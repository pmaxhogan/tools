import QRCode from "qrcode";
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Animated QR file transfer: the frame protocol and codec.
 *
 * A payload is split into fixed size chunks, each chunk is wrapped in a small
 * binary header, and the whole frame is encoded as base64url text that a QR
 * code carries in byte mode. The sender paints those frames on a screen in a
 * loop; the receiver points a camera at the screen and feeds every decoded
 * string into `Receiver.ingest`.
 *
 * Why base64url instead of raw bytes in byte mode: every browser path that
 * reads a QR code hands back a string. jsQR exposes `binaryData`, but the
 * native BarcodeDetector only gives `rawValue`, and a raw byte payload that is
 * not valid UTF-8 is mangled by the time it gets there. base64url survives any
 * text pipe intact. It costs about 33 percent more air time, which is priced
 * into the chunk size below.
 *
 * Two stream modes:
 *
 * - "sequential" walks chunk 0 to chunk N and loops. The receiver reports which
 *   indices it is still missing and waits for the next pass.
 * - "fountain" is an endless LT code stream. Each cycle opens with a systematic
 *   pass, one plain chunk per frame, and then spends twice that many frames on
 *   combination frames that XOR a pseudo random subset of chunks. The subset is
 *   derived from the transfer id and the frame index carried in the header, so
 *   the receiver recomputes exactly what the sender used without any handshake,
 *   and a receiver that joins late or drops a third of the frames still
 *   finishes. The systematic pass repeats every cycle rather than sitting once
 *   at the head of the stream, which is a deliberate deviation from textbook LT:
 *   it means a clean pass is always enough, early frames are useful
 *   immediately, and a receiver joining in the middle never has to wait long
 *   for the degree 1 frames that let peeling start.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export type TransferMode = "sequential" | "fountain";
export type EccLevel = "L" | "M";
export type SizeName = "small" | "medium" | "large" | "max";

/** Frame magic. Three ASCII bytes, version 1 of the protocol. */
export const MAGIC = "QX1";

/** Fixed part of the frame header, in bytes. */
export const HEADER_BYTES = 22;

/** Header flag bits. */
const FLAG_FOUNTAIN = 1;
const FLAG_HAS_NAME = 2;

/** A frame carries the file name every this many stream positions. */
export const DEFAULT_META_EVERY = 16;

/** Above this the transfer takes long enough that a cable is the better tool. */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** Longest file name the u8 length field can carry, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;

/**
 * A fountain cycle is this many times the chunk count: one systematic pass plus
 * two passes of combination frames.
 *
 * Measured, not guessed. At a 70 percent frame capture rate, which is a fair
 * description of a hand held phone reading a screen, a cycle of twice the chunk
 * count fails to decode about a fifth of the time for a small payload, because
 * 1.4 usable frames per chunk is simply not enough redundancy. Three times the
 * chunk count decodes essentially always, and the stream is endless anyway, so
 * this is a planning figure rather than a deadline.
 */
export const FOUNTAIN_CYCLE_FACTOR = 3;

/**
 * Combination frame degrees are multiplied by this before use.
 *
 * A textbook soliton degree is tuned for a receiver that knows nothing. Ours
 * always has the systematic pass, so by the time the combination frames matter
 * most of a frame's chunks are already known and the frame collapses to nothing.
 * Doubling the degree keeps roughly one or two unknowns per frame at realistic
 * loss rates, which measurably halves the failure rate at every chunk count.
 */
export const DEGREE_SPREAD = 2;

/** Which QR version each size option pins. */
export const SIZE_VERSIONS: Record<SizeName, number> = {
  small: 10,
  medium: 15,
  large: 20,
  max: 25,
};

/**
 * Byte mode data capacity of a QR symbol, in characters, for the versions and
 * error correction levels this tool offers.
 *
 * These are measured against the bundled encoder, not copied from a published
 * capacity table: the two disagree by a few characters at some versions because
 * the encoder charges the mode and character count indicators against the data
 * budget slightly differently. The encoder's number is the one that matters,
 * since it is the thing that refuses to build the symbol, and `index.test.ts`
 * re-derives every value here so the table cannot drift.
 */
export const QR_BYTE_CAPACITY: Record<number, Record<EccLevel, number>> = {
  10: { L: 271, M: 213 },
  15: { L: 520, M: 412 },
  20: { L: 858, M: 666 },
  25: { L: 1273, M: 997 },
};

/* -------------------------------------------------------------------------- */
/* base64url                                                                  */
/* -------------------------------------------------------------------------- */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  // Tolerate standard base64's two extra characters so a frame that went
  // through a non url safe encoder somewhere still parses.
  table["+".charCodeAt(0)] = 62;
  table["/".charCodeAt(0)] = 63;
  return table;
})();

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >>> 18) & 63] +
      B64_ALPHABET[(n >>> 12) & 63] +
      B64_ALPHABET[(n >>> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >>> 18) & 63] + B64_ALPHABET[(n >>> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64_ALPHABET[(n >>> 18) & 63] +
      B64_ALPHABET[(n >>> 12) & 63] +
      B64_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/** Decode unpadded (or padded) base64url back to bytes. */
export function fromBase64Url(text: string): Uint8Array {
  const clean = (text ?? "").trim().replace(/=+$/, "");
  if (clean.length % 4 === 1)
    throw new ToolError(
      "bad-frame",
      "That scan is not a complete transfer frame.",
      "Keep the whole code inside the camera view and hold still for a moment.",
    );

  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 256 ? B64_LOOKUP[code] : -1;
    if (value < 0)
      throw new ToolError(
        "bad-frame",
        "That scan is not a transfer frame.",
        "Point the camera at the animated code from this tool's sender tab.",
      );
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CRC32                                                                      */
/* -------------------------------------------------------------------------- */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** Standard IEEE CRC32 over a byte array, returned as an unsigned 32 bit value. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Seeded randomness                                                          */
/* -------------------------------------------------------------------------- */

/** cyrb53 style string hash, folded to one 32 bit seed. */
function hashString(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

/** mulberry32: tiny deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Four random bytes as eight hex characters. A non empty seed makes the id
 * reproducible, which is what the tests and shared links rely on; otherwise it
 * comes from the platform CSPRNG.
 */
export function makeTransferId(seed?: string): string {
  const bytes = new Uint8Array(4);
  const value = (seed ?? "").trim();
  if (value) {
    const rng = mulberry32(hashString(value));
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(rng() * 256) & 0xff;
  } else {
    crypto.getRandomValues(bytes);
  }
  return toHex(bytes);
}

/* -------------------------------------------------------------------------- */
/* Robust soliton distribution                                                */
/* -------------------------------------------------------------------------- */

/**
 * Tuning constants for the robust soliton distribution. Picked by sweeping both
 * against simulated decodes at chunk counts from 20 to 400 and capture rates
 * from 70 to 90 percent, not from a paper's example values.
 */
const SOLITON_C = 0.03;
const SOLITON_DELTA = 0.01;

const solitonCache = new Map<number, Float64Array>();

/**
 * Cumulative robust soliton distribution over degrees 1..K. Index d holds the
 * probability of drawing a degree of at most d, so a single uniform sample
 * scans it. Cached per chunk count because both the sender and the receiver ask
 * for the same K over and over.
 */
export function solitonCdf(totalChunks: number): Float64Array {
  const cached = solitonCache.get(totalChunks);
  if (cached) return cached;

  const k = Math.max(1, totalChunks);
  const p = new Float64Array(k + 1);
  // Ideal soliton.
  p[1] = 1 / k;
  for (let d = 2; d <= k; d++) p[d] = 1 / (d * (d - 1));

  // Robust addition: a 1/d ramp plus a spike near k / r.
  let r = SOLITON_C * Math.log(k / SOLITON_DELTA) * Math.sqrt(k);
  if (!Number.isFinite(r) || r <= 0) r = 1;
  const spike = Math.round(k / r);
  if (spike >= 1 && spike <= k) {
    for (let d = 1; d < spike; d++) p[d] += r / (d * k);
    p[spike] += (r * Math.log(Math.max(Math.E, r / SOLITON_DELTA))) / k;
  }

  let beta = 0;
  for (let d = 1; d <= k; d++) beta += p[d];
  const cdf = new Float64Array(k + 1);
  let acc = 0;
  for (let d = 1; d <= k; d++) {
    acc += p[d] / beta;
    cdf[d] = acc;
  }
  cdf[k] = 1;

  // Bound the cache: only a handful of distinct chunk counts are ever live.
  if (solitonCache.size > 8) solitonCache.clear();
  solitonCache.set(totalChunks, cdf);
  return cdf;
}

/** Draw one degree from the robust soliton distribution, clamped to 1..K. */
export function solitonDegree(u: number, totalChunks: number): number {
  const cdf = solitonCdf(totalChunks);
  for (let d = 1; d <= totalChunks; d++) if (u <= cdf[d]) return d;
  return Math.max(1, Math.min(totalChunks, totalChunks));
}

/**
 * The source chunk indices a fountain frame combines, derived from values both
 * sides read out of the frame header and nothing else.
 *
 * The first `totalChunks` positions of every cycle are the systematic pass:
 * position p carries chunk p untouched. The rest are XOR combinations, seeded
 * from the transfer id and the absolute frame index so no two combination
 * frames in a cycle are alike.
 */
export function fountainIndices(
  transferId: string,
  frameIndex: number,
  totalChunks: number,
): number[] {
  if (totalChunks <= 1) return [0];

  const framesPerCycle = totalChunks * FOUNTAIN_CYCLE_FACTOR;
  const cyclePosition = frameIndex % framesPerCycle;
  if (cyclePosition < totalChunks) return [cyclePosition];

  const rng = mulberry32(hashString(`${transferId}:${frameIndex}`));
  const degree = Math.min(
    totalChunks,
    Math.max(2, Math.round(DEGREE_SPREAD * solitonDegree(rng(), totalChunks))),
  );

  if (degree >= totalChunks) return Array.from({ length: totalChunks }, (_, i) => i);

  if (degree * 2 > totalChunks) {
    // Dense draw: shuffle a full index list and take the front of it. Rejection
    // sampling would thrash at this density.
    const pool = Array.from({ length: totalChunks }, (_, i) => i);
    for (let i = totalChunks - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, degree).sort((a, b) => a - b);
  }

  const picked = new Set<number>();
  let guard = 0;
  while (picked.size < degree && guard < degree * 64) {
    picked.add(Math.floor(rng() * totalChunks));
    guard++;
  }
  return [...picked].sort((a, b) => a - b);
}

/* -------------------------------------------------------------------------- */
/* Option validation                                                          */
/* -------------------------------------------------------------------------- */

function normaliseSize(size: string | undefined): SizeName {
  const raw = (size ?? "medium").trim().toLowerCase();
  const alias: Record<string, SizeName> = {
    "": "medium",
    small: "small",
    s: "small",
    medium: "medium",
    m: "medium",
    large: "large",
    l: "large",
    max: "max",
    maximum: "max",
    xl: "max",
  };
  const chosen = alias[raw];
  if (!chosen)
    throw new ToolError(
      "bad-option",
      `Unknown code size "${size}".`,
      "Use small, medium, large or max. Bigger codes carry more data per frame but need a better camera.",
    );
  return chosen;
}

function normaliseEcc(ecc: string | undefined): EccLevel {
  const raw = (ecc ?? "M").trim().toUpperCase();
  if (raw === "" || raw === "M") return "M";
  if (raw === "L") return "L";
  throw new ToolError(
    "bad-option",
    `Unknown error correction level "${ecc}".`,
    "Use L for the most data per frame or M for the most reliable scanning.",
  );
}

function normaliseMode(mode: string | undefined): TransferMode {
  const raw = (mode ?? "fountain").trim().toLowerCase();
  if (raw === "" || raw === "fountain") return "fountain";
  if (raw === "sequential") return "sequential";
  throw new ToolError(
    "bad-option",
    `Unknown stream mode "${mode}".`,
    "Use fountain for a camera that drops frames, or sequential for an ordered loop.",
  );
}

function normaliseFps(fps: number | undefined): number {
  const value = fps === undefined || fps === null ? 10 : Number(fps);
  if (!Number.isFinite(value) || value < 4 || value > 20)
    throw new ToolError(
      "bad-option",
      `Frame rate ${fps} is outside the usable range.`,
      "Use 4 to 20 frames per second. Around 10 is the sweet spot for phone cameras.",
    );
  return Math.round(value);
}

function normaliseMetaEvery(metaEvery: number | undefined): number {
  const value = metaEvery === undefined || metaEvery === null ? DEFAULT_META_EVERY : Number(metaEvery);
  if (!Number.isFinite(value) || value < 1 || value > 1000)
    throw new ToolError(
      "bad-option",
      `The file name repeat interval ${metaEvery} is not usable.`,
      "Use a whole number between 1 and 1000.",
    );
  return Math.floor(value);
}

/* -------------------------------------------------------------------------- */
/* Byte helpers                                                               */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === "string" ? encoder.encode(input) : input;
}

function xorInto(target: Uint8Array, other: Uint8Array): void {
  const n = Math.min(target.length, other.length);
  for (let i = 0; i < n; i++) target[i] ^= other[i];
}

function padTo(data: Uint8Array, length: number): Uint8Array {
  if (data.length === length) return data.slice();
  const out = new Uint8Array(length);
  out.set(data.subarray(0, length));
  return out;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  return (source[offset] << 8) | source[offset + 1];
}

function readU32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] << 24) |
      (source[offset + 1] << 16) |
      (source[offset + 2] << 8) |
      source[offset + 3]) >>>
    0
  );
}

/* -------------------------------------------------------------------------- */
/* Frames                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything one frame carries, before or after the wire encoding. */
export interface FrameFields {
  transferId: string;
  mode: TransferMode;
  /** Chunk index in sequential mode, stream position in fountain mode. */
  index: number;
  totalChunks: number;
  totalLength: number;
  chunkSize: number;
  /** Present only on the repeating meta frames. */
  fileName?: string;
  data: Uint8Array;
}

export interface ParsedFrame extends FrameFields {
  /** CRC32 of `data` as it travelled, already verified by the parser. */
  crc: number;
}

/** Serialise one frame to its wire bytes. */
export function buildFrameBytes(fields: FrameFields): Uint8Array {
  const nameBytes = fields.fileName ? encoder.encode(fields.fileName) : null;
  if (nameBytes && nameBytes.length > MAX_NAME_BYTES)
    throw new ToolError(
      "bad-option",
      "That file name is too long to fit in a frame header.",
      "Shorten the name to 255 bytes or fewer.",
    );

  const headerLength = HEADER_BYTES + (nameBytes ? 1 + nameBytes.length : 0);
  const out = new Uint8Array(headerLength + fields.data.length);

  out[0] = MAGIC.charCodeAt(0);
  out[1] = MAGIC.charCodeAt(1);
  out[2] = MAGIC.charCodeAt(2);
  out[3] = (fields.mode === "fountain" ? FLAG_FOUNTAIN : 0) | (nameBytes ? FLAG_HAS_NAME : 0);
  for (let i = 0; i < 4; i++) out[4 + i] = parseInt(fields.transferId.slice(i * 2, i * 2 + 2), 16);
  writeU16(out, 8, fields.totalChunks);
  writeU16(out, 10, fields.index & 0xffff);
  writeU32(out, 12, fields.totalLength);
  writeU16(out, 16, fields.chunkSize);
  writeU32(out, 18, crc32(fields.data));
  if (nameBytes) {
    out[HEADER_BYTES] = nameBytes.length;
    out.set(nameBytes, HEADER_BYTES + 1);
  }
  out.set(fields.data, headerLength);
  return out;
}

/** Serialise one frame to the base64url text a QR code carries. */
export function encodeFrame(fields: FrameFields): string {
  return toBase64Url(buildFrameBytes(fields));
}

function badFrame(message: string, fix: string): ToolError {
  return new ToolError("bad-frame", message, fix);
}

/** Parse and verify one frame's wire bytes. Throws `ToolError` on anything odd. */
export function parseFrame(bytes: Uint8Array): ParsedFrame {
  if (bytes.length < HEADER_BYTES)
    throw badFrame(
      "That scan is too short to be a transfer frame.",
      "Fill more of the camera view with the code and try again.",
    );
  if (
    bytes[0] !== MAGIC.charCodeAt(0) ||
    bytes[1] !== MAGIC.charCodeAt(1) ||
    bytes[2] !== MAGIC.charCodeAt(2)
  )
    throw badFrame(
      "That QR code is not part of an animated transfer.",
      "Point the camera at the sender tab of this tool, not at an ordinary QR code.",
    );

  const flags = bytes[3];
  const mode: TransferMode = flags & FLAG_FOUNTAIN ? "fountain" : "sequential";
  const transferId = toHex(bytes.subarray(4, 8));
  const totalChunks = readU16(bytes, 8);
  const index = readU16(bytes, 10);
  const totalLength = readU32(bytes, 12);
  const chunkSize = readU16(bytes, 16);
  const crc = readU32(bytes, 18);

  if (totalChunks < 1 || chunkSize < 1)
    throw badFrame(
      "That frame's header is not usable.",
      "Restart the sender and scan the stream again.",
    );

  let offset = HEADER_BYTES;
  let fileName: string | undefined;
  if (flags & FLAG_HAS_NAME) {
    if (bytes.length < HEADER_BYTES + 1)
      throw badFrame(
        "That frame claims a file name but does not carry one.",
        "Wait for the next frame in the loop.",
      );
    const nameLength = bytes[HEADER_BYTES];
    offset = HEADER_BYTES + 1 + nameLength;
    if (bytes.length < offset)
      throw badFrame(
        "That frame's file name is cut short.",
        "Wait for the next frame in the loop.",
      );
    fileName = decoder.decode(bytes.subarray(HEADER_BYTES + 1, offset));
  }

  const data = bytes.subarray(offset);
  if (crc32(data) !== crc)
    throw new ToolError(
      "bad-crc",
      "That frame failed its checksum, so it was misread.",
      "Hold the camera steadier or slow the sender down; the frame will come round again.",
    );

  return {
    transferId,
    mode,
    index,
    totalChunks,
    totalLength,
    chunkSize,
    fileName,
    crc,
    data: data.slice(),
  };
}

/** Parse and verify one frame from its base64url text. */
export function decodeFrame(text: string): ParsedFrame {
  return parseFrame(fromBase64Url(text));
}

/* -------------------------------------------------------------------------- */
/* Planning and frame generation                                              */
/* -------------------------------------------------------------------------- */

export interface TransferPlan {
  transferId: string;
  fileName: string;
  /** Payload length in bytes. */
  totalLength: number;
  chunkSize: number;
  totalChunks: number;
  mode: TransferMode;
  ecc: EccLevel;
  size: SizeName;
  /** Pinned QR version, so every frame draws at the same module count. */
  version: number;
  /** Modules per side of the pinned symbol. */
  moduleCount: number;
  /** Byte mode capacity of the pinned symbol, in base64url characters. */
  capacity: number;
  /** Frame bytes that fit inside that capacity once base64url is priced in. */
  frameBytes: number;
  /** The file name repeats every this many stream positions. */
  metaEvery: number;
  /**
   * Sequential: exactly the chunk count, then the loop repeats. Fountain: three
   * times the chunk count, being one systematic pass and two passes of
   * combination frames, which is what a camera catching roughly two frames in
   * three needs to finish. The fountain stream itself never ends.
   */
  framesPerCycle: number;
}

export interface FrameSource extends TransferPlan {
  /** The base64url text for stream position `i`. Any non negative integer. */
  nextFrame(i: number): string;
  /** The padded source chunk at `index`, for tests and panels that inspect it. */
  chunkAt(index: number): Uint8Array;
}

export interface TransferOptions {
  size?: string;
  ecc?: string;
  mode?: string;
  /** Name the receiver saves the payload under. */
  fileName?: string;
  metaEvery?: number;
  /** Non empty makes the transfer id reproducible. */
  seed?: string;
}

/** Modules per side of a QR symbol at a given version. */
export function moduleCountForVersion(version: number): number {
  return 17 + 4 * version;
}

function capacityFor(version: number, ecc: EccLevel): number {
  const row = QR_BYTE_CAPACITY[version];
  if (!row)
    throw new ToolError(
      "bad-option",
      `QR version ${version} is not one of the offered code sizes.`,
      "Use small, medium, large or max.",
    );
  return row[ecc];
}

function cleanFileName(name: string | undefined, fallback: string): string {
  const raw = (name ?? "").trim().replace(/[\\/]+/g, "_");
  return raw || fallback;
}

/**
 * Work out the chunk size, the chunk count and the QR geometry for a payload.
 *
 * The chunk size is computed against the *meta* header, the biggest one, so
 * every frame in the stream carries the same number of payload bytes whether or
 * not it repeats the file name. Frames without the name simply leave a few
 * characters of QR capacity unused, which is far cheaper than the bookkeeping a
 * variable chunk size would cost the receiver.
 */
export function planTransfer(payload: Uint8Array | string, opts: TransferOptions = {}): TransferPlan {
  const bytes = toBytes(payload);
  if (bytes.length === 0)
    throw new ToolError(
      "empty-input",
      "There is nothing to send.",
      "Drop in a file or paste some text first.",
    );
  if (bytes.length > MAX_PAYLOAD_BYTES)
    throw new ToolError(
      "too-large",
      `That payload is ${formatBytes(bytes.length)}, and this tool stops at ${formatBytes(MAX_PAYLOAD_BYTES)}.`,
      "A camera reads a couple of kilobytes per second, so anything larger takes well over an hour on screen. Zip a smaller selection, or use a cable or the Local File Drop tool.",
    );

  const size = normaliseSize(opts.size);
  const ecc = normaliseEcc(opts.ecc);
  const mode = normaliseMode(opts.mode);
  const metaEvery = normaliseMetaEvery(opts.metaEvery);
  const version = SIZE_VERSIONS[size];
  const capacity = capacityFor(version, ecc);
  const fileName = cleanFileName(opts.fileName, typeof payload === "string" ? "payload.txt" : "file.bin");

  const nameBytes = encoder.encode(fileName);
  if (nameBytes.length > MAX_NAME_BYTES)
    throw new ToolError(
      "bad-option",
      "That file name is too long to fit in a frame header.",
      "Shorten the name to 255 bytes or fewer.",
    );

  // base64url turns 3 bytes into 4 characters, so the usable byte budget is
  // three quarters of the character capacity.
  const frameBytes = Math.floor((capacity * 3) / 4);
  const chunkSize = frameBytes - (HEADER_BYTES + 1 + nameBytes.length);
  if (chunkSize < 1)
    throw new ToolError(
      "bad-option",
      `A "${size}" code has no room left for data once the header and the file name "${fileName}" are in it.`,
      "Shorten the file name or pick a larger code size.",
    );

  const totalChunks = Math.ceil(bytes.length / chunkSize);
  if (totalChunks > 65535)
    throw new ToolError(
      "too-large",
      "That payload needs more chunks than one transfer can address.",
      "Pick a larger code size, or send a smaller file.",
    );

  return {
    transferId: makeTransferId(opts.seed),
    fileName,
    totalLength: bytes.length,
    chunkSize,
    totalChunks,
    mode,
    ecc,
    size,
    version,
    moduleCount: moduleCountForVersion(version),
    capacity,
    frameBytes,
    metaEvery,
    framesPerCycle: mode === "fountain" ? totalChunks * FOUNTAIN_CYCLE_FACTOR : totalChunks,
  };
}

/**
 * Build a frame generator over a payload. `nextFrame(i)` is pure in `i`, so the
 * panel can render an endless animation without holding any frame text, and a
 * receiver that joins at position 4000 gets frames it can still use.
 */
export function createFrameSource(
  payload: Uint8Array | string,
  opts: TransferOptions = {},
): FrameSource {
  const plan = planTransfer(payload, opts);
  const bytes = toBytes(payload);
  const { chunkSize, totalChunks, totalLength, transferId, mode, metaEvery, fileName } = plan;

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = new Uint8Array(chunkSize);
    chunk.set(bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, totalLength)));
    chunks.push(chunk);
  }
  const lastLength = totalLength - (totalChunks - 1) * chunkSize;

  /** A plain chunk, trimmed if it is the short tail, so no air time is wasted. */
  const plainChunk = (index: number): Uint8Array => {
    const chunk = chunks[index];
    return index === totalChunks - 1 ? chunk.subarray(0, lastLength) : chunk;
  };

  const nextFrame = (i: number): string => {
    const position = Math.max(0, Math.floor(i));
    const wrapped = position % 65536;

    let index: number;
    let data: Uint8Array;
    if (mode === "sequential") {
      index = position % totalChunks;
      data = plainChunk(index);
    } else {
      index = wrapped;
      const indices = fountainIndices(transferId, wrapped, totalChunks);
      if (indices.length === 1) {
        data = plainChunk(indices[0]);
      } else {
        const combined = new Uint8Array(chunkSize);
        for (const j of indices) xorInto(combined, chunks[j]);
        data = combined;
      }
    }

    return encodeFrame({
      transferId,
      mode,
      index,
      totalChunks,
      totalLength,
      chunkSize,
      fileName: position % metaEvery === 0 ? fileName : undefined,
      data,
    });
  };

  return {
    ...plan,
    nextFrame,
    chunkAt: (index: number) => chunks[index].slice(),
  };
}

/**
 * One full cycle of frames as text: every chunk once in sequential mode, twice
 * the chunk count in fountain mode. `count` overrides that length.
 */
export function encodeFrames(
  payload: Uint8Array | string,
  opts: TransferOptions & { count?: number } = {},
): string[] {
  const source = createFrameSource(payload, opts);
  const count = Math.max(1, Math.floor(opts.count ?? source.framesPerCycle));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(source.nextFrame(i));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Receiver                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReceiverResult {
  /** The frame parsed, passed its checksum, and belongs to this transfer. */
  accepted: boolean;
  /** Accepted but carried nothing new. */
  redundant: boolean;
  /** Why the frame was ignored. Absent when accepted. */
  reason?: string;
  transferId?: string;
  fileName?: string;
  /** Source chunks decoded so far. */
  received: number;
  /** Source chunks in the whole payload. Zero before the first good frame. */
  total: number;
  /** 0 to 1. */
  progress: number;
  /** Frames accepted so far. */
  frames: number;
  done: boolean;
  /** Chunk indices still undecoded. Present once a header has been read. */
  missing?: number[];
  /** Set exactly when `done` first becomes true, and on every result after. */
  file?: { name: string; bytes: Uint8Array };
}

interface Combo {
  indices: Set<number>;
  data: Uint8Array;
  alive: boolean;
}

interface LockedPlan {
  transferId: string;
  mode: TransferMode;
  totalChunks: number;
  totalLength: number;
  chunkSize: number;
}

/**
 * Collects frames until the payload is whole.
 *
 * Feed it every string the camera decodes, including garbage: `ingest` never
 * throws, it returns `accepted: false` with a reason. The first valid frame
 * locks the transfer id and the header, so a second transfer animating nearby
 * cannot corrupt this one.
 */
export class Receiver {
  private plan: LockedPlan | null = null;
  private chunks: (Uint8Array | null)[] = [];
  private pendingByIndex = new Map<number, Combo[]>();
  private queue: number[] = [];
  private known = 0;
  private acceptedFrames = 0;
  private name: string | null = null;
  private assembled: { name: string; bytes: Uint8Array } | null = null;

  /** Throw away everything and wait for a fresh transfer. */
  reset(): void {
    this.plan = null;
    this.chunks = [];
    this.pendingByIndex = new Map();
    this.queue = [];
    this.known = 0;
    this.acceptedFrames = 0;
    this.name = null;
    this.assembled = null;
  }

  /** The current state without ingesting anything. */
  get status(): ReceiverResult {
    return this.snapshot(false, false);
  }

  /** True once every chunk has been decoded. */
  get done(): boolean {
    return this.assembled !== null;
  }

  private snapshot(accepted: boolean, redundant: boolean, reason?: string): ReceiverResult {
    const total = this.plan?.totalChunks ?? 0;
    const result: ReceiverResult = {
      accepted,
      redundant,
      received: this.known,
      total,
      progress: total ? this.known / total : 0,
      frames: this.acceptedFrames,
      done: this.assembled !== null,
    };
    if (reason) result.reason = reason;
    if (this.plan) {
      result.transferId = this.plan.transferId;
      result.missing = this.missing();
    }
    if (this.name) result.fileName = this.name;
    if (this.assembled) result.file = this.assembled;
    return result;
  }

  /** Chunk indices not yet decoded. */
  missing(): number[] {
    if (!this.plan) return [];
    const out: number[] = [];
    for (let i = 0; i < this.plan.totalChunks; i++) if (!this.chunks[i]) out.push(i);
    return out;
  }

  private setChunk(index: number, data: Uint8Array): void {
    if (this.chunks[index]) return;
    this.chunks[index] = data;
    this.known++;
    this.queue.push(index);
  }

  /** Peel: substitute every newly known chunk into the combos that mention it. */
  private drain(): void {
    while (this.queue.length) {
      const j = this.queue.pop() as number;
      const list = this.pendingByIndex.get(j);
      if (!list) continue;
      this.pendingByIndex.delete(j);
      const chunk = this.chunks[j] as Uint8Array;
      for (const combo of list) {
        if (!combo.alive || !combo.indices.has(j)) continue;
        xorInto(combo.data, chunk);
        combo.indices.delete(j);
        if (combo.indices.size === 0) {
          combo.alive = false;
        } else if (combo.indices.size === 1) {
          const k = combo.indices.values().next().value as number;
          combo.alive = false;
          this.setChunk(k, combo.data);
        }
      }
    }
  }

  private assemble(): void {
    const plan = this.plan;
    if (!plan || this.known < plan.totalChunks) return;
    const out = new Uint8Array(plan.totalChunks * plan.chunkSize);
    for (let i = 0; i < plan.totalChunks; i++) out.set(this.chunks[i] as Uint8Array, i * plan.chunkSize);
    this.assembled = {
      name: this.name ?? "file.bin",
      bytes: out.subarray(0, plan.totalLength).slice(),
    };
  }

  /**
   * Take one decoded QR string. Returns the transfer state, and, once every
   * chunk is in, the reassembled file.
   */
  ingest(frameText: string): ReceiverResult {
    let frame: ParsedFrame;
    try {
      frame = decodeFrame(frameText);
    } catch (e) {
      return this.snapshot(false, false, e instanceof ToolError ? e.message : String(e));
    }

    if (!this.plan) {
      this.plan = {
        transferId: frame.transferId,
        mode: frame.mode,
        totalChunks: frame.totalChunks,
        totalLength: frame.totalLength,
        chunkSize: frame.chunkSize,
      };
      this.chunks = new Array(frame.totalChunks).fill(null);
    } else if (frame.transferId !== this.plan.transferId) {
      return this.snapshot(false, false, "That frame belongs to a different transfer.");
    } else if (
      frame.totalChunks !== this.plan.totalChunks ||
      frame.chunkSize !== this.plan.chunkSize ||
      frame.totalLength !== this.plan.totalLength ||
      frame.mode !== this.plan.mode
    ) {
      return this.snapshot(
        false,
        false,
        "That frame's header does not match the transfer already in progress.",
      );
    }

    if (frame.fileName) this.name = frame.fileName;
    if (frame.data.length > this.plan.chunkSize)
      return this.snapshot(false, false, "That frame carries more data than its header allows.");

    this.acceptedFrames++;
    if (this.assembled) {
      if (this.name && this.assembled.name !== this.name) this.assembled.name = this.name;
      return this.snapshot(true, true);
    }

    const indices =
      this.plan.mode === "fountain"
        ? fountainIndices(this.plan.transferId, frame.index, this.plan.totalChunks)
        : [frame.index];
    if (indices.some((i) => i < 0 || i >= this.plan!.totalChunks)) {
      this.acceptedFrames--;
      return this.snapshot(false, false, "That frame points at a chunk outside the payload.");
    }

    // Reduce against everything already known before filing the frame.
    const remaining = new Set(indices);
    const data = padTo(frame.data, this.plan.chunkSize);
    for (const j of indices) {
      const chunk = this.chunks[j];
      if (chunk) {
        xorInto(data, chunk);
        remaining.delete(j);
      }
    }

    if (remaining.size === 0) {
      this.assemble();
      return this.snapshot(true, true);
    }

    if (remaining.size === 1) {
      this.setChunk(remaining.values().next().value as number, data);
    } else {
      const combo: Combo = { indices: remaining, data, alive: true };
      for (const j of remaining) {
        const list = this.pendingByIndex.get(j);
        if (list) list.push(combo);
        else this.pendingByIndex.set(j, [combo]);
      }
    }

    this.drain();
    this.assemble();
    return this.snapshot(true, false);
  }
}

/* -------------------------------------------------------------------------- */
/* QR rendering                                                               */
/* -------------------------------------------------------------------------- */

export interface QrMatrix {
  /** Modules per side, including no quiet zone. */
  size: number;
  /** The version actually used. */
  version: number;
  /** `size * size` bytes, 1 for a dark module and 0 for a light one. */
  data: Uint8Array;
}

/**
 * Turn one frame's text into a raw module matrix so a panel can blit it to a
 * canvas without building an SVG string thirty times a second.
 *
 * `version` should be the plan's version: pin it, or short frames encode into a
 * smaller symbol than long ones and the animation visibly jitters between
 * module counts, which also upsets the camera's autofocus.
 *
 * `QRCode.create` is used rather than `QRCode.toString`, because the string
 * renderers differ between the package's Node and browser builds while the
 * module matrix is identical everywhere.
 */
export function frameToQrMatrix(text: string, ecc: string = "M", version?: number): QrMatrix {
  const level = normaliseEcc(ecc);
  if (!text)
    throw new ToolError(
      "empty-input",
      "There is no frame text to draw.",
      "Generate the frames first.",
    );
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: level, ...(version ? { version } : {}) });
    return {
      size: qr.modules.size,
      version: qr.version,
      data: new Uint8Array(qr.modules.data),
    };
  } catch (e) {
    throw new ToolError(
      "encode-failed",
      `That frame does not fit in a QR code: ${(e as Error).message}`,
      "Pick a larger code size, or lower the error correction level to L.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Estimating                                                                 */
/* -------------------------------------------------------------------------- */

/** The frame rates a phone camera can actually keep up with. */
export const FPS_MIN = 4;
export const FPS_MAX = 20;
export const FPS_RECOMMENDED = 10;

export interface TransferEstimate {
  chunkSize: number;
  totalChunks: number;
  /** Frames in one planning cycle: see `TransferPlan.framesPerCycle`. */
  frames: number;
  framesPerCycle: number;
  /** Seconds for one cycle at the given frame rate. */
  seconds: number;
  /** Payload bytes moved per second across one cycle. */
  bytesPerSecond: number;
  version: number;
  ecc: EccLevel;
  mode: TransferMode;
}

/**
 * How long a payload takes on screen. Cheap enough for a panel to call on every
 * option change, and it never touches the payload itself, only its length.
 */
export function estimateTransfer(
  bytes: number,
  size: string = "medium",
  fps: number = FPS_RECOMMENDED,
  mode: string = "fountain",
  ecc: string = "M",
  fileName: string = "file.bin",
): TransferEstimate {
  const length = Math.max(0, Math.floor(Number(bytes) || 0));
  const sizeName = normaliseSize(size);
  const level = normaliseEcc(ecc);
  const streamMode = normaliseMode(mode);
  const rate = normaliseFps(fps);
  const version = SIZE_VERSIONS[sizeName];
  const capacity = capacityFor(version, level);
  const nameBytes = encoder.encode(cleanFileName(fileName, "file.bin")).length;
  const chunkSize = Math.floor((capacity * 3) / 4) - (HEADER_BYTES + 1 + nameBytes);
  if (chunkSize < 1)
    throw new ToolError(
      "bad-option",
      `A "${sizeName}" code has no room left for data once the header and file name are in it.`,
      "Shorten the file name or pick a larger code size.",
    );

  const totalChunks = Math.max(1, Math.ceil(length / chunkSize));
  const framesPerCycle =
    streamMode === "fountain" ? totalChunks * FOUNTAIN_CYCLE_FACTOR : totalChunks;
  const seconds = framesPerCycle / rate;
  return {
    chunkSize,
    totalChunks,
    frames: framesPerCycle,
    framesPerCycle,
    seconds,
    bytesPerSecond: seconds > 0 ? length / seconds : 0,
    version,
    ecc: level,
    mode: streamMode,
  };
}

/** "8.4 s", "1 min 12 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - minutes * 60);
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/* -------------------------------------------------------------------------- */
/* The generic tool contract                                                  */
/* -------------------------------------------------------------------------- */

export interface QrTransferOpts {
  /** 'small' | 'medium' | 'large' | 'max' */
  size: string;
  /** 'L' | 'M' */
  ecc: string;
  /** 'sequential' | 'fountain' */
  mode: string;
  /** Frames per second the sender animates at. */
  fps: number;
  /** Name the receiver saves under. The panel fills this from the dropped file. */
  fileName?: string;
  /** Non empty makes the transfer id reproducible. */
  seed?: string;
  metaEvery?: number;
  [key: string]: unknown;
}

/**
 * The generic shell renders a labelled record. The real surface is the custom
 * panel: a sender that animates the frames on a canvas and a receiver that
 * reads them back through the camera.
 */
export function run(input: Uint8Array | string, opts: QrTransferOpts): Record<string, string> {
  const source = createFrameSource(input, {
    size: opts?.size,
    ecc: opts?.ecc,
    mode: opts?.mode,
    fileName: opts?.fileName,
    metaEvery: opts?.metaEvery,
    seed: opts?.seed,
  });
  const fps = normaliseFps(opts?.fps);
  const seconds = source.framesPerCycle / fps;

  return {
    "Payload size": formatBytes(source.totalLength),
    "File name": source.fileName,
    "Transfer ID": source.transferId,
    Mode:
      source.mode === "fountain"
        ? "Fountain: an endless stream, frames can arrive in any order and gaps are fine"
        : "Sequential: chunk 0 to the end, then the loop repeats",
    "Chunk size": `${formatBytes(source.chunkSize)} of payload per frame`,
    Chunks: String(source.totalChunks),
    "Frames per cycle": String(source.framesPerCycle),
    [`Estimated time at ${fps} fps`]: formatDuration(seconds),
    "QR version": `Version ${source.version} at error correction ${source.ecc}, ${source.moduleCount} modules per side, ${source.capacity} characters per code`,
    "First frame": source.nextFrame(0),
    Note: "The sender tab paints these frames on screen in a loop and the receiver tab reads them back through the camera. Nothing is uploaded: the payload crosses between the two devices as light.",
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, QrTransferOpts>;
