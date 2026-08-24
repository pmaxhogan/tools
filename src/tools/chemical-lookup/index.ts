import { CHEMICALS, type Chemical, type NfpaRating } from "../_generated/chem-data";
import { PICTOGRAMS } from "../_generated/ghs-statements";
import { ToolError, type ToolLogic } from "../types";

/**
 * Chemical lookup: one search box over 3,050 compounds, one full data sheet.
 *
 * Searches names, synonyms, CAS registry numbers and molecular formulas, then
 * reports the formula, molar mass, physical properties, NFPA 704 diamond, GHS
 * classification and source links for the best match.
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
