// Works out which repos belong together, so that app-ios / app-web / app-backend
// appear under one heading without anybody configuring anything.
//
// The rule is deliberately the dullest one that works: split a repo name on the
// separators people actually use, take the first token, and call it a group once
// two or more repos share it. Run against a real 34-repo fleet that produced
// exactly the eight groups a person would have drawn by hand, and raising the
// threshold from two to three changed nothing — so there is no cleverness here
// worth its own failure modes.
//
// Grouping is a property of someone's naming convention, not of runner fleets,
// so everything is overridable and nothing is required.

// `.` is in here for names like `example.dev`, which would otherwise land in a
// group of one called `example.dev`.
const SPLIT = /[-_.]+/;

function bare(repo) {
  return String(repo).split('/').pop().toLowerCase();
}

function tokenOf(repo) {
  return bare(repo).split(SPLIT)[0] ?? '';
}

/**
 * @param names  Repo names, with or without owner. Deduplicated here.
 * @param min    Repos that must share a token before it becomes a group.
 * @param ignore Tokens that must never become a group.
 * @param pinned Groups to force, in the display order given.
 * @param enabled false collapses everything into one flat group.
 * @returns {{ order: string[], of: (repo: string) => string }}
 */
export function deriveGroups(names = [], opts = {}) {
  const { min = 2, ignore = [], pinned = [], enabled = true } = opts;

  const ignored = new Set(ignore.map((s) => s.toLowerCase()).filter(Boolean));
  const pins = pinned.map((s) => s.toLowerCase()).filter(Boolean);
  // Longest first, so a repo matching both `app` and `app-legacy` is attributed
  // to the more specific pin however the list was ordered.
  const pinsBySpecificity = [...pins].sort((a, b) => b.length - a.length);

  let auto = [];
  if (enabled) {
    // Distinct names, because the corpus is the union of the runner directories
    // and the repo roster and most repos appear in both. Counting the raw list
    // would let one repo present twice clear a threshold of two and invent a
    // group with a single member in it.
    const distinct = new Set(names.map(bare).filter(Boolean));

    const counts = new Map();
    for (const name of distinct) {
      const t = tokenOf(name);
      // A token with no letter in it is a date or a number, not a project.
      if (!t || !/[a-z]/.test(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }

    auto = [...counts]
      .filter(([t, n]) => n >= min && !ignored.has(t) && !pins.includes(t))
      // Biggest first, then alphabetical. Both halves matter: size puts the
      // fleet's centre of gravity at the top, and the alphabetical tie-break
      // keeps equal-sized groups from swapping places between restarts.
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
  }
  const autoGroups = new Set(auto);

  function of(repo) {
    const name = bare(repo);
    // Pins are matched as prefixes rather than whole tokens, which is how
    // FLEET_PROJECTS behaved before this existed. Keeping that means an upgrade
    // cannot silently regroup a dashboard someone had already configured.
    for (const p of pinsBySpecificity) if (name.startsWith(p)) return p;
    const t = tokenOf(name);
    return autoGroups.has(t) ? t : 'other';
  }

  // Pins first in the order given — that is someone's stated reading order —
  // then inferred groups, then the singletons. A pin with no members stays in
  // the list harmlessly: the UI only renders groups that have runners in them.
  return { order: [...pins, ...auto, 'other'], of };
}
