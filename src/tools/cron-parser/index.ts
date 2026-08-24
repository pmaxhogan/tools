import { Cron } from "croner";
import cronstrue from "cronstrue";
import { ToolError, type ToolLogic } from "../types";

export interface CronOpts {
  /** IANA zone name applied to the run preview, e.g. 'UTC' or 'America/Chicago'. */
  tz: string;
  /** True when the expression carries a leading seconds field (six fields). */
  seconds: boolean;
  [key: string]: unknown;
}

export interface CronResult {
  [label: string]: string;
}

/** How many upcoming fire times the preview shows. */
export const RUN_COUNT = 10;

/**
 * cronstrue throws a bare string ('Error: minutes part must be >= 0 and <= 59');
 * croner throws a real Error. Normalize both and drop the redundant prefix so the
 * underlying parse reason can be embedded in a ToolError message.
 */
function reason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error:\s*/i, "").trim();
}

/** A known-good expression with the right number of fields for the current mode. */
export function example(seconds: boolean): string {
  return seconds ? "0 */15 9-17 * * 1-5" : "*/15 9-17 * * 1-5";
}

function invalid(expr: string, err: unknown, seconds: boolean): ToolError {
  const why = reason(err);
  const fieldCount = /requires exactly|parts? (are|is) required|has \d+ parts/i.test(why);
  const shape = seconds
    ? "six fields: second minute hour day-of-month month day-of-week"
    : "five fields: minute hour day-of-month month day-of-week";
  const hint = fieldCount
    ? ` If your expression has a different number of fields, toggle the "expression includes seconds" option.`
    : "";
  return new ToolError(
    "invalid-cron",
    `Could not parse "${expr}" as a cron expression: ${why}`,
    `Use ${shape}, for example ${example(seconds)}.${hint}`,
  );
}

function assertZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new ToolError(
      "bad-timezone",
      `Unknown time zone "${tz}".`,
      "Use an IANA name like UTC, America/Chicago, Europe/Berlin, or Asia/Tokyo.",
    );
  }
}

/**
 * Render an instant as ISO 8601 in the given zone, keeping the zone's UTC offset
 * (`2026-03-08T03:00:00-04:00`) so the preview reads as wall-clock time there and
 * still round-trips through `new Date(...)`.
 */
export function isoInZone(d: Date, tz: string): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(d)) {
    parts[part.type] = part.value;
  }
  const zone = parts.timeZoneName ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Plain-English reading of a cron expression. Throws ToolError on a parse failure. */
export function describeExpression(expr: string, seconds = false): string {
  try {
    return cronstrue.toString(expr, { throwExceptionOnParseError: true });
  } catch (err) {
    throw invalid(expr, err, seconds);
  }
}

/**
 * Upcoming fire times. `from` is injectable so tests never depend on the wall clock.
 * Returns an empty array for expressions that can never match (e.g. `0 0 30 2 *`).
 */
export function nextRuns(
  expr: string,
  opts: { tz?: string; seconds?: boolean; from?: Date; count?: number } = {},
): Date[] {
  const tz = assertZone(opts.tz || "UTC");
  const count = opts.count ?? RUN_COUNT;
  try {
    const job = new Cron(expr, { timezone: tz, mode: opts.seconds ? "6-part" : "5-part" });
    return job.nextRuns(count, opts.from ?? new Date());
  } catch (err) {
    throw invalid(expr, err, !!opts.seconds);
  }
}

export function run(input: string, opts: CronOpts): CronResult {
  const expr = (input ?? "").trim().replace(/\s+/g, " ");
  const seconds = !!opts?.seconds;
  if (!expr)
    throw new ToolError(
      "empty-input",
      "Enter a cron expression to explain.",
      `Try ${example(seconds)}.`,
    );

  const tz = assertZone((opts?.tz ?? "").trim() || "UTC");

  // Parse with croner first so field-count and range problems win over cronstrue's
  // looser reading of the same expression.
  const runs = nextRuns(expr, { tz, seconds, count: RUN_COUNT });

  const out: CronResult = { Description: describeExpression(expr, seconds) };
  if (runs.length === 0) {
    out["Next runs"] = "This expression never matches a future date.";
    return out;
  }
  runs.forEach((d, i) => {
    out[`Next run ${i + 1}`] = isoInZone(d, tz);
  });
  return out;
}

export default { run } satisfies ToolLogic<string, CronResult, CronOpts>;
