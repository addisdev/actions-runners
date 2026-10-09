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
///
/// 2026-10-09 (aliquant-backend #54, aliquant-web #116, homelab-map #11,
/// taylab-launch-kit #86): waits ran 1.5 h past their deadline because the
/// loop awaited the GitHub ask inline and the ask itself never returned (see
/// `Subprocess`). So now:
/// 3. The deadline is a wall-clock timer of its own (`Deadline.race`); no
///    await inside the loop can hold it, and each GitHub ask has its own
///    budget, capped by the time left.
/// 4. A stream that goes silent (no glance and no keepalive for
///    `streamSilence`) counts as stale and is torn down and reconnected, and
///    `onDrop` lets the caller reopen its route (a dead tunnel).
/// 5. A view that has no runs for the target at all (finished long ago, or
///    rows missing) asks GitHub at the stale cadence, from the start.
public struct WaitLoop: Sendable {
    public typealias Connect = @Sendable () async throws -> AsyncThrowingStream<FleetClient.StreamEvent, Error>

    public var target: WaitTarget
    public var timeout: TimeInterval
    public var connect: Connect
    public var github: (@Sendable (Glance?) async -> GitHubChecks?)?
    public var crossCheckFresh: TimeInterval = 120
    public var crossCheckStale: TimeInterval = 30
    /// The most one GitHub ask may take (it is also capped by the time left).
    public var askTimeout: TimeInterval = 25
    /// Before the first glance arrives, how long a connect may take before the
    /// view counts as missing (and GitHub is asked).
    public var connectGrace: TimeInterval = 10
    /// fleetd sends a keepalive every 25 s; a stream quiet for this long is
    /// dead even if its socket still looks open.
    public var streamSilence: TimeInterval = 75
    /// How long past the deadline the wall-clock backstop lets the loop answer
    /// on its own before answering for it.
    public var hardGrace: TimeInterval = 2
    public var tick: TimeInterval = 1
    public var reconnectDelay: TimeInterval = 3
    public var now: @Sendable () -> Double = { Format.nowMs() }
    /// Progress lines ("… greenfolio-ios PR #445: 0 of 1 done").
    public var progress: @Sendable (String) -> Void = { _ in }
    /// Called when a connection ended without a glance or went silent: the
    /// route under it may be dead (the CLI reopens its SSH tunnel).
    public var onDrop: (@Sendable () -> Void)?

    public init(target: WaitTarget, timeout: TimeInterval, connect: @escaping Connect,
                github: (@Sendable (Glance?) async -> GitHubChecks?)?) {
        self.target = target; self.timeout = timeout; self.connect = connect; self.github = github
    }

    public func run() async -> WaitOutcome {
        let latest = Latest()
        let seen = Seen()
        let reader = Reader()
        reader.start { self.read(into: latest) }
        let outcome = await Deadline.race(seconds: timeout + hardGrace, {
            await self.loop(latest: latest, reader: reader, seen: seen)
        }, onTimeout: { seen.timedOut(target: self.target) })
        reader.stop()
        return outcome
    }

    /// Keeps `latest` current, reconnecting with backoff, until cancelled.
    private func read(into latest: Latest) -> Task<Void, Never> {
        let backoff = Backoff(base: reconnectDelay, cap: max(reconnectDelay, 30))
        return Task {
            var attempt = 0
            while !Task.isCancelled {
                var gotGlance = false
                do {
                    let stream = try await connect()
                    await latest.beginStream(at: now())
                    for try await ev in stream {
                        switch ev {
                        case .glance(let g): await latest.set(g, at: now()); attempt = 0; gotGlance = true
                        case .keepalive: await latest.touch(now())
                        }
                    }
                    await latest.endStream()
                } catch { await latest.endStream() }
                if Task.isCancelled { return }
                if !gotGlance { onDrop?() }
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(backoff.delay(attempt: attempt) * 1e9))
            }
        }
    }

    private func loop(latest: Latest, reader: Reader, seen: Seen) async -> WaitOutcome {
        let start = now()
        let deadline = start + timeout * 1000
        var nextCross = start + crossCheckFresh * 1000
        var seenVersion = -1
        var askedAt: Double?
        var announced = ""
        var staleAnnounced = false
        var restartedAt = start

        func say(_ line: String) {
            if line != announced { progress(line); announced = line }
        }

        while !Task.isCancelled {
            let t = now()
            let snap = await latest.snapshot(start: start)
            let g = snap.glance
            let version = snap.version
            let heardAt = snap.heardAt
            let missing = g == nil && t - snap.noGlanceAnchor > connectGrace * 1000
            let silent = t - (heardAt ?? start) > streamSilence * 1000
            let collectorStale = g?.isCollectorStale(now: t) ?? false
            let stale = missing || silent || collectorStale
            let age = g?.collectorAgeMs(now: t)

            if silent, t - restartedAt > streamSilence * 1000 {
                // Keepalives stopped: the socket is a corpse (daemon restarted
                // under a live tunnel, or the tunnel died quietly). Reconnect.
                restartedAt = t
                onDrop?()
                reader.start { self.read(into: latest) }
            }

            if let g, version != seenVersion {
                seenVersion = version
                let d = Waiter.decide(g, verdict: g.verdict, target: target)
                switch d {
                case .green, .red:
                    return WaitOutcome(decision: d, source: .cockpit, cockpitAgeMs: age, cockpitSaid: nil)
                case .pointless where !stale:
                    // A verdict from a view that is not current is not a reason to stop.
                    return WaitOutcome(decision: d, source: .cockpit, cockpitAgeMs: age, cockpitSaid: nil)
                case .waiting(let s):
                    let line = s.map { "\($0.progress)\($0.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")" } ?? "no runs yet"
                    seen.update { $0.cockpitSet = s; $0.cockpitLine = line }
                    if !stale { say("… \(target.label): \(line)") }
                case .pointless:
                    break
                }
            }
            // Cockpit has a view but no runs for this target: nothing it shows
            // will ever end the wait, so GitHub is asked as often as when stale.
            let blind = g != nil && seen.snapshot().cockpitSet == nil
            seen.update { $0.stale = stale; $0.blind = blind; $0.cockpitAgeMs = age }

            if stale, !staleAnnounced, self.github != nil {
                staleAnnounced = true
                let why = missing ? "cockpit has no view of the fleet"
                    : silent ? "cockpit's stream has been silent for \(Format.duration(ms: t - (heardAt ?? start))) (reconnecting)"
                    : "cockpit's view is \(Format.duration(ms: age ?? 0)) old (collector stalled)"
                progress("… \(target.label): \(why); asking GitHub directly every \(Int(crossCheckStale)) s")
            } else if !stale {
                staleAnnounced = false
            }

            let eager = stale || blind
            // Do not pull GitHub forward while the SSE stream is open but the
            // first glance has not arrived yet (grace is from stream open).
            let accelerate = collectorStale || silent || blind || (missing && !snap.streamOpen)
            if accelerate { nextCross = min(nextCross, askedAt.map { $0 + crossCheckStale * 1000 } ?? t) }
            if let ask = self.github, t >= nextCross {
                askedAt = t
                let left = max(0.1, (deadline - t) / 1000)
                let answer = await Deadline.race(seconds: min(askTimeout, left), { await ask(g) }, onTimeout: { nil })
                if let answer {
                    seen.update { $0.github = answer }
                    switch answer.state {
                    case .green, .red:
                        let snap = seen.snapshot()
                        let set = answer.checkSet(repo: snap.cockpitSet?.repo ?? target.repo, pr: target.pr)
                        return WaitOutcome(decision: answer.state == .green ? .green(set) : .red(set), source: .github,
                                           cockpitAgeMs: age, cockpitSaid: snap.cockpitLine)
                    case .pending:
                        if eager {
                            let s = answer.checkSet(repo: target.repo, pr: target.pr)
                            say("… \(target.label): \(s.progress) (GitHub)")
                        }
                    }
                }
                nextCross = now() + (eager ? crossCheckStale : crossCheckFresh) * 1000
            }

            if now() >= deadline { return seen.timedOut(target: target) }
            try? await Task.sleep(nanoseconds: UInt64(min(tick, max(0.01, (deadline - now()) / 1000)) * 1e9))
        }
        return seen.timedOut(target: target)
    }

    private actor Latest {
        struct Snapshot {
            var glance: Glance?
            var version: Int
            var heardAt: Double?
            var noGlanceAnchor: Double
            var streamOpen: Bool
        }

        var glance: Glance?
        var version = 0
        var heardAt: Double?
        var streamStartedMs: Double?

        func beginStream(at t: Double) { streamStartedMs = t }
        func endStream() { streamStartedMs = nil }
        func set(_ g: Glance, at t: Double) { glance = g; version += 1; heardAt = t }
        func touch(_ t: Double) { heardAt = t }
        func snapshot(start: Double) -> Snapshot {
            Snapshot(glance: glance, version: version, heardAt: heardAt,
                     noGlanceAnchor: streamStartedMs ?? start,
                     streamOpen: streamStartedMs != nil)
        }
    }

    /// The current stream reader; replaced when the stream goes silent.
    private final class Reader: @unchecked Sendable {
        private let lock = NSLock()
        private var task: Task<Void, Never>?
        func start(_ make: () -> Task<Void, Never>) {
            let old = lock.withLock { task }
            old?.cancel()
            let t = make()
            lock.withLock { task = t }
        }
        func stop() { lock.withLock { task }?.cancel() }
    }

    /// What the loop knows, readable by the wall-clock backstop when the loop
    /// itself cannot answer in time.
    final class Seen: @unchecked Sendable {
        struct State {
            var cockpitSet: CheckSet?
            var cockpitLine: String?
            var github: GitHubChecks?
            var cockpitAgeMs: Double?
            var stale = false
            var blind = false
        }
        private let lock = NSLock()
        private var state = State()
        func update(_ f: (inout State) -> Void) { lock.withLock { f(&state) } }
        func snapshot() -> State { lock.withLock { state } }

        /// The timeout answer: GitHub's progress when cockpit's view is stale
        /// or has nothing for the target, else cockpit's.
        func timedOut(target: WaitTarget) -> WaitOutcome {
            let s = snapshot()
            let useGitHub = (s.stale || s.cockpitSet == nil) && s.github != nil
            let set = useGitHub ? s.github.map { $0.checkSet(repo: target.repo, pr: target.pr) } : s.cockpitSet
            return WaitOutcome(decision: .waiting(set), source: useGitHub ? .github : .cockpit,
                               cockpitAgeMs: s.cockpitAgeMs, cockpitSaid: s.cockpitLine)
        }
    }
}
