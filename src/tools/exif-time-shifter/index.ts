import { ToolError, type ToolLogic } from "../types";

/**
 * EXIF Time Shifter logic.
 *
 * Every Exif datetime is a fixed 20 byte ASCII value, "YYYY:MM:DD HH:MM:SS" plus
 * a trailing NUL, and it is always stored out of line at an offset inside the
 * TIFF block. Shifting a clock therefore never changes any length, so this tool
 * patches the exact 19 characters in place instead of re-serializing the TIFF.
 * Nothing else in the file moves: thumbnails, maker notes, unknown vendor tags
 * and the image data itself all keep their original bytes and their original
 * offsets.
 *
 * The walker handles both TIFF byte orders (II little endian and MM big endian)
 * and both containers: a JPEG, where the TIFF sits inside the APP1 Exif segment,
 * and a bare TIFF file, where it starts at byte zero.
 *
 * GPS timestamps are deliberately left alone. GPSTimeStamp is three rationals
 * and GPSDateStamp is a separate field, so a shift across midnight would desync
 * the pair, and GPS time is satellite time that was never wrong to begin with.
 */

/* ------------------------------------------------------------------ */
/* option shape                                                        */
/* ------------------------------------------------------------------ */

export interface ExifShiftOpts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  [key: string]: unknown;
}

/** One datetime field that was rewritten. */
export interface ShiftedTag {
  tag: string;
  from: string;
  to: string;
}

export interface ExifShiftResult {
  /** A patched copy. The input array is never modified. */
  bytes: Uint8Array;
  changed: ShiftedTag[];
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;

/** "YYYY:MM:DD HH:MM:SS" without the trailing NUL. */
const DATETIME_LENGTH = 19;

const DATETIME_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const FORMAT_FIX =
  "Use a JPEG (.jpg or .jpeg) or a raw TIFF file. PNG, WebP and HEIC store their metadata a different way and are not supported here.";

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

function u16(b: Uint8Array, at: number, little: boolean): number {
  return little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1];
}

function u32(b: Uint8Array, at: number, little: boolean): number {
  return little
    ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
    : ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function readAscii(b: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const at = start + i;
    if (at >= b.length) break;
    const c = b[at];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Byte width of each TIFF field type, indexed by the type code. */
function typeSize(type: number): number {
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  return type >= 0 && type < sizes.length ? sizes[type] : 0;
}

/* ------------------------------------------------------------------ */
/* container walk                                                      */
/* ------------------------------------------------------------------ */

function isBareTiff(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const ii = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00;
  const mm = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a;
  return ii || mm;
}

function describeFormat(b: Uint8Array): string {
  const at = (i: number) => (i < b.length ? b[i] : -1);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "That is a PNG, and PNG files do not carry an Exif camera clock this tool can patch.";
  }
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "That is a WebP, which keeps its Exif in a RIFF chunk this tool does not patch yet.";
  }
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    return "That is a HEIC or MP4 style container, which stores Exif a different way than JPEG does.";
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return "That is a GIF, which has no Exif metadata at all.";
  }
  return "That file is neither a JPEG nor a TIFF, so it has no Exif block to shift.";
}

/**
 * Walk a JPEG segment table and return the offset of the TIFF header inside the
 * APP1 Exif segment. XMP also uses APP1, so the "Exif" header is checked rather
 * than the marker alone.
 */
function findJpegExif(b: Uint8Array): number {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = b[at + 1];
    // Fill byte before the real marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // End of image, or the start of entropy coded scan data.
    if (marker === 0xd9 || marker === 0xda) break;

    const len = (b[at + 2] << 8) | b[at + 3];
    if (len < 2 || at + 2 + len > b.length) break;

    const isExif =
      marker === 0xe1 &&
      len >= 8 &&
      b[at + 4] === 0x45 &&
      b[at + 5] === 0x78 &&
      b[at + 6] === 0x69 &&
      b[at + 7] === 0x66 &&
      b[at + 8] === 0x00 &&
      b[at + 9] === 0x00;
    if (isExif) return at + 10;

    at += 2 + len;
  }
  throw new ToolError(
    "no-exif",
    "This JPEG has no Exif block, so there is no camera clock stored in it.",
    "Pick a photo straight off the camera or phone. Exported copies and screenshots usually have the metadata stripped.",
  );
}

function locateTiff(b: Uint8Array): number {
  if (isBareTiff(b)) return 0;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return findJpegExif(b);
  throw new ToolError("unsupported-format", describeFormat(b), FORMAT_FIX);
}

/* ------------------------------------------------------------------ */
/* TIFF walk                                                           */
/* ------------------------------------------------------------------ */

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of the value, inline or resolved through the pointer. */
  valueAt: number;
}

function readIfd(b: Uint8Array, tiff: number, little: boolean, ifdOffset: number): IfdEntry[] {
  const at = tiff + ifdOffset;
  if (ifdOffset <= 0 || at + 2 > b.length) return [];
  const count = u16(b, at, little);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = u16(b, e, little);
    const type = u16(b, e + 2, little);
    const n = u32(b, e + 4, little);
    const size = typeSize(type) * n;
    const valueAt = size <= 4 ? e + 8 : tiff + u32(b, e + 8, little);
    entries.push({ tag, type, count: n, valueAt });
  }
  return entries;
}

interface ParsedExif {
  tiff: number;
  little: boolean;
  ifd0: IfdEntry[];
  exifIfd: IfdEntry[];
}

function parseExif(b: Uint8Array): ParsedExif {
  const tiff = locateTiff(b);
  if (tiff + 8 > b.length) {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block ends before its TIFF header is complete.",
      "The file looks truncated. Re-copy it off the camera card and try again.",
    );
  }
  const mark = (b[tiff] << 8) | b[tiff + 1];
  let little: boolean;
  if (mark === 0x4949) little = true;
  else if (mark === 0x4d4d) little = false;
  else {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block does not start with a valid TIFF byte order mark.",
      "The metadata is damaged. Re-copy the original file off the camera card and try again.",
    );
  }
  if (u16(b, tiff + 2, little) !== 42) {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block is missing the TIFF magic number, so its structure cannot be trusted.",
      "The metadata is damaged. Re-copy the original file off the camera card and try again.",
    );
  }

  const ifd0 = readIfd(b, tiff, little, u32(b, tiff + 4, little));

  let exifIfd: IfdEntry[] = [];
  const pointer = ifd0.find((e) => e.tag === TAG_EXIF_IFD);
  if (pointer && pointer.valueAt >= 0 && pointer.valueAt + 4 <= b.length) {
    const subOffset =
      pointer.type === TYPE_SHORT
        ? u16(b, pointer.valueAt, little)
        : u32(b, pointer.valueAt, little);
    exifIfd = readIfd(b, tiff, little, subOffset);
  }

  return { tiff, little, ifd0, exifIfd };
}

function asciiTag(b: Uint8Array, entries: IfdEntry[], tag: number): string | undefined {
  const e = entries.find((x) => x.tag === tag);
  if (!e || e.type !== TYPE_ASCII || e.valueAt < 0 || e.valueAt >= b.length) return undefined;
  const text = readAscii(b, e.valueAt, Math.min(e.count, 128)).trim();
  return text || undefined;
}

/* ------------------------------------------------------------------ */
/* date math                                                           */
/* ------------------------------------------------------------------ */

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Shift one "YYYY:MM:DD HH:MM:SS" value. Everything runs through Date.UTC and
 * the getUTC readers, so the machine's own time zone and its DST rules never
 * touch the result. Returns null when the value is not a real timestamp, which
 * is how cameras write an unset field.
 */
function shiftDatetime(value: string, deltaSeconds: number): string | null {
  const m = DATETIME_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);

  let ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC maps years 0 to 99 into the 1900s, so undo that for a stray "0024".
  if (y >= 0 && y < 100) {
    const corrected = new Date(ms);
    corrected.setUTCFullYear(y);
    ms = corrected.getTime();
  }
  if (!Number.isFinite(ms)) return null;

  const shifted = new Date(ms + deltaSeconds * 1000);
  const year = shifted.getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > 9999) {
    throw new ToolError(
      "out-of-range",
      `Shifting ${value} by that much lands outside the year range Exif can store (0000 to 9999).`,
      "Use a smaller shift. An Exif datetime is a fixed width field, so a five digit year does not fit.",
    );
  }

  return (
    `${pad(year, 4)}:${pad(shifted.getUTCMonth() + 1, 2)}:${pad(shifted.getUTCDate(), 2)} ` +
    `${pad(shifted.getUTCHours(), 2)}:${pad(shifted.getUTCMinutes(), 2)}:${pad(shifted.getUTCSeconds(), 2)}`
  );
}

/* ------------------------------------------------------------------ */
/* the patcher                                                         */
/* ------------------------------------------------------------------ */

/**
 * Rewrite every Exif datetime in place by `deltaSeconds` and return a patched
 * copy plus the list of what changed. Pure: the input array is untouched, and
 * the output is always exactly the same length as the input.
 */
export function shiftExifBytes(bytes: Uint8Array, deltaSeconds: number): ExifShiftResult {
  if (!bytes || bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "No photo loaded yet.",
      "Drop a JPEG onto the panel above, or pick one with the file button.",
    );
  }

  const { ifd0, exifIfd } = parseExif(bytes);

  const targets: { tag: string; entry: IfdEntry }[] = [];
  for (const e of ifd0) if (e.tag === TAG_DATETIME) targets.push({ tag: "DateTime", entry: e });
  for (const e of exifIfd) {
    if (e.tag === TAG_DATETIME_ORIGINAL) targets.push({ tag: "DateTimeOriginal", entry: e });
    if (e.tag === TAG_DATETIME_DIGITIZED) targets.push({ tag: "DateTimeDigitized", entry: e });
  }

  const out = bytes.slice();
  const changed: ShiftedTag[] = [];
  const patchedAt = new Set<number>();

  for (const target of targets) {
    const e = target.entry;
    if (e.type !== TYPE_ASCII || e.count < DATETIME_LENGTH) continue;
    if (e.valueAt < 0 || e.valueAt + DATETIME_LENGTH > bytes.length) continue;

    // Always read the original array, so two tags that share one value offset
    // can never be shifted twice.
    const from = readAscii(bytes, e.valueAt, DATETIME_LENGTH);
    const to = shiftDatetime(from, deltaSeconds);
    if (to === null) continue;

    if (!patchedAt.has(e.valueAt)) {
      for (let i = 0; i < DATETIME_LENGTH; i++) out[e.valueAt + i] = to.charCodeAt(i);
      patchedAt.add(e.valueAt);
    }
    changed.push({ tag: target.tag, from, to });
  }

  if (changed.length === 0) {
    throw new ToolError(
      "no-datetime",
      "This file has Exif metadata but none of the three datetime fields, so there is no clock to correct.",
      "Shifting needs DateTime, DateTimeOriginal or DateTimeDigitized. Some editors drop them on export.",
    );
  }

  return { bytes: out, changed };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function optNumber(opts: ExifShiftOpts | undefined, key: string): number {
  const raw = opts ? opts[key] : undefined;
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function humanShift(deltaSeconds: number): string {
  const sign = deltaSeconds < 0 ? "-" : "+";
  let rest = Math.abs(deltaSeconds);
  const units: [string, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    }
  }
  return sign + parts.join(" ");
}

function decodeBase64(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ToolError(
      "empty-input",
      "No photo loaded yet.",
      "Drop a JPEG onto the panel above, or pick one with the file button.",
    );
  }
  const cleaned = trimmed.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const notBase64 = new ToolError(
    "not-base64",
    "That text is not a photo. A JPEG is binary, so pasted text only works when it is base64.",
    "Drop the .jpg file itself onto the panel above, or paste its base64 or data URL form.",
  );
  if (!cleaned || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) throw notBase64;

  const normalized = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw notBase64;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCamera(bytes: Uint8Array): { make?: string; model?: string } {
  try {
    const { ifd0 } = parseExif(bytes);
    return {
      make: asciiTag(bytes, ifd0, TAG_MAKE),
      model: asciiTag(bytes, ifd0, TAG_MODEL),
    };
  } catch {
    return {};
  }
}

export function run(input: Uint8Array | string, opts: ExifShiftOpts): Record<string, string> {
  const delta =
    optNumber(opts, "days") * 86400 +
    optNumber(opts, "hours") * 3600 +
    optNumber(opts, "minutes") * 60 +
    optNumber(opts, "seconds");

  if (delta === 0) {
    throw new ToolError(
      "zero-shift",
      "The shift is zero, so every timestamp would stay exactly as it is.",
      "Set at least one of days, hours, minutes or seconds.",
    );
  }

  const bytes = typeof input === "string" ? decodeBase64(input) : input;
  const { changed } = shiftExifBytes(bytes, delta);
  const camera = readCamera(bytes);

  const out: Record<string, string> = { "Shift applied": humanShift(delta) };
  for (const c of changed) out[c.tag] = `${c.from} -> ${c.to}`;
  if (camera.make) out["Camera make"] = camera.make;
  if (camera.model) out["Camera model"] = camera.model;
  out["Saving the file"] =
    "Only these 19 character date fields change, so the patched copy is byte for byte identical everywhere else. Use the download button in the panel above to save it.";
  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  ExifShiftOpts
>;
