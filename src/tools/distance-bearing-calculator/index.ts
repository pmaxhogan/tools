import { ToolError, type ToolLogic } from "../types";
import {
  WMM_EPOCH,
  WMM_G,
  WMM_G_DOT,
  WMM_H,
  WMM_H_DOT,
  WMM_MAX_DEGREE,
  WMM_MODEL,
  WMM_REFERENCE_RADIUS_KM,
  WMM_VALID_FROM,
  WMM_VALID_TO,
} from "./wmm";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** IUGG mean earth radius, the sphere the haversine numbers are quoted on. */
export const SPHERE_RADIUS_KM = 6371.0088;

/** WGS84 ellipsoid, in meters. */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

const KM_PER_MILE = 1.609344;
const KM_PER_NAUTICAL_MILE = 1.852;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;
const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

function wrapLon(lon: number): number {
  return (((lon % 360) + 540) % 360) - 180;
}

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

export type UnitId = "km" | "mi" | "nmi" | "m";

interface UnitDef {
  id: UnitId;
  /** Suffix printed after a value. */
  label: string;
  /** How many of this unit make up one kilometer. */
  perKm: number;
}

const UNITS: Record<UnitId, UnitDef> = {
  km: { id: "km", label: "km", perKm: 1 },
  mi: { id: "mi", label: "mi", perKm: 1 / KM_PER_MILE },
  nmi: { id: "nmi", label: "nmi", perKm: 1 / KM_PER_NAUTICAL_MILE },
  m: { id: "m", label: "m", perKm: 1000 },
};

const UNIT_SYNONYMS: Record<string, UnitId> = {
  km: "km",
  kms: "km",
  kilometer: "km",
  kilometers: "km",
  kilometre: "km", // spelling: allow (accepted input synonym)
  kilometres: "km", // spelling: allow (accepted input synonym)
  mi: "mi",
  mile: "mi",
  miles: "mi",
  statute: "mi",
  "statute-miles": "mi",
  nmi: "nmi",
  nm: "nmi",
  nauticalmile: "nmi",
  nauticalmiles: "nmi",
  "nautical-mile": "nmi",
  "nautical-miles": "nmi",
  kn: "nmi",
  m: "m",
  meter: "m",
  meters: "m",
  metre: "m", // spelling: allow (accepted input synonym)
  metres: "m", // spelling: allow (accepted input synonym)
};

/** Resolve a unit name or abbreviation, or null when it is not a unit. */
export function resolveUnit(name: string | undefined | null): UnitId | null {
  if (name === undefined || name === null) return null;
  const key = String(name).trim().toLowerCase().replace(/\s+/g, "");
  return UNIT_SYNONYMS[key] ?? null;
}

function formatDistance(km: number, unit: UnitDef): string {
  const value = km * unit.perKm;
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : 5;
  return `${value.toFixed(decimals)} ${unit.label}`;
}

/* ------------------------------------------------------------------ *
 * Coordinate parsing
 *
 * A deliberately small reader: decimal degrees, degrees and decimal
 * minutes, and full degrees minutes seconds, with optional N, S, E and W
 * letters on either value. It is separate from the coordinate converter's
 * reader on purpose, because tool logic never imports another tool.
 * ------------------------------------------------------------------ */

export interface LatLon {
  lat: number;
  lon: number;
}

interface AngleGroup {
  nums: number[];
  marks: string[];
  hemi?: string;
}

const BAD_ANGLE_CHAR = /[^0-9+\-.,;/|°'"NSEWnsew\s]/;

function normalizeAngleText(raw: string): string {
  return raw
    .replace(/[º˚∘]/g, "°")
    .replace(/[′’ʹ´]/g, "'")
    .replace(/[″”“ʺ]/g, '"')
    .replace(/[−–—]/g, "-")
    .replace(/''/g, '"')
    .replace(/\b(?:latitude|longitude|lat|long|lng|lon)\b\s*[:=]?/gi, " ")
    .replace(/\bdegrees?\b/gi, "°")
    .replace(/\bdeg\b/gi, "°")
    .replace(/\bminutes?\b/gi, "'")
    .replace(/\bseconds?\b/gi, '"');
}

function tokenizeAngles(text: string, original: string): AngleGroup[] {
  const s = normalizeAngleText(text);
  const bad = BAD_ANGLE_CHAR.exec(s);
  if (bad) {
    const token = s.split(/[\s,;]+/).find((t) => BAD_ANGLE_CHAR.test(t)) ?? bad[0];
    throw new ToolError(
      "unparseable",
      `Could not read "${token.trim()}" as part of a coordinate in "${original.trim()}".`,
      "Write each point as decimal degrees like 40.7128, -74.0060 or as 40°42'46\"N 74°00'22\"W.",
    );
  }

  const re = /([+-]?\d+(?:\.\d+)?)|(°)|(')|(")|([NSEWnsew])|([,;/|])/g;
  const groups: AngleGroup[] = [];
  let cur: AngleGroup | null = null;
  let pendingHemi: string | undefined;

  const open = (): AngleGroup => {
    const g: AngleGroup = { nums: [], marks: [] };
    if (pendingHemi) {
      g.hemi = pendingHemi;
      pendingHemi = undefined;
    }
    groups.push(g);
    return g;
  };

  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      if (cur === null || cur.nums.length >= 3 || cur.marks.includes('"')) cur = open();
      cur.nums.push(Number(m[1]));
    } else if (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined) {
      const mark = m[2] !== undefined ? "°" : m[3] !== undefined ? "'" : '"';
      if (cur === null || cur.nums.length === 0) continue;
      if (cur.marks.includes(mark) && cur.nums.length > 1) {
        const moved = cur.nums.pop() as number;
        cur = open();
        cur.nums.push(moved);
      }
      cur.marks.push(mark);
    } else if (m[5] !== undefined) {
      const letter = m[5].toUpperCase();
      if (cur !== null && cur.nums.length > 0 && !cur.hemi) {
        cur.hemi = letter;
        cur = null;
      } else {
        cur = null;
        pendingHemi = letter;
      }
    } else {
      cur = null;
    }
  }
  return groups;
}

interface AngleValue {
  value: number;
  hemi?: string;
}

function groupValue(g: AngleGroup, original: string): AngleValue {
  const [d, mi, se] = g.nums;
  const hasMin = g.nums.length >= 2;
  const hasSec = g.nums.length >= 3;
  if (hasMin && (mi < 0 || mi >= 60)) {
    throw new ToolError(
      "unparseable",
      `Minutes value ${mi} in "${original.trim()}" is not between 0 and 60.`,
      "Minutes and seconds each run from 0 up to but not including 60.",
    );
  }
  if (hasSec && (se < 0 || se >= 60)) {
    throw new ToolError(
      "unparseable",
      `Seconds value ${se} in "${original.trim()}" is not between 0 and 60.`,
      "Minutes and seconds each run from 0 up to but not including 60.",
    );
  }
  const sign = d < 0 || Object.is(d, -0) ? -1 : 1;
  const value = sign * (Math.abs(d) + (hasMin ? mi / 60 : 0) + (hasSec ? se / 3600 : 0));
  return { value, hemi: g.hemi };
}

function assertRange(lat: number, lon: number, original: string): void {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new ToolError(
      "out-of-range",
      `Latitude ${lat} in "${original.trim()}" is outside the range -90 to 90.`,
      "Latitude comes first unless an N, S, E or W letter says otherwise.",
    );
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new ToolError(
      "out-of-range",
      `Longitude ${lon} in "${original.trim()}" is outside the range -180 to 180.`,
      "Longitude runs from -180 to 180. Wrap the value into that range first.",
    );
  }
}

const isLatLetter = (h?: string): boolean => h === "N" || h === "S";
const isLonLetter = (h?: string): boolean => h === "E" || h === "W";

/** Read one point written as decimal degrees, DDM or DMS. */
export function parsePoint(text: string): LatLon {
  const original = String(text ?? "");
  const raw = original.trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter at least one coordinate.",
      "Try two lines like 40.7128, -74.0060 and 51.5074, -0.1278.",
    );
  }

  const groups = tokenizeAngles(raw, original);
  if (groups.length !== 2) {
    throw new ToolError(
      "unparseable",
      `Could not read "${raw}" as a coordinate: a latitude and a longitude are needed, and ${groups.length} value${groups.length === 1 ? " was" : "s were"} found.`,
      "Write both values, for example 40.7128, -74.0060 or 40°42'46\"N 74°00'22\"W.",
    );
  }

  const first = groupValue(groups[0], original);
  const second = groupValue(groups[1], original);

  if (isLatLetter(first.hemi) && isLatLetter(second.hemi)) {
    throw new ToolError(
      "unparseable",
      `"${raw}" carries two north or south letters and no east or west letter.`,
      "One value needs N or S and the other needs E or W.",
    );
  }
  if (isLonLetter(first.hemi) && isLonLetter(second.hemi)) {
    throw new ToolError(
      "unparseable",
      `"${raw}" carries two east or west letters and no north or south letter.`,
      "One value needs N or S and the other needs E or W.",
    );
  }

  const flipped = isLonLetter(first.hemi) || isLatLetter(second.hemi);
  const latV = flipped ? second : first;
  const lonV = flipped ? first : second;
  const signed = (v: AngleValue): number =>
    v.hemi === "S" || v.hemi === "W" ? -Math.abs(v.value) : v.hemi ? Math.abs(v.value) : v.value;

  const lat = signed(latV);
  const lon = signed(lonV);
  assertRange(lat, lon, original);
  return { lat, lon };
}

/* ------------------------------------------------------------------ *
 * Spherical geometry
 * ------------------------------------------------------------------ */

/** Great circle distance in kilometers on a sphere of mean earth radius. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * SPHERE_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great circle bearing in degrees clockwise from true north. */
export function initialBearing(a: LatLon, b: LatLon): number {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return wrap360(toDeg(Math.atan2(y, x)));
}

/** Bearing on arrival, which differs from the initial bearing on a great circle. */
export function finalBearing(a: LatLon, b: LatLon): number {
  return wrap360(initialBearing(b, a) + 180);
}

/** Half way along the great circle between two points. */
export function midpoint(a: LatLon, b: LatLon): LatLon {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const bx = Math.cos(p2) * Math.cos(dLon);
  const by = Math.cos(p2) * Math.sin(dLon);
  const lat = Math.atan2(
    Math.sin(p1) + Math.sin(p2),
    Math.sqrt((Math.cos(p1) + bx) * (Math.cos(p1) + bx) + by * by),
  );
  const lon = toRad(a.lon) + Math.atan2(by, Math.cos(p1) + bx);
  return { lat: toDeg(lat), lon: wrapLon(toDeg(lon)) };
}

/** Destination reached by traveling a great circle distance on a bearing. */
export function sphereDestination(start: LatLon, bearingDeg: number, distanceKm: number): LatLon {
  const delta = distanceKm / SPHERE_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const p1 = toRad(start.lat);
  const l1 = toRad(start.lon);
  const sinP2 = Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(theta);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(p1),
      Math.cos(delta) - Math.sin(p1) * sinP2,
    );
  return { lat: toDeg(p2), lon: wrapLon(toDeg(l2)) };
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** Nearest 16 point compass name for a bearing. */
export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(wrap360(bearing) / 22.5) % 16];
}

/* ------------------------------------------------------------------ *
 * Vincenty on the WGS84 ellipsoid
 * ------------------------------------------------------------------ */

export interface VincentyInverse {
  /** Distance in kilometers. */
  distanceKm: number;
  /** Initial bearing in degrees, or null for coincident points. */
  initialBearing: number | null;
  /** Bearing on arrival in degrees, or null for coincident points. */
  finalBearing: number | null;
  /** False when the iteration hit its cap, which happens near antipodal pairs. */
  converged: boolean;
  iterations: number;
}

/**
 * Vincenty's inverse formula on WGS84.
 *
 * The iteration is the standard one with a hard cap. Nearly antipodal pairs
 * are the known failure case: lambda oscillates instead of settling, so the
 * result is reported as not converged and the caller falls back to the sphere
 * rather than returning a wrong number.
 */
export function vincentyInverse(a: LatLon, b: LatLon, maxIterations = 200): VincentyInverse {
  const L = toRad(b.lon - a.lon);
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(toRad(a.lat)));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(toRad(b.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let iterations = 0;
  let converged = false;
  // Assigned on the first pass of the do-while, which always runs.
  let sinSigma: number;
  let cosSigma: number;
  let sigma: number;
  let cosSqAlpha: number;
  let cos2SigmaM: number;
  let sinLambda: number;
  let cosLambda: number;

  do {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) {
      return {
        distanceKm: 0,
        initialBearing: null,
        finalBearing: null,
        converged: true,
        iterations,
      };
    }
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // On an equatorial line cosSqAlpha is zero and cos2SigmaM is undefined.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    iterations++;
    if (Math.abs(lambda - lambdaPrev) < 1e-12) {
      converged = true;
      break;
    }
  } while (iterations < maxIterations);

  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return {
    distanceKm: (WGS84_B * A * (sigma - deltaSigma)) / 1000,
    initialBearing: wrap360(
      toDeg(Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)),
    ),
    finalBearing: wrap360(
      toDeg(Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda)),
    ),
    converged,
    iterations,
  };
}

export interface VincentyDirect {
  lat: number;
  lon: number;
  /** Bearing on arrival in degrees. */
  finalBearing: number;
}

/** Vincenty's direct formula: where you end up after a geodesic run on WGS84. */
export function vincentyDirect(
  start: LatLon,
  bearingDeg: number,
  distanceKm: number,
): VincentyDirect {
  const s = distanceKm * 1000;
  const alpha1 = toRad(bearingDeg);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);

  const tanU1 = (1 - WGS84_F) * Math.tan(toRad(start.lat));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = s / (WGS84_B * A);
  for (let i = 0; i < 200; i++) {
    const c2sm = Math.cos(2 * sigma1 + sigma);
    const sinS = Math.sin(sigma);
    const cosS = Math.cos(sigma);
    const deltaSigma =
      B *
      sinS *
      (c2sm +
        (B / 4) *
          (cosS * (-1 + 2 * c2sm * c2sm) -
            (B / 6) * c2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * c2sm * c2sm)));
    const next = s / (WGS84_B * A) + deltaSigma;
    const settled = Math.abs(next - sigma) < 1e-12;
    sigma = next;
    if (settled) break;
  }

  const sinSigma = Math.sin(sigma);
  const cosSigma = Math.cos(sigma);
  const cos2SigmaM = Math.cos(2 * sigma1 + sigma);

  const x = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - WGS84_F) * Math.sqrt(sinAlpha * sinAlpha + x * x),
  );
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) *
      WGS84_F *
      sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

  return {
    lat: toDeg(lat2),
    lon: wrapLon(start.lon + toDeg(L)),
    finalBearing: wrap360(toDeg(Math.atan2(sinAlpha, -x))),
  };
}

/* ------------------------------------------------------------------ *
 * World Magnetic Model
 * ------------------------------------------------------------------ */

export interface MagneticField {
  /** Declination in degrees, east of true north positive. */
  declination: number;
  /** Inclination (dip) in degrees, down positive. */
  inclination: number;
  /** Horizontal intensity in nanotesla. */
  horizontal: number;
  /** Total intensity in nanotesla. */
  total: number;
  /** North, east and down components in nanotesla. */
  x: number;
  y: number;
  z: number;
  /** Annual change of declination in degrees per year. */
  declinationChange: number;
  /** Annual change of inclination in degrees per year. */
  inclinationChange: number;
  /** Annual change of total intensity in nanotesla per year. */
  totalChange: number;
  /** Model name, for example WMM-2025. */
  model: string;
  /** Decimal year the field was evaluated for. */
  decimalYear: number;
  /** False when the requested date falls outside the model's five year window. */
  inValidity: boolean;
}

interface HarmonicSum {
  x: number;
  y: number;
  z: number;
}

/**
 * Schmidt semi-normalized associated Legendre functions and their derivative
 * with respect to colatitude, for degree and order up to WMM_MAX_DEGREE.
 */
function legendre(cosTheta: number, sinTheta: number): { p: number[][]; dp: number[][] } {
  const n = WMM_MAX_DEGREE;
  const p: number[][] = Array.from({ length: n + 1 }, (_, i) => new Array(i + 1).fill(0));
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) => new Array(i + 1).fill(0));
  p[0][0] = 1;
  dp[0][0] = 0;

  for (let deg = 1; deg <= n; deg++) {
    // Sectoral term.
    if (deg === 1) {
      p[1][1] = sinTheta;
      dp[1][1] = cosTheta;
    } else {
      const k = Math.sqrt((2 * deg - 1) / (2 * deg));
      p[deg][deg] = k * (sinTheta * p[deg - 1][deg - 1]);
      dp[deg][deg] = k * (sinTheta * dp[deg - 1][deg - 1] + cosTheta * p[deg - 1][deg - 1]);
    }
    // Everything below the diagonal.
    for (let m = 0; m < deg; m++) {
      const denom = Math.sqrt(deg * deg - m * m);
      const prev2 = deg - 2 >= m ? p[deg - 2][m] : 0;
      const dPrev2 = deg - 2 >= m ? dp[deg - 2][m] : 0;
      const k2 = Math.sqrt((deg - 1) * (deg - 1) - m * m);
      p[deg][m] = ((2 * deg - 1) * cosTheta * p[deg - 1][m] - k2 * prev2) / denom;
      dp[deg][m] =
        ((2 * deg - 1) * (cosTheta * dp[deg - 1][m] - sinTheta * p[deg - 1][m]) - k2 * dPrev2) /
        denom;
    }
  }
  return { p, dp };
}

/** One spherical harmonic sum in the geocentric frame, in nanotesla. */
function harmonicSum(
  g: number[][],
  h: number[][],
  ratio: number,
  lonRad: number,
  p: number[][],
  dp: number[][],
  sinTheta: number,
): HarmonicSum {
  const cosM: number[] = new Array(WMM_MAX_DEGREE + 1);
  const sinM: number[] = new Array(WMM_MAX_DEGREE + 1);
  for (let m = 0; m <= WMM_MAX_DEGREE; m++) {
    cosM[m] = Math.cos(m * lonRad);
    sinM[m] = Math.sin(m * lonRad);
  }

  let x = 0;
  let y = 0;
  let z = 0;
  let ratioPow = ratio * ratio; // (a/r)^(n+2) starts at n = 1 with (a/r)^3 below.
  for (let n = 1; n <= WMM_MAX_DEGREE; n++) {
    ratioPow *= ratio;
    for (let m = 0; m <= n; m++) {
      const gc = g[n][m] * cosM[m] + h[n][m] * sinM[m];
      const gs = g[n][m] * sinM[m] - h[n][m] * cosM[m];
      x += ratioPow * gc * dp[n][m];
      y += (ratioPow * m * gs * p[n][m]) / sinTheta;
      z -= (n + 1) * ratioPow * gc * p[n][m];
    }
  }
  return { x, y, z };
}

/**
 * Evaluate the World Magnetic Model at a geodetic position and date.
 *
 * `altKm` is height above the WGS84 ellipsoid in kilometers and
 * `decimalYear` is a fractional year such as 2026.5. The declination is
 * positive east of true north, which is the sign convention charts use.
 */
export function magneticDeclination(
  lat: number,
  lon: number,
  altKm: number,
  decimalYear: number,
): MagneticField {
  // The east component divides by cos(geocentric latitude), so step off the
  // exact pole. Declination is not defined there in any case.
  const latClamped = Math.max(-89.99999, Math.min(89.99999, lat));
  const dt = decimalYear - WMM_EPOCH;

  const phi = toRad(latClamped);
  const lambda = toRad(lon);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  // Geodetic to geocentric, in kilometers.
  const aKm = WGS84_A / 1000;
  const e2 = WGS84_F * (2 - WGS84_F);
  const rc = aKm / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const pRad = (rc + altKm) * cosPhi;
  const zRad = (rc * (1 - e2) + altKm) * sinPhi;
  const r = Math.sqrt(pRad * pRad + zRad * zRad);
  const phiPrime = Math.asin(zRad / r);

  const cosTheta = Math.sin(phiPrime); // cos(colatitude)
  const sinTheta = Math.cos(phiPrime); // sin(colatitude)
  const { p, dp } = legendre(cosTheta, sinTheta);
  const ratio = WMM_REFERENCE_RADIUS_KM / r;

  // Time adjusted main field coefficients.
  const g: number[][] = WMM_G.map((row, n) => row.map((v, m) => v + dt * WMM_G_DOT[n][m]));
  const h: number[][] = WMM_H.map((row, n) => row.map((v, m) => v + dt * WMM_H_DOT[n][m]));

  const field = harmonicSum(g, h, ratio, lambda, p, dp, sinTheta);
  const rate = harmonicSum(WMM_G_DOT, WMM_H_DOT, ratio, lambda, p, dp, sinTheta);

  // Rotate the geocentric frame back onto the geodetic one.
  const delta = phiPrime - phi;
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);
  const x = field.x * cosD - field.z * sinD;
  const y = field.y;
  const z = field.x * sinD + field.z * cosD;
  const xDot = rate.x * cosD - rate.z * sinD;
  const yDot = rate.y;
  const zDot = rate.x * sinD + rate.z * cosD;

  const horizontal = Math.sqrt(x * x + y * y);
  const total = Math.sqrt(horizontal * horizontal + z * z);
  const hDot = (x * xDot + y * yDot) / horizontal;
  const fDot = (x * xDot + y * yDot + z * zDot) / total;

  return {
    declination: toDeg(Math.atan2(y, x)),
    inclination: toDeg(Math.atan2(z, horizontal)),
    horizontal,
    total,
    x,
    y,
    z,
    declinationChange: toDeg((x * yDot - y * xDot) / (horizontal * horizontal)),
    inclinationChange: toDeg((horizontal * zDot - z * hDot) / (total * total)),
    totalChange: fDot,
    model: WMM_MODEL,
    decimalYear,
    inValidity: decimalYear >= WMM_VALID_FROM && decimalYear <= WMM_VALID_TO,
  };
}

/** Decimal year for a unix timestamp in milliseconds, evaluated in UTC. */
export function decimalYearFromMs(ms: number): number {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (ms - start) / (end - start);
}

/* ------------------------------------------------------------------ *
 * Input parsing
 * ------------------------------------------------------------------ */

interface DestinationRequest {
  start: LatLon;
  bearing: number;
  distanceKm: number;
  /** The unit the distance was written in, for echoing it back. */
  writtenUnit: UnitId;
}

interface ParsedInput {
  points: LatLon[];
  destination: DestinationRequest | null;
  /** Decimal year requested with an "on" line, when there was one. */
  decimalYear: number | null;
  /** The date as the user wrote it, for the output row. */
  dateLabel: string | null;
}

const DESTINATION_RE =
  /^from\s+(.+?)\s+(?:bearing|heading|azimuth|course)\s+([+-]?\d+(?:\.\d+)?)\s*(?:°|deg|degrees)?\s*(?:,|;)?\s*(?:for\s+)?(?:distance|dist|range|for)?\s*([\d.]+)\s*([a-z]*)\s*$/i;

const DATE_RE = /^on\s+(.+)$/i;

function parseDistanceToken(value: string, unitToken: string, fallback: UnitId): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ToolError(
      "bad-destination",
      `Could not read "${value}" as a distance.`,
      "Write the run as from 40.7,-74 bearing 45 distance 100km.",
    );
  }
  const unit = unitToken ? resolveUnit(unitToken) : fallback;
  if (!unit) {
    throw new ToolError(
      "bad-destination",
      `"${unitToken}" is not a distance unit this tool knows.`,
      "Use km, m, mi or nmi, for example distance 100km.",
    );
  }
  return n / UNITS[unit].perKm;
}

function parseDestinationLine(line: string, fallbackUnit: UnitId): DestinationRequest {
  const m = DESTINATION_RE.exec(line.trim());
  if (!m) {
    throw new ToolError(
      "bad-destination",
      `Could not read "${line.trim()}" as a start point, a bearing and a distance.`,
      "Write it as from 40.7,-74 bearing 45 distance 100km.",
    );
  }
  let start: LatLon;
  try {
    start = parsePoint(m[1]);
  } catch (err) {
    if (err instanceof ToolError && err.code === "out-of-range") throw err;
    throw new ToolError(
      "bad-destination",
      `Could not read "${m[1].trim()}" as the start point of the run.`,
      "Write it as from 40.7,-74 bearing 45 distance 100km.",
    );
  }
  const bearing = Number(m[2]);
  if (!Number.isFinite(bearing)) {
    throw new ToolError(
      "bad-destination",
      `Could not read "${m[2]}" as a bearing in degrees.`,
      "Bearings are degrees clockwise from north, so 0 is north and 90 is east.",
    );
  }
  const writtenUnit = m[4] ? resolveUnit(m[4]) : fallbackUnit;
  if (!writtenUnit) {
    throw new ToolError(
      "bad-destination",
      `"${m[4]}" is not a distance unit this tool knows.`,
      "Use km, m, mi or nmi, for example distance 100km.",
    );
  }
  return {
    start,
    bearing: wrap360(bearing),
    distanceKm: parseDistanceToken(m[3], m[4], fallbackUnit),
    writtenUnit,
  };
}

function parseDateLine(line: string): { decimalYear: number; label: string } {
  const body = (DATE_RE.exec(line.trim()) as RegExpExecArray)[1].trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const ms = Date.UTC(year, month - 1, day);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      throw new ToolError(
        "bad-date",
        `"${body}" is not a real calendar date.`,
        "Write the date as YYYY-MM-DD, for example on 2026-08-19.",
      );
    }
    return { decimalYear: decimalYearFromMs(ms), label: body };
  }
  const decimal = /^(\d{4}(?:\.\d+)?)$/.exec(body);
  if (decimal) return { decimalYear: Number(decimal[1]), label: body };
  throw new ToolError(
    "bad-date",
    `Could not read "${body}" as a date.`,
    "Write the date as YYYY-MM-DD, for example on 2026-08-19, or as a decimal year like 2026.5.",
  );
}

function splitLines(raw: string): string[] {
  return raw
    .split(/[\r\n;]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseInput(raw: string, fallbackUnit: UnitId): ParsedInput {
  const lines = splitLines(raw);
  const points: LatLon[] = [];
  const destinations: DestinationRequest[] = [];
  let decimalYear: number | null = null;
  let dateLabel: string | null = null;

  for (const line of lines) {
    if (DATE_RE.test(line)) {
      const parsed = parseDateLine(line);
      decimalYear = parsed.decimalYear;
      dateLabel = parsed.label;
      continue;
    }
    if (/^from\b/i.test(line)) {
      destinations.push(parseDestinationLine(line, fallbackUnit));
      continue;
    }
    points.push(parsePoint(line));
  }

  if (destinations.length > 1) {
    throw new ToolError(
      "bad-destination",
      `Found ${destinations.length} destination requests. This tool works out one at a time.`,
      "Keep a single line like from 40.7,-74 bearing 45 distance 100km.",
    );
  }
  if (destinations.length === 1 && points.length > 0) {
    throw new ToolError(
      "bad-destination",
      "A destination request cannot be mixed with extra coordinates in the same input.",
      "Either give the destination line on its own, or give two or more coordinates and drop the from line.",
    );
  }

  return { points, destination: destinations[0] ?? null, decimalYear, dateLabel };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function dmsPart(value: number, degWidth: number, letters: string): string {
  const abs = Math.abs(value);
  const totalSec = Math.round(abs * 3600 * 10) / 10;
  let deg = Math.floor(totalSec / 3600);
  let min = Math.floor((totalSec - deg * 3600) / 60);
  let sec = totalSec - deg * 3600 - min * 60;
  if (Number(sec.toFixed(1)) >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  const hemi = value < 0 ? letters[1] : letters[0];
  return `${String(deg).padStart(degWidth, "0")}°${String(min).padStart(2, "0")}'${sec.toFixed(1).padStart(4, "0")}"${hemi}`;
}

function formatPoint(p: LatLon): string {
  return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} (${dmsPart(p.lat, 2, "NS")} ${dmsPart(p.lon, 3, "EW")})`;
}

function formatBearing(bearing: number | null): string {
  if (bearing === null) return "not defined, the two points are the same";
  return `${bearing.toFixed(1)}° (${compassPoint(bearing)})`;
}

function formatDeclination(f: MagneticField): string {
  const side = f.declination >= 0 ? "east" : "west";
  const drift = f.declinationChange >= 0 ? "east" : "west";
  return (
    `${f.declination.toFixed(2)}° ${side}, ` +
    `inclination ${f.inclination.toFixed(2)}°, ` +
    `field ${Math.round(f.total)} nT, ` +
    `drifting ${Math.abs(f.declinationChange).toFixed(2)}° ${drift} per year`
  );
}

function magneticBearing(trueBearing: number, declination: number): number {
  return wrap360(trueBearing - declination);
}

/* ------------------------------------------------------------------ *
 * run()
 * ------------------------------------------------------------------ */

export interface DistanceBearingOpts {
  /** Output distance unit: km, mi, nmi or m. */
  units?: string;
  /** Add magnetic declination and magnetic bearing rows. */
  magnetic?: boolean;
  /** Unix milliseconds, injected by tests. Defaults to the current time. */
  now?: number;
  [key: string]: unknown;
}

export type DistanceBearingResult = Record<string, string>;

function modelRow(f: MagneticField, dateLabel: string): string {
  const base =
    `${f.model}, valid ${WMM_VALID_FROM.toFixed(1)} to ${WMM_VALID_TO.toFixed(1)}. ` +
    `Evaluated for ${dateLabel} (decimal year ${f.decimalYear.toFixed(3)}).`;
  if (f.inValidity) return base;
  return `${base} That date is outside the published five year window, so treat the figure as an extrapolation.`;
}

function addMagneticRows(
  out: DistanceBearingResult,
  label: string,
  point: LatLon,
  decimalYear: number,
  bearing: number | null,
  bearingLabel: string | null,
): MagneticField {
  const f = magneticDeclination(point.lat, point.lon, 0, decimalYear);
  out[`Magnetic declination at ${label}`] = formatDeclination(f);
  if (bearing !== null && bearingLabel) {
    out[bearingLabel] =
      `${magneticBearing(bearing, f.declination).toFixed(1)}° ` +
      `(true bearing ${bearing.toFixed(1)}° minus declination ${f.declination.toFixed(2)}°)`;
  }
  return f;
}

export function run(input: string, opts: DistanceBearingOpts = {}): DistanceBearingResult {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter two coordinates, one per line.",
      "Try 40.7128, -74.0060 on the first line and 51.5074, -0.1278 on the second.",
    );
  }

  const o = opts ?? {};
  const unit = UNITS[resolveUnit(typeof o.units === "string" ? o.units : "km") ?? "km"];
  const magnetic = o.magnetic !== false;
  const nowMs = typeof o.now === "number" && Number.isFinite(o.now) ? o.now : Date.now();

  const parsed = parseInput(raw, unit.id);
  const decimalYear = parsed.decimalYear ?? decimalYearFromMs(nowMs);
  const dateLabel = parsed.dateLabel ?? new Date(nowMs).toISOString().slice(0, 10);

  const out: DistanceBearingResult = {};

  /* ---- destination mode ---- */
  if (parsed.destination) {
    const d = parsed.destination;
    const written = UNITS[d.writtenUnit];
    const geodesic = vincentyDirect(d.start, d.bearing, d.distanceKm);
    const sphere = sphereDestination(d.start, d.bearing, d.distanceKm);

    out["Start"] = formatPoint(d.start);
    out["Bearing (true)"] = formatBearing(d.bearing);
    out["Distance traveled"] = formatDistance(d.distanceKm, unit);
    if (written.id !== unit.id) {
      out["Distance as written"] = formatDistance(d.distanceKm, written);
    }
    out["Destination (WGS84 ellipsoid)"] = formatPoint({ lat: geodesic.lat, lon: geodesic.lon });
    out["Destination (sphere)"] = formatPoint(sphere);
    out["Ellipsoid minus sphere"] = formatDistance(
      haversineKm({ lat: geodesic.lat, lon: geodesic.lon }, sphere),
      unit,
    );
    out["Final bearing (true)"] = formatBearing(geodesic.finalBearing);
    if (magnetic) {
      const f = addMagneticRows(
        out,
        "the start",
        d.start,
        decimalYear,
        d.bearing,
        "Magnetic bearing to steer",
      );
      out["Declination model"] = modelRow(f, dateLabel);
    }
    return out;
  }

  /* ---- one point is not enough ---- */
  if (parsed.points.length < 2) {
    throw new ToolError(
      "need-two",
      `Only ${parsed.points.length} coordinate was given. Distance and bearing need two points.`,
      "Add a second coordinate on its own line, or use a line like from 40.7,-74 bearing 45 distance 100km.",
    );
  }

  const pts = parsed.points;
  pts.forEach((p, i) => {
    out[`Point ${i + 1}`] = formatPoint(p);
  });

  /* ---- two points ---- */
  if (pts.length === 2) {
    const [a, b] = pts;
    const sphereKm = haversineKm(a, b);
    const v = vincentyInverse(a, b);
    const initial = a.lat === b.lat && a.lon === b.lon ? null : initialBearing(a, b);
    const final = initial === null ? null : finalBearing(a, b);

    out["Distance (sphere)"] = formatDistance(sphereKm, unit);
    if (v.converged) {
      out["Distance (WGS84 ellipsoid)"] = formatDistance(v.distanceKm, unit);
      out["Ellipsoid minus sphere"] =
        `${formatDistance(v.distanceKm - sphereKm, unit)}` +
        (sphereKm > 0 ? ` (${(((v.distanceKm - sphereKm) / sphereKm) * 100).toFixed(3)}%)` : "");
    } else {
      out["Distance (WGS84 ellipsoid)"] =
        `${formatDistance(sphereKm, unit)} (sphere value shown: ` +
        "Vincenty did not converge, which happens when two points are nearly antipodal)";
    }
    out["Initial bearing (true)"] = formatBearing(initial);
    out["Final bearing (true)"] = formatBearing(final);
    out["Midpoint"] = formatPoint(midpoint(a, b));

    if (magnetic) {
      const f1 = addMagneticRows(
        out,
        "point 1",
        a,
        decimalYear,
        initial,
        "Magnetic bearing to steer",
      );
      addMagneticRows(out, "point 2", b, decimalYear, final, "Magnetic bearing on arrival");
      out["Declination model"] = modelRow(f1, dateLabel);
    }
    return out;
  }

  /* ---- route of three or more points ---- */
  let totalSphere = 0;
  let totalEllipsoid = 0;
  let allConverged = true;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const legKm = haversineKm(a, b);
    const v = vincentyInverse(a, b);
    const bearing = a.lat === b.lat && a.lon === b.lon ? null : initialBearing(a, b);
    totalSphere += legKm;
    totalEllipsoid += v.converged ? v.distanceKm : legKm;
    if (!v.converged) allConverged = false;

    let row = `${formatDistance(legKm, unit)} sphere, ${
      v.converged ? formatDistance(v.distanceKm, unit) : "no ellipsoid value"
    } WGS84, bearing ${formatBearing(bearing)}`;
    if (magnetic && bearing !== null) {
      const f = magneticDeclination(a.lat, a.lon, 0, decimalYear);
      row += `, magnetic ${magneticBearing(bearing, f.declination).toFixed(1)}°`;
    }
    out[`Leg ${i + 1} (point ${i + 1} to ${i + 2})`] = row;
  }

  out["Total distance (sphere)"] = formatDistance(totalSphere, unit);
  out["Total distance (WGS84 ellipsoid)"] = allConverged
    ? formatDistance(totalEllipsoid, unit)
    : `${formatDistance(totalEllipsoid, unit)} (one leg fell back to the sphere because Vincenty did not converge)`;
  out["Legs"] = String(pts.length - 1);

  if (magnetic) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const f1 = addMagneticRows(
      out,
      "point 1",
      first,
      decimalYear,
      initialBearing(first, pts[1]),
      "Magnetic bearing on leg 1",
    );
    addMagneticRows(out, `point ${pts.length}`, last, decimalYear, null, null);
    out["Declination model"] = modelRow(f1, dateLabel);
  }
  return out;
}

export default { run } satisfies ToolLogic<string, DistanceBearingResult, DistanceBearingOpts>;
