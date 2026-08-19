import { formatBytes } from "@/lib/format";
import type { ToolLogic } from "../types";

/**
 * Pure logic layer for the Screen Recorder tool.
 *
 * The actual recording (getDisplayMedia + MediaRecorder) is entirely browser
 * API surface and lives in the panel, which is out of scope here (rule 27:
 * tool logic never touches the DOM). This module provides the small pieces
 * that are worth unit testing in isolation: mime negotiation, filename and
 * size formatting, recorder option construction, and the ffmpeg remux args
 * used to convert a recorded WebM to MP4. `run()` has no meaningful browser
 * state to read, so it renders a "what will happen" summary from the chosen
 * options, which keeps the tool sane inside the generic panel shell even
 * before a custom panel is wired in.
 */

/* ------------------------------------------------------------------ *
 * mime negotiation
 * ------------------------------------------------------------------ */

/**
 * Ordered candidate mime strings to try for each quality preference, most
 * specific (codec-pinned) first, falling back to the bare container. The
 * panel probes each with `MediaRecorder.isTypeSupported`.
 */
export const MIME_CANDIDATES: Record<string, string[]> = {
  "webm-vp9": ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm"],
  "webm-vp8": ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"],
  "webm-av1": ["video/webm;codecs=av01,opus", "video/webm;codecs=av01", "video/webm"],
  mp4: ["video/mp4;codecs=avc1,mp4a", "video/mp4;codecs=h264,aac", "video/mp4"],
};

const LAST_RESORT_MIME = "video/webm";

/**
 * Picks the best concrete mime string for a preference key, walking the
 * candidate list in order and returning the first one `isSupported` accepts.
 * If none of the preferred candidates are supported, falls back through
 * every other preference's candidate list (so a browser that only supports
 * plain "video/webm" still gets a usable answer even when asked for mp4).
 * Returns "video/webm" as an absolute last resort.
 */
export function pickMimeType(preferred: string, isSupported: (mime: string) => boolean): string {
  const primary = MIME_CANDIDATES[preferred] ?? MIME_CANDIDATES["webm-vp9"]!;
  for (const mime of primary) {
    if (isSupported(mime)) return mime;
  }

  for (const [key, candidates] of Object.entries(MIME_CANDIDATES)) {
    if (key === preferred) continue;
    for (const mime of candidates) {
      if (isSupported(mime)) return mime;
    }
  }

  return LAST_RESORT_MIME;
}

/** "mp4" for any mp4 mime, "webm" for everything else (including unknown). */
export function extForMime(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

/* ------------------------------------------------------------------ *
 * filenames
 * ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface RecordingFilenameOpts {
  prefix?: string;
  ext: string;
  date?: Date;
}

/**
 * Builds a sortable, collision-resistant filename like
 * "screen-recording-2026-08-18-143005.webm" from local wall-clock time.
 * Accepts an injected Date so callers (and tests) get a deterministic name.
 */
export function recordingFilename(opts: RecordingFilenameOpts): string {
  const prefix = opts.prefix && opts.prefix.trim() ? opts.prefix.trim() : "screen-recording";
  const d = opts.date ?? new Date();
  const stamp = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join("-");
  const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join("");
  return `${prefix}-${stamp}-${time}.${opts.ext}`;
}

/* ------------------------------------------------------------------ *
 * quality presets / size estimation / recorder options
 * ------------------------------------------------------------------ */

export interface QualityPreset {
  id: string;
  label: string;
  videoKbps: number;
}

export const QUALITY: QualityPreset[] = [
  { id: "1080p-high", label: "1080p high", videoKbps: 8000 },
  { id: "1080p", label: "1080p", videoKbps: 5000 },
  { id: "720p", label: "720p", videoKbps: 2500 },
  { id: "low", label: "Low", videoKbps: 1000 },
];

const AUDIO_KBPS = 128;

function findQuality(id: string): QualityPreset {
  return QUALITY.find((q) => q.id === id) ?? QUALITY[1]!;
}

/** Bytes for a clip of the given length at a constant video bitrate. */
export function estimateSize(bitrateKbps: number, seconds: number): number {
  const kbps = Number.isFinite(bitrateKbps) && bitrateKbps > 0 ? bitrateKbps : 0;
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.round(((kbps * 1000) / 8) * secs);
}

export interface RecorderOptionsInput {
  quality: string;
  mimeType: string;
  micAudio?: boolean;
  systemAudio?: boolean;
}

export interface RecorderOptions {
  mimeType: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

/** Maps a quality preset id and chosen mime into MediaRecorder constructor options. */
export function buildRecorderOptions(opts: RecorderOptionsInput): RecorderOptions {
  const preset = findQuality(opts.quality);
  const wantsAudio = Boolean(opts.micAudio) || Boolean(opts.systemAudio);
  const out: RecorderOptions = {
    mimeType: opts.mimeType,
    videoBitsPerSecond: preset.videoKbps * 1000,
  };
  if (wantsAudio) out.audioBitsPerSecond = AUDIO_KBPS * 1000;
  return out;
}

/* ------------------------------------------------------------------ *
 * ffmpeg remux
 * ------------------------------------------------------------------ */

/**
 * ffmpeg args to convert a recorded WebM into MP4 (H.264 + AAC), reusing the
 * shared single-thread ffmpeg.wasm runtime in src/lib/ffmpeg.ts. Pure array
 * builder: the panel supplies the in-memory filenames and runs the job.
 */
export function mp4RemuxArgs(inputName: string, outputName: string): string[] {
  return ["-i", inputName, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", outputName];
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface ScreenRecorderOpts {
  quality: string;
  format: string; // "webm" | "mp4"
  micAudio: boolean;
  systemAudio: boolean;
  [key: string]: unknown;
}

const HYPOTHETICAL_SECONDS = 60;

/**
 * No meaningful text input (meta.input is "none"): the actual recording
 * happens in the panel via getDisplayMedia + MediaRecorder. This renders a
 * "what will happen" summary from the chosen options so the tool still shows
 * something sensible inside the generic output shell.
 */
export function run(_input: string, opts: ScreenRecorderOpts): Record<string, string> {
  const preset = findQuality(opts.quality);
  const format = opts.format === "mp4" ? "mp4" : "webm";
  const wantsAudio = Boolean(opts.micAudio) || Boolean(opts.systemAudio);

  const audioParts: string[] = [];
  if (opts.micAudio) audioParts.push("microphone");
  if (opts.systemAudio) audioParts.push("system/tab audio");
  const audioSummary = audioParts.length > 0 ? audioParts.join(" + ") : "none";

  const estimatedBytes = estimateSize(
    preset.videoKbps + (wantsAudio ? AUDIO_KBPS : 0),
    HYPOTHETICAL_SECONDS,
  );

  const out: Record<string, string> = {};
  out["Quality"] = `${preset.label} (~${preset.videoKbps} kbps video)`;
  out["Audio sources"] = audioSummary;
  out["Recording format"] =
    format === "mp4"
      ? "MP4 (converted in-browser after recording)"
      : "WebM (native, instant export)";
  out["Captured directly as"] =
    "WebM (browser MediaRecorder output); MP4 is a local ffmpeg.wasm conversion step";
  out[`Estimated size for ${HYPOTHETICAL_SECONDS}s`] = formatBytes(estimatedBytes);
  out["Where recording happens"] = "Entirely on this device; nothing is uploaded";

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, ScreenRecorderOpts>;
