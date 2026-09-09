// Merges the two halves — what GitHub says, and what this machine says — into
// the single snapshot the UI renders, and derives drift from the disagreements
// between them.
//
// Drift is the point of the merge. Every rule below is a state that is silent
// on its own: GitHub shows a runner as online while launchd has it dead, or a
// listener runs happily for a repo that deregistered it and will never send it
// work. Each looks fine from whichever side you happen to be looking at.

// Grouping arrives as a dependency rather than being computed here, because it
// depends on the whole set of repo names and these functions only ever see one
// at a time. See lib/groups.js; fleetd builds it once per tick.
//
// The fallback groups everything as "other". A missing grouper is a wiring
// mistake, and a flat dashboard is a better way to find out about it than a
// daemon that will not start.
const FLAT = { order: ['other'], of: () => 'other' };

function ms(a, b) {
  if (!a || !b) return null;
  const d = new Date(b) - new Date(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

// Labels a runner carries beyond the three every self-hosted runner gets for
// free. Those extras are what `runs-on:` actually selects on, so they are the
// only ones worth comparing between siblings.
// Which instance a runner is, read back out of its directory name. register.sh
// gives instance 1 the bare repo name and appends `-N` from 2 on, so the suffix
// is the only place this number exists — nothing records it.
//
// It matters because instance 1 and the rest are not interchangeable: removing
// a duplicate frees capacity, removing instance 1 leaves the repo with no CI.
// Every scale-down decision turns on that difference.
//
// Matched against the repo's own name rather than by a trailing `-\d+`, because
// plenty of repos end in a number by nature — anything generated from a course
// or template tends to carry a long numeric suffix. A repo called
// `data-pipeline-2024` reads as instance 2024 under the naive rule, and since
// the scale-down sweep only touches instances above 1, that would make its
// runner eligible for automatic removal as if it were a duplicate.
export function instanceOf(dirName = '', repo = '') {
  const base = String(repo).split('/').pop();
  if (base && dirName.startsWith(`${base}-`)) {
    const suffix = dirName.slice(base.length + 1);
    if (/^\d+$/.test(suffix)) return Number(suffix);
  }
  return 1;
}

const IMPLICIT_LABELS = new Set(['self-hosted', 'macos', 'x64', 'arm64', 'linux', 'windows']);
const ROLE_LABELS = new Set(['ci', 'ui-web']);
export function roleLabel(extraLabels = []) {
  return extraLabels.find((l) => ROLE_LABELS.has(l)) ?? null;
}
export function extraLabels(labels = []) {
  return labels
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((l) => l && !IMPLICIT_LABELS.has(l.toLowerCase()))
    .sort();
}

export function buildRunners({ dirs, ghRunnersByRepo, launchd, processes, runnersKnownFor = null, groups = FLAT }) {
  const runners = [];
  const seenGh = new Set();

  for (const d of dirs) {
    // Did we actually manage to ask GitHub about this repo this tick? A failed
    // call leaves no entry, and treating that as "GitHub has no such runner"
    // reports every runner for the repo as an orphan. A single 503 for one repo
    // did exactly that — a 46-second orphan alert for a runner that was
    // registered and online the whole time.
    const ghUnknown = runnersKnownFor ? !runnersKnownFor.has(d.repo) : false;
    const gh = (ghRunnersByRepo.get(d.repo) ?? []).find((r) => r.name === d.name) ?? null;
    if (gh) seenGh.add(`${d.repo}::${gh.name}`);

    const job = launchd.get(d.launchdLabel);
    const listener = processes.listeners.get(d.dir) ?? null;
    const worker = processes.workers.get(d.dir) ?? null;

    let launchdState;
    if (!job) launchdState = 'not-loaded';
    else if (job.pid) launchdState = 'running';
    else launchdState = 'dead';

    runners.push({
      name: d.name,
      repo: d.repo,
      project: groups.of(d.repo),
      dir: d.dir,
      dirName: d.dirName,
      instance: instanceOf(d.dirName, d.repo),
      launchdLabel: d.launchdLabel,
      launchdState,
      drainState: d.drainState ?? null,
      version: d.version ?? null,
      lastExit: job?.lastExit ?? null,
      pid: listener?.pid ?? job?.pid ?? null,
      rssMb: listener ? Math.round(listener.rssKb / 1024) : null,
      uptime: listener?.etime ?? null,
      // Local truth about busy-ness, available instantly and for free. GitHub's
      // `busy` flag agrees, a poll interval later.
      workingLocally: Boolean(worker),
      registered: Boolean(gh),
      // "We could not ask" — every rule that reasons about GitHub state must
      // abstain rather than guess when this is set.
      ghUnknown,
      ghId: gh?.id ?? null,
      ghStatus: gh?.status ?? null,
      ghBusy: gh?.busy ?? false,
      labels: gh ? (gh.labels ?? []).map((l) => l.name) : [],
      extraLabels: gh ? extraLabels(gh.labels) : [],
      role: roleLabel(gh ? extraLabels(gh.labels) : []),
    });
  }

  // Runners GitHub knows about that have no directory here. Either they live on
  // another machine, or they are a registration nobody cleaned up.
  const elsewhere = [];
  for (const [repo, list] of ghRunnersByRepo) {
    for (const r of list) {
      if (seenGh.has(`${repo}::${r.name}`)) continue;
      elsewhere.push({
        name: r.name,
        repo,
        project: groups.of(repo),
        ghStatus: r.status,
        ghBusy: r.busy,
        labels: (r.labels ?? []).map((l) => l.name),
        extraLabels: extraLabels(r.labels),
        role: roleLabel(extraLabels(r.labels ?? [])),
        // An ephemeral runner lands here by construction: it lives under
        // .ephemeral, which disk discovery skips, so GitHub knows about it and
        // this host appears not to. Without this tag it reads as "registered on
        // another machine", which is wrong and invites somebody to go looking for
        // a machine that does not exist — or worse, to clean up a live runner.
        //
        // Matched on the name because scripts/ephemeral-runner.sh is what creates
        // these and it puts `-eph-` in every one.
        ephemeral: /-eph-\d{8}-\d{6}-\d+$/.test(r.name),
      });
    }
  }

  return { runners, elsewhere };
}

export function deriveDrift({ runners, elsewhere, active, repos, now = Date.now(), classify = null }) {
  const drift = [];
  const add = (severity, kind, subject, detail, hint, extra = null) =>
    drift.push({ severity, kind, subject, detail, hint, ...(extra ?? {}) });

  for (const r of runners) {
    // A drained runner is stopped deliberately — no drift alerts for its
    // stopped state, since health.sh --repair also skips drained runners.
    const intentionallyStopped = Boolean(r.drainState);

    if (!intentionallyStopped && r.registered && r.launchdState === 'not-loaded') {
      add('critical', 'launchd-missing', r.name,
        'registered on GitHub, but launchd has no job for it',
        `no LaunchAgent loaded for ${r.launchdLabel} — jobs for ${r.repo} will queue forever`);
    } else if (!intentionallyStopped && r.registered && r.launchdState === 'dead') {
      add('critical', 'launchd-dead', r.name,
        `launchd job loaded but not running (last exit ${r.lastExit})`,
        'no runner plist sets KeepAlive, so launchd will not revive it — health.sh --repair');
    }

    if (!intentionallyStopped && r.launchdState === 'running' && r.registered && !r.ghUnknown && r.ghStatus === 'offline') {
      add('critical', 'offline', r.name,
        'listener is running locally but GitHub reports it offline',
        'the listener is alive but not talking to GitHub — check network and _diag');
    }

    // Only when GitHub actually answered. Otherwise this is a guess dressed up
    // as a finding, and it fires during precisely the moments GitHub is flaky.
    if (!r.registered && !r.ghUnknown) {
      add('serious', 'orphan', r.name,
        'running on this host but not registered for ' + r.repo,
        'deregistered on GitHub and never removed — it will never receive a job. scripts/deregister.sh');
    }

    if (r.registered && r.launchdState === 'running' && !r.pid) {
      add('warning', 'no-listener', r.name,
        'launchd reports a PID but no Runner.Listener process was found',
        'the supervisor is up without its listener');
    }
  }

  // A second runner only matches the same `runs-on:` if it carries the same
  // extra labels. Get this wrong and it sits idle forever while the first one
  // queues — invisible, because both look healthy.
  const byRepo = new Map();
  for (const r of runners) {
    if (!r.registered) continue;
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  for (const [repo, list] of byRepo) {
    if (list.length < 2) continue;
    // Group by role. Runners with different roles (ci vs ui-web) are intentional
    // siblings and do not trigger drift. Mismatches WITHIN the same role do.
    const byRole = new Map();
    for (const r of list) {
      const role = roleLabel(r.extraLabels) ?? '__none__';
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(r);
    }
    for (const [, roleList] of byRole) {
      if (roleList.length < 2) continue;
      const sets = new Set(roleList.map((r) => r.extraLabels.join(',')));
      if (sets.size > 1) {
        add('serious', 'label-mismatch', repo,
          'sibling runners of the same role carry different extra labels: ' +
            roleList.map((r) => `${r.name}[${r.extraLabels.join(',') || 'none'}]`).join(' vs '),
          'they will not match the same runs-on: — the odd one out will never be scheduled');
      }
    }
  }

  // Runners registered elsewhere are context, not a disagreement to act on, and
  // they get their own section on the fleet page. Listing sixteen of them here
  // as "info" pushed the two rows that mattered off the screen — which is the
  // failure mode this whole page exists to prevent.

  // A run queued while a runner that could take it sits idle is the tell for a
  // label mismatch or a wedged listener. It is otherwise only noticed when
  // somebody wonders why a PR has been yellow for an hour.
  for (const run of active) {
    if (run.status !== 'queued') continue;
    // Queue wait is measured from the LATER of created_at and run_started_at.
    // On a re-run, GitHub keeps created_at pinned to the original attempt while
    // run_started_at moves to the new one — so measuring from created_at alone
    // reports the age of the first attempt as queue time. Re-running a run from
    // half an hour ago fired "queued 32m while a runner is idle" for a wait that
    // was actually seconds. A first attempt has no run_started_at yet, where
    // shapeRun falls back to created_at and this is a no-op.
    const queuedSince = Math.max(
      new Date(run.createdAt).getTime(),
      new Date(run.startedAt ?? run.createdAt).getTime()
    );
    const waited = now - queuedSince;
    if (waited < 5 * 60 * 1000) continue;

    // The classifier, when supplied, replaces what used to be a single question
    // — is a runner idle? — with a diagnosis. That question separated only two
    // of the seven reasons a job can sit queued, and it separated the wrong
    // pair: "every runner is busy" and "the host is saturated" both look like
    // idle=false, and only the first is fixed by adding a runner.
    //
    // `actionEligible` is now the only gate on whether the UI offers to add one.
    // The classifier sets it for exactly one cause, repo-capacity, so a label
    // mismatch can no longer be answered by cloning the mismatch — a mistake
    // this fleet has already made once.
    const c = classify?.(run) ?? null;
    if (c) {
      const severity = c.confidence === 'high' && c.cause !== 'github-delay' ? 'serious' : 'warning';
      add(severity, 'stuck-queue', `${run.repo.split('/').pop()} · ${run.workflowName}`,
        `queued ${Math.round(waited / 60000)}m — ${c.cause}`,
        c.recommended,
        {
          repo: run.repo,
          cause: c.cause,
          confidence: c.confidence,
          evidence: c.evidence,
          // Kept under the name the UI already reads, so both paths agree.
          capacityShortage: c.actionEligible,
        });
      continue;
    }

    // Fallback for callers with no classifier wired in. Same conservative bias:
    // duplication is offered only when nothing is idle, because an idle runner
    // that is not taking the job has a label problem, and a second copy of it
    // would sit idle too.
    const idle = runners.some(
      (r) => r.repo === run.repo && r.registered && r.ghStatus === 'online' && !r.ghBusy && !r.workingLocally
    );
    add(idle ? 'serious' : 'warning', 'stuck-queue', `${run.repo.split('/').pop()} · ${run.workflowName}`,
      `queued ${Math.round(waited / 60000)}m` + (idle ? ' while a runner for this repo is idle' : ''),
      idle
        ? 'an idle runner is not picking this up — check that runs-on: matches its labels'
        : 'every runner for this repo is busy',
      { repo: run.repo, capacityShortage: !idle });
  }

  // Repos with workflows and no runner are deliberately NOT drift. Drift means
  // this machine and GitHub disagree about something that exists; an unserved
  // repo is a gap, it has its own section, and listing it in both places buries
  // the disagreements that actually need acting on under a wall of yellow.

  const order = { critical: 0, serious: 1, warning: 2, info: 3 };
  return drift.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function shapeRun(repo, run, groups = FLAT) {
  return {
    id: run.id,
    repo,
    project: groups.of(repo),
    workflowId: run.workflow_id,
    workflowName: run.name,
    workflowPath: run.path ?? null,
    runNumber: run.run_number,
    runAttempt: run.run_attempt ?? null,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    sha: (run.head_sha ?? '').slice(0, 7),
    createdAt: run.created_at,
    startedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
    durationMs: run.status === 'completed' ? ms(run.run_started_at ?? run.created_at, run.updated_at) : null,
    // Fields that enrich the run list without any extra API calls.
    // display_title comes from GitHub and is what their own UI shows.
    displayTitle: run.display_title ?? null,
    // First PR linked to this run — present on pull_request events.
    prNumber: run.pull_requests?.[0]?.number ?? null,
    // Who triggered the run.
    actor: run.actor?.login ?? run.triggering_actor?.login ?? null,
    // First line of the commit message. Truncated on the way in so the DB row
    // stays small regardless of what goes in commit messages.
    headCommitMsg: run.head_commit?.message
      ? String(run.head_commit.message).split('\n')[0].slice(0, 200)
      : null,
  };
}

export function shapeJob(repo, job) {
  return {
    id: job.id,
    runId: job.run_id,
    repo,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    // GitHub sends "" — not null — for a job no runner ever claimed. Left as an
    // empty string it is a value that looks present in SQL and reads as absent
    // in JS, which is the worst of both.
    runnerName: job.runner_name || null,
    runnerId: job.runner_id || null,
    labels: job.labels ?? [],
    queuedMs: ms(job.created_at, job.started_at),
    durationMs: ms(job.started_at, job.completed_at),
    url: job.html_url,
  };
}
