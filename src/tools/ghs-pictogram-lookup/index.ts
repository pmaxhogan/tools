import { CHEMICALS, type Chemical } from "../_generated/chem-data";
import { H_STATEMENTS, P_STATEMENTS, PICTOGRAMS } from "../_generated/ghs-statements";
import { ToolError, type ToolLogic } from "../types";

/**
 * GHS pictogram and hazard code lookup.
 *
 * Pick one or more of the nine GHS pictograms, or one or more H codes, and get
 * the chemicals classified that way. The pictogram artwork is the official UN
 * public domain set, self hosted under /ghs/, so the picker shows the drawn
 * symbols rather than word chips.
 *
 * `hStatementText` returns the canonical UN wording from the GHS reference,
 * which is what a code means in general and can carry an "(Obsolete)" prefix
 * for a statement withdrawn in a later revision. A chemical row carries its own
 * copy of the text as the notifying body worded it, including a bracketed
 * hazard class; that is what the chemical lookup shows instead.
 *
 * A compound often carries several classifications, one per notifying body. The
 * dataset already picked one per row, so a row here is one coherent
 * classification and not the union of every jurisdiction.
 */

/** Reference only wording. Byte identical to the copy in nfpa-704-fire-diamond. */
export const DISCLAIMER =
  "Reference only. Nothing here is a basis for a workplace safety decision. Verify every rating against the safety data sheet, NFPA 704 itself, and the authority having jurisdiction.";

export type MatchMode = "all" | "any";

export interface PictogramInfo {
  /** "GHS01" through "GHS09". */
  code: string;
  /** The symbol's name, for example "Exploding Bomb". */
  name: string;
  /** The hazard family it marks. Absent for GHS08 and GHS09. */
  hazardClass?: string;
  /** Path to the self hosted UN artwork, relative to the site root. */
  svgPath: string;
}

/** The nine pictograms joined to their self hosted SVG paths. */
export const PICTOGRAM_INFO: PictogramInfo[] = PICTOGRAMS.map((p) => {
  const info: PictogramInfo = { code: p.code, name: p.name, svgPath: `/ghs/${p.code}.svg` };
  if (p.hazardClass) info.hazardClass = p.hazardClass;
  return info;
});

const VALID_PICTOGRAMS = new Set(PICTOGRAM_INFO.map((p) => p.code));

function byName(a: Chemical, b: Chemical): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function splitCodes(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[\s,;|]+/);
  return list.map((s) => String(s ?? "").trim()).filter(Boolean);
}

/**
 * Accepts "GHS02", "ghs2" and a bare "2", and returns the canonical codes in
 * GHS01 to GHS09 order with duplicates removed. Throws for anything else.
 */
export function normalizePictogramCodes(input: string | string[]): string[] {
  const seen = new Set<string>();
  for (const raw of splitCodes(input)) {
    const compact = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
    const match = /^(?:GHS)?0?([1-9])$/.exec(compact);
    if (!match)
      throw new ToolError(
        "unknown-pictogram",
        `"${raw}" is not a GHS pictogram code.`,
        `Use one of ${PICTOGRAM_INFO.map((p) => p.code).join(", ")}.`,
      );
    seen.add(`GHS0${match[1]}`);
  }
  return PICTOGRAM_INFO.map((p) => p.code).filter((code) => seen.has(code));
}

/**
 * Accepts "H225", "h225" and a bare "225", and returns the canonical codes in
 * ascending order with duplicates removed. Throws for a code the GHS reference
 * does not list.
 */
export function normalizeHCodes(input: string | string[]): string[] {
  const seen = new Set<string>();
  for (const raw of splitCodes(input)) {
    const compact = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
    const match = /^H?(\d{3})$/.exec(compact);
    const code = match ? `H${match[1]}` : "";
    if (!code || H_STATEMENTS[code] === undefined)
      throw new ToolError(
        "unknown-h-code",
        `"${raw}" is not a GHS hazard statement code.`,
        "Hazard codes are the letter H and three digits, such as H225 or H319. There are 86 of them in the reference.",
      );
    seen.add(code);
  }
  return [...seen].sort();
}

/** The canonical UN wording for a hazard code, or undefined if there is none. */
export function hStatementText(code: string): string | undefined {
  const compact = String(code ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  const match = /^H?(\d{3})$/.exec(compact);
  return match ? H_STATEMENTS[`H${match[1]}`] : undefined;
}

/** The canonical UN wording for a precautionary code, plain or combination. */
export function pStatementText(code: string): string | undefined {
  const compact = String(code ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
  return P_STATEMENTS[compact] ?? P_STATEMENTS[`P${compact.replace(/^P/, "")}`];
}

/**
 * Chemicals classified with these pictograms, sorted by name. "all" requires
 * every listed pictogram, "any" requires at least one. An empty code list
 * matches nothing and returns an empty array, so a picker with no selection is
 * a no-op rather than an error.
 */
export function matchByPictograms(
  codes: string[],
  mode: MatchMode = "all",
  limit = CHEMICALS.length,
): Chemical[] {
  const wanted = normalizePictogramCodes(codes);
  if (!wanted.length) return [];
  const out = CHEMICALS.filter((c) => {
    const have = c.ghs?.pictograms;
    if (!have?.length) return false;
    return mode === "any"
      ? wanted.some((code) => have.includes(code))
      : wanted.every((code) => have.includes(code));
  });
  return out.sort(byName).slice(0, Math.max(0, limit));
}

/**
 * Chemicals carrying these hazard statement codes, sorted by name. "all"
 * requires every listed code, "any" requires at least one. An empty code list
 * matches nothing.
 */
export function matchByHCodes(
  codes: string[],
  mode: MatchMode = "all",
  limit = CHEMICALS.length,
): Chemical[] {
  const wanted = normalizeHCodes(codes);
  if (!wanted.length) return [];
  const out = CHEMICALS.filter((c) => {
    const have = c.ghs?.h;
    if (!have?.length) return false;
    return mode === "any"
      ? wanted.some((code) => have.some((h) => h.code === code))
      : wanted.every((code) => have.some((h) => h.code === code));
  });
  return out.sort(byName).slice(0, Math.max(0, limit));
}

const pictogramCountCache = new Map<string, number>();

/** How many chemicals in the dataset carry each pictogram. */
export function pictogramCounts(): Record<string, number> {
  if (!pictogramCountCache.size) {
    for (const p of PICTOGRAM_INFO) pictogramCountCache.set(p.code, 0);
    for (const c of CHEMICALS) {
      for (const code of c.ghs?.pictograms ?? []) {
        if (VALID_PICTOGRAMS.has(code))
          pictogramCountCache.set(code, (pictogramCountCache.get(code) ?? 0) + 1);
      }
    }
  }
  return Object.fromEntries(pictogramCountCache);
}

/** The hazard codes seen most often across a set of chemicals, most first. */
export function commonHCodes(chemicals: Chemical[], limit = 5): { code: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const c of chemicals) {
    for (const h of c.ghs?.h ?? []) tally.set(h.code, (tally.get(h.code) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

export interface GhsOpts {
  /** Comma separated pictogram codes, for example "GHS02, GHS07". */
  pictograms: string;
  mode: string;
  /** Comma separated hazard codes, for example "H225, H319". */
  hcodes: string;
  [key: string]: unknown;
}

const LIST_CAP = 30;

function nameList(chemicals: Chemical[], total: number): string {
  const shown = chemicals.slice(0, LIST_CAP).map((c) => c.name);
  const extra = total - shown.length;
  return extra > 0 ? `${shown.join(", ")}, and ${extra} more` : shown.join(", ");
}

export function run(_input: unknown, opts?: Partial<GhsOpts>): Record<string, string> {
  const mode: MatchMode = String(opts?.mode ?? "all") === "any" ? "any" : "all";
  const pictograms = normalizePictogramCodes(opts?.pictograms ?? "");
  const hcodes = normalizeHCodes(opts?.hcodes ?? "");

  if (!pictograms.length && !hcodes.length) {
    const counts = pictogramCounts();
    const out: Record<string, string> = {
      "Chemicals with a GHS classification": String(CHEMICALS.filter((c) => c.ghs).length),
    };
    for (const p of PICTOGRAM_INFO) {
      out[`${p.code} ${p.name}`] =
        `${counts[p.code]} chemicals${p.hazardClass ? `, ${p.hazardClass}` : ""}, ${p.svgPath}`;
    }
    out["Disclaimer"] = DISCLAIMER;
    return out;
  }

  const byPictogram = pictograms.length
    ? matchByPictograms(pictograms, mode, CHEMICALS.length)
    : undefined;
  const byCode = hcodes.length ? matchByHCodes(hcodes, mode, CHEMICALS.length) : undefined;
  let matches: Chemical[];
  if (byPictogram && byCode) {
    const ids = new Set(byCode.map((c) => c.id));
    matches = byPictogram.filter((c) => ids.has(c.id));
  } else {
    matches = byPictogram ?? byCode ?? [];
  }

  const out: Record<string, string> = { Mode: mode === "all" ? "match all" : "match any" };
  if (pictograms.length)
    out["Pictograms"] = pictograms
      .map((code) => {
        const info = PICTOGRAM_INFO.find((p) => p.code === code)!;
        return `${info.code} ${info.name}`;
      })
      .join(", ");
  if (hcodes.length)
    out["Hazard statements"] = hcodes
      .map((code) => `${code} ${hStatementText(code) ?? ""}`.trim())
      .join("; ");
  out["Matches"] = String(matches.length);
  if (matches.length) {
    out["Chemicals"] = nameList(matches, matches.length);
    const common = commonHCodes(matches, 5);
    if (common.length)
      out["Most common hazard statements"] = common
        .map((h) => `${h.code} ${hStatementText(h.code) ?? ""} (${h.count})`)
        .join("; ");
  }
  out["Disclaimer"] = DISCLAIMER;
  return out;
}

export default { run } satisfies ToolLogic<unknown, Record<string, string>, Partial<GhsOpts>>;
