#!/usr/bin/env bash
# The only way the auto-remediation bridge can ask an agent about an alert.
#
#   ./escalate.sh '{"rule":"stuck-queue","key":"...","title":"...","opened_at":0}'
#
# Same split as fleet-action.sh, for the same reason: the bridge decides WHEN to
# escalate, this decides WHICH RULES may ever be escalated, and the credential
# lives here rather than in the daemon holding an open socket. A bug in the
# bridge's HTTP handling should not be able to spend money.
#
# It also keeps the dependency boundary honest. Everything the bridge imports is
# in the Node standard library; the Cursor SDK is loaded only by the child
# process this script starts. If that subtree breaks, dead runners still get
# repaired and the only thing lost is the explanation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(dirname "$HERE")"
KEY_FILE="${CURSOR_API_KEY_FILE:-$DASH/.cursor-api-key}"

# Deliberately wider than the bridge uses, so this doubles as the operator's
# manual entry point: `./escalate.sh "$(curl -s .../api/alerts | ...)"` on any
# one alert, to see what the agent makes of it without waiting for a recurrence.
#
# What qualifies a rule for this list is that answering it requires READING
# something — a workflow file, an annotation, a percentile — rather than running
# something. If the answer is a known shell command, it belongs in
# fleet-action.sh's allowlist and in ROUTES, not here.
ESCALATABLE=(
  newly-failing
  stuck-queue
  label-mismatch
  orphan
  no-listener
)

# These three have a deterministic repair and autofix owns them. Escalating one
# would pay a model to narrate a fix that is already running, and would race the
# repair it is describing.
AUTOFIX_OWNED=(
  launchd-dead
  launchd-missing
  offline
)

usage() {
  echo "usage: $(basename "$0") '<alert-json>'" >&2
  echo "       $(basename "$0") --login         # sign in with your Cursor account (no API key needed)" >&2
  echo "       $(basename "$0") --verify        # check the credential actually works" >&2
  printf 'escalatable rules: %s\n' "${ESCALATABLE[*]}" >&2
  exit 64
}

[ $# -ge 1 ] || usage
ALERT="$1"

# --verify skips the rule checks and only exercises the credential. It exists
# because of how the previous version of this path failed: the key was present,
# the daemon looked installed, and every single run died on authentication for
# four days before anyone noticed there had been no diagnoses. Finding that out
# at install time costs one API call.
VERIFY=false
LOGIN=false
case "$ALERT" in
  --verify) VERIFY=true ;;
  --login)  LOGIN=true ;;
esac

# Parse rather than pattern-match, so a rule name appearing inside a workflow
# title cannot smuggle an alert past the allowlist. Fails closed on bad JSON.
if [ "$VERIFY" != true ] && [ "$LOGIN" != true ]; then
RULE="$(python3 -c '
import json, sys
try:
    a = json.loads(sys.argv[1])
except ValueError as e:
    sys.exit(f"alert is not valid JSON: {e}")
if not isinstance(a, dict):
    sys.exit("alert must be a JSON object")
rule = a.get("rule")
if not isinstance(rule, str) or not rule:
    sys.exit("alert has no rule")
print(rule)
' "$ALERT")" || { echo "refused: bad alert payload" >&2; exit 65; }

for a in "${AUTOFIX_OWNED[@]}"; do
  if [ "$a" = "$RULE" ]; then
    echo "refused: '$RULE' has a deterministic repair — autofix owns it, not an agent." >&2
    exit 77
  fi
done

ok=false
for a in "${ESCALATABLE[@]}"; do [ "$a" = "$RULE" ] && ok=true && break; done
if [ "$ok" != true ]; then
  echo "refused: '$RULE' is not an escalatable rule." >&2
  printf 'escalatable: %s\n' "${ESCALATABLE[*]}" >&2
  exit 77
fi
fi

# Two credential sources, checked in this order. An explicit key file wins
# because it is the one an operator chose deliberately; the browser login is the
# fallback for anyone who cannot mint an API key, which is the common case on a
# managed team account.
#
#   key file  dashboard/.cursor-api-key — no expiry, needs dashboard access
#   login     ~/.cursor/sdk/auth.json   — written by `escalate.sh --login`,
#                                         uses the existing Cursor account,
#                                         and expires after 90 days
#
# The expiry is the thing to design against, not the convenience. See --verify.
SDK_AUTH="$HOME/.cursor/sdk/auth.json"
CRED_SOURCE=""

if [ -f "$KEY_FILE" ]; then
  # Refuse a world-readable credential rather than quietly using it.
  PERMS="$(stat -f '%OLp' "$KEY_FILE")"
  if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ]; then
    echo "refused: $KEY_FILE has mode $PERMS — run: chmod 600 $KEY_FILE" >&2
    exit 69
  fi
  CRED_SOURCE="key-file"
elif [ -f "$SDK_AUTH" ]; then
  CRED_SOURCE="login"
elif [ "$LOGIN" = true ]; then
  CRED_SOURCE="none"   # about to create one
else
  echo "no credential — escalation is disabled." >&2
  echo "Either sign in with the Cursor account you already have:" >&2
  echo "  ./autofix/escalate.sh --login" >&2
  echo "or, if you can mint an API key at https://cursor.com/dashboard/integrations:" >&2
  echo "  printf '%s' 'cursor_...' > $KEY_FILE && chmod 600 $KEY_FILE" >&2
  exit 69
fi

# A stable interpreter, for the reason autofixctl.sh already documents: an
# nvm-managed path stops existing the day that Node version is uninstalled, and
# a remediation daemon that dies on a version bump is not a remediation daemon.
NODE_BIN="${ESCALATE_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "no stable node interpreter found" >&2; exit 69; }

# Exported only for the key-file source. With a stored login there is no key to
# pass: the SDK reads ~/.cursor/sdk/auth.json itself, and setting an empty
# CURSOR_API_KEY would override that with nothing.
if [ "$CRED_SOURCE" = "key-file" ]; then
  CURSOR_API_KEY="$(cat "$KEY_FILE")"
  export CURSOR_API_KEY
fi

cd "$HERE/escalate"

if [ "$LOGIN" = true ]; then
  # Browser login against the existing Cursor account. This is the path for
  # anyone who cannot mint an API key from the dashboard. It writes
  # ~/.cursor/sdk/auth.json and the credential lasts 90 days.
  exec "$NODE_BIN" --input-type=module -e '
    const { execFile } = await import("node:child_process");
    const { Cursor } = await import("@cursor/sdk");
    const r = await Cursor.auth.login({
      onLoginUrl: (url) => {
        console.log("Authorize this machine here:\n  " + url + "\n");
        execFile("open", [url], () => {});   // best effort; the URL above is the fallback
      },
    });
    console.log("signed in" + (r && typeof r === "object" ? ": " + JSON.stringify(r).slice(0, 200) : ""));
    console.log("\nCredential written to ~/.cursor/sdk/auth.json (valid 90 days).");
    console.log("Now run: ./autofix/escalate.sh --verify");
  '
fi

if [ "$VERIFY" = true ]; then
  echo "credential source: $CRED_SOURCE"
  # A models list is the cheapest authenticated call available, and it fails the
  # same way a real run would: same credential, same client, same network path.
  exec "$NODE_BIN" --input-type=module -e '
    const { Cursor } = await import("@cursor/sdk");
    const key = process.env.CURSOR_API_KEY;   // undefined for the login source

    try {
      const st = await Cursor.auth.status();
      if (st?.status && st.status !== "logged-out") {
        console.log(`login status: ${st.status}`);
        // A 90-day credential in an unattended daemon WILL expire, and the last
        // version of this path went dark for four days without anyone noticing.
        // If the SDK tells us when, say so now rather than at 03:00.
        const exp = st.expiresAt ?? st.expires_at ?? st.apiKeyExpiresAt;
        if (exp) {
          const days = Math.round((new Date(exp).getTime() - Date.now()) / 86400000);
          console.log(`credential expires in ${days} day(s) (${new Date(exp).toISOString().slice(0, 10)})`);
          if (days < 14) console.log("WARNING: re-run --login soon; escalation stops working when this lapses.");
        }
      }
    } catch { /* status is advisory; the real test is the call below */ }

    try {
      const r = await Cursor.models.list(key ? { apiKey: key } : {});
      const ids = (r.models ?? r).map((m) => m.id ?? m);
      console.log(`credential OK — ${ids.length} models available`);
      const want = process.env.ESCALATE_MODEL ?? "composer-2.5";
      console.log(ids.includes(want)
        ? `model ${want} is available`
        : `WARNING: model ${want} is not in the list; set ESCALATE_MODEL to one of: ${ids.slice(0, 8).join(", ")}`);
    } catch (e) {
      console.error(`credential REJECTED: ${e.message}`);
      console.error("Escalation will not work. Run --login again, or install an API key.");
      process.exit(1);
    }
  '
fi

exec "$NODE_BIN" "$HERE/escalate/run.mjs" "$ALERT"
