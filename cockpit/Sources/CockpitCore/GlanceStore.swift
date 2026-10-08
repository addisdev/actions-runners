import Foundation
import Observation

/// Owns the connection to one fleetd and the latest glance from it.
///
/// A stale snapshot is kept on screen, greyed, with its age — never replaced
/// by an empty view and never left looking green. Reconnection is jittered
/// exponential backoff; the app also calls `reconnectNow()` on wake and on a
/// network change, when waiting out a 30 s backoff would be silly.
@MainActor
@Observable
public final class GlanceStore {
    public private(set) var glance: Glance?
    public private(set) var connection: ConnectionState = .connecting
    public private(set) var route: Route?
    /// Wall-clock ms of the last byte of any kind on the stream (event or keepalive).
    public private(set) var lastEventMs: Double?
    /// Wall-clock ms the current glance arrived.
    public private(set) var lastGlanceMs: Double?
    public private(set) var lastError: String?

    public var config: TransportConfig {
        didSet { if config != oldValue { restart() } }
    }
    public var token: String?

    /// Called on the main actor with every new glance.
    @ObservationIgnored public var onGlance: ((Glance) -> Void)?
    /// Called whenever the connection state changes.
    @ObservationIgnored public var onConnection: ((ConnectionState) -> Void)?

    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var watchdog: Task<Void, Never>?
    @ObservationIgnored private var transport: Transport?
    @ObservationIgnored private let backoff: Backoff
    @ObservationIgnored private let makeTransport: @Sendable (TransportConfig) -> Transport?
    @ObservationIgnored private var generation = 0

    public init(
        config: TransportConfig = .default,
        backoff: Backoff = Backoff(),
        makeTransport: @escaping @Sendable (TransportConfig) -> Transport? = GlanceStore.defaultTransport
    ) {
        self.config = config
        self.backoff = backoff
        self.makeTransport = makeTransport
    }

    nonisolated public static func defaultTransport(_ c: TransportConfig) -> Transport? {
        switch c {
        case .tunnel(let aliases, let port): TunnelTransport(aliases: aliases, remotePort: port)
        case .direct(let url): DirectTransport(url: url)
        case .fixture: nil
        }
    }

    public var client: FleetClient? {
        route.map { FleetClient(base: $0.baseURL, token: token) }
    }

    public func start() {
        guard loop == nil else { return }
        generation += 1
        let gen = generation
        if case .fixture(let name) = config {
            loadFixture(name)
            return
        }
        loop = Task { [weak self] in await self?.run(gen) }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                self?.checkStaleness(gen)
            }
        }
    }

    public func stop() {
        generation += 1
        loop?.cancel(); loop = nil
        watchdog?.cancel(); watchdog = nil
        transport?.close(); transport = nil
    }

    public func restart() {
        stop()
        route = nil
        start()
    }

    /// Skip whatever backoff is pending and try again now.
    public func reconnectNow() {
        if case .fixture = config { return }
        restart()
    }

    /// For fixture mode and the replay scrubber.
    public func show(_ g: Glance, as state: ConnectionState) {
        apply(g)
        set(state)
    }

    private func loadFixture(_ name: String) {
        do {
            let g = try Fixtures.glance(name)
            route = Route(baseURL: URL(string: "fixture://\(name)")!, label: "fixture: \(name)")
            show(g, as: .fixture(name))
        } catch {
            lastError = "Fixture \(name): \(error)"
            set(.reconnecting(attempt: 0, error: lastError!))
        }
    }

    private func set(_ s: ConnectionState) {
        guard connection != s else { return }
        connection = s
        onConnection?(s)
    }

    private func apply(_ g: Glance) {
        let now = Format.nowMs()
        glance = g
        lastGlanceMs = now
        lastEventMs = now
        onGlance?(g)
    }

    private func run(_ gen: Int) async {
        var attempt = 0
        while !Task.isCancelled && gen == generation {
            set(attempt == 0 ? .connecting : connection)
            do {
                guard let t = makeTransport(config) else { return }
                transport = t
                let r = try await t.open()
                guard gen == generation else { t.close(); return }
                route = r
                let c = FleetClient(base: r.baseURL, token: token)
                apply(try await c.glance())
                set(glance?.isCollectorStale() == true ? .collectorStale : .live)
                attempt = 0
                lastError = nil
                for try await ev in c.stream() {
                    guard gen == generation, !Task.isCancelled else { return }
                    switch ev {
                    case .glance(let g):
                        apply(g)
                        set(g.isCollectorStale() ? .collectorStale : .live)
                    case .keepalive:
                        lastEventMs = Format.nowMs()
                    }
                }
                throw URLError(.networkConnectionLost)
            } catch {
                guard gen == generation, !Task.isCancelled else { return }
                transport?.close()
                attempt += 1
                lastError = String(describing: error)
                set(.reconnecting(attempt: attempt, error: lastError!))
                let d = backoff.delay(attempt: attempt)
                try? await Task.sleep(nanoseconds: UInt64(d * 1_000_000_000))
            }
        }
    }

    private func checkStaleness(_ gen: Int) {
        guard gen == generation, connection.isLive || connection == .collectorStale else { return }
        if Staleness.isStale(lastEventMs: lastEventMs, fastMs: glance?.fastMs, now: Format.nowMs()) {
            // Silence past the window: the stream is dead even if the socket
            // has not noticed. Start over rather than wait for TCP.
            lastError = "No data for \(Format.short(ms: Staleness.window(fastMs: glance?.fastMs)))"
            let saved = lastError!
            restart()
            set(.reconnecting(attempt: 1, error: saved))
        } else if let t = transport, !t.isAlive {
            restart()
        } else if connection == .live, glance?.isCollectorStale(now: Format.nowMs()) == true {
            // Keepalives still arrive, but no tick has finished: fleetd publishes
            // only after a tick, so the glance on screen would otherwise keep
            // reading live and green (2026-10-07, 12:32Z onwards).
            set(.collectorStale)
        }
    }
}
