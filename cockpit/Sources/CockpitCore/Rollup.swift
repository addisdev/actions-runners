import Foundation

/// A commit's checks as one row: "PR #96 · 2 of 5 done · green in 11–26m".
public struct CheckSet: Identifiable, Sendable, Equatable {
    public enum State: String, Sendable, Codable { case pending, green, red }

    public var id: String
    public var repo: String
    public var prNumber: Int?
    public var branch: String?
    public var sha: String?
    public var title: String?
    public var runs: [RunRow]
    public var total: Int
    public var done: Int
    public var failed: [RunRow]
    public var queued: [QueueItem]
    /// Until every check is finished, as a p50…p90-ish range; nil when unknown.
    public var etaGreenMs: [Double]?
    public var state: State

    public var label: String {
        let repoShort = repo.split(separator: "/").last.map(String.init) ?? repo
        if let pr = prNumber { return "\(repoShort) PR #\(pr)" }
        if let b = branch { return "\(repoShort) · \(b)" }
        return repoShort
    }

    public var progress: String {
        switch state {
        case .green: "\(total) of \(total) green"
        case .red: "\(failed.count) failed · \(done) of \(total) done"
        case .pending: "\(done) of \(total) done"
        }
    }
}

public enum Rollup {
    /// Groups active and recent runs by commit (or branch when a run carries no
    /// sha). Within a commit the newest run of each workflow wins, so a re-run
    /// that went green replaces the red attempt it retried.
    public static func checkSets(_ g: Glance) -> [CheckSet] {
        let all = (g.runs ?? []) + (g.recent ?? [])
        var groups: [String: [RunRow]] = [:]
        for r in all {
            let key = "\(r.repo)@\(r.sha ?? r.branch ?? String(r.id))"
            groups[key, default: []].append(r)
        }
        let queueById = Dictionary(g.queue.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return groups.map { key, runs in
            var latest: [String: RunRow] = [:]
            for r in runs.sorted(by: { ($0.updatedAt ?? 0, $0.id) < ($1.updatedAt ?? 0, $1.id) }) {
                latest[r.workflow ?? String(r.id)] = r
            }
            let rs = latest.values.sorted { ($0.workflow ?? "") < ($1.workflow ?? "") }
            let active = rs.filter(\.isActive)
            let failed = rs.filter(\.failed)
            let queued = active.compactMap { queueById[$0.id] }
            let state: CheckSet.State = !active.isEmpty ? .pending : failed.isEmpty ? .green : .red
            let head = rs.first { $0.prNumber != nil } ?? rs.first!
            return CheckSet(
                id: key, repo: head.repo, prNumber: head.prNumber, branch: head.branch, sha: head.sha,
                title: head.title, runs: rs, total: rs.count, done: rs.count - active.count, failed: failed,
                queued: queued, etaGreenMs: state == .pending ? eta(active, queueById) : nil, state: state
            )
        }
        .sorted { a, b in
            if (a.state == .pending) != (b.state == .pending) { return a.state == .pending }
            return (a.runs.map { $0.updatedAt ?? 0 }.max() ?? 0) > (b.runs.map { $0.updatedAt ?? 0 }.max() ?? 0)
        }
    }

    /// The slowest remaining check decides when the commit is green.
    static func eta(_ active: [RunRow], _ queue: [Int: QueueItem]) -> [Double]? {
        var lo = 0.0, hi = 0.0
        for r in active {
            if let q = queue[r.id] {
                guard let d = q.etaDoneMs, d.count == 2 else { return nil }
                lo = max(lo, d[0]); hi = max(hi, d[1])
            } else if let exp = r.expectedMs, let el = r.elapsedMs {
                // expectedMs is the workflow's p95, so it bounds the high end;
                // 60 % of it is a fair "typical" low end.
                lo = max(lo, max(0, exp * 0.6 - el)); hi = max(hi, max(0, exp - el))
            } else {
                return nil
            }
        }
        return [lo, hi]
    }

    public static func find(_ g: Glance, repo: String, pr: Int? = nil, sha: String? = nil, branch: String? = nil) -> CheckSet? {
        checkSets(g).first { s in
            (s.repo == repo || s.repo.hasSuffix("/" + repo))
                && (pr == nil || s.prNumber == pr)
                && (sha == nil || (s.sha.map { sha!.hasPrefix($0) || $0.hasPrefix(sha!) } ?? false))
                && (branch == nil || s.branch == branch)
        }
    }
}

/// What `cockpit wait` (and a watch) should do with the latest glance.
public enum WaitDecision: Sendable, Equatable {
    case waiting(CheckSet?)
    case green(CheckSet)
    case red(CheckSet)
    /// Waiting cannot end well: say why and stop.
    case pointless(String)

    public var exitCode: Int32 {
        switch self {
        case .green: 0
        case .red: 1
        case .pointless: 2
        case .waiting: 3
        }
    }
}

public struct WaitTarget: Sendable, Equatable, Codable {
    public var repo: String
    public var pr: Int?
    public var sha: String?
    public var branch: String?

    public init(repo: String, pr: Int? = nil, sha: String? = nil, branch: String? = nil) {
        self.repo = repo; self.pr = pr; self.sha = sha; self.branch = branch
    }

    public var label: String {
        let r = repo.split(separator: "/").last.map(String.init) ?? repo
        if let pr { return "\(r) PR #\(pr)" }
        if let sha { return "\(r) @ \(sha.prefix(7))" }
        if let branch { return "\(r) · \(branch)" }
        return r
    }
}

public enum Waiter {
    static let infra: Set<String> = ["host-down", "disk-floor", "blind"]

    public static func decide(_ g: Glance, verdict: Verdict, target t: WaitTarget) -> WaitDecision {
        let set = Rollup.find(g, repo: t.repo, pr: t.pr, sha: t.sha, branch: t.branch)
        if let s = set, s.state == .green { return .green(s) }
        if let s = set, s.state == .red { return .red(s) }

        // Only now ask whether the wait can end: a finished result beats a
        // verdict about the fleet.
        if infra.contains(verdict.id) {
            return .pointless("\(verdict.title): \(verdict.sentence ?? "")")
        }
        if let blocked = verdict.open.first(where: { $0.id == "account-blocked" && $0.blocking == true }) {
            return .pointless("\(blocked.title): jobs are refused before they reach a runner")
        }
        let repoMatch: (String) -> Bool = { $0 == t.repo || $0.hasSuffix("/" + t.repo) }
        if let stuck = (set?.queued ?? g.queue.filter { repoMatch($0.repo) })
            .first(where: { ["runner-down", "unserved", "role-unserved", "label-mismatch", "github-hosted"].contains($0.cause ?? "") }) {
            return .pointless("\(stuck.workflow ?? "a check") is queued with cause \(stuck.cause ?? "?") — it will not start on its own. \(stuck.recommended ?? "")")
        }
        if let dead = g.runners.first(where: { repoMatch($0.repo ?? "") && ($0.state == .dead || $0.state == .offline) }),
           !g.runners.contains(where: { repoMatch($0.repo ?? "") && [.idle, .busy, .overdue].contains($0.state) }) {
            return .pointless("\(dead.name) is \(dead.state.rawValue) and no other runner serves \(t.repo)")
        }
        return .waiting(set)
    }
}

/// A person's "tell me when this is done", kept by the app.
public struct Watch: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(target.repo)|\(target.pr.map(String.init) ?? "")|\(target.sha ?? "")|\(target.branch ?? "")" }
    public var target: WaitTarget
    public var createdAt: Double

    public init(target: WaitTarget, createdAt: Double) { self.target = target; self.createdAt = createdAt }

    /// Finished watches, with how they finished.
    public static func finished(_ watches: [Watch], glance g: Glance) -> [(Watch, CheckSet)] {
        watches.compactMap { w in
            guard let s = Rollup.find(g, repo: w.target.repo, pr: w.target.pr, sha: w.target.sha, branch: w.target.branch),
                  s.state != .pending,
                  // Only a result that arrived after the watch was set.
                  (s.runs.compactMap(\.updatedAt).max() ?? 0) >= w.createdAt else { return nil }
            return (w, s)
        }
    }
}
