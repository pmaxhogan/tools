import { ToolError, type ToolLogic } from "../types";

/**
 * The pure layer of the reaction time test.
 *
 * Everything here is arithmetic over numbers the panel measured: the wait
 * before the cue (drawn from a seeded PRNG so a shared link replays the same
 * sequence of waits), the classification of a press against the phase the
 * trial was in, and the statistics over a set of finished trials. No timers,
 * no DOM, no clock reads: the panel owns `performance.now()` and hands the
 * numbers in.
 */

/** Default lower bound of the random wait before the cue, in milliseconds. */
export const DEFAULT_MIN_DELAY_MS = 2000;
/** Default upper bound of the random wait before the cue, in milliseconds. */
export const DEFAULT_MAX_DELAY_MS = 5000;
/** Shortest wait a caller may configure. Below this the cue is unfair. */
export const DELAY_FLOOR_MS = 500;
/** Longest wait a caller may configure. */
export const DELAY_CEILING_MS = 15000;
/** Default number of trials in one run. */
export const DEFAULT_ROUNDS = 5;
/** Smallest and largest round counts the tool accepts. */
export const ROUND_LIMITS = { min: 1, max: 25 } as const;

/**
 * The window most published studies put a simple visual reaction in for an
 * alert adult on a normal screen. Used for the comparison scale and the
 * rating bands, both of which are honest about the caveats: display latency,
 * input latency, and browser event delivery all sit inside the measurement.
 */
export const TYPICAL_RANGE_MS = { min: 200, max: 250 } as const;

export type RatingBandId = "anticipated" | "very-fast" | "typical" | "average" | "slow";

export interface RatingBand {
  id: RatingBandId;
  /** Exclusive upper bound in milliseconds. The last band is Infinity. */
  maxMs: number;
  label: string;
  /** One honest sentence about what the band means. */
  note: string;
}

/**
 * Rating bands, ordered by upper bound. These describe where a time sits
 * against typical human visual reaction, not how good someone is: a reading
 * under 150 ms is far more likely to be an anticipated cue than a record.
 */
export const RATING_BANDS: readonly RatingBand[] = [
  {
    id: "anticipated",
    maxMs: 150,
    label: "Probably anticipated",
    note: "Under 150 ms is faster than a simple visual reaction usually goes, so the cue was most likely predicted rather than reacted to.",
  },
  {
    id: "very-fast",
    maxMs: 200,
    label: "Very fast",
    note: "Between 150 and 199 ms, faster than the range most people measure.",
  },
  {
    id: "typical",
    maxMs: 251,
    label: "Typical",
    note: "Between 200 and 250 ms, the range a simple visual reaction usually lands in.",
  },
  {
    id: "average",
    maxMs: 301,
    label: "Average",
    note: "Between 251 and 300 ms, a common reading on a laptop trackpad or a high latency display.",
  },
  {
    id: "slow",
    maxMs: Number.POSITIVE_INFINITY,
    label: "Slower than typical",
    note: "Over 300 ms. Display latency, input latency, and tiredness all push a reading this way.",
  },
];

/** The band a single time in milliseconds falls into. */
export function ratingFor(ms: number): RatingBand {
  for (const band of RATING_BANDS) {
    if (ms < band.maxMs) return band;
  }
  return RATING_BANDS[RATING_BANDS.length - 1]!;
}

/**
 * mulberry32: the same small deterministic PRNG the other seeded generators in
 * this repo use. Seeded from one 32 bit number, so a seed in the URL fragment
 * replays an identical sequence of waits on any machine.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DelayOpts {
  /** Deterministic seed. The same seed always yields the same wait sequence. */
  seed: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

function resolveBounds(opts: DelayOpts): { min: number; max: number } {
  const min = Math.round(opts.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
  const max = Math.round(opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);

  if (!Number.isFinite(min) || !Number.isFinite(max))
    throw new ToolError(
      "bad-delay-range",
      "The wait before the cue must be given as two numbers of milliseconds.",
      `Use a range inside ${DELAY_FLOOR_MS} to ${DELAY_CEILING_MS} ms, for example ${DEFAULT_MIN_DELAY_MS} to ${DEFAULT_MAX_DELAY_MS}.`,
    );

  if (min < DELAY_FLOOR_MS || max > DELAY_CEILING_MS)
    throw new ToolError(
      "bad-delay-range",
      `The wait before the cue must sit between ${DELAY_FLOOR_MS} and ${DELAY_CEILING_MS} ms, got ${min} to ${max}.`,
      `Pick a shortest wait of at least ${DELAY_FLOOR_MS} ms and a longest wait of at most ${DELAY_CEILING_MS} ms.`,
    );

  if (min > max)
    throw new ToolError(
      "bad-delay-range",
      `The shortest wait (${min} ms) is longer than the longest wait (${max} ms).`,
      "Swap the two values so the shortest wait comes first.",
    );

  return { min, max };
}

/**
 * The whole sequence of waits for one run, drawn from a single seeded stream.
 *
 * Drawing every wait from one stream rather than reseeding per trial is what
 * keeps consecutive waits independent: adjacent seeds fed to the same PRNG
 * produce correlated first draws, which a player could learn to read.
 */
export function delaysForTest(rounds: number, opts: DelayOpts): number[] {
  const count = Math.floor(rounds);
  if (!Number.isFinite(count) || count < ROUND_LIMITS.min || count > ROUND_LIMITS.max)
    throw new ToolError(
      "bad-rounds",
      `Round count must be between ${ROUND_LIMITS.min} and ${ROUND_LIMITS.max}, got ${rounds}.`,
      `Choose a number of rounds between ${ROUND_LIMITS.min} and ${ROUND_LIMITS.max}.`,
    );

  const { min, max } = resolveBounds(opts);
  const rng = mulberry32(opts.seed);
  const span = max - min;
  return Array.from({ length: count }, () => min + Math.round(rng() * span));
}

/** The wait before the cue for one trial, in milliseconds. Zero based index. */
export function delayForTrial(index: number, opts: DelayOpts): number {
  const i = Math.floor(index);
  if (!Number.isFinite(i) || i < 0)
    throw new ToolError(
      "bad-trial-index",
      `Trial index must be zero or greater, got ${index}.`,
      "Pass the zero based position of the trial.",
    );
  return delaysForTest(i + 1, opts)[i]!;
}

/** The phase a trial is in when a press lands. */
export type TrialPhase = "idle" | "waiting" | "cue" | "done";

export type PressOutcome =
  /** The run was not started yet: this press starts it. */
  | { kind: "start" }
  /** Pressed before the cue appeared. */
  | { kind: "false-start"; earlyByMs: number }
  /** A real reaction, measured from the cue. */
  | { kind: "reaction"; timeMs: number }
  /** Nothing to react to: the run already finished. */
  | { kind: "ignored" };

export interface PressInput {
  phase: TrialPhase;
  /** When the press landed, on the same clock as `cueAtMs`. */
  pressedAtMs: number;
  /** When the cue is or was scheduled to appear. Null outside a live trial. */
  cueAtMs: number | null;
}

/**
 * Classifies one press. Pure so the false start rule is unit tested rather
 * than buried in an event handler: a press during the wait is a false start,
 * a press after the cue is a reaction, and a press with no live trial either
 * starts the run or is ignored.
 */
export function classifyPress(input: PressInput): PressOutcome {
  const { phase, pressedAtMs, cueAtMs } = input;
  if (phase === "idle") return { kind: "start" };
  if (phase === "done") return { kind: "ignored" };
  if (cueAtMs === null) return { kind: "ignored" };

  if (phase === "waiting") {
    if (pressedAtMs < cueAtMs) return { kind: "false-start", earlyByMs: cueAtMs - pressedAtMs };
    return { kind: "reaction", timeMs: 0 };
  }

  return { kind: "reaction", timeMs: Math.max(0, pressedAtMs - cueAtMs) };
}

export interface ReactionSummary {
  count: number;
  averageMs: number;
  bestMs: number;
  worstMs: number;
  medianMs: number;
  /** Population standard deviation, in milliseconds. */
  stdDevMs: number;
  /** Band the average falls into. */
  rating: string;
  ratingBand: RatingBandId;
  ratingNote: string;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function medianOf(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Statistics over the finished trials of one run. False starts are not trials,
 * so they never appear here; the panel counts them separately and `report`
 * prints them alongside.
 */
export function summarize(times: readonly number[]): ReactionSummary {
  if (times.length === 0)
    throw new ToolError(
      "no-trials",
      "There are no finished trials to summarize.",
      "Complete at least one round, then read the results.",
    );

  const sorted = [...times].sort((a, b) => a - b);
  const total = sorted.reduce((sum, t) => sum + t, 0);
  const average = total / sorted.length;
  const variance = sorted.reduce((sum, t) => sum + (t - average) ** 2, 0) / sorted.length;
  const band = ratingFor(average);

  return {
    count: sorted.length,
    averageMs: round1(average),
    bestMs: round1(sorted[0]!),
    worstMs: round1(sorted[sorted.length - 1]!),
    medianMs: round1(medianOf(sorted)),
    stdDevMs: round1(Math.sqrt(variance)),
    rating: band.label,
    ratingBand: band.id,
    ratingNote: band.note,
  };
}

/**
 * The labeled record both surfaces show: the generic shell renders it as rows,
 * and the panel copies it as the shareable summary. False starts are reported
 * rather than hidden, because a run with four of them is a different run.
 */
export function report(times: readonly number[], falseStarts = 0): Record<string, string> {
  const stats = summarize(times);
  const out: Record<string, string> = {
    Trials: String(stats.count),
    Average: `${stats.averageMs} ms`,
    Best: `${stats.bestMs} ms`,
    Median: `${stats.medianMs} ms`,
    Worst: `${stats.worstMs} ms`,
    "Standard deviation": `${stats.stdDevMs} ms`,
    Rating: `${stats.rating} (typical is ${TYPICAL_RANGE_MS.min} to ${TYPICAL_RANGE_MS.max} ms)`,
  };
  if (falseStarts > 0) out["False starts"] = String(falseStarts);
  return out;
}

export interface ReactionRunOpts {
  /** Number of trials the panel runs. Not used by `run`, which reads times. */
  rounds?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  seed?: string;
  [key: string]: unknown;
}

/**
 * Generic surface entry point: paste the trial times you measured, in
 * milliseconds, separated by commas, spaces, or newlines, and get the same
 * statistics the live panel shows.
 */
export function run(input: string, _opts: ReactionRunOpts): Record<string, string> {
  const parts = (input ?? "")
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0)
    throw new ToolError(
      "empty-input",
      "No trial times were given.",
      "Paste your reaction times in milliseconds, separated by commas or newlines, or run the live test above.",
    );

  const times = parts.map((part) => {
    const value = Number(part.replace(/ms$/i, ""));
    if (!Number.isFinite(value) || value < 0)
      throw new ToolError(
        "bad-number",
        `"${part}" is not a reaction time in milliseconds.`,
        "Every entry must be a number of milliseconds that is zero or greater, for example 231 or 198.4.",
      );
    return value;
  });

  return report(times);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, ReactionRunOpts>;
