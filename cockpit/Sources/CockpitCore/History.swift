import Foundation

/// GET /api/timeline: the week in the ladder's terms.
public struct FleetTimeline: Codable, Sendable, Equatable {
    public struct Interval: Codable, Sendable, Equatable, Identifiable {
        public var id: String { "\(key)@\(Int(openedAt))" }
        public var key: String
        public var rule: String?
        public var severity: String?
        public var title: String
        public var openedAt: Double
        public var closedAt: Double?
        public var rung: String
    }
    public struct Today: Codable, Sendable, Equatable {
        public var since: Double
        public var jobs: Int
        public var queueMs: Double
        public var buildMs: Double
        public var lostJobs: Int
        public var heldSeconds: Double
    }
    public struct Week: Codable, Sendable, Equatable {
        public struct Wait: Codable, Sendable, Equatable { public var repo: String; public var queueMs: Double; public var jobs: Int }
        public var worstWait: [Wait]
        public var incidents: Int
        public var byRung: [String: Int]
        public var mttrMs: Double?
    }
    public struct Flaky: Codable, Sendable, Equatable { public var runner: String; public var lost: Int }

    public var days: Int
    public var generatedAt: Double
    public var incidents: [Interval]
    public var today: Today?
    public var week: Week?
    public var flaky: [Flaky]
    /// [ts, load per core, swap-ins/s, disk free GB, busy runners]
    public var samples: [[Double?]]
}

public extension FleetClient {
    func timeline(days: Int = 7) async throws -> FleetTimeline {
        try JSONDecoder().decode(FleetTimeline.self, from: try await get("api/timeline", query: ["days": String(days)]))
    }

    func posture(refresh: Bool = false) async throws -> PostureSummary {
        try JSONDecoder().decode(PostureSummary.self, from: try await get("api/posture", query: refresh ? ["refresh": "1"] : [:]))
    }

    /// The redacted diagnostic bundle for one runner (needs the device token).
    func bundle(runner: String) async throws -> Data {
        try await get("api/runner/bundle", query: ["name": runner])
    }
}

/// Lanes for the incident timeline: one per rung that had anything this week,
/// in ladder order, each interval clipped to the window.
public struct TimelineLane: Identifiable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var tone: Tone
    /// (start, end) as fractions of the window, 0…1.
    public var spans: [Span]

    public struct Span: Sendable, Equatable, Identifiable {
        public var id: String
        public var from: Double
        public var to: Double
        public var title: String
        public var durationMs: Double
        public var open: Bool
    }
}

public enum HistoryPresenter {
    static let order = ["host-down", "unknown", "disk-floor", "dead-service", "saturated", "account-blocked", "config-drift", "waiting", "failing"]
    static let titles = [
        "host-down": "Host down", "unknown": "Blind", "disk-floor": "Disk floor", "dead-service": "Dead service",
        "saturated": "Saturated", "account-blocked": "Account", "config-drift": "Config drift", "waiting": "Stuck queue",
        "failing": "Red builds",
    ]

    public static func lanes(_ t: FleetTimeline, windowMs: Double, now: Double) -> [TimelineLane] {
        let start = now - windowMs
        var byRung: [String: [FleetTimeline.Interval]] = [:]
        for i in t.incidents where (i.closedAt ?? now) >= start { byRung[i.rung, default: []].append(i) }
        return order.compactMap { rung in
            guard let list = byRung[rung], !list.isEmpty else { return nil }
            let tone: Tone = list.contains { $0.severity == "critical" } ? .critical : .warning
            return TimelineLane(id: rung, title: titles[rung] ?? rung, tone: tone, spans: list.map { i in
                let end = i.closedAt ?? now
                return .init(id: i.id, from: max(0, (i.openedAt - start) / windowMs), to: min(1, (end - start) / windowMs),
                             title: i.title, durationMs: end - i.openedAt, open: i.closedAt == nil)
            })
        }
    }

    /// "Jobs waited 3.1 h and ran 2.4 h today."
    public static func todayLine(_ t: FleetTimeline) -> String? {
        guard let d = t.today, d.jobs > 0 else { return nil }
        var s = "\(d.jobs) jobs today: waited \(Format.duration(ms: d.queueMs)), ran \(Format.duration(ms: d.buildMs))"
        if d.heldSeconds > 0 { s += ", held \(Format.duration(ms: d.heldSeconds * 1000)) by admission" }
        if d.lostJobs > 0 { s += ", \(d.lostJobs) lost to the host" }
        return s + "."
    }

    /// The weekly digest, as a notification body.
    public static func digest(_ t: FleetTimeline) -> (title: String, body: String) {
        guard let w = t.week else { return ("Fleet week", "No history yet.") }
        var parts: [String] = []
        parts.append(w.incidents == 0 ? "No incidents." : "\(w.incidents) incident\(w.incidents == 1 ? "" : "s")"
            + (w.mttrMs.map { ", cleared in \(Format.duration(ms: $0)) on average" } ?? "") + ".")
        let top = w.byRung.sorted { $0.value > $1.value }.prefix(2).map { "\(titles[$0.key] ?? $0.key) ×\($0.value)" }
        if !top.isEmpty { parts.append("Most: " + top.joined(separator: ", ") + ".") }
        if let worst = w.worstWait.first {
            parts.append("Longest waits: \(worst.repo.split(separator: "/").last.map(String.init) ?? worst.repo) (\(Format.duration(ms: worst.queueMs)) over \(worst.jobs) jobs).")
        }
        if let f = t.flaky.first, f.lost >= 2 { parts.append("\(f.runner) lost \(f.lost) jobs.") }
        return ("Fleet week: \(w.incidents == 0 ? "quiet" : "\(w.incidents) incidents")", parts.joined(separator: " "))
    }
}

/// Top CPU on the host, over the same SSH alias, with the one culprit this
/// fleet has met before named outright.
public enum HostProbe {
    public struct TopCPU: Sendable, Equatable {
        public var lines: [(cpu: Double, command: String)]
        public var spotlightCPU: Double
        public var verdict: String

        public static func == (a: TopCPU, b: TopCPU) -> Bool {
            a.verdict == b.verdict && a.spotlightCPU == b.spotlightCPU && a.lines.map(\.command) == b.lines.map(\.command)
        }
    }

    public static func parseTop(_ out: String) -> TopCPU {
        var lines: [(Double, String)] = []
        for raw in out.split(separator: "\n").dropFirst() {
            let parts = raw.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1)
            guard parts.count == 2, let cpu = Double(parts[0]) else { continue }
            lines.append((cpu, String(parts[1]).trimmingCharacters(in: .whitespaces)))
        }
        let spotlight = lines.filter { l in ["mds", "mds_stores", "mdworker", "mdworker_shared", "mdsync"].contains { l.1.hasSuffix($0) } }
            .reduce(0) { $0 + $1.0 }
        let verdict: String
        if spotlight >= 50 {
            verdict = "Spotlight is using \(Int(spotlight))% CPU — it is indexing, most likely the runner work trees. Exclude the fleet root in Spotlight privacy."
        } else if let top = lines.first, top.0 >= 100 {
            verdict = "\(top.1) is using \(Int(top.0))% CPU."
        } else {
            verdict = "Nothing is hogging the CPU right now."
        }
        return TopCPU(lines: lines.map { (cpu: $0.0, command: $0.1) }, spotlightCPU: spotlight, verdict: verdict)
    }

    public static func topCPU(alias: String) async -> TopCPU? {
        guard let out = await Shell.run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-T", alias,
                                                        "ps -Ao %cpu,comm -r | head -12"], timeout: 15) else { return nil }
        return parseTop(out)
    }
}
