import { ToolError, type ToolLogic } from "../types";

/**
 * Screen Ruler logic.
 *
 * A web page cannot see outside its own browser tab, so this tool measures
 * two things honestly: (1) anything rendered inside this tab, via an on-page
 * ruler overlay the panel draws (a dropped/pasted screenshot, or the page
 * itself), and (2) distances inside a calibrated screenshot. Measuring
 * pixels on an arbitrary other site needs the Bookmarklet Shelf's pixel
 * ruler bookmarklet instead.
 *
 * `run()` accepts the JSON snapshot the panel builds from the overlay, or a
 * plain text pair of points for quick manual use. The colour helpers
 * (rgbaToHex, contrastRatio, nearestCssColorName) exist for the panel's
 * canvas-sampling colour picker and are not part of run()'s own input shape.
 */

/* -------------------------------------------------------------------- types */

export interface RulerPoint {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** px/mm/cm/in are the user-facing units; cssPx and devicePx separate the two pixel scales. */
export type LengthUnit = "px" | "mm" | "cm" | "in";

export interface PxToUnitsOpts {
  /** Device pixel ratio, used only to report devicePx alongside the CSS-pixel measurement. */
  dpr?: number;
  /** CSS pixels per inch. The CSS spec fixes this at 96 for the reference pixel. */
  cssPpi?: number;
  /** Pixels per millimetre from calibrate(). When set, this replaces cssPpi for real-world units. */
  calibrationPxPerMm?: number;
}

export interface UnitsResult {
  /** The input length, in CSS pixels. */
  px: number;
  /** Same value as px, named explicitly for the panel's readout. */
  cssPx: number;
  /** px scaled by the device pixel ratio: the physical pixels the display draws. */
  devicePx: number;
  mm: number;
  cm: number;
  inches: number;
  points: number;
}

export interface DisplayInput {
  width: number;
  height: number;
  dpr: number;
  availWidth?: number;
  availHeight?: number;
}

export interface RulerJsonInput {
  points?: unknown;
  dpr?: unknown;
  calibrationPxPerMm?: unknown;
  display?: unknown;
}

export interface ScreenRulerOpts {
  units: string;
  dpr: number;
  [key: string]: unknown;
}

export type ScreenRulerResult = Record<string, string>;

/* --------------------------------------------------------------- constants */

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const DEFAULT_CSS_PPI = 96;
const MIN_DPR = 0.5;
const MAX_DPR = 4;

const UNIT_SYNONYMS: Record<LengthUnit, string[]> = {
  px: ["px", "pixel", "pixels", "screen pixel", "screen pixels"],
  mm: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
  cm: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
  in: ["in", "inch", "inches"],
};

/* ------------------------------------------------------------------ length */

/** Rounds to `dp` decimal places (default 0). */
function round(n: number, dp = 0): number {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Converts a length in CSS pixels to every other unit the panel displays.
 *
 * Without calibration, real-world units assume the CSS reference pixel (96
 * CSS px per inch), which is accurate only when the browser's assumed DPI
 * matches the real display. With `calibrationPxPerMm` (from `calibrate()`),
 * real-world units use the screen's actual measured scale instead. `devicePx`
 * always reflects `px * dpr` regardless of calibration, since it reports the
 * physical pixel count, not a real-world length.
 */
export function pxToUnits(px: number, opts: PxToUnitsOpts = {}): UnitsResult {
  const dpr = isFiniteNumber(opts.dpr) && opts.dpr > 0 ? opts.dpr : 1;
  const cssPpi = isFiniteNumber(opts.cssPpi) && opts.cssPpi > 0 ? opts.cssPpi : DEFAULT_CSS_PPI;

  let mm: number;
  if (isFiniteNumber(opts.calibrationPxPerMm) && opts.calibrationPxPerMm > 0) {
    mm = px / opts.calibrationPxPerMm;
  } else {
    mm = (px / cssPpi) * MM_PER_INCH;
  }
  const inches = mm / MM_PER_INCH;

  return {
    px,
    cssPx: px,
    devicePx: px * dpr,
    mm,
    cm: mm / 10,
    inches,
    points: inches * POINTS_PER_INCH,
  };
}

/** Inverse of the real-world side of pxToUnits: a length in `unit` back to CSS pixels. */
export function unitsToPx(value: number, unit: LengthUnit, opts: PxToUnitsOpts = {}): number {
  if (unit === "px") return value;

  const cssPpi = isFiniteNumber(opts.cssPpi) && opts.cssPpi > 0 ? opts.cssPpi : DEFAULT_CSS_PPI;
  let mm: number;
  switch (unit) {
    case "mm":
      mm = value;
      break;
    case "cm":
      mm = value * 10;
      break;
    case "in":
      mm = value * MM_PER_INCH;
      break;
  }

  if (isFiniteNumber(opts.calibrationPxPerMm) && opts.calibrationPxPerMm > 0) {
    return mm * opts.calibrationPxPerMm;
  }
  return (mm / MM_PER_INCH) * cssPpi;
}

/** Straight-line distance between two points, in whatever unit the points are already in. */
export function distance(a: RulerPoint, b: RulerPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle from a to b in degrees, measured from the positive x axis. Screen
 * coordinates grow downward, so a positive angle points down-and-right.
 * Range is -180 to 180, matching Math.atan2.
 */
export function angle(a: RulerPoint, b: RulerPoint): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** The axis-aligned bounding rectangle of two corner points, in either order. */
export function rectFromPoints(a: RulerPoint, b: RulerPoint): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

const COMMON_ASPECT_RATIOS: { name: string; value: number }[] = [
  { name: "1:1", value: 1 },
  { name: "5:4", value: 5 / 4 },
  { name: "4:3", value: 4 / 3 },
  { name: "3:2", value: 3 / 2 },
  { name: "16:10", value: 16 / 10 },
  { name: "16:9", value: 16 / 9 },
  { name: "21:9", value: 21 / 9 },
  { name: "32:9", value: 32 / 9 },
  { name: "4:5", value: 4 / 5 },
  { name: "3:4", value: 3 / 4 },
  { name: "2:3", value: 2 / 3 },
  { name: "10:16", value: 10 / 16 },
  { name: "9:16", value: 9 / 16 },
  { name: "9:21", value: 9 / 21 },
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Reduces width:height to a common named ratio (16:9, 4:3, ...) within a
 * small tolerance, otherwise falls back to a reduced integer fraction.
 */
export function aspectRatio(width: number, height: number): string {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return "Unknown";
  }
  const ratio = width / height;
  const match = COMMON_ASPECT_RATIOS.find((r) => Math.abs(r.value - ratio) < 0.015);
  if (match) return match.name;

  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = gcd(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}

/**
 * Derives pixels-per-millimetre from a known real-world length (in mm) held
 * up to the screen and the pixel distance measured across it. A standard
 * credit card is 85.60 mm wide, a common calibration reference.
 */
export function calibrate(knownMm: number, measuredPx: number): number {
  if (!isFiniteNumber(knownMm) || knownMm <= 0 || !isFiniteNumber(measuredPx) || measuredPx <= 0) {
    throw new ToolError(
      "bad-option",
      "Calibration needs a positive known length and a positive measured pixel distance.",
      "Example: calibrate(85.6, 200) for an 85.60 mm credit card measured as 200 px on screen.",
    );
  }
  return measuredPx / knownMm;
}

/** Formats a measurement with the chosen unit first and the others alongside for context. */
export function formatMeasurement(m: UnitsResult, units: LengthUnit): string {
  const px = `${round(m.px)} px`;
  const mm = `${m.mm.toFixed(2)} mm`;
  const cm = `${m.cm.toFixed(2)} cm`;
  const inches = `${m.inches.toFixed(3)} in`;
  switch (units) {
    case "mm":
      return `${mm} (${px}, ${cm}, ${inches})`;
    case "cm":
      return `${cm} (${px}, ${mm}, ${inches})`;
    case "in":
      return `${inches} (${px}, ${mm}, ${cm})`;
    case "px":
    default:
      return `${px} (${mm}, ${cm}, ${inches})`;
  }
}

/** Physical-ish pixel counts for a display, plus the CSS px vs device px explanation. */
export function describeDisplay(display: DisplayInput): Record<string, string> {
  const dpr = isFiniteNumber(display.dpr) && display.dpr > 0 ? display.dpr : 1;
  const out: Record<string, string> = {};
  out["CSS resolution"] =
    `${round(display.width)} x ${round(display.height)} px (CSS pixels, what this ruler measures)`;
  out["Device pixel resolution"] =
    `${round(display.width * dpr)} x ${round(display.height * dpr)} px (physical pixels the display draws)`;
  out["Device pixel ratio"] = `${dpr}x`;
  if (isFiniteNumber(display.availWidth) && isFiniteNumber(display.availHeight)) {
    out["Available screen area"] = `${round(display.availWidth)} x ${round(display.availHeight)} px`;
  }
  return out;
}

/* ------------------------------------------------------------------- color */

function badHex(hex: string): ToolError {
  return new ToolError(
    "bad-option",
    `"${hex}" is not a valid hex colour.`,
    "Use a 3 or 6 digit hex colour, such as #fff or #38bdf8.",
  );
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3}$/.test(h) && !/^[0-9a-fA-F]{6}$/.test(h)) throw badHex(hex);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Converts 0..255 RGB channels plus an optional 0..1 alpha to a lowercase hex colour. */
export function rgbaToHex(r: number, g: number, b: number, a = 1): string {
  const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const hex2 = (v: number): string => clampByte(v).toString(16).padStart(2, "0");
  const clampedAlpha = Math.max(0, Math.min(1, a));
  const alphaHex = clampedAlpha < 1 ? hex2(clampedAlpha * 255) : "";
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alphaHex}`;
}

function srgbChannelToLinear(byte: number): number {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(rgb.r) +
    0.7152 * srgbChannelToLinear(rgb.g) +
    0.0722 * srgbChannelToLinear(rgb.b)
  );
}

/** WCAG 2.x contrast ratio between two hex colours, from 1:1 to 21:1. Argument order does not matter. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The 16 basic CSS/HTML named colours, enough for a quick eyedropper label. */
const BASIC_NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  lime: "#00ff00",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  silver: "#c0c0c0",
  gray: "#808080",
  maroon: "#800000",
  olive: "#808000",
  purple: "#800080",
  teal: "#008080",
  navy: "#000080",
  orange: "#ffa500",
};

/** Nearest of the 16 basic CSS colour names to a hex colour, by plain RGB distance. */
export function nearestCssColorName(hex: string): string {
  const target = hexToRgb(hex);
  let best = "black";
  let bestDistance = Infinity;
  for (const [name, value] of Object.entries(BASIC_NAMED_COLORS)) {
    const c = hexToRgb(value);
    const d = (c.r - target.r) ** 2 + (c.g - target.g) ** 2 + (c.b - target.b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- run() I/O */

function normalizeUnits(raw: unknown): LengthUnit {
  const value = String(raw ?? "px")
    .trim()
    .toLowerCase();
  for (const unit of Object.keys(UNIT_SYNONYMS) as LengthUnit[]) {
    if (UNIT_SYNONYMS[unit].includes(value)) return unit;
  }
  throw new ToolError(
    "bad-option",
    `Unknown units "${String(raw)}".`,
    "Use one of: px, mm, cm, in.",
  );
}

function validateDpr(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < MIN_DPR || value > MAX_DPR) {
    throw new ToolError(
      "bad-option",
      `Device pixel ratio must be between ${MIN_DPR} and ${MAX_DPR}.`,
      "Typical values: 1 for standard displays, 2 for Retina/HiDPI.",
    );
  }
  return value;
}

function isNumberPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]);
}

function badPoints(fix: string): ToolError {
  return new ToolError("bad-points", "Could not read two points from the input.", fix);
}

function parsePointToken(token: string): RulerPoint {
  const parts = token.split(",");
  if (parts.length !== 2) {
    throw badPoints('Each point needs an x and a y separated by a comma, like "0,0 100,50".');
  }
  const x = Number(parts[0]!.trim());
  const y = Number(parts[1]!.trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw badPoints('Each coordinate must be a number, like "0,0 100,50".');
  }
  return { x, y };
}

function emptyExplanation(): ScreenRulerResult {
  return {
    "What this measures": "Drag the on-page ruler overlay to measure anything rendered inside this browser tab: the page itself, or a screenshot you drop or paste here. Distances read out in pixels by default.",
    "Calibrate for real units": "Hold a credit card or a ruler up to the screen: a standard card is 85.60 mm wide. Drag the calibration line to match its edges and every measurement afterward converts to real millimeters, centimeters, and inches using that scale.",
    "Other pages and windows": "A web page cannot see or measure anything outside its own browser tab. To measure something on another site, use the pixel ruler bookmarklet from the Bookmarklet Shelf, or take a screenshot of it and drop that screenshot here instead.",
    "Manual input": 'Paste two points as "x1,y1 x2,y2" or JSON like {"points":[[0,0],[100,50]]} to compute a distance without the overlay.',
  };
}

/**
 * Reports distance, angle, bounding box, and aspect ratio between two points.
 *
 * Input is either the JSON snapshot the ruler panel builds,
 * {"points":[[x1,y1],[x2,y2]],"dpr":1,"calibrationPxPerMm":2.34,"display":{...}},
 * or plain text "x1,y1 x2,y2" for quick manual use (the dpr option applies
 * only to the text form, since the JSON form supplies its own).
 */
export function run(input: string | undefined, opts: ScreenRulerOpts): ScreenRulerResult {
  const raw = (input ?? "").trim();
  const units = normalizeUnits(opts?.units);

  if (!raw) return emptyExplanation();

  let pointA: RulerPoint;
  let pointB: RulerPoint;
  let dpr: number;
  let calibrationPxPerMm: number | undefined;
  let display: DisplayInput | undefined;

  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ToolError(
        "bad-json",
        "The input is not valid JSON.",
        'Expected {"points":[[x1,y1],[x2,y2]]}, or plain text like "0,0 100,50".',
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ToolError(
        "bad-json",
        "The JSON is not a measurement object.",
        'Expected an object like {"points":[[x1,y1],[x2,y2]]}.',
      );
    }

    const obj = parsed as RulerJsonInput;
    const pts = obj.points;
    if (!Array.isArray(pts) || pts.length !== 2 || !pts.every(isNumberPair)) {
      throw badPoints('The "points" field needs exactly two [x, y] pairs, such as {"points":[[0,0],[100,50]]}.');
    }
    const [a, b] = pts as [[number, number], [number, number]];
    pointA = { x: a[0], y: a[1] };
    pointB = { x: b[0], y: b[1] };

    dpr = validateDpr(obj.dpr ?? opts.dpr);

    if (obj.calibrationPxPerMm !== undefined) {
      const cal = obj.calibrationPxPerMm;
      if (!isFiniteNumber(cal) || cal <= 0) {
        throw new ToolError(
          "bad-option",
          "calibrationPxPerMm must be a positive number.",
          "Run calibrate(knownMm, measuredPx) and pass the result, or omit the field to use the 96 CSS pixel per inch default.",
        );
      }
      calibrationPxPerMm = cal;
    }

    if (obj.display !== undefined) {
      const d = obj.display as Record<string, unknown>;
      if (
        typeof d !== "object" ||
        d === null ||
        !isFiniteNumber(d.width) ||
        !isFiniteNumber(d.height) ||
        !isFiniteNumber(d.dpr)
      ) {
        throw new ToolError(
          "bad-json",
          'The "display" field needs numeric width, height, and dpr.',
          'Example: "display":{"width":1920,"height":1080,"dpr":1}.',
        );
      }
      display = {
        width: d.width,
        height: d.height,
        dpr: d.dpr,
        availWidth: isFiniteNumber(d.availWidth) ? d.availWidth : undefined,
        availHeight: isFiniteNumber(d.availHeight) ? d.availHeight : undefined,
      };
    }
  } else {
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) {
      throw badPoints('Enter exactly two points as "x1,y1 x2,y2", such as "0,0 100,50".');
    }
    pointA = parsePointToken(tokens[0]!);
    pointB = parsePointToken(tokens[1]!);
    dpr = validateDpr(opts.dpr);
  }

  const distPx = distance(pointA, pointB);
  const angleDeg = angle(pointA, pointB);
  const rect = rectFromPoints(pointA, pointB);
  const pxOpts: PxToUnitsOpts = { dpr, cssPpi: DEFAULT_CSS_PPI, calibrationPxPerMm };
  const distanceMeasurement = pxToUnits(distPx, pxOpts);
  const widthMeasurement = pxToUnits(rect.width, pxOpts);
  const heightMeasurement = pxToUnits(rect.height, pxOpts);

  const out: ScreenRulerResult = {};
  out["Point A"] = `(${round(pointA.x, 2)}, ${round(pointA.y, 2)}) px`;
  out["Point B"] = `(${round(pointB.x, 2)}, ${round(pointB.y, 2)}) px`;
  out["Distance"] = formatMeasurement(distanceMeasurement, units);
  out["Angle"] = `${round(angleDeg, 2)} deg`;
  out["Width"] = formatMeasurement(widthMeasurement, units);
  out["Height"] = formatMeasurement(heightMeasurement, units);
  out["Aspect ratio"] =
    rect.width > 0 && rect.height > 0 ? aspectRatio(rect.width, rect.height) : "Not available, zero width or height";
  out["Device pixel ratio"] = `${dpr}x`;
  out["Calibration"] = calibrationPxPerMm
    ? `${round(calibrationPxPerMm, 4)} px per mm, calibrated`
    : "Not calibrated, real-world units assume 96 CSS pixels per inch";

  if (display) Object.assign(out, describeDisplay(display));

  return out;
}

export default { run } satisfies ToolLogic<string | undefined, ScreenRulerResult, ScreenRulerOpts>;
