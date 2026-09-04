// The capacity tab: how much of this machine CI is allowed to take, which repos
// are starved of runners, and what the autoscaler last decided.
//
// The organising idea is that a refusal has to be as legible as an action. This
// fleet's own history says a scale-up will be refused most of the time — three
// concurrent jobs already put a 12-core machine at 5x load per core — so a
// screen that only reported successes would look broken. Every panel here leads
// with the reason.

import { chartEl as h } from './charts.js';
import * as control from './control.js';

const mount = (el, ...kids) =>
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

let settings = null;
let getSnapshot = () => null;
let saving = null;
let lastError = null;

export function setSnapshotSource(fn) {
  getSnapshot = fn;
}

export async function loadSettings() {
  try {
    settings = await (await fetch('/api/settings')).json();
  } catch {
    settings = null;
  }
}

// Simulation and forecast are fetched on demand rather than with every snapshot.
// A replay sweeps 30 days of job rows and a baseline sweeps 60, which is fine
// when someone opens the tab and wasteful every 15 seconds.
let sim = null;
let forecast = null;
let loadingSim = false;
let loadingForecast = false;

export async function loadSimulation({ days = 30 } = {}) {
  loadingSim = true;
  render();
  try {
    sim = await (await fetch(`/api/simulate?days=${days}`)).json();
  } catch (err) {
    sim = { error: err.message };
  }
  loadingSim = false;
  render();
}

export async function loadForecast() {
  loadingForecast = true;
  render();
  try {
    forecast = await (await fetch('/api/forecast?hours=12')).json();
  } catch (err) {
    forecast = { error: err.message };
  }
  loadingForecast = false;
  render();
}

async function save(key, body) {
  const token = localStorage.getItem('fleet-control-token');
  if (!token) {
    lastError = 'no control token — unlock on the Control tab first';
    render();
    return;
  }
  saving = key;
  lastError = null;
  render();
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ key, ...body }),
    });
    const parsed = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (parsed.error) lastError = `${key}: ${parsed.error}`;
  } catch (err) {
    lastError = err.message;
  } finally {
    saving = null;
    await loadSettings();
    render();
  }
}

// Add a runner for the repo a given runner serves, offering an override if the
// daemon refuses for lack of headroom.
//
// The override exists because the two callers are not equivalent: automation
// must never talk its way past the gate, but a person looking at the machine may
// know something the gate does not — that the load is a build about to finish,
// or that they are willing to pay for it. So the refusal is shown in full and
// the choice is theirs, which is also why `force` is never a default.
//
// Shared by all three entry points (the sizing table, the runner drawer, the
// stuck-queue drift item) so the override behaves identically wherever it is
// reached from.
export async function addRunner(runnerName) {
  const first = await control.confirmAct('runner.duplicate', { name: runnerName });
  if (!first) return null;
  if (first.ok) {
    alert('Added.\n\n' + (first.output || ''));
    return first;
  }

  const refusal = first.error || first.output || 'unknown error';
  if (first.status !== 409) {
    alert('Failed: ' + refusal);
    return first;
  }

  if (!window.confirm(`${refusal}\n\nAdd it anyway?`)) return first;
  const forced = await control.act('runner.duplicate', { name: runnerName, force: true });
  alert(forced.ok ? 'Added.\n\n' + (forced.output || '') : 'Failed: ' + (forced.error || forced.output));
  return forced;
}

// ------------------------------------------------------------------- panels

function headroomPanel(s) {
  const cap = s.capacity ?? {};
  const ok = cap.ok;
  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Headroom' }),
      h('span', { class: `count ${ok ? '' : 'warn'}`, text: ok ? 'room to add a runner' : 'not now' })
    ),
    ok
      ? h('div', { class: 'all-clear' }, h('b', { text: '✓' }),
          ` ${cap.busy ?? 0} job(s) running, under the limit of ${cap.ceiling}.`)
      : h('ul', { class: 'reasons' }, (cap.reasons ?? []).map((r) => h('li', { text: r }))),
    // Said plainly because the numbers above invite the opposite reading, and
    // acting on that misreading is how a fleet gets a load average of 760.
    //
    // Conditional on admission control actually enforcing: once it is, the flat
    // claim is no longer true, and a screen that kept saying it would be
    // teaching the operator something false about their own fleet.
    (s.admission?.mode === 'enforce')
      ? h('p', { class: 'note', text:
          'This gate only governs ADDING runners. Jobs that are already running are ' +
          'capped separately by admission control — see below.' })
      : h('p', { class: 'note', text:
          'Nothing here throttles jobs that are already running. There is no scheduler — ' +
          'every registered runner listens independently, so the number of runners is the ' +
          'real limit on how many jobs can run at once.' })
  );
}

// Job admission, from hooks/job-started.sh.
//
// The states this has to tell apart are the whole point of the panel: hooks
// absent, hooks present but switched off, observing, and enforcing all look
// identical if you only report event counts — and they need completely
// different responses from whoever is reading.
function admissionPanel(s) {
  const a = s.admission ?? {};
  const hooks = a.hooks ?? { installed: 0, total: 0 };
  const c = a.last24h ?? {};
  const waiting = a.waiting ?? [];

  // The install count comes from the slow loop, which on a fresh start has not
  // run yet. Until it has, `0 of 0` means "not counted", not "none installed" —
  // claiming the latter would tell the operator their hooks are missing every
  // time the daemon restarts.
  const counted = hooks.checkedAt != null;
  const installedNone = counted && hooks.installed === 0;
  const installedSome = counted && hooks.installed > 0 && hooks.installed < hooks.total;
  const mode = a.mode ?? null;
  // The mode is read from the events, because fleet.env is read by the hooks
  // inside a job and never by this process. So between someone setting a mode
  // and the next job starting, it is genuinely unknown — and saying "off" then
  // would contradict the file they just edited.
  const seen = a.lastDecisionAt != null;

  const state = !counted ? 'checking'
    : installedNone ? 'not installed'
      : mode === 'enforce' ? 'enforcing'
        : mode === 'observe' ? 'observing'
          : !seen ? 'installed, idle'
            : 'installed, off';

  const elapsed = (ts) => {
    if (!ts) return '–';
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };
  const mins = (secs) => (!secs ? '0' : secs < 60 ? `${secs}s` : `${(secs / 60).toFixed(1)}m`);

  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Job admission' }),
      h('span', { class: `count ${mode === 'enforce' ? 'warn' : ''}`, text: state })
    ),

    h('p', { class: 'note', text:
      'The only limit in this fleet that applies to jobs as they START. Enforced by a ' +
      'job-started hook in each runner, not by this daemon — a job must be able to begin ' +
      'when the dashboard is down.' }),

    installedNone
      ? h('p', { class: 'note', text:
          `No runner references the hooks (0 of ${hooks.total}). Install them with ` +
          'scripts/install-hooks.sh --apply --restart. They stay inert until ' +
          'FLEET_ADMIT_MODE is set, so installing changes nothing on its own.' })
      : null,

    installedSome
      ? h('div', { class: 'err', text:
          `Only ${hooks.installed} of ${hooks.total} runners have the hooks. The others are ` +
          'unlimited and do not take a slot, so the concurrency count is an under-estimate. ' +
          'Re-run scripts/install-hooks.sh --apply.' })
      : null,

    counted && !installedNone && !mode && !seen
      ? h('p', { class: 'note', text:
          `Installed on ${hooks.installed} of ${hooks.total} runners, but no job has started on ` +
          'one yet, so whether FLEET_ADMIT_MODE is set cannot be read from here. The mode ' +
          'appears after the next job runs.' })
      : null,

    counted && !installedNone && !mode && seen
      ? h('p', { class: 'note', text:
          `Installed on ${hooks.installed} of ${hooks.total} runners and jobs are running, but no ` +
          'decisions recorded — FLEET_ADMIT_MODE is off. Set it to observe in fleet.env to see ' +
          'what a limit would have done before it can cost a build.' })
      : null,

    !counted
      ? h('p', { class: 'note', text:
          'Counting which runners reference the hooks — this happens on the slow loop, so it ' +
          'is not known for the first few minutes after a restart.' })
      : null,

    // 'fallback' means the hook could not find a Runner.Worker to own its slot.
    // Surfaced loudly because the symptom is silence: admission keeps reporting
    // success while counting nothing, so it never holds anything.
    a.ownerKind === 'fallback'
      ? h('div', { class: 'err', text:
          'A hook could not identify the Runner.Worker owning its job, so it fell back to its ' +
          'parent process. Slots may be released early and the limit under-enforced. This ' +
          'usually means the runner changed how it invokes hooks.' })
      : null,

    mode
      ? h('dl', { class: 'kv' },
          h('dt', { text: 'limit' }),
          h('dd', { text: a.limit != null ? `${a.limit} concurrent job(s)` : '–' }),
          h('dt', { text: 'last decision' }),
          h('dd', { text: a.lastDecisionAt ? new Date(a.lastDecisionAt).toLocaleTimeString() : '–' }),
          h('dt', { text: 'jobs started (24h)' }),
          h('dd', { text: String((c.admitted ?? 0) + (c.observed ?? 0) + (c.timeout ?? 0)) }),
          mode === 'observe' ? h('dt', { text: 'would have been held' }) : h('dt', { text: 'held' }),
          mode === 'observe'
            ? h('dd', { text: `${c['would-hold'] ?? 0} in 24h` })
            : h('dd', { text: `${c.held ?? 0} in 24h, ${mins(a.heldSeconds ?? 0)} total wait` }),
          mode === 'enforce' ? h('dt', { text: 'admitted at the time bound' }) : null,
          mode === 'enforce'
            ? h('dd', { class: (c.timeout ?? 0) > 0 ? 'warn' : 'muted',
                text: `${c.timeout ?? 0} — held to the limit then let through anyway` })
            : null
        )
      : null,

    waiting.length
      ? h('div', {},
          h('h4', { text: `Waiting now (${waiting.length})` }),
          h('table', { class: 'grid' },
            h('thead', {}, h('tr', {},
              h('th', { text: 'runner' }), h('th', { text: 'repo' }),
              h('th', { text: 'waiting' }), h('th', { text: 'why' })
            )),
            h('tbody', {}, waiting.map((w) =>
              h('tr', { class: 'is-warn' },
                h('td', { text: w.runner ?? '–' }),
                h('td', { text: (w.repo ?? '').split('/').pop() || '–' }),
                h('td', { text: elapsed(w.since) }),
                h('td', { class: 'muted', text: w.reason ?? '–' })
              )
            ))
          ))
      : null,

    mode === 'enforce'
      ? h('p', { class: 'note muted', text:
          'A held job is IN PROGRESS to GitHub, so its wait counts against its own ' +
          'timeout-minutes and is inside the durations on the Analytics tab. That is why the ' +
          'wait is bounded, and why every decision records how long it waited.' })
      : null
  );
}

function autoscalePanel(s) {
  const a = s.autoscale ?? {};
  const state = !a.enabled ? 'off' : a.dryRun ? 'dry run' : 'live';
  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Autoscaler' }),
      h('span', { class: `count ${a.enabled && !a.dryRun ? 'warn' : ''}`, text: state })
    ),
    h('dl', { class: 'kv' },
      h('dt', { text: 'last decision' }),
      h('dd', { text: a.at ? new Date(a.at).toLocaleTimeString() : 'not run yet' }),
      h('dt', { text: 'outcome' }),
      h('dd', { text: a.acted ? `acted: ${a.action}` : 'no action' }),
      h('dt', { text: 'why' }),
      h('dd', { text: a.reason ?? '–' })
    )
  );
}

function sizingPanel(s) {
  const rows = s.sizing ?? [];
  const short = (r) => r.split('/').pop();
  const under = rows.filter((r) => r.delta > 0);
  const canAct = control.hasToken();

  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Runners per repo' }),
      h('span', { class: 'count', text: `${under.length} under-provisioned` })
    ),
    h('p', { class: 'note', text:
      'Want is the 90th percentile of that repo\'s own CONCURRENT jobs — how many of its ' +
      'jobs wanted to run at the same moment — capped per repo. Not its peak: one repo here ' +
      'peaked at 33 simultaneous jobs, and sizing to that would encode the worst moment as ' +
      'normal. The queue is what covers the rest.' }),
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'repo' }), h('th', { text: 'have' }), h('th', { text: 'want' }),
        h('th', { text: 'why' }), h('th', { text: '' })
      )),
      h('tbody', {}, rows.map((r) =>
        h('tr', { class: r.delta > 0 ? 'is-warn' : '' },
          h('td', { text: short(r.repo) }),
          h('td', { text: String(r.have) }),
          h('td', { text: r.capped ? `${r.want} (capped)` : String(r.want) }),
          h('td', { class: 'muted', text: r.reason }),
          h('td', {},
            r.delta > 0 && canAct
              ? h('button', {
                  class: 'btn', text: 'Add one',
                  onclick: async () => {
                    // Cloned from an existing runner rather than registered from
                    // scratch: the action copies the sibling's labels, which is
                    // the part that is easy to get wrong by hand.
                    const sib = (getSnapshot()?.runners ?? []).find((x) => x.repo === r.repo);
                    if (!sib) return;
                    await addRunner(sib.name);
                  },
                })
              : null
          )
        )
      ))
    )
  );
}

// Whether the duplicates that already exist did any good. Deliberately placed
// above the settings: the case for or against turning autoscaling on should be
// read before the switch that turns it on.
function effectPanel(s) {
  const rows = s.scaleEffect ?? [];
  if (!rows.length) return null;
  const mins = (ms) => (ms == null ? '–' : `${(ms / 60000).toFixed(1)}m`);

  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Did adding a runner help?' }),
      h('span', { class: 'count', text: `${rows.length} repo(s) with a duplicate` })
    ),
    h('p', { class: 'note', text:
      '90th-percentile queue wait before and after each repo\'s second runner appeared — not the ' +
      'median, which is about six seconds fleet-wide and would make every duplicate look ' +
      'pointless. Observational, not a controlled comparison: a repo that got slower for ' +
      'unrelated reasons will look like the runner did nothing.' }),
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'repo' }), h('th', { text: 'p90 before' }), h('th', { text: 'p90 after' }),
        h('th', { text: 'change' }), h('th', { text: 'jobs' })
      )),
      h('tbody', {}, rows.map((r) => {
        const delta = r.beforeMs - r.afterMs;
        const better = delta > 0;
        return h('tr', {},
          h('td', { text: r.repo.split('/').pop() }),
          h('td', { text: mins(r.beforeMs) }),
          h('td', { text: mins(r.afterMs) }),
          h('td', { class: better ? 'good' : 'muted',
            text: `${better ? '−' : '+'}${mins(Math.abs(delta))}` }),
          h('td', { class: 'muted', text: `${r.beforeN} → ${r.afterN}` })
        );
      }))
    )
  );
}

function field(spec) {
  const id = `set-${spec.key}`;
  const busy = saving === spec.key;

  if (spec.type === 'bool') {
    return h('div', { class: 'set-row' },
      h('label', { for: id, text: spec.label }),
      h('input', {
        id, type: 'checkbox', checked: Boolean(spec.value), disabled: busy,
        onchange: (e) => save(spec.key, { value: e.target.checked }),
      }),
      sourceTag(spec)
    );
  }

  if (spec.type === 'list') {
    return h('div', { class: 'set-row' },
      h('label', { for: id, text: spec.label }),
      h('input', {
        id, type: 'text', value: (spec.value ?? []).join(' '), disabled: busy,
        placeholder: 'space separated',
        onchange: (e) => save(spec.key, { value: e.target.value }),
      }),
      sourceTag(spec)
    );
  }

  return h('div', { class: 'set-row' },
    h('label', { for: id, text: spec.label }),
    h('input', {
      id, type: 'number', value: String(spec.value ?? ''), disabled: busy,
      min: spec.min ?? undefined, max: spec.max ?? undefined,
      onchange: (e) => save(spec.key, { value: e.target.value }),
    }),
    sourceTag(spec)
  );
}

// Which layer the value came from. Without this, "the plist says 3 but this says
// 8" has no explanation anywhere in the product.
function sourceTag(spec) {
  if (spec.source === 'setting') {
    return h('span', { class: 'src' },
      h('span', { text: 'edited here' }),
      h('button', {
        class: 'btn tiny', text: 'reset',
        title: 'Remove the stored value so the environment or default applies again',
        onclick: () => save(spec.key, { reset: true }),
      })
    );
  }
  return h('span', { class: 'src muted', text: spec.source });
}

function settingsPanel() {
  if (!settings) return h('div', { class: 'panel' }, h('p', { text: 'settings unavailable' }));
  const all = settings.settings ?? [];
  const group = (keys) => all.filter((s) => keys.includes(s.key));

  return h('div', { class: 'panel' },
    h('div', { class: 'section-head' },
      h('h2', { text: 'Settings' }),
      h('span', { class: 'count', text: control.hasToken() ? 'editable' : 'locked' })
    ),
    lastError ? h('div', { class: 'err', text: lastError }) : null,
    h('p', { class: 'note', text:
      'Changes apply on the next collector tick — no restart. The environment SEEDS these ' +
      'values; once edited here, the stored value wins, so editing the plist afterwards has ' +
      'no effect until you reset the row.' }),

    h('h4', { text: 'Capacity' }),
    group(['maxTotalRunners', 'ceiling', 'loadPerCore', 'minFreeDiskGb', 'maxSwapinsPerSec',
      'blockOnPressure', 'maxInstancesPerRepo']).map(field),

    h('h4', { text: 'Autoscaling' }),
    group(['autoscale', 'autoscaleDryRun', 'scaleDown', 'minQueuedMs', 'scaleCooldownMs',
      'idleTtlMs']).map(field),

    h('h4', { text: 'Grouping' }),
    group(['groupsEnabled', 'groupMin', 'groupIgnore', 'projects']).map(field),

    h('p', { class: 'note muted', text: `Set only in the environment: ${(settings.envOnly ?? []).join(', ')}` })
  );
}

const ms = (n) => (n == null ? '–' : n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n / 60_000)}m`);

// Better or worse, and by how much. Queue waits and SLO breaches improve when
// they go DOWN, runner-hours going up is a cost rather than a win — so the
// direction that counts as good is per-metric rather than global.
function deltaCell(value, lowerIsBetter = true) {
  if (value == null) return h('td', { class: 'num', text: '–' });
  if (value === 0) return h('td', { class: 'num muted', text: 'no change' });
  const better = lowerIsBetter ? value < 0 : value > 0;
  const sign = value > 0 ? '+' : '';
  return h('td', { class: `num ${better ? 'good' : 'warn'}`, text: `${sign}${ms(Math.abs(value)) === '–' ? value : (value < 0 ? '-' : '+') + ms(Math.abs(value))}` });
}

// What the fleet would have done with a different number of runners, replayed
// over real arrivals. Kept visually distinct from the Analytics tab because the
// numbers look the same and are not: the durations are measured, the waits are
// counterfactual.
function simulationPanel() {
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Scenario replay' }),
      h('button', {
        class: 'btn tiny', text: loadingSim ? 'replaying…' : (sim ? 'Re-run' : 'Run replay'),
        disabled: loadingSim,
        onclick: () => loadSimulation({ days: 30 }),
      })
    ),
    h('div', { class: 'panel-sub' },
      'Replays the last 30 days of real job arrivals and real durations against a different number '
      + 'of runners. Job durations are measured; queue waits are simulated. The proposal is the '
      + 'sizing recommendation below unless you have overridden it.'),
    sim?.error
      ? h('div', { class: 'empty', text: `Replay failed: ${sim.error}` })
      : !sim
        ? h('div', { class: 'empty', text: 'Not run yet. Replaying sweeps a month of job history, so it is on demand rather than automatic.' })
        : h('div', {},
            h('div', { class: 'panel-sub muted',
              text: `${sim.jobsConsidered} jobs replayed over ${sim.days} days.` }),
            h('table', { class: 'mini-table' },
              h('thead', {}, h('tr', {},
                h('th', { text: '' }),
                h('th', { class: 'num', text: 'Now' }),
                h('th', { class: 'num', text: 'Proposed' }),
                h('th', { class: 'num', text: 'Change' })
              )),
              h('tbody', {},
                [
                  ['Median queue wait', 'p50WaitMs', true, true],
                  ['p90 queue wait', 'p90WaitMs', true, true],
                  ['p95 queue wait', 'p95WaitMs', true, true],
                  ['Jobs over 5m SLO', 'overSloCount', true, false],
                  ['Peak simultaneous jobs', 'peakSimultaneous', false, false],
                  ['Runner-hours', 'totalRunnerHours', false, false],
                ].map(([label, key, lowerIsBetter, isTime]) =>
                  h('tr', {},
                    h('td', { text: label }),
                    h('td', { class: 'num', text: isTime ? ms(sim.current?.[key]) : String(sim.current?.[key] ?? '–') }),
                    h('td', { class: 'num', text: isTime ? ms(sim.proposed?.[key]) : String(sim.proposed?.[key] ?? '–') }),
                    isTime
                      ? deltaCell(sim.delta?.[key], lowerIsBetter)
                      : h('td', { class: `num ${sim.delta?.[key] === 0 ? 'muted' : (lowerIsBetter ? (sim.delta?.[key] < 0 ? 'good' : 'warn') : '')}`,
                          text: sim.delta?.[key] == null ? '–' : sim.delta[key] === 0 ? 'no change' : `${sim.delta[key] > 0 ? '+' : ''}${sim.delta[key]}` })
                  )
                )
              )
            ),
            // The scenario itself, so a surprising result can be checked against
            // what was actually simulated rather than assumed.
            h('div', { class: 'panel-sub muted', text: Object.entries(sim.proposedCounts ?? {})
              .filter(([repo, n]) => (sim.currentCounts?.[repo] ?? 0) !== n)
              .map(([repo, n]) => `${repo.split('/').pop()}: ${sim.currentCounts?.[repo] ?? 0} → ${n}`)
              .join(' · ') || 'The proposal is identical to the current fleet, so nothing changes.' })
          )
  );
}

// Predicted demand, and the gate that keeps it from acting.
function forecastPanel() {
  const gate = forecast?.gate;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h3', { text: 'Burst forecast' }),
      h('span', { class: 'count', text: 'shadow mode' }),
      h('button', {
        class: 'btn tiny', text: loadingForecast ? 'loading…' : (forecast ? 'Refresh' : 'Load forecast'),
        disabled: loadingForecast,
        onclick: () => loadForecast(),
      })
    ),
    h('div', { class: 'panel-sub' },
      'Weekday and time-of-day patterns from job history, plus the cron schedules in your workflow '
      + 'files. A history pattern needs three separate weeks before it counts; a cron schedule counts '
      + 'immediately, because it is a statement of fact rather than a prediction. '
      + 'Nothing acts on any of this — see the gate below.'),
    forecast?.error
      ? h('div', { class: 'empty', text: `Forecast failed: ${forecast.error}` })
      : !forecast
        ? h('div', { class: 'empty', text: 'Not loaded yet.' })
        : h('div', {},
            h('div', { class: 'panel-sub muted',
              text: `Learned from ${forecast.weeksCovered} weeks of history `
                + `(${forecast.bucketsLearned} time buckets, ${forecast.schedulesFound} cron schedules).` }),
            forecast.predictions?.length
              ? h('table', { class: 'mini-table' },
                  h('thead', {}, h('tr', {},
                    h('th', { text: 'When' }),
                    h('th', { class: 'num', text: 'Expected concurrent' }),
                    h('th', { text: 'Confidence' }),
                    h('th', { text: 'Why' })
                  )),
                  h('tbody', {}, forecast.predictions.map((p) =>
                    h('tr', {},
                      h('td', { text: new Date(p.windowStart).toLocaleString(undefined,
                        { weekday: 'short', hour: 'numeric' }) }),
                      h('td', { class: 'num', text: String(p.totalExpectedConcurrent) }),
                      h('td', { class: p.confidence === 'high' ? 'good' : p.confidence === 'low' ? 'muted' : '',
                        text: p.confidence }),
                      h('td', { class: 'mini', text: p.repos.map((r) => `${r.repo.split('/').pop()}: ${r.evidence}`).join('; ') })
                    )
                  ))
                )
              : h('div', { class: 'all-clear' }, h('b', { text: '✓' }),
                  ' No recurring bursts predicted in the next 12 hours. Either demand is even, or '
                  + 'there is not enough repeated history yet to call anything a pattern.'),
            gate
              ? h('div', { class: gate.passed ? 'all-clear' : 'note' },
                  gate.passed
                    ? `Evaluation gate PASSED over ${gate.count} scored windows `
                      + `(precision ${gate.precision?.toFixed(2)}, recall ${gate.recall?.toFixed(2)}). `
                      + 'Pre-warming may be enabled, and remains subject to headroom and fleet caps.'
                    : `Evaluation gate not met, so pre-warming stays locked: ${gate.reasons.join('; ')}. `
                      + 'The daemon scores one window per hour in the background; this unlocks itself '
                      + 'once the numbers hold up.'
                )
              : null
          )
  );
}

export function render() {
  const s = getSnapshot();
  const el = document.getElementById('view-capacity');
  if (!el) return;
  if (!s) {
    mount(el, h('p', { text: 'waiting for the first snapshot…' }));
    return;
  }
  // Admission sits directly under headroom: the two are the same question asked
  // about different things — may we add a runner, and may this job start — and
  // reading them apart is what stops the ceiling being mistaken for a job cap.
  //
  // Replay and forecast go last, after the measured panels. They are the two
  // that are not observations, and putting them below everything that is keeps
  // that distinction in the layout rather than only in the wording.
  mount(el, headroomPanel(s), admissionPanel(s), autoscalePanel(s), sizingPanel(s),
    effectPanel(s), simulationPanel(), forecastPanel(), settingsPanel());
}
