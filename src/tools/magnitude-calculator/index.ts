/**
 * Stellar magnitude calculator.
 *
 * Everything here follows from two definitions:
 *
 * - Pogson's ratio: a difference of 5 magnitudes is a brightness ratio of
 *   exactly 100, so flux ratio = 10^(0.4 * delta m). N. R. Pogson, MNRAS
 *   17, 12 (1856).
 * - The distance modulus: m - M = 5 log10(d / 10 pc), which is the same
 *   inverse square law written in magnitudes. Absolute magnitude is the
 *   apparent magnitude an object would have at exactly 10 parsecs.
 *
 * On top of those it does the everyday jobs: combining several stars into
 * one magnitude, the flux ratio between two magnitudes, parallax to
 * distance, surface brightness of an extended object, and a rough
 * limiting magnitude for a telescope aperture.
 *
 * Pure arithmetic and string parsing. No DOM, no network, no storage.
 */

import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Light years in one parsec (IAU 2015 definitions). */
export const PC_IN_LY = 3.2615637769;
/** Astronomical units in one parsec: 648000 / pi, by definition. */
export const PC_IN_AU = 206264.80624709636;
/** Kilometers in one astronomical unit (IAU 2012 definition, exact). */
export const AU_IN_KM = 149597870.7;
/** Kilometers in one parsec. */
export const PC_IN_KM = PC_IN_AU * AU_IN_KM;
/** Absolute magnitude of the Sun in the Johnson V band. */
export const SUN_ABSOLUTE_V = 4.83;
/** Apparent magnitude of the Sun in the Johnson V band. */
export const SUN_APPARENT_V = -26.74;
/** Square arcseconds in one square arcminute. */
const ARCSEC2_PER_ARCMIN2 = 3600;

/* ------------------------------------------------------------------ */
/* The core relations                                                   */
/* ------------------------------------------------------------------ */

/** Flux ratio for a magnitude difference: brighter over fainter. */
export function fluxRatio(brighter: number, fainter: number): number {
  return 10 ** (0.4 * (fainter - brighter));
}

/** Distance modulus m - M for a distance in parsecs. */
export function distanceModulus(parsecs: number): number {
  return 5 * Math.log10(parsecs) - 5;
}

/** Distance in parsecs for a distance modulus. */
export function modulusToParsecs(modulus: number): number {
  return 10 ** (modulus / 5 + 1);
}

/** Absolute magnitude from apparent magnitude, distance and extinction. */
export function absoluteMagnitude(apparent: number, parsecs: number, extinction = 0): number {
  return apparent - distanceModulus(parsecs) - extinction;
}

/** Apparent magnitude from absolute magnitude, distance and extinction. */
export function apparentMagnitude(absolute: number, parsecs: number, extinction = 0): number {
  return absolute + distanceModulus(parsecs) + extinction;
}

/**
 * The single magnitude of several sources seen together. Fluxes add, so
 * the combined magnitude is -2.5 log10 of the summed flux.
 */
export function combinedMagnitude(magnitudes: readonly number[]): number {
  const flux = magnitudes.reduce((total, m) => total + 10 ** (-0.4 * m), 0);
  return -2.5 * Math.log10(flux);
}

/**
 * Mean surface brightness in magnitudes per square arcsecond for an
 * object of total magnitude `magnitude` spread over `areaArcsec2`.
 * Spreading the same light over 100 times the area costs 5 magnitudes.
 */
export function surfaceBrightness(magnitude: number, areaArcsec2: number): number {
  return magnitude + 2.5 * Math.log10(areaArcsec2);
}

/**
 * A rough naked eye limiting magnitude for a telescope aperture in
 * millimeters, using the widely quoted 2.7 + 5 log10(D) rule. It is an
 * approximation with a large spread, not a specification: real limits
 * move by two magnitudes or more with sky brightness, magnification,
 * optical quality, altitude of the target, and the observer's eye.
 */
export function limitingMagnitude(apertureMm: number): number {
  return 2.7 + 5 * Math.log10(apertureMm);
}

/* ------------------------------------------------------------------ */
/* Unit parsing                                                         */
/* ------------------------------------------------------------------ */

/** Distance units, keyed by their lower cased spelling, valued in parsecs. */
const DISTANCE_UNITS: Record<string, number | undefined> = {
  pc: 1,
  parsec: 1,
  parsecs: 1,
  kpc: 1000,
  kiloparsec: 1000,
  kiloparsecs: 1000,
  mpc: 1e6,
  megaparsec: 1e6,
  megaparsecs: 1e6,
  gpc: 1e9,
  gigaparsec: 1e9,
  ly: 1 / PC_IN_LY,
  lightyear: 1 / PC_IN_LY,
  lightyears: 1 / PC_IN_LY,
  "light-year": 1 / PC_IN_LY,
  "light-years": 1 / PC_IN_LY,
  kly: 1000 / PC_IN_LY,
  au: 1 / PC_IN_AU,
  ua: 1 / PC_IN_AU,
  km: 1 / PC_IN_KM,
  m: 1 / (PC_IN_KM * 1000),
  mi: 1.609344 / PC_IN_KM,
  mile: 1.609344 / PC_IN_KM,
  miles: 1.609344 / PC_IN_KM,
};

/** Aperture units, keyed by spelling, valued in millimeters. */
const APERTURE_UNITS: Record<string, number | undefined> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
};

/** Angular units, keyed by spelling, valued in arcseconds. */
const ANGLE_UNITS: Record<string, number | undefined> = {
  arcsec: 1,
  arcsecs: 1,
  arcsecond: 1,
  arcseconds: 1,
  as: 1,
  arcmin: 60,
  arcmins: 60,
  arcminute: 60,
  arcminutes: 60,
  am: 60,
  deg: 3600,
  degree: 3600,
  degrees: 3600,
  mas: 0.001,
};

function badUnit(kind: string, raw: string, allowed: string): never {
  throw new ToolError(
    "bad-unit",
    `"${raw}" is not a ${kind} unit this calculator knows.`,
    `Use one of: ${allowed}.`,
  );
}

function readNumber(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ToolError(
      "bad-number",
      `Could not read "${raw}" as the value for ${field}.`,
      "Write it as a plain decimal number, like 2.64 or -1.46.",
    );
  }
  return value;
}

const VALUE_UNIT_RE = /^([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*(.*)$/;

/** Splits "2.64 pc" into its number and its unit text. */
function splitValueUnit(raw: string, field: string): { value: number; unit: string } {
  const m = VALUE_UNIT_RE.exec(raw.trim());
  if (!m) {
    throw new ToolError(
      "bad-number",
      `Could not read "${raw}" as the value for ${field}.`,
      "Write the number first and the unit after it, like: 2.64 pc",
    );
  }
  return { value: readNumber(m[1], field), unit: m[2].trim() };
}

/** A distance with any supported unit, converted to parsecs. */
export function parseDistanceParsecs(raw: string): number {
  const { value, unit } = splitValueUnit(raw, "distance");
  const key = unit.toLowerCase();
  // Case matters for the parsec prefixes: Mpc is a megaparsec.
  const factor =
    unit === "Mpc" ? 1e6 : unit === "kpc" ? 1000 : (DISTANCE_UNITS[key] ?? (key === "" ? 1 : undefined));
  if (factor === undefined) {
    badUnit("distance", unit, "pc, kpc, Mpc, ly, AU, km, m, mi");
  }
  if (!(value > 0)) {
    throw new ToolError(
      "bad-distance",
      `A distance of ${raw} is not something light can travel.`,
      "Enter a distance greater than zero, like: 2.64 pc",
    );
  }
  return value * factor;
}

/** An aperture with any supported unit, converted to millimeters. */
export function parseApertureMm(raw: string): number {
  const { value, unit } = splitValueUnit(raw, "aperture");
  const factor = APERTURE_UNITS[unit.toLowerCase()] ?? (unit === "" ? 1 : undefined);
  if (factor === undefined) badUnit("aperture", unit, "mm, cm, m, in");
  if (!(value > 0)) {
    throw new ToolError(
      "bad-aperture",
      `An aperture of ${raw} has no light gathering area.`,
      "Enter an aperture greater than zero, like: 200 mm",
    );
  }
  return value * factor;
}

/**
 * An angular size, one axis or two, converted to arcseconds. A unit on
 * the second axis carries over to the first, so "190x60 arcmin" and
 * "190 arcmin x 60 arcmin" mean the same thing.
 */
export function parseAngularSize(raw: string): { major: number; minor: number } {
  const text = raw.trim();
  const parts = text.split(/\s*(?:x|by|\*|×)\s*/i);
  if (parts.length > 2) {
    throw new ToolError(
      "bad-size",
      `Could not read "${raw}" as an angular size.`,
      'Give one axis like "30 arcsec" or two like "190x60 arcmin".',
    );
  }
  const last = splitValueUnit(parts[parts.length - 1], "angular size");
  const factor = ANGLE_UNITS[last.unit.toLowerCase()];
  if (factor === undefined) badUnit("angular", last.unit || "(none)", "arcsec, arcmin, deg, mas");
  const minor = last.value * factor;
  let major = minor;
  if (parts.length === 2) {
    const first = splitValueUnit(parts[0], "angular size");
    const firstFactor = first.unit === "" ? factor : ANGLE_UNITS[first.unit.toLowerCase()];
    if (firstFactor === undefined) {
      badUnit("angular", first.unit, "arcsec, arcmin, deg, mas");
    }
    major = first.value * firstFactor;
  }
  if (!(major > 0) || !(minor > 0)) {
    throw new ToolError(
      "bad-size",
      `An angular size of ${raw} covers no sky.`,
      'Enter a size greater than zero, like "30 arcsec" or "190x60 arcmin".',
    );
  }
  return { major: Math.max(major, minor), minor: Math.min(major, minor) };
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

/** The canonical fields this tool understands. */
type FieldName =
  | "apparent"
  | "absolute"
  | "distance"
  | "parallax"
  | "extinction"
  | "aperture"
  | "combine"
  | "compare"
  | "size";

const ALIASES: Record<string, FieldName> = {
  m: "apparent",
  mv: "apparent",
  mag: "apparent",
  magnitude: "apparent",
  apparent: "apparent",
  app: "apparent",
  "apparent magnitude": "apparent",
  absolute: "absolute",
  abs: "absolute",
  absmag: "absolute",
  "absolute magnitude": "absolute",
  d: "distance",
  dist: "distance",
  distance: "distance",
  r: "distance",
  p: "parallax",
  plx: "parallax",
  parallax: "parallax",
  a: "extinction",
  av: "extinction",
  ext: "extinction",
  extinction: "extinction",
  aperture: "aperture",
  telescope: "aperture",
  scope: "aperture",
  combine: "combine",
  combined: "combine",
  stars: "combine",
  sum: "combine",
  compare: "compare",
  ratio: "compare",
  "flux ratio": "compare",
  size: "size",
  angular: "size",
  "angular size": "size",
  extent: "size",
};

const KNOWN_KEYS = Array.from(new Set(Object.values(ALIASES))).join(", ");

/** Everything the reader supplied, already normalized. */
export interface MagnitudeInput {
  apparent?: number;
  absolute?: number;
  parsecs?: number;
  parallaxMas?: number;
  extinction?: number;
  apertureMm?: number;
  combine?: number[];
  compare?: number[];
  size?: { major: number; minor: number };
  /** How the distance was written, for the output rows. */
  distanceText?: string;
}

const LINE_RE = /^([A-Za-z][A-Za-z\s-]*?)\s*[:=]\s*(.+)$/;
const LOOSE_RE = /^([A-Za-z][A-Za-z-]*)\s+(.+)$/;

export function parseInput(input: string): MagnitudeInput {
  const lines = (input ?? "")
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter at least two of apparent magnitude, absolute magnitude and distance.",
      'For example:\napparent: -1.46\ndistance: 2.64 pc',
    );
  }

  const out: MagnitudeInput = {};
  for (const line of lines) {
    const m = LINE_RE.exec(line) ?? LOOSE_RE.exec(line);
    if (!m) {
      throw new ToolError(
        "bad-line",
        `Could not read "${line}" as a field.`,
        `Write one field per line as "name: value". Known names: ${KNOWN_KEYS}.`,
      );
    }
    const rawKey = m[1].trim();
    const value = m[2].trim();
    // "m" and "M" are the standard symbols and differ only by case, so the
    // exact spelling is checked before the case insensitive alias table.
    const field: FieldName | undefined =
      rawKey === "m" ? "apparent" : rawKey === "M" ? "absolute" : ALIASES[rawKey.toLowerCase()];
    if (!field) {
      throw new ToolError(
        "unknown-field",
        `"${rawKey}" is not a field this calculator knows.`,
        `Known names: ${KNOWN_KEYS}. Use lower case m for apparent magnitude and upper case M for absolute.`,
      );
    }

    switch (field) {
      case "apparent":
        out.apparent = readNumber(value, "apparent magnitude");
        break;
      case "absolute":
        out.absolute = readNumber(value, "absolute magnitude");
        break;
      case "distance":
        out.parsecs = parseDistanceParsecs(value);
        out.distanceText = value;
        break;
      case "parallax": {
        const { value: plx, unit } = splitValueUnit(value, "parallax");
        const arcsec = unit.toLowerCase() === "arcsec" || unit === '"' ? plx : plx / 1000;
        if (!(arcsec > 0)) {
          throw new ToolError(
            "bad-parallax",
            `A parallax of ${value} does not give a distance.`,
            "Enter a parallax greater than zero, in milliarcseconds, like: 379.21 mas",
          );
        }
        out.parallaxMas = arcsec * 1000;
        break;
      }
      case "extinction":
        out.extinction = readNumber(value, "extinction");
        break;
      case "aperture":
        out.apertureMm = parseApertureMm(value);
        break;
      case "combine":
        out.combine = parseMagnitudeList(value, "combine");
        break;
      case "compare": {
        const pair = parseMagnitudeList(value, "compare");
        if (pair.length !== 2) {
          throw new ToolError(
            "bad-compare",
            `Comparing needs exactly two magnitudes, not ${pair.length}.`,
            "Write both, like: compare: -1.46, 0.03",
          );
        }
        out.compare = pair;
        break;
      }
      case "size":
        out.size = parseAngularSize(value);
        break;
    }
  }
  return out;
}

function parseMagnitudeList(raw: string, field: string): number[] {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new ToolError(
      "bad-list",
      `The ${field} field needs at least one magnitude.`,
      "Write them separated by commas, like: 2.0, 3.0, 4.0",
    );
  }
  return parts.map((p) => readNumber(p, `${field} magnitude`));
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

function mag(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

/** A number with as many significant figures as it deserves. */
function sig(value: number, digits = 4): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(digits - 1);
  return Number(value.toPrecision(digits)).toString();
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface MagnitudeOpts {
  /** "auto", "pc", "ly", "au" or "km": which distance row leads. */
  distanceUnit?: string;
  /** Dark adapted eye pupil in millimeters, for the aperture gain row. */
  pupil?: number;
  [key: string]: unknown;
}

export type MagnitudeResult = Record<string, string>;

function distanceRow(parsecs: number, unit: string): string {
  const ly = parsecs * PC_IN_LY;
  const au = parsecs * PC_IN_AU;
  const km = parsecs * PC_IN_KM;
  const pcText = `${sig(parsecs, 6)} pc`;
  const lyText = `${sig(ly, 6)} ly`;
  const auText = `${sig(au, 6)} AU`;
  const kmText = `${sig(km, 6)} km`;
  if (unit === "pc") return `${pcText} (${lyText})`;
  if (unit === "ly") return `${lyText} (${pcText})`;
  if (unit === "au") return `${auText} (${pcText})`;
  if (unit === "km") return `${kmText} (${pcText})`;
  // Auto: lead with whichever unit keeps the number readable.
  if (parsecs < 1e-4) return `${auText} (${kmText})`;
  if (parsecs < 0.1) return `${lyText} (${auText})`;
  return `${pcText} (${lyText})`;
}

export function run(input: string, opts: MagnitudeOpts = {}): MagnitudeResult {
  const unit = String(opts.distanceUnit ?? "auto").toLowerCase();
  const pupilRaw = Number(opts.pupil);
  const pupil = Number.isFinite(pupilRaw) && pupilRaw > 0 ? pupilRaw : 7;

  const parsed = parseInput(input);
  const out: MagnitudeResult = {};

  const extinction = parsed.extinction ?? 0;

  let parsecs = parsed.parsecs;
  if (parsecs === undefined && parsed.parallaxMas !== undefined) {
    parsecs = 1000 / parsed.parallaxMas;
    out["Distance from parallax"] =
      `${sig(parsecs, 6)} pc, from a parallax of ${sig(parsed.parallaxMas, 6)} mas`;
  }

  let apparent = parsed.apparent;
  let absolute = parsed.absolute;
  let solvedFor: string | null = null;

  if (apparent !== undefined && parsecs !== undefined && absolute === undefined) {
    absolute = absoluteMagnitude(apparent, parsecs, extinction);
    solvedFor = "absolute magnitude, from the apparent magnitude and the distance";
  } else if (absolute !== undefined && parsecs !== undefined && apparent === undefined) {
    apparent = apparentMagnitude(absolute, parsecs, extinction);
    solvedFor = "apparent magnitude, from the absolute magnitude and the distance";
  } else if (apparent !== undefined && absolute !== undefined && parsecs === undefined) {
    parsecs = modulusToParsecs(apparent - absolute - extinction);
    solvedFor = "distance, from the two magnitudes";
  }

  const hasSideJob =
    parsed.combine !== undefined ||
    parsed.compare !== undefined ||
    parsed.apertureMm !== undefined ||
    parsed.size !== undefined;

  if (solvedFor === null && !hasSideJob && (apparent === undefined || absolute === undefined)) {
    throw new ToolError(
      "not-enough-input",
      "That is not enough to work with.",
      'Give any two of apparent magnitude, absolute magnitude and distance, for example:\napparent: -1.46\ndistance: 2.64 pc\nOr use one of the standalone jobs: combine, compare, aperture.',
    );
  }

  if (solvedFor) out.Solved = solvedFor;

  if (apparent !== undefined) out["Apparent magnitude (m)"] = mag(apparent);
  if (absolute !== undefined) out["Absolute magnitude (M)"] = mag(absolute);
  if (parsecs !== undefined) out.Distance = distanceRow(parsecs, unit);
  if (parsecs !== undefined) {
    out.Parallax = `${sig(1000 / parsecs, 6)} mas`;
  }
  if (apparent !== undefined && absolute !== undefined) {
    out["Distance modulus (m - M)"] = mag(apparent - absolute);
  }
  if (extinction !== 0) {
    out.Extinction =
      `${mag(extinction)} magnitudes of dimming assumed between here and there, so m - M above is the apparent distance modulus and the true one is ${mag((apparent ?? 0) - (absolute ?? 0) - extinction)}`;
  }
  if (absolute !== undefined) {
    const luminosity = 10 ** (0.4 * (SUN_ABSOLUTE_V - absolute));
    out["Luminosity (V band)"] =
      `${sig(luminosity, 4)} times the Sun, taking the Sun's absolute V magnitude as ${SUN_ABSOLUTE_V}`;
  }
  if (apparent !== undefined) {
    out["Brightness against the Sun"] =
      `${sig(fluxRatio(SUN_APPARENT_V, apparent), 4)} times fainter in our sky than the Sun at magnitude ${SUN_APPARENT_V}`;
  }

  if (parsed.compare) {
    const [first, second] = parsed.compare;
    const ratio = fluxRatio(Math.min(first, second), Math.max(first, second));
    out["Flux ratio"] =
      `${sig(ratio, 6)} to 1: magnitude ${mag(Math.min(first, second))} is that many times brighter than magnitude ${mag(Math.max(first, second))}`;
    out["Magnitude difference"] = mag(Math.abs(first - second));
  }

  if (parsed.combine) {
    const total = combinedMagnitude(parsed.combine);
    out["Combined magnitude"] =
      `${mag(total)} from ${parsed.combine.length} source${parsed.combine.length === 1 ? "" : "s"} seen together`;
    const brightest = Math.min(...parsed.combine);
    out["Gain over the brightest"] =
      `${mag(brightest - total)} magnitudes brighter than the brightest one alone`;
  }

  if (parsed.apertureMm !== undefined) {
    const limit = limitingMagnitude(parsed.apertureMm);
    out["Limiting magnitude"] =
      `${mag(limit)} for a ${sig(parsed.apertureMm, 4)} mm aperture, a rule of thumb only`;
    out["Light grasp"] =
      `${sig((parsed.apertureMm / pupil) ** 2, 4)} times the eye at a ${pupil} mm pupil, worth ${mag(5 * Math.log10(parsed.apertureMm / pupil))} magnitudes`;
    out["Limiting magnitude caveat"] =
      "The 2.7 plus 5 log10 of the aperture in millimeters rule spreads by two magnitudes or more in practice. Sky brightness, magnification, optics, the altitude of the target and your own eye all move it.";
  }

  if (parsed.size) {
    const magnitudeForArea =
      apparent ?? (parsed.combine ? combinedMagnitude(parsed.combine) : undefined);
    if (magnitudeForArea === undefined) {
      throw new ToolError(
        "not-enough-input",
        "Surface brightness needs a total magnitude as well as an angular size.",
        'Add an apparent magnitude line, for example:\napparent: 3.44\nsize: 190x60 arcmin',
      );
    }
    // An ellipse of the given axes, which is how catalogs quote galaxy sizes.
    const areaArcsec2 = (Math.PI / 4) * parsed.size.major * parsed.size.minor;
    const perArcsec = surfaceBrightness(magnitudeForArea, areaArcsec2);
    out["Surface brightness"] =
      `${mag(perArcsec)} magnitudes per square arcsecond, spreading magnitude ${mag(magnitudeForArea)} over an ellipse of ${sig(parsed.size.major / 60, 4)} by ${sig(parsed.size.minor / 60, 4)} arcminutes`;
    out["Surface brightness (per square arcminute)"] = mag(
      perArcsec - 2.5 * Math.log10(ARCSEC2_PER_ARCMIN2),
    );
  }

  return out;
}

export default { run } satisfies ToolLogic<string, MagnitudeResult, MagnitudeOpts>;
