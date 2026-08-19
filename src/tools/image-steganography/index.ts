import { sha256 } from "@noble/hashes/sha2.js";
import { formatByteCount } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Least significant bit steganography over raw RGBA buffers.
 *
 * Decoding a PNG into pixels and encoding pixels back into a PNG both need a
 * canvas, so the panel does that part and hands these functions the bytes it
 * read back. Everything here is arithmetic on a `Uint8ClampedArray`, which keeps
 * the whole format testable in Node.
 *
 * ## The container
 *
 * Hidden data is written as one frame, LSB first, walking pixels in row order:
 *
 * ```
 * offset  size  field
 * 0       4     magic, the ASCII bytes "STG1"
 * 4       1     flags (see below)
 * 5       4     payload length in bytes, unsigned 32 bit big endian
 * 9       4     CRC32 of the plaintext payload, unsigned 32 bit big endian
 * 13      8     nonce, present only when the encrypted flag is set
 * ...           the payload, encrypted when the flag is set
 * ```
 *
 * The flags byte packs the settings the frame was written with, so a reader
 * never has to be told them:
 *
 * ```
 * bits 0-1  bits per channel, stored as (bits - 1), so 0 means 1 and 1 means 2
 * bits 2-4  channel set: 0 rgb, 1 rgba, 2 r, 3 g, 4 b
 * bit  5    encrypted
 * bit  6    compressed (reserved, always 0 in this version)
 * bit  7    reserved, always 0
 * ```
 *
 * Because the flags are part of the frame, `extract` can try every settings
 * combination and only accept the one whose flags byte agrees with the
 * combination it was read at. That is a 32 bit magic plus a self consistency
 * check, so a false positive on an ordinary photo is not a practical concern.
 *
 * ## The bit order
 *
 * Payload bytes are serialized least significant bit first. Bit `k` of frame
 * byte `i` goes to slot `i * 8 + k`. Slots run through the image in pixel order,
 * and inside a pixel through the selected channels in red, green, blue, alpha
 * order, and inside a channel from bit 0 upward. So at two bits per channel over
 * RGB, pixel 0 carries slots 0 to 5.
 *
 * ## The optional password
 *
 * When a password is given the payload is XORed with a SHA-256 keystream:
 * `key = sha256(utf8(password) || nonce)`, then block `i` of the keystream is
 * `sha256(key || uint32le(i))`. The nonce is 8 random bytes stored in the
 * header, so hiding the same message twice never produces the same bits.
 *
 * This is lightweight encryption, and the honest description matters: it is a
 * real stream cipher over a real hash, but there is no key stretching, so a
 * guessable password falls to an offline brute force, and there is no
 * authentication tag, so a tampered payload is detected only by the CRC32,
 * which is a checksum and not a MAC. It stops someone who opens the file in an
 * editor. It is not a substitute for an encrypted archive.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

/** How many low bits of each selected channel carry data. */
export type BitDepth = 1 | 2;

/** Which channels of each pixel carry data. */
export type ChannelSet = "rgb" | "rgba" | "r" | "g" | "b";

export interface EmbedOpts {
  bitsPerChannel: BitDepth;
  channels: ChannelSet;
  /** Turns on the SHA-256 keystream. An empty string counts as no password. */
  password?: string;
  /**
   * Makes the nonce deterministic instead of random, so a test or a pipeline can
   * assert exact output. Ignored when no password is set.
   */
  seed?: string;
}

export interface EmbedResult {
  /** A copy of the carrier with the frame written into its low bits. */
  rgba: Uint8ClampedArray;
  bits: BitDepth;
  channels: ChannelSet;
  encrypted: boolean;
  /** Bytes of payload, not counting the header. */
  payloadBytes: number;
  /** Header size for this frame: 13, or 21 when encrypted. */
  headerBytes: number;
  /** Header plus payload. */
  usedBytes: number;
  /** Everything this carrier could hold at these settings. */
  capacityBytes: number;
  /** `usedBytes` as a percentage of `capacityBytes`. */
  fillPercent: number;
  /** CRC32 of the plaintext payload. */
  crc: number;
  /** Peak signal to noise ratio of the result against the carrier, in dB. */
  psnr: number;
  /** True when any source pixel was not fully opaque. */
  hasTransparency: boolean;
}

export interface ExtractOpts {
  password?: string;
}

export interface ExtractMeta {
  bits: BitDepth;
  channels: ChannelSet;
  encrypted: boolean;
  /** True when the CRC32 in the header matches the recovered payload. */
  crcOk: boolean;
}

export interface ExtractResult {
  payload: Uint8Array;
  meta: ExtractMeta;
}

export interface StegoOpts {
  mode?: string;
  bits?: string | number;
  channels?: string;
  password?: string;
  seed?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** ASCII "STG1". */
const MAGIC = [0x53, 0x54, 0x47, 0x31] as const;
/** magic + flags + length + crc. */
const HEADER_BASE = 13;
const NONCE_BYTES = 8;

const FLAG_ENCRYPTED = 1 << 5;
/** Reserved for a future deflated payload. Never set by this version. */
const FLAG_COMPRESSED = 1 << 6;
const FLAG_RESERVED = 1 << 7;

const CHANNEL_INDEXES: Record<ChannelSet, readonly number[]> = {
  rgb: [0, 1, 2],
  rgba: [0, 1, 2, 3],
  r: [0],
  g: [1],
  b: [2],
};

const CHANNEL_ORDER: readonly ChannelSet[] = ["rgb", "rgba", "r", "g", "b"];

const CHANNEL_LABELS: Record<ChannelSet, string> = {
  rgb: "red, green, and blue",
  rgba: "red, green, blue, and alpha",
  r: "red only",
  g: "green only",
  b: "blue only",
};

const TOO_LARGE_FIX = "Use a bigger image, 2 bits per channel, or a shorter message.";

const PANEL_FIX = "Drop an image in the panel, type the message, and choose Hide or Reveal.";

/* ------------------------------------------------------------------ *
 * validation
 * ------------------------------------------------------------------ */

function assertCarrier(rgba: Uint8ClampedArray): number {
  if (!(rgba instanceof Uint8ClampedArray) || rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new ToolError(
      "invalid-image",
      `A buffer of ${rgba?.length ?? 0} bytes is not RGBA pixel data.`,
      "Pass four bytes per pixel, in red, green, blue, alpha order, with no header.",
    );
  }
  return rgba.length / 4;
}

function assertBits(bits: number): BitDepth {
  if (bits !== 1 && bits !== 2) {
    throw new ToolError(
      "invalid-bits",
      `${bits} bits per channel is not supported.`,
      "Use 1 bit per channel for an invisible change, or 2 to hide twice as much.",
    );
  }
  return bits;
}

function assertChannels(channels: string): ChannelSet {
  if (!CHANNEL_ORDER.includes(channels as ChannelSet)) {
    throw new ToolError(
      "invalid-channels",
      `"${channels}" is not a channel set.`,
      "Choose one of: rgb, rgba, r, g, b.",
    );
  }
  return channels as ChannelSet;
}

/* ------------------------------------------------------------------ *
 * capacity
 * ------------------------------------------------------------------ */

/**
 * Total bytes an image of this size can carry, header included.
 *
 * Every selected channel of every pixel contributes `bits` slots, and eight
 * slots make a byte. The remainder is dropped because a partial byte is not
 * usable.
 */
export function capacityBytes(
  width: number,
  height: number,
  bits: BitDepth,
  channels: ChannelSet,
): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ToolError(
      "invalid-size",
      `A width and height of ${width} by ${height} is not a usable image size.`,
      "Pass the pixel width and height as positive whole numbers.",
    );
  }
  const depth = assertBits(bits);
  const set = assertChannels(channels);
  return Math.floor((width * height * CHANNEL_INDEXES[set].length * depth) / 8);
}

function capacityForPixels(pixels: number, bits: BitDepth, channels: ChannelSet): number {
  return Math.floor((pixels * CHANNEL_INDEXES[channels].length * bits) / 8);
}

/** Header size for a frame with or without the nonce. */
export function headerBytesFor(encrypted: boolean): number {
  return HEADER_BASE + (encrypted ? NONCE_BYTES : 0);
}

/**
 * Bytes of message an image can hold once the header is accounted for. Never
 * negative: a carrier too small even for the header reports 0.
 */
export function payloadCapacityBytes(
  width: number,
  height: number,
  bits: BitDepth,
  channels: ChannelSet,
  encrypted = false,
): number {
  return Math.max(0, capacityBytes(width, height, bits, channels) - headerBytesFor(encrypted));
}

/* ------------------------------------------------------------------ *
 * bit plumbing
 * ------------------------------------------------------------------ */

/**
 * Byte offset and bit index of one slot.
 *
 * Slots advance through pixels in row order, through the selected channels
 * inside a pixel, and through the low bits inside a channel.
 */
function slotAt(
  slot: number,
  bits: BitDepth,
  indexes: readonly number[],
): { offset: number; bit: number } {
  const perPixel = indexes.length * bits;
  const pixel = Math.floor(slot / perPixel);
  const rest = slot - pixel * perPixel;
  const channel = Math.floor(rest / bits);
  return { offset: pixel * 4 + indexes[channel]!, bit: rest - channel * bits };
}

/** Writes `bytes` into the low bits of `rgba`, starting at byte index `from`. */
function writeBytes(
  rgba: Uint8ClampedArray,
  bytes: Uint8Array,
  from: number,
  bits: BitDepth,
  channels: ChannelSet,
): void {
  const indexes = CHANNEL_INDEXES[channels];
  let slot = from * 8;
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      const { offset, bit } = slotAt(slot, bits, indexes);
      const mask = 1 << bit;
      const on = (value >> k) & 1;
      rgba[offset] = on === 1 ? rgba[offset]! | mask : rgba[offset]! & ~mask;
      slot += 1;
    }
  }
}

/** Reads `count` bytes out of the low bits of `rgba`, starting at byte `from`. */
function readBytes(
  rgba: Uint8ClampedArray,
  from: number,
  count: number,
  bits: BitDepth,
  channels: ChannelSet,
): Uint8Array {
  const indexes = CHANNEL_INDEXES[channels];
  const out = new Uint8Array(count);
  let slot = from * 8;
  for (let i = 0; i < count; i += 1) {
    let value = 0;
    for (let k = 0; k < 8; k += 1) {
      const { offset, bit } = slotAt(slot, bits, indexes);
      value |= ((rgba[offset]! >> bit) & 1) << k;
      slot += 1;
    }
    out[i] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CRC32
 * ------------------------------------------------------------------ */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** The IEEE CRC32 every PNG and zip uses, returned as an unsigned 32 bit value. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * the keystream
 * ------------------------------------------------------------------ */

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

/**
 * SHA-256 in counter mode: `key = sha256(password || nonce)`, then block `i` is
 * `sha256(key || uint32le(i))`. Deterministic for a given password and nonce,
 * which is what makes the round trip work.
 */
export function keystream(password: string, nonce: Uint8Array, length: number): Uint8Array {
  const key = sha256(concatBytes(new TextEncoder().encode(password), nonce));
  const out = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const block = sha256(concatBytes(key, uint32le(counter)));
    const take = Math.min(block.length, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
    counter += 1;
  }
  return out;
}

/** XORs a payload with the keystream. Self inverse, so it both hides and reveals. */
function applyKeystream(data: Uint8Array, password: string, nonce: Uint8Array): Uint8Array {
  const stream = keystream(password, nonce, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i]! ^ stream[i]!;
  return out;
}

function makeNonce(seed?: string): Uint8Array {
  if (typeof seed === "string" && seed !== "") {
    return sha256(new TextEncoder().encode(`image-steganography nonce:${seed}`)).slice(
      0,
      NONCE_BYTES,
    );
  }
  const out = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(out);
  return out;
}

/* ------------------------------------------------------------------ *
 * payload helpers
 * ------------------------------------------------------------------ */

/** UTF-8 encodes a message into the bytes that get hidden. */
export function payloadFromText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * UTF-8 decodes a recovered payload. Throws when the bytes are not valid UTF-8,
 * which is the signal that what was hidden was a file rather than a message.
 */
export function textFromPayload(payload: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new ToolError(
      "not-text",
      "The recovered payload is not valid UTF-8 text.",
      "It is probably a hidden file. Save it with the download button instead of reading it as a message.",
    );
  }
}

/** True when a payload decodes cleanly as UTF-8. */
export function isText(payload: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * flags
 * ------------------------------------------------------------------ */

function packFlags(bits: BitDepth, channels: ChannelSet, encrypted: boolean): number {
  return (
    (bits - 1) | (CHANNEL_ORDER.indexOf(channels) << 2) | (encrypted ? FLAG_ENCRYPTED : 0)
  );
}

interface ParsedFlags {
  bits: BitDepth;
  channels: ChannelSet;
  encrypted: boolean;
}

/** Returns null for any flags byte this version cannot have written. */
function parseFlags(flags: number): ParsedFlags | null {
  if ((flags & FLAG_COMPRESSED) !== 0 || (flags & FLAG_RESERVED) !== 0) return null;
  const bitField = flags & 0b11;
  if (bitField > 1) return null;
  const channelField = (flags >> 2) & 0b111;
  const channels = CHANNEL_ORDER[channelField];
  if (!channels) return null;
  return {
    bits: (bitField + 1) as BitDepth,
    channels,
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
  };
}

/* ------------------------------------------------------------------ *
 * embed
 * ------------------------------------------------------------------ */

/**
 * Hides a payload in the low bits of a carrier and reports what it cost.
 *
 * The carrier is never mutated: the result is a copy. Everything the reader
 * needs is written into the frame, so the settings used here do not have to be
 * remembered or shared.
 */
export function embedWithReport(
  rgba: Uint8ClampedArray,
  payload: Uint8Array,
  opts: EmbedOpts,
): EmbedResult {
  const pixels = assertCarrier(rgba);
  const bits = assertBits(opts.bitsPerChannel);
  const channels = assertChannels(opts.channels);

  if (payload.length === 0) {
    throw new ToolError(
      "empty-payload",
      "There is nothing to hide.",
      "Type a message or pick a file to hide inside the image.",
    );
  }

  const password = typeof opts.password === "string" ? opts.password : "";
  const encrypted = password !== "";
  const headerBytes = headerBytesFor(encrypted);
  const capacity = capacityForPixels(pixels, bits, channels);
  const used = headerBytes + payload.length;

  if (used > capacity) {
    throw new ToolError(
      "too-large",
      `The payload needs ${used} bytes of capacity but this image offers ${capacity}.`,
      TOO_LARGE_FIX,
    );
  }

  const crc = crc32(payload);
  const nonce = encrypted ? makeNonce(opts.seed) : new Uint8Array(0);
  const body = encrypted ? applyKeystream(payload, password, nonce) : payload;

  const header = new Uint8Array(headerBytes);
  header.set(MAGIC, 0);
  header[4] = packFlags(bits, channels, encrypted);
  header[5] = (payload.length >>> 24) & 0xff;
  header[6] = (payload.length >>> 16) & 0xff;
  header[7] = (payload.length >>> 8) & 0xff;
  header[8] = payload.length & 0xff;
  header[9] = (crc >>> 24) & 0xff;
  header[10] = (crc >>> 16) & 0xff;
  header[11] = (crc >>> 8) & 0xff;
  header[12] = crc & 0xff;
  if (encrypted) header.set(nonce, HEADER_BASE);

  const out = new Uint8ClampedArray(rgba);
  writeBytes(out, header, 0, bits, channels);
  writeBytes(out, body, headerBytes, bits, channels);

  let hasTransparency = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i]! < 255) {
      hasTransparency = true;
      break;
    }
  }

  return {
    rgba: out,
    bits,
    channels,
    encrypted,
    payloadBytes: payload.length,
    headerBytes,
    usedBytes: used,
    capacityBytes: capacity,
    fillPercent: capacity === 0 ? 0 : (used / capacity) * 100,
    crc,
    psnr: psnr(rgba, out),
    hasTransparency,
  };
}

/** Hides a payload and returns just the stego pixels. */
export function embed(
  rgba: Uint8ClampedArray,
  payload: Uint8Array,
  opts: EmbedOpts,
): Uint8ClampedArray {
  return embedWithReport(rgba, payload, opts).rgba;
}

/* ------------------------------------------------------------------ *
 * extract
 * ------------------------------------------------------------------ */

interface Candidate {
  payload: Uint8Array;
  meta: ExtractMeta;
}

/**
 * Recovers hidden data, working out the settings from the frame itself.
 *
 * Every combination of bit depth and channel set is tried. A combination counts
 * as a hit only when the magic matches, the flags byte decodes to exactly the
 * combination being read at, and the declared length fits in the image. A hit
 * whose CRC32 also matches wins outright; otherwise the first hit is used to
 * produce a specific error or, for an unencrypted frame, a payload flagged
 * `crcOk: false` so a partially damaged image still gives you something.
 */
export function extract(rgba: Uint8ClampedArray, opts: ExtractOpts = {}): ExtractResult {
  const pixels = assertCarrier(rgba);
  const password = typeof opts.password === "string" ? opts.password : "";
  const candidates: Candidate[] = [];

  for (const bits of [1, 2] as BitDepth[]) {
    for (const channels of CHANNEL_ORDER) {
      const capacity = capacityForPixels(pixels, bits, channels);
      if (capacity < HEADER_BASE + 1) continue;

      const head = readBytes(rgba, 0, HEADER_BASE, bits, channels);
      if (
        head[0] !== MAGIC[0] ||
        head[1] !== MAGIC[1] ||
        head[2] !== MAGIC[2] ||
        head[3] !== MAGIC[3]
      ) {
        continue;
      }

      const flags = parseFlags(head[4]!);
      if (!flags || flags.bits !== bits || flags.channels !== channels) continue;

      const length =
        ((head[5]! << 24) | (head[6]! << 16) | (head[7]! << 8) | head[8]!) >>> 0;
      const expectedCrc =
        ((head[9]! << 24) | (head[10]! << 16) | (head[11]! << 8) | head[12]!) >>> 0;
      const headerBytes = headerBytesFor(flags.encrypted);
      if (length < 1 || headerBytes + length > capacity) continue;

      const nonce = flags.encrypted
        ? readBytes(rgba, HEADER_BASE, NONCE_BYTES, bits, channels)
        : new Uint8Array(0);
      const body = readBytes(rgba, headerBytes, length, bits, channels);
      const payload =
        flags.encrypted && password !== "" ? applyKeystream(body, password, nonce) : body;

      candidates.push({
        payload,
        meta: {
          bits,
          channels,
          encrypted: flags.encrypted,
          crcOk: crc32(payload) === expectedCrc,
        },
      });
    }
  }

  const clean = candidates.find((c) => c.meta.crcOk);
  if (clean) return { payload: clean.payload, meta: clean.meta };

  const first = candidates[0];
  if (!first) {
    throw new ToolError(
      "nothing-found",
      "No hidden data was found in this image.",
      "Load the exact PNG that came out of the hide step. Saving as JPEG or WebP, resizing, cropping, or screenshotting the image erases the hidden bits.",
    );
  }

  if (first.meta.encrypted) {
    throw new ToolError(
      "bad-password",
      password === ""
        ? "This image holds hidden data, but it is password protected."
        : "This image holds hidden data, but that password did not decrypt it.",
      password === ""
        ? "Enter the password that was used when the data was hidden."
        : "Check the password, including its capital letters and any spaces.",
    );
  }

  return { payload: first.payload, meta: first.meta };
}

/* ------------------------------------------------------------------ *
 * measurement and visualization
 * ------------------------------------------------------------------ */

/**
 * Peak signal to noise ratio between two RGBA buffers, in decibels.
 *
 * The mean squared error runs over all four channels, and the peak is 255. Two
 * identical buffers have no error, so the ratio is infinite; anything above
 * about 40 dB is invisible to a person, and one bit LSB embedding lands far
 * above that.
 */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) {
    throw new ToolError(
      "size-mismatch",
      `The two buffers hold ${a.length} and ${b.length} bytes.`,
      "Compare the carrier against the stego image it produced, at the same size.",
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  const mse = sum / a.length;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

/**
 * Paints one bit plane as pure black and white, which is what makes the whole
 * idea visible: a photo's low bits look like static, so data hidden there looks
 * like more static, while a flat gradient or a screenshot shows obvious
 * structure and gives the hiding place away.
 *
 * By default a pixel is white when the chosen bit is set in an odd number of the
 * red, green, and blue channels, so any single channel embedding still shows up.
 * Pass a channel to look at exactly one instead. Alpha is left fully opaque.
 */
export function visualizeLsb(
  rgba: Uint8ClampedArray,
  bit = 0,
  channel: "parity" | "r" | "g" | "b" | "a" = "parity",
): Uint8ClampedArray {
  assertCarrier(rgba);
  if (!Number.isInteger(bit) || bit < 0 || bit > 7) {
    throw new ToolError(
      "invalid-bit",
      `Bit ${bit} does not exist in an 8 bit channel.`,
      "Pick a bit from 0, the least significant, to 7.",
    );
  }

  const out = new Uint8ClampedArray(rgba.length);
  const single = channel === "parity" ? -1 : "rgba".indexOf(channel);

  for (let i = 0; i < rgba.length; i += 4) {
    const on =
      single >= 0
        ? (rgba[i + single]! >> bit) & 1
        : (((rgba[i]! >> bit) & 1) ^ ((rgba[i + 1]! >> bit) & 1) ^ ((rgba[i + 2]! >> bit) & 1)) &
          1;
    const value = on === 1 ? 255 : 0;
    out[i] = value;
    out[i + 1] = value;
    out[i + 2] = value;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * The warning to show for a chosen output format, or null when the format is
 * safe. Anything that rewrites pixel values destroys the hidden bits, and that
 * includes both lossy compression and palette quantization.
 */
export function formatWarning(mime: string): string | null {
  const type = String(mime ?? "")
    .toLowerCase()
    .split(";")[0]!
    .trim();

  switch (type) {
    case "image/jpeg":
    case "image/jpg":
    case "image/pjpeg":
      return "JPEG is lossy. Re-encoding rewrites nearly every pixel, so the hidden bits will not survive. Save the result as PNG.";
    case "image/webp":
      return "WebP is normally written lossy, which rewrites pixel values and erases the hidden bits. Save the result as PNG.";
    case "image/avif":
    case "image/heic":
    case "image/heif":
      return "This format is lossy. It rewrites pixel values on save, which erases the hidden bits. Save the result as PNG.";
    case "image/gif":
      return "GIF reduces the image to at most 256 colors. That rewrites pixel values and erases the hidden bits. Save the result as PNG.";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * reports
 * ------------------------------------------------------------------ */

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function readPsnr(value: number): string {
  if (!Number.isFinite(value)) return "identical to the original";
  if (value >= 50) return "no visible change";
  if (value >= 40) return "no change a person would notice";
  if (value >= 30) return "a faint change in flat areas";
  return "visible noise, so lower the bits per channel or use a bigger image";
}

const ENCRYPTION_NOTE =
  "SHA-256 keystream with a random 8 byte nonce. Lightweight encryption: it stops a casual reader, but there is no key stretching and no authentication tag, so treat a weak password as guessable.";

/** Labeled rows describing a completed embed, for the generic shell. */
export function describeEmbed(result: EmbedResult): Record<string, string> {
  const rows: Record<string, string> = {
    Hidden: formatByteCount(result.payloadBytes),
    "Bits used": `${result.bits} bit${result.bits === 1 ? "" : "s"} per channel across ${CHANNEL_LABELS[result.channels]}`,
    Capacity: `${formatByteCount(result.capacityBytes)} total, ${result.fillPercent.toFixed(2)} percent now used including the ${result.headerBytes} byte header`,
    Encryption: result.encrypted
      ? ENCRYPTION_NOTE
      : "None. Anyone who runs this tool on the image gets the payload back.",
    "Image quality": `PSNR ${Number.isFinite(result.psnr) ? `${result.psnr.toFixed(2)} dB` : "infinite"}, ${readPsnr(result.psnr)}`,
    Checksum: `CRC32 ${hex32(result.crc)} over the payload, so a damaged image is reported rather than decoded into garbage`,
    "Save as": "Export the result as PNG. Any lossy re-encode erases the hidden bits.",
  };

  if (result.hasTransparency) {
    rows.Transparency =
      "This image has pixels that are not fully opaque. Canvas premultiplies alpha, which can rewrite the color under them, so flatten the image onto a background before hiding anything.";
  }

  return rows;
}

/** Labeled rows describing a completed extract, for the generic shell. */
export function describeExtract(result: ExtractResult): Record<string, string> {
  const rows: Record<string, string> = {
    Recovered: formatByteCount(result.payload.length),
    Settings: `${result.meta.bits} bit${result.meta.bits === 1 ? "" : "s"} per channel across ${CHANNEL_LABELS[result.meta.channels]}, detected from the header`,
    Encryption: result.meta.encrypted
      ? "The payload was encrypted and the password decrypted it."
      : "None. The payload was stored in the clear.",
    Checksum: result.meta.crcOk
      ? "CRC32 matches, so the payload came back exactly as it went in."
      : "CRC32 does not match. The image was altered after the data was hidden, so the payload below is incomplete.",
  };

  if (isText(result.payload)) {
    rows.Message = textFromPayload(result.payload);
  } else {
    rows.Payload = "Not UTF-8 text, so this is a hidden file rather than a message.";
    rows["First bytes"] = hexPreview(result.payload, 32);
  }

  return rows;
}

function hexPreview(bytes: Uint8Array, limit: number): string {
  const take = Math.min(limit, bytes.length);
  const parts: string[] = [];
  for (let i = 0; i < take; i += 1) parts.push(bytes[i]!.toString(16).padStart(2, "0"));
  return parts.join(" ") + (bytes.length > take ? ` ... (${bytes.length} bytes)` : "");
}

/* ------------------------------------------------------------------ *
 * base64
 * ------------------------------------------------------------------ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i += 1) B64_LOOKUP[B64[i] as string] = i;
B64_LOOKUP["-"] = 62;
B64_LOOKUP["_"] = 63;

/** Standard or URL safe base64 to bytes. Returns null on anything invalid. */
function base64ToBytes(raw: string): Uint8Array | null {
  const core = raw.replace(/\s+/g, "").replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of core) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[i] = (acc >> bits) & 0xff;
      i += 1;
    }
  }
  return i === out.length ? out : out.slice(0, i);
}

/** Bytes to standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    if (b === undefined) {
      out += `${B64[(a & 3) << 4]}==`;
      break;
    }
    out += B64[((a & 3) << 4) | (b >> 4)];
    if (c === undefined) {
      out += `${B64[(b & 15) << 2]}=`;
      break;
    }
    out += B64[((b & 15) << 2) | (c >> 6)];
    out += B64[c & 63];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const HIDE_WORDS = new Set(["hide", "embed", "encode", "write", "conceal", "insert"]);
const REVEAL_WORDS = new Set(["reveal", "extract", "decode", "read", "recover", "find"]);

function readMode(value: unknown): "hide" | "reveal" {
  if (value === undefined || value === null || value === "") return "hide";
  const word = String(value).toLowerCase().trim();
  if (HIDE_WORDS.has(word)) return "hide";
  if (REVEAL_WORDS.has(word)) return "reveal";
  throw new ToolError(
    "invalid-mode",
    `"${String(value)}" is not a mode.`,
    "Choose Hide to put data into an image, or Reveal to read it back out.",
  );
}

function readBitsOption(value: unknown): BitDepth {
  if (value === undefined || value === null || value === "") return 1;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return assertBits(n);
}

function usePanel(): ToolError {
  return new ToolError(
    "use-panel",
    "This tool needs an image and a message; use the panel above.",
    PANEL_FIX,
  );
}

/**
 * Text surface for the tool.
 *
 * The generic shell hands a tool one input, and this tool needs a carrier image
 * and a message at the same time, so the real work happens in the panel on this
 * page. What `run` accepts is a small JSON payload of raw pixels, which is what
 * makes the format runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 8, "height": 8, "rgbaBase64": "<base64 RGBA>", "text": "hi", "mode": "hide" }
 * ```
 *
 * `bytesBase64` may be given instead of `text` to hide arbitrary bytes, and
 * `password`, `mode`, `bits`, and `channels` may be given in the payload as well
 * as in the options. Anything that is not this shape gets a clear error pointing
 * at the panel, because a bare PNG on its own can never be a hide request.
 */
export function run(input: Uint8Array | string, opts: StegoOpts = {}): Record<string, string> {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    text = new TextDecoder().decode(input);
  } else {
    throw usePanel();
  }

  if (text.trim() === "") throw usePanel();

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usePanel();
    payload = parsed as Record<string, unknown>;
  } catch {
    throw usePanel();
  }

  if (typeof payload.rgbaBase64 !== "string") throw usePanel();

  const width = payload.width;
  const height = payload.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1
  ) {
    throw new ToolError(
      "invalid-size",
      "The payload needs a positive whole `width` and `height`.",
      "Send the pixel size the RGBA data was read at.",
    );
  }

  const bytes = base64ToBytes(payload.rgbaBase64);
  if (bytes === null) {
    throw new ToolError(
      "invalid-image",
      "`rgbaBase64` is not valid base64.",
      "Send four bytes per pixel, in red, green, blue, alpha order, base64 encoded.",
    );
  }
  const need = (width as number) * (height as number) * 4;
  if (bytes.length !== need) {
    throw new ToolError(
      "invalid-image",
      `The pixel data holds ${bytes.length} bytes, but ${String(width)} by ${String(height)} pixels needs ${need}.`,
      "Send four bytes per pixel, in red, green, blue, alpha order, with no header.",
    );
  }
  const rgba = new Uint8ClampedArray(bytes);

  const mode = readMode(payload.mode ?? opts.mode);
  const password =
    typeof payload.password === "string"
      ? payload.password
      : typeof opts.password === "string"
        ? opts.password
        : "";
  const seed =
    typeof payload.seed === "string"
      ? payload.seed
      : typeof opts.seed === "string"
        ? opts.seed
        : undefined;

  if (mode === "reveal") {
    return describeExtract(extract(rgba, { password }));
  }

  const bits = readBitsOption(payload.bits ?? opts.bits);
  const channels = assertChannels(
    String(payload.channels ?? opts.channels ?? "rgb").toLowerCase(),
  );

  let message: Uint8Array;
  if (typeof payload.text === "string" && payload.text !== "") {
    message = payloadFromText(payload.text);
  } else if (typeof payload.bytesBase64 === "string") {
    const decoded = base64ToBytes(payload.bytesBase64);
    if (decoded === null) {
      throw new ToolError(
        "invalid-payload",
        "`bytesBase64` is not valid base64.",
        "Base64 encode the file you want to hide, or send a `text` message instead.",
      );
    }
    message = decoded;
  } else {
    throw new ToolError(
      "empty-payload",
      "There is nothing to hide.",
      "Add a `text` message or a `bytesBase64` file to the payload.",
    );
  }

  const result = embedWithReport(rgba, message, {
    bitsPerChannel: bits,
    channels,
    password,
    seed,
  });
  const rows = describeEmbed(result);

  const encoded = bytesToBase64(result.rgba);
  rows["Stego pixels"] =
    encoded.length <= 8192
      ? encoded
      : `${formatByteCount(result.rgba.length)} of RGBA pixels, too large to print here. The panel above hands you the PNG.`;

  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, StegoOpts>;
