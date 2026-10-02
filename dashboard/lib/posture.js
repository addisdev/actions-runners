// Posture: conditions that are fine today and will bite later.
//
// None of these is an incident. Each is a standing risk this fleet has already
// paid for once: Spotlight indexing _work starved the host until jobs died
// (2026-09-12); no auto-login meant a reboot while nobody was home stranded
// every LaunchAgent (2026-09-05); workflows still asking for GitHub-hosted
// macOS ran into the account's spending limit hundreds of times. They stay
// visible here until someone fixes them, because an alert that fired once and
// closed is forgotten by the next incident.
//
// Checked on the slow loop. Every probe is a read; nothing here changes the
// host. Several fixes are system settings that only the owner can make — and on
// a managed Mac, MDM may not allow at all — so each item says who can act.

const OK = (id, title, detail) => ({ id, title, ok: true, detail });
const RISK = (id, title, detail, fix, who) => ({ id, title, ok: false, detail, fix, who });
const UNKNOWN = (id, title, detail) => ({ id, title, ok: null, detail });

/**
 * @param {object} p
 * @param {(cmd: string, args: string[], timeout?: number) => Promise<string>} p.sh
 * @param {string} p.root         fleet root on this host
 * @param {object} p.snapshot     current fleet snapshot
 * @param {object[]} p.lint       lint findings
 * @param {string} p.labelPrefix  LaunchAgent label prefix (FLEET_LABEL_PREFIX)
 */
export async function checkPosture({ sh, root, snapshot, lint = [], labelPrefix = 'com.runner-fleet' }) {
  const items = [];

  // Spotlight over _work: count indexed files the runners write by the
  // thousand. Zero means excluded (or never indexed); anything else means
  // mds is chewing through every npm ci.
  // An empty answer is a probe that did not run, not a count of zero.
  const num = (s) => (s.trim() === '' ? NaN : Number(s.trim()));
  // A minute, not twenty seconds: over 77,000 matches the count takes ~14 s on
  // an idle host, and on a busy one the 20 s probe timed out and the item read
  // "could not check" while the index was very much on (2026-10-01).
  const indexed = num(await sh('/usr/bin/mdfind', ['-onlyin', root, '-count', 'kMDItemFSName == "package.json"'], 60000));
  if (!Number.isFinite(indexed) || (await sh('/usr/bin/mdutil', ['-s', '/'], 5000)).includes('disabled')) {
    items.push(Number.isFinite(indexed) ? OK('spotlight', 'Spotlight is not indexing runner work trees', 'indexing is disabled')
      : UNKNOWN('spotlight', 'Spotlight indexing of runner work trees', 'mdfind did not answer within a minute — not checked'));
  } else if (indexed > 0) {
    items.push(RISK('spotlight', 'Spotlight is indexing runner work trees',
      `${indexed.toLocaleString('en-US')} package.json files under ${root} are in the Spotlight index. On 2026-09-12 mds indexing _work starved the host until jobs lost contact mid-step.`,
      `System Settings → Spotlight → Search Privacy → add ${root} (or: sudo mdutil -i off on a dedicated volume). May be locked by MDM on a managed Mac.`,
      'owner'));
  } else {
    items.push(OK('spotlight', 'Spotlight is not indexing runner work trees', `no indexed files under ${root}`));
  }

  // Auto-login: without it a reboot while nobody is home leaves every runner
  // LaunchAgent unstarted until someone logs in at the console.
  const auto = (await sh('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser'], 5000)).trim();
  items.push(auto
    ? OK('auto-login', 'Runners come back after a reboot', `auto-login as ${auto}`)
    : RISK('auto-login', 'A reboot strands every runner until someone logs in',
      'No auto-login user. Runner LaunchAgents start at login, so a power cut or update while nobody is home stops the fleet.',
      'System Settings → Users & Groups → Automatically log in as (not available with FileVault on, and may be blocked by MDM). Otherwise: keep a way to log in remotely (Screen Sharing over the tailnet).',
      'owner'));

  // Sleep: a runner host that sleeps is a host that is down.
  const pm = await sh('/usr/bin/pmset', ['-g'], 5000);
  const sleep = /^\s*sleep\s+(\d+)/m.exec(pm)?.[1];
  if (sleep == null) items.push(UNKNOWN('sleep', 'System sleep', 'pmset did not answer'));
  else if (sleep === '0') items.push(OK('sleep', 'The host does not sleep', 'pmset sleep 0'));
  else items.push(RISK('sleep', `The host sleeps after ${sleep} minutes idle`,
    'A sleeping host takes no jobs and looks like "host down" from everywhere else.',
    'sudo pmset -a sleep 0 (or System Settings → Energy → Prevent automatic sleeping).', 'owner'));

  // Admission hooks on every runner.
  const hooks = snapshot.admission?.hooks;
  if (hooks?.total) {
    items.push(hooks.installed === hooks.total
      ? OK('hooks', 'Admission hooks on every runner', `${hooks.installed} of ${hooks.total}`)
      : RISK('hooks', `Admission hooks missing on ${hooks.total - hooks.installed} runner(s)`,
        `${hooks.installed} of ${hooks.total} runners carry the job hooks; the rest start jobs with no concurrency or disk-floor check.`,
        'scripts/install-hooks.sh --apply --restart', 'command'));
  }

  // Runner version drift: a runner left behind on an old version stops
  // getting jobs once GitHub retires it.
  const versions = new Map();
  for (const r of snapshot.runners ?? []) if (r.version) versions.set(r.version, (versions.get(r.version) ?? 0) + 1);
  if (versions.size > 1) {
    const list = [...versions].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(', ');
    items.push(RISK('versions', 'Runners are on different versions', list,
      'Runners self-update between jobs; one stuck behind usually needs restarting (Restart runner).', 'button'));
  } else if (versions.size === 1) {
    items.push(OK('versions', 'Every runner on one version', [...versions.keys()][0]));
  }

  // The repair loop itself.
  const agents = await sh('/bin/launchctl', ['list'], 5000);
  const health = [`${labelPrefix}.fleet-health`, `${labelPrefix}.runner-health`].find((l) => agents.includes(l));
  items.push(health
    ? OK('health-agent', 'Periodic health repair is loaded', health)
    : RISK('health-agent', 'Periodic health repair is not loaded',
      'Nothing revives a dead runner service between visits.', './healthctl.sh install', 'command'));

  // Workflows still asking for GitHub-hosted macOS: every one of their jobs
  // bills, and a spending limit refuses self-hosted jobs along with them.
  // Public repos run hosted macOS for free; only private ones bill and hit the
  // spending limit. A repo whose visibility is unknown counts, to be safe.
  const isPublic = new Map((snapshot.repos ?? []).map((r) => [r.fullName, r.private === false]));
  const hosted = lint.filter((f) => f.rule === 'hosted-macos' && !isPublic.get(f.repo));
  if (hosted.length) {
    const repos = [...new Set(hosted.map((f) => f.repo.split('/').pop()))];
    items.push(RISK('hosted-runners', `${hosted.length} workflow job(s) still target GitHub-hosted macOS`,
      `In ${repos.slice(0, 6).join(', ')}${repos.length > 6 ? ` and ${repos.length - 6} more` : ''}. These bill per minute and hit the spending limit that also blocks self-hosted jobs.`,
      'Change runs-on to the self-hosted labels (see the Lint tab).', 'owner'));
  } else {
    items.push(OK('hosted-runners', 'No workflow targets GitHub-hosted macOS', 'lint found none'));
  }

  // This checkout vs its remote (last fetch; nothing is fetched here).
  const behind = num(await sh('/usr/bin/git', ['-C', root, 'rev-list', '--count', 'HEAD..origin/main'], 5000));
  if (Number.isFinite(behind) && behind > 0) {
    items.push(RISK('behind', `The fleet scripts are ${behind} commit(s) behind origin/main`,
      'As of the last fetch.', 'git pull, then ./dashboard/fleetctl.sh restart when the queue is empty.', 'command'));
  } else if (Number.isFinite(behind)) {
    items.push(OK('behind', 'The fleet scripts are current', 'up to date with origin/main as of the last fetch'));
  }

  // GitHub API headroom.
  const api = snapshot.api;
  if (api?.limit) {
    const pct = Math.round((api.remaining / api.limit) * 100);
    items.push(pct >= 20
      ? OK('api', 'GitHub API headroom', `${api.remaining} of ${api.limit} left this hour`)
      : RISK('api', 'GitHub API budget is low', `${api.remaining} of ${api.limit} left this hour`,
        'Fewer polled repos or a longer FLEET_FAST_MS.', 'owner'));
  }

  return { checkedAt: Date.now(), items, open: items.filter((i) => i.ok === false).length };
}
