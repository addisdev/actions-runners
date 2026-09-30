import Foundation
import Network

/// A tiny loopback HTTP server for transport and client tests: one canned
/// response per path, and an SSE path that sends its events and closes.
final class StubServer: @unchecked Sendable {
    enum Reply {
        case json(Int, String)
        case sse([String], hold: TimeInterval)
    }

    private let listener: NWListener
    private let routes: [String: Reply]
    private let queue = DispatchQueue(label: "stub-server")
    private(set) var requests: [String] = []
    private let lock = NSLock()

    init(routes: [String: Reply]) throws {
        self.routes = routes
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
    }

    var port: Int { Int(listener.port?.rawValue ?? 0) }
    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func start() async throws {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                if case .ready = state, once.claim() { c.resume() }
            }
            listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    func seen() -> [String] { lock.lock(); defer { lock.unlock() }; return requests }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8) else { conn.cancel(); return }
            let line = text.split(separator: "\r\n").first.map(String.init) ?? ""
            let target = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            self.lock.lock(); self.requests.append(target); self.lock.unlock()
            let path = target.split(separator: "?").first.map(String.init) ?? target
            switch self.routes[target] ?? self.routes[path] {
            case .json(let code, let body)?:
                let resp = "HTTP/1.1 \(code) X\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n\(body)"
                conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in conn.cancel() })
            case .sse(let events, let hold)?:
                var resp = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n"
                for e in events { resp += e.hasPrefix(":") ? "\(e)\n\n" : "data: \(e)\n\n" }
                conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in
                    self.queue.asyncAfter(deadline: .now() + hold) { conn.cancel() }
                })
            case nil:
                let resp = "HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found"
                conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in conn.cancel() })
            }
        }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
