import Foundation

// Pure mapping from a glance (plus connection state) to what the views draw.
// Everything a person reads — which glyph, which words, which order — is
// decided here so it can be tested without SwiftUI.

/// Shape carries the state; colour only reinforces it, so the grid reads the
/// same to someone who cannot tell red from green.
public enum PillShape: String, Sendable {
    case ring, progress, hourglass, square, dashed, cross, diamond, arrow, question, hatched, dotted
}

public enum PillColor: String, Sendable {
    case idle, busy, caution, neutral, critical, config, faint
}

public struct PillModel: Identifiable, Sendable, Equatable {
    public var id: String { name }
    public var name: String
    public var shortName: String
    public var state: RunnerState
    public var shape: PillShape
    public var color: PillColor
    public var progress: Double?
    public var detail: String
    public var accessibilityLabel: String
    public var url: String?
}

public struct GroupModel: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var pills: [PillModel]
}

public struct DiskModel: Sendable, Equatable {
    public var freeGb: Double
    public var totalGb: Double?
    public var floorGb: Double?
    /// 0…1 positions on a scale that always shows the floor with room above it.
    public var freeFraction: Double
    public var floorFraction: Double?
    public var scaleMaxGb: Double
    public var tone: Tone
    public var caption: String
    public var eta: String?
}

public struct VitalModel: Sendable, Equatable, Identifiable {
    public var id: String { label }
    public var label: String
    public var value: String
    public var tone: Tone
}

public struct LaneModel: Identifiable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var subtitle: String
    public var ghOnly: Bool
    public var stale: Bool
    public var vitals: [VitalModel]
    public var disk: DiskModel?
    public var groups: [GroupModel]
    public var runnerCount: Int
}

public struct QueueRowModel: Identifiable, Sendable, Equatable {
    public var id: Int
    public var title: String
    public var subtitle: String?
    public var cause: String
    public var causeTone: Tone
    public var age: String
    public var eta: String?
    public var recommended: String?
    public var url: String?
}

public struct MenuBarModel: Sendable, Equatable {
    public var tone: Tone
    public var symbol: String
    public var counts: String
    public var tooltip: String
}

public enum Presenter {
    // MARK: pills

    public static func pill(_ r: Runner, hostName: String, now: Double) -> PillModel {
        let short = shortName(r.name, hostName: hostName)
        let (shape, color): (PillShape, PillColor) = {
            switch r.state {
            case .idle: (.ring, .idle)
            case .busy: (.progress, .busy)
            case .overdue: (.progress, .caution)
            case .heldSlot: (.hourglass, .neutral)
            case .heldDisk: (.square, .critical)
            case .settling: (.dashed, .caution)
            case .offline: (.cross, .critical)
            case .dead: (.cross, .critical)
            case .lost: (.diamond, .caution)
            case .draining: (.arrow, .neutral)
            case .misconfigured: (.question, .config)
            case .hostDown: (.hatched, .faint)
            case .unknown: (.dotted, .faint)
            }
        }()
        var progress: Double?
        if let job = r.job, let expected = job.expectedMs, expected > 0 {
            let elapsed = job.elapsedMs ?? job.startedAt.map { now - $0 } ?? 0
            progress = min(1.5, max(0, elapsed / expected))
        } else if r.state == .busy || r.state == .overdue {
            progress = nil
        }
        let detail = r.detail ?? r.state.rawValue
        return PillModel(
            name: r.name,
            shortName: short,
            state: r.state,
            shape: shape,
            color: color,
            progress: progress,
            detail: detail,
            accessibilityLabel: accessibility(short, r, progress: progress),
            url: r.job?.url
        )
    }

    static func accessibility(_ short: String, _ r: Runner, progress: Double?) -> String {
        let words: String = switch r.state {
        case .idle: "idle"
        case .busy: "busy"
        case .overdue: "running past its usual time"
        case .heldSlot: "waiting for an admission slot"
        case .heldDisk: "held by the disk floor"
        case .settling: "offline, probably reconnecting"
        case .offline: "offline"
        case .dead: "service dead"
        case .lost: "lost a job recently"
        case .draining: "draining"
        case .misconfigured: "misconfigured"
        case .hostDown: "host down"
        case .unknown: "state unknown"
        }
        if let job = r.job, let expected = job.expectedMs, let elapsed = job.elapsedMs {
            return "\(short), \(words), \(Format.duration(ms: elapsed)) of about \(Format.duration(ms: expected))"
        }
        return "\(short), \(words)"
    }

    /// register.sh names runners `<host>-<repo>`; inside a host's lane the
    /// prefix is noise.
    public static func shortName(_ name: String, hostName: String) -> String {
        for prefix in [hostName + "-", hostName.lowercased() + "-"] where name.hasPrefix(prefix) && name.count > prefix.count {
            return String(name.dropFirst(prefix.count))
        }
        return name
    }

    // MARK: lanes

    public static func lanes(_ g: Glance, now: Double) -> [LaneModel] {
        let order = g.hosts.sorted { a, b in
            // The coordinator first, supervised agents next, GitHub-only lanes last.
            func rank(_ h: Host) -> Int { h.local == true ? 0 : h.ghOnly == true ? 2 : 1 }
            return rank(a) == rank(b) ? a.name < b.name : rank(a) < rank(b)
        }
        return order.compactMap { h in
            let runners = g.runners.filter { $0.host == h.id }
            guard !runners.isEmpty || h.local == true else { return nil }
            var byProject: [String: [Runner]] = [:]
            // A small lane reads better as one row than as five one-pill rows.
            let flat = runners.count <= 8
            for r in runners { byProject[flat ? "all" : (r.project ?? "other"), default: []].append(r) }
            let groups = byProject.keys.sorted { a, b in
                if a == "other" { return false }
                if b == "other" { return true }
                return a < b
            }.map { p in
                GroupModel(
                    id: "\(h.id)/\(p)",
                    name: p,
                    pills: byProject[p]!.sorted { $0.name < $1.name }.map { pill($0, hostName: h.name, now: now) }
                )
            }
            let subtitle: String = {
                if h.stale == true { return "not reporting for \(Format.duration(ms: h.staleForMs ?? 0))" }
                if h.ghOnly == true { return "GitHub view only" }
                if h.drained == true { return "drained" }
                if let up = h.vitals?.uptimeSec { return "up \(Format.duration(ms: up * 1000))" }
                return ""
            }()
            return LaneModel(
                id: h.id,
                title: "\(h.name) · \(runners.count) runner\(runners.count == 1 ? "" : "s")",
                subtitle: subtitle,
                ghOnly: h.ghOnly == true,
                stale: h.stale == true,
                vitals: h.vitals.map(vitals) ?? [],
                disk: h.vitals.flatMap(disk),
                groups: groups,
                runnerCount: runners.count
            )
        }
    }

    public static func vitals(_ v: Vitals) -> [VitalModel] {
        var out: [VitalModel] = []
        if let lpc = v.loadPerCore {
            // Informational only: one Xcode build pushes load past 8 per core on
            // a 12-core host, and that is healthy. Never red.
            out.append(VitalModel(label: "load / core", value: String(format: "%.1f", lpc), tone: lpc >= 4 ? .warning : .ok))
        }
        if let p = v.memPressure {
            out.append(VitalModel(label: "memory", value: p, tone: p == "critical" ? .critical : p == "warning" ? .warning : .ok))
        }
        if let s = v.swapinsPerSec {
            out.append(VitalModel(label: "swap-ins", value: "\(Int(s.rounded()))/s", tone: s >= 50 ? .warning : .ok))
        }
        return out
    }

    public static func disk(_ v: Vitals) -> DiskModel? {
        guard let free = v.diskFreeGb else { return nil }
        let floor = v.diskFloorGb
        // Scale: enough headroom that "just above the floor" looks close to it,
        // without the floor collapsing into the left edge on a 2 TB disk.
        let scaleMax = max(200, (floor ?? 0) * 4, free * 1.15).rounded()
        let tone: Tone = {
            guard let floor else { return free < 20 ? .critical : .ok }
            if free < floor { return .critical }
            if free < floor + 15 { return .warning }
            return .ok
        }()
        let caption: String = {
            guard let floor else { return "\(Format.gb(free)) free" }
            let margin = free - floor
            return margin >= 0
                ? "\(Format.gb(free)) free · \(Format.gb(margin)) above the \(Int(floor)) GB floor"
                : "\(Format.gb(free)) free · \(Format.gb(-margin)) BELOW the \(Int(floor)) GB floor"
        }()
        let eta = v.diskFloorEtaMs.map { ms -> String in
            let rate = v.diskRateGbPerHour.map { String(format: " (−%.1f GB/h)", abs($0)) } ?? ""
            return "floor in ~\(Format.duration(ms: ms))\(rate)"
        }
        return DiskModel(
            freeGb: free,
            totalGb: v.diskTotalGb,
            floorGb: floor,
            freeFraction: min(1, free / scaleMax),
            floorFraction: floor.map { min(1, $0 / scaleMax) },
            scaleMaxGb: scaleMax,
            tone: tone,
            caption: caption,
            eta: eta
        )
    }

    // MARK: queue

    public static func causeTone(_ cause: String?) -> Tone {
        switch cause {
        case "runner-down", "unserved", "label-mismatch": .critical
        case "host-saturation", "role-unserved", "github-hosted", "concurrency-block": .warning
        case "repo-capacity", "github-delay": .ok
        default: .unknown
        }
    }

    public static func causeLabel(_ cause: String?) -> String {
        switch cause {
        case "github-delay": "normal dispatch"
        case "repo-capacity": "behind a busy runner"
        case "runner-down": "runner down"
        case "host-saturation": "host saturated"
        case "label-mismatch": "no runner matches"
        case "unserved": "no runner"
        case "role-unserved": "no runner for role"
        case "github-hosted": "wants a hosted runner"
        case "concurrency-block": "concurrency group"
        case "telemetry-unavailable": "cannot diagnose"
        case let c?: c
        case nil: "queued"
        }
    }

    public static func queue(_ g: Glance) -> [QueueRowModel] {
        g.queue.sorted { ($0.queuedMs ?? 0) > ($1.queuedMs ?? 0) }.map { q in
            let repo = q.repo.split(separator: "/").last.map(String.init) ?? q.repo
            var sub: [String] = []
            if let pr = q.prNumber { sub.append("PR #\(pr)") } else if let b = q.branch { sub.append(b) }
            if let t = q.title { sub.append(t) }
            let eta: String? = {
                if let r = q.etaStartMs, r.count == 2 {
                    var s = r[1] <= 0 ? "starting" : "starts in \(range(r))"
                    if let d = q.etaDoneMs, d.count == 2 { s += " · done in \(range(d))" }
                    return s
                }
                if ["runner-down", "unserved", "role-unserved", "label-mismatch", "github-hosted"].contains(q.cause ?? "") {
                    return "won't start on its own"
                }
                return nil
            }()
            return QueueRowModel(
                id: q.id,
                title: "\(repo) · \(q.workflow ?? "workflow")",
                subtitle: sub.isEmpty ? nil : sub.joined(separator: " · "),
                cause: causeLabel(q.cause),
                causeTone: causeTone(q.cause),
                age: Format.short(ms: q.queuedMs ?? 0),
                eta: eta,
                recommended: q.recommended,
                url: q.url
            )
        }
    }

    /// "4m–11m", or "~5m" when the two ends round the same.
    public static func range(_ r: [Double]) -> String {
        let a = Format.short(ms: r[0]), b = Format.short(ms: r[1])
        return a == b ? "~\(a)" : "\(a)–\(b)"
    }

    public struct CheckRowModel: Identifiable, Sendable, Equatable {
        public var id: String
        public var title: String
        public var subtitle: String?
        public var progress: String
        public var eta: String?
        public var state: CheckSet.State
        public var target: WaitTarget
        public var url: String?
    }

    /// Commits with checks still running, plus anything that finished red.
    public static func checks(_ g: Glance, limit: Int = 5) -> [CheckRowModel] {
        Rollup.checkSets(g).filter { $0.state != .green }.prefix(limit).map { s in
            CheckRowModel(
                id: s.id, title: s.label, subtitle: s.title, progress: s.progress,
                eta: s.etaGreenMs.map { "done in \(range($0))" },
                state: s.state,
                target: WaitTarget(repo: s.repo, pr: s.prNumber, sha: s.prNumber == nil ? s.sha : nil,
                                   branch: s.prNumber == nil && s.sha == nil ? s.branch : nil),
                url: (s.failed.first ?? s.runs.first)?.url
            )
        }
    }

    // MARK: menu bar

    public static func symbol(for tone: Tone, verdictId: String) -> String {
        switch verdictId {
        case "blind": return "wifi.slash"
        case "host-down": return "bolt.horizontal.circle"
        case "disk-floor": return "externaldrive.badge.exclamationmark"
        default: break
        }
        switch tone {
        case .critical: return "xmark.octagon"
        case .warning: return "exclamationmark.triangle"
        case .unknown: return "questionmark.circle"
        case .info, .ok: return "checkmark.circle"
        }
    }

    public static func menuBar(verdict: Verdict, counts: Counts?, showCounts: Bool) -> MenuBarModel {
        var parts: [String] = []
        if showCounts, let c = counts {
            if c.running > 0 { parts.append("\(c.running)▸") }
            if c.queued > 0 { parts.append("\(c.queued)◷") }
        }
        return MenuBarModel(
            tone: verdict.tone,
            symbol: symbol(for: verdict.tone, verdictId: verdict.id),
            counts: parts.joined(separator: " "),
            tooltip: [verdict.title, verdict.sentence].compactMap { $0 }.joined(separator: " — ")
        )
    }
}
