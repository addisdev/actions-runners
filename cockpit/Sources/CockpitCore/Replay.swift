import Foundation

/// The recorded incidents, as sequences the replay window steps through. Each
/// step is a bundled fixture plus a caption saying what changed and when —
/// the same fixtures the tests hold the verdict to.
public struct ReplaySequence: Identifiable, Sendable, Hashable {
    public struct Step: Sendable, Hashable {
        public var fixture: String
        public var caption: String
    }
    public var id: String
    public var title: String
    public var steps: [Step]

    public static let all: [ReplaySequence] = [
        .init(id: "disk", title: "Disk floor freeze (2026-09-29)", steps: [
            .init(fixture: "quiet", caption: "09-28 13:30 — 92 GB free, fleet quiet"),
            .init(fixture: "diskBelowIdle", caption: "09-29 04:30 — 37 GB free: under the 40 GB floor, nothing asked to start yet"),
            .init(fixture: "diskHold", caption: "09-29 05:00 — three jobs held at Set up runner, busy=0, no error anywhere"),
            .init(fixture: "quiet", caption: "after cleanup — jobs admitted again"),
        ]),
        .init(id: "dead", title: "Dead runner service", steps: [
            .init(fixture: "quiet", caption: "healthy"),
            .init(fixture: "dead", caption: "RunnerService.js exits 137; launchd keeps the job loaded, nothing restarts it, ios-ci queues"),
            .init(fixture: "quiet", caption: "after health.sh --repair"),
        ]),
        .init(id: "saturated", title: "Saturated host (2026-09-12)", steps: [
            .init(fixture: "waiting", caption: "03:00 — a busy night, runs queued behind busy runners: waiting, healthy"),
            .init(fixture: "saturated", caption: "04:10 — second job lost contact mid-step in an hour: Spotlight indexing _work"),
            .init(fixture: "quiet", caption: "after the indexing burst"),
        ]),
        .init(id: "account", title: "Billing block", steps: [
            .init(fixture: "quiet", caption: "healthy"),
            .init(fixture: "accountBlocked", caption: "GitHub refuses jobs on two repos before they reach any runner"),
        ]),
        .init(id: "agent", title: "Agent host stops reporting", steps: [
            .init(fixture: "quiet", caption: "healthy"),
            .init(fixture: "agentDown", caption: "the studio agent's heartbeat stops; the coordinator cannot place on it"),
        ]),
        .init(id: "drift", title: "Label drift", steps: [
            .init(fixture: "drift", caption: "a second runner with different extra labels will never match runs-on"),
        ]),
    ]
}
