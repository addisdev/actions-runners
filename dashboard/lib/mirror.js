// Which runners a joining host should register so that it can share a repo's
// jobs with the host that already serves it.
//
// GitHub is the scheduler here, not this fleet: a job goes to any idle runner
// whose labels cover its `runs-on`. So a second host takes a share of a repo's
// work exactly when it has a runner carrying the same labels as one that is
// already serving it. That makes the copy unit a LABEL SET, not a repo: on
// runner-host aliquant-web has four runners, two labelled `ci` and two
// `ui-web`, and copying only the first one's labels would leave every ui-web
// job queueing for the old host while the new one sat idle.
//
// What the joining host cannot run is the part worth getting right, because a
// runner registered on the wrong host does not fail at registration. It takes a
// job and fails in the middle of it, on a real product's CI. So the plan skips,
// and says why:
//   - a label the host does not advertise (FLEET_HOST_LABELS), which is how the
//     fleet already says "this host has Xcode 26" or "this host has a CI
//     database";
//   - a Simulator runner, named by the same patterns the admission hook uses
//     (FLEET_SIMULATOR_RUNNERS), unless the host has Xcode;
//   - repos the operator names (FLEET_MIRROR_SKIP_REPOS), for jobs whose needs
//     no label states: an iOS lane on a plain `ci` runner, a backend suite that
//     expects a local PostgreSQL.
//
// Pure: it takes the coordinator's runner list and this host's facts, and
// returns a plan. scripts/mirror-runners.sh does the registering.

// Labels every self-hosted macOS runner carries. Not part of a label set.
const DEFAULT_LABELS = new Set(['self-hosted', 'macos', 'arm64', 'x64', 'linux']);

// Same shell-glob subset as hooks/common.sh's admit_runner_matches: `*` only.
export function globMatch(pattern, name) {
  const re = new RegExp(
    `^${String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
  );
  return re.test(name);
}

export function extraLabels(labels = []) {
  return labels
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((l) => l && !DEFAULT_LABELS.has(String(l).toLowerCase()))
    .map(String)
    .sort();
}

// The name a runner would have without its host prefix and instance suffix:
// RL6P9G7WYT-aliquant-web-3 → aliquant-web. Used only to test the Simulator
// patterns, which are written against the repo-shaped part of the name.
function bareName(runner) {
  return String(runner.repo ?? '').split('/').pop() || String(runner.name ?? '');
}

/**
 * @param {object}   opts
 * @param {object[]} opts.runners        - coordinator /api/state runners (name, repo, labels, instance)
 * @param {string[]} opts.hostLabels     - this host's FLEET_HOST_LABELS
 * @param {boolean}  opts.hasXcode       - whether xcodebuild works on this host
 * @param {string[]} [opts.simulatorPatterns] - FLEET_SIMULATOR_RUNNERS
 * @param {string[]} [opts.skipRepos]    - FLEET_MIRROR_SKIP_REPOS (bare names or owner/repo)
 * @param {string[]} [opts.onlyRepos]    - limit the plan to these (a pilot)
 * @param {string[]} [opts.existing]     - runner dir names already on this host
 * @returns {{ register: object[], skipped: object[], present: object[] }}
 */
export function planMirror({
  runners = [], hostLabels = [], hasXcode = false, simulatorPatterns = [],
  skipRepos = [], onlyRepos = [], existing = [],
}) {
  const have = new Set(hostLabels.map((l) => String(l).toLowerCase()));
  const named = (list) => new Set(list.flatMap((r) => [r, String(r).split('/').pop()]));
  const skip = named(skipRepos);
  const only = onlyRepos.length ? named(onlyRepos) : null;
  const existingDirs = new Set(existing);

  // repo → ordered distinct label sets, in the order the source host numbered
  // its instances, so the joining host's instance 1 matches the source's.
  const sets = new Map();
  const sorted = [...runners]
    .filter((r) => r.repo)
    .sort((a, b) => String(a.repo).localeCompare(String(b.repo)) || (a.instance ?? 1) - (b.instance ?? 1));
  for (const r of sorted) {
    const labels = extraLabels(r.labels ?? []);
    const key = labels.join(',');
    if (!sets.has(r.repo)) sets.set(r.repo, new Map());
    const bySet = sets.get(r.repo);
    if (!bySet.has(key)) bySet.set(key, { labels, source: r.name, simulator: false });
    if (simulatorPatterns.some((p) => globMatch(p, bareName(r)) || globMatch(p, r.name ?? ''))) {
      bySet.get(key).simulator = true;
    }
  }

  const register = [];
  const skipped = [];
  const present = [];
  for (const [repo, bySet] of [...sets].sort(([a], [b]) => a.localeCompare(b))) {
    const name = repo.split('/').pop();
    if (only && !only.has(repo) && !only.has(name)) continue;
    let instance = 0;
    for (const set of bySet.values()) {
      const base = { repo, labels: set.labels, source: set.source };
      if (skip.has(repo) || skip.has(name)) {
        skipped.push({ ...base, reason: 'listed in FLEET_MIRROR_SKIP_REPOS' });
        continue;
      }
      const missing = set.labels.filter((l) => !have.has(l.toLowerCase()));
      if (missing.length) {
        skipped.push({ ...base, reason: `host lacks label ${missing.join(', ')}` });
        continue;
      }
      if (set.simulator && !hasXcode) {
        skipped.push({ ...base, reason: 'Simulator runner and this host has no Xcode' });
        continue;
      }
      instance += 1;
      const dir = instance === 1 ? name : `${name}-${instance}`;
      const row = { ...base, instance, dir };
      if (existingDirs.has(dir)) present.push(row);
      else register.push(row);
    }
  }
  return { register, skipped, present };
}
