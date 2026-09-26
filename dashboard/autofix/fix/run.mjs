#!/usr/bin/env node
// Cloud-agent fix: for code or config CI failures, launch a Cursor cloud agent
// that clones the repo at the failing SHA, diagnoses the failure, and opens a
// pull request with the fix.
//
//   fleetd alert  ──webhook──>  bridge  ──>  fix.sh ──>  here
//
// The split of concerns mirrors the escalation path:
//   escalation  READS the fleet and WRITES a diagnosis report.
//   fix         READS the failure and WRITES a PR on the target repo.
//
// Unlike escalation, the agent here operates on a CLOUD RUNTIME — a fresh VM
// with the failing repo cloned at the exact SHA. It can build, test, and push
// commits. This file enforces all the safety gates: event type, branch, PR
// label (when the failure is on a PR branch), and per-repo allowlisting. The
// bridge enforces daily caps and cooldowns.
//
// TRUST MODEL
// The candidate data comes from the local fleet DB, which in turn comes from
// the GitHub API. Branch names, commit messages, and actor fields are treated
// as untrusted text: they are never interpolated into shell commands or used
// to construct execution paths. They are included in the prompt only after
// being explicitly JSON.stringify'd or .slice()'d to a safe length.
//
// The cloud agent runs on a Cursor-hosted VM with no route to the local fleet
// dashboard. It has the repo cloned and the gh CLI authenticated; it can open
// PRs but cannot touch the runner infrastructure.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOFIX = dirname(HERE);
const DASH = dirname(AUTOFIX);

const CONFIG = {
  model: process.env.FIX_MODEL ?? 'composer-2.5',
  timeoutMs: Number(process.env.FIX_TIMEOUT_MS ?? 600_000),
  reportDir: join(DASH, 'logs', 'fixes'),
  dryRun: process.env.FIX_DRY_RUN === '1',
  // Repos listed here are a second layer of defence: fix.sh validates against
  // AUTOFIX_FIX_REPOS before calling this script. If both are set, the stricter
  // one wins. If this variable is absent, fix.sh's allowlist is the only gate.
  fixRepos: (process.env.AUTOFIX_FIX_REPOS ?? '').split(',').filter(Boolean),
  // When true, the agent is allowed to commit to the current PR branch rather
  // than creating a new one. Only applies to pull_request events where the PR
  // already has a fleet-autofix label.
  allowBranchUpdate: process.env.FIX_ALLOW_BRANCH_UPDATE !== '0',
  // Archive each cloud agent once it finishes so routine fleet activity does
  // not accumulate in the workspace agent list. Set to 0 to leave agents
  // active when you want to browse them in Cursor.
  archiveAgents: process.env.FIX_ARCHIVE_AGENTS !== '0',
};

function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(' ')}`);
}

// macOS notification — same pattern as escalate/run.mjs, arguments only.
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

// Check whether a GitHub PR has a specific label. Uses the gh CLI, which is
// already authenticated and available on the host.
async function prHasLabel(repo, prNumber, label) {
  const result = await sh('gh', [
    'api', `repos/${repo}/pulls/${prNumber}`,
    '--jq', '.labels[].name',
  ]);
  if (!result.ok) return false;
  return result.stdout.split('\n').map((s) => s.trim()).includes(label);
}

// Check whether a PR is from a fork (head repo != base repo). Fork PRs must
// not receive automated commits because the fork author can push arbitrary
// content to our branch.
async function prIsFromFork(repo, prNumber) {
  const result = await sh('gh', [
    'api', `repos/${repo}/pulls/${prNumber}`,
    '--jq', '.head.repo.full_name',
  ]);
  if (!result.ok) return true; // conservatively assume fork on failure
  const headRepo = result.stdout.trim();
  return headRepo !== repo;
}

// Build the agent prompt. All user-controlled text (branch names, SHA, actor,
// workflow path) is JSON-encoded before embedding so it cannot change the
// structure of the prompt. The prompt is deliberately concise: the agent has
// the full repo available and can explore further.
function buildPrompt(candidate, reportPath) {
  const jobLines = (candidate.jobs ?? [])
    .filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')
    .map((j) => `  - ${JSON.stringify(j.name)}: ${j.failureClass ?? 'unknown'}`
      + (j.failureDetail ? ` (${j.failureDetail.slice(0, 200)})` : ''))
    .join('\n');

  const failureClasses = [...new Set(
    (candidate.jobs ?? [])
      .filter((j) => j.failureClass)
      .map((j) => j.failureClass),
  )].join(', ');

  return `You are fixing a GitHub Actions CI failure. A self-hosted runner fleet \
detected that this workflow failed and chose to attempt an automated fix.

FAILED RUN
  repo:         ${JSON.stringify(candidate.repo)}
  workflow:     ${JSON.stringify(candidate.workflowName)}
  workflow file: ${JSON.stringify(candidate.workflowPath ?? '(unknown)')}
  branch:       ${JSON.stringify(candidate.branch)}
  sha:          ${JSON.stringify(candidate.sha)}
  event:        ${JSON.stringify(candidate.event)}
  run url:      ${JSON.stringify(candidate.url)}
  failure type: ${failureClasses}

FAILED JOBS
${jobLines || '  (no classified jobs — check the workflow YAML for syntax issues)'}

YOUR TASK
1. Read the workflow file at ${JSON.stringify(candidate.workflowPath ?? '.github/workflows/')}.
2. Understand what the failing step does and why it might have failed.
3. Reproduce the failure locally if the required tools are available (build, test, lint).
4. Apply the minimal change that fixes the root cause. Prefer fixing the code \
over disabling or skipping the failing step.
5. Verify the fix by running the failing command before committing.
6. If the workflow tests exist, run them to confirm no regressions.

CONSTRAINTS
- Make only the changes necessary to fix this specific failure.
- Do not merge the pull request. Leave it for human review.
- If the failure is not fixable (external dependency, quota issue, race \
condition), explain that in a comment and do not push anything.
- Do not include credentials, tokens, or secrets in any committed file.
- Write a clear, one-line PR title starting with "fix:".

OUTCOME
Write your final verdict as JSON to exactly this path:
  ${JSON.stringify(reportPath)}
with exactly these fields:
{
  "fixed": true if a commit/PR was created, else false,
  "headline": "one sentence under 100 chars summarising what was fixed (or why not)",
  "prUrl": "the PR URL if one was created, else null",
  "confidence": "high | medium | low",
  "notFixable": true if the failure cannot be fixed by code changes, else false
}

Write the JSON file as your last action. Then reply with the headline only.`;
}

// ---------------------------------------------------------------------------

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: run.mjs \'{"repo":"...","runId":0,...}\'');
    process.exit(64);
  }

  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch (e) {
    console.error(`candidate argument is not valid JSON: ${e.message}`);
    process.exit(64);
  }

  if (!candidate.repo || !candidate.runId) {
    console.error('candidate needs at least { repo, runId }');
    process.exit(64);
  }

  // Second-layer allowlist check (fix.sh is the primary gate).
  if (CONFIG.fixRepos.length && !CONFIG.fixRepos.includes(candidate.repo)) {
    console.error(`${candidate.repo} is not in the fix allowlist`);
    process.exit(77);
  }

  // For pull_request events: verify this is not a fork PR and check for the
  // fleet-autofix label before committing to the branch.
  let useExistingPr = false;
  if (candidate.event === 'pull_request' && candidate.prNumber) {
    const isFork = await prIsFromFork(candidate.repo, candidate.prNumber);
    if (isFork) {
      log(`skip: ${candidate.repo}#${candidate.prNumber} is a fork PR — not pushing to fork branches`);
      process.exit(0);
    }
    if (CONFIG.allowBranchUpdate) {
      useExistingPr = await prHasLabel(candidate.repo, candidate.prNumber, 'fleet-autofix');
      if (!useExistingPr) {
        log(`skip: ${candidate.repo}#${candidate.prNumber} lacks the fleet-autofix label — not pushing to this PR`);
        process.exit(0);
      }
    }
  }

  mkdirSync(CONFIG.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = `${candidate.repo.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)}_${candidate.runId}`;
  const reportPath = join(CONFIG.reportDir, `.verdict-${stamp}-${slug}.json`);
  const logPath = join(CONFIG.reportDir, `${stamp}-${slug}.md`);

  if (CONFIG.dryRun) {
    const prompt = buildPrompt(candidate, reportPath);
    const promptPath = join(CONFIG.reportDir, `${stamp}-${slug}.prompt.txt`);
    writeFileSync(promptPath, prompt);
    log(`DRY-RUN: fix candidate ${candidate.repo} run ${candidate.runId} (${candidate.event})`);
    log(`DRY-RUN: prompt written to ${promptPath} (${prompt.length} chars)`);
    process.exit(0);
  }

  const { Agent, CursorAgentError } = await import('@cursor/sdk');
  const apiKey = process.env.CURSOR_API_KEY;
  const started = Date.now();

  const repoUrl = `https://github.com/${candidate.repo}`;
  const startingRef = candidate.sha ?? candidate.branch ?? candidate.defaultBranch ?? 'main';

  // Cloud configuration differs by event type:
  //   push / dispatch / schedule → create a new branch and PR
  //   pull_request (same-repo, has fleet-autofix label) → update the PR branch
  const cloudConfig = useExistingPr
    ? {
        repos: [{
          url: repoUrl,
          prUrl: `https://github.com/${candidate.repo}/pull/${candidate.prNumber}`,
        }],
        workOnCurrentBranch: true,
        skipReviewerRequest: true,
      }
    : {
        repos: [{ url: repoUrl, startingRef }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      };

  let agent = null;
  let released = false;
  let finalText = '';
  let verdict = null;
  let meta = { model: CONFIG.model };

  // Drop the local handle, then archive the cloud agent. Archiving is not
  // deletion: the agent ID logged below still resolves through Agent.get(id)
  // and Agent.list({ includeArchived: true }), and any PR it opened is
  // untouched. Archiving only takes it out of the default agent list.
  //
  // process.exit() terminates without running pending finally blocks, so
  // every exit path below calls release() rather than relying on the finally.
  const release = async () => {
    if (released || !agent) return;
    released = true;
    const id = agent.agentId;
    await agent[Symbol.asyncDispose]().catch(() => {});
    // Agent.archive routes by ID prefix; only bc- IDs are cloud agents.
    if (!CONFIG.archiveAgents || !id?.startsWith('bc-')) return;
    try {
      await Agent.archive(id, { apiKey });
      log(`archived agent ${id}`);
    } catch (e) {
      log(`could not archive agent ${id}: ${e?.message ?? e}`);
    }
  };

  const finish = async (code) => {
    await release();
    process.exit(code);
  };

  try {
    agent = await Agent.create({
      apiKey,
      model: { id: CONFIG.model },
      cloud: cloudConfig,
    });

    const run = await agent.send(buildPrompt(candidate, reportPath));
    meta.agentId = agent.agentId;
    meta.runId = run.id;
    log(`fixing ${candidate.repo} run ${candidate.runId} — agent ${agent.agentId} run ${run.id}`);

    const timer = setTimeout(() => {
      log(`timeout after ${CONFIG.timeoutMs}ms — cancelling fix run ${run.id}`);
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
    meta.status = result?.status;

    if (result?.status === 'error') {
      const msg = result.error?.message ?? 'no message given';
      log(`fix run ${run.id} finished with status=error — ${msg}`);

      // Auth-shaped errors indicate a credential problem, not a code fix failure.
      if (/invalid user api key|unauthorized|authentication|api key|expired|401|403/i.test(msg)) {
        log('classified as a credential failure');
        await notify('Fix credential rejected', msg.slice(0, 200));
        await finish(1);
      }
      await notify(`Fix agent failed: ${candidate.repo}`, msg.slice(0, 200));
      await finish(2);
    }
  } catch (e) {
    if (e instanceof CursorAgentError) {
      log(`fix agent did not start: ${e.message} (retryable=${e.isRetryable})`);
      await notify(`Fix could not start: ${candidate.repo}`, e.message.slice(0, 200));
      await finish(1);
    }
    throw e;
  } finally {
    await release();
  }

  meta.elapsedMs ??= Date.now() - started;

  // Parse the verdict file the agent was instructed to write.
  if (existsSync(reportPath)) {
    try {
      verdict = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (e) {
      log(`verdict file present but unparseable: ${e.message}`);
    }
  }
  // Fallback: try to parse a JSON block from the final reply.
  if (!verdict) {
    const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(finalText ?? '');
    if (fence) {
      try { verdict = JSON.parse(fence[1]); } catch { /* fall through */ }
    }
  }

  const report = [
    `# Fleet fix: ${candidate.repo}`,
    '',
    `**${verdict?.headline ?? finalText?.slice(0, 200) ?? '(no headline)'}**`,
    '',
    `| | |`,
    `|---|---|`,
    `| Repo | ${candidate.repo} |`,
    `| Run | [${candidate.runId}](${candidate.url ?? ''}) attempt ${candidate.runAttempt ?? 1} |`,
    `| Workflow | ${candidate.workflowName ?? '?'} on \`${candidate.branch ?? '?'}\` |`,
    `| Fixed | ${verdict?.fixed === true ? 'yes' : 'no'} |`,
    `| PR | ${verdict?.prUrl ?? '—'} |`,
    `| Confidence | ${verdict?.confidence ?? '?'} |`,
    '',
    `Diagnosed by \`autofix/fix\` using ${meta.model} in ${Math.round((meta.elapsedMs ?? 0) / 1000)}s.`,
    `Agent \`${meta.agentId ?? '?'}\` run \`${meta.runId ?? '?'}\`.`,
  ].join('\n');

  writeFileSync(logPath, report);
  log(`fix report written to ${logPath}`);

  const headline = verdict?.headline ?? `fix attempt for ${candidate.repo} run ${candidate.runId}`;
  const notifBody = verdict?.prUrl ? `PR: ${verdict.prUrl}` : (verdict?.fixed === false ? 'no fix applied' : 'see logs');
  await notify(`Fix: ${candidate.repo}`, `${headline.slice(0, 180)} — ${notifBody.slice(0, 180)}`);

  process.exit(verdict ? 0 : 3);
}

main().catch((e) => {
  log(`fix crashed: ${e?.stack ?? e}`);
  process.exit(70);
});
