import { decode as decodeMsgpack } from "@msgpack/msgpack";
import { decode as decodeCbor } from "cbor-x";
import { formatBytes, formatByteCount } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Binary Format Decoder: protobuf, CBOR, and MessagePack to readable JSON.
 *
 * CBOR and MessagePack have real decoders behind them (cbor-x and
 * @msgpack/msgpack), both of which refuse a payload with trailing bytes, so a
 * successful decode always means the whole input was consumed. Protobuf has no
 * self describing header and nothing can decode it from a schema it was not
 * given, so the wire format parser here is hand rolled: it walks tag and value
 * pairs and reports field numbers instead of field names, which is everything
 * the wire format actually carries.
 *
 * `TextDecoder` and `atob` are platform primitives present in Node, browsers,
 * and Workers alike, so they are fair game the same way `crypto` is.
 */

/* ------------------------------------------------------------------ */
/* limits                                                             */
/* ------------------------------------------------------------------ */

/** Refuse anything larger: a browser tab decoding this in one go is a hang. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** Recursion cap for nested messages and for the JSON renderer. */
export const MAX_DEPTH = 32;
/** Bytes shown in a hex preview before it is truncated. */
const HEX_PREVIEW_BYTES = 64;
/** Largest field number the protobuf spec allows (2^29 - 1). */
const MAX_FIELD_NUMBER = 536870911;

/* ------------------------------------------------------------------ */
/* options                                                            */
/* ------------------------------------------------------------------ */

export type FormatId = "protobuf" | "cbor" | "msgpack";

export interface BinaryDecoderOpts {
  /** "auto" | "protobuf" | "cbor" | "msgpack". */
  format: string;
  [key: string]: unknown;
}

const FORMAT_ORDER: FormatId[] = ["protobuf", "cbor", "msgpack"];

const FORMAT_LABELS: Record<FormatId, string> = {
  protobuf: "Protobuf",
  cbor: "CBOR",
  msgpack: "MessagePack",
};

function normalizeFormat(value: unknown): "auto" | FormatId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (id === "protobuf" || id === "cbor" || id === "msgpack") return id;
  return "auto";
}

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

function emptyInput(): ToolError {
  return new ToolError(
    "empty-input",
    "Provide some bytes to decode.",
    "Drop a binary file, or paste the payload as base64 or as a hex dump.",
  );
}

function badEncoding(): ToolError {
  return new ToolError(
    "bad-encoding",
    "This text is not base64, base64url, or hex, so there are no bytes to decode.",
    "Paste the payload as base64 or as hex (a leading 0x and any whitespace are fine), or drop the binary file itself.",
  );
}

function tooLarge(size: number): ToolError {
  return new ToolError(
    "too-large",
    `That payload is ${formatByteCount(size)}, over the ${formatBytes(MAX_INPUT_BYTES)} limit for decoding in the page.`,
    "Slice the file down to the record you care about, or split it into smaller messages.",
  );
}

/* ------------------------------------------------------------------ */
/* input decoding                                                     */
/* ------------------------------------------------------------------ */

export type InputEncoding = "raw bytes" | "hex" | "base64";

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  if (normal.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normal)) return null;
  try {
    const binary = atob(normal);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Accept raw bytes, a hex dump (with or without a leading 0x, and with any
 * whitespace), a base64 or base64url string, or a `data:...;base64,` URL.
 *
 * Hex and base64 share an alphabet, so "deadbeef" is a syntactically valid
 * string in both. Unlike a format with magic bytes there is nothing to check a
 * guess against here, so the rule is fixed and documented: text that is entirely
 * hex digits and of even length is read as hex, everything else as base64.
 */
export function toBytes(input: Uint8Array | string): {
  bytes: Uint8Array;
  encoding: InputEncoding;
} {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInput();
    return { bytes: input, encoding: "raw bytes" };
  }

  const trimmed = input.trim();
  if (trimmed === "") throw emptyInput();

  let payload = trimmed;
  const dataUrl = /^data:[^,]*,/.exec(trimmed);
  if (dataUrl) {
    if (!/;base64/i.test(dataUrl[0])) throw badEncoding();
    payload = trimmed.slice(dataUrl[0].length);
  }

  const compact = payload.replace(/\s+/g, "");
  if (compact === "") throw emptyInput();

  if (/^0[xX]/.test(compact)) {
    const body = compact.slice(2);
    if (body === "") throw emptyInput();
    const bytes = hexToBytes(body);
    if (!bytes) throw badEncoding();
    return { bytes, encoding: "hex" };
  }

  const hex = hexToBytes(compact);
  if (hex) return { bytes: hex, encoding: "hex" };

  const b64 = base64ToBytes(compact);
  if (b64) {
    if (b64.length === 0) throw emptyInput();
    return { bytes: b64, encoding: "base64" };
  }

  throw badEncoding();
}

/* ------------------------------------------------------------------ */
/* protobuf wire format                                               */
/* ------------------------------------------------------------------ */

interface VarintResult {
  value: number | bigint;
  next: number;
}

/**
 * Base 128 varint. Values that still fit a JS number stay numbers; anything past
 * Number.MAX_SAFE_INTEGER is recomputed exactly as a BigInt, because a 64 bit id
 * quietly losing its low digits is worse than no answer at all.
 */
export function readVarint(bytes: Uint8Array, pos: number, end: number): VarintResult | null {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (let i = 0; i < 10; i++) {
    if (p >= end) return null;
    const byte = bytes[p++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      if (i >= 7 && value > Number.MAX_SAFE_INTEGER) {
        let exact = 0n;
        for (let j = 0; j <= i; j++) {
          exact |= BigInt(bytes[pos + j] & 0x7f) << BigInt(7 * j);
        }
        return { value: exact, next: p };
      }
      return { value, next: p };
    }
  }
  return null;
}

/** One decoded tag and value pair, already shaped for the JSON renderer. */
interface PbField {
  number: number;
  /** "varint", "string", "message", "bytes", "fixed64", or "fixed32". */
  label: string;
  value: unknown;
}

interface PbParse {
  fields: PbField[];
  /** Length delimited fields that were neither a message nor readable text. */
  hexFallbacks: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The payload as text, or null when it is not valid UTF-8 or carries control
 * characters. Tabs, newlines, and carriage returns count as ordinary text.
 */
export function asPrintableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "";
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return null;
  }
  return text;
}

/**
 * True when the text carries no control characters at all, not even a tab or a
 * newline. This is the tie breaker between a string and a nested message, and it
 * has to be strict in both directions. A two byte string like "hi" is also a
 * syntactically valid message (field 13, varint 105), so a message-first rule
 * misreads the most common payload there is. But a real nested message holding a
 * ten character string starts with a 0x0a tag and a 0x0a length, which a lenient
 * text check would happily read as "\n\n0123456789". Only strictly printable
 * text beats a clean message parse; lenient text is the last resort before hex.
 */
export function isStrictPrintable(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Walk one message body. Returns null the moment anything fails to line up,
 * which is what makes the nested message probe safe: a payload that is really a
 * string usually trips over a reserved wire type or runs off the end, and is
 * then read as a string instead. See `isStrictPrintable` for the tie breaker
 * when a payload is a valid message and valid text at the same time.
 */
function parseFields(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  depth: number,
): PbParse | null {
  const fields: PbField[] = [];
  let hexFallbacks = 0;
  let p = start;

  while (p < end) {
    const key = readVarint(bytes, p, end);
    if (!key) return null;
    // A field key always fits in 32 bits, so a BigInt key means a malformed stream.
    if (typeof key.value !== "number" || key.value > 0xffffffff) return null;
    p = key.next;

    const wireType = key.value % 8;
    const number = Math.floor(key.value / 8);
    if (number === 0 || number > MAX_FIELD_NUMBER) return null;

    if (wireType === 0) {
      const varint = readVarint(bytes, p, end);
      if (!varint) return null;
      p = varint.next;
      fields.push({ number, label: "varint", value: varint.value });
      continue;
    }

    if (wireType === 1) {
      if (p + 8 > end) return null;
      const uint = view.getBigUint64(p, true);
      fields.push({
        number,
        label: "fixed64",
        value: {
          uint: uint <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(uint) : uint,
          double: view.getFloat64(p, true),
        },
      });
      p += 8;
      continue;
    }

    if (wireType === 5) {
      if (p + 4 > end) return null;
      fields.push({
        number,
        label: "fixed32",
        value: { uint: view.getUint32(p, true), float: view.getFloat32(p, true) },
      });
      p += 4;
      continue;
    }

    // 3 and 4 are the deprecated group markers, 6 and 7 are reserved.
    if (wireType !== 2) return null;

    const len = readVarint(bytes, p, end);
    if (!len || typeof len.value !== "number") return null;
    p = len.next;
    const payloadEnd = p + len.value;
    if (payloadEnd > end) return null;

    const slice = bytes.subarray(p, payloadEnd);
    const text = asPrintableText(slice);
    let label = "";
    let value: unknown;

    if (text !== null && isStrictPrintable(text)) {
      label = "string";
      value = text;
    } else {
      if (len.value > 0 && depth < MAX_DEPTH) {
        const nested = parseFields(bytes, view, p, payloadEnd, depth + 1);
        if (nested && nested.fields.length > 0) {
          label = "message";
          value = groupFields(nested);
          hexFallbacks += nested.hexFallbacks;
        }
      }
      if (label === "" && text !== null) {
        label = "string";
        value = text;
      }
      if (label === "") {
        label = "bytes";
        value = slice;
        hexFallbacks += 1;
      }
    }

    fields.push({ number, label, value });
    p = payloadEnd;
  }

  return p === end ? { fields, hexFallbacks } : null;
}

/** Collapse a field list into an object, turning repeated numbers into arrays. */
function groupFields(parse: PbParse): Record<string, unknown> {
  const order: number[] = [];
  const byNumber = new Map<number, { label: string; values: unknown[] }>();
  for (const field of parse.fields) {
    let entry = byNumber.get(field.number);
    if (!entry) {
      entry = { label: field.label, values: [] };
      byNumber.set(field.number, entry);
      order.push(field.number);
    }
    entry.values.push(field.value);
  }
  const out: Record<string, unknown> = {};
  for (const number of order) {
    const entry = byNumber.get(number);
    if (!entry) continue;
    out[`${number} (${entry.label})`] = entry.values.length === 1 ? entry.values[0] : entry.values;
  }
  return out;
}

export interface ProtobufResult {
  value: Record<string, unknown>;
  /** Top level tag and value pairs, counting each repeat separately. */
  fieldCount: number;
  /** Distinct top level field numbers, in the order they first appeared. */
  fieldNumbers: number[];
  /** Length delimited fields shown as a hex preview instead of text or a message. */
  hexFallbacks: number;
}

/** Decode a schema-less protobuf message. Returns null when the bytes do not fit. */
export function decodeProtobuf(bytes: Uint8Array): ProtobufResult | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parse = parseFields(bytes, view, 0, bytes.length, 0);
  if (!parse || parse.fields.length === 0) return null;
  const numbers: number[] = [];
  for (const field of parse.fields) {
    if (!numbers.includes(field.number)) numbers.push(field.number);
  }
  return {
    value: groupFields(parse),
    fieldCount: parse.fields.length,
    fieldNumbers: numbers,
    hexFallbacks: parse.hexFallbacks,
  };
}

/* ------------------------------------------------------------------ */
/* JSON rendering                                                     */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function bytesPreview(bytes: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {
    $bytes: toHex(bytes.subarray(0, HEX_PREVIEW_BYTES)),
    length: bytes.length,
  };
  if (bytes.length > HEX_PREVIEW_BYTES) out.truncated = true;
  return out;
}

function mapKey(key: unknown): string {
  if (key === null) return "null";
  if (typeof key === "object") return "[object]";
  return String(key);
}

/**
 * Convert anything a decoder can hand back into something JSON.stringify will
 * accept. BigInt becomes a decimal string, bytes become a hex preview, a Map
 * becomes an object, a Date becomes an ISO string, and a non-finite number
 * becomes its name rather than the null JSON would otherwise emit.
 */
export function toJsonValue(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === "bigint") return (value as bigint).toString();
  if (type === "number") {
    const n = value as number;
    return Number.isFinite(n) ? n : String(n);
  }
  if (type === "string" || type === "boolean") return value;
  if (type === "function" || type === "symbol") return String(value);

  const object = value as object;
  if (object instanceof DataView) {
    return bytesPreview(new Uint8Array(object.buffer, object.byteOffset, object.byteLength));
  }
  if (ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView;
    return bytesPreview(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (object instanceof ArrayBuffer) return bytesPreview(new Uint8Array(object));
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }
  if (object instanceof RegExp) return String(object);
  if (object instanceof Error) return `${object.name}: ${object.message}`;

  if (seen.has(object)) return "[circular reference]";
  if (depth >= MAX_DEPTH) return "[max depth reached]";

  seen.add(object);
  try {
    if (Array.isArray(object)) return object.map((item) => toJsonValue(item, depth + 1, seen));
    if (object instanceof Set) {
      return [...object].map((item) => toJsonValue(item, depth + 1, seen));
    }
    if (object instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of object.entries()) {
        const base = mapKey(key);
        let unique = base;
        let n = 2;
        while (unique in out) unique = `${base} #${n++}`;
        out[unique] = toJsonValue(item, depth + 1, seen);
      }
      return out;
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record);
    // cbor-x hands back a Tag instance for any tag it has no native mapping for.
    if (keys.length === 2 && typeof record.tag === "number" && keys.includes("value")) {
      return { $tag: record.tag, value: toJsonValue(record.value, depth + 1, seen) };
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = toJsonValue(record[key], depth + 1, seen);
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Pretty printed JSON, two space indent, safe for every decodable input. */
export function renderJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value), null, 2) ?? "null";
}

/* ------------------------------------------------------------------ */
/* detection heuristics                                               */
/* ------------------------------------------------------------------ */

interface Hint {
  /** 0 rules the format out, 3 means the first byte is a classic start for it. */
  score: number;
  reason: string;
}

function hexByte(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

const WIRE_TYPE_NAMES: Record<number, string> = {
  0: "varint",
  1: "fixed64",
  2: "length delimited",
  5: "fixed32",
};

/**
 * Cheap first byte read for each format. Only used to order otherwise equal
 * candidates: every reported decode still had to consume the whole input.
 */
export function firstByteHints(bytes: Uint8Array): Record<FormatId, Hint> {
  const b = bytes[0];
  const label = hexByte(b);

  const wireType = b % 8;
  const fieldNumber = Math.floor(b / 8);
  let protobuf: Hint;
  if (fieldNumber === 0 || !(wireType in WIRE_TYPE_NAMES)) {
    protobuf = { score: 0, reason: `first byte ${label} is not a valid protobuf field key` };
  } else {
    protobuf = {
      score: (wireType === 0 || wireType === 2) && fieldNumber <= 15 ? 3 : 2,
      reason: `first byte ${label} is a protobuf field key (field ${fieldNumber}, ${WIRE_TYPE_NAMES[wireType]})`,
    };
  }

  const major = b >> 5;
  let cbor: Hint;
  if (major === 5) cbor = { score: 3, reason: `first byte ${label} is a CBOR map header` };
  else if (major === 4) cbor = { score: 2, reason: `first byte ${label} is a CBOR array header` };
  else if (major === 6) cbor = { score: 2, reason: `first byte ${label} is a CBOR tag` };
  else cbor = { score: 1, reason: `first byte ${label} is a bare CBOR value` };

  let msgpack: Hint;
  if ((b >= 0x80 && b <= 0x8f) || b === 0xde || b === 0xdf) {
    msgpack = { score: 3, reason: `first byte ${label} is a msgpack map header` };
  } else if ((b >= 0x90 && b <= 0x9f) || b === 0xdc || b === 0xdd) {
    msgpack = { score: 2, reason: `first byte ${label} is a msgpack array header` };
  } else if (b >= 0xa0 && b <= 0xbf) {
    msgpack = { score: 2, reason: `first byte ${label} is a msgpack fixed string header` };
  } else if (b === 0xc1) {
    msgpack = { score: 0, reason: `first byte ${label} is never valid in msgpack` };
  } else {
    msgpack = { score: 1, reason: `first byte ${label} is a bare msgpack value` };
  }

  return { protobuf, cbor, msgpack };
}

/* ------------------------------------------------------------------ */
/* decode attempts                                                    */
/* ------------------------------------------------------------------ */

interface Attempt {
  format: FormatId;
  ok: boolean;
  value?: unknown;
  protobuf?: ProtobufResult;
  /** True when nothing had to fall back to a raw hex preview. */
  clean: boolean;
  reason?: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "the decoder rejected these bytes";
}

function attempt(format: FormatId, bytes: Uint8Array): Attempt {
  if (format === "protobuf") {
    const parsed = decodeProtobuf(bytes);
    if (!parsed) {
      return {
        format,
        ok: false,
        clean: false,
        reason: "the tag and length bytes do not line up as a protobuf message",
      };
    }
    return {
      format,
      ok: true,
      value: parsed.value,
      protobuf: parsed,
      clean: parsed.hexFallbacks === 0,
    };
  }

  try {
    // useBigInt64 keeps a msgpack uint64 or int64 exact. Without it the decoder
    // hands back a JS number and anything past 2^53 quietly loses its low digits.
    const value =
      format === "cbor" ? decodeCbor(bytes) : decodeMsgpack(bytes, { useBigInt64: true });
    return { format, ok: true, value, clean: true };
  } catch (error) {
    return { format, ok: false, clean: false, reason: errorText(error) };
  }
}

/* ------------------------------------------------------------------ */
/* entry point                                                        */
/* ------------------------------------------------------------------ */

function byteLengthRow(size: number): string {
  return size < 1024 ? formatByteCount(size) : `${formatByteCount(size)} (${formatBytes(size)})`;
}

function protobufRows(result: ProtobufResult): Record<string, string> {
  const rows: Record<string, string> = {
    "Top level fields": `${result.fieldCount} (field ${result.fieldNumbers.length === 1 ? "number" : "numbers"} ${result.fieldNumbers.join(", ")})`,
  };
  if (result.hexFallbacks > 0) {
    rows["Opaque fields"] =
      `${result.hexFallbacks} shown as a hex preview: not readable text and not a nested message`;
  }
  return rows;
}

export function run(input: Uint8Array | string, opts: BinaryDecoderOpts): Record<string, string> {
  const { bytes, encoding } = toBytes(input);
  if (bytes.length > MAX_INPUT_BYTES) throw tooLarge(bytes.length);

  const inputRow = encoding === "raw bytes" ? "raw bytes" : `${encoding} text`;
  const requested = normalizeFormat(opts?.format);

  if (requested !== "auto") {
    const only = attempt(requested, bytes);
    if (!only.ok) {
      throw new ToolError(
        "undecodable",
        `These bytes are not valid ${FORMAT_LABELS[requested]}: ${only.reason}.`,
        "Switch the Format option back to Auto detect, which tries protobuf, CBOR, and msgpack in turn.",
      );
    }
    const rows: Record<string, string> = {
      Format: FORMAT_LABELS[requested],
      Input: inputRow,
      "Byte length": byteLengthRow(bytes.length),
    };
    if (only.protobuf) Object.assign(rows, protobufRows(only.protobuf));
    rows.Decoded = renderJson(only.value);
    return rows;
  }

  const hints = firstByteHints(bytes);
  const attempts = FORMAT_ORDER.map((format) => attempt(format, bytes));
  const winners = attempts.filter((a) => a.ok);

  if (winners.length === 0) {
    const detail = attempts.map((a) => `${FORMAT_LABELS[a.format]}: ${a.reason}`).join(". ");
    throw new ToolError(
      "undecodable",
      `These bytes did not decode as protobuf, CBOR, or msgpack. ${detail}.`,
      "Pick one format in the Format option to see that decoder's own error, and check the payload is not gzipped, framed with a length prefix, or encrypted.",
    );
  }

  // Fully clean decodes first, then the first byte hint, then a fixed order so
  // the answer never depends on which decoder happened to run first.
  winners.sort((a, b) => {
    if (a.clean !== b.clean) return a.clean ? -1 : 1;
    const byHint = hints[b.format].score - hints[a.format].score;
    if (byHint !== 0) return byHint;
    return FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format);
  });

  const won = winners[0];
  const rows: Record<string, string> = {
    Format: `${FORMAT_LABELS[won.format]} (auto detected)`,
    Input: inputRow,
    "Byte length": byteLengthRow(bytes.length),
    Detection: `${hints[won.format].reason}, and every byte was consumed with nothing left over.`,
  };

  const others = winners.slice(1);
  if (others.length > 0) {
    rows["Also decodes as"] =
      `${others.map((a) => FORMAT_LABELS[a.format]).join(" and ")}. These formats share byte patterns, so a short payload is often valid in more than one of them. Pick a format in the Format option if the JSON below looks wrong.`;
  }

  if (won.protobuf) Object.assign(rows, protobufRows(won.protobuf));
  rows.Decoded = renderJson(won.value);
  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  BinaryDecoderOpts
>;
