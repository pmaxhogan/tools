import { Temporal } from "@js-temporal/polyfill";
import { ToolError, type ToolLogic } from "../types";

export interface TemporalOpts {
  /** IANA zone used to interpret a wall-clock input and to report offsets. */
  timeZone: string;
  /** Optional ISO 8601 duration to add, e.g. "P1M2DT3H". */
  add?: string;
  [key: string]: unknown;
}

export interface TemporalResult {
  [label: string]: string;
}

const DATE_FIX = "Use ISO 8601, e.g. 2026-03-08 or 2026-03-08T01:30.";
const DURATION_FIX = "Use an ISO 8601 duration like P1D, PT90M, or P1M2DT3H.";

/** Trailing "[Zone/Name]" annotation, so the input is a full ZonedDateTime. */
const HAS_ZONE_BRACKET = /\[[^\]]+\]\s*$/;
/** A time component after the date part. */
const HAS_TIME = /[T\s]\d{1,2}:\d{2}/;
/** A UTC designator or numeric offset at the end, so the input pins an instant. */
const HAS_OFFSET = /[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const MONTHS = [
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
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "+05:30" / "-05:00" from a nanosecond offset. */
function formatOffsetNs(ns: number): string {
  const sign = ns < 0 ? "-" : "+";
  const totalMinutes = Math.round(Math.abs(ns) / 60_000_000_000);
  return `${sign}${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

/** Validates the selected zone once, with an actionable error. */
function checkZone(tz: string): string {
  const zone = (tz || "").trim() || "UTC";
  try {
    Temporal.PlainDateTime.from("2000-01-01T12:00").toZonedDateTime(zone);
  } catch {
    throw new ToolError(
      "bad-timezone",
      `Unknown time zone "${zone}".`,
      "Use an IANA name like America/New_York, Europe/Berlin, or UTC.",
    );
  }
  return zone;
}

type WallKind = "normal" | "gap" | "overlap";

/**
 * Classifies a wall-clock time against a zone without trusting the polyfill's
 * "reject" error message: resolve it both ways and compare.
 *
 * - both resolutions are the same instant  -> normal
 * - two instants, wall time preserved      -> fall-back overlap (time happens twice)
 * - two instants, wall time moved          -> spring-forward gap (time never happens)
 */
function classifyWall(pdt: Temporal.PlainDateTime, tz: string): WallKind {
  const earlier = pdt.toZonedDateTime(tz, { disambiguation: "earlier" });
  const later = pdt.toZonedDateTime(tz, { disambiguation: "later" });
  if (earlier.epochNanoseconds === later.epochNanoseconds) return "normal";
  return earlier.toPlainDateTime().equals(pdt) ? "overlap" : "gap";
}

/** Whether a zone shifts its offset during the given year, and its standard offset. */
function zoneProfile(tz: string, year: number): { observesDst: boolean; standardNs: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let month = 1; month <= 12; month++) {
    const ns = Temporal.PlainDateTime.from({ year, month, day: 1, hour: 12 }).toZonedDateTime(
      tz,
    ).offsetNanoseconds;
    if (ns < min) min = ns;
    if (ns > max) max = ns;
  }
  return { observesDst: min !== max, standardNs: min };
}

interface Parsed {
  typeName: string;
  /** Canonical string of the Temporal object the input parsed into. */
  canonical: string;
  /** The instant-bearing view. Date-only input is anchored to start of day. */
  zdt: Temporal.ZonedDateTime;
  /** True when the input carried no time, so instant fields are anchored. */
  dateOnly: boolean;
  /** True when the input already pinned an instant (bracketed zone, Z, or offset). */
  exact: boolean;
  wallKind: WallKind;
}

function parseInput(raw: string, tz: string): Parsed {
  const text = raw.trim();

  if (HAS_ZONE_BRACKET.test(text)) {
    let zdt: Temporal.ZonedDateTime;
    try {
      zdt = Temporal.ZonedDateTime.from(text);
    } catch (err) {
      throw new ToolError("bad-date", `Could not parse "${text}": ${describe(err)}`, DATE_FIX);
    }
    return {
      typeName: "Temporal.ZonedDateTime",
      canonical: zdt.toString(),
      zdt,
      dateOnly: false,
      exact: true,
      wallKind: classifyWall(zdt.toPlainDateTime(), zdt.timeZoneId),
    };
  }

  if (HAS_TIME.test(text) && HAS_OFFSET.test(text)) {
    let instant: Temporal.Instant;
    try {
      instant = Temporal.Instant.from(text.replace(" ", "T"));
    } catch (err) {
      throw new ToolError("bad-date", `Could not parse "${text}": ${describe(err)}`, DATE_FIX);
    }
    const zdt = instant.toZonedDateTimeISO(tz);
    return {
      typeName: "Temporal.Instant",
      canonical: instant.toString(),
      zdt,
      dateOnly: false,
      exact: true,
      // An exact instant can never land in a gap, but it can land in an overlap.
      wallKind: classifyWall(zdt.toPlainDateTime(), tz),
    };
  }

  if (HAS_TIME.test(text)) {
    let pdt: Temporal.PlainDateTime;
    try {
      pdt = Temporal.PlainDateTime.from(text);
    } catch (err) {
      throw new ToolError("bad-date", `Could not parse "${text}": ${describe(err)}`, DATE_FIX);
    }
    return {
      typeName: "Temporal.PlainDateTime",
      canonical: pdt.toString(),
      zdt: pdt.toZonedDateTime(tz),
      dateOnly: false,
      exact: false,
      wallKind: classifyWall(pdt, tz),
    };
  }

  let pd: Temporal.PlainDate;
  try {
    pd = Temporal.PlainDate.from(text);
  } catch (err) {
    throw new ToolError("bad-date", `Could not parse "${text}": ${describe(err)}`, DATE_FIX);
  }
  return {
    typeName: "Temporal.PlainDate",
    canonical: pd.toString(),
    zdt: pd.toZonedDateTime(tz),
    dateOnly: true,
    exact: false,
    wallKind: "normal",
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dstRow(parsed: Parsed, tz: string): string {
  const { zdt } = parsed;
  const profile = zoneProfile(tz, zdt.year);
  const parts: string[] = [];

  if (!profile.observesDst) {
    parts.push(`${tz} does not observe daylight saving time in ${zdt.year}.`);
  } else {
    const standard = formatOffsetNs(profile.standardNs);
    const inDst = zdt.offsetNanoseconds > profile.standardNs;
    parts.push(
      inDst
        ? `In daylight saving time: offset ${zdt.offset} is ahead of the ${standard} standard offset.`
        : `In standard time: offset ${zdt.offset} matches the ${standard} standard offset.`,
    );
  }

  if (parsed.wallKind === "gap") {
    parts.push(
      `Spring forward: this wall-clock time does not exist due to spring-forward, so it was moved to ${zdt.toPlainDateTime().toString()} (${zdt.offset}).`,
    );
  } else if (parsed.wallKind === "overlap") {
    const earlier = zdt.toPlainDateTime().toZonedDateTime(tz, { disambiguation: "earlier" });
    const which = zdt.epochNanoseconds === earlier.epochNanoseconds ? "earlier" : "later";
    parts.push(
      `Fall back: this wall-clock time happens twice in ${tz}, and this is the ${which} of the two instants.`,
    );
  } else if (!parsed.dateOnly) {
    parts.push("This wall-clock time is unambiguous: it happens exactly once.");
  }

  const hours = zdt.hoursInDay;
  if (hours !== 24) parts.push(`This local day is ${hours} hours long, not 24.`);

  return parts.join(" ");
}

function nextChangeRow(zdt: Temporal.ZonedDateTime): string {
  const next = zdt.getTimeZoneTransition("next");
  if (!next) return `No further offset change scheduled in ${zdt.timeZoneId}.`;
  const before = next.subtract({ nanoseconds: 1 });
  return `${next.toPlainDateTime().toString()} local, offset ${before.offset} becomes ${next.offset}.`;
}

function addRow(parsed: Parsed, raw: string, tz: string): TemporalResult {
  let duration: Temporal.Duration;
  try {
    duration = Temporal.Duration.from(raw.trim());
  } catch (err) {
    throw new ToolError(
      "bad-duration",
      `Could not parse "${raw.trim()}" as a duration: ${describe(err)}`,
      DURATION_FIX,
    );
  }

  if (parsed.dateOnly) {
    const result = parsed.zdt.toPlainDate().add(duration);
    return {
      "After adding": `${duration.toString()} gives ${result.toString()} (calendar date math, no time of day).`,
    };
  }

  const result = parsed.zdt.add(duration);
  const changed = result.offset !== parsed.zdt.offset;
  const note = changed
    ? `offset ${result.offset}, changed from ${parsed.zdt.offset} across a DST transition`
    : `offset ${result.offset}, unchanged`;
  return {
    "After adding": `${duration.toString()} gives ${result.toPlainDateTime().toString()} in ${tz} (${note}).`,
  };
}

export function run(input: string, opts: TemporalOpts): TemporalResult {
  const text = (input ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "Enter a date or date-time.",
      'Try "2026-03-08T01:30" or "2026-03-08".',
    );
  }

  const tz = checkZone(opts?.timeZone ?? "UTC");
  const parsed = parseInput(text, tz);
  const { zdt } = parsed;
  const date = zdt.toPlainDate();
  // A bracketed input carries its own zone, which may differ from the selected
  // one. Offset and DST always describe the zone the value actually lives in.
  const zone = zdt.timeZoneId;

  const out: TemporalResult = {};

  out["Input parsed as"] = parsed.exact
    ? `${parsed.typeName}: ${parsed.canonical}`
    : `${parsed.typeName}: ${parsed.canonical}, interpreted in ${tz}`;

  if (parsed.dateOnly) {
    out["Anchored to"] = `Start of day in ${tz}: ${zdt.toString()}`;
  }

  const ms = zdt.epochMilliseconds;
  out["Instant (UTC)"] = zdt.toInstant().toString();
  out["Epoch seconds"] = String(Math.floor(ms / 1000));
  out["Epoch ms"] = String(ms);
  out["Offset"] = `${zdt.offset} (${zone})`;
  out["DST"] = dstRow(parsed, zone);
  out["Next DST change"] = nextChangeRow(zdt);

  const addRaw = typeof opts?.add === "string" ? opts.add.trim() : "";
  if (addRaw) Object.assign(out, addRow(parsed, addRaw, zone));

  out["Day of week"] = `${WEEKDAYS[date.dayOfWeek - 1]} (ISO day ${date.dayOfWeek})`;
  out["Day of year"] = `${date.dayOfYear} of ${date.daysInYear}`;
  out["ISO week"] = `${date.yearOfWeek}-W${pad2(date.weekOfYear ?? 0)}`;
  out["Days in month"] = `${date.daysInMonth} (${MONTHS[date.month - 1]} ${date.year})`;
  out["Leap year"] = date.inLeapYear
    ? `Yes, ${date.year} is a leap year`
    : `No, ${date.year} is not a leap year`;

  return out;
}

export default { run } satisfies ToolLogic<string, TemporalResult, TemporalOpts>;
