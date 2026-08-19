import { ToolError, type ToolLogic } from "../types";

/**
 * Webcam & Mic Test — panel probes, logic formats (same shape as
 * src/tools/display-info). The panel starts getUserMedia, draws the live
 * preview and level meter itself, then serializes what it read into a JSON
 * report: { devices, video, audio, levels }. This file only turns that
 * report into labeled, copyable rows. No DOM, no getUserMedia, no timers
 * live here.
 */

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/* ------------------------------------------------------------------ *
 * level math (pure PCM analysis)
 * ------------------------------------------------------------------ */

/** Floor applied to every dB conversion so silence never prints -Infinity. */
const DB_FLOOR = -100;

function amplitudeToDb(amplitude: number): number {
  if (!isFiniteNumber(amplitude) || amplitude <= 0) return DB_FLOOR;
  const db = 20 * Math.log10(Math.abs(amplitude));
  return Math.max(DB_FLOOR, db);
}

/** Converts a linear RMS amplitude (0..1) to dBFS, floored at -100. */
export function rmsToDb(rms: number): number {
  return amplitudeToDb(rms);
}

/** Converts a linear peak amplitude (0..1) to dBFS, floored at -100. */
export function peakToDb(peak: number): number {
  return amplitudeToDb(peak);
}

export type Level = "silent" | "very quiet" | "good" | "loud" | "clipping";

/**
 * Buckets a dBFS reading into a plain-language level. Thresholds:
 * below -60 silent, -60..-40 very quiet, -40..-12 good, -12..-1 loud,
 * above -1 clipping. Each range's lower bound belongs to that range.
 */
export function describeLevel(db: number): Level {
  if (!isFiniteNumber(db) || db < -60) return "silent";
  if (db < -40) return "very quiet";
  if (db < -12) return "good";
  if (db <= -1) return "loud";
  return "clipping";
}

export interface SampleAnalysis {
  rms: number;
  peak: number;
  rmsDb: number;
  peakDb: number;
  level: Level;
  /** Mean of the raw samples: a nonzero value means the signal is biased off zero. */
  dcOffset: number;
  /** Count of samples at or above the near-full-scale clip threshold. */
  clippedCount: number;
}

/** A sample at or above this absolute amplitude is treated as digitally clipped. */
const CLIP_THRESHOLD = 0.999;

/** Pure RMS/peak/DC-offset/clip analysis of one PCM float buffer (-1..1 range). */
export function analyzeSamples(samples: Float32Array): SampleAnalysis {
  const n = samples.length;
  if (n === 0) {
    return { rms: 0, peak: 0, rmsDb: DB_FLOOR, peakDb: DB_FLOOR, level: "silent", dcOffset: 0, clippedCount: 0 };
  }

  let sum = 0;
  let sumSquares = 0;
  let peak = 0;
  let clippedCount = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i]!;
    sum += x;
    sumSquares += x * x;
    const abs = Math.abs(x);
    if (abs > peak) peak = abs;
    if (abs >= CLIP_THRESHOLD) clippedCount++;
  }

  const rms = Math.sqrt(sumSquares / n);
  const dcOffset = sum / n;
  const rmsDb = rmsToDb(rms);
  const peakDb = peakToDb(peak);

  return { rms, peak, rmsDb, peakDb, level: describeLevel(rmsDb), dcOffset, clippedCount };
}

/* ------------------------------------------------------------------ *
 * video track formatting
 * ------------------------------------------------------------------ */

export interface VideoTrackSettings {
  width?: number;
  height?: number;
  frameRate?: number;
  facingMode?: string;
  deviceId?: string;
  aspectRatio?: number;
}

const RESOLUTION_NAMES: Record<number, string> = {
  4320: "8K",
  2160: "4K",
  1440: "1440p",
  1080: "1080p",
  720: "720p",
  480: "480p",
  360: "360p",
  240: "240p",
  144: "144p",
};

function resolutionName(height: number): string {
  const rounded = Math.round(height);
  return RESOLUTION_NAMES[rounded] ?? `${rounded}p`;
}

const COMMON_ASPECT_RATIOS: { name: string; value: number }[] = [
  { name: "1:1", value: 1 },
  { name: "4:3", value: 4 / 3 },
  { name: "3:2", value: 3 / 2 },
  { name: "16:10", value: 16 / 10 },
  { name: "16:9", value: 16 / 9 },
  { name: "21:9", value: 21 / 9 },
  { name: "9:16", value: 9 / 16 },
  { name: "3:4", value: 3 / 4 },
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatioLabel(width: number, height: number): string {
  const ratio = width / height;
  const match = COMMON_ASPECT_RATIOS.find((r) => Math.abs(r.value - ratio) < 0.02);
  if (match) return match.name;
  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = gcd(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}

const FACING_LABELS: Record<string, string> = {
  user: "Front camera (user facing)",
  environment: "Rear camera (environment facing)",
  left: "Left facing camera",
  right: "Right facing camera",
};

/** Formats a video MediaStreamTrack's settings() into labeled rows. */
export function describeVideoTrack(settings: VideoTrackSettings): Record<string, string> {
  const out: Record<string, string> = {};
  const { width, height, frameRate, facingMode, deviceId, aspectRatio } = settings ?? {};

  if (isFiniteNumber(width) && isFiniteNumber(height) && width > 0 && height > 0) {
    out["Resolution"] =
      `${Math.round(width)} x ${Math.round(height)} (${resolutionName(height)}, ${aspectRatioLabel(width, height)})`;
  } else if (isFiniteNumber(aspectRatio) && aspectRatio > 0) {
    out["Aspect ratio"] = `${aspectRatio.toFixed(2)}:1`;
  }

  if (isFiniteNumber(frameRate) && frameRate > 0) {
    out["Frame rate"] = Number.isInteger(frameRate) ? `${frameRate} fps` : `${frameRate.toFixed(1)} fps`;
  }

  if (facingMode) {
    out["Facing"] = FACING_LABELS[facingMode] ?? facingMode;
  }

  if (deviceId) {
    out["Device ID"] = deviceId;
  }

  if (Object.keys(out).length === 0) {
    out["Video"] = "No video track details reported";
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * audio track formatting
 * ------------------------------------------------------------------ */

export interface AudioTrackSettings {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  deviceId?: string;
}

function channelsLabel(count: number): string {
  if (count === 1) return "1 (mono)";
  if (count === 2) return "2 (stereo)";
  return `${count} (multichannel)`;
}

function toggleLabel(value: boolean): string {
  return value ? "On" : "Off";
}

/** Formats an audio MediaStreamTrack's settings() into labeled rows. */
export function describeAudioTrack(settings: AudioTrackSettings): Record<string, string> {
  const out: Record<string, string> = {};
  const { sampleRate, channelCount, echoCancellation, noiseSuppression, autoGainControl, deviceId } =
    settings ?? {};

  if (isFiniteNumber(sampleRate) && sampleRate > 0) {
    out["Sample rate"] = `${Math.round(sampleRate)} Hz`;
  }
  if (isFiniteNumber(channelCount) && channelCount > 0) {
    out["Channels"] = channelsLabel(Math.round(channelCount));
  }
  if (typeof echoCancellation === "boolean") out["Echo cancellation"] = toggleLabel(echoCancellation);
  if (typeof noiseSuppression === "boolean") out["Noise suppression"] = toggleLabel(noiseSuppression);
  if (typeof autoGainControl === "boolean") out["Auto gain control"] = toggleLabel(autoGainControl);
  if (deviceId) out["Device ID"] = deviceId;

  if (Object.keys(out).length === 0) {
    out["Audio"] = "No audio track details reported";
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * device list formatting
 * ------------------------------------------------------------------ */

export interface DeviceEntry {
  kind: string;
  label: string;
  deviceId: string;
}

const KIND_LABELS: Record<string, string> = {
  videoinput: "Cameras",
  audioinput: "Microphones",
  audiooutput: "Speakers",
};

/** Groups enumerateDevices() output by kind, with counts and names (or a
 * permission notice when labels are empty, which happens before a grant). */
export function summarizeDevices(devices: DeviceEntry[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const list = devices ?? [];

  if (list.length === 0) {
    out["Devices"] = "No devices reported";
    return out;
  }

  const groups = new Map<string, DeviceEntry[]>();
  for (const d of list) {
    const arr = groups.get(d.kind) ?? [];
    arr.push(d);
    groups.set(d.kind, arr);
  }

  for (const [kind, entries] of groups) {
    const label = KIND_LABELS[kind] ?? kind;
    const hasLabels = entries.some((e) => e.label && e.label.trim().length > 0);
    if (!hasLabels) {
      out[label] = `${entries.length} detected, permission needed to see names`;
    } else {
      const names = entries.map((e) => (e.label && e.label.trim() ? e.label.trim() : "Unnamed device"));
      out[label] = `${entries.length}: ${names.join(", ")}`;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface RunOpts {
  detail?: string;
  [key: string]: unknown;
}

export type WebcamMicResult = Record<string, string>;

const EMPTY_STATUS =
  "Click Start above to turn on your camera and microphone preview. Nothing is recorded or uploaded: the stream and levels stay on this page and stop the moment you press Stop or navigate away.";

const REPORT_KEYS = ["devices", "video", "audio", "levels"] as const;

interface Report {
  devices?: DeviceEntry[];
  video?: VideoTrackSettings;
  audio?: AudioTrackSettings;
  levels?: { rms?: number; peak?: number };
}

function parseReport(raw: string): Report {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      "This panel builds the report automatically from the camera and mic preview above; paste valid JSON only if testing by hand.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not look like a webcam or microphone report.",
      "Expected an object with any of: devices, video, audio, levels.",
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!REPORT_KEYS.some((k) => k in obj)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not contain any recognized report fields (devices, video, audio, levels).",
      "Expected an object with any of: devices, video, audio, levels.",
    );
  }

  return obj as Report;
}

/** Rows kept when the Detail option is set to summary. */
const SUMMARY_KEYS = [
  "Cameras",
  "Microphones",
  "Video: Resolution",
  "Video: Frame rate",
  "Audio: Sample rate",
  "Mic level (RMS)",
];

function normalizeDetail(value: unknown): "summary" | "full" {
  return value === "summary" ? "summary" : "full";
}

export function run(input: string, opts: RunOpts): WebcamMicResult {
  const raw = input ?? "";
  if (!raw.trim()) {
    return { Status: EMPTY_STATUS };
  }

  const report = parseReport(raw);
  const out: Record<string, string> = {};

  if (report.devices) {
    Object.assign(out, summarizeDevices(report.devices));
  }

  if (report.video) {
    for (const [k, v] of Object.entries(describeVideoTrack(report.video))) {
      out[`Video: ${k}`] = v;
    }
  }

  if (report.audio) {
    for (const [k, v] of Object.entries(describeAudioTrack(report.audio))) {
      out[`Audio: ${k}`] = v;
    }
  }

  if (report.levels) {
    const { rms, peak } = report.levels;
    if (isFiniteNumber(rms)) {
      const db = rmsToDb(rms);
      out["Mic level (RMS)"] = `${db.toFixed(1)} dB, ${describeLevel(db)}`;
    }
    if (isFiniteNumber(peak)) {
      const db = peakToDb(peak);
      out["Mic level (peak)"] = `${db.toFixed(1)} dB`;
    }
  }

  if (Object.keys(out).length === 0) {
    return { Report: "The report did not include any readable devices, video, audio, or level data." };
  }

  if (normalizeDetail(opts?.detail) === "summary") {
    const filtered: Record<string, string> = {};
    for (const key of SUMMARY_KEYS) {
      if (key in out) filtered[key] = out[key]!;
    }
    return Object.keys(filtered).length > 0 ? filtered : out;
  }

  return out;
}

export default { run } satisfies ToolLogic<string, WebcamMicResult, RunOpts>;
