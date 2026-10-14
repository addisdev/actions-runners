import Foundation
import Testing
@testable import CockpitCore

// addisdev/lake-api PR #73, 2026-10-12/13: three real job bodies, kept in
// Fixtures/orphaned-jobs.json so that dashboard/test/orphans.test.js holds the
// daemon's classifier to the same jobs.
private func fixtureJob(_ key: String) -> String {
    let all = try! JSONSerialization.jsonObject(with: Fixtures.data("orphaned-jobs")) as! [String: Any]
    return String(decoding: try! JSONSerialization.data(withJSONObject: all[key]!), as: UTF8.self)
}

/// docs `build`, run 38318681067: "Complete runner" cancelled, "Complete job" in progress.
let docsBuild1 = fixtureJob("docsBuild1")

/// docs `build`, run 38331315857: "Complete runner" itself still in progress, nothing cancelled.
let docsBuild2 = fixtureJob("docsBuild2")

/// site-ci `site`, run 38331315807, on the second runner.
let siteJob = fixtureJob("siteJob")

private let repo = "addisdev/lake-api"

func job(_ json: String) throws -> GHJob { try GHJob.decode(job: Data(json.utf8)) }

private func at(_ iso: String) -> Double { OrphanedJob.ms(iso)! }

private func runner(_ name: String, _ state: RunnerState) -> Runner {
    Runner(name: name, repo: repo, host: "runner-host", state: state)
}

@Suite("jobs orphaned by a draining runner")
struct OrphanedJobTests {
    /// The first incident, 12 minutes in: the runner reads draining, the
    /// completion hook was cancelled, "Complete job" never finished.
    @Test func cancelledCompletionOnADrainingRunner() throws {
        let j = try job(docsBuild1)
        let o = try #require(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .draining),
                                                  now: at("2026-10-12T23:12:33Z")))
        #expect(o.runId == 38318681067 && o.jobId == 115041321171)
        #expect(o.job == "build" && o.runner == "MACSERIAL0-lake-api" && o.runnerState == "draining")
        #expect(o.stuckStep == "Complete job")
        #expect(o.stuckSince == at("2026-10-12T23:00:33Z")) // when "Complete runner" started
        #expect(o.stuckForMs == 12 * 60_000)
        #expect(o.workPassed && o.failedStep == nil)
        #expect(o.summary.contains("orphaned by a draining runner — not your code"))
        #expect(o.forceCancelCommand == "gh api -X POST repos/addisdev/lake-api/actions/runs/38318681067/force-cancel")
        #expect(o.rerunCommand == "gh run rerun 38318681067 -R addisdev/lake-api")
        let text = o.pointless(pr: 73)
        #expect(text.contains(o.forceCancelCommand) && text.contains(o.rerunCommand))
        #expect(text.contains("cockpit wait addisdev/lake-api --pr 73 --recover"))
        #expect(!o.pointless(pr: nil).contains("--recover"))
    }

    /// The tiers controller resumed the runner at 23:05 while GitHub still
    /// held the job, so cockpit read it busy. The cancelled hook is proof enough.
    @Test func aCancelledCompletionIsEnoughOnAResumedRunner() throws {
        let o = OrphanedJob.classify(try job(docsBuild1), repo: repo, runner: runner("MACSERIAL0-lake-api", .busy),
                                     now: at("2026-10-12T23:10:00Z"))
        #expect(o?.runnerState == "busy")
        #expect(OrphanedJob.classify(try job(docsBuild1), repo: repo, runner: nil, now: at("2026-10-12T23:10:00Z")) != nil)
    }

    /// The second incident: "Complete runner" still in progress, nothing
    /// cancelled. Only the runner's state tells this apart from a slow hook.
    @Test func anUnfinishedCompletionNeedsTheRunnerGone() throws {
        let j = try job(docsBuild2)
        let now = at("2026-10-13T01:26:00Z")
        for state in [RunnerState.draining, .offline, .dead, .lost, .hostDown] {
            let o = OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", state), now: now)
            #expect(o?.stuckStep == "Complete runner", "state \(state)")
            #expect(o?.stuckSince == at("2026-10-13T01:22:59Z"))
        }
        #expect(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .busy), now: now) == nil)
        #expect(OrphanedJob.classify(j, repo: repo, runner: nil, now: now) == nil)
    }

    @Test func theSiteJobOnTheSecondRunner() throws {
        let o = try #require(OrphanedJob.classify(try job(siteJob), repo: repo,
                                                  runner: runner("MACSERIAL0-lake-api-2", .offline),
                                                  now: at("2026-10-13T01:26:00Z")))
        #expect(o.job == "site" && o.runner == "MACSERIAL0-lake-api-2" && o.stuckStep == "Complete job")
        #expect(o.workPassed)
    }

    /// Under three minutes is a hook still finishing, not an orphan.
    @Test func notBeforeThreeMinutes() throws {
        let j = try job(docsBuild1)
        let draining = runner("MACSERIAL0-lake-api", .draining)
        #expect(OrphanedJob.classify(j, repo: repo, runner: draining, now: at("2026-10-12T23:03:32Z")) == nil)
        #expect(OrphanedJob.classify(j, repo: repo, runner: draining, now: at("2026-10-12T23:03:33Z")) != nil)
    }

    /// A job still running a work step is running, whatever its runner says.
    @Test func aJobStillWorkingIsNotOrphaned() throws {
        var j = try job(docsBuild1)
        j.steps![4].status = "in_progress"; j.steps![4].conclusion = nil
        #expect(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .draining),
                                     now: at("2026-10-12T23:30:00Z")) == nil)
    }

    /// After the force-cancel GitHub completes the job: nothing to report.
    @Test func aCompletedJobIsNotOrphaned() throws {
        var j = try job(docsBuild1)
        j.status = "completed"; j.conclusion = "cancelled"
        #expect(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .draining),
                                     now: at("2026-10-12T23:30:00Z")) == nil)
    }

    /// A step had failed before the runner left: still orphaned (waiting is
    /// pointless), but not "not your code", and never auto-recovered.
    @Test func aFailedStepIsNamed() throws {
        var j = try job(docsBuild1)
        j.steps![4].conclusion = "failure"
        let o = try #require(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .draining),
                                                  now: at("2026-10-12T23:30:00Z")))
        #expect(!o.workPassed && o.failedStep == "Build")
        #expect(!o.summary.contains("not your code"))
        #expect(!o.pointless(pr: 73).contains("--recover"))
    }

    /// The `…/runs/<id>/jobs` page, with each runner looked up in the glance.
    @Test func aJobsPageAgainstAGlance() throws {
        let page = Data(#"{"total_count":1,"jobs":[\#(siteJob)]}"#.utf8)
        let jobs = try GHJob.decode(jobs: page)
        var g = try Fixtures.glance("quiet")
        g.runners = [runner("MACSERIAL0-lake-api-2", .draining)]
        let found = OrphanedJob.classify(jobs: jobs, repo: repo, glance: g, now: at("2026-10-13T01:40:00Z"))
        #expect(found.map(\.runId) == [38331315807])
        #expect(found.first?.runnerState == "draining")
    }

    @Test func runIdsFromCheckURLs() {
        #expect(WaitLoop.runId(fromURL: "https://github.com/addisdev/lake-api/actions/runs/38331315807/job/115081447989") == 38331315807)
        #expect(WaitLoop.runId(fromURL: "https://github.com/addisdev/lake-api/pull/73") == nil)
    }
}

/// A fresh glance with lake-api PR #73's docs run in progress, started
/// `startedAgoMs` ago, then keepalives only.
private func lakeApiStream(startedAgoMs: Double) throws -> WaitLoop.Connect {
    var g = try Fixtures.glance("quiet")
    let now = Format.nowMs()
    g.ts = now; g.generatedAt = now; g.ageMs = 0; g.stale = false
    g.queue = []; g.recent = []
    g.runs = [RunRow(id: 38318681067, repo: repo, workflow: "docs", status: "in_progress", conclusion: nil,
                     branch: "docs/lake-api-site", sha: "ac14128a1787", prNumber: 73, event: "pull_request",
                     title: "Docs site", url: nil, startedAt: now - startedAgoMs, updatedAt: now,
                     elapsedMs: startedAgoMs, expectedMs: 120_000, prHead: "ac14128a1787")]
    g.runners = [runner("MACSERIAL0-lake-api", .draining)]
    let first = g
    return {
        AsyncThrowingStream { c in
            let task = Task {
                c.yield(.glance(first))
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

private final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func set(_ n: T) { lock.withLock { v = n } }
}

private func pendingChecks() -> GitHubChecks {
    GitHubChecks(head: "ac14128a1787744532bef60da7334a0a8df33637", checks: [
        .init(name: "build", workflow: "docs", status: "in_progress", conclusion: nil,
              url: "https://github.com/addisdev/lake-api/actions/runs/38318681067/job/115041321171"),
    ])
}

private func greenChecks() -> GitHubChecks {
    GitHubChecks(head: "ac14128a1787744532bef60da7334a0a8df33637", checks: [
        .init(name: "build", workflow: "docs", status: "completed", conclusion: "success", url: nil),
    ])
}

private func orphan(workPassed: Bool = true) throws -> OrphanedJob {
    var j = try job(docsBuild1)
    if !workPassed { j.steps![4].conclusion = "failure" }
    return try #require(OrphanedJob.classify(j, repo: repo, runner: runner("MACSERIAL0-lake-api", .draining),
                                             now: OrphanedJob.ms("2026-10-12T23:12:33Z")!))
}

private func quick(_ l: WaitLoop) -> WaitLoop {
    var l = l
    l.tick = 0.02; l.crossCheckStale = 0.1; l.crossCheckFresh = 0.3; l.connectGrace = 0.1
    l.reconnectDelay = 0.05; l.orphanCheckEvery = 0.1
    return l
}

@Suite("cockpit wait on a job orphaned by a draining runner", .serialized)
struct OrphanedWaitTests {
    /// Before: "0 of 1 done" until the timeout. Now: exit 2 with the commands.
    @Test func stopsWithTheRecoveryCommands() async throws {
        let o = try orphan()
        let asked = Box<[Int]>([])
        var loop = quick(WaitLoop(target: WaitTarget(repo: repo, pr: 73), timeout: 5,
                                  connect: try lakeApiStream(startedAgoMs: 25 * 60_000),
                                  github: { _ in pendingChecks() }))
        loop.orphans = { ids, _ in asked.set(ids); return [o] }
        let out = await loop.run()
        guard case .pointless(let why) = out.decision else { Issue.record("expected pointless, got \(out.decision)"); return }
        #expect(out.decision.exitCode == 2)
        #expect(asked.value == [38318681067])
        #expect(why.contains("orphaned by a draining runner — not your code"))
        #expect(why.contains("gh api -X POST repos/addisdev/lake-api/actions/runs/38318681067/force-cancel"))
        #expect(why.contains("gh run rerun 38318681067 -R addisdev/lake-api"))
        #expect(why.contains("--pr 73 --recover"))
    }

    /// --recover: force-cancel and re-run once, then wait on the re-run.
    @Test func recoversOnceThenWaitsOnTheRerun() async throws {
        let o = try orphan()
        let recovered = Box(0)
        var loop = quick(WaitLoop(target: WaitTarget(repo: repo, pr: 73), timeout: 5,
                                  connect: try lakeApiStream(startedAgoMs: 25 * 60_000),
                                  github: { _ in recovered.value > 0 ? greenChecks() : pendingChecks() }))
        loop.orphans = { _, _ in [o] } // still listed: the view lags the re-run
        loop.recover = { got in
            #expect(got == o)
            recovered.set(recovered.value + 1)
            return OrphanRecovery.Result(ok: true, step: "rerun", detail: nil)
        }
        let out = await loop.run()
        guard case .green = out.decision else { Issue.record("expected green, got \(out.decision)"); return }
        #expect(out.source == .github)
        #expect(recovered.value == 1)
    }

    @Test func aFailedRecoveryStopsWithItsStep() async throws {
        let o = try orphan()
        var loop = quick(WaitLoop(target: WaitTarget(repo: repo, pr: 73), timeout: 5,
                                  connect: try lakeApiStream(startedAgoMs: 25 * 60_000),
                                  github: { _ in pendingChecks() }))
        loop.orphans = { _, _ in [o] }
        loop.recover = { _ in OrphanRecovery.Result(ok: false, step: "rerun", detail: "force-cancelled; the re-run was refused") }
        let out = await loop.run()
        guard case .pointless(let why) = out.decision else { Issue.record("expected pointless, got \(out.decision)"); return }
        #expect(why.contains("--recover stopped at rerun: force-cancelled; the re-run was refused"))
    }

    /// A step had failed: a re-run would only repeat it, so --recover leaves it alone.
    @Test func aFailedStepIsNeverRecovered() async throws {
        let o = try orphan(workPassed: false)
        let called = Box(false)
        var loop = quick(WaitLoop(target: WaitTarget(repo: repo, pr: 73), timeout: 5,
                                  connect: try lakeApiStream(startedAgoMs: 25 * 60_000),
                                  github: { _ in pendingChecks() }))
        loop.orphans = { _, _ in [o] }
        loop.recover = { _ in called.set(true); return OrphanRecovery.Result(ok: true, step: "rerun", detail: nil) }
        let out = await loop.run()
        guard case .pointless = out.decision else { Issue.record("expected pointless, got \(out.decision)"); return }
        #expect(!called.value)
    }

    /// A run younger than the threshold is not worth a GitHub call.
    @Test func aYoungRunIsNotAsked() async throws {
        let asked = Box(0)
        var loop = quick(WaitLoop(target: WaitTarget(repo: repo, pr: 73), timeout: 0.6,
                                  connect: try lakeApiStream(startedAgoMs: 60_000),
                                  github: { _ in GitHubChecks(head: nil, checks: []) }))
        loop.orphans = { _, _ in asked.set(asked.value + 1); return [] }
        let out = await loop.run()
        guard case .waiting = out.decision else { Issue.record("expected a timeout, got \(out.decision)"); return }
        #expect(asked.value == 0)
    }
}
