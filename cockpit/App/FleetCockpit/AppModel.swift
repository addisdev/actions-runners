import AppKit
import CockpitCore
import Foundation
import Network
import Observation
import ServiceManagement
import UserNotifications

@MainActor
@Observable
final class AppModel {
    let store: GlanceStore
    var settings: AppSettings {
        didSet {
            guard settings != oldValue else { return }
            settings.save()
            store.config = settings.transport
        }
    }
    /// The pill under the pointer, shown in the inspector strip.
    var hovered: PillModel?
    var filter: String = ""

    /// What the sentinel concluded while the dashboard was unreachable.
    var outOfBand: Verdict?
    var lastProbeMs: Double?
    var probing = false
    var showLadder = false
    let notifier = Notifier()

    // MARK: control state
    var catalog: ActionCatalog?
    /// An action waiting for the person to confirm it (its confirm text is shown inline).
    var pending: (action: ActionDef, args: [String: String])?
    var running: String?
    var lastResult: (label: String, result: ActionResult)?
    var selectedRunner: PillModel?
    var runnerDetail: RunnerDetail?
    var pairingStatus: String?
    var token: String? { didSet { store.token = token } }

    /// Commits someone asked to be told about.
    var watches: [Watch] = AppModel.loadWatches() {
        didSet { if let d = try? JSONEncoder().encode(watches) { UserDefaults.standard.set(d, forKey: "watches.v1") } }
    }

    static func loadWatches() -> [Watch] {
        guard let d = UserDefaults.standard.data(forKey: "watches.v1") else { return [] }
        return (try? JSONDecoder().decode([Watch].self, from: d)) ?? []
    }

    func isWatched(_ t: WaitTarget) -> Bool { watches.contains { $0.target == t } }

    func toggleWatch(_ t: WaitTarget) {
        if isWatched(t) { watches.removeAll { $0.target == t } } else { watches.append(Watch(target: t, createdAt: Format.nowMs())) }
    }

    // MARK: history state
    var timeline: Timeline?
    var showHistory = false
    var historyWindowDays = 1
    var showPosture = false
    var topCPU: HostProbe.TopCPU?
    var probingCPU = false
    @ObservationIgnored private var lastTimelineMs: Double = 0

    @ObservationIgnored private var incidents = IncidentTracker()
    @ObservationIgnored private var sentinelTask: Task<Void, Never>?
    @ObservationIgnored private var networkUp = true
    @ObservationIgnored private var lastTargets: SentinelTargets?
    /// Kept in the snapshot file while nothing newer has arrived, so a restart
    /// during an outage does not erase what the fleet looked like before it.
    @ObservationIgnored private var lastGoodGlance: Glance?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var lastPath: String?
    @ObservationIgnored private var wakeObserver: NSObjectProtocol?

    init() {
        var s = AppSettings.load()
        // `--fixture <name>` for screenshots and demos, without touching saved settings.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--fixture"), i + 1 < args.count {
            s.mode = .fixture
            s.fixture = args[i + 1]
        }
        settings = s
        store = GlanceStore(config: s.transport)
        store.onGlance = { [weak self] g in
            self?.glanceArrived(g)
            self?.lastGoodGlance = g
            self?.lastTargets = SentinelTargets.from(g) ?? self?.lastTargets
            self?.writeSnapshot()
        }
        store.onConnection = { [weak self] state in self?.connectionChanged(state) }
        notifier.requestAuthorization()
        notifier.onAction = { [weak self] action, info in self?.notificationAction(action, info) }
        // Targets from the last run, so a launch while the host is down can
        // still ask GitHub about the right runners.
        if s.mode != .fixture, let g = (try? SnapshotFile.read())?.glance {
            lastGoodGlance = g
            lastTargets = SentinelTargets.from(g)
        }
        store.start()
        observeSystem()
        Renderer.runIfRequested(self)
    }

    var verdict: Verdict {
        CockpitVerdict.effective(glance: store.glance, connection: store.connection,
                                 outOfBand: outOfBand, lastGlanceMs: store.lastGlanceMs)
    }

    var ladder: [LadderRung] { Ladder.build(verdict) }

    /// "Now" for ages on screen. A fixture is a moment in the past, so its ages
    /// are measured from when it was recorded rather than from today.
    func clockMs(_ date: Date = Date()) -> Double {
        if case .fixture = store.connection, let t = store.glance?.generatedAt { return t }
        return Format.nowMs(date)
    }

    var brief: String {
        IncidentBrief.markdown(verdict: verdict, glance: store.glance, route: store.route?.label,
                               connection: String(describing: store.connection))
    }

    func copyBrief() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(brief, forType: .string)
    }

    // MARK: control

    /// Keychain account for this fleet's device token: the coordinator's id.
    var tokenAccount: String {
        store.glance?.hosts.first(where: { $0.local == true })?.id ?? settings.aliasList.first ?? "fleet"
    }

    var isPaired: Bool { token != nil }

    private func glanceArrived(_ g: Glance) {
        if token == nil, let t = TokenStore.load(account: tokenAccount) { token = t }
        if catalog == nil, case .live = store.connection { Task { await loadCatalog() } }
        for (w, s) in Watch.finished(watches, glance: g) {
            watches.removeAll { $0.id == w.id }
            let failed = s.failed.compactMap(\.workflow).joined(separator: ", ")
            notifier.post(id: "watch:\(w.id)", title: s.state == .green ? "✔ \(s.label) is green" : "✖ \(s.label) failed",
                          body: s.state == .green ? s.progress : "Failed: \(failed). \(notYourCodeNote(s, g))",
                          critical: false, info: ["kind": "watch", "url": (s.failed.first ?? s.runs.first)?.url ?? ""])
        }
        if Format.nowMs() - lastTimelineMs > 5 * 60_000 { Task { await refreshTimeline() } }
        checkWeeklyDigest()
        let hour = Calendar.current.component(.hour, from: Date())
        for event in incidents.update(g.incidents, prefs: settings.notifications, now: Format.nowMs(), hour: hour) {
            notifier.incident(event)
        }
    }

    func refreshTimeline() async {
        guard let c = store.client else { return }
        lastTimelineMs = Format.nowMs()
        if let t = try? await c.timeline(days: 7) { timeline = t }
    }

    /// Monday 09:00 local, once a week: the digest as a notification.
    private func checkWeeklyDigest() {
        let cal = Calendar.current
        let now = Date()
        guard cal.component(.weekday, from: now) == 2, cal.component(.hour, from: now) >= 9 else { return }
        let week = "\(cal.component(.yearForWeekOfYear, from: now))-\(cal.component(.weekOfYear, from: now))"
        guard UserDefaults.standard.string(forKey: "digest.lastWeek") != week else { return }
        UserDefaults.standard.set(week, forKey: "digest.lastWeek")
        Task {
            await refreshTimeline()
            guard let t = timeline else { return }
            let d = HistoryPresenter.digest(t)
            notifier.post(id: "digest", title: d.title, body: d.body, critical: false, info: ["kind": "digest"])
        }
    }

    func probeTopCPU() async {
        guard let alias = settings.aliasList.first else { return }
        probingCPU = true
        defer { probingCPU = false }
        topCPU = await HostProbe.topCPU(alias: alias)
    }

    /// Saves the runner's redacted diagnostic bundle to Downloads and shows it.
    func downloadBundle(_ runner: String) async {
        guard let c = store.client, isPaired else { return }
        do {
            let data = try await c.bundle(runner: runner)
            let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
            let url = dir.appendingPathComponent("\(runner)-diagnostics-\(stamp).txt")
            try data.write(to: url, options: [.atomic])
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            lastResult = ("Diagnostic bundle", ActionResult(ok: false, error: String(describing: error)))
        }
    }

    /// "Not your code" when the daemon recorded the failure as the host's or the account's.
    private func notYourCodeNote(_ s: CheckSet, _ g: Glance) -> String {
        let ids = Set(s.failed.map(\.id))
        guard let f = g.failures?.first(where: { ids.contains($0.runId) }), f.notYourCode == true else { return "" }
        return f.label + "."
    }

    func loadCatalog() async {
        guard let c = store.client else { return }
        catalog = try? await c.actions()
    }

    /// Asks first when the catalogue says to; runs straight away otherwise.
    func request(_ actionId: String, args: [String: String] = [:]) {
        guard let def = catalog?.action(actionId) ?? ActionCatalog.fallback(actionId) else { return }
        if def.confirm != nil || def.isHighDanger {
            pending = (def, args)
        } else {
            Task { await run(def, args: args) }
        }
    }

    func confirmPending() {
        guard let p = pending else { return }
        pending = nil
        Task { await run(p.action, args: p.args) }
    }

    func run(_ def: ActionDef, args: [String: String]) async {
        guard let client = store.client else { return }
        guard isPaired else {
            lastResult = (def.label, ActionResult(ok: false, error: "Pair this Mac first (Settings → Control)."))
            return
        }
        running = def.label
        defer { running = nil }
        let r = (try? await client.perform(def.id, args: args)) ?? ActionResult(ok: false, error: "No response")
        lastResult = (def.label, r)
        // The one two-step flow: a cleanup preview offers the real cleanup.
        if def.id == "fleet.cleanupPreview", r.ok, let apply = catalog?.action("fleet.cleanupApply") {
            pending = (apply, [:])
        }
        if let name = selectedRunner?.name { await loadRunner(name) }
    }

    func pair() async {
        guard let alias = settings.aliasList.first, let client = store.client else {
            pairingStatus = "Connect to the dashboard over an SSH alias first."
            return
        }
        pairingStatus = "Asking \(alias) for a pairing code…"
        guard let code = await Pairing.mintCode(alias: alias, fleetRoot: settings.fleetRoot) else {
            pairingStatus = "Could not get a code: is \(settings.fleetRoot)/dashboard/fleetctl.sh on \(alias)?"
            return
        }
        let name = "Fleet Cockpit on \(Foundation.Host.current().localizedName ?? "this Mac")"
        do {
            let t = try await client.pair(code: code, name: name)
            guard TokenStore.save(t, account: tokenAccount) else {
                pairingStatus = "Paired, but the token could not be saved to the Keychain."
                return
            }
            token = t
            pairingStatus = "Paired as “\(name)”. Revoke with ./fleetctl.sh revoke on the host."
            await loadCatalog()
        } catch {
            pairingStatus = "Pairing failed: \(error)"
        }
    }

    func forgetPairing() {
        TokenStore.delete(account: tokenAccount)
        token = nil
        pairingStatus = "This Mac's token is forgotten. Revoke it on the host too: ./fleetctl.sh devices"
    }

    func select(_ pill: PillModel?) {
        selectedRunner = pill
        runnerDetail = nil
        if let name = pill?.name { Task { await loadRunner(name) } }
    }

    func loadRunner(_ name: String) async {
        guard let c = store.client else { return }
        let d = try? await c.runner(name)
        if selectedRunner?.name == name { runnerDetail = d }
    }

    func dismiss(_ key: String) async {
        try? await store.client?.dismiss(key)
    }

    private func notificationAction(_ action: String, _ info: [String: String]) {
        switch action {
        case "repair": request("fleet.healthRepair")
        case "dismiss": if let k = info["key"] { Task { await dismiss(k) } }
        case "snooze": if let k = info["key"] { incidents.snooze(k, untilMs: Format.nowMs() + 3_600_000) }
        case "open": openDashboard(fragment: "#/alerts")
        case UNNotificationDefaultActionIdentifier where info["kind"] == "watch": open(info["url"])
        default: break // tapping the banner itself: the menu bar is right there
        }
    }

    // MARK: URL scheme

    /// fleetcockpit://pair · ://why · ://runner/<name> · ://reconnect · ://fixture/<name>
    func handle(_ url: URL) {
        guard url.scheme == "fleetcockpit" else { return }
        let arg = url.pathComponents.dropFirst().first
        switch url.host {
        case "pair": Task { await pair() }
        case "why": showLadder = true
        case "reconnect": store.reconnectNow()
        case "runner":
            if let name = arg, let g = store.glance {
                let pill = Presenter.lanes(g, now: clockMs()).flatMap { $0.groups.flatMap(\.pills) }
                    .first { $0.name == name || $0.shortName == name }
                select(pill)
            }
        case "fixture":
            if let name = arg { var s = settings; s.mode = .fixture; s.fixture = name; settings = s }
        default: break
        }
    }

    // MARK: sentinel

    private func connectionChanged(_ state: ConnectionState) {
        switch state {
        case .reconnecting:
            startSentinel()
        case .live, .collectorStale, .fixture:
            stopSentinel()
            if outOfBand != nil { outOfBand = nil }
            notifier.cockpit(nil)
        case .connecting:
            break
        }
        writeSnapshot()
    }

    /// Starts after 20 s of failed reconnects — a daemon restart takes a few
    /// seconds and is not an incident — then probes once a minute until the
    /// stream is back.
    private func startSentinel() {
        guard sentinelTask == nil else { return }
        sentinelTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            while !Task.isCancelled {
                await self?.probeOnce()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    private func stopSentinel() {
        sentinelTask?.cancel()
        sentinelTask = nil
        probing = false
    }

    func probeOnce() async {
        if case .fixture = settings.transport { return }
        probing = true
        defer { probing = false }
        let targets = lastTargets
        var probe = SentinelProbe(aliases: settings.mode == .tunnel ? settings.aliasList : [])
        probe.remotePort = settings.remotePort
        let p = await probe.run(targets, localNetwork: networkUp)
        guard !store.connection.isLive, store.connection != .collectorStale else { return }
        let v = Sentinel.classify(p, hostName: targets?.hostName ?? settings.aliasList.first ?? "the host")
        outOfBand = v
        lastProbeMs = Format.nowMs()
        notifier.cockpit(v)
        writeSnapshot()
    }

    var menuBar: MenuBarModel {
        Presenter.menuBar(verdict: verdict, counts: store.glance?.counts, showCounts: settings.showCounts)
    }

    /// Greyed when what is on screen cannot currently be refreshed.
    var isDimmed: Bool { !(store.connection.isLive) }

    func lanes(now: Double) -> [LaneModel] {
        guard let g = store.glance else { return [] }
        let all = Presenter.lanes(g, now: now)
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all }
        return all.compactMap { lane in
            var l = lane
            l.groups = lane.groups.compactMap { g in
                var g = g
                g.pills = g.pills.filter {
                    $0.name.lowercased().contains(q) || g.name.lowercased().contains(q)
                        || $0.state.rawValue.contains(q) || $0.detail.lowercased().contains(q)
                }
                return g.pills.isEmpty ? nil : g
            }
            return l.groups.isEmpty ? nil : l
        }
    }

    var routeLabel: String {
        switch store.connection {
        case .fixture(let n): return "fixture · \(n)"
        case .connecting: return "connecting…"
        case .reconnecting(let attempt, _): return "reconnecting (attempt \(attempt))"
        case .live, .collectorStale:
            guard let r = store.route else { return "live" }
            let via = r.label.hasSuffix("-ts") ? "tailnet" : settings.mode == .direct ? "direct" : "LAN"
            let ms = r.latencyMs.map { " · \(Int($0.rounded())) ms" } ?? ""
            return "via \(r.label) (\(via))\(ms)"
        }
    }

    // MARK: system events

    private func observeSystem() {
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.store.reconnectNow() }
        }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            // A route built on the old network (Wi-Fi to hotspot, VPN up or
            // down) is dead weight even if the socket has not noticed yet.
            let signature = "\(path.status)|" + path.availableInterfaces.map(\.name).joined(separator: ",")
            let up = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                self.networkUp = up
                defer { self.lastPath = signature }
                if let last = self.lastPath, last != signature, path.status == .satisfied {
                    self.store.reconnectNow()
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "path-monitor"))
        pathMonitor = monitor
    }

    // MARK: snapshot for the CLI and other tools

    private func writeSnapshot() {
        // A demo must never overwrite what the CLI reads as the live fleet.
        if case .fixture = store.connection { return }
        if case .fixture = settings.transport { return }
        let snap = SnapshotFile(
            writtenAt: Format.nowMs(),
            route: store.route?.label,
            connection: String(describing: store.connection),
            verdict: verdict,
            glance: store.glance ?? lastGoodGlance
        )
        Task.detached(priority: .utility) { try? snap.write() }
    }

    // MARK: launch at login

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("launch at login: \(error)")
            }
        }
    }

    // MARK: opening things

    func open(_ string: String?) {
        guard let string, let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }

    /// The full web dashboard, through the same route.
    func openDashboard(fragment: String = "") {
        guard let base = store.route?.baseURL, base.scheme?.hasPrefix("http") == true else { return }
        NSWorkspace.shared.open(URL(string: base.absoluteString + "/" + fragment) ?? base)
    }

    func openTerminal(alias: String? = nil) {
        let host = alias ?? settings.aliasList.first ?? "runner-host"
        let script = "tell application \"Terminal\" to do script \"ssh \(host)\"\ntell application \"Terminal\" to activate"
        NSAppleScript(source: script)?.executeAndReturnError(nil)
    }
}
