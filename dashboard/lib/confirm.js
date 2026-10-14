// The second step of a v1 action: a preview hands back a confirmation token,
// and only that token, from the same caller, for the same action and the
// same arguments, within five minutes, runs it. Once.
//
// An agent that previews `runner.drain` for one runner cannot spend the
// confirmation on another runner, and a confirmation leaked into a transcript
// is worthless to anyone holding a different token.

import { randomBytes } from 'node:crypto';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 500;

const pending = new Map();

// Key order must not matter: {a,b} and {b,a} are the same request.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function purge(now) {
  for (const [t, e] of pending) if (e.expires <= now) pending.delete(t);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
}

export function issueConfirmation({ action, args, caller }, now = Date.now()) {
  purge(now);
  const token = randomBytes(18).toString('base64url');
  pending.set(token, { action, args: canonical(args), caller, expires: now + CONFIRM_TTL_MS });
  return { token, expiresAt: now + CONFIRM_TTL_MS };
}

// Returns null when it may run, or why not.
export function consumeConfirmation(token, { action, args, caller }, now = Date.now()) {
  const e = pending.get(String(token ?? ''));
  if (!e || e.expires <= now) return 'the confirmation is unknown or expired: preview the action again';
  if (e.caller !== caller) return 'the confirmation was issued to a different caller';
  if (e.action !== action || e.args !== canonical(args)) {
    return 'the confirmation was issued for a different action or different arguments: preview this one';
  }
  pending.delete(token);
  return null;
}

export function resetConfirmations() {
  pending.clear();
}
