import Foundation

/// One job as GitHub's REST API has it: `gh api repos/<o>/<r>/actions/jobs/<id>`,
/// or one element of `.jobs` from `…/actions/runs/<id>/jobs`.
public struct GHJob: Codable, Sendable, Equatable {
    public struct Step: Codable, Sendable, Equatable {
        public var name: String
        public var status: String?
        public var conclusion: String?
        public var number: Int?
        public var started_at: String?
        public var completed_at: String?
    }

    public var id: Int
    public var run_id: Int?
    public var name: String?
    public var status: String?
    public var conclusion: String?
    public var runner_name: String?
    public var html_url: String?
    public var started_at: String?
    public var steps: [Step]?

    public static func decode(job data: Data) throws -> GHJob { try JSONDecoder().decode(GHJob.self, from: data) }

    /// `.jobs` of a `…/actions/runs/<id>/jobs` body.
    public static func decode(jobs data: Data) throws -> [GHJob] {
        struct Page: Decodable { var jobs: [GHJob] }
        return try JSONDecoder().decode(Page.self, from: data).jobs
    }
}

/// A job whose work is done but whose result never reached GitHub, because
/// its runner went away while the job was finishing.
///
/// addisdev/homelake PR #73, 2026-10-12/13: three jobs (runs 38318681067,
/// 38331315857, 38331315807) on runners the tiers controller was draining
/// passed every step, then sat `in_progress` for 10-25 minutes with
/// "Complete runner" cancelled or stuck and "Complete job" in progress. The
/// drain stopped the runner's service while the job-completed hook ran
/// (scripts/drain-stop-when-idle.sh, fixed in the same change), the listener
/// cancelled the job, and nobody was left to report it. `gh run cancel` did
/// nothing; `POST …/runs/<id>/force-cancel` completed the run about a minute
/// later and `gh run rerun` then passed in 15 s. `cockpit why` had shown
/// "0 of 1 done" and `cockpit wait` kept waiting.
public struct OrphanedJob: Sendable, Equatable, Codable {
    public var repo: String
    public var runId: Int
    public var jobId: Int
    public var job: String
    public var runner: String?
    /// The runner's state in cockpit's view, if cockpit knows the runner.
    public var runnerState: String?
    /// The "Complete …" step the job is stuck at.
    public var stuckStep: String
    /// When that stage started (ms since 1970).
    public var stuckSince: Double
    public var stuckForMs: Double
    /// Every work step passed: the result was lost, not failed.
    public var workPassed: Bool
    /// The work step that did not pass, when one did not.
    public var failedStep: String?
    public var url: String?

    /// How long a job may sit in "Complete …" before it counts as orphaned.
    /// The completion hook normally takes seconds.
    public static let minStuckMs: Double = 180_000

    /// Runner states that mean the runner is not finishing this job.
    static let goneStates: Set<RunnerState> = [.draining, .offline, .dead, .lost, .hostDown]

    public var forceCancelCommand: String { "gh api -X POST repos/\(repo)/actions/runs/\(runId)/force-cancel" }
    public var rerunCommand: String { "gh run rerun \(runId) -R \(repo)" }

    /// One line: what happened and whose fault it is.
    public var summary: String {
        let who = runner.map { r in "\(r)\(runnerState.map { " (\($0))" } ?? "")" } ?? "its runner"
        let stuck = "stuck at \"\(stuckStep)\" for \(Format.duration(ms: stuckForMs))"
        if workPassed {
            return "\(job): orphaned by a draining runner — not your code. Every step passed, then \(who) went away; \(stuck)."
        }
        return "\(job): orphaned by a draining runner after \"\(failedStep ?? "a step")\" failed; \(who) went away, \(stuck)."
    }

    /// The reason a wait on `pr` stops on this job, with the way out.
    public func pointless(pr: Int?) -> String {
        var lines = [summary, "  force-cancel: \(forceCancelCommand)", "  then, once the run shows completed (~1 min): \(rerunCommand)"]
        if workPassed, let pr { lines.append("  or let cockpit do both for this PR: cockpit wait \(repo) --pr \(pr) --recover") }
        return lines.joined(separator: "\n")
    }

    /// The commands that end it: force-cancel completes the run in about a
    /// minute (plain `gh run cancel` does nothing here), and only then does
    /// GitHub accept a re-run.
    public var recovery: [String] { [forceCancelCommand, "# about a minute later, once the run shows completed:", rerunCommand] }

    /// Whether `job` is orphaned. `runner` is cockpit's view of the job's
    /// runner (nil when cockpit does not list it).
    ///
    /// Orphaned means: the job is in progress; every step that is not a
    /// "Complete …" step has completed; a "Complete …" step has been
    /// cancelled or unfinished for at least `minStuckMs`; and the runner is
    /// gone (draining, offline, dead, lost, host down) or a "Complete …" step
    /// was cancelled. A cancelled completion step is proof on its own: the
    /// worker cancels it only when the listener shuts down, and a run someone
    /// cancelled does not stay in progress for minutes afterwards. That
    /// matters because a drained runner the controller resumed reads "busy"
    /// again while GitHub still holds the orphan.
    public static func classify(_ job: GHJob, repo: String, runner: Runner?, now: Double = Format.nowMs(),
                                minStuckMs: Double = OrphanedJob.minStuckMs) -> OrphanedJob? {
        guard job.status == "in_progress", let steps = job.steps, !steps.isEmpty else { return nil }
        let isFinal: (GHJob.Step) -> Bool = { $0.name.hasPrefix("Complete ") }
        let work = steps.filter { !isFinal($0) }
        guard !work.isEmpty, work.allSatisfy({ $0.status == "completed" }) else { return nil }
        let finals = steps.filter(isFinal)
        let open = finals.filter { $0.status != "completed" || $0.conclusion == "cancelled" }
        guard !open.isEmpty else { return nil }
        let cancelled = finals.contains { $0.conclusion == "cancelled" }
        let gone = runner.map { goneStates.contains($0.state) } ?? false
        guard cancelled || gone else { return nil }

        // From the first unfinished or cancelled "Complete …" step: that is
        // when the job stopped making progress.
        guard let since = open.compactMap({ ms($0.started_at) }).min() else { return nil }
        let stuckFor = now - since
        guard stuckFor >= minStuckMs else { return nil }
        let stuck = open.last { $0.status != "completed" } ?? open[0]
        let failed = work.first { !["success", "skipped", "neutral"].contains($0.conclusion ?? "") }
        return OrphanedJob(repo: repo, runId: job.run_id ?? 0, jobId: job.id, job: job.name ?? "job",
                           runner: job.runner_name, runnerState: runner?.state.rawValue, stuckStep: stuck.name,
                           stuckSince: since, stuckForMs: stuckFor, workPassed: failed == nil,
                           failedStep: failed?.name, url: job.html_url)
    }

    /// Every orphaned job of one run, with each job's runner looked up in `glance`.
    public static func classify(jobs: [GHJob], repo: String, glance: Glance?, now: Double = Format.nowMs()) -> [OrphanedJob] {
        jobs.compactMap { j in
            let r = j.runner_name.flatMap { name in glance?.runners.first { $0.name == name } }
            return classify(j, repo: repo, runner: r, now: now)
        }
    }

    static func ms(_ s: String?) -> Double? {
        guard let s, let d = ISO8601DateFormatter().date(from: s) else { return nil }
        return d.timeIntervalSince1970 * 1000
    }
}

/// Asks GitHub for a run's jobs (its latest attempt) through `gh`.
public enum GHJobsProbe {
    public static func fetch(repo: String, runId: Int, glance: Glance?, timeout: TimeInterval = 20) async -> [GHJob]? {
        guard runId > 0, let full = await GHChecksProbe.fullName(repo, glance: glance),
              let out = await GHChecksProbe.gh(["api", "repos/\(full)/actions/runs/\(runId)/jobs?per_page=100"], timeout: timeout)
        else { return nil }
        return try? GHJob.decode(jobs: out)
    }

    /// The orphaned jobs of `runIds`, asked a few at a time. Runs GitHub does
    /// not answer for are skipped.
    public static func orphans(repo: String, runIds: [Int], glance: Glance?, now: @escaping @Sendable () -> Double = { Format.nowMs() }) async -> [OrphanedJob] {
        guard let full = await GHChecksProbe.fullName(repo, glance: glance) else { return [] }
        return await withTaskGroup(of: [OrphanedJob].self) { group in
            for id in Set(runIds) where id > 0 {
                group.addTask {
                    guard let jobs = await fetch(repo: full, runId: id, glance: glance) else { return [] }
                    return OrphanedJob.classify(jobs: jobs, repo: full, glance: glance, now: now())
                }
            }
            var out: [OrphanedJob] = []
            for await o in group { out += o }
            return out.sorted { $0.stuckSince < $1.stuckSince }
        }
    }
}

/// `--recover`: force-cancel an orphaned run, wait for GitHub to complete
/// it, re-run it, and log what was done. Only `cockpit wait --pr N --recover`
/// calls this, and only for runs of that PR's own checks.
public enum OrphanRecovery {
    public struct Result: Sendable, Equatable, Codable {
        public var ok: Bool
        public var step: String
        public var detail: String?
    }

    /// The log every recovery appends to (one JSON object per line).
    public static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/FleetCockpit/orphan-recover.ndjson")
    }

    public static func recover(_ o: OrphanedJob, pr: Int?, settle: TimeInterval = 180) async -> Result {
        let result = await run(o, settle: settle)
        log(o, pr: pr, result: result)
        return result
    }

    static func run(_ o: OrphanedJob, settle: TimeInterval) async -> Result {
        guard await GHChecksProbe.gh(["api", "-X", "POST", "repos/\(o.repo)/actions/runs/\(o.runId)/force-cancel"], timeout: 30) != nil else {
            return Result(ok: false, step: "force-cancel", detail: "GitHub refused or did not answer")
        }
        // A re-run is refused while the run is still in progress, and
        // force-cancel takes about a minute to complete it.
        let deadline = Date().addingTimeInterval(settle)
        var completed = false
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if let out = await GHChecksProbe.gh(["api", "repos/\(o.repo)/actions/runs/\(o.runId)", "-q", ".status"], timeout: 20),
               String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "completed" {
                completed = true
                break
            }
        }
        guard completed else {
            return Result(ok: false, step: "settle", detail: "force-cancelled, still not completed after \(Int(settle)) s")
        }
        guard await GHChecksProbe.gh(["run", "rerun", String(o.runId), "-R", o.repo], timeout: 30) != nil else {
            return Result(ok: false, step: "rerun", detail: "force-cancelled; the re-run was refused")
        }
        return Result(ok: true, step: "rerun", detail: nil)
    }

    static func log(_ o: OrphanedJob, pr: Int?, result: Result) {
        struct Line: Encodable { let ts: String; let pr: Int?; let orphan: OrphanedJob; let result: Result }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard var data = try? enc.encode(Line(ts: ISO8601DateFormatter().string(from: Date()), pr: pr, orphan: o, result: result)) else { return }
        data.append(0x0A)
        let url = logURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}
