import Foundation
import CockpitCore

// `cockpit mcp`: the same answers as the command line, as an MCP server over
// stdio (newline-delimited JSON-RPC 2.0), for agent sessions that prefer a tool
// to a shell command. No dependencies; four tools; read-only by design — the
// actions that change the fleet stay behind `cockpit run --yes`.

enum MCPServer {
    static var tools: [[String: Any]] { [
        tool("fleet_status", "The self-hosted runner fleet's verdict: one ordered ladder (host down, disk floor, dead service, saturated, account blocked, config drift, waiting, clear) with evidence and the next move. Call this before diagnosing any CI failure or queue.", [:], []),
        tool("why_queued", "Everything the fleet knows about one repository: its runners and their states, queued runs with cause, confidence, evidence and ETA, check rollups, recent failures (marked notYourCode when the host or account failed them) and open alerts.",
             ["repo": ["type": "string", "description": "Repository name or owner/name"]], ["repo"]),
        tool("fleet_queue", "Every queued run, oldest first, with its queue cause and start/finish ETA ranges.", [:], []),
        tool("wait_for_checks", "Wait until a commit's checks finish. Returns green, red (with failed checks), pointless (waiting cannot end well: host down, disk floor, billing block, or a check that will never start — stop and report) or timeout.",
             ["repo": ["type": "string"], "pr": ["type": "integer"], "sha": ["type": "string"], "branch": ["type": "string"],
              "timeout_minutes": ["type": "integer", "description": "Default 10, max 30"]], ["repo"]),
    ] }

    static func tool(_ name: String, _ desc: String, _ props: [String: Any], _ required: [String]) -> [String: Any] {
        ["name": name, "description": desc,
         "inputSchema": ["type": "object", "properties": props, "required": required]]
    }

    static func run() async {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let id = msg["id"]
            let method = msg["method"] as? String ?? ""
            let params = msg["params"] as? [String: Any] ?? [:]
            switch method {
            case "initialize":
                reply(id, ["protocolVersion": (params["protocolVersion"] as? String) ?? "2025-06-18",
                           "capabilities": ["tools": [:]],
                           "serverInfo": ["name": "fleet-cockpit", "version": "0.1.0"]])
            case "tools/list":
                reply(id, ["tools": tools])
            case "tools/call":
                let name = params["name"] as? String ?? ""
                let args = params["arguments"] as? [String: Any] ?? [:]
                let (text, isError) = await call(name, args)
                reply(id, ["content": [["type": "text", "text": text]], "isError": isError])
            case "ping":
                reply(id, [:])
            default:
                if id != nil { error(id, -32601, "method not found: \(method)") }
            }
        }
    }

    static func reply(_ id: Any?, _ result: [String: Any]) {
        write(["jsonrpc": "2.0", "id": id ?? NSNull(), "result": result])
    }

    static func error(_ id: Any?, _ code: Int, _ message: String) {
        write(["jsonrpc": "2.0", "id": id ?? NSNull(), "error": ["code": code, "message": message]])
    }

    static func write(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        FileHandle.standardOutput.write(d + Data("\n".utf8))
    }

    static func json<T: Encodable>(_ v: T) -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? String(decoding: e.encode(v), as: UTF8.self)) ?? "{}"
    }

    /// The freshest view: the app's snapshot when under 90 s old, else a tunnel.
    static func glance() async -> (Glance?, Verdict, String) {
        if let snap = try? SnapshotFile.read(), snap.ageMs() < 90_000 {
            return (snap.glance, snap.verdict, "app")
        }
        let t = TunnelTransport(aliases: ["runner-host", "runner-ts"])
        defer { t.close() }
        do {
            let r = try await t.open()
            let g = try await FleetClient(base: r.baseURL).glance()
            return (g, g.verdict, r.label)
        } catch {
            return (nil, Verdict(id: "unreachable", tone: .unknown, title: "Dashboard unreachable",
                                 sentence: "\(error)", evidence: [], next: nil, rung: nil, open: []), "none")
        }
    }

    static func call(_ name: String, _ a: [String: Any]) async -> (String, Bool) {
        switch name {
        case "fleet_status":
            let (g, v, route) = await glance()
            struct Out: Encodable { let verdict: Verdict; let counts: Counts?; let route: String; let posture: [PostureItem]? }
            return (json(Out(verdict: v, counts: g?.counts, route: route, posture: g?.posture?.items)), false)
        case "why_queued":
            guard let repo = a["repo"] as? String else { return ("repo is required", true) }
            let (g, v, _) = await glance()
            guard let g else { return (json(v), true) }
            let m: (String?) -> Bool = { r in guard let r else { return false }; return r == repo || r.hasSuffix("/" + repo) }
            struct Why: Encodable {
                let verdict: Verdict; let runners: [Runner]; let queue: [QueueItem]; let checks: [String]
                let failures: [FailureRow]; let incidents: [Incident]
            }
            let short = repo.split(separator: "/").last.map(String.init) ?? repo
            return (json(Why(verdict: v, runners: g.runners.filter { m($0.repo) }, queue: g.queue.filter { m($0.repo) },
                             checks: Rollup.checkSets(g).filter { m($0.repo) }.map { "\($0.label): \($0.progress)" },
                             failures: (g.failures ?? []).filter { m($0.repo) },
                             incidents: g.incidents.filter { $0.key.contains(short) || $0.title.contains(short) })), false)
        case "fleet_queue":
            let (g, v, _) = await glance()
            guard let g else { return (json(v), true) }
            return (json(g.queue), false)
        case "wait_for_checks":
            guard let repo = a["repo"] as? String else { return ("repo is required", true) }
            let target = WaitTarget(repo: repo, pr: a["pr"] as? Int, sha: a["sha"] as? String, branch: a["branch"] as? String)
            let minutes = min(30, max(1, a["timeout_minutes"] as? Int ?? 10))
            let deadline = Date().addingTimeInterval(Double(minutes) * 60)
            var last: WaitDecision = .waiting(nil)
            while Date() < deadline {
                let (g, _, _) = await glance()
                if let g {
                    last = Waiter.decide(g, verdict: g.verdict, target: target)
                    if case .waiting = last {} else { break }
                }
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
            switch last {
            case .green(let s): return ("green: \(target.label) — \(s.progress)", false)
            case .red(let s): return ("red: \(target.label) — \(s.progress); failed: \(s.failed.compactMap(\.workflow).joined(separator: ", "))", false)
            case .pointless(let why): return ("pointless: \(why)", false)
            case .waiting(let s): return ("timeout after \(minutes) min: \(s?.progress ?? "no runs seen")", false)
            }
        default:
            return ("unknown tool \(name)", true)
        }
    }
}
