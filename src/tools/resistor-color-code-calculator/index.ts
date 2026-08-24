import { ToolError, type ToolLogic } from "../types";

export interface ResistorOpts {
  /** "decode" | "encode" */
  mode: string;
  /** encode only: "4" | "5" | "6" */
  bands?: string;
  /** encode only: percent as a string, e.g. "5", "1", "0.5", "20" */
  tolerance?: string;
  /** encode only, 6-band: ppm/K as a string, e.g. "100", "50" */
  tempco?: string;
  [key: string]: unknown;
}

export type ResistorResult = Record<string, string>;

interface ColorInfo {
  digit?: number;
  multiplierExp: number;
  tolerance?: number;
  tempco?: number;
}

/** Canonical band color data. Every color has a multiplier; only black-white have a digit. */
const COLOR_INFO: Record<string, ColorInfo> = {
  black: { digit: 0, multiplierExp: 0 },
  brown: { digit: 1, multiplierExp: 1, tolerance: 1, tempco: 100 },
  red: { digit: 2, multiplierExp: 2, tolerance: 2, tempco: 50 },
  orange: { digit: 3, multiplierExp: 3, tempco: 15 },
  yellow: { digit: 4, multiplierExp: 4, tempco: 25 },
  green: { digit: 5, multiplierExp: 5, tolerance: 0.5 },
  blue: { digit: 6, multiplierExp: 6, tolerance: 0.25, tempco: 10 },
  violet: { digit: 7, multiplierExp: 7, tolerance: 0.1, tempco: 5 },
  grey: { digit: 8, multiplierExp: 8, tolerance: 0.05 },
  white: { digit: 9, multiplierExp: 9 },
  gold: { multiplierExp: -1, tolerance: 5 },
  silver: { multiplierExp: -2, tolerance: 10 },
};

const CANONICAL_COLORS = Object.keys(COLOR_INFO);

/** Alternate spellings accepted on input. Deliberately no single-letter abbreviations. */
const COLOR_ALIASES: Record<string, string> = { gray: "grey", gry: "grey", purple: "violet" };
for (const c of CANONICAL_COLORS) COLOR_ALIASES[c] = c;

const DIGIT_COLOR: Record<number, string> = {
  0: "black",
  1: "brown",
  2: "red",
  3: "orange",
  4: "yellow",
  5: "green",
  6: "blue",
  7: "violet",
  8: "grey",
  9: "white",
};

const MULTIPLIER_COLOR: Record<number, string> = {
  "-2": "silver",
  "-1": "gold",
  0: "black",
  1: "brown",
  2: "red",
  3: "orange",
  4: "yellow",
  5: "green",
  6: "blue",
  7: "violet",
  8: "grey",
  9: "white",
};

const TOLERANCE_TO_COLOR: Record<string, string> = {
  "1": "brown",
  "2": "red",
  "0.5": "green",
  "0.25": "blue",
  "0.1": "violet",
  "0.05": "grey",
  "5": "gold",
  "10": "silver",
};

const TEMPCO_TO_COLOR: Record<string, string> = {
  "100": "brown",
  "50": "red",
  "15": "orange",
  "25": "yellow",
  "10": "blue",
  "5": "violet",
};

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

/** Standard E12/E24/E96 series, one decade, values 1.00-9.76. */
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6,
  6.2, 6.8, 7.5, 8.2, 9.1,
];
const E96 = [
  1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43, 1.47,
  1.5, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1, 2.15, 2.21,
  2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.8, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24,
  3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53, 4.64, 4.75,
  4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65, 6.81, 6.98,
  7.15, 7.32, 7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

/** Engineering-notation scale steps, exponent must be a multiple of 3. */
const SCALES = [
  { exp: -6, suf: "u" },
  { exp: -3, suf: "m" },
  { exp: 0, suf: "" },
  { exp: 3, suf: "k" },
  { exp: 6, suf: "M" },
  { exp: 9, suf: "G" },
];

/** Format a value in engineering notation with up to 3 significant figures, e.g. "4.70 kohm". */
function formatEng(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  let choice = SCALES[SCALES.length - 1];
  let found = false;
  for (const s of SCALES) {
    const scaled = abs / 10 ** s.exp;
    if (scaled >= 1 && scaled < 1000) {
      choice = s;
      found = true;
      break;
    }
  }
  if (!found && abs < 10 ** SCALES[0].exp) choice = SCALES[0];

  const scaled = abs / 10 ** choice.exp;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${sign}${scaled.toFixed(decimals)} ${choice.suf}${unit}`;
}

/** Nearest value in a standard series (checked across nearby decades), and whether it is an exact match. */
function nearestInSeries(value: number, series: number[]): { value: number; exact: boolean } {
  if (value <= 0) return { value: 0, exact: value === 0 };
  const decade = Math.floor(Math.log10(value));
  let best = { value: series[0] * 10 ** decade, diff: Infinity };
  for (const exp of [decade - 1, decade, decade + 1]) {
    for (const base of series) {
      const candidate = Math.round(base * 10 ** exp * 1e6) / 1e6;
      const diff = Math.abs(candidate - value);
      if (diff < best.diff) best = { value: candidate, diff };
    }
  }
  return { value: best.value, exact: best.diff / value < 1e-6 };
}

function eSeriesRows(value: number): ResistorResult {
  const e12 = nearestInSeries(value, E12);
  const e24 = nearestInSeries(value, E24);
  const e96 = nearestInSeries(value, E96);
  return {
    "E12 standard value": e12.exact
      ? "Yes, exact E12 match."
      : `No, nearest E12 value is ${formatEng(e12.value, "ohm")}.`,
    "E24 standard value": e24.exact
      ? "Yes, exact E24 match."
      : `No, nearest E24 value is ${formatEng(e24.value, "ohm")}.`,
    "E96 standard value": e96.exact
      ? "Yes, exact E96 match."
      : `No, nearest E96 value is ${formatEng(e96.value, "ohm")}.`,
  };
}

/** Human-readable label for a multiplier exponent, e.g. 2 -> "x100", -1 -> "x0.1". */
function multiplierLabel(exp: number): string {
  return `x${10 ** exp}`;
}

function normalizeColor(token: string): string {
  const key = token.trim().toLowerCase();
  const canon = COLOR_ALIASES[key];
  if (!canon) {
    throw new ToolError(
      "bad-color",
      `"${token}" is not a recognized resistor band color.`,
      "Use black, brown, red, orange, yellow, green, blue, violet, grey (or gray), white, gold, or silver.",
    );
  }
  return canon;
}

// ---------------------------------------------------------------------------
// Decode: colors -> value
// ---------------------------------------------------------------------------

function decode(raw: string): ResistorResult {
  const tokens = raw.split(/[\s,-]+/).filter(Boolean);
  const n = tokens.length;
  if (n < 3 || n > 6) {
    throw new ToolError(
      "bad-band-count",
      `Resistor color codes use 3 to 6 bands; got ${n}.`,
      'Enter 3 to 6 color names, like "brown black red gold" for a 4-band code.',
    );
  }

  const colors = tokens.map(normalizeColor);
  const digitCount = n <= 4 ? 2 : 3;
  const multiplierPos = digitCount;
  const tolerancePos = n >= 4 ? digitCount + 1 : null;
  const tempcoPos = n === 6 ? 5 : null;

  const digits: number[] = [];
  for (let pos = 0; pos < digitCount; pos++) {
    const info = COLOR_INFO[colors[pos]];
    if (info.digit === undefined) {
      throw new ToolError(
        "bad-band-count",
        `"${colors[pos]}" cannot be the ${ORDINALS[pos]} band; digit bands must be black through white, never gold or silver.`,
        "Gold and silver may only appear as the multiplier or tolerance band.",
      );
    }
    digits.push(info.digit);
  }

  const multiplierExp = COLOR_INFO[colors[multiplierPos]].multiplierExp;

  let tolerancePercent = 20;
  if (tolerancePos !== null) {
    const info = COLOR_INFO[colors[tolerancePos]];
    if (info.tolerance === undefined) {
      throw new ToolError(
        "bad-band-count",
        `"${colors[tolerancePos]}" cannot be the tolerance band; use brown, red, green, blue, violet, grey, gold, or silver.`,
        "Pick a color with a defined tolerance for the tolerance band.",
      );
    }
    tolerancePercent = info.tolerance;
  }

  let tempcoPpm: number | undefined;
  if (tempcoPos !== null) {
    const info = COLOR_INFO[colors[tempcoPos]];
    if (info.tempco === undefined) {
      throw new ToolError(
        "bad-band-count",
        `"${colors[tempcoPos]}" cannot be the temperature coefficient band; use brown, red, orange, yellow, blue, or violet.`,
        "Pick a color with a defined ppm/K rating for the 6th band.",
      );
    }
    tempcoPpm = info.tempco;
  }

  const mantissa = digits.reduce((acc, d) => acc * 10 + d, 0);
  const value = mantissa * 10 ** multiplierExp;
  const min = value * (1 - tolerancePercent / 100);
  const max = value * (1 + tolerancePercent / 100);

  const bandParts: string[] = digits.map((d, i) => `${ORDINALS[i]} ${colors[i]} = digit ${d}`);
  bandParts.push(
    `${ORDINALS[multiplierPos]} ${colors[multiplierPos]} = multiplier ${multiplierLabel(multiplierExp)}`,
  );
  bandParts.push(
    tolerancePos !== null
      ? `${ORDINALS[tolerancePos]} ${colors[tolerancePos]} = tolerance ${tolerancePercent}%`
      : "no tolerance band = tolerance 20%",
  );
  if (tempcoPos !== null) {
    bandParts.push(
      `${ORDINALS[tempcoPos]} ${colors[tempcoPos]} = temperature coefficient ${tempcoPpm} ppm/K`,
    );
  }

  const result: ResistorResult = {
    Resistance: formatEng(value, "ohm"),
    Tolerance: `${tolerancePercent}%`,
    Range: `${formatEng(min, "ohm")} to ${formatEng(max, "ohm")}`,
    Bands: bandParts.join(", "),
  };
  if (tempcoPpm !== undefined) result["Temperature coefficient"] = `${tempcoPpm} ppm/K`;
  Object.assign(result, eSeriesRows(value));
  return result;
}

// ---------------------------------------------------------------------------
// Encode: value -> colors
// ---------------------------------------------------------------------------

const MULT_LETTER: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, m: 1e-3, R: 1 };

/** Parse "4.7k", "220", "1M", "0.5 ohm", "4k7", "220R" etc into a value in ohms. */
function parseValue(raw: string): number {
  const s = raw
    .trim()
    .replace(/ohms?$/i, "")
    .replace(/[Ωω]/g, "")
    .trim();

  const embedded = s.match(/^([+-]?\d+)([kKMGmR])(\d+)$/);
  if (embedded) {
    const num = Number(`${embedded[1]}.${embedded[3]}`);
    if (Number.isFinite(num)) return num * MULT_LETTER[embedded[2]];
  }

  const plain = s.match(/^([+-]?\d*\.?\d+)\s*([kKMGmR])?$/);
  if (plain) {
    const num = Number(plain[1]);
    const mult = plain[2] ? MULT_LETTER[plain[2]] : 1;
    if (Number.isFinite(num)) return num * mult;
  }

  throw new ToolError(
    "bad-value",
    `Could not parse "${raw}" as a resistance value.`,
    'Use a plain number with an optional unit, like "4.7k", "220", "1M", "0.5 ohm", or shorthand like "4k7".',
  );
}

/** Split a value into an N-significant-digit mantissa and a multiplier exponent, clamped to a real band color. */
function decomposeValue(
  value: number,
  sigDigits: number,
): { digits: number[]; multiplierExp: number; exactValue: number } {
  if (value === 0) return { digits: new Array(sigDigits).fill(0), multiplierExp: 0, exactValue: 0 };

  let exp = Math.floor(Math.log10(value)) - (sigDigits - 1);
  let mantissa = Math.round(value / 10 ** exp);
  if (mantissa >= 10 ** sigDigits) {
    mantissa = Math.round(mantissa / 10);
    exp += 1;
  }

  const minExp = -2;
  const maxExp = 9;
  if (exp < minExp) {
    mantissa = Math.round(mantissa * 10 ** (exp - minExp));
    exp = minExp;
  } else if (exp > maxExp) {
    mantissa = Math.round(mantissa / 10 ** (exp - maxExp));
    exp = maxExp;
  }

  const digits: number[] = new Array(sigDigits).fill(0);
  let m = mantissa;
  for (let i = sigDigits - 1; i >= 0; i--) {
    digits[i] = m % 10;
    m = Math.floor(m / 10);
  }

  return { digits, multiplierExp: exp, exactValue: mantissa * 10 ** exp };
}

/** Everything the encoder derives before any of it is formatted into a result. */
interface EncodedBands {
  /** Band colors in reading order, canonical keys. */
  colors: string[];
  /** The band count actually used. */
  bands: 4 | 5 | 6;
  /** The value the caller asked for, in ohms. */
  value: number;
  /** The value those bands really carry, in ohms. */
  exactValue: number;
  /** Tolerance percent in its option-string form, for example "5". */
  toleranceStr: string;
  /** ppm/K in its option-string form, or "" when the code has no tempco band. */
  tempcoStr: string;
}

/**
 * The whole encode pipeline except the result formatting: parse the value,
 * validate every option, and pick the colors. `encode` renders these into the
 * result record and `encodeToBands` hands the colors straight to a drawing, so
 * both paths see identical validation and identical ToolErrors.
 */
function encodeColors(raw: string, opts: ResistorOpts): EncodedBands {
  const value = parseValue(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ToolError(
      "bad-value",
      `"${raw}" is not a valid resistance value.`,
      'Use a plain number with an optional unit, like "4.7k", "220", or "4k7".',
    );
  }

  const bandsStr = String(opts.bands ?? "4");
  if (bandsStr !== "4" && bandsStr !== "5" && bandsStr !== "6") {
    throw new ToolError(
      "bad-option",
      `Unsupported band count "${opts.bands}".`,
      "Choose 4, 5, or 6 bands.",
    );
  }
  const bands = Number(bandsStr) as 4 | 5 | 6;

  const toleranceStr = String(opts.tolerance ?? "5");
  const toleranceColor = TOLERANCE_TO_COLOR[toleranceStr];
  if (!toleranceColor) {
    throw new ToolError(
      "bad-option",
      `Unrecognized tolerance "${opts.tolerance}".`,
      "Choose one of 5, 1, 2, 0.5, 0.25, 0.1, 10, or 20 percent.",
    );
  }
  if (toleranceStr === "20") {
    throw new ToolError(
      "bad-option",
      "20% tolerance has no band color of its own; it is only implied by a resistor with no tolerance band at all (a 3-band code), which this encoder does not produce.",
      "Choose 5% or tighter for an encoded band, or read a 3-band code by hand as 20% tolerance.",
    );
  }

  let tempcoColor: string | undefined;
  let tempcoStr = "";
  if (bands === 6) {
    tempcoStr = String(opts.tempco ?? "100");
    tempcoColor = TEMPCO_TO_COLOR[tempcoStr];
    if (!tempcoColor) {
      throw new ToolError(
        "bad-option",
        `Unrecognized temperature coefficient "${opts.tempco}".`,
        "Choose one of 100, 50, 15, 25, 10, or 5 ppm/K.",
      );
    }
  }

  const sigDigits = bands === 4 ? 2 : 3;
  const { digits, multiplierExp, exactValue } = decomposeValue(value, sigDigits);

  const colorSequence = [
    ...digits.map((d) => DIGIT_COLOR[d]),
    MULTIPLIER_COLOR[multiplierExp],
    toleranceColor,
  ];
  if (tempcoColor) colorSequence.push(tempcoColor);

  return { colors: colorSequence, bands, value, exactValue, toleranceStr, tempcoStr };
}

function encode(raw: string, opts: ResistorOpts): ResistorResult {
  const {
    colors: colorSequence,
    bands,
    value,
    exactValue,
    toleranceStr,
    tempcoStr,
  } = encodeColors(raw, opts);

  const result: ResistorResult = {
    Bands: colorSequence.join(", "),
    Sketch: `[${colorSequence.join("|")}]`,
    "Value encoded": formatEng(exactValue, "ohm"),
    Tolerance: `${toleranceStr}%`,
  };
  if (tempcoStr) result["Temperature coefficient"] = `${tempcoStr} ppm/K`;

  const relErr = value === 0 ? (exactValue === 0 ? 0 : 1) : Math.abs(exactValue - value) / value;
  if (relErr > 1e-9) {
    result.Note = `${formatEng(value, "ohm")} is not exactly representable with ${bands} bands; the nearest representable value is ${formatEng(exactValue, "ohm")}.`;
  }

  Object.assign(result, eSeriesRows(exactValue));
  return result;
}

// ---------------------------------------------------------------------------

export function run(input: string, opts: ResistorOpts): ResistorResult {
  const raw = (input ?? "").trim();
  const mode = (opts.mode || "decode").toLowerCase();
  if (mode !== "decode" && mode !== "encode") {
    throw new ToolError(
      "bad-option",
      `Unrecognized mode "${opts.mode}".`,
      'Use "decode" or "encode".',
    );
  }
  if (!raw) {
    throw new ToolError(
      "empty-input",
      mode === "decode"
        ? 'Enter 3 to 6 resistor band colors, like "brown black red gold".'
        : 'Enter a resistance value, like "4.7k" or "220".',
      mode === "decode"
        ? 'Try "yellow violet red gold" for a 4.7k ohm 5% resistor.'
        : 'Try "4.7k", "220", or shorthand like "4k7".',
    );
  }

  return mode === "decode" ? decode(raw) : encode(raw, opts);
}

export default { run } satisfies ToolLogic<string, ResistorResult, ResistorOpts>;

// ---------------------------------------------------------------------------
// Drawing surface: hex table, per-position legality, band arithmetic
//
// Everything below is additive surface for the bespoke panel, which draws a
// resistor instead of asking the reader to type color names. None of it changes
// what run, decode, or encode do. It is deliberately backed by the same tables
// those functions validate against, so a swatch picker can never offer a color
// that the decoder would then reject.
// ---------------------------------------------------------------------------

/**
 * The painted color of every band. These are printed ink colors on a tan body,
 * not web colors: muted and slightly warm, so a row of them reads as a real
 * part rather than a palette. Gold and silver carry a flat base color here and
 * the drawing overlays a metallic gradient on top; the flat value is the
 * fallback anywhere a gradient is not available.
 *
 * Keyed by the canonical color names in COLOR_INFO. A band always has a color,
 * so there is no "none" entry: use `bandHex`, which answers "transparent" for
 * anything it does not know.
 */
export const BAND_HEX: Record<string, string> = {
  black: "#1a1a1a",
  brown: "#6b3f22",
  red: "#d33a2c",
  orange: "#e07a2f",
  yellow: "#e8c22e",
  green: "#3d8b40",
  blue: "#2f5db3",
  violet: "#7d4ac0",
  grey: "#8a8a8a",
  white: "#f4f2ee",
  gold: "#c9a227",
  silver: "#b8b8b6",
};

/**
 * US English display labels. The canonical key stays "grey" because the decoder
 * and its tests are written against it, but nothing a reader sees says that:
 * every visible name comes from here, so the band is labeled "Gray".
 */
const COLOR_LABEL: Record<string, string> = {
  black: "Black",
  brown: "Brown",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  violet: "Violet",
  grey: "Gray",
  white: "White",
  gold: "Gold",
  silver: "Silver",
};

/** Canonical key for a color name or alias, or undefined. Never throws. */
function canonicalColor(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  return COLOR_ALIASES[token.trim().toLowerCase()];
}

/** The display name for a color name or alias, for example "gray" to "Gray". */
export function bandLabel(color: string): string {
  const canon = canonicalColor(color);
  return canon ? COLOR_LABEL[canon] : color;
}

/** The painted color, or "transparent" for an unknown or missing band. */
export function bandHex(color: string): string {
  const canon = canonicalColor(color);
  return (canon && BAND_HEX[canon]) || "transparent";
}

/** What one band position means in a code of a given length. */
export type BandRole = "digit" | "multiplier" | "tolerance" | "tempco";

/**
 * The job of the band at `position` (0-based) in a `bands`-band code, or null
 * when that position does not exist. The arithmetic mirrors `decode` exactly:
 * two significant digits up to 4 bands and three from 5, the multiplier
 * immediately after them, tolerance next when there is a 4th band at all, and
 * the temperature coefficient only on a 6-band code.
 */
export function bandRole(bands: number, position: number): BandRole | null {
  if (!Number.isInteger(bands) || bands < 3 || bands > 6) return null;
  if (!Number.isInteger(position) || position < 0 || position >= bands) return null;
  const digitCount = bands <= 4 ? 2 : 3;
  if (position < digitCount) return "digit";
  if (position === digitCount) return "multiplier";
  if (position === digitCount + 1) return "tolerance";
  return "tempco";
}

/** One color a band may legally take, with everything a swatch needs to render it. */
export interface BandOption {
  /** Canonical color key, the value `run` accepts. */
  color: string;
  /** US English display name, for example "Gray". */
  label: string;
  /** Painted color for the swatch. */
  hex: string;
  /** What this color means in this position: "digit 4", "x100", "±5%", "50 ppm/K". */
  meaning: string;
}

/** Compact multiplier label: x1, x10, x1k, x1M, x1G, x0.1, x0.01. */
function multiplierShort(exp: number): string {
  if (exp < 0) return `x${(10 ** exp).toFixed(-exp)}`;
  if (exp < 3) return `x${10 ** exp}`;
  if (exp < 6) return `x${10 ** (exp - 3)}k`;
  if (exp < 9) return `x${10 ** (exp - 6)}M`;
  return `x${10 ** (exp - 9)}G`;
}

/** What one color contributes in one role. */
function bandMeaning(color: string, role: BandRole): string {
  const info = COLOR_INFO[color];
  if (role === "digit") return `digit ${info.digit}`;
  if (role === "multiplier") return multiplierShort(info.multiplierExp);
  if (role === "tolerance") return `±${info.tolerance}%`;
  return `${info.tempco} ppm/K`;
}

/**
 * Every color the band at `position` may legally take in a `bands`-band code,
 * in canonical order, each with its display name, hex, and meaning.
 *
 * Derived from COLOR_INFO, the same table `decode` validates against: digit
 * bands are the ten colors that carry a digit (gold and silver do not), the
 * multiplier accepts all twelve, and tolerance and temperature coefficient are
 * whichever colors define one. An unknown position returns an empty list.
 */
export function legalColorsForPosition(bands: number, position: number): BandOption[] {
  const role = bandRole(bands, position);
  if (!role) return [];
  return CANONICAL_COLORS.filter((color) => {
    const info = COLOR_INFO[color];
    if (role === "digit") return info.digit !== undefined;
    if (role === "multiplier") return true;
    if (role === "tolerance") return info.tolerance !== undefined;
    return info.tempco !== undefined;
  }).map((color) => ({
    color,
    label: COLOR_LABEL[color],
    hex: BAND_HEX[color],
    meaning: bandMeaning(color, role),
  }));
}

/**
 * The same resistor, re-banded to a different band count, preserving the value
 * as far as the new count allows.
 *
 * Growing from two significant digits to three appends a zero digit and drops
 * the multiplier one decade, so 10 x 100 becomes 100 x 10 and the value does
 * not move. Shrinking does the reverse and loses the last digit, which is a
 * real loss of precision, not a bug. A multiplier that would fall outside the
 * printable gold-to-white range is clamped to it, which does move the value.
 *
 * Total by design: this drives a live control, so a color it does not recognize
 * becomes a sensible default rather than an exception.
 */
export function resizeBands(colors: string[], nextCount: number): string[] {
  const next = Math.min(6, Math.max(3, Math.trunc(Number(nextCount) || 4)));
  const current = colors.length >= 3 && colors.length <= 6 ? colors.length : 4;
  const currentDigits = current <= 4 ? 2 : 3;

  const digits: number[] = [];
  for (let i = 0; i < currentDigits; i++) {
    const canon = canonicalColor(colors[i]);
    const digit = canon === undefined ? undefined : COLOR_INFO[canon].digit;
    digits.push(digit ?? 0);
  }

  const multiplierCanon = canonicalColor(colors[currentDigits]);
  let exp = multiplierCanon ? COLOR_INFO[multiplierCanon].multiplierExp : 0;

  const toleranceCanon = canonicalColor(colors[currentDigits + 1]);
  const toleranceColor =
    toleranceCanon && COLOR_INFO[toleranceCanon].tolerance !== undefined ? toleranceCanon : "gold";

  const tempcoCanon = canonicalColor(colors[5]);
  const tempcoColor =
    tempcoCanon && COLOR_INFO[tempcoCanon].tempco !== undefined ? tempcoCanon : "brown";

  const nextDigits = next <= 4 ? 2 : 3;
  while (digits.length < nextDigits) {
    digits.push(0);
    exp -= 1;
  }
  while (digits.length > nextDigits) {
    digits.pop();
    exp += 1;
  }
  exp = Math.min(9, Math.max(-2, exp));

  const out = digits.map((d) => DIGIT_COLOR[d]);
  out.push(MULTIPLIER_COLOR[exp]);
  if (next >= 4) out.push(toleranceColor);
  if (next === 6) out.push(tempcoColor);
  return out;
}

/** The band colors a fresh `count`-band code starts on: 1 kohm at 5%. */
export function defaultBands(count: number): string[] {
  return resizeBands(["brown", "black", "red", "gold"], count);
}

/**
 * The typed path: "brown black red gold" to canonical color keys. Accepts the
 * same separators, aliases, and casing `decode` does, and throws the same
 * ToolErrors, so the two input routes can never disagree about what is valid.
 * Position legality is left to `run`, which reports it with the band named.
 */
export function parseBandList(raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      'Enter 3 to 6 resistor band colors, like "brown black red gold".',
      'Try "yellow violet red gold" for a 4.7k ohm 5% resistor.',
    );
  }
  const tokens = text.split(/[\s,-]+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 6) {
    throw new ToolError(
      "bad-band-count",
      `Resistor color codes use 3 to 6 bands; got ${tokens.length}.`,
      'Enter 3 to 6 color names, like "brown black red gold" for a 4-band code.',
    );
  }
  return tokens.map(normalizeColor);
}

/** One character per color, for the URL fragment: a digit, or g/s for gold/silver. */
const CODE_CHAR: Record<string, string> = Object.fromEntries(
  CANONICAL_COLORS.map((color) => {
    const digit = COLOR_INFO[color].digit;
    return [color, digit === undefined ? color[0] : String(digit)];
  }),
);
const CODE_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(CODE_CHAR).map(([color, char]) => [char, color]),
);

/** Band colors as a compact shareable code, for example "102g" for 1 kohm at 5%. */
export function bandsToCode(colors: string[]): string {
  return colors
    .map((color) => {
      const canon = canonicalColor(color);
      return canon ? CODE_CHAR[canon] : "";
    })
    .join("");
}

/**
 * The inverse, for reading a shared link. Total by design: a hand-edited or
 * stale code returns null instead of throwing, and a code whose colors are
 * illegal for their positions is rejected too, so a link can never load the
 * drawing into a state the decoder refuses.
 */
export function codeToBands(code: string): string[] | null {
  const chars = (code ?? "").trim().toLowerCase().split("");
  if (chars.length < 3 || chars.length > 6) return null;
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const color = CODE_COLOR[chars[i]];
    if (!color) return null;
    const legal = legalColorsForPosition(chars.length, i);
    if (!legal.some((option) => option.color === color)) return null;
    out.push(color);
  }
  return out;
}

/**
 * Encode mode's band colors on their own, for painting the drawing. Runs the
 * exact validation `run(value, { mode: "encode" })` runs and throws the same
 * ToolErrors, so a panel can call both and only has to handle one error path.
 */
export function encodeToBands(raw: string, opts: Omit<ResistorOpts, "mode">): string[] {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      'Enter a resistance value, like "4.7k" or "220".',
      'Try "4.7k", "220", or shorthand like "4k7".',
    );
  }
  return encodeColors(text, { mode: "encode", ...opts }).colors;
}

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  formatEng,
  decomposeValue,
  parseValue,
  nearestInSeries,
  COLOR_INFO,
  CANONICAL_COLORS,
};
