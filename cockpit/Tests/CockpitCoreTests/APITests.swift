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

/// GitHub's answer for a PR as `gh` gives it, and the green rule over it:
/// stream-app PR #5 (2026-10-24), where every check GitHub listed had passed
/// while run 40116718009 was still creating the six jobs behind `needs:`.
@Suite("GitHub's checks")
struct GitHubChecksTests {
    static let view = Data("""
    {"headRefOid":"d42a20fa8be5e24c477004b82a8c2194eacd6493","headRefName":"fix/ci-gate",
     "headRepository":{"name":"stream-app"},"headRepositoryOwner":{"login":"acme"},"state":"OPEN",
     "statusCheckRollup":[
      {"__typename":"CheckRun","name":"guard","workflowName":"ci","status":"COMPLETED","conclusion":"SUCCESS",
       "completedAt":"2026-10-24T17:34:39Z","detailsUrl":"https://github.com/acme/stream-app/actions/runs/40116718009/job/120939404752"},
      {"__typename":"CheckRun","name":"changes","workflowName":"ci","status":"COMPLETED","conclusion":"SUCCESS",
       "completedAt":"2026-10-24T17:34:46Z","detailsUrl":"https://github.com/acme/stream-app/actions/runs/40116718009/job/120939404951"}]}
    """.utf8)

    static func runs(_ status: String, conclusion: String? = nil, updated: String = "2026-10-24T17:34:46Z") -> Data {
        Data("""
        {"total_count":1,"workflow_runs":[{"id":40116718009,"workflow_id":7,"name":"ci","status":"\(status)",
         "conclusion":\(conclusion.map { "\"\($0)\"" } ?? "null"),"created_at":"2026-10-24T17:34:12Z","updated_at":"\(updated)",
         "html_url":"https://github.com/acme/stream-app/actions/runs/40116718009"}]}
        """.utf8)
    }

    static func at(_ iso: String) -> Double { ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970 * 1000 }

    @Test func aGreenRollupWhileTheRunIsInProgressIsPending() throws {
        var c = try GitHubChecks.parse(prView: Self.view)
        #expect(c.state == .green, "the rollup alone, as before")
        #expect(c.headRepo == "acme/stream-app" && c.headRef == "fix/ci-gate" && c.open)
        c.runs = try GitHubChecks.parse(runs: Self.runs("in_progress"))
        c.fetchedAt = Self.at("2026-10-24T17:34:50Z")
        #expect(c.state == .pending)
        #expect(c.pendingWhy == "GitHub still has ci in progress")
        #expect(c.checkSet(repo: "acme/stream-app", pr: 5).progress == "2 of 2 done")
    }

    @Test func aFinishedRunIsGreenOnlyOnceGitHubHasBeenQuiet() throws {
        var c = try GitHubChecks.parse(prView: Self.view)
        c.runs = try GitHubChecks.parse(runs: Self.runs("completed", conclusion: "success", updated: "2026-10-24T17:36:54Z"))
        c.fetchedAt = Self.at("2026-10-24T17:37:00Z")
        #expect(c.state == .pending)
        #expect(c.pendingWhy?.hasPrefix("settling: ") == true)
        c.fetchedAt = Self.at("2026-10-24T17:37:30Z")
        #expect(c.state == .green)
    }

    @Test func aRunWithNoJobInTheRollupIsARowOfItsOwn() throws {
        var c = try GitHubChecks.parse(prView: Self.view)
        c.checks = []
        c.runs = try GitHubChecks.parse(runs: Self.runs("queued"))
        let set = c.checkSet(repo: "acme/stream-app", pr: 5)
        #expect(set.state == .pending)
        #expect(set.progress == "0 of 1 done")
    }

    @Test func aFailedRunIsRed() throws {
        var c = try GitHubChecks.parse(prView: Self.view)
        c.runs = try GitHubChecks.parse(runs: Self.runs("completed", conclusion: "cancelled", updated: "2026-10-24T17:36:54Z"))
        c.fetchedAt = Self.at("2026-10-24T17:36:55Z")
        #expect(c.state == .red)
    }
}

@Suite("cockpit wait confirms an older daemon's green")
struct ConfirmGreenTests {
    private func unverifiedGreen() throws -> (V1Checks, Data) {
        var (a, raw) = try answer("checks-green")
        a.verified = nil
        return (a, raw)
    }

    @Test func aGreenWithVerifiedIsBelievedWithoutAsking() async throws {
        let clock = Clock()
        var w = wait(Script([.success(try answer("checks-green"))]), clock)
        let asks = Script([.failure(URLError(.unknown))])
        w.github = { _ = try? asks.next(0); return nil }
        guard case .answer(let a, _) = await w.run() else { Issue.record("no answer"); return }
        #expect(a.state == "green")
        #expect(asks.asked.isEmpty)
        #expect(CheckWait.text(a, label: "comet-web @ ec99782") == "✔ comet-web @ ec99782: 1 of 1 green (GitHub: 1 run, 1 job)")
    }

    @Test func anUnverifiedGreenWaitsForGitHub() async throws {
        let clock = Clock()
        var w = wait(Script([.success(try unverifiedGreen())]), clock)
        var pending = CheckSet(id: "github", repo: "acme/comet-web", prNumber: 7, branch: nil, sha: nil, title: nil,
                               runs: [], total: 9, done: 2, failed: [], queued: [], etaGreenMs: nil, state: .pending)
        pending.why = "GitHub still has ci in progress"
        var green = pending
        green.state = .green
        green.done = 9
        let asks = Script([.failure(URLError(.unknown))])
        let (stillPending, nowGreen) = (pending, green)
        w.github = { _ = try? asks.next(0); return asks.asked.count >= 3 ? nowGreen : stillPending }
        guard case .answer(let a, _) = await w.run() else { Issue.record("no answer"); return }
        #expect(a.state == "green")
        #expect(asks.asked.count == 3)
        #expect(clock.now - 1_000_000 >= 30_000, "asked every 15 s")
    }

    @Test func anUnverifiedGreenThatGitHubCallsRedIsRed() async throws {
        let clock = Clock()
        var w = wait(Script([.success(try unverifiedGreen())]), clock)
        let red = CheckSet(id: "github", repo: "acme/comet-web", prNumber: 7, branch: nil, sha: nil, title: nil,
                           runs: [], total: 2, done: 2, failed: [], queued: [], etaGreenMs: nil, state: .red)
        w.github = { red }
        guard case .github(let s) = await w.run() else { Issue.record("not GitHub's red"); return }
        #expect(s.state == .red)
    }

    @Test func anUnverifiedGreenGitHubCannotConfirmTimesOut() async throws {
        let clock = Clock()
        var w = wait(Script([.success(try unverifiedGreen())]), clock, deadlineS: 60)
        w.github = { nil }
        guard case .timeout = await w.run() else { Issue.record("did not time out"); return }
    }
}
