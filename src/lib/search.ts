/**
 * Shared tool search: one matcher, one ranker, one highlighter, consumed by
 * the command palette, the sidebar nav, and the homepage grid so the three
 * surfaces agree on what matches and in what order.
 *
 * Pure and DOM-free. Matching is substring based (indexOf, never RegExp) so
 * queries with metacharacters like "c++" or "(x)" are literal and safe.
 * Ranking: name exact > name prefix > name substring > keywords / searchTerms
 * (curated aliases) > category > description. Tokens combine with AND: every
 * whitespace-separated token must land in some field for a tool to match.
 */

/** Minimal metadata the search surfaces pass in. `searchTerms` is optional. */
export interface SearchTool {
  slug: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  searchTerms?: string[];
}

export interface SearchResult<T extends SearchTool = SearchTool> {
  tool: T;
  score: number;
}

/** Split a query into unique, lowercased, non-empty tokens. */
export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.trim().toLowerCase().split(/\s+/)) {
    if (raw) seen.add(raw);
  }
  return [...seen];
}

/** HTML-escape a string for safe insertion via v-html. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return `text` HTML-escaped, with every case-insensitive occurrence of any
 * query token wrapped in `<mark>`. Matches are found on the raw text first,
 * then each segment is escaped, so offsets never drift on `&`/`<`/`>` and the
 * output is always safe. Overlapping and touching ranges merge into one mark.
 */
export function highlightHtml(text: string, query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) return escapeHtml(text);

  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const tok of tokens) {
    let from = 0;
    let idx = lower.indexOf(tok, from);
    while (idx !== -1) {
      ranges.push([idx, idx + tok.length]);
      from = idx + tok.length;
      idx = lower.indexOf(tok, from);
    }
  }
  if (ranges.length === 0) return escapeHtml(text);

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }

  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) out += escapeHtml(text.slice(pos, s));
    out += `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    pos = e;
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos));
  return out;
}

// Whole-query weights (the full trimmed query hitting one field).
const W_NAME_EXACT = 1000;
const W_NAME_PREFIX = 500;
const W_NAME_SUBSTR = 250;
const W_ALIAS_EXACT = 200;
const W_ALIAS_SUBSTR = 120;
const W_CATEGORY = 80;
const W_DESCRIPTION = 40;

// Per-token weights (each token's best field hit), so multi-word queries rank
// by where their words land without any single word dominating the whole-query
// tiers above.
const T_NAME = 40;
const T_ALIAS = 25;
const T_CATEGORY = 15;
const T_DESCRIPTION = 8;

function aliasHaystack(tool: SearchTool): string[] {
  return [...tool.keywords, ...(tool.searchTerms ?? [])].map((k) => k.toLowerCase());
}

function scoreTool(tool: SearchTool, query: string, tokens: string[]): number | null {
  const name = tool.name.toLowerCase();
  const category = tool.category.toLowerCase();
  const description = tool.description.toLowerCase();
  const aliases = aliasHaystack(tool);

  // AND semantics: every token must appear in at least one field.
  for (const tok of tokens) {
    const hit =
      name.includes(tok) ||
      category.includes(tok) ||
      description.includes(tok) ||
      aliases.some((a) => a.includes(tok));
    if (!hit) return null;
  }

  let score = 0;

  // Whole-query tier bonus (single best tier wins for the full query string).
  const q = query.trim().toLowerCase();
  if (name === q) score += W_NAME_EXACT;
  else if (name.startsWith(q)) score += W_NAME_PREFIX;
  else if (name.includes(q)) score += W_NAME_SUBSTR;
  else if (aliases.some((a) => a === q)) score += W_ALIAS_EXACT;
  else if (aliases.some((a) => a.includes(q))) score += W_ALIAS_SUBSTR;
  else if (category.includes(q)) score += W_CATEGORY;
  else if (description.includes(q)) score += W_DESCRIPTION;

  // Per-token contribution (best field per token).
  for (const tok of tokens) {
    if (name.includes(tok)) score += T_NAME;
    else if (aliases.some((a) => a.includes(tok))) score += T_ALIAS;
    else if (category.includes(tok)) score += T_CATEGORY;
    else if (description.includes(tok)) score += T_DESCRIPTION;
  }

  return score;
}

/**
 * Rank `tools` against `query`. An empty query returns every tool in input
 * order (score 0) so callers can group them. Otherwise returns only matching
 * tools, best first, ties broken by name.
 */
export function searchTools<T extends SearchTool>(tools: T[], query: string): SearchResult<T>[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return tools.map((tool) => ({ tool, score: 0 }));

  const results: SearchResult<T>[] = [];
  for (const tool of tools) {
    const score = scoreTool(tool, query, tokens);
    if (score !== null) results.push({ tool, score });
  }
  results.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return results;
}
