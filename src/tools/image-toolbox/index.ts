import exifr from "exifr";
import { formatByteCount, formatBytes as formatByteSize } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

export interface ImageToolboxOpts {
  /** Remove EXIF, XMP, IPTC, and comment metadata without touching pixels. */
  stripExif?: boolean;
  [key: string]: unknown;
}

export type ImageToolboxResult = Record<string, string>;

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function i32le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && o + i < b.length; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

function startsWithAscii(b: Uint8Array, text: string): boolean {
  if (b.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[i] !== text.charCodeAt(i)) return false;
  return true;
}

function matchesAt(b: Uint8Array, offset: number, sig: number[]): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

/** Every header read goes through this so a truncated file never throws a RangeError. */
function need(b: Uint8Array, offset: number, len: number, what: string): void {
  if (offset + len > b.length) {
    throw new ToolError(
      "truncated-image",
      `The file ends before its ${what} could be read, so it is incomplete or corrupt.`,
      "Re-export or re-download the image, then try again.",
    );
  }
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Pure base64 (no btoa, no Buffer), so the same code runs in Node and the browser. */
function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      "=";
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** "1,234 bytes (1.21 KB)". */
function humanSize(n: number): string {
  if (n < 1024) return formatByteCount(n);
  const size = formatByteSize(n, { maxUnit: "GB", precision: 2, largePrecision: 1 });
  return `${formatByteCount(n)} (${size})`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function aspectRatio(w: number, h: number): string {
  const decimal = (w / h).toFixed(2);
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  if (rw <= 99 && rh <= 99) return `${rw}:${rh} (${decimal})`;
  return `${decimal}:1`;
}

/* ------------------------------------------------------------------ */
/* format detection and header parsing                                 */
/* ------------------------------------------------------------------ */

type Strippable = "jpeg" | "png" | null;

interface Detected {
  format: string;
  width?: number;
  height?: number;
  /** Replaces the "W x H px" row for formats without fixed pixels. */
  dimensionsLabel?: string;
  colorInfo?: string;
  interlace?: string;
  frames?: number;
  extra?: Record<string, string>;
  strippable: Strippable;
  /** MIME used for the cleaned data URL. */
  mime?: string;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_COLOR_TYPES: Record<number, string> = {
  0: "Grayscale",
  2: "Truecolor (RGB)",
  3: "Indexed color (palette)",
  4: "Grayscale with alpha",
  6: "Truecolor with alpha (RGBA)",
};

function parsePng(b: Uint8Array): Detected {
  need(b, 8, 25, "IHDR header");
  if (ascii(b, 12, 4) !== "IHDR") {
    throw new ToolError(
      "unsupported-format",
      "This file starts with a PNG signature but its first chunk is not IHDR, so the header is corrupt.",
      "Re-export the image as a valid PNG and try again.",
    );
  }
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const bitDepth = b[24]!;
  const colorType = b[25]!;
  const interlace = b[28]!;
  const colorName = PNG_COLOR_TYPES[colorType] ?? `Color type ${colorType}`;
  return {
    format: "PNG",
    width,
    height,
    colorInfo: `${bitDepth} bits per channel, ${colorName}`,
    interlace: interlace === 1 ? "Adam7 interlaced" : "None (progressive scan not used)",
    strippable: "png",
    mime: "image/png",
  };
}

const JPEG_SOF_NAMES: Record<number, string> = {
  0xc0: "Baseline DCT",
  0xc1: "Extended sequential DCT",
  0xc2: "Progressive DCT",
  0xc3: "Lossless",
  0xc5: "Differential sequential DCT",
  0xc6: "Differential progressive DCT",
  0xc7: "Differential lossless",
  0xc9: "Arithmetic extended sequential DCT",
  0xca: "Arithmetic progressive DCT",
  0xcb: "Arithmetic lossless",
  0xcd: "Differential arithmetic sequential DCT",
  0xce: "Differential arithmetic progressive DCT",
  0xcf: "Differential arithmetic lossless",
};

const JPEG_PROGRESSIVE = new Set([0xc2, 0xc6, 0xca, 0xce]);

function jpegComponentName(count: number): string {
  if (count === 1) return "Grayscale";
  if (count === 3) return "YCbCr color";
  if (count === 4) return "CMYK or YCCK";
  return `${count} components`;
}

function parseJpeg(b: Uint8Array): Detected {
  let p = 2;
  let found: { marker: number; precision: number; w: number; h: number; comps: number } | undefined;

  while (p + 1 < b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    let marker = b[p + 1]!;
    // Fill bytes: any number of 0xFF may precede the marker code.
    while (marker === 0xff && p + 2 < b.length) {
      p++;
      marker = b[p + 1]!;
    }
    p += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (p + 2 > b.length) break;
    const len = u16be(b, p);
    if (len < 2) break;
    if (JPEG_SOF_NAMES[marker] !== undefined) {
      need(b, p, 8, "frame header");
      found = {
        marker,
        precision: b[p + 2]!,
        h: u16be(b, p + 3),
        w: u16be(b, p + 5),
        comps: b[p + 7]!,
      };
      break;
    }
    p += len;
  }

  if (!found) {
    throw new ToolError(
      "truncated-image",
      "This JPEG has no frame header, so its dimensions cannot be read. The file is truncated or corrupt.",
      "Re-export or re-download the image, then try again.",
    );
  }

  return {
    format: "JPEG",
    width: found.w,
    height: found.h,
    colorInfo: `${found.precision} bits per channel, ${jpegComponentName(found.comps)}`,
    interlace: JPEG_PROGRESSIVE.has(found.marker)
      ? `Progressive (${JPEG_SOF_NAMES[found.marker]})`
      : `Baseline (${JPEG_SOF_NAMES[found.marker]})`,
    strippable: "jpeg",
    mime: "image/jpeg",
  };
}

/** Skip a GIF sub-block chain. Always advances, so the caller cannot loop forever. */
function skipGifSubBlocks(b: Uint8Array, start: number): number {
  let p = start;
  while (p < b.length) {
    const size = b[p]!;
    p++;
    if (size === 0) break;
    p += size;
  }
  return p;
}

function parseGif(b: Uint8Array): Detected {
  need(b, 0, 13, "logical screen descriptor");
  const version = ascii(b, 0, 6);
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const packed = b[10]!;
  const hasGct = (packed & 0x80) !== 0;
  const colorRes = ((packed >> 4) & 0x07) + 1;
  const gctEntries = hasGct ? 2 ** ((packed & 0x07) + 1) : 0;

  let p = 13 + (hasGct ? gctEntries * 3 : 0);
  let frames = 0;
  let firstInterlaced: boolean | undefined;

  while (p < b.length) {
    const block = b[p]!;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      // extension: introducer + label, then sub-blocks
      if (p + 2 > b.length) break;
      p = skipGifSubBlocks(b, p + 2);
      continue;
    }
    if (block === 0x2c) {
      if (p + 10 > b.length) break;
      frames++;
      const localPacked = b[p + 9]!;
      if (firstInterlaced === undefined) firstInterlaced = (localPacked & 0x40) !== 0;
      let q = p + 10;
      if (localPacked & 0x80) q += 3 * 2 ** ((localPacked & 0x07) + 1);
      q += 1; // LZW minimum code size
      p = skipGifSubBlocks(b, q);
      continue;
    }
    break; // unrecognized block, stop rather than guess
  }

  const extra: Record<string, string> = {};
  if (hasGct) extra["Palette"] = `Global color table, ${gctEntries} colors`;
  else extra["Palette"] = "No global color table";

  return {
    format: `GIF (${version})`,
    width,
    height,
    colorInfo: `${colorRes} bits per channel source, ${gctEntries || "no"} color global palette`,
    interlace: firstInterlaced ? "Interlaced" : "None",
    frames: frames || undefined,
    extra,
    strippable: null,
  };
}

interface RiffChunk {
  id: string;
  start: number;
  size: number;
}

function readRiffChunks(b: Uint8Array): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let p = 12;
  while (p + 8 <= b.length && chunks.length < 64) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (size > b.length) break;
    chunks.push({ id, start: p + 8, size });
    p += 8 + size + (size % 2);
  }
  return chunks;
}

function parseWebp(b: Uint8Array): Detected {
  need(b, 0, 16, "WebP container header");
  const chunks = readRiffChunks(b);
  const first = chunks[0];
  if (!first) {
    throw new ToolError(
      "truncated-image",
      "This WebP file has no image chunk, so it is incomplete or corrupt.",
      "Re-export or re-download the image, then try again.",
    );
  }

  if (first.id === "VP8L") {
    // 0x2f signature, then 14 bits width-1, 14 bits height-1, 1 bit alpha, 3 bits version.
    need(b, first.start, 5, "VP8L header");
    if (b[first.start] !== 0x2f) {
      throw new ToolError(
        "unsupported-format",
        "This WebP file declares a lossless image but its VP8L signature byte is wrong, so the header is corrupt.",
        "Re-export the image and try again.",
      );
    }
    const bits = u32le(b, first.start + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    const hasAlpha = ((bits >>> 28) & 1) === 1;
    return {
      format: "WebP (lossless VP8L)",
      width,
      height,
      colorInfo: `8 bits per channel, lossless${hasAlpha ? " with alpha" : ""}`,
      strippable: null,
    };
  }

  if (first.id === "VP8 ") {
    // Key frame: 3 byte frame tag, 3 byte start code, then 14 bit width and height.
    need(b, first.start, 10, "VP8 key frame header");
    if (!matchesAt(b, first.start + 3, [0x9d, 0x01, 0x2a])) {
      throw new ToolError(
        "unsupported-format",
        "This WebP file has a VP8 chunk without a key frame start code, so the header cannot be read.",
        "Re-export the image and try again.",
      );
    }
    const width = u16le(b, first.start + 6) & 0x3fff;
    const height = u16le(b, first.start + 8) & 0x3fff;
    return {
      format: "WebP (lossy VP8)",
      width,
      height,
      colorInfo: "8 bits per channel, lossy YCbCr",
      strippable: null,
    };
  }

  if (first.id === "VP8X") {
    need(b, first.start, 10, "VP8X header");
    const flags = b[first.start]!;
    const width = u24le(b, first.start + 4) + 1;
    const height = u24le(b, first.start + 7) + 1;
    const featureList: string[] = [];
    if (flags & 0x20) featureList.push("ICC profile");
    if (flags & 0x10) featureList.push("alpha");
    if (flags & 0x08) featureList.push("EXIF");
    if (flags & 0x04) featureList.push("XMP");
    if (flags & 0x02) featureList.push("animation");
    const animFrames = chunks.filter((c) => c.id === "ANMF").length;
    const extra: Record<string, string> = {};
    if (featureList.length) extra["Features"] = featureList.join(", ");
    return {
      format: "WebP (extended VP8X)",
      width,
      height,
      colorInfo: `8 bits per channel${flags & 0x10 ? " with alpha" : ""}`,
      frames: animFrames || undefined,
      extra,
      strippable: null,
    };
  }

  throw new ToolError(
    "unsupported-format",
    `This RIFF/WebP file starts with an unknown "${first.id.trim()}" chunk instead of VP8, VP8L, or VP8X.`,
    "Re-export the image as a standard WebP and try again.",
  );
}

const BMP_COMPRESSION: Record<number, string> = {
  0: "uncompressed (BI_RGB)",
  1: "RLE 8 bit",
  2: "RLE 4 bit",
  3: "bit fields",
  4: "embedded JPEG",
  5: "embedded PNG",
  6: "alpha bit fields",
};

function parseBmp(b: Uint8Array): Detected {
  need(b, 14, 4, "DIB header size");
  const dibSize = u32le(b, 14);

  if (dibSize === 12) {
    need(b, 18, 6, "BITMAPCOREHEADER");
    return {
      format: "BMP (BITMAPCOREHEADER)",
      width: u16le(b, 18),
      height: u16le(b, 20),
      colorInfo: `${u16le(b, 22)} bits per pixel`,
      strippable: null,
    };
  }

  if (dibSize >= 40) {
    need(b, 18, 16, "DIB header");
    const width = Math.abs(i32le(b, 18));
    const rawHeight = i32le(b, 22);
    const bitCount = u16le(b, 28);
    const compression = u32le(b, 30);
    const names: Record<number, string> = {
      40: "BITMAPINFOHEADER",
      52: "BITMAPV2INFOHEADER",
      56: "BITMAPV3INFOHEADER",
      108: "BITMAPV4HEADER",
      124: "BITMAPV5HEADER",
    };
    const extra: Record<string, string> = {
      "Row order": rawHeight < 0 ? "Top down" : "Bottom up",
    };
    return {
      format: `BMP (${names[dibSize] ?? `${dibSize} byte DIB header`})`,
      width,
      height: Math.abs(rawHeight),
      colorInfo: `${bitCount} bits per pixel, ${BMP_COMPRESSION[compression] ?? `compression ${compression}`}`,
      extra,
      strippable: null,
    };
  }

  throw new ToolError(
    "unsupported-format",
    `This BMP file declares a ${dibSize} byte DIB header, which is not a format this tool can read.`,
    "Re-export the image as a standard BMP, PNG, or JPEG and try again.",
  );
}

function parseIco(b: Uint8Array): Detected {
  need(b, 0, 6, "icon directory");
  const isCursor = b[2] === 0x02;
  const count = u16le(b, 4);
  if (count === 0) {
    throw new ToolError(
      "unsupported-format",
      "This icon file declares zero images, so there is nothing to inspect.",
      "Re-export the icon with at least one size and try again.",
    );
  }
  need(b, 6, count * 16, "icon directory entries");

  const sizes: string[] = [];
  let best = { w: 0, h: 0, bits: 0 };
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = b[o]! === 0 ? 256 : b[o]!;
    const h = b[o + 1]! === 0 ? 256 : b[o + 1]!;
    const bits = u16le(b, o + 6);
    sizes.push(`${w} x ${h}`);
    if (w * h > best.w * best.h) best = { w, h, bits };
  }

  return {
    format: isCursor ? "CUR (Windows cursor)" : "ICO (Windows icon)",
    width: best.w,
    height: best.h,
    colorInfo: best.bits ? `${best.bits} bits per pixel (largest image)` : undefined,
    extra: {
      Images: String(count),
      "Icon sizes": sizes.join(", "),
    },
    strippable: null,
  };
}

const SVG_LENGTH = /^\s*([\d.]+)\s*([a-z%]*)\s*$/i;

function parseSvg(text: string): Detected {
  const head = text.slice(0, 4000);
  const openTag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
  const attr = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(openTag)?.[1];

  const extra: Record<string, string> = {};
  const w = attr("width");
  const h = attr("height");
  if (w && h) {
    const wm = SVG_LENGTH.exec(w);
    const hm = SVG_LENGTH.exec(h);
    extra["Declared size"] =
      wm && hm ? `${wm[1]}${wm[2] || "px"} x ${hm[1]}${hm[2] || "px"}` : `${w} x ${h}`;
  }
  const viewBox = attr("viewBox");
  if (viewBox) extra["viewBox"] = viewBox.trim();

  return {
    format: "SVG (vector)",
    dimensionsLabel: "Scalable vector, no fixed pixel size",
    extra,
    strippable: null,
  };
}

/** Cheap best-effort UTF-8 decode used only for SVG sniffing and error messages. */
function tryDecodeText(b: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 8192));
  } catch {
    return undefined;
  }
}

function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 4000).trimStart();
  if (/^<svg\b/i.test(head)) return true;
  if (/^<\?xml/i.test(head) || /^<!doctype\s+svg/i.test(head)) return /<svg\b/i.test(head);
  return false;
}

/** Name a few common non-image signatures so the error can say what was actually dropped. */
function guessNonImage(b: Uint8Array): string | undefined {
  if (startsWithAscii(b, "%PDF")) return "a PDF document";
  if (matchesAt(b, 0, [0x50, 0x4b, 0x03, 0x04])) return "a ZIP based file (zip, docx, xlsx)";
  if (matchesAt(b, 0, [0x1f, 0x8b])) return "a gzip archive";
  if (matchesAt(b, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = ascii(b, 8, 4).trim();
    if (brand.startsWith("heic") || brand.startsWith("heif") || brand.startsWith("mif1"))
      return "a HEIC/HEIF image";
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "an AVIF image";
    return `an ISO media file (brand ${brand})`;
  }
  if (matchesAt(b, 0, [0x49, 0x49, 0x2a, 0x00]) || matchesAt(b, 0, [0x4d, 0x4d, 0x00, 0x2a]))
    return "a TIFF image";
  return undefined;
}

const SUPPORTED_LIST = "PNG, JPEG, GIF, WebP, BMP, ICO, and SVG";

function detect(b: Uint8Array): Detected {
  if (matchesAt(b, 0, PNG_SIG)) return parsePng(b);
  if (matchesAt(b, 0, [0xff, 0xd8, 0xff])) return parseJpeg(b);
  if (startsWithAscii(b, "GIF87a") || startsWithAscii(b, "GIF89a")) return parseGif(b);
  if (startsWithAscii(b, "RIFF") && ascii(b, 8, 4) === "WEBP") return parseWebp(b);
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return parseBmp(b);
  if (matchesAt(b, 0, [0x00, 0x00, 0x01, 0x00]) || matchesAt(b, 0, [0x00, 0x00, 0x02, 0x00]))
    return parseIco(b);

  const text = tryDecodeText(b);
  if (text && looksLikeSvg(text)) return parseSvg(text);

  const guess = guessNonImage(b);
  if (guess) {
    throw new ToolError(
      "unsupported-format",
      `This looks like ${guess}, which this tool cannot inspect.`,
      `Supported formats are ${SUPPORTED_LIST}.`,
    );
  }
  if (text !== undefined) {
    throw new ToolError(
      "unsupported-format",
      "These bytes decode as plain text, not as an image.",
      `Drop an image file instead. Supported formats are ${SUPPORTED_LIST}.`,
    );
  }
  const hex = [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
  throw new ToolError(
    "unsupported-format",
    `No known image signature was found. The file starts with the bytes ${hex}.`,
    `Supported formats are ${SUPPORTED_LIST}.`,
  );
}

/* ------------------------------------------------------------------ */
/* metadata stripping (no re-encoding, pixels untouched)               */
/* ------------------------------------------------------------------ */

interface StripDetail {
  bytes: Uint8Array;
  removed: string[];
  kept: string[];
}

const JPEG_APP1 = 0xe1;
const JPEG_APP2 = 0xe2;
const JPEG_APP13 = 0xed;
const JPEG_COM = 0xfe;

function stripJpegDetail(b: Uint8Array): StripDetail {
  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  parts.push(b.subarray(0, 2));
  let p = 2;

  while (p + 1 < b.length) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(p, p + 2));
      p += 2;
      continue;
    }
    // Start of scan or end of image: everything after is entropy coded data.
    if (marker === 0xda || marker === 0xd9) break;
    if (p + 4 > b.length) break;
    const len = u16be(b, p + 2);
    const end = p + 2 + len;
    if (len < 2 || end > b.length) break;

    const payload = b.subarray(p + 4, end);
    const size = end - p;
    let dropLabel: string | undefined;

    if (marker === JPEG_APP1) {
      if (startsWithAscii(payload, "Exif\0\0")) dropLabel = "APP1 Exif";
      else if (startsWithAscii(payload, "http://ns.adobe.com/xap/")) dropLabel = "APP1 XMP";
      else dropLabel = "APP1 metadata";
    } else if (marker === JPEG_APP2) {
      if (startsWithAscii(payload, "ICC_PROFILE\0")) kept.push("ICC color profile");
      else dropLabel = "APP2 metadata";
    } else if (marker === JPEG_APP13) {
      dropLabel = "APP13 IPTC/Photoshop";
    } else if (marker === JPEG_COM) {
      dropLabel = "COM comment";
    }

    if (dropLabel) removed.push(`${dropLabel} (${size.toLocaleString("en-US")} bytes)`);
    else parts.push(b.subarray(p, end));
    p = end;
  }

  if (p < b.length) parts.push(b.subarray(p));
  return { bytes: concatBytes(parts), removed, kept };
}

const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

function stripPngDetail(b: Uint8Array): StripDetail {
  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  parts.push(b.subarray(0, 8));
  let p = 8;

  while (p + 12 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const end = p + 12 + len;
    if (len > 0x7fffffff || end > b.length) break;
    if (PNG_METADATA_CHUNKS.has(type)) {
      removed.push(`${type} chunk (${(12 + len).toLocaleString("en-US")} bytes)`);
    } else {
      if (type === "iCCP") kept.push("iCCP color profile");
      parts.push(b.subarray(p, end));
    }
    p = end;
    if (type === "IEND") break;
  }

  if (p < b.length) parts.push(b.subarray(p));
  return { bytes: concatBytes(parts), removed, kept };
}

/**
 * Remove metadata segments from a JPEG or PNG without re-encoding a single
 * pixel. JPEG keeps APP0 JFIF and any APP2 ICC profile; PNG keeps every chunk
 * except eXIf, tEXt, zTXt, and iTXt. Retained chunks keep their original CRCs
 * because PNG chunks are independent of each other.
 *
 * Exported so the canvas editor panel can reuse the exact same bytes.
 */
export function stripExif(bytes: Uint8Array): { bytes: Uint8Array; removed: string[] } {
  const detail = stripExifDetail(bytes);
  return { bytes: detail.bytes, removed: detail.removed };
}

function stripExifDetail(bytes: Uint8Array): StripDetail {
  if (matchesAt(bytes, 0, PNG_SIG)) return stripPngDetail(bytes);
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return stripJpegDetail(bytes);
  throw new ToolError(
    "strip-unsupported",
    "Metadata can only be removed in place from JPEG and PNG files.",
    "Convert the image to JPEG or PNG first with the editor, then strip the metadata.",
  );
}

/* ------------------------------------------------------------------ */
/* EXIF reading                                                        */
/* ------------------------------------------------------------------ */

const ORIENTATION_MEANING: Record<number, string> = {
  1: "normal",
  2: "mirrored horizontally",
  3: "rotated 180 degrees",
  4: "mirrored vertically",
  5: "mirrored horizontally and rotated 270 degrees clockwise",
  6: "rotated 90 degrees clockwise",
  7: "mirrored horizontally and rotated 90 degrees clockwise",
  8: "rotated 270 degrees clockwise",
};

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\0+$/, "").trim();
  return t || undefined;
}

function shutterLabel(seconds: number): string {
  if (seconds <= 0) return `${seconds} s`;
  if (seconds >= 1) return `${Number(seconds.toFixed(2))} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

function isoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    // exifr leaves the raw "2024:05:01 12:00:00" shape when reviving is off.
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  return undefined;
}

async function readExifRows(bytes: Uint8Array): Promise<Record<string, string>> {
  let tags: Record<string, unknown> | undefined;
  try {
    tags = (await exifr.parse(bytes, {
      tiff: true,
      ifd0: {},
      exif: {},
      gps: {},
      translateKeys: true,
      // Keep raw numbers so Orientation can be reported as "6 (rotated ...)".
      translateValues: false,
      reviveValues: true,
      mergeOutput: true,
      sanitize: true,
    })) as Record<string, unknown> | undefined;
  } catch {
    // exifr throws a plain Error for formats it does not recognize. That is not
    // a user error here: the header parser above already validated the image.
    tags = undefined;
  }

  const rows: Record<string, string> = {};
  if (!tags) return rows;

  const make = str(tags.Make);
  const model = str(tags.Model);
  if (make || model) {
    const camera =
      make && model
        ? model.toLowerCase().startsWith(make.toLowerCase())
          ? model
          : `${make} ${model}`
        : (make ?? model)!;
    rows["Camera"] = camera;
  }

  const lens = str(tags.LensModel) ?? str(tags.Lens) ?? str(tags.LensInfo);
  if (lens) rows["Lens"] = lens;

  const taken = isoDate(tags.DateTimeOriginal) ?? isoDate(tags.CreateDate);
  if (taken) rows["Taken"] = taken;

  const exposureParts: string[] = [];
  const shutter = num(tags.ExposureTime);
  if (shutter !== undefined) exposureParts.push(shutterLabel(shutter));
  const fNumber = num(tags.FNumber);
  if (fNumber !== undefined) exposureParts.push(`f/${Number(fNumber.toFixed(1))}`);
  const iso = num(tags.ISO) ?? num(tags.ISOSpeedRatings) ?? num(tags.PhotographicSensitivity);
  if (iso !== undefined) exposureParts.push(`ISO ${iso}`);
  if (exposureParts.length) rows["Exposure"] = exposureParts.join(", ");

  const focal = num(tags.FocalLength);
  if (focal !== undefined) {
    const equiv = num(tags.FocalLengthIn35mmFormat);
    rows["Focal length"] =
      equiv !== undefined
        ? `${Number(focal.toFixed(1))} mm (${Number(equiv.toFixed(0))} mm equivalent)`
        : `${Number(focal.toFixed(1))} mm`;
  }

  const orientation = num(tags.Orientation);
  if (orientation !== undefined) {
    const meaning = ORIENTATION_MEANING[orientation] ?? "unspecified";
    rows["Orientation"] = `${orientation} (${meaning})`;
  }

  const lat = num(tags.latitude);
  const lon = num(tags.longitude);
  if (lat !== undefined && lon !== undefined) {
    rows["GPS"] = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    rows["GPS warning"] =
      "This photo records where it was taken, often to within a few meters. Strip the metadata before you share it publicly.";
  }

  const software = str(tags.Software);
  if (software) rows["Software"] = software;

  return rows;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (!input || input.length === 0) {
      throw new ToolError(
        "empty-input",
        "No image was provided.",
        "Drop an image file onto the input or pick one with the file button.",
      );
    }
    return input;
  }

  const text = input.trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "No image was provided.",
      "Drop an image file onto the input or pick one with the file button.",
    );
  }
  // SVG is the one image format that is genuinely pasteable as text.
  if (looksLikeSvg(text)) return new TextEncoder().encode(input);

  throw new ToolError(
    "not-an-image",
    "This input is text, not image bytes, so there is no image header to read.",
    `Drop an image file onto the input instead. Supported formats are ${SUPPORTED_LIST}.`,
  );
}

export async function run(
  input: Uint8Array | string,
  opts: ImageToolboxOpts,
): Promise<ImageToolboxResult> {
  const bytes = toBytes(input);
  const info = detect(bytes);

  const result: ImageToolboxResult = { Format: info.format };

  if (info.dimensionsLabel) {
    result["Dimensions"] = info.dimensionsLabel;
  } else if (info.width && info.height) {
    result["Dimensions"] = `${info.width} x ${info.height} px`;
    const pixels = info.width * info.height;
    // Below 0.1 MP the rounded value is always "0.0", which tells nobody anything.
    if (pixels >= 100_000) result["Megapixels"] = (pixels / 1_000_000).toFixed(1);
    result["Aspect ratio"] = aspectRatio(info.width, info.height);
  }

  if (info.colorInfo) result["Bit depth / color type"] = info.colorInfo;
  if (info.interlace) result["Interlace/progressive"] = info.interlace;
  for (const [k, v] of Object.entries(info.extra ?? {})) result[k] = v;
  result["File size"] = humanSize(bytes.length);
  if (info.frames !== undefined) {
    result["Frames"] = info.frames === 1 ? "1 (still)" : `${info.frames} (animated)`;
  }

  const exifRows = await readExifRows(bytes);
  if (Object.keys(exifRows).length === 0) {
    result["EXIF"] = "None found";
  } else {
    for (const [k, v] of Object.entries(exifRows)) result[k] = v;
  }

  if (opts?.stripExif) {
    if (info.strippable === null) {
      throw new ToolError(
        "strip-unsupported",
        `Metadata cannot be removed in place from ${info.format} files, only from JPEG and PNG.`,
        "Convert the image to JPEG or PNG first with the editor, then strip the metadata.",
      );
    }
    const detail = stripExifDetail(bytes);
    const saved = bytes.length - detail.bytes.length;
    const notes: string[] = [];
    if (detail.removed.length) {
      notes.push(`Removed ${detail.removed.join(", ")}. Saved ${humanSize(saved)}.`);
    } else {
      notes.push("Nothing to remove: this file carries no EXIF, XMP, IPTC, or comment metadata.");
    }
    if (detail.kept.length) notes.push(`Kept ${detail.kept.join(", ")} so colors stay correct.`);
    notes.push("Pixel data was copied byte for byte, so there is no quality loss.");
    result["Stripped"] = notes.join(" ");
    result["Cleaned image"] =
      `data:${info.mime ?? "application/octet-stream"};base64,${toBase64(detail.bytes)}`;
  }

  return result;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  ImageToolboxResult,
  ImageToolboxOpts
>;
