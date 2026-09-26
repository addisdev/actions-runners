#!/usr/bin/env bash
# The only way the auto-remediation bridge can launch an AI fix for a failed run.
#
#   ./fix.sh '{"repo":"owner/name","runId":0,"event":"push",...}'
#   ./fix.sh --verify   # check that the credential is working
#   ./fix.sh --login    # sign in interactively
#
# Same split as fleet-action.sh and escalate.sh: the bridge decides WHEN to
# act, this decides WHICH REPOS may ever receive automated fix PRs, and the
# Cursor credential lives here rather than in the daemon that holds an open
# socket. A bug in the bridge's HTTP handling should not be able to push code.
#
# What distinguishes this script from escalate.sh:
#   - escalate.sh reads the fleet and writes a diagnosis report (local agent)
#   - fix.sh reads a failing run and writes a PR on the target repo (cloud agent)
#
# AUTOFIX_FIX_REPOS must contain the repo before this script does anything.
# An empty list means AI fixes are disabled, which is the safe default.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(dirname "$HERE")"
KEY_FILE="${CURSOR_API_KEY_FILE:-$DASH/.cursor-api-key}"

VERIFY=false
LOGIN=false
case "${1:-}" in
  --verify) VERIFY=true ;;
  --login)  LOGIN=true ;;
esac

# Parse the repo from the candidate JSON and validate it against the allowlist.
if [ "$VERIFY" != true ] && [ "$LOGIN" != true ]; then
CANDIDATE="$1"
REPO="$(python3 -c '
import json, sys, os
try:
    c = json.loads(sys.argv[1])
except ValueError as e:
    sys.exit(f"candidate is not valid JSON: {e}")
if not isinstance(c, dict):
    sys.exit("candidate must be a JSON object")
repo = c.get("repo")
if not isinstance(repo, str) or not repo or "/" not in repo:
    sys.exit("candidate has no valid repo field")
print(repo)
' "$CANDIDATE")" || { echo "refused: bad candidate payload" >&2; exit 65; }

# The allowlist. An empty AUTOFIX_FIX_REPOS means AI fixes are disabled.
FIX_REPOS="${AUTOFIX_FIX_REPOS:-}"
if [ -z "$FIX_REPOS" ]; then
  echo "AI fixes are disabled — set AUTOFIX_FIX_REPOS to a comma-separated repo list to enable." >&2
  exit 69
fi

ok=false
IFS=',' read -ra ALLOWED_REPOS <<< "$FIX_REPOS"
for r in "${ALLOWED_REPOS[@]}"; do
  [ "$(echo "$r" | tr -d ' ')" = "$REPO" ] && ok=true && break
done

if [ "$ok" != true ]; then
  echo "refused: '$REPO' is not in the fix allowlist." >&2
  echo "Add it to AUTOFIX_FIX_REPOS to enable automated fix PRs for this repo." >&2
  exit 77
fi
fi

# Credential resolution — same two sources as escalate.sh.
SDK_AUTH="$HOME/.cursor/sdk/auth.json"
CRED_SOURCE=""

if [ -f "$KEY_FILE" ]; then
  PERMS="$(stat -f '%OLp' "$KEY_FILE")"
  if [ "$PERMS" != "600" ] && [ "$PERMS" != "400" ]; then
    echo "refused: $KEY_FILE has mode $PERMS — run: chmod 600 $KEY_FILE" >&2
    exit 69
  fi
  CRED_SOURCE="key-file"
elif [ -f "$SDK_AUTH" ]; then
  CRED_SOURCE="login"
elif [ "$LOGIN" = true ]; then
  CRED_SOURCE="none"
else
  echo "no credential — AI fixes are disabled." >&2
  echo "Either sign in with your Cursor account:" >&2
  echo "  ./autofix/fix.sh --login" >&2
  echo "or install an API key:" >&2
  echo "  printf '%s' 'cursor_...' > $KEY_FILE && chmod 600 $KEY_FILE" >&2
  exit 69
fi

# Stable interpreter — same pattern as autofixctl.sh and escalate.sh.
NODE_BIN="${FIX_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "no stable node interpreter found" >&2; exit 69; }

if [ "$CRED_SOURCE" = "key-file" ]; then
  CURSOR_API_KEY="$(cat "$KEY_FILE")"
  export CURSOR_API_KEY
fi

cd "$HERE/fix"

if [ "$LOGIN" = true ]; then
  exec "$NODE_BIN" --input-type=module -e '
    const { execFile } = await import("node:child_process");
    const { Cursor } = await import("@cursor/sdk");
    const r = await Cursor.auth.login({
      onLoginUrl: (url) => {
        console.log("Authorize this machine here:\n  " + url + "\n");
        execFile("open", [url], () => {});
      },
    });
    // Name only the fields that are safe to see. The login result carries the
    // live API key, and this output is read over someones shoulder, pasted into
    // an issue, and captured in whatever log the caller is redirecting to.
    const email = r && typeof r === "object" ? r.email : null;
    const expMs = r && typeof r === "object" ? r.apiKeyExpiresAtMs : null;
    console.log("signed in" + (email ? " as " + email : ""));
    if (expMs) console.log("Key valid until " + new Date(expMs).toISOString() + ".");
    console.log("\nCredential written to ~/.cursor/sdk/auth.json (valid 90 days).");
    console.log("Now run: ./autofix/fix.sh --verify");
  '
fi

if [ "$VERIFY" = true ]; then
  echo "credential source: $CRED_SOURCE"
  exec "$NODE_BIN" --input-type=module -e '
    const { Cursor } = await import("@cursor/sdk");
    const key = process.env.CURSOR_API_KEY;
    try {
      const st = await Cursor.auth.status();
      if (st?.status && st.status !== "logged-out") {
        console.log("login status: " + st.status);
        const exp = st.expiresAt ?? st.expires_at ?? st.apiKeyExpiresAt;
        if (exp) {
          const days = Math.round((new Date(exp).getTime() - Date.now()) / 86400000);
          console.log("credential expires in " + days + " day(s) (" + new Date(exp).toISOString().slice(0, 10) + ")");
          if (days < 14) console.log("WARNING: re-run --login soon.");
        }
      }
    } catch { /* advisory */ }
    try {
      const r = await Cursor.models.list(key ? { apiKey: key } : {});
      const ids = (r.models ?? r).map((m) => m.id ?? m);
      console.log("credential OK — " + ids.length + " models available");
      const want = process.env.FIX_MODEL ?? "composer-2.5";
      console.log(ids.includes(want)
        ? "model " + want + " is available"
        : "WARNING: model " + want + " not found; available: " + ids.slice(0, 8).join(", "));
    } catch (e) {
      console.error("credential REJECTED: " + e.message);
      process.exit(1);
    }
  '
fi

exec "$NODE_BIN" "$HERE/fix/run.mjs" "$CANDIDATE"
