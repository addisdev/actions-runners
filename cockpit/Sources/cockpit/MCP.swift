import Foundation
import CockpitCore

// `cockpit mcp`: the dashboard's MCP server (/mcp, docs/api.md#mcp-mcp) over
// stdio, through the same SSH tunnel as every other command. The tools, their
// descriptions and their answers all come from the daemon; this only carries
// newline-delimited JSON-RPC each way.
//
// No token is sent unless FLEET_API_TOKEN is set, so by default the tools
// read and every action is refused. The token `cockpit pair` saves holds
// every scope, and an agent holding it could confirm its own previews of
// anything, switching a host off included.

enum MCPBridge {
    static let out = NSLock()

    static func run(_ link: Transport) async {
        let routes = RouteCache(link)
        let token = ProcessInfo.processInfo.environment["FLEET_API_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        await withTaskGroup(of: Void.self) { group in
            // wait_for_checks holds a call for minutes; a ping or a second
            // call must not queue behind it.
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8), !line.isEmpty else { continue }
                group.addTask { await forward(data, routes: routes, token: token) }
            }
        }
        link.close()
    }

    static func forward(_ data: Data, routes: RouteCache, token: String?) async {
        let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"]
        do {
            let client = FleetClient(base: try await routes.base(), token: token)
            if let reply = try await client.mcp(data) { write(reply) }
        } catch {
            routes.invalidate()
            guard let id else { return }
            let msg: String = (error as? APIError)?.description
                ?? "the fleet dashboard did not answer (\(error.localizedDescription)); `cockpit sentinel` checks the host out of band"
            if let d = try? JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": msg],
            ]) { write(d) }
        }
    }

    static func write(_ d: Data) {
        // One line per message; the daemon's JSON has no raw newlines.
        out.withLock { FileHandle.standardOutput.write(d + Data("\n".utf8)) }
    }
}
