import Foundation

/// What the cockpit shows at the top: the daemon's verdict when it can be
/// trusted, and an honest statement of what is not known when it cannot.
/// Abstain, never guess — a view that cannot be refreshed is never green.
public enum CockpitVerdict {
    public static func effective(glance: Glance?, connection: ConnectionState, outOfBand: Verdict?,
                                 lastGlanceMs: Double?, now: Double = Format.nowMs()) -> Verdict {
        if let outOfBand { return outOfBand }
        switch connection {
        case .reconnecting(_, let error):
            let age = lastGlanceMs.map { "The view below is \(Format.duration(ms: now - $0)) old." } ?? "Nothing has been received yet."
            return Verdict(
                id: "unreachable", tone: .unknown, title: "Dashboard unreachable",
                sentence: "\(age) Retrying; checking the host out of band.",
                evidence: [error], next: NextMove(label: "Reconnect now", kind: "reconnect"),
                rung: nil, open: []
            )
        case .collectorStale:
            let age = glance?.ageMs.map { Format.duration(ms: $0) } ?? "a while"
            return Verdict(
                id: "unknown", tone: .unknown, title: "Collector stalled",
                sentence: "The dashboard is answering but its last completed pass was \(age) ago, so the fleet view is out of date.",
                evidence: [glance?.collector?.lastError].compactMap { $0 },
                next: NextMove(label: "Restart the dashboard on the host", kind: "command", command: "cd ~/actions-runners/dashboard && ./fleetctl.sh restart"),
                rung: 0, open: []
            )
        case .connecting where glance == nil:
            return Verdict(id: "connecting", tone: .unknown, title: "Connecting", sentence: "Opening a route to the dashboard.",
                           evidence: [], next: nil, rung: nil, open: [])
        default:
            if let g = glance { return g.verdict }
            return Verdict(id: "connecting", tone: .unknown, title: "Connecting", sentence: nil,
                           evidence: [], next: nil, rung: nil, open: [])
        }
    }
}
