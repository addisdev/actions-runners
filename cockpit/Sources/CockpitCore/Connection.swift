import Foundation

/// Reconnect delays: 1 s doubling to a 30 s cap, ±20 % jitter — fleetd's own
/// browser client uses the same numbers, so a daemon restart is not met by
/// every client reconnecting in the same second.
public struct Backoff: Sendable {
    public var base: Double = 1
    public var cap: Double = 30
    public var jitter: Double = 0.2

    public init(base: Double = 1, cap: Double = 30, jitter: Double = 0.2) {
        self.base = base; self.cap = cap; self.jitter = jitter
    }

    public func delay(attempt: Int, random: Double = Double.random(in: 0...1)) -> Double {
        let raw = min(cap, base * pow(2, Double(max(0, attempt - 1))))
        return raw * (1 - jitter + 2 * jitter * random)
    }
}

/// When silence on the stream means the connection is dead rather than the
/// fleet being quiet. fleetd publishes every tick (15 s busy, 45 s idle) and
/// sends a keepalive every 25 s, so 2.5 ticks — never under a minute — is a
/// generous reading of "nothing is arriving".
public enum Staleness {
    public static func window(fastMs: Double?) -> Double {
        max(60_000, 2.5 * (fastMs ?? 15_000))
    }

    public static func isStale(lastEventMs: Double?, fastMs: Double?, now: Double) -> Bool {
        guard let lastEventMs else { return true }
        return now - lastEventMs > window(fastMs: fastMs)
    }

    /// The daemon's own "collector stale" threshold (FLEET_COLLECTOR_STALE_MS).
    public static let collectorMs: Double = 240_000
}

extension Glance {
    /// How old the fleet view itself is: since the daemon's last finished fast
    /// tick, not since the glance was sent. The two differ when the collector
    /// stalls: fleetd then publishes nothing, the stream carries only
    /// keepalives, and the last glance — whose `stale` was false when it was
    /// built — stays on screen looking live. On 2026-10-07 the last tick
    /// finished about 12:32Z and two waits sat on that view for 27 minutes.
    /// nil when the glance carries no `ts` (a fixture-less test or old daemon).
    public func collectorAgeMs(now: Double = Format.nowMs()) -> Double? {
        ts.map { max(0, now - $0) }
    }

    /// Too old to trust "still running": the daemon said so, or no tick has
    /// finished for longer than the daemon's own threshold.
    public func isCollectorStale(now: Double = Format.nowMs()) -> Bool {
        stale == true || (collectorAgeMs(now: now).map { $0 > Staleness.collectorMs } ?? false)
    }
}

/// Where the cockpit is with the daemon, independent of what the fleet says.
public enum ConnectionState: Sendable, Equatable {
    case connecting
    case live
    /// Connected, but the daemon's own collector has stopped (its snapshot is old).
    case collectorStale
    /// Lost the stream; retrying. The last glance stays on screen, greyed.
    case reconnecting(attempt: Int, error: String)
    case fixture(String)

    public var isLive: Bool {
        switch self {
        case .live, .fixture: true
        default: false
        }
    }
}
