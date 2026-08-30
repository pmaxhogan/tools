/**
 * Moon phase, illumination, distance, phase times and moonrise.
 *
 * The algorithms are Jean Meeus, "Astronomical Algorithms" (2nd edition):
 *
 *   ch. 22  nutation in longitude and obliquity (the abbreviated series)
 *   ch. 25  the Sun's apparent longitude and distance (low accuracy series)
 *   ch. 47  the Moon's position: the ELP2000-82 truncated series, 60 terms
 *           for longitude and distance and 60 for latitude
 *   ch. 48  illuminated fraction, phase angle, position angle of the bright limb
 *   ch. 49  the times of new moon, first quarter, full moon and last quarter,
 *           mean phase plus the periodic and planetary corrections
 *   ch. 15  rising, transit and setting, using the Moon's own standard
 *           altitude h0 = 0.7275 * parallax - 34 arcminutes
 *   ch. 40  topocentric right ascension and declination (the parallax that
 *           moves the Moon by up to a degree between the geocenter and a
 *           place on the surface)
 *
 * Delta T (Terrestrial Time minus Universal Time) uses the Espenak and Meeus
 * polynomial expressions published with the NASA Five Millennium Canon of
 * Solar Eclipses, which is what turns a Dynamical Time result from chapter 49
 * into the civil clock time a reader wants.
 *
 * Everything here is pure arithmetic plus Intl for time zone formatting. No
 * DOM, no network, no storage (PROJECT.md rule 27).
 */

import { ToolError, type ToolLogic } from "../types";
// The city table lives with the sun calculator, which authored it. It is pure
// data with no logic of its own, so reading it here keeps one gazetteer for
// the whole site rather than a third copy that drifts out of step.
import { lookupPlace, type PlaceEntry } from "../sunrise-sunset-calculator/places";

/* ------------------------------------------------------------------ */
/* Units and small helpers                                              */
/* ------------------------------------------------------------------ */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

/** Julian Day of the unix epoch, 1970-01-01T00:00:00Z. */
const UNIX_EPOCH_JD = 2440587.5;

/** Mean length of one synodic month, in days (Meeus ch. 49). */
export const SYNODIC_MONTH = 29.530588861;

/** Equatorial radius of the Earth in kilometers (IAU 1976). */
const EARTH_RADIUS_KM = 6378.14;

/** Radius of the Moon in kilometers, for the angular diameter. */
const MOON_RADIUS_KM = 1737.4;

/** One astronomical unit in kilometers (IAU 2012). */
const AU_KM = 149_597_870.7;

/** Earliest and latest dates this tool will answer for. */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

const sinD = (deg: number): number => Math.sin(deg * RAD);
const cosD = (deg: number): number => Math.cos(deg * RAD);
const tanD = (deg: number): number => Math.tan(deg * RAD);
const asinD = (x: number): number => Math.asin(Math.max(-1, Math.min(1, x))) * DEG;
const atan2D = (y: number, x: number): number => Math.atan2(y, x) * DEG;

/** Wrap into [0, 360). */
function mod360(deg: number): number {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
}

/** Wrap into [-180, 180). */
function wrap180(deg: number): number {
  return mod360(deg + 180) - 180;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/* ------------------------------------------------------------------ */
/* Time scales                                                          */
/* ------------------------------------------------------------------ */

/** Julian Day from epoch milliseconds (UT). */
export function julianDay(ms: number): number {
  return ms / MS_PER_DAY + UNIX_EPOCH_JD;
}

/** Epoch milliseconds (UT) from a Julian Day. */
export function msFromJulianDay(jd: number): number {
  return (jd - UNIX_EPOCH_JD) * MS_PER_DAY;
}

/** Julian centuries from J2000.0. */
function centuries(jd: number): number {
  return (jd - 2451545) / 36525;
}

/** Decimal year, good enough for the Delta T polynomials. */
function decimalYear(jd: number): number {
  return 2000 + (jd - 2451545) / 365.25;
}

/**
 * Delta T in seconds: Terrestrial Time minus Universal Time. Espenak and
 * Meeus polynomial expressions, NASA Five Millennium Canon of Solar Eclipses.
 * Over this tool's 1900 to 2100 window the pre-2015 branches follow the
 * measured record within a second or two and the later ones are the published
 * extrapolation, which runs a few seconds high for the present decade.
 */
export function deltaTSeconds(jd: number): number {
  const y = decimalYear(jd);
  if (y < 1920) {
    const t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
  }
  if (y < 1941) {
    const t = y - 1920;
    return 21.2 + 0.84493 * t - 0.0761 * t * t + 0.0020936 * t ** 3;
  }
  if (y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + t ** 3 / 2547;
  }
  if (y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - t ** 3 / 718;
  }
  if (y < 2005) {
    const t = y - 2000;
    return (
      63.86 +
      0.3345 * t -
      0.060374 * t * t +
      0.0017275 * t ** 3 +
      0.000651814 * t ** 4 +
      0.00002373599 * t ** 5
    );
  }
  if (y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  const u = (y - 1820) / 100;
  return -20 + 32 * u * u - 0.5628 * (2150 - y);
}

/** Julian Ephemeris Day (TT) from a Julian Day in UT. */
export function jdeFromJd(jd: number): number {
  return jd + deltaTSeconds(jd) / 86400;
}

/** Julian Day in UT from a Julian Ephemeris Day (TT). */
export function jdFromJde(jde: number): number {
  // Delta T changes by microseconds per second, so one pass is exact enough.
  return jde - deltaTSeconds(jde) / 86400;
}

/* ------------------------------------------------------------------ */
/* Nutation and obliquity (Meeus ch. 22, abbreviated)                   */
/* ------------------------------------------------------------------ */

export interface Nutation {
  /** Nutation in longitude, degrees. */
  dPsi: number;
  /** Nutation in obliquity, degrees. */
  dEps: number;
  /** True obliquity of the ecliptic, degrees. */
  epsilon: number;
}

export function nutation(t: number): Nutation {
  const omega = 125.04452 - 1934.136261 * t;
  const ls = 280.4665 + 36000.7698 * t;
  const lm = 218.3165 + 481267.8813 * t;

  const dPsiArcsec =
    -17.2 * sinD(omega) - 1.32 * sinD(2 * ls) - 0.23 * sinD(2 * lm) + 0.21 * sinD(2 * omega);
  const dEpsArcsec =
    9.2 * cosD(omega) + 0.57 * cosD(2 * ls) + 0.1 * cosD(2 * lm) - 0.09 * cosD(2 * omega);

  // Mean obliquity, Meeus formula 22.2.
  const eps0 =
    23 + 26 / 60 + 21.448 / 3600 - (46.815 * t + 0.00059 * t * t - 0.001813 * t ** 3) / 3600;

  return {
    dPsi: dPsiArcsec / 3600,
    dEps: dEpsArcsec / 3600,
    epsilon: eps0 + dEpsArcsec / 3600,
  };
}

/* ------------------------------------------------------------------ */
/* The Sun (Meeus ch. 25, low accuracy: about 0.01 degree)              */
/* ------------------------------------------------------------------ */

export interface SunState {
  /** Apparent geocentric ecliptic longitude, degrees. */
  longitude: number;
  /** Distance from Earth, astronomical units. */
  distanceAu: number;
  /** Apparent right ascension, degrees. */
  ra: number;
  /** Apparent declination, degrees. */
  dec: number;
}

export function sunState(jde: number): SunState {
  const t = centuries(jde);
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;

  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * sinD(m) +
    (0.019993 - 0.000101 * t) * sinD(2 * m) +
    0.000289 * sinD(3 * m);

  const trueLong = l0 + c;
  const v = m + c;
  const r = (1.000001018 * (1 - e * e)) / (1 + e * cosD(v));

  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * sinD(omega);

  const { epsilon } = nutation(t);
  // The apparent right ascension uses the corrected obliquity (Meeus p. 165).
  const epsCorrected = epsilon + 0.00256 * cosD(omega);
  const ra = mod360(atan2D(cosD(epsCorrected) * sinD(lambda), cosD(lambda)));
  const dec = asinD(sinD(epsCorrected) * sinD(lambda));

  return { longitude: mod360(lambda), distanceAu: r, ra, dec };
}

/* ------------------------------------------------------------------ */
/* The Moon (Meeus ch. 47, table 47.A and 47.B)                         */
/* ------------------------------------------------------------------ */

/** [D, M, M', F, coefficient of Sigma l (1e-6 deg), coefficient of Sigma r (1e-3 km)] */
const TERMS_LR: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0],
  [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0],
  [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0],
  [2, 0, -1, -2, 0, 8752],
];

/** [D, M, M', F, coefficient of Sigma b (1e-6 deg)] */
const TERMS_B: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777],
  [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596],
  [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439],
  [2, 0, 2, 1, 422],
  [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351],
  [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315],
  [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229],
  [1, 1, 0, -1, 223],
  [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220],
  [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177],
  [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119],
  [4, -1, 0, -1, 115],
  [2, -2, 0, 1, 107],
];

export interface MoonPosition {
  /** Apparent geocentric ecliptic longitude, degrees, equinox of date. */
  longitude: number;
  /** Geocentric ecliptic latitude, degrees. */
  latitude: number;
  /** Distance between the centers of Earth and Moon, kilometers. */
  distanceKm: number;
  /** Equatorial horizontal parallax, degrees. */
  parallax: number;
  /** Apparent geocentric right ascension, degrees. */
  ra: number;
  /** Apparent geocentric declination, degrees. */
  dec: number;
  /** Geocentric apparent semidiameter, degrees. */
  semidiameter: number;
}

/**
 * The Moon's apparent geocentric position for a Julian Ephemeris Day.
 * Longitude is good to about 10 arcseconds, latitude to about 4, and the
 * distance to about 50 kilometers, which is the published accuracy of the
 * truncated ELP2000-82 series in Meeus chapter 47.
 */
export function moonPosition(jde: number): MoonPosition {
  const t = centuries(jde);

  const lPrime =
    218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + t ** 3 / 538841 - t ** 4 / 65194000;
  const d =
    297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + t ** 3 / 545868 - t ** 4 / 113065000;
  const m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + t ** 3 / 24490000;
  const mPrime =
    134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + t ** 3 / 69699 - t ** 4 / 14712000;
  const f =
    93.272095 + 483202.0175233 * t - 0.0036539 * t * t - t ** 3 / 3526000 + t ** 4 / 863310000;

  const a1 = 119.75 + 131.849 * t;
  const a2 = 53.09 + 479264.29 * t;
  const a3 = 313.45 + 481266.484 * t;
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;

  let sumL = 0;
  let sumR = 0;
  for (const [cd, cm, cmp, cf, coefL, coefR] of TERMS_LR) {
    const arg = cd * d + cm * m + cmp * mPrime + cf * f;
    const damp = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumL += coefL * damp * sinD(arg);
    sumR += coefR * damp * cosD(arg);
  }

  let sumB = 0;
  for (const [cd, cm, cmp, cf, coefB] of TERMS_B) {
    const arg = cd * d + cm * m + cmp * mPrime + cf * f;
    const damp = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumB += coefB * damp * sinD(arg);
  }

  // Additive terms for Venus (A1), Jupiter (A2) and the flattening of the Earth.
  sumL += 3958 * sinD(a1) + 1962 * sinD(lPrime - f) + 318 * sinD(a2);
  sumB +=
    -2235 * sinD(lPrime) +
    382 * sinD(a3) +
    175 * sinD(a1 - f) +
    175 * sinD(a1 + f) +
    127 * sinD(lPrime - mPrime) -
    115 * sinD(lPrime + mPrime);

  const lambdaMean = mod360(lPrime + sumL / 1e6);
  const beta = sumB / 1e6;
  const distanceKm = 385000.56 + sumR / 1000;
  const parallax = asinD(EARTH_RADIUS_KM / distanceKm);

  const { dPsi, epsilon } = nutation(t);
  const lambda = mod360(lambdaMean + dPsi);

  const ra = mod360(
    atan2D(sinD(lambda) * cosD(epsilon) - tanD(beta) * sinD(epsilon), cosD(lambda)),
  );
  const dec = asinD(sinD(beta) * cosD(epsilon) + cosD(beta) * sinD(epsilon) * sinD(lambda));

  return {
    longitude: lambda,
    latitude: beta,
    distanceKm,
    parallax,
    ra,
    dec,
    semidiameter: asinD(MOON_RADIUS_KM / distanceKm),
  };
}

/* ------------------------------------------------------------------ */
/* Illumination (Meeus ch. 48)                                          */
/* ------------------------------------------------------------------ */

export interface Illumination {
  /** Geocentric elongation of the Moon from the Sun, degrees. */
  elongation: number;
  /** Phase angle Sun-Moon-Earth, degrees: 0 at full, 180 at new. */
  phaseAngle: number;
  /** Illuminated fraction of the disc, 0 to 1. */
  fraction: number;
  /** Position angle of the midpoint of the bright limb, degrees. */
  brightLimbAngle: number;
  /** True while the illuminated fraction is growing. */
  waxing: boolean;
  /** Difference in apparent longitude, Moon minus Sun, 0 to 360 degrees. */
  phaseLongitude: number;
}

export function illumination(moon: MoonPosition, sun: SunState): Illumination {
  const psi =
    Math.acos(clamp(cosD(moon.latitude) * cosD(moon.longitude - sun.longitude), -1, 1)) * DEG;

  const sunKm = sun.distanceAu * AU_KM;
  const i = mod360(atan2D(sunKm * sinD(psi), moon.distanceKm - sunKm * cosD(psi)));
  const phaseAngle = i > 180 ? 360 - i : i;
  const fraction = (1 + cosD(phaseAngle)) / 2;

  const dRa = sun.ra - moon.ra;
  const chi = mod360(
    atan2D(
      cosD(sun.dec) * sinD(dRa),
      sinD(sun.dec) * cosD(moon.dec) - cosD(sun.dec) * sinD(moon.dec) * cosD(dRa),
    ),
  );

  const phaseLongitude = mod360(moon.longitude - sun.longitude);
  return {
    elongation: psi,
    phaseAngle,
    fraction,
    brightLimbAngle: chi,
    waxing: phaseLongitude < 180,
    phaseLongitude,
  };
}

/* ------------------------------------------------------------------ */
/* Phase times (Meeus ch. 49)                                           */
/* ------------------------------------------------------------------ */

export type PhaseKind = "new" | "first-quarter" | "full" | "last-quarter";

export const PHASE_LABELS: Record<PhaseKind, string> = {
  new: "New moon",
  "first-quarter": "First quarter",
  full: "Full moon",
  "last-quarter": "Last quarter",
};

const PHASE_OFFSET: Record<PhaseKind, number> = {
  new: 0,
  "first-quarter": 0.25,
  full: 0.5,
  "last-quarter": 0.75,
};

/** [coefficient in days, D multiplier, M multiplier, M' multiplier, F multiplier, Omega multiplier, power of E] */
type PhaseTerm = readonly [number, number, number, number, number];

/** Terms are [coefficient, M multiplier, M' multiplier, F multiplier, Omega multiplier]. */
const NEW_MOON_TERMS: readonly PhaseTerm[] = [
  [-0.4072, 0, 1, 0, 0],
  [0.17241, 1, 0, 0, 0],
  [0.01608, 0, 2, 0, 0],
  [0.01039, 0, 0, 2, 0],
  [0.00739, -1, 1, 0, 0],
  [-0.00514, 1, 1, 0, 0],
  [0.00208, 2, 0, 0, 0],
  [-0.00111, 0, 1, -2, 0],
  [-0.00057, 0, 1, 2, 0],
  [0.00056, 1, 2, 0, 0],
  [-0.00042, 0, 3, 0, 0],
  [0.00042, 1, 0, 2, 0],
  [0.00038, 1, 0, -2, 0],
  [-0.00024, -1, 2, 0, 0],
  [-0.00017, 0, 0, 0, 1],
  [-0.00007, 2, 1, 0, 0],
  [0.00004, 0, 2, -2, 0],
  [0.00004, 3, 0, 0, 0],
  [0.00003, 1, 1, -2, 0],
  [0.00003, 0, 2, 2, 0],
  [-0.00003, 1, 1, 2, 0],
  [0.00003, -1, 1, 2, 0],
  [-0.00002, -1, 1, -2, 0],
  [-0.00002, 1, 3, 0, 0],
  [0.00002, 0, 4, 0, 0],
];

const FULL_MOON_TERMS: readonly PhaseTerm[] = [
  [-0.40614, 0, 1, 0, 0],
  [0.17302, 1, 0, 0, 0],
  [0.01614, 0, 2, 0, 0],
  [0.01043, 0, 0, 2, 0],
  [0.00734, -1, 1, 0, 0],
  [-0.00515, 1, 1, 0, 0],
  [0.00209, 2, 0, 0, 0],
  [-0.00111, 0, 1, -2, 0],
  [-0.00057, 0, 1, 2, 0],
  [0.00056, 1, 2, 0, 0],
  [-0.00042, 0, 3, 0, 0],
  [0.00042, 1, 0, 2, 0],
  [0.00038, 1, 0, -2, 0],
  [-0.00024, -1, 2, 0, 0],
  [-0.00017, 0, 0, 0, 1],
  [-0.00007, 2, 1, 0, 0],
  [0.00004, 0, 2, -2, 0],
  [0.00004, 3, 0, 0, 0],
  [0.00003, 1, 1, -2, 0],
  [0.00003, 0, 2, 2, 0],
  [-0.00003, 1, 1, 2, 0],
  [0.00003, -1, 1, 2, 0],
  [-0.00002, -1, 1, -2, 0],
  [-0.00002, 1, 3, 0, 0],
  [0.00002, 0, 4, 0, 0],
];

const QUARTER_TERMS: readonly PhaseTerm[] = [
  [-0.62801, 0, 1, 0, 0],
  [0.17172, 1, 0, 0, 0],
  [-0.01183, 1, 1, 0, 0],
  [0.00862, 0, 2, 0, 0],
  [0.00804, 0, 0, 2, 0],
  [0.00454, -1, 1, 0, 0],
  [0.00204, 2, 0, 0, 0],
  [-0.0018, 0, 1, -2, 0],
  [-0.0007, 0, 1, 2, 0],
  [-0.0004, 0, 3, 0, 0],
  [-0.00034, -1, 2, 0, 0],
  [0.00032, 1, 0, 2, 0],
  [0.00032, 1, 0, -2, 0],
  [-0.00028, 2, 1, 0, 0],
  [0.00027, 1, 2, 0, 0],
  [-0.00017, 0, 0, 0, 1],
  [-0.00005, -1, 1, -2, 0],
  [0.00004, 0, 2, 2, 0],
  [-0.00004, 1, 1, 2, 0],
  [0.00004, -2, 1, 0, 0],
  [0.00003, 1, 1, -2, 0],
  [0.00003, 3, 0, 0, 0],
  [0.00002, 0, 2, -2, 0],
  [0.00002, -1, 1, 2, 0],
  [-0.00002, 1, 3, 0, 0],
];

/** Planetary arguments, [constant, coefficient of k, coefficient of T squared]. */
const PLANETARY_ARGS: readonly (readonly [number, number, number])[] = [
  [299.77, 0.107408, -0.009173],
  [251.88, 0.016321, 0],
  [251.83, 26.651886, 0],
  [349.42, 36.412478, 0],
  [84.66, 18.206239, 0],
  [141.74, 53.303771, 0],
  [207.14, 2.453732, 0],
  [154.84, 7.30686, 0],
  [34.52, 27.261239, 0],
  [207.19, 0.121824, 0],
  [291.34, 1.844379, 0],
  [161.72, 24.198154, 0],
  [239.56, 25.513099, 0],
  [331.55, 3.592518, 0],
];

const PLANETARY_COEFFICIENTS: readonly number[] = [
  0.000325, 0.000165, 0.000164, 0.000126, 0.00011, 0.000062, 0.00006, 0.000056, 0.000047, 0.000042,
  0.00004, 0.000037, 0.000035, 0.000023,
];

/**
 * The Julian Ephemeris Day of one lunar phase, from its lunation number.
 * `k` counts new moons from the one of 2000 January 6; add 0.25, 0.5 or 0.75
 * for the quarters and the full moon. The result is in Dynamical Time.
 */
export function phaseJde(k: number): number {
  const t = k / 1236.85;
  const t2 = t * t;

  let jde =
    2451550.09766 +
    SYNODIC_MONTH * k +
    0.00015437 * t2 -
    0.00000015 * t2 * t +
    0.00000000073 * t2 * t2;

  const e = 1 - 0.002516 * t - 0.0000074 * t2;
  const m = 2.5534 + 29.1053567 * k - 0.0000014 * t2 - 0.00000011 * t2 * t;
  const mPrime =
    201.5643 + 385.81693528 * k + 0.0107582 * t2 + 0.00001238 * t2 * t - 0.000000058 * t2 * t2;
  const f =
    160.7108 + 390.67050284 * k - 0.0016118 * t2 - 0.00000227 * t2 * t + 0.000000011 * t2 * t2;
  const omega = 124.7746 - 1.56375588 * k + 0.0020672 * t2 + 0.00000215 * t2 * t;

  const quarterPhase = Math.abs(k % 1) === 0.25 || Math.abs(k % 1) === 0.75;
  const fractional = ((k % 1) + 1) % 1;
  const terms =
    fractional === 0 ? NEW_MOON_TERMS : fractional === 0.5 ? FULL_MOON_TERMS : QUARTER_TERMS;

  for (const [coefficient, cm, cmp, cf, cOmega] of terms) {
    const arg = cm * m + cmp * mPrime + cf * f + cOmega * omega;
    // The eccentricity factor E enters once per power of the Sun's mean
    // anomaly in the argument, which is what chapter 49 prints beside each
    // term as E or E squared.
    const damp = Math.abs(cm) === 1 ? e : Math.abs(cm) === 2 ? e * e : 1;
    jde += coefficient * damp * sinD(arg);
  }

  if (quarterPhase) {
    const w =
      0.00306 -
      0.00038 * e * cosD(m) +
      0.00026 * cosD(mPrime) -
      0.00002 * cosD(mPrime - m) +
      0.00002 * cosD(mPrime + m) +
      0.00002 * cosD(2 * f);
    jde += fractional === 0.25 ? w : -w;
  }

  for (let i = 0; i < PLANETARY_ARGS.length; i += 1) {
    const [c0, ck, ct2] = PLANETARY_ARGS[i];
    jde += PLANETARY_COEFFICIENTS[i] * sinD(c0 + ck * k + ct2 * t2);
  }

  return jde;
}

/** The approximate lunation number for a Julian Day. */
function approximateK(jd: number): number {
  return (decimalYear(jd) - 2000) * 12.3685;
}

export interface PhaseEvent {
  kind: PhaseKind;
  /** Epoch milliseconds of the event in Universal Time. */
  ms: number;
  /** Lunation number: k in the Meeus numbering. */
  k: number;
  /** Brown lunation number, the numbering used in almanacs. */
  lunation: number;
}

function eventAt(kind: PhaseKind, cycle: number): PhaseEvent {
  const k = cycle + PHASE_OFFSET[kind];
  return {
    kind,
    ms: msFromJulianDay(jdFromJde(phaseJde(k))),
    k,
    lunation: cycle + 953,
  };
}

/** The first occurrence of one phase kind at or after an instant. */
export function nextPhase(kind: PhaseKind, fromMs: number): PhaseEvent {
  let cycle = Math.floor(approximateK(julianDay(fromMs))) - 2;
  for (let guard = 0; guard < 8; guard += 1, cycle += 1) {
    const event = eventAt(kind, cycle);
    if (event.ms >= fromMs) return event;
  }
  return eventAt(kind, cycle);
}

/** The last occurrence of one phase kind at or before an instant. */
export function previousPhase(kind: PhaseKind, fromMs: number): PhaseEvent {
  let cycle = Math.ceil(approximateK(julianDay(fromMs))) + 2;
  for (let guard = 0; guard < 8; guard += 1, cycle -= 1) {
    const event = eventAt(kind, cycle);
    if (event.ms <= fromMs) return event;
  }
  return eventAt(kind, cycle);
}

/* ------------------------------------------------------------------ */
/* Phase naming                                                         */
/* ------------------------------------------------------------------ */

/**
 * How close the difference in longitude has to be to 0, 90, 180 or 270
 * degrees before the phase is named for the exact moment rather than the
 * stretch between two. Half of the 15 degree window is about 14 hours.
 */
const CARDINAL_WINDOW = 7.5;

/** The eight phase names, from the difference in apparent longitude. */
export function phaseName(phaseLongitude: number): string {
  const d = mod360(phaseLongitude);
  if (d < CARDINAL_WINDOW || d >= 360 - CARDINAL_WINDOW) return "New moon";
  if (Math.abs(d - 90) < CARDINAL_WINDOW) return "First quarter";
  if (Math.abs(d - 180) < CARDINAL_WINDOW) return "Full moon";
  if (Math.abs(d - 270) < CARDINAL_WINDOW) return "Last quarter";
  if (d < 90) return "Waxing crescent";
  if (d < 180) return "Waxing gibbous";
  if (d < 270) return "Waning gibbous";
  return "Waning crescent";
}

/* ------------------------------------------------------------------ */
/* The drawn disc                                                       */
/* ------------------------------------------------------------------ */

export interface DiscOptions {
  /** Center of the disc in SVG user units. */
  cx?: number;
  cy?: number;
  /** Radius of the disc in SVG user units. */
  r?: number;
  /**
   * True to draw the disc as it looks from the southern hemisphere, where the
   * whole picture is turned through half a turn, so a waxing moon is lit on
   * the left rather than on the right.
   */
  southern?: boolean;
}

function trim(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The SVG path of the lit part of the Moon's disc.
 *
 * The outer edge is half of the limb circle and the inner edge is half of an
 * ellipse whose semi-axis across the disc is r * |2f - 1|, which is the
 * projection of the terminator, the great circle dividing lunar day from
 * lunar night. That makes the sweep flags the whole trick: the terminator
 * bulges away from the lit limb while the Moon is a crescent and toward the
 * dark limb once it is gibbous, and it degenerates to a straight line at
 * exactly half lit.
 *
 * Returns an empty string at new moon, when nothing is lit.
 */
export function terminatorPath(
  fraction: number,
  waxing: boolean,
  options: DiscOptions = {},
): string {
  const cx = options.cx ?? 50;
  const cy = options.cy ?? 50;
  const r = options.r ?? 48;
  const f = clamp(fraction, 0, 1);
  if (f < 0.0005) return "";

  const litOnRight = options.southern === true ? !waxing : waxing;
  const gibbous = f > 0.5;
  const rx = r * Math.abs(2 * f - 1);

  // Sweep flag 1 is the direction of increasing angle, which reads clockwise
  // on screen because SVG's y axis points down.
  const limbSweep = litOnRight ? 1 : 0;
  const terminatorSweep = litOnRight === gibbous ? 1 : 0;

  const top = `${trim(cx)} ${trim(cy - r)}`;
  const bottom = `${trim(cx)} ${trim(cy + r)}`;
  return (
    `M${top}` +
    `A${trim(r)} ${trim(r)} 0 0 ${limbSweep} ${bottom}` +
    `A${trim(rx)} ${trim(r)} 0 0 ${terminatorSweep} ${top}` +
    `Z`
  );
}

/* ------------------------------------------------------------------ */
/* Topocentric position and the events of a day (Meeus ch. 15 and 40)   */
/* ------------------------------------------------------------------ */

/** Apparent sidereal time at Greenwich, degrees, for a Julian Day in UT. */
export function apparentSiderealTime(jd: number): number {
  const t = centuries(jd);
  const theta0 =
    280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - (t * t * t) / 38710000;
  const { dPsi, epsilon } = nutation(t);
  return mod360(theta0 + dPsi * cosD(epsilon));
}

export interface HorizontalPosition {
  /** Altitude above the horizon, degrees, with no correction for refraction. */
  altitude: number;
  /** Azimuth measured from north through east, degrees. */
  azimuth: number;
  /** Local hour angle, degrees. */
  hourAngle: number;
}

/** Equatorial to horizontal for an observer, both angles in degrees. */
export function horizontalFrom(
  ra: number,
  dec: number,
  siderealDeg: number,
  lat: number,
  lon: number,
): HorizontalPosition {
  const h = mod360(siderealDeg + lon - ra);
  const altitude = asinD(sinD(lat) * sinD(dec) + cosD(lat) * cosD(dec) * cosD(h));
  const azimuth = mod360(atan2D(sinD(h), cosD(h) * sinD(lat) - tanD(dec) * cosD(lat)) + 180);
  return { altitude, azimuth, hourAngle: wrap180(h) };
}

/**
 * The Moon's topocentric right ascension and declination for an observer at
 * sea level (Meeus formulas 40.6 and 40.7). Parallax moves the Moon by up to
 * about one degree, which is the difference between a picture of the sky and
 * a picture of the sky from where you are standing.
 */
export function topocentricMoon(
  moon: MoonPosition,
  siderealDeg: number,
  lat: number,
  lon: number,
): { ra: number; dec: number } {
  const u = Math.atan(0.99664719 * tanD(lat)) * DEG;
  const rhoSin = 0.99664719 * sinD(u);
  const rhoCos = cosD(u);
  const h = mod360(siderealDeg + lon - moon.ra);
  const sinPi = sinD(moon.parallax);

  const denominator = cosD(moon.dec) - rhoCos * sinPi * cosD(h);
  const dRa = atan2D(-rhoCos * sinPi * sinD(h), denominator);
  const dec = atan2D((sinD(moon.dec) - rhoSin * sinPi) * cosD(dRa), denominator);
  return { ra: mod360(moon.ra + dRa), dec };
}

/**
 * The standard altitude for moonrise and moonset: the geocentric altitude of
 * the Moon's center when its upper limb touches a sea level horizon, once
 * refraction and the Moon's own parallax are allowed for (Meeus ch. 15).
 */
export function moonStandardAltitude(parallaxDeg: number): number {
  return 0.7275 * parallaxDeg - 0.5667;
}

export interface DayEvents {
  /** Epoch milliseconds, or null when the event does not happen that day. */
  rise: number | null;
  set: number | null;
  /** Epoch milliseconds of the highest point inside the window. */
  transit: number;
  /** Highest altitude reached inside the window, degrees. */
  peakAltitude: number;
  /** True when the Moon is above the standard altitude for the whole window. */
  alwaysUp: boolean;
  /** True when it never reaches the standard altitude. */
  alwaysDown: boolean;
}

/** Geocentric altitude and the standard altitude for one instant. */
function riseSample(ms: number, lat: number, lon: number): { altitude: number; excess: number } {
  const jd = julianDay(ms);
  const moon = moonPosition(jdeFromJd(jd));
  const { altitude } = horizontalFrom(moon.ra, moon.dec, apparentSiderealTime(jd), lat, lon);
  return { altitude, excess: altitude - moonStandardAltitude(moon.parallax) };
}

function bisect(lo: number, hi: number, lat: number, lon: number, excessLo: number): number {
  let a = lo;
  let b = hi;
  let fa = excessLo;
  for (let i = 0; i < 30; i += 1) {
    const mid = (a + b) / 2;
    const fm = riseSample(mid, lat, lon).excess;
    if (fm === 0) return mid;
    if (fa < 0 === fm < 0) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
    }
  }
  return (a + b) / 2;
}

/**
 * Moonrise, moonset and transit inside a window, found by sampling the
 * altitude every ten minutes and bisecting each crossing. Sampling rather
 * than the interpolation of chapter 15 keeps it honest on the days when the
 * Moon rises twice or not at all, which happens roughly once a month because
 * the Moon comes up about fifty minutes later each day.
 */
export function moonEvents(startMs: number, endMs: number, lat: number, lon: number): DayEvents {
  const step = 10 * MS_PER_MINUTE;
  const samples: { ms: number; altitude: number; excess: number }[] = [];
  for (let ms = startMs; ms < endMs + step; ms += step) {
    const at = Math.min(ms, endMs);
    samples.push({ ms: at, ...riseSample(at, lat, lon) });
    if (at === endMs) break;
  }

  let rise: number | null = null;
  let set: number | null = null;
  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1];
    const after = samples[i];
    if (before.excess < 0 && after.excess >= 0 && rise === null) {
      rise = bisect(before.ms, after.ms, lat, lon, before.excess);
    } else if (before.excess >= 0 && after.excess < 0 && set === null) {
      set = bisect(before.ms, after.ms, lat, lon, before.excess);
    }
  }

  // Transit is the highest point, refined by a ternary search around the best
  // sample so the answer does not sit on the ten minute grid.
  const altitudeAt = (ms: number): number => riseSample(ms, lat, lon).altitude;
  let bestIndex = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].altitude > samples[bestIndex].altitude) bestIndex = i;
  }
  let lo = samples[Math.max(0, bestIndex - 1)].ms;
  let hi = samples[Math.min(samples.length - 1, bestIndex + 1)].ms;
  while (hi - lo > 2 * MS_PER_SECOND) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (altitudeAt(m1) < altitudeAt(m2)) lo = m1;
    else hi = m2;
  }
  const transitMs = (lo + hi) / 2;

  return {
    rise,
    set,
    transit: transitMs,
    peakAltitude: altitudeAt(transitMs),
    alwaysUp: samples.every((sample) => sample.excess >= 0),
    alwaysDown: samples.every((sample) => sample.excess < 0),
  };
}

/* ------------------------------------------------------------------ */
/* One snapshot of the Moon                                             */
/* ------------------------------------------------------------------ */

export interface MoonSnapshot {
  /** The instant this describes, epoch milliseconds in Universal Time. */
  ms: number;
  position: MoonPosition;
  sun: SunState;
  light: Illumination;
  /** Days since the last new moon. */
  ageDays: number;
  /** The name of the phase, one of the usual eight. */
  name: string;
  /** Brown lunation number of the current cycle. */
  lunation: number;
}

/** Everything the panel and the tool both need about one instant. */
export function moonSnapshot(ms: number): MoonSnapshot {
  const jd = julianDay(ms);
  const jde = jdeFromJd(jd);
  const position = moonPosition(jde);
  const sun = sunState(jde);
  const light = illumination(position, sun);
  const lastNew = previousPhase("new", ms);
  return {
    ms,
    position,
    sun,
    light,
    ageDays: (ms - lastNew.ms) / MS_PER_DAY,
    name: phaseName(light.phaseLongitude),
    lunation: lastNew.lunation,
  };
}

/* ------------------------------------------------------------------ */
/* Time zone formatting                                                 */
/* ------------------------------------------------------------------ */

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ZoneFields extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, fmt);
  }
  return fmt;
}

function fieldsIn(zone: string, ms: number): ZoneFields {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of a zone from UTC in minutes at a given instant. */
function offsetOf(zone: string, ms: number): number {
  const f = fieldsIn(zone, ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return Math.round((asUtc - ms) / MS_PER_MINUTE);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** "2026-08-30 18:45" in a zone, rounded to the nearest minute. */
function stamp(zone: string, ms: number): string {
  const f = fieldsIn(zone, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE);
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)} ${pad2(f.hour)}:${pad2(f.minute)}`;
}

/** "18:45" in a zone, with a day marker when it is not the day asked about. */
function clockOn(zone: string, ms: number, target: CalendarDate): string {
  const f = fieldsIn(zone, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE);
  const time = `${pad2(f.hour)}:${pad2(f.minute)}`;
  const diff = Math.round(
    (Date.UTC(f.year, f.month - 1, f.day) - Date.UTC(target.year, target.month - 1, target.day)) /
      MS_PER_DAY,
  );
  if (diff === 0) return time;
  if (diff === 1) return `${time} the next day`;
  if (diff === -1) return `${time} the day before`;
  return `${time} on ${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
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

function compassPoint(deg: number): string {
  return COMPASS[Math.round(mod360(deg) / 22.5) % 16];
}

function coordLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)} ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)} ${lon < 0 ? "W" : "E"}`;
}

/** Right ascension in hours, minutes and seconds. */
function raLabel(deg: number): string {
  const hours = mod360(deg) / 15;
  const h = Math.floor(hours);
  const minutes = (hours - h) * 60;
  const m = Math.floor(minutes);
  const s = (minutes - m) * 60;
  return `${pad2(h)}h ${pad2(m)}m ${s.toFixed(1).padStart(4, "0")}s`;
}

/** Declination in degrees, arcminutes and arcseconds. */
function decLabel(deg: number): string {
  const sign = deg < 0 ? "-" : "+";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minutes = (abs - d) * 60;
  const m = Math.floor(minutes);
  const s = (minutes - m) * 60;
  return `${sign}${pad2(d)} ${pad2(m)}' ${s.toFixed(0).padStart(2, "0")}"`;
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?Z?$/i;
const TIME_RE = /^(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i;
const TZ_PREFIX_RE = /^(?:tz|timezone|time\s*zone|zone|in)\s+(.+)$/i;

interface Location {
  label: string;
  lat: number;
  lon: number;
  zone?: string;
  place?: PlaceEntry;
}

function parseCoordinates(raw: string): { lat: number; lon: number } | null {
  const cleaned = raw
    .replace(/[°º]/g, " ")
    .replace(/\bdeg(?:rees)?\b/gi, " ")
    .replace(/[,;]/g, " ")
    .replace(/(\d)\s*([NSEW])/gi, "$1 $2")
    .replace(/([NSEW])\s*(\d)/gi, "$1 $2")
    .trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const tokens = cleaned.split(/\s+/);
  const values: { num: number; hemi?: string; token: string }[] = [];
  let pending: string | undefined;

  for (const token of tokens) {
    if (/^[NSEW]$/i.test(token)) {
      const hemi = token.toUpperCase();
      const last = values[values.length - 1];
      if (pending === undefined && last && last.hemi === undefined) last.hemi = hemi;
      else if (pending === undefined) pending = hemi;
      else return null;
      continue;
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(token)) {
      values.push({ num: Number(token), hemi: pending, token });
      pending = undefined;
      continue;
    }
    return null;
  }

  if (pending !== undefined || values.length !== 2) return null;

  let [first, second] = values;
  const northSouth = (h?: string): boolean => h === "N" || h === "S";
  const eastWest = (h?: string): boolean => h === "E" || h === "W";
  if (eastWest(first.hemi) || northSouth(second.hemi)) [first, second] = [second, first];

  const lat =
    first.hemi === "S"
      ? -Math.abs(first.num)
      : first.hemi === "N"
        ? Math.abs(first.num)
        : first.num;
  const lon =
    second.hemi === "W"
      ? -Math.abs(second.num)
      : second.hemi === "E"
        ? Math.abs(second.num)
        : second.num;

  if (!(Math.abs(lat) <= 90)) {
    throw new ToolError(
      "bad-coordinates",
      `Latitude "${first.token}" is outside the range -90 to 90.`,
      "Latitude runs from -90 at the south pole to 90 at the north pole.",
    );
  }
  if (!(Math.abs(lon) <= 180)) {
    throw new ToolError(
      "bad-coordinates",
      `Longitude "${second.token}" is outside the range -180 to 180.`,
      "Longitude runs from -180 to 180, negative west of Greenwich.",
    );
  }
  return { lat, lon };
}

function resolveLocation(raw: string): Location {
  const trimmed = raw.trim();
  const coords = parseCoordinates(trimmed);
  if (coords) {
    return { label: coordLabel(coords.lat, coords.lon), lat: coords.lat, lon: coords.lon };
  }
  const place = lookupPlace(trimmed);
  if (place) {
    return {
      label: `${place.name} (${coordLabel(place.lat, place.lon)})`,
      lat: place.lat,
      lon: place.lon,
      zone: place.zone,
      place,
    };
  }
  if (/\d/.test(trimmed)) {
    throw new ToolError(
      "bad-coordinates",
      `Could not read "${trimmed}" as a latitude and longitude.`,
      "Write the pair as decimal degrees, like: 40.7128, -74.0060 or 40.7128 N, 74.0060 W",
    );
  }
  throw new ToolError(
    "unknown-place",
    `"${trimmed}" is not a city this calculator knows.`,
    "Use a major city like tokyo, or enter the coordinates directly: 40.7128, -74.0060",
  );
}

function validateZone(raw: string): string {
  const name = raw.trim();
  if (/^(utc|gmt|z|zulu)$/i.test(name)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
    return name;
  } catch {
    throw new ToolError(
      "bad-timezone",
      `"${name}" is not a time zone name this calculator knows.`,
      "Use an IANA zone name like Europe/Berlin or America/New_York, or leave the line out for UTC.",
    );
  }
}

interface ParsedInput {
  location?: string;
  date?: CalendarDate;
  time?: { hour: number; minute: number; second: number };
  zone?: string;
}

function parseInput(input: string): ParsedInput {
  const lines = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const parsed: ParsedInput = {};
  for (const line of lines) {
    const asDate = DATE_RE.exec(line);
    if (asDate) {
      const year = Number(asDate[1]);
      const month = Number(asDate[2]);
      const day = Number(asDate[3]);
      const probe = new Date(Date.UTC(year, month - 1, day));
      if (
        probe.getUTCFullYear() !== year ||
        probe.getUTCMonth() + 1 !== month ||
        probe.getUTCDate() !== day
      ) {
        throw new ToolError(
          "bad-date",
          `There is no such date as ${asDate[1]}-${asDate[2]}-${asDate[3]}.`,
          "Use a real calendar date written like: 2026-08-30",
        );
      }
      if (year < MIN_YEAR || year > MAX_YEAR) {
        throw new ToolError(
          "date-out-of-range",
          `The year ${year} is outside the range this calculator covers.`,
          `Pick a date between ${MIN_YEAR} and ${MAX_YEAR}, where the series the maths is built on stays accurate.`,
        );
      }
      parsed.date = { year, month, day };
      if (asDate[4] !== undefined) {
        parsed.time = {
          hour: Number(asDate[4]),
          minute: Number(asDate[5]),
          second: asDate[6] === undefined ? 0 : Number(asDate[6]),
        };
      }
      continue;
    }
    const asTime = TIME_RE.exec(line);
    if (asTime && /^at\s/i.test(line)) {
      parsed.time = {
        hour: Number(asTime[1]),
        minute: Number(asTime[2]),
        second: asTime[3] === undefined ? 0 : Number(asTime[3]),
      };
      continue;
    }
    const asZone = TZ_PREFIX_RE.exec(line);
    if (asZone && (asZone[1].includes("/") || /^(utc|gmt|z|zulu)$/i.test(asZone[1].trim()))) {
      parsed.zone = validateZone(asZone[1]);
      continue;
    }
    if (line.includes("/") || /^(utc|gmt|z|zulu)$/i.test(line)) {
      parsed.zone = validateZone(line);
      continue;
    }
    if (parsed.location === undefined) {
      parsed.location = line;
      continue;
    }
    throw new ToolError(
      "bad-line",
      `Could not read "${line}" as a place, a date or a time zone.`,
      'One place, one date written like "2026-08-30", and one zone written like "tz Europe/Berlin".',
    );
  }

  if (
    parsed.time &&
    (parsed.time.hour > 23 || parsed.time.minute > 59 || parsed.time.second > 59)
  ) {
    throw new ToolError(
      "bad-time",
      "That is not a valid time of day.",
      "Write the time on a 24 hour clock, like: at 17:54",
    );
  }
  return parsed;
}

function readDetail(value: unknown): "summary" | "full" {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  const full = ["full", "all", "detailed", "detail", "everything", "advanced", "verbose"];
  return full.includes(raw) ? "full" : "summary";
}

function readHemisphere(value: unknown): "north" | "south" {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["south", "southern", "s", "down under"].includes(raw) ? "south" : "north";
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface MoonOpts {
  /** "summary" (default) or "full". */
  detail?: string;
  /** "north" (default) or "south": which way up the disc is drawn. */
  hemisphere?: string;
  /**
   * Epoch milliseconds standing in for "now". Injected by tests so the output
   * is deterministic; not exposed as a user option.
   */
  now?: number;
  [key: string]: unknown;
}

export type MoonResult = Record<string, string>;

function formatDays(days: number): string {
  const whole = Math.floor(days);
  const hours = Math.round((days - whole) * 24);
  const carried = hours === 24 ? whole + 1 : whole;
  const shownHours = hours === 24 ? 0 : hours;
  return `${days.toFixed(2)} days (${carried} ${carried === 1 ? "day" : "days"} and ${shownHours} ${shownHours === 1 ? "hour" : "hours"} since the new moon)`;
}

export function run(input: string, opts: MoonOpts = {}): MoonResult {
  const detail = readDetail(opts.detail);
  const hemisphere = readHemisphere(opts.hemisphere);
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  const parsed = parseInput(input);
  const location = parsed.location === undefined ? null : resolveLocation(parsed.location);

  const zone = parsed.zone ?? location?.zone ?? "UTC";
  const zoneSource = parsed.zone
    ? "set on its own line of the input"
    : location?.zone
      ? `the home zone of ${location.place?.name ?? location.label}`
      : "no zone was given, so times are UTC";

  const todayFields = fieldsIn(zone, now);
  const target: CalendarDate = parsed.date ?? {
    year: todayFields.year,
    month: todayFields.month,
    day: todayFields.day,
  };

  if (target.year < MIN_YEAR || target.year > MAX_YEAR) {
    throw new ToolError(
      "date-out-of-range",
      `The year ${target.year} is outside the range this calculator covers.`,
      `Pick a date between ${MIN_YEAR} and ${MAX_YEAR}.`,
    );
  }

  // The instant the report is about. With no date at all it is right now; with
  // a date but no time it is local noon, which is the moment that best
  // describes "the moon on that day".
  let momentMs: number;
  let momentSource: string;
  if (!parsed.date && !parsed.time) {
    momentMs = now;
    momentSource = "right now";
  } else {
    const local = parsed.time ?? { hour: 12, minute: 0, second: 0 };
    const guess = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      local.hour,
      local.minute,
      local.second,
    );
    momentMs = guess - offsetOf(zone, guess) * MS_PER_MINUTE;
    // One more pass settles the rare case where the guess landed on the other
    // side of a daylight saving change from the answer.
    momentMs = guess - offsetOf(zone, momentMs) * MS_PER_MINUTE;
    momentSource = parsed.time ? "taken from the input" : "local noon on the date given";
  }

  const snapshot = moonSnapshot(momentMs);
  const { position, light } = snapshot;

  const out: MoonResult = {};

  out.Moment = `${stamp(zone, momentMs)} ${zone === "UTC" ? "UTC" : `${zone} (${offsetLabel(offsetOf(zone, momentMs))})`}, ${momentSource}`;
  if (location) out.Location = location.label;
  out.Phase = snapshot.name;
  out.Illumination = `${(light.fraction * 100).toFixed(1)}% of the disc is lit, and ${light.waxing ? "growing" : "shrinking"}`;
  out.Age = formatDays(snapshot.ageDays);
  out.Distance = `${Math.round(position.distanceKm).toLocaleString("en-US")} km from the center of the Earth`;
  out["Angular diameter"] = `${(position.semidiameter * 2 * 60).toFixed(1)} arcminutes`;

  const upcoming: PhaseKind[] = ["new", "first-quarter", "full", "last-quarter"];
  for (const kind of upcoming) {
    const event = nextPhase(kind, momentMs);
    out[`Next ${PHASE_LABELS[kind].toLowerCase()}`] =
      `${stamp(zone, event.ms)}${zone === "UTC" ? " UTC" : ""}, in ${((event.ms - momentMs) / MS_PER_DAY).toFixed(1)} days`;
  }

  if (location) {
    // The events of the local calendar day the moment falls in.
    const dayStartGuess = Date.UTC(target.year, target.month - 1, target.day);
    const dayStart = dayStartGuess - offsetOf(zone, dayStartGuess) * MS_PER_MINUTE;
    const events = moonEvents(dayStart, dayStart + MS_PER_DAY, location.lat, location.lon);

    out.Moonrise =
      events.rise === null
        ? events.alwaysUp
          ? "The moon is above the horizon all day."
          : "The moon does not rise on this date."
        : clockOn(zone, events.rise, target);
    out.Moonset =
      events.set === null
        ? events.alwaysDown
          ? "The moon is below the horizon all day."
          : "The moon does not set on this date."
        : clockOn(zone, events.set, target);
    out["Highest point"] =
      `${clockOn(zone, events.transit, target)}, ${events.peakAltitude.toFixed(1)} degrees up`;

    const sidereal = apparentSiderealTime(julianDay(momentMs));
    const topo = topocentricMoon(position, sidereal, location.lat, location.lon);
    const horizontal = horizontalFrom(topo.ra, topo.dec, sidereal, location.lat, location.lon);
    out["Altitude now"] =
      `${horizontal.altitude.toFixed(1)} degrees${horizontal.altitude < 0 ? ", below the horizon" : ""}`;
    out["Azimuth now"] =
      `${horizontal.azimuth.toFixed(1)} degrees, ${compassPoint(horizontal.azimuth)}`;
  }

  out["Disc drawn for"] =
    hemisphere === "south"
      ? "The southern hemisphere, so a waxing moon is lit on the left."
      : "The northern hemisphere, so a waxing moon is lit on the right.";

  if (detail === "full") {
    out["Time zone"] = zone === "UTC" ? `UTC, ${zoneSource}` : `${zone}, ${zoneSource}`;
    out["Ecliptic longitude"] = `${position.longitude.toFixed(4)} degrees`;
    out["Ecliptic latitude"] = `${position.latitude.toFixed(4)} degrees`;
    out["Right ascension"] = raLabel(position.ra);
    out.Declination = decLabel(position.dec);
    out["Elongation from the sun"] = `${light.elongation.toFixed(2)} degrees`;
    out["Phase angle"] = `${light.phaseAngle.toFixed(2)} degrees`;
    out["Position angle of the bright limb"] = `${light.brightLimbAngle.toFixed(1)} degrees`;
    out["Horizontal parallax"] = `${(position.parallax * 60).toFixed(2)} arcminutes`;
    out.Lunation = `Brown lunation number ${snapshot.lunation}`;
    out["Delta T"] =
      `${deltaTSeconds(julianDay(momentMs)).toFixed(1)} seconds, added to civil time to get the dynamical time the phase series works in`;
    out["Terminator path"] = terminatorPath(light.fraction, light.waxing, {
      southern: hemisphere === "south",
    });
  }

  return out;
}

export default { run } satisfies ToolLogic<string, MoonResult, MoonOpts>;
