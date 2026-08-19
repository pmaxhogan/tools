import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Pure logic layer for the Element Recorder tool.
 *
 * The actual capture (getDisplayMedia + CropTarget.fromElement Region Capture,
 * or the canvas-crop fallback, + MediaRecorder) is entirely browser API
 * surface and lives in the panel (rule 27: tool logic never touches the DOM).
 * This module provides the pieces worth unit testing in isolation: mime
 * negotiation, region/drag math, a WebM duration-header fix for MediaRecorder
 * output, bitrate estimation, and filenames. `run()` turns a JSON report the
 * panel hands back after a recording into labeled rows (mirrors
 * src/tools/screen-recorder's split; not imported from here).
 */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/* ------------------------------------------------------------------ *
 * mime negotiation
 * ------------------------------------------------------------------ */

/** Default candidate order: most specific/efficient codec first. */
export const DEFAULT_MIME_CANDIDATES: string[] = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/mp4",
];

const LAST_RESORT_MIME = "video/webm";

/**
 * Picks the first candidate mime string the panel's `MediaRecorder.isTypeSupported`
 * check accepts, walking `candidates` in order. Falls back to
 * `DEFAULT_MIME_CANDIDATES` when no candidate list is supplied, and to
 * "video/webm" as an absolute last resort when nothing is supported.
 */
export function pickMimeType(
  candidates: string[],
  supported: (mime: string) => boolean,
): string {
  const list = Array.isArray(candidates) && candidates.length > 0 ? candidates : DEFAULT_MIME_CANDIDATES;
  for (const mime of list) {
    if (typeof mime === "string" && mime && supported(mime)) return mime;
  }
  return LAST_RESORT_MIME;
}

/** "mp4" for any mp4 mime, "webm" for everything else (including unknown). */
export function extForMime(mime: string): string {
  return typeof mime === "string" && mime.toLowerCase().startsWith("video/mp4") ? "mp4" : "webm";
}

/* ------------------------------------------------------------------ *
 * filenames
 * ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Builds a sortable, collision-resistant filename like
 * "element-recording-2026-08-18-143005.webm" from local wall-clock time.
 * Accepts an injected Date so callers (and tests) get a deterministic name.
 */
export function fileName(prefix: string, mime: string, now?: Date): string {
  const base = prefix && prefix.trim() ? prefix.trim() : "element-recording";
  const ext = extForMime(mime);
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const date = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join("-");
  const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join("");
  return `${base}-${date}-${time}.${ext}`;
}

/* ------------------------------------------------------------------ *
 * quality / bitrate
 * ------------------------------------------------------------------ */

export type Quality = "low" | "medium" | "high";

/** A select value is always exactly one of these three; anything else defaults to medium. */
function normalizeQuality(value: unknown): Quality {
  return value === "low" || value === "high" ? value : "medium";
}

const QUALITY_MULTIPLIER: Record<Quality, number> = {
  low: 0.5,
  medium: 1,
  high: 1.75,
};

/** Bitrate multiplier for a quality select value (unknown values default to medium's 1x). */
export function qualityMultiplier(quality: string): number {
  return QUALITY_MULTIPLIER[normalizeQuality(quality)];
}

const BITS_PER_PIXEL = 0.1;
const MIN_BITRATE_BPS = 250_000;
const MAX_BITRATE_BPS = 20_000_000;

/**
 * Recommended `videoBitsPerSecond` for a region of the given pixel size and
 * frame rate, clamped to a sane range. Monotonic in width, height, and fps.
 */
export function estimateBitrate(width: number, height: number, fps: number): number {
  const w = isFiniteNumber(width) && width > 0 ? width : 0;
  const h = isFiniteNumber(height) && height > 0 ? height : 0;
  const f = isFiniteNumber(fps) && fps > 0 ? fps : 30;
  const raw = w * h * f * BITS_PER_PIXEL;
  return Math.round(Math.min(MAX_BITRATE_BPS, Math.max(MIN_BITRATE_BPS, raw)));
}

/* ------------------------------------------------------------------ *
 * region math
 * ------------------------------------------------------------------ */

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function n(v: unknown, fallback = 0): number {
  return isFiniteNumber(v) ? v : fallback;
}

/** Normalizes a drag from (x1,y1) to (x2,y2), in either direction, into a rect. */
export function regionFromPoints(x1: number, y1: number, x2: number, y2: number): Region {
  const ax = n(x1);
  const ay = n(y1);
  const bx = n(x2);
  const by = n(y2);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** Clamps a region so it stays fully inside bounds (default origin 0,0). */
export function clampRegion(region: Region, bounds: Bounds): Region {
  const boundsX = n(bounds?.x, 0);
  const boundsY = n(bounds?.y, 0);
  const boundsWidth = isFiniteNumber(bounds?.width) && bounds.width > 0 ? bounds.width : 0;
  const boundsHeight = isFiniteNumber(bounds?.height) && bounds.height > 0 ? bounds.height : 0;

  const rawWidth = isFiniteNumber(region?.width) ? Math.max(0, region.width) : 0;
  const rawHeight = isFiniteNumber(region?.height) ? Math.max(0, region.height) : 0;
  const width = Math.min(rawWidth, boundsWidth);
  const height = Math.min(rawHeight, boundsHeight);

  const rawX = n(region?.x, boundsX);
  const rawY = n(region?.y, boundsY);
  const x = Math.min(Math.max(rawX, boundsX), boundsX + boundsWidth - width);
  const y = Math.min(Math.max(rawY, boundsY), boundsY + boundsHeight - height);

  return { x, y, width, height };
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Snaps a CSS-pixel element rect (from getBoundingClientRect) to device
 * pixels at the given devicePixelRatio, rounding the left/top and
 * right/bottom edges independently so cropped width/height stay exact
 * instead of drifting from rounding a scaled width separately.
 */
export function snapToElementRect(rect: CssRect, dpr: number): Region {
  const ratio = isFiniteNumber(dpr) && dpr > 0 ? dpr : 1;
  const left = n(rect?.x);
  const top = n(rect?.y);
  const width = n(rect?.width);
  const height = n(rect?.height);

  const x = Math.round(left * ratio);
  const y = Math.round(top * ratio);
  const right = Math.round((left + width) * ratio);
  const bottom = Math.round((top + height) * ratio);

  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/* ------------------------------------------------------------------ *
 * recording summary
 * ------------------------------------------------------------------ */

export interface RecordingSummaryInput {
  bytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  fps?: number;
}

function formatDuration(ms: number): string {
  if (!isFiniteNumber(ms) || ms <= 0) return "0:00";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function formatBitrate(bitsPerSecond: number): string {
  if (!isFiniteNumber(bitsPerSecond) || bitsPerSecond <= 0) return "unknown";
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** Turns a finished-recording report into labeled, copyable rows. */
export function describeRecording(input: RecordingSummaryInput): Record<string, string> {
  const bytes = isFiniteNumber(input?.bytes) && input.bytes > 0 ? input.bytes : 0;
  const durationMs = isFiniteNumber(input?.durationMs) && input.durationMs > 0 ? input.durationMs : 0;
  const width = isFiniteNumber(input?.width) && input.width > 0 ? Math.round(input.width) : 0;
  const height = isFiniteNumber(input?.height) && input.height > 0 ? Math.round(input.height) : 0;
  const fps = isFiniteNumber(input?.fps) && input.fps > 0 ? input.fps : 0;
  const mimeType = input?.mimeType && input.mimeType.trim() ? input.mimeType.trim() : "unknown";

  const out: Record<string, string> = {};
  out["Size"] = formatBytes(bytes);
  out["Duration"] = formatDuration(durationMs);
  out["Frame size"] = width > 0 && height > 0 ? `${width} x ${height}` : "unknown";
  out["Format"] = mimeType;
  out["Frame rate"] = fps > 0 ? `${Number.isInteger(fps) ? fps : fps.toFixed(1)} fps` : "unknown";
  out["Bitrate"] = durationMs > 0 ? formatBitrate((bytes * 8) / (durationMs / 1000)) : "unknown";
  return out;
}

/* ------------------------------------------------------------------ *
 * WebM duration header fix
 *
 * MediaRecorder writes WebM with an unknown-size Segment and no Duration in
 * the Segment Info, since it does not know the final length up front. This
 * walks the EBML tree (EBML Header, Segment, Segment Info) to find or insert
 * the Info > Duration element (id 0x4489) and writes the real duration, so
 * players that read the header up front (rather than scanning Cues) show a
 * correct length and seek bar immediately.
 * ------------------------------------------------------------------ */

const EBML_ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
};

const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns per tick: WebM's usual default (1ms/tick)

interface EbmlElement {
  id: number;
  idLength: number;
  sizeLength: number;
  sizeUnknown: boolean;
  headerStart: number;
  dataStart: number;
  dataEnd: number;
}

function readVintLength(firstByte: number): number {
  if (firstByte === 0) return -1;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (firstByte & mask) === 0) {
    mask >>= 1;
    length++;
  }
  return length <= 8 ? length : -1;
}

function readId(bytes: Uint8Array, offset: number): { id: number; length: number } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  const length = readVintLength(first);
  if (length < 0 || offset + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[offset + i]!;
  return { id, length };
}

function readSize(
  bytes: Uint8Array,
  offset: number,
): { size: number; length: number; unknown: boolean } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  const length = readVintLength(first);
  if (length < 0 || offset + length > bytes.length) return null;
  const marker = 0x80 >> (length - 1);
  let value = first & (marker - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  const max = Math.pow(2, 7 * length) - 1;
  return { size: value, length, unknown: value === max };
}

/** Parses one level of sibling EBML elements from `start` up to `end`. */
function parseChildren(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const idRes = readId(bytes, offset);
    if (!idRes) break;
    const sizeRes = readSize(bytes, offset + idRes.length);
    if (!sizeRes) break;
    const dataStart = offset + idRes.length + sizeRes.length;
    const dataEnd = sizeRes.unknown ? end : Math.min(end, dataStart + sizeRes.size);
    out.push({
      id: idRes.id,
      idLength: idRes.length,
      sizeLength: sizeRes.length,
      sizeUnknown: sizeRes.unknown,
      headerStart: offset,
      dataStart,
      dataEnd,
    });
    if (sizeRes.unknown) break; // an unknown-size element consumes the rest of its parent
    offset = dataEnd;
  }
  return out;
}

function readUintElementValue(bytes: Uint8Array, el: EbmlElement): number {
  let value = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) value = value * 256 + bytes[i]!;
  return value;
}

function readTimecodeScale(bytes: Uint8Array, info: EbmlElement, infoChildren: EbmlElement[]): number {
  const tcs = infoChildren.find((e) => e.id === EBML_ID.TIMECODE_SCALE);
  if (!tcs) return DEFAULT_TIMECODE_SCALE;
  const value = readUintElementValue(bytes, tcs);
  return value > 0 ? value : DEFAULT_TIMECODE_SCALE;
}

function encodeFloat64(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return new Uint8Array(buf);
}

function encodeSizeVint(value: number, length: number): Uint8Array {
  const marker = 0x80 >> (length - 1);
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = marker | v;
  return out;
}

function minSizeLength(value: number): number {
  for (let length = 1; length <= 8; length++) {
    const max = Math.pow(2, 7 * length) - 2; // reserve the all-1s value for "unknown"
    if (value <= max) return length;
  }
  return 8;
}

/** Re-encodes an element's size field for a new data length, keeping the
 * original byte width when it still fits (so nothing else has to shift). */
function resizeSizeField(originalLength: number, newDataLength: number): Uint8Array {
  const cap = Math.pow(2, 7 * originalLength) - 2;
  const length = newDataLength <= cap ? originalLength : minSizeLength(newDataLength);
  return encodeSizeVint(newDataLength, length);
}

interface ByteEdit {
  start: number;
  end: number;
  replacement: Uint8Array;
}

/** Applies a set of non-overlapping edits (given in original-byte offsets) in one pass. */
function applyEdits(bytes: Uint8Array, edits: ByteEdit[]): Uint8Array {
  const sorted = edits.slice().sort((a, b) => a.start - b.start);
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start > cursor) chunks.push(bytes.subarray(cursor, edit.start));
    chunks.push(edit.replacement);
    cursor = Math.max(cursor, edit.end);
  }
  if (cursor < bytes.length) chunks.push(bytes.subarray(cursor, bytes.length));

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Writes `durationMs` into the WebM's Segment > Info > Duration element,
 * overwriting it in place when present, inserting it when absent. Returns
 * the input unchanged if the buffer does not contain a recognizable
 * Segment/Info structure (best-effort: never throws on malformed input).
 */
export function patchWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array {
  const ms = isFiniteNumber(durationMs) && durationMs > 0 ? durationMs : 0;

  const top = parseChildren(bytes, 0, bytes.length);
  const segment = top.find((e) => e.id === EBML_ID.SEGMENT);
  if (!segment) return bytes.slice();

  const segmentChildren = parseChildren(bytes, segment.dataStart, segment.dataEnd);
  const info = segmentChildren.find((e) => e.id === EBML_ID.INFO);
  if (!info) return bytes.slice();

  const infoChildren = parseChildren(bytes, info.dataStart, info.dataEnd);
  const timecodeScale = readTimecodeScale(bytes, info, infoChildren);
  const durationValue = (ms * 1_000_000) / timecodeScale;
  const durationBytes = encodeFloat64(durationValue);

  const durationEl = infoChildren.find((e) => e.id === EBML_ID.DURATION);

  // Fast path: an 8-byte Duration already exists, so only its value bytes
  // change. No size fields move, so nothing else in the file shifts.
  if (durationEl && !durationEl.sizeUnknown && durationEl.dataEnd - durationEl.dataStart === 8) {
    const out = bytes.slice();
    out.set(durationBytes, durationEl.dataStart);
    return out;
  }

  const newElement = new Uint8Array(2 + 1 + 8); // id(2) + size(1) + float64 data(8)
  newElement[0] = 0x44;
  newElement[1] = 0x89;
  newElement[2] = 0x88; // size vint: marker 0x80 | value 8
  newElement.set(durationBytes, 3);

  let removeStart = -1;
  let removeEnd = -1;
  let insertAt: number;
  if (durationEl) {
    // Existing Duration with an unexpected width: replace it wholesale.
    removeStart = durationEl.headerStart;
    removeEnd = durationEl.dataEnd;
    insertAt = durationEl.headerStart;
  } else {
    // Insert right after TimecodeScale when present, else at the start of Info.
    const tcs = infoChildren.find((e) => e.id === EBML_ID.TIMECODE_SCALE);
    insertAt = tcs ? tcs.dataEnd : info.dataStart;
  }

  const removedLength = removeStart >= 0 ? removeEnd - removeStart : 0;
  const delta = newElement.length - removedLength;

  const edits: ByteEdit[] = [];

  // Grow Info's size field to cover the inserted/replaced bytes.
  const newInfoDataLength = info.dataEnd - info.dataStart + delta;
  const infoSizeStart = info.headerStart + info.idLength;
  edits.push({
    start: infoSizeStart,
    end: infoSizeStart + info.sizeLength,
    replacement: resizeSizeField(info.sizeLength, newInfoDataLength),
  });

  // Segment usually has an unknown size (MediaRecorder streams it), which
  // needs no update at all; only grow it when it has a real declared size.
  if (!segment.sizeUnknown) {
    const newSegDataLength = segment.dataEnd - segment.dataStart + delta;
    const segSizeStart = segment.headerStart + segment.idLength;
    edits.push({
      start: segSizeStart,
      end: segSizeStart + segment.sizeLength,
      replacement: resizeSizeField(segment.sizeLength, newSegDataLength),
    });
  }

  edits.push({
    start: insertAt,
    end: removeStart >= 0 ? removeEnd : insertAt,
    replacement: newElement,
  });

  return applyEdits(bytes, edits);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface ElementRecorderOpts {
  quality: string;
  fps: number;
  format: string; // "webm" | "mp4-if-supported"
  [key: string]: unknown;
}

const REPORT_KEYS = ["bytes", "durationMs", "width", "height", "mimeType", "fps"] as const;

function parseRecordingReport(raw: string): RecordingSummaryInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      "This panel fills in the report automatically after a recording finishes; paste valid JSON only if testing by hand.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not look like a recording report.",
      "Expected an object with any of: bytes, durationMs, width, height, mimeType, fps.",
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!REPORT_KEYS.some((k) => k in obj)) {
    throw new ToolError(
      "not-a-report",
      "The JSON does not contain any recognized report fields.",
      "Expected an object with any of: bytes, durationMs, width, height, mimeType, fps.",
    );
  }

  return obj as RecordingSummaryInput;
}

const CHROMIUM_SUPPORT_NOTE =
  "Region Capture, the API that crops the capture stream to one element, needs Chromium 104 or newer: Chrome, Edge, Opera, and other Chromium based browsers. Elsewhere this tool falls back to capturing the full tab and cropping every frame into a canvas before recording, which costs more CPU but still records only the region you picked.";

/**
 * No live browser state to read (meta.input is "application/json" but the
 * page starts with nothing to show): before a recording finishes, this
 * renders the configured settings and a browser-support note. After a
 * recording, the panel serializes what it captured into a JSON report and
 * this turns it into labeled rows via describeRecording.
 */
export function run(input: string, opts: ElementRecorderOpts): Record<string, string> {
  const raw = input ?? "";
  const quality = normalizeQuality(opts?.quality);
  const fps = isFiniteNumber(opts?.fps) && opts.fps > 0 ? opts.fps : 30;
  const format = opts?.format === "mp4-if-supported" ? "mp4-if-supported" : "webm";

  if (!raw.trim()) {
    const referenceBps = Math.round(estimateBitrate(1920, 1080, fps) * qualityMultiplier(quality));
    const out: Record<string, string> = {};
    out["Status"] =
      "Draw a rectangle over the part of the page to record, or switch to pick mode and click an element. Press Start to record only that region. Nothing is uploaded: cropping and recording both happen on this device.";
    out["Region Capture support"] = CHROMIUM_SUPPORT_NOTE;
    out["Configured quality"] = `${quality} (~${Math.round(referenceBps / 1000)} kbps at 1080p)`;
    out["Configured frame rate"] = `${fps} fps`;
    out["Configured export format"] =
      format === "mp4-if-supported"
        ? "MP4 when the browser's MediaRecorder supports it, otherwise WebM"
        : "WebM";
    return out;
  }

  const report = parseRecordingReport(raw);
  return describeRecording({
    bytes: report.bytes,
    durationMs: report.durationMs,
    width: report.width,
    height: report.height,
    mimeType: report.mimeType,
    fps: report.fps ?? fps,
  });
}

export default { run } satisfies ToolLogic<string, Record<string, string>, ElementRecorderOpts>;
