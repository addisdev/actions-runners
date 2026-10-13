// A host's on/off switch: whether the Mac takes CI jobs at all.
//
// The same control on the Fleet tab and the Hosts tab, so "switch this machine
// off" is one click wherever the machine is on screen. Off runs
// scripts/host-drain.sh --off on that host (directly for this machine, through
// its agent for another); on runs --on. Turning off is not instant — a busy
// runner finishes its job first — so that state is shown rather than hidden.

import { chartEl as h } from './charts.js';
import * as control from './control.js';

// A click is shown as in flight until the host reports the new state. A
// remote host only reports on its next heartbeat, and this machine on the
// next tick, so without this the switch would flip back for half a minute.
const pending = new Map();
const PENDING_MS = 3 * 60 * 1000;

// 'on' | 'paused' (on, new runners paused) | 'turning-off' | 'off'
export function hostMode(summary) {
  if (summary?.off) return summary.drainingCount > 0 ? 'turning-off' : 'off';
  if (summary?.drained) return 'paused';
  return 'on';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (list, max = 6) =>
  list.slice(0, max).join(', ') + (list.length > max ? `, and ${list.length - max} more` : '');

// What this click would do, beyond the action's standing confirmation.
export function offImpactText(impact) {
  if (!impact) return null;
  const lines = [];
  if (impact.busy?.length) {
    lines.push(`${plural(impact.busy.length, 'job')} running now will finish first: ${short(impact.busy)}.`);
  }
  if (impact.stranded?.length) {
    lines.push(
      `No other host has a runner online for ${plural(impact.stranded.length, 'repo')}, so their jobs will queue ` +
      `until this host is back on: ${short(impact.stranded.map((r) => String(r).split('/').pop()))}.`
    );
  }
  return lines.join('\n\n') || null;
}

function stateText(mode, summary) {
  switch (mode) {
    case 'turning-off': return `Turning off · ${plural(summary.drainingCount, 'job')} finishing`;
    case 'off': return 'Off · takes no CI jobs';
    case 'paused': return 'On · new runners paused';
    default: return 'On · takes CI jobs';
  }
}

/**
 * @param {object}   summary   - a host summary (snapshot.hosts / /api/hosts)
 * @param {object}   [opts]
 * @param {object}   [opts.impact]   - switchOffImpact() for this host
 * @param {Function} [opts.onChange] - re-render after a click settles
 */
export function hostSwitch(summary, { impact = null, onChange = () => {} } = {}) {
  const id = summary.id;
  const mode = hostMode(summary);
  const isOn = mode === 'on' || mode === 'paused';
  const wait = pending.get(id);
  if (wait && (Date.now() - wait.at > PENDING_MS || (wait.want === 'off') === !isOn)) pending.delete(id);
  const inFlight = pending.get(id);

  const locked = !control.hasToken();
  const disabled = locked || summary.stale || Boolean(inFlight);
  const why = locked
    ? 'Unlock the Control tab to switch hosts on or off'
    : summary.stale ? 'This host is not reporting; a switch would not reach it'
      : inFlight ? 'Waiting for the host to report the change'
        : isOn ? `Stop ${summary.name} taking CI jobs` : `Let ${summary.name} take CI jobs again`;

  const label = inFlight
    ? (inFlight.want === 'off' ? 'Switching off…' : 'Switching on…')
    : stateText(mode, summary);

  return h('div', { class: `host-switch mode-${mode}${inFlight ? ' is-pending' : ''}` },
    h('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(inFlight ? inFlight.want === 'on' : isOn),
      'aria-label': `${summary.name} takes CI jobs`,
      title: why,
      disabled: disabled ? 'disabled' : null,
      onclick: async () => {
        const want = isOn ? 'off' : 'on';
        const args = { hostId: id };
        const onStart = () => {
          pending.set(id, { want, at: Date.now() });
          onChange();
        };
        const res = want === 'off'
          ? await control.confirmAct('host.off', args, { detail: offImpactText(impact), onStart })
          : await control.confirmAct('host.on', args, { onStart });
        if (!res) return;
        if (res.ok) {
          pending.set(id, { want, at: Date.now() });
        } else {
          pending.delete(id);
          alert(`Could not switch ${summary.name} ${want}: ${res.error || res.output}`);
        }
        onChange();
      },
    }, h('span', { class: 'switch-knob' })),
    h('span', { class: 'switch-label', text: label })
  );
}
