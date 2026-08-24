/**
 * Discord Compressor: the bitrate math behind a two pass encode that lands a
 * video just under a chosen upload cap.
 *
 * The whole tool is one arithmetic problem. A hard size target means the
 * encoder has a fixed bit budget, so the job is to divide that budget between
 * the container, the audio track, and the picture, then hand the remainder to
 * x264 as a target bitrate. Everything in this file is pure so the panel can
 * recompute the plan on every keystroke without touching the media engine.
 *
 * Units: one MB here is 1,000,000 bytes (decimal). Upload caps are sometimes
 * quoted in binary mebibytes (1,048,576 bytes), and the decimal reading is the
 * smaller of the two, so planning against it undershoots either interpretation
 * rather than overshooting one of them.
 */
import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/** Bytes in one MB for every size in this tool. Decimal, see the note above. */
export const BYTES_PER_MB = 1_000_000;

/**
 * Share of the cap held back for container overhead. MP4 spends bytes on the
 * moov atom, the sample tables, and per frame headers, and none of that is
 * counted in the stream bitrates ffmpeg is given. Three percent is the usual
 * working figure for H.264 in MP4 at these durations.
 */
export const OVERHEAD_FRACTION = 0.03;

/**
 * Flat reserve on top of the percentage. A very short clip has a moov atom
 * that is almost independent of its length, so three percent of a small cap
 * would not cover it. 4 KiB is comfortably above a typical faststart header.
 */
export const OVERHEAD_FLOOR_BYTES = 4096;

/** AAC stereo bitrates the planner will spend, best first. */
export const AUDIO_TIERS = [96, 64, 48] as const;

/**
 * Below this, H.264 stops resolving anything a viewer would call detail, so
 * reporting an honest refusal beats producing a gray smear that fits.
 */
export const MIN_VIDEO_KBPS = 100;

/** Largest custom cap accepted. Past this the browser runs out of memory first. */
export const MAX_CAP_MB = 2000;

/** Frame rate used when the panel is told not to keep the source rate. */
export const CAPPED_FPS = 30;

/** x264 speed preset. Fast enough to be usable in wasm, still rate accurate. */
export const PRESET = "veryfast";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface PlanInput {
  /** The upload cap in bytes. */
  targetBytes: number;
  /** Length of the clip in seconds. */
  durationSec: number;
  /** Whether an audio track should be kept and paid for. */
  hasAudio: boolean;
  /** Force a specific audio bitrate instead of letting the planner choose. */
  audioKbps?: number;
}

export interface CompressionPlan {
  /** Target video bitrate handed to x264, in kbps. */
  videoKbps: number;
  /** AAC bitrate, or 0 when the output is silent. */
  audioKbps: number;
  /** Expected size of the two streams, before container overhead. */
  estimatedBytes: number;
  /** False when the cap cannot hold a watchable picture for this duration. */
  feasible: boolean;
  /** Set only when `feasible` is false: what went wrong and what to do. */
  reason?: string;
}

export interface PassInput {
  /** File name of the input inside the ffmpeg filesystem. */
  inputName: string;
  videoKbps: number;
  /** 0 means encode without audio. */
  audioKbps: number;
  /** Cap the output height. Null or 0 keeps the source height. */
  maxHeight?: number | null;
  /** Cap the frame rate. Null or 0 keeps the source rate. */
  fps?: number | null;
  /** Name pass 2 writes. Ignored by pass 1, which writes nothing. */
  outputName?: string;
}

export interface DiscordCompressorOpts {
  /** One of the preset caps, in MB, as a string. */
  cap?: string;
  /** Overrides `cap` when it parses as a positive number of MB. */
  customMB?: string;
  /** '0' keeps the source height, otherwise a pixel height. */
  maxHeight?: string | number;
  /** Keep the source frame rate. False caps it at 30. */
  keepFps?: boolean;
  /** Keep the audio track. False encodes a silent file. */
  keepAudio?: boolean;
  [key: string]: unknown;
}

export type CompressionReport = Record<string, string>;

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

/** 9,690,000 bytes reads as "9.69 MB". Always two decimals, always decimal MB. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;
}

/** 83.45 seconds reads as "1:23". Hours appear only when there are any. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** Megabytes to bytes, rounded, so a fractional custom cap still lands on an integer. */
export function megabytesToBytes(mb: number): number {
  return Math.round(mb * BYTES_PER_MB);
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

function infeasible(
  reason: string,
  audioKbps = 0,
  videoKbps = 0,
  estimatedBytes = 0,
): CompressionPlan {
  return { videoKbps, audioKbps, estimatedBytes, feasible: false, reason };
}

/**
 * Divides a size cap into a video bitrate and an audio bitrate.
 *
 * The budget is the cap minus container overhead (a percentage plus a flat
 * floor). Audio is paid first, from the best tier that still leaves the video
 * above its floor, because a clip nobody can hear is worse than one that is
 * slightly softer. Whatever is left, floored to a whole kbps, is the video
 * bitrate handed to x264.
 *
 * This drives a live readout, so bad numbers come back as an infeasible plan
 * with a reason rather than as a thrown error.
 */
export function planCompression(input: PlanInput): CompressionPlan {
  const { targetBytes, durationSec, hasAudio } = input;

  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    return infeasible("The size cap has to be a positive number of bytes.");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return infeasible(
      "The length of this clip is unknown, so there is no budget to divide over it.",
    );
  }

  const usableBytes = targetBytes * (1 - OVERHEAD_FRACTION) - OVERHEAD_FLOOR_BYTES;
  if (usableBytes <= 0) {
    return infeasible(
      `A ${formatMegabytes(targetBytes)} cap is smaller than the container overhead it would need, so no bits are left for the streams.`,
    );
  }

  const totalKbps = (usableBytes * 8) / 1000 / durationSec;

  // The best tier that still leaves a watchable picture. Explicit requests are
  // honored as given: the caller knows something the planner does not.
  const explicit = input.audioKbps;
  let audioKbps = 0;
  let audioStarved = false;

  if (hasAudio) {
    if (explicit !== undefined) {
      if (!Number.isFinite(explicit) || explicit < 0) {
        return infeasible("The audio bitrate has to be zero or a positive number of kbps.");
      }
      audioKbps = explicit;
    } else {
      const affordable = AUDIO_TIERS.find((tier) => totalKbps - tier >= MIN_VIDEO_KBPS);
      audioKbps = affordable ?? AUDIO_TIERS[AUDIO_TIERS.length - 1]!;
      audioStarved = affordable === undefined;
    }
  }

  const videoKbps = Math.max(0, Math.floor(totalKbps - audioKbps));
  const estimatedBytes = Math.round(((videoKbps + audioKbps) * 1000 * durationSec) / 8);
  const feasible = !audioStarved && videoKbps >= MIN_VIDEO_KBPS;

  if (!feasible) {
    return {
      videoKbps,
      audioKbps,
      estimatedBytes,
      feasible: false,
      reason: `A ${formatMegabytes(targetBytes)} cap across ${formatClock(durationSec)} leaves ${videoKbps} kbps for video, under the ${MIN_VIDEO_KBPS} kbps floor where H.264 stops holding any detail. Trim the clip, drop the resolution, or pick a larger cap.`,
    };
  }

  return { videoKbps, audioKbps, estimatedBytes, feasible: true };
}

/* ------------------------------------------------------------------ */
/* ffmpeg arguments                                                    */
/* ------------------------------------------------------------------ */

/**
 * Scale filter that caps height without ever enlarging a smaller source.
 * The comma inside min() is escaped because ffmpeg splits a filter chain on
 * unescaped commas. Width is -2 so it follows the aspect ratio and stays even,
 * which H.264 requires.
 */
function scaleFilter(maxHeight: number): string {
  return `scale=-2:min(${maxHeight}\\,ih)`;
}

/**
 * Builds one pass of the two pass encode.
 *
 * Pass 1 analyzes the clip and writes ffmpeg2pass-0.log; it decodes no audio
 * and muxes nothing, which is what `-an -f null -` says. Pass 2 reads that log
 * and spends its bit budget where pass 1 found the motion.
 *
 * Both passes carry the same scale filter, frame rate, preset, and target
 * bitrate on purpose: x264 keys its first pass statistics to the frame size and
 * count it saw, so a pass 2 at a different resolution or rate would either
 * refuse to start or misallocate every bit it was given.
 */
export function buildPassArgs(pass: 1 | 2, o: PassInput): string[] {
  if (!o.inputName) {
    throw new ToolError(
      "empty-input",
      "No input file was named for the encode.",
      "Pick a video file first.",
    );
  }
  if (!Number.isFinite(o.videoKbps) || o.videoKbps < 1) {
    throw new ToolError(
      "invalid-bitrate",
      `A video bitrate of ${o.videoKbps} kbps cannot be encoded.`,
      "Raise the size cap or shorten the clip so the plan leaves room for video.",
    );
  }

  const args = [
    "-y",
    "-i",
    o.inputName,
    "-c:v",
    "libx264",
    "-preset",
    PRESET,
    "-b:v",
    `${Math.floor(o.videoKbps)}k`,
  ];

  if (o.maxHeight) args.push("-vf", scaleFilter(o.maxHeight));
  if (o.fps) args.push("-r", String(o.fps));

  args.push("-pass", String(pass));

  if (pass === 1) {
    args.push("-an", "-f", "null", "-");
    return args;
  }

  if (o.audioKbps > 0) {
    args.push("-c:a", "aac", "-b:a", `${Math.floor(o.audioKbps)}k`);
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", o.outputName || "output.mp4");
  return args;
}

/** Shell-safe rendering of an argument list, for the copyable command readout. */
export function formatCommand(args: string[]): string {
  const quoted = args.map((arg) =>
    /^[A-Za-z0-9_.:+=\-/]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`,
  );
  return `ffmpeg ${quoted.join(" ")}`;
}

/** "clip.mov" at a 10 MB cap becomes "clip-10mb.mp4". */
export function outputNameFor(originalName: string, capMB: number): string {
  const dot = originalName.lastIndexOf(".");
  const stem = (dot > 0 ? originalName.slice(0, dot) : originalName)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${stem || "video"}-${capMB}mb.mp4`;
}

/* ------------------------------------------------------------------ */
/* duration                                                            */
/* ------------------------------------------------------------------ */

const DURATION_RE = /Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/;

/**
 * Pulls "Duration: 00:01:23.45" out of ffmpeg log output and returns seconds.
 *
 * ffmpeg prints the duration once per input while probing, so the first match
 * belongs to the file that was passed in. Returns null for "Duration: N/A",
 * which is what a stream with no known length reports.
 */
export function parseDuration(ffprobeLikeLog: string): number | null {
  const match = DURATION_RE.exec(ffprobeLikeLog ?? "");
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The other path to a duration: a number straight off an HTMLVideoElement.
 * Browsers report NaN before metadata arrives and Infinity for some streamed
 * WebM files, so both become null rather than poisoning the plan.
 */
export function normalizeDuration(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolves the cap in MB from the option values: a custom entry wins whenever
 * it is filled in, otherwise the preset select decides.
 */
export function resolveCapMB(opts: DiscordCompressorOpts): number {
  const custom = String(opts.customMB ?? "").trim();
  if (custom) {
    const parsed = Number(custom);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ToolError(
        "invalid-cap",
        `"${custom}" is not a size in megabytes.`,
        "Enter a positive number, for example 25, or clear the field to use a preset cap.",
      );
    }
    if (parsed > MAX_CAP_MB) {
      throw new ToolError(
        "invalid-cap",
        `A ${parsed} MB cap is larger than this tool will plan for.`,
        `Enter ${MAX_CAP_MB} MB or less. Past that the browser runs out of memory before the encode finishes.`,
      );
    }
    return parsed;
  }

  const preset = Number(String(opts.cap ?? "10"));
  return Number.isFinite(preset) && preset > 0 ? preset : 10;
}

/** '0' or an empty value keeps the source height; anything else is a pixel cap. */
export function resolveMaxHeight(opts: DiscordCompressorOpts): number | null {
  const parsed = Number(String(opts.maxHeight ?? "0"));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Keeping the source rate means no -r at all; otherwise the rate is capped. */
export function resolveFps(opts: DiscordCompressorOpts): number | null {
  return opts.keepFps === false ? CAPPED_FPS : null;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

interface PlanRequest {
  targetMB?: number;
  durationSec?: number;
  hasAudio?: boolean;
}

function parseRequest(input: string): PlanRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ToolError(
      "invalid-json",
      "That is not valid JSON.",
      'Describe the clip like {"targetMB": 10, "durationSec": 90, "hasAudio": true}.',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-plan",
      "The request has to be a JSON object.",
      'Describe the clip like {"targetMB": 10, "durationSec": 90, "hasAudio": true}.',
    );
  }
  return parsed as PlanRequest;
}

/**
 * The text fallback for the generic shell and the pipeline: describe a clip as
 * JSON and get the same plan the panel would compute, plus both ffmpeg
 * commands so the encode can be reproduced anywhere ffmpeg is installed.
 */
export function run(
  input: Uint8Array | string,
  opts: DiscordCompressorOpts = {},
): CompressionReport {
  if (input instanceof Uint8Array) {
    throw new ToolError(
      "needs-panel",
      "The encode itself runs in the tool panel on this page, not through this text interface.",
      'Drop the video into the panel above. To plan a cap here instead, describe the clip as JSON like {"targetMB": 10, "durationSec": 90, "hasAudio": true}.',
    );
  }

  const text = input.trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "Describe the clip you want to fit.",
      'Paste something like {"targetMB": 10, "durationSec": 90, "hasAudio": true}.',
    );
  }

  const request = parseRequest(text);

  const capMB =
    typeof request.targetMB === "number" && Number.isFinite(request.targetMB)
      ? request.targetMB
      : resolveCapMB(opts);

  const durationSec = Number(request.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ToolError(
      "invalid-plan",
      "The clip length is missing or is not a positive number of seconds.",
      'Add "durationSec" to the request, for example {"targetMB": 10, "durationSec": 90}.',
    );
  }

  const hasAudio = request.hasAudio ?? opts.keepAudio !== false;
  const targetBytes = megabytesToBytes(capMB);
  const plan = planCompression({ targetBytes, durationSec, hasAudio });

  const report: CompressionReport = {
    "Size cap": `${formatMegabytes(targetBytes)} (${targetBytes.toLocaleString("en-US")} bytes)`,
    "Clip length": `${formatClock(durationSec)} (${durationSec} s)`,
    "Video bitrate": `${plan.videoKbps} kbps`,
    "Audio bitrate": plan.audioKbps > 0 ? `${plan.audioKbps} kbps AAC` : "none, silent output",
    "Estimated stream size": formatMegabytes(plan.estimatedBytes),
    "Reserved for the container": formatMegabytes(
      Math.round(targetBytes * OVERHEAD_FRACTION) + OVERHEAD_FLOOR_BYTES,
    ),
  };

  if (!plan.feasible) {
    report["Fits the cap"] = `No. ${plan.reason ?? ""}`.trim();
    return report;
  }

  const headroom = targetBytes - plan.estimatedBytes;
  report["Fits the cap"] = `Yes, about ${formatMegabytes(headroom)} to spare`;

  const passInput: PassInput = {
    inputName: "input.mp4",
    videoKbps: plan.videoKbps,
    audioKbps: plan.audioKbps,
    maxHeight: resolveMaxHeight(opts),
    fps: resolveFps(opts),
    outputName: outputNameFor("input.mp4", capMB),
  };
  report["ffmpeg pass 1"] = formatCommand(buildPassArgs(1, passInput));
  report["ffmpeg pass 2"] = formatCommand(buildPassArgs(2, passInput));

  return report;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  CompressionReport,
  DiscordCompressorOpts
>;
