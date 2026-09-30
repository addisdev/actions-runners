import Foundation

/// Turns successive glances' open incidents into what deserves a notification.
///
/// The daemon already fires on transitions, stores intervals and guards
/// storms; this mirrors that on the receiving end so the cockpit announces the
/// same things the same way: once on open, once on recovery with how long it
/// lasted, nothing for conditions already open at launch, one summary instead
/// of a burst, and nothing that was dismissed, snoozed, muted or below the
/// chosen severity.
public struct IncidentTracker: Sendable {
    public struct Preferences: Codable, Sendable, Equatable {
        /// "critical" or "warning": the least severe incident that notifies.
        public var minSeverity: String = "warning"
        public var mutedRules: Set<String> = []
        /// Quiet hours as local hours (start inclusive, end exclusive); nil = off.
        /// During quiet hours only critical incidents notify.
        public var quietStart: Int?
        public var quietEnd: Int?

        public init() {}

        public func inQuietHours(hour: Int) -> Bool {
            guard let s = quietStart, let e = quietEnd, s != e else { return false }
            return s < e ? (hour >= s && hour < e) : (hour >= s || hour < e)
        }
    }

    public enum Event: Sendable, Equatable {
        case opened(Incident)
        case recovered(Incident, lastedMs: Double)
        case storm(count: Int, worst: Incident)
        case recoveredMany(count: Int)
    }

    public var stormThreshold = 5
    private var known: [String: Incident] = [:]
    private var announced: Set<String> = []
    private var primed = false
    private var snoozedUntil: [String: Double] = [:]

    public init() {}

    public mutating func snooze(_ key: String, untilMs: Double) { snoozedUntil[key] = untilMs }

    /// Feeds one glance's incidents; returns what to announce.
    public mutating func update(_ incidents: [Incident], prefs: Preferences, now: Double, hour: Int) -> [Event] {
        let current = Dictionary(incidents.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        defer { known = current }
        // The first glance after launch is the state of the world, not news.
        guard primed else {
            primed = true
            announced = Set(current.values.filter { passes($0, prefs, now: now, hour: hour) }.map(\.key))
            return []
        }

        var events: [Event] = []
        var opened: [Incident] = []
        for (key, inc) in current where known[key] == nil && passes(inc, prefs, now: now, hour: hour) {
            opened.append(inc)
            announced.insert(key)
        }
        var recovered: [Event] = []
        for (key, inc) in known where current[key] == nil && announced.contains(key) {
            announced.remove(key)
            recovered.append(.recovered(inc, lastedMs: max(0, now - (inc.openedAt ?? now))))
        }
        events.append(contentsOf: recovered.count > stormThreshold ? [.recoveredMany(count: recovered.count)] : recovered)
        if opened.count > stormThreshold {
            let worst = opened.max { $0.tone < $1.tone }!
            events.insert(.storm(count: opened.count, worst: worst), at: 0)
        } else {
            events.insert(contentsOf: opened.sorted { $0.tone > $1.tone }.map(Event.opened), at: 0)
        }
        snoozedUntil = snoozedUntil.filter { $0.value > now }
        return events
    }

    private func passes(_ inc: Incident, _ p: Preferences, now: Double, hour: Int) -> Bool {
        if inc.dismissed == true { return false }
        if let rule = inc.rule, p.mutedRules.contains(rule) { return false }
        if let until = snoozedUntil[inc.key], until > now { return false }
        let tone = inc.tone
        if p.inQuietHours(hour: hour) { return tone == .critical }
        return p.minSeverity == "critical" ? tone == .critical : (tone == .critical || tone == .warning)
    }
}

public extension Incident {
    /// Rules whose repair is health.sh --repair.
    var isRepairable: Bool {
        ["launchd-dead", "launchd-missing", "offline", "no-listener"].contains(rule ?? "")
            || (rule == "stuck-queue" && key.contains(":runner-down:"))
    }
}
