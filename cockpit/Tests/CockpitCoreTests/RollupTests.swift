import Foundation
import Testing
@testable import CockpitCore

private func run(_ id: Int, _ wf: String, status: String = "completed", conclusion: String? = "success",
                 sha: String = "abc1234", pr: Int? = 96, updated: Double = 1_000, elapsed: Double? = nil,
                 expected: Double? = nil, repo: String = "acme/comet-web", head: String? = nil) -> RunRow {
    RunRow(id: id, repo: repo, workflow: wf, status: status, conclusion: status == "completed" ? conclusion : nil,
           branch: "fix-login", sha: sha, prNumber: pr, event: "pull_request", title: "Fix login", url: nil,
           startedAt: nil, updatedAt: updated, elapsedMs: elapsed, expectedMs: expected, prHead: head)
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

    /// greenfolio-web PR #399, 2026-10-02: both checks were cancelled (timed out
    /// in the admission wait) and the rollup read "2 of 2 green".
    @Test func cancelledChecksAreRedNotGreen() throws {
        let g = try glance(recent: [run(1, "QA Tests", conclusion: "cancelled"), run(2, "Web E2E", conclusion: "cancelled")])
        let s = try #require(Rollup.checkSets(g).first)
        #expect(s.state == .red)
        #expect(s.progress == "2 cancelled · 2 of 2 done")
        #expect(s.failed.allSatisfy { $0.cancelled })
    }

    @Test func aMixOfFailedAndCancelledSaysBoth() throws {
        let g = try glance(recent: [run(1, "ci", conclusion: "failure"), run(2, "e2e", conclusion: "cancelled"), run(3, "lint")])
        #expect(Rollup.checkSets(g).first?.progress == "1 failed, 1 cancelled · 3 of 3 done")
    }

    @Test func skippedAndNeutralStillPass() throws {
        let g = try glance(recent: [run(1, "ci"), run(2, "deploy", conclusion: "skipped"), run(3, "lint", conclusion: "neutral")])
        #expect(Rollup.checkSets(g).first?.state == .green)
    }

    @Test func otherUnfinishedConclusionsAreNotGreen() throws {
        for c in ["action_required", "stale", "something_new"] {
            let g = try glance(recent: [run(1, "ci", conclusion: c)])
            #expect(Rollup.checkSets(g).first?.state == .red, "\(c)")
        }
    }

    @Test func aGreenRerunReplacesTheCancelledAttempt() throws {
        let g = try glance(recent: [run(1, "ci", conclusion: "cancelled", updated: 1_000), run(2, "ci", updated: 2_000)])
        #expect(Rollup.checkSets(g).first?.state == .green)
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
        #expect(Waiter.decide(try glance(recent: [run(1, "ci", conclusion: "cancelled")]), verdict: quiet, target: target).exitCode == 1)
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

/// taylab-launch-kit PR #79, 2026-10-03, run ids as GitHub gave them. 16c0536
/// was pushed (kit-ci 37124998303), caf600e on top cancelled it and failed
/// (37125005925), then the branch was force-pushed back to 16c0536. Until the
/// daemon saw the new run (37125411032), a wait on the PR read "red" from
/// caf600e and a wait on 16c0536 read "cancelled".
@Suite("PR head and re-pushes")
struct PRHeadTests {
    let head = "16c0536773bc"
    var cancelledFirst: RunRow { run(37124998303, "kit-ci", conclusion: "cancelled", sha: "16c0536", pr: 79, updated: 1_000, head: head) }
    var failedOnTop: RunRow { run(37125005925, "kit-ci", conclusion: "failure", sha: "caf600e", pr: 79, updated: 2_000, head: head) }
    let pr = WaitTarget(repo: "taylab-launch-kit", pr: 79)
    let headSha = WaitTarget(repo: "taylab-launch-kit", sha: "16c0536773bcd1c6cb6aa99ac3aeb6a0d269114c")

    private func g(_ runs: [RunRow] = [], _ recent: [RunRow]) throws -> Glance {
        try glance(runs: runs.map { var r = $0; r.repo = "addisdev/taylab-launch-kit"; return r },
                   recent: recent.map { var r = $0; r.repo = "addisdev/taylab-launch-kit"; return r })
    }

    @Test func aWaitOnThePRDoesNotReadAnOlderCommitsRed() throws {
        let g = try g([], [cancelledFirst, failedOnTop])
        guard case .waiting(let s) = Waiter.decide(g, verdict: g.verdict, target: pr) else { Issue.record("expected waiting"); return }
        #expect(s?.sha == "16c0536")
        #expect(s?.progress == "0 of 1 done; waiting for kit-ci to run again on this commit")
    }

    @Test func aWaitOnTheRepushedShaDoesNotReadItsOldCancel() throws {
        let g = try g([], [cancelledFirst, failedOnTop])
        guard case .waiting = Waiter.decide(g, verdict: g.verdict, target: headSha) else { Issue.record("expected waiting"); return }
    }

    @Test func theNewRunOnTheHeadDecides() throws {
        let running = run(37125411032, "kit-ci", status: "in_progress", sha: "16c0536", pr: 79, updated: 3_000, head: head)
        var g = try g([running], [cancelledFirst, failedOnTop])
        guard case .waiting(let s) = Waiter.decide(g, verdict: g.verdict, target: pr) else { Issue.record("expected waiting"); return }
        #expect(s?.superseded.isEmpty == true && s?.progress == "0 of 1 done")

        var passed = running; passed.status = "completed"; passed.conclusion = "success"; passed.updatedAt = 4_000
        g = try self.g([], [cancelledFirst, failedOnTop, passed])
        guard case .green = Waiter.decide(g, verdict: g.verdict, target: pr) else { Issue.record("expected green"); return }
        guard case .green = Waiter.decide(g, verdict: g.verdict, target: headSha) else { Issue.record("expected green"); return }
    }

    @Test func aNewHeadWithNoRunYetIsStillWaiting() throws {
        let g = try g([], [run(1, "ci", conclusion: "failure", sha: "aaaaaaa", pr: 79, head: "bbbbbbbbbbbb")])
        guard case .waiting(nil) = Waiter.decide(g, verdict: g.verdict, target: pr) else { Issue.record("expected waiting with no set"); return }
    }

    /// The ordinary case stays red: a commit the branch moved past, cancelled
    /// by the newer push, is finished, and is not the head.
    @Test func aCommitTheBranchMovedPastKeepsItsCancel() throws {
        let g = try g([], [run(1, "ci", conclusion: "cancelled", sha: "aaaaaaa", pr: 79, head: "bbbbbbbbbbbb"),
                           run(2, "ci", status: "in_progress", sha: "bbbbbbb", pr: 79, head: "bbbbbbbbbbbb")])
        guard case .red = Waiter.decide(g, verdict: g.verdict, target: WaitTarget(repo: "taylab-launch-kit", sha: "aaaaaaa")) else {
            Issue.record("expected red"); return
        }
        guard case .waiting = Waiter.decide(g, verdict: g.verdict, target: pr) else { Issue.record("expected the head, pending"); return }
    }

    /// Concurrency cancels the old run AFTER its replacement was created, so the
    /// cancelled run has the later updatedAt. The newer run id still wins.
    @Test func aRunCancelledAfterItsReplacementStartedDoesNotWin() throws {
        let g = try glance(runs: [run(2, "ci", status: "in_progress", updated: 2_000)],
                           recent: [run(1, "ci", conclusion: "cancelled", updated: 3_000)])
        #expect(Rollup.checkSets(g).first?.state == .pending)
    }

    /// A daemon older than prHead: the commit with the newest run stands in.
    @Test func withoutAHeadTheNewestCommitIsThePR() throws {
        let g = try glance(recent: [run(5, "ci", sha: "bbbbbbb", updated: 1_000),
                                    run(4, "ci", conclusion: "failure", sha: "aaaaaaa", updated: 9_000)])
        #expect(Rollup.find(g, repo: "comet-web", pr: 96)?.sha == "bbbbbbb")
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
