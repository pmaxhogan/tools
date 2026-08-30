/**
 * Where the Sun, the Moon and the naked eye planets are, from any place on
 * any date.
 *
 * The planets come from the approximate Keplerian elements published by the
 * Solar System Dynamics group at JPL, E. M. Standish, "Keplerian Elements for
 * Approximate Positions of the Major Planets", which is the table reprinted in
 * the Explanatory Supplement and at
 * https://ssd.jpl.nasa.gov/planets/approx_pos.html. Each planet gets six
 * elements and six rates per Julian century, valid from 1800 to 2050, and the
 * quoted accuracy over that span runs from a few arcseconds for the inner
 * planets to about one arcminute for Neptune. That is a real ephemeris in
 * miniature, not a fit to a lookup table, but it is not a full theory: expect
 * arcminutes, not arcseconds.
 *
 * The Moon is the truncated ELP2000-82 series from Meeus chapter 47, which
 * this site already implements for the moon phase calculator, so the two tools
 * cannot disagree about where the Moon is.
 *
 * Also here:
 *   Meeus ch. 21  precession from J2000 to the equinox of date
 *   Meeus ch. 23  nutation applied to right ascension and declination
 *   Meeus ch. 41  the visual magnitude formulas from the Astronomical Almanac
 *   Meeus ch. 45  the tilt of Saturn's rings, which is worth up to half a
 *                 magnitude and is the reason Saturn is not simply a number
 *
 * Everything here is pure arithmetic plus Intl for time zone formatting. No
 * DOM, no network, no storage (PROJECT.md rule 27).
 */

import { ToolError, type ToolLogic } from "../types";
// The city table lives with the sun calculator, which authored it, and the
// lunar series lives with the moon phase calculator. Both are read only here:
// one gazetteer and one lunar theory for the whole site.
import { lookupPlace, type PlaceEntry } from "../sunrise-sunset-calculator/places";
import {
  apparentSiderealTime,
  horizontalFrom,
  jdeFromJd,
  julianDay,
  moonPosition,
  moonStandardAltitude,
  nutation,
  topocentricMoon,
} from "../moon-phase-calculator/index";

/* ------------------------------------------------------------------ */
/* Units and small helpers                                              */
/* ------------------------------------------------------------------ */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

/** One astronomical unit in kilometers (IAU 2012). */
const AU_KM = 149_597_870.7;

/** Days light takes to cross one astronomical unit. */
const LIGHT_TIME_PER_AU = 0.005_775_518_3;

/** Standish's table is fitted to this window and is not honest outside it. */
export const MIN_YEAR = 1800;
export const MAX_YEAR = 2050;

const sinD = (deg: number): number => Math.sin(deg * RAD);
const cosD = (deg: number): number => Math.cos(deg * RAD);
const tanD = (deg: number): number => Math.tan(deg * RAD);
const asinD = (x: number): number => Math.asin(Math.max(-1, Math.min(1, x))) * DEG;
const acosD = (x: number): number => Math.acos(Math.max(-1, Math.min(1, x))) * DEG;
const atan2D = (y: number, x: number): number => Math.atan2(y, x) * DEG;

function mod360(deg: number): number {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
}

function wrap180(deg: number): number {
  return mod360(deg + 180) - 180;
}

function centuries(jd: number): number {
  return (jd - 2451545) / 36525;
}

type Vector = readonly [number, number, number];

function subtract(a: Vector, b: Vector): Vector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function magnitudeOf(v: Vector): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/* ------------------------------------------------------------------ */
/* The approximate Keplerian elements (JPL, Standish)                   */
/* ------------------------------------------------------------------ */

/**
 * One row of Standish's table: the element at J2000 and its rate per Julian
 * century, in the order semimajor axis (au), eccentricity, inclination,
 * mean longitude, longitude of perihelion, longitude of the ascending node.
 * All angles are degrees, referred to the mean ecliptic and equinox of J2000.
 */
interface Elements {
  a: readonly [number, number];
  e: readonly [number, number];
  i: readonly [number, number];
  l: readonly [number, number];
  peri: readonly [number, number];
  node: readonly [number, number];
}

const ELEMENTS: Record<string, Elements> = {
  mercury: {
    a: [0.38709927, 0.00000037],
    e: [0.20563593, 0.00001906],
    i: [7.00497902, -0.00594749],
    l: [252.2503235, 149472.67411175],
    peri: [77.45779628, 0.16047689],
    node: [48.33076593, -0.12534081],
  },
  venus: {
    a: [0.72333566, 0.0000039],
    e: [0.00677672, -0.00004107],
    i: [3.39467605, -0.0007889],
    l: [181.9790995, 58517.81538729],
    peri: [131.60246718, 0.00268329],
    node: [76.67984255, -0.27769418],
  },
  earth: {
    a: [1.00000261, 0.00000562],
    e: [0.01671123, -0.00004392],
    i: [-0.00001531, -0.01294668],
    l: [100.46457166, 35999.37244981],
    peri: [102.93768193, 0.32327364],
    node: [0, 0],
  },
  mars: {
    a: [1.52371034, 0.00001847],
    e: [0.0933941, 0.00007882],
    i: [1.84969142, -0.00813131],
    l: [-4.55343205, 19140.30268499],
    peri: [-23.94362959, 0.44441088],
    node: [49.55953891, -0.29257343],
  },
  jupiter: {
    a: [5.202887, -0.00011607],
    e: [0.04838624, -0.00013253],
    i: [1.30439695, -0.00183714],
    l: [34.39644051, 3034.74612775],
    peri: [14.72847983, 0.21252668],
    node: [100.47390909, 0.20469106],
  },
  saturn: {
    a: [9.53667594, -0.0012506],
    e: [0.05386179, -0.00050991],
    i: [2.48599187, 0.00193609],
    l: [49.95424423, 1222.49362201],
    peri: [92.59887831, -0.41897216],
    node: [113.66242448, -0.28867794],
  },
  uranus: {
    a: [19.18916464, -0.00196176],
    e: [0.04725744, -0.00004397],
    i: [0.77263783, -0.00242939],
    l: [313.23810451, 428.48202785],
    peri: [170.9542763, 0.40805281],
    node: [74.01692503, 0.04240589],
  },
  neptune: {
    a: [30.06992276, 0.00026291],
    e: [0.00859048, 0.00005105],
    i: [1.77004347, 0.00035372],
    l: [-55.12002969, 218.45945325],
    peri: [44.96476227, -0.32241464],
    node: [131.78422574, -0.00508664],
  },
};

/**
 * Heliocentric rectangular coordinates in the mean ecliptic and equinox of
 * J2000, in astronomical units, following Standish's own recipe: propagate the
 * elements, solve Kepler's equation, then rotate the orbital plane into the
 * ecliptic.
 */
export function heliocentric(planet: string, jde: number): Vector {
  const el = ELEMENTS[planet];
  const t = centuries(jde);

  const a = el.a[0] + el.a[1] * t;
  const e = el.e[0] + el.e[1] * t;
  const inclination = el.i[0] + el.i[1] * t;
  const meanLongitude = el.l[0] + el.l[1] * t;
  const perihelion = el.peri[0] + el.peri[1] * t;
  const node = el.node[0] + el.node[1] * t;

  const argument = perihelion - node;
  const meanAnomaly = wrap180(meanLongitude - perihelion);

  // Kepler's equation, in degrees, with the eccentricity expressed in degrees
  // so the whole solve stays in one unit.
  const eStar = e * DEG;
  let eccentricAnomaly = meanAnomaly + eStar * sinD(meanAnomaly);
  for (let i = 0; i < 32; i += 1) {
    const residual = meanAnomaly - (eccentricAnomaly - eStar * sinD(eccentricAnomaly));
    const step = residual / (1 - e * cosD(eccentricAnomaly));
    eccentricAnomaly += step;
    if (Math.abs(step) < 1e-11) break;
  }

  // In the orbital plane, with the x axis toward perihelion.
  const xOrbit = a * (cosD(eccentricAnomaly) - e);
  const yOrbit = a * Math.sqrt(1 - e * e) * sinD(eccentricAnomaly);

  const cosArg = cosD(argument);
  const sinArg = sinD(argument);
  const cosNode = cosD(node);
  const sinNode = sinD(node);
  const cosInc = cosD(inclination);
  const sinInc = sinD(inclination);

  return [
    (cosArg * cosNode - sinArg * sinNode * cosInc) * xOrbit +
      (-sinArg * cosNode - cosArg * sinNode * cosInc) * yOrbit,
    (cosArg * sinNode + sinArg * cosNode * cosInc) * xOrbit +
      (-sinArg * sinNode + cosArg * cosNode * cosInc) * yOrbit,
    sinArg * sinInc * xOrbit + cosArg * sinInc * yOrbit,
  ];
}

/* ------------------------------------------------------------------ */
/* Frames: ecliptic to equatorial, precession, nutation                 */
/* ------------------------------------------------------------------ */

/** Obliquity of the ecliptic at J2000, degrees. */
const OBLIQUITY_J2000 = 23.43928;

/** Ecliptic rectangular coordinates to equatorial right ascension and declination. */
function eclipticVectorToEquatorial(v: Vector): { ra: number; dec: number; distance: number } {
  const distance = magnitudeOf(v);
  const yEq = v[1] * cosD(OBLIQUITY_J2000) - v[2] * sinD(OBLIQUITY_J2000);
  const zEq = v[1] * sinD(OBLIQUITY_J2000) + v[2] * cosD(OBLIQUITY_J2000);
  return { ra: mod360(atan2D(yEq, v[0])), dec: asinD(zEq / distance), distance };
}

/**
 * Precession of right ascension and declination from J2000 to the equinox of
 * date, Meeus formulas 21.2 and 21.4. Between J2000 and the present this is
 * worth about a third of a degree, so leaving it out would be the single
 * largest error in the whole calculation.
 */
export function precessFromJ2000(ra: number, dec: number, t: number): { ra: number; dec: number } {
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) / 3600;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) / 3600;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) / 3600;

  const a = cosD(dec) * sinD(ra + zeta);
  const b = cosD(theta) * cosD(dec) * cosD(ra + zeta) - sinD(theta) * sinD(dec);
  const c = sinD(theta) * cosD(dec) * cosD(ra + zeta) + cosD(theta) * sinD(dec);
  return { ra: mod360(atan2D(a, b) + z), dec: asinD(c) };
}

/** Nutation applied to right ascension and declination, Meeus formula 23.1. */
function applyNutation(ra: number, dec: number, t: number): { ra: number; dec: number } {
  const { dPsi, dEps, epsilon } = nutation(t);
  const dRa =
    (cosD(epsilon) + sinD(epsilon) * sinD(ra) * tanD(dec)) * dPsi - cosD(ra) * tanD(dec) * dEps;
  const dDec = sinD(epsilon) * cosD(ra) * dPsi + sinD(ra) * dEps;
  return { ra: mod360(ra + dRa), dec: dec + dDec };
}

/**
 * The general precession in longitude between J2000 and the equinox of date,
 * degrees. Used to read an ecliptic longitude of date back onto the J2000
 * grid the constellation boundaries are published on.
 */
function precessionInLongitude(t: number): number {
  return 1.396971 * t + 0.0003086 * t * t;
}

/* ------------------------------------------------------------------ */
/* Constellations along the ecliptic                                    */
/* ------------------------------------------------------------------ */

/**
 * Where the ecliptic crosses each IAU constellation boundary, as a J2000
 * ecliptic longitude in degrees. This is a band lookup, not the full Delporte
 * boundary table: it answers "which constellation does the ecliptic run
 * through at this longitude", which is the right answer for a body close to
 * the ecliptic and can be one constellation out for a body several degrees
 * off it. Every entry is [start longitude, name]; the band runs to the next
 * start, wrapping at 360.
 */
const ECLIPTIC_BANDS: readonly (readonly [number, string])[] = [
  [28.7, "Aries"],
  [53.5, "Taurus"],
  [90.4, "Gemini"],
  [118.3, "Cancer"],
  [138.1, "Leo"],
  [174, "Virgo"],
  [217.8, "Libra"],
  [241.1, "Scorpius"],
  [247.8, "Ophiuchus"],
  [266.6, "Sagittarius"],
  [299.7, "Capricornus"],
  [327.6, "Aquarius"],
  [351.6, "Pisces"],
];

/** How far off the ecliptic a body can be before the band lookup gets shaky. */
const BAND_CAUTION_LATITUDE = 4;

export function constellationAt(longitudeJ2000: number): string {
  const lon = mod360(longitudeJ2000);
  let name = "Pisces";
  for (const [start, label] of ECLIPTIC_BANDS) {
    if (lon >= start) name = label;
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Magnitudes (Meeus ch. 41, the Astronomical Almanac expressions)      */
/* ------------------------------------------------------------------ */

/**
 * The saturnicentric latitude of the Earth, degrees: how far the rings are
 * tilted out of edge on. Meeus formula 45.1, using the geocentric ecliptic
 * position of Saturn referred to the equinox of date.
 */
function saturnRingLatitude(lambda: number, beta: number, t: number): number {
  const inclination = 28.075 - 0.012 * t;
  const node = 169.508 + 3.23 * t;
  return asinD(
    sinD(inclination) * cosD(beta) * sinD(lambda - node) - cosD(inclination) * sinD(beta),
  );
}

interface MagnitudeInput {
  /** Distance from the Sun, au. */
  r: number;
  /** Distance from Earth, au. */
  delta: number;
  /** Phase angle Sun-body-Earth, degrees. */
  phaseAngle: number;
  /** Saturnicentric latitude of Earth, degrees, for Saturn only. */
  ringLatitude?: number;
}

function visualMagnitude(body: string, input: MagnitudeInput): number {
  const { r, delta, phaseAngle: i } = input;
  const base = 5 * Math.log10(r * delta);
  switch (body) {
    case "mercury":
      return -0.42 + base + 0.038 * i - 0.000273 * i * i + 0.000002 * i ** 3;
    case "venus":
      return -4.4 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i ** 3;
    case "mars":
      return -1.52 + base + 0.016 * i;
    case "jupiter":
      return -9.4 + base + 0.005 * i;
    case "saturn": {
      const b = input.ringLatitude ?? 0;
      // The rings are worth up to half a magnitude when they are wide open and
      // nothing when they are edge on, which is why Saturn brightens and fades
      // on a fifteen year rhythm that has nothing to do with its distance.
      return -8.88 + base - 2.6 * Math.abs(sinD(b)) + 1.25 * sinD(b) * sinD(b);
    }
    case "uranus":
      return -7.19 + base + 0.0028 * i;
    case "neptune":
      return -6.87 + base;
    case "sun":
      return -26.74 + 5 * Math.log10(delta);
    case "moon":
      // The standard lunar phase law, referred to the mean distance.
      return (
        -12.73 + 0.026 * Math.abs(i) + 4e-9 * i ** 4 + 5 * Math.log10((delta * AU_KM) / 384400)
      );
    default:
      return Number.NaN;
  }
}

/* ------------------------------------------------------------------ */
/* One body at one instant                                              */
/* ------------------------------------------------------------------ */

export const BODY_IDS = [
  "sun",
  "moon",
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
] as const;

export type BodyId = (typeof BODY_IDS)[number];

export const BODY_NAMES: Record<BodyId, string> = {
  sun: "Sun",
  moon: "Moon",
  mercury: "Mercury",
  venus: "Venus",
  mars: "Mars",
  jupiter: "Jupiter",
  saturn: "Saturn",
  uranus: "Uranus",
  neptune: "Neptune",
};

export interface BodyState {
  id: BodyId;
  name: string;
  /** Apparent right ascension, degrees, equinox and equator of date. */
  ra: number;
  /** Apparent declination, degrees, equinox and equator of date. */
  dec: number;
  /** Geocentric ecliptic longitude of date, degrees. */
  eclipticLongitude: number;
  /** Geocentric ecliptic latitude, degrees. */
  eclipticLatitude: number;
  /** Distance from Earth, astronomical units. */
  distanceAu: number;
  /** Distance from the Sun, astronomical units. Zero for the Sun itself. */
  sunDistanceAu: number;
  /** Phase angle Sun-body-Earth, degrees. */
  phaseAngle: number;
  /** Illuminated fraction of the disc, 0 to 1. */
  illuminatedFraction: number;
  /** Estimated visual magnitude. */
  magnitude: number;
  /** Angular separation from the Sun, degrees. */
  elongation: number;
  /** Which side of the Sun the body sits on. Empty for the Sun itself. */
  elongationSide: "east" | "west" | "";
  /** The constellation the ecliptic runs through at this longitude. */
  constellation: string;
  /** True when the body is far enough off the ecliptic to doubt that name. */
  constellationUncertain: boolean;
  /** Standard altitude for the rise and set of this body, degrees. */
  standardAltitude: number;
}

/** Ecliptic longitude and latitude of date from apparent right ascension and declination. */
function equatorialToEcliptic(
  ra: number,
  dec: number,
  epsilon: number,
): { longitude: number; latitude: number } {
  return {
    longitude: mod360(atan2D(sinD(ra) * cosD(epsilon) + tanD(dec) * sinD(epsilon), cosD(ra))),
    latitude: asinD(sinD(dec) * cosD(epsilon) - cosD(dec) * sinD(epsilon) * sinD(ra)),
  };
}

/** The geocentric ecliptic vector of a planet, corrected for light time. */
function geocentricVector(planet: string, jde: number, earth: Vector): Vector {
  let vector = subtract(heliocentric(planet, jde), earth);
  for (let i = 0; i < 2; i += 1) {
    const tau = LIGHT_TIME_PER_AU * magnitudeOf(vector);
    vector = subtract(heliocentric(planet, jde - tau), earth);
  }
  return vector;
}

/**
 * Everything about one body at one instant, in the equator and equinox of
 * date. Aberration is left out, which is worth at most 21 arcseconds, well
 * inside the arcminute the elements themselves are good for.
 */
export function bodyState(id: BodyId, ms: number): BodyState {
  const jd = julianDay(ms);
  const jde = jdeFromJd(jd);
  const t = centuries(jde);
  const { epsilon } = nutation(t);
  const earth = heliocentric("earth", jde);
  const earthDistance = magnitudeOf(earth);

  let ra: number;
  let dec: number;
  let distanceAu: number;
  let sunDistanceAu: number;
  let standardAltitude: number;

  if (id === "moon") {
    const moon = moonPosition(jde);
    ra = moon.ra;
    dec = moon.dec;
    distanceAu = moon.distanceKm / AU_KM;
    standardAltitude = moonStandardAltitude(moon.parallax);
    // The Moon's distance from the Sun closes the Sun, Moon, Earth triangle.
    const cosElongation = cosD(moon.latitude) * cosD(moon.longitude - sunLongitudeOfDate(earth, t));
    sunDistanceAu = Math.sqrt(
      earthDistance * earthDistance +
        distanceAu * distanceAu -
        2 * earthDistance * distanceAu * cosElongation,
    );
  } else if (id === "sun") {
    // The Sun sits at the origin of these elements, so its geocentric place is
    // simply the reverse of the Earth's, less the 20.5 arcsecond aberration
    // that the Earth's own motion puts on it.
    const vector: Vector = [-earth[0], -earth[1], -earth[2]];
    const equatorial = eclipticVectorToEquatorial(vector);
    const precessed = precessFromJ2000(equatorial.ra, equatorial.dec, t);
    const ecliptic = equatorialToEcliptic(precessed.ra, precessed.dec, epsilon);
    const aberrated = equatorialFromEcliptic(
      ecliptic.longitude - 0.00569,
      ecliptic.latitude,
      epsilon,
    );
    const nutated = applyNutation(aberrated.ra, aberrated.dec, t);
    ra = nutated.ra;
    dec = nutated.dec;
    distanceAu = earthDistance;
    sunDistanceAu = 0;
    standardAltitude = -0.8333;
  } else {
    const vector = geocentricVector(id, jde, earth);
    const equatorial = eclipticVectorToEquatorial(vector);
    const precessed = precessFromJ2000(equatorial.ra, equatorial.dec, t);
    const nutated = applyNutation(precessed.ra, precessed.dec, t);
    ra = nutated.ra;
    dec = nutated.dec;
    distanceAu = equatorial.distance;
    sunDistanceAu = magnitudeOf(heliocentric(id, jde - LIGHT_TIME_PER_AU * distanceAu));
    standardAltitude = -0.5667;
  }

  const ecliptic = equatorialToEcliptic(ra, dec, epsilon);

  // The Sun, body and Earth triangle gives both the elongation and the phase.
  let elongation: number;
  let phaseAngle: number;
  if (id === "sun") {
    elongation = 0;
    phaseAngle = 0;
  } else {
    elongation = acosD(
      (earthDistance * earthDistance + distanceAu * distanceAu - sunDistanceAu * sunDistanceAu) /
        (2 * earthDistance * distanceAu),
    );
    phaseAngle = acosD(
      (sunDistanceAu * sunDistanceAu + distanceAu * distanceAu - earthDistance * earthDistance) /
        (2 * sunDistanceAu * distanceAu),
    );
  }

  const sunEcliptic = sunLongitudeOfDate(earth, t);
  const side: "east" | "west" | "" =
    id === "sun" ? "" : mod360(ecliptic.longitude - sunEcliptic) < 180 ? "east" : "west";

  const ringLatitude =
    id === "saturn" ? saturnRingLatitude(ecliptic.longitude, ecliptic.latitude, t) : undefined;

  return {
    id,
    name: BODY_NAMES[id],
    ra,
    dec,
    eclipticLongitude: ecliptic.longitude,
    eclipticLatitude: ecliptic.latitude,
    distanceAu,
    sunDistanceAu,
    phaseAngle,
    illuminatedFraction: id === "sun" ? 1 : (1 + cosD(phaseAngle)) / 2,
    magnitude: visualMagnitude(id, {
      r: sunDistanceAu,
      delta: distanceAu,
      phaseAngle,
      ringLatitude,
    }),
    elongation,
    elongationSide: side,
    constellation: constellationAt(ecliptic.longitude - precessionInLongitude(t)),
    constellationUncertain: Math.abs(ecliptic.latitude) > BAND_CAUTION_LATITUDE,
    standardAltitude,
  };
}

/** Ecliptic to equatorial for one direction, degrees in and degrees out. */
function equatorialFromEcliptic(
  longitude: number,
  latitude: number,
  epsilon: number,
): { ra: number; dec: number } {
  return {
    ra: mod360(
      atan2D(sinD(longitude) * cosD(epsilon) - tanD(latitude) * sinD(epsilon), cosD(longitude)),
    ),
    dec: asinD(sinD(latitude) * cosD(epsilon) + cosD(latitude) * sinD(epsilon) * sinD(longitude)),
  };
}

/** The Sun's geocentric ecliptic longitude of date, from the Earth's own place. */
function sunLongitudeOfDate(earth: Vector, t: number): number {
  const j2000 = mod360(atan2D(-earth[1], -earth[0]));
  return mod360(j2000 + precessionInLongitude(t));
}

/* ------------------------------------------------------------------ */
/* Rise, transit and set                                                */
/* ------------------------------------------------------------------ */

export interface SkyEvents {
  rise: number | null;
  set: number | null;
  transit: number;
  peakAltitude: number;
  alwaysUp: boolean;
  alwaysDown: boolean;
}

interface Sample {
  ms: number;
  altitude: number;
  excess: number;
}

function sampleAt(id: BodyId, ms: number, lat: number, lon: number): Sample {
  const state = bodyState(id, ms);
  const sidereal = apparentSiderealTime(julianDay(ms));
  const { altitude } = horizontalFrom(state.ra, state.dec, sidereal, lat, lon);
  return { ms, altitude, excess: altitude - state.standardAltitude };
}

/**
 * Rise, transit and set inside a window, by sampling the altitude every ten
 * minutes and bisecting the crossings. The positions are recomputed at every
 * sample rather than held fixed for the day, which is what lets the same code
 * serve the Moon, whose right ascension moves half a degree an hour.
 */
export function skyEvents(
  id: BodyId,
  startMs: number,
  endMs: number,
  lat: number,
  lon: number,
): SkyEvents {
  const step = 10 * MS_PER_MINUTE;
  const samples: Sample[] = [];
  for (let ms = startMs; ms < endMs + step; ms += step) {
    const at = Math.min(ms, endMs);
    samples.push(sampleAt(id, at, lat, lon));
    if (at === endMs) break;
  }

  const bisect = (lo: number, hi: number, excessLo: number): number => {
    let a = lo;
    let b = hi;
    let fa = excessLo;
    for (let i = 0; i < 26; i += 1) {
      const mid = (a + b) / 2;
      const fm = sampleAt(id, mid, lat, lon).excess;
      if (fm === 0) return mid;
      if (fa < 0 === fm < 0) {
        a = mid;
        fa = fm;
      } else {
        b = mid;
      }
    }
    return (a + b) / 2;
  };

  let rise: number | null = null;
  let set: number | null = null;
  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1];
    const after = samples[i];
    if (before.excess < 0 && after.excess >= 0 && rise === null) {
      rise = bisect(before.ms, after.ms, before.excess);
    } else if (before.excess >= 0 && after.excess < 0 && set === null) {
      set = bisect(before.ms, after.ms, before.excess);
    }
  }

  let bestIndex = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].altitude > samples[bestIndex].altitude) bestIndex = i;
  }
  let lo = samples[Math.max(0, bestIndex - 1)].ms;
  let hi = samples[Math.min(samples.length - 1, bestIndex + 1)].ms;
  while (hi - lo > 10 * MS_PER_SECOND) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (sampleAt(id, m1, lat, lon).altitude < sampleAt(id, m2, lat, lon).altitude) lo = m1;
    else hi = m2;
  }
  const transit = (lo + hi) / 2;

  return {
    rise,
    set,
    transit,
    peakAltitude: sampleAt(id, transit, lat, lon).altitude,
    alwaysUp: samples.every((sample) => sample.excess >= 0),
    alwaysDown: samples.every((sample) => sample.excess < 0),
  };
}

/* ------------------------------------------------------------------ */
/* Is it visible?                                                       */
/* ------------------------------------------------------------------ */

/** The faintest a body can be and still be seen by eye in a dark country sky. */
const NAKED_EYE_LIMIT = 6;

export function visibilityNote(
  id: BodyId,
  altitude: number,
  magnitude: number,
  sunAltitude: number,
): string {
  if (id === "sun") {
    return altitude > -0.8333 ? "Yes, the sun is up." : "No, the sun is below the horizon.";
  }
  if (altitude <= 0) return "No, it is below the horizon.";
  if (magnitude > NAKED_EYE_LIMIT) {
    return "No, it is too faint for the unaided eye. Binoculars or a telescope will show it.";
  }
  if (sunAltitude > -0.8333) {
    if (id === "moon") return "Yes, though a daytime moon is pale against a blue sky.";
    if (magnitude < -3)
      return "Yes, if you know exactly where to look: it is bright enough for a daylight sky.";
    return "No, the sun is up and washes it out.";
  }
  if (sunAltitude > -6) {
    return magnitude < 2
      ? "Yes, in the bright twilight."
      : "Not yet, the twilight is still too bright.";
  }
  if (sunAltitude > -12) {
    return magnitude < 4 ? "Yes, in the twilight." : "Only just, the sky is not fully dark.";
  }
  return magnitude < 4.5
    ? "Yes, in a dark sky."
    : "Yes in a dark country sky, though light pollution will hide it from a town.";
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

function offsetOf(zone: string, ms: number): number {
  const f = fieldsIn(zone, ms);
  return Math.round(
    (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - ms) / MS_PER_MINUTE,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function stamp(zone: string, ms: number): string {
  const f = fieldsIn(zone, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE);
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)} ${pad2(f.hour)}:${pad2(f.minute)}`;
}

function clockOn(zone: string, ms: number, target: CalendarDate): string {
  const f = fieldsIn(zone, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE);
  const time = `${pad2(f.hour)}:${pad2(f.minute)}`;
  const diff = Math.round(
    (Date.UTC(f.year, f.month - 1, f.day) - Date.UTC(target.year, target.month - 1, target.day)) /
      MS_PER_DAY,
  );
  if (diff === 0) return time;
  if (diff === 1) return `${time} next day`;
  if (diff === -1) return `${time} previous day`;
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

function raLabel(deg: number): string {
  const hours = mod360(deg) / 15;
  const h = Math.floor(hours);
  const minutes = (hours - h) * 60;
  const m = Math.floor(minutes);
  const s = (minutes - m) * 60;
  return `${pad2(h)}h ${pad2(m)}m ${s.toFixed(1).padStart(4, "0")}s`;
}

function decLabel(deg: number): string {
  const sign = deg < 0 ? "-" : "+";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minutes = (abs - d) * 60;
  const m = Math.floor(minutes);
  const s = (minutes - m) * 60;
  return `${sign}${pad2(d)} ${pad2(m)}' ${s.toFixed(0).padStart(2, "0")}"`;
}

function signedMagnitude(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
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
          `The year ${year} is outside the range the orbital elements are fitted to.`,
          `Pick a date between ${MIN_YEAR} and ${MAX_YEAR}. Outside that window the JPL approximate elements drift far enough to be misleading.`,
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
      "Write the time on a 24 hour clock, like: at 21:30",
    );
  }
  return parsed;
}

function readDetail(value: unknown): "summary" | "full" {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["full", "all", "detailed", "detail", "everything", "advanced", "verbose"].includes(raw)
    ? "full"
    : "summary";
}

type Order = "traditional" | "brightest" | "highest";

function readOrder(value: unknown): Order {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["brightest", "brightness", "magnitude", "bright"].includes(raw)) return "brightest";
  if (["highest", "altitude", "sky", "up"].includes(raw)) return "highest";
  return "traditional";
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface PlanetOpts {
  /** "summary" (default) or "full". */
  detail?: string;
  /** "traditional" (default), "brightest" or "highest". */
  order?: string;
  /** Epoch milliseconds standing in for "now". Injected by tests. */
  now?: number;
  [key: string]: unknown;
}

export type PlanetResult = Record<string, string>;

export function run(input: string, opts: PlanetOpts = {}): PlanetResult {
  const detail = readDetail(opts.detail);
  const order = readOrder(opts.order);
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  const parsed = parseInput(input);
  const location = parsed.location === undefined ? null : resolveLocation(parsed.location);

  const zone = parsed.zone ?? location?.zone ?? "UTC";
  const todayFields = fieldsIn(zone, now);
  const target: CalendarDate = parsed.date ?? {
    year: todayFields.year,
    month: todayFields.month,
    day: todayFields.day,
  };

  if (target.year < MIN_YEAR || target.year > MAX_YEAR) {
    throw new ToolError(
      "date-out-of-range",
      `The year ${target.year} is outside the range the orbital elements are fitted to.`,
      `Pick a date between ${MIN_YEAR} and ${MAX_YEAR}.`,
    );
  }

  let momentMs: number;
  let momentSource: string;
  if (!parsed.date && !parsed.time) {
    momentMs = now;
    momentSource = "right now";
  } else {
    const local = parsed.time ?? { hour: 21, minute: 0, second: 0 };
    const guess = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      local.hour,
      local.minute,
      local.second,
    );
    momentMs = guess - offsetOf(zone, guess) * MS_PER_MINUTE;
    momentMs = guess - offsetOf(zone, momentMs) * MS_PER_MINUTE;
    momentSource = parsed.time ? "taken from the input" : "9 pm local on the date given";
  }

  const states = BODY_IDS.map((id) => bodyState(id, momentMs));
  const sidereal = apparentSiderealTime(julianDay(momentMs));

  const horizontal = new Map<BodyId, { altitude: number; azimuth: number }>();
  const events = new Map<BodyId, SkyEvents>();
  if (location) {
    const dayStartGuess = Date.UTC(target.year, target.month - 1, target.day);
    const dayStart = dayStartGuess - offsetOf(zone, dayStartGuess) * MS_PER_MINUTE;
    for (const state of states) {
      // Only the Moon is close enough for the observer's own position on the
      // globe to move it: everything else shifts by well under an arcminute.
      const place =
        state.id === "moon"
          ? topocentricMoon(
              moonPosition(jdeFromJd(julianDay(momentMs))),
              sidereal,
              location.lat,
              location.lon,
            )
          : { ra: state.ra, dec: state.dec };
      horizontal.set(
        state.id,
        horizontalFrom(place.ra, place.dec, sidereal, location.lat, location.lon),
      );
      events.set(
        state.id,
        skyEvents(state.id, dayStart, dayStart + MS_PER_DAY, location.lat, location.lon),
      );
    }
  }

  const sunAltitude = horizontal.get("sun")?.altitude ?? Number.NaN;

  const ordered = [...states];
  if (order === "brightest") ordered.sort((a, b) => a.magnitude - b.magnitude);
  if (order === "highest" && location) {
    ordered.sort(
      (a, b) => (horizontal.get(b.id)?.altitude ?? -90) - (horizontal.get(a.id)?.altitude ?? -90),
    );
  }

  const out: PlanetResult = {};

  out.Moment = `${stamp(zone, momentMs)} ${zone === "UTC" ? "UTC" : `${zone} (${offsetLabel(offsetOf(zone, momentMs))})`}, ${momentSource}`;
  out.Location = location
    ? location.label
    : "No place given, so this is only where the bodies are on the sky, with no altitude, azimuth or rise and set times.";

  for (const state of ordered) {
    const sky = horizontal.get(state.id);
    const event = events.get(state.id);
    const parts: string[] = [`Magnitude ${signedMagnitude(state.magnitude)}`];

    if (sky) {
      parts.push(
        `altitude ${sky.altitude.toFixed(1)} degrees`,
        `azimuth ${sky.azimuth.toFixed(0)} (${compassPoint(sky.azimuth)})`,
      );
    }

    if (event) {
      if (event.alwaysUp) parts.push("above the horizon all day");
      else if (event.alwaysDown) parts.push("below the horizon all day");
      else {
        parts.push(
          event.rise === null
            ? "no rise on this date"
            : `rises ${clockOn(zone, event.rise, target)}`,
          `highest ${clockOn(zone, event.transit, target)}`,
          event.set === null ? "no set on this date" : `sets ${clockOn(zone, event.set, target)}`,
        );
      }
    }

    if (state.id !== "sun") {
      parts.push(`${state.elongation.toFixed(1)} degrees ${state.elongationSide} of the sun`);
    }
    parts.push(
      `in ${state.constellation}${state.constellationUncertain ? " on the ecliptic band lookup, though it sits far enough off the ecliptic that the neighboring constellation is possible" : ""}`,
    );
    if (sky) {
      parts.push(
        `visible now: ${visibilityNote(state.id, sky.altitude, state.magnitude, sunAltitude).replace(/\.$/, "")}`,
      );
    }

    out[state.name] = `${parts.join(", ")}.`;

    if (detail === "full") {
      const light = state.distanceAu * LIGHT_TIME_PER_AU * 24 * 60;
      const detailParts = [
        `RA ${raLabel(state.ra)}, Dec ${decLabel(state.dec)}`,
        `ecliptic longitude ${state.eclipticLongitude.toFixed(3)} degrees, latitude ${state.eclipticLatitude.toFixed(3)} degrees`,
        `${state.distanceAu.toFixed(6)} au from Earth`,
      ];
      if (state.id !== "sun") {
        detailParts.push(
          `${state.sunDistanceAu.toFixed(6)} au from the sun`,
          `phase angle ${state.phaseAngle.toFixed(1)} degrees, ${(state.illuminatedFraction * 100).toFixed(1)}% lit`,
        );
      }
      detailParts.push(`light takes ${light.toFixed(1)} minutes to reach us`);
      if (event) {
        detailParts.push(
          `highest point ${event.peakAltitude.toFixed(1)} degrees above the horizon`,
        );
      }
      out[`${state.name} in detail`] = `${detailParts.join(". ")}.`;
    }
  }

  out.Method =
    "Planet positions come from the JPL approximate Keplerian elements (Standish), which are fitted to " +
    `${MIN_YEAR} through ${MAX_YEAR} and are good to a few arcminutes. The moon uses the truncated ELP2000-82 series from Meeus chapter 47. ` +
    "Magnitudes are the Astronomical Almanac expressions in Meeus chapter 41, including the tilt of Saturn's rings, and are good to about a fifth of a magnitude. " +
    "Altitudes are geometric, with no correction for refraction, so a body within half a degree of the horizon may already be visible. " +
    "Constellations come from a band lookup along the ecliptic rather than the full boundary table, so a body several degrees off the ecliptic can belong to the neighbor.";

  return out;
}

export default { run } satisfies ToolLogic<string, PlanetResult, PlanetOpts>;
