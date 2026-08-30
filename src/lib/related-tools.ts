/**
 * "Related tools" ranking for the bottom of a tool page.
 *
 * Pure and DOM-free (rule 27): takes the current tool's metadata plus every
 * tool's metadata and returns a short, deterministic list of the tools most
 * worth trying next. Two signals, both cheap and explainable:
 *
 *  - Same category is a strong signal on its own (a JSON tool sits next to
 *    other Data tools even with no keyword overlap).
 *  - Shared vocabulary across name words, `keywords`, and `searchTerms`
 *    (lowercased, stopwords stripped) adds up per shared word, and a
 *    single-hop expansion through `search-synonyms.ts` catches the case where
 *    two tools describe the same thing in different words (a "sound" tool and
 *    an "audio" tool).
 *
 * Ties are broken by name so the list never reorders itself between builds.
 */
import type { SearchTool } from "./search";
import { expandToken } from "./search-synonyms";

/** What this module needs from a tool's metadata, same shape as the grid/palette use. */
export type RelatedTool = SearchTool & { icon?: string };

/** Same category is worth roughly this many shared-word hits on its own. */
const CATEGORY_WEIGHT = 20;

/** Score per word shared directly between the two tools' vocabularies. */
const TOKEN_WEIGHT = 5;

/** Score per word linked only through a curated synonym (search-synonyms.ts). */
const SYNONYM_WEIGHT = 2;

const DEFAULT_RESULTS = 6;
const MIN_RESULTS = 3;
const MAX_RESULTS = 6;

/** Common English function words: too frequent to signal relatedness. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "your",
  "you",
]);

/** Lowercase and split on non-alphanumerics, dropping stopwords and single letters. */
function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** The full bag of vocabulary words for one tool: name, keywords, searchTerms. */
function tokenSet(tool: RelatedTool): Set<string> {
  const words: string[] = [...splitWords(tool.name)];
  for (const keyword of tool.keywords) words.push(...splitWords(keyword));
  for (const term of tool.searchTerms ?? []) words.push(...splitWords(term));
  return new Set(words);
}

/** Count of words present in both bags. */
function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count++;
  return count;
}

/**
 * Count of `a` words that reach a `b` word only through one synonym hop
 * (never a direct match, which `overlapCount` already covers). Mirrors how
 * search.ts expands the query side only, so this stays a single hop with no
 * transitive bridging between two unrelated words that happen to share an
 * expansion target.
 */
function synonymOverlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) continue;
    for (const phrase of expandToken(word)) {
      if (splitWords(phrase).some((expanded) => b.has(expanded))) {
        count++;
        break;
      }
    }
  }
  return count;
}

function score(meta: RelatedTool, candidate: RelatedTool, metaTokens: Set<string>): number {
  const candidateTokens = tokenSet(candidate);
  let total = 0;
  if (meta.category === candidate.category) total += CATEGORY_WEIGHT;
  total += overlapCount(metaTokens, candidateTokens) * TOKEN_WEIGHT;
  total += synonymOverlapCount(metaTokens, candidateTokens) * SYNONYM_WEIGHT;
  return total;
}

/**
 * The `n` (clamped to 3-6) tools most related to `meta`, best first, ties
 * broken by name. `meta` is excluded from its own results. `allMetas` may be
 * in any order and any length; when fewer than `n` other tools exist, every
 * other tool is returned.
 */
export function relatedTools<T extends RelatedTool>(
  meta: T,
  allMetas: readonly T[],
  n: number = DEFAULT_RESULTS,
): T[] {
  const count = Math.min(Math.max(n, MIN_RESULTS), MAX_RESULTS);
  const metaTokens = tokenSet(meta);
  const candidates = allMetas.filter((candidate) => candidate.slug !== meta.slug);

  return candidates
    .map((candidate) => ({ candidate, score: score(meta, candidate, metaTokens) }))
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, count)
    .map((entry) => entry.candidate);
}
