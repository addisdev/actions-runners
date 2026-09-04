# Configuring Your Workflows

This guide covers how to write GitHub Actions workflow files that target your
self-hosted fleet, and common pitfalls.

## Targeting a self-hosted runner

The minimum change to send a job to your fleet:

```yaml
jobs:
  build:
    runs-on: self-hosted   # or [self-hosted, macos, arm64]
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/build.sh
```

`self-hosted` is the label every runner in this fleet carries. Jobs without
that label still run on GitHub-hosted runners.

## Using labels to target specific runners

Register runners with extra labels to route jobs to specific runners:

```bash
./register.sh owner/project-ios xcode-16.3
```

The workflow then matches only runners with that label:

```yaml
runs-on: [self-hosted, macos, xcode-16.3]
```

A runner that lacks any label in the `runs-on` list is invisible to that job.
This is how you run a job on a different Xcode version without touching the rest
of the fleet.

> **Adding a second runner?** Pass the same extra labels as the first, or it
> will not match and will sit permanently idle. The dashboard's **Duplicate**
> button copies labels automatically.

## timeout-minutes

Every self-hosted job needs an explicit `timeout-minutes`. A hung job holds its
runner and everything queues behind it. GitHub's 6-hour default only applies to
hosted runners — it does not apply here.

```yaml
jobs:
  build:
    runs-on: [self-hosted, macos]
    timeout-minutes: 30
    steps:
      - ...
```

A reasonable starting point: `timeout-minutes: 30` for a typical iOS build.
Raise it if your p95 from Analytics shows jobs genuinely taking longer.

## Checkout and cache behaviour

`actions/checkout` defaults to `clean: true`, which runs `git clean -ffdx`
before every job. That deletes untracked build caches in the checkout directory.

Point build directories **outside** the checkout to keep them across jobs:

```yaml
- name: Build
  env:
    DERIVED_DATA: ${{ github.workspace }}/../DerivedData
  run: xcodebuild -derivedDataPath "$DERIVED_DATA" ...
```

Or use `--scratch-path` (SwiftPM) and `-clonedSourcePackagesDirPath` (Xcode)
to move caches out of the checkout. One iOS repo went from 236 s to 95 s
per run after this change.

If you want a clean build (e.g. a release job), use an [ephemeral runner](
ephemeral-runners.md) instead of disabling caching on the persistent runner —
the cache is the point of running on persistent hardware.

## Concurrency groups

Without a concurrency group, one push and one PR merge can run simultaneously,
doubling peak load. Add a concurrency group to queue them instead:

```yaml
concurrency:
  group: ${{ github.ref }}-build
  cancel-in-progress: true
```

`cancel-in-progress: true` is appropriate for feature branches but dangerous on
`main` — a failed canary can cancel a deployment. Use per-branch logic if needed:

```yaml
concurrency:
  group: ${{ github.ref }}-build
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

The dashboard's **Lint** tab flags unbounded matrices, missing concurrency
groups, and static group name collisions automatically.

## Matrix jobs

```yaml
strategy:
  matrix:
    scheme: [App, AppTests, UITests]
```

A 3-scheme matrix runs 3 concurrent jobs — each needing its own runner. On a
single-runner repo this means two jobs will queue. Register a second runner
before deploying a matrix, or the matrix just creates a longer queue.

The dashboard's Capacity tab models this: it shows the maximum simultaneous
jobs in a repo's history and how many runners are needed to absorb that peak
without queuing.

## Public repository safety

Self-hosted runners on public repositories can be triggered by any fork PR.
Treat the runner host as compromised if the repo is public: the job runs as the
current user, and the runner has access to credentials, SSH keys, and any
secrets in the workflow.

If you must use self-hosted runners with a public repo:
- Use ephemeral runners (they delete their working directory after each job)
- Never store secrets accessible to the runner outside the GitHub Secrets vault
- Run the runner as a dedicated limited account, not as yourself
- Read [GitHub's guidance on self-hosted runner security](
  https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners)

The plan for this fleet is private repos only.

## Branch protection note

Branch protection and required status checks are unavailable on private repos
on GitHub's Free plan. The rulesets and branch-protection APIs both return 403.
Nothing in the GitHub UI will stop a red PR from being merged, so you need your
own conventions and review discipline.
