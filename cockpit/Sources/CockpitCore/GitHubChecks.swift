import Foundation

/// GitHub's own view of a PR's checks: `gh pr view <n> --json
/// headRefOid,statusCheckRollup`. Cockpit's rows are a copy of this, made by
/// the daemon's fast loop; when that loop stops finishing ticks the copy
/// freezes, so a wait asks the original as well (greenfolio-ios PR #445 and
/// greenfolio-android PR #280, 2026-10-07: both green on GitHub while cockpit
/// still showed them running).
public struct GitHubChecks: Sendable, Equatable {
    public struct Check: Sendable, Equatable {
        public var name: String
        public var workflow: String?
        /// Lowercased, in the REST spelling: `completed` / `in_progress` / `queued`.
        public var status: String
        public var conclusion: String?
        public var url: String?
    }

    public var head: String?
    public var checks: [Check]

    /// Finished only when GitHub lists at least one check and every one is
    /// complete. An empty rollup is a head whose workflows have not been
    /// created yet, not a pass.
    public var state: CheckSet.State {
        if checks.isEmpty || checks.contains(where: { $0.status != "completed" }) { return .pending }
        return rows.allSatisfy(\.passed) ? .green : .red
    }

    /// As cockpit rows, so a GitHub answer reports exactly like a cockpit one
    /// (same green rule: success/skipped/neutral only; cancelled is red).
    var rows: [RunRow] {
        checks.enumerated().map { i, c in
            RunRow(id: -(i + 1), repo: "", workflow: c.name, status: c.status, conclusion: c.conclusion,
                   branch: nil, sha: head, prNumber: nil, event: nil, title: nil, url: c.url,
                   startedAt: nil, updatedAt: nil, elapsedMs: nil, expectedMs: nil)
        }
    }

    public func checkSet(repo: String, pr: Int?) -> CheckSet {
        let rs = rows.map { r -> RunRow in var r = r; r.repo = repo; r.prNumber = pr; return r }
        let failed = rs.filter(\.failed)
        let done = rs.filter { !$0.isActive }.count
        return CheckSet(id: "github:\(repo)@\(head ?? "?")", repo: repo, prNumber: pr, branch: nil,
                        sha: head.map { String($0.prefix(12)) }, title: nil, runs: rs, total: rs.count, done: done,
                        failed: failed, queued: [], etaGreenMs: nil, state: state)
    }

    /// Parses `gh pr view --json headRefOid,statusCheckRollup`. Check runs
    /// carry status + conclusion; commit statuses carry one `state`.
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
        }
        struct View: Decodable { var headRefOid: String?; var statusCheckRollup: [Item]? }
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
                             url: i.targetUrl)
            }
            let status = (i.status ?? "QUEUED").lowercased()
            return Check(name: i.name ?? "check", workflow: i.workflowName,
                         status: status == "completed" ? "completed" : status,
                         conclusion: status == "completed" ? (i.conclusion ?? "").lowercased() : nil,
                         url: i.detailsUrl)
        }
        return GitHubChecks(head: v.headRefOid, checks: checks)
    }
}

/// Asks GitHub through the `gh` CLI. `gh pr view` is GraphQL, whose budget is
/// separate from the REST budget the daemon's token polls with, and a wait
/// asks at most twice a minute — far from the bulk calls that once
/// rate-penalized the daemon.
public struct GHChecksProbe: Sendable {
    public var repo: String
    public var pr: Int
    public var timeout: TimeInterval = 20

    public init(repo: String, pr: Int) { self.repo = repo; self.pr = pr }

    public func fetch() async -> GitHubChecks? {
        guard let out = await Self.gh(["pr", "view", String(pr), "-R", repo, "--json", "headRefOid,statusCheckRollup"],
                                      timeout: timeout) else { return nil }
        return try? GitHubChecks.parse(prView: out)
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

    static func gh(_ args: [String], timeout: TimeInterval) async -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            let p = Process()
            if let path = ghPath {
                p.executableURL = URL(fileURLWithPath: path); p.arguments = args
            } else {
                p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = ["gh"] + args
            }
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            p.standardInput = FileHandle.nullDevice
            do { try p.run() } catch { c.resume(returning: nil); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if p.isRunning { p.terminate() }
            }
            // Read to EOF before waiting: a reply larger than the pipe buffer
            // would otherwise block gh on write and never exit.
            DispatchQueue.global().async {
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                c.resume(returning: p.terminationStatus == 0 ? data : nil)
            }
        }
    }
}
