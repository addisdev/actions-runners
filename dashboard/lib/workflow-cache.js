// Which repos' cached workflow files to drop, decided outside the daemon so it
// can be tested.
//
// The refresh in fleetd.js reconciles files per repo, but only for a repo it can
// still list. A repo deleted or renamed on GitHub 404s on that list, which the
// refresh skipped as transient, so its rows were never dropped and the lint kept
// reporting four repos that had been gone since September.

// Cached repos that are no longer on the owner's roster, or are archived.
// `liveRepos` is the set from this tick's roster refresh; null or empty means the
// refresh failed or came back blank, and nothing is pruned on that evidence.
export function reposToPrune({ cachedRepos, liveRepos }) {
  if (!liveRepos || liveRepos.size === 0) return [];
  return [...new Set(cachedRepos)].filter((repo) => !liveRepos.has(repo)).sort();
}

// A workflow list that fails this way means the repo is gone (or this token can
// no longer see it), not that GitHub had a bad minute. 404 for deleted or hidden,
// 410 for a repo GitHub reports as removed.
export function repoIsGone(err) {
  return err?.status === 404 || err?.status === 410;
}
