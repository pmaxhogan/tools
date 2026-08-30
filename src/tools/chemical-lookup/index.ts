import { CHEMICALS, type Chemical, type NfpaRating } from "../_generated/chem-data";
import {
  CHEM_BROAD_META,
  chemCid,
  chemHasGhs,
  chemHasNfpa,
  chemIsDrug,
  type ChemIndexRow,
  type ChemNfpaRating,
  type ChemRecord,
} from "../_generated/chem-index";
import { PICTOGRAMS } from "../_generated/ghs-statements";
import { ToolError, type ToolLogic } from "../types";

/**
 * Chemical lookup: one search box over every compound in the dataset, one full
 * data sheet.
 *
 * Searches names, synonyms, CAS registry numbers, molecular formulas and molar
 * masses, then reports the formula, molar mass, physical properties, NFPA 704
 * diamond, GHS classification and source links for the match.
 *
 * THE TWO TIERS
 * -------------
 * The dataset ships in two pieces and this module serves both.
 *
 * - The narrow tier is `CHEMICALS`, 3,050 compounds bundled into this file's
 *   JavaScript. `lookup`, `suggestions`, `describeChemical` and `run` work on
 *   it, and `run` has to: it is also the curl endpoint, and a pure function
 *   cannot fetch a static asset.
 * - The broad tier is 25,248 compounds under `/data/chem/`, too large to
 *   bundle. The panel fetches the index, and the functions below the
 *   "THE BROAD TIER" banner search and render whatever it hands them. They
 *   take the data as an argument and fetch nothing.
 *
 * Two things about the data worth knowing before reading this file:
 *
 * - Hazard statements, pictogram sets and precautionary sets are interned and
 *   shared between rows, so nothing here sorts or mutates them in place.
 * - `ghs.h[].text` is the statement as the notifying body worded it, including
 *   the bracketed hazard class. That is what this tool shows, because it is
 *   reporting what was notified for this specific compound. The canonical UN
 *   wording for a code lives in H_STATEMENTS and is what the GHS pictogram
 *   lookup shows instead.
 */

/** Reference only wording. Byte identical to the copy in nfpa-704-fire-diamond. */
export const DISCLAIMER =
  "Reference only. Nothing here is a basis for a workplace safety decision. Verify every rating against the safety data sheet, NFPA 704 itself, and the authority having jurisdiction.";

export type MatchField = "name" | "CAS" | "synonym" | "formula";

export interface ChemicalMatch {
  chemical: Chemical;
  /** Higher is better. Exact name 1000, exact CAS 950, down to 130 for a loose synonym hit. */
  score: number;
  matchedOn: MatchField;
}

const PICTOGRAM_NAMES: Record<string, string> = {};
for (const p of PICTOGRAMS) PICTOGRAM_NAMES[p.code] = p.name;

function byName(a: Chemical, b: Chemical): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** How much this row actually carries, used only to break a scoring tie. */
function completeness(c: Chemical): number {
  return (
    (c.nfpa ? 1 : 0) +
    (c.nfpaAlt ? 1 : 0) +
    (c.ghs ? 1 : 0) +
    (c.cas ? 1 : 0) +
    (c.formula ? 1 : 0) +
    (c.molarMass !== undefined ? 1 : 0) +
    (c.props ? 1 : 0) +
    (c.wikipedia ? 1 : 0) +
    (c.cid !== undefined ? 1 : 0)
  );
}

function scoreOne(c: Chemical, q: string, raw: string, cas: string): ChemicalMatch | undefined {
  const name = c.name.toLowerCase();
  if (name === q) return { chemical: c, score: 1000, matchedOn: "name" };
  if (c.cas && c.cas === cas) return { chemical: c, score: 950, matchedOn: "CAS" };
  if (c.synonyms.some((s) => s.toLowerCase() === q))
    return { chemical: c, score: 700, matchedOn: "synonym" };
  if (c.formula && c.formula === raw) return { chemical: c, score: 600, matchedOn: "formula" };
  if (c.formula && c.formula.toLowerCase() === q)
    return { chemical: c, score: 560, matchedOn: "formula" };
  if (name.startsWith(q)) return { chemical: c, score: 500, matchedOn: "name" };
  if (c.synonyms.some((s) => s.toLowerCase().startsWith(q)))
    return { chemical: c, score: 320, matchedOn: "synonym" };
  if (name.includes(q)) return { chemical: c, score: 250, matchedOn: "name" };
  if (c.synonyms.some((s) => s.toLowerCase().includes(q)))
    return { chemical: c, score: 130, matchedOn: "synonym" };
  return undefined;
}

/**
 * Ranked matches for a name, synonym, CAS number or formula. Best first, with
 * ties broken by how much data the row carries, then by the shorter name, then
 * alphabetically, so the order never depends on the platform's collation.
 */
export function lookup(text: string, limit = 10): ChemicalMatch[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();
  const cas = raw.replace(/\s+/g, "");

  const out: ChemicalMatch[] = [];
  for (const c of CHEMICALS) {
    const hit = scoreOne(c, q, raw, cas);
    if (hit) out.push(hit);
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      completeness(b.chemical) - completeness(a.chemical) ||
      a.chemical.name.length - b.chemical.name.length ||
      byName(a.chemical, b.chemical),
  );
  return out.slice(0, Math.max(0, limit));
}

/**
 * Looser suggestions for a query that matched nothing. Each word of the query
 * is shortened one letter at a time down to four, and the first stem that turns
 * up any chemical name wins, so a typo like "acetonezz" still reaches acetone.
 * Only ever runs on the error path.
 */
export function suggestions(text: string, limit = 3): Chemical[] {
  const query = String(text ?? "")
    .toLowerCase()
    .trim();
  if (query.length < 4) return [];

  // First preference: names (or short synonyms) within a small edit distance
  // of the whole query, so "acetne" reaches Acetone instead of whatever
  // shares a four letter stem. The distance is bounded, and candidates whose
  // length differs by more than the bound are skipped before any cell of the
  // matrix is computed, which keeps the scan linear in practice.
  const MAX_DISTANCE = Math.min(3, Math.max(1, Math.floor(query.length / 3)));
  const scored: { c: Chemical; distance: number; length: number }[] = [];
  for (const c of CHEMICALS) {
    let best = Number.POSITIVE_INFINITY;
    const candidates = [c.name, ...c.synonyms.filter((s) => s.length <= 24).slice(0, 4)];
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (Math.abs(lower.length - query.length) > MAX_DISTANCE) continue;
      const d = boundedEditDistance(query, lower, MAX_DISTANCE);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= MAX_DISTANCE) scored.push({ c, distance: best, length: c.name.length });
  }
  if (scored.length) {
    scored.sort(
      (a, b) => a.distance - b.distance || a.length - b.length || (a.c.name < b.c.name ? -1 : 1),
    );
    return scored.slice(0, limit).map((s) => s.c);
  }

  // Fallback: shorten each word until any chemical name contains the stem, so
  // a mangled or partial query still gets pointed somewhere sensible.
  const words = query.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (const word of words) {
    for (let length = word.length; length >= 4; length--) {
      const stem = word.slice(0, length);
      const hits = CHEMICALS.filter((c) => c.name.toLowerCase().includes(stem));
      if (hits.length) return hits.sort(byName).slice(0, limit);
    }
  }
  return [];
}

/**
 * Damerau-Levenshtein distance (adjacent transpositions count as one edit),
 * capped: any row whose minimum exceeds `bound` aborts with Infinity so a
 * hopeless candidate costs almost nothing.
 */
function boundedEditDistance(a: string, b: string, bound: number): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j < cols; j += 1) {
      const substitution = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let value = Math.min(prev[j]! + 1, current[j - 1]! + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2]! + 1);
      }
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > bound) return Number.POSITIVE_INFINITY;
    prevPrev = prev;
    prev = current;
  }
  return prev[cols - 1]!;
}

export function wikipediaUrl(c: Chemical): string | undefined {
  if (!c.wikipedia) return undefined;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(c.wikipedia.replace(/ /g, "_"))}`;
}

export function pubchemUrl(c: Chemical): string | undefined {
  if (c.cid === undefined) return undefined;
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${c.cid}`;
}

/** "Health 3, Fire 0, Instability 1, W (HSDB)" */
export function formatNfpa(rating: NfpaRating): string {
  const parts = [`Health ${rating.h}`, `Fire ${rating.f}`, `Instability ${rating.r}`];
  const specials = ["W", "OX", "SA"].filter((s) => rating.special.includes(s as "W" | "OX" | "SA"));
  if (specials.length) parts.push(specials.join(" "));
  return `${parts.join(", ")} (${rating.source})`;
}

const SYNONYM_CAP = 6;
const P_CODE_CAP = 24;

/** The full data sheet for one chemical, ready for the record renderer. */
export function describeChemical(c: Chemical): Record<string, string> {
  const out: Record<string, string> = { Name: c.name };
  if (c.synonyms.length) {
    const shown = c.synonyms.slice(0, SYNONYM_CAP).join(", ");
    const extra = c.synonyms.length - Math.min(SYNONYM_CAP, c.synonyms.length);
    out["Also known as"] = extra > 0 ? `${shown}, and ${extra} more` : shown;
  }
  if (c.formula) out["Formula"] = c.formula;
  if (c.molarMass !== undefined) out["Molar mass"] = `${c.molarMass} g/mol`;
  if (c.cas) out["CAS number"] = c.cas;

  if (c.props?.density) out["Density"] = c.props.density;
  if (c.props?.meltingPoint) out["Melting point"] = c.props.meltingPoint;
  if (c.props?.boilingPoint) out["Boiling point"] = c.props.boilingPoint;
  if (c.props?.flashPoint) out["Flash point"] = c.props.flashPoint;

  if (c.nfpa) out["NFPA 704"] = formatNfpa(c.nfpa);
  if (c.nfpaAlt) out["NFPA 704, second source"] = formatNfpa(c.nfpaAlt);

  if (c.ghs) {
    if (c.ghs.signal) out["GHS signal word"] = c.ghs.signal;
    if (c.ghs.pictograms.length)
      out["GHS pictograms"] = c.ghs.pictograms
        .map((code) => (PICTOGRAM_NAMES[code] ? `${code} ${PICTOGRAM_NAMES[code]}` : code))
        .join(", ");
    if (c.ghs.h.length)
      out["GHS hazard statements"] = c.ghs.h.map((h) => `${h.code} ${h.text}`).join("; ");
    if (c.ghs.p.length) {
      const shown = c.ghs.p.slice(0, P_CODE_CAP).join(", ");
      const extra = c.ghs.p.length - Math.min(P_CODE_CAP, c.ghs.p.length);
      out["GHS precautionary statements"] = extra > 0 ? `${shown}, and ${extra} more` : shown;
    }
  }

  const wiki = wikipediaUrl(c);
  const pubchem = pubchemUrl(c);
  if (wiki) out["Wikipedia"] = wiki;
  if (pubchem) out["PubChem"] = pubchem;
  out["Sources"] = wiki
    ? "PubChem (public domain) and English Wikipedia (CC BY-SA 4.0), credited by the article link above."
    : "PubChem (public domain, US National Library of Medicine).";
  out["Note"] = DISCLAIMER;
  return out;
}

/**
 * The generic path and the curl endpoint.
 *
 * This answers from the narrow tier, the 3,050 compounds bundled with this
 * module, while the tool's own page searches all 25,248. That is deliberate:
 * `run` is pure by contract, the broad tier is 129 JSON files fetched over the
 * network, and a Worker request handler serving them back to itself would be a
 * worse answer than a smaller honest one. The narrow tier is the subset that
 * carries an NFPA rating or a GHS classification, which is what an API caller
 * is almost always after.
 */
export function run(input: string, _opts?: Record<string, unknown>): Record<string, string> {
  const text = String(input ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No chemical to look up.",
      'Type a name like "acetone", a CAS number like "67-64-1", or a formula like "H2SO4".',
    );

  const matches = lookup(text, 10);
  if (!matches.length) {
    const guesses = suggestions(text);
    throw new ToolError(
      "no-match",
      `Nothing in the dataset matches "${text}".`,
      guesses.length
        ? `Did you mean ${guesses.map((c) => c.name).join(", ")}?`
        : "Try the common name, a synonym, the CAS registry number, or the molecular formula.",
    );
  }

  const top = matches[0]!;
  const runnerUp = matches[1];
  const tied =
    runnerUp !== undefined &&
    runnerUp.score === top.score &&
    runnerUp.chemical.name.toLowerCase() !== top.chemical.name.toLowerCase();
  if (tied)
    throw new ToolError(
      "ambiguous",
      `"${text}" matches ${matches.length === 10 ? "10 or more" : matches.length} chemicals equally well.`,
      `Try one of ${matches
        .slice(0, 3)
        .map((m) => m.chemical.name)
        .join(", ")}.`,
    );

  return describeChemical(top.chemical);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Record<string, unknown>>;

/* ==================================================================== *
 *  THE BROAD TIER
 *
 *  Everything above this line reads CHEMICALS, the 3,050 compound narrow
 *  tier that ships inside this module's JavaScript. `run()` stays on it,
 *  because the curl endpoint and the generic panel both call `run()`
 *  directly and neither can fetch a static asset from a pure function.
 *
 *  Everything below works on the broad tier instead: 25,248 compounds that
 *  live in `/data/chem/` and are fetched by the panel. Nothing here fetches
 *  anything. The panel reads `CHEM_INDEX_URL` once, hands the parsed rows to
 *  `prepareChemIndex`, and every search after that is a pure call into
 *  `searchChemIndex`. Picking a compound costs one shard fetch, and the
 *  record that comes back is rendered by `renderRecord`.
 * ==================================================================== */

/**
 * The index rows with the derived keys a search needs, computed once instead
 * of 25,248 times per keystroke. Hold on to the result and pass it to every
 * `searchChemIndex` call; rebuilding it per query is the whole cost.
 */
export interface PreparedChemIndex {
  rows: ChemIndexRow[];
  /** Lowercased name, aligned with `rows`. */
  names: string[];
  /** Lowercased formula with whitespace removed, "" when unknown. */
  formulas: string[];
  /**
   * A sorted "element then count" signature of the formula, so H2SO4, O4SH2
   * and SO4H2 all share one key. "" when the formula did not parse.
   */
  formulaKeys: string[];
  /** CAS number with whitespace removed, "" when unknown. */
  cas: string[];
  /**
   * Lowercased alternative names from the index row's optional `syn` column,
   * aligned with `rows`. Empty for a row that carries none, whether because
   * this build had nothing to offer or because index.json's own size budget
   * cut the column down (see `CHEM_BROAD_META.indexSynCap`).
   */
  synonyms: string[][];
}

export interface ChemFilters {
  /** Only compounds carrying an NFPA 704 rating. */
  nfpa?: boolean;
  /** Only compounds carrying a GHS classification. */
  ghs?: boolean;
  /** Only compounds whose Wikipedia article is a drug article. */
  drug?: boolean;
}

export type ChemMatchField = "name" | "formula" | "cas" | "mass" | "fuzzy" | "synonym";

export interface ChemSearchHit {
  id: number;
  name: string;
  /** "" when the dataset has none. */
  formula: string;
  /** "" when the dataset has none. */
  cas: string;
  /** Grams per mole, or undefined when the dataset has none. */
  molarMass: number | undefined;
  /** The PubChem CID, or undefined when this build could not resolve one. */
  cid: number | undefined;
  hasNfpa: boolean;
  hasGhs: boolean;
  isDrug: boolean;
  /** Higher is better. See the SCORE_ constants for the ladder. */
  score: number;
  matchedOn: ChemMatchField;
}

export interface ChemSearchOptions {
  limit?: number;
  filters?: ChemFilters;
  /** Set false to skip the edit distance pass, which is the expensive one. */
  fuzzy?: boolean;
}

/* ---- the scoring ladder -------------------------------------------- *
 * Exact name beats a prefix, a prefix beats formula and CAS, and the
 * bounded edit distance pass sits underneath everything, so a typo never
 * outranks something the query actually spells.                         */

export const SCORE_NAME_EXACT = 1000;
export const SCORE_NAME_PREFIX = 800;
/** Every word of the query is the start of a word in the name. */
export const SCORE_NAME_TOKENS = 700;
export const SCORE_NAME_SUBSTRING = 620;
export const SCORE_FORMULA_EXACT = 600;
/** Same elements in the same counts, written in a different order. */
export const SCORE_FORMULA_HILL = 580;
export const SCORE_CAS_EXACT = 560;
export const SCORE_CAS_PARTIAL = 420;
export const SCORE_FORMULA_PARTIAL = 380;
export const SCORE_MASS = 300;
/** Minus ten per edit, so a one letter slip sorts above a three letter one. */
export const SCORE_FUZZY = 200;

/** A bare number is read as a molar mass within this many g/mol. */
export const MASS_TOLERANCE = 0.5;
/** Below this many strict hits the edit distance pass runs. */
const FUZZY_TRIGGER = 5;
/** Shorter queries produce noise rather than corrections. */
const FUZZY_MIN_LENGTH = 4;

const ELEMENT_TOKEN = /([A-Z][a-z]?)(\d*)|(\()|(\))(\d*)/g;

/**
 * Element counts for a properly cased formula, or undefined when the string is
 * not one. Handles nested groups, so Ca(OH)2 and K3[Fe(CN)6] both parse once
 * the brackets are normalized to parentheses.
 *
 * Case matters and is not inferred: "co" is carbon monoxide or cobalt
 * depending on who typed it, so a lowercase query never reaches this function.
 * A lowercase formula is matched as a string instead, which is exact and never
 * guesses.
 */
export function parseFormula(text: string): Map<string, number> | undefined {
  const source = String(text ?? "")
    .replace(/[[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/\s+/g, "");
  if (!source || !/^[A-Za-z0-9()]+$/.test(source)) return undefined;
  if (!/[A-Z]/.test(source)) return undefined;

  const stack: Map<string, number>[] = [new Map()];
  let consumed = 0;
  ELEMENT_TOKEN.lastIndex = 0;
  for (let m = ELEMENT_TOKEN.exec(source); m; m = ELEMENT_TOKEN.exec(source)) {
    if (m.index !== consumed) return undefined;
    consumed = m.index + m[0].length;
    const top = stack[stack.length - 1]!;
    if (m[1]) {
      const count = m[2] ? Number(m[2]) : 1;
      if (!Number.isFinite(count) || count < 1) return undefined;
      top.set(m[1], (top.get(m[1]) ?? 0) + count);
    } else if (m[3]) {
      stack.push(new Map());
    } else {
      const group = stack.pop();
      if (!group || !stack.length) return undefined;
      const multiplier = m[5] ? Number(m[5]) : 1;
      if (!Number.isFinite(multiplier) || multiplier < 1) return undefined;
      const parent = stack[stack.length - 1]!;
      for (const [el, n] of group) parent.set(el, (parent.get(el) ?? 0) + n * multiplier);
    }
  }
  if (consumed !== source.length || stack.length !== 1) return undefined;
  const out = stack[0]!;
  return out.size ? out : undefined;
}

/** "H2O4S1" style signature: elements sorted, counts appended, order irrelevant. */
export function formulaKey(text: string): string {
  const parsed = parseFormula(text);
  if (!parsed) return "";
  return [...parsed.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([el, n]) => `${el}${n}`)
    .join("");
}

/**
 * Derives the search keys for a fetched index. Cheap enough to run on mount
 * (one pass over 25,248 rows) and worth every millisecond it saves later.
 */
export function prepareChemIndex(rows: readonly ChemIndexRow[]): PreparedChemIndex {
  const list = rows as ChemIndexRow[];
  const names: string[] = new Array(list.length);
  const formulas: string[] = new Array(list.length);
  const formulaKeys: string[] = new Array(list.length);
  const cas: string[] = new Array(list.length);
  const synonyms: string[][] = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i]!;
    names[i] = row[1].toLowerCase();
    const f = row[2] ? row[2].replace(/\s+/g, "") : "";
    formulas[i] = f.toLowerCase();
    formulaKeys[i] = f ? formulaKey(f) : "";
    cas[i] = row[3] ? row[3].replace(/\s+/g, "") : "";
    synonyms[i] = row[6] ? row[6].map((s) => s.toLowerCase()) : [];
  }
  return { rows: list, names, formulas, formulaKeys, cas, synonyms };
}

/** A molar mass window, in grams per mole, inclusive at both ends. */
export interface MassRange {
  min: number;
  max: number;
}

/**
 * Reads a molar mass query. "mass:98-99" and "mw:98-99" give the range as
 * written; "mass:98" and a bare "98.08" give a window of plus or minus
 * MASS_TOLERANCE. Anything else is not a mass query.
 */
export function parseMassQuery(text: string): MassRange | undefined {
  const raw = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return undefined;
  const prefixed = /^(?:mass|mw|molar mass|molarmass)\s*[:=]\s*(.+)$/.exec(raw);
  const body = prefixed ? prefixed[1]!.trim() : raw;

  const range = /^(\d+(?:\.\d+)?)\s*(?:-|to|\.\.)\s*(\d+(?:\.\d+)?)$/.exec(body);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  if (!/^\d+(?:\.\d+)?$/.test(body)) return undefined;
  // A bare integer with no prefix is more likely a CAS fragment than a mass,
  // but both searches run and CAS outranks mass, so reading it as both costs
  // nothing and looking a compound up by its molar mass is a real use.
  const value = Number(body);
  if (!Number.isFinite(value)) return undefined;
  return { min: value - MASS_TOLERANCE, max: value + MASS_TOLERANCE };
}

/** True when the row passes every filter that is switched on. */
function passesFilters(row: ChemIndexRow, filters: ChemFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.nfpa && !chemHasNfpa(row)) return false;
  if (filters.ghs && !chemHasGhs(row)) return false;
  if (filters.drug && !chemIsDrug(row)) return false;
  return true;
}

/** How much this row carries, used only to break a scoring tie. */
function indexCompleteness(prepared: PreparedChemIndex, i: number): number {
  const row = prepared.rows[i]!;
  return (
    (chemHasNfpa(row) ? 2 : 0) +
    (chemHasGhs(row) ? 2 : 0) +
    (prepared.cas[i] ? 1 : 0) +
    (prepared.formulas[i] ? 1 : 0) +
    (row[4] ? 1 : 0)
  );
}

interface ScoredIndexHit {
  index: number;
  hit: ChemSearchHit;
}

function hitFor(
  prepared: PreparedChemIndex,
  i: number,
  score: number,
  on: ChemMatchField,
): ScoredIndexHit {
  const row = prepared.rows[i]!;
  return {
    index: i,
    hit: {
      id: row[0],
      name: row[1],
      formula: row[2],
      cas: row[3],
      molarMass: row[4] || undefined,
      cid: chemCid(row),
      hasNfpa: chemHasNfpa(row),
      hasGhs: chemHasGhs(row),
      isDrug: chemIsDrug(row),
      score,
      matchedOn: on,
    },
  };
}

function matchesTokens(name: string, tokens: string[]): boolean {
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.every((t) => words.some((w) => w.startsWith(t)));
}

/**
 * The best of a row's own synonym tier for `q`: exact, then prefix, then
 * substring, matching the SCORE_SYNONYM_ constants. A row with no synonyms
 * (most of the broad tier, and every row before index.json carried a `syn`
 * column) simply scores 0 here.
 */
function synonymTier(rowSynonyms: string[], q: string): number {
  if (!q) return 0;
  let best = 0;
  for (const s of rowSynonyms) {
    if (s === q) return SCORE_SYNONYM_EXACT;
    if (best < SCORE_SYNONYM_PREFIX && s.startsWith(q)) best = SCORE_SYNONYM_PREFIX;
    else if (best < SCORE_SYNONYM_SUBSTRING && q.length >= 2 && s.includes(q)) {
      best = SCORE_SYNONYM_SUBSTRING;
    }
  }
  return best;
}

function compareNames(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : 0;
}

/**
 * Ranked matches over the broad index.
 *
 * The ladder, best first:
 *
 *   1. the name, exactly
 *   2. the name, by prefix
 *   3. a `syn` entry, exactly
 *   4. the name, word by word
 *   5. a `syn` entry, by prefix
 *   6. the name, anywhere inside it
 *   7. the molecular formula, as written or as the same elements in another
 *      order (H2SO4 also answers to h2so4 and to O4SH2)
 *   8. the CAS registry number, exactly
 *   9. a `syn` entry, anywhere inside it
 *   10. the CAS registry number, as a fragment
 *   11. the molar mass, from "mass:98-99" or a bare number within half a gram
 *       per mole
 *   12. a bounded Damerau-Levenshtein pass, so "acetne" still reaches acetone
 *
 * Only one tier scores per row, the best one. A row with no `syn` entries
 * (most rows before index.json carried the column, and any row this build had
 * nothing to offer) simply never reaches tiers 3, 5 or 9. Ties break on how
 * much the row carries, then the shorter name, then alphabetically, then by
 * id, so the order never depends on the platform's collation. The edit
 * distance pass only runs when the strict tiers came back nearly empty,
 * because it is the only part of this that is not a string comparison.
 */
export function searchChemIndex(
  prepared: PreparedChemIndex,
  text: string,
  options: ChemSearchOptions = {},
): ChemSearchHit[] {
  const limit = Math.max(0, options.limit ?? 50);
  const filters = options.filters;
  const raw = String(text ?? "").trim();
  if (!raw || !limit) return [];

  const q = raw.toLowerCase();
  const compact = raw.replace(/\s+/g, "");
  const compactLower = compact.toLowerCase();
  const queryKey = /[A-Z]/.test(compact) ? formulaKey(compact) : "";
  const casLike = /^[0-9][0-9-]*$/.test(compact) && compact.length >= 3;
  const mass = parseMassQuery(raw);
  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);

  const scored: ScoredIndexHit[] = [];
  const { rows, names, formulas, formulaKeys, cas, synonyms } = prepared;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!passesFilters(row, filters)) continue;
    const name = names[i]!;
    const synTier = synonyms[i]!.length ? synonymTier(synonyms[i]!, q) : 0;

    let score = 0;
    let on: ChemMatchField = "name";
    if (name === q) {
      score = SCORE_NAME_EXACT;
    } else if (name.startsWith(q)) {
      score = SCORE_NAME_PREFIX;
    } else if (synTier === SCORE_SYNONYM_EXACT) {
      score = synTier;
      on = "synonym";
    } else if (tokens.length > 1 && matchesTokens(name, tokens)) {
      score = SCORE_NAME_TOKENS;
    } else if (synTier === SCORE_SYNONYM_PREFIX) {
      score = synTier;
      on = "synonym";
    } else if (q.length >= 2 && name.includes(q)) {
      score = SCORE_NAME_SUBSTRING;
    }

    const formula = formulas[i]!;
    if (!score && formula) {
      if (formula === compactLower) {
        score = SCORE_FORMULA_EXACT;
        on = "formula";
      } else if (queryKey && formulaKeys[i] === queryKey) {
        score = SCORE_FORMULA_HILL;
        on = "formula";
      }
    }

    const registry = cas[i]!;
    if (!score && registry && casLike && registry === compact) {
      score = SCORE_CAS_EXACT;
      on = "cas";
    }

    if (!score && synTier === SCORE_SYNONYM_SUBSTRING) {
      score = synTier;
      on = "synonym";
    }

    if (!score && registry && casLike && registry.includes(compact)) {
      score = SCORE_CAS_PARTIAL;
      on = "cas";
    }

    if (!score && formula && compactLower.length >= 3 && formula.includes(compactLower)) {
      score = SCORE_FORMULA_PARTIAL;
      on = "formula";
    }

    if (!score && mass && row[4] && row[4] >= mass.min && row[4] <= mass.max) {
      score = SCORE_MASS;
      on = "mass";
    }

    if (score) scored.push(hitFor(prepared, i, score, on));
  }

  const wantFuzzy = options.fuzzy !== false && scored.length < FUZZY_TRIGGER;
  if (wantFuzzy && q.length >= FUZZY_MIN_LENGTH && /[a-z]/.test(q)) {
    const already = new Set(scored.map((s) => s.index));
    const bound = Math.min(3, Math.max(1, Math.floor(q.length / 4)));
    for (let i = 0; i < rows.length; i += 1) {
      if (already.has(i)) continue;
      const name = names[i]!;
      if (Math.abs(name.length - q.length) > bound) continue;
      if (!passesFilters(rows[i]!, filters)) continue;
      const d = boundedEditDistance(q, name, bound);
      if (d <= bound) scored.push(hitFor(prepared, i, SCORE_FUZZY - d * 10, "fuzzy"));
    }
  }

  scored.sort(
    (a, b) =>
      b.hit.score - a.hit.score ||
      indexCompleteness(prepared, b.index) - indexCompleteness(prepared, a.index) ||
      a.hit.name.length - b.hit.name.length ||
      compareNames(a.hit.name, b.hit.name) ||
      a.hit.id - b.hit.id,
  );
  return scored.slice(0, limit).map((s) => s.hit);
}

/* ---- rendering one record ------------------------------------------ */

/**
 * The attribution every Wikipedia derived value owes its article, worded once
 * so the grid row and the panel's caption can never drift apart.
 */
export function wikipediaAttribution(title: string): string {
  return `Text from Wikipedia: ${title}, CC BY-SA 4.0`;
}

export function recordWikipediaUrl(record: ChemRecord): string | undefined {
  if (!record.wikipedia) return undefined;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(record.wikipedia.replace(/ /g, "_"))}`;
}

export function recordPubchemUrl(record: ChemRecord): string | undefined {
  if (record.cid === undefined) return undefined;
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${record.cid}`;
}

/** "Health 3, Fire 0, Instability 1, W (Wikipedia)" */
export function formatChemNfpa(rating: ChemNfpaRating): string {
  return formatNfpa(rating);
}

/**
 * The full data sheet for one broad tier record, ready for KeyValueGrid.
 *
 * The two statement maps are injected rather than imported so the shape stays
 * testable against a two entry fixture; the panel passes H_STATEMENTS and
 * P_STATEMENTS from `_generated/ghs-statements`. A code the map does not carry
 * is printed on its own rather than dropped, because an unexplained H code is
 * still information and a missing row is not.
 */
export function renderRecord(
  record: ChemRecord,
  hStatements: Record<string, string> = {},
  pStatements: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = { Name: record.name };

  const synonyms = record.synonyms ?? [];
  if (synonyms.length) out["Also known as"] = synonyms.join(", ");
  if (record.formula) out["Formula"] = record.formula;
  if (record.molarMass !== undefined) out["Molar mass"] = `${record.molarMass} g/mol`;
  if (record.exactMass !== undefined) out["Exact mass"] = `${record.exactMass} g/mol`;
  if (record.cas) out["CAS number"] = record.cas;
  if (record.cid !== undefined) out["PubChem CID"] = String(record.cid);
  if (record.isDrug) out["Compound type"] = "Drug or medication";

  if (record.props?.density) out["Density"] = record.props.density;
  if (record.props?.meltingPoint) out["Melting point"] = record.props.meltingPoint;
  if (record.props?.boilingPoint) out["Boiling point"] = record.props.boilingPoint;
  if (record.props?.flashPoint) out["Flash point"] = record.props.flashPoint;

  if (record.nfpa) out["NFPA 704"] = formatChemNfpa(record.nfpa);

  const ghs = record.ghs;
  if (ghs) {
    if (ghs.signal) out["GHS signal word"] = ghs.signal;
    if (ghs.pictograms.length)
      out["GHS pictograms"] = ghs.pictograms
        .map((code) => (PICTOGRAM_NAMES[code] ? `${code} ${PICTOGRAM_NAMES[code]}` : code))
        .join(", ");
    if (ghs.h.length)
      out["GHS hazard statements"] = ghs.h
        .map((code) => (hStatements[code] ? `${code} ${hStatements[code]}` : code))
        .join("; ");
    if (ghs.p.length)
      out["GHS precautionary statements"] = ghs.p
        .map((code) => (pStatements[code] ? `${code} ${pStatements[code]}` : code))
        .join("; ");
  }

  if (record.description) {
    out["Description"] = record.description;
    if (record.wikipedia) out["Attribution"] = wikipediaAttribution(record.wikipedia);
  }

  const wiki = recordWikipediaUrl(record);
  const pubchem = recordPubchemUrl(record);
  if (wiki) out["Wikipedia"] = wiki;
  if (pubchem) out["PubChem"] = pubchem;
  out["Sources"] = wiki
    ? "PubChem (public domain, US National Library of Medicine) and English Wikipedia (CC BY-SA 4.0), credited by the article link above."
    : "PubChem (public domain, US National Library of Medicine).";
  out["Note"] = DISCLAIMER;
  return out;
}

/** One line per fact, for the data provenance footer under the tool. */
export function provenanceLines(): string[] {
  const c = CHEM_BROAD_META.counts;
  const n = (value: number) => value.toLocaleString("en-US");
  return [
    `${n(c.compounds)} compounds, built ${CHEM_BROAD_META.builtAt}.`,
    `${n(c.withNfpa)} carry an NFPA 704 rating, ${n(c.withGhs)} a GHS classification, ${n(c.drugs)} are drug articles.`,
    "PubChem data is public domain, from the US National Library of Medicine. Wikipedia text is CC BY-SA 4.0.",
  ];
}

/* ---- the union of the two tiers ------------------------------------ *
 *
 * The broad index is bigger but its names are Wikipedia article titles and
 * it carries no synonyms, so on its own it answers "sodium chloride" with
 * Sodium chlorite, "ethanol" with Ethanolamine and "sulfuric acid" with
 * "Sulfonated phenolics/sulfuric acid". The narrow tier has the canonical
 * name and up to a few dozen synonyms for exactly the compounds people type
 * by hand, and it is already bundled here.
 *
 * So the page searches both and merges the results. Neither tier is a subset
 * of the other: 286 narrow names have no broad row at all, and the broad
 * tier is eight times the size.                                          */

export type ChemTier = "broad" | "narrow";

/**
 * `"synonym"` used to belong only to the narrow tier's own ladder; the broad
 * index now carries a `syn` column too, so `ChemMatchField` already includes
 * it and this alias is kept only so existing imports of `ChemHitField` do not
 * need to change.
 */
export type ChemHitField = ChemMatchField;

/** A synonym is not the name, but someone who typed one meant this compound. */
export const SCORE_SYNONYM_EXACT = 760;
export const SCORE_SYNONYM_PREFIX = 660;
export const SCORE_SYNONYM_SUBSTRING = 540;

/**
 * `lookup` scores on its own ladder, which was written when the narrow tier
 * was the whole dataset: an exact CAS number is its second best hit, where
 * the broad ladder puts CAS below every name match. Mixing the two raw would
 * order results by which tier happened to answer, so every narrow score is
 * translated into the broad ladder here, by hand, once.
 */
export const NARROW_SCORE_MAP: Record<number, { score: number; on: ChemHitField }> = {
  1000: { score: SCORE_NAME_EXACT, on: "name" },
  950: { score: SCORE_CAS_EXACT, on: "cas" },
  700: { score: SCORE_SYNONYM_EXACT, on: "synonym" },
  600: { score: SCORE_FORMULA_EXACT, on: "formula" },
  560: { score: SCORE_FORMULA_EXACT, on: "formula" },
  500: { score: SCORE_NAME_PREFIX, on: "name" },
  320: { score: SCORE_SYNONYM_PREFIX, on: "synonym" },
  250: { score: SCORE_NAME_SUBSTRING, on: "name" },
  130: { score: SCORE_SYNONYM_SUBSTRING, on: "synonym" },
};

/** One result row, whichever tier answered. */
export interface ChemUnionHit {
  /**
   * Stable across builds and safe in a URL. Broad ids are the bare number,
   * narrow ids keep their "cid:180" or "wp:Acetone" form, so `/^\d+$/` is
   * enough to tell a detail view which tier to load from.
   */
  id: string;
  tier: ChemTier;
  name: string;
  /** "" when the dataset has none. */
  formula: string;
  /** "" when the dataset has none. */
  cas: string;
  molarMass: number | undefined;
  hasNfpa: boolean;
  hasGhs: boolean;
  isDrug: boolean;
  score: number;
  matchedOn: ChemHitField;
}

/**
 * How many narrow rows to consider before merging. The narrow ladder is not
 * monotone with the merged one (its exact CAS hit sorts high there and low
 * here), so taking only its own top ten could drop a row that outranks
 * everything once translated. Two hundred rows of a 3,050 row scan is free.
 */
const NARROW_UNION_CAP = 200;

/** Merged rows that share this key are the same compound. */
function unionKey(name: string, cid: number | undefined): string {
  return cid === undefined ? `name:${name.toLowerCase()}` : `cid:${cid}`;
}

function unionCompleteness(hit: ChemUnionHit): number {
  return (
    (hit.hasNfpa ? 2 : 0) +
    (hit.hasGhs ? 2 : 0) +
    (hit.cas ? 1 : 0) +
    (hit.formula ? 1 : 0) +
    (hit.molarMass !== undefined ? 1 : 0)
  );
}

function narrowPasses(c: Chemical, filters: ChemFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.nfpa && !c.nfpa && !c.nfpaAlt) return false;
  if (filters.ghs && !c.ghs) return false;
  // The narrow rows carry no drug flag, so a drug filter simply has no narrow
  // answers. Handled by the caller, which skips the narrow scan entirely.
  return true;
}

/**
 * The search the tool's page runs: both tiers, one ranked list.
 *
 * `prepared` may be undefined, which is what the panel passes while the index
 * is still downloading. The narrow tier then answers on its own, which is a
 * useful search rather than an empty box.
 *
 * Rows are merged on the PubChem CID when both tiers resolved one, and on the
 * lowercased name otherwise. The higher score wins the merge; on a tie the
 * narrow row wins, because its name is the compound's name rather than the
 * title of the article that happened to describe it, and its GHS statements
 * are worded as the notifying body wrote them.
 */
export function searchChemicals(
  prepared: PreparedChemIndex | undefined,
  text: string,
  options: ChemSearchOptions = {},
): ChemUnionHit[] {
  const limit = Math.max(0, options.limit ?? 50);
  const raw = String(text ?? "").trim();
  if (!raw || !limit) return [];
  const filters = options.filters;

  const merged = new Map<string, ChemUnionHit>();
  const consider = (hit: ChemUnionHit, cid: number | undefined) => {
    const key = unionKey(hit.name, cid);
    const held = merged.get(key);
    if (!held) {
      merged.set(key, hit);
      return;
    }
    if (hit.score > held.score) merged.set(key, hit);
    else if (hit.score === held.score && hit.tier === "narrow" && held.tier === "broad")
      merged.set(key, hit);
  };

  if (prepared) {
    const broad = searchChemIndex(prepared, raw, {
      ...options,
      limit: Math.max(limit * 4, 100),
    });
    for (const hit of broad) {
      consider(
        {
          id: String(hit.id),
          tier: "broad",
          name: hit.name,
          formula: hit.formula,
          cas: hit.cas,
          molarMass: hit.molarMass,
          hasNfpa: hit.hasNfpa,
          hasGhs: hit.hasGhs,
          isDrug: hit.isDrug,
          score: hit.score,
          matchedOn: hit.matchedOn,
        },
        // Only a real CID joins the tiers; a synthetic id is this build's own
        // invention and means nothing to the narrow rows.
        hit.cid,
      );
    }
  }

  if (!filters?.drug) {
    for (const match of lookup(raw, NARROW_UNION_CAP)) {
      const c = match.chemical;
      if (!narrowPasses(c, filters)) continue;
      const mapped = NARROW_SCORE_MAP[match.score];
      if (!mapped) continue;
      consider(
        {
          id: c.id,
          tier: "narrow",
          name: c.name,
          formula: c.formula ?? "",
          cas: c.cas ?? "",
          molarMass: c.molarMass,
          hasNfpa: Boolean(c.nfpa ?? c.nfpaAlt),
          hasGhs: Boolean(c.ghs),
          isDrug: false,
          score: mapped.score,
          matchedOn: mapped.on,
        },
        c.cid,
      );
    }
  }

  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        unionCompleteness(b) - unionCompleteness(a) ||
        a.name.length - b.name.length ||
        compareNames(a.name, b.name) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limit);
}

/** The narrow row behind a union hit, when the hit came from that tier. */
export function narrowChemical(id: string): Chemical | undefined {
  return CHEMICALS.find((c) => c.id === id);
}

/** True when a union hit's id addresses the broad tier, so it needs a shard. */
export function isBroadId(id: string): boolean {
  return /^\d+$/.test(id);
}
