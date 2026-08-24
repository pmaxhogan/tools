import { ToolError, type ToolLogic } from "../types";
import {
  FINGER_CODES,
  FINGER_HOME_X,
  FINGER_LABELS,
  LAYOUTS,
  LAYOUT_IDS,
  ROW_LABELS,
  keyForChar,
  keyId,
  resolveLayoutId,
  type Layout,
  type LayoutKey,
} from "./layouts";

/** Longest input the analyzer accepts, measured in characters. */
export const MAX_CHARACTERS = 2 * 1024 * 1024;

/** Shown when the input box is empty so the page always has something to read. */
export const DEFAULT_TEXT =
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow.";

/**
 * Per keystroke effort weights, in arbitrary units where a home row index or
 * middle key costs 1.0. They are the only tunable in the whole model, so they
 * are written out here rather than buried in the scoring function:
 *
 *   row base      home row 1.0, top row 1.5, bottom row 1.7, number row 2.5
 *   pinky         +0.5 on the two pinky fingers
 *   inner index   +0.5 on the columns an index finger must stretch into
 *
 * That puts every top row key between 1.5 and 2.0, every bottom row key
 * between 1.7 and 2.2, and every number row key between 2.5 and 3.0. Holding
 * Shift is not scored: the analysis is case insensitive, so an upper case
 * letter costs exactly what its lower case twin costs.
 */
export const ROW_EFFORT = [2.5, 1.5, 1.0, 1.7];
export const PINKY_EFFORT = 0.5;
export const INNER_INDEX_EFFORT = 0.5;

/** Effort weight of a single press of one key. */
export function keyEffort(key: LayoutKey): number {
  let effort = ROW_EFFORT[key.row];
  if (key.finger === 0 || key.finger === 7) effort += PINKY_EFFORT;
  if (key.innerIndex) effort += INNER_INDEX_EFFORT;
  return effort;
}

/**
 * How far the finger travels from its resting key to this key, in key units,
 * counting the trip out only. Rows are one key unit apart vertically, so a
 * straight reach up one row is 1.0 and a diagonal reach is a little more.
 */
export function keyDistance(key: LayoutKey): number {
  const dx = key.x - FINGER_HOME_X[key.finger];
  const dy = key.row - 2;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

export interface KeyHit {
  id: string;
  char: string;
  count: number;
  percent: number;
  finger: number;
  row: number;
}

export interface Analysis {
  layoutId: string;
  layoutName: string;
  /** Every character in the text, including spaces and unmapped ones. */
  characters: number;
  /** Characters that landed on a key. This is the keystroke count. */
  keystrokes: number;
  /** Characters this layout has no key for, such as emoji or CJK. */
  skipped: number;
  /** Spaces, tabs and line breaks. Not keystrokes, and they end a bigram run. */
  whitespace: number;
  /** Press count per key, keyed by "row-col". Feeds renderHeatmapSvg. */
  hitCounts: Record<string, number>;
  fingerCounts: number[];
  fingerPercents: number[];
  handCounts: { left: number; right: number };
  handPercents: { left: number; right: number };
  rowCounts: number[];
  rowPercents: number[];
  /** Keystrokes on the home row, the G and H stretch columns included. */
  homeRowCount: number;
  homeRowPercent: number;
  /** Keystrokes on the eight keys the fingers actually rest on. */
  restingCount: number;
  restingPercent: number;
  /** Pairs of consecutive keystrokes inside a word. */
  bigrams: number;
  sameFingerBigrams: number;
  sameFingerPercent: number;
  /** Keystrokes that pull an index finger out of its own column. */
  lateralStretches: number;
  lateralStretchPercent: number;
  alternations: number;
  alternationPercent: number;
  inwardRolls: number;
  outwardRolls: number;
  rolls: number;
  rollPercent: number;
  /** Repeats of the very same key, which are neither a roll nor a same finger bigram. */
  repeats: number;
  effort: number;
  effortPer100: number;
  distance: number;
  distancePer100: number;
  topKeys: KeyHit[];
}

export interface AnalyzeOptions {
  /** How many entries the topKeys list holds. Default 10. */
  topKeys?: number;
}

function emptyAnalysis(layout: Layout): Analysis {
  return {
    layoutId: layout.id,
    layoutName: layout.name,
    characters: 0,
    keystrokes: 0,
    skipped: 0,
    whitespace: 0,
    hitCounts: {},
    fingerCounts: new Array(8).fill(0),
    fingerPercents: new Array(8).fill(0),
    handCounts: { left: 0, right: 0 },
    handPercents: { left: 0, right: 0 },
    rowCounts: new Array(4).fill(0),
    rowPercents: new Array(4).fill(0),
    homeRowCount: 0,
    homeRowPercent: 0,
    restingCount: 0,
    restingPercent: 0,
    bigrams: 0,
    sameFingerBigrams: 0,
    sameFingerPercent: 0,
    lateralStretches: 0,
    lateralStretchPercent: 0,
    alternations: 0,
    alternationPercent: 0,
    inwardRolls: 0,
    outwardRolls: 0,
    rolls: 0,
    rollPercent: 0,
    repeats: 0,
    effort: 0,
    effortPer100: 0,
    distance: 0,
    distancePer100: 0,
    topKeys: [],
  };
}

/** Layout by id, or a ToolError naming the ones that do exist. */
export function requireLayout(raw: string): Layout {
  const id = resolveLayoutId(raw);
  const layout = id === undefined ? undefined : LAYOUTS[id];
  if (!layout) {
    throw new ToolError(
      "bad-layout",
      `There is no keyboard layout called "${String(raw)}".`,
      `Pick one of: ${LAYOUT_IDS.join(", ")}. Spaces, hyphens and case are ignored, so "Colemak DH" and "mod dh" both mean colemak-dh.`,
    );
  }
  return layout;
}

/**
 * Count key, finger, hand, row and bigram load for one text on one layout.
 *
 * Matching is case insensitive and shifted symbols resolve to the key that
 * produces them, so "A" and "a" both count as one press of the a key, and "%"
 * counts as one press of whichever key carries it on that layout.
 *
 * Whitespace is a separator rather than a keystroke: the space bar is a thumb
 * key and the analysis covers the eight non thumb fingers, so spaces, tabs and
 * line breaks are counted on their own and end the current bigram run.
 */
export function analyzeText(text: string, layoutId: string, opts: AnalyzeOptions = {}): Analysis {
  const layout = requireLayout(layoutId);
  const result = emptyAnalysis(layout);
  const source = typeof text === "string" ? text : "";
  const chars = [...source];
  result.characters = chars.length;

  const topCount = Math.max(1, Math.floor(opts.topKeys ?? 10));
  // Every weight is a whole number of tenths, so the running total is kept in
  // tenths. Adding 1.7 sixty times in floating point drifts; adding 17 does not.
  let effortTenths = 0;
  const hits = new Map<string, { key: LayoutKey; count: number }>();
  let previous: LayoutKey | undefined;

  for (const char of chars) {
    if (/\s/.test(char)) {
      result.whitespace++;
      previous = undefined;
      continue;
    }
    const key = keyForChar(layout, char);
    if (!key) {
      result.skipped++;
      previous = undefined;
      continue;
    }

    result.keystrokes++;
    result.fingerCounts[key.finger]++;
    result.handCounts[key.hand]++;
    result.rowCounts[key.row]++;
    if (key.resting) result.restingCount++;
    if (key.innerIndex) result.lateralStretches++;
    effortTenths += Math.round(keyEffort(key) * 10);
    result.distance += keyDistance(key);

    const id = keyId(key);
    const entry = hits.get(id);
    if (entry) entry.count++;
    else hits.set(id, { key, count: 1 });

    if (previous) {
      result.bigrams++;
      if (previous.hand !== key.hand) {
        result.alternations++;
      } else if (previous.finger === key.finger) {
        if (previous.row === key.row && previous.col === key.col) result.repeats++;
        else result.sameFingerBigrams++;
      } else {
        const inward =
          key.hand === "left" ? key.finger > previous.finger : key.finger < previous.finger;
        if (inward) result.inwardRolls++;
        else result.outwardRolls++;
      }
    }
    previous = key;
  }

  const strokes = result.keystrokes;
  const share = (n: number): number => (strokes === 0 ? 0 : (n / strokes) * 100);
  const bigramShare = (n: number): number =>
    result.bigrams === 0 ? 0 : (n / result.bigrams) * 100;

  result.fingerPercents = result.fingerCounts.map(share);
  result.handPercents = {
    left: share(result.handCounts.left),
    right: share(result.handCounts.right),
  };
  result.rowPercents = result.rowCounts.map(share);
  result.homeRowCount = result.rowCounts[2];
  result.homeRowPercent = result.rowPercents[2];
  result.restingPercent = share(result.restingCount);
  result.lateralStretchPercent = share(result.lateralStretches);
  result.sameFingerPercent = bigramShare(result.sameFingerBigrams);
  result.alternationPercent = bigramShare(result.alternations);
  result.rolls = result.inwardRolls + result.outwardRolls;
  result.rollPercent = bigramShare(result.rolls);
  result.effort = effortTenths / 10;
  result.effortPer100 = strokes === 0 ? 0 : (effortTenths * 10) / strokes;
  result.distancePer100 = strokes === 0 ? 0 : (result.distance / strokes) * 100;

  for (const [id, entry] of hits) result.hitCounts[id] = entry.count;

  result.topKeys = [...hits.values()]
    .sort((a, b) => b.count - a.count || keyId(a.key).localeCompare(keyId(b.key)))
    .slice(0, topCount)
    .map((entry) => ({
      id: keyId(entry.key),
      char: entry.key.char,
      count: entry.count,
      percent: share(entry.count),
      finger: entry.key.finger,
      row: entry.key.row,
    }));

  return result;
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

export interface ComparisonRow {
  /** 1 is the lowest effort layout for this text. */
  rank: number;
  layoutId: string;
  layoutName: string;
  effortPer100: number;
  sameFingerPercent: number;
  homeRowPercent: number;
  alternationPercent: number;
  rollPercent: number;
  distancePer100: number;
  keystrokes: number;
  characters: number;
}

/**
 * Run the same text through several layouts. The returned record is keyed by
 * layout id and its insertion order is the ranking, lowest effort first, so
 * Object.values() gives a ready to render table. Ties break on layout id so
 * the order never depends on anything but the input.
 */
export function compareLayouts(
  text: string,
  layoutIds: string[] = LAYOUT_IDS,
): Record<string, ComparisonRow> {
  const ids = layoutIds.length === 0 ? LAYOUT_IDS : layoutIds;
  const analyzes = ids.map((id) => analyzeText(text, id, { topKeys: 1 }));

  const seen = new Set<string>();
  const ranked = analyzes
    .filter((analysis) => {
      if (seen.has(analysis.layoutId)) return false;
      seen.add(analysis.layoutId);
      return true;
    })
    .sort((a, b) => a.effortPer100 - b.effortPer100 || a.layoutId.localeCompare(b.layoutId));

  const table: Record<string, ComparisonRow> = {};
  ranked.forEach((analysis, position) => {
    table[analysis.layoutId] = {
      rank: position + 1,
      layoutId: analysis.layoutId,
      layoutName: analysis.layoutName,
      effortPer100: analysis.effortPer100,
      sameFingerPercent: analysis.sameFingerPercent,
      homeRowPercent: analysis.homeRowPercent,
      alternationPercent: analysis.alternationPercent,
      rollPercent: analysis.rollPercent,
      distancePer100: analysis.distancePer100,
      keystrokes: analysis.keystrokes,
      characters: analysis.characters,
    };
  });
  return table;
}

/* ------------------------------------------------------------------ *
 * SVG heatmap
 * ------------------------------------------------------------------ */

const UNIT = 52;
const KEY_SIZE = 46;
const PAD = 14;
const LEGEND_HEIGHT = 52;

/** Outline color per finger, so the eight finger zones read at a glance. */
const FINGER_COLORS = [
  "#b45309",
  "#a16207",
  "#4d7c0f",
  "#0f766e",
  "#0e7490",
  "#4338ca",
  "#7e22ce",
  "#be123c",
];

/**
 * Fill for a key whose share of the busiest key is `t`, from 0 to 1. One hue
 * throughout, light for cold and saturated for hot, so the ramp reads the same
 * way for every kind of color vision.
 */
export function heatFill(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const lightness = 96 - 60 * clamped;
  return `hsl(212 78% ${lightness.toFixed(1)}%)`;
}

function labelColor(t: number): string {
  return t >= 0.55 ? "#ffffff" : "#0f172a";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Keycap legend: a single upper case glyph where one exists. */
function capLabel(char: string): string {
  const upper = char.toUpperCase();
  return [...upper].length === 1 ? upper : char;
}

/**
 * A keyboard diagram with every key tinted by how often it was pressed.
 *
 * `hitCounts` may be keyed by the "row-col" ids that analyzeText produces or
 * by the characters themselves, whichever the caller has to hand. The output
 * is a plain deterministic SVG string with no external references, so it can
 * be inlined, downloaded, or diffed.
 */
export function renderHeatmapSvg(layoutId: string, hitCounts: Record<string, number>): string {
  const layout = requireLayout(layoutId);
  const counts = hitCounts ?? {};

  const countFor = (key: LayoutKey): number => {
    const byId = counts[keyId(key)];
    if (typeof byId === "number" && Number.isFinite(byId)) return Math.max(0, byId);
    const byChar = counts[key.char];
    if (typeof byChar === "number" && Number.isFinite(byChar)) return Math.max(0, byChar);
    return 0;
  };

  let max = 0;
  let total = 0;
  for (const key of layout.keys) {
    const count = countFor(key);
    total += count;
    if (count > max) max = count;
  }

  const rightEdge = layout.keys.reduce((widest, key) => Math.max(widest, key.x + 1), 0);
  const width = Math.round(PAD * 2 + rightEdge * UNIT);
  const boardHeight = 4 * UNIT;
  const height = PAD * 2 + boardHeight + LEGEND_HEIGHT;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(layout.name)} key frequency heatmap" font-family="ui-sans-serif, system-ui, sans-serif">`,
  );
  parts.push(
    `<title>${escapeXml(layout.name)} heatmap, ${total} keystrokes, busiest key pressed ${max} times</title>`,
  );

  for (const key of layout.keys) {
    const count = countFor(key);
    const t = max === 0 ? 0 : count / max;
    const x = PAD + key.x * UNIT;
    const y = PAD + key.row * UNIT;
    parts.push(
      `<rect data-key="${escapeXml(keyId(key))}" data-char="${escapeXml(key.char)}" data-count="${count}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${KEY_SIZE}" height="${KEY_SIZE}" rx="6" fill="${heatFill(t)}" stroke="${FINGER_COLORS[key.finger]}" stroke-width="2"/>`,
    );
    parts.push(
      `<text x="${(x + KEY_SIZE / 2).toFixed(1)}" y="${(y + 22).toFixed(1)}" text-anchor="middle" font-size="17" font-weight="600" fill="${labelColor(t)}">${escapeXml(capLabel(key.char))}</text>`,
    );
    if (count > 0) {
      parts.push(
        `<text x="${(x + KEY_SIZE / 2).toFixed(1)}" y="${(y + 38).toFixed(1)}" text-anchor="middle" font-size="10" fill="${labelColor(t)}" opacity="0.85">${count}</text>`,
      );
    }
  }

  const legendY = PAD + boardHeight + 22;
  parts.push(
    `<text x="${PAD}" y="${legendY}" font-size="12" fill="#64748b">Outline color marks the finger zone. Darker fill means the key was pressed more often.</text>`,
  );
  FINGER_CODES.forEach((code, finger) => {
    const x = PAD + finger * 84;
    parts.push(
      `<text x="${x}" y="${legendY + 20}" font-size="12" font-weight="600" fill="${FINGER_COLORS[finger]}">${escapeXml(code)} ${escapeXml(FINGER_LABELS[finger])}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface HeatmapOpts {
  /** Layout id, or any spelling resolveLayoutId understands. */
  layout: string;
  /** "analyze" for one layout, "compare" for every layout ranked. */
  mode: string;
  [key: string]: unknown;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function num(value: number): string {
  return value.toFixed(1);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function fingerLoadLine(analysis: Analysis): string {
  return FINGER_LABELS.map(
    (label, finger) => `${label} ${pct(analysis.fingerPercents[finger])}`,
  ).join(", ");
}

function rowLine(analysis: Analysis): string {
  return ROW_LABELS.map((label, row) => `${label} ${pct(analysis.rowPercents[row])}`).join(", ");
}

function topKeysLine(analysis: Analysis): string {
  if (analysis.topKeys.length === 0) return "none, nothing landed on a key";
  return analysis.topKeys.map((hit) => `${hit.char} ${hit.count} (${pct(hit.percent)})`).join(", ");
}

function skippedLine(analysis: Analysis): string {
  const parts = [
    `${plural(analysis.skipped, "character", "characters")} with no key on this layout`,
  ];
  parts.push(
    `${plural(analysis.whitespace, "space, tab or line break", "spaces, tabs and line breaks")} counted separately`,
  );
  return parts.join(", ");
}

function analyzeRows(analysis: Analysis): Record<string, string> {
  return {
    Layout: analysis.layoutName,
    "Characters analyzed": `${plural(analysis.keystrokes, "keystroke", "keystrokes")} from ${plural(analysis.characters, "character", "characters")}`,
    Skipped: skippedLine(analysis),
    "Finger load": fingerLoadLine(analysis),
    "Hand balance": `left ${pct(analysis.handPercents.left)}, right ${pct(analysis.handPercents.right)}`,
    "Home row": `${pct(analysis.homeRowPercent)} of keystrokes stay on the home row, ${pct(analysis.restingPercent)} land on the eight keys the fingers rest on`,
    "Row distribution": rowLine(analysis),
    "Same-finger bigrams": `${analysis.sameFingerBigrams} of ${plural(analysis.bigrams, "bigram", "bigrams")} (${pct(analysis.sameFingerPercent)})`,
    "Lateral stretches": `${analysis.lateralStretches} of ${plural(analysis.keystrokes, "keystroke", "keystrokes")} (${pct(analysis.lateralStretchPercent)}) pull an index finger into its inner column`,
    Alternation: `${analysis.alternations} of ${plural(analysis.bigrams, "bigram", "bigrams")} (${pct(analysis.alternationPercent)}) swap hands`,
    Rolls: `${analysis.rolls} of ${plural(analysis.bigrams, "bigram", "bigrams")} (${pct(analysis.rollPercent)}), ${analysis.inwardRolls} inward and ${analysis.outwardRolls} outward`,
    "Effort per 100": num(analysis.effortPer100),
    "Effort weights": `home row 1.0, top row 1.5, bottom row 1.7, number row 2.5, plus 0.5 on a pinky key and 0.5 on an inner index column. Lower is easier.`,
    Distance: `${num(analysis.distance)} key units total, ${num(analysis.distancePer100)} per 100 keystrokes`,
    "Top 10 keys": topKeysLine(analysis),
  };
}

function compareRows(text: string, selected: Layout): Record<string, string> {
  const table = compareLayouts(text, LAYOUT_IDS);
  const rows = Object.values(table);
  const rendered: Record<string, string> = {};

  const mine = table[selected.id] ?? rows[0];
  rendered["Characters analyzed"] =
    `${plural(mine.keystrokes, "keystroke", "keystrokes")} from ${plural(mine.characters, "character", "characters")} on ${mine.layoutName}, compared across ${plural(rows.length, "layout", "layouts")}`;

  for (const row of rows) {
    rendered[`${row.rank}. ${row.layoutName}`] =
      `effort ${num(row.effortPer100)} per 100, SFB ${pct(row.sameFingerPercent)}, home row ${pct(row.homeRowPercent)}, alternation ${pct(row.alternationPercent)}, rolls ${pct(row.rollPercent)}`;
  }

  const winner = rows[0];
  rendered.Winner = `${winner.layoutName} at ${num(winner.effortPer100)} effort per 100 keystrokes, the lowest of the ${rows.length} layouts compared`;

  if (table[selected.id]) {
    rendered["Your layout"] =
      mine.rank === 1
        ? `${mine.layoutName} is already the lowest effort layout for this text`
        : `${mine.layoutName} ranks ${mine.rank} of ${rows.length}, ${num(mine.effortPer100 - winner.effortPer100)} effort per 100 behind ${winner.layoutName}`;
  }

  return rendered;
}

export function run(input: string, opts: HeatmapOpts): Record<string, string> {
  const raw = typeof input === "string" ? input : "";
  if (raw.length > MAX_CHARACTERS) {
    throw new ToolError(
      "text-too-long",
      `That text is ${raw.length} characters and the limit is ${MAX_CHARACTERS}.`,
      "Paste a sample instead of the whole corpus. A few thousand words is already enough for the finger load numbers to settle.",
    );
  }

  const usedDefault = raw.trim() === "";
  const text = usedDefault ? DEFAULT_TEXT : raw;

  const mode = String(opts?.mode ?? "analyze")
    .toLowerCase()
    .trim();
  if (mode !== "analyze" && mode !== "compare") {
    throw new ToolError(
      "bad-mode",
      `There is no mode called "${String(opts?.mode)}".`,
      "Pick analyze or compare.",
    );
  }

  const layout = requireLayout(String(opts?.layout ?? "qwerty"));

  const rows =
    mode === "compare" ? compareRows(text, layout) : analyzeRows(analyzeText(text, layout.id));

  if (usedDefault) {
    rows.Note =
      "No text was given, so this analyzed the built-in pangram sample. Paste your own writing, code, or chat log to see how your real key load falls.";
  }
  return rows;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, HeatmapOpts>;
