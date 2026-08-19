/**
 * Chart Maker, a self contained SVG chart renderer.
 *
 * No charting dependency: the whole renderer is arithmetic plus string
 * building, so the page ships a few kilobytes instead of a plotting library,
 * and the same `run()` powers the curl endpoint.
 *
 * Two deliberate rendering choices:
 *
 * 1. Every piece of text and every axis, grid and tick line is painted with
 *    `fill="currentColor"` or `stroke="currentColor"`, so an inlined chart
 *    inherits the page ink and reads correctly in both site themes with no
 *    re-render. The root element carries `data-chart-ink="currentColor"` as
 *    the marker a panel looks for: before rasterising to PNG on a canvas it
 *    sets an explicit `color` on the root, because a standalone image has no
 *    page to inherit from.
 * 2. The background stays transparent. Nothing paints a page colored rect, so
 *    the chart sits on whatever surface it lands on.
 *
 * Output is deterministic: no clock, no randomness, and every coordinate is
 * rounded before it reaches the string, so the same input always produces a
 * byte identical SVG.
 */
import Papa from "papaparse";
import { ToolError, type ToolLogic } from "../types";

/** One column of numbers. `null` marks a gap, which breaks lines and skips marks. */
export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

/** The parsed shape a chart is drawn from. */
export interface ChartData {
  title?: string;
  labels: string[];
  series: ChartSeries[];
}

export interface ChartOpts {
  type: string;
  width: number;
  height: number;
  legend: boolean;
  gridlines: boolean;
  valueLabels: boolean;
  palette: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------- palettes -- */

/**
 * "site" is the default categorical palette. Eight hues, each picked so it
 * clears a 3:1 contrast ratio (the WCAG threshold for meaningful graphics)
 * against every site surface in both themes: light page #F6F4F1 and its white
 * cards, dark page #141311 and its #1D1B18 cards. The exact list:
 *
 *   #6C5AD8 violet, #2E86C8 blue,   #16998E teal, #4E9A51 green,
 *   #8A8529 olive,  #C96B22 orange, #D2544E red,  #C25AA6 pink
 *
 * Violet leads because it is the site brand hue, so a single series chart
 * reads as part of the site rather than as stock chart library output.
 *
 * "mono", "warm" and "cool" are ordered ramps for series that have a natural
 * order. They vary hue and saturation inside the same narrow luminance band as
 * the categorical palette, for the same both themes reason: a ramp that ran
 * from near black to near white would lose half its steps on one theme.
 */
const PALETTES: Record<string, string[]> = {
  site: ["#6C5AD8", "#2E86C8", "#16998E", "#4E9A51", "#8A8529", "#C96B22", "#D2544E", "#C25AA6"],
  mono: ["#6B50D6", "#7057D1", "#745FCC", "#7965C7", "#7D6CC3", "#8272BE", "#867ABA", "#8B80B6"],
  warm: ["#C03043", "#C53636", "#BE4A39", "#B55B3B", "#AB693C", "#A3743E", "#9C7E40", "#988742"],
  cool: ["#7F4ACA", "#6D5ACB", "#5E67C8", "#4D73BD", "#437FA9", "#408896", "#428F88", "#49957B"],
};

/* ------------------------------------------------------------ constants -- */

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const LABEL_SIZE = 12;
const TITLE_SIZE = 16;
const VALUE_SIZE = 11;
/** Average glyph width as a fraction of font size. Good enough to detect overlap. */
const CHAR_RATIO = 0.6;
const SWATCH = 10;
const LEGEND_GAP = 16;
const LEGEND_ROW = 18;
const MAX_LEGEND_CHARS = 18;
const MAX_LABEL_CHARS = 24;
const EDGE = 16;
/** Vertical band reserved under the x axis when its labels are rotated. */
const X_LABEL_BAND = 90;
/** Characters a rotated x label may keep so its footprint fits that band. */
const ROTATED_LABEL_CHARS = Math.max(
  4,
  Math.floor((X_LABEL_BAND - 16) / 0.71 / (LABEL_SIZE * CHAR_RATIO)),
);

const MIN_WIDTH = 320;
const MAX_WIDTH = 1600;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 1000;
/** Data cells (rows times series) above which a chart stops being readable. */
const MAX_CELLS = 5000;
/** Slices a pie keeps before the tail is folded into "Other". */
const MAX_SLICES = 12;

const TYPE_LABELS: Record<string, string> = {
  bar: "Bar",
  "stacked-bar": "Stacked bar",
  "horizontal-bar": "Horizontal bar",
  line: "Line",
  area: "Area",
  scatter: "Scatter",
  pie: "Pie",
  donut: "Donut",
};

/** Accepted spellings for `type`, so the curl endpoint is forgiving. */
const TYPE_ALIASES: Record<string, string> = {
  bar: "bar",
  bars: "bar",
  barchart: "bar",
  column: "bar",
  columns: "bar",
  grouped: "bar",
  groupedbar: "bar",
  verticalbar: "bar",
  stackedbar: "stacked-bar",
  stacked: "stacked-bar",
  stack: "stacked-bar",
  horizontalbar: "horizontal-bar",
  horizontal: "horizontal-bar",
  hbar: "horizontal-bar",
  barh: "horizontal-bar",
  line: "line",
  lines: "line",
  linechart: "line",
  trend: "line",
  area: "area",
  areachart: "area",
  filled: "area",
  scatter: "scatter",
  scatterplot: "scatter",
  points: "scatter",
  xy: "scatter",
  pie: "pie",
  piechart: "pie",
  donut: "donut",
  doughnut: "donut",
  ring: "donut",
};

const PALETTE_ALIASES: Record<string, string> = {
  site: "site",
  default: "site",
  brand: "site",
  categorical: "site",
  mono: "mono",
  monochrome: "mono",
  single: "mono",
  violet: "mono",
  warm: "warm",
  hot: "warm",
  cool: "cool",
  cold: "cool",
};

/* ---------------------------------------------------------- text helpers -- */

/** Escape for both element content and attribute values. */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Round a coordinate so the output never carries floating point dust. */
function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function truncate(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function textWidth(text: string, size: number): number {
  return text.length * size * CHAR_RATIO;
}

function stripZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Axis and value label formatting. Deliberately hand rolled rather than
 * `toLocaleString`, which is locale dependent and would make the same input
 * render differently on two machines.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${stripZeros((value / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${stripZeros((value / 1e6).toFixed(2))}M`;
  const decimals = Number.isInteger(value) ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  const fixed = stripZeros(value.toFixed(decimals));
  const negative = fixed.startsWith("-");
  const bare = negative ? fixed.slice(1) : fixed;
  const [int, frac] = bare.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function formatPercent(pct: number): string {
  return stripZeros(pct.toFixed(1));
}

/* --------------------------------------------------------------- parsing -- */

/**
 * Read one cell as a number.
 *
 * Handles the shapes real spreadsheet exports contain: thousands separators
 * ("1,234" and "1 234"), currency symbols, a trailing percent sign ("45%"
 * becomes 45), and accounting negatives ("(1,234)" becomes -1234). Anything
 * that is not a plain number after that cleanup is a gap, not a zero, so text
 * columns and blank cells never fake a data point.
 *
 * Note the US convention: a comma is always a thousands separator, never a
 * decimal point, so "1,5" reads as 15.
 */
export function parseNumber(raw: string): number | null {
  let s = String(raw ?? "").trim();
  if (s === "") return null;

  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s,_\u00A0\u202F\u2009]/g, "").replace(/[$€£¥₹]/g, "");
  if (s.endsWith("%")) s = s.slice(0, -1);
  if (s === "" || !/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;

  const value = Number(s);
  return Number.isFinite(value) ? sign * value : null;
}

/**
 * A first row is a header when every non-empty cell after the label column is
 * non-numeric. That keeps "Month,Revenue,Cost" a header and "Jan,120,80" data.
 */
function detectHeader(row: string[], width: number): boolean {
  const start = width === 1 ? 0 : 1;
  const rest: string[] = [];
  for (let i = start; i < width; i++) {
    const cell = String(row[i] ?? "").trim();
    if (cell !== "") rest.push(cell);
  }
  if (rest.length > 0) return rest.every((cell) => parseNumber(cell) === null);
  const first = String(row[0] ?? "").trim();
  return first !== "" && parseNumber(first) === null;
}

/**
 * Pull an optional "# Title" line off the front.
 *
 * Guard against a real CSV whose first cell starts with a hash: the line only
 * counts as a title when whitespace follows the hash run, or when the
 * remainder holds no delimiter character at all.
 */
function takeTitle(lines: string[]): string | undefined {
  let index = 0;
  while (index < lines.length && String(lines[index]).trim() === "") index++;
  if (index >= lines.length) return undefined;

  const line = String(lines[index]).trimStart();
  if (!line.startsWith("#")) return undefined;

  const rest = line.replace(/^#+/, "");
  const title = rest.trim();
  if (title === "") return undefined;
  if (!/^\s/.test(rest) && /[,;\t|]/.test(rest)) return undefined;

  lines.splice(index, 1);
  return title;
}

/**
 * Parse CSV or TSV into the chart shape. Papa auto-detects the delimiter, so
 * comma, tab, semicolon and pipe files all work with no setup step.
 */
export function parseChartData(text: string): ChartData {
  const raw = typeof text === "string" ? text : "";
  if (raw.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to chart yet.",
      "Paste CSV or TSV data with a label column and at least one column of numbers, or drop a .csv file onto the input.",
    );
  }

  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const title = takeTitle(lines);

  const parsed = Papa.parse<string[]>(lines.join("\n"), {
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  // Delimiter warnings are normal for single column input, so only a real
  // parse failure (an unterminated quote, say) is worth stopping for.
  const fatal = parsed.errors.find((e) => e.type !== "Delimiter");
  if (fatal) {
    const line = typeof fatal.row === "number" ? fatal.row + 1 : undefined;
    throw new ToolError(
      "invalid-csv",
      line
        ? `Could not parse the data at line ${line}: ${fatal.message}.`
        : `Could not parse the data: ${fatal.message}.`,
      'Check that every quoted field has a matching closing quote, and that quotes inside a quoted field are doubled ("" not ").',
    );
  }

  const rows = parsed.data.filter(
    (row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim() !== ""),
  );
  if (rows.length === 0) {
    throw new ToolError(
      "empty-input",
      "No rows found in the input.",
      "Paste CSV or TSV data with a label column and at least one column of numbers.",
    );
  }

  let width = 1;
  for (const row of rows) width = Math.max(width, row.length);

  const hasHeader = detectHeader(rows[0], width);
  const headerRow = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;
  if (body.length === 0) {
    throw new ToolError(
      "no-numbers",
      "The input has a header row but no data rows.",
      "Add at least one row of values below the header.",
    );
  }

  // A single column is read as a bare list of numbers, labelled 1, 2, 3.
  const valueStart = width === 1 ? 0 : 1;
  const cells = body.length * (width - valueStart);
  if (cells > MAX_CELLS) {
    throw new ToolError(
      "too-many-points",
      `This input holds ${formatNumber(cells)} data cells, more than the ${formatNumber(MAX_CELLS)} a readable chart can carry.`,
      "Aggregate the data first (by week or by month, for example), or chart fewer columns.",
    );
  }

  const labels = body.map((row, i) => (width === 1 ? String(i + 1) : String(row[0] ?? "").trim()));

  const series: ChartSeries[] = [];
  for (let col = valueStart; col < width; col++) {
    const fallback = `Series ${col - valueStart + 1}`;
    const name = hasHeader ? String(headerRow[col] ?? "").trim() || fallback : fallback;
    series.push({ name, values: body.map((row) => parseNumber(String(row[col] ?? ""))) });
  }

  if (!series.some((s) => s.values.some((v) => v !== null))) {
    throw new ToolError(
      "no-numbers",
      "No numbers found in the data columns.",
      "Keep the labels in the first column and the numbers in the columns after it. Values like 1,234, $99 and 45% are read as numbers; text is not.",
    );
  }

  return title ? { title, labels, series } : { labels, series };
}

/* ----------------------------------------------------------- axis ticks -- */

function niceNum(range: number, round: boolean): number {
  if (!(range > 0)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * Math.pow(10, exponent);
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  // Normalise -0, which would otherwise print as "-0" on an axis.
  return rounded === 0 ? 0 : rounded;
}

/**
 * The classic "nice numbers" tick algorithm (Heckbert): pick a step from the
 * 1 / 2 / 5 family so the axis lands on round values, then extend the domain
 * outward to whole multiples of that step.
 *
 * niceTicks(0, 87, 5) gives 0, 20, 40, 60, 80, 100.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (hi < lo) [lo, hi] = [hi, lo];

  if (lo === hi) {
    // A flat series still needs an axis with room around the line.
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) / 2 : 1;
    lo -= pad;
    hi += pad;
  }

  const wanted = Math.max(2, Math.floor(count) || 5);
  const step = niceNum(niceNum(hi - lo, false) / (wanted - 1), true);
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step)) + 1));
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  for (let i = 0; i < 500; i++) {
    const value = start + i * step;
    ticks.push(roundTo(value, decimals));
    if (value >= end - step / 1000) break;
  }
  return ticks;
}

/* --------------------------------------------------------- option intake -- */

interface Resolved {
  type: string;
  width: number;
  height: number;
  legend: boolean;
  gridlines: boolean;
  valueLabels: boolean;
  palette: string;
  colors: string[];
}

function resolveNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Math.round(Number(value));
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ToolError(
      "bad-option",
      `${label} must be a whole number between ${min} and ${max}, and this run asked for ${String(value)}.`,
      `Choose a ${label.toLowerCase()} between ${min} and ${max}.`,
    );
  }
  return num;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

function resolveChoice(
  value: unknown,
  aliases: Record<string, string>,
  label: string,
  allowed: string[],
  fallback: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, "");
  const hit = aliases[key];
  if (!hit) {
    throw new ToolError(
      "bad-option",
      `"${String(value)}" is not a ${label} this tool draws.`,
      `Pick one of: ${allowed.join(", ")}.`,
    );
  }
  return hit;
}

function resolveOpts(opts: Partial<ChartOpts>): Resolved {
  const type = resolveChoice(opts.type, TYPE_ALIASES, "chart type", Object.keys(TYPE_LABELS), "bar");
  const palette = resolveChoice(
    opts.palette,
    PALETTE_ALIASES,
    "palette",
    Object.keys(PALETTES),
    "site",
  );
  return {
    type,
    palette,
    colors: PALETTES[palette] ?? PALETTES.site,
    width: resolveNumber(opts.width, "Width", MIN_WIDTH, MAX_WIDTH, 800),
    height: resolveNumber(opts.height, "Height", MIN_HEIGHT, MAX_HEIGHT, 450),
    legend: resolveBoolean(opts.legend, true),
    gridlines: resolveBoolean(opts.gridlines, true),
    valueLabels: resolveBoolean(opts.valueLabels, false),
  };
}

/* ------------------------------------------------------------- svg parts -- */

interface LegendItem {
  text: string;
  color: string;
}

function packLegend(items: LegendItem[], maxWidth: number): (LegendItem & { w: number })[][] {
  const rows: (LegendItem & { w: number })[][] = [];
  let row: (LegendItem & { w: number })[] = [];
  let used = 0;
  for (const item of items) {
    const w = SWATCH + 6 + textWidth(item.text, LABEL_SIZE) + LEGEND_GAP;
    if (row.length > 0 && used + w > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ ...item, w });
    used += w;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Title on the left, legend right aligned under it. Returns the first free y. */
function buildHeader(
  title: string | undefined,
  items: LegendItem[],
  o: Resolved,
): { parts: string[]; top: number } {
  const parts: string[] = [];
  let y = EDGE;

  if (title) {
    parts.push(
      `<text x="${n(EDGE)}" y="${n(y + TITLE_SIZE * 0.82)}" font-size="${TITLE_SIZE}" font-weight="600" fill="currentColor">${esc(truncate(title, 90))}</text>`,
    );
    y += TITLE_SIZE + 10;
  }

  if (o.legend && items.length > 0) {
    // A long legend must never eat the whole canvas: shorten the labels first,
    // then cap the rows and count off whatever did not fit.
    const maxRows = Math.max(1, Math.floor((o.height * 0.33) / LEGEND_ROW));
    const usable = o.width - EDGE * 2;
    let rows = packLegend(items, usable);
    if (rows.length > maxRows) {
      rows = packLegend(
        items.map((item) => ({ ...item, text: truncate(item.text, 8) })),
        usable,
      );
    }
    let hidden = 0;
    if (rows.length > maxRows) {
      rows = rows.slice(0, Math.max(1, maxRows - 1));
      hidden = items.length - rows.reduce((sum, row) => sum + row.length, 0);
    }

    for (const row of rows) {
      const rowWidth = row.reduce((sum, item) => sum + item.w, 0) - LEGEND_GAP;
      let x = Math.max(EDGE, o.width - EDGE - rowWidth);
      for (const item of row) {
        parts.push(
          `<rect x="${n(x)}" y="${n(y + 3)}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${item.color}"/>`,
        );
        parts.push(
          `<text x="${n(x + SWATCH + 6)}" y="${n(y + 12)}" fill="currentColor" fill-opacity="0.75">${esc(item.text)}</text>`,
        );
        x += item.w;
      }
      y += LEGEND_ROW;
    }
    if (hidden > 0) {
      parts.push(
        `<text x="${n(o.width - EDGE)}" y="${n(y + 12)}" text-anchor="end" fill="currentColor" fill-opacity="0.6">+${hidden} more</text>`,
      );
      y += LEGEND_ROW;
    }
    y += 6;
  }

  return { parts, top: y };
}

function markRect(
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  seriesName: string,
  label: string,
  value: number,
): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="2" fill="${color}" data-series="${esc(seriesName)}" data-label="${esc(label)}" data-value="${esc(String(value))}"/>`;
}

function markCircle(
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity: string,
  seriesName: string,
  label: string,
  value: number,
): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${color}" fill-opacity="${opacity}" data-series="${esc(seriesName)}" data-label="${esc(label)}" data-value="${esc(String(value))}"/>`;
}

function valueText(x: number, y: number, value: number, anchor: string): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${VALUE_SIZE}" text-anchor="${anchor}" fill="currentColor" fill-opacity="0.75">${esc(formatNumber(value))}</text>`;
}

function svgDocument(o: Resolved, title: string, desc: string, parts: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" viewBox="0 0 ${o.width} ${o.height}" role="img" font-family="${FONT_STACK}" font-size="${LABEL_SIZE}" data-chart-type="${o.type}" data-chart-palette="${o.palette}" data-chart-ink="currentColor">`,
    `<title>${esc(title)}</title>`,
    `<desc>${esc(desc)}</desc>`,
    ...parts,
    "</svg>",
  ].join("\n");
}

/* --------------------------------------------------- cartesian renderers -- */

function renderCartesian(data: ChartData, series: ChartSeries[], o: Resolved): string {
  const labels = data.labels;
  const stacked = o.type === "stacked-bar";
  const items = series.map((s, i) => ({
    text: truncate(s.name, MAX_LEGEND_CHARS),
    color: o.colors[i % o.colors.length],
  }));
  const head = buildHeader(data.title, items, o);
  const body: string[] = [...head.parts];

  let dmin = Infinity;
  let dmax = -Infinity;
  if (stacked) {
    for (let i = 0; i < labels.length; i++) {
      let positive = 0;
      let negative = 0;
      for (const s of series) {
        const v = s.values[i];
        if (v === null || v === undefined) continue;
        if (v >= 0) positive += v;
        else negative += v;
      }
      dmin = Math.min(dmin, negative);
      dmax = Math.max(dmax, positive);
    }
  } else {
    for (const s of series) {
      for (const v of s.values) {
        if (v === null || v === undefined) continue;
        dmin = Math.min(dmin, v);
        dmax = Math.max(dmax, v);
      }
    }
  }
  if (!Number.isFinite(dmin) || !Number.isFinite(dmax)) {
    dmin = 0;
    dmax = 1;
  }
  // Bars and areas are read against a baseline, so their axis must include
  // zero. Lines and scatter plots read better zoomed to the data.
  if (o.type !== "line" && o.type !== "scatter") {
    dmin = Math.min(dmin, 0);
    dmax = Math.max(dmax, 0);
  }

  const yTicks = niceTicks(
    dmin,
    dmax,
    Math.max(3, Math.min(9, Math.round((o.height - head.top - 60) / 55))),
  );
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];
  const yTexts = yTicks.map(formatNumber);

  const plotLeft = Math.min(
    o.width * 0.4,
    Math.max(34, 14 + Math.max(...yTexts.map((t) => textWidth(t, LABEL_SIZE)))),
  );
  const plotRight = o.width - EDGE - 4;
  const plotW = Math.max(40, plotRight - plotLeft);
  const band = plotW / Math.max(1, labels.length);

  // A line or scatter over a numeric first column gets a true numeric x axis
  // rather than evenly spaced categories.
  const numericX =
    (o.type === "line" || o.type === "area" || o.type === "scatter") &&
    labels.length > 0 &&
    labels.every((l) => parseNumber(l) !== null);
  const xValues = numericX ? labels.map((l) => parseNumber(l) as number) : [];
  let xTicks: number[] = [];
  let xMin = 0;
  let xMax = 1;
  if (numericX) {
    xTicks = niceTicks(
      Math.min(...xValues),
      Math.max(...xValues),
      Math.max(3, Math.min(9, Math.round(plotW / 90))),
    );
    xMin = xTicks[0];
    xMax = xTicks[xTicks.length - 1];
  }

  const fullXTexts = numericX
    ? xTicks.map(formatNumber)
    : labels.map((l) => truncate(l, MAX_LABEL_CHARS));
  const slot = numericX ? plotW / Math.max(1, xTicks.length - 1) : band;
  // Estimated width beats a measurement we cannot take without a DOM: rotate
  // as soon as the widest label would not fit its slot.
  const rotate = Math.max(0, ...fullXTexts.map((t) => textWidth(t, LABEL_SIZE))) > slot - 8;
  // A rotated label runs down and to the left, so the space it takes under the
  // axis is its width times sin(45). Trim it to what the reserved band holds,
  // otherwise a long category name runs off the bottom edge of the image.
  const xTexts = rotate ? fullXTexts.map((t) => truncate(t, ROTATED_LABEL_CHARS)) : fullXTexts;
  const maxXWidth = Math.max(0, ...xTexts.map((t) => textWidth(t, LABEL_SIZE)));
  const every = rotate ? Math.max(1, Math.ceil(15 / slot)) : 1;

  const plotTop = head.top;
  const plotBottom = Math.max(
    plotTop + 40,
    o.height - EDGE - (rotate ? 16 + maxXWidth * 0.71 : 20),
  );
  const plotH = plotBottom - plotTop;

  const yScale = (v: number) => plotBottom - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const xScale = (v: number) => plotLeft + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const bandCenter = (i: number) => plotLeft + (i + 0.5) * band;

  if (o.gridlines) {
    for (const tick of yTicks) {
      body.push(
        `<line x1="${n(plotLeft)}" y1="${n(yScale(tick))}" x2="${n(plotRight)}" y2="${n(yScale(tick))}" stroke="currentColor" stroke-opacity="0.12"/>`,
      );
    }
  }
  yTicks.forEach((tick, i) => {
    body.push(
      `<text x="${n(plotLeft - 8)}" y="${n(yScale(tick) + 4)}" text-anchor="end" fill="currentColor" fill-opacity="0.7">${esc(yTexts[i])}</text>`,
    );
  });
  body.push(
    `<line x1="${n(plotLeft)}" y1="${n(plotTop)}" x2="${n(plotLeft)}" y2="${n(plotBottom)}" stroke="currentColor" stroke-opacity="0.35"/>`,
  );
  body.push(
    `<line x1="${n(plotLeft)}" y1="${n(plotBottom)}" x2="${n(plotRight)}" y2="${n(plotBottom)}" stroke="currentColor" stroke-opacity="0.35"/>`,
  );
  if (yMin < 0 && yMax > 0) {
    body.push(
      `<line x1="${n(plotLeft)}" y1="${n(yScale(0))}" x2="${n(plotRight)}" y2="${n(yScale(0))}" stroke="currentColor" stroke-opacity="0.35"/>`,
    );
  }

  const drawXLabel = (x: number, text: string) => {
    if (!text) return;
    const y = plotBottom + 16;
    if (rotate) {
      body.push(
        `<text x="${n(x)}" y="${n(y)}" text-anchor="end" fill="currentColor" fill-opacity="0.7" transform="rotate(-45 ${n(x)} ${n(y)})">${esc(text)}</text>`,
      );
    } else {
      body.push(
        `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" fill="currentColor" fill-opacity="0.7">${esc(text)}</text>`,
      );
    }
  };
  if (numericX) {
    xTicks.forEach((tick, i) => {
      if (i % every === 0) drawXLabel(xScale(tick), xTexts[i]);
    });
  } else {
    labels.forEach((_, i) => {
      if (i % every === 0) drawXLabel(bandCenter(i), xTexts[i]);
    });
  }

  const baseY = yScale(Math.min(Math.max(0, yMin), yMax));

  if (o.type === "bar" || stacked) {
    const inner = band * 0.72;
    for (let i = 0; i < labels.length; i++) {
      const groupX = plotLeft + i * band + (band - inner) / 2;
      if (stacked) {
        let positive = 0;
        let negative = 0;
        series.forEach((s, si) => {
          const v = s.values[i];
          if (v === null || v === undefined) return;
          const from = v >= 0 ? positive : negative;
          const to = from + v;
          if (v >= 0) positive = to;
          else negative = to;
          const y0 = yScale(from);
          const y1 = yScale(to);
          body.push(
            markRect(
              groupX,
              Math.min(y0, y1),
              inner,
              Math.abs(y1 - y0),
              o.colors[si % o.colors.length],
              s.name,
              labels[i],
              v,
            ),
          );
          if (o.valueLabels && Math.abs(y1 - y0) >= 14) {
            body.push(valueText(groupX + inner / 2, (y0 + y1) / 2 + 4, v, "middle"));
          }
        });
      } else {
        const barW = Math.max(1, inner / series.length);
        series.forEach((s, si) => {
          const v = s.values[i];
          if (v === null || v === undefined) return;
          const x = groupX + si * barW;
          const y = yScale(v);
          body.push(
            markRect(
              x,
              Math.min(y, baseY),
              Math.max(1, barW - 1),
              Math.abs(y - baseY),
              o.colors[si % o.colors.length],
              s.name,
              labels[i],
              v,
            ),
          );
          if (o.valueLabels && barW >= 12) {
            body.push(valueText(x + barW / 2, Math.min(y, baseY) - 4, v, "middle"));
          }
        });
      }
    }
  }

  if (o.type === "line" || o.type === "area") {
    series.forEach((s, si) => {
      const color = o.colors[si % o.colors.length];
      const segments: { x: number; y: number; v: number; label: string }[][] = [];
      let current: { x: number; y: number; v: number; label: string }[] = [];
      s.values.forEach((v, i) => {
        // A gap ends the current run, which is what breaks the line.
        if (v === null || v === undefined) {
          if (current.length > 0) segments.push(current);
          current = [];
          return;
        }
        current.push({
          x: numericX ? xScale(xValues[i]) : bandCenter(i),
          y: yScale(v),
          v,
          label: labels[i] ?? "",
        });
      });
      if (current.length > 0) segments.push(current);

      if (o.type === "area") {
        for (const seg of segments) {
          if (seg.length < 2) continue;
          const d = [
            `M${n(seg[0].x)},${n(baseY)}`,
            ...seg.map((p) => `L${n(p.x)},${n(p.y)}`),
            `L${n(seg[seg.length - 1].x)},${n(baseY)}`,
            "Z",
          ].join(" ");
          body.push(
            `<path d="${d}" fill="${color}" fill-opacity="0.18" stroke="none" data-series="${esc(s.name)}"/>`,
          );
        }
      }

      const d = segments
        .map((seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" "))
        .join(" ");
      if (d !== "") {
        body.push(
          `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-series="${esc(s.name)}"/>`,
        );
      }

      const points = segments.reduce((sum, seg) => sum + seg.length, 0);
      for (const seg of segments) {
        // Dots stay off on dense series, but a lone point would be invisible
        // without one, so those always get drawn.
        if (points > 60 && seg.length > 1) continue;
        for (const p of seg) {
          body.push(markCircle(p.x, p.y, 3, color, "1", s.name, p.label, p.v));
          if (o.valueLabels) body.push(valueText(p.x, p.y - 8, p.v, "middle"));
        }
      }
    });
  }

  if (o.type === "scatter") {
    series.forEach((s, si) => {
      const color = o.colors[si % o.colors.length];
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const x = numericX ? xScale(xValues[i]) : bandCenter(i);
        body.push(markCircle(x, yScale(v), 4, color, "0.85", s.name, labels[i] ?? "", v));
        if (o.valueLabels) body.push(valueText(x, yScale(v) - 9, v, "middle"));
      });
    });
  }

  const desc = `${TYPE_LABELS[o.type]} chart with ${series.length} series over ${labels.length} ${labels.length === 1 ? "point" : "points"}.`;
  return svgDocument(o, data.title ?? `${TYPE_LABELS[o.type]} chart`, desc, body);
}

function renderHorizontalBar(data: ChartData, series: ChartSeries[], o: Resolved): string {
  const labels = data.labels;
  const items = series.map((s, i) => ({
    text: truncate(s.name, MAX_LEGEND_CHARS),
    color: o.colors[i % o.colors.length],
  }));
  const head = buildHeader(data.title, items, o);
  const body: string[] = [...head.parts];

  let dmin = 0;
  let dmax = 0;
  for (const s of series) {
    for (const v of s.values) {
      if (v === null || v === undefined) continue;
      dmin = Math.min(dmin, v);
      dmax = Math.max(dmax, v);
    }
  }

  const xTicks = niceTicks(dmin, dmax, Math.max(3, Math.min(9, Math.round(o.width / 130))));
  const xMin = xTicks[0];
  const xMax = xTicks[xTicks.length - 1];
  const xTexts = xTicks.map(formatNumber);

  const shownLabels = labels.map((l) => truncate(l, 20));
  const plotLeft = Math.min(
    o.width * 0.4,
    Math.max(34, 12 + Math.max(0, ...shownLabels.map((l) => textWidth(l, LABEL_SIZE)))),
  );
  const plotRight = o.width - EDGE - 8;
  const plotW = Math.max(40, plotRight - plotLeft);
  const plotTop = head.top;
  const plotBottom = Math.max(plotTop + 40, o.height - EDGE - 20);
  const plotH = plotBottom - plotTop;
  const band = plotH / Math.max(1, labels.length);

  const xScale = (v: number) => plotLeft + ((v - xMin) / (xMax - xMin || 1)) * plotW;

  if (o.gridlines) {
    for (const tick of xTicks) {
      body.push(
        `<line x1="${n(xScale(tick))}" y1="${n(plotTop)}" x2="${n(xScale(tick))}" y2="${n(plotBottom)}" stroke="currentColor" stroke-opacity="0.12"/>`,
      );
    }
  }
  xTicks.forEach((tick, i) => {
    body.push(
      `<text x="${n(xScale(tick))}" y="${n(plotBottom + 16)}" text-anchor="middle" fill="currentColor" fill-opacity="0.7">${esc(xTexts[i])}</text>`,
    );
  });
  body.push(
    `<line x1="${n(plotLeft)}" y1="${n(plotTop)}" x2="${n(plotLeft)}" y2="${n(plotBottom)}" stroke="currentColor" stroke-opacity="0.35"/>`,
  );
  body.push(
    `<line x1="${n(plotLeft)}" y1="${n(plotBottom)}" x2="${n(plotRight)}" y2="${n(plotBottom)}" stroke="currentColor" stroke-opacity="0.35"/>`,
  );

  const everyLabel = Math.max(1, Math.ceil(14 / band));
  labels.forEach((_, i) => {
    if (i % everyLabel !== 0 || !shownLabels[i]) return;
    body.push(
      `<text x="${n(plotLeft - 8)}" y="${n(plotTop + (i + 0.5) * band + 4)}" text-anchor="end" fill="currentColor" fill-opacity="0.7">${esc(shownLabels[i])}</text>`,
    );
  });

  const baseX = xScale(Math.min(Math.max(0, xMin), xMax));
  const inner = band * 0.72;
  const barH = Math.max(1, inner / series.length);
  for (let i = 0; i < labels.length; i++) {
    series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      const x = xScale(v);
      const y = plotTop + i * band + (band - inner) / 2 + si * barH;
      body.push(
        markRect(
          Math.min(x, baseX),
          y,
          Math.abs(x - baseX),
          Math.max(1, barH - 1),
          o.colors[si % o.colors.length],
          s.name,
          labels[i],
          v,
        ),
      );
      if (o.valueLabels && barH >= 10) {
        body.push(
          valueText(
            v >= 0 ? Math.max(x, baseX) + 4 : Math.min(x, baseX) - 4,
            y + barH / 2 + 3,
            v,
            v >= 0 ? "start" : "end",
          ),
        );
      }
    });
  }

  const desc = `Horizontal bar chart with ${series.length} series over ${labels.length} ${labels.length === 1 ? "category" : "categories"}.`;
  return svgDocument(o, data.title ?? "Horizontal bar chart", desc, body);
}

/* --------------------------------------------------------- pie and donut -- */

function slicePath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number) =>
    `${n(cx + radius * Math.cos(angle))},${n(cy + radius * Math.sin(angle))}`;
  if (inner <= 0) {
    return `M${n(cx)},${n(cy)} L${point(outer, a0)} A${n(outer)},${n(outer)} 0 ${large} 1 ${point(outer, a1)} Z`;
  }
  return `M${point(outer, a0)} A${n(outer)},${n(outer)} 0 ${large} 1 ${point(outer, a1)} L${point(inner, a1)} A${n(inner)},${n(inner)} 0 ${large} 0 ${point(inner, a0)} Z`;
}

function renderPie(data: ChartData, series: ChartSeries[], o: Resolved): string {
  const first = series[0];
  const entries: { label: string; value: number }[] = [];
  data.labels.forEach((label, i) => {
    const value = first.values[i];
    if (value === null || value === undefined || !(value > 0)) return;
    entries.push({ label: label || `Item ${i + 1}`, value });
  });

  if (entries.length === 0) {
    throw new ToolError(
      "no-numbers",
      "A pie chart needs at least one value above zero in the first data column.",
      "Switch to a bar or line chart, which can show zero and negative values, or chart a column with positive numbers.",
    );
  }

  // Above the cap the tail is folded into one "Other" slice. The eleven
  // largest survive (ties break toward the earlier row) and keep their
  // original order, so the chart still reads in the order the data was given.
  let slices = entries;
  let groupedCount = 0;
  if (entries.length > MAX_SLICES) {
    const keep = new Set(
      entries
        .map((entry, index) => ({ index, value: entry.value }))
        .sort((a, b) => b.value - a.value || a.index - b.index)
        .slice(0, MAX_SLICES - 1)
        .map((entry) => entry.index),
    );
    const rest = entries.filter((_, index) => !keep.has(index));
    groupedCount = rest.length;
    slices = [
      ...entries.filter((_, index) => keep.has(index)),
      { label: "Other", value: rest.reduce((sum, entry) => sum + entry.value, 0) },
    ];
  }

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const items = slices.map((slice, i) => ({
    text: truncate(slice.label, MAX_LEGEND_CHARS),
    color: o.colors[i % o.colors.length],
  }));
  const head = buildHeader(data.title, items, o);
  const body: string[] = [...head.parts];

  const areaTop = head.top;
  const areaBottom = o.height - EDGE;
  const cx = o.width / 2;
  const cy = (areaTop + areaBottom) / 2;
  const radius = Math.max(20, Math.min(o.width / 2 - EDGE - 56, (areaBottom - areaTop) / 2 - 16));
  const inner = o.type === "donut" ? radius * 0.58 : 0;

  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    // A lone slice would sweep a full turn, which draws nothing, so it stops a
    // hair short of the full circle.
    const sweep = Math.min((slice.value / total) * Math.PI * 2, Math.PI * 2 - 1e-6);
    const end = angle + sweep;
    body.push(
      `<path d="${slicePath(cx, cy, radius, inner, angle, end)}" fill="${o.colors[i % o.colors.length]}" data-label="${esc(slice.label)}" data-value="${esc(String(slice.value))}"/>`,
    );

    const pct = (slice.value / total) * 100;
    // Percentages sit outside the ring, in the page ink, so they stay legible
    // over any slice color in either theme.
    if (pct >= 2) {
      const mid = angle + sweep / 2;
      const lx = cx + (radius + 10) * Math.cos(mid);
      const ly = cy + (radius + 10) * Math.sin(mid) + 4;
      const text = o.legend
        ? `${formatPercent(pct)}%`
        : `${truncate(slice.label, 14)} ${formatPercent(pct)}%`;
      body.push(
        `<text x="${n(lx)}" y="${n(ly)}" text-anchor="${Math.cos(mid) >= -0.01 ? "start" : "end"}" fill="currentColor" fill-opacity="0.85">${esc(text)}</text>`,
      );
    }
    angle = end;
  });

  const desc =
    `${TYPE_LABELS[o.type]} chart of ${first.name} with ${slices.length} slices.` +
    (groupedCount > 0
      ? ` The ${groupedCount} smallest values are grouped into a slice named Other.`
      : "");
  return svgDocument(o, data.title ?? `${TYPE_LABELS[o.type]} chart`, desc, body);
}

/* ------------------------------------------------------------ public api -- */

/** Draw parsed data as a standalone SVG document. */
export function renderChart(data: ChartData, opts: Partial<ChartOpts> = {}): string {
  const o = resolveOpts(opts ?? {});
  const labels = data?.labels ?? [];
  // A column that parsed to nothing but gaps would poison the axis extent, so
  // it is dropped before anything is measured.
  const series = (data?.series ?? []).filter((s) =>
    s.values.some((v) => v !== null && v !== undefined && Number.isFinite(v)),
  );
  if (series.length === 0 || labels.length === 0) {
    throw new ToolError(
      "no-numbers",
      "This data has no numeric column to chart.",
      "Keep the labels in the first column and the numbers in the columns after it.",
    );
  }

  const normalized: ChartData = data.title
    ? { title: data.title, labels, series }
    : { labels, series };

  if (o.type === "pie" || o.type === "donut") return renderPie(normalized, series, o);
  if (o.type === "horizontal-bar") return renderHorizontalBar(normalized, series, o);
  return renderCartesian(normalized, series, o);
}

export function run(input: string, opts: ChartOpts): string {
  return renderChart(parseChartData(typeof input === "string" ? input : ""), opts);
}

export default { run } satisfies ToolLogic<string, string, ChartOpts>;
