#!/usr/bin/env node
// fleet: the fleet dashboard's /api/v1 from a shell. No dependencies, no
// build step, nothing generated into the repository: the commands are read
// at run time from the daemon's own OpenAPI document, which lib/api.js
// generates from its route table. A daemon with a new route has a new
// command, and this file never needs to know.
//
//   fleet                         list the commands
//   fleet help <command>          one command's flags
//   fleet <command> [args] [--flag value ...]
//   fleet wait owner/repo --pr N [--timeout 45m]
//
// FLEET_URL (default http://localhost:7878) and FLEET_TOKEN (or
// FLEET_TOKEN_FILE) say where and as whom; --url and --token override them.
// Output is the daemon's JSON on stdout. Errors also go to stderr as
// message and hint. Exit codes: 0 ok, 1 refused (4xx), 2 a preview that
// needs --yes, or checks that are pointless to wait on, 3 unreachable or timed out.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = camel(a.slice(2, eq > 0 ? eq : undefined));
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positional, flags };
}

// The spec's operations, keyed by command name.
export function commands(spec) {
  const out = new Map();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const cli = op['x-fleet-cli'];
      if (!cli?.name) continue;
      const body = op.requestBody?.content?.['application/json']?.schema?.properties ?? {};
      out.set(cli.name, { ...cli, path, method: method.toUpperCase(), op, body });
    }
  }
  return out;
}

const GLOBAL = new Set(['url', 'token', 'yes', 'help', 'timeout', 'compact']);

function value(type, raw) {
  if (type === 'boolean') return raw === true || raw === 'true';
  if (type === 'integer' && typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// A command line, laid out as the request its route expects. Flags the route
// does not declare go where the daemon will judge them: into `args` for a
// route that takes action arguments, otherwise into the query, where the
// daemon refuses an unknown one and names the ones it takes.
export function requestFor(cmd, { positional, flags }) {
  const named = {};
  const want = cmd.positional ?? [];
  if (positional.length > want.length) {
    throw new UsageError(`${cmd.name} takes ${want.length ? want.join(' ') : 'no arguments'}; got ${positional.join(' ')}`);
  }
  want.forEach((p, i) => {
    const v = positional[i];
    if (v == null) return;
    if (p === 'owner/repo') {
      const [owner, repo, extra] = v.split('/');
      if (!owner || !repo || extra != null) throw new UsageError(`expected owner/repo, got ${v}`);
      Object.assign(named, { owner, repo });
    } else {
      named[p] = v;
    }
  });
  let path = cmd.path;
  const query = new URLSearchParams();
  const body = {};
  const params = cmd.op.parameters ?? [];
  for (const [k, raw] of Object.entries({ ...flags, ...named })) {
    if (GLOBAL.has(k)) continue;
    const p = params.find((x) => x.name === k);
    if (p?.in === 'path') path = path.replace(`{${k}}`, encodeURIComponent(raw));
    else if (p) query.set(k, String(raw));
    else if (cmd.body[k]) body[k] = value(cmd.body[k].type, raw);
    else if (cmd.body.args) (body.args ??= {})[k] = raw === true ? true : raw;
    else query.set(k, String(raw));
  }
  const missing = path.match(/\{(\w+)\}/);
  if (missing) throw new UsageError(`${cmd.name} needs ${want.length ? want.join(' ') : `--${kebab(missing[1])}`}`);
  const qs = query.toString();
  return { method: cmd.method, path: qs ? `${path}?${qs}` : path, body: cmd.method === 'GET' ? null : body };
}

export class UsageError extends Error {}

export function client({ url, token, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  return async function call({ method, path, body }, { timeoutMs = 30_000 } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { status: 0, body: { error: { code: 'unreachable', message: `no answer from ${base}: ${err.cause?.code ?? err.message}`, hint: 'Is fleetd running there? Set FLEET_URL or --url.' } } };
    }
    if (!res.headers.get('fleet-api-version')) {
      return { status: res.status, body: { error: { code: 'unsupported', message: `${base} does not serve /api/v1`, hint: 'Update actions-runners on the host: git pull && ./dashboard/fleetctl.sh restart' } } };
    }
    return { status: res.status, body: await res.json() };
  };
}

// --------------------------------------------------------------------- wait

export function parseTimeout(raw = '45m') {
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(String(raw));
  if (!m) throw new UsageError(`--timeout is 90s, 45m or 2h, not ${raw}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, '': 60 }[m[2]] * 1000;
}

const WAIT_EXIT = { green: 0, red: 1, pointless: 2, pending: 3 };

// The checks command, asked again until the checks finish or the timeout
// passes. The daemon holds each ask up to 300 s and decides everything else.
export async function waitFor(call, cmd, args, { timeoutMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), progress = () => {} }) {
  const deadline = now() + timeoutMs;
  let last = null;
  let said = null;
  for (;;) {
    const left = Math.floor((deadline - now()) / 1000);
    if (left <= 0) return last ?? { status: 0, body: { state: 'pending', reason: 'timed out before the dashboard answered' } };
    const req = requestFor(cmd, { ...args, flags: { ...args.flags, wait: String(Math.min(300, left)) } });
    const out = await call(req, { timeoutMs: (Math.min(300, left) + 30) * 1000 });
    if (out.status === 0 || out.status >= 500) {
      progress(out.body.error?.message ?? `HTTP ${out.status}`);
      await sleep(10_000);
      continue;
    }
    if (out.status !== 200) return out;
    last = out;
    const p = out.body.checks?.progress;
    if (p && p !== said) progress(p);
    said = p;
    if (out.body.state !== 'pending') return out;
  }
}

// --------------------------------------------------------------------- main

function help(cmds, name) {
  if (!name) {
    const rows = [...cmds.values()].map((c) => `  ${[c.name, ...(c.positional ?? [])].join(' ').padEnd(26)} ${c.op.summary}`);
    return [
      'usage: fleet <command> [args] [--flag value ...]',
      '',
      'commands (from the daemon\'s /api/v1/openapi.json):',
      ...rows,
      `  ${'wait owner/repo'.padEnd(26)} checks, asked again until they finish or --timeout (default 45m)`,
      '',
      'fleet help <command> lists its flags. FLEET_URL and FLEET_TOKEN say where and as whom.',
    ].join('\n');
  }
  const c = cmds.get(name === 'wait' ? 'checks' : name);
  if (!c) return `no command ${name}`;
  const flags = [
    ...(c.op.parameters ?? []).filter((p) => p.in === 'query').map((p) => [p.name, p.schema?.type, p.description]),
    ...Object.entries(c.body).filter(([k]) => k !== 'args').map(([k, s]) => [k, s.type, s.description]),
  ];
  return [
    `usage: fleet ${[name, ...(c.positional ?? [])].join(' ')}${flags.length ? ' [flags]' : ''}${c.body.args ? ' [--<arg> value ...]' : ''}`,
    '',
    c.op.description,
    '',
    `needs: ${c.op['x-fleet-scope']}${c.op['x-fleet-scope'] === 'read' ? ' (no token on loopback)' : ' token'}`,
    ...(flags.length ? ['', 'flags:', ...flags.map(([k, t, d]) => `  --${kebab(k).padEnd(10)} ${t.padEnd(8)} ${d ?? ''}`)] : []),
    ...(c.body.args ? ['', 'Any other --flag is an argument to the action; fleet actions lists what each takes.'] : []),
    ...(c.confirms ? ['--yes runs it after the preview; without it, an action that changes the fleet stops at the preview.'] : []),
    ...(name === 'wait' ? ['', '--timeout  90s, 45m or 2h (default 45m). Exit 0 green, 1 red, 2 pointless, 3 timed out.'] : []),
  ].join('\n');
}

function token(flags, env) {
  if (typeof flags.token === 'string') return flags.token;
  if (env.FLEET_TOKEN) return env.FLEET_TOKEN;
  if (env.FLEET_TOKEN_FILE) return readFileSync(env.FLEET_TOKEN_FILE, 'utf8').trim();
  return null;
}

export async function main(argv, { env = process.env, out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), fetchImpl = fetch } = {}) {
  const args = parseArgv(argv);
  const [name, ...rest] = args.positional;
  const url = typeof args.flags.url === 'string' ? args.flags.url : env.FLEET_URL ?? 'http://localhost:7878';
  const call = client({ url, token: token(args.flags, env), fetchImpl });
  const json = (body) => out(args.flags.compact ? JSON.stringify(body) : JSON.stringify(body, null, 2));
  const fail = (o, code) => {
    json(o.body);
    if (o.body.error) err(`${o.body.error.message}${o.body.error.hint ? `\n  ${o.body.error.hint}` : ''}`);
    return code;
  };

  const spec = await call({ method: 'GET', path: '/api/v1/openapi.json', body: null });
  if (spec.status !== 200) return fail(spec, spec.status === 0 ? 3 : 1);
  const cmds = commands(spec.body);
  if (!name || name === 'help' || args.flags.help) {
    out(help(cmds, name === 'help' ? rest[0] : name));
    return 0;
  }
  const cmd = cmds.get(name === 'wait' ? 'checks' : name);
  if (!cmd) {
    err(`no command ${name}. fleet help lists them.`);
    return 64;
  }
  const given = { positional: rest, flags: args.flags };
  try {
    if (name === 'wait') {
      const o = await waitFor(call, cmd, given, { timeoutMs: parseTimeout(args.flags.timeout), progress: (s) => err(`… ${s}`) });
      if (o.status !== 200 && o.status !== 0) return fail(o, 1);
      json(o.body);
      return WAIT_EXIT[o.body.state] ?? 3;
    }
    const req = requestFor(cmd, given);
    const o = await call(req);
    if (o.status !== 200) return fail(o, o.status === 0 || o.status >= 500 ? 3 : 1);
    if (cmd.confirms && o.body.status === 'confirm_required') {
      // Anything that changes the fleet stops here without --yes: an agent
      // exploring the commands must not drain or restart by accident.
      if (o.body.danger !== 'none' && !args.flags.yes) {
        json(o.body);
        err(`${o.body.label}: ${o.body.effect ?? 'changes the fleet'}\n  would run: ${o.body.command}\n  nothing has run; add --yes to run it`);
        return 2;
      }
      const done = await call({ ...req, body: { ...req.body, confirm: o.body.confirm } }, { timeoutMs: 300_000 });
      if (done.status !== 200) return fail(done, 1);
      json(done.body);
      return done.body.ok ? 0 : 1;
    }
    json(o.body);
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message}\n\n${help(cmds, name)}`);
    return 64;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
