import { ToolError, type ToolLogic } from "../types";

/**
 * Light Meter — the panel samples canvas pixels from a live camera preview
 * (~5 Hz), converts them to linear light with sRGBToLinear/linearLuma below,
 * smooths the readings with rollingAverage, and serializes the result into a
 * JSON report: { meanLuma, r, g, b, exposureTimeSec?, iso?, fNumber? }. This
 * file turns that report into a lux and color temperature estimate. No DOM,
 * no getUserMedia, no canvas access live here.
 *
 * Nothing here is a calibrated light meter. A phone or webcam sensor has no
 * fixed, known relationship between scene brightness and the pixel values it
 * reports: auto exposure, auto white balance, and per-device tone curves all
 * get in the way. When the browser exposes the camera's chosen exposure time,
 * ISO, and aperture (rare, MediaStreamTrack getSettings()/getCapabilities()
 * support varies a lot), those settings pin down a real incident-light
 * estimate the same way a handheld meter would. When it does not, this falls
 * back to a rough brightness-only mapping that a user calibrates by eye
 * against a known source. Every result says which situation it is in.
 */

// ---------------------------------------------------------------------------
// Color math helpers (also used directly by the panel on raw canvas pixels)
// ---------------------------------------------------------------------------

/** Converts one sRGB gamma-encoded channel (0..1) to linear light. */
export function sRGBToLinear(c: number): number {
  const clamped = Math.min(1, Math.max(0, c));
  return clamped <= 0.04045 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
}

/** Rec. 709 relative luminance from linear-light sRGB channels. */
export function linearLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Averages the last `n` samples of a running series, for the panel to smooth
 * a noisy per-frame reading. Uses however many samples are available when
 * fewer than n have been collected yet; returns 0 for an empty series.
 */
export function rollingAverage(values: number[], n: number): number {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const window = Math.max(1, Math.floor(n));
  const slice = values.slice(-window);
  const sum = slice.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  return sum / slice.length;
}

// ---------------------------------------------------------------------------
// Shared numeric helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveFinite(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

// ---------------------------------------------------------------------------
// Lux estimate
// ---------------------------------------------------------------------------

/** ISO 2720 incident-light calibration constant for a reflected-light meter. */
const REFLECTED_METER_CONSTANT = 250;
/** lux = (C / 100) * 2^EV100, so this is the constant folded together. */
const LUX_PER_EV_UNIT = REFLECTED_METER_CONSTANT / 100; // 2.5

/** 18 percent reflectance, the neutral gray a reflected-light meter targets. */
const GRAY_18 = 0.18;

/** Assumed lux of a "properly exposed", 18 percent gray, typical indoor scene. */
const ROUGH_REFERENCE_LUX = 300;
/** Steepness of the rough luma-to-lux curve; wider than 1 to span a huge range. */
const ROUGH_GAMMA = 2.5;

export interface LuxEstimateInput {
  /** Mean linearized luma of the frame, 0..1. */
  meanLuma: number;
  /** Shutter time in seconds, when the browser reports it. */
  exposureTimeSec?: number;
  /** ISO sensitivity, when the browser reports it. */
  iso?: number;
  /** Lens f-number, when the browser reports it. */
  fNumber?: number;
  /** User calibration multiplier for the rough (no-exposure-data) path. */
  calibration?: number;
}

export interface LuxEstimate {
  lux: number;
  /** Exposure value at ISO 100 (EV100), consistent with evFromLux(lux). */
  ev: number;
  confidence: "measured" | "rough";
  /** Low/high bound of the estimate, in lux. */
  range: [number, number];
}

/**
 * Estimates illuminance in lux from a camera frame. Uses the incident-light
 * relation EV100 = log2(N^2 / t) - log2(ISO / 100), lux = 2.5 * 2^EV100, when
 * the browser reports exposure time, ISO, and aperture, scaled by how far the
 * frame's mean luma sits from 18 percent gray (the level auto exposure
 * normally targets). Falls back to a rough brightness-only curve, tunable
 * with a calibration factor, when that metadata is unavailable.
 */
export function estimateLux(input: LuxEstimateInput): LuxEstimate {
  const safeLuma = Math.max(0.001, clamp01(input.meanLuma));
  const hasExposureData =
    isPositiveFinite(input.exposureTimeSec) &&
    isPositiveFinite(input.iso) &&
    isPositiveFinite(input.fNumber);

  if (hasExposureData) {
    const t = input.exposureTimeSec as number;
    const iso = input.iso as number;
    const N = input.fNumber as number;

    const ev = Math.log2((N * N) / t) - Math.log2(iso / 100);
    const nominalLux = LUX_PER_EV_UNIT * 2 ** ev;
    const scale = safeLuma / GRAY_18;
    const lux = nominalLux * scale;

    return {
      lux,
      ev,
      confidence: "measured",
      range: [lux * 0.7, lux * 1.3],
    };
  }

  const calibration = isPositiveFinite(input.calibration) ? (input.calibration as number) : 1;
  const lux = ROUGH_REFERENCE_LUX * (safeLuma / GRAY_18) ** ROUGH_GAMMA * calibration;

  return {
    lux,
    ev: evFromLux(lux),
    confidence: "rough",
    range: [lux * 0.5, lux * 1.5],
  };
}

/** Recommended EV100 for a given illuminance, the inverse of estimateLux's formula. */
export function evFromLux(lux: number): number {
  const safe = Math.max(1e-6, lux);
  return Math.log2(safe / LUX_PER_EV_UNIT);
}

interface LuxBand {
  lo: number;
  hi: number;
  label: string;
}

const LUX_BANDS: LuxBand[] = [
  { lo: 0.1, hi: 1, label: "moonlight" },
  { lo: 10, hi: 50, label: "a dim room" },
  { lo: 100, hi: 200, label: "typical living room lighting" },
  { lo: 300, hi: 500, label: "office lighting" },
  { lo: 1000, hi: 2000, label: "an overcast day" },
  { lo: 10000, hi: 25000, label: "full daylight" },
  { lo: 50000, hi: 100000, label: "direct sunlight" },
];

/** Plain-language light level for a lux value, from moonlight to direct sun. */
export function describeLux(lux: number): string {
  const value = Math.max(0, lux);
  const first = LUX_BANDS[0] as LuxBand;
  const last = LUX_BANDS[LUX_BANDS.length - 1] as LuxBand;

  if (value < first.lo) return `darker than ${first.label}`;
  if (value > last.hi) return `brighter than ${last.label}`;

  for (let i = 0; i < LUX_BANDS.length; i++) {
    const band = LUX_BANDS[i] as LuxBand;
    if (value >= band.lo && value <= band.hi) return band.label;
    const next = LUX_BANDS[i + 1];
    if (next && value > band.hi && value < next.lo) {
      return `between ${band.label} and ${next.label}`;
    }
  }
  return last.label;
}

// ---------------------------------------------------------------------------
// Color temperature estimate
// ---------------------------------------------------------------------------

export interface CctInput {
  /** Linear-light red, green, blue channels, 0..1. */
  r: number;
  g: number;
  b: number;
}

export interface CctEstimate {
  /** Correlated color temperature in Kelvin, clamped to 1000..25000. */
  cct: number;
  label: string;
  note: string;
}

const WB_CAVEAT =
  "Auto white balance actively corrects color casts before this estimate ever sees the frame, so this reflects what the camera decided the light looks like, not necessarily the true color temperature, unless white balance is locked.";

interface CctReference {
  k: number;
  label: string;
}

const CCT_REFERENCES: CctReference[] = [
  { k: 1900, label: "candle light" },
  { k: 2700, label: "incandescent" },
  { k: 3000, label: "halogen" },
  { k: 4000, label: "fluorescent" },
  { k: 5500, label: "daylight" },
  { k: 6500, label: "overcast" },
  { k: 7500, label: "shade" },
];

/** Nearest reference label, compared in mireds (1e6/K) since color perception is roughly linear there. */
function nearestCctLabel(k: number): string {
  const mired = 1e6 / k;
  let best: CctReference = CCT_REFERENCES[0] as CctReference;
  let bestDist = Infinity;
  for (const ref of CCT_REFERENCES) {
    const dist = Math.abs(mired - 1e6 / ref.k);
    if (dist < bestDist) {
      bestDist = dist;
      best = ref;
    }
  }
  return best.label;
}

/**
 * Estimates correlated color temperature from the frame's mean linear sRGB
 * via McCamy's approximation: convert to CIE XYZ (D65 sRGB primaries), then
 * to xy chromaticity, then n = (x - 0.3320) / (0.1858 - y) and
 * CCT = 449n^3 + 3525n^2 + 6823.3n + 5520.33, clamped to 1000..25000 K.
 */
export function estimateCct(input: CctInput): CctEstimate {
  const r = Math.max(0, input.r);
  const g = Math.max(0, input.g);
  const b = Math.max(0, input.b);

  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;

  const sum = X + Y + Z;
  if (sum <= 0) {
    return {
      cct: 6500,
      label: "overcast",
      note: `No color signal in the frame, so this defaults to an overcast daylight estimate. ${WB_CAVEAT}`,
    };
  }

  const x = X / sum;
  const y = Y / sum;
  const n = (x - 0.332) / (0.1858 - y);
  const raw = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
  const cct = Math.min(25000, Math.max(1000, raw));

  return { cct, label: nearestCctLabel(cct), note: WB_CAVEAT };
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export interface LightMeterOpts {
  /** Rough-path calibration multiplier, 0.1..10, default 1. */
  calibration?: number;
  /** "lux" | "footcandles" */
  units?: string;
  [key: string]: unknown;
}

export type LightMeterResult = Record<string, string>;

const EMPTY_STATUS =
  "Point the camera at a light source and press Start above to read a live lux and color temperature estimate. Frames are analyzed on this page and discarded: nothing is recorded or uploaded.";

interface Report {
  meanLuma: number;
  r?: number;
  g?: number;
  b?: number;
  exposureTimeSec?: number;
  iso?: number;
  fNumber?: number;
}

function parseReport(raw: string): Report {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      'This panel builds the frame report automatically from the camera preview above; paste valid JSON only if testing by hand, for example {"meanLuma":0.18,"r":0.18,"g":0.18,"b":0.18}.',
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not look like a camera frame report.",
      'Expected an object with at least meanLuma, a number between 0 and 1, such as {"meanLuma":0.18}.',
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!isFiniteNumber(obj.meanLuma)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not contain a numeric meanLuma field.",
      'Expected an object with at least meanLuma, a number between 0 and 1, such as {"meanLuma":0.18}.',
    );
  }

  const report: Report = { meanLuma: clamp01(obj.meanLuma) };
  if (isFiniteNumber(obj.r)) report.r = obj.r;
  if (isFiniteNumber(obj.g)) report.g = obj.g;
  if (isFiniteNumber(obj.b)) report.b = obj.b;
  if (isPositiveFinite(obj.exposureTimeSec)) report.exposureTimeSec = obj.exposureTimeSec;
  if (isPositiveFinite(obj.iso)) report.iso = obj.iso;
  if (isPositiveFinite(obj.fNumber)) report.fNumber = obj.fNumber;
  return report;
}

function normalizeUnits(raw: unknown): "lux" | "footcandles" {
  if (raw === undefined || raw === null || raw === "") return "lux";
  const v = String(raw).trim().toLowerCase();
  if (v === "lux") return "lux";
  if (v === "footcandles" || v === "footcandle" || v === "fc") return "footcandles";
  throw new ToolError(
    "bad-option",
    `Unknown units "${String(raw)}".`,
    'Use "lux" or "footcandles".',
  );
}

function normalizeCalibration(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 10) {
    throw new ToolError(
      "bad-option",
      `Calibration must be a number between 0.1 and 10, got "${String(raw)}".`,
      "Point the camera at a light source of known brightness and adjust the calibration option until the reading matches, typically somewhere between 0.1 and 10.",
    );
  }
  return n;
}

/** 1 foot-candle = 10.7639 lux. */
const LUX_PER_FOOTCANDLE = 10.7639;

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US");
  if (abs >= 10) return n.toFixed(1);
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(3);
  return n.toExponential(2);
}

function formatIlluminance(lux: number, units: "lux" | "footcandles"): string {
  if (units === "footcandles") {
    return `${formatNum(lux / LUX_PER_FOOTCANDLE)} fc`;
  }
  return `${formatNum(lux)} lux`;
}

function formatShutterSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown shutter time";
  if (seconds >= 1) return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

export function run(input: string, opts: LightMeterOpts = {}): LightMeterResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { Status: EMPTY_STATUS };
  }

  const units = normalizeUnits(opts.units);
  const calibration = normalizeCalibration(opts.calibration);
  const report = parseReport(raw);

  const luxResult = estimateLux({
    meanLuma: report.meanLuma,
    exposureTimeSec: report.exposureTimeSec,
    iso: report.iso,
    fNumber: report.fNumber,
    calibration,
  });

  const out: LightMeterResult = {};

  out["Illuminance estimate"] =
    `${formatIlluminance(luxResult.lux, units)} (${luxResult.confidence === "measured" ? "measured from exposure settings" : "rough estimate from brightness only"})`;
  out["Estimated range"] =
    `${formatIlluminance(luxResult.range[0], units)} to ${formatIlluminance(luxResult.range[1], units)}`;
  out["EV100"] = luxResult.ev.toFixed(2);
  out["Light level"] = describeLux(luxResult.lux);

  if (report.r !== undefined && report.g !== undefined && report.b !== undefined) {
    const cct = estimateCct({ r: report.r, g: report.g, b: report.b });
    out["Color temperature estimate"] = `${Math.round(cct.cct)} K (${cct.label})`;
    out["Color temperature note"] = cct.note;
  } else {
    out["Color temperature estimate"] =
      "Not available: the frame report did not include color channel data.";
  }

  const hasExposureData =
    report.exposureTimeSec !== undefined && report.iso !== undefined && report.fNumber !== undefined;
  out["Camera exposure settings used"] = hasExposureData
    ? `f/${report.fNumber} at ${formatShutterSeconds(report.exposureTimeSec as number)}, ISO ${report.iso}`
    : "Not exposed by this browser: most browsers do not report the camera's exposure time, ISO, or aperture through MediaStreamTrack, so this reading falls back to the rough brightness-only estimate.";

  out["Accuracy"] =
    luxResult.confidence === "measured"
      ? "This is an estimate built from the camera's reported exposure settings, not a calibrated light meter. Treat it as accurate to roughly plus or minus 30 percent."
      : `This is a rough estimate from frame brightness alone, using a calibration factor of ${calibration}x. Point the camera at a light source of known brightness (a lux meter app on another device, or a manufacturer spec sheet for a lamp) and adjust the calibration option until this reading matches, then keep that value for future readings in similar light.`;

  return out;
}

export default { run } satisfies ToolLogic<string, LightMeterResult, LightMeterOpts>;
