import Foundation
import Testing
@testable import CockpitCore

/// A transport that counts its opens and closes, routed to a stub daemon.
final class CountingTransport: Transport, @unchecked Sendable {
    let base: URL
    let openDelay: TimeInterval
    private let lock = NSLock()
    private var alive = false
    private(set) var opens = 0
    private(set) var closes = 0

    init(base: URL, openDelay: TimeInterval = 0) {
        self.base = base
        self.openDelay = openDelay
    }

    var isAlive: Bool { lock.withLock { alive } }

    func open() async throws -> Route {
        lock.withLock { opens += 1 }
        if openDelay > 0 { try await Task.sleep(nanoseconds: UInt64(openDelay * 1_000_000_000)) }
        lock.withLock { alive = true }
        return Route(baseURL: base, label: "stub")
    }

    func close() { lock.withLock { if alive { closes += 1 }; alive = false } }

    /// The tunnel process died on its own (sleep, network change, sshd restart).
    func die() { lock.withLock { alive = false } }

    var counts: (opens: Int, closes: Int) { lock.withLock { (opens, closes) } }
}

private func waitUntil(_ seconds: TimeInterval = 5, _ cond: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !cond(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
}

@Suite("on-demand route: open, idle close, reopen", .serialized)
struct OnDemandRouteTests {
    private func server() async throws -> StubServer {
        let s = try StubServer(routes: ["/api/health": .json(200, "{\"ok\":true}")])
        try await s.start()
        return s
    }

    @Test func opensOnFirstUseNotBefore() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 0.3)
        #expect(t.counts.opens == 0)
        #expect(!r.isOpen)
        let ok = try await r.use { try await Probe.health($0) }
        #expect(ok)
        #expect(t.counts.opens == 1)
        #expect(r.isOpen)
        r.close()
    }

    @Test func closesAfterIdleAndReopensOnTheNextCall() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 0.3)
        _ = try await r.use { try await Probe.health($0) }
        // Calls within the idle window reuse the tunnel.
        _ = try await r.use { try await Probe.health($0) }
        #expect(t.counts.opens == 1)

        try await waitUntil { !r.isOpen }
        #expect(!r.isOpen)
        #expect(t.counts.closes == 1)

        _ = try await r.use { try await Probe.health($0) }
        #expect(t.counts.opens == 2)
        #expect(r.isOpen)
        r.close()
        #expect(t.counts.closes == 2)
    }

    @Test func aCallInFlightKeepsTheTunnelPastTheIdleWindow() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 0.2)
        // wait_for_checks holds one call for minutes; the tunnel must stay up
        // under it even while other, short calls come and go.
        let long = Task { try await r.use { _ in try await Task.sleep(nanoseconds: 800_000_000) } }
        try await waitUntil { r.isOpen }
        _ = try await r.use { try await Probe.health($0) }
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(r.isOpen)
        #expect(t.counts.closes == 0)
        try await long.value
        try await waitUntil { !r.isOpen }
        #expect(t.counts.closes == 1)
        #expect(t.counts.opens == 1)
    }

    @Test func aNewCallCancelsAPendingIdleClose() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 1)
        _ = try await r.use { try await Probe.health($0) }
        try await Task.sleep(nanoseconds: 600_000_000)
        _ = try await r.use { try await Probe.health($0) }
        // 1.2 s after the first call, 0.6 s after the second: still open.
        try await Task.sleep(nanoseconds: 600_000_000)
        #expect(r.isOpen)
        #expect(t.counts.closes == 0)
        try await waitUntil { !r.isOpen }
        #expect(t.counts.closes == 1)
    }

    @Test func concurrentCallsShareOneOpen() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base, openDelay: 0.2)
        let r = OnDemandRoute(t, idle: 1)
        try await withThrowingTaskGroup(of: Bool.self) { g in
            for _ in 0..<5 { g.addTask { try await r.use { try await Probe.health($0) } } }
            for try await ok in g { #expect(ok) }
        }
        #expect(t.counts.opens == 1)
        r.close()
    }

    @Test func aDeadTunnelIsReopened() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 5)
        _ = try await r.use { try await Probe.health($0) }
        t.die()
        _ = try await r.use { try await Probe.health($0) }
        #expect(t.counts.opens == 2)
        r.close()
    }

    @Test func invalidateDropsTheRoute() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t, idle: 5)
        _ = try await r.base()
        r.invalidate()
        #expect(!r.isOpen)
        _ = try await r.base()
        #expect(t.counts.opens == 2)
        r.close()
    }

    @Test func withoutIdleTheRouteIsHeld() async throws {
        let s = try await server()
        defer { s.stop() }
        let t = CountingTransport(base: s.base)
        let r = OnDemandRoute(t)
        _ = try await r.use { try await Probe.health($0) }
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(r.isOpen)
        r.close()
    }
}

/// A stand-in for /usr/bin/ssh: forwards `-L 127.0.0.1:P:127.0.0.1:R` locally,
/// writes its pid to `<alias>.pid`, and exits when stdin closes — as the real
/// tunnel's remote `cat` does.
private let fakeSSH = """
import os, socket, sys, threading
args = sys.argv[1:]
fwd = args[args.index("-L") + 1].split(":")
lport, rport = int(fwd[1]), int(fwd[3])
alias = args[args.index("-L") + 2]
open(alias + ".pid", "w").write(str(os.getpid()))
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    for s in (a, b):
        try: s.shutdown(socket.SHUT_RDWR)
        except OSError: pass
def serve():
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", lport)); ls.listen(16)
    while True:
        c, _ = ls.accept()
        r = socket.create_connection(("127.0.0.1", rport))
        threading.Thread(target=pipe, args=(c, r), daemon=True).start()
        threading.Thread(target=pipe, args=(r, c), daemon=True).start()
threading.Thread(target=serve, daemon=True).start()
sys.stdin.buffer.read()
os._exit(0)
"""

private let python3 = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
    .first { FileManager.default.isExecutableFile(atPath: $0) }

@Suite("tunnel process: opened on demand, gone after idle", .serialized)
struct TunnelLifecycleTests {
    @Test(.enabled(if: python3 != nil, "needs python3 for the fake ssh"))
    func theTunnelProcessExitsAfterIdleAndComesBack() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cockpit-tunnel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let ssh = dir.appendingPathComponent("ssh")
        try "#!\(python3!)\n\(fakeSSH)".write(to: ssh, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ssh.path)

        let s = try StubServer(routes: ["/api/health": .json(200, "{\"ok\":true}")])
        try await s.start()
        defer { s.stop() }

        let alias = dir.appendingPathComponent("host").path
        let pidFile = alias + ".pid"
        func pid() throws -> pid_t { pid_t(try String(contentsOfFile: pidFile, encoding: .utf8))! }
        func running(_ p: pid_t) -> Bool { kill(p, 0) == 0 }

        let t = TunnelTransport(aliases: [alias], remotePort: s.port, sshPath: ssh.path)
        let r = OnDemandRoute(t, idle: 0.5)
        #expect(!FileManager.default.fileExists(atPath: pidFile))

        #expect(try await r.use { try await Probe.health($0) })
        let first = try pid()
        #expect(running(first))

        // Idle: the process (and with it the host's session) goes away.
        try await waitUntil { !running(first) }
        #expect(!running(first))
        #expect(!r.isOpen)

        // The next call brings up a new tunnel and still answers.
        #expect(try await r.use { try await Probe.health($0) })
        let second = try pid()
        #expect(second != first)
        #expect(running(second))
        r.close()
        try await waitUntil { !running(second) }
        #expect(!running(second))
    }
}
