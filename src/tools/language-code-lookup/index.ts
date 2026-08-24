import {
  LANGUAGES,
  SCRIPTS,
  WIKIDATA_META,
  type Language,
  type Script,
  type TextDirection,
} from "../_generated/wikidata-languages";
import { ToolError, type ToolLogic } from "../types";

/**
 * Language code lookup: one search box over the 8,265 ISO 639 languages and
 * 274 ISO 15924 scripts in the Wikidata snapshot.
 *
 * Matches a language's ISO 639-1, ISO 639-2, or ISO 639-3 code, its English
 * name, or its native name. A query that fits a writing script better than
 * any language, either its four letter ISO 15924 code or its name, returns
 * the script's record instead, so typing "Cyrl" or "Cyrillic" works without
 * a separate mode.
 *
 * Two dataset quirks this file leans on:
 *  - `scripts` on a language is often empty even for a widely written
 *    language (French is the flagship example) because Wikidata usually
 *    connects a language to its own alphabet rather than to the ISO 15924
 *    script. An empty array reads as "not recorded", not "unwritten".
 *  - Several ISO 639-3 codes share an English name (two unrelated languages
 *    both called "Bemba" is a real example), so a plain name search can
 *    still be ambiguous even though the name looks unique at a glance.
 */

const SOURCE_NOTE = `Wikidata, CC0 1.0. Snapshot built ${WIKIDATA_META.builtAt.slice(0, 10)}.`;

export type LanguageMatchField = "name" | "nativeName" | "iso1" | "iso2" | "iso3";

export interface LanguageMatch {
  language: Language;
  /** Higher is better. Exact name or code 1000 down to 230 for a loose native-name substring. */
  score: number;
  matchedOn: LanguageMatchField;
}

export type ScriptMatchField = "code" | "name";

export interface ScriptMatch {
  script: Script;
  score: number;
  matchedOn: ScriptMatchField;
}

function byNameThenQid(a: Language, b: Language): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0;
}

function byScriptName(a: Script, b: Script): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function scoreLanguage(l: Language, q: string): LanguageMatch | undefined {
  const name = l.name.toLowerCase();
  const native = l.nativeName?.toLowerCase();
  const iso1 = l.iso1?.toLowerCase();
  const iso2 = l.iso2?.toLowerCase();
  const iso3 = l.iso3?.toLowerCase();

  if (name === q) return { language: l, score: 1000, matchedOn: "name" };
  if (native === q) return { language: l, score: 980, matchedOn: "nativeName" };
  if (iso1 === q) return { language: l, score: 970, matchedOn: "iso1" };
  if (iso2 === q) return { language: l, score: 960, matchedOn: "iso2" };
  if (iso3 === q) return { language: l, score: 950, matchedOn: "iso3" };
  if (name.startsWith(q)) return { language: l, score: 500, matchedOn: "name" };
  if (native?.startsWith(q)) return { language: l, score: 480, matchedOn: "nativeName" };
  if (name.includes(q)) return { language: l, score: 250, matchedOn: "name" };
  if (native?.includes(q)) return { language: l, score: 230, matchedOn: "nativeName" };
  return undefined;
}

function scoreScript(s: Script, q: string): ScriptMatch | undefined {
  const code = s.code.toLowerCase();
  const name = s.name.toLowerCase();

  if (code === q) return { script: s, score: 1000, matchedOn: "code" };
  if (name === q) return { script: s, score: 950, matchedOn: "name" };
  if (name.startsWith(q)) return { script: s, score: 500, matchedOn: "name" };
  if (code.startsWith(q)) return { script: s, score: 480, matchedOn: "code" };
  if (name.includes(q)) return { script: s, score: 250, matchedOn: "name" };
  return undefined;
}

/**
 * Ranked language matches for an ISO 639 code, English name, or native name.
 * Best first, ties broken alphabetically by English name then Wikidata id.
 */
export function findLanguage(text: string, limit = 10): LanguageMatch[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();

  const out: LanguageMatch[] = [];
  for (const l of LANGUAGES) {
    const hit = scoreLanguage(l, q);
    if (hit) out.push(hit);
  }
  out.sort((a, b) => b.score - a.score || byNameThenQid(a.language, b.language));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Ranked script matches for an ISO 15924 code or script name. Best first,
 * ties broken alphabetically by name then code.
 */
export function findScript(text: string, limit = 10): ScriptMatch[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();

  const out: ScriptMatch[] = [];
  for (const s of SCRIPTS) {
    const hit = scoreScript(s, q);
    if (hit) out.push(hit);
  }
  out.sort((a, b) => b.score - a.score || byScriptName(a.script, b.script));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Looser language suggestions for a query that matched nothing. Shortens
 * each word of the query one letter at a time down to three and returns the
 * first stem that turns up any language name. Only ever runs on the error
 * path.
 */
export function suggestions(text: string, limit = 3): Language[] {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  for (const word of words) {
    for (let length = word.length; length >= 3; length--) {
      const stem = word.slice(0, length);
      const hits = LANGUAGES.filter((l) => l.name.toLowerCase().includes(stem));
      if (hits.length) return hits.sort(byNameThenQid).slice(0, limit);
    }
  }
  return [];
}

export function wikipediaUrl(l: Language): string | undefined {
  if (!l.wikipedia) return undefined;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(l.wikipedia.replace(/ /g, "_"))}`;
}

function formatDirection(d?: TextDirection): string {
  switch (d) {
    case "ltr":
      return "Left to right";
    case "rtl":
      return "Right to left";
    case "vertical-rl":
      return "Vertical, columns run right to left";
    case "vertical-lr":
      return "Vertical, columns run left to right";
    case "boustrophedon":
      return "Boustrophedon, direction alternates each line";
    default:
      return "Not recorded";
  }
}

function formatScripts(scripts: Language["scripts"]): string {
  if (!scripts.length) return "Not recorded";
  return scripts.map((s) => (s.name ? `${s.name} (${s.code})` : s.code)).join(", ");
}

/** The full data sheet for one language, ready for the record renderer. */
export function describeLanguage(l: Language): Record<string, string> {
  return {
    Type: "Language",
    Name: l.name,
    "Native name": l.nativeName ?? "Not recorded",
    "ISO 639-1": l.iso1 ?? "Not recorded",
    "ISO 639-2": l.iso2 ?? "Not recorded",
    "ISO 639-3": l.iso3 ?? "Not recorded",
    Scripts: formatScripts(l.scripts),
    Direction: formatDirection(l.direction),
    Speakers: l.speakers !== undefined ? l.speakers.toLocaleString("en-US") : "Not recorded",
    Family: l.family ?? "Not recorded",
    ...(wikipediaUrl(l) ? { Wikipedia: wikipediaUrl(l)! } : {}),
    Source: SOURCE_NOTE,
  };
}

/** The full data sheet for one writing script, ready for the record renderer. */
export function describeScript(s: Script): Record<string, string> {
  return {
    Type: "Writing script (ISO 15924)",
    Name: s.name,
    "ISO 15924 code": s.code,
    Direction: formatDirection(s.direction),
    Source: SOURCE_NOTE,
  };
}

function pickBestLanguage(matches: LanguageMatch[], raw: string): Language {
  const top = matches[0]!;
  const runnerUp = matches[1];
  const tied =
    runnerUp !== undefined &&
    runnerUp.score === top.score &&
    runnerUp.language.qid !== top.language.qid;
  if (tied)
    throw new ToolError(
      "ambiguous",
      `"${raw}" matches ${matches.length === 10 ? "10 or more" : matches.length} languages equally well.`,
      `Try one of ${matches
        .slice(0, 3)
        .map((m) => `${m.language.name} (${m.language.iso3 ?? m.language.qid})`)
        .join(", ")}.`,
    );
  return top.language;
}

function pickBestScript(matches: ScriptMatch[], raw: string): Script {
  const top = matches[0]!;
  const runnerUp = matches[1];
  const tied =
    runnerUp !== undefined &&
    runnerUp.score === top.score &&
    runnerUp.script.code !== top.script.code;
  if (tied)
    throw new ToolError(
      "ambiguous",
      `"${raw}" matches ${matches.length === 10 ? "10 or more" : matches.length} scripts equally well.`,
      `Try one of ${matches
        .slice(0, 3)
        .map((m) => `${m.script.name} (${m.script.code})`)
        .join(", ")}.`,
    );
  return top.script;
}

export function run(input: string, _opts?: Record<string, unknown>): Record<string, string> {
  const raw = String(input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "No language to look up.",
      'Type an ISO 639 code like "ja", a language name like "Swahili", or a script name or ISO 15924 code like "Cyrillic" or "Cyrl".',
    );

  const langMatches = findLanguage(raw, 10);
  const scriptMatches = findScript(raw, 10);
  const bestLangScore = langMatches[0]?.score ?? -1;
  const bestScriptScore = scriptMatches[0]?.score ?? -1;

  if (bestLangScore < 0 && bestScriptScore < 0) {
    const guesses = suggestions(raw);
    throw new ToolError(
      "no-match",
      `Nothing matches "${raw}".`,
      guesses.length
        ? `Did you mean ${guesses.map((l) => l.name).join(", ")}?`
        : "Try an ISO 639-1, 639-2, or 639-3 code, a language name, or an ISO 15924 script.",
    );
  }

  if (bestScriptScore > bestLangScore) return describeScript(pickBestScript(scriptMatches, raw));
  return describeLanguage(pickBestLanguage(langMatches, raw));
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Record<string, unknown>>;
