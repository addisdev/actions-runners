import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// How the cockpit reaches a fleetd that binds to loopback on another Mac.
///
/// The default needs nothing changed on the host: a child `ssh -N -L` through
/// the aliases already in ~/.ssh/config, so requests arrive at the daemon as
/// loopback — which is also what its DNS-rebinding check expects. A direct URL
/// is for the day the dashboard is served over Tailscale Serve or the LAN.
public enum TransportConfig: Codable, Sendable, Equatable {
    case tunnel(aliases: [String], remotePort: Int)
    case direct(URL)
    case fixture(String)

    /// The ssh aliases tried, in order, when nothing else is configured: the
    /// coordinator's LAN name, then its tailnet name. This is the one place the
    /// default route is written down; the app's settings, the CLI's `--via` and
    /// the sentinel all start from it. A fleet on another host is a setting
    /// (Settings → Connection, or `--via`), not a new build.
    public static let defaultAliases = ["ultra", "ultra-ts"]
    public static let defaultRemotePort = 7878

    public static let `default` = TransportConfig.tunnel(aliases: defaultAliases, remotePort: defaultRemotePort)
}

/// The route in use right now, shown in the popover footer.
public struct Route: Sendable, Equatable {
    public var baseURL: URL
    public var label: String
    public var latencyMs: Double?

    public init(baseURL: URL, label: String, latencyMs: Double? = nil) {
        self.baseURL = baseURL; self.label = label; self.latencyMs = latencyMs
    }
}

public protocol Transport: AnyObject, Sendable {
    /// Establishes a route and returns it, trying candidates in order.
    func open() async throws -> Route
    /// Tears the route down. Safe to call twice.
    func close()
    /// True while the route is believed usable (the tunnel process is alive).
    var isAlive: Bool { get }
}

public enum TransportError: Error, CustomStringConvertible, Equatable {
    case noRoute([String])
    case sshMissing

    public var description: String {
        switch self {
        case .noRoute(let tried): "No route to the dashboard (tried \(tried.joined(separator: ", ")))"
        case .sshMissing: "/usr/bin/ssh is missing"
        }
    }
}

public final class DirectTransport: Transport, @unchecked Sendable {
    private let url: URL
    public init(url: URL) { self.url = url }
    public func open() async throws -> Route {
        let started = Date()
        guard try await Probe.health(url) else { throw TransportError.noRoute([url.absoluteString]) }
        return Route(baseURL: url, label: url.host ?? url.absoluteString, latencyMs: Date().timeIntervalSince(started) * 1000)
    }
    public func close() {}
    public var isAlive: Bool { true }
}

/// Spawns `/usr/bin/ssh -N -L <free port>:127.0.0.1:<remote> <alias>` for the
/// first alias whose tunnel answers `/api/health`. BatchMode means an alias
/// that would prompt for a password fails fast instead of hanging the app.
public final class TunnelTransport: Transport, @unchecked Sendable {
    private let aliases: [String]
    private let remotePort: Int
    private let sshPath: String
    private let lock = NSLock()
    private var process: Process?
    private var lifeline: Pipe?

    public init(aliases: [String], remotePort: Int = 7878, sshPath: String = "/usr/bin/ssh") {
        self.aliases = aliases
        self.remotePort = remotePort
        self.sshPath = sshPath
    }

    public var isAlive: Bool {
        lock.withLock { process?.isRunning ?? false }
    }

    public func open() async throws -> Route {
        close()
        guard FileManager.default.isExecutableFile(atPath: sshPath) else { throw TransportError.sshMissing }
        var tried: [String] = []
        for alias in aliases {
            tried.append(alias)
            guard let port = freeLocalPort() else { continue }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: sshPath)
            // Not -N: the session runs `cat` on the host, fed from a pipe only
            // this process holds. However the app ends — quit, crash, SIGKILL —
            // the pipe closes, cat sees EOF, and ssh exits. With -N a killed app
            // left its tunnel running forever, reparented to launchd.
            p.arguments = [
                "-T",
                "-o", "BatchMode=yes",
                "-o", "ExitOnForwardFailure=yes",
                "-o", "ConnectTimeout=6",
                "-o", "ServerAliveInterval=15",
                "-o", "ServerAliveCountMax=2",
                "-o", "ControlMaster=no",
                "-o", "ControlPath=none",
                "-L", "127.0.0.1:\(port):127.0.0.1:\(remotePort)",
                alias,
                "cat >/dev/null",
            ]
            let lifeline = Pipe()
            p.standardInput = lifeline
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { continue }
            let base = URL(string: "http://127.0.0.1:\(port)")!
            let started = Date()
            // The forward is up once the daemon answers through it; ssh can
            // take a few seconds on a tailnet route.
            var up = false
            while Date().timeIntervalSince(started) < 10, p.isRunning {
                if (try? await Probe.health(base, timeout: 2)) == true { up = true; break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            if up {
                setProcess(p, lifeline: lifeline)
                let latency = try? await Probe.latency(base)
                return Route(baseURL: base, label: alias, latencyMs: latency)
            }
            p.terminate()
            try? lifeline.fileHandleForWriting.close()
        }
        throw TransportError.noRoute(tried)
    }

    private func setProcess(_ p: Process?, lifeline: Pipe?) {
        lock.withLock { process = p; self.lifeline = lifeline }
    }

    public func close() {
        let (p, pipe): (Process?, Pipe?) = lock.withLock {
            defer { process = nil; lifeline = nil }
            return (process, lifeline)
        }
        if let p, p.isRunning { p.terminate() }
        try? pipe?.fileHandleForWriting.close()
    }

    deinit { close() }
}

/// A transport's route, opened when a call needs it and — with `idle` set —
/// closed again once no call has used it for that long.
///
/// `cockpit mcp` runs for as long as its Claude Code session, idle nearly all
/// of that time. Holding a tunnel the whole while cost the host one of its 42
/// ssh slots per open session (launchd's cap on sshd instances); on 2026-10-22
/// ultra reached 40 and every proxied MCP server failed to connect. With an
/// idle close a session holds a slot only while it is asking the fleet.
///
/// Concurrent callers share one open: a second call that arrives while the
/// tunnel is coming up waits for it rather than starting another (and
/// `TunnelTransport.open` closes whatever it had before it starts).
public final class OnDemandRoute: @unchecked Sendable {
    private let transport: Transport
    private let idle: TimeInterval?
    private let lock = NSLock()
    private var route: Route?
    private var opening: Task<Route, Error>?
    private var users = 0
    /// Bumped whenever the route is taken or dropped, so an idle close that
    /// was scheduled before then does nothing.
    private var epoch = 0
    private var closer: Task<Void, Never>?

    public init(_ transport: Transport, idle: TimeInterval? = nil) {
        self.transport = transport
        self.idle = idle
    }

    /// The route's base URL, opening (or reopening, once the tunnel process
    /// has died) as needed.
    public func base() async throws -> URL {
        let pending: Task<Route, Error> = lock.withLock {
            if let route, transport.isAlive { return Task { route } }
            route = nil
            if let opening { return opening }
            let t = Task { [transport] in try await transport.open() }
            opening = t
            return t
        }
        do {
            let r = try await pending.value
            lock.withLock {
                if opening == pending { opening = nil; route = r }
            }
            return r.baseURL
        } catch {
            lock.withLock { if opening == pending { opening = nil } }
            throw error
        }
    }

    /// Runs `body` with the route held open; the idle clock starts when the
    /// last call in flight returns.
    public func use<T: Sendable>(_ body: @Sendable (URL) async throws -> T) async throws -> T {
        acquire()
        defer { release() }
        return try await body(try await base())
    }

    /// The route answered nothing: drop it, so the next use opens a new tunnel
    /// instead of reconnecting to a forward whose far end is gone.
    public func invalidate() {
        lock.withLock { route = nil; epoch += 1 }
        transport.close()
    }

    /// Closes the route for good (the caller is exiting).
    public func close() {
        lock.withLock { closer?.cancel(); closer = nil }
        invalidate()
    }

    /// True while a route is held and its tunnel is up.
    public var isOpen: Bool { lock.withLock { route != nil } && transport.isAlive }

    private func acquire() {
        lock.withLock {
            users += 1
            epoch += 1
            closer?.cancel()
            closer = nil
        }
    }

    private func release() {
        lock.withLock {
            users -= 1
            guard users == 0, let idle else { return }
            let mine = epoch
            closer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(idle * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                // Closed under the lock, so a call that starts now opens
                // its tunnel after this one is gone, not before.
                self.lock.withLock {
                    guard self.users == 0, self.epoch == mine else { return }
                    self.route = nil
                    self.closer = nil
                    self.transport.close()
                }
            }
        }
    }
}

/// Asks the kernel for an unused loopback port.
func freeLocalPort() -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0 else { return nil }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    guard named == 0 else { return nil }
    return Int(UInt16(bigEndian: addr.sin_port))
}

public enum Probe {
    public static func health(_ base: URL, timeout: TimeInterval = 5) async throws -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("api/health"))
        req.timeoutInterval = timeout
        let (_, resp) = try await URLSession.shared.data(for: req)
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    public static func latency(_ base: URL) async throws -> Double {
        let started = Date()
        _ = try await health(base, timeout: 3)
        return Date().timeIntervalSince(started) * 1000
    }
}
