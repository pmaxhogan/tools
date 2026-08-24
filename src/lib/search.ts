/**
 * Shared tool search: one matcher, one ranker, one highlighter, consumed by
 * the command palette, the sidebar nav, and the homepage grid so the three
 * surfaces agree on what matches and in what order.
 *
 * Pure and DOM-free. Matching is substring based (indexOf, never RegExp) so
 * queries with metacharacters like "c++" or "(x)" are literal and safe. The
 * only regular expressions here are fixed literals run over tool metadata,
 * never over anything the visitor typed.
 *
 * Ranking has two axes. Match QUALITY is the major one: a whole word beats a
 * word prefix, which beats an initials match, which beats a substring buried
 * mid word, which beats a typo correction. The FIELD is the minor one: the
 * name beats the curated aliases (keywords plus searchTerms), which beat the
 * category, which beats the description. Quality outranking field is the whole
 * point of the table below, and it looks wrong until you have the case that
 * forced it: "em" never appears in "Electromagnetic Spectrum" at all, it
 * reaches that tool through the alias "em spectrum" and through the synonym
 * expansion of "em" to "electromagnetic", and both of those word level hits
 * have to beat the "em" sitting mid word inside "Background Remover" and
 * "Temporal Playground".
 *
 * Three things widen what matches, each scored below a direct hit:
 * curated synonyms (search-synonyms.ts), name initials, and, only for a long
 * token that almost nothing matched, a single character typo correction.
 * Tokens still combine with AND: every whitespace separated token has to land
 * somewhere for a tool to match at all.
 */

import { expandToken } from "./search-synonyms";
import { recentBoost } from "./recent-tools";

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

/**
 * Minimal category metadata, structurally satisfied by `ToolCategory` from
 * src/tools/categories.ts. `description` is optional so a caller can pass a
 * lighter projection.
 */
export interface SearchCategory {
  slug: string;
  label: string;
  icon?: string;
  description?: string;
}

/** A category row. The palette renders these alongside tool rows. */
export interface CategoryResult<C extends SearchCategory = SearchCategory> {
  kind: "category";
  category: C;
  score: number;
}

/** A tool row in a mixed result list. `SearchResult` itself stays untagged. */
export type ToolResult<T extends SearchTool = SearchTool> = { kind: "tool" } & SearchResult<T>;

/** What `searchAll` returns, discriminated on `kind`. */
export type MixedResult<
  T extends SearchTool = SearchTool,
  C extends SearchCategory = SearchCategory,
> = ToolResult<T> | CategoryResult<C>;

/** Optional ranking inputs. `recent` is newest first, see recent-tools.ts. */
export interface SearchOptions {
  recent?: readonly string[];
}

/** `searchCategories` extras. Pass `tools` to let a category match by cluster. */
export interface CategorySearchOptions extends SearchOptions {
  tools?: readonly SearchTool[];
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  let out = "";
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) out += escapeHtml(text.slice(pos, s));
    out += `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    pos = e;
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos));
  return out;
}

/**
 * The tier table: one weight per kind of hit, best tier per token wins.
 *
 * Read it top to bottom as "how good is this hit", not "which field was it".
 * A word level hit on a curated alias (60) deliberately outranks a mid word
 * substring in the name (30): that is the "em" case from the module comment,
 * and moving those two rows past each other is what breaks it. An initials hit
 * sits just under the name word prefix and just over the alias rows for the
 * same reason in reverse: on a registry this size a two letter token finds a
 * word starting with it in somebody's keywords every time, so any lower and
 * initials would never surface at all.
 *
 * The whole query gets scored against the same table and multiplied by
 * QUERY_WEIGHT, so matching the entire string still dominates matching its
 * words one at a time, and a single word query is simply worth 9x its tier.
 */
const NAME_EXACT = 120; // the name is exactly the token
const NAME_WORD_EXACT = 100; // the token is a whole word of the name
const NAME_START = 95; // the name starts with the token
const ALIAS_EXACT = 90; // an alias is exactly the token
const NAME_WORD_PREFIX = 70; // the token starts a word of the name
const NAME_ACRONYM = 68; // the token is the name's initials, or a prefix of them
const ALIAS_WORD_EXACT = 66; // the token is a whole word of an alias
const ALIAS_WORD_PREFIX = 60; // the token starts a word of an alias
const CATEGORY_WORD = 44; // the token starts a word of the category
const NAME_SUBSTR = 30; // the token sits mid word in the name
const ALIAS_SUBSTR = 22; // the token sits mid word in an alias
const CATEGORY_SUBSTR = 14; // the token sits mid word in the category
const DESCRIPTION_WORD = 10; // the token starts a word of the description
const DESCRIPTION_SUBSTR = 6; // the token sits mid word in the description
const FUZZY_NAME = 4; // one typo away from a word of the name
const FUZZY_ALIAS = 2; // one typo away from a word of an alias

/** How much the whole query string counts for, relative to one token. */
const QUERY_WEIGHT = 8;

/**
 * What a synonym hit keeps of its tier: always less than the same hit on the
 * word the visitor actually typed, but by less than one quality tier, so an
 * expanded whole word name hit (0.6 x 120 = 72) still edges out a direct word
 * prefix (70). That is the margin that lets "sound" reach a tool whose meta
 * only ever says "audio".
 */
const EXPANSION_FACTOR = 0.6;

/** A token shorter than this is never typo corrected. */
const FUZZY_MIN_LENGTH = 4;

/** Typo correction only kicks in for a token this thin on direct hits. */
const FUZZY_MIN_HITS = 3;

/** Alias words kept per tool for typo correction, so a long meta stays cheap. */
const FUZZY_WORD_CAP = 48;

/**
 * Every category row is scaled by this. It lands an exact label match above
 * any tool that matched only in its description, and below any tool whose
 * name starts with the query, which is the one product call here: flip this
 * single constant to move category rows as a block.
 */
const CATEGORY_SCALE = 0.45;

/** Matching tools needed before a category with no text match earns a row. */
const CATEGORY_CLUSTER_MIN = 3;

/** Score per matching tool in a category. */
const CATEGORY_CLUSTER_PER = 6;

/** Ceiling on the cluster bonus, well under any direct tool match. */
const CATEGORY_CLUSTER_CAP = 30;

/** Precomputed, lowercased haystacks for one tool or category. */
interface SearchIndex {
  name: string;
  nameWords: string[];
  initials: string;
  aliases: string[];
  aliasWords: string[];
  category: string;
  description: string;
}

/** Split lowercased metadata into words. Never runs on visitor input. */
function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

function isWordCharCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code >= 128;
}

/**
 * 2 when `needle` is a whole word of `hay`, 1 when it starts one, 0 otherwise.
 * Substring scan with boundary checks rather than a RegExp, so a needle full
 * of metacharacters is still literal.
 */
function wordHit(hay: string, needle: string): number {
  if (!needle || !hay) return 0;
  let best = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    if (idx === 0 || !isWordCharCode(hay.charCodeAt(idx - 1))) {
      const end = idx + needle.length;
      if (end >= hay.length || !isWordCharCode(hay.charCodeAt(end))) return 2;
      best = 1;
    }
    idx = hay.indexOf(needle, idx + 1);
  }
  return best;
}

/**
 * True when `a` and `b` are at most one Damerau-Levenshtein edit apart: one
 * insertion, deletion, substitution, or swap of two adjacent characters.
 * Bounded at one edit, so it walks to the first mismatch and compares the two
 * tails instead of filling a distance matrix.
 */
export function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  const shortest = Math.min(la, lb);
  let i = 0;
  while (i < shortest && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // One is a prefix of the other, and the lengths differ by exactly one.
  if (i === shortest) return true;

  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return (
      a.charCodeAt(i) === b.charCodeAt(i + 1) &&
      a.charCodeAt(i + 1) === b.charCodeAt(i) &&
      a.slice(i + 2) === b.slice(i + 2) // adjacent transposition
    );
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Indexes are derived from frozen metadata, so cache them on the object itself.
// Search runs on every keystroke over the same array; this keeps the lowercasing
// and word splitting to once per tool per page, not once per keystroke.
const TOOL_INDEX = new WeakMap<SearchTool, SearchIndex>();
const CATEGORY_INDEX = new WeakMap<SearchCategory, SearchIndex>();

function buildIndex(
  rawName: string,
  rawAliases: string[],
  rawCategory: string,
  rawDescription: string,
): SearchIndex {
  const name = rawName.toLowerCase();
  const nameWords = words(name);
  const aliases = rawAliases.map((alias) => alias.toLowerCase());
  const aliasWords: string[] = [];
  const seen = new Set(nameWords);
  outer: for (const alias of aliases) {
    for (const word of words(alias)) {
      // A word this short can never be one edit from a fuzzy-length token.
      if (word.length < FUZZY_MIN_LENGTH - 1 || seen.has(word)) continue;
      seen.add(word);
      aliasWords.push(word);
      if (aliasWords.length >= FUZZY_WORD_CAP) break outer;
    }
  }
  return {
    name,
    nameWords,
    initials: nameWords.map((word) => word[0]).join(""),
    aliases,
    aliasWords,
    category: rawCategory.toLowerCase(),
    description: rawDescription.toLowerCase(),
  };
}

function toolIndex(tool: SearchTool): SearchIndex {
  const cached = TOOL_INDEX.get(tool);
  if (cached) return cached;
  const built = buildIndex(
    tool.name,
    [...tool.keywords, ...(tool.searchTerms ?? [])],
    tool.category,
    tool.description,
  );
  TOOL_INDEX.set(tool, built);
  return built;
}

function categoryIndex(category: SearchCategory): SearchIndex {
  const cached = CATEGORY_INDEX.get(category);
  if (cached) return cached;
  // The label plays the part of the name and the slug that of an alias, so a
  // category scores through the same table as a tool.
  const built = buildIndex(
    category.label,
    [category.slug, category.slug.replace(/-/g, " ")],
    "",
    category.description ?? "",
  );
  CATEGORY_INDEX.set(category, built);
  return built;
}

/** Best tier for one literal needle against one index. Zero means no match. */
function directTier(index: SearchIndex, needle: string): number {
  if (!needle) return 0;
  const { name } = index;
  if (name === needle) return NAME_EXACT;

  const nameWordTier = wordHit(name, needle);
  if (nameWordTier === 2) return NAME_WORD_EXACT;
  if (name.startsWith(needle)) return NAME_START;

  let aliasTier = 0;
  for (const alias of index.aliases) {
    if (alias === needle) {
      aliasTier = ALIAS_EXACT;
      break;
    }
    const tier = wordHit(alias, needle);
    if (tier === 2) {
      if (aliasTier < ALIAS_WORD_EXACT) aliasTier = ALIAS_WORD_EXACT;
    } else if (tier === 1) {
      if (aliasTier < ALIAS_WORD_PREFIX) aliasTier = ALIAS_WORD_PREFIX;
    } else if (aliasTier < ALIAS_SUBSTR && alias.includes(needle)) {
      aliasTier = ALIAS_SUBSTR;
    }
  }
  if (aliasTier === ALIAS_EXACT) return ALIAS_EXACT;
  if (nameWordTier === 1) return NAME_WORD_PREFIX;
  if (needle.length >= 2 && index.initials.startsWith(needle)) return NAME_ACRONYM;
  if (aliasTier >= ALIAS_WORD_PREFIX) return aliasTier;

  if (wordHit(index.category, needle) > 0) return CATEGORY_WORD;
  if (name.includes(needle)) return NAME_SUBSTR;
  if (aliasTier > 0) return aliasTier;
  if (index.category.includes(needle)) return CATEGORY_SUBSTR;
  if (wordHit(index.description, needle) > 0) return DESCRIPTION_WORD;
  if (index.description.includes(needle)) return DESCRIPTION_SUBSTR;
  return 0;
}

/** Best tier for a token counting its curated synonyms, which score lower. */
function tierFor(index: SearchIndex, needle: string, expansions: readonly string[]): number {
  let best = directTier(index, needle);
  if (best >= NAME_EXACT || expansions.length === 0) return best;
  for (const expansion of expansions) {
    const tier = directTier(index, expansion) * EXPANSION_FACTOR;
    if (tier > best) best = tier;
  }
  return best;
}

/** Last resort tier: one typo away from a word of the name or of an alias. */
function fuzzyTier(index: SearchIndex, token: string): number {
  for (const word of index.nameWords) {
    if (withinEditDistanceOne(token, word)) return FUZZY_NAME;
  }
  for (const word of index.aliasWords) {
    if (withinEditDistanceOne(token, word)) return FUZZY_ALIAS;
  }
  return 0;
}

/** Empty query order: recent tools first, newest first, then the rest as given. */
function recentFirst<T extends SearchTool>(
  tools: readonly T[],
  recent: readonly string[] | undefined,
): SearchResult<T>[] {
  if (!recent || recent.length === 0) return tools.map((tool) => ({ tool, score: 0 }));
  const bySlug = new Map<string, T>();
  for (const tool of tools) if (!bySlug.has(tool.slug)) bySlug.set(tool.slug, tool);

  const results: SearchResult<T>[] = [];
  const used = new Set<string>();
  for (const slug of recent) {
    const tool = bySlug.get(slug);
    if (!tool || used.has(slug)) continue;
    used.add(slug);
    results.push({ tool, score: recentBoost(slug, recent) });
  }
  for (const tool of tools) {
    if (!used.has(tool.slug)) results.push({ tool, score: 0 });
  }
  return results;
}

/**
 * Rank `tools` against `query`. An empty query returns every tool in input
 * order (score 0), or, when `options.recent` is given, the recently used ones
 * first in recency order followed by the rest in input order. Otherwise it
 * returns only matching tools, best first, ties broken by name.
 */
export function searchTools<T extends SearchTool>(
  tools: readonly T[],
  query: string,
  options?: SearchOptions,
): SearchResult<T>[] {
  const recent = options?.recent;
  const tokens = tokenize(query);
  if (tokens.length === 0) return recentFirst(tools, recent);

  const indexes = tools.map(toolIndex);
  const expansions = tokens.map((token) => expandToken(token));
  const toolCount = tools.length;
  const tokenCount = tokens.length;

  // tiers[tool * tokenCount + token], so AND and scoring share one pass of work.
  const tiers = new Float64Array(toolCount * tokenCount);
  const hits = new Array<number>(tokenCount).fill(0);
  for (let t = 0; t < toolCount; t++) {
    for (let k = 0; k < tokenCount; k++) {
      const tier = tierFor(indexes[t], tokens[k], expansions[k]);
      tiers[t * tokenCount + k] = tier;
      if (tier > 0) hits[k]++;
    }
  }

  // Typo tolerance: only for a long token that almost nothing matched, counting
  // synonym hits, so a word the map already resolves is never second guessed.
  for (let k = 0; k < tokenCount; k++) {
    if (tokens[k].length < FUZZY_MIN_LENGTH || hits[k] >= FUZZY_MIN_HITS) continue;
    for (let t = 0; t < toolCount; t++) {
      const at = t * tokenCount + k;
      if (tiers[at] === 0) tiers[at] = fuzzyTier(indexes[t], tokens[k]);
    }
  }

  const q = query.trim().toLowerCase();
  const queryExpansions = expandToken(q);
  const results: SearchResult<T>[] = [];
  for (let t = 0; t < toolCount; t++) {
    let score = 0;
    let matched = true;
    for (let k = 0; k < tokenCount; k++) {
      const tier = tiers[t * tokenCount + k];
      if (tier === 0) {
        matched = false;
        break;
      }
      score += tier;
    }
    if (!matched) continue;
    score += QUERY_WEIGHT * tierFor(indexes[t], q, queryExpansions);
    score += recentBoost(tools[t].slug, recent);
    results.push({ tool: tools[t], score });
  }
  results.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return results;
}

/** How many matching tools sit in each category, keyed by lowercased label. */
function clusterCounts(results: readonly SearchResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { tool } of results) {
    const key = tool.category.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function rankCategories<C extends SearchCategory>(
  categories: readonly C[],
  query: string,
  clusters: ReadonlyMap<string, number>,
): CategoryResult<C>[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const q = query.trim().toLowerCase();
  const queryExpansions = expandToken(q);

  const results: CategoryResult<C>[] = [];
  for (const category of categories) {
    const index = categoryIndex(category);
    const cluster = clusters.get(category.label.toLowerCase()) ?? 0;

    let base = 0;
    let matched = true;
    for (const token of tokens) {
      const tier = tierFor(index, token, expandToken(token));
      if (tier === 0) {
        matched = false;
        break;
      }
      base += tier;
    }

    const bonus = Math.min(cluster * CATEGORY_CLUSTER_PER, CATEGORY_CLUSTER_CAP);
    if (!matched) {
      // No text match, but this is where the matching tools live.
      if (cluster >= CATEGORY_CLUSTER_MIN)
        results.push({ kind: "category", category, score: bonus });
      continue;
    }
    const score = (base + QUERY_WEIGHT * tierFor(index, q, queryExpansions)) * CATEGORY_SCALE;
    results.push({ kind: "category", category, score: score + bonus });
  }
  results.sort((a, b) => b.score - a.score || a.category.label.localeCompare(b.category.label));
  return results;
}

/**
 * Rank `categories` against `query`, best first. A category matches on its
 * label, its slug, its description, or a curated synonym of any of those; pass
 * `options.tools` and it also matches when enough of its tools do, which is
 * how "sound" surfaces the Audio category. An empty query returns nothing.
 */
export function searchCategories<C extends SearchCategory>(
  categories: readonly C[],
  query: string,
  options?: CategorySearchOptions,
): CategoryResult<C>[] {
  const tools = options?.tools;
  const clusters = tools
    ? clusterCounts(searchTools(tools, query, options))
    : new Map<string, number>();
  return rankCategories(categories, query, clusters);
}

/**
 * Tools and categories in one list, best first, each row tagged with `kind`.
 * An empty query returns the tools only, in `searchTools` order, because a
 * list of every category is not a search result.
 */
export function searchAll<T extends SearchTool, C extends SearchCategory>(
  tools: readonly T[],
  categories: readonly C[],
  query: string,
  options?: SearchOptions,
): MixedResult<T, C>[] {
  const toolResults = searchTools(tools, query, options);
  const rows: MixedResult<T, C>[] = toolResults.map((result) => ({ kind: "tool", ...result }));
  if (tokenize(query).length === 0) return rows;

  const merged: MixedResult<T, C>[] = [
    ...rankCategories(categories, query, clusterCounts(toolResults)),
    ...rows,
  ];
  merged.sort((a, b) => b.score - a.score || labelOf(a).localeCompare(labelOf(b)));
  return merged;
}

function labelOf(row: MixedResult): string {
  return row.kind === "tool" ? row.tool.name : row.category.label;
}
