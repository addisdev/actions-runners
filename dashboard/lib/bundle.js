// Diagnostic bundles: a text dump of one runner's state, safe to paste into an
// issue.
//
// ALLOWLIST, NOT DENYLIST. This is the whole design of the file.
//
// A runner directory contains `.credentials` and `.credentials_rsaparams`, which
// hold the private key that authenticates this runner to GitHub, and `_work`,
// which holds whole checkouts of private repositories along with whatever
// secrets a job wrote to disk. A denylist gets those wrong exactly once and the
// mistake is unrecoverable: the operator has already pasted the result into a
// public issue by the time anyone notices.
//
// So nothing is included unless it is named in ALLOW below, and every value that
// survives is passed through the redactor. A file added to a future runner
// release is excluded by default, which is the direction this has to fail in.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// Exactly what may be read out of a runner directory, and why.
//
// .runner       — repo URL and agent name. Both are already on the dashboard.
// .env          — PATH and hook wiring. Redacted below; see the note there.
// .path         — the PATH the service resolved.
// .drain        — drain state, so a bundle explains why a runner is stopped.
// bin/runner.version, .version — which version is running.
const ALLOW = new Set(['.runner', '.env', '.path', '.drain', '.version', 'bin/runner.version']);

// Anything shaped like a secret, whatever it is called. Applied to every line of
// every allowed file, on the assumption that the allowlist will eventually be
// wrong about something.
//
// The .env case is the concrete one: it is allowlisted because PATH and the hook
// paths are genuinely useful, and there is nothing stopping somebody adding
// GITHUB_TOKEN to it. So the key name is matched rather than the file.
const REDACT_PATTERNS = [
  // KEY=secret, for any key that sounds like a credential.
  [/^(\s*[\w.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH)[\w.-]*\s*=\s*).*/gim, '$1<redacted>'],
  // JSON string values under a credential-ish key.
  [/("(?:[\w.-]*(?:token|secret|password|key|credential|auth)[\w.-]*)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"'],
  // GitHub token formats, wherever they appear.
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '<redacted-github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-pat>'],
  // Bearer headers and Authorization lines, which show up in _diag excerpts.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <redacted>'],
  // Long base64-ish runs, which is what a leaked key looks like when it has no
  // recognisable prefix. Deliberately aggressive: a false redaction costs a
  // round trip, a missed key costs a rotation.
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '<redacted-long-token>'],
  // PEM blocks, collapsed entirely rather than line by line.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '<redacted-private-key>'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Build a redacted, plain-text diagnostic bundle for one runner.
 *
 * @param {object} opts
 * @param {object}   opts.runner   - a runner from the snapshot
 * @param {object}   [opts.host]   - snapshot.host
 * @param {object[]} [opts.events] - recent runner_events rows
 * @param {object[]} [opts.jobs]   - recent jobs rows
 * @param {object}   [opts.diag]   - output of diagSummary()
 * @param {number}   [opts.diagTailLines]
 * @returns {{ filename: string, text: string, included: string[], excluded: string[] }}
 */
export function buildBundle({ runner, host = {}, events = [], jobs = [], diag = null, diagTailLines = 200 }) {
  const parts = [];
  const included = [];
  const excluded = [];

  const section = (title, body) => {
    parts.push(`${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n${body}\n`);
  };

  section('DIAGNOSTIC BUNDLE', [
    `runner:     ${runner.name}`,
    `repo:       ${runner.repo}`,
    `instance:   ${runner.instance ?? 1}`,
    `generated:  ${new Date().toISOString()}`,
    '',
    'Contents are allowlisted and redacted. .credentials, .credentials_rsaparams',
    'and _work are never read — see dashboard/lib/bundle.js.',
  ].join('\n'));

  section('RUNNER STATE', [
    `launchd label:  ${runner.launchdLabel}`,
    `launchd state:  ${runner.launchdState}`,
    `last exit:      ${runner.lastExit ?? 'n/a'}`,
    `github status:  ${runner.registered ? runner.ghStatus : 'not registered'}`,
    `github busy:    ${runner.ghBusy ? 'yes' : 'no'}`,
    `working now:    ${runner.workingLocally ? 'yes' : 'no'}`,
    `drain state:    ${runner.drainState ?? 'none'}`,
    `version:        ${runner.version ?? 'unknown'}`,
    `labels:         ${(runner.labels ?? []).join(', ') || 'none'}`,
    `pid:            ${runner.pid ?? 'none'}`,
    `rss:            ${runner.rssMb != null ? `${runner.rssMb} MB` : 'unknown'}`,
    `uptime:         ${runner.uptime ?? 'unknown'}`,
  ].join('\n'));

  section('HOST', [
    `hostname:   ${host.hostname ?? 'unknown'}`,
    `platform:   ${host.platform ?? 'unknown'} (darwin ${host.darwin ?? '?'})`,
    `cores:      ${host.cores ?? '?'}`,
    `load:       ${[host.load1, host.load5, host.load15].map((n) => (n != null ? n.toFixed(2) : '?')).join(' ')}`,
    `memory:     ${host.memUsedMb ?? '?'} / ${host.memTotalMb ?? '?'} MB used, ${host.memFreePct ?? '?'}% free`,
    `pressure:   ${host.memPressure ?? 'unknown'}`,
    `swap-in/s:  ${host.swapinsPerSec ?? '?'}`,
    `disk:       ${host.diskFreeGb != null ? `${Math.round(host.diskFreeGb)} GB free of ${Math.round(host.diskTotalGb ?? 0)} GB` : 'unknown'}`,
    `runners:    ${host.runnerCount ?? '?'} (${host.workers ?? '?'} working)`,
  ].join('\n'));

  // Allowlisted files from the runner directory.
  if (runner.dir && existsSync(runner.dir)) {
    for (const rel of ALLOW) {
      const p = join(runner.dir, rel);
      if (!existsSync(p)) continue;
      try {
        // Bounded read. A file that is unexpectedly enormous is a reason to stop,
        // not to load it into memory and truncate afterwards.
        const size = statSync(p).size;
        if (size > 64 * 1024) {
          excluded.push(`${rel} (too large: ${size} bytes)`);
          continue;
        }
        let raw = readFileSync(p, 'utf8');
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        section(`FILE: ${rel}`, redact(raw).trimEnd());
        included.push(rel);
      } catch (err) {
        excluded.push(`${rel} (unreadable: ${err.message})`);
      }
    }

    // Everything present and deliberately left out, named so the reader can see
    // the allowlist was applied rather than wonder whether it ran.
    try {
      for (const e of readdirSync(runner.dir, { withFileTypes: true })) {
        if (ALLOW.has(e.name)) continue;
        if (e.name === '_diag') continue; // handled below, in summary form
        excluded.push(e.isDirectory() ? `${e.name}/ (not allowlisted)` : `${e.name} (not allowlisted)`);
      }
    } catch { /* directory listing is a nicety, not a requirement */ }
  }

  if (diag) {
    section('DIAGNOSTIC LOG SUMMARY', [
      `file:     ${basename(diag.file ?? 'unknown')}`,
      `modified: ${diag.mtime ? new Date(diag.mtime).toISOString() : 'unknown'}`,
      `scanned:  ${diag.linesScanned ?? '?'} lines`,
      `errors:   ${diag.errors ?? 0}`,
      `warnings: ${diag.warnings ?? 0}`,
      '',
      diag.lastError ? `last error:   ${redact(diag.lastError)}` : 'last error:   none',
      diag.lastWarning ? `last warning: ${redact(diag.lastWarning)}` : 'last warning: none',
    ].join('\n'));

    // The log tail goes through the redactor like everything else. Runner logs
    // are not supposed to contain tokens, and "not supposed to" is not a basis
    // for shipping them unredacted.
    if (diag.tail) {
      section(`DIAGNOSTIC LOG TAIL (last ${diagTailLines} lines, redacted)`,
        redact(diag.tail.split('\n').slice(-diagTailLines).join('\n')));
    }
  }

  if (events.length) {
    section('RECENT STATE CHANGES', events
      .map((e) => `${new Date(e.ts).toISOString()}  ${e.kind ?? 'state'}  ${e.detail ?? ''}`)
      .join('\n'));
  }

  if (jobs.length) {
    section('RECENT JOBS', jobs.map((j) => [
      new Date(j.started_at ?? j.created_at ?? 0).toISOString(),
      (j.conclusion ?? j.status ?? 'unknown').padEnd(12),
      j.duration_ms != null ? `${Math.round(j.duration_ms / 1000)}s`.padEnd(8) : '-'.padEnd(8),
      j.name ?? '',
    ].join('  ')).join('\n'));
  }

  section('EXCLUDED', excluded.length
    ? excluded.sort().map((x) => `  ${x}`).join('\n')
    : '  (nothing else was present in the runner directory)');

  return {
    filename: `bundle-${runner.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    text: parts.join('\n'),
    included,
    excluded,
  };
}

// Exported for the tests, which assert that the two credential files and _work
// are absent from the allowlist rather than merely absent from one bundle.
export const ALLOWLIST = ALLOW;
