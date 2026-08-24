import { CHEMICALS, type Chemical, type NfpaRating } from "../_generated/chem-data";
import { ToolError, type ToolLogic } from "../types";

/**
 * NFPA 704 fire diamond: search by rating, search by name, draw the diamond.
 *
 * The dataset merges PubChem's NFPA annotations (HSDB and OSHA) with the NFPA
 * parameters in English Wikipedia chemboxes. When the two disagree, PubChem is
 * `nfpa` and Wikipedia is `nfpaAlt`, and both are shown rather than one being
 * picked silently.
 *
 * PubChem's annotations frequently omit the white quadrant even when the
 * compound is water reactive or an oxidizer, so every special symbol question
 * here is asked against the UNION of `nfpa.special` and `nfpaAlt.special`. That
 * is deliberately generous: a search that requires W finds the 197 compounds
 * either source calls water reactive, not just the 187 PubChem does.
 *
 * Nothing in this module mutates the dataset. The hazard arrays in chem-data
 * are interned and shared between rows, so every array that leaves this file is
 * a fresh copy.
 */

/** Reference only wording, shown above the results and in the page footer. */
export const DISCLAIMER =
  "Reference only. Nothing here is a basis for a workplace safety decision. Verify every rating against the safety data sheet, NFPA 704 itself, and the authority having jurisdiction.";

export type Rating = 0 | 1 | 2 | 3 | 4;
export type Special = "W" | "OX" | "SA";
/** Three state filter for one special symbol. */
export type SpecialFilter = "require" | "exclude" | "any";

export interface NfpaQuery {
  /** Blue quadrant. Undefined means any. */
  h?: Rating;
  /** Red quadrant. Undefined means any. */
  f?: Rating;
  /** Yellow quadrant. Undefined means any. */
  r?: Rating;
  special: Record<Special, SpecialFilter>;
}

export interface NearbyMatch {
  chemical: Chemical;
  /** Sum of the absolute differences across the quadrants the query pinned. */
  distance: number;
}

/** The order specials are listed and drawn in. */
export const SPECIAL_ORDER: Special[] = ["W", "OX", "SA"];

/** A neutral special filter: nothing required, nothing excluded. */
export const ANY_SPECIALS: Record<Special, SpecialFilter> = { W: "any", OX: "any", SA: "any" };

export const SPECIAL_LABELS: Record<Special, string> = {
  W: "Reacts with water",
  OX: "Oxidizer",
  SA: "Simple asphyxiant gas",
};

/** The NFPA 704 degree descriptions, indexed 0 to 4. */
export const RATING_LABELS: Record<"h" | "f" | "r", string[]> = {
  h: [
    "No hazard beyond that of ordinary combustibles",
    "Causes irritation, minor residual injury",
    "Intense or prolonged exposure may cause incapacitation",
    "Short exposure could cause serious injury",
    "Very short exposure could cause death or major injury",
  ],
  f: [
    "Will not burn",
    "Must be preheated before it will ignite",
    "Must be moderately heated or exposed to high ambient temperature",
    "Ignites at most ambient temperatures",
    "Vaporizes and burns readily at normal temperatures",
  ],
  r: [
    "Normally stable, even under fire conditions",
    "Normally stable, unstable at elevated temperature and pressure",
    "Violent chemical change at elevated temperature and pressure",
    "May detonate with a strong initiating source or under confinement",
    "Readily capable of detonation at normal temperature and pressure",
  ],
};

export const QUADRANT_LABELS: Record<"h" | "f" | "r", string> = {
  h: "Health",
  f: "Fire",
  r: "Instability",
};

/** The quadrant colors, so the panel and the downloadable SVG never drift. */
export const NFPA_COLORS = {
  health: "#0072bc",
  fire: "#ee1c25",
  instability: "#fff200",
  special: "#ffffff",
  outline: "#111111",
  lightText: "#ffffff",
  darkText: "#111111",
} as const;

function isRating(v: unknown): v is Rating {
  return v === 0 || v === 1 || v === 2 || v === 3 || v === 4;
}

/**
 * Every special symbol either source records for this chemical, deduped and in
 * W, OX, SA order. Always a fresh array: the dataset's arrays are shared.
 */
export function specialsFor(c: Chemical): Special[] {
  const seen = new Set<Special>();
  for (const s of c.nfpa?.special ?? []) seen.add(s);
  for (const s of c.nfpaAlt?.special ?? []) seen.add(s);
  return SPECIAL_ORDER.filter((s) => seen.has(s));
}

/** "Health 3, Fire 0, Instability 2, W (HSDB)" */
export function formatRating(rating: NfpaRating, specials?: Special[]): string {
  const list = specials ?? SPECIAL_ORDER.filter((s) => rating.special.includes(s));
  const parts = [`Health ${rating.h}`, `Fire ${rating.f}`, `Instability ${rating.r}`];
  if (list.length) parts.push(list.join(" "));
  return `${parts.join(", ")} (${rating.source})`;
}

function byName(a: Chemical, b: Chemical): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function specialsMatch(query: NfpaQuery, specials: Special[]): boolean {
  for (const s of SPECIAL_ORDER) {
    const filter = query.special?.[s] ?? "any";
    if (filter === "require" && !specials.includes(s)) return false;
    if (filter === "exclude" && specials.includes(s)) return false;
  }
  return true;
}

/**
 * Every chemical whose rating matches the query exactly, sorted by name.
 * A quadrant left undefined matches any value. Specials are matched against
 * the union of the PubChem and Wikipedia white quadrants.
 */
export function matchChemicals(query: NfpaQuery): Chemical[] {
  const out: Chemical[] = [];
  for (const c of CHEMICALS) {
    const rating = c.nfpa;
    if (!rating) continue;
    if (query.h !== undefined && rating.h !== query.h) continue;
    if (query.f !== undefined && rating.f !== query.f) continue;
    if (query.r !== undefined && rating.r !== query.r) continue;
    if (!specialsMatch(query, specialsFor(c))) continue;
    out.push(c);
  }
  return out.sort(byName);
}

/**
 * The closest chemicals that are not exact matches, for when a rating combo has
 * few or no hits. The special filters stay hard, because relaxing them would
 * answer a "reacts with water" search with compounds that do not; only the
 * numeric quadrants are relaxed, ranked by the sum of the absolute differences
 * across the quadrants the query actually pinned.
 */
export function nearbyChemicals(query: NfpaQuery, limit = 12): NearbyMatch[] {
  const out: NearbyMatch[] = [];
  for (const c of CHEMICALS) {
    const rating = c.nfpa;
    if (!rating) continue;
    if (!specialsMatch(query, specialsFor(c))) continue;
    let distance = 0;
    if (query.h !== undefined) distance += Math.abs(rating.h - query.h);
    if (query.f !== undefined) distance += Math.abs(rating.f - query.f);
    if (query.r !== undefined) distance += Math.abs(rating.r - query.r);
    if (distance === 0) continue;
    out.push({ chemical: c, distance });
  }
  out.sort((a, b) => a.distance - b.distance || byName(a.chemical, b.chemical));
  return out.slice(0, Math.max(0, limit));
}

/**
 * The reverse path: type a name, a synonym, a CAS number or a formula and get
 * the chemicals that match, best first, so the panel can fill the quadrants
 * from one of them. Only chemicals that carry an NFPA rating are returned,
 * since a hit with no diamond has nothing to fill in.
 */
export function searchChemical(text: string, limit = 25): Chemical[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();
  const cas = raw.replace(/\s+/g, "");

  const scored: { chemical: Chemical; score: number }[] = [];
  for (const c of CHEMICALS) {
    if (!c.nfpa) continue;
    let score = 0;
    const name = c.name.toLowerCase();
    if (name === q) score = 1000;
    else if (c.cas && c.cas === cas) score = 900;
    else if (c.formula && c.formula === raw) score = 700;
    else if (c.formula && c.formula.toLowerCase() === q) score = 650;
    else if (c.synonyms.some((s) => s.toLowerCase() === q)) score = 600;
    else if (name.startsWith(q)) score = 500;
    else if (c.synonyms.some((s) => s.toLowerCase().startsWith(q))) score = 300;
    else if (name.includes(q)) score = 250;
    else if (c.synonyms.some((s) => s.toLowerCase().includes(q))) score = 120;
    if (score) scored.push({ chemical: c, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.chemical.name.length - b.chemical.name.length ||
      byName(a.chemical, b.chemical),
  );
  return scored.slice(0, Math.max(0, limit)).map((s) => s.chemical);
}

export interface DiamondSpec {
  /** Blue quadrant. Undefined leaves it blank, which is what "Any" looks like. */
  h?: Rating;
  f?: Rating;
  r?: Rating;
  special?: Special[];
  /** Optional line of text under the diamond, usually the chemical name. */
  caption?: string;
  /** Paint a solid background, for example "#ffffff" before a PNG export. */
  background?: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Geometry. A 100 unit square rotated 45 degrees has a half diagonal of
// 100 / sqrt(2), so the quadrant centers sit 70.71 from the middle and the
// outer points sit 141.42 away.
const CX = 200;
const CY = 200;
const D = 70.71;
const FAR = 141.42;
const NUMERAL_SIZE = 62;
/** Cap height sits roughly 0.35 of the font size below the optical center. */
const BASELINE_SHIFT = 0.35;

/** Two decimals, with the trailing zeros dropped, so the file stays readable. */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function quadrant(points: [number, number][], fill: string): string {
  const pts = points.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
  return `<polygon points="${pts}" fill="${fill}" stroke="${NFPA_COLORS.outline}" stroke-width="3" stroke-linejoin="round" />`;
}

function numeral(cx: number, cy: number, value: Rating | undefined, fill: string): string {
  if (value === undefined) return "";
  return `<text x="${n(cx)}" y="${n(cy + NUMERAL_SIZE * BASELINE_SHIFT)}" font-family="Helvetica, Arial, sans-serif" font-size="${NUMERAL_SIZE}" font-weight="bold" text-anchor="middle" fill="${fill}">${value}</text>`;
}

/**
 * A standalone NFPA 704 diamond as an SVG string: four rotated squares, blue
 * left for health, red top for fire, yellow right for instability, white bottom
 * for the special symbols. W is drawn with its strikethrough as a real line
 * rather than a combining character, so it survives every renderer and every
 * SVG to PNG converter.
 *
 * The result carries no XML prolog, so it inlines into a page as is and still
 * opens as a valid .svg file when downloaded.
 */
export function diamondSvg(spec: DiamondSpec): string {
  for (const key of ["h", "f", "r"] as const) {
    const v = spec[key];
    if (v !== undefined && !isRating(v))
      throw new ToolError(
        "invalid-rating",
        `The ${QUADRANT_LABELS[key].toLowerCase()} rating ${JSON.stringify(v)} is not an NFPA 704 degree.`,
        "Each quadrant takes a whole number from 0 to 4, or nothing at all to leave it blank.",
      );
  }
  const specials = SPECIAL_ORDER.filter((s) => (spec.special ?? []).includes(s));
  const caption = spec.caption?.trim();
  const height = caption ? 420 : 400;

  const top = quadrant(
    [
      [CX, CY - FAR],
      [CX + D, CY - D],
      [CX, CY],
      [CX - D, CY - D],
    ],
    NFPA_COLORS.fire,
  );
  const right = quadrant(
    [
      [CX + D, CY - D],
      [CX + FAR, CY],
      [CX + D, CY + D],
      [CX, CY],
    ],
    NFPA_COLORS.instability,
  );
  const bottom = quadrant(
    [
      [CX, CY],
      [CX + D, CY + D],
      [CX, CY + FAR],
      [CX - D, CY + D],
    ],
    NFPA_COLORS.special,
  );
  const left = quadrant(
    [
      [CX - FAR, CY],
      [CX - D, CY - D],
      [CX, CY],
      [CX - D, CY + D],
    ],
    NFPA_COLORS.health,
  );

  const specialSize = specials.length <= 1 ? 46 : specials.length === 2 ? 32 : 24;
  const lineHeight = specialSize * 1.05;
  const firstLine = CY + D - ((specials.length - 1) / 2) * lineHeight;
  const specialParts: string[] = [];
  specials.forEach((symbol, index) => {
    const midY = firstLine + index * lineHeight;
    const baseline = n(midY + specialSize * BASELINE_SHIFT);
    specialParts.push(
      `<text x="${n(CX)}" y="${baseline}" font-family="Helvetica, Arial, sans-serif" font-size="${specialSize}" font-weight="bold" text-anchor="middle" fill="${NFPA_COLORS.darkText}">${symbol}</text>`,
    );
    if (symbol === "W") {
      // The bar is drawn, never a combining character: U+0336 renders
      // inconsistently and disappears in most SVG to PNG converters.
      const halfWidth = specialSize * 0.46;
      specialParts.push(
        `<line class="nfpa-w-bar" x1="${n(CX - halfWidth)}" y1="${n(midY)}" x2="${n(CX + halfWidth)}" y2="${n(midY)}" stroke="${NFPA_COLORS.darkText}" stroke-width="${n(Math.max(2, specialSize * 0.08))}" stroke-linecap="butt" />`,
      );
    }
  });

  const described = (["h", "f", "r"] as const)
    .filter((k) => spec[k] !== undefined)
    .map((k) => `${QUADRANT_LABELS[k].toLowerCase()} ${spec[k]}`)
    .join(", ");
  const detail = [described, specials.join(" ")].filter(Boolean).join(", ");
  const subject = caption ? `NFPA 704 diamond for ${caption}` : "NFPA 704 diamond";
  const title = detail ? `${subject}: ${detail}` : subject;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 ${height}" width="400" height="${height}" role="img" aria-label="${xmlEscape(title)}">`,
    `<title>${xmlEscape(title)}</title>`,
  ];
  if (spec.background)
    parts.push(`<rect x="0" y="0" width="400" height="${height}" fill="${spec.background}" />`);
  parts.push(top, right, bottom, left);
  parts.push(numeral(CX - D, CY, spec.h, NFPA_COLORS.lightText));
  parts.push(numeral(CX, CY - D, spec.f, NFPA_COLORS.lightText));
  parts.push(numeral(CX + D, CY, spec.r, NFPA_COLORS.darkText));
  parts.push(...specialParts);
  if (caption)
    parts.push(
      `<text x="${CX}" y="392" font-family="Helvetica, Arial, sans-serif" font-size="26" text-anchor="middle" fill="${NFPA_COLORS.darkText}">${xmlEscape(caption)}</text>`,
    );
  parts.push("</svg>");
  return parts.filter(Boolean).join("\n");
}

export interface NfpaOpts {
  health: string;
  fire: string;
  instability: string;
  water: string;
  oxidizer: string;
  asphyxiant: string;
  svg: boolean;
  [key: string]: unknown;
}

function readRating(raw: unknown, key: "h" | "f" | "r"): Rating | undefined {
  const v = String(raw ?? "any").trim();
  if (!v || v === "any") return undefined;
  const n = Number(v);
  if (!isRating(n))
    throw new ToolError(
      "invalid-rating",
      `"${v}" is not an NFPA 704 ${QUADRANT_LABELS[key].toLowerCase()} rating.`,
      'Use a whole number from 0 to 4, or "any" to leave the quadrant open.',
    );
  return n;
}

function readFilter(raw: unknown, label: string): SpecialFilter {
  const v = String(raw ?? "any").trim();
  if (v === "require" || v === "exclude" || v === "any") return v;
  throw new ToolError(
    "invalid-filter",
    `"${v}" is not a filter for the ${label} symbol.`,
    'Use "require", "exclude" or "any".',
  );
}

/** Build a query from the option values the panel and the API both send. */
export function queryFromOpts(opts?: Partial<NfpaOpts>): NfpaQuery {
  const query: NfpaQuery = {
    special: {
      W: readFilter(opts?.water, "water reactive"),
      OX: readFilter(opts?.oxidizer, "oxidizer"),
      SA: readFilter(opts?.asphyxiant, "simple asphyxiant"),
    },
  };
  const h = readRating(opts?.health, "h");
  const f = readRating(opts?.fire, "f");
  const r = readRating(opts?.instability, "r");
  if (h !== undefined) query.h = h;
  if (f !== undefined) query.f = f;
  if (r !== undefined) query.r = r;
  return query;
}

export function describeQuery(query: NfpaQuery): string {
  const parts = (["h", "f", "r"] as const).map(
    (k) => `${QUADRANT_LABELS[k]} ${query[k] === undefined ? "any" : query[k]}`,
  );
  for (const s of SPECIAL_ORDER) {
    const filter = query.special?.[s] ?? "any";
    if (filter !== "any") parts.push(`${s} ${filter === "require" ? "required" : "excluded"}`);
  }
  return parts.join(", ");
}

const LIST_CAP = 30;

function nameList(chemicals: Chemical[]): string {
  const shown = chemicals.slice(0, LIST_CAP).map((c) => c.name);
  const extra = chemicals.length - shown.length;
  return extra > 0 ? `${shown.join(", ")}, and ${extra} more` : shown.join(", ");
}

export function run(_input: unknown, opts?: Partial<NfpaOpts>): Record<string, string> {
  const query = queryFromOpts(opts);
  const matches = matchChemicals(query);

  const out: Record<string, string> = {
    Rating: describeQuery(query),
    "Exact matches": String(matches.length),
  };
  if (matches.length) out["Chemicals"] = nameList(matches);
  if (matches.length < 5) {
    const nearby = nearbyChemicals(query, 10);
    out["Nearby ratings"] = nearby.length
      ? nearby
          .map(
            (n) =>
              `${n.chemical.name} (${formatRating(n.chemical.nfpa!, specialsFor(n.chemical))})`,
          )
          .join("; ")
      : "none within the special symbol filters";
  }
  if (opts?.svg && query.h !== undefined && query.f !== undefined && query.r !== undefined) {
    const spec: DiamondSpec = { h: query.h, f: query.f, r: query.r };
    const required = SPECIAL_ORDER.filter((s) => query.special[s] === "require");
    if (required.length) spec.special = required;
    out["Diamond SVG"] = diamondSvg(spec);
  }
  out["Disclaimer"] = DISCLAIMER;
  return out;
}

export default { run } satisfies ToolLogic<unknown, Record<string, string>, Partial<NfpaOpts>>;
