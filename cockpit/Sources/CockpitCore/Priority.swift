import Foundation

/// `cockpit priority <repo> <pr> [--off]`: puts the priority label on a PR, or
/// takes it off. The fleet's admission hooks give a job of a PR carrying it the
/// next free slot in its lane on the host, ahead of jobs without it
/// (hooks/common.sh, PRIORITY LANE; docs/admission-and-scaling.md). The label
/// is created in the repo the first time it is needed.
public enum PriorityLabel {
    public static let defaultName = "priority"
    static let color = "B60205"
    static let summary = "Fleet admission: this PR's CI jobs take the next free slot (cockpit priority)"

    /// The `gh` calls, in order. The first of two (creating the label) may fail
    /// because the label exists, which is fine.
    public static func commands(repo: String, pr: Int, on: Bool, label: String = defaultName) -> [[String]] {
        if on {
            return [
                ["label", "create", label, "-R", repo, "--color", color, "--description", summary],
                ["pr", "edit", String(pr), "-R", repo, "--add-label", label],
            ]
        }
        return [["pr", "edit", String(pr), "-R", repo, "--remove-label", label]]
    }

    /// A PR number from "512" or "#512"; nil for anything else.
    public static func prNumber(_ raw: String) -> Int? {
        let s = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        guard let n = Int(s), n > 0 else { return nil }
        return n
    }

    /// What the owner reads after a change.
    public static func text(repo: String, pr: Int, on: Bool, label: String = defaultName) -> String {
        let short = repo.split(separator: "/").last.map(String.init) ?? repo
        if on {
            return """
            ✔ \(repo)#\(pr) has the \(label) label.
              Its jobs take the next free slot in their admission lane on the host; jobs without it
              wait while one of its jobs is waiting. A job held over the starvation guard (45 min by
              default) still goes ahead by arrival. A job still queued at GitHub for a runner of
              this repo waits for one first: the label orders the host's slots, not GitHub's queue.
              Off again: cockpit priority \(short) \(pr) --off
            """
        }
        return "✔ \(repo)#\(pr): the \(label) label is off; its jobs wait in arrival order again."
    }

    /// Runs the calls; nil on success, else what went wrong.
    public static func apply(repo: String, pr: Int, on: Bool, label: String = defaultName) async -> String? {
        let calls = commands(repo: repo, pr: pr, on: on, label: label)
        for (i, args) in calls.enumerated() {
            let optional = on && i == 0
            if await GHChecksProbe.gh(args, timeout: 30) == nil, !optional {
                return "gh \(args.prefix(2).joined(separator: " ")) failed for \(repo)#\(pr) (is gh signed in, and is #\(pr) an open PR there?)"
            }
        }
        return nil
    }
}
