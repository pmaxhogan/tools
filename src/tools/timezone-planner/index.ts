import { ToolError, type ToolLogic } from "../types";
import { lookupPlace } from "./cities";

export interface TimezonePlannerOpts {
  /** First working hour, local in every place (0 to 23). */
  dayStart?: number | string;
  /** Hour the working day ends, local in every place (1 to 24). */
  dayEnd?: number | string;
  /**
   * Epoch milliseconds standing in for "now". Injected by tests so the output
   * is deterministic; not exposed as a user option.
   */
  now?: number;
  [key: string]: unknown;
}

export type TimezonePlannerResult = Record<string, string>;

/** A place resolved to something we can compute an offset for. */
interface Zone {
  /** Dedupe key: the IANA name, or "fixed:<minutes>" for a raw offset. */
  key: string;
  /** How the place is labelled in the output. */
  label: string;
  iana?: string;
  /** Minutes east of UTC, for raw offset inputs only. */
  fixed?: number;
}

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface PlanDate {
  year: number;
  month: number;
  day: number;
}

interface Row {
  zone: Zone;
  /** Working window on the planning date, as epoch milliseconds. */
  start: number;
  end: number;
  /** UTC offset in minutes at the start of that window. */
  offset: number;
}

const MAX_PLACES = 8;
const UTC_ZONE: Zone = { key: "fixed:0", label: "UTC", fixed: 0 };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DATE_RE = /^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})$/i;
const OFFSET_RE = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;

/* ------------------------------------------------------------------ */
/* Time zone maths. Intl is the only zone database available, and it is
   pure: no DOM, no network, no storage.                                */
/* ------------------------------------------------------------------ */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(iana: string): Intl.DateTimeFormat {
  let fmt = formatters.get(iana);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(iana, fmt);
  }
  return fmt;
}

/** The wall clock reading in `zone` at an instant. */
function fieldsIn(zone: Zone, ms: number): Fields {
  if (zone.fixed !== undefined) {
    const shifted = new Date(ms + zone.fixed * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }
  const parts = partsFormatter(zone.iana as string).formatToParts(new Date(ms));
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

/**
 * The zone's UTC offset in minutes at a specific instant, so daylight saving
 * is resolved for the date being planned rather than for today.
 */
function offsetOf(zone: Zone, ms: number): number {
  if (zone.fixed !== undefined) return zone.fixed;
  const f = fieldsIn(zone, ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The instant at which a wall clock reading happens in `zone`. */
function epochFromLocal(zone: Zone, date: PlanDate, hour: number, minute = 0): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  if (zone.fixed !== undefined) return wall - zone.fixed * 60_000;
  const firstGuess = wall - offsetOf(zone, wall) * 60_000;
  return wall - offsetOf(zone, firstGuess) * 60_000;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function hhmm(f: Fields): string {
  return `${pad2(f.hour)}:${pad2(f.minute)}`;
}

function ymd(f: Fields | PlanDate): string {
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
}

function weekdayOf(f: Fields | PlanDate): string {
  return WEEKDAYS[new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay()];
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function dayDiff(plan: PlanDate, f: Fields): number {
  const a = Date.UTC(f.year, f.month - 1, f.day);
  const b = Date.UTC(plan.year, plan.month - 1, plan.day);
  return Math.round((a - b) / 86_400_000);
}

/** Local clock reading, tagged when it lands on another calendar day. */
function clockIn(zone: Zone, ms: number, plan: PlanDate): string {
  const f = fieldsIn(zone, ms);
  const diff = dayDiff(plan, f);
  if (diff === 0) return hhmm(f);
  return `${hhmm(f)} ${diff > 0 ? "+" : ""}${diff}d`;
}

/** A UTC range, spelled with dates only when the two ends differ. */
function utcRange(startMs: number, endMs: number): string {
  const a = fieldsIn(UTC_ZONE, startMs);
  const b = fieldsIn(UTC_ZONE, endMs);
  if (ymd(a) === ymd(b)) return `${hhmm(a)} to ${hhmm(b)} UTC on ${ymd(a)}`;
  return `${ymd(a)} ${hhmm(a)} to ${ymd(b)} ${hhmm(b)} UTC`;
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                        */
/* ------------------------------------------------------------------ */

function parseDate(raw: string): PlanDate {
  const m = DATE_RE.exec(raw.trim());
  if (!m) {
    throw new ToolError(
      "bad-date",
      `Could not read "${raw.trim()}" as a date.`,
      "Put the date on its own first line, written like: on 2026-08-18",
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
      `There is no such date as ${raw.trim().replace(/^on\s+/i, "")}.`,
      "Use a real calendar date written like: on 2026-08-18",
    );
  }
  return { year, month, day };
}

function parseInput(input: string): { date?: PlanDate; tokens: string[] } {
  const lines = input.split(/\r?\n/).map((line) => line.trim());
  const tokens: string[] = [];
  let date: PlanDate | undefined;
  let seenFirst = false;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    let pieces = line
      .split(",")
      .map((piece) => piece.trim())
      .filter(Boolean);
    if (!seenFirst) {
      seenFirst = true;
      const head = pieces[0] ?? "";
      if (/^on\s/i.test(head) || DATE_RE.test(head)) {
        date = parseDate(head);
        pieces = pieces.slice(1);
      }
    }
    tokens.push(...pieces);
  }
  return { date, tokens };
}

function parseOffset(token: string): number | undefined {
  const m = OFFSET_RE.exec(token);
  if (!m) return undefined;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || minutes > 59) return undefined;
  const total = hours * 60 + minutes;
  return m[1] === "-" ? -total : total;
}

/** Validates an IANA name and returns the spelling the engine treats as canonical. */
function canonicalKey(iana: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: iana }).resolvedOptions().timeZone;
}

function resolveZone(token: string): Zone {
  const raw = token.trim();

  if (/^(utc|gmt|z|zulu)$/i.test(raw)) return { ...UTC_ZONE };

  const offset = parseOffset(raw);
  if (offset !== undefined) {
    return { key: `fixed:${offset}`, label: offsetLabel(offset), fixed: offset };
  }

  if (raw.includes("/")) {
    try {
      // The label stays as typed: engines disagree about which spelling of a
      // renamed zone is canonical (Asia/Kolkata versus Asia/Calcutta), so the
      // canonical form is used only as the dedupe key.
      return { key: canonicalKey(raw), label: raw, iana: raw };
    } catch {
      throw new ToolError(
        "unknown-place",
        `"${raw}" is not a time zone this planner knows.`,
        "Use an IANA zone name like Europe/Berlin, a city like st louis, or an offset like UTC+5:30.",
      );
    }
  }

  const city = lookupPlace(raw);
  if (city) return { key: canonicalKey(city.zone), label: city.name, iana: city.zone };

  throw new ToolError(
    "unknown-place",
    `"${raw}" is not a city or time zone this planner knows.`,
    "Use an IANA zone name like Europe/Berlin, a well known city like tokyo, or an offset like UTC+5:30.",
  );
}

function readHour(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

function readHours(opts: TimezonePlannerOpts): { dayStart: number; dayEnd: number } {
  const dayStart = readHour(opts.dayStart, 9);
  const dayEnd = readHour(opts.dayEnd, 17);
  const badRange =
    !Number.isInteger(dayStart) ||
    dayStart < 0 ||
    dayStart > 23 ||
    !Number.isInteger(dayEnd) ||
    dayEnd < 1 ||
    dayEnd > 24;
  if (badRange) {
    throw new ToolError(
      "bad-hours",
      `Working hours ${opts.dayStart ?? 9} to ${opts.dayEnd ?? 17} are not whole hours in range.`,
      "The day start is a whole hour from 0 to 23 and the day end a whole hour from 1 to 24.",
    );
  }
  if (dayStart >= dayEnd) {
    throw new ToolError(
      "bad-hours",
      `A working day cannot start at ${pad2(dayStart)}:00 and end at ${pad2(dayEnd)}:00.`,
      "Set the start hour below the end hour, for example 9 to 17.",
    );
  }
  return { dayStart, dayEnd };
}

/* ------------------------------------------------------------------ */
/* The tool                                                             */
/* ------------------------------------------------------------------ */

function put(out: TimezonePlannerResult, label: string, value: string): void {
  let key = label;
  let n = 2;
  while (key in out) key = `${label} (${n++})`;
  out[key] = value;
}

export function run(input: string, opts: TimezonePlannerOpts = {}): TimezonePlannerResult {
  const { dayStart, dayEnd } = readHours(opts);
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();

  const parsed = parseInput(input ?? "");
  if (parsed.tokens.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter the places you want to compare.",
      "One place per line or separated by commas, like: Europe/Berlin, st louis",
    );
  }
  if (parsed.tokens.length > MAX_PLACES) {
    throw new ToolError(
      "too-many",
      `That is ${parsed.tokens.length} places. The planner compares up to ${MAX_PLACES} at once.`,
      `Keep the list to ${MAX_PLACES} places or fewer.`,
    );
  }

  const zones: Zone[] = [];
  for (const token of parsed.tokens) {
    const zone = resolveZone(token);
    if (!zones.some((existing) => existing.key === zone.key)) zones.push(zone);
  }
  if (zones.length < 2) {
    throw new ToolError(
      "need-two",
      parsed.tokens.length < 2
        ? "One place on its own has nothing to overlap with."
        : `Every place you listed is in the same time zone (${zones[0].label}).`,
      "Add a second place in a different zone, like: Europe/Berlin, st louis",
    );
  }

  const plan = parsed.date ?? fieldsIn(zones[0], now);
  const planDate: PlanDate = { year: plan.year, month: plan.month, day: plan.day };

  const rows: Row[] = zones.map((zone) => {
    const start = epochFromLocal(zone, planDate, dayStart);
    const end = epochFromLocal(zone, planDate, dayEnd);
    return { zone, start, end, offset: offsetOf(zone, start) };
  });

  const out: TimezonePlannerResult = {};
  put(
    out,
    "Planning date",
    `${ymd(planDate)} (${weekdayOf(planDate)}), ${
      parsed.date
        ? "taken from the first line of the input"
        : `the current date in ${zones[0].label}`
    }`,
  );
  put(out, "Working hours", `${pad2(dayStart)}:00 to ${pad2(dayEnd)}:00 local time in every place`);

  for (const row of rows) {
    const nowFields = fieldsIn(row.zone, now);
    put(
      out,
      row.zone.label,
      `Now ${hhmm(nowFields)} ${weekdayOf(nowFields)}. ` +
        `${offsetLabel(row.offset)} on ${ymd(planDate)}. ` +
        `Working ${utcRange(row.start, row.end)}.`,
    );
  }

  const overlapStart = Math.max(...rows.map((r) => r.start));
  const overlapEnd = Math.min(...rows.map((r) => r.end));

  if (overlapEnd > overlapStart) {
    const locals = rows
      .map(
        (r) =>
          `${clockIn(r.zone, overlapStart, planDate)}-${clockIn(r.zone, overlapEnd, planDate)} ${r.zone.label}`,
      )
      .join(", ");
    put(
      out,
      "Overlap",
      `${formatDuration((overlapEnd - overlapStart) / 60_000)} together: ${utcRange(overlapStart, overlapEnd)}. Local clocks: ${locals}.`,
    );
  } else {
    const gapMinutes = (overlapStart - overlapEnd) / 60_000;
    const latest = rows.reduce((a, b) => (b.start > a.start ? b : a));
    const earliest = rows.reduce((a, b) => (b.end < a.end ? b : a));
    const advice =
      gapMinutes === 0
        ? "The two closest windows touch without sharing a single minute."
        : `The closest windows miss by ${formatDuration(gapMinutes)}.`;
    put(
      out,
      "Overlap",
      `No overlap. ${advice} Start the day in ${latest.zone.label} ${formatDuration(gapMinutes + 60)} earlier, ` +
        `or finish the day in ${earliest.zone.label} ${formatDuration(gapMinutes + 60)} later, to share a full hour.`,
    );
  }

  return out;
}

export default { run } satisfies ToolLogic<string, TimezonePlannerResult, TimezonePlannerOpts>;
