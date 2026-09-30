import SwiftUI
import WidgetKit
import CockpitCore

// Desktop widgets, fed by the snapshot the app writes into the shared app
// group on every update. The widget never touches the network: it shows what
// the app last saw, and says so when that is too old to trust.

struct FleetEntry: TimelineEntry {
    let date: Date
    let snapshot: SnapshotFile?

    var ageMs: Double { snapshot.map { Format.nowMs(date) - $0.writtenAt } ?? .infinity }
    var stale: Bool { ageMs > 10 * 60_000 }
}

struct FleetProvider: TimelineProvider {
    func placeholder(in context: Context) -> FleetEntry {
        FleetEntry(date: Date(), snapshot: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (FleetEntry) -> Void) {
        completion(FleetEntry(date: Date(), snapshot: context.isPreview ? Self.sample : Self.read() ?? Self.sample))
    }

    func getTimeline(in context: Context, completion: @escaping (WidgetKit.Timeline<FleetEntry>) -> Void) {
        let entry = FleetEntry(date: Date(), snapshot: Self.read())
        // The app reloads timelines on every verdict change; this is the
        // fallback so a dead app's last view visibly ages.
        completion(WidgetKit.Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(5 * 60))))
    }

    static func read() -> SnapshotFile? {
        guard let url = SnapshotFile.groupURL else { return nil }
        return try? SnapshotFile.read(from: url)
    }

    static var sample: SnapshotFile? {
        guard let g = try? Fixtures.glance("waiting") else { return nil }
        return SnapshotFile(writtenAt: Format.nowMs(), route: "runner-host", connection: "live", verdict: g.verdict, glance: g)
    }
}

extension Tone {
    var color: Color {
        switch self {
        case .critical: .red
        case .warning: .orange
        case .unknown: .gray
        case .info: .blue
        case .ok: .green
        }
    }
}

extension PillColor {
    var color: Color {
        switch self {
        case .idle: .green
        case .busy: .blue
        case .caution: .orange
        case .neutral: .secondary
        case .critical: .red
        case .config: .purple
        case .faint: .gray.opacity(0.5)
        }
    }
}

struct VerdictBlock: View {
    let entry: FleetEntry
    var lines = 2

    var body: some View {
        let v = entry.snapshot?.verdict
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: Presenter.symbol(for: entry.stale ? .unknown : v?.tone ?? .unknown, verdictId: v?.id ?? "unknown"))
                    .foregroundStyle((entry.stale ? .unknown : v?.tone ?? .unknown).color)
                    .font(.system(size: 15, weight: .semibold))
                Text(entry.stale ? "No current view" : v?.title ?? "Fleet Cockpit is not running")
                    .font(.system(.headline, design: .rounded)).lineLimit(lines)
            }
            if let g = entry.snapshot?.glance, !entry.stale {
                Text("\(g.counts.running) running · \(g.counts.queued) queued")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            }
            Text(entry.snapshot.map { "updated \(Format.ago($0.writtenAt, now: Format.nowMs(entry.date)))" } ?? "open Fleet Cockpit")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        }
    }
}

struct DotGrid: View {
    let glance: Glance

    var body: some View {
        let pills = Presenter.lanes(glance, now: Format.nowMs()).flatMap { $0.groups.flatMap(\.pills) }
        let cols = Array(repeating: GridItem(.fixed(7), spacing: 3), count: 12)
        LazyVGrid(columns: cols, alignment: .leading, spacing: 3) {
            ForEach(pills) { p in
                Circle()
                    .fill(p.shape == .ring ? Color.clear : p.color.color)
                    .overlay(Circle().strokeBorder(p.color.color, lineWidth: 1.2))
                    .frame(width: 7, height: 7)
            }
        }
    }
}

struct FleetWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FleetEntry

    var body: some View {
        switch family {
        case .systemSmall:
            VerdictBlock(entry: entry, lines: 3)
        case .systemMedium:
            HStack(alignment: .top, spacing: 12) {
                VerdictBlock(entry: entry, lines: 3)
                Spacer(minLength: 0)
                if let g = entry.snapshot?.glance, !entry.stale { DotGrid(glance: g) }
            }
        default:
            VStack(alignment: .leading, spacing: 10) {
                VerdictBlock(entry: entry)
                if let s = entry.snapshot?.verdict.sentence, !entry.stale {
                    Text(s).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                }
                if let g = entry.snapshot?.glance, !entry.stale {
                    DotGrid(glance: g)
                    let checks = Presenter.checks(g, limit: 3)
                    ForEach(checks) { c in
                        HStack {
                            Text(c.title).font(.system(size: 11)).lineLimit(1)
                            Spacer()
                            Text(c.progress).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(Presenter.queue(g).prefix(4)) { q in
                        HStack {
                            Text(q.title).font(.system(size: 11)).lineLimit(1)
                            Spacer()
                            Text(q.eta ?? q.cause).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

struct FleetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FleetCockpit", provider: FleetProvider()) { entry in
            FleetWidgetView(entry: entry)
                .containerBackground(.background, for: .widget)
                .widgetURL(URL(string: "fleetcockpit://why"))
        }
        .configurationDisplayName("Fleet")
        .description("The runner fleet's verdict, runners and queue.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct FleetWidgets: WidgetBundle {
    var body: some Widget { FleetWidget() }
}
