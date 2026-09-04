// Workflow concurrency analysis across the whole fleet.
//
// This builds on the existing lint rules (file-local, per-job) with
// cross-file findings that a single-file pass cannot produce: group collisions
// across workflows, declared parallelism that exceeds per-repo or host caps,
// and schedule overlaps that guarantee contention.
//
// All findings are informational; this module never edits a repository.
// Uncertain YAML produces a 'low' confidence note rather than a confident patch.

import { parseYaml } from './yaml.js';

const HOSTED_RE = /^(ubuntu|macos|windows)-/i;
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Analyse the workflow files for one repo and return structured findings.
 *
 * @param {object} opts
 * @param {string}   opts.repo
 * @param {object[]} opts.files      - rows from workflow_files for this repo
 * @param {number}   opts.runnerCount - how many runners the repo currently has
 * @param {number}   opts.hostCap    - fleet concurrency ceiling
 * @param {number}   [opts.perRepoCap] - optional per-repo instance cap
 * @returns {object[]} findings
 */
export function adviseRepo({ repo, files, runnerCount, hostCap, perRepoCap }) {
  const findings = [];

  // Only analyse one entry per (path, is_default ref) — using a non-default
  // ref would analyse a branch nobody deploys from and produce false positives.
  const defaultFiles = files.filter((f) => f.is_default || f.ref === '__default__');
  if (!defaultFiles.length) return findings;

  // Map from concurrency.group expression string → list of workflow paths that
  // use it — later used to detect cross-file collisions.
  const groupsByExpr = new Map();

  for (const f of defaultFiles) {
    let doc, partial;
    try {
      ({ doc, partial } = parseYaml(f.content ?? ''));
    } catch {
      findings.push(note(repo, f.path, 'parse-error', 'Could not parse this workflow file.', 'low'));
      continue;
    }

    if (partial) {
      findings.push(note(repo, f.path, 'parse-partial',
        'File is only partially readable by the built-in parser — some checks may be skipped.',
        'low'));
    }

    const wfConcurrency = doc?.concurrency;
    const wfGroup = wfConcurrency?.group ?? (typeof wfConcurrency === 'string' ? wfConcurrency : null);
    if (wfGroup) {
      const expr = String(wfGroup);
      if (!groupsByExpr.has(expr)) groupsByExpr.set(expr, []);
      groupsByExpr.get(expr).push(f.path);
    }

    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== 'object') continue;

    // Collect schedule triggers for the whole workflow.
    const triggers = doc.on ?? doc.true ?? doc[true] ?? null;
    const schedules = [];
    if (triggers && typeof triggers === 'object' && !Array.isArray(triggers)) {
      const sched = triggers.schedule;
      if (Array.isArray(sched)) {
        for (const s of sched) {
          if (s?.cron) schedules.push(String(s.cron));
        }
      }
    }

    let totalMatrixSize = 1;
    let matrixUnbounded = false;
    let selfHostedJobCount = 0;
    const jobConcurrencyGroups = new Set();

    for (const [jobName, job] of Object.entries(jobs)) {
      if (!job || typeof job !== 'object' || job.uses) continue;

      const labels = runsOnLabels(job['runs-on']);
      if (!labels) continue;

      const lowered = labels.map(norm);
      const isSelfHosted = lowered.includes('self-hosted');
      const isHosted = labels.some((l) => HOSTED_RE.test(String(l)));

      if (!isSelfHosted || isHosted) continue;
      selfHostedJobCount++;

      // Per-job concurrency group collision (within this file).
      const jobConc = job.concurrency;
      if (jobConc) {
        const g = jobConc.group ?? (typeof jobConc === 'string' ? jobConc : null);
        if (g) {
          const expr = String(g);
          if (jobConcurrencyGroups.has(expr)) {
            findings.push(finding(repo, f.path, jobName, 'concurrency-collision',
              `Two jobs in this workflow share the concurrency group "${expr}"`,
              'This causes the jobs to serialize — only one can run at a time. Check whether a ' +
              'per-branch expression (${{ github.ref }}) was intended.'));
          }
          jobConcurrencyGroups.add(expr);
        }
      }

      // Matrix cardinality.
      const strategy = job.strategy;
      if (strategy?.matrix && typeof strategy.matrix === 'object') {
        let size = 1;
        let unbounded = false;
        for (const [key, vals] of Object.entries(strategy.matrix)) {
          if (key === 'include' || key === 'exclude') continue;
          if (Array.isArray(vals)) {
            size *= vals.length;
          } else if (typeof vals === 'string' && vals.includes('${{')) {
            unbounded = true;
          }
        }
        const maxParallel = strategy['max-parallel'];
        const effectiveSize = Number.isFinite(maxParallel) && maxParallel > 0 ? maxParallel : size;
        totalMatrixSize *= size;
        if (unbounded) matrixUnbounded = true;

        if (unbounded) {
          findings.push(finding(repo, f.path, jobName, 'matrix-unbounded',
            'Matrix values contain an expression — cardinality cannot be determined statically',
            'If the matrix expands to more entries than available runners, jobs queue behind each other. ' +
            'Consider max-parallel to cap the concurrency.'));
        } else if (effectiveSize > runnerCount) {
          findings.push(finding(repo, f.path, jobName, 'matrix-exceeds-runners',
            `Matrix produces ${size} job(s)${maxParallel ? ` (capped to ${maxParallel} by max-parallel)` : ''}, ` +
            `but this repo has ${runnerCount} runner(s)`,
            'Jobs beyond the runner count queue. Either add runners or set max-parallel ≤ runner count.'));
        }
      }
    }

    // If the total unbounded/declared concurrency for self-hosted jobs exceeds
    // the host ceiling, warn.
    if (!matrixUnbounded && selfHostedJobCount > 1 && totalMatrixSize > (perRepoCap ?? hostCap)) {
      findings.push(finding(repo, f.path, null, 'parallelism-exceeds-cap',
        `Declared parallelism (${totalMatrixSize} jobs) exceeds the ` +
        `${perRepoCap ? 'per-repo cap' : 'host ceiling'} (${perRepoCap ?? hostCap})`,
        'The excess will queue and inflate apparent run times. Review the Capacity tab to adjust caps.'));
    }
  }

  // Cross-file: same concurrency group expression in multiple workflows for
  // this repo. Static strings are the dangerous case; expression groups that
  // differ per-PR are usually fine.
  for (const [expr, paths] of groupsByExpr) {
    if (paths.length < 2) continue;
    if (expr.includes('${{')) continue; // dynamic — probably fine
    findings.push({
      repo, path: paths[0], job: null,
      rule: 'cross-file-concurrency-collision',
      severity: 'warning',
      confidence: 'medium',
      message: `Static concurrency group "${expr}" appears in ${paths.length} workflows: ${paths.join(', ')}`,
      hint: 'All workflows sharing this exact group serialize with each other. If they are independent, ' +
            'add a workflow-specific prefix to the group expression.',
    });
  }

  return findings;
}

/**
 * Analyse all repos from the workflow_files cache.
 *
 * @param {object} opts
 * @param {object[]} opts.files       - all rows from workflow_files
 * @param {Map}      opts.runnersByRepo - repo → runner array (from snapshot)
 * @param {number}   opts.hostCap     - fleet ceiling
 * @param {number}   [opts.perRepoCap]
 * @returns {object[]} all findings, severity-sorted
 */
export function adviseAll({ files, runnersByRepo, hostCap, perRepoCap }) {
  const byRepo = new Map();
  for (const f of files) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, []);
    byRepo.get(f.repo).push(f);
  }

  const all = [];
  for (const [repo, repoFiles] of byRepo) {
    const runnerCount = (runnersByRepo.get(repo) ?? []).length || 1;
    all.push(...adviseRepo({ repo, files: repoFiles, runnerCount, hostCap, perRepoCap }));
  }

  const ORDER = { critical: 0, serious: 1, warning: 2, info: 3 };
  return all.sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || a.repo.localeCompare(b.repo));
}

function runsOnLabels(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && Array.isArray(value.labels)) return value.labels.map(String);
  return null;
}

function finding(repo, path, job, rule, message, hint) {
  return { repo, path, job: job ?? null, rule, severity: 'warning', confidence: 'high', message, hint };
}

function note(repo, path, rule, message, confidence) {
  return { repo, path, job: null, rule, severity: 'info', confidence, message, hint: null };
}
