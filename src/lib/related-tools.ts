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
 * **Never pad the list with fillers.** The list used to be sorted by score and
 * sliced to six, which meant a small category borrowed whatever ranked next,
 * however unrelated: the molar mass calculator ended up recommending a 3D print
 * cost calculator and a Minecraft damage calculator, whose entire claim to
 * relatedness was the word "calculator". So the selection now runs in tiers:
 * category siblings first, then tools from other categories that carry real
 * vocabulary overlap, and only when that leaves fewer than three does it reach
 * for the weaker overlaps. A tool with no overlap at all is never shown, even
 * if that leaves the section short.
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

/** Score for a shared word from GENERIC_WORDS below: a tiebreak, not a match. */
const GENERIC_WEIGHT = 1;

/** Score per word linked only through a curated synonym (search-synonyms.ts). */
const SYNONYM_WEIGHT = 2;

/**
 * Overlap a tool from another category must carry before it is offered
 * alongside the category siblings. Set to CATEGORY_WEIGHT on purpose: an
 * outsider has to be at least as related by vocabulary as a sibling is by
 * simply sharing a category, which works out at four shared words.
 */
const CROSS_CATEGORY_MIN = CATEGORY_WEIGHT;

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

/**
 * The near-stopwords of this particular corpus: words that say what shape a
 * tool is ("calculator", "viewer", "generator") or that only sell it ("free",
 * "online", "no ads"), rather than what it is about. Roughly a third of the
 * catalog is a calculator and most keyword lists promise the tool is free, so
 * a shared one of these says almost nothing, and three of them were enough to
 * put a 3D print cost calculator on the molar mass calculator's page.
 *
 * They are scored down rather than dropped. Dropped outright, a JSON formatter
 * stopped recommending the JSON schema validator, because "validator",
 * "linter" and "checker" were all it had beyond the word "json". At
 * GENERIC_WEIGHT they still break ties between two otherwise equal tools
 * without ever carrying a match on their own.
 */
const GENERIC_WORDS = new Set([
  // what kind of thing the tool is
  "analyser",
  "analyzer",
  "app",
  "beautifier",
  "builder",
  "calculator",
  "calculators",
  "checker",
  "converter",
  "converters",
  "decoder",
  "editor",
  "encoder",
  "formatter",
  "generator",
  "generators",
  "inspector",
  "kit",
  "linter",
  "lookup",
  "maker",
  "parser",
  "picker",
  "reader",
  "scanner",
  "suite",
  "tester",
  "tool",
  "tools",
  "utility",
  "validator",
  "viewer",
  "viewers",
  // how it is sold
  "ads",
  "alternative",
  "best",
  "browser",
  "custom",
  "download",
  "easy",
  "fast",
  "free",
  "instant",
  "local",
  "no",
  "offline",
  "online",
  "private",
  "quick",
  "simple",
  "upload",
  "web",
  "without",
  // too broad to distinguish one tool from another
  "file",
  "files",
  "make",
  "open",
  "view",
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

/** Weighted count of words present in both bags, generic words scored down. */
function overlapWeight(a: Set<string>, b: Set<string>): number {
  let total = 0;
  for (const word of a) {
    if (!b.has(word)) continue;
    total += GENERIC_WORDS.has(word) ? GENERIC_WEIGHT : TOKEN_WEIGHT;
  }
  return total;
}

/**
 * Count of `a` words that reach a `b` word only through one synonym hop
 * (never a direct match, which `overlapWeight` already covers). Mirrors how
 * search.ts expands the query side only, so this stays a single hop with no
 * transitive bridging between two unrelated words that happen to share an
 * expansion target. Generic words never hop: an alias of "calculator" is as
 * uninformative as "calculator".
 */
function synonymOverlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word) || GENERIC_WORDS.has(word)) continue;
    for (const phrase of expandToken(word)) {
      if (splitWords(phrase).some((expanded) => b.has(expanded))) {
        count++;
        break;
      }
    }
  }
  return count;
}

/**
 * Vocabulary overlap alone, with no category bonus in it. This is the number
 * that decides whether a tool from another category is related at all, so it
 * has to stay separable from the sibling bonus.
 */
function overlapScore(metaTokens: Set<string>, candidateTokens: Set<string>): number {
  return (
    overlapWeight(metaTokens, candidateTokens) +
    synonymOverlapCount(metaTokens, candidateTokens) * SYNONYM_WEIGHT
  );
}

/**
 * The tools most related to `meta`, best first, ties broken by name, capped at
 * `n` (clamped to 3-6) and with `meta` excluded from its own results.
 *
 * Selection runs in tiers, so nothing unrelated is ever shown just to fill the
 * row out:
 *
 *  1. every tool in the same category, best first;
 *  2. tools from other categories carrying at least `CROSS_CATEGORY_MIN`
 *     vocabulary overlap;
 *  3. only if that came to fewer than three, the strongest remaining tools
 *     with any overlap at all, up to three.
 *
 * A tool that shares no vocabulary and no category is never returned, so a
 * one-tool category can legitimately produce a short list, or none.
 */
export function relatedTools<T extends RelatedTool>(
  meta: T,
  allMetas: readonly T[],
  n: number = DEFAULT_RESULTS,
): T[] {
  const count = Math.min(Math.max(n, MIN_RESULTS), MAX_RESULTS);
  const metaTokens = tokenSet(meta);

  const scored = allMetas
    .filter((candidate) => candidate.slug !== meta.slug)
    .map((candidate) => {
      const overlap = overlapScore(metaTokens, tokenSet(candidate));
      const sibling = candidate.category === meta.category;
      return { candidate, overlap, sibling, score: overlap + (sibling ? CATEGORY_WEIGHT : 0) };
    });

  const byRank = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    b.score - a.score || a.candidate.name.localeCompare(b.candidate.name);

  const siblings = scored.filter((entry) => entry.sibling).sort(byRank);
  const outsiders = scored.filter((entry) => !entry.sibling).sort(byRank);

  const picked = [
    ...siblings,
    ...outsiders.filter((entry) => entry.overlap >= CROSS_CATEGORY_MIN),
  ];

  if (picked.length < MIN_RESULTS) {
    const weaker = outsiders.filter(
      (entry) => entry.overlap > 0 && entry.overlap < CROSS_CATEGORY_MIN,
    );
    picked.push(...weaker.slice(0, MIN_RESULTS - picked.length));
  }

  return picked.slice(0, count).map((entry) => entry.candidate);
}
