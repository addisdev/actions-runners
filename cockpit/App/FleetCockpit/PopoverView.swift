import SwiftUI
import CockpitCore

private struct RenderingKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// True under ImageRenderer, which cannot draw scroll views, text fields
    /// or menus; the popover swaps in static equivalents.
    var isRendering: Bool {
        get { self[RenderingKey.self] }
        set { self[RenderingKey.self] = newValue }
    }
}

struct PopoverView: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @Environment(\.isRendering) private var isRendering

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { ctx in
            let now = model.clockMs(ctx.date)
            VStack(alignment: .leading, spacing: 12) {
                VerdictHeader(verdict: model.verdict, dimmed: model.isDimmed, onNext: handle)
                headerActions
                ControlBar(model: model)
                if model.showPosture, let risks = model.store.glance?.posture?.items, !risks.isEmpty {
                    PostureList(items: risks)
                }
                if let top = model.topCPU {
                    TopCPUView(top: top) { model.topCPU = nil }
                }
                if model.showLadder {
                    LadderView(rungs: model.ladder)
                } else if model.verdict.open.count > 1 {
                    alsoOpen
                }
                Divider()
                scrolling {
                    VStack(alignment: .leading, spacing: 14) {
                        if model.showHistory {
                            HistoryPanel(model: model, now: now)
                            Divider()
                        }
                        ForEach(model.lanes(now: now)) { lane in
                            LaneView(lane: lane, dense: model.settings.dense, hovered: $model.hovered) { p in
                                model.select(model.selectedRunner?.id == p.id ? nil : p)
                            }
                            if lane.id == model.store.glance?.hosts.first(where: { $0.local == true })?.id {
                                if let s = model.timeline?.samples, s.count > 2 {
                                    SparklineStrip(samples: s, floorGb: lane.disk?.floorGb)
                                }
                                laneActions(lane)
                            }
                            Divider()
                        }
                        if let g = model.store.glance {
                            let checks = Presenter.checks(g)
                            if !checks.isEmpty {
                                ChecksSection(rows: checks, isWatched: model.isWatched, onToggle: model.toggleWatch) { model.open($0) }
                                Divider()
                            }
                            QueueSection(rows: Presenter.queue(g)) { model.open($0) }
                            if let f = g.failures, !f.isEmpty {
                                Divider()
                                FailuresSection(rows: f, now: now) { model.open($0) }
                            }
                        }
                    }
                    .opacity(model.isDimmed ? 0.55 : 1)
                    .saturation(model.isDimmed ? 0.2 : 1)
                }
                if let sel = model.selectedRunner {
                    RunnerPanel(model: model, pill: sel)
                } else {
                    inspector
                }
                footer(now: now)
            }
            .padding(14)
            .frame(width: Metrics.popoverWidth)
        }
    }

    @ViewBuilder
    private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if isRendering {
            content()
        } else {
            ScrollView { content() }.frame(maxHeight: 520)
        }
    }

    @State private var copied = false

    private var headerActions: some View {
        HStack(spacing: 12) {
            if isRendering {
                Text(model.showLadder ? "Hide why" : "Why?").foregroundStyle(Color.accentColor)
                Text("Copy brief").foregroundStyle(Color.accentColor)
            } else {
                Button(model.showLadder ? "Hide why" : "Why?") { model.showLadder.toggle() }
                Button(copied ? "Copied" : "Copy brief") {
                    model.copyBrief()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                }
            }
            if isRendering {
                Text(model.showHistory ? "Hide history" : "History").foregroundStyle(Color.accentColor)
            } else {
                Button(model.showHistory ? "Hide history" : "History") {
                    model.showHistory.toggle()
                    if model.showHistory { Task { await model.refreshTimeline() } }
                }
            }
            if let items = model.store.glance?.posture?.items, let chip = Presenter.postureChip(items) {
                if isRendering {
                    Text(chip).foregroundStyle(.orange)
                } else {
                    Button(chip) { model.showPosture.toggle() }
                        .foregroundStyle(.orange)
                }
            }
            if model.probing {
                ProgressView().controlSize(.mini)
                Text("checking the host out of band…").foregroundStyle(.secondary)
            } else if let t = model.lastProbeMs, model.outOfBand != nil {
                Text("checked out of band \(Format.ago(t, now: Format.nowMs()))").foregroundStyle(.secondary)
            }
            Spacer()
        }
        .buttonStyle(.link)
        .font(.system(size: 11))
        .padding(.leading, 14)
    }

    @ViewBuilder
    private func laneActions(_ lane: LaneModel) -> some View {
        let diskWorry = (lane.disk?.tone ?? .ok) != .ok
        let busy = lane.vitals.contains { $0.tone != .ok } || model.verdict.id == "saturated"
        if (diskWorry || busy) && !isRendering {
            HStack(spacing: 12) {
                if diskWorry {
                    Button("What is using disk?") { model.request("fleet.cleanupPreview") }
                        .disabled(!model.isPaired)
                        .help(model.isPaired ? "Runs the cleanup preview (deletes nothing)" : "Pair this Mac first")
                }
                if busy {
                    Button(model.probingCPU ? "Checking…" : "Top CPU on the host") { Task { await model.probeTopCPU() } }
                        .disabled(model.probingCPU)
                }
            }
            .buttonStyle(.link)
            .font(.system(size: 11))
        }
    }

    private var alsoOpen: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(model.verdict.open.dropFirst()) { f in
                HStack(spacing: 6) {
                    Circle().fill(f.tone.color).frame(width: 6, height: 6)
                    Text(f.title).font(.system(size: 11.5))
                    if let e = f.evidence?.first {
                        Text(e).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .padding(.leading, 14)
    }

    /// The hover card, docked: a floating popover inside a popover fights the
    /// pointer, a fixed strip does not.
    private var inspector: some View {
        HStack(spacing: 8) {
            if let p = model.hovered {
                PillView(pill: p, size: 12)
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.shortName).font(.system(size: 12, weight: .semibold))
                    Text(p.detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                }
            } else if isRendering {
                Text("Hover a runner for detail · type to filter")
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            } else {
                TextField("Filter runners", text: $model.filter)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
            }
            Spacer(minLength: 0)
        }
        .frame(height: 30)
    }

    private func footer(now: Double) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(model.store.connection.isLive ? Color.green : model.store.connection == .collectorStale ? .orange : .gray)
                .frame(width: 7, height: 7)
            Text(model.routeLabel).lineLimit(1)
            if let t = model.store.lastGlanceMs {
                Text("· \(Format.ago(t, now: now))")
            }
            Spacer()
            if isRendering {
                Image(systemName: "ellipsis.circle")
            } else {
                footerMenu
            }
        }
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(.secondary)
    }

    private var footerMenu: some View {
            Menu {
                Button("Open web dashboard") { model.openDashboard() }
                    .disabled(model.store.route?.baseURL.scheme?.hasPrefix("http") != true)
                Button("Terminal on the host") { model.openTerminal() }
                Button("Reconnect now") { model.store.reconnectNow() }
                Button("Open as a floating window  ⌃⌥⌘F") { model.togglePanel() }
                Button("Incident replay…") { openWindow(id: "replay"); NSApp.activate(ignoringOtherApps: true) }
                Divider()
                Button("Settings…") { openSettings(); NSApp.activate(ignoringOtherApps: true) }
                Button("Quit Fleet Cockpit") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
    }

    private func handle(_ n: NextMove) {
        switch n.kind {
        case "url":
            if let u = n.url, u.hasPrefix("#"), let base = model.store.route?.baseURL {
                model.open(base.absoluteString + "/" + u)
            } else {
                model.open(n.url)
            }
        case "reconnect":
            model.store.reconnectNow()
        case "action":
            if let a = n.action { model.request(a) }
        case "command" where n.command?.hasPrefix("ps -Ao") == true:
            Task { await model.probeTopCPU() }
        case "command":
            if let c = n.command {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(c, forType: .string)
            }
            model.openTerminal()
        default:
            model.openDashboard()
        }
    }
}
