import Foundation

/// GitHub's own view of a PR's checks: `gh pr view <n> --json
/// headRefOid,statusCheckRollup`, the branch ref, and the head's workflow
/// runs. Cockpit's rows are a copy of this, made by the daemon's fast loop;
/// when that loop stops finishing ticks the copy freezes, so a wait asks the
/// original as well (shop-ios PR #445 and shop-android PR #280, 2026-10-07:
/// both green on GitHub while cockpit still showed them running).
///
/// The same green rule as the daemon's (dashboard/lib/checks.js
/// githubVerdict): every workflow run for the head completed, every check
/// completed and passed, and nothing new for `settleMs`. The rollup lists only
/// jobs that exist, and a job behind `needs:` exists only once its needs
/// finish, so a green rollup alone is not the end (stream-app PR #5,
/// 2026-10-24).
public struct GitHubChecks: Sendable, Equatable {
    public struct Check: Sendable, Equatable {
        public var name: String
        public var workflow: String?
        /// Lowercased, in the REST spelling: `completed` / `in_progress` / `queued`.
        public var status: String
        public var conclusion: String?
        public var url: String?
        public var completedAt: Double? = nil
    }

    /// One workflow run for the head, from `actions/runs?head_sha=`.
    public struct Run: Sendable, Equatable {
        public var id: Int
        public var workflowId: Int?
        public var name: String?
        public var status: String
        public var conclusion: String?
        public var createdAt: Double?
        public var updatedAt: Double?
        public var url: String?
    }

    /// How long GitHub must have been quiet about the head before a green.
    public static let settleMs: Double = 30_000

    public var head: String?
    public var checks: [Check]
    /// The head's workflow runs; nil when not asked (judged by checks alone).
    public var runs: [Run]? = nil
    /// When GitHub was asked, epoch ms; the settle window counts from it.
    public var fetchedAt: Double? = nil
    /// From the PR view, to find where its branch is now.
    public var open: Bool = false
    public var headRepo: String? = nil
    public var headRef: String? = nil

    /// The newest run of each workflow, as in the fleet's rollup.
    public var latestRuns: [Run] {
        var by: [String: Run] = [:]
        for r in runs ?? [] {
            let key = r.workflowId.map(String.init) ?? r.name ?? String(r.id)
            if let held = by[key], held.id > r.id { continue }
            by[key] = r
        }
        return by.values.sorted { $0.id < $1.id }
    }

    var lastChange: Double {
        (latestRuns.flatMap { [$0.createdAt, $0.updatedAt] } + (runs ?? []).map(\.createdAt) + checks.map(\.completedAt))
            .compactMap { $0 }.max() ?? 0
    }

    /// Why a finished-looking answer is still pending; nil otherwise.
    public var pendingWhy: String? {
        let runs = latestRuns
        if checks.isEmpty && runs.isEmpty { return "GitHub has no runs or checks for the head yet" }
        if let r = runs.first(where: { $0.status != "completed" }) {
            return "GitHub still has \(r.name ?? "a run") \(r.status.replacingOccurrences(of: "_", with: " "))"
        }
        if let c = checks.first(where: { $0.status != "completed" }) { return "GitHub still has \(c.name) running" }
        if !failedAny, let fetchedAt, case let quiet = fetchedAt - lastChange, quiet < Self.settleMs {
            return "settling: GitHub's newest run or job changed \(Int(max(0, quiet / 1000))) s ago, and a green waits \(Int(Self.settleMs / 1000)) s for any run still to register"
        }
        return nil
    }

    var failedAny: Bool {
        !rows.allSatisfy(\.passed) || !latestRuns.allSatisfy { ["success", "skipped", "neutral"].contains($0.conclusion ?? "") }
    }

    public var state: CheckSet.State {
        if pendingWhy != nil { return .pending }
        return failedAny ? .red : .green
    }

    /// As cockpit rows, so a GitHub answer reports exactly like a cockpit one
    /// (same green rule: success/skipped/neutral only; cancelled is red). A
    /// run with no job in the rollup yet is one row of its own.
    var rows: [RunRow] {
        let listed = checks.map { c -> RunRow in
            RunRow(id: 0, repo: "", workflow: c.name, status: c.status, conclusion: c.conclusion,
                   branch: nil, sha: head, prNumber: nil, event: nil, title: nil, url: c.url,
                   startedAt: nil, updatedAt: nil, elapsedMs: nil, expectedMs: nil)
        }
        let unlisted = latestRuns.filter { r in !checks.contains { $0.url?.contains("/actions/runs/\(r.id)/") == true } }
            .map { r in
                RunRow(id: 0, repo: "", workflow: r.name, status: r.status, conclusion: r.status == "completed" ? r.conclusion : nil,
                       branch: nil, sha: head, prNumber: nil, event: nil, title: nil, url: r.url,
                       startedAt: nil, updatedAt: nil, elapsedMs: nil, expectedMs: nil)
            }
        return (listed + unlisted).enumerated().map { i, r in var r = r; r.id = -(i + 1); return r }
    }

    public func checkSet(repo: String, pr: Int?) -> CheckSet {
        let rs = rows.map { r -> RunRow in var r = r; r.repo = repo; r.prNumber = pr; return r }
        let failed = rs.filter(\.failed)
        let done = rs.filter { !$0.isActive }.count
        var set = CheckSet(id: "github:\(repo)@\(head ?? "?")", repo: repo, prNumber: pr, branch: nil,
                           sha: head.map { String($0.prefix(12)) }, title: nil, runs: rs, total: rs.count, done: done,
                           failed: failed, queued: [], etaGreenMs: nil, state: state)
        set.why = pendingWhy
        return set
    }

    static func ms(_ s: String?) -> Double? {
        s.flatMap { ISO8601DateFormatter().date(from: $0) }.map { $0.timeIntervalSince1970 * 1000 }
    }

    /// Parses `gh pr view --json headRefOid,headRefName,headRepository,
    /// headRepositoryOwner,state,statusCheckRollup`. Check runs carry status +
    /// conclusion; commit statuses carry one `state`.
    public static func parse(prView data: Data) throws -> GitHubChecks {
        struct Item: Decodable {
            var __typename: String?
            var name: String?
            var context: String?
            var workflowName: String?
            var status: String?
            var conclusion: String?
            var state: String?
            var detailsUrl: String?
            var targetUrl: String?
            var completedAt: String?
            var startedAt: String?
        }
        struct Named: Decodable { var name: String?; var login: String? }
        struct View: Decodable {
            var headRefOid: String?
            var headRefName: String?
            var headRepository: Named?
            var headRepositoryOwner: Named?
            var state: String?
            var statusCheckRollup: [Item]?
        }
        let v = try JSONDecoder().decode(View.self, from: data)
        let checks = (v.statusCheckRollup ?? []).map { i -> Check in
            if i.__typename == "StatusContext" || (i.status == nil && i.state != nil) {
                let s = (i.state ?? "PENDING").uppercased()
                let finished = !["PENDING", "EXPECTED"].contains(s)
                let conclusion: String? = switch s {
                case "SUCCESS": "success"
                case "PENDING", "EXPECTED": nil
                default: "failure" // FAILURE, ERROR
                }
                return Check(name: i.context ?? i.name ?? "status", workflow: nil,
                             status: finished ? "completed" : "in_progress", conclusion: conclusion,
                             url: i.targetUrl, completedAt: finished ? ms(i.startedAt) : nil)
            }
            let status = (i.status ?? "QUEUED").lowercased()
            return Check(name: i.name ?? "check", workflow: i.workflowName,
                         status: status == "completed" ? "completed" : status,
                         conclusion: status == "completed" ? (i.conclusion ?? "").lowercased() : nil,
                         url: i.detailsUrl, completedAt: ms(i.completedAt))
        }
        var c = GitHubChecks(head: v.headRefOid, checks: checks)
        c.open = v.state?.uppercased() == "OPEN"
        if let owner = v.headRepositoryOwner?.login, let name = v.headRepository?.name { c.headRepo = "\(owner)/\(name)" }
        c.headRef = v.headRefName
        return c
    }

    /// Parses `gh api repos/<repo>/actions/runs?head_sha=<sha>`.
    public static func parse(runs data: Data) throws -> [Run] {
        struct R: Decodable {
            var id: Int
            var workflow_id: Int?
            var name: String?
            var status: String?
            var conclusion: String?
            var created_at: String?
            var updated_at: String?
            var html_url: String?
        }
        struct Page: Decodable { var workflow_runs: [R]? }
        return (try JSONDecoder().decode(Page.self, from: data).workflow_runs ?? []).map { r in
            let status = r.status ?? "queued"
            return Run(id: r.id, workflowId: r.workflow_id, name: r.name, status: status == "completed" ? "completed" : status,
                       conclusion: status == "completed" ? (r.conclusion ?? "") : nil,
                       createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), url: r.html_url)
        }
    }
}

/// Asks GitHub through the `gh` CLI. `gh pr view` is GraphQL, whose budget is
/// separate from the REST budget the daemon's token polls with, and a wait
/// asks at most a few times a minute — far from the bulk calls that once
/// rate-penalized the daemon.
public struct GHChecksProbe: Sendable {
    public var repo: String
    public var pr: Int
    public var timeout: TimeInterval = 20

    public init(repo: String, pr: Int) { self.repo = repo; self.pr = pr }

    /// nil unless GitHub answered all of it: a part missing is not a yes.
    public func fetch() async -> GitHubChecks? {
        let asked = Format.nowMs()
        guard let out = await Self.gh(["pr", "view", String(pr), "-R", repo, "--json",
                                       "headRefOid,headRefName,headRepository,headRepositoryOwner,state,statusCheckRollup"],
                                      timeout: timeout),
              var c = try? GitHubChecks.parse(prView: out) else { return nil }
        // The PR's head catches up with a push a moment after the branch
        // moves; until it does, its rollup is the previous head's.
        if c.open, let from = c.headRepo, let ref = c.headRef,
           let b = await Self.gh(["api", "repos/\(from)/git/ref/heads/\(ref)", "--jq", ".object.sha"], timeout: timeout) {
            let sha = String(decoding: b, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if sha.count == 40, sha != c.head { c.head = sha; c.checks = [] }
        }
        guard let head = c.head,
              let runs = await Self.gh(["api", "repos/\(repo)/actions/runs?head_sha=\(head)&per_page=100"], timeout: timeout),
              let parsed = try? GitHubChecks.parse(runs: runs) else { return nil }
        c.runs = parsed
        c.fetchedAt = asked
        return c
    }

    /// `owner/name` for a bare repo name: from the glance when it knows the
    /// repo, else gh's own resolution (the signed-in account's repo).
    public static func fullName(_ repo: String, glance: Glance?) async -> String? {
        if repo.contains("/") { return repo }
        let known = ((glance?.runs ?? []) + (glance?.recent ?? [])).map(\.repo) + (glance?.runners ?? []).compactMap(\.repo)
        if let hit = known.first(where: { $0.hasSuffix("/" + repo) }) { return hit }
        guard let out = await gh(["repo", "view", repo, "--json", "nameWithOwner", "-q", ".nameWithOwner"], timeout: 20) else { return nil }
        let name = String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return name.contains("/") ? name : nil
    }

    /// The MCP server and launchd jobs get a bare PATH, so look where
    /// Homebrew puts gh before trusting `env`.
    static var ghPath: String? {
        ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Never hangs past `timeout`: see `Subprocess` for the 2026-10-09 hang
    /// this used to have (terminate() racing waitUntilExit()).
    static func gh(_ args: [String], timeout: TimeInterval) async -> Data? {
        let (path, argv) = ghPath.map { ($0, args) } ?? ("/usr/bin/env", ["gh"] + args)
        guard let r = await Subprocess.run(path, argv, timeout: timeout), r.status == 0 else { return nil }
        return r.stdout
    }
}

/// One workflow run as GitHub has it now: `gh api repos/<repo>/actions/runs/<id>`,
/// which always describes the run's latest attempt. A wait asks before it
/// believes a red from cockpit's view, because a re-run keeps the run id and
/// the view can still hold the attempt it retries: jot-ios PR #181
/// (2026-10-11), where `gh run rerun --failed` started attempt 3 and cockpit
/// still showed attempt 2's failure, so `cockpit wait` returned red at once.
public enum GHRunProbe {
    struct Run: Decodable {
        var id: Int
        var status: String?
        var conclusion: String?
        var run_attempt: Int?
        var run_started_at: String?
        var updated_at: String?
        var html_url: String?
    }

    /// `row` as GitHub has it now; nil when GitHub did not answer.
    public static func fetch(_ row: RunRow, glance: Glance?, timeout: TimeInterval = 20) async -> RunRow? {
        guard row.id > 0, let repo = await GHChecksProbe.fullName(row.repo, glance: glance),
              let out = await GHChecksProbe.gh(["api", "repos/\(repo)/actions/runs/\(row.id)"], timeout: timeout)
        else { return nil }
        return try? update(row, with: out)
    }

    /// `row` with the run's current state from a REST run body laid over it.
    static func update(_ row: RunRow, with data: Data, now: Double = Format.nowMs()) throws -> RunRow {
        let run = try JSONDecoder().decode(Run.self, from: data)
        guard run.id == row.id else { throw CocoaError(.coderValueNotFound) }
        func ms(_ s: String?) -> Double? {
            s.flatMap { ISO8601DateFormatter().date(from: $0) }.map { $0.timeIntervalSince1970 * 1000 }
        }
        var r = row
        r.status = run.status ?? r.status
        r.conclusion = r.status == "completed" ? run.conclusion : nil
        r.runAttempt = run.run_attempt ?? r.runAttempt
        r.startedAt = ms(run.run_started_at) ?? r.startedAt
        r.updatedAt = ms(run.updated_at) ?? r.updatedAt
        r.url = run.html_url ?? r.url
        r.elapsedMs = r.status == "in_progress" ? r.startedAt.map { max(0, now - $0) } : nil
        return r
    }
}
