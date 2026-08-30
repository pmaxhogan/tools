/**
 * Pinned tools: the list helpers, all pure. Companion to recent-tools.ts, and
 * deliberately the same shape, because the two lists live side by side on the
 * homepage and in the sidebar.
 *
 * Storage is the caller's job (src/lib/prefs.ts does it). The list of slugs
 * belongs in localStorage under the key "favorite-tools" (exported below as
 * FAVORITES_KEY): a list of tool slugs is a preference, like the sidebar width,
 * never content, so it is the one thing storage is allowed to hold. Nothing in
 * this module touches localStorage, the DOM, or the network, which keeps the
 * tests plain.
 *
 * Order is newest first, matching the recent list, so the tool you just pinned
 * is the one at the front of the Pinned row. The cap is generous but real: a
 * pinned row is a shortcut, and past thirty entries it is just the tool list
 * again in a worse order.
 */

/** localStorage key the surfaces read and write the pinned slug list under. */
export const FAVORITES_KEY = "favorite-tools";

/** How many slugs the list keeps. */
export const FAVORITES_MAX = 30;

/**
 * A cleaned copy of `list`: trimmed, blanks dropped, duplicates removed keeping
 * the first occurrence, capped at `max`. Every other helper here runs its
 * output through this, so a list that came back from storage in a shape an
 * older version wrote can still be used and re-saved safely.
 */
export function normalizeFavorites(list: readonly string[], max = FAVORITES_MAX): string[] {
  if (max <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed) || out.length >= max) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** True when `slug` is pinned. Whitespace around the slug is ignored. */
export function isFavorite(list: readonly string[], slug: string): boolean {
  const needle = slug.trim();
  if (!needle) return false;
  return list.some((entry) => entry.trim() === needle);
}

/**
 * Return a new list with `slug` pinned if it was not, or unpinned if it was.
 * Pinning puts it first; unpinning leaves the rest in order. The input list is
 * never mutated, so callers can hand this straight back to storage.
 */
export function toggleFavorite(
  list: readonly string[],
  slug: string,
  max = FAVORITES_MAX,
): string[] {
  const needle = slug.trim();
  if (!needle) return normalizeFavorites(list, max);
  if (isFavorite(list, needle)) {
    return normalizeFavorites(
      list.filter((entry) => entry.trim() !== needle),
      max,
    );
  }
  return normalizeFavorites([needle, ...list], max);
}
