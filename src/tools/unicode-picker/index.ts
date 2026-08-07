import { ToolError, type ToolLogic } from '../types';
import { CATEGORIES, ENTRIES, type UnicodeEntry } from './data';

export interface UnicodePickerOpts {
  /** 'all' or a category id from CATEGORIES. */
  category: string;
  [key: string]: unknown;
}

export type UnicodePickerResult = Record<string, string>;

/** Rows shown before the "…and N more" summary row. */
export const MAX_RESULTS = 100;

const LABELS = new Map(CATEGORIES.map((c) => [c.id, c.label]));

/** Everything a query is matched against, lowercased once per entry. */
const HAYSTACK = new Map<UnicodeEntry, string>(
  ENTRIES.map((e) => [e, `${e.name} ${e.category} ${LABELS.get(e.category) ?? ''}`.toLowerCase()]),
);

/**
 * Rank: an exact character match wins, then a name that starts with the query,
 * then a name containing it, then everything else in dataset order. Keeps the
 * useful hits above the 100-row cap.
 */
function score(e: UnicodeEntry, raw: string, q: string): number {
  if (raw && e.char === raw) return 0;
  if (!q) return 3;
  if (e.name.startsWith(q)) return 1;
  if (e.name.includes(q)) return 2;
  return 3;
}

/**
 * Case-insensitive search over name, category and the character itself.
 * Multi-word queries are AND-ed, so "left arrow" finds "leftwards arrow".
 */
export function search(query: string, category: string): UnicodeEntry[] {
  const raw = (query ?? '').trim();
  const q = raw.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  const pool = category === 'all' ? ENTRIES : ENTRIES.filter((e) => e.category === category);

  const hits = pool.filter((e) => {
    if (!terms.length) return true;
    if (e.char === raw) return true;
    const hay = HAYSTACK.get(e)!;
    return terms.every((t) => hay.includes(t));
  });

  return hits
    .map((e, i) => ({ e, i, s: score(e, raw, q) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.e);
}

/** "rightwards arrow — U+2192 — &rarr;" */
export function describe(e: UnicodeEntry): string {
  return `${e.name} — ${e.codepoint} — ${e.htmlEntity}`;
}

export const run: ToolLogic<string, UnicodePickerResult, UnicodePickerOpts>['run'] = (
  input,
  opts,
) => {
  const category = String(opts?.category ?? 'all').trim() || 'all';
  if (category !== 'all' && !LABELS.has(category))
    throw new ToolError(
      'unknown-category',
      `Unknown category "${category}".`,
      `Use "all" or one of: ${CATEGORIES.map((c) => c.id).join(', ')}.`,
    );

  const query = (input ?? '').trim();
  const hits = search(query, category);

  if (!hits.length) {
    const where = category === 'all' ? 'any category' : `the ${LABELS.get(category)} category`;
    return {
      'No matches': `Nothing in ${where} matches "${query}". Try a shorter query like "arrow", "dash", "greek" or "space" — or paste the character itself.`,
    };
  }

  const out: UnicodePickerResult = {};
  for (const e of hits.slice(0, MAX_RESULTS)) out[e.char] = describe(e);

  const extra = hits.length - MAX_RESULTS;
  if (extra > 0)
    out[`…and ${extra} more`] =
      'Narrow the search or pick a category to see the rest of the matches.';

  return out;
};

export default { run } satisfies ToolLogic<string, UnicodePickerResult, UnicodePickerOpts>;
