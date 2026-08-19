/**
 * Sun and golden hour calculator.
 *
 * Implements the NOAA solar position equations (the ones published with the
 * NOAA Solar Calculator spreadsheet): Julian day, Julian century, geometric
 * mean longitude and anomaly, orbital eccentricity, the equation of center,
 * true and apparent longitude, mean obliquity plus its correction, solar
 * declination, the equation of time, and the hour angle for a given zenith.
 *
 * Everything here is pure arithmetic plus Intl for time zone formatting. No
 * DOM, no network, no storage.
 */

import { ToolError, type ToolLogic } from "../types";
import { lookupPlace, type PlaceEntry } from "./places";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
/** Julian day number of the unix epoch (1970-01-01T00:00:00Z). */
const UNIX_EPOCH_JD = 2440587.5;

/** Zenith angle of the sun's centre at sunrise and sunset (NOAA). */
export const ZENITH_SUNRISE = 90.833;
/** Civil twilight: the sun's centre 6 degrees below the horizon. */
export const ZENITH_CIVIL = 96;
/** Nautical twilight: 12 degrees below the horizon. */
export const ZENITH_NAUTICAL = 102;
/** Astronomical twilight: 18 degrees below the horizon. */
export const ZENITH_ASTRONOMICAL = 108;
/** Golden hour boundary: the sun's centre 6 degrees above the horizon. */
export const ZENITH_GOLDEN = 84;
/** Blue hour inner boundary: the sun's centre 4 degrees below the horizon. */
export const ZENITH_BLUE = 94;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

/* ------------------------------------------------------------------ */
/* NOAA solar equations                                                 */
/* ------------------------------------------------------------------ */

function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Julian day for an instant given in epoch milliseconds. */
export function julianDay(ms: number): number {
  return ms / MS_PER_DAY + UNIX_EPOCH_JD;
}

/** Julian centuries since J2000.0. */
export function julianCentury(jd: number): number {
  return (jd - 2451545) / 36525;
}

/** Geometric mean longitude of the sun, degrees, wrapped to [0, 360). */
export function geomMeanLongSun(t: number): number {
  return mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
}

/** Geometric mean anomaly of the sun, degrees. */
export function geomMeanAnomalySun(t: number): number {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

/** Eccentricity of Earth's orbit (unitless). */
export function eccentricityEarthOrbit(t: number): number {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

/** Sun's equation of centre, degrees. */
export function sunEqOfCenter(t: number): number {
  const m = geomMeanAnomalySun(t) * RAD;
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  );
}

/** Sun's true longitude, degrees. */
export function sunTrueLong(t: number): number {
  return geomMeanLongSun(t) + sunEqOfCenter(t);
}

/** Sun's apparent longitude, degrees (true longitude corrected for nutation). */
export function sunApparentLong(t: number): number {
  return sunTrueLong(t) - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
}

/** Mean obliquity of the ecliptic, degrees. */
export function meanObliquityOfEcliptic(t: number): number {
  return 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
}

/** Obliquity of the ecliptic corrected for nutation, degrees. */
export function obliquityCorrection(t: number): number {
  return meanObliquityOfEcliptic(t) + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);
}

/** Solar declination, degrees north of the celestial equator. */
export function sunDeclination(t: number): number {
  const e = obliquityCorrection(t) * RAD;
  const lambda = sunApparentLong(t) * RAD;
  return Math.asin(Math.sin(e) * Math.sin(lambda)) * DEG;
}

/**
 * Equation of time in minutes: apparent solar time minus mean solar time.
 * A negative value means the real sun crosses the meridian later than the
 * mean sun does.
 */
export function equationOfTime(t: number): number {
  const eps = obliquityCorrection(t) * RAD;
  const l0 = geomMeanLongSun(t) * RAD;
  const m = geomMeanAnomalySun(t) * RAD;
  const e = eccentricityEarthOrbit(t);
  const y = Math.tan(eps / 2) ** 2;
  const eq =
    y * Math.sin(2 * l0) -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * e * e * Math.sin(2 * m);
  return eq * 4 * DEG;
}

/**
 * Cosine of the hour angle at which the sun reaches `zenith`. Outside
 * [-1, 1] there is no such moment that day: above 1 the sun never climbs
 * that high, below -1 it never sinks that low.
 */
function cosHourAngle(latDeg: number, decDeg: number, zenithDeg: number): number {
  const lat = latDeg * RAD;
  const dec = decDeg * RAD;
  return (
    Math.cos(zenithDeg * RAD) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec)
  );
}

/** Hour angle in degrees for a zenith, or null when the sun never reaches it. */
export function hourAngleForZenith(
  latDeg: number,
  decDeg: number,
  zenithDeg: number,
): number | null {
  const c = cosHourAngle(latDeg, decDeg, zenithDeg);
  if (!Number.isFinite(c) || c > 1 || c < -1) return null;
  return Math.acos(c) * DEG;
}

/**
 * Approximate atmospheric refraction in degrees for a geometric elevation,
 * using the piecewise fit from the NOAA calculator. It assumes a standard
 * atmosphere of 1010 mb and 10 degrees Celsius.
 */
export function atmosphericRefraction(elevationDeg: number): number {
  if (elevationDeg > 85) return 0;
  const te = Math.tan(elevationDeg * RAD);
  let seconds: number;
  if (elevationDeg > 5) {
    seconds = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (elevationDeg > -0.575) {
    seconds =
      1735 +
      elevationDeg *
        (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  } else {
    seconds = -20.772 / te;
  }
  return seconds / 3600;
}

/* ------------------------------------------------------------------ */
/* Solar position                                                       */
/* ------------------------------------------------------------------ */

export interface SolarPosition {
  /**
   * Apparent altitude above the horizon in degrees, corrected for standard
   * atmospheric refraction. This is what an observer at that spot actually
   * sees, and it is the value the shadow ratio uses.
   */
  altitude: number;
  /** Geometric altitude in degrees, before the refraction correction. */
  geometricAltitude: number;
  /** Bearing of the sun in degrees, clockwise from true north. */
  azimuth: number;
  /** Solar declination in degrees at that instant. */
  declination: number;
  /** Equation of time in minutes at that instant. */
  equationOfTime: number;
  /** Geometric zenith distance in degrees (90 minus the geometric altitude). */
  zenith: number;
}

/**
 * Where the sun is, as seen from `lat` / `lon`, at an instant.
 * Latitude is positive north, longitude positive east.
 */
export function solarPosition(date: Date, latDeg: number, lonDeg: number): SolarPosition {
  const ms = date.getTime();
  const t = julianCentury(julianDay(ms));
  const dec = sunDeclination(t);
  const eqTime = equationOfTime(t);

  // Minutes past 00:00 UTC for this instant.
  const utcMinutes = (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_MINUTE;
  const trueSolarMinutes = (((utcMinutes + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle =
    trueSolarMinutes / 4 < 0 ? trueSolarMinutes / 4 + 180 : trueSolarMinutes / 4 - 180;

  const lat = latDeg * RAD;
  const decRad = dec * RAD;
  const zenith =
    Math.acos(
      clamp(
        Math.sin(lat) * Math.sin(decRad) +
          Math.cos(lat) * Math.cos(decRad) * Math.cos(hourAngle * RAD),
        -1,
        1,
      ),
    ) * DEG;
  const geometricAltitude = 90 - zenith;
  const altitude = geometricAltitude + atmosphericRefraction(geometricAltitude);

  const cosAz = clamp(
    (Math.sin(lat) * Math.cos(zenith * RAD) - Math.sin(decRad)) /
      (Math.cos(lat) * Math.sin(zenith * RAD)),
    -1,
    1,
  );
  const acosAz = Math.acos(cosAz) * DEG;
  const azimuth = hourAngle > 0 ? mod360(acosAz + 180) : mod360(540 - acosAz);

  return { altitude, geometricAltitude, azimuth, declination: dec, equationOfTime: eqTime, zenith };
}

/**
 * Shadow length as a multiple of the object's height: 1 / tan(altitude).
 * A zero or negative altitude means there is no sunlit shadow, so this
 * returns null rather than a nonsense number.
 */
export function shadowRatio(altitudeDeg: number): number | null {
  if (!(altitudeDeg > 0)) return null;
  const ratio = 1 / Math.tan(altitudeDeg * RAD);
  return Number.isFinite(ratio) ? ratio : null;
}

/* ------------------------------------------------------------------ */
/* Sun events for a calendar day                                        */
/* ------------------------------------------------------------------ */

/** What happened at one zenith threshold on one day. */
export type EventState = "normal" | "up-all-day" | "down-all-day";

export interface SunEventPair {
  /** When the sun climbs past the threshold, or null when it never does. */
  rise: Date | null;
  /** When the sun sinks past the threshold, or null when it never does. */
  set: Date | null;
  state: EventState;
}

export interface SunTimes {
  /** When the sun crosses the local meridian. Always defined. */
  solarNoon: Date;
  sunrise: Date | null;
  sunset: Date | null;
  civilDawn: Date | null;
  civilDusk: Date | null;
  nauticalDawn: Date | null;
  nauticalDusk: Date | null;
  astronomicalDawn: Date | null;
  astronomicalDusk: Date | null;
  /** Morning end of golden hour: the sun reaches 6 degrees altitude. */
  goldenMorningEnd: Date | null;
  /** Evening start of golden hour: the sun drops back to 6 degrees. */
  goldenEveningStart: Date | null;
  /** Morning end of blue hour: the sun reaches 4 degrees below the horizon. */
  blueMorningEnd: Date | null;
  /** Evening start of blue hour: the sun drops to 4 degrees below the horizon. */
  blueEveningStart: Date | null;
  /** Minutes between sunrise and sunset: 0 in polar night, 1440 in polar day. */
  dayLengthMinutes: number;
  /** Per threshold outcome, so each twilight stays independent of sunrise. */
  states: {
    day: EventState;
    civil: EventState;
    nautical: EventState;
    astronomical: EventState;
    golden: EventState;
    blue: EventState;
  };
  /** Solar declination in degrees at solar noon. */
  declination: number;
  /** Equation of time in minutes at solar noon. */
  equationOfTime: number;
}

/** Epoch milliseconds of 00:00 UTC on the UTC calendar date `date` falls on. */
function utcMidnightMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Minutes past 00:00 UTC at which the sun crosses the meridian. */
function solarNoonUTCMinutes(jd0: number, lonDeg: number): number {
  let minutes = 720 - 4 * lonDeg - equationOfTime(julianCentury(jd0 + 0.5 - lonDeg / 360));
  for (let pass = 0; pass < 2; pass++) {
    minutes = 720 - 4 * lonDeg - equationOfTime(julianCentury(jd0 + minutes / 1440));
  }
  return minutes;
}

/**
 * Minutes past 00:00 UTC of a rise or set event at one zenith. The value can
 * fall outside [0, 1440) when the event belongs to the neighbouring UTC day,
 * which is correct: the caller turns it back into an instant.
 */
function eventUTCMinutes(
  jd0: number,
  latDeg: number,
  lonDeg: number,
  zenithDeg: number,
  rising: boolean,
): number | null {
  const first = julianCentury(jd0 + 0.5 - lonDeg / 360);
  const firstHa = hourAngleForZenith(latDeg, sunDeclination(first), zenithDeg);
  if (firstHa === null) return null;
  let minutes = 720 - 4 * lonDeg - equationOfTime(first) + (rising ? -4 * firstHa : 4 * firstHa);

  // Two refinement passes: re-evaluate the ephemeris at the estimated instant.
  // If a pass falls off the edge of solvability, which happens on the day a
  // polar night or a midnight sun begins, keep the estimate already in hand.
  for (let pass = 0; pass < 2; pass++) {
    const t = julianCentury(jd0 + minutes / 1440);
    const ha = hourAngleForZenith(latDeg, sunDeclination(t), zenithDeg);
    if (ha === null) return minutes;
    minutes = 720 - 4 * lonDeg - equationOfTime(t) + (rising ? -4 * ha : 4 * ha);
  }
  return minutes;
}

/**
 * Rise and set for one zenith threshold on one UTC calendar day, plus a state
 * saying which way the sun missed the threshold when there is no crossing.
 */
export function sunEventPair(
  dateUTCmidnight: Date,
  latDeg: number,
  lonDeg: number,
  zenithDeg: number,
): SunEventPair {
  const base = utcMidnightMs(dateUTCmidnight);
  const jd0 = julianDay(base);
  const riseMinutes = eventUTCMinutes(jd0, latDeg, lonDeg, zenithDeg, true);
  const setMinutes = eventUTCMinutes(jd0, latDeg, lonDeg, zenithDeg, false);
  if (riseMinutes === null || setMinutes === null) {
    const t = julianCentury(jd0 + 0.5 - lonDeg / 360);
    const c = cosHourAngle(latDeg, sunDeclination(t), zenithDeg);
    return { rise: null, set: null, state: c > 1 ? "down-all-day" : "up-all-day" };
  }
  return {
    rise: new Date(base + riseMinutes * MS_PER_MINUTE),
    set: new Date(base + setMinutes * MS_PER_MINUTE),
    state: "normal",
  };
}

/**
 * Every sun event for one UTC calendar day at one spot. `dateUTCmidnight` is
 * read as a calendar date: only its UTC year, month, and day matter.
 * Latitude is positive north, longitude positive east.
 */
export function sunTimes(dateUTCmidnight: Date, latDeg: number, lonDeg: number): SunTimes {
  const base = utcMidnightMs(dateUTCmidnight);
  const jd0 = julianDay(base);

  const noonMinutes = solarNoonUTCMinutes(jd0, lonDeg);
  const solarNoon = new Date(base + noonMinutes * MS_PER_MINUTE);
  const tNoon = julianCentury(jd0 + noonMinutes / 1440);

  const pair = (zenith: number): SunEventPair =>
    sunEventPair(dateUTCmidnight, latDeg, lonDeg, zenith);

  const day = pair(ZENITH_SUNRISE);
  const civil = pair(ZENITH_CIVIL);
  const nautical = pair(ZENITH_NAUTICAL);
  const astronomical = pair(ZENITH_ASTRONOMICAL);
  const golden = pair(ZENITH_GOLDEN);
  const blue = pair(ZENITH_BLUE);

  let dayLengthMinutes = 0;
  if (day.state === "normal" && day.rise && day.set) {
    dayLengthMinutes = (day.set.getTime() - day.rise.getTime()) / MS_PER_MINUTE;
  } else if (day.state === "up-all-day") {
    dayLengthMinutes = 1440;
  }

  return {
    solarNoon,
    sunrise: day.rise,
    sunset: day.set,
    civilDawn: civil.rise,
    civilDusk: civil.set,
    nauticalDawn: nautical.rise,
    nauticalDusk: nautical.set,
    astronomicalDawn: astronomical.rise,
    astronomicalDusk: astronomical.set,
    goldenMorningEnd: golden.rise,
    goldenEveningStart: golden.set,
    blueMorningEnd: blue.rise,
    blueEveningStart: blue.set,
    dayLengthMinutes,
    states: {
      day: day.state,
      civil: civil.state,
      nautical: nautical.state,
      astronomical: astronomical.state,
      golden: golden.state,
      blue: blue.state,
    },
    declination: sunDeclination(tNoon),
    equationOfTime: equationOfTime(tNoon),
  };
}

/* ------------------------------------------------------------------ */
/* Time zone formatting (Intl is the only zone database available)      */
/* ------------------------------------------------------------------ */

interface ZoneFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
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
  };
}

/** Minutes east of UTC for a zone at an instant, daylight saving included. */
function offsetOf(zone: string, ms: number): number {
  const f = fieldsIn(zone, ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
  return Math.round((asUtc - Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE) / MS_PER_MINUTE);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function ymd(d: CalendarDate): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function weekdayOf(d: CalendarDate): string {
  return WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
}

function dayDiff(target: CalendarDate, actual: CalendarDate): number {
  const a = Date.UTC(actual.year, actual.month - 1, actual.day);
  const b = Date.UTC(target.year, target.month - 1, target.day);
  return Math.round((a - b) / MS_PER_DAY);
}

/** The instant rounded to the nearest whole minute. */
function toWholeMinute(date: Date): number {
  return Math.round(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/**
 * HH:MM in the display zone, rounded to the nearest minute so the reading
 * matches published tables instead of truncating a second early. A day marker
 * is appended when the event lands on another calendar day.
 */
function clockIn(zone: string, date: Date, target: CalendarDate): string {
  const f = fieldsIn(zone, toWholeMinute(date));
  const stamp = `${pad2(f.hour)}:${pad2(f.minute)}`;
  const diff = dayDiff(target, f);
  if (diff === 0) return stamp;
  return `${stamp} (${diff > 0 ? "+" : ""}${diff} day${Math.abs(diff) === 1 ? "" : "s"})`;
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}h ${pad2(total % 60)}m`;
}

function compassPoint(deg: number): string {
  return COMPASS[Math.round(mod360(deg) / 22.5) % 16];
}

function coordLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)} ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)} ${lon < 0 ? "W" : "E"}`;
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})$/i;
const TZ_PREFIX_RE = /^(?:tz|timezone|time\s*zone|zone|in)\s+(.+)$/i;

interface Location {
  label: string;
  lat: number;
  lon: number;
  /** The home zone of a named city. Absent for raw coordinates. */
  zone?: string;
  place?: PlaceEntry;
}

/**
 * Try to read a line as a coordinate pair. Returns null when the line is not
 * coordinate shaped at all, so the caller can try the city table; throws when
 * it clearly meant to be coordinates but cannot be used.
 */
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
      if (pending === undefined && last && last.hemi === undefined) {
        last.hemi = hemi;
      } else if (pending === undefined) {
        pending = hemi;
      } else {
        throw new ToolError(
          "bad-coordinates",
          `Two hemisphere letters in a row near "${token}" in "${raw.trim()}".`,
          "Write each coordinate as one number with at most one letter, like: 40.7128 N, 74.0060 W",
        );
      }
      continue;
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(token)) {
      values.push({ num: Number(token), hemi: pending, token });
      pending = undefined;
      continue;
    }
    // A word mixed in with the numbers. Not a coordinate pair.
    return null;
  }

  if (pending !== undefined) {
    throw new ToolError(
      "bad-coordinates",
      `The letter "${pending}" in "${raw.trim()}" has no number to go with it.`,
      "Write each coordinate as one number with at most one letter, like: 40.7128 N, 74.0060 W",
    );
  }

  if (values.length !== 2) {
    throw new ToolError(
      "bad-coordinates",
      `Found ${values.length} number${values.length === 1 ? "" : "s"} in "${raw.trim()}", and a location needs exactly two.`,
      "Give latitude then longitude, like: 40.7128, -74.0060",
    );
  }

  let [first, second] = values;
  const isNorthSouth = (h?: string): boolean => h === "N" || h === "S";
  const isEastWest = (h?: string): boolean => h === "E" || h === "W";
  if (
    (isNorthSouth(first.hemi) && isNorthSouth(second.hemi)) ||
    (isEastWest(first.hemi) && isEastWest(second.hemi))
  ) {
    throw new ToolError(
      "bad-coordinates",
      `Both numbers in "${raw.trim()}" are marked with the same kind of hemisphere letter.`,
      "One coordinate is N or S and the other is E or W, like: 40.7128 N, 74.0060 W",
    );
  }
  if (isEastWest(first.hemi) || isNorthSouth(second.hemi)) {
    [first, second] = [second, first];
  }

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

function parseDate(raw: string): CalendarDate {
  const text = raw.trim();
  const m = DATE_RE.exec(text);
  if (!m) {
    throw new ToolError(
      "bad-date",
      `Could not read "${text}" as a date.`,
      "Put the date on its own line, written like: on 2026-06-21",
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new ToolError(
      "bad-date",
      `There is no such date as ${text.replace(/^on\s+/i, "")}.`,
      "Use a real calendar date written like: on 2026-06-21",
    );
  }
  return { year, month, day };
}

/** Validates a zone name against the engine's own zone database. */
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
  location: string;
  date?: CalendarDate;
  zone?: string;
}

function parseInput(input: string): ParsedInput {
  const lines = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter a place to calculate the sun for.",
      'A city like "Tokyo", or coordinates like "40.7128, -74.0060". Add "on 2026-06-21" on a second line for another date.',
    );
  }

  const parsed: ParsedInput = { location: lines[0] };
  for (const line of lines.slice(1)) {
    const tzMatch = TZ_PREFIX_RE.exec(line);
    if (tzMatch && !DATE_RE.test(line)) {
      parsed.zone = validateZone(tzMatch[1]);
      continue;
    }
    if (DATE_RE.test(line) || /^on\s+/i.test(line)) {
      parsed.date = parseDate(line);
      continue;
    }
    if (line.includes("/") || /^(utc|gmt|z|zulu)$/i.test(line)) {
      parsed.zone = validateZone(line);
      continue;
    }
    throw new ToolError(
      "bad-date",
      `Could not read "${line}" as a date or a time zone.`,
      'Write a date as "on 2026-06-21" and a time zone as "tz Europe/Berlin".',
    );
  }
  return parsed;
}

function readDetail(value: unknown): "summary" | "full" {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  const full = ["full", "all", "detailed", "detail", "everything", "advanced", "verbose", "raw"];
  return full.includes(raw) ? "full" : "summary";
}

/* ------------------------------------------------------------------ */
/* Output text for events that do not happen                            */
/* ------------------------------------------------------------------ */

/** How a zenith threshold reads inside a sentence. */
function altitudeWords(zenith: number): string {
  const altitude = 90 - zenith;
  if (Math.abs(altitude) < 1) return "the horizon";
  const rounded = Math.round(Math.abs(altitude));
  return `${rounded} degrees ${altitude > 0 ? "above" : "below"} the horizon`;
}

function missingReason(state: EventState, zenith: number): string {
  const words = altitudeWords(zenith);
  if (state === "up-all-day") return `None: the sun stays higher than ${words} all day.`;
  return `None: the sun stays lower than ${words} all day.`;
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export interface SunOpts {
  /** "summary" (default) or "full". Synonyms are accepted. */
  detail?: string;
  /**
   * Epoch milliseconds standing in for "now". Injected by tests so the
   * output is deterministic; not exposed as a user option.
   */
  now?: number;
  [key: string]: unknown;
}

export type SunResult = Record<string, string>;

export function run(input: string, opts: SunOpts = {}): SunResult {
  const detail = readDetail(opts.detail);
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  const parsed = parseInput(input);
  const location = resolveLocation(parsed.location);

  const displayZone = parsed.zone ?? location.zone ?? "UTC";
  // "Today" means today where the place is, when the place has a home zone.
  const dateZone = location.zone ?? displayZone;

  const zoneSource = parsed.zone
    ? "set on its own line of the input"
    : location.zone
      ? `the home zone of ${location.place?.name ?? location.label}`
      : "no zone was given, so times are UTC";

  const todayFields = fieldsIn(dateZone, now);
  const target: CalendarDate = parsed.date ?? {
    year: todayFields.year,
    month: todayFields.month,
    day: todayFields.day,
  };
  const dateSource = parsed.date ? "taken from the input" : `today in ${dateZone}`;

  // Anchor the UTC day used for the arithmetic so solar noon really lands on
  // the requested local date. This only bites where the zone offset and the
  // longitude disagree in sign, such as Samoa or Kiribati.
  let anchorMs = Date.UTC(target.year, target.month - 1, target.day);
  const probeNoonMs =
    anchorMs + solarNoonUTCMinutes(julianDay(anchorMs), location.lon) * MS_PER_MINUTE;
  anchorMs += clamp(-dayDiff(target, fieldsIn(dateZone, probeNoonMs)), -1, 1) * MS_PER_DAY;

  const times = sunTimes(new Date(anchorMs), location.lat, location.lon);
  const clock = (d: Date): string => clockIn(displayZone, d, target);

  const out: SunResult = {};

  out.Location = location.label;
  out.Date = `${ymd(target)}, ${weekdayOf(target)}, ${dateSource}`;
  out["Time zone"] =
    displayZone === "UTC"
      ? `UTC, ${zoneSource}`
      : `${displayZone}, ${offsetLabel(offsetOf(displayZone, times.solarNoon.getTime()))} on this date, ${zoneSource}`;

  /* Sunrise, sunset, solar noon, day length. */
  if (times.states.day === "normal" && times.sunrise && times.sunset) {
    out.Sunrise = clock(times.sunrise);
    out.Sunset = clock(times.sunset);
  } else if (times.states.day === "up-all-day") {
    out.Sunrise = "No sunrise: the sun is already up and stays up (midnight sun).";
    out.Sunset = "No sunset: the sun stays above the horizon all day (midnight sun).";
  } else {
    out.Sunrise = "No sunrise: the sun stays below the horizon all day (polar night).";
    out.Sunset = "No sunset: the sun never came up (polar night).";
  }
  out["Solar noon"] = `${clock(times.solarNoon)}, the sun at its highest`;
  out["Day length"] =
    times.states.day === "up-all-day"
      ? "24h 00m, the sun never sets on this date"
      : times.states.day === "down-all-day"
        ? "0h 00m, the sun never rises on this date"
        : formatDuration(times.dayLengthMinutes);

  /**
   * One band of light, bounded below by `outer` (the darker threshold) and
   * above by `inner` (the brighter one). Normally that splits into a morning
   * half and an evening half. Inside a polar night the sun turns around
   * before it ever crosses the brighter threshold, so the band never breaks
   * and both halves are the same single stretch.
   */
  const band = (
    outerRise: Date | null,
    outerSet: Date | null,
    outerState: EventState,
    outerZenith: number,
    innerRise: Date | null,
    innerSet: Date | null,
  ): { morning: string; evening: string; split: boolean } => {
    if (outerState !== "normal" || !outerRise || !outerSet) {
      const reason = missingReason(outerState, outerZenith);
      return { morning: reason, evening: reason, split: false };
    }
    if (innerRise && innerSet) {
      return {
        morning: `${clock(outerRise)} to ${clock(innerRise)}`,
        evening: `${clock(innerSet)} to ${clock(outerSet)}`,
        split: true,
      };
    }
    const whole = `${clock(outerRise)} to ${clock(outerSet)}, one unbroken stretch around solar noon because it never gets brighter than this`;
    return { morning: whole, evening: whole, split: false };
  };

  const twilight = (
    label: string,
    outerRise: Date | null,
    outerSet: Date | null,
    outerState: EventState,
    outerZenith: number,
    innerRise: Date | null,
    innerSet: Date | null,
  ): void => {
    const b = band(outerRise, outerSet, outerState, outerZenith, innerRise, innerSet);
    out[label] = b.split ? `Morning ${b.morning}, evening ${b.evening}` : b.morning;
  };

  /* Twilights. Each band runs from its own threshold to the next brighter one. */
  twilight(
    "Civil twilight",
    times.civilDawn,
    times.civilDusk,
    times.states.civil,
    ZENITH_CIVIL,
    times.sunrise,
    times.sunset,
  );
  twilight(
    "Nautical twilight",
    times.nauticalDawn,
    times.nauticalDusk,
    times.states.nautical,
    ZENITH_NAUTICAL,
    times.civilDawn,
    times.civilDusk,
  );
  twilight(
    "Astronomical twilight",
    times.astronomicalDawn,
    times.astronomicalDusk,
    times.states.astronomical,
    ZENITH_ASTRONOMICAL,
    times.nauticalDawn,
    times.nauticalDusk,
  );

  /* Golden hour: the horizon up to 6 degrees, and back down again. */
  const goldenRows = (): [string, string] => {
    if (times.states.day === "down-all-day") {
      const reason = "None: the sun stays below the horizon all day (polar night).";
      return [reason, reason];
    }
    if (times.states.golden === "up-all-day") {
      const reason = missingReason("up-all-day", ZENITH_GOLDEN);
      return [reason, reason];
    }
    if (times.states.day === "up-all-day" && times.goldenMorningEnd && times.goldenEveningStart) {
      // Midnight sun: the golden band wraps around midnight instead of dawn.
      return [
        `Until ${clock(times.goldenMorningEnd)}, the sun is already above the horizon at midnight`,
        `From ${clock(times.goldenEveningStart)}, and the sun does not set`,
      ];
    }
    const b = band(
      times.sunrise,
      times.sunset,
      times.states.day,
      ZENITH_SUNRISE,
      times.goldenMorningEnd,
      times.goldenEveningStart,
    );
    return [b.morning, b.evening];
  };
  [out["Golden hour (morning)"], out["Golden hour (evening)"]] = goldenRows();

  /* Blue hour: roughly 6 to 4 degrees below the horizon. */
  const blue = band(
    times.civilDawn,
    times.civilDusk,
    times.states.civil,
    ZENITH_CIVIL,
    times.blueMorningEnd,
    times.blueEveningStart,
  );
  out["Blue hour (morning)"] = blue.morning;
  out["Blue hour (evening)"] = blue.evening;

  /* Where the sun is at this moment. */
  const position = solarPosition(new Date(now), location.lat, location.lon);
  const nowFields = fieldsIn(displayZone, toWholeMinute(new Date(now)));
  out["Sun right now"] =
    `Altitude ${position.altitude.toFixed(1)} degrees, azimuth ${position.azimuth.toFixed(1)} degrees ` +
    `(${compassPoint(position.azimuth)}), at ${ymd(nowFields)} ${pad2(nowFields.hour)}:${pad2(nowFields.minute)}`;

  const ratio = shadowRatio(position.altitude);
  if (ratio === null) {
    out["Shadow length"] = "No shadow: sun below horizon";
    out["Shadow direction"] = "No shadow: sun below horizon";
  } else {
    out["Shadow length"] =
      ratio > 100
        ? "Over 100 times the height of the object, the sun is barely above the horizon"
        : `${ratio.toFixed(2)} times the height of the object`;
    const shadowAzimuth = mod360(position.azimuth + 180);
    out["Shadow direction"] =
      `${shadowAzimuth.toFixed(1)} degrees (${compassPoint(shadowAzimuth)}), straight away from the sun`;
  }

  if (detail === "full") {
    const signed = (value: number, digits: number): string =>
      `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
    const utcStamp = (d: Date | null): string => {
      if (!d) return "none on this date";
      const f = fieldsIn("UTC", toWholeMinute(d));
      return `${ymd(f)} ${pad2(f.hour)}:${pad2(f.minute)} UTC`;
    };
    out["Solar declination"] = `${signed(times.declination, 2)} degrees at solar noon`;
    out["Equation of time"] =
      `${signed(times.equationOfTime, 2)} minutes at solar noon, apparent solar time minus mean solar time`;
    out["Sunrise (UTC)"] = utcStamp(times.sunrise);
    out["Solar noon (UTC)"] = utcStamp(times.solarNoon);
    out["Sunset (UTC)"] = utcStamp(times.sunset);
    out["Sun altitude now, before refraction"] =
      `${signed(position.geometricAltitude, 3)} degrees geometric`;
  }

  return out;
}

export default { run } satisfies ToolLogic<string, SunResult, SunOpts>;
