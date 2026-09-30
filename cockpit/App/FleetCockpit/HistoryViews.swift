import Charts
import SwiftUI
import CockpitCore

/// Two hours of one host metric: an area with the latest point emphasised.
struct Sparkline: View {
    let points: [(Date, Double)]
    let color: Color
    var floor: Double?

    var body: some View {
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                AreaMark(x: .value("t", p.0), y: .value("v", p.1))
                    .foregroundStyle(color.opacity(0.15))
                LineMark(x: .value("t", p.0), y: .value("v", p.1))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 1.2))
            }
            if let last = points.last {
                PointMark(x: .value("t", last.0), y: .value("v", last.1)).foregroundStyle(color).symbolSize(12)
            }
            if let floor {
                RuleMark(y: .value("floor", floor)).foregroundStyle(.primary.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .frame(height: 22)
    }
}

struct SparklineStrip: View {
    let samples: [[Double?]]
    var floorGb: Double?

    private func series(_ i: Int) -> [(Date, Double)] {
        samples.compactMap { s in
            guard s.count > i, let t = s[0], let v = s[i] else { return nil }
            return (Date(timeIntervalSince1970: t / 1000), v)
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            spark("load / core", series(1), .blue)
            spark("swap-ins", series(2), .orange)
            spark("disk GB", series(3), .green, floor: floorGb)
        }
    }

    private func spark(_ label: String, _ pts: [(Date, Double)], _ c: Color, floor: Double? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Sparkline(points: pts, color: c, floor: floor)
            Text("\(label) · 2 h").font(.system(size: 9)).foregroundStyle(.tertiary)
        }
    }
}

struct HistoryPanel: View {
    @Bindable var model: AppModel
    let now: Double
    @Environment(\.isRendering) private var isRendering

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("History").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                if isRendering {
                    Text(model.historyWindowDays == 1 ? "24 h" : "7 d").font(.system(size: 11, design: .monospaced))
                } else {
                Picker("", selection: $model.historyWindowDays) {
                    Text("24 h").tag(1)
                    Text("7 d").tag(7)
                }
                .pickerStyle(.segmented)
                .frame(width: 110)
                .labelsHidden()
                }
            }
            if let t = model.timeline {
                let window = Double(model.historyWindowDays) * 86_400_000
                let lanes = HistoryPresenter.lanes(t, windowMs: window, now: now)
                if lanes.isEmpty {
                    Text("No incidents in this window.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(lanes) { lane in
                    HStack(spacing: 8) {
                        Text(lane.title).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                            .frame(width: 84, alignment: .leading)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(.quaternary).frame(height: 6)
                                ForEach(lane.spans) { s in
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(lane.tone.color)
                                        .frame(width: max(3, geo.size.width * (s.to - s.from)), height: 10)
                                        .offset(x: geo.size.width * s.from)
                                        .help("\(s.title) — \(s.open ? "open, " : "")\(Format.duration(ms: s.durationMs))")
                                }
                            }
                        }
                        .frame(height: 12)
                    }
                }
                if let line = HistoryPresenter.todayLine(t) {
                    Text(line).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let w = t.week, let mttr = w.mttrMs {
                    Text("This week: \(w.incidents) incidents, cleared in \(Format.duration(ms: mttr)) on average.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                let flaky = t.flaky.filter { $0.lost >= 2 }
                if !flaky.isEmpty {
                    let host = model.store.glance?.hosts.first { $0.local == true }?.name ?? ""
                    Text("Lost jobs this week: " + flaky.map { "\(Presenter.shortName($0.runner, hostName: host)) ×\($0.lost)" }.joined(separator: ", "))
                        .font(.system(size: 11)).foregroundStyle(.orange)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }
}

struct PostureList: View {
    let items: [PostureItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Standing risks").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(items) { i in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.shield").foregroundStyle(.orange)
                        Text(i.title).font(.system(size: 12, weight: .semibold))
                        Spacer()
                        Text(whoLabel(i.who)).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    if let d = i.detail { Text(d).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    if let f = i.fix {
                        Text(f).font(.system(size: 11)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.07)))
    }

    private func whoLabel(_ w: String?) -> String {
        switch w {
        case "owner": "only you"
        case "command": "a command"
        case "button": "one click"
        default: ""
        }
    }
}
