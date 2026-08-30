import { ToolError, type ToolLogic } from "../types";

/**
 * Click speed math, kept pure so the live panel and the unit tests measure the
 * same thing. Nothing here reads a clock: the panel records real event
 * timestamps and hands the array in, so every number below is reproducible
 * from that array alone.
 */

/** The test windows the panel offers, in seconds. */
export const DURATIONS = [5, 10, 30, 60, 100] as const;

/** Longest window `run()` will accept, so a typo cannot ask for a year. */
const MAX_DURATION_SECONDS = 3600;

export interface ClickRank {
  /** Short band name, e.g. "Fast". */
  label: string;
  /** One honest sentence about what that band usually means. */
  description: string;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function assertCount(clicks: number): void {
  if (!Number.isFinite(clicks) || clicks < 0)
    throw new ToolError(
      "bad-number",
      `A click count must be a number of zero or more, got ${String(clicks)}.`,
      "Enter a whole number of clicks, such as 73.",
    );
}

function assertDuration(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new ToolError(
      "bad-duration",
      `The test length must be a positive number of seconds, got ${String(seconds)}.`,
      "Choose one of the 5, 10, 30, 60, or 100 second windows.",
    );
  if (seconds > MAX_DURATION_SECONDS)
    throw new ToolError(
      "bad-duration",
      `The test length must be ${MAX_DURATION_SECONDS} seconds or less, got ${String(seconds)}.`,
      "Choose one of the 5, 10, 30, 60, or 100 second windows.",
    );
}

/** Clicks per second, rounded to two decimals. */
export function cps(clicks: number, seconds: number): number {
  assertCount(clicks);
  assertDuration(seconds);
  return round(clicks / seconds, 2);
}

/**
 * The band a rate falls in, with a plain description. The top band names the
 * two techniques that produce it rather than treating the number as a score,
 * because a rate above ten is a different activity, not a better click.
 */
export function rank(value: number): ClickRank {
  if (!Number.isFinite(value) || value < 0)
    throw new ToolError(
      "bad-number",
      `A clicks per second value must be a number of zero or more, got ${String(value)}.`,
      "Pass the measured rate, such as 7.3.",
    );
  if (value < 4)
    return {
      label: "Relaxed",
      description:
        "A comfortable pace. This is where most people land when they are not trying to go fast.",
    };
  if (value < 6)
    return {
      label: "Average",
      description: "The usual range for someone clicking as fast as one finger comfortably allows.",
    };
  if (value < 8)
    return {
      label: "Fast",
      description: "Above the range most people reach with a single finger and a rested hand.",
    };
  if (value < 10)
    return {
      label: "Very fast",
      description: "Normally the result of practice, a light mouse switch, or a short test window.",
    };
  return {
    label: "Jitter or butterfly range",
    description:
      "Rates above ten per second usually come from jitter clicking (tensing the arm so the finger vibrates) or butterfly clicking (alternating two fingers on one button), not from ordinary clicking.",
  };
}

export interface ClickSummary {
  /** Clicks counted inside the window. */
  clicks: number;
  /** Length of the window, in seconds. */
  durationSeconds: number;
  /** Average clicks per second across the whole window. */
  cps: number;
  /** Most clicks landing in any one second span, measured as a sliding window. */
  peakCps: number;
  /** Clicks in each whole second of the window, index 0 being the first second. */
  perSecond: number[];
  rank: ClickRank;
}

/**
 * Turns raw click timestamps (milliseconds from the start of the test) into
 * the full summary. Timestamps that are not finite, are negative, or land past
 * the end of the window are dropped, so a stray event after the timer stopped
 * cannot inflate the rate.
 *
 * `peakCps` is a sliding window, not a bucket maximum: a burst straddling the
 * boundary between second three and second four still counts as one burst.
 */
export function summarize(timestampsMs: readonly number[], durationSeconds: number): ClickSummary {
  assertDuration(durationSeconds);
  const limit = durationSeconds * 1000;
  const clean = (timestampsMs ?? [])
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= limit)
    .slice()
    .sort((a, b) => a - b);

  const buckets = new Array<number>(Math.ceil(durationSeconds)).fill(0);
  for (const t of clean) {
    const index = Math.min(buckets.length - 1, Math.floor(t / 1000));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }

  let peak = 0;
  let start = 0;
  for (let end = 0; end < clean.length; end += 1) {
    while (clean[end]! - clean[start]! >= 1000) start += 1;
    peak = Math.max(peak, end - start + 1);
  }

  const rate = cps(clean.length, durationSeconds);
  return {
    clicks: clean.length,
    durationSeconds,
    cps: rate,
    peakCps: peak,
    perSecond: buckets,
    rank: rank(rate),
  };
}

export interface ClickSpeedOpts {
  /** Window length in seconds. Defaults to 10. */
  duration?: number | string;
  [key: string]: unknown;
}

/** True when the text is one plain number with no separators. */
function isSingleNumber(text: string): boolean {
  return /^\d+(\.\d+)?$/.test(text);
}

function parseTimestamps(text: string): number[] {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.map((token) => {
    const value = Number(token);
    if (!Number.isFinite(value) || value < 0)
      throw new ToolError(
        "bad-number",
        `"${token}" is not a click timestamp in milliseconds.`,
        "Paste click times in milliseconds from the start of the test, separated by commas or spaces, or paste a single click count instead.",
      );
    return value;
  });
}

function formatSeconds(seconds: number): string {
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * Generic entry point. The input is either a single click count, or the list of
 * click timestamps in milliseconds from the start of the test, which unlocks
 * the peak and per second rows. The live panel calls `summarize()` directly.
 */
export function run(input: string, opts: ClickSpeedOpts): Record<string, string> {
  const text = (input ?? "").trim();
  if (text === "")
    throw new ToolError(
      "empty-input",
      "Enter a click count, or the click timestamps in milliseconds, to score a run.",
      "Type a number such as 73, or paste timestamps like 0, 140, 271, 402.",
    );

  const rawDuration = opts?.duration ?? 10;
  const duration = typeof rawDuration === "string" ? Number(rawDuration) : rawDuration;
  assertDuration(duration);

  if (isSingleNumber(text)) {
    const clicks = Number(text);
    const rate = cps(clicks, duration);
    const band = rank(rate);
    return {
      "Clicks per second": rate.toFixed(2),
      "Total clicks": String(clicks),
      "Test length": formatSeconds(duration),
      Ranking: band.label,
      "What that means": band.description,
    };
  }

  const summary = summarize(parseTimestamps(text), duration);
  return {
    "Clicks per second": summary.cps.toFixed(2),
    "Total clicks": String(summary.clicks),
    "Test length": formatSeconds(summary.durationSeconds),
    "Peak in any one second": String(summary.peakCps),
    "Clicks by second": summary.perSecond.join(", "),
    Ranking: summary.rank.label,
    "What that means": summary.rank.description,
  };
}

export default { run } satisfies ToolLogic<string, Record<string, string>, ClickSpeedOpts>;
