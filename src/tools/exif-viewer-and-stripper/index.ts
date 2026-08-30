import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * EXIF Viewer and Stripper logic.
 *
 * Reads every metadata block a normal photo can carry, and writes a copy with
 * those blocks removed without touching a single pixel.
 *
 * Four containers are walked by hand rather than through a library, because the
 * stripper has to rebuild the same structure it just read and a parser that
 * only hands back decoded values cannot tell you which byte range to drop:
 *
 * - JPEG: a marker chain. Metadata lives in APP1 (Exif and XMP), APP13
 *   (Photoshop, which carries IPTC), and COM.
 * - PNG: a chunk chain. Metadata lives in eXIf, tEXt, zTXt, and iTXt.
 * - WebP: RIFF chunks. Metadata lives in EXIF and XMP, and the VP8X header
 *   carries a flag bit for each, which has to be cleared when they go.
 * - TIFF: the bare TIFF block, which is what a raw file and the inside of a
 *   JPEG APP1 both are.
 *
 * Stripping never re-encodes. The compressed image data is copied byte for
 * byte, so quality is identical and the file stays bit for bit the same
 * everywhere the metadata was not. Two blocks are kept on purpose: an ICC color
 * profile, because dropping it visibly shifts color, and the APP14 Adobe
 * marker, because dropping it makes some decoders read a CMYK or YCCK JPEG with
 * the wrong channel order.
 */

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export type Container = "jpeg" | "png" | "webp" | "tiff" | "unknown";

/** One decoded metadata field. */
export interface MetaField {
  /** Which directory it came from: "IFD0", "Exif", "GPS", "Interop", "IFD1". */
  group: string;
  /** The tag's readable name, or a hex id when the tag is not in the table. */
  name: string;
  /** The raw tag number, useful when the name is a fallback. */
  tag: number;
  /** The value as text, already made human readable where that helps. */
  value: string;
}

/** One segment or chunk in the container, in file order. */
export interface SegmentInfo {
  /** "APP1", "IDAT", "VP8X", and so on. */
  id: string;
  /** What it carries, in plain words. */
  description: string;
  /** Byte offset of the segment header in the file. */
  offset: number;
  /** Total bytes the segment occupies, framing included. */
  size: number;
  /** True when "strip metadata" would drop it. */
  metadata: boolean;
}

/** A PNG text chunk or an IPTC dataset: a keyword and its text. */
export interface TextRecord {
  source: "PNG tEXt" | "PNG zTXt" | "PNG iTXt" | "IPTC";
  keyword: string;
  value: string;
}

export interface GpsFix {
  latitude: number;
  longitude: number;
  /** Meters above sea level, negative below. Absent when the tag is missing. */
  altitude?: number;
  /** "38.627000, -90.199400", the form a map search box accepts. */
  decimal: string;
  /** An OpenStreetMap URL. Nothing fetches it; it is text until you click it. */
  mapUrl: string;
}

export interface ExifReport {
  container: Container;
  /** "JPEG", "PNG", "WebP", "TIFF". */
  formatLabel: string;
  byteLength: number;
  fields: MetaField[];
  segments: SegmentInfo[];
  text: TextRecord[];
  gps: GpsFix | null;
  /** The raw XMP packet, exactly as it sits in the file. */
  xmp: string | null;
  /** The embedded IFD1 preview, when the file has one. */
  thumbnail: Uint8Array | null;
  /** True when nothing metadata shaped was found anywhere. */
  empty: boolean;
}

export interface StripResult {
  bytes: Uint8Array;
  /** Human readable list of what came out. */
  removed: string[];
  /** Blocks deliberately left in place, and why. */
  kept: string[];
  bytesSaved: number;
}

export interface ExifViewerOpts {
  /** Also write the cleaned copy and report what was removed. */
  strip?: boolean;
  /** List every tag rather than the common ones. */
  showAll?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

function u16be(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!;
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

function ascii(b: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && at + i < b.length; i++) out += String.fromCharCode(b[at + i]!);
  return out;
}

function matchesAt(b: Uint8Array, at: number, signature: readonly number[]): boolean {
  if (b.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (b[at + i] !== signature[i]) return false;
  return true;
}

function startsWithText(b: Uint8Array, text: string): boolean {
  if (b.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[i] !== text.charCodeAt(i)) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Which container the bytes are, read from the magic number. */
export function detectContainer(bytes: Uint8Array): Container {
  if (matchesAt(bytes, 0, PNG_SIG)) return "png";
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWithText(bytes, "RIFF") && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (matchesAt(bytes, 0, [0x49, 0x49, 0x2a, 0x00])) return "tiff";
  if (matchesAt(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  return "unknown";
}

const FORMAT_LABEL: Record<Container, string> = {
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
  tiff: "TIFF",
  unknown: "Unrecognized",
};

function unsupported(bytes: Uint8Array): ToolError {
  const at = (i: number): number => (i < bytes.length ? bytes[i]! : -1);
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    return new ToolError(
      "unsupported-format",
      "That is a HEIC, AVIF, or MP4 style container, which stores its metadata inside an ISO box structure this tool does not walk yet.",
      "Export it as a JPEG or PNG first, or use the Image Toolbox, which reports the basics for more formats.",
    );
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return new ToolError(
      "unsupported-format",
      "That is a GIF, which has no Exif, XMP, or IPTC block to show or remove.",
      "GIF only carries an optional comment extension. Drop a JPEG, PNG, WebP, or TIFF instead.",
    );
  }
  return new ToolError(
    "unsupported-format",
    "That file is not a JPEG, PNG, WebP, or TIFF, so there is no metadata block to read.",
    "Drop a photo straight off a camera or phone. Screenshots and exported copies are often already clean.",
  );
}

/* ------------------------------------------------------------------ */
/* TIFF tag tables                                                     */
/* ------------------------------------------------------------------ */

const IFD_TAGS: Record<number, string> = {
  0x00fe: "NewSubfileType",
  0x0100: "ImageWidth",
  0x0101: "ImageHeight",
  0x0102: "BitsPerSample",
  0x0103: "Compression",
  0x0106: "PhotometricInterpretation",
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0111: "StripOffsets",
  0x0112: "Orientation",
  0x0115: "SamplesPerPixel",
  0x0116: "RowsPerStrip",
  0x0117: "StripByteCounts",
  0x011a: "XResolution",
  0x011b: "YResolution",
  0x011c: "PlanarConfiguration",
  0x0128: "ResolutionUnit",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x013e: "WhitePoint",
  0x013f: "PrimaryChromaticities",
  0x0201: "JPEGInterchangeFormat",
  0x0202: "JPEGInterchangeFormatLength",
  0x0211: "YCbCrCoefficients",
  0x0213: "YCbCrPositioning",
  0x0214: "ReferenceBlackWhite",
  0x8298: "Copyright",
  0x8769: "ExifIFDPointer",
  0x8825: "GPSIFDPointer",
  0x9c9b: "XPTitle",
  0x9c9c: "XPComment",
  0x9c9d: "XPAuthor",
  0x9c9e: "XPKeywords",
  0x9c9f: "XPSubject",
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8822: "ExposureProgram",
  0x8824: "SpectralSensitivity",
  0x8827: "ISOSpeedRatings",
  0x8830: "SensitivityType",
  0x8832: "RecommendedExposureIndex",
  0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal",
  0x9101: "ComponentsConfiguration",
  0x9102: "CompressedBitsPerPixel",
  0x9201: "ShutterSpeedValue",
  0x9202: "ApertureValue",
  0x9203: "BrightnessValue",
  0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue",
  0x9206: "SubjectDistance",
  0x9207: "MeteringMode",
  0x9208: "LightSource",
  0x9209: "Flash",
  0x920a: "FocalLength",
  0x927c: "MakerNote",
  0x9286: "UserComment",
  0x9290: "SubSecTime",
  0x9291: "SubSecTimeOriginal",
  0x9292: "SubSecTimeDigitized",
  0xa000: "FlashpixVersion",
  0xa001: "ColorSpace",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa005: "InteroperabilityIFDPointer",
  0xa20e: "FocalPlaneXResolution",
  0xa20f: "FocalPlaneYResolution",
  0xa210: "FocalPlaneResolutionUnit",
  0xa217: "SensingMethod",
  0xa300: "FileSource",
  0xa301: "SceneType",
  0xa401: "CustomRendered",
  0xa402: "ExposureMode",
  0xa403: "WhiteBalance",
  0xa404: "DigitalZoomRatio",
  0xa405: "FocalLengthIn35mmFilm",
  0xa406: "SceneCaptureType",
  0xa407: "GainControl",
  0xa408: "Contrast",
  0xa409: "Saturation",
  0xa40a: "Sharpness",
  0xa40c: "SubjectDistanceRange",
  0xa420: "ImageUniqueID",
  0xa430: "CameraOwnerName",
  0xa431: "BodySerialNumber",
  0xa432: "LensSpecification",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0xa435: "LensSerialNumber",
};

const GPS_TAGS: Record<number, string> = {
  0x0000: "GPSVersionID",
  0x0001: "GPSLatitudeRef",
  0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef",
  0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude",
  0x0007: "GPSTimeStamp",
  0x0008: "GPSSatellites",
  0x0009: "GPSStatus",
  0x000a: "GPSMeasureMode",
  0x000c: "GPSSpeedRef",
  0x000d: "GPSSpeed",
  0x0010: "GPSImgDirectionRef",
  0x0011: "GPSImgDirection",
  0x0012: "GPSMapDatum",
  0x001d: "GPSDateStamp",
};

const INTEROP_TAGS: Record<number, string> = {
  0x0001: "InteroperabilityIndex",
  0x0002: "InteroperabilityVersion",
};

/** Enumerations worth spelling out, because the bare number means nothing. */
const ENUMS: Record<string, Record<number, string>> = {
  Orientation: {
    1: "normal",
    2: "mirrored horizontally",
    3: "rotated 180 degrees",
    4: "mirrored vertically",
    5: "mirrored horizontally and rotated 270 degrees clockwise",
    6: "rotated 90 degrees clockwise",
    7: "mirrored horizontally and rotated 90 degrees clockwise",
    8: "rotated 270 degrees clockwise",
  },
  ResolutionUnit: { 1: "none", 2: "inches", 3: "centimeters" },
  ExposureProgram: {
    0: "not defined",
    1: "manual",
    2: "normal program",
    3: "aperture priority",
    4: "shutter priority",
    5: "creative program",
    6: "action program",
    7: "portrait mode",
    8: "landscape mode",
  },
  MeteringMode: {
    0: "unknown",
    1: "average",
    2: "center weighted average",
    3: "spot",
    4: "multi spot",
    5: "pattern",
    6: "partial",
    255: "other",
  },
  LightSource: {
    0: "unknown",
    1: "daylight",
    2: "fluorescent",
    3: "tungsten",
    4: "flash",
    9: "fine weather",
    10: "cloudy weather",
    11: "shade",
  },
  ColorSpace: { 1: "sRGB", 2: "Adobe RGB", 0xffff: "uncalibrated" },
  WhiteBalance: { 0: "auto", 1: "manual" },
  ExposureMode: { 0: "auto", 1: "manual", 2: "auto bracket" },
  SceneCaptureType: { 0: "standard", 1: "landscape", 2: "portrait", 3: "night scene" },
  Contrast: { 0: "normal", 1: "soft", 2: "hard" },
  Saturation: { 0: "normal", 1: "low", 2: "high" },
  Sharpness: { 0: "normal", 1: "soft", 2: "hard" },
  SensingMethod: {
    1: "not defined",
    2: "one chip color area",
    3: "two chip color area",
    4: "three chip color area",
    5: "color sequential area",
    7: "trilinear",
    8: "color sequential linear",
  },
  YCbCrPositioning: { 1: "centered", 2: "co-sited" },
  GPSAltitudeRef: { 0: "above sea level", 1: "below sea level" },
  CustomRendered: { 0: "normal", 1: "custom" },
};

/** Tags most people actually want to see, used when "show every tag" is off. */
const COMMON_TAGS = new Set([
  "Make",
  "Model",
  "LensModel",
  "LensMake",
  "Software",
  "Artist",
  "Copyright",
  "ImageDescription",
  "DateTime",
  "DateTimeOriginal",
  "DateTimeDigitized",
  "OffsetTimeOriginal",
  "Orientation",
  "ExposureTime",
  "FNumber",
  "ISOSpeedRatings",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "ExposureProgram",
  "ExposureBiasValue",
  "MeteringMode",
  "Flash",
  "WhiteBalance",
  "ColorSpace",
  "PixelXDimension",
  "PixelYDimension",
  "ImageWidth",
  "ImageHeight",
  "XResolution",
  "YResolution",
  "ResolutionUnit",
  "BodySerialNumber",
  "CameraOwnerName",
  "ImageUniqueID",
  "UserComment",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
  "GPSDateStamp",
  "GPSTimeStamp",
  "GPSMapDatum",
]);

/* ------------------------------------------------------------------ */
/* TIFF walk                                                           */
/* ------------------------------------------------------------------ */

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of the value inside the TIFF block. */
  valueAt: number;
}

interface TiffView {
  bytes: Uint8Array;
  /** Offset of the TIFF header inside `bytes`. Every pointer is relative to it. */
  base: number;
  little: boolean;
}

function readU16(view: TiffView, at: number): number {
  const b = view.bytes;
  return view.little ? b[at]! | (b[at + 1]! << 8) : (b[at]! << 8) | b[at + 1]!;
}

function readU32(view: TiffView, at: number): number {
  const b = view.bytes;
  return view.little
    ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
    : ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function readI32(view: TiffView, at: number): number {
  return readU32(view, at) | 0;
}

function readIfd(view: TiffView, offset: number): { entries: Entry[]; next: number } {
  const at = view.base + offset;
  if (offset <= 0 || at + 2 > view.bytes.length) return { entries: [], next: 0 };
  const count = readU16(view, at);
  const entries: Entry[] = [];
  // A corrupt count would otherwise walk off the end of the file.
  const safeCount = Math.min(count, Math.floor((view.bytes.length - at - 2) / 12));
  for (let i = 0; i < safeCount; i++) {
    const e = at + 2 + i * 12;
    const tag = readU16(view, e);
    const type = readU16(view, e + 2);
    const n = readU32(view, e + 4);
    const size = (TYPE_SIZE[type] ?? 0) * n;
    const valueAt = size <= 4 ? e + 8 : view.base + readU32(view, e + 8);
    entries.push({ tag, type, count: n, valueAt });
  }
  const nextAt = at + 2 + safeCount * 12;
  const next = nextAt + 4 <= view.bytes.length ? readU32(view, nextAt) : 0;
  return { entries, next };
}

function readAsciiValue(view: TiffView, entry: Entry): string {
  let out = "";
  for (let i = 0; i < entry.count; i++) {
    const at = entry.valueAt + i;
    if (at >= view.bytes.length) break;
    const c = view.bytes[at]!;
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out.trim();
}

/** One component of a typed value, as a number. */
function readComponent(view: TiffView, entry: Entry, index: number): number {
  const size = TYPE_SIZE[entry.type] ?? 0;
  const at = entry.valueAt + index * size;
  if (at + size > view.bytes.length) return NaN;
  switch (entry.type) {
    case 1:
    case 7:
      return view.bytes[at]!;
    case 3:
      return readU16(view, at);
    case 4:
      return readU32(view, at);
    case 5: {
      const d = readU32(view, at + 4);
      return d === 0 ? 0 : readU32(view, at) / d;
    }
    case 8:
      return (readU16(view, at) << 16) >> 16;
    case 9:
      return readI32(view, at);
    case 10: {
      const d = readI32(view, at + 4);
      return d === 0 ? 0 : readI32(view, at) / d;
    }
    default:
      return NaN;
  }
}

function numbersOf(view: TiffView, entry: Entry, limit = 8): number[] {
  const out: number[] = [];
  const n = Math.min(entry.count, limit);
  for (let i = 0; i < n; i++) out.push(readComponent(view, entry, i));
  return out;
}

/** A rational printed the way a photographer writes it: 1/250 rather than 0.004. */
function rationalText(view: TiffView, entry: Entry, index: number): string {
  const size = TYPE_SIZE[entry.type] ?? 0;
  const at = entry.valueAt + index * size;
  if (at + size > view.bytes.length) return "";
  const signed = entry.type === 10;
  const n = signed ? readI32(view, at) : readU32(view, at);
  const d = signed ? readI32(view, at + 4) : readU32(view, at + 4);
  if (d === 0) return "0";
  if (d === 1) return String(n);
  const value = n / d;
  if (Math.abs(value) < 1 && n !== 0) return `${n}/${d}`;
  return String(Number(value.toFixed(4)));
}

/** UTF-16LE, which is what the Windows XP* tags store. */
function readUtf16(view: TiffView, entry: Entry): string {
  let out = "";
  for (let i = 0; i + 1 < entry.count; i += 2) {
    const at = entry.valueAt + i;
    if (at + 1 >= view.bytes.length) break;
    const code = view.bytes[at]! | (view.bytes[at + 1]! << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/**
 * Turn one entry into the string the report shows, applying the unit or the
 * enumeration when there is one. Everything else falls back to the raw
 * components, capped so a 40,000 entry maker note does not become the report.
 */
function formatValue(view: TiffView, name: string, entry: Entry): string {
  if (name.startsWith("XP") && entry.type === 1) return readUtf16(view, entry);
  if (entry.type === 2) return readAsciiValue(view, entry);

  if (name === "ExifVersion" || name === "FlashpixVersion" || name === "InteroperabilityVersion") {
    return ascii(view.bytes, entry.valueAt, Math.min(entry.count, 4));
  }
  if (name === "UserComment") {
    // The first eight bytes are a character set marker, not text.
    const encoding = ascii(view.bytes, entry.valueAt, 8).replace(/\0/g, "").trim();
    const body = ascii(view.bytes, entry.valueAt + 8, Math.min(entry.count - 8, 512))
      .replace(/\0+$/, "")
      .trim();
    return body ? (encoding ? `${body} (${encoding})` : body) : "";
  }
  if (name === "MakerNote") {
    return `${entry.count.toLocaleString("en-US")} bytes of vendor specific data`;
  }

  const enumeration = ENUMS[name];
  if (enumeration && entry.count === 1) {
    const raw = readComponent(view, entry, 0);
    const label = enumeration[raw];
    return label ? `${raw} (${label})` : String(raw);
  }

  if (name === "Flash" && entry.count === 1) {
    const raw = readComponent(view, entry, 0);
    const fired = (raw & 1) === 1 ? "fired" : "did not fire";
    return `${raw} (${fired})`;
  }
  if (name === "ExposureTime") return `${rationalText(view, entry, 0)} s`;
  if (name === "FNumber" || name === "MaxApertureValue") {
    return `f/${Number(readComponent(view, entry, 0).toFixed(2))}`;
  }
  if (name === "FocalLength") return `${Number(readComponent(view, entry, 0).toFixed(2))} mm`;
  if (name === "FocalLengthIn35mmFilm") return `${readComponent(view, entry, 0)} mm`;
  if (name === "ExposureBiasValue") {
    const v = readComponent(view, entry, 0);
    return `${v > 0 ? "+" : ""}${Number(v.toFixed(2))} EV`;
  }
  if (name === "GPSTimeStamp" && entry.count === 3) {
    const parts = numbersOf(view, entry, 3).map((v) => String(Math.round(v)).padStart(2, "0"));
    return `${parts[0]}:${parts[1]}:${parts[2]} UTC`;
  }
  if (name === "GPSLatitude" || name === "GPSLongitude") {
    const [d, m, s] = numbersOf(view, entry, 3);
    return `${d ?? 0} degrees ${m ?? 0} minutes ${Number((s ?? 0).toFixed(3))} seconds`;
  }
  if (name === "GPSAltitude") return `${Number(readComponent(view, entry, 0).toFixed(1))} m`;

  if (entry.type === 5 || entry.type === 10) {
    const parts: string[] = [];
    for (let i = 0; i < Math.min(entry.count, 4); i++) parts.push(rationalText(view, entry, i));
    return parts.join(", ");
  }
  if (entry.type === 7) {
    return `${entry.count.toLocaleString("en-US")} bytes of undefined data`;
  }

  const values = numbersOf(view, entry);
  const text = values.map((v) => (Number.isFinite(v) ? String(v) : "?")).join(", ");
  return entry.count > values.length ? `${text}, and ${entry.count - values.length} more` : text;
}

function tableFor(group: string): Record<number, string> {
  if (group === "Exif") return EXIF_TAGS;
  if (group === "GPS") return GPS_TAGS;
  if (group === "Interop") return INTEROP_TAGS;
  return IFD_TAGS;
}

function collectFields(view: TiffView, group: string, entries: Entry[]): MetaField[] {
  const table = tableFor(group);
  const out: MetaField[] = [];
  for (const entry of entries) {
    const name = table[entry.tag] ?? `Tag 0x${entry.tag.toString(16).padStart(4, "0")}`;
    // The pointers are structure, not content: they are followed, not shown.
    if (name.endsWith("IFDPointer")) continue;
    const value = formatValue(view, name, entry);
    if (value === "") continue;
    out.push({ group, name, tag: entry.tag, value });
  }
  return out;
}

interface TiffParse {
  fields: MetaField[];
  gps: GpsFix | null;
  thumbnail: Uint8Array | null;
}

/** Signed decimal degrees from the three rationals plus the N/S or E/W ref. */
function toDecimalDegrees(parts: number[], ref: string): number {
  const [d = 0, m = 0, s = 0] = parts;
  const magnitude = d + m / 60 + s / 3600;
  const negative = ref === "S" || ref === "W";
  return negative ? -magnitude : magnitude;
}

function readGps(view: TiffView, entries: Entry[]): GpsFix | null {
  const find = (tag: number): Entry | undefined => entries.find((e) => e.tag === tag);
  const lat = find(0x0002);
  const lon = find(0x0004);
  if (!lat || !lon || lat.count < 3 || lon.count < 3) return null;

  const latRef = find(0x0001);
  const lonRef = find(0x0003);
  const latitude = toDecimalDegrees(
    numbersOf(view, lat, 3),
    latRef ? readAsciiValue(view, latRef) : "N",
  );
  const longitude = toDecimalDegrees(
    numbersOf(view, lon, 3),
    lonRef ? readAsciiValue(view, lonRef) : "E",
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const altEntry = find(0x0006);
  const altRef = find(0x0005);
  let altitude: number | undefined;
  if (altEntry) {
    const raw = readComponent(view, altEntry, 0);
    if (Number.isFinite(raw)) {
      const below = altRef ? readComponent(view, altRef, 0) === 1 : false;
      altitude = below ? -raw : raw;
    }
  }

  const decimal = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude }),
    decimal,
    mapUrl: `https://www.openstreetmap.org/?mlat=${latitude.toFixed(6)}&mlon=${longitude.toFixed(6)}#map=16/${latitude.toFixed(5)}/${longitude.toFixed(5)}`,
  };
}

/**
 * Walk a TIFF block: IFD0, then the Exif, GPS and Interop sub directories it
 * points at, then IFD1 and the JPEG preview it describes.
 */
export function parseTiff(bytes: Uint8Array, base: number): TiffParse {
  if (base + 8 > bytes.length) {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block ends before its TIFF header is complete.",
      "The file looks truncated. Re-copy it from the camera card or the original source.",
    );
  }
  const mark = (bytes[base]! << 8) | bytes[base + 1]!;
  if (mark !== 0x4949 && mark !== 0x4d4d) {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block does not start with a valid TIFF byte order mark.",
      "The metadata is damaged. Re-copy the original file and try again.",
    );
  }
  const view: TiffView = { bytes, base, little: mark === 0x4949 };
  if (readU16(view, base + 2) !== 42) {
    throw new ToolError(
      "corrupt-exif",
      "The Exif block is missing the TIFF magic number, so its structure cannot be trusted.",
      "The metadata is damaged. Re-copy the original file and try again.",
    );
  }

  const ifd0 = readIfd(view, readU32(view, base + 4));
  const fields = collectFields(view, "IFD0", ifd0.entries);

  const follow = (tag: number, group: string): Entry[] => {
    const pointer = ifd0.entries.find((e) => e.tag === tag);
    if (!pointer) return [];
    const offset = readComponent(view, pointer, 0);
    if (!Number.isFinite(offset) || offset <= 0) return [];
    const dir = readIfd(view, offset);
    fields.push(...collectFields(view, group, dir.entries));
    return dir.entries;
  };

  const exifEntries = follow(0x8769, "Exif");
  const gpsEntries = follow(0x8825, "GPS");

  const interopPointer = exifEntries.find((e) => e.tag === 0xa005);
  if (interopPointer) {
    const offset = readComponent(view, interopPointer, 0);
    if (Number.isFinite(offset) && offset > 0) {
      fields.push(...collectFields(view, "Interop", readIfd(view, offset).entries));
    }
  }

  let thumbnail: Uint8Array | null = null;
  if (ifd0.next > 0) {
    const ifd1 = readIfd(view, ifd0.next);
    fields.push(...collectFields(view, "IFD1", ifd1.entries));
    const at = ifd1.entries.find((e) => e.tag === 0x0201);
    const len = ifd1.entries.find((e) => e.tag === 0x0202);
    if (at && len) {
      const start = base + readComponent(view, at, 0);
      const size = readComponent(view, len, 0);
      if (
        Number.isFinite(start) &&
        Number.isFinite(size) &&
        size > 0 &&
        start + size <= bytes.length
      ) {
        thumbnail = bytes.subarray(start, start + size);
      }
    }
  }

  return { fields, gps: gpsEntries.length > 0 ? readGps(view, gpsEntries) : null, thumbnail };
}

/* ------------------------------------------------------------------ */
/* IPTC                                                                */
/* ------------------------------------------------------------------ */

const IPTC_TAGS: Record<number, string> = {
  5: "Object name",
  10: "Urgency",
  15: "Category",
  20: "Supplemental category",
  25: "Keywords",
  40: "Special instructions",
  55: "Date created",
  60: "Time created",
  62: "Digital creation date",
  65: "Originating program",
  80: "Byline",
  85: "Byline title",
  90: "City",
  92: "Sublocation",
  95: "Province or state",
  100: "Country code",
  101: "Country",
  103: "Original transmission reference",
  105: "Headline",
  110: "Credit",
  115: "Source",
  116: "Copyright notice",
  118: "Contact",
  120: "Caption",
  122: "Caption writer",
};

/**
 * Read the IIM datasets out of a Photoshop APP13 payload. The payload is a
 * chain of 8BIM resources; IPTC lives in the one with id 0x0404.
 */
export function parseIptc(payload: Uint8Array): TextRecord[] {
  const out: TextRecord[] = [];
  let at = 0;
  // Skip the "Photoshop 3.0\0" identifier when it is present.
  const header = ascii(payload, 0, 14);
  if (header.startsWith("Photoshop 3.0")) at = 14;

  while (at + 12 <= payload.length) {
    if (ascii(payload, at, 4) !== "8BIM") break;
    const id = u16be(payload, at + 4);
    const nameLength = payload[at + 6]!;
    // The Pascal name is padded so the whole field takes an even byte count.
    const namePadded = nameLength % 2 === 0 ? nameLength + 2 : nameLength + 1;
    const sizeAt = at + 6 + namePadded;
    if (sizeAt + 4 > payload.length) break;
    const size = u32be(payload, sizeAt);
    const dataAt = sizeAt + 4;
    if (dataAt + size > payload.length) break;

    if (id === 0x0404) {
      let p = dataAt;
      const end = dataAt + size;
      while (p + 5 <= end) {
        if (payload[p] !== 0x1c) break;
        const dataset = payload[p + 2]!;
        const length = u16be(payload, p + 3);
        const valueAt = p + 5;
        if (valueAt + length > end) break;
        const name = IPTC_TAGS[dataset] ?? `IPTC 2:${dataset}`;
        const value = new TextDecoder("utf-8", { fatal: false })
          .decode(payload.subarray(valueAt, valueAt + length))
          .replace(/\0/g, "")
          .trim();
        if (value) out.push({ source: "IPTC", keyword: name, value });
        p = valueAt + length;
      }
    }

    at = dataAt + size + (size % 2);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* XMP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Re-indent an XMP packet so it can be read.
 *
 * Deliberately a string transform rather than a parse. `DOMParser` is a browser
 * global this layer must not touch, an XML parser would be a heavy dependency
 * for a cosmetic job, and re-serializing risks changing a packet the visitor
 * wanted to see exactly as written. This only inserts line breaks and leading
 * spaces between tags, so every character of the original survives.
 */
export function prettyXml(xml: string): string {
  const collapsed = xml.replace(/>\s+</g, "><").trim();
  const parts = collapsed.replace(/></g, ">\n<").split("\n");
  const lines: string[] = [];
  let depth = 0;
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    const isClose = /^<\//.test(line);
    const isSelfClosing = /\/>$/.test(line) || /^<\?/.test(line) || /^<!/.test(line);
    if (isClose) depth = Math.max(0, depth - 1);
    lines.push(`${"  ".repeat(depth)}${line}`);
    // A line that both opens and closes the same element changes nothing.
    const isPaired = /^<[^/!?][^>]*>.*<\/[^>]+>$/.test(line);
    if (!isClose && !isSelfClosing && !isPaired) depth++;
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* container walks                                                     */
/* ------------------------------------------------------------------ */

const JPEG_MARKER_NAMES: Record<number, string> = {
  0xc0: "SOF0 baseline",
  0xc1: "SOF1 extended sequential",
  0xc2: "SOF2 progressive",
  0xc4: "DHT Huffman table",
  0xd8: "SOI start of image",
  0xd9: "EOI end of image",
  0xda: "SOS start of scan",
  0xdb: "DQT quantization table",
  0xdd: "DRI restart interval",
  0xe0: "APP0 JFIF",
  0xe2: "APP2",
  0xee: "APP14 Adobe",
  0xfe: "COM comment",
};

interface JpegWalk {
  segments: SegmentInfo[];
  exifAt: number | null;
  xmp: string | null;
  iptc: TextRecord[];
}

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

function walkJpeg(bytes: Uint8Array): JpegWalk {
  const segments: SegmentInfo[] = [];
  let exifAt: number | null = null;
  let xmp: string | null = null;
  let iptc: TextRecord[] = [];

  segments.push({
    id: "SOI",
    description: "Start of image",
    offset: 0,
    size: 2,
    metadata: false,
  });
  let p = 2;

  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) break;
    const marker = bytes[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      segments.push({
        id: marker === 0xda ? "SOS" : "EOI",
        description: marker === 0xda ? "Start of scan, followed by the image data" : "End of image",
        offset: p,
        size: bytes.length - p,
        metadata: false,
      });
      break;
    }
    if (p + 4 > bytes.length) break;
    const length = u16be(bytes, p + 2);
    const end = p + 2 + length;
    if (length < 2 || end > bytes.length) break;

    const payload = bytes.subarray(p + 4, end);
    let id = `0x${marker.toString(16)}`;
    let description = JPEG_MARKER_NAMES[marker] ?? "Unknown marker";
    let metadata = false;

    if (marker === 0xe1) {
      id = "APP1";
      if (startsWithText(payload, "Exif\0\0")) {
        description = "Exif metadata";
        metadata = true;
        exifAt = p + 4 + 6;
      } else if (startsWithText(payload, XMP_HEADER)) {
        description = "XMP metadata";
        metadata = true;
        xmp = new TextDecoder("utf-8", { fatal: false }).decode(
          payload.subarray(XMP_HEADER.length),
        );
      } else {
        description = "APP1 metadata";
        metadata = true;
      }
    } else if (marker === 0xed) {
      id = "APP13";
      description = "Photoshop resources, which carry IPTC";
      metadata = true;
      iptc = parseIptc(payload);
    } else if (marker === 0xfe) {
      id = "COM";
      description = "Comment";
      metadata = true;
    } else if (marker === 0xe2) {
      id = "APP2";
      if (startsWithText(payload, "ICC_PROFILE\0")) {
        description = "ICC color profile, kept when stripping";
      } else {
        description = "APP2 metadata";
        metadata = true;
      }
    } else if (marker >= 0xe0 && marker <= 0xef) {
      id = `APP${marker - 0xe0}`;
      description = JPEG_MARKER_NAMES[marker] ?? `Application segment ${marker - 0xe0}`;
    } else {
      id = JPEG_MARKER_NAMES[marker]?.split(" ")[0] ?? id;
    }

    segments.push({ id, description, offset: p, size: end - p, metadata });
    p = end;
  }

  return { segments, exifAt, xmp, iptc };
}

const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

const PNG_CHUNK_DESCRIPTIONS: Record<string, string> = {
  IHDR: "Image header",
  PLTE: "Palette",
  IDAT: "Image data",
  IEND: "End of file",
  iCCP: "ICC color profile, kept when stripping",
  sRGB: "sRGB rendering intent",
  gAMA: "Gamma",
  pHYs: "Physical pixel size",
  tRNS: "Transparency",
  acTL: "Animation control",
  fcTL: "Frame control",
  fdAT: "Frame data",
  tIME: "Last modification time",
  eXIf: "Exif metadata",
  tEXt: "Latin-1 text",
  zTXt: "Compressed text",
  iTXt: "International text",
};

interface PngWalk {
  segments: SegmentInfo[];
  exif: Uint8Array | null;
  text: TextRecord[];
  xmp: string | null;
}

/** A tEXt chunk: keyword, NUL, Latin-1 text. */
function readTextChunk(payload: Uint8Array): TextRecord | null {
  const split = payload.indexOf(0);
  if (split < 0) return null;
  const keyword = ascii(payload, 0, split);
  const value = new TextDecoder("latin1").decode(payload.subarray(split + 1)).trim();
  return value ? { source: "PNG tEXt", keyword, value } : null;
}

/**
 * An iTXt chunk: keyword, NUL, compression flag, compression method, language
 * tag, NUL, translated keyword, NUL, UTF-8 text. A compressed one is reported
 * rather than inflated: this layer has no deflate, and the point of listing it
 * is that it exists and will be removed.
 */
function readIntlTextChunk(payload: Uint8Array): TextRecord | null {
  const keywordEnd = payload.indexOf(0);
  if (keywordEnd < 0 || keywordEnd + 2 >= payload.length) return null;
  const keyword = ascii(payload, 0, keywordEnd);
  const compressed = payload[keywordEnd + 1] === 1;
  const languageEnd = payload.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) return null;
  const translatedEnd = payload.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return null;
  if (compressed) {
    return {
      source: "PNG iTXt",
      keyword,
      value: `${payload.length - translatedEnd - 1} bytes of compressed text`,
    };
  }
  const value = new TextDecoder("utf-8", { fatal: false })
    .decode(payload.subarray(translatedEnd + 1))
    .trim();
  return value ? { source: "PNG iTXt", keyword, value } : null;
}

function walkPng(bytes: Uint8Array): PngWalk {
  const segments: SegmentInfo[] = [];
  const text: TextRecord[] = [];
  let exif: Uint8Array | null = null;
  let xmp: string | null = null;
  let p = 8;

  while (p + 12 <= bytes.length) {
    const length = u32be(bytes, p);
    const type = ascii(bytes, p + 4, 4);
    const end = p + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) break;
    const payload = bytes.subarray(p + 8, p + 8 + length);

    segments.push({
      id: type,
      description: PNG_CHUNK_DESCRIPTIONS[type] ?? "Ancillary chunk",
      offset: p,
      size: 12 + length,
      metadata: PNG_METADATA_CHUNKS.has(type),
    });

    if (type === "eXIf") exif = payload;
    else if (type === "tEXt") {
      const record = readTextChunk(payload);
      if (record) text.push(record);
    } else if (type === "zTXt") {
      const split = payload.indexOf(0);
      if (split >= 0) {
        text.push({
          source: "PNG zTXt",
          keyword: ascii(payload, 0, split),
          value: `${Math.max(0, payload.length - split - 2)} bytes of compressed text`,
        });
      }
    } else if (type === "iTXt") {
      const record = readIntlTextChunk(payload);
      if (record) {
        text.push(record);
        if (record.keyword === "XML:com.adobe.xmp") xmp = record.value;
      }
    }

    p = end;
    if (type === "IEND") break;
  }

  return { segments, exif, text, xmp };
}

interface WebpWalk {
  segments: SegmentInfo[];
  exif: Uint8Array | null;
  xmp: string | null;
}

const WEBP_CHUNK_DESCRIPTIONS: Record<string, string> = {
  VP8X: "Extended file header with the feature flags",
  "VP8 ": "Lossy image data",
  VP8L: "Lossless image data",
  ALPH: "Alpha channel",
  ANIM: "Animation parameters",
  ANMF: "Animation frame",
  ICCP: "ICC color profile, kept when stripping",
  EXIF: "Exif metadata",
  XMP: "XMP metadata",
};

function walkWebp(bytes: Uint8Array): WebpWalk {
  const segments: SegmentInfo[] = [];
  let exif: Uint8Array | null = null;
  let xmp: string | null = null;
  let p = 12;

  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    const size = u32le(bytes, p + 4);
    const dataAt = p + 8;
    if (size > bytes.length || dataAt + size > bytes.length) break;
    const payload = bytes.subarray(dataAt, dataAt + size);
    const trimmed = id.trim();

    segments.push({
      id: trimmed || id,
      description: WEBP_CHUNK_DESCRIPTIONS[id] ?? WEBP_CHUNK_DESCRIPTIONS[trimmed] ?? "RIFF chunk",
      offset: p,
      // RIFF pads every chunk to an even length.
      size: 8 + size + (size % 2),
      metadata: trimmed === "EXIF" || trimmed === "XMP",
    });

    if (trimmed === "EXIF") {
      // Some writers prefix the payload with the JPEG style "Exif\0\0" header.
      exif = startsWithText(payload, "Exif\0\0") ? payload.subarray(6) : payload;
    } else if (trimmed === "XMP") {
      xmp = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    }

    p = dataAt + size + (size % 2);
  }

  return { segments, exif, xmp };
}

/* ------------------------------------------------------------------ */
/* the reader                                                          */
/* ------------------------------------------------------------------ */

/** Read every metadata block the file carries. Never modifies the input. */
export function readMetadata(bytes: Uint8Array): ExifReport {
  if (!bytes || bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "No file loaded yet.",
      "Drop a JPEG, PNG, WebP, or TIFF onto the panel above, or pick one with the file button.",
    );
  }
  const container = detectContainer(bytes);
  if (container === "unknown") throw unsupported(bytes);

  let segments: SegmentInfo[];
  let text: TextRecord[] = [];
  let xmp: string | null = null;
  let tiff: TiffParse = { fields: [], gps: null, thumbnail: null };

  if (container === "jpeg") {
    const walk = walkJpeg(bytes);
    segments = walk.segments;
    xmp = walk.xmp;
    text = walk.iptc;
    if (walk.exifAt !== null) tiff = parseTiff(bytes, walk.exifAt);
  } else if (container === "png") {
    const walk = walkPng(bytes);
    segments = walk.segments;
    text = walk.text;
    xmp = walk.xmp;
    if (walk.exif) tiff = parseTiff(walk.exif, 0);
  } else if (container === "webp") {
    const walk = walkWebp(bytes);
    segments = walk.segments;
    xmp = walk.xmp;
    if (walk.exif) tiff = parseTiff(walk.exif, 0);
  } else {
    tiff = parseTiff(bytes, 0);
    segments = [
      {
        id: "TIFF",
        description: "The whole file is one TIFF block",
        offset: 0,
        size: bytes.length,
        metadata: false,
      },
    ];
  }

  return {
    container,
    formatLabel: FORMAT_LABEL[container],
    byteLength: bytes.length,
    fields: tiff.fields,
    segments,
    text,
    gps: tiff.gps,
    xmp,
    thumbnail: tiff.thumbnail,
    empty: tiff.fields.length === 0 && text.length === 0 && xmp === null,
  };
}

/** The fields worth showing at a glance, in a stable reading order. */
export function commonFields(fields: readonly MetaField[]): MetaField[] {
  return fields.filter((f) => COMMON_TAGS.has(f.name));
}

/* ------------------------------------------------------------------ */
/* the stripper                                                        */
/* ------------------------------------------------------------------ */

function stripJpeg(bytes: Uint8Array): StripResult {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed: string[] = [];
  const kept: string[] = [];
  let p = 2;

  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) break;
    const marker = bytes[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(p, p + 2));
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    if (p + 4 > bytes.length) break;
    const length = u16be(bytes, p + 2);
    const end = p + 2 + length;
    if (length < 2 || end > bytes.length) break;

    const payload = bytes.subarray(p + 4, end);
    let drop: string | null = null;

    if (marker === 0xe1) {
      if (startsWithText(payload, "Exif\0\0")) drop = "APP1 Exif";
      else if (startsWithText(payload, XMP_HEADER)) drop = "APP1 XMP";
      else drop = "APP1 metadata";
    } else if (marker === 0xed) {
      drop = "APP13 Photoshop and IPTC";
    } else if (marker === 0xfe) {
      drop = "COM comment";
    } else if (marker === 0xe2) {
      if (startsWithText(payload, "ICC_PROFILE\0")) kept.push("APP2 ICC color profile");
      else drop = "APP2 metadata";
    } else if (marker === 0xee) {
      kept.push("APP14 Adobe color transform marker");
    }

    if (drop) removed.push(`${drop} (${formatBytes(end - p)})`);
    else parts.push(bytes.subarray(p, end));
    p = end;
  }

  if (p < bytes.length) parts.push(bytes.subarray(p));
  const out = concat(parts);
  return { bytes: out, removed, kept, bytesSaved: bytes.length - out.length };
}

function stripPng(bytes: Uint8Array): StripResult {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed: string[] = [];
  const kept: string[] = [];
  let p = 8;

  while (p + 12 <= bytes.length) {
    const length = u32be(bytes, p);
    const type = ascii(bytes, p + 4, 4);
    const end = p + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) break;
    if (PNG_METADATA_CHUNKS.has(type)) {
      removed.push(`${type} chunk (${formatBytes(12 + length)})`);
    } else {
      if (type === "iCCP") kept.push("iCCP color profile");
      parts.push(bytes.subarray(p, end));
    }
    p = end;
    if (type === "IEND") break;
  }

  if (p < bytes.length) parts.push(bytes.subarray(p));
  const out = concat(parts);
  return { bytes: out, removed, kept, bytesSaved: bytes.length - out.length };
}

/** VP8X flag bits for the two blocks this tool removes. */
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(bytes: Uint8Array): StripResult {
  const chunks: Uint8Array[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  let p = 12;

  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4).trim();
    const size = u32le(bytes, p + 4);
    const dataAt = p + 8;
    if (size > bytes.length || dataAt + size > bytes.length) break;
    const padded = 8 + size + (size % 2);

    if (id === "EXIF" || id === "XMP") {
      removed.push(`${id} chunk (${formatBytes(padded)})`);
    } else {
      if (id === "ICCP") kept.push("ICCP color profile");
      const chunk = bytes.slice(p, p + padded);
      if (id === "VP8X" && chunk.length >= 9) {
        // The flag byte still advertises blocks that are no longer there, and a
        // decoder that trusts it goes looking for a chunk that does not exist.
        chunk[8] = chunk[8]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      }
      chunks.push(chunk);
    }
    p = dataAt + size + (size % 2);
  }

  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12), 0);
  out.set(body, 12);
  // The RIFF size counts everything after the size field itself.
  const riffSize = 4 + body.length;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;

  return { bytes: out, removed, kept, bytesSaved: bytes.length - out.length };
}

/**
 * Write a copy of the file with its metadata blocks removed. Pixels are copied
 * byte for byte, so nothing is recompressed and the result is visually
 * identical.
 */
export function stripMetadata(bytes: Uint8Array): StripResult {
  const container = detectContainer(bytes);
  if (container === "jpeg") return stripJpeg(bytes);
  if (container === "png") return stripPng(bytes);
  if (container === "webp") return stripWebp(bytes);
  if (container === "tiff") {
    throw new ToolError(
      "strip-unsupported",
      "A bare TIFF is metadata all the way down: its directories also point at the image data, so removing them would remove the picture.",
      "Convert it to a JPEG or PNG first, then strip that copy.",
    );
  }
  throw unsupported(bytes);
}

/** A filename for the cleaned copy: "photo.jpg" becomes "photo-clean.jpg". */
export function cleanFilename(name: string): string {
  const trimmed = name.trim() || "image";
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return `${trimmed}-clean`;
  return `${trimmed.slice(0, dot)}-clean${trimmed.slice(dot)}`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function decodeBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text
    .replace(/^data:[^,]*,/, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  const notBase64 = new ToolError(
    "not-base64",
    "That text is not an image. A photo is binary, so pasted text only works when it is base64 or a data URL.",
    "Drop the file itself onto the panel above, or paste its base64 or data URL form.",
  );
  if (!clean) throw notBase64;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = alphabet.indexOf(clean[i]!);
    if (value < 0) throw notBase64;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

export function run(input: Uint8Array | string, opts: ExifViewerOpts = {}): Record<string, string> {
  const bytes = typeof input === "string" ? decodeBase64(input) : input;
  const report = readMetadata(bytes);
  const showAll = truthy(opts.showAll);

  const out: Record<string, string> = {
    Format: report.formatLabel,
    "File size": formatBytes(report.byteLength),
  };

  if (report.empty) {
    out["Metadata"] = "None. This file carries no Exif, XMP, IPTC, or text metadata.";
  }

  const fields = showAll ? report.fields : commonFields(report.fields);
  for (const field of fields) out[`${field.group} ${field.name}`] = field.value;
  if (!showAll && report.fields.length > fields.length) {
    out["Hidden tags"] =
      `${report.fields.length - fields.length} more tags are present. Turn on "Show every tag" to list them.`;
  }

  if (report.gps) {
    out["GPS coordinates"] = report.gps.decimal;
    if (report.gps.altitude !== undefined) {
      out["GPS altitude"] = `${report.gps.altitude.toFixed(1)} m`;
    }
    out["GPS map link"] = report.gps.mapUrl;
  }

  for (const record of report.text) out[`${record.source} ${record.keyword}`] = record.value;

  if (report.thumbnail) {
    out["Embedded thumbnail"] =
      `${formatBytes(report.thumbnail.length)} JPEG preview stored in IFD1. The panel above shows it.`;
  }
  if (report.xmp) out["XMP packet"] = prettyXml(report.xmp);

  const metadataSegments = report.segments.filter((s) => s.metadata);
  out["Segments"] = report.segments.map((s) => `${s.id} (${formatBytes(s.size)})`).join(", ");
  if (metadataSegments.length > 0) {
    out["Metadata segments"] = metadataSegments.map((s) => `${s.id}: ${s.description}`).join("; ");
  }

  if (truthy(opts.strip)) {
    const stripped = stripMetadata(bytes);
    out["Stripped"] =
      stripped.removed.length > 0
        ? `${stripped.removed.join(", ")}. Saved ${formatBytes(stripped.bytesSaved)}.`
        : "Nothing to remove: this file was already clean.";
    if (stripped.kept.length > 0) out["Kept on purpose"] = stripped.kept.join(", ");
    out["Saving the cleaned copy"] =
      "No pixel is recompressed, so the cleaned copy is identical to look at. Use the download button in the panel above to save it.";
  }

  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  ExifViewerOpts
>;
