// UI contract tests for operator-facing dashboard rendering.
//
// Static source checks — same approach as kpi-nav.test.js. Verifies that the
// client wires queue diagnosis, staleness, federation panels, and remediation
// without needing a browser or build step.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8');
const hosts = readFileSync(join(HERE, '..', 'public', 'hosts.js'), 'utf8');
const capacity = readFileSync(join(HERE, '..', 'public', 'capacity.js'), 'utf8');
const html = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8');
const css = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8');

describe('queue diagnosis rendering contract', () => {
  test('queueDiagnosisPanel renders cause, confidence, recommendation, and evidence', () => {
    assert.match(app, /function queueDiagnosisPanel\(d\)/);
    assert.match(app, /queue-cause cause-/);
    assert.match(app, /queue-confidence/);
    assert.match(app, /queue-recommend/);
    assert.match(app, /queue-evidence/);
    assert.match(app, /d\.evidence\.map/);
  });

  test('queue evidence stays open across live snapshot re-renders', () => {
    assert.match(app, /const openQueueEvidence = new Set\(\)/);
    assert.match(app, /open: openQueueEvidence\.has\(evidenceKey\)/);
    assert.match(app, /ontoggle:/);
    assert.match(app, /openQueueEvidence\.add\(evidenceKey\)/);
    assert.match(app, /openQueueEvidence\.delete\(evidenceKey\)/);
  });

  test('stale queued runs expose a clear one-click cancellation action', () => {
    assert.match(app, /probable GitHub-side hold/);
    assert.match(app, /remediation\.label/);
    assert.match(app, /control\.act\(remediation\.action, \{ repo: d\.repo, runId: d\.id \}\)/);
    assert.match(app, /Unlock the Control tab to run this action/);
  });

  test('Fleet queued rows attach diagnosis from snapshot.queue', () => {
    assert.match(app, /queueDiagnosisPanel\(q\)/);
    assert.match(app, /s\.queue/);
  });

  test('Runs active rows join queue causes by run id', () => {
    assert.match(app, /function queueCauseMap\(s\)/);
    assert.match(app, /diagnosis: causes\.get\(r\.id\)/);
    assert.match(app, /queueDiagnosisPanel\(diagnosis\)/);
  });
});

describe('connection staleness contract', () => {
  test('uses collector stale threshold aligned with fleetd default', () => {
    assert.match(app, /COLLECTOR_STALE_MS = 240_000/);
  });

  test('polls /api/health and shows stale state instead of Live', () => {
    assert.match(app, /function pollHealth\(\)/);
    assert.match(app, /fetch\('\/api\/health'\)/);
    assert.match(app, /dot is-stale/);
    assert.match(app, /Collector stalled|Stale/);
  });

  test('stale dot styles exist in CSS', () => {
    assert.match(css, /\.dot\.is-stale/);
  });
});

describe('long-running job indicator contract', () => {
  test('longRunningIndicator checks snapshot flags and expected duration fields', () => {
    assert.match(app, /function longRunningIndicator\(r\)/);
    assert.match(app, /expectedDurationMs|expectedMs|p95DurationMs|durationP95Ms/);
    assert.match(app, /r\.longRunning|r\.isLongRunning|r\.slow/);
    assert.match(css, /\.chip\.long-running/);
  });
});

describe('partially running workflow contract', () => {
  test('a queued workflow with an executing job is shown as running', () => {
    assert.match(app, /function liveRunState\(r\)/);
    assert.match(app, /j\.status === 'in_progress'/);
    assert.match(app, /const liveState = live \? liveRunState\(r\) : null/);
    assert.match(app, /liveState\?\.status/);
    assert.match(app, /text: `\$\{liveState\.queued\} queued`/);
  });

  test('the queued KPI counts jobs rather than workflow rows', () => {
    assert.match(app, /function queuedJobCount\(runs\)/);
    assert.match(app, /const queued = queuedJobCount\(s\.active \?\? \[\]\)/);
  });
});

describe('queued KPI navigation contract', () => {
  test('Queued tile navigates to fleet queue section', () => {
    assert.match(app, /label: 'Queued'[\s\S]*?onclick: kpiNav\('fleet', '#fleet-queue'\)/);
  });
});

describe('remediation panel contract', () => {
  test('fetches remediation candidates and degrades gracefully', () => {
    assert.match(app, /function loadRemediation\(\)/);
    assert.match(app, /\/api\/remediation-candidates/);
    assert.match(app, /function remediationSection\(\)/);
    assert.match(app, /nothing pending/);
  });
});

describe('federation hosts UI contract', () => {
  test('renders fleet capacity, placements, and pending commands from /api/hosts', () => {
    assert.match(hosts, /function fleetCapacityPanel/);
    assert.match(hosts, /function placementsPanel/);
    assert.match(hosts, /function pendingCommandsPanel/);
    assert.match(hosts, /data\.recentPlacements/);
    assert.match(hosts, /data\.pendingCommands/);
  });

  test('hosts tab auto-refreshes while active and shows vitals with actions', () => {
    assert.match(hosts, /export function setActive/);
    assert.match(hosts, /REFRESH_MS/);
    assert.match(hosts, /fetch\('\/api\/hosts'\)/);
    assert.match(hosts, /text: 'load'/);
    assert.match(hosts, /text: 'memory'/);
    assert.match(hosts, /text: 'disk'/);
    assert.match(hosts, /fleet\.healthRepair/);
    assert.match(hosts, /host\.drain/);
    assert.match(hosts, /host\.resume/);
    assert.match(hosts, /control\.confirmAct/);
    assert.match(hosts, /scope: 'col'/);
    assert.match(app, /hosts\.setActive/);
  });
});

describe('multi-host fleet UI contract', () => {
  test('federation summary bar and header use snapshot.federation', () => {
    assert.match(html, /id="federation-summary"/);
    assert.match(app, /function renderFederationSummary\(s\)/);
    assert.match(app, /s\.federation/);
    assert.match(app, /fleetCapacityOk/);
    assert.match(css, /\.federation-summary/);
  });

  test('fleet view groups host-first when federated', () => {
    assert.match(app, /function isFederated\(s\)/);
    assert.match(app, /function hostSection\(/);
    assert.match(app, /s\.fleetRunners/);
    assert.match(app, /class: 'host-block'/);
    assert.match(css, /\.host-block/);
  });

  test('remote runner rows and drawer show host attribution', () => {
    assert.match(app, /function hostAttributionChip/);
    assert.match(app, /function runHostLabel/);
    assert.match(app, /hostLabel:/);
    assert.match(app, /host-attrib-line/);
    assert.match(css, /\.chip\.host-attrib/);
  });

  test('capacity distinguishes local and fleet headroom with autoscale host/mode/deficit', () => {
    assert.match(capacity, /function headroomBlock/);
    assert.match(capacity, /headroomBlock\('This host'/);
    assert.match(capacity, /headroomBlock\('Fleet-wide'/);
    assert.match(capacity, /s\.fleetCapacity/);
    assert.match(capacity, /h\('dt', \{ text: 'host' \}\)/);
    assert.match(capacity, /h\('dt', \{ text: 'mode' \}\)/);
    assert.match(capacity, /h\('dt', \{ text: 'remaining deficit' \}\)/);
    assert.match(capacity, /a\.deficit/);
  });
});

describe('accessibility contract', () => {
  test('skip link targets main content landmark', () => {
    assert.match(html, /class="skip-link" href="#main-content"/);
    assert.match(html, /id="main-content"/);
    assert.match(css, /\.skip-link/);
  });

  test('runner tiles expose aria labels in federated fleet', () => {
    assert.match(app, /'aria-label': `\$\{r\.name\} on/);
  });
});

describe('mobile layout contracts', () => {
  test('index.html has viewport-fit=cover', () => {
    assert.match(html, /viewport-fit=cover/);
  });

  test('index.html has bottom nav with primary tabs', () => {
    assert.match(html, /bottom-nav/);
    assert.match(html, /bnav-fleet/);
    assert.match(html, /bnav-runs/);
    assert.match(html, /bnav-alerts/);
    assert.match(html, /bnav-hosts/);
    assert.match(html, /bnav-more/);
  });

  test('index.html has more-sheet for secondary tabs', () => {
    assert.match(html, /more-sheet/);
  });

  test('style.css defines .bottom-nav', () => {
    assert.match(css, /\.bottom-nav/);
  });

  test('style.css has .table-scroll for wide table containers', () => {
    assert.match(css, /\.table-scroll/);
  });

  test('app.js has visibilitychange reconnect for SSE', () => {
    assert.match(app, /visibilitychange/);
    assert.match(app, /connect\(\)/);
  });

  test('app.js uses hash routing for bookmarkable tabs', () => {
    assert.match(app, /history\.pushState/);
    assert.match(app, /hashchange/);
    assert.match(app, /#\/fleet|#\/runs/);
  });

  test('app.js has exponential SSE backoff', () => {
    assert.match(app, /sseBackoffMs/);
    assert.match(app, /sseBackoffMs \* 2/);
  });

  test('app.js pauses elapsed timer when hidden', () => {
    assert.match(app, /elapsedTimerPaused/);
  });

  test('app.js has access banner rendering', () => {
    assert.match(app, /renderAccessBanner/);
    assert.match(app, /access-banner/);
  });

  test('app.js registers service worker only on secure contexts', () => {
    assert.match(app, /serviceWorker.*register|register.*serviceWorker/);
    assert.match(app, /isSecureContext/);
  });

  test('app.js has glance card for mobile fleet view', () => {
    assert.match(app, /renderGlanceCard/);
    assert.match(app, /glance-card/);
  });

  test('style.css shows dismiss button on hover:none devices', () => {
    assert.match(css, /hover: none/);
    assert.match(css, /row-x/);
  });

  test('index.html has apple-touch-icon', () => {
    assert.match(html, /apple-touch-icon/);
  });

  test('index.html has glance-card container for fleet view', () => {
    assert.match(html, /glance-card/);
  });
});

describe('pairing UI contracts', () => {
  const control = readFileSync(new URL('../public/control.js', import.meta.url), 'utf8');

  test('control.js has pairing code generation', () => {
    assert.match(control, /startPairing/);
    assert.match(control, /\/api\/pair\/start/);
  });

  test('control.js has QR code rendering', () => {
    assert.match(control, /qrCodeSvg/);
    assert.match(control, /qrcodegen/);
  });

  test('control.js has maybeExchangePairCode for fragment handling', () => {
    assert.match(control, /maybeExchangePairCode/);
    assert.match(control, /#pair=/);
  });

  test('control.js has device list and revoke', () => {
    assert.match(control, /revokeDevice/);
    assert.match(control, /device-row/);
    assert.match(control, /\/api\/devices\/revoke/);
  });

  // The vendored file is an ES module (it ends in `export default`). Loaded
  // with a classic <script> tag it is a syntax error and window.qrcodegen is
  // never defined, so the panel silently fell back to a bare URL.
  test('the QR library is imported as a module, not a classic script', () => {
    assert.match(control, /import qrcodegen from '\.\/vendor\/qrcodegen\.js'/);
    assert.doesNotMatch(control, /window\.qrcodegen/);
    assert.doesNotMatch(html, /<script[^>]+qrcodegen/);
  });

  test('a locked device can type a pairing code, not only scan one', () => {
    assert.match(control, /Enter pairing code/);
    assert.match(control, /promptForPairCode/);
  });

  test('a revoked or rotated token is detected rather than shown as unlocked', () => {
    assert.match(control, /tokenRejected/);
    assert.match(control, /bad token/);
  });

  test('copying the pairing link works on plain-http LAN, where clipboard is unavailable', () => {
    assert.match(control, /navigator\.clipboard\.writeText[\s\S]{0,200}catch[\s\S]{0,80}window\.prompt/);
  });

  test('the pairing code counts down and notices a successful pairing', () => {
    assert.match(control, /pair-countdown/);
    assert.match(control, /pairingBaseline/);
  });
});

describe('mobile reliability contracts', () => {
  const sw = readFileSync(join(HERE, '..', 'public', 'sw.js'), 'utf8');
  const tip = readFileSync(join(HERE, '..', 'public', 'tip.js'), 'utf8');

  test('the access banner never injects proxy-supplied text as HTML', () => {
    // tailscaleUser comes from a request header.
    const banner = app.slice(app.indexOf('function renderAccessBanner'), app.indexOf('function renderHeader'));
    assert.doesNotMatch(banner, /innerHTML/);
  });

  test('Back closes an open drawer before leaving the tab', () => {
    assert.match(app, /history\.pushState\(\{[^\n]*drawer: true \}/);
    assert.match(app, /addEventListener\('popstate'/);
  });

  test('navigation that came from history does not push a new entry', () => {
    assert.match(app, /setView\(name, \{ fromHistory: true \}\)/);
  });

  test('a stream error keeps the last snapshot on screen', () => {
    const onerror = app.slice(app.indexOf('es.onerror'), app.indexOf('es.onerror') + 400);
    assert.doesNotMatch(onerror, /snap = null/);
  });

  test('returning to the tab reconnects only when the stream is suspect', () => {
    assert.match(app, /function resumeIfStale/);
  });

  test('tables are wrapped in scroll containers', () => {
    assert.match(app, /function wrapTables/);
    assert.match(app, /MutationObserver/);
  });

  test('the more sheet is hidden outside the phone layout too', () => {
    assert.match(css, /\.bottom-nav,\s*\.more-sheet\s*\{\s*display:\s*none/);
  });

  test('the service worker does not pin phones to a stale shell', () => {
    assert.match(sw, /networkFirst\(request, CACHE_SHELL/);
    assert.match(sw, /allSettled/);
  });

  test('tip popovers are positioned in viewport coordinates', () => {
    // position: fixed plus scrollY put the popover off-screen on a scrolled page.
    assert.doesNotMatch(tip, /scrollY/);
    assert.doesNotMatch(tip, /preventDefault/);
  });
});

describe('fleetctl remote-access contracts', () => {
  const fleetctl = readFileSync(join(HERE, '..', 'fleetctl.sh'), 'utf8');

  test('no python f-strings (Python 3.9 on the hosts rejects the escaping)', () => {
    assert.doesNotMatch(fleetctl, /print\(f"/);
  });

  test('remote lan regenerates the LaunchAgent, since FLEET_HOST is baked into it', () => {
    const lan = fleetctl.slice(fleetctl.indexOf('    lan)'), fleetctl.indexOf('    tailscale)'));
    assert.match(lan, /apply_env_change/);
    assert.match(fleetctl, /apply_env_change\(\) \{[\s\S]*?cmd_install/);
  });

  test('remote tailscale off removes only our listener, and Funnel is never used', () => {
    assert.doesNotMatch(fleetctl, /"\$ts" serve reset|tailscale serve reset/);
    assert.doesNotMatch(fleetctl, /"\$ts" funnel|tailscale funnel/);
  });
});
