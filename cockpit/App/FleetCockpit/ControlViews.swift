import SwiftUI
import CockpitCore

/// Confirmation, progress and result for control actions, inline in the
/// popover: a sheet or alert over a menu bar window fights the window's own
/// dismissal, an inline bar does not.
struct ControlBar: View {
    @Bindable var model: AppModel

    var body: some View {
        if let p = model.pending {
            VStack(alignment: .leading, spacing: 6) {
                Text(p.action.label).font(.system(size: 12, weight: .semibold))
                if let c = p.action.confirm {
                    Text(c).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Cancel") { model.pending = nil }
                    Button(p.action.label) { model.confirmPending() }
                        .buttonStyle(.borderedProminent)
                        .tint(p.action.isHighDanger ? .red : .accentColor)
                }
                .controlSize(.small)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.1)))
        } else if let r = model.running {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("\(r)…").font(.system(size: 11.5))
            }
        } else if let (label, r) = model.lastResult {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: r.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(r.ok ? .green : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.ok ? "\(label) finished" : "\(label) failed").font(.system(size: 11.5, weight: .semibold))
                    if !r.summary.isEmpty {
                        Text(r.summary).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                            .lineLimit(4).textSelection(.enabled)
                    }
                }
                Spacer()
                Button { model.lastResult = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
    }
}

/// One runner: what it is doing, what happened to it lately, and the actions
/// that apply to it.
struct RunnerPanel: View {
    @Bindable var model: AppModel
    let pill: PillModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                PillView(pill: pill, size: 12)
                Text(pill.shortName).font(.system(size: 13, weight: .semibold))
                Spacer()
                Button { model.select(nil) } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            Text(pill.detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let d = model.runnerDetail {
                if let u = d.utilization {
                    Text("\(u.jobCount ?? 0) jobs in \(u.days ?? 7) days, \(u.failureCount ?? 0) failed · \(Format.duration(ms: u.totalMs ?? 0)) busy")
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                }
                if let diag = d.diagSummary, (diag.errors ?? 0) > 0, let e = diag.lastError {
                    Text("_diag: \(diag.errors ?? 0) errors — \(e)").font(.system(size: 10.5)).foregroundStyle(.orange).lineLimit(2)
                }
                ForEach((d.jobs ?? []).prefix(4)) { j in
                    Button { model.open(j.html_url) } label: {
                        HStack(spacing: 6) {
                            Circle().fill(color(j)).frame(width: 6, height: 6)
                            Text(j.name ?? "job").font(.system(size: 11)).lineLimit(1)
                            Spacer()
                            Text(j.conclusion ?? j.status ?? "").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                ForEach(Array((d.events ?? []).prefix(3).enumerated()), id: \.offset) { _, e in
                    Text("\(Format.ago(e.ts, now: model.clockMs())) · \(e.detail ?? e.kind)")
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1)
                }
            } else {
                ProgressView().controlSize(.small)
            }
            HStack {
                if pill.state == .dead || pill.state == .offline {
                    Button("Repair") { model.request("fleet.healthRepair") }
                }
                Button("Restart") { model.request("runner.restart", args: ["name": pill.name]) }
                if pill.state == .draining {
                    Button("Resume") { model.request("runner.resume", args: ["name": pill.name]) }
                } else {
                    Button("Drain") { model.request("runner.drain", args: ["name": pill.name]) }
                }
                if pill.url != nil { Button("Open job") { model.open(pill.url) } }
            }
            .controlSize(.small)
            .disabled(!model.isPaired || model.running != nil)
            if !model.isPaired {
                Text("Pair this Mac in Settings to use these.").font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private func color(_ j: RunnerDetail.JobRow) -> Color {
        switch j.conclusion {
        case "success": .green
        case "failure", "timed_out": .red
        case nil: .accentColor
        default: .gray
        }
    }
}
