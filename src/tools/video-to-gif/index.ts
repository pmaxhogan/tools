import { ToolError, type ToolLogic } from "../types";

/**
 * Video to GIF: the pure planning layer.
 *
 * The encode itself runs in the browser through ffmpeg.wasm, driven by
 * `VideoToGifPanel.vue` and `MediaShell`. Everything that decides *what* ffmpeg
 * should be told to do lives here, so it can be unit tested without a wasm
 * engine, a DOM, or a file.
 *
 * The command is the classic two filter GIF pipeline in a single pass:
 * the scaled frames are split, one branch generates a palette, the other one
 * is quantized against it. Doing both in one `-filter_complex` means the file
 * is decoded once instead of twice.
 */

export type GifPaletteMode = "global" | "perframe";
export type GifDither = "sierra2_4a" | "bayer" | "none";

/**
 * Name the GIF gets inside the ffmpeg filesystem. Fixed rather than derived
 * from the input, so the output can never collide with the input in one flat
 * directory.
 */
export const GIF_OUTPUT_NAME = "output.gif";

/** Ordered dither strength. 3 keeps the pattern subtle without inflating the file. */
export const BAYER_SCALE = 3;

/** Past this many frames a GIF is slow to encode and awkward to share. */
export const FRAME_WARNING_THRESHOLD = 600;

const MIN_FPS = 1;
const MAX_FPS = 30;
const MIN_WIDTH = 64;
const MAX_WIDTH = 1280;

/* ------------------------------------------------------------------ */
/* time parsing                                                        */
/* ------------------------------------------------------------------ */

/** One clock field: digits, with an optional fractional tail. */
const TIME_FIELD = /^\d+(?:\.\d+)?$/;

/**
 * Parses a timestamp into seconds. Accepts plain seconds ("12", "12.5"),
 * "mm:ss", and "hh:mm:ss.mmm". Returns null for anything empty or malformed,
 * which lets callers treat "no value" and "nonsense" the same way when that is
 * what they want, and tell them apart when it is not.
 */
export function parseTimeSpec(value: string): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  const parts = text.split(":");
  if (parts.length > 3) return null;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!TIME_FIELD.test(part)) return null;
    // Only the final field carries a fraction: "1.5:30" is not a timestamp.
    if (i < parts.length - 1 && part.includes(".")) return null;
    // Minutes and seconds are clock fields, so they stay under 60. The leading
    // field is free: "90:00" is a legitimate way to write 90 minutes.
    if (i > 0 && Number(part) >= 60) return null;
  }

  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Renders seconds back as a compact clock value, used in the plan rows. */
function formatSeconds(seconds: number): string {
  const whole = Math.floor(seconds);
  const fraction = seconds - whole;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const base = `${minutes}:${String(rest).padStart(2, "0")}`;
  if (fraction === 0) return base;
  return `${base}${fraction.toFixed(3).slice(1).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/* ------------------------------------------------------------------ */
/* frame estimate                                                      */
/* ------------------------------------------------------------------ */

export interface FrameEstimateInput {
  fps: number;
  startSec: number | null;
  endSec: number | null;
  /** Length of the source clip, when the caller happens to know it. */
  durationSec?: number | null;
}

/**
 * Frames the trim window will produce, or null when the window cannot be known
 * (no end time and no source duration). The panel uses this to warn before a
 * visitor waits several minutes for a 40 MB GIF.
 */
export function estimateFrames(o: FrameEstimateInput): number | null {
  const fps = Number(o.fps);
  if (!Number.isFinite(fps) || fps <= 0) return null;

  const start = o.startSec ?? 0;
  if (!Number.isFinite(start) || start < 0) return null;

  const end =
    o.endSec !== null && o.endSec !== undefined
      ? o.endSec
      : o.durationSec !== null && o.durationSec !== undefined && o.durationSec > 0
        ? o.durationSec
        : null;
  if (end === null || !Number.isFinite(end)) return null;

  const window = end - start;
  if (window <= 0) return null;
  return Math.round(fps * window);
}

/* ------------------------------------------------------------------ */
/* argument building                                                   */
/* ------------------------------------------------------------------ */

export interface GifArgsInput {
  /** Input file name inside the ffmpeg filesystem, e.g. "clip.mp4". */
  inputName: string;
  startSec: number | null;
  endSec: number | null;
  fps: number;
  width: number;
  paletteMode: GifPaletteMode;
  dither: GifDither;
  loop: boolean;
}

/** A runnable command, or the reason this option combination cannot run. */
export type GifArgsResult = { args: string[]; outputs: [string] } | { error: string; fix?: string };

/**
 * The `-filter_complex` graph. Split once, generate a palette from one branch,
 * quantize the other branch against it.
 *
 * The two palette modes are a matched pair, not two independent switches:
 *   global   -> palettegen stats_mode=full, one table for the whole clip
 *   perframe -> palettegen stats_mode=single plus paletteuse new=1, which tells
 *               paletteuse that a fresh palette arrives with every frame
 * Using stats_mode=single without new=1 silently quantizes the whole clip
 * against the first frame's palette, which is the classic way to get a GIF that
 * looks right for a second and then falls apart.
 */
export function buildGifFilter(o: {
  fps: number;
  width: number;
  paletteMode: GifPaletteMode;
  dither: GifDither;
}): string {
  const statsMode = o.paletteMode === "perframe" ? "single" : "full";

  let paletteuse = `dither=${o.dither}`;
  if (o.dither === "bayer") paletteuse += `:bayer_scale=${BAYER_SCALE}`;
  if (o.paletteMode === "perframe") paletteuse += ":new=1";

  return (
    `[0:v] fps=${numberArg(o.fps)},scale=${o.width}:-1:flags=lanczos,split [a][b];` +
    `[a] palettegen=stats_mode=${statsMode} [p];` +
    `[b][p] paletteuse=${paletteuse}`
  );
}

/** Formats a number for an ffmpeg argument: 12 stays "12", 12.5 stays "12.5". */
function numberArg(value: number): string {
  return String(value);
}

/**
 * Turns the panel's option values into a full ffmpeg command.
 *
 * `-ss` and `-to` go before `-i` so the seek happens on the input, which is
 * both far faster than decoding from zero and accurate enough here because the
 * output is re-encoded frame by frame anyway.
 */
export function buildGifArgs(o: GifArgsInput): GifArgsResult {
  const inputName = (o.inputName ?? "").trim();
  if (!inputName) {
    return {
      error: "No input file was given to the encoder.",
      fix: "Drop a video file into the input area, then run the conversion again.",
    };
  }

  const fps = Number(o.fps);
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    return {
      error: `Frame rate must be a number between ${MIN_FPS} and ${MAX_FPS}.`,
      fix: "Try 12 frames per second, which reads smoothly for screen recordings.",
    };
  }

  const width = Math.round(Number(o.width));
  if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    return {
      error: `Width must be a whole number of pixels between ${MIN_WIDTH} and ${MAX_WIDTH}.`,
      fix: "Try 480 pixels wide, which is the usual size for an embedded GIF.",
    };
  }

  const startSec = o.startSec;
  if (startSec !== null && (!Number.isFinite(startSec) || startSec < 0)) {
    return {
      error: "The start time cannot be negative.",
      fix: "Leave the start box empty to begin at the first frame.",
    };
  }

  const endSec = o.endSec;
  if (endSec !== null && !Number.isFinite(endSec)) {
    return {
      error: "The end time is not a valid timestamp.",
      fix: 'Use seconds ("12.5"), mm:ss ("1:20"), or hh:mm:ss ("0:01:20.500").',
    };
  }
  if (endSec !== null && endSec <= (startSec ?? 0)) {
    return {
      error: "The end time has to come after the start time.",
      fix: "Raise the end time, lower the start time, or clear one of them.",
    };
  }

  const args: string[] = [];
  if (startSec !== null) args.push("-ss", numberArg(startSec));
  if (endSec !== null) args.push("-to", numberArg(endSec));
  args.push(
    "-i",
    inputName,
    "-filter_complex",
    buildGifFilter({ fps, width, paletteMode: o.paletteMode, dither: o.dither }),
    // The GIF muxer reads 0 as "loop forever" and -1 as "play once".
    "-loop",
    o.loop ? "0" : "-1",
    GIF_OUTPUT_NAME,
  );

  return { args, outputs: [GIF_OUTPUT_NAME] };
}

/* ------------------------------------------------------------------ */
/* textual fallback                                                    */
/* ------------------------------------------------------------------ */

export interface GifPlanOpts {
  start?: string;
  end?: string;
  fps?: number;
  width?: number;
  palette?: string;
  dither?: string;
  loop?: boolean;
  [key: string]: unknown;
}

const DEFAULTS = {
  start: "",
  end: "",
  fps: 12,
  width: 480,
  palette: "global" as GifPaletteMode,
  dither: "sierra2_4a" as GifDither,
  loop: true,
};

const PALETTE_MODES: GifPaletteMode[] = ["global", "perframe"];
const DITHERS: GifDither[] = ["sierra2_4a", "bayer", "none"];

const PALETTE_NOTES: Record<GifPaletteMode, string> = {
  global:
    "Global palette: one table of 256 colors for the whole clip. Smallest file, but colors drift when the scene changes.",
  perframe:
    "Per frame palette: a fresh 256 color table on every frame. Handles scene changes and gradients, at a noticeably larger file size.",
};

const DITHER_NOTES: Record<GifDither, string> = {
  sierra2_4a:
    "Sierra2 4a error diffusion: the default. Smooth gradients, some grain that moves between frames.",
  bayer: `Bayer ordered dithering at scale ${BAYER_SCALE}: a fixed crosshatch pattern that stays still between frames, which compresses much better.`,
  none: "No dithering: flat bands of color. Best for screen recordings, line art, and flat UI.",
};

function toEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Wraps an argument in quotes when a shell would otherwise mangle it. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9._:/=+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Merges a JSON body over the option values, so the tool can be driven by a
 * pasted settings object as well as by the panel controls. Unknown keys are
 * ignored rather than passed through.
 */
function mergeJson(text: string, opts: GifPlanOpts): { opts: GifPlanOpts; note?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { opts };
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return {
      opts,
      note: "The pasted text was not a JSON settings object, so the options below were used as they are.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      opts,
      note: "The pasted text looked like JSON but did not parse, so the options below were used as they are.",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      opts,
      note: "The pasted JSON was not an object of settings, so the options below were used as they are.",
    };
  }

  const source = parsed as Record<string, unknown>;
  const merged: GifPlanOpts = { ...opts };
  for (const key of ["start", "end", "fps", "width", "palette", "dither", "loop"]) {
    if (key in source) merged[key] = source[key];
  }
  return { opts: merged };
}

/**
 * The textual surface of the tool: it plans the encode rather than performing
 * it. Given nothing at all, it still returns the command the current options
 * would produce, which is useful on its own if you want to run ffmpeg locally.
 */
export function run(input: Uint8Array | string, opts: GifPlanOpts = {}): Record<string, string> {
  let effective: GifPlanOpts = { ...DEFAULTS, ...opts };
  let note: string | undefined;
  let inputRow: string | undefined;

  if (typeof input === "string") {
    const merged = mergeJson(input, effective);
    effective = merged.opts;
    note = merged.note;
  } else if (input && input.byteLength > 0) {
    inputRow = `${input.byteLength.toLocaleString("en-US")} bytes of video received. The encode itself runs in the panel above, where ffmpeg has the file.`;
  }

  const startText = toText(effective.start, "").trim();
  const endText = toText(effective.end, "").trim();

  const startSec = startText ? parseTimeSpec(startText) : null;
  if (startText && startSec === null) {
    throw new ToolError(
      "invalid-start-time",
      `"${startText}" is not a timestamp this tool understands.`,
      'Use seconds ("12.5"), mm:ss ("1:20"), or hh:mm:ss ("0:01:20.500").',
    );
  }

  const endSec = endText ? parseTimeSpec(endText) : null;
  if (endText && endSec === null) {
    throw new ToolError(
      "invalid-end-time",
      `"${endText}" is not a timestamp this tool understands.`,
      'Use seconds ("12.5"), mm:ss ("1:20"), or hh:mm:ss ("0:01:20.500").',
    );
  }

  const fps = toNumber(effective.fps, DEFAULTS.fps);
  const width = toNumber(effective.width, DEFAULTS.width);
  const paletteMode = toEnum(effective.palette, PALETTE_MODES, DEFAULTS.palette);
  const dither = toEnum(effective.dither, DITHERS, DEFAULTS.dither);
  const loop = effective.loop === undefined ? DEFAULTS.loop : Boolean(effective.loop);

  const built = buildGifArgs({
    inputName: "input.mp4",
    startSec,
    endSec,
    fps,
    width,
    paletteMode,
    dither,
    loop,
  });

  if ("error" in built) {
    throw new ToolError("invalid-settings", built.error, built.fix);
  }

  const frames = estimateFrames({ fps, startSec, endSec });
  const rows: Record<string, string> = {};

  if (note) rows.Note = note;
  if (inputRow) rows.Input = inputRow;

  rows["ffmpeg command"] = `ffmpeg ${built.args.map(shellQuote).join(" ")}`;
  rows["Filter graph"] = built.args[built.args.indexOf("-filter_complex") + 1];
  rows.Trim =
    startSec === null && endSec === null
      ? "Whole clip, from the first frame to the last."
      : `From ${startSec === null ? "the first frame" : formatSeconds(startSec)} to ${
          endSec === null ? "the end of the clip" : formatSeconds(endSec)
        }.`;
  rows.Frames =
    frames === null
      ? `Unknown until an end time is set. At ${fps} fps, every second of video is ${fps} frames.`
      : `About ${frames.toLocaleString("en-US")} at ${fps} fps.${
          frames > FRAME_WARNING_THRESHOLD
            ? ` That is over ${FRAME_WARNING_THRESHOLD}, so expect a slow encode and a large file.`
            : ""
        }`;
  rows.Size = `${width} pixels wide, height chosen automatically to keep the aspect ratio.`;
  rows.Palette = PALETTE_NOTES[paletteMode];
  rows.Dither = DITHER_NOTES[dither];
  rows.Loop = loop ? "Loops forever (-loop 0)." : "Plays once and stops (-loop -1).";
  rows.Tip =
    "GIF has no interframe compression and a 256 color limit, so it is often ten times the size of the same clip as MP4 or WebM. Trim hard, drop the frame rate, and scale down before reaching for a bigger palette.";

  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  GifPlanOpts
>;
