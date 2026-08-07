import { ToolError, type ToolLogic } from "../types";

/**
 * Frame math and validation for the video trimmer.
 *
 * The browser work (decoding, seeking, capturing, encoding) lives in
 * VideoTrimmerPanel.vue. This module stays pure: it parses time specs, turns a
 * requested range into frame numbers, and picks a recorder mime type from a
 * support predicate the caller supplies. Nothing here touches the DOM.
 */

export interface TrimOpts {
  /** Start of the range, as a time spec such as "0", "1:02", "00:01:02.500". */
  start?: string;
  /** End of the range. Empty means "to the end of the clip". */
  end?: string;
  /** Frame rate used for the frame numbers shown next to the range. */
  fps?: number | string;
  [key: string]: unknown;
}

export interface TrimPlan {
  /** First frame kept, counting from zero. */
  startFrame: number;
  /** First frame after the range, counting from zero. */
  endFrame: number;
  /** Number of frames in the range. */
  frameCount: number;
  /** Length of the trimmed clip in seconds. */
  outDurationSec: number;
}

export interface TrimPlanError {
  error: string;
  fix?: string;
}

export interface TrimRequest {
  durationSec: number;
  startSec: number;
  endSec: number;
  fps: number;
}

const TIME_HELP =
  "Use seconds (12.5), minutes and seconds (1:02.5), or hours, minutes and seconds (00:01:02.500).";

/**
 * Parses a time spec into seconds. Accepts bare seconds, "mm:ss", and
 * "hh:mm:ss", each with an optional fractional part written with a dot or a
 * comma. Returns null when the string is not a time.
 */
export function parseTimeSpec(spec: string): number | null {
  if (typeof spec !== "string") return null;
  const text = spec.trim().replace(",", ".");
  if (!text) return null;

  const parts = text.split(":");
  if (parts.length > 3) return null;

  const numbers: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    // Only the last field may carry a fraction: "1.5:02" is not a time.
    if (i < parts.length - 1 && part.includes(".")) return null;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    // Minutes and seconds fields cannot overflow into the next unit.
    if (i > 0 && value >= 60) return null;
    numbers.push(value);
  }

  let seconds = 0;
  for (const value of numbers) seconds = seconds * 60 + value;
  return seconds;
}

/**
 * Turns a requested range into frame numbers.
 *
 * Rounding rule: the start frame is floored and the end frame is ceiled, so the
 * kept range always covers every frame the requested times touch. A range of
 * 1.5s to 2.5s at 30 fps keeps frames 45 through 74, which is 30 frames. This
 * errs toward keeping a boundary frame rather than clipping one off, which is
 * what people expect when they scrub to a moment and trim there.
 *
 * Returns a plan, or an error object with a fix hint. It never throws, so a
 * live panel can call it on every keystroke.
 */
export function planTrim(o: TrimRequest): TrimPlan | TrimPlanError {
  const { durationSec, startSec, endSec, fps } = o;

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      error: "The clip duration is not a positive number of seconds.",
      fix: "Load a video the browser can decode, or pass a durationSec greater than zero.",
    };
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return {
      error: "The start and end times must both be numbers of seconds.",
      fix: TIME_HELP,
    };
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    return {
      error: "The frame rate must be a positive number.",
      fix: "Set the frame rate to the real rate of the clip, for example 24, 30, or 60.",
    };
  }
  if (startSec < 0) {
    return {
      error: "The start time is before the beginning of the clip.",
      fix: "Set the start to 0 or later.",
    };
  }
  if (endSec > durationSec) {
    return {
      error: `The end time is past the end of the clip, which runs ${formatSeconds(durationSec)}.`,
      fix: `Set the end to ${formatSeconds(durationSec)} or earlier.`,
    };
  }
  if (endSec <= startSec) {
    return {
      error: "The end time is not after the start time.",
      fix: "Move the end marker later than the start marker, then trim again.",
    };
  }

  const startFrame = Math.floor(startSec * fps);
  const endFrame = Math.ceil(endSec * fps);
  return {
    startFrame,
    endFrame,
    frameCount: endFrame - startFrame,
    outDurationSec: endSec - startSec,
  };
}

/** Candidate recorder types, best quality first. */
export const RECORDER_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Picks the first recorder mime type the browser accepts, preferring VP9 for
 * quality and falling back to VP8 and then to plain WebM. The support check is
 * injected so this stays pure and testable; the panel passes
 * MediaRecorder.isTypeSupported. Returns null when nothing is supported, which
 * the panel reports as an honest "this browser cannot record" message.
 */
export function chooseRecorderMime(isTypeSupported: (type: string) => boolean): string | null {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // A predicate that throws is treated as "not supported" so one bad
      // browser check cannot take the whole tool down.
    }
  }
  return null;
}

/** Seconds as h:mm:ss.mmm, dropping the hours field when it is zero. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const total = Math.round(seconds * 1000);
  const ms = total % 1000;
  const allSeconds = Math.floor(total / 1000);
  const s = allSeconds % 60;
  const m = Math.floor(allSeconds / 60) % 60;
  const h = Math.floor(allSeconds / 3600);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const head = h > 0 ? `${h}:${pad(m)}` : `${m}`;
  return `${head}:${pad(s)}.${pad(ms, 3)}`;
}

interface PlanInput {
  durationSec?: unknown;
  start?: unknown;
  end?: unknown;
  fps?: unknown;
}

/** Reads a time from JSON (number or string) or from an option string. */
function readTime(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseTimeSpec(value);
  return null;
}

/**
 * Text surface for the tool: the trimming itself needs a browser, but the plan
 * is useful on its own, so run() takes a JSON description of a clip and returns
 * the frame math for the requested range.
 *
 * `durationSec` is required. `start`, `end`, and `fps` come from the JSON when
 * present and from the tool options otherwise; an empty end means the end of
 * the clip.
 */
export function run(input: Uint8Array | string, opts: TrimOpts): Record<string, string> {
  if (input instanceof Uint8Array) {
    throw new ToolError(
      "needs-panel",
      "Trimming a video file needs the interactive panel, which decodes and re-encodes the clip in your browser.",
      'Drop the video into the trimmer on this page. This text surface takes JSON such as {"durationSec": 30, "start": "1.5", "end": "2.5", "fps": 30} and returns the frame math.',
    );
  }

  const text = typeof input === "string" ? input.trim() : "";
  if (!text) {
    throw new ToolError(
      "empty-input",
      "No clip description was given.",
      'Paste JSON such as {"durationSec": 30, "start": "1.5", "end": "2.5", "fps": 30}, or drop a video into the trimmer above.',
    );
  }

  let parsed: PlanInput;
  try {
    parsed = JSON.parse(text) as PlanInput;
  } catch {
    throw new ToolError(
      "invalid-json",
      "That is not valid JSON.",
      'Describe the clip as JSON, for example {"durationSec": 30, "start": "1.5", "end": "2.5", "fps": 30}.',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-json",
      "The input must be a JSON object describing one clip.",
      'Use the shape {"durationSec": 30, "start": "1.5", "end": "2.5", "fps": 30}.',
    );
  }

  const durationSec = typeof parsed.durationSec === "number" ? parsed.durationSec : NaN;
  if (!Number.isFinite(durationSec)) {
    throw new ToolError(
      "missing-duration",
      "The JSON needs a numeric durationSec, the length of the clip in seconds.",
      'Add durationSec, for example {"durationSec": 30, "start": "1.5", "end": "2.5"}.',
    );
  }

  const startSec = readTime(parsed.start) ?? readTime(opts?.start) ?? 0;
  const endRaw = readTime(parsed.end) ?? readTime(opts?.end);
  const endSec = endRaw ?? durationSec;
  const fps = readTime(parsed.fps) ?? readTime(opts?.fps) ?? 30;

  const plan = planTrim({ durationSec, startSec, endSec, fps });
  if ("error" in plan) throw new ToolError("invalid-range", plan.error, plan.fix);

  return {
    "Source duration": `${formatSeconds(durationSec)} (${durationSec} s)`,
    "Frame rate": `${fps} fps`,
    Start: `${formatSeconds(startSec)} (frame ${plan.startFrame})`,
    End: `${formatSeconds(endSec)} (frame ${plan.endFrame})`,
    Frames: String(plan.frameCount),
    "Trimmed duration": `${formatSeconds(plan.outDurationSec)} (${plan.outDurationSec} s)`,
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, TrimOpts>;
