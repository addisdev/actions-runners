import Foundation

// /api/v1 (docs/api.md#version-1-apiv1). The daemon answers the questions the
// command line used to work out for itself from the glance: why a repo is
// stuck, whether a PR's checks are done, which jobs are orphaned. The types
// here are tested against Fixtures/v1/, which
// dashboard/scripts/make-glance-fixtures.mjs makes with the daemon's own
// route handler, and CI fails when the two drift.

public struct APIError: Error, Decodable, Sendable, Equatable, CustomStringConvertible {
    public var status: Int = 0
    public var code: String
    public var message: String
    public var hint: String?

    enum CodingKeys: String, CodingKey { case code, message, hint }

    public init(status: Int, code: String, message: String, hint: String? = nil) {
        self.status = status; self.code = code; self.message = message; self.hint = hint
    }

    /// The daemon predates /api/v1: it answered without the version header.
    public static func unsupported(_ status: Int) -> APIError {
        APIError(status: status, code: "unsupported",
                 message: "the dashboard does not serve /api/v1 yet",
                 hint: "Update actions-runners on the host: git pull && ./dashboard/fleetctl.sh restart")
    }

    public var description: String { message + (hint.map { "\n  \($0)" } ?? "") }
}

public struct V1CheckSet: Decodable, Sendable, Equatable {
    public var prNumber: Int?
    public var branch: String?
    public var sha: String?
    public var state: String
    public var progress: String
    public var etaGreenMs: [Double]?
    /// Only in a checks answer, not in a diagnosis.
    public var failed: [RunRow]?

    public var label: String {
        if let prNumber { return "PR #\(prNumber)" }
        return [branch, sha].compactMap { $0 }.joined(separator: " @ ")
    }
}

public struct V1Orphan: Codable, Sendable, Equatable {
    public var repo: String
    public var runId: Int
    public var job: String?
    public var runner: String?
    public var workPassed: Bool
    public var failedStep: String?
    public var url: String?
    public var summary: String
    public var recovery: [String]
}

/// GET /api/v1/repos/{owner}/{repo}/checks
public struct V1Checks: Decodable, Sendable, Equatable {
    public var state: String
    public var reason: String?
    public var hint: String?
    public var source: String
    public var waitedMs: Double?
    public var fleetAgeMs: Double?
    public var fleetSaid: String?
    public var checks: V1CheckSet?
    public var orphans: [V1Orphan]?
    /// On a green: what GitHub's side of the check covered. A daemon that
    /// confirms every green on GitHub always sends it, so a green without it
    /// came from an older daemon and is confirmed by the client
    /// (stream-app PR #5, 2026-10-24).
    public var verified: Verified?

    public struct Verified: Codable, Sendable, Equatable {
        public var head: String?
        public var runs: Int
        public var jobs: Int
        public var checks: Int?
    }

    public var finished: Bool { state != "pending" }

    /// `cockpit wait`'s exit codes: 0 green, 1 red, 2 pointless, 3 still pending.
    public var exitCode: Int32 {
        switch state {
        case "green": 0
        case "red": 1
        case "pointless": 2
        default: 3
        }
    }
}

/// GET /api/v1/repos/{owner}/{repo}/diagnosis
public struct V1Diagnosis: Decodable, Sendable {
    public var repo: String?
    public var verdict: Verdict
    public var runners: [Runner]
    public var queue: [QueueItem]
    public var failures: [FailureRow]
    public var checks: [V1CheckSet]
    public var orphans: [V1Orphan]
    public var incidents: [Incident]
    public var freshness: Freshness

    public struct Freshness: Decodable, Sendable {
        public var ageMs: Double?
        public var stale: Bool
    }
}

/// POST /api/v1/actions/{id}
public struct V1Action: Decodable, Sendable, Equatable {
    public var status: String
    public var action: String
    public var label: String?
    public var danger: String?
    public var command: String?
    public var effect: String?
    public var confirm: String?
    public var ok: Bool?
    public var output: String?
    public var hint: String?
}

struct Items<T: Decodable>: Decodable { var items: [T] }

extension FleetClient {
    public func v1(_ path: String, query: [String: String] = [:], method: String = "GET",
                   body: [String: Any]? = nil, timeout: TimeInterval = 15) async throws -> Data {
        var req = request("api/v1/" + path, query: query, method: method,
                          body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        req.timeoutInterval = timeout
        let (data, resp) = try await session.data(for: req)
        let http = resp as? HTTPURLResponse
        let code = http?.statusCode ?? 0
        guard http?.value(forHTTPHeaderField: "fleet-api-version") != nil else { throw APIError.unsupported(code) }
        guard code == 200 else {
            struct Body: Decodable { var error: APIError }
            var e = (try? JSONDecoder().decode(Body.self, from: data))?.error
                ?? APIError(status: code, code: "http_\(code)", message: String(decoding: data.prefix(200), as: UTF8.self))
            e.status = code
            throw e
        }
        return data
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T { try JSONDecoder().decode(type, from: data) }

    /// `owner/name` for a bare repository name, from the repos the fleet serves.
    public func fullName(_ repo: String) async throws -> String {
        if repo.contains("/") { return repo }
        let runners = try decode(Items<Runner>.self, try await v1("runners")).items.compactMap(\.repo)
        let queued = try decode(Items<QueueItem>.self, try await v1("queue")).items.map(\.repo)
        let hits = Set((runners + queued).filter { $0.lowercased().hasSuffix("/" + repo.lowercased()) })
        if hits.count == 1, let hit = hits.first { return hit }
        throw APIError(status: 404, code: "unknown_repo",
                       message: hits.isEmpty ? "the fleet serves no repository named \(repo)" : "\(repo) is ambiguous: \(hits.sorted().joined(separator: ", "))",
                       hint: "Give it as owner/name.")
    }

    public func hosts() async throws -> [Host] {
        try decode(Items<Host>.self, try await v1("hosts")).items
    }

    /// The answer, and the daemon's JSON for `--json`.
    public func diagnosis(_ repo: String) async throws -> (V1Diagnosis, Data) {
        let data = try await v1("repos/\(repo)/diagnosis")
        return (try decode(V1Diagnosis.self, data), data)
    }

    /// Held open up to `wait` seconds (the daemon caps it at 300).
    public func checks(_ t: WaitTarget, wait: Int) async throws -> (V1Checks, Data) {
        var q = ["wait": String(wait)]
        if let pr = t.pr { q["pr"] = String(pr) }
        if let sha = t.sha { q["sha"] = sha }
        if let branch = t.branch { q["branch"] = branch }
        let data = try await v1("repos/\(t.repo)/checks", query: q, timeout: TimeInterval(wait) + 30)
        return (try decode(V1Checks.self, data), data)
    }

    /// Without `confirm`, a preview that changes nothing and carries the
    /// confirm token; with it, the run.
    public func action(_ id: String, args: [String: Any], confirm: String? = nil) async throws -> (V1Action, Data) {
        var body: [String: Any] = ["args": args]
        if let confirm { body["confirm"] = confirm }
        let data = try await v1("actions/\(id)", method: "POST", body: body, timeout: 300)
        return (try decode(V1Action.self, data), data)
    }

    /// One JSON-RPC message to the daemon's MCP endpoint; nil when it needs
    /// no answer (a notification).
    public func mcp(_ message: Data) async throws -> Data? {
        var req = request("mcp", method: "POST", body: message)
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
        // wait_for_checks holds a call open up to 300 s.
        req.timeoutInterval = 330
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 202 { return nil }
        if code == 404 { throw APIError.unsupported(code) }
        return data
    }
}
