// The control plane.
//
// Two rules govern everything in this file, and neither is negotiable:
//
// 1. NO SHELL. Every local action is execFile with an argv array — never a
//    string handed to `sh -c`. There is no interpolation point, so a runner
//    name containing `; rm -rf ~` is a name that fails to match a known runner,
//    not a command.
//
// 2. NO FREE-FORM COMMANDS. The registry below is the complete set of things
//    this daemon can do. There is no "run arbitrary script" action and there is
//    no path by which the HTTP layer can name a binary. Arguments are validated
//    against entities the daemon already knows about — a runner name must be a
//    runner it discovered, a repo must be one it polls.
//
// The actions themselves are the existing scripts. That is deliberate: they
// encode detail this file should not duplicate (the launchd label derivation,
// the UTF-8 BOM in .runner, the same-label rule for a second runner). The
// dashboard is a face on them, not a second implementation.

import { execFile } from 'node:child_process';
import { headroom } from './capacity.js';

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const LABEL_RE = /^[A-Za-z0-9._-]{1,40}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,120}$/;

class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Runs a command with no shell, a hard timeout, and a bounded buffer. Returns
// the combined output rather than throwing on a non-zero exit: a script that
// exits 1 to mean "something is unhealthy" is reporting, not failing, and the
// caller wants to read what it said.
// `okCodes` exists because some of these scripts use the exit status to report a
// FINDING, not a failure. health.sh exits 1 when any runner is unhealthy — even
// when --repair then fixed it — so treating non-zero as failure reports a
// successful repair as "Failed" in red. preflight.sh is the same shape.
function run(file, args, { cwd, timeout = 120000, env, okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err?.code ?? 0;
        resolve({
          code,
          ok: okCodes.includes(code),
          killed: Boolean(err?.killed),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          output: [stdout, stderr].filter(Boolean).join('\n').trimEnd(),
          command: `${file} ${args.join(' ')}`,
        });
      }
    );
  });
}

export function buildActions({ root, gh, getSnapshot, getLimits = () => ({}) }) {
  const knownRunner = (name) => {
    const r = getSnapshot().runners.find((x) => x.name === name);
    if (!r) throw new ActionError(`unknown runner: ${name}`, 404);
    return r;
  };

  const knownRepo = (repo) => {
    if (!REPO_RE.test(repo ?? '')) throw new ActionError('malformed repo');
    const snap = getSnapshot();
    const known =
      snap.runners.some((r) => r.repo === repo) ||
      (snap.repos ?? []).some((r) => r.fullName === repo);
    if (!known) throw new ActionError(`repo not known to this daemon: ${repo}`, 404);
    return repo;
  };

  const intArg = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ActionError(`${name} must be a positive integer`);
    return n;
  };

  // Everything a duplicate needs, worked out from the runner you clicked: which
  // repo, which instance number is free, and which labels the new one must carry.
  //
  // Labels are copied from the LOWEST-numbered sibling rather than taken as an
  // argument, because a second runner whose labels do not match the first never
  // matches the same `runs-on:` and sits idle forever while the first one queues
  // — which looks exactly like the problem it was added to fix. The fleet has
  // already made that mistake once. Copying removes the chance to repeat it.
  function duplicatePlan(name) {
    const target = knownRunner(name);
    const siblings = getSnapshot().runners.filter((r) => r.repo === target.repo);
    // max + 1, not the first gap: register.sh refuses an existing directory, and
    // reusing a number whose directory was left behind by a failed removal would
    // collide rather than recover.
    const next = Math.max(...siblings.map((r) => r.instance ?? 1)) + 1;
    const base = [...siblings].sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1))[0] ?? target;
    const labels = base.extraLabels ?? [];
    for (const l of labels) {
      if (!LABEL_RE.test(l)) throw new ActionError(`sibling carries an unusable label: ${l}`);
    }
    return { repo: target.repo, next, labels, siblings };
  }

  // Remove exactly one runner, named directly. Refuses if it is working — a
  // runner torn down mid-job reports as a lost runner, which reads like an
  // infrastructure fault rather than somebody's choice.
  //
  // Checked here as well as in the script because this is the fast, specific
  // answer: the HTTP caller gets a 409 naming the runner instead of a script's
  // exit status, and the confirm dialog never opens on a job that is running.
  async function deregister(name, apply) {
    const target = knownRunner(name);
    if (target.workingLocally || target.ghBusy) {
      throw new ActionError(`refusing: ${name} is running a job right now`, 409);
    }
    const args = [target.dirName];
    if (apply) args.push('--apply');
    return run('./scripts/deregister.sh', args, { cwd: root, timeout: 300000 });
  }

  return {
    // ---- runner lifecycle -------------------------------------------------
    'runner.restart': {
      label: 'Restart runner',
      danger: 'medium',
      summary: (a) => `svc.sh stop && svc.sh start in ${a.name}`,
      async exec({ name }) {
        const r = knownRunner(name);
        // Stop then start, in that order, from the runner's own directory —
        // exactly what health.sh --repair does for a dead service.
        const stop = await run('./svc.sh', ['stop'], { cwd: r.dir, timeout: 60000 });
        const start = await run('./svc.sh', ['start'], { cwd: r.dir, timeout: 60000 });
        return {
          code: start.code,
          ok: start.code === 0,
          command: `(cd ${r.dir} && ./svc.sh stop && ./svc.sh start)`,
          output: [stop.output, start.output].filter(Boolean).join('\n'),
        };
      },
    },

    'fleet.health': {
      label: 'Health check',
      danger: 'none',
      summary: () => './health.sh',
      // Exit 1 means "one or more runners are unhealthy" — a report, not a fault.
      exec: () => run('./health.sh', [], { cwd: root, okCodes: [0, 1] }),
    },

    'fleet.healthRepair': {
      label: 'Health check and repair',
      danger: 'medium',
      summary: () => './health.sh --repair',
      // Still exits 1 after a successful repair, because it found something to
      // repair. Reporting that in red taught the operator to distrust the tab.
      exec: () => run('./health.sh', ['--repair'], { cwd: root, timeout: 300000, okCodes: [0, 1] }),
    },

    'fleet.status': {
      label: 'Fleet status',
      danger: 'none',
      summary: () => './status.sh',
      exec: () => run('./status.sh', [], { cwd: root }),
    },

    'fleet.preflight': {
      label: 'Preflight this host',
      danger: 'none',
      summary: () => './preflight.sh',
      exec: () => run('./preflight.sh', [], { cwd: root, timeout: 180000, okCodes: [0, 1] }),
    },

    // Dry run is a separate action from apply, not a flag on one. A single
    // action with a boolean is one typo away from deleting caches you meant to
    // preview.
    'fleet.cleanupPreview': {
      label: 'Preview cleanup',
      danger: 'none',
      summary: () => './cleanup.sh (dry run)',
      exec: () => run('./cleanup.sh', [], { cwd: root, timeout: 300000 }),
    },

    'fleet.cleanupApply': {
      label: 'Apply cleanup',
      danger: 'high',
      confirm: 'This deletes DerivedData, dead simulators and old _diag logs. Preview first.',
      summary: () => './cleanup.sh --apply',
      exec: () => run('./cleanup.sh', ['--apply'], { cwd: root, timeout: 600000 }),
    },

    'runner.register': {
      label: 'Register a runner',
      danger: 'high',
      confirm: 'This registers a new runner with GitHub and installs a LaunchAgent.',
      summary: (a) =>
        `${a.instance > 1 ? `RUNNER_INSTANCE=${a.instance} ` : ''}./register.sh ${a.repo}${a.label ? ` ${a.label}` : ''}`,
      async exec({ repo, label, instance, force }) {
        knownRepo(repo);
        if (label != null && label !== '' && !LABEL_RE.test(label)) {
          throw new ActionError('malformed label');
        }
        const inst = instance ? intArg(instance, 'instance') : 1;
        if (inst > 4) throw new ActionError('instance must be 1–4');

        // The same-label rule, enforced here rather than left to memory: a
        // second runner that does not carry the first one's extra labels will
        // never match the same runs-on:, and will sit idle forever while the
        // first one queues. This is the mistake the fleet has already made.
        const siblings = getSnapshot().runners.filter((r) => r.repo === repo && r.registered);
        if (inst > 1 && siblings.length) {
          const expected = siblings[0].extraLabels ?? [];
          const given = label ? [label] : [];
          const same =
            expected.length === given.length && expected.every((l) => given.includes(l));
          if (!same) {
            throw new ActionError(
              `label mismatch: the existing runner carries [${expected.join(', ') || 'no extra labels'}]. ` +
                `A second runner must carry the same, or it will never match the same runs-on:.`
            );
          }
        }

        // Only an ADDITIONAL runner is gated on headroom. Instance 1 is a repo's
        // first runner, which gives it CI at all rather than more concurrency —
        // refusing that because the machine is busy right now would be refusing
        // to set up a repo because a build is running.
        if (inst > 1) {
          const snap = getSnapshot();
          const hr = headroom({ host: snap.host ?? {}, runners: snap.runners ?? [], limits: getLimits() });
          if (!hr.ok && !force) {
            throw new ActionError(`no headroom to add a runner: ${hr.reasons.join('; ')}`, 409);
          }
        }

        const args = [repo];
        if (label) args.push(label);
        return run('./register.sh', args, {
          cwd: root,
          timeout: 300000,
          env: inst > 1 ? { RUNNER_INSTANCE: String(inst) } : undefined,
        });
      },
    },

    // One click, because the manual path is four decisions long (which repo,
    // which instance number, which labels, is there room) and three of them are
    // derivable. The fleet already runs three hand-made duplicates, so this is
    // paving a path people walk.
    'runner.duplicate': {
      label: 'Duplicate runner',
      danger: 'high',
      confirm:
        'This registers an ADDITIONAL runner for the same repo, letting two of its jobs ' +
        'run at once. It consumes ~1.3 GB of disk and a concurrency slot.',
      summary: (a) => {
        const { repo, next, labels } = duplicatePlan(a.name);
        return `RUNNER_INSTANCE=${next} ./register.sh ${repo}${labels.length ? ` ${labels.join(',')}` : ''}`;
      },
      async exec({ name, force }) {
        const { repo, next, labels } = duplicatePlan(name);
        const limits = getLimits();
        const cap = limits.maxInstancesPerRepo ?? 4;
        if (next > cap) {
          throw new ActionError(
            `refusing: ${repo} already has ${next - 1} runners, the per-repo limit. ` +
              'Raise maxInstancesPerRepo if more is really wanted.'
          );
        }

        // The gate. A person may override it; the autoscaler calls this without
        // force and therefore cannot.
        const snap = getSnapshot();
        const hr = headroom({ host: snap.host ?? {}, runners: snap.runners ?? [], limits });
        if (!hr.ok && !force) {
          throw new ActionError(
            `no headroom to add a runner: ${hr.reasons.join('; ')}. ` +
              'Adding one now would make every running job slower, not faster.',
            409
          );
        }

        const args = [repo];
        if (labels.length) args.push(labels.join(','));
        return run('./register.sh', args, {
          cwd: root,
          timeout: 300000,
          env: { RUNNER_INSTANCE: String(next) },
        });
      },
    },

    // ---- drain mode -------------------------------------------------------
    // Drain marks a runner as intentionally stopped so health.sh and the
    // autoscaler do not restart it, the dashboard does not raise a dead alert,
    // and deregister.sh can safely follow once any in-flight job is done.
    //
    // Busy drain: writes a .drain marker NOW (dashboard shows "draining") and
    // a .drain-stop flag. The ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook reads that
    // flag after the job reports completion and calls svc.sh stop. The job is
    // never interrupted.
    'runner.drain': {
      label: 'Drain runner',
      danger: 'medium',
      confirm:
        'This will stop the runner after its current job finishes (or immediately if idle). ' +
        'It will NOT deregister from GitHub. Use "Remove" to fully remove it.',
      summary: (a) => `./scripts/drain-runner.sh ${a.name} --drain`,
      async exec({ name }) {
        const r = knownRunner(name);
        return run('./scripts/drain-runner.sh', [r.dirName, '--drain'], { cwd: root, timeout: 60000 });
      },
    },

    'runner.resume': {
      label: 'Resume runner',
      danger: 'medium',
      summary: (a) => `./scripts/drain-runner.sh ${a.name} --resume`,
      async exec({ name }) {
        const r = knownRunner(name);
        return run('./scripts/drain-runner.sh', [r.dirName, '--resume'], { cwd: root, timeout: 60000 });
      },
    },

    // Both variants go through the same builder; only --apply differs. The
    // script refuses a busy runner and refuses to leave a repo with no runner
    // at all, so those two guards hold even when this is run by hand.
    'runner.deregisterPreview': {
      label: 'Preview removal',
      danger: 'none',
      summary: (a) => `./scripts/deregister.sh ${a.name}`,
      exec: ({ name }) => deregister(name, false),
    },

    'runner.deregister': {
      label: 'Remove runner',
      danger: 'high',
      confirm:
        'This deregisters the runner from GitHub and removes its LaunchAgent and directory. ' +
        'Preview it first.',
      summary: (a) => `./scripts/deregister.sh ${a.name} --apply`,
      exec: ({ name }) => deregister(name, true),
    },

    // ---- GitHub-side actions ---------------------------------------------
    'run.cancel': {
      label: 'Cancel run',
      danger: 'medium',
      summary: (a) => `POST /repos/${a.repo}/actions/runs/${a.runId}/cancel`,
      async exec({ repo, runId }) {
        knownRepo(repo);
        const id = intArg(runId, 'runId');
        await gh.post(`repos/${repo}/actions/runs/${id}/cancel`);
        return { code: 0, ok: true, command: `cancel ${repo} run ${id}`, output: 'cancellation requested' };
      },
    },

    'run.rerun': {
      label: 'Re-run',
      danger: 'medium',
      summary: (a) =>
        `POST /repos/${a.repo}/actions/runs/${a.runId}/${a.failedOnly ? 'rerun-failed-jobs' : 'rerun'}`,
      async exec({ repo, runId, failedOnly }) {
        knownRepo(repo);
        const id = intArg(runId, 'runId');
        const path = failedOnly ? 'rerun-failed-jobs' : 'rerun';
        await gh.post(`repos/${repo}/actions/runs/${id}/${path}`);
        return { code: 0, ok: true, command: `${path} ${repo} run ${id}`, output: 're-run requested' };
      },
    },

    'workflow.dispatch': {
      label: 'Trigger workflow',
      danger: 'medium',
      summary: (a) => `POST /repos/${a.repo}/actions/workflows/${a.workflowId}/dispatches (${a.ref})`,
      async exec({ repo, workflowId, ref }) {
        knownRepo(repo);
        const id = intArg(workflowId, 'workflowId');
        if (!REF_RE.test(ref ?? '')) throw new ActionError('malformed ref');
        await gh.post(`repos/${repo}/actions/workflows/${id}/dispatches`, { ref });
        return { code: 0, ok: true, command: `dispatch ${repo} workflow ${id} on ${ref}`, output: 'dispatch requested' };
      },
    },
  };
}

export { ActionError };
