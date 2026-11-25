// Runner labels that name an Xcode, checked against the Xcode each host gives
// its jobs, once a day.
//
// The rule lives in scripts/xcode-label.sh, which register.sh and
// join-host.sh source: a label `xcode-<major>` or `xcode-<major>.<minor>` must
// name the Xcode a job on that runner gets (the runner's DEVELOPER_DIR, else
// the host's selected Xcode). register.sh enforces it on the day a runner is
// made; this module catches the day after, when Xcode is updated or reselected
// under labels that were true when they were written.
//
// What runs where, so the check costs no GitHub calls:
//   - each host runs `scripts/xcode-label.sh facts` once a day (the same
//     shell code register.sh uses to read a version) and reports the result:
//     fleetd for its own host, the agent in its heartbeat;
//   - fleetd already holds every runner's labels from its runner polling, and
//     compares the two here. The findings join the drift list, so they show up
//     under the `config-drift` verdict that Cockpit and `cockpit status` read.
//
// matchesLabel() is the shell rule's copy; scripts/xcode-label-cases.tsv
// is the table both are tested against.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

const LABEL_RE = /^xcode-(\d+)(?:\.(\d+))?$/i;
export const DEFAULT_CHECK_MS = 24 * 60 * 60 * 1000;

/** Is this label an Xcode claim? */
export function isXcodeLabel(label) {
  return LABEL_RE.test(String(label ?? ''));
}

/**
 * Does LABEL name VERSION?
 * @returns {'match'|'mismatch'|'ignored'} ignored: not an Xcode label.
 * A missing version (xcodebuild does not answer) is a mismatch for every
 * Xcode label.
 */
export function matchesLabel(label, version) {
  const m = LABEL_RE.exec(String(label ?? ''));
  if (!m) return 'ignored';
  if (!version) return 'mismatch';
  const [vMajor, vMinor = '0'] = String(version).split('.');
  if (Number(vMajor) !== Number(m[1])) return 'mismatch';
  if (m[2] != null && Number(vMinor) !== Number(m[2])) return 'mismatch';
  return 'match';
}

/** Parse `xcode-label.sh facts` output. */
export function parseFacts(text, checkedAt = Date.now()) {
  const facts = { checkedAt, selected: null, runners: {} };
  for (const line of String(text ?? '').split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'selected') facts.selected = { developerDir: f[1] || null, version: f[2] || null };
    else if (f[0] === 'runner' && f[1]) facts.runners[f[1]] = { developerDir: f[2] || null, version: f[3] || null };
  }
  return facts.selected ? facts : null;
}

/**
 * A sampler that runs the facts script at most once per `everyMs`. The first
 * call waits for the answer; later ones return the last answer at once and
 * refresh it in the background when it is due, so a tick never waits on
 * xcodebuild. null while unknown (no script, or it failed): the check abstains
 * rather than calling every label wrong.
 */
export function createXcodeFacts({
  root,
  script = join(root, 'scripts/xcode-label.sh'),
  everyMs = DEFAULT_CHECK_MS,
  run = defaultRun,
  now = Date.now,
  onError = () => {},
} = {}) {
  let facts = null;
  let at = -Infinity;
  let pending = null;
  const refresh = () => {
    pending = run(script, ['facts', '--root', root])
      .then((out) => { facts = parseFacts(out, now()); })
      .catch((err) => { facts = null; onError(err); })
      .finally(() => { at = now(); pending = null; });
    return pending;
  };
  return async function sample() {
    if (!pending && now() - at >= everyMs) {
      const first = at === -Infinity;
      const p = refresh();
      if (first) await p;
    }
    return facts;
  };
}

function defaultRun(script, args) {
  return new Promise((resolve, reject) => {
    execFile('bash', [script, ...args], { timeout: 60_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Drift findings for every host whose Xcode facts are known.
 *
 * Each host lists the runners IT reported (its runner directories), joined to
 * GitHub's labels by exact runner name. Names from GitHub alone are never
 * attributed to a host: a runner with no directory here is not this host's
 * Xcode's problem.
 *
 * @param {object[]} hosts - { name, labels (host labels), xcode (facts), runners: [{ name, dirName, labels }] }
 * @returns {object[]} drift entries, kind 'xcode-label'
 */
export function xcodeLabelDrift(hosts = []) {
  const out = [];
  for (const h of hosts) {
    const facts = h?.xcode;
    if (!facts?.selected) continue;
    const sel = facts.selected;
    const selText = sel.version ? `Xcode ${sel.version} is selected` : 'no Xcode answers (xcodebuild -version fails)';
    const hostBad = (h.labels ?? []).filter((l) => matchesLabel(l, sel.version) === 'mismatch');
    if (hostBad.length) {
      out.push({
        severity: 'warning',
        kind: 'xcode-label',
        subject: `${h.name}: host label ${hostBad.join(',')}, ${selText}`,
        detail: `FLEET_HOST_LABELS on ${h.name} advertises ${hostBad.join(',')} but ${selText}`,
        hint: sel.version
          ? `rename it to xcode-${String(sel.version).split('.')[0]} in ${h.name}'s fleet.env (and any runs-on: that asks for the old one)`
          : `install and select an Xcode on ${h.name}, or drop the label`,
        host: h.name,
        labels: hostBad,
        version: sel.version ?? null,
      });
    }
    for (const r of h.runners ?? []) {
      const own = r.dirName ? facts.runners?.[r.dirName] : null;
      const got = own ?? sel;
      const bad = (r.labels ?? []).filter((l) => matchesLabel(l, got.version) === 'mismatch');
      if (!bad.length) continue;
      const where = own ? `its DEVELOPER_DIR (${own.developerDir}) is ${own.version ? `Xcode ${own.version}` : 'not an Xcode that answers'}` : selText;
      out.push({
        severity: 'warning',
        kind: 'xcode-label',
        subject: `${r.name}: label ${bad.join(',')}, ${own ? `DEVELOPER_DIR Xcode ${own.version ?? 'unknown'}` : selText}`,
        detail: `${r.name} on ${h.name} carries ${bad.join(',')} but ${where}`,
        hint: 'jobs that ask for that label build with another Xcode: relabel the runner (scripts/deregister.sh, then register.sh with the right label), or give it that Xcode with FLEET_RUNNER_DEVELOPER_DIR',
        host: h.name,
        runner: r.name,
        labels: bad,
        version: got.version ?? null,
      });
    }
  }
  return out;
}
