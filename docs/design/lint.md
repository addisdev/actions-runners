# Workflow lint

This page argues that a workflow linter is only believed if it parses the YAML
properly and checks the branch the job actually ran from. Both were learned the
hard way.

Static analysis over every workflow file in every repo. Each rule corresponds to
something that actually went wrong on this fleet, not to a style preference:

| Rule | What it catches |
|---|---|
| `unmatched-label` | a `runs-on:` no live runner satisfies — the job queues until something cancels it |
| `unserved` | the repo has self-hosted jobs and no runner registered anywhere |
| `no-timeout` | a self-hosted job with no `timeout-minutes`; GitHub's 6-hour default never applied to self-hosted |
| `hosted-macos` | a job on GitHub-hosted macOS, which bills at 10x against the included allowance |
| `no-cancel-in-progress` | a `pull_request` workflow that does not supersede its own runs |
| `unparsed` | the parser would not guess — nothing was checked there |

**The YAML is parsed, not grepped.**
[`lib/yaml.js`](https://github.com/addisdev/actions-runners/blob/main/dashboard/lib/yaml.js)
is a subset parser sized for
these files. The construct that forces it is the block scalar: there are 79 of
them across 23 files, nearly all `run: |` shell scripts whose contents are
arbitrary text. A line scanner reads `runs-on:` out of a heredoc and reports a
job that does not exist, and one finding like that is enough for someone to stop
believing the whole screen. Anything the parser cannot confidently read is
reported as `unparsed` and skipped rather than guessed.

It was validated against PyYAML across all 22 workflow files in these repos —
123 fields compared (job names, `runs-on` values, timeouts, step counts,
triggers, concurrency), zero mismatches — and against deliberately hostile input:
a `run: |` block containing a fake `jobs:` tree, `timeout-minutes` inside a
comment and inside a heredoc, anchors, merge keys and tabs.

Two scoping rules stop false positives:

- **Reusable workflows** (`on: workflow_call` only) never run in their own repo —
  they execute in the caller's context on the caller's runners. Their labels are
  checked against the whole fleet, and `unserved` does not apply to them.
- **Label matching is a subset test across every runner registered for the repo,
  on any machine.** A repo that splits `ci` and `release` across two hosts on
  purpose would otherwise be flagged as broken by a check that only saw the
  local runners.

## It lints the branches that actually run

GitHub executes the workflow file **from the ref that triggered the run**, so
there is no single file to check. This used to read the default branch only,
which was wrong in a way that took a manual investigation to notice: the repos
it was built against default to `develop`, while `main` is where pull requests
merge. In one of them the two had diverged by 41 commits, `main` already had the
`concurrency` block, and the Lint tab reported the missing one on `develop`
forever — a finding whose fix already existed one branch over.

The refs to check come from the local `runs` table, not the API, so discovering
them costs nothing:

- **`push` events only.** A `pull_request` run's `head_branch` is the PR's own
  branch — 188 distinct ones for a single repo in 30 days, all transient.
  Pushes land on the handful of long-lived branches, which is also the set
  someone can still fix.
- **At least two pushes**, which drops single-push leftovers like a stale `ci/…`
  branch.
- **Semver-looking refs are skipped.** A tag push runs the file as it was at that
  tag, and no finding against an immutable tag is actionable.
- **The default branch is always included**, pushes or not — it is what the next
  PR opens against.

On this fleet that resolves to `{main, develop}` and turns 27 files into 41
file/branch checks. Findings identical across refs are collapsed into one row;
what the screen adds is the refs each finding applies to, because **a finding on
one branch and not another is a different problem** — the file is already correct
somewhere and the branch is behind, so the fix is a merge, not an edit. Empirically
that is rare and worth knowing: across nine repos with both branches, only that
one file differed in anything a rule reads.

The findings the tab renders, and the shape they arrive in, are in the
[API reference](../api.md). What the rules are asking of a workflow file is in
[Configuring your workflows](../workflows.md).
