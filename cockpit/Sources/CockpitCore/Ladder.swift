import Foundation

/// The rungs as the cockpit shows them: the daemon's ladder with the two
/// out-of-band rungs only a client can see put on top.
public struct LadderRung: Identifiable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var blurb: String
    public var tone: Tone
    /// This rung is the verdict.
    public var lit: Bool
    /// This rung is true right now (the verdict or one of the others open).
    public var open: Bool
    public var evidence: [String]
    public var next: NextMove?
}

public enum Ladder {
    static let rungs: [(id: String, title: String, blurb: String, tone: Tone, aliases: [String])] = [
        ("blind", "This Mac is offline", "Nothing answers from here; nothing can be said about the fleet.", .unknown, []),
        ("host-down", "Host down", "A host is asleep, off, rebooted with nobody logged in, or not reporting.", .critical, []),
        ("unknown", "Cannot read the fleet", "The dashboard or the collector is not answering; the view is out of date.",
         .unknown, ["unreachable", "dashboard-down", "off-network", "connecting"]),
        ("disk-floor", "Disk floor held", "Jobs held at Set up runner because free disk is under the admission floor.", .critical, []),
        ("dead-service", "Dead service", "A runner service died; launchd will not revive it.", .critical, []),
        ("saturated", "Saturated", "Jobs lose contact mid-step because the host is starved.", .warning, []),
        ("account-blocked", "Account blocked", "GitHub refuses or caps work. Nothing on the fleet is wrong.", .warning, []),
        ("config-drift", "Config drift", "Labels, orphans or unserved repos: work that can never be picked up.", .warning, []),
        ("waiting", "Waiting, healthy", "Queued behind a busy runner or normal dispatch. A queue is not a stall.", .ok, []),
        ("clear", "All clear", "Nothing running is in trouble and nothing is stuck.", .ok, []),
    ]

    public static func index(of id: String) -> Int? {
        rungs.firstIndex { $0.id == id || $0.aliases.contains(id) }
    }

    public static func build(_ verdict: Verdict) -> [LadderRung] {
        let litIndex = index(of: verdict.id)
        var openById: [Int: Finding] = [:]
        for f in verdict.open { if let i = index(of: f.id), openById[i] == nil { openById[i] = f } }
        return rungs.enumerated().map { i, r in
            let isLit = i == litIndex
            let finding = openById[i]
            return LadderRung(
                id: r.id,
                title: isLit ? verdict.title : finding?.title ?? r.title,
                blurb: isLit ? (verdict.sentence ?? r.blurb) : finding?.sentence ?? r.blurb,
                tone: isLit ? verdict.tone : finding?.tone ?? r.tone,
                lit: isLit,
                open: isLit || finding != nil,
                evidence: isLit ? verdict.evidence : finding?.evidence ?? [],
                next: isLit ? verdict.next : finding?.next
            )
        }
    }
}

/// A markdown incident brief, made to paste into an agent session, an issue or
/// a chat: what the cockpit concluded, why, and the state it concluded it from.
public enum IncidentBrief {
    public static func markdown(verdict: Verdict, glance: Glance?, route: String?, connection: String,
                                now: Date = Date()) -> String {
        let iso = ISO8601DateFormatter().string(from: now)
        var lines: [String] = []
        lines.append("## Fleet: \(verdict.title)")
        lines.append("")
        lines.append("_\(iso) · verdict `\(verdict.id)` (\(verdict.tone.rawValue)) · via \(route ?? "none") · \(connection)_")
        lines.append("")
        if let s = verdict.sentence { lines.append(s); lines.append("") }
        if !verdict.evidence.isEmpty {
            lines.append("**Evidence**")
            for e in verdict.evidence { lines.append("- \(e)") }
            lines.append("")
        }
        if let n = verdict.next, n.kind != "none" {
            var next = "**Next move:** \(n.label)"
            if let c = n.command { next += " — `\(c)`" }
            if let u = n.url { next += " — \(u)" }
            lines.append(next)
            lines.append("")
        }
        let others = verdict.open.filter { $0.id != verdict.id }
        if !others.isEmpty {
            lines.append("**Also open**")
            for f in others {
                lines.append("- \(f.title)" + ((f.evidence?.first).map { ": \($0)" } ?? ""))
            }
            lines.append("")
        }
        if let g = glance {
            lines.append("**State** — \(g.counts.running) running, \(g.counts.queued) queued, \(g.counts.held) held, \(g.counts.runners) runners"
                + (g.ageMs.map { ", snapshot \(Format.short(ms: $0)) old" } ?? ""))
            for h in g.hosts where h.local == true || h.ghOnly != true {
                guard let v = h.vitals else { continue }
                var bits: [String] = []
                if let l = v.loadPerCore { bits.append(String(format: "load %.1f/core", l)) }
                if let p = v.memPressure { bits.append("memory \(p)") }
                if let s = v.swapinsPerSec { bits.append("swap-ins \(Int(s))/s") }
                if let d = v.diskFreeGb { bits.append("disk \(Format.gb(d)) free" + (v.diskFloorGb.map { " (floor \(Int($0)) GB)" } ?? "")) }
                lines.append("- \(h.name): " + bits.joined(separator: ", "))
            }
            let trouble = g.runners.filter { ![.idle, .busy, .heldSlot].contains($0.state) }
            if !trouble.isEmpty {
                lines.append("")
                lines.append("**Runners not idle or busy**")
                for r in trouble.prefix(12) { lines.append("- `\(r.name)` \(r.state.rawValue)" + (r.detail.map { ": \($0)" } ?? "")) }
            }
            if !g.queue.isEmpty {
                lines.append("")
                lines.append("**Queue**")
                for q in g.queue.prefix(8) {
                    lines.append("- \(q.repo) · \(q.workflow ?? "?") — \(Format.short(ms: q.queuedMs ?? 0)), \(q.cause ?? "?")")
                }
            }
            let incidents = g.incidents.filter { $0.dismissed != true }
            if !incidents.isEmpty {
                lines.append("")
                lines.append("**Open alerts**")
                for i in incidents.prefix(8) { lines.append("- [\(i.severity ?? "?")] \(i.title)") }
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }
}
