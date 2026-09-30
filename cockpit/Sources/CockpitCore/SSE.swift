import Foundation

/// A Server-Sent Events line parser: feed it lines, get whole `data` payloads.
///
/// Only the parts fleetd uses: `data:` lines (joined with newlines when an
/// event spans several), a blank line to dispatch, and `:` comment lines —
/// the 25 s keepalives — which carry nothing but still prove the connection
/// is alive, so they are reported separately.
public struct SSEParser: Sendable {
    public enum Event: Equatable, Sendable {
        case data(String)
        case keepalive
    }

    private var buffer: [String] = []

    public init() {}

    public mutating func feed(line raw: String) -> Event? {
        let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
        if line.isEmpty {
            guard !buffer.isEmpty else { return nil }
            defer { buffer.removeAll(keepingCapacity: true) }
            return .data(buffer.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return .keepalive }
        if line.hasPrefix("data:") {
            var value = line.dropFirst(5)
            if value.first == " " { value = value.dropFirst() }
            buffer.append(String(value))
        }
        // event:, id:, retry: — fleetd sends none of them; ignored per spec.
        return nil
    }
}
