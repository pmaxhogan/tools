import { ToolError, type ToolLogic } from '../types';

export interface WeekNumberOpts {
  [key: string]: unknown;
}

export interface WeekNumberResult {
  [label: string]: string;
}

const DAY_MS = 86_400_000;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Matches an ISO 8601 calendar date, optionally followed by a time and/or
 * offset. Only the date part is used — the tool operates on whole calendar
 * days in UTC, so time-of-day and offset are accepted (for compatibility
 * with datetime strings) but ignored, keeping results deterministic
 * regardless of the runtime's local time zone.
 */
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parse input into a UTC midnight Date for the target calendar day. */
function parseDate(raw: string): Date {
  const s = (raw ?? '').trim();

  if (!s) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  const m = ISO_DATE_RE.exec(s);
  if (!m) {
    throw new ToolError(
      'unparseable-date',
      `Could not parse "${s}" as a date.`,
      'Use an ISO 8601 date like 2026-08-06, or a full datetime like 2026-08-06T21:00:00Z. Leave empty for today.',
    );
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));

  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new ToolError(
      'invalid-date',
      `"${s}" is not a real calendar date.`,
      'Check the month (01-12) and day (01-31) values, e.g. 2026-08-06.',
    );
  }

  return d;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.round((d.getTime() - start) / DAY_MS) + 1;
}

/** ISO day number: Monday = 1 ... Sunday = 7. */
function isoDayNumber(d: Date): number {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** Monday of the ISO week containing `d` (UTC midnight). */
function isoWeekMonday(d: Date): Date {
  const dayNum = isoDayNumber(d);
  return new Date(d.getTime() - (dayNum - 1) * DAY_MS);
}

/**
 * ISO 8601 week number and week-year. Week 1 is the week containing the
 * first Thursday of the year; the ISO week-year is the calendar year that
 * Thursday falls in, which can differ from the input's own calendar year
 * near Jan 1 / Dec 31.
 */
function isoWeek(d: Date): { week: number; year: number } {
  // Nearest Thursday: ISO weeks start Monday (day 0 in ISO terms).
  const dayNum = isoDayNumber(d); // Mon=1..Sun=7
  const thursday = new Date(d.getTime() + (4 - dayNum) * DAY_MS);

  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = isoDayNumber(firstThursday);
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 4);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { week, year: thursday.getUTCFullYear() };
}

function isoDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function format(d: Date): WeekNumberResult {
  const { week, year } = isoWeek(d);
  const doy = dayOfYear(d);
  const remaining = daysInYear(d.getUTCFullYear()) - doy;
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  const monday = isoWeekMonday(d);
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);

  return {
    'ISO week': `W${String(week).padStart(2, '0')}`,
    'ISO week-year': String(year),
    'Day of year': String(doy),
    'Day of week': `${DAY_NAMES[d.getUTCDay()]} (${isoDayNumber(d)})`,
    Quarter: `Q${quarter}`,
    'Days remaining in year': String(remaining),
    'Week range': `${isoDateStr(monday)} - ${isoDateStr(sunday)}`,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function run(input: string, _opts: WeekNumberOpts): WeekNumberResult {
  return format(parseDate(input));
}

export default { run } satisfies ToolLogic<string, WeekNumberResult, WeekNumberOpts>;
