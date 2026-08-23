import { ToolError, type ToolLogic } from "../types";

/**
 * Standard mouse polling rates (Hz) that firmware reports itself as. A
 * measured rate is snapped to the nearest of these, on a log scale so 125 vs
 * 250 is judged the same way 4000 vs 8000 is.
 */
const STANDARD_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

export type PollingClassification =
  "125 Hz" | "250 Hz" | "500 Hz" | "1000 Hz" | "2000 Hz" | "4000 Hz" | "8000 Hz" | "unknown";

export interface PollingRateResult {
  /** Measured rate in Hz, derived from the median inter-event interval. */
  hz: number;
  /** Median interval between consecutive move events, in milliseconds. */
  median: number;
  /** 95th percentile interval, in milliseconds: catches occasional stalls/coalescing. */
  p95intervalMs: number;
  /** Mean absolute deviation from the median interval, in milliseconds. */
  jitterMs: number;
  /** Number of timestamps the measurement was built from. */
  samples: number;
  classification: PollingClassification;
}

const MIN_INTERVALS_FOR_READING = 4;
/** Above this ratio of mean-deviation to median interval, the signal is too noisy to classify. */
const MAX_JITTER_RATIO = 0.5;
/** A measured Hz must land within this multiplicative band of a standard rate to count as a match. */
const CLASSIFY_BAND = [0.75, 1.33] as const;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Measures polling rate from a series of pointermove timestamps (milliseconds,
 * e.g. from PointerEvent.timeStamp or getCoalescedEvents()). Uses the median
 * inter-event interval rather than the mean, since a single dropped frame or
 * a burst of coalesced-then-flushed events would otherwise skew an average.
 * Browsers commonly coalesce pointermove delivery to the display's refresh
 * rate (rAF), which can make a 1000 Hz mouse read as ~60-144 Hz unless the
 * caller feeds in getCoalescedEvents() timestamps instead of the dispatched
 * event's own timeStamp.
 */
export function pollingRateFromTimestamps(timestamps: number[]): PollingRateResult {
  const clean = (timestamps ?? [])
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);

  const intervals: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i] - clean[i - 1];
    if (d > 0) intervals.push(d);
  }

  const samples = clean.length;

  if (intervals.length < MIN_INTERVALS_FOR_READING) {
    return { hz: 0, median: 0, p95intervalMs: 0, jitterMs: 0, samples, classification: "unknown" };
  }

  const med = median(intervals);
  const p95 = percentile(intervals, 95);
  const meanAbsDev = intervals.reduce((sum, v) => sum + Math.abs(v - med), 0) / intervals.length;
  const hz = med > 0 ? 1000 / med : 0;
  const jitterRatio = med > 0 ? meanAbsDev / med : Infinity;

  let classification: PollingClassification = "unknown";
  if (hz > 0) {
    let best: (typeof STANDARD_POLLING_RATES)[number] = STANDARD_POLLING_RATES[0];
    let bestDist = Infinity;
    for (const rate of STANDARD_POLLING_RATES) {
      const dist = Math.abs(Math.log2(hz) - Math.log2(rate));
      if (dist < bestDist) {
        bestDist = dist;
        best = rate;
      }
    }
    const ratio = hz / best;
    const withinBand = ratio >= CLASSIFY_BAND[0] && ratio <= CLASSIFY_BAND[1];
    if (withinBand && jitterRatio <= MAX_JITTER_RATIO) {
      classification = `${best} Hz` as PollingClassification;
    }
  }

  return {
    hz: round(hz, 1),
    median: round(med, 3),
    p95intervalMs: round(p95, 3),
    jitterMs: round(meanAbsDev, 3),
    samples,
    classification,
  };
}

export interface DpiTravelInput {
  /** Sum of movementX (or equivalent raw counts) over one straight run. */
  counts: number;
  /** Physical distance actually traveled, in inches. */
  physicalDistanceInches: number;
}

export interface DpiResult {
  dpi: number;
  nearestCommonDpi: number;
  note: string;
}

const COMMON_DPI = [400, 800, 1200, 1600, 3200];
const RAW_COUNTS_NOTE =
  "This assumes the counts are raw device counts, not scaled CSS pixels. movementX is CSS pixels unless the page holds pointer lock; Chrome reports raw device counts through movementX while pointer lock is active, which is why the panel locks the pointer before this run.";

/**
 * Converts a travel run (summed raw counts over a known physical distance)
 * into a DPI reading and the nearest common marketed DPI value.
 */
export function dpiFromTravel(input: DpiTravelInput): DpiResult {
  const { counts, physicalDistanceInches } = input;

  if (!Number.isFinite(counts) || counts === 0) {
    throw new ToolError(
      "bad-travel-counts",
      "Travel counts must be a non-zero number.",
      "Move the mouse in one straight run while pointer lock is active and sum the movementX values.",
    );
  }
  if (!Number.isFinite(physicalDistanceInches) || physicalDistanceInches <= 0) {
    throw new ToolError(
      "bad-travel-distance",
      "Physical distance must be a positive number of inches.",
      "Set the physical distance option to how far you actually moved the mouse, measured with a ruler.",
    );
  }

  const dpi = Math.abs(counts) / physicalDistanceInches;

  let nearestCommonDpi = COMMON_DPI[0];
  let bestDist = Infinity;
  for (const candidate of COMMON_DPI) {
    const dist = Math.abs(dpi - candidate);
    if (dist < bestDist) {
      bestDist = dist;
      nearestCommonDpi = candidate;
    }
  }

  return { dpi: Math.round(dpi), nearestCommonDpi, note: RAW_COUNTS_NOTE };
}

export interface AccelerationSample {
  /** Elapsed time since the previous sample, in milliseconds. */
  dt: number;
  /** Raw movement counts since the previous sample (movementX under pointer lock). */
  dx: number;
}

export type AccelerationVerdict = "linear" | "accelerated";

export interface AccelerationResult {
  slowCounts: number;
  fastCounts: number;
  /** Average counts per millisecond in each run, for sanity-checking that "fast" was actually faster. */
  slowSpeed: number;
  fastSpeed: number;
  /** fastCounts / slowCounts: how much more travel the fast run reported for what should be the same physical distance. */
  ratio: number;
  verdict: AccelerationVerdict;
}

/** fastCounts/slowCounts at or above this ratio is read as pointer acceleration, not measurement noise. */
const ACCELERATION_RATIO_THRESHOLD = 1.15;

function sumCounts(samples: AccelerationSample[]): number {
  return samples.reduce((sum, s) => sum + Math.abs(s.dx), 0);
}

function sumDt(samples: AccelerationSample[]): number {
  return samples.reduce((sum, s) => sum + s.dt, 0);
}

/**
 * Compares two runs across the same physical distance, one moved slowly and
 * one moved quickly. With acceleration (pointer precision enhancement) off,
 * both runs should report roughly the same total counts, since counts track
 * physical distance, not speed. A materially higher count on the fast run
 * means the OS or driver is scaling counts up with velocity.
 */
export function accelerationCheck(
  slow: AccelerationSample[],
  fast: AccelerationSample[],
): AccelerationResult {
  if (!Array.isArray(slow) || !Array.isArray(fast) || slow.length === 0 || fast.length === 0) {
    throw new ToolError(
      "insufficient-samples",
      "Need movement samples from both a slow run and a fast run to compare.",
      "Move the mouse across the same physical distance twice: once slowly, once quickly.",
    );
  }

  const slowCounts = sumCounts(slow);
  const fastCounts = sumCounts(fast);

  if (slowCounts <= 0 || fastCounts <= 0) {
    throw new ToolError(
      "no-movement",
      "No mouse movement was recorded in one of the two runs.",
      "Make sure the mouse actually moves during both the slow and the fast run.",
    );
  }

  const slowDt = sumDt(slow);
  const fastDt = sumDt(fast);
  const slowSpeed = slowDt > 0 ? slowCounts / slowDt : 0;
  const fastSpeed = fastDt > 0 ? fastCounts / fastDt : 0;
  const ratio = fastCounts / slowCounts;
  const verdict: AccelerationVerdict =
    ratio >= ACCELERATION_RATIO_THRESHOLD ? "accelerated" : "linear";

  return {
    slowCounts: Math.round(slowCounts),
    fastCounts: Math.round(fastCounts),
    slowSpeed: round(slowSpeed, 4),
    fastSpeed: round(fastSpeed, 4),
    ratio: round(ratio, 3),
    verdict,
  };
}

/** Standard button index to name, per the DOM MouseEvent.button convention. */
export function describeButtons(buttonIndex: number): string {
  switch (buttonIndex) {
    case 0:
      return "Left";
    case 1:
      return "Middle";
    case 2:
      return "Right";
    case 3:
      return "Back";
    case 4:
      return "Forward";
    default:
      return `Button ${buttonIndex}`;
  }
}

export interface ClickEvent {
  type: "down" | "up";
  /** MouseEvent.button index. */
  button: number;
  /** Event timestamp, in milliseconds. */
  t: number;
}

export interface ButtonClickStats {
  downs: number;
  ups: number;
  /** Average time between down and the following up, in milliseconds, or null if no complete pair was seen. */
  avgHeldMs: number | null;
}

export interface DoubleClickEvent {
  button: string;
  intervalMs: number;
}

export interface ClickStatsResult {
  perButton: Record<string, ButtonClickStats>;
  doubleClicks: DoubleClickEvent[];
  /** Two downs on the same button closer together than a human can intentionally click: likely contact bounce. */
  bounces: DoubleClickEvent[];
}

/** Two downs this close together on the same button cannot be an intentional double click. */
const BOUNCE_THRESHOLD_MS = 25;
/** Consecutive downs within this window count as a double click (matches common OS defaults). */
const DOUBLE_CLICK_MAX_MS = 500;

/**
 * Aggregates a stream of button down/up events into per-button counts, held
 * duration, double-click intervals, and switch bounce detection. A worn
 * mechanical switch fires two "down" events within a few milliseconds of a
 * single physical click; BOUNCE_THRESHOLD_MS separates that from a real fast
 * double click.
 */
export function clickStats(events: ClickEvent[]): ClickStatsResult {
  const clean = (events ?? [])
    .filter(
      (e): e is ClickEvent =>
        !!e &&
        (e.type === "down" || e.type === "up") &&
        typeof e.button === "number" &&
        typeof e.t === "number" &&
        Number.isFinite(e.t),
    )
    .sort((a, b) => a.t - b.t);

  const byButton = new Map<number, ClickEvent[]>();
  for (const e of clean) {
    const arr = byButton.get(e.button) ?? [];
    arr.push(e);
    byButton.set(e.button, arr);
  }

  const perButton: Record<string, ButtonClickStats> = {};
  const doubleClicks: DoubleClickEvent[] = [];
  const bounces: DoubleClickEvent[] = [];

  for (const [button, evs] of byButton) {
    const name = describeButtons(button);
    let downs = 0;
    let ups = 0;
    const heldDurations: number[] = [];
    let pendingDownT: number | null = null;
    let lastDownT: number | null = null;

    for (const e of evs) {
      if (e.type === "down") {
        downs++;
        if (lastDownT !== null) {
          const interval = e.t - lastDownT;
          if (interval <= BOUNCE_THRESHOLD_MS) {
            bounces.push({ button: name, intervalMs: round(interval, 1) });
          } else if (interval <= DOUBLE_CLICK_MAX_MS) {
            doubleClicks.push({ button: name, intervalMs: round(interval, 1) });
          }
        }
        lastDownT = e.t;
        pendingDownT = e.t;
      } else {
        ups++;
        if (pendingDownT !== null) {
          heldDurations.push(e.t - pendingDownT);
          pendingDownT = null;
        }
      }
    }

    perButton[name] = {
      downs,
      ups,
      avgHeldMs:
        heldDurations.length > 0
          ? round(heldDurations.reduce((s, v) => s + v, 0) / heldDurations.length, 1)
          : null,
    };
  }

  return { perButton, doubleClicks, bounces };
}

export interface ScrollEvent {
  /** WheelEvent.deltaY. */
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixel, 1 line, 2 page. */
  deltaMode: number;
}

export interface ScrollStatsResult {
  events: number;
  deltaModeLabel: string;
  deltaModeConsistent: boolean;
  /** Median absolute non-zero deltaY: the size of one wheel notch/click. Null if no scrolling was recorded. */
  notchSizeY: number | null;
  minAbsDeltaY: number | null;
  maxAbsDeltaY: number | null;
}

const DELTA_MODE_LABELS: Record<number, string> = { 0: "pixel", 1: "line", 2: "page" };

/** Summarizes a stream of wheel events: notch size in deltaY and delta mode consistency. */
export function scrollStats(events: ScrollEvent[]): ScrollStatsResult {
  const clean = (events ?? []).filter(
    (e): e is ScrollEvent =>
      !!e &&
      typeof e.deltaY === "number" &&
      Number.isFinite(e.deltaY) &&
      typeof e.deltaMode === "number",
  );

  if (clean.length === 0) {
    return {
      events: 0,
      deltaModeLabel: "unknown",
      deltaModeConsistent: true,
      notchSizeY: null,
      minAbsDeltaY: null,
      maxAbsDeltaY: null,
    };
  }

  const modes = new Set(clean.map((e) => e.deltaMode));
  const deltaModeConsistent = modes.size <= 1;
  const primaryMode = clean[0].deltaMode;
  const deltaModeLabel = DELTA_MODE_LABELS[primaryMode] ?? `mode ${primaryMode}`;

  const nonZeroAbs = clean.map((e) => Math.abs(e.deltaY)).filter((v) => v > 0);

  return {
    events: clean.length,
    deltaModeLabel,
    deltaModeConsistent,
    notchSizeY: nonZeroAbs.length ? round(median(nonZeroAbs), 2) : null,
    minAbsDeltaY: nonZeroAbs.length ? Math.min(...nonZeroAbs) : null,
    maxAbsDeltaY: nonZeroAbs.length ? Math.max(...nonZeroAbs) : null,
  };
}

export interface MouseReport {
  moveTimestamps?: unknown;
  travel?: unknown;
  acceleration?: unknown;
  clicks?: unknown;
  scrolls?: unknown;
}

export interface MouseTesterOpts {
  physicalDistanceCm: number;
  units: "cm" | "in";
  [key: string]: unknown;
}

const CM_PER_INCH = 2.54;

/** Resolves the physical distance to use for the DPI run, in inches, from options or an explicit override. */
function resolveDistanceInches(
  travel: { physicalDistanceInches?: unknown },
  opts: MouseTesterOpts,
): number {
  if (typeof travel.physicalDistanceInches === "number" && travel.physicalDistanceInches > 0) {
    return travel.physicalDistanceInches;
  }
  const raw =
    typeof opts.physicalDistanceCm === "number" && opts.physicalDistanceCm > 0
      ? opts.physicalDistanceCm
      : 10;
  return opts.units === "in" ? raw : raw / CM_PER_INCH;
}

const INSTRUCTIONS: Record<string, string> = {
  "How this tool works":
    "This page needs a JSON report produced by the live test panel, not typed text. Run the tests below, then the panel sends its report through automatically.",
  "Polling rate":
    "Move the mouse continuously for about 5 seconds; the panel records pointermove timestamps (using getCoalescedEvents when the browser provides it) and reports the median interval as a Hz reading.",
  "DPI test":
    "The panel requests pointer lock, then you move the mouse exactly the physical distance set in the options, measured with a ruler; it sums movementX counts to compute DPI.",
  Acceleration:
    "Move the mouse across the same physical distance twice: once slowly, once quickly. The panel compares total counts between the two runs to check for OS-level pointer acceleration.",
  "Click test":
    "Click each button in the click grid to record down and up timing, double-click intervals, and switch bounce.",
  "Scroll test": "Scroll the wheel to record deltaY per notch and delta mode.",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Builds the labeled report from whichever sections of a MouseReport are present. */
export function summarize(report: MouseReport, opts: MouseTesterOpts): Record<string, string> {
  const out: Record<string, string> = {};
  let any = false;

  if (report.moveTimestamps !== undefined) {
    any = true;
    if (
      !Array.isArray(report.moveTimestamps) ||
      report.moveTimestamps.some((t) => typeof t !== "number")
    ) {
      throw new ToolError(
        "bad-move-timestamps",
        "moveTimestamps must be an array of numbers (milliseconds).",
      );
    }
    const rate = pollingRateFromTimestamps(report.moveTimestamps as number[]);
    out["Polling rate"] =
      rate.classification === "unknown" ? `Unknown (measured ~${rate.hz} Hz)` : rate.classification;
    out["Measured Hz"] = String(rate.hz);
    out["Median interval"] = `${rate.median} ms`;
    out["95th percentile interval"] = `${rate.p95intervalMs} ms`;
    out["Jitter"] = `${rate.jitterMs} ms`;
    out["Move samples"] = String(rate.samples);
  }

  if (report.travel !== undefined) {
    any = true;
    if (!isPlainObject(report.travel) || typeof report.travel.counts !== "number") {
      throw new ToolError(
        "bad-travel",
        "travel must be an object with a numeric counts field (summed movementX counts).",
      );
    }
    const distanceInches = resolveDistanceInches(report.travel, opts);
    const dpi = dpiFromTravel({
      counts: report.travel.counts,
      physicalDistanceInches: distanceInches,
    });
    out["Measured DPI"] = String(dpi.dpi);
    out["Nearest common DPI"] = String(dpi.nearestCommonDpi);
    out["DPI note"] = dpi.note;
  }

  if (report.acceleration !== undefined) {
    any = true;
    if (
      !isPlainObject(report.acceleration) ||
      !Array.isArray(report.acceleration.slow) ||
      !Array.isArray(report.acceleration.fast)
    ) {
      throw new ToolError(
        "bad-acceleration",
        "acceleration must be an object with slow and fast arrays of {dt, dx} samples.",
      );
    }
    const accel = accelerationCheck(
      report.acceleration.slow as AccelerationSample[],
      report.acceleration.fast as AccelerationSample[],
    );
    out["Acceleration verdict"] =
      accel.verdict === "linear"
        ? "Linear: counts stayed consistent between the slow and fast run, no acceleration detected."
        : "Accelerated: the fast run reported disproportionately more counts than the slow run for the same distance.";
    out["Slow run counts"] = String(accel.slowCounts);
    out["Fast run counts"] = String(accel.fastCounts);
    out["Fast/slow ratio"] = String(accel.ratio);
  }

  if (report.clicks !== undefined) {
    any = true;
    if (!Array.isArray(report.clicks)) {
      throw new ToolError("bad-clicks", "clicks must be an array of click events.");
    }
    const stats = clickStats(report.clicks as ClickEvent[]);
    for (const [button, s] of Object.entries(stats.perButton)) {
      out[`${button} button`] = `${s.downs} down / ${s.ups} up${
        s.avgHeldMs !== null ? `, held ~${s.avgHeldMs} ms` : ""
      }`;
    }
    out["Double clicks"] = stats.doubleClicks.length
      ? stats.doubleClicks.map((d) => `${d.button} (${d.intervalMs} ms)`).join(", ")
      : "none detected";
    out["Switch bounce"] = stats.bounces.length
      ? `Suspicious: ${stats.bounces.map((b) => `${b.button} (${b.intervalMs} ms)`).join(", ")}`
      : "none detected";
  }

  if (report.scrolls !== undefined) {
    any = true;
    if (!Array.isArray(report.scrolls)) {
      throw new ToolError("bad-scrolls", "scrolls must be an array of wheel events.");
    }
    const s = scrollStats(report.scrolls as ScrollEvent[]);
    out["Scroll events"] = String(s.events);
    out["Scroll delta mode"] = s.deltaModeConsistent
      ? s.deltaModeLabel
      : `mixed (not consistently ${s.deltaModeLabel})`;
    out["Scroll notch size"] =
      s.notchSizeY !== null ? `${s.notchSizeY} per notch` : "no notches detected";
  }

  if (!any) {
    throw new ToolError(
      "empty-report",
      "The JSON report did not contain any recognized fields.",
      "Include at least one of moveTimestamps, travel, acceleration, clicks, or scrolls.",
    );
  }

  return out;
}

export function run(input: string, opts: MouseTesterOpts): Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) return INSTRUCTIONS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "invalid-json",
      "Could not parse input as JSON.",
      "Provide the JSON report produced by the live test panel, or leave the input empty to see instructions.",
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ToolError(
      "invalid-report",
      "Expected a JSON object describing a mouse test report.",
      "Provide an object with any of moveTimestamps, travel, acceleration, clicks, or scrolls.",
    );
  }

  return summarize(parsed as MouseReport, opts);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MouseTesterOpts>;
