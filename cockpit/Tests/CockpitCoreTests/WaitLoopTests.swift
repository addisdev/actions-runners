import Foundation
import Testing
@testable import CockpitCore

// 2026-10-07: greenfolio-ios PR #445 went green on GitHub at 12:33Z and
// greenfolio-android PR #280 at 12:37Z, but runner-host's fast loop finished
// its last tick about 12:32Z. fleetd publishes only after a tick, so every
// client kept the 12:32 glance ("0 of 1 done", "ci / instrumentation · 12 min")
// while keepalives held the stream open. `cockpit wait` checked its deadline
// only when a glance arrived, so it neither saw the result nor timed out.

/// `gh pr view 280 -R addisdev/greenfolio-android --json headRefOid,statusCheckRollup`, as GitHub answered.
private let android280 = #"""
{"headRefOid":"51e466845614f2380c7dce74d6c256deef077b77","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-07T12:24:49Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/addisdev/greenfolio-android/actions/runs/37620208185/job/112788264922","name":"ci / build","startedAt":"2026-10-07T12:19:50Z","status":"COMPLETED","workflowName":"Android CI"},{"__typename":"CheckRun","completedAt":"2026-10-07T12:37:13Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/addisdev/greenfolio-android/actions/runs/37620208185/job/112788264677","name":"ci / instrumentation","startedAt":"2026-10-07T12:19:50Z","status":"COMPLETED","workflowName":"Android CI"}]}
"""#

/// The same PR while instrumentation was still running.
private let android280Running = #"""
{"headRefOid":"51e466845614f2380c7dce74d6c256deef077b77","statusCheckRollup":[{"__typename":"CheckRun","conclusion":"SUCCESS","name":"ci / build","status":"COMPLETED","workflowName":"Android CI"},{"__typename":"CheckRun","conclusion":"","name":"ci / instrumentation","status":"IN_PROGRESS","workflowName":"Android CI"}]}
"""#

private func checks(_ json: String) throws -> GitHubChecks { try GitHubChecks.parse(prView: Data(json.utf8)) }

private let ios = "addisdev/greenfolio-ios"

/// The glance a client held from 12:32Z: PR #445's one check in progress,
/// built `ageMs` before now.
private func frozenGlance(ageMs: Double, conclusion: String? = nil) throws -> Glance {
    var g = try Fixtures.glance("quiet")
    let now = Format.nowMs()
    g.ts = now - ageMs
    g.generatedAt = now - ageMs
    g.ageMs = 0
    g.stale = false
    let run = RunRow(id: 37620685566, repo: ios, workflow: "iOS CI", status: conclusion == nil ? "in_progress" : "completed",
                     conclusion: conclusion, branch: "feat/species-catalog-v2", sha: "70418921d8d3", prNumber: 445,
                     event: "pull_request", title: "Species catalog v2", url: nil, startedAt: now - ageMs - 480_000,
                     updatedAt: now - ageMs, elapsedMs: conclusion == nil ? 480_000 : nil, expectedMs: 1_620_000,
                     prHead: "70418921d8d3")
    if conclusion == nil { g.runs = [run]; g.recent = [] } else { g.runs = []; g.recent = [run] }
    g.queue = []
    return g
}

/// A stream that sends `first` and then only keepalives, forever: a daemon
/// whose HTTP server is fine and whose collector is not.
private func keepalivesAfter(_ first: Glance?) -> WaitLoop.Connect {
    {
        AsyncThrowingStream { c in
            let task = Task {
                if let first { c.yield(.glance(first)) }
                while !Task.isCancelled {
                    c.yield(.keepalive)
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                c.finish()
            }
            c.onTermination = { _ in task.cancel() }
        }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

private func fast(_ l: WaitLoop) -> WaitLoop {
    var l = l
    l.tick = 0.02; l.crossCheckStale = 0.1; l.crossCheckFresh = 0.3; l.connectGrace = 0.1; l.reconnectDelay = 0.05
    return l
}

@Suite("cockpit wait against a stalled collector", .serialized)
struct WaitLoopTests {
    /// The regression itself, over a real SSE connection: the stub daemon sends
    /// the 12:32 glance and then nothing. GitHub says green; the wait must
    /// return green, say it came from GitHub, and say what cockpit still read.
    @Test func aFrozenViewEndsOnGitHubsGreen() async throws {
        let frozen = String(decoding: try JSONEncoder().encode(try frozenGlance(ageMs: 27 * 60_000)), as: UTF8.self)
        let server = try StubServer(routes: [
            "/api/health": .json(200, "{\"ok\":true}"),
            "/api/stream?view=glance": .sse([frozen, ": keepalive"], hold: 30),
        ])
        try await server.start()
        defer { server.stop() }

        let base = server.base
        let asked = Counter()
        let green = try checks(android280)
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 10,
            connect: { FleetClient(base: base).stream() },
            github: { _ in asked.bump(); return green }
        ))
        let started = Date()
        let out = await loop.run()
        guard case .green(let s) = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
        #expect(out.source == .github)
        #expect(out.cockpitSaid?.hasPrefix("0 of 1 done") == true)
        #expect((out.cockpitAgeMs ?? 0) > 26 * 60_000)
        #expect(s.progress == "2 of 2 green")
        #expect(s.repo == ios)
        #expect(asked.value == 1)
        #expect(Date().timeIntervalSince(started) < 5)
    }

    /// Keepalives alone must not hold a wait past its deadline (the old loop
    /// checked the deadline only after a glance).
    @Test func keepalivesAloneStillTimeOut() async throws {
        let pending = try checks(android280Running)
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 0.6,
            connect: keepalivesAfter(try frozenGlance(ageMs: 27 * 60_000)),
            github: { _ in pending }
        ))
        let started = Date()
        let out = await loop.run()
        #expect(Date().timeIntervalSince(started) < 3)
        guard case .waiting(let s) = out.decision else { Issue.record("expected a timeout, got \(out.decision)"); return }
        #expect(out.decision.exitCode == 3)
        // Stale view: the timeout reports GitHub's progress, not the frozen one.
        #expect(s?.progress == "1 of 2 done")
        #expect(out.source == .github)
    }

    /// Without GitHub (a sha or branch wait), the deadline still holds.
    @Test func noGitHubStillTimesOut() async throws {
        let loop = fast(WaitLoop(target: WaitTarget(repo: "greenfolio-ios", sha: "70418921"), timeout: 0.4,
                                 connect: keepalivesAfter(nil), github: nil))
        let started = Date()
        let out = await loop.run()
        #expect(Date().timeIntervalSince(started) < 3)
        #expect(out.decision == .waiting(nil))
    }

    /// A fresh view that is already green answers on its own; GitHub is not asked.
    @Test func aFreshCockpitResultNeedsNoGitHub() async throws {
        let asked = Counter()
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 5,
            connect: keepalivesAfter(try frozenGlance(ageMs: 5_000, conclusion: "success")),
            github: { _ in asked.bump(); return nil }
        ))
        let out = await loop.run()
        guard case .green = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
        #expect(out.source == .cockpit)
        #expect(asked.value == 0)
    }

    /// Rows can freeze while ticks still finish (#37/#38), so a FRESH pending
    /// view is cross-checked too, only less often.
    @Test func aFreshPendingViewIsStillCrossChecked() async throws {
        let green = try checks(android280)
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 5,
            connect: keepalivesAfter(try frozenGlance(ageMs: 5_000)),
            github: { _ in green }
        ))
        let started = Date()
        let out = await loop.run()
        guard case .green = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
        #expect(out.source == .github)
        #expect(Date().timeIntervalSince(started) >= 0.25) // waited for the fresh cadence
    }

    /// GitHub still pending never overrides cockpit's own finished answer.
    @Test func gitHubPendingDoesNotHideACockpitRed() async throws {
        let pending = try checks(android280Running)
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 5,
            connect: keepalivesAfter(try frozenGlance(ageMs: 5_000, conclusion: "failure")),
            github: { _ in pending }
        ))
        let out = await loop.run()
        guard case .red = out.decision else { Issue.record("expected red, got \(out.decision)"); return }
        #expect(out.source == .cockpit)
    }

    /// 2026-10-03/04: "Dashboard unreachable" at load 567 used to end the wait
    /// with exit 3. With a PR, GitHub can still answer.
    @Test func anUnreachableDashboardStillEndsOnGitHub() async throws {
        let green = try checks(android280)
        let loop = fast(WaitLoop(
            target: WaitTarget(repo: "addisdev/greenfolio-android", pr: 280), timeout: 5,
            connect: { throw TransportError.noRoute(["runner-host", "runner-ts"]) },
            github: { _ in green }
        ))
        let out = await loop.run()
        guard case .green(let s) = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
        #expect(out.source == .github && out.cockpitAgeMs == nil)
        #expect(s.repo == "addisdev/greenfolio-android")
    }

    /// A "pointless" verdict from a view 27 minutes old is not a reason to stop.
    @Test func aStaleVerdictIsNotPointless() async throws {
        var g = try frozenGlance(ageMs: 27 * 60_000)
        g.verdict = Verdict(id: "disk-floor", tone: .critical, title: "Disk under the floor", sentence: nil,
                            evidence: [], next: nil, rung: 2, open: [])
        let green = try checks(android280)
        let loop = fast(WaitLoop(target: WaitTarget(repo: "greenfolio-ios", pr: 445), timeout: 5,
                                 connect: keepalivesAfter(g), github: { _ in green }))
        let out = await loop.run()
        guard case .green = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
    }
}

@Suite("GitHub's statusCheckRollup")
struct GitHubChecksTests {
    @Test func theRealPR280AnswerIsGreen() throws {
        let c = try checks(android280)
        #expect(c.head == "51e466845614f2380c7dce74d6c256deef077b77")
        #expect(c.state == .green)
        let s = c.checkSet(repo: "addisdev/greenfolio-android", pr: 280)
        #expect(s.progress == "2 of 2 green" && s.sha == "51e466845614")
    }

    @Test func anUnfinishedCheckIsPending() throws {
        let s = try checks(android280Running).checkSet(repo: "r", pr: 1)
        #expect(s.state == .pending && s.progress == "1 of 2 done")
    }

    @Test func noChecksYetIsPendingNotGreen() throws {
        #expect(try checks(#"{"headRefOid":"abc","statusCheckRollup":[]}"#).state == .pending)
    }

    /// Same rule as cockpit (#36): cancelled is red, not a pass.
    @Test func cancelledIsRed() throws {
        let c = try checks(#"{"statusCheckRollup":[{"__typename":"CheckRun","name":"ci / test","status":"COMPLETED","conclusion":"CANCELLED","detailsUrl":"https://x"}]}"#)
        let s = c.checkSet(repo: "r", pr: 1)
        #expect(s.state == .red && s.failed.first?.cancelled == true && s.failed.first?.url == "https://x")
    }

    @Test func skippedAndNeutralPass() throws {
        let c = try checks(#"{"statusCheckRollup":[{"__typename":"CheckRun","name":"a","status":"COMPLETED","conclusion":"SKIPPED"},{"__typename":"CheckRun","name":"b","status":"COMPLETED","conclusion":"NEUTRAL"}]}"#)
        #expect(c.state == .green)
    }

    @Test func commitStatusesCount() throws {
        let pending = try checks(#"{"statusCheckRollup":[{"__typename":"StatusContext","context":"deploy","state":"PENDING"}]}"#)
        #expect(pending.state == .pending)
        let failed = try checks(#"{"statusCheckRollup":[{"__typename":"StatusContext","context":"deploy","state":"ERROR","targetUrl":"https://y"}]}"#)
        #expect(failed.state == .red)
    }
}

@Suite("collector staleness")
struct CollectorStalenessTests {
    @Test func aGlanceIsAsOldAsItsLastTick() throws {
        let now = Format.nowMs()
        var g = try Fixtures.glance("quiet")
        g.stale = false
        g.ts = now - 30_000
        #expect(!g.isCollectorStale(now: now))
        g.ts = now - 5 * 60_000
        #expect(g.isCollectorStale(now: now))
        g.ts = now
        g.stale = true
        #expect(g.isCollectorStale(now: now))
        g.stale = nil
        g.ts = nil
        #expect(!g.isCollectorStale(now: now))
    }

    @Test func theStalledVerdictNamesTheRealAge() throws {
        let now = Format.nowMs()
        var g = try Fixtures.glance("quiet")
        g.ts = now - 27 * 60_000
        g.ageMs = 0
        let v = CockpitVerdict.effective(glance: g, connection: .collectorStale, outOfBand: nil, lastGlanceMs: nil, now: now)
        #expect(v.title == "Collector stalled")
        #expect(v.sentence?.contains(Format.duration(ms: 27 * 60_000)) == true)
    }
}
