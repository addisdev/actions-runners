import Foundation

/// HTTP access to one fleetd, over whatever route the transport opened.
public struct FleetClient: Sendable {
    public let base: URL
    public var token: String?
    let session: URLSession

    public init(base: URL, token: String? = nil, session: URLSession = .shared) {
        self.base = base
        self.token = token
        self.session = session
    }

    public enum StreamEvent: Sendable, Equatable {
        case glance(Glance)
        case keepalive
    }

    public enum ClientError: Error, CustomStringConvertible, Equatable {
        case http(Int, String)
        case notGlance

        public var description: String {
            switch self {
            case .http(let code, let body): "HTTP \(code): \(body.prefix(200))"
            case .notGlance: "The daemon does not serve /api/glance yet — update actions-runners on the host."
            }
        }
    }

    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }

    func request(_ path: String, query: [String: String] = [:], method: String = "GET", body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        req.timeoutInterval = 15
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        return req
    }

    public func get(_ path: String, query: [String: String] = [:]) async throws -> Data {
        let (data, resp) = try await session.data(for: request(path, query: query))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw ClientError.http(code, String(decoding: data, as: UTF8.self)) }
        return data
    }

    public func post(_ path: String, json: [String: Any]) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json)
        let (data, resp) = try await session.data(for: request(path, method: "POST", body: body))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw ClientError.http(code, String(decoding: data, as: UTF8.self)) }
        return data
    }

    public func glance() async throws -> Glance {
        do {
            return try Glance.decode(try await get("api/glance"))
        } catch ClientError.http(404, _) {
            throw ClientError.notGlance
        }
    }

    /// The glance stream. Ends (throws) when the connection drops; the caller
    /// owns reconnection, because only it knows about backoff and routes.
    public func stream() -> AsyncThrowingStream<StreamEvent, Error> {
        let req: URLRequest = {
            var r = request("api/stream", query: ["view": "glance"])
            r.timeoutInterval = 90 // > the 25 s keepalive, < forever
            r.setValue("text/event-stream", forHTTPHeaderField: "accept")
            return r
        }()
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    guard code == 200 else { throw ClientError.http(code, "") }
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        switch parser.feed(line: line) {
                        case .data(let payload)?:
                            continuation.yield(.glance(try Glance.decode(Data(payload.utf8))))
                        case .keepalive?:
                            continuation.yield(.keepalive)
                        case nil:
                            // `lines` drops blank lines, which is the SSE event
                            // boundary; every data line fleetd sends is one whole
                            // event, so dispatch on the line itself.
                            break
                        }
                        if line.hasPrefix("data:"), case .data(let payload)? = parser.feed(line: "") {
                            continuation.yield(.glance(try Glance.decode(Data(payload.utf8))))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
