/**
 * Recently used tools: the list helper and the ranking boost, both pure.
 *
 * Storage is the caller's job. The list of slugs belongs in localStorage under
 * the key "recent-tools" (exported below as RECENT_TOOLS_KEY): a list of tool
 * slugs is a preference, like the sidebar width, never content, so it is the
 * one thing storage is allowed to hold. Nothing in this module touches
 * localStorage, the DOM, or the network, which is what lets search.ts import
 * it and lets the tests stay plain.
 *
 * The boost is deliberately small. It reorders tools that already match at the
 * same tier, and it can never lift a weak match past a strong one: the top
 * slot is worth RECENT_BOOST_TOP points against a name exact hit worth more
 * than a thousand (see the tier table in search.ts).
 */

/** localStorage key the surfaces read and write the recent slug list under. */
export const RECENT_TOOLS_KEY = "recent-tools";

/** How many slugs the list keeps. */
export const RECENT_TOOLS_MAX = 10;

/** Score added for the most recent tool. */
export const RECENT_BOOST_TOP = 24;

/** How much each older entry loses, down to a floor of 1. */
export const RECENT_BOOST_STEP = 2;

/**
 * Return a new list with `slug` first, duplicates removed, blanks dropped and
 * the length capped at `max`. The input list is never mutated, so callers can
 * hand this straight back to storage.
 */
export function rememberRecent(list: string[], slug: string, max = RECENT_TOOLS_MAX): string[] {
  if (max <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed) || out.length >= max) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(slug);
  for (const entry of list) push(entry);
  return out;
}

/**
 * The search score bonus for `slug`, given the recent list newest first.
 * Zero when the tool is not in the list.
 */
export function recentBoost(slug: string, recent?: readonly string[]): number {
  if (!recent || recent.length === 0) return 0;
  const index = recent.indexOf(slug);
  if (index === -1) return 0;
  return Math.max(1, RECENT_BOOST_TOP - index * RECENT_BOOST_STEP);
}
