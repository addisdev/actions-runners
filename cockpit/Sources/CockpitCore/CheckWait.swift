import Foundation

/// `cockpit wait`. The daemon decides when checks are done, holding each
/// request up to 300 s (dashboard/lib/checks.js holds the rules and the
/// incidents behind them). What is left to the client is what the daemon
/// cannot do for itself: keep asking until the caller's deadline, survive a
/// dashboard that stops answering (2026-10-03/04, load 567), and ask GitHub
/// directly while it is gone.
public struct CheckWait: Sendable {
    public enum Outcome: Sendable {
        case answer(V1Checks, Data)
        /// GitHub's answer while the dashboard could not be reached.
        case github(CheckSet)
        case timeout(V1Checks?, Data?, reachable: Bool)
        case refused(APIError)
        case recoveryFailed(V1Checks, Data, String)
    }

    public typealias Ask = @Sendable (_ waitS: Int) async throws -> (V1Checks, Data)

    /// Wall-clock deadline, epoch ms.
    public var deadline: Double
    public var ask: Ask
    /// A PR's checks from GitHub, for while the dashboard is unreachable, and
    /// to confirm a green from a daemon too old to confirm it itself (its
    /// answer has no `verified`).
    public var github: (@Sendable () async -> CheckSet?)?
    /// Recovers orphaned runs; returns why it could not, or nil.
    public var recover: (@Sendable ([V1Orphan]) async -> String?)?
    public var onDrop: @Sendable () -> Void = {}
    public var progress: @Sendable (String) -> Void = { _ in }
    public var now: @Sendable () -> Double = { Format.nowMs() }
    public var sleep: @Sendable (Double) async -> Void = { s in try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
    public var githubEveryS: Double = 60
    /// How often an unconfirmed green is asked of GitHub again.
    public var confirmEveryS: Double = 15
    public var retryS: Double = 10
    /// After a recovery, a red made only of the recovered runs, cancelled, is
    /// the force-cancel landing before the re-run starts, not a result.
    public var settleMs: Double = 240_000

    public init(deadline: Double, ask: @escaping Ask) {
        self.deadline = deadline
        self.ask = ask
    }

    public func run() async -> Outcome {
        var last: (V1Checks, Data)?
        var said: String?
        var askedGitHub = -Double.infinity
        var confirmedAt = -Double.infinity
        var recovered: [Int: Double] = [:]
        var reachable = false
        var dropped = false
        while true {
            let left = (deadline - now()) / 1000
            if left <= 0 { return .timeout(last?.0, last?.1, reachable: reachable) }
            let a: V1Checks, raw: Data
            do {
                (a, raw) = try await ask(min(300, max(1, Int(left))))
            } catch let e as APIError where e.code == "unsupported" || (400..<500).contains(e.status) {
                return .refused(e)
            } catch {
                onDrop()
                if !dropped {
                    progress("dashboard unreachable (\(error.localizedDescription)); retrying\(github == nil ? "" : ", asking GitHub meanwhile")")
                    dropped = true
                }
                if let github, now() - askedGitHub >= githubEveryS * 1000 {
                    askedGitHub = now()
                    if let s = await github(), s.state != .pending { return .github(s) }
                }
                await sleep(retryS)
                continue
            }
            reachable = true
            dropped = false
            last = (a, raw)
            if let s = a.checks, case let p = s.progress + (s.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")
                + (a.state == "pending" ? a.reason.map { " — \($0)" } ?? "" : ""), p != said {
                progress(p)
                said = p
            }
            // A green from a daemon that does not confirm greens on GitHub
            // (stream-app PR #5, 2026-10-24: its "1 of 1 green" was the
            // previous head's, 8 s after a push). Not believed until GitHub
            // agrees; GitHub not answering is not a yes.
            if a.state == "green", a.verified == nil, let github {
                if now() - confirmedAt >= confirmEveryS * 1000 {
                    confirmedAt = now()
                    let s = await github()
                    if let s, s.state == .green { return .answer(a, raw) }
                    if let s, s.state == .red { return .github(s) }
                    let p = "the dashboard read \(a.checks?.progress ?? "green"), but GitHub "
                        + (s.map { "has \($0.progress)\($0.why.map { " — \($0)" } ?? "")" } ?? "did not answer")
                    if p != said { progress(p); said = p }
                }
                await sleep(min(retryS, max(0.01, (deadline - now()) / 1000)))
                continue
            }

            if a.state == "pointless", let recover, let orphans = a.orphans, !orphans.isEmpty,
               orphans.allSatisfy(\.workPassed) {
                let fresh = orphans.filter { recovered[$0.runId] == nil }
                if fresh.isEmpty {
                    // Force-cancelled; GitHub has not completed the run yet.
                    await sleep(retryS)
                    continue
                }
                if let why = await recover(fresh) { return .recoveryFailed(a, raw, why) }
                for o in fresh {
                    recovered[o.runId] = now()
                    progress("recovering run \(o.runId): force-cancelled; the dashboard re-runs it once GitHub completes it")
                }
                continue
            }
            if a.state == "red", let failed = a.checks?.failed, !failed.isEmpty,
               failed.allSatisfy({ r in r.cancelled && recovered[r.id].map { now() - $0 < settleMs } == true }) {
                await sleep(retryS)
                continue
            }
            if a.finished { return .answer(a, raw) }
            // The daemon held the request; a pending that came straight back
            // means it could not, and asking again at once would spin.
            if (a.waitedMs ?? 0) < 1000 { await sleep(2) }
        }
    }

    /// The answer, for a person.
    public static func text(_ a: V1Checks, label: String, recoverCommand: String? = nil) -> String {
        var out: [String] = []
        let note: String = {
            guard a.source == "github" else { return "" }
            let age = a.fleetAgeMs.map { "the fleet's view is \(Format.duration(ms: $0)) old" } ?? "the fleet had no view"
            return " (from GitHub; \(age)\(a.fleetSaid.map { ", it still read \($0)" } ?? ""))"
        }()
        let progress = a.checks?.progress
        switch a.state {
        case "green":
            let covered = a.verified.map { v in
                " (GitHub: \(v.runs) run\(v.runs == 1 ? "" : "s"), \(v.jobs) job\(v.jobs == 1 ? "" : "s"))"
            } ?? ""
            out.append("✔ \(label): \(progress ?? "green")\(covered)\(note)")
        case "red":
            out.append("✖ \(label): \(progress ?? "red")\(note)")
            for f in a.checks?.failed ?? [] {
                out.append("  \(f.workflow ?? "?")\(f.cancelled ? " (cancelled)" : "")\(f.url.map { " — \($0)" } ?? "")")
            }
            if let h = a.hint { out.append("  \(h)") }
        case "pointless":
            out.append("⏹ \(label): not waiting — \(a.reason ?? "waiting cannot end well")")
            for o in a.orphans ?? [] { for c in o.recovery { out.append("    \(c)") } }
            if let recoverCommand, let orphans = a.orphans, !orphans.isEmpty, orphans.allSatisfy(\.workPassed) {
                out.append("  or let cockpit do both: \(recoverCommand)")
            }
        default:
            out.append("… \(label): timed out\(progress.map { " at \($0)" } ?? " (no runs seen)")\(note)")
        }
        return out.joined(separator: "\n")
    }
}
