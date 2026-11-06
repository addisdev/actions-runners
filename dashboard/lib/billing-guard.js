// The billing guard: nothing runs or is kept at GitHub.
//
// Every CI job runs on the self-hosted runners and keeps its artifacts on the
// runner host (~/ci-artifacts, lib/artifacts.js). GitHub is the code, the PRs
// and the run log, nothing else. On GitHub Free the month's 500 MB of
// artifact storage (~372 GB-hours) went by 2026-11-05, after which every
// upload-artifact failed until the 1st. This check says, once a day, whether
// the account is still at zero, and names the repo and SKU the day it is not:
//
//   hosted-minutes  any GitHub-hosted Actions minute in a repo that is not
//                   exempt. The exempt repos (default actions-runners and
//                   fleet-runner, owner decision D1) are public and stay on
//                   hosted runners, where their minutes are free.
//   storage         Actions storage (gross GB-hours) in the non-exempt repos
//                   above a small floor on any day of the window.
//   artifacts       a private repo holding unexpired GitHub artifacts.
//   caches          a private repo holding GitHub Actions caches.
//
// Sources: /users/{account}/settings/billing/usage?year=&month= (per repo,
// per SKU, per day; needs a token with the `user` scope),
// /repos/{r}/actions/cache/usage and /repos/{r}/actions/artifacts.
//
// This module is pure: usage items and holdings in, a verdict out. fleetd's
// slow loop fetches them once a day (runBillingGuard below takes the client).

export const DEFAULT_EXEMPT = ['actions-runners', 'fleet-runner'];
// GB-hours a day the non-exempt repos may hold between them. One 40 MB
// report kept a day is ~1 GB-h; homelake's screenshots were 231 GB-h on 11-05.
export const DEFAULT_STORAGE_FLOOR_GBH = 1;
// Today and yesterday (UTC, GitHub's billing day): a guard that looked at the
// whole month would stay red for weeks over one fixed mistake.
export const DEFAULT_WINDOW_DAYS = 2;
export const GUARD_EVERY_MS = 24 * 60 * 60 * 1000;
// A run that could not read the billing API is tried again sooner.
export const GUARD_RETRY_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const lower = (s) => String(s ?? '').toLowerCase();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function isActions(item) {
  return lower(item?.product) === 'actions';
}

export function isHostedMinutes(item) {
  return isActions(item) && lower(item.unitType) === 'minutes';
}

export function isStorage(item) {
  return isActions(item) && /storage/.test(lower(item.sku)) && /gigabyte/.test(lower(item.unitType));
}

// The UTC days the window covers, oldest first.
export function windowDays(now, days = DEFAULT_WINDOW_DAYS) {
  const n = Math.max(1, Math.floor(days));
  return Array.from({ length: n }, (_, i) => day(now - (n - 1 - i) * DAY_MS));
}

// The (year, month) pairs the window touches: one usage call each.
export function monthsFor(now, days = DEFAULT_WINDOW_DAYS) {
  const seen = new Map();
  for (const d of windowDays(now, days)) {
    const [y, m] = d.split('-').map(Number);
    seen.set(`${y}-${m}`, { year: y, month: m });
  }
  return [...seen.values()];
}

export function evaluateUsage(items, {
  now = Date.now(),
  days = DEFAULT_WINDOW_DAYS,
  exempt = DEFAULT_EXEMPT,
  storageFloorGbh = DEFAULT_STORAGE_FLOOR_GBH,
} = {}) {
  const inWindow = new Set(windowDays(now, days));
  const isExempt = new Set(exempt.map(lower));
  const minutes = new Map();
  const exemptMinutes = new Map();
  const storage = new Map(); // date -> Map(repo -> gbh)
  const exemptStorage = new Map(); // repo -> gbh
  for (const it of items ?? []) {
    const date = String(it?.date ?? '').slice(0, 10);
    if (!inWindow.has(date)) continue;
    const repo = it.repositoryName || '(no repository)';
    const qty = Number(it.quantity ?? it.grossQuantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (isHostedMinutes(it)) {
      const into = isExempt.has(lower(repo)) ? exemptMinutes : minutes;
      const key = `${repo}\u0000${it.sku}`;
      const prev = into.get(key) ?? { repo, sku: it.sku, minutes: 0, days: new Set() };
      prev.minutes += qty;
      prev.days.add(date);
      into.set(key, prev);
    } else if (isStorage(it)) {
      if (isExempt.has(lower(repo))) {
        exemptStorage.set(repo, (exemptStorage.get(repo) ?? 0) + qty);
        continue;
      }
      const byRepo = storage.get(date) ?? new Map();
      byRepo.set(repo, (byRepo.get(repo) ?? 0) + qty);
      storage.set(date, byRepo);
    }
  }

  const findings = [];
  for (const m of [...minutes.values()].sort((a, b) => b.minutes - a.minutes)) {
    findings.push({
      kind: 'hosted-minutes', repo: m.repo, sku: m.sku, amount: m.minutes, unit: 'minutes',
      detail: `${m.repo}: ${m.minutes} GitHub-hosted minutes (${m.sku}) on ${[...m.days].sort().join(', ')}`,
    });
  }
  const storageDays = [...inWindow].map((date) => {
    const byRepo = storage.get(date) ?? new Map();
    const repos = [...byRepo.entries()].map(([repo, gbh]) => ({ repo, gbh: round(gbh, 3) })).sort((a, b) => b.gbh - a.gbh);
    return { date, gbh: round(repos.reduce((s, r) => s + r.gbh, 0), 3), repos };
  });
  for (const d of storageDays) {
    if (d.gbh <= storageFloorGbh) continue;
    // Name the repos that make up the day, largest first, down to the floor.
    for (const r of d.repos) {
      if (r.gbh < 0.01) continue;
      findings.push({
        kind: 'storage', repo: r.repo, sku: 'Actions storage', amount: r.gbh, unit: 'GB-hours', date: d.date,
        detail: `${r.repo}: ${round(r.gbh)} GB-hours of Actions storage on ${d.date} (the day's total ${round(d.gbh)} is over the ${storageFloorGbh} GB-h floor)`,
      });
    }
  }
  return {
    window: { from: [...inWindow][0], to: [...inWindow].at(-1), days: inWindow.size },
    findings,
    storageDays,
    exempt: {
      repos: exempt,
      minutes: [...exemptMinutes.values()].map((m) => ({ repo: m.repo, sku: m.sku, minutes: m.minutes })),
      storageGbh: [...exemptStorage.entries()].map(([repo, gbh]) => ({ repo, gbh: round(gbh, 3) })),
    },
  };
}

// holdings: [{ repo: 'owner/name', private, caches: { count, bytes } | null,
// artifacts: { count, bytes, more } | null }]
export function evaluateHoldings(holdings, { exempt = DEFAULT_EXEMPT } = {}) {
  const isExempt = new Set(exempt.map(lower));
  const findings = [];
  for (const h of holdings ?? []) {
    const name = String(h.repo ?? '').split('/').pop();
    if (!h.private || isExempt.has(lower(name))) continue;
    const mb = (b) => round((b ?? 0) / 1048576, 1);
    if (h.artifacts?.count > 0) {
      findings.push({
        kind: 'artifacts', repo: name, sku: 'Actions storage', amount: h.artifacts.count, unit: 'artifacts', bytes: h.artifacts.bytes ?? 0,
        detail: `${name}: ${h.artifacts.count}${h.artifacts.more ? '+' : ''} GitHub artifacts kept (${mb(h.artifacts.bytes)} MB)`,
      });
    }
    if (h.caches?.count > 0) {
      findings.push({
        kind: 'caches', repo: name, sku: 'Actions cache', amount: h.caches.count, unit: 'caches', bytes: h.caches.bytes ?? 0,
        detail: `${name}: ${h.caches.count} GitHub Actions caches (${mb(h.caches.bytes)} MB); gh cache delete --all -R ${h.repo}`,
      });
    }
  }
  return findings;
}

// The verdict: red names every finding; unavailable when the usage API could
// not be read and nothing else is wrong (that is not a green).
export function verdict({ account, usage, usageError, holdings, holdingErrors = [], now = Date.now(), config = {} }) {
  const usageEval = usage ? evaluateUsage(usage, { ...config, now }) : null;
  const findings = [...(usageEval?.findings ?? []), ...evaluateHoldings(holdings, config)];
  let state = 'green';
  if (findings.length) state = 'red';
  else if (usageError || holdingErrors.length) state = 'unavailable';
  const window = usageEval?.window ?? { from: windowDays(now, config.days)[0], to: day(now), days: config.days ?? DEFAULT_WINDOW_DAYS };
  const repos = [...new Set(findings.map((f) => f.repo))];
  let summary;
  if (state === 'red') {
    summary = `GitHub is running or keeping something for ${repos.length === 1 ? repos[0] : `${repos.length} repos`}: `
      + findings.slice(0, 3).map((f) => f.detail).join('; ') + (findings.length > 3 ? `; and ${findings.length - 3} more` : '');
  } else if (state === 'unavailable') {
    summary = usageError
      ? `Cannot read ${account}'s Actions billing: ${usageError}`
      : `Could not check ${holdingErrors.length} repos' artifacts and caches`;
  } else {
    summary = `0 hosted minutes outside ${(config.exempt ?? DEFAULT_EXEMPT).join(' and ')}, `
      + `storage under ${config.storageFloorGbh ?? DEFAULT_STORAGE_FLOOR_GBH} GB-h a day, no GitHub artifacts or caches in private repos (${window.from}..${window.to})`;
  }
  return {
    state,
    account,
    checkedAt: now,
    window,
    summary,
    findings,
    storageDays: usageEval?.storageDays ?? [],
    exempt: usageEval?.exempt ?? null,
    usageError: usageError ?? null,
    holdingErrors,
    reposChecked: (holdings ?? []).length,
  };
}

// The Homelab Map's product-check shape (hmap detect/drift.py): one entry per
// check, state ok | warn | failed. Unavailable is amber, not green.
export function statusEntry(result) {
  if (!result) return null;
  const state = result.state === 'green' ? 'ok' : result.state === 'red' ? 'failed' : 'warn';
  return { state, at: new Date(result.checkedAt).toISOString(), detail: result.summary };
}

// Why a usage call failed, said so the owner knows the fix.
export function usageErrorText(err, account) {
  if (err?.status === 404 || err?.status === 403) {
    return `${err.status} from /users/${account}/settings/billing/usage: the token needs the \`user\` scope `
      + '(on the runner host: gh auth refresh -h github.com -s user)';
  }
  return err?.message ?? String(err);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// One full check against GitHub. `gh.get(path)` resolves { data } or throws an
// error carrying `status`; `repos` is the fleet's roster ({ fullName, private,
// archived }). Never throws: what it could not read is in the result.
export async function runBillingGuard({ gh, account, repos, config = {}, now = Date.now() }) {
  let usage = [];
  let usageError = null;
  for (const { year, month } of monthsFor(now, config.days)) {
    try {
      const { data } = await gh.get(`users/${encodeURIComponent(account)}/settings/billing/usage?year=${year}&month=${month}`, { etag: false });
      usage = usage.concat(data?.usageItems ?? []);
    } catch (err) {
      usageError = usageErrorText(err, account);
      usage = null;
      break;
    }
  }
  const mine = (repos ?? []).filter((r) => r.private && !r.archived
    && lower(String(r.fullName).split('/')[0]) === lower(account));
  const holdingErrors = [];
  const holdings = await mapLimit(mine, 4, async (r) => {
    const h = { repo: r.fullName, private: true, caches: null, artifacts: null };
    try {
      const { data } = await gh.get(`repos/${r.fullName}/actions/cache/usage`, { etag: false });
      h.caches = { count: data?.active_caches_count ?? 0, bytes: data?.active_caches_size_in_bytes ?? 0 };
    } catch (err) {
      holdingErrors.push(`${r.fullName} caches: ${err.message}`);
    }
    try {
      const { data } = await gh.get(`repos/${r.fullName}/actions/artifacts?per_page=100`, { etag: false });
      const live = (data?.artifacts ?? []).filter((a) => !a.expired);
      h.artifacts = {
        count: live.length,
        bytes: live.reduce((s, a) => s + (a.size_in_bytes ?? 0), 0),
        more: (data?.total_count ?? 0) > 100 && live.length === 100,
      };
    } catch (err) {
      holdingErrors.push(`${r.fullName} artifacts: ${err.message}`);
    }
    return h;
  });
  return verdict({ account, usage, usageError, holdings, holdingErrors, now, config });
}

// Due when there is no result yet, the last one is a day old, or the last one
// could not read the billing API and an hour has passed.
export function guardDue(last, now = Date.now()) {
  if (!last?.checkedAt) return true;
  const age = now - last.checkedAt;
  return age >= GUARD_EVERY_MS || (last.state === 'unavailable' && age >= GUARD_RETRY_MS);
}

// The account to guard: the setting when given, else the one owner every
// repository the fleet serves shares. Null when that is ambiguous.
export function guardAccount(setting, repos) {
  if (setting) return setting;
  const owners = new Set((repos ?? []).map((r) => String(r.fullName ?? '').split('/')[0]).filter(Boolean));
  return owners.size === 1 ? [...owners][0] : null;
}
