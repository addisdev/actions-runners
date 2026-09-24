# Dismissing alerts

Every alert row has an `×`. Clicking it stops that condition notifying until it
clears. There is no reason to type, no duration to pick and nothing to expire.

This page is about the three things that `×` deliberately does not do, because
each one is a plausible implementation that breaks something quietly.

## It does not close the alert

The obvious implementation of a dismiss button is to close the alert. It is
also a notification loop.

Alerts here fire on *transitions*: a rule that is still true does not re-notify,
because one dead runner evaluated every 15 seconds would otherwise send 240
notifications an hour. Closing an alert whose condition is still true means the
very next tick finds the condition, sees no open interval, opens a new one — and
notifies. The button would summon the thing it was pressed to get rid of.

So a dismissal is a flag beside the interval, never a close. That also keeps the
history honest: `analytics.js` reads the `alerts` table directly, and a dismissed
outage still happened and still lasted as long as it lasted.

## It does not hide the alert from `/api/alerts`

The second obvious implementation is to filter dismissed alerts out of the API.
That one silently changes what an unattended process is allowed to do.

The autofix bridge prunes its per-alert state for any key it stops seeing open:

```js
for (const key of Object.keys(state)) {
  if (key.startsWith('#')) continue;             // bookkeeping, not an alert
  if (!openKeys.has(key)) { delete state[key]; dropped++; }
}
```

Hiding a dismissed alert would therefore stop the bridge repairing it *and* reset
its `maxAttempts` budget, so a dismissed-then-restored `offline` would quietly
get a fresh set of restart attempts. A button on the Alerts tab would have
changed the fleet's remediation policy.

Dismissed alerts stay in `open` carrying a `dismissed_at`, and each consumer
decides. The bridge ignores the field entirely: **muting your own pager is a
statement about your attention, not an instruction to stop fixing runners.**

## It does not dismiss one run of something

Alert keys name their condition, except one:

| Rule | Key |
|---|---|
| `runner-unused` | `runner:unused:<runner>` |
| drift rules | `drift:<kind>:<subject>` |
| `newly-failing` | `newfail:<repo>:<workflow>:<run id>` |

Dismissing a failing workflow by key would silence exactly one push and start
talking again on the next, which is precisely the alert most worth dismissing.
So a dismissal is stored against a *scope* — the key with the run id collapsed
away. `bridge.js` and `autofix/escalate/run.mjs` already do this for their
cooldowns, having hit the same problem first; `alertScope()` in `lib/alerts.js`
is the third copy, which is the price of those two being separate processes that
import nothing from the dashboard core.

## Why there is no expiry

A dismissal lasts until its condition clears, and is then deleted. Nothing needs
to expire because **the condition going away is the expiry**, which is what keeps
the whole feature to two columns:

```sql
CREATE TABLE IF NOT EXISTS dismissals (
  scope        TEXT PRIMARY KEY,
  dismissed_at INTEGER NOT NULL
);
```

It is also the more honest rule. A condition that clears and then recurs is new
news — the runner came back and went down again — so it is allowed to say so
rather than inheriting a decision made about a different outage.

The case this is really for is the opposite one: a condition that never clears.
Four runners attached to repos that have gone quiet will be flagged as unused
indefinitely, and no expiry anyone picks is the right answer for them. Dismiss
each once and they stay quiet; if a repo wakes up and later goes quiet again,
that is worth one notification.

## Which is why they stay on the page

With no expiry, being permanently visible is the only thing standing between a
dismissal and a genuine fault hidden for ever. So dismissed conditions are always
listed in their own panel, never merely absent, with a count in the header and a
one-click undo. The operator sees how many there are without opening anything.

The Alerts tab's all-clear line had to change with it. It used to say:

> Nothing is open. Alerts fire on transitions, so silence here means every
> condition is clear.

That is now only true when nothing is dismissed, and a page that looks clear
while four conditions are hidden is the lie this whole design exists to avoid.

Three counts elsewhere would have drifted if missed, all of which report what is
*speaking* rather than what is *true*: the SSE badge in `fleetd.js`, the fault
signature in `watch/fleet-watch.mjs`, and the autofix bridge's storm threshold.
The last matters most — four permanently dismissed conditions would otherwise sit
at four of the bridge's six, so two real failures would disable all remediation.

## It does not ask for the control token

The first build of this gated dismissing behind the control token, like
`POST /api/settings` and everything else that mutates. Clicking the `×` opened a
prompt saying *paste the control token (./fleetctl.sh token)*, which is a shell
command and a paste standing between an operator and a button whose entire
purpose is to be one click. A control that costs more than the annoyance it
removes does not get used.

The argument for the token, in `lib/auth.js`'s own words, is that handing it out
would carry "the right to restart runners and delete caches along with the right
to look". Dismissing carries neither. It starts nothing, stops nothing, and does
not touch repair — it changes what this page and the notifier tell *you* about an
alert you are already looking at. Against a reader who can already see every
alert, every runner and every job on the dashboard, a token on this route defends
nothing.

So from the machine the daemon runs on, dismissing needs no token. From anywhere
else it still does, because hiding alerts on a dashboard other people are reading
is a different act from hiding them on your own.

What does apply either way is the Origin check, and without a token it is now the
only thing between this route and a page in another tab. A cross-origin `fetch`
with a JSON content type gets a CORS preflight that the daemon never answers, but
a `<form enctype="text/plain">` post is a "simple request", skips the preflight
entirely, and can carry a body that parses as JSON. Browsers set `Origin` on
those too, which is what `sameOrigin()` checks.
