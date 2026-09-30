import SwiftUI
import CockpitCore

struct VerdictHeader: View {
    let verdict: Verdict
    var dimmed: Bool
    var onNext: (NextMove) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(verdict.tone.color)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 3) {
                Text(verdict.title)
                    .font(.system(.headline, design: .rounded).weight(.bold))
                if let s = verdict.sentence {
                    Text(s).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let n = verdict.next, n.kind != "none" {
                    Button(n.label) { onNext(n) }
                        .buttonStyle(.borderedProminent)
                        .tint(verdict.tone == .ok ? .accentColor : verdict.tone.color)
                        .controlSize(.small)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .opacity(dimmed && verdict.id != "unreachable" ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}

struct DiskGauge: View {
    let disk: DiskModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { geo in
                let w = geo.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(disk.tone.color).frame(width: max(4, w * disk.freeFraction))
                    if let f = disk.floorFraction {
                        Rectangle()
                            .fill(.primary)
                            .frame(width: 2, height: 14)
                            .offset(x: w * f - 1)
                            .accessibilityHidden(true)
                    }
                }
            }
            .frame(height: 8)
            HStack {
                Text(disk.caption)
                Spacer()
                if let eta = disk.eta { Text(eta) }
            }
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(disk.tone == .ok ? .secondary : disk.tone.color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Disk: \(disk.caption)")
    }
}

struct VitalsStrip: View {
    let vitals: [VitalModel]

    var body: some View {
        HStack(spacing: 14) {
            ForEach(vitals) { v in
                VStack(alignment: .leading, spacing: 0) {
                    Text(v.value)
                        .font(.system(size: 12.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(v.tone == .ok ? .primary : v.tone.color)
                    Text(v.label).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .monospacedDigit()
    }
}

struct LaneView: View {
    let lane: LaneModel
    var dense: Bool
    @Binding var hovered: PillModel?
    var onOpen: (PillModel) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(lane.title).font(.system(size: 12.5, weight: .semibold))
                Spacer()
                Text(lane.subtitle)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(lane.stale ? .red : .secondary)
            }
            if !lane.vitals.isEmpty { VitalsStrip(vitals: lane.vitals) }
            if let d = lane.disk { DiskGauge(disk: d) }
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 8, verticalSpacing: 6) {
                ForEach(lane.groups) { g in
                    GridRow {
                        Text(g.name)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 74, alignment: .leading)
                            .lineLimit(1)
                        FlowLayout(spacing: dense ? 3 : 5) {
                            ForEach(g.pills) { p in
                                PillView(pill: p, size: dense ? Metrics.densePill : Metrics.pill)
                                    .onHover { inside in
                                        if inside { hovered = p } else if hovered?.id == p.id { hovered = nil }
                                    }
                                    .onTapGesture { onOpen(p) }
                                    .help(p.accessibilityLabel)
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Wraps pills onto as many rows as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? 300
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > maxW { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(maxW, widest), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + sz.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

struct QueueSection: View {
    let rows: [QueueRowModel]
    var onOpen: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Queue").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if rows.isEmpty {
                Text("Nothing queued.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(rows) { r in
                Button { onOpen(r.url) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.title).font(.system(size: 12.5)).lineLimit(1)
                            if let s = r.subtitle {
                                Text(s).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 4)
                        Text(r.cause)
                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(r.causeTone.color.opacity(0.15)))
                            .foregroundStyle(r.causeTone == .unknown ? .secondary : r.causeTone.color)
                        VStack(alignment: .trailing, spacing: 0) {
                            Text(r.age).font(.system(size: 12, weight: .medium, design: .monospaced))
                            if let eta = r.eta {
                                Text(eta).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.secondary)
                            }
                        }
                        .monospacedDigit()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(r.recommended ?? "")
            }
        }
    }
}

/// The whole ladder with the verdict's rung lit: what was checked, in what
/// order, and why this rung won.
struct LadderView: View {
    let rungs: [LadderRung]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rungs.enumerated()), id: \.element.id) { i, r in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(i)")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(r.lit ? Color.accentColor : .secondary)
                        .frame(width: 14, alignment: .trailing)
                    Circle()
                        .fill(r.open ? r.tone.color : Color.secondary.opacity(0.25))
                        .frame(width: 7, height: 7)
                        .padding(.top, 4)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.title)
                            .font(.system(size: 12, weight: r.lit ? .bold : r.open ? .semibold : .regular))
                            .foregroundStyle(r.open ? .primary : .secondary)
                        if r.lit || r.open {
                            Text(r.blurb).font(.system(size: 11)).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(r.evidence, id: \.self) { e in
                                Text("· \(e)").font(.system(size: 11)).foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .background(r.lit ? RoundedRectangle(cornerRadius: 5).fill(Color.accentColor.opacity(0.08)) : nil)
            }
        }
    }
}

struct FailuresSection: View {
    let rows: [FailureRow]
    let now: Double
    var onOpen: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Failed in the last 2 hours").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(rows) { f in
                Button { onOpen(f.url) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(f.repo.split(separator: "/").last.map(String.init) ?? f.repo) · \(f.workflow ?? "run")")
                                .font(.system(size: 12.5)).lineLimit(1)
                            Text(f.label).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        if f.notYourCode == true {
                            Text("not your code")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(Color.orange.opacity(0.15)))
                                .foregroundStyle(.orange)
                        }
                        Text(Format.ago(f.at, now: now))
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct ChecksSection: View {
    let rows: [Presenter.CheckRowModel]
    let isWatched: (WaitTarget) -> Bool
    var onToggle: (WaitTarget) -> Void
    var onOpen: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Checks").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(rows) { r in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle().fill(r.state == .red ? Color.red : Color.accentColor).frame(width: 7, height: 7)
                    Button { onOpen(r.url) } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.title).font(.system(size: 12.5)).lineLimit(1)
                            if let s = r.subtitle { Text(s).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(r.progress).font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(r.state == .red ? .red : .primary)
                        if let e = r.eta { Text(e).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.secondary) }
                    }
                    .monospacedDigit()
                    if r.state == .pending {
                        Button { onToggle(r.target) } label: {
                            Image(systemName: isWatched(r.target) ? "bell.fill" : "bell")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(isWatched(r.target) ? Color.accentColor : .secondary)
                        .help(isWatched(r.target) ? "Stop watching" : "Notify me when these checks finish")
                    }
                }
            }
        }
    }
}
