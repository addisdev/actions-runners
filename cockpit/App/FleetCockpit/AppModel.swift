import AppKit
import CockpitCore
import Foundation
import Network
import Observation
import ServiceManagement

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
        store.onGlance = { [weak self] _ in self?.writeSnapshot() }
        store.onConnection = { [weak self] _ in self?.writeSnapshot() }
        store.start()
        observeSystem()
        Renderer.runIfRequested(self)
    }

    var verdict: Verdict {
        CockpitVerdict.effective(glance: store.glance, connection: store.connection,
                                 outOfBand: nil, lastGlanceMs: store.lastGlanceMs)
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
            Task { @MainActor in
                guard let self else { return }
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
            glance: store.glance
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
    func openDashboard() {
        guard let base = store.route?.baseURL, base.scheme?.hasPrefix("http") == true else { return }
        NSWorkspace.shared.open(base)
    }

    func openTerminal(alias: String? = nil) {
        let host = alias ?? settings.aliasList.first ?? "runner-host"
        let script = "tell application \"Terminal\" to do script \"ssh \(host)\"\ntell application \"Terminal\" to activate"
        NSAppleScript(source: script)?.executeAndReturnError(nil)
    }
}
