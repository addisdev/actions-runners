// An independent watchdog for the dashboard.
//
// fleetd already alerts on drift and host pressure, and does it better than a
// poller could — it has the state transitions in hand. This exists for the one
// condition fleetd structurally cannot report: fleetd itself being down. A
// daemon cannot notify you about its own absence, and `KeepAlive` restarting a
// process that crash-loops still leaves the fleet unwatched between restarts.
//
// So this is deliberately not a second alerting engine. It records health
// transitions to a log that survives reboots, and it shouts when the thing that
// does the real alerting stops answering.
//
// Sentinels, greppable and stable: FLEET_PROBLEM / FLEET_RECOVERED /
// FLEET_UNREACHABLE.
import { execFile } from 'node:child_process';

const BASE = process.env.FLEET_BASE ?? `http://127.0.0.1:${process.env.FLEET_PORT ?? 7878}`;
const EVERY_MS = Number(process.env.WATCH_MS ?? 30000);
const HEARTBEAT_EVERY = Number(process.env.WATCH_HEARTBEAT ?? 20);
const NOTIFY = process.env.WATCH_NOTIFY === '1';

// A fault must survive this many consecutive polls before it is reported.
//
// Two reasons, both measured on this host. At boot, launchd brings fleetd up
// before seventeen runners have registered, so a watcher without a sustain
// reports a broken fleet every reboot — and an alarm that fires on every
// healthy boot is one you learn to skip. And the `offline` drift kind here
// self-resolves in 46-280s; fleetd's own autofix waits 5 minutes before acting
// on it for exactly that reason. One poll of patience is the cheapest version
// of the same idea.
const SUSTAIN = Number(process.env.WATCH_SUSTAIN ?? 2);

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (...m) => console.log(`[${stamp()}]`, ...m);
const notify = (title, message) => {
  if (!NOTIFY || process.platform !== 'darwin') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('/usr/bin/osascript', [
    '-e', `display notification "${esc(message).slice(0, 500)}" with title "${esc(title)}"`,
  ], { timeout: 10000 }, (err) => {
    if (err) say('watch notification failed:', err.message);
  });
};

async function grab(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// Everything wrong right now, as one stable string. Comparing signatures rather
// than a boolean means a *new* fault arriving during an existing one is still a
// change, and still gets reported.
async function probe() {
  const [health, alerts] = await Promise.all([grab('/api/health'), grab('/api/alerts')]);
  const faults = [];
  if (health.ok !== true) faults.push('collector-not-ok');
  if (health.lastError) faults.push(`collector-error: ${health.lastError}`);
  if (health.drift > 0) faults.push(`drift x${health.drift}`);
  // Dismissed conditions stay in `open` so the bridge keeps repairing them, but
  // a watcher exists to shout — reporting something the operator has already
  // waved away would make the signature change on a decision rather than on a
  // fault, which is the opposite of what it is for.
  const audible = (alerts.open ?? []).filter((a) => !a.dismissed_at);
  for (const a of audible) faults.push(`${a.rule}: ${a.title}`);
  return {
    sig: faults.sort().join(' | '),
    runners: health.runners,
    drift: health.drift,
    open: audible.length,
  };
}

let reported = null;    // the signature currently reported, null until first verdict
let pending = null;     // a signature seen but not yet sustained
let pendingFor = 0;
let quietPolls = 0;

async function tick() {
  let snap;
  try {
    snap = await probe();
  } catch (err) {
    snap = { sig: `unreachable: ${err.message}`, unreachable: true };
  }

  // Recovery is reported immediately; only faults wait to be sustained. Waiting
  // to confirm good news is how a fixed fleet keeps looking broken.
  if (!snap.sig) {
    pending = null;
    pendingFor = 0;
    if (reported !== '' && reported !== null) {
      say('FLEET_RECOVERED — all clear:', `${snap.runners} runners, 0 drift, 0 open alerts`);
      notify('Runner fleet recovered', `${snap.runners} runners; all clear`);
      quietPolls = 0;
    } else if (reported === null) {
      say(`watch started — healthy: ${snap.runners} runners, 0 drift, 0 open alerts`);
    }
    reported = '';
  } else if (snap.sig === reported) {
    pending = null;
    pendingFor = 0;
  } else {
    if (snap.sig === pending) pendingFor += 1;
    else { pending = snap.sig; pendingFor = 1; }

    if (pendingFor >= SUSTAIN) {
      const tag = snap.unreachable ? 'FLEET_UNREACHABLE' : 'FLEET_PROBLEM';
      const where = snap.unreachable ? '' : ` (${snap.open} open alert(s), drift ${snap.drift})`;
      say(`${tag}${where}:`, snap.sig, `[sustained ${pendingFor} polls]`);
      notify(snap.unreachable ? 'Runner fleet unreachable' : 'Runner fleet problem', snap.sig);
      reported = snap.sig;
      pending = null;
      pendingFor = 0;
      quietPolls = 0;
    }
  }

  quietPolls += 1;
  if (quietPolls % HEARTBEAT_EVERY === 0) {
    say(reported ? `still degraded: ${reported}` : `steady: ${snap.runners} runners, 0 drift, 0 open alerts`);
  }
}

say(`watching ${BASE} every ${EVERY_MS / 1000}s, sustain ${SUSTAIN}`);
await tick();
setInterval(() => { tick().catch((e) => say('watch error:', e.message)); }, EVERY_MS);
