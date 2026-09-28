// Notifications on this device — the browser half of ../lib/push.js.
//
// A subscription is made against the daemon's VAPID key and registered with a
// paired device's token, so revoking the device on the host silences it too.
// Everything that can stop push from working (plain HTTP, iOS outside a Home
// Screen app, a blocked permission, no token) is named in the panel rather than
// leaving a button that does nothing.

import { chartEl as h } from './charts.js';

const SEVERITY_KEY = 'fleet-push-min-severity';
const SEVERITIES = [
  { value: 'critical', label: 'Critical only' },
  { value: 'warning', label: 'Warnings and critical' },
  { value: 'info', label: 'Everything' },
];

let deps = { hasToken: () => false, authHeaders: () => ({}), rerender: () => {} };
const state = {
  loaded: false,
  serverDisabled: false,
  subscribed: false,
  minSeverity: localStorage.getItem(SEVERITY_KEY) ?? 'warning',
  busy: null,
  notice: null,
  error: null,
};

export function configureNotifications(d) { deps = { ...deps, ...d }; }

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const IOS_HINT = 'On iPhone and iPad, notifications only work from the Home Screen app: tap Share, choose '
  + '"Add to Home Screen", then open the dashboard from that icon. Needs iOS 16.4 or later.';

// Returns { ok } or { ok: false, reason }. Ordered so the first reason is the
// one to fix first.
export function eligibility() {
  if (!isSecureContext) {
    return {
      ok: false,
      reason: 'Notifications need HTTPS. Open the dashboard at its Tailscale address '
        + '(./fleetctl.sh remote status lists it) instead of a plain http:// LAN address.',
    };
  }
  if (isIos() && !isStandalone()) return { ok: false, reason: IOS_HINT };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'This browser does not support web push notifications.' };
  }
  if (state.serverDisabled) {
    return { ok: false, reason: 'Push is turned off on this daemon ("push": false in alerts.config.json).' };
  }
  if (Notification.permission === 'denied') {
    return {
      ok: false,
      reason: 'Notifications are blocked for this site. Allow them in the browser or system settings, then reload.',
    };
  }
  if (!deps.hasToken()) {
    return {
      ok: false,
      reason: 'Pair this device first. Notifications belong to a paired device, so revoking it silences them.',
    };
  }
  return { ok: true };
}

function keyBytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a, b) => {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

async function currentSubscription() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...deps.authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status });
  return json;
}

async function serverKey() {
  const res = await fetch('/api/push/key', { cache: 'no-store' });
  if (res.status === 404) {
    state.serverDisabled = true;
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.publicKey) throw new Error(body.error ?? `HTTP ${res.status}`);
  state.serverDisabled = false;
  return keyBytes(body.publicKey);
}

async function register(sub, minSeverity) {
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), minSeverity } });
  state.subscribed = true;
  state.minSeverity = minSeverity;
  localStorage.setItem(SEVERITY_KEY, minSeverity);
}

// Brings the panel in line with reality and quietly repairs the two ways a
// subscription goes stale without the user doing anything: the daemon rotated
// its VAPID key, or it pruned the subscription after the push service
// reported it gone.
export async function refreshNotifications() {
  try {
    if (!isSecureContext || !('PushManager' in window)) return;
    const key = await serverKey().catch(() => null);
    const sub = await currentSubscription();
    if (!sub || !deps.hasToken() || state.serverDisabled) {
      state.subscribed = false;
      return;
    }
    if (key && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {});
      const reg = await registration();
      const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await register(fresh, state.minSeverity);
      return;
    }
    const status = await api(`/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`);
    if (status.subscribed) {
      state.subscribed = true;
      state.minSeverity = status.minSeverity ?? state.minSeverity;
    } else {
      await register(sub, state.minSeverity);
    }
  } catch (err) {
    if (err.status !== 403) {
      state.subscribed = false;
      state.error = `Could not check notifications: ${err.message}. Turn them off and on again if alerts stop arriving.`;
    }
  } finally {
    state.loaded = true;
  }
}

async function run(label, fn) {
  state.busy = label;
  state.error = null;
  state.notice = null;
  deps.rerender();
  try {
    await fn();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = null;
    deps.rerender();
  }
}

function enable(minSeverity) {
  // requestPermission comes first, before any await: Safari only shows the
  // prompt while the tap that asked for it still counts as a user gesture.
  const permission = Notification.requestPermission();
  return run('enable', async () => {
    if ((await permission) !== 'granted') {
      throw new Error('Notification permission was not granted.');
    }
    const key = await serverKey();
    if (!key) throw new Error('Push is turned off on this daemon.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await register(sub, minSeverity);
    state.notice = 'Notifications are on for this device. Send a test to check they arrive.';
  });
}

function disable() {
  return run('disable', async () => {
    const sub = await currentSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    state.subscribed = false;
    state.notice = 'Notifications are off for this device.';
  });
}

function changeSeverity(minSeverity) {
  return run('severity', async () => {
    const sub = await currentSubscription();
    if (!sub) throw new Error('This device is no longer subscribed. Turn notifications on again.');
    await register(sub, minSeverity);
    state.notice = `Saved: ${SEVERITIES.find((s) => s.value === minSeverity)?.label.toLowerCase()}.`;
  });
}

function sendTest() {
  return run('test', async () => {
    const sub = await currentSubscription();
    if (!sub) throw new Error('This device is no longer subscribed. Turn notifications on again.');
    await api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
    state.notice = 'Test sent. It should arrive within a few seconds, even with the dashboard closed.';
  });
}

// The Home Screen icon carries the open-alert count, like a native app would.
export function updateAppBadge(count) {
  if (!('setAppBadge' in navigator) || !Number.isFinite(count)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

export function notificationsPanel() {
  const verdict = eligibility();
  const severitySelect = h('select', {
    class: 'input', id: 'push-severity', 'aria-label': 'Which alerts to send',
    disabled: state.busy ? 'disabled' : null,
  }, SEVERITIES.map((s) => h('option', {
    value: s.value, text: s.label, selected: s.value === state.minSeverity ? 'selected' : null,
  })));
  if (state.subscribed) severitySelect.addEventListener('change', () => changeSeverity(severitySelect.value));

  const busyText = (label, text) => (state.busy === label ? `${text}…` : text);
  const actions = !verdict.ok
    ? null
    : state.subscribed
      ? h('div', { class: 'row-actions' },
          severitySelect,
          h('button', { class: 'btn', text: busyText('test', 'Send test'), disabled: state.busy ? 'disabled' : null, onclick: sendTest }),
          h('button', { class: 'btn', text: busyText('disable', 'Turn off'), disabled: state.busy ? 'disabled' : null, onclick: disable }))
      : h('div', { class: 'row-actions' },
          severitySelect,
          h('button', {
            class: 'btn primary', text: busyText('enable', 'Turn on notifications'),
            disabled: state.busy ? 'disabled' : null,
            onclick: () => enable(severitySelect.value),
          }));

  const statusFlag = !verdict.ok ? h('span', { class: 'flag muted', text: 'unavailable' })
    : state.subscribed ? h('span', { class: 'flag good', text: 'on' })
      : h('span', { class: 'flag muted', text: 'off' });

  return h('div', { class: 'panel', id: 'notifications-panel' },
    h('div', { class: 'panel-head' }, h('h3', { text: 'Notifications on this device' }), statusFlag),
    h('div', { class: 'panel-sub' },
      'Alerts reach this device even when the dashboard is closed and the phone is off your tailnet. '
        + 'Messages are end-to-end encrypted to this device; the push service only relays them. '
        + 'A resolution replaces the alert it resolves.'),
    verdict.ok ? null : h('div', { class: 'pair-notice warn', text: verdict.reason }),
    state.notice ? h('div', { class: 'pair-notice ok', role: 'status', text: state.notice }) : null,
    state.error ? h('div', { class: 'pair-notice err', role: 'alert', text: state.error }) : null,
    actions);
}
