import Foundation
import Testing
@testable import CockpitCore

private func fixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try JSONDecoder().decode(type, from: Fixtures.v1(name))
}

private func answer(_ name: String) throws -> (V1Checks, Data) {
    let d = try Fixtures.v1(name)
    return (try JSONDecoder().decode(V1Checks.self, from: d), d)
}

/// A clock that moves only when the code under test sleeps.
private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: Double = 1_000_000
    private(set) var slept: [Double] = []
    var now: Double { lock.withLock { t } }
    func sleep(_ s: Double) { lock.withLock { t += s * 1000; slept.append(s) } }
}

/// Answers in order; the last one repeats.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var steps: [Result<(V1Checks, Data), Error>]
    private(set) var asked: [Int] = []
    init(_ steps: [Result<(V1Checks, Data), Error>]) { self.steps = steps }
    func next(_ w: Int) throws -> (V1Checks, Data) {
        try lock.withLock {
            asked.append(w)
            return try (steps.count > 1 ? steps.removeFirst() : steps[0]).get()
        }
    }
}

private func wait(_ script: Script, _ clock: Clock, deadlineS: Double = 3600) -> CheckWait {
    var w = CheckWait(deadline: clock.now + deadlineS * 1000) { try script.next($0) }
    w.now = { clock.now }
    w.sleep = { clock.sleep($0) }
    return w
}

@Suite("/api/v1 contract")
struct APIContractTests {
    @Test func everyChecksAnswerDecodesWithItsExitCode() throws {
        for (name, state, code) in [("checks-green", "green", 0), ("checks-red", "red", 1),
                                     ("checks-orphaned", "pointless", 2), ("checks-pending", "pending", 3)] as [(String, String, Int32)] {
            let (a, _) = try answer(name)
            #expect(a.state == state, "\(name)")
            #expect(a.exitCode == code, "\(name)")
            #expect(a.checks?.progress.isEmpty == false, "\(name)")
        }
    }

    @Test func aRedCarriesTheFailedRunsAndAnOrphanItsRecovery() throws {
        let (red, _) = try answer("checks-red")
        #expect(red.checks?.failed?.first?.workflow == "web-ci")
        let (orphaned, _) = try answer("checks-orphaned")
        let o = try #require(orphaned.orphans?.first)
        #expect(o.workPassed)
        #expect(o.recovery.contains { $0.contains("force-cancel") })
    }

    @Test func theDiagnosisDecodesIntoTheGlanceTypes() throws {
        let d = try fixture(V1Diagnosis.self, "diagnosis")
        #expect(d.repo == "acme/comet-web")
        #expect(!d.runners.isEmpty)
        #expect(d.orphans.count == 1)
        #expect(d.checks.contains { $0.state == "pending" && $0.etaGreenMs?.count == 2 })
    }

    @Test func actionsPreviewThenRun() throws {
        let p = try fixture(V1Action.self, "action-preview")
        #expect(p.status == "confirm_required")
        #expect(p.confirm == "fixture-confirm")
        #expect(p.command?.contains("drain-runner.sh") == true)
        let done = try fixture(V1Action.self, "action-done")
        #expect(done.status == "done" && done.ok == true)
    }

    @Test func errorsKeepTheirCodeAndHint() throws {
        struct Body: Decodable { var error: APIError }
        let e = try fixture(Body.self, "error-unknown-repo").error
        #expect(e.code == "unknown_repo")
        #expect(e.hint?.contains("owner/repo") == true)
    }
}

@Suite("cockpit why and wait, as text")
struct V1TextTests {
    @Test func whyListsChecksAndOrphans() throws {
        let text = Why.text(try fixture(V1Diagnosis.self, "diagnosis"), repo: "comet-web")
        #expect(text.contains("comet-web: "))
        #expect(text.contains("Checks:"))
        #expect(text.contains("1 of 2 done, done in"))
        #expect(text.contains("Orphaned"))
        #expect(text.contains("gh run rerun"))
        #expect(!text.contains("Collector stalled"))
    }

    @Test func whySaysWhenTheViewIsStale() throws {
        var d = try fixture(V1Diagnosis.self, "diagnosis")
        d.freshness = .init(ageMs: 27 * 60_000, stale: true)
        #expect(Why.text(d, repo: "comet-web").hasPrefix("? Collector stalled: the dashboard's view is 27"))
    }

    @Test func aRedNamesWhatFailed() throws {
        let text = CheckWait.text(try answer("checks-red").0, label: "comet-web @ ec99782")
        #expect(text.hasPrefix("✖ comet-web @ ec99782"))
        #expect(text.contains("web-ci"))
    }

    @Test func anOrphanOffersRecoveryOnlyWhenTheWorkPassed() throws {
        let a = try answer("checks-orphaned").0
        let text = CheckWait.text(a, label: "comet-web PR #7", recoverCommand: "cockpit wait comet-web --pr 7 --recover")
        #expect(text.hasPrefix("⏹"))
        #expect(text.contains("--recover"))
        var failedFirst = a
        failedFirst.orphans?[0].workPassed = false
        #expect(!CheckWait.text(failedFirst, label: "x", recoverCommand: "cockpit wait x --recover").contains("--recover"))
    }
}

@Suite("cockpit wait loop")
struct CheckWaitTests {
    @Test func asksAgainWhilePendingAndStopsOnTheAnswer() async throws {
        let clock = Clock()
        let script = Script([.success(try answer("checks-pending")), .success(try answer("checks-green"))])
        guard case .answer(let a, _) = await wait(script, clock).run() else { Issue.record("no answer"); return }
        #expect(a.state == "green")
        #expect(script.asked == [300, 300])
    }

    @Test func neverAsksTheDaemonToHoldPastTheDeadline() async throws {
        let clock = Clock()
        let script = Script([.success(try answer("checks-green"))])
        _ = await wait(script, clock, deadlineS: 42).run()
        #expect(script.asked == [42])
    }

    @Test func timesOutWithTheLastAnswer() async throws {
        let clock = Clock()
        let script = Script([.success(try answer("checks-pending"))])
        guard case .timeout(let a, _, let reachable) = await wait(script, clock, deadlineS: 10).run() else {
            Issue.record("did not time out"); return
        }
        #expect(a?.state == "pending")
        #expect(reachable)
    }

    @Test func aRefusalEndsTheWait() async throws {
        let clock = Clock()
        let script = Script([.failure(APIError(status: 404, code: "unknown_repo", message: "no"))])
        guard case .refused(let e) = await wait(script, clock).run() else { Issue.record("not refused"); return }
        #expect(e.code == "unknown_repo")
    }

    @Test func anUnreachableDashboardIsRetriedAndGitHubAskedMeanwhile() async throws {
        let clock = Clock()
        let script = Script([.failure(URLError(.cannotConnectToHost))])
        var w = wait(script, clock)
        let drops = Script([.failure(URLError(.cannotConnectToHost))])
        w.onDrop = { _ = try? drops.next(0) }
        let green = CheckSet(id: "github", repo: "acme/comet-web", prNumber: 7, branch: nil, sha: nil, title: nil,
                             runs: [], total: 1, done: 1, failed: [], queued: [], etaGreenMs: nil, state: .green)
        let asks = Script([.failure(URLError(.timedOut))])
        w.github = { _ = try? asks.next(0); return asks.asked.count >= 2 ? green : nil }
        guard case .github(let s) = await w.run() else { Issue.record("GitHub did not answer"); return }
        #expect(s.state == .green)
        #expect(asks.asked.count == 2)
        // Retries every 10 s, GitHub at most once a minute.
        #expect(script.asked.count >= 7)
        #expect(drops.asked.count == script.asked.count)
    }

    @Test func recoversAnOrphanOnceAndWaitsThroughItsCancellation() async throws {
        let clock = Clock()
        let (orphaned, raw) = try answer("checks-orphaned")
        let runId = try #require(orphaned.orphans?.first?.runId)
        // The force-cancel lands: the recovered run reads red (cancelled)
        // until the re-run starts, then the commit goes green.
        var cancelled = try answer("checks-red")
        cancelled.0.checks?.failed = [RunRow(id: runId, repo: "acme/comet-web", workflow: "web-e2e", status: "completed",
                                             conclusion: "cancelled", branch: nil, sha: nil, prNumber: nil, event: nil,
                                             title: nil, url: nil, startedAt: nil, updatedAt: nil, elapsedMs: nil, expectedMs: nil)]
        let script = Script([.success((orphaned, raw)), .success((orphaned, raw)), .success(cancelled), .success(try answer("checks-green"))])
        var w = wait(script, clock)
        let recoveries = Script([.failure(URLError(.unknown))])
        w.recover = { orphans in _ = try? recoveries.next(orphans.count); return nil }
        guard case .answer(let a, _) = await w.run() else { Issue.record("no answer"); return }
        #expect(a.state == "green")
        #expect(recoveries.asked == [1])
    }

    @Test func aRecoveryThatFailsStopsTheWait() async throws {
        let clock = Clock()
        let script = Script([.success(try answer("checks-orphaned"))])
        var w = wait(script, clock)
        w.recover = { _ in "refused: not orphaned" }
        guard case .recoveryFailed(_, _, let why) = await w.run() else { Issue.record("kept waiting"); return }
        #expect(why.contains("refused"))
    }

    @Test func withoutRecoveryAnOrphanIsTheAnswer() async throws {
        let clock = Clock()
        let script = Script([.success(try answer("checks-orphaned"))])
        guard case .answer(let a, _) = await wait(script, clock).run() else { Issue.record("no answer"); return }
        #expect(a.exitCode == 2)
    }
}
