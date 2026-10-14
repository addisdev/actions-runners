// What a token may do.
//
//   read        every GET under /api/v1
//   act         the actions an agent may take on its own judgement, each
//               behind a preview and a confirmation: checks and previews that
//               change nothing, drain and resume, re-run, cancel, and
//               recovering an orphaned run
//   act:danger  every other action: anything that restarts, repairs,
//               registers, removes, deletes or takes a whole host out of CI
//
// The master token and device tokens paired before scopes existed hold all
// three, so nothing that worked stops working. A new token names its scopes.

export const SCOPES = ['read', 'act', 'act:danger'];
export const ALL_SCOPES = [...SCOPES];

// host.off is not here: on a one-host fleet it stops every CI job, which is
// not a call a chat agent makes alone. host.drain only pauses autoscale.
export const ACT_ACTIONS = new Set([
  'fleet.health',
  'fleet.status',
  'fleet.preflight',
  'fleet.cleanupPreview',
  'runner.deregisterPreview',
  'runner.drain',
  'runner.resume',
  'host.drain',
  'host.resume',
  'run.rerun',
  'run.cancel',
  'run.recoverOrphan',
]);

export function scopeForAction(id) {
  return ACT_ACTIONS.has(id) ? 'act' : 'act:danger';
}

// act:danger implies act, and either implies read.
export function grants(scopes, needed) {
  const have = new Set(scopes ?? []);
  if (needed === 'read') return have.has('read') || have.has('act') || have.has('act:danger');
  if (needed === 'act') return have.has('act') || have.has('act:danger');
  return have.has(needed);
}

// "read,act" or ["read", "act"] → ['read', 'act']; null when any is unknown.
export function parseScopes(input) {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!list.length || list.some((s) => !SCOPES.includes(s))) return null;
  return SCOPES.filter((s) => list.includes(s));
}
