// Static analysis over the workflow files, checking for the failure modes this
// fleet has already hit. Every rule here corresponds to something that actually
// went wrong, not to a general style preference.

import { parseYaml } from './yaml.js';

// Labels every self-hosted runner reports for free, plus the GitHub-hosted image
// names. A job whose runs-on names a hosted image is not our problem to match.
const HOSTED_RE = /^(ubuntu|macos|windows)-/i;

const norm = (s) => String(s).trim().toLowerCase();

const PW_INSTALL_RE = /\bplaywright\s+install\b|\bnpx\s+playwright\s+install\b|\byarn\s+playwright\s+install\b|\bpnpm\s+(exec\s+)?playwright\s+install\b/;
const PW_TEST_RE = /\bplaywright\s+test\b|\bnpx\s+playwright\s+test\b|\byarn\s+playwright\s+test\b|\bpnpm\s+(exec\s+)?playwright\s+test\b|@playwright\/test/;

function stepText(step) {
  if (!step || typeof step !== 'object') return '';
  const parts = [];
  if (step.run) parts.push(String(step.run));
  if (step.uses) parts.push(String(step.uses));
  if (step.with && typeof step.with === 'object') parts.push(JSON.stringify(step.with));
  return parts.join('\n');
}

function envSetsPlaywrightPath(job) {
  const check = (block) => {
    if (!block || typeof block !== 'object') return false;
    for (const [k, v] of Object.entries(block)) {
      if (norm(k) !== 'playwright_browsers_path') continue;
      const s = String(v).toLowerCase();
      if (s.includes('runner.tool_cache') || s.includes('runner_temp')) return true;
    }
    return false;
  };
  for (const step of job.steps ?? []) {
    if (check(step?.env)) return true;
    const run = String(step?.run ?? '').toLowerCase();
    if (
      run.includes('playwright_browsers_path') &&
      run.includes('runner_tool_cache') &&
      run.includes('github_env')
    ) return true;
  }
  return false;
}

function jobUsesPlaywright(job) {
  for (const step of job.steps ?? []) {
    const t = stepText(step).toLowerCase();
    if (PW_INSTALL_RE.test(t) || PW_TEST_RE.test(t)) return true;
    if (step.uses && /playwright/.test(String(step.uses).toLowerCase())) return true;
  }
  return false;
}

function jobRunsPlaywrightTests(job) {
  for (const step of job.steps ?? []) {
    const t = stepText(step).toLowerCase();
    if (PW_TEST_RE.test(t)) return true;
    if (step.uses && /playwright.*test|test.*playwright/.test(String(step.uses).toLowerCase())) return true;
  }
  return false;
}

function hasPlaywrightInstallWithoutTimeout(job) {
  for (const step of job.steps ?? []) {
    const t = stepText(step);
    if (!PW_INSTALL_RE.test(t)) continue;
    if (step['timeout-minutes'] != null) continue;
    if (step.uses && /playwright/.test(String(step.uses).toLowerCase())) continue;
    return true;
  }
  return false;
}

function hasFailureArtifacts(job) {
  for (const step of job.steps ?? []) {
    if (!step?.uses || !String(step.uses).includes('upload-artifact')) continue;
    const cond = String(step.if ?? '').toLowerCase();
    if (cond && !cond.includes('failure') && !cond.includes('always')) continue;
    const blob = stepText(step).toLowerCase();
    if (/test-results|playwright-report|trace|blob-report|screenshot|\.zip/.test(blob)) return true;
  }
  return false;
}

function runsOnLabels(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  // A `runs-on: { group: …, labels: […] }` form, or anything else structured.
  if (typeof value === 'object') {
    if (Array.isArray(value.labels)) return value.labels.map(String);
    return null;
  }
  return null;
}

export function lintWorkflow({ repo, path, name, content, runnerLabelSets, fleetLabelSets }) {
  const findings = [];
  const { doc, warnings, partial } = parseYaml(content);
  const wf = name ?? doc?.name ?? path;

  const add = (rule, severity, job, message, hint) =>
    findings.push({ repo, path, workflow: wf, rule, severity, job: job ?? null, message, hint });

  if (partial) {
    add('unparsed', 'info', null,
      `Only partly readable: ${warnings[0]}`,
      'The rules below skipped anything they could not confidently read in this file.');
  }

  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== 'object') {
    if (!partial) {
      add('unparsed', 'info', null, 'No jobs block found', 'Reusable workflow, or a shape this parser does not read.');
    }
    return findings;
  }

  // `on:` is a YAML 1.1 boolean, so a strict parser hands back the key `true`.
  const triggers = doc.on ?? doc.true ?? doc[true] ?? null;
  const triggerNames = triggers && typeof triggers === 'object' && !Array.isArray(triggers)
    ? Object.keys(triggers)
    : Array.isArray(triggers) ? triggers.map(String) : triggers ? [String(triggers)] : [];
  const onPullRequest = triggerNames.some((t) => norm(t).startsWith('pull_request'));

  // A workflow whose only trigger is workflow_call never runs in its own repo:
  // it is called by another repo and executes in the CALLER's context, on the
  // caller's runners. Judging it against its own repo's runners reports "no
  // runner is registered here", which is true and beside the point. Its labels
  // still have to exist somewhere in the fleet, so it is checked against every
  // runner instead.
  const reusable = triggerNames.length > 0 && triggerNames.every((t) => norm(t) === 'workflow_call');

  const cancel = doc.concurrency && typeof doc.concurrency === 'object'
    ? doc.concurrency['cancel-in-progress']
    : null;

  if (onPullRequest && cancel !== true && !reusable) {
    add('no-cancel-in-progress', 'warning', null,
      doc.concurrency
        ? 'Runs on pull_request with a concurrency group but cancel-in-progress is not true'
        : 'Runs on pull_request with no concurrency group',
      'Each push to a PR starts another run while the previous one is still going. With one runner ' +
        'per repo they queue behind each other, so the newest change waits on results nobody wants.');
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;

    // A job that calls a reusable workflow has no runs-on of its own; the
    // called workflow owns that decision.
    if (job.uses) continue;

    const labels = runsOnLabels(job['runs-on']);
    if (labels == null) {
      add('unparsed', 'info', jobName, 'Could not read runs-on for this job',
        'Skipped rather than guessed.');
      continue;
    }

    const lowered = labels.map(norm);
    const dynamic = labels.some((l) => String(l).includes('${{'));
    const selfHosted = lowered.includes('self-hosted');
    const hostedImage = labels.find((l) => HOSTED_RE.test(String(l)) && !String(l).includes('${{'));

    if (dynamic) {
      add('unparsed', 'info', jobName,
        `runs-on contains an expression (${labels.join(', ')})`,
        'Its value depends on the run, so label matching is skipped for this job.');
    }

    // The big one. GitHub's 6-hour default only ever applied to hosted runners;
    // a self-hosted job has no timeout at all. With one runner per repo, a hung
    // job holds that runner and every later run queues behind it indefinitely.
    if (selfHosted && job['timeout-minutes'] == null) {
      add('no-timeout', 'serious', jobName,
        'Self-hosted job with no timeout-minutes',
        'A hung job holds its runner forever and every later run for this repo queues behind it. ' +
          "GitHub's 6-hour default does not apply to self-hosted runners.");
    }

    // macOS on GitHub-hosted bills at 10x against the included allowance. That
    // multiplier is what took Actions down account-wide and created this fleet.
    if (hostedImage && /^macos-/i.test(hostedImage)) {
      add('hosted-macos', 'warning', jobName,
        `Runs on GitHub-hosted ${hostedImage}`,
        'Hosted macOS bills at 10x against the included allowance on private repos. Exhausting it ' +
          'once blocked Actions account-wide, including the cheap Ubuntu jobs in unrelated repos.');
    }

    // Does any runner registered for this repo satisfy the whole label set?
    // GitHub requires a runner to carry every label in runs-on, so this is a
    // subset test, not a per-label one.
    if (selfHosted && !dynamic) {
      const candidates = reusable ? (fleetLabelSets ?? []) : (runnerLabelSets ?? []);
      const scope = reusable ? 'the fleet' : repo;
      if (candidates.length === 0) {
        add('unserved', 'critical', jobName,
          reusable
            ? 'No runners exist anywhere in the fleet'
            : `No runner is registered for ${repo} at all`,
          'This job will queue until it is cancelled. Register a runner, or move the job to a hosted one.');
      } else {
        const wanted = lowered;
        const match = candidates.some((set) => wanted.every((l) => set.labels.includes(l)));
        if (!match) {
          const everLabel = new Set(candidates.flatMap((s) => s.labels));
          const missing = wanted.filter((l) => !everLabel.has(l));
          add('unmatched-label', 'critical', jobName,
            `No runner matches runs-on: [${labels.join(', ')}]`,
            missing.length
              ? `No runner in ${scope} carries ${missing.map((m) => `\`${m}\``).join(', ')}. ` +
                'Jobs matching this will queue until cancelled — this is exactly how the abandoned ' +
                '`ollama` label produced runs that sat for 24 hours and were killed.'
              : 'Every label exists on some runner, but no single runner carries all of them at once.');
        }
      }
    }

    if (selfHosted && !dynamic && jobUsesPlaywright(job)) {
      if (!envSetsPlaywrightPath(job)) {
        add('playwright-shared-cache', 'warning', jobName,
          'Playwright job without per-runner PLAYWRIGHT_BROWSERS_PATH',
          'Multiple runners on one Mac sharing ~/Library/Caches/ms-playwright contend on __dirlock ' +
            'during browser install. In a step, append PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TOOL_CACHE/ms-playwright ' +
            'to $GITHUB_ENV before installing browsers.');
      }
      if (hasPlaywrightInstallWithoutTimeout(job)) {
        add('playwright-install-timeout', 'serious', jobName,
          'playwright install step has no timeout-minutes',
          'A hung browser download holds the runner until the job timeout. Give the install step ' +
            'timeout-minutes: 15 (or use an action that sets one).');
      }
      if (jobRunsPlaywrightTests(job) && !hasFailureArtifacts(job)) {
        add('playwright-no-failure-artifacts', 'warning', jobName,
          'Playwright tests with no failure artifact upload',
          'Failed UI tests are hard to debug from logs alone. Upload playwright-report/, test-results/, ' +
            'or traces with actions/upload-artifact on failure().');
      }
      // Blob reporter is needed for merge-reports to work in a matrix workflow.
      if (jobRunsPlaywrightTests(job)) {
        const steps = job.steps ?? [];
        const hasBlob = steps.some((s) => {
          const t = stepText(s).toLowerCase();
          return t.includes('blob') && t.includes('reporter');
        });
        if (!hasBlob) {
          add('playwright-no-blob-reporter', 'info', jobName,
            'No blob reporter detected in Playwright steps',
            'The matrix merge-reports job needs blob reports. Add reporter: [[\'blob\']] for CI in playwright.config.');
        }
      }
    }
  }

  return findings;
}

// Each file arrives once per ref that actually runs it, so the same finding can
// be produced several times for one workflow. Reporting it per ref would triple
// the screen for a repo whose branches agree, which is most of them — so
// identical findings are collapsed and carry the list of refs they apply to.
//
// The refs are the point, not decoration. A finding on every ref is a workflow
// problem; a finding on one ref is a *branch* problem, and the fix is usually to
// bring that branch level rather than to edit the file. That distinction is
// invisible when you only ever read the default branch.
export function lintAll({ files, runnersByRepo }) {
  const grouped = new Map();
  const fleetLabelSets = [...runnersByRepo.values()].flat();

  const record = (finding, ref, isDefault) => {
    // Deliberately excludes the ref: two refs producing the same finding is the
    // case being collapsed.
    const key = JSON.stringify([finding.repo, finding.path, finding.rule, finding.job ?? null,
      finding.message]);
    const prior = grouped.get(key);
    if (prior) {
      if (!prior.refs.includes(ref)) prior.refs.push(ref);
      if (isDefault) prior.onDefault = true;
      return;
    }
    grouped.set(key, { ...finding, refs: [ref], onDefault: Boolean(isDefault) });
  };

  for (const f of files) {
    const ref = f.ref && f.ref !== '__default__' ? f.ref : '(default)';
    const isDefault = Boolean(f.is_default) || f.ref === '__default__';
    try {
      for (const finding of lintWorkflow({
        repo: f.repo,
        path: f.path,
        name: f.name,
        content: f.content,
        runnerLabelSets: runnersByRepo.get(f.repo) ?? [],
        fleetLabelSets,
      })) record(finding, ref, isDefault);
    } catch (err) {
      record({
        repo: f.repo, path: f.path, workflow: f.name ?? f.path, rule: 'lint-error',
        severity: 'info', job: null, message: `Lint failed: ${err.message}`,
        hint: 'This is a bug in the linter, not in the workflow.',
      }, ref, isDefault);
    }
  }

  // How many refs of this workflow were linted at all, so the UI can say "on
  // develop only" rather than just "on develop" — which reads as if no other
  // branch was checked.
  const refsPerFile = new Map();
  for (const f of files) {
    const k = `${f.repo}\n${f.path}`;
    const ref = f.ref && f.ref !== '__default__' ? f.ref : '(default)';
    if (!refsPerFile.has(k)) refsPerFile.set(k, new Set());
    refsPerFile.get(k).add(ref);
  }

  const order = { critical: 0, serious: 1, warning: 2, info: 3 };
  return [...grouped.values()]
    .map((f) => ({
      ...f,
      refs: f.refs.sort(),
      refsChecked: [...(refsPerFile.get(`${f.repo}\n${f.path}`) ?? [])].sort(),
    }))
    .sort((a, b) =>
      (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.repo.localeCompare(b.repo));
}
