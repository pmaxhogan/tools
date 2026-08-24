import { ELEMENTS, type Element } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";

/**
 * Periodic table layout, property trends and per element detail.
 *
 * Everything here is pure geometry and arithmetic over the PubChem periodic
 * table snapshot in src/tools/_generated/elements.ts. The panel owns the
 * rendering; this module owns where a cell goes and what color a trend paints.
 *
 * Two layouts, and they disagree about lutetium and lawrencium on purpose:
 *
 * - `layoutStandard` is the printed table. Eighteen columns, the f block lifted
 *   out into two rows underneath, and a "57-71" / "89-103" marker sitting in
 *   the group 3 cell that the f block was taken from. It follows the dataset,
 *   which gives all fifteen of 57 to 71 and 89 to 103 no group at all.
 * - `layoutWide` splices the f block back inline at thirty two columns. Thirty
 *   two columns only adds up with a fourteen wide f block (2 s + 14 f + 10 d +
 *   6 p), so element 71 and element 103 take the group 3 column and the other
 *   fourteen of each series fill columns 3 to 16. That is the ordering that
 *   keeps atomic number increasing left to right, which is the whole point of
 *   the wide form.
 *
 * `elementAt` answers from the dataset's own period and group fields, so it
 * returns undefined for every f block element in both layouts. It is a dataset
 * query, not a hit test against a rendered grid.
 */

const BY_SYMBOL = new Map<string, Element>();
const BY_NUMBER = new Map<number, Element>();
const BY_NAME = new Map<string, Element>();
for (const el of ELEMENTS) {
  BY_SYMBOL.set(el.symbol.toLowerCase(), el);
  BY_NUMBER.set(el.atomicNumber, el);
  BY_NAME.set(el.name.toLowerCase(), el);
}

/** The f block runs 57 to 71 and 89 to 103 in this dataset. */
const LANTHANIDE_START = 57;
const LANTHANIDE_END = 71;
const ACTINIDE_START = 89;
const ACTINIDE_END = 103;

/** Every distinct PubChem category, in first appearance order. */
export const CATEGORIES: string[] = (() => {
  const seen: string[] = [];
  for (const el of ELEMENTS) {
    if (el.groupBlock && !seen.includes(el.groupBlock)) seen.push(el.groupBlock);
  }
  return seen;
})();

export function elementBySymbol(symbol: string): Element | undefined {
  return BY_SYMBOL.get(
    String(symbol ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function elementByAtomicNumber(n: number): Element | undefined {
  return BY_NUMBER.get(n);
}

/** Resolve a symbol, a full name, or an atomic number. Case insensitive. */
export function findElement(text: string): Element | undefined {
  const q = String(text ?? "").trim();
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return BY_NUMBER.get(Number(q));
  return BY_SYMBOL.get(q.toLowerCase()) ?? BY_NAME.get(q.toLowerCase());
}

/**
 * The element in the main grid at this period and group. Returns undefined for
 * an empty cell and for every f block element, which carries no group.
 */
export function elementAt(period: number, group: number): Element | undefined {
  return ELEMENTS.find((el) => el.period === period && el.group === group);
}

export interface ElementCell {
  kind: "element";
  element: Element;
  /** 1 based column. */
  x: number;
  /** 1 based row. */
  y: number;
}

export interface MarkerCell {
  kind: "marker";
  /** "57-71" or "89-103". */
  label: string;
  series: "lanthanide" | "actinide";
  x: number;
  y: number;
}

export type LayoutCell = ElementCell | MarkerCell;

export interface Layout {
  mode: "standard" | "wide";
  columns: number;
  rows: number;
  cells: LayoutCell[];
}

function isLanthanide(z: number): boolean {
  return z >= LANTHANIDE_START && z <= LANTHANIDE_END;
}

function isActinide(z: number): boolean {
  return z >= ACTINIDE_START && z <= ACTINIDE_END;
}

/**
 * The printed table: 18 columns, 7 main rows, a blank spacer row, then the
 * lanthanides on row 9 and the actinides on row 10, both spanning columns 3
 * to 17. The group 3 cells of periods 6 and 7 hold the range markers.
 */
export function layoutStandard(): Layout {
  const cells: LayoutCell[] = [];
  for (const el of ELEMENTS) {
    const z = el.atomicNumber;
    if (isLanthanide(z)) {
      cells.push({ kind: "element", element: el, x: 3 + (z - LANTHANIDE_START), y: 9 });
    } else if (isActinide(z)) {
      cells.push({ kind: "element", element: el, x: 3 + (z - ACTINIDE_START), y: 10 });
    } else if (el.group !== undefined) {
      cells.push({ kind: "element", element: el, x: el.group, y: el.period });
    }
  }
  cells.push({ kind: "marker", label: "57-71", series: "lanthanide", x: 3, y: 6 });
  cells.push({ kind: "marker", label: "89-103", series: "actinide", x: 3, y: 7 });
  return { mode: "standard", columns: 18, rows: 10, cells };
}

/**
 * The wide table: 32 columns, 7 rows, no markers. Groups 1 and 2 keep their
 * numbers, groups 3 to 18 shift right by 14 to make room for the f block, and
 * the f block fills columns 3 to 16 with element 71 and element 103 landing in
 * the group 3 column at 17.
 */
export function layoutWide(): Layout {
  const cells: LayoutCell[] = [];
  for (const el of ELEMENTS) {
    const z = el.atomicNumber;
    let x: number;
    if (z === LANTHANIDE_END || z === ACTINIDE_END) x = 17;
    else if (isLanthanide(z)) x = 3 + (z - LANTHANIDE_START);
    else if (isActinide(z)) x = 3 + (z - ACTINIDE_START);
    else if (el.group === undefined) continue;
    else x = el.group <= 2 ? el.group : el.group + 14;
    cells.push({ kind: "element", element: el, x, y: el.period });
  }
  return { mode: "wide", columns: 32, rows: 7, cells };
}

export function layoutFor(mode: string): Layout {
  return mode === "wide" ? layoutWide() : layoutStandard();
}

export type TrendId =
  | "electronegativity"
  | "atomicRadius"
  | "ionizationEnergy"
  | "electronAffinity"
  | "meltingPoint"
  | "density";

export interface TrendSpec {
  id: TrendId;
  label: string;
  unit: string;
  /**
   * Density is mapped on a log scale: it runs from 0.00009 for hydrogen to
   * 22.57 for osmium, five and a half orders of magnitude, so a linear ramp
   * would paint every solid the same color. Every other trend spans well under
   * two orders of magnitude and stays linear.
   */
  scale: "linear" | "log";
}

export const TRENDS: TrendSpec[] = [
  { id: "electronegativity", label: "Electronegativity", unit: "Pauling", scale: "linear" },
  { id: "atomicRadius", label: "Atomic radius", unit: "pm", scale: "linear" },
  { id: "ionizationEnergy", label: "Ionization energy", unit: "eV", scale: "linear" },
  { id: "electronAffinity", label: "Electron affinity", unit: "eV", scale: "linear" },
  { id: "meltingPoint", label: "Melting point", unit: "K", scale: "linear" },
  { id: "density", label: "Density", unit: "g/cm3", scale: "log" },
];

const TREND_BY_ID = new Map(TRENDS.map((t) => [t.id, t]));

/** The raw published value for a trend, or undefined when PubChem has none. */
export function trendValue(el: Element, trend: TrendId): number | undefined {
  const v = el[trend];
  return typeof v === "number" ? v : undefined;
}

export interface TrendRange {
  min: number;
  max: number;
  /** How many of the 118 elements carry a value for this trend. */
  count: number;
}

const rangeCache = new Map<TrendId, TrendRange>();

/** Observed min and max across every element that publishes this trend. */
export function trendRange(trend: TrendId): TrendRange {
  const cached = rangeCache.get(trend);
  if (cached) return cached;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const el of ELEMENTS) {
    const v = trendValue(el, trend);
    if (v === undefined) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range: TrendRange = { min, max, count };
  rangeCache.set(trend, range);
  return range;
}

/**
 * The element's position in a trend, normalized to 0 for the lowest value in
 * the table and 1 for the highest. Undefined when the element has no published
 * value, which is common for the synthetic end of period 7.
 */
export function normalizeTrend(el: Element, trend: TrendId): number | undefined {
  const spec = TREND_BY_ID.get(trend);
  if (!spec) return undefined;
  const v = trendValue(el, trend);
  if (v === undefined) return undefined;
  const { min, max } = trendRange(trend);
  if (!(max > min)) return 0;
  if (spec.scale === "log") {
    if (v <= 0 || min <= 0) return 0;
    const t = (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
    return Math.min(1, Math.max(0, t));
  }
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

export type PaletteId = "viridis" | "plasma" | "blue-red" | "grayscale";

/** Color ramps, low value first. Interpolated in sRGB. */
export const PALETTES: Record<PaletteId, string[]> = {
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"],
  "blue-red": ["#2166ac", "#f7f7f7", "#b2182b"],
  grayscale: ["#f7f7f7", "#252525"],
};

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
}

/** Sample a palette at t, clamped to 0..1. Returns "#rrggbb". */
export function paletteColor(t: number, palette: PaletteId = "viridis"): string {
  const stops = PALETTES[palette] ?? PALETTES.viridis;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const span = stops.length - 1;
  const scaled = clamped * span;
  const lo = Math.min(span, Math.floor(scaled));
  const hi = Math.min(span, lo + 1);
  const f = scaled - lo;
  const a = hexToRgb(stops[lo]!);
  const b = hexToRgb(stops[hi]!);
  return `#${toHex(a[0] + (b[0] - a[0]) * f)}${toHex(a[1] + (b[1] - a[1]) * f)}${toHex(a[2] + (b[2] - a[2]) * f)}`;
}

export interface TrendPaint {
  /** The published value. */
  value: number;
  /** Normalized position in the trend, 0 to 1. */
  t: number;
  /** "#rrggbb" sampled from the palette at t. */
  color: string;
}

/**
 * Where this element sits in a trend and what color that is. Undefined when
 * the element publishes no value for the trend, so a panel can leave the cell
 * unpainted rather than paint it as a zero.
 */
export function trendColor(
  el: Element,
  trend: TrendId,
  palette: PaletteId = "viridis",
): TrendPaint | undefined {
  const t = normalizeTrend(el, trend);
  if (t === undefined) return undefined;
  return { value: trendValue(el, trend)!, t, color: paletteColor(t, palette) };
}

export function wikipediaUrl(el: Element): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(el.name.replace(/ /g, "_"))}`;
}

export function pubchemUrl(el: Element): string {
  return `https://pubchem.ncbi.nlm.nih.gov/element/${el.atomicNumber}`;
}

function kelvin(k: number): string {
  return `${k} K (${(k - 273.15).toFixed(2)} °C)`;
}

/** A labeled summary of one element, ready for the generic record renderer. */
export function describeElement(el: Element): Record<string, string> {
  const out: Record<string, string> = {
    Name: el.name,
    Symbol: el.symbol,
    "Atomic number": String(el.atomicNumber),
  };
  if (el.atomicMassText) out["Atomic mass"] = `${el.atomicMassText} u`;
  else if (el.atomicMass !== undefined) out["Atomic mass"] = `${el.atomicMass} u`;
  if (el.groupBlock) out["Category"] = el.groupBlock;
  out["Period"] = String(el.period);
  out["Group"] =
    el.group !== undefined
      ? String(el.group)
      : isLanthanide(el.atomicNumber)
        ? "f block (lanthanide)"
        : "f block (actinide)";
  if (el.standardState) out["Standard state"] = el.standardState;
  if (el.electronConfiguration) out["Electron configuration"] = el.electronConfiguration;
  if (el.oxidationStates) out["Oxidation states"] = el.oxidationStates;
  if (el.electronegativity !== undefined)
    out["Electronegativity"] = `${el.electronegativity} (Pauling)`;
  if (el.atomicRadius !== undefined) out["Atomic radius"] = `${el.atomicRadius} pm (van der Waals)`;
  if (el.ionizationEnergy !== undefined) out["Ionization energy"] = `${el.ionizationEnergy} eV`;
  if (el.electronAffinity !== undefined) out["Electron affinity"] = `${el.electronAffinity} eV`;
  if (el.meltingPoint !== undefined) out["Melting point"] = kelvin(el.meltingPoint);
  if (el.boilingPoint !== undefined) out["Boiling point"] = kelvin(el.boilingPoint);
  if (el.density !== undefined) out["Density"] = `${el.density} g/cm3`;
  if (el.yearDiscovered) out["Year discovered"] = el.yearDiscovered;
  if (el.cpkHexColor) out["CPK color"] = `#${el.cpkHexColor}`;
  out["Wikipedia"] = wikipediaUrl(el);
  out["PubChem"] = pubchemUrl(el);
  out["Source"] = "PubChem periodic table (public domain, US National Library of Medicine).";
  return out;
}

export interface PeriodicTableOpts {
  symbol: string;
  layout: string;
  trend: string;
  palette: string;
  [key: string]: unknown;
}

export function run(_input: unknown, opts?: Partial<PeriodicTableOpts>): Record<string, string> {
  const query = String(opts?.symbol ?? "").trim();
  if (!query)
    throw new ToolError(
      "empty-input",
      "No element chosen.",
      'Pass an element symbol, name or atomic number, such as "Fe", "Iron" or "26".',
    );
  const el = findElement(query);
  if (!el)
    throw new ToolError(
      "unknown-element",
      `No element matches "${query}".`,
      'Use a symbol like "Fe", a name like "Iron", or an atomic number from 1 to 118.',
    );

  const out = describeElement(el);
  const trend = TREND_BY_ID.get(String(opts?.trend ?? "") as TrendId);
  if (trend) {
    const palette = (
      PALETTE_IDS.includes(String(opts?.palette ?? "") as PaletteId)
        ? String(opts?.palette)
        : "viridis"
    ) as PaletteId;
    const paint = trendColor(el, trend.id, palette);
    const range = trendRange(trend.id);
    out[`Trend: ${trend.label}`] = paint
      ? `${paint.value} ${trend.unit}, ${(paint.t * 100).toFixed(1)}% of the way from ${range.min} to ${range.max} on a ${trend.scale} scale, ${paint.color}`
      : `no published value (${range.count} of 118 elements have one)`;
  }
  const layout = layoutFor(String(opts?.layout ?? "standard"));
  const cell = layout.cells.find(
    (c) => c.kind === "element" && c.element.atomicNumber === el.atomicNumber,
  );
  if (cell) out[`Position (${layout.mode} layout)`] = `column ${cell.x}, row ${cell.y}`;
  return out;
}

export default { run } satisfies ToolLogic<
  unknown,
  Record<string, string>,
  Partial<PeriodicTableOpts>
>;
