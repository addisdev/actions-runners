import Foundation

extension Tone {
    public var mark: String {
        switch self {
        case .critical: "✖"
        case .warning: "▲"
        case .unknown: "?"
        case .info, .ok: "✔"
        }
    }
}

/// `cockpit why <repo>`: the daemon's diagnosis, for a person.
public enum Why {
    public static func text(_ d: V1Diagnosis, repo: String) -> String {
        var out: [String] = []
        let short = (d.repo ?? repo).split(separator: "/").last.map(String.init) ?? repo
        if d.freshness.stale {
            // The verdict below was true when the collector last finished a
            // tick, which may be half an hour ago.
            out.append("? Collector stalled: the dashboard's view is \(d.freshness.ageMs.map { Format.duration(ms: $0) } ?? "of unknown age") old")
        }
        out.append("Fleet: \(d.verdict.tone.mark) \(d.verdict.title)")
        out.append("\n\(short): \(d.runners.count) runner(s)")
        if d.runners.isEmpty { out.append("  none registered — jobs for this repo can only queue (unserved)") }
        for r in d.runners { out.append("  \(r.state.rawValue.padding(toLength: 13, withPad: " ", startingAt: 0)) \(r.name)  \(r.detail ?? "")") }
        if !d.queue.isEmpty {
            out.append("\nQueued:")
            for q in d.queue {
                let eta = q.etaStartMs.map { "starts in \(Presenter.range($0))" }
                    ?? (q.neverStarts ? "will not start on its own" : q.etaBasis ?? "no estimate")
                out.append("  \(q.workflow ?? "?") — \(Format.short(ms: q.queuedMs ?? 0)), \(Presenter.causeLabel(q.cause)) (\(q.confidence ?? "?")); \(eta)")
                for e in q.evidence ?? [] { out.append("    · \(e)") }
                if let r = q.recommended { out.append("    → \(r)") }
            }
        }
        if !d.checks.isEmpty {
            out.append("\nChecks:")
            for s in d.checks {
                out.append("  \(s.label): \(s.progress)\(s.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")")
            }
        }
        if !d.orphans.isEmpty {
            out.append("\nOrphaned (the runner went away while the job was finishing):")
            for o in d.orphans {
                out.append("  \(o.summary)")
                for c in o.recovery { out.append("    \(c)") }
            }
        }
        if !d.failures.isEmpty {
            out.append("\nFailed in the last 2 hours:")
            for f in d.failures { out.append("  \(f.workflow ?? "?"): \(f.label)\(f.notYourCode == true ? "  [not your code]" : "")") }
            // The shmget error is in the step log, which no failure class reads.
            if let shm = d.verdict.open.first(where: { $0.id == "shm-low" }) {
                out.append("  ! \(shm.title): a Postgres suite that failed in shmget is the host, not the code")
                for e in (shm.evidence ?? []).prefix(2) { out.append("    · \(e)") }
            }
        }
        if !d.incidents.isEmpty {
            out.append("\nOpen alerts:")
            for i in d.incidents { out.append("  [\(i.severity ?? "?")] \(i.title)") }
        }
        return out.joined(separator: "\n")
    }
}
