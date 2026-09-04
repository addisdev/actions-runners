#!/usr/bin/env node
// Escalation: hand an alert to an agent when there is nothing mechanical to run.
//
//   fleetd alert ──webhook──> bridge ──┬─> health.sh --repair      (3 rules)
//                                      └─> escalate.sh ──> here    (the rest)
//
// The bridge's own comment explains why it has no model in its loop, and that
// reasoning still holds: for a dead LaunchAgent the fix is known and one shell
// call away, so asking a model about it would be strictly worse. But the same
// paragraph concedes the other half — "the alerts that DO need judgement are
// left to notify a human instead" — and a notification at 03:00 saying
// `Run is stuck in the queue` is not judgement, it is a request for someone
// else to go and read six API endpoints. That reading is what this does.
//
// The division of labour is therefore: autofix REPAIRS, escalation EXPLAINS.
// Nothing here touches the fleet. The agent is told to diagnose and report, and
// it is never handed the control token, so the worst outcome of a bad run is a
// wrong paragraph in an issue rather than sixteen restarted runners.
//
// Honest limitation: a local agent runs as this user and has a shell. The
// read-only posture below is an instruction, not a sandbox. What actually keeps
// this safe is that the escalation path holds no fleet credential and the
// destructive fleet actions all live behind fleet-action.sh's allowlist.
//
// This is also the only part of the dashboard with a dependency, which is why
// it lives in its own directory with its own package.json. The bridge must keep
// repairing dead runners even if this whole subtree fails to load.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOFIX = dirname(HERE);
const DASH = dirname(AUTOFIX);

const CONFIG = {
  fleetUrl: process.env.FLEET_URL ?? 'http://127.0.0.1:7878',
  model: process.env.ESCALATE_MODEL ?? 'composer-2.5',
  // Generous, because reading annotations for a failed run is several API round
  // trips. Enforced with run.cancel() rather than by killing the process, so
  // the run is torn down on Cursor's side too instead of being orphaned.
  timeoutMs: Number(process.env.ESCALATE_TIMEOUT_MS ?? 300_000),
  reportDir: join(DASH, 'logs', 'escalations'),
  dryRun: process.env.ESCALATE_DRY_RUN === '1',
  // Filing is opt-out per repo rather than opt-in, but a repo that should never
  // receive automated issues can be listed here.
  noIssueRepos: (process.env.ESCALATE_NO_ISSUE_REPOS ?? '').split(',').filter(Boolean),
};

const ISSUE_LABEL = 'fleet-escalation';

function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(' ')}`);
}

// Same reasoning as alerts.js: arguments, never interpolation. The subtitle and
// body here contain a repo name and model-written prose, which is exactly the
// input you do not want reaching an AppleScript parser.
function notify(title, body) {
  const script =
    'on run argv\n' +
    '  display notification (item 1 of argv) with title "Fleet" subtitle (item 2 of argv)\n' +
    'end run';
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script, (body || ' ').slice(0, 400), title.slice(0, 200)],
      { timeout: 15_000 }, () => resolve());
  });
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 << 20, ...opts },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      }));
  });
}

async function getJson(path) {
  try {
    const res = await fetch(`${CONFIG.fleetUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `${path} -> ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: `${path} -> ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// What to actually look at, per rule.
//
// A generic "investigate this alert" prompt produces a generic answer: the
// model rediscovers the dashboard from scratch, spends its budget on curl, and
// reports the alert body back in longer words. These notes are the difference
// between that and a useful verdict. They encode where the answer for each rule
// has historically actually been.

const PLAYBOOK = {
  'newly-failing': `
FIRST, before reading any logs: GET /api/repo?name=<repo> and look at the
failure classes on recent jobs. This fleet records WHY a job failed, not just
that it failed, and the answer is usually not the code:
  - account-blocked  Actions refused to start the job (billing / spending limit).
                     The job never reached a runner. Nothing is wrong with the
                     repo, the workflow, or this machine. Over a recent 30-day
                     window this was the majority of all job failures here.
                     blame = "account". Do NOT file an issue against the repo:
                     one billing problem is not N repo bugs. Say so and stop.
  - account-quota    Storage/artifact quota. blame = "account".
  - runner-lost      Runner stopped talking to GitHub mid-job, typically CPU or
                     memory starvation on this host. Correlate with what else
                     was building at that timestamp. blame = "host".
  - no-runner        Nothing matched the required labels. Check /api/lint.
                     blame = "config".
  - job-failed       Only now is this plausibly the code. Read the failing step.
                     blame = "code".
Report the class explicitly. If the class is unknown because annotations
expired, say that rather than guessing.`,

  'stuck-queue': `
This is a capacity question, not an error. Establish, in order:
  1. GET /api/state — how many runners are registered for this repo, and how
     many are busy right now?
  2. GET /api/analytics?days=30 — the queue percentiles for this repo, and its
     typical run duration. A p95 queue far above the run duration means demand
     genuinely exceeds supply; a p95 queue near zero with one bad outlier does
     not.
  3. Does the workflow have jobs that can actually run in parallel, or are they
     chained with needs:? A second runner does nothing for a serial pipeline.
  4. Host headroom: this machine has 12 cores / 32 GB. Heavy builds already
     starve each other here, and runner-lost failures have been observed when
     several large builds overlap. More concurrency is not free.
Recommend a second runner only if queue time dominates AND the jobs are
parallel AND there is headroom. Otherwise say explicitly that waiting is the
correct behaviour, which is a valid and useful answer.`,

  'label-mismatch': `
Compare the runs-on labels demanded by the workflow against the labels actually
registered on the runners. GET /api/lint (which now checks every active branch,
not just the default one, so note WHICH ref is wrong) and GET /api/state for
registered labels. A mismatch on a non-default branch is a different and much
lower-severity problem than one on the branch that actually runs.`,

  orphan: `
Determine which side the runner exists on: registered with GitHub but absent
locally, or present locally but not registered. GET /api/state and compare
against the LaunchAgents in ~/Library/LaunchAgents. An orphan is usually a
half-finished registration or teardown; identify which, and name the single
command that would finish it. Do not run it.`,

  'no-listener': `
The runner is registered but its listener process is gone. Check whether the
LaunchAgent is loaded and what its last exit status was, and read the runner's
own _diag logs for the reason it stopped. Note whether this overlaps an
already-open launchd-dead or offline alert for the same runner, because autofix
repairs those and this alert may simply be the same fault seen from a different
angle — in which case say so and recommend no separate action.`,
};

function playbookFor(rule) {
  return PLAYBOOK[rule] ?? 'No specific playbook for this rule. Investigate from /api/state and /api/health.';
}

// ---------------------------------------------------------------------------

function buildPrompt(alert, context, verdictPath) {
  return `You are diagnosing one alert from a self-hosted GitHub Actions runner fleet.
The fleet's own auto-remediation daemon already looked at this alert and had no
mechanical repair for it, so it was handed to you. Your job is to find out what
is actually wrong and write it down for a human who is not going to read six
API endpoints themselves.

READ-ONLY. Do not repair anything, do not restart runners, do not cancel or
re-run workflow runs, do not edit or commit any file in the repository, and do
not POST to /api/action. Diagnosis only. If the fix needs doing, name it and
stop — a human or the autofix daemon will do it.

THE ALERT
  rule:      ${alert.rule}
  severity:  ${alert.severity ?? 'unknown'}
  key:       ${alert.key}
  title:     ${alert.title}
  body:      ${(alert.body ?? '').replace(/\n/g, ' / ')}
  opened:    ${new Date(alert.opened_at).toISOString()} (${Math.round((Date.now() - alert.opened_at) / 60000)} min ago)

WHERE TO LOOK FOR THIS RULE
${playbookFor(alert.rule)}

THE DASHBOARD
Running locally at ${CONFIG.fleetUrl}. Read it with curl. Endpoints:
  /api/state              current runners, repos, in-flight runs
  /api/health             per-runner health and drift
  /api/alerts             all open and recent alerts
  /api/repo?name=<repo>   per-repo detail INCLUDING per-job failure classes
  /api/history?repo=<repo>&limit=100
  /api/analytics?days=30  queue and duration percentiles, failure causes
  /api/lint               workflow static analysis, per branch
The dashboard source is in ${DASH} if you need to know what a field means.
The GitHub CLI (gh) is authenticated, so gh run view / gh api are available for
job logs and annotations.

CONTEXT ALREADY FETCHED FOR YOU
${JSON.stringify(context, null, 1).slice(0, 6000)}

WHAT TO PRODUCE
Investigate, then write your verdict as JSON to exactly this path:
  ${verdictPath}
with exactly these fields:
{
  "repo": "owner/name or null if this is not repo-specific",
  "headline": "one sentence, under 100 chars, what is wrong",
  "cause": "2-4 sentences of what you actually established, citing what you read",
  "blame": "code | host | account | config | unknown",
  "confidence": "high | medium | low",
  "recommendation": "the single next action for a human, or 'none' if none is needed",
  "transient": true if this looks self-resolving and needs no action, else false,
  "fileIssue": true if a GitHub issue on that repo is warranted, else false
}

Set confidence honestly. "low" is the right answer when annotations expired or
the evidence is thin, and it suppresses issue filing, which is the behaviour we
want. Set transient true for something already recovering. Set fileIssue false
for anything that is not the repo's fault — an account billing block or a host
capacity problem is not a bug in the code and must not become an issue on it.

Write the JSON file as your last action. Then reply with the headline only.`;
}

// ---------------------------------------------------------------------------

function parseVerdict(verdictPath, finalText) {
  // Preferred path: the agent wrote the file it was asked to write.
  if (existsSync(verdictPath)) {
    try {
      return { verdict: JSON.parse(readFileSync(verdictPath, 'utf8')), from: 'file' };
    } catch (e) {
      log(`verdict file present but unparseable: ${e.message}`);
    }
  }
  // Fallback: a fenced block in the reply. Worth having — losing an entire
  // investigation to a missing file write would be a silly way to fail.
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(finalText ?? '');
  if (fence) {
    try { return { verdict: JSON.parse(fence[1]), from: 'reply' }; } catch { /* fall through */ }
  }
  return { verdict: null, from: 'none' };
}

function reportMarkdown(alert, verdict, meta) {
  const v = verdict ?? {};
  return `# Fleet escalation: ${alert.rule}

**${v.headline ?? '(no headline produced)'}**

| | |
|---|---|
| Alert | \`${alert.key}\` |
| Rule | \`${alert.rule}\` (${alert.severity ?? '?'}) |
| Opened | ${new Date(alert.opened_at).toISOString()} |
| Repo | ${v.repo ?? '—'} |
| Blame | ${v.blame ?? 'unknown'} |
| Confidence | ${v.confidence ?? 'unknown'} |
| Transient | ${v.transient === true ? 'yes' : 'no'} |

## What was established

${v.cause ?? '_No verdict was produced. See the transcript below._'}

## Recommended next action

${v.recommendation ?? '_none given_'}

---
<!-- fleet-scope: ${meta.scope} -->
Diagnosed by \`autofix/escalate\` using ${meta.model} in ${Math.round(meta.elapsedMs / 1000)}s.
Agent \`${meta.agentId ?? '?'}\` run \`${meta.runId ?? '?'}\`. Verdict source: ${meta.verdictFrom}.
Alert body: ${(alert.body ?? '').replace(/\n/g, ' / ') || '—'}
`;
}

// A GitHub issue is a durable, assignable, deduplicable place for this, but only
// if it does not turn into noise. Two guards: the marker comment below scopes
// dedupe to the same underlying condition rather than the same alert instance
// (newly-failing keys carry a run id, so every failure is a fresh key and
// keying on that would file an issue per failing run), and a repo can opt out.
async function fileIssue(repo, scope, title, body) {
  if (CONFIG.noIssueRepos.includes(repo)) {
    log(`issue: ${repo} is opted out of automated issues`);
    return null;
  }
  const marker = `<!-- fleet-scope: ${scope} -->`;

  await sh('gh', ['label', 'create', ISSUE_LABEL, '--repo', repo,
    '--color', 'B60205', '--description', 'Opened by the fleet dashboard escalation path'],
    { timeout: 30_000 }); // already-exists is a failure here and is fine

  const existing = await sh('gh', ['issue', 'list', '--repo', repo, '--state', 'open',
    '--label', ISSUE_LABEL, '--limit', '50', '--json', 'number,body'], { timeout: 45_000 });

  if (existing.ok) {
    try {
      const match = JSON.parse(existing.stdout || '[]').find((i) => (i.body ?? '').includes(marker));
      if (match) {
        const c = await sh('gh', ['issue', 'comment', String(match.number), '--repo', repo,
          '--body', `Recurred.\n\n${body}`], { timeout: 45_000 });
        log(`issue: commented on ${repo}#${match.number} (${c.ok ? 'ok' : 'failed: ' + c.stderr.slice(0, 120)})`);
        return c.ok ? { number: match.number, action: 'commented' } : null;
      }
    } catch (e) {
      log(`issue: could not read existing issues (${e.message}) — not filing, to avoid a duplicate`);
      return null;
    }
  } else {
    log(`issue: list failed (${existing.stderr.slice(0, 160)}) — not filing, to avoid a duplicate`);
    return null;
  }

  const created = await sh('gh', ['issue', 'create', '--repo', repo,
    '--title', title.slice(0, 240), '--label', ISSUE_LABEL, '--body', body], { timeout: 60_000 });
  if (!created.ok) {
    log(`issue: create failed — ${created.stderr.slice(0, 200)}`);
    return null;
  }
  log(`issue: created ${created.stdout}`);
  return { url: created.stdout, action: 'created' };
}

// ---------------------------------------------------------------------------

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: run.mjs \'{"rule":"...","key":"...","title":"...","opened_at":0}\'');
    process.exit(64);
  }

  let alert;
  try {
    alert = JSON.parse(raw);
  } catch (e) {
    console.error(`alert argument is not valid JSON: ${e.message}`);
    process.exit(64);
  }
  if (!alert.rule || !alert.key) {
    console.error('alert needs at least { rule, key }');
    process.exit(64);
  }
  alert.opened_at ??= Date.now();

  // The scope is what dedupe and cooldown are keyed on: the CONDITION, not the
  // instance. `newfail:repo:workflow:12345` and the same failure on run 12346
  // are one problem, and treating them as two is how you file forty issues.
  const scope = alert.key.startsWith('newfail:')
    ? alert.key.split(':').slice(0, 3).join(':')
    : alert.key;

  mkdirSync(CONFIG.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = scope.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80);
  const reportPath = join(CONFIG.reportDir, `${stamp}-${slug}.md`);
  const verdictPath = join(CONFIG.reportDir, `.verdict-${stamp}-${slug}.json`);

  const context = {
    health: await getJson('/api/health'),
    alerts: await getJson('/api/alerts'),
  };

  // Dry run writes the prompt out rather than only measuring it. The playbook is
  // the part of this worth tuning, and tuning it blind is how you end up paying
  // for a run that asks the model to rediscover the dashboard.
  if (CONFIG.dryRun) {
    const prompt = buildPrompt(alert, context, verdictPath);
    const path = join(CONFIG.reportDir, `${stamp}-${slug}.prompt.txt`);
    writeFileSync(path, prompt);
    log(`DRY-RUN would escalate ${alert.key} (scope ${scope}) with model ${CONFIG.model}`);
    log(`DRY-RUN prompt is ${prompt.length} chars — written to ${path}`);
    process.exit(0);
  }

  const { Agent, CursorAgentError } = await import('@cursor/sdk');
  const apiKey = process.env.CURSOR_API_KEY;
  const started = Date.now();

  let agent = null;
  let finalText = '';
  let meta = { scope, model: CONFIG.model, verdictFrom: 'none' };

  try {
    agent = await Agent.create({
      apiKey,
      model: { id: CONFIG.model },
      // Explicit even though local is the default: an accidental cloud agent
      // here would be worse than useless, because it would run on a hosted VM
      // with no route to 127.0.0.1 and would confidently diagnose nothing.
      local: { cwd: DASH },
    });

    const run = await agent.send(buildPrompt(alert, context, verdictPath));
    meta.agentId = agent.agentId;
    meta.runId = run.id;
    // Logged before waiting: if the run hangs, these ids are the only handle.
    log(`escalating ${scope} — agent ${agent.agentId} run ${run.id}`);

    const timer = setTimeout(() => {
      log(`timeout after ${CONFIG.timeoutMs}ms — cancelling run ${run.id}`);
      if (run.supports('cancel')) run.cancel().catch(() => {});
    }, CONFIG.timeoutMs);

    let result;
    try {
      result = await run.wait();
    } finally {
      clearTimeout(timer);
    }

    finalText = typeof result?.result === 'string' ? result.result : '';
    meta.elapsedMs = Date.now() - started;

    // The run executed and failed. Distinct from the catch below, which means it
    // never started at all: different cause, different fix, different exit code.
    if (result?.status === 'error') {
      const msg = result.error?.message ?? 'no message given';
      log(`run ${run.id} finished with status=error — ${msg}`);
      writeFileSync(reportPath, reportMarkdown(alert, null, { ...meta, verdictFrom: `run-errored: ${msg}` }));

      // A missing or expired credential arrives HERE, as a run that started and
      // failed, rather than as a CursorAgentError. Agent.create does not
      // validate a local credential, so the rejection lands ~16s later inside
      // the run instead of at construction. Reporting that as an ordinary run
      // failure would hide it from the bridge's startup-failure breaker, which
      // is the one mechanism meant to notice a credential that stopped working
      // — the exact failure that went unnoticed for four days last time. So
      // auth-shaped run errors are reported as startup failures, because that
      // is what they actually are.
      if (/invalid user api key|unauthorized|authentication|api key|expired|401|403/i.test(msg)) {
        log('classified as a credential failure, not a diagnosis failure');
        await notify('Escalation credential rejected', msg.slice(0, 200));
        process.exit(1);
      }
      await notify(`Escalation failed: ${alert.rule}`, msg.slice(0, 200));
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof CursorAgentError) {
      log(`agent did not start: ${e.message} (retryable=${e.isRetryable})`);
      await notify(`Escalation could not start: ${alert.rule}`, e.message.slice(0, 200));
      process.exit(1);
    }
    throw e;
  } finally {
    if (agent) await agent[Symbol.asyncDispose]().catch(() => {});
  }

  meta.elapsedMs ??= Date.now() - started;
  const { verdict, from } = parseVerdict(verdictPath, finalText);
  meta.verdictFrom = from;
  if (existsSync(verdictPath)) rmSync(verdictPath, { force: true });

  const report = reportMarkdown(alert, verdict, meta);
  writeFileSync(reportPath, report);
  log(`report written to ${reportPath} (verdict from ${from})`);

  const headline = verdict?.headline ?? alert.title;
  await notify(`${alert.rule}: ${verdict?.blame ?? 'diagnosed'}`, headline);

  // Policy lives here, not in the model's answer. The agent can veto filing
  // with fileIssue:false, but it cannot force one: a low-confidence guess or a
  // problem that is not the repo's fault must not land in someone's tracker.
  const repo = typeof verdict?.repo === 'string' && verdict.repo.includes('/') ? verdict.repo : null;
  const shouldFile = Boolean(
    verdict
    && verdict.fileIssue !== false
    && repo
    && verdict.transient !== true
    && verdict.confidence !== 'low'
    && verdict.blame !== 'account',
  );

  if (shouldFile) {
    await fileIssue(repo, scope, `[fleet] ${headline}`, report);
  } else if (verdict) {
    log(`no issue filed: repo=${repo ?? 'none'} blame=${verdict.blame} `
      + `confidence=${verdict.confidence} transient=${verdict.transient} fileIssue=${verdict.fileIssue}`);
  } else {
    log('no issue filed: no verdict was produced');
  }

  process.exit(verdict ? 0 : 3);
}

main().catch((e) => {
  log(`escalation crashed: ${e?.stack ?? e}`);
  process.exit(70);
});
