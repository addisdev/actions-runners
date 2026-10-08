import Foundation

/// How a wait ended, and on whose word.
public struct WaitOutcome: Sendable, Equatable {
    public enum Source: String, Sendable { case cockpit, github }

    public var decision: WaitDecision
    public var source: Source
    /// How old cockpit's fleet view was at the end (nil: none was ever seen).
    public var cockpitAgeMs: Double?
    /// What cockpit itself still said when GitHub decided, e.g. "0 of 1 done".
    public var cockpitSaid: String?
}

/// `cockpit wait` and the MCP `wait_for_checks`, as one loop.
///
/// Two things went wrong on 2026-10-07 (greenfolio-ios PR #445,
/// greenfolio-android PR #280) and this loop is shaped against both:
///
/// 1. The daemon's fast loop stopped finishing ticks under load, so it
///    published nothing; the stream carried keepalives only and the last
///    glance said "running" forever. The old loop decided — and checked its
///    deadline — only when a glance arrived, so it could neither see the
///    checks finish nor time out. Here a timer drives the loop and the stream
///    only refreshes what it looks at.
/// 2. Cockpit's rows are a copy of GitHub's. While a wait is pending it asks
///    GitHub itself (`statusCheckRollup`): every `crossCheckStale` seconds
///    when cockpit's view is stale or unreachable, every `crossCheckFresh`
///    otherwise, because a view can also freeze while ticks still finish.
///    GitHub's finished answer ends the wait; its "pending" never overrides
///    cockpit's own green or red.
public struct WaitLoop: Sendable {
    public typealias Connect = @Sendable () async throws -> AsyncThrowingStream<FleetClient.StreamEvent, Error>

    public var target: WaitTarget
    public var timeout: TimeInterval
    public var connect: Connect
    public var github: (@Sendable (Glance?) async -> GitHubChecks?)?
    public var crossCheckFresh: TimeInterval = 120
    public var crossCheckStale: TimeInterval = 30
    /// Before the first glance arrives, how long a connect may take before the
    /// view counts as missing (and GitHub is asked).
    public var connectGrace: TimeInterval = 10
    public var tick: TimeInterval = 1
    public var reconnectDelay: TimeInterval = 3
    public var now: @Sendable () -> Double = { Format.nowMs() }
    /// Progress lines ("… greenfolio-ios PR #445: 0 of 1 done").
    public var progress: @Sendable (String) -> Void = { _ in }

    public init(target: WaitTarget, timeout: TimeInterval, connect: @escaping Connect,
                github: (@Sendable (Glance?) async -> GitHubChecks?)?) {
        self.target = target; self.timeout = timeout; self.connect = connect; self.github = github
    }

    public func run() async -> WaitOutcome {
        let latest = Latest()
        let backoff = Backoff(base: reconnectDelay, cap: max(reconnectDelay, 30))
        let reader = Task {
            var attempt = 0
            while !Task.isCancelled {
                do {
                    for try await ev in try await connect() {
                        if case .glance(let g) = ev { await latest.set(g); attempt = 0 }
                    }
                } catch {}
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(backoff.delay(attempt: attempt) * 1e9))
            }
        }
        defer { reader.cancel() }

        let start = now()
        let deadline = start + timeout * 1000
        var nextCross = start + crossCheckFresh * 1000
        var seen = -1
        var cockpitSet: CheckSet?
        var cockpitLine: String?
        var github: GitHubChecks?
        var askedAt: Double?
        var announced = ""
        var staleAnnounced = false

        func say(_ line: String) {
            if line != announced { progress(line); announced = line }
        }

        while true {
            let t = now()
            let (g, version) = await latest.get()
            let missing = g == nil && t - start > connectGrace * 1000
            let stale = missing || (g?.isCollectorStale(now: t) ?? false)
            let age = g?.collectorAgeMs(now: t)

            if let g, version != seen {
                seen = version
                let d = Waiter.decide(g, verdict: g.verdict, target: target)
                switch d {
                case .green, .red:
                    return WaitOutcome(decision: d, source: .cockpit, cockpitAgeMs: age, cockpitSaid: nil)
                case .pointless where !stale:
                    // A verdict from a view that is not current is not a reason to stop.
                    return WaitOutcome(decision: d, source: .cockpit, cockpitAgeMs: age, cockpitSaid: nil)
                case .waiting(let s):
                    cockpitSet = s
                    cockpitLine = s.map { "\($0.progress)\($0.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")" } ?? "no runs yet"
                    if !stale { say("… \(target.label): \(cockpitLine!)") }
                case .pointless:
                    break
                }
            }

            if stale, !staleAnnounced, self.github != nil {
                staleAnnounced = true
                let why = missing ? "cockpit has no view of the fleet"
                    : "cockpit's view is \(Format.duration(ms: age ?? 0)) old (collector stalled)"
                progress("… \(target.label): \(why); asking GitHub directly every \(Int(crossCheckStale)) s")
            } else if !stale {
                staleAnnounced = false
            }

            if stale { nextCross = min(nextCross, askedAt.map { $0 + crossCheckStale * 1000 } ?? t) }
            if let ask = self.github, t >= nextCross {
                askedAt = t
                if let answer = await ask(g) {
                    github = answer
                    switch answer.state {
                    case .green, .red:
                        let set = answer.checkSet(repo: cockpitSet?.repo ?? target.repo, pr: target.pr)
                        return WaitOutcome(decision: answer.state == .green ? .green(set) : .red(set), source: .github,
                                           cockpitAgeMs: age, cockpitSaid: cockpitLine)
                    case .pending:
                        if stale {
                            let s = answer.checkSet(repo: target.repo, pr: target.pr)
                            say("… \(target.label): \(s.progress) (GitHub)")
                        }
                    }
                }
                nextCross = now() + (stale ? crossCheckStale : crossCheckFresh) * 1000
            }

            if now() >= deadline {
                let set = stale ? (github.map { $0.checkSet(repo: target.repo, pr: target.pr) } ?? cockpitSet) : cockpitSet
                return WaitOutcome(decision: .waiting(set), source: stale && github != nil ? .github : .cockpit,
                                   cockpitAgeMs: age, cockpitSaid: cockpitLine)
            }
            try? await Task.sleep(nanoseconds: UInt64(tick * 1e9))
        }
    }

    private actor Latest {
        var glance: Glance?
        var version = 0
        func set(_ g: Glance) { glance = g; version += 1 }
        func get() -> (Glance?, Int) { (glance, version) }
    }
}
