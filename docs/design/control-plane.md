# The control plane

This page argues that a dashboard someone can see is not a dashboard they can
act on, and that everything an action or a diagnostic bundle may touch is fixed
in advance by an allowlist rather than decided at the time.

Unlock the Control tab once with `./fleetctl.sh token`. The token is stored in
that browser and **is never served to the page** — read access and the right to
restart runners are different things, so a dashboard someone can see is not a
dashboard they can act on.

Two rules govern
[`lib/actions.js`](https://github.com/addisdev/actions-runners/blob/main/dashboard/lib/actions.js),
and neither is negotiable:

- **No shell.** Every local action is `execFile` with an argv array, never a
  string handed to `sh -c`. There is no interpolation point, so a runner name
  containing `; rm -rf ~` is a name that fails to match a known runner.
- **No free-form commands.** The registry is the complete set of things this
  daemon can do. Arguments are validated against entities it already knows —
  a runner must be one it discovered, a repo one it polls.

The actions *are* the existing scripts, which keeps them the single source of
truth rather than forking their logic into a web app. Every action, successful
or refused, is recorded in `action_log`.

Three guards are worth knowing about, because each encodes a way to lose the
fleet:

- **Removal names its target.** `scripts/deregister.sh <dir-name>` removes one
  runner and is dry-run by default. It replaced `teardown.sh`, whose only
  selector was `--keep <dir,dir,…>` — to remove one runner you named every
  *other* runner, and an empty or mistyped keep-list removed everything. The
  script refuses a runner that is mid-job, and refuses to leave a repo with no
  runner at all unless `--force` says so.
- **`runner.duplicate` copies labels rather than accepting them.** A second
  runner that does not carry the first one's extra labels never matches the same
  `runs-on:`, so it sits idle forever while the first one queues — which looks
  exactly like the problem it was added to fix. The labels come from the
  lowest-numbered sibling, so there is no opportunity to get them wrong.
- **`runner.register` enforces the same-label rule** for the same reason. The
  form shows the existing labels; the daemon refuses the mismatch regardless of
  what the form sent.

Set `FLEET_READ_ONLY=1` to disable the control plane entirely. It and the rest
of the daemon's variables are in
[Dashboard daemon variables](../configuration.md#dashboard-daemon-variables); the
endpoints the tab calls are in the [API reference](../api.md).

The unattended half of the same problem — what an automated process may ever do
to the fleet, as opposed to what a person with the token may — is covered in
[Why the blast radius stays small](alerts.md#why-the-blast-radius-stays-small).

## Diagnostic bundles

The **Diagnostics** button in the runner drawer downloads a text bundle that is
safe to paste into an issue. It is built from an **allowlist**, never a denylist:

A runner directory holds `.credentials` and `.credentials_rsaparams` — the private
key that authenticates it to GitHub — and `_work`, which holds whole checkouts of
private repositories plus whatever secrets a job wrote to disk. A denylist gets
those wrong exactly once, and by then the result has already been pasted into a
public issue.

So nothing is included unless
[`lib/bundle.js`](https://github.com/addisdev/actions-runners/blob/main/dashboard/lib/bundle.js)
names it, and
everything that survives goes through a redactor that matches on key *names*
(`*TOKEN*`, `*SECRET*`, `*KEY*`…), GitHub token formats, `Bearer` headers, PEM
blocks and long base64 runs. `.env` is allowlisted because `PATH` and the hook
wiring are genuinely useful, and it is exactly the file somebody eventually puts
a token in — which is why the redactor exists rather than trusting the list. The
bundle ends with everything it excluded, so a reader can see the filter ran.
