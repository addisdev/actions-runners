import Foundation
import Testing
@testable import CockpitCore

private func run(_ id: Int, _ wf: String, status: String = "completed", conclusion: String? = "success",
                 sha: String = "abc1234", pr: Int? = 96, updated: Double = 1_000, elapsed: Double? = nil,
                 expected: Double? = nil, repo: String = "acme/comet-web") -> RunRow {
    RunRow(id: id, repo: repo, workflow: wf, status: status, conclusion: status == "completed" ? conclusion : nil,
           branch: "fix-login", sha: sha, prNumber: pr, event: "pull_request", title: "Fix login", url: nil,
           startedAt: nil, updatedAt: updated, elapsedMs: elapsed, expectedMs: expected)
}

private func glance(runs: [RunRow] = [], recent: [RunRow] = [], queue: [QueueItem] = []) throws -> Glance {
    var g = try Fixtures.glance("quiet")
    g.runs = runs; g.recent = recent; g.queue = queue
    return g
}

private func queued(_ id: Int, cause: String, done: [Double]? = nil, repo: String = "acme/comet-web") -> QueueItem {
    QueueItem(id: id, repo: repo, project: nil, workflow: "e2e", queuedMs: 60_000, cause: cause, confidence: "high",
              recommended: "Run health.sh --repair.", evidence: nil, url: nil, branch: nil, prNumber: 96, title: nil,
              etaStartMs: nil, etaDoneMs: done, etaBasis: nil)
}

@Suite("PR rollup")
struct RollupTests {
    @Test func pendingWithAnEtaFromTheSlowestCheck() throws {
        let g = try glance(runs: [run(3, "e2e", status: "in_progress", elapsed: 60_000, expected: 600_000),
                                  run(4, "lint", status: "queued")],
                           recent: [run(1, "ci"), run(2, "build")],
                           queue: [queued(4, cause: "repo-capacity", done: [300_000, 900_000])])
        let s = try #require(Rollup.checkSets(g).first)
        #expect(s.label == "comet-web PR #96")
        #expect(s.state == .pending && s.total == 4 && s.done == 2)
        #expect(s.progress == "2 of 4 done")
        #expect(s.etaGreenMs == [300_000, 900_000])
    }

    @Test func aGreenRerunReplacesTheRedAttempt() throws {
        let g = try glance(recent: [run(1, "ci", conclusion: "failure", updated: 1_000), run(2, "ci", updated: 2_000)])
        #expect(Rollup.checkSets(g).first?.state == .green)
    }

    @Test func redWhenAnyLatestCheckFailed() throws {
        let g = try glance(recent: [run(1, "ci"), run(2, "e2e", conclusion: "failure")])
        let s = try #require(Rollup.checkSets(g).first)
        #expect(s.state == .red && s.failed.map(\.workflow) == ["e2e"])
    }

    @Test func findMatchesShortRepoAndShaPrefixes() throws {
        let g = try glance(recent: [run(1, "ci", sha: "abc1234")])
        #expect(Rollup.find(g, repo: "comet-web", sha: "abc1234def") != nil)
        #expect(Rollup.find(g, repo: "comet-web", pr: 97) == nil)
    }
}

@Suite("wait decision")
struct WaiterTests {
    let target = WaitTarget(repo: "comet-web", pr: 96)

    @Test func greenAndRedEndTheWait() throws {
        let quiet = try Fixtures.glance("quiet").verdict
        #expect(Waiter.decide(try glance(recent: [run(1, "ci")]), verdict: quiet, target: target).exitCode == 0)
        #expect(Waiter.decide(try glance(recent: [run(1, "ci", conclusion: "failure")]), verdict: quiet, target: target).exitCode == 1)
    }

    @Test func aDiskFloorHoldMakesWaitingPointless() throws {
        let hold = try Fixtures.glance("diskHold")
        var g = hold
        g.runs = [run(1, "ci", status: "queued")]
        guard case .pointless(let why) = Waiter.decide(g, verdict: hold.verdict, target: target) else {
            Issue.record("expected pointless"); return
        }
        #expect(why.hasPrefix("Disk floor is holding jobs"))
    }

    @Test func aFinishedResultBeatsAnInfraVerdict() throws {
        var g = try Fixtures.glance("diskHold")
        g.recent = [run(1, "ci")]
        g.runs = []
        #expect(Waiter.decide(g, verdict: g.verdict, target: target) == .green(Rollup.checkSets(g)[0]))
    }

    @Test func aStructuralQueueCauseIsPointless() throws {
        let g = try glance(runs: [run(4, "e2e", status: "queued")], queue: [queued(4, cause: "runner-down")])
        guard case .pointless(let why) = Waiter.decide(g, verdict: g.verdict, target: target) else {
            Issue.record("expected pointless"); return
        }
        #expect(why.contains("runner-down"))
    }

    @Test func aPublicRepoOnHostedRunnersIsWorthWaitingFor() throws {
        var q = queued(4, cause: "github-hosted")
        q.etaBasis = "waiting for a GitHub-hosted runner (public repo)"
        let g = try glance(runs: [run(4, "e2e", status: "queued")], queue: [q])
        guard case .waiting = Waiter.decide(g, verdict: g.verdict, target: target) else {
            Issue.record("a public repo's hosted queue is not pointless"); return
        }
        #expect(Presenter.queue(g).first?.eta == "waiting on GitHub")
    }

    @Test func aQuotaIsNotABlockButBillingIs() throws {
        let live = try Fixtures.glance("live") // storage quota only
        var g = live
        g.runs = [run(1, "ci", status: "in_progress", elapsed: 1, expected: 10)]
        if case .pointless = Waiter.decide(g, verdict: live.verdict, target: target) { Issue.record("quota should not stop a wait") }
        let blocked = try Fixtures.glance("accountBlocked")
        var g2 = blocked
        g2.runs = g.runs
        guard case .pointless = Waiter.decide(g2, verdict: blocked.verdict, target: target) else {
            Issue.record("billing block should stop a wait"); return
        }
    }

    @Test func stillRunningKeepsWaiting() throws {
        let g = try glance(runs: [run(1, "ci", status: "in_progress", elapsed: 1, expected: 10)])
        guard case .waiting(let s) = Waiter.decide(g, verdict: g.verdict, target: target) else { Issue.record("expected waiting"); return }
        #expect(s?.state == .pending)
    }
}

@Suite("watches")
struct WatchTests {
    @Test func onlyResultsAfterTheWatchWasSetCount() throws {
        let g = try glance(recent: [run(1, "ci", updated: 5_000)])
        let before = Watch(target: WaitTarget(repo: "comet-web", pr: 96), createdAt: 1_000)
        let after = Watch(target: WaitTarget(repo: "comet-web", pr: 96), createdAt: 9_000)
        #expect(Watch.finished([before], glance: g).count == 1)
        #expect(Watch.finished([after], glance: g).isEmpty)
    }
}
