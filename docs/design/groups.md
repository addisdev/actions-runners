# Groups are inferred, not configured

This page argues that the dullest possible grouping rule beats a configured one,
and that where the names come from matters more than how they are split.

Runners and repos are grouped so that `app-ios`, `app-web` and `app-backend`
appear under one `app` heading. Nothing configures this: a repo name is split on
`-`, `_` and `.`, and any first token shared by two or more repos becomes a
group. Repos that share nothing with anything land under `other`.

The rule is the dullest one that works. Run against a real 34-repo fleet it
produced exactly the groups a person would have drawn by hand, and raising the
threshold from two to three changed none of them — so there is no cleverness
here to go wrong later.

**The names come from disk and from SQLite, never from the current tick.** This
is the whole reason the corpus is assembled the way it is. Groups derived from
one tick's API results dissolve the moment a call fails, and a heading that
disappears and comes back moves every tile beneath it — the same class of
failure the drift rules already guard against, where a single 503 once produced
a 46-second phantom orphan alert. Verified by running the collector with every
GitHub call returning 401: the grouping came out byte-identical to a healthy run.

**Only repos the fleet has something to do with get a vote** — those with a
workflow or a runner, the same test the roster uses. An account full of
boilerplates and tutorial checkouts otherwise decides the layout: two unrelated
repos that happened to begin `github-` were enough to invent a `github` heading.

Four escape hatches, all optional and all off by default: `FLEET_PROJECTS` pins
groups and their order, `FLEET_GROUP_IGNORE` suppresses a token that is shared
by accident rather than convention, `FLEET_GROUP_MIN` moves the threshold, and
`FLEET_GROUPS=off` gives one flat list. Pins are matched as prefixes rather than
tokens, which is how `FLEET_PROJECTS` behaved when it was the only mechanism —
so upgrading cannot silently regroup a dashboard someone had already arranged.

All four are documented in
[Grouping variables](../configuration.md#grouping-variables).
