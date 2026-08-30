/**
 * Julian date converter.
 *
 * Converts in both directions between a calendar date and time and the
 * Julian Date family: JD, Modified Julian Date, Truncated JD, Rata Die,
 * the Excel 1900 serial number, and Unix time. It also reports the
 * derived quantities an observer normally wants beside a Julian Date:
 * ISO week date, day of year, Julian epoch, Julian century since J2000,
 * Delta T, Terrestrial Time, and Greenwich and local sidereal time.
 *
 * Sources for the algorithms:
 *
 * - Julian Day from a calendar date and back again: Jean Meeus,
 *   "Astronomical Algorithms" 2nd edition, chapter 7.
 * - Greenwich mean sidereal time: Meeus chapter 12, formula 12.4.
 * - Delta T (TT minus UT): the polynomial expressions of Espenak and
 *   Meeus published with the NASA Five Millennium Canon of Solar
 *   Eclipses, covering -1999 to +3000.
 *
 * Everything here is pure arithmetic. No DOM, no network, no storage,
 * and no dependence on the host time zone: every calendar field is UTC
 * unless the input carries its own offset.
 */

import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Julian Date of the Unix epoch, 1970-01-01T00:00:00Z. */
export const JD_UNIX_EPOCH = 2440587.5;
/** JD minus MJD. MJD 0 is 1858-11-17T00:00:00Z. */
export const MJD_OFFSET = 2400000.5;
/** JD of the standard epoch J2000.0, 2000-01-01T12:00:00 TT. */
export const JD_J2000 = 2451545;
/** JD of 0001-01-01T00:00:00 in the proleptic Gregorian calendar. */
const JD_RATA_DIE_ZERO = 1721424.5;
/** JD of the Excel 1900 serial 0, which Excel labels 1900-01-00. */
const JD_EXCEL_ZERO = 2415018.5;
/** Truncated JD subtracts this before flooring. */
const JD_TRUNCATED_ZERO = 2440000.5;
/** First day of the Gregorian calendar, 1582-10-15. */
const JD_GREGORIAN_START = 2299160.5;

const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;

/** Indexed by the Meeus weekday number, where 0 is Sunday. */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Indexed by the ISO 8601 weekday number minus one, where 1 is Monday. */
const ISO_WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/* ------------------------------------------------------------------ */
/* Calendar arithmetic (Meeus chapter 7)                                */
/* ------------------------------------------------------------------ */

/** A calendar instant. `day` may carry a fraction, Meeus style. */
export interface CalendarMoment {
  year: number;
  month: number;
  /** Day of month, possibly fractional (4.81 is the 4th at 19:26:24). */
  day: number;
}

/** Which calendar a date is written in. */
export type CalendarSystem = "gregorian" | "julian";

/**
 * Julian Date for a calendar date in the given calendar. Meeus 7.1: the
 * Gregorian branch adds the century correction B, the Julian branch does
 * not. Works for negative years (the proleptic extension backwards).
 */
export function calendarToJd(moment: CalendarMoment, calendar: CalendarSystem): number {
  let y = moment.year;
  let m = moment.month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  let b = 0;
  if (calendar === "gregorian") {
    const a = Math.floor(y / 100);
    b = 2 - a + Math.floor(a / 4);
  }
  return (
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + moment.day + b - 1524.5
  );
}

/**
 * Calendar date for a Julian Date, in the given calendar. The inverse of
 * `calendarToJd`, Meeus chapter 7. `day` comes back fractional.
 */
export function jdToCalendar(jd: number, calendar: CalendarSystem): CalendarMoment {
  const shifted = jd + 0.5;
  const z = Math.floor(shifted);
  const f = shifted - z;
  let a = z;
  if (calendar === "gregorian") {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e) + f;
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  return { year, month, day };
}

/**
 * The calendar in historical use on a given JD: Julian up to
 * 1582 October 4, Gregorian from 1582 October 15. The ten days in
 * between never existed anywhere the reform was adopted on time.
 */
export function historicalCalendar(jd: number): CalendarSystem {
  return jd < JD_GREGORIAN_START ? "julian" : "gregorian";
}

/** The Julian Day Number containing a JD: the integer day label. */
export function julianDayNumber(jd: number): number {
  return Math.floor(jd + 0.5);
}

/**
 * Meeus weekday number for a JD, where 0 is Sunday. JD 0.0 fell on a
 * Monday, so the count is fixed by that anchor alone.
 */
export function weekdayNumber(jd: number): number {
  return (((julianDayNumber(jd) + 1) % 7) + 7) % 7;
}

/** Day of the week for a JD. */
export function weekdayOf(jd: number): string {
  return WEEKDAYS[weekdayNumber(jd)];
}

/** Days elapsed in the year, 1 on January 1. Gregorian reckoning. */
export function dayOfYear(year: number, month: number, day: number): number {
  const jan1 = calendarToJd({ year, month: 1, day: 1 }, "gregorian");
  const here = calendarToJd({ year, month, day: Math.floor(day) }, "gregorian");
  return here - jan1 + 1;
}

/** ISO 8601 week date for a proleptic Gregorian calendar date. */
export function isoWeekDate(
  year: number,
  month: number,
  day: number,
): { year: number; week: number; weekday: number } {
  const jdn = julianDayNumber(calendarToJd({ year, month, day: Math.floor(day) }, "gregorian"));
  // ISO weekday: Monday is 1, Sunday is 7.
  const sunday = (((jdn + 1) % 7) + 7) % 7;
  const weekday = sunday === 0 ? 7 : sunday;
  // The Thursday of this ISO week decides which year the week belongs to.
  const thursday = jdn + (4 - weekday);
  const thursdayDate = jdToCalendar(thursday - 0.5, "gregorian");
  const isoYear = thursdayDate.year;
  const jan1 = julianDayNumber(calendarToJd({ year: isoYear, month: 1, day: 1 }, "gregorian"));
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return { year: isoYear, week, weekday };
}

/* ------------------------------------------------------------------ */
/* Delta T (Espenak and Meeus polynomial expressions)                   */
/* ------------------------------------------------------------------ */

/**
 * Delta T in seconds: Terrestrial Time minus Universal Time, for a
 * decimal year. This is the Espenak and Meeus piecewise polynomial set
 * published with the NASA Five Millennium Canon of Solar Eclipses,
 * valid from -1999 to +3000.
 *
 * Before roughly 1700 these are fits to eclipse records and carry
 * uncertainties of minutes to hours. After 2015 they are an
 * extrapolation: Earth's rotation sped up after the fit was made, so
 * the polynomial runs a few seconds high for the present decade.
 */
export function deltaTSeconds(decimalYear: number): number {
  const y = decimalYear;
  const u = (y - 1820) / 100;

  if (y < -500) return -20 + 32 * u * u;
  if (y < 500) {
    const t = y / 100;
    return poly(t, [
      10583.6, -1014.41, 33.78311, -5.952053, -0.1798452, 0.022174192, 0.0090316521,
    ]);
  }
  if (y < 1600) {
    const t = (y - 1000) / 100;
    return poly(t, [
      1574.2, -556.01, 71.23472, 0.319781, -0.8503463, -0.005050998, 0.0083572073,
    ]);
  }
  if (y < 1700) {
    const t = y - 1600;
    return 120 - 0.9808 * t - 0.01532 * t * t + (t * t * t) / 7129;
  }
  if (y < 1800) {
    const t = y - 1700;
    return poly(t, [8.83, 0.1603, -0.0059285, 0.00013336, -1 / 1174000]);
  }
  if (y < 1860) {
    const t = y - 1800;
    return poly(t, [
      13.72, -0.332447, 0.0068612, 0.0041116, -0.00037436, 0.0000121272, -0.0000001699,
      0.000000000875,
    ]);
  }
  if (y < 1900) {
    const t = y - 1860;
    return poly(t, [7.62, 0.5737, -0.251754, 0.01680668, -0.0004473624, 1 / 233174]);
  }
  if (y < 1920) {
    const t = y - 1900;
    return poly(t, [-2.79, 1.494119, -0.0598939, 0.0061966, -0.000197]);
  }
  if (y < 1941) {
    const t = y - 1920;
    return poly(t, [21.2, 0.84493, -0.0761, 0.0020936]);
  }
  if (y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + (t * t * t) / 2547;
  }
  if (y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t * t * t) / 718;
  }
  if (y < 2005) {
    const t = y - 2000;
    return poly(t, [63.86, 0.3345, -0.060374, 0.0017275, 0.000651814, 0.00002373599]);
  }
  if (y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (y < 2150) return -20 + 32 * u * u - 0.5628 * (2150 - y);
  return -20 + 32 * u * u;
}

function poly(x: number, coefficients: readonly number[]): number {
  let total = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) total = total * x + coefficients[i];
  return total;
}

/** Decimal year for a calendar date, the form the Delta T fit expects. */
export function decimalYear(year: number, month: number): number {
  return year + (month - 0.5) / 12;
}

/* ------------------------------------------------------------------ */
/* Sidereal time (Meeus chapter 12)                                     */
/* ------------------------------------------------------------------ */

function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Greenwich mean sidereal time in degrees for a Julian Date given in UT.
 * Meeus formula 12.4, which is valid for any instant rather than only
 * for 0h UT.
 */
export function greenwichMeanSiderealDegrees(jdUt: number): number {
  const t = (jdUt - JD_J2000) / 36525;
  const theta =
    280.46061837 +
    360.98564736629 * (jdUt - JD_J2000) +
    0.000387933 * t * t -
    (t * t * t) / 38710000;
  return mod360(theta);
}

/** Degrees rendered as sidereal hours, minutes and seconds. */
export function degreesToHms(deg: number, decimals = 4): string {
  const hours = mod360(deg) / 15;
  let h = Math.floor(hours);
  let m = Math.floor((hours - h) * 60);
  let s = (hours - h - m / 60) * 3600;
  // Guard the carry that rounding the seconds can force.
  if (Number(s.toFixed(decimals)) >= 60) {
    s = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    h += 1;
  }
  if (h >= 24) h -= 24;
  return `${pad2(h)}h ${pad2(m)}m ${s.toFixed(decimals).padStart(decimals + 3, "0")}s`;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(Math.trunc(n)).padStart(2, "0");
}

function padYear(year: number): string {
  if (year < 0) return `-${String(-year).padStart(4, "0")}`;
  if (year > 9999) return `+${String(year)}`;
  return String(year).padStart(4, "0");
}

/** Splits a fractional day into whole day plus hours, minutes, seconds. */
export function splitDayFraction(day: number): {
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const whole = Math.floor(day);
  let rest = (day - whole) * SECONDS_PER_DAY;
  // Round to the millisecond so 23:59:59.9999999 does not print as 60.
  rest = Math.round(rest * 1000) / 1000;
  let hour = Math.floor(rest / 3600);
  let minute = Math.floor((rest - hour * 3600) / 60);
  let second = rest - hour * 3600 - minute * 60;
  if (second >= 60) {
    second -= 60;
    minute += 1;
  }
  if (minute >= 60) {
    minute -= 60;
    hour += 1;
  }
  return { day: whole, hour, minute, second };
}

function formatSeconds(second: number): string {
  const rounded = Math.round(second * 1000) / 1000;
  const text = rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const [intPart, frac] = text.split(".");
  return frac ? `${intPart.padStart(2, "0")}.${frac}` : intPart.padStart(2, "0");
}

/** A calendar moment as "2026-08-30 12:34:56". */
export function formatMoment(moment: CalendarMoment): string {
  const { day, hour, minute, second } = splitDayFraction(moment.day);
  return `${padYear(moment.year)}-${pad2(moment.month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${formatSeconds(second)}`;
}

/** A calendar moment as an ISO 8601 UTC timestamp. */
export function formatIso(moment: CalendarMoment): string {
  const { day, hour, minute, second } = splitDayFraction(moment.day);
  return `${padYear(moment.year)}-${pad2(moment.month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${formatSeconds(second)}Z`;
}

function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "not a number";
  return value.toFixed(digits);
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

/** Bare numbers no larger than this are read as a Julian Date. */
const BARE_JD_MAX = 5_000_000;

const NUMBER = String.raw`[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?`;

const PREFIXED_RE = new RegExp(
  String.raw`^(jd|julian\s*day|julian\s*date|mjd|modified\s*julian(?:\s*d(?:ay|ate))?|` +
    String.raw`tjd|truncated\s*julian(?:\s*d(?:ay|ate))?|rd|rata\s*die|excel|` +
    String.raw`unix|epoch|posix|unixtime|unix\s*time)\s*[:=]?\s*(${NUMBER})$`,
  "i",
);

const AT_RE = new RegExp(String.raw`^@(${NUMBER})$`, "i");

const DATE_RE = new RegExp(
  String.raw`^([-+]?\d{1,6})-(\d{1,2})-(\d{1,2}(?:\.\d+)?)` +
    String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{1,2}(?:\.\d+)?))?)?` +
    String.raw`\s*(Z|z|[-+]\d{2}:?\d{2})?$`,
);

const BARE_RE = new RegExp(String.raw`^(${NUMBER})$`);

/** What the reader typed, reduced to a Julian Date plus a description. */
interface ParsedValue {
  /** Julian Date in Universal Time. */
  jd: number;
  /** How the input was read, for the "Input read as" row. */
  reading: string;
  /** True when the input was a calendar date rather than a day number. */
  fromCalendar: boolean;
  /** The calendar the input date was interpreted in, when it was a date. */
  inputCalendar?: CalendarSystem;
}

function requireFinite(raw: string, value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new ToolError(
      "bad-number",
      `Could not read "${raw}" as ${what}.`,
      "Write it as a plain decimal number, like 2451545.0",
    );
  }
  return value;
}

function parseOffsetMinutes(raw: string | undefined): number {
  if (!raw || raw === "Z" || raw === "z") return 0;
  const m = /^([-+])(\d{2}):?(\d{2})$/.exec(raw);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function parseCalendarText(text: string, calendarOption: CalendarChoice): ParsedValue {
  const m = DATE_RE.exec(text);
  if (!m) {
    throw new ToolError(
      "bad-input",
      `Could not read "${text}" as a date or a day number.`,
      'Try a date like 2026-08-30 12:00, a Julian Date like "JD 2451545.0", a Modified Julian Date like "MJD 51544.5", or a Unix time like "unix 1234567890".',
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayValue = Number(m[3]);
  if (month < 1 || month > 12) {
    throw new ToolError(
      "bad-month",
      `There is no month ${month}.`,
      "Months run from 01 to 12, so write the date as 2026-08-30.",
    );
  }
  if (dayValue < 1 || dayValue >= 32) {
    throw new ToolError(
      "bad-day",
      `There is no day ${m[3]} in any month.`,
      "Days run from 01 to 31, so write the date as 2026-08-30.",
    );
  }

  const hour = m[4] !== undefined ? Number(m[4]) : 0;
  const minute = m[5] !== undefined ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  if (hour > 24 || minute > 59 || second >= 61) {
    throw new ToolError(
      "bad-time",
      `Could not read "${m[4]}:${m[5]}" as a time of day.`,
      "Use a 24 hour clock, like 2026-08-30 18:45:00.",
    );
  }
  const offsetMinutes = parseOffsetMinutes(m[7]);

  const dayFraction = dayValue + (hour * 3600 + minute * 60 + second) / SECONDS_PER_DAY;
  const calendar = resolveInputCalendar(year, month, Math.floor(dayValue), calendarOption);
  const jd = calendarToJd({ year, month, day: dayFraction }, calendar) - offsetMinutes / 1440;

  const offsetNote =
    offsetMinutes === 0
      ? m[7]
        ? ", UTC"
        : ", read as UTC"
      : `, offset ${m[7]} converted to UTC`;
  return {
    jd,
    reading: `calendar date in the ${calendar === "gregorian" ? "Gregorian" : "Julian"} calendar${offsetNote}`,
    fromCalendar: true,
    inputCalendar: calendar,
  };
}

/** The calendar an input date should be read in. */
function resolveInputCalendar(
  year: number,
  month: number,
  day: number,
  choice: CalendarChoice,
): CalendarSystem {
  if (choice === "gregorian" || choice === "julian") return choice;
  // Auto: the calendar actually in use. The ten days the reform skipped
  // never existed, so a date inside the gap is a mistake worth naming.
  if (year > 1582 || (year === 1582 && (month > 10 || (month === 10 && day >= 15)))) {
    return "gregorian";
  }
  if (year === 1582 && month === 10 && day > 4 && day < 15) {
    throw new ToolError(
      "nonexistent-date",
      `1582 October ${day} never happened: the Gregorian reform skipped October 5 through 14.`,
      'Pick a date outside the gap, or set Calendar to "Julian (proleptic)" or "Gregorian (proleptic)" to force one calendar throughout.',
    );
  }
  return "julian";
}

function parseValue(raw: string, calendarOption: CalendarChoice): ParsedValue {
  const text = raw.trim();

  const at = AT_RE.exec(text);
  if (at) {
    const unix = requireFinite(at[1], Number(at[1]), "a Unix time");
    return { jd: JD_UNIX_EPOCH + unix / SECONDS_PER_DAY, reading: "Unix time in seconds", fromCalendar: false };
  }

  const prefixed = PREFIXED_RE.exec(text);
  if (prefixed) {
    const keyword = prefixed[1].toLowerCase().replace(/\s+/g, " ");
    const value = requireFinite(prefixed[2], Number(prefixed[2]), "a number");
    if (keyword.startsWith("mjd") || keyword.startsWith("modified")) {
      return { jd: value + MJD_OFFSET, reading: "Modified Julian Date", fromCalendar: false };
    }
    if (keyword.startsWith("tjd") || keyword.startsWith("truncated")) {
      return { jd: value + JD_TRUNCATED_ZERO, reading: "Truncated Julian Date", fromCalendar: false };
    }
    if (keyword === "rd" || keyword.startsWith("rata")) {
      return { jd: value + JD_RATA_DIE_ZERO, reading: "Rata Die day number", fromCalendar: false };
    }
    if (keyword === "excel") {
      return { jd: value + JD_EXCEL_ZERO, reading: "Excel 1900 serial number", fromCalendar: false };
    }
    if (keyword.startsWith("jd") || keyword.startsWith("julian")) {
      return { jd: value, reading: "Julian Date", fromCalendar: false };
    }
    return {
      jd: JD_UNIX_EPOCH + value / SECONDS_PER_DAY,
      reading: "Unix time in seconds",
      fromCalendar: false,
    };
  }

  const bare = BARE_RE.exec(text);
  if (bare) {
    const value = requireFinite(bare[1], Number(bare[1]), "a number");
    if (value >= 0 && value <= BARE_JD_MAX) {
      return {
        jd: value,
        reading: "a bare number in Julian Date range, so read as a Julian Date",
        fromCalendar: false,
      };
    }
    if (Math.abs(value) >= 1e11) {
      return {
        jd: JD_UNIX_EPOCH + value / 1000 / SECONDS_PER_DAY,
        reading: "a bare number too large for seconds, so read as Unix milliseconds",
        fromCalendar: false,
      };
    }
    return {
      jd: JD_UNIX_EPOCH + value / SECONDS_PER_DAY,
      reading: "a bare number outside Julian Date range, so read as Unix seconds",
      fromCalendar: false,
    };
  }

  return parseCalendarText(text, calendarOption);
}

/* ------------------------------------------------------------------ */
/* Longitude parsing for local sidereal time                            */
/* ------------------------------------------------------------------ */

const LON_RE = /^([-+]?\d+(?:\.\d+)?)\s*(?:deg|degrees|°)?\s*([EWew])?$/;

/** East positive longitude in degrees, or null when nothing was given. */
export function parseLongitude(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const m = LON_RE.exec(text);
  if (!m) {
    throw new ToolError(
      "bad-longitude",
      `Could not read "${text}" as a longitude.`,
      "Write it in decimal degrees, east positive, like -90.1994 or 90.1994 W.",
    );
  }
  let value = Number(m[1]);
  if (m[2] && m[2].toUpperCase() === "W") value = -Math.abs(value);
  if (m[2] && m[2].toUpperCase() === "E") value = Math.abs(value);
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new ToolError(
      "bad-longitude",
      `A longitude of ${text} is outside the range of the Earth.`,
      "Longitude runs from -180 to +180 degrees, east positive.",
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

export type CalendarChoice = "auto" | "gregorian" | "julian";

export interface JulianDateOpts {
  /** "auto" (historical), "gregorian" or "julian" (both proleptic). */
  calendar?: string;
  /** Observer longitude in degrees, east positive, for local sidereal time. */
  longitude?: string;
  /** "summary" or "full". */
  detail?: string;
  /** Epoch milliseconds standing in for "now". Injected by tests. */
  now?: number;
  [key: string]: unknown;
}

export type JulianDateResult = Record<string, string>;

function readCalendar(value: unknown): CalendarChoice {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "gregorian") return "gregorian";
  if (raw === "julian") return "julian";
  return "auto";
}

function readDetail(value: unknown): "summary" | "full" {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["full", "all", "detailed", "everything", "advanced"].includes(raw) ? "full" : "summary";
}

export function run(input: string, opts: JulianDateOpts = {}): JulianDateResult {
  const calendarOption = readCalendar(opts.calendar);
  const detail = readDetail(opts.detail);
  const longitude = parseLongitude(opts.longitude);
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  const lines = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const first = lines[0] ?? "";
  const useNow = first === "" || /^(now|today)$/i.test(first);

  const parsed: ParsedValue = useNow
    ? {
        jd: JD_UNIX_EPOCH + now / MS_PER_DAY,
        reading: "the current moment, because no date was given",
        fromCalendar: false,
      }
    : parseValue(first, calendarOption);

  const jd = parsed.jd;
  if (!Number.isFinite(jd)) {
    throw new ToolError(
      "out-of-range",
      "That value does not land on a real instant.",
      "Try a Julian Date between 0 and 5000000, or a calendar date between the year -4712 and the year 9999.",
    );
  }
  if (jd < -1_000_000 || jd > 10_000_000) {
    throw new ToolError(
      "out-of-range",
      `A Julian Date of ${jd} is far outside the range this converter covers.`,
      "Julian Date 0 is 4713 BC and Julian Date 5000000 is the year 8977. Stay inside that range.",
    );
  }

  const gregorian = jdToCalendar(jd, "gregorian");
  const julian = jdToCalendar(jd, "julian");
  const inUse = historicalCalendar(jd);
  const primary = calendarOption === "auto" ? (inUse === "julian" ? julian : gregorian) : calendarOption === "julian" ? julian : gregorian;
  const primaryName = calendarOption === "auto" ? inUse : calendarOption;

  const mjd = jd - MJD_OFFSET;
  const unixSeconds = (jd - JD_UNIX_EPOCH) * SECONDS_PER_DAY;
  const year = decimalYear(gregorian.year, gregorian.month);
  const dt = deltaTSeconds(year);
  const gmst = greenwichMeanSiderealDegrees(jd);

  const out: JulianDateResult = {};

  out["Input read as"] = `${useNow ? first || "(nothing)" : first} : ${parsed.reading}`;
  out["Date and time (UTC)"] =
    `${formatMoment(primary)}, ${MONTH_NAMES[primary.month - 1]} ${Math.floor(primary.day)}, ${weekdayOf(jd)}` +
    `, ${primaryName === "julian" ? "Julian calendar" : "Gregorian calendar"}`;
  out["ISO 8601"] = formatIso(gregorian);
  out["Julian Date (JD)"] = fixed(jd, 8);
  out["Modified Julian Date (MJD)"] = fixed(mjd, 8);
  out["Julian day number"] = String(Math.floor(jd + 0.5));
  out["Unix time (seconds)"] = fixed(unixSeconds, 3);

  const iso = isoWeekDate(gregorian.year, gregorian.month, gregorian.day);
  out["ISO week date"] =
    `${padYear(iso.year)}-W${String(iso.week).padStart(2, "0")}-${iso.weekday}` +
    ` (${ISO_WEEKDAYS[iso.weekday - 1]})`;
  out["Day of year"] =
    `${dayOfYear(gregorian.year, gregorian.month, gregorian.day)} of ${isLeapYear(gregorian.year) ? 366 : 365}`;

  out["Greenwich mean sidereal time"] = `${degreesToHms(gmst)} (${fixed(gmst, 5)} degrees)`;
  if (longitude !== null) {
    const lst = mod360(gmst + longitude);
    out["Local mean sidereal time"] =
      `${degreesToHms(lst)} at longitude ${signed(longitude, 4)} degrees east`;
  }

  out["Delta T (TT minus UT)"] =
    `${fixed(dt, 1)} seconds, from the Espenak and Meeus polynomials`;
  out["Julian Ephemeris Day (TT)"] = fixed(jd + dt / SECONDS_PER_DAY, 8);

  if (detail === "full") {
    out["Gregorian calendar date"] = formatMoment(gregorian);
    out["Julian calendar date"] = formatMoment(julian);
    const sameYmd = {
      year: gregorian.year,
      month: gregorian.month,
      day: Math.floor(gregorian.day),
    };
    const gap = Math.round(
      calendarToJd(sameYmd, "julian") - calendarToJd(sameYmd, "gregorian"),
    );
    out["Calendar difference"] =
      `${Math.abs(gap)} days: the Julian calendar date runs that far ${gap >= 0 ? "behind" : "ahead of"} the Gregorian one at this Julian Date`;
    out["Truncated Julian Date (TJD)"] = fixed(jd - JD_TRUNCATED_ZERO, 6);
    out["Rata Die"] = fixed(jd - JD_RATA_DIE_ZERO, 6);
    out["Excel serial (1900 system)"] =
      jd >= JD_EXCEL_ZERO + 60
        ? fixed(jd - JD_EXCEL_ZERO, 6)
        : `${fixed(jd - JD_EXCEL_ZERO, 6)}, before Excel's fictional 1900-02-29 so it disagrees with Excel by a day`;
    out["Unix time (milliseconds)"] = fixed(unixSeconds * 1000, 0);
    out["Days since J2000.0"] = fixed(jd - JD_J2000, 6);
    out["Julian century since J2000.0"] = fixed((jd - JD_J2000) / 36525, 9);
    out["Julian epoch"] = `J${fixed(2000 + (jd - JD_J2000) / 365.25, 5)}`;
    out["Besselian epoch"] = `B${fixed(1900 + (jd - 2415020.31352) / 365.242198781, 5)}`;
    out["Day of week"] = weekdayOf(jd);
  }

  return out;
}

/** Gregorian leap year test. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export default { run } satisfies ToolLogic<string, JulianDateResult, JulianDateOpts>;
