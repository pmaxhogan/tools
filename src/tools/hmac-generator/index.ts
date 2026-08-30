import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { ToolError, type ToolLogic } from "../types";

export interface HmacOpts {
  /** "compute" (default) or "verify". */
  mode?: string;
  /**
   * The secret key. Declared `sensitive` in meta.ts, so the panel masks it and
   * the shell never writes it to the URL fragment.
   */
  key?: string;
  /** "sha256" (default), "sha1", "sha384", or "sha512". */
  algorithm?: string;
  /** Digest encoding: "hex" (default), "base64", or "base64url". */
  encoding?: string;
  /** How the key text is read: "utf8" (default), "hex", or "base64". */
  keyEncoding?: string;
  /** Verify mode only: the MAC the message is expected to produce. */
  expected?: string;
  [key: string]: unknown;
}

export type HmacResult = Record<string, string>;

/**
 * The line that separates the message from the secret key in the main input.
 *
 * The key has its own option now, flagged sensitive, which the panel masks and
 * the shell never writes to the URL fragment. This separator is the older way
 * in and is still honored so notes and links written before the option existed
 * keep working: when the Key option is empty and the input carries a --- line,
 * the text below the last one is read as the key.
 */
const SEPARATOR_RE = /^-{3,}$/;

const KEY_FIX =
  "Type or paste the secret key into the Key option. Text below a line of three dashes in the message box still works, which is how this tool took the key before the option existed.";

/* ------------------------------------------------------------------ */
/* Encodings                                                           */
/* ------------------------------------------------------------------ */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (RFC 4648 section 4), written by hand so this file stays Buffer-free. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64_CHARS[(chunk >> 18) & 63];
    out += B64_CHARS[(chunk >> 12) & 63];
    out += b1 !== undefined ? B64_CHARS[(chunk >> 6) & 63] : "=";
    out += b2 !== undefined ? B64_CHARS[chunk & 63] : "=";
  }
  return out;
}

/** URL safe base64 (RFC 4648 section 5): -_ instead of +/ and no padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes either base64 flavor. Returns null when the text is not valid base64. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "")
    .replace(/=+$/, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decodes hex, tolerating a 0x prefix and internal whitespace. Null when invalid. */
export function fromHex(text: string): Uint8Array | null {
  const clean = text.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (clean.length % 2 !== 0) return null;
  if (clean.length === 0) return new Uint8Array(0);
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ------------------------------------------------------------------ */
/* Input splitting                                                     */
/* ------------------------------------------------------------------ */

export interface SplitInput {
  message: string;
  key: string;
  /** False when the input carries no --- line, so all of it is the message. */
  hasKey: boolean;
}

/**
 * Splits "message, then a --- line, then the key" into its two halves.
 *
 * The LAST separator line wins, so a message that itself contains a row of
 * dashes (Markdown front matter, an email signature) still round-trips. CRLF
 * is normalized first so pasting from a Windows editor behaves the same. An
 * input with no separator is all message, and the key comes from the option.
 */
export function splitMessageAndKey(input: string): SplitInput {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i]!.trim())) at = i;
  }
  if (at === -1) return { message: normalized, key: "", hasKey: false };
  const key = lines.slice(at + 1).join("\n");
  return { message: lines.slice(0, at).join("\n"), key, hasKey: key.trim() !== "" };
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

const HASHES = { sha1, sha256, sha384, sha512 } as const;

const HASH_LABELS: Record<keyof typeof HASHES, string> = {
  sha1: "HMAC-SHA1",
  sha256: "HMAC-SHA256",
  sha384: "HMAC-SHA384",
  sha512: "HMAC-SHA512",
};

/** Internal block size of each hash, the size HMAC pads or hashes the key to. */
const BLOCK_BYTES: Record<keyof typeof HASHES, number> = {
  sha1: 64,
  sha256: 64,
  sha384: 128,
  sha512: 128,
};

function pickAlgorithm(raw: unknown): keyof typeof HASHES {
  const value = typeof raw === "string" && raw ? raw.toLowerCase().replace(/-/g, "") : "sha256";
  if (value in HASHES) return value as keyof typeof HASHES;
  throw new ToolError(
    "bad-option",
    `The option "algorithm" does not recognize "${String(raw)}".`,
    "Choose SHA-1, SHA-256, SHA-384, or SHA-512. MD5 is deliberately not offered.",
  );
}

function encodeDigest(bytes: Uint8Array, encoding: string): string {
  if (encoding === "hex") return toHex(bytes);
  if (encoding === "base64") return toBase64(bytes);
  if (encoding === "base64url") return toBase64Url(bytes);
  throw new ToolError(
    "bad-option",
    `The option "encoding" does not recognize "${encoding}".`,
    "Choose hex, base64, or base64url.",
  );
}

function decodeKey(text: string, keyEncoding: string): Uint8Array {
  if (keyEncoding === "utf8") return new TextEncoder().encode(text);
  if (keyEncoding === "hex") {
    const bytes = fromHex(text);
    if (!bytes)
      throw new ToolError(
        "bad-key",
        "The key is not valid hexadecimal.",
        'Use an even number of characters from 0-9 and a-f, or set "Key format" back to text.',
      );
    return bytes;
  }
  if (keyEncoding === "base64") {
    const bytes = fromBase64(text);
    if (!bytes)
      throw new ToolError(
        "bad-key",
        "The key is not valid base64.",
        'Paste the key exactly as it was issued, or set "Key format" back to text.',
      );
    return bytes;
  }
  throw new ToolError(
    "bad-option",
    `The option "keyEncoding" does not recognize "${keyEncoding}".`,
    "Choose text, hex, or base64.",
  );
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/**
 * Compares two byte strings without an early exit, so the time taken does not
 * depend on how many leading bytes matched. Length is compared first and is
 * not a secret: a MAC's length is fixed by its algorithm and public.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Reads an expected MAC in whichever of the three encodings it was written in.
 * Returns null when it decodes in none of them, or decodes to the wrong length.
 */
export function parseExpected(text: string, digestBytes: number): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const hex = /^(0x)?[0-9a-fA-F\s]+$/.test(trimmed) ? fromHex(trimmed) : null;
  if (hex && hex.length === digestBytes) return hex;
  const b64 = fromBase64(trimmed);
  if (b64 && b64.length === digestBytes) return b64;
  return null;
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export function run(input: string, opts: HmacOpts): HmacResult {
  const text = input ?? "";
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to authenticate.",
      "Type or paste the message here, and put the secret key in the Key option.",
    );
  }

  /*
   * Two ways in, and the option wins. A key in the Key option means the whole
   * input is the message, dashes and all. Only when that option is empty does
   * the older "--- then the key" form apply, so a note or a link written
   * before the option existed still computes the same MAC.
   */
  const optionKey = typeof opts.key === "string" ? opts.key : "";
  const split = splitMessageAndKey(text);
  const usingOption = optionKey.trim() !== "";
  const message = usingOption ? text.replace(/\r\n/g, "\n") : split.message;
  const key = usingOption ? optionKey : split.key;
  if (key.trim() === "") {
    throw new ToolError(
      "empty-key",
      "There is no secret key to authenticate the message with.",
      KEY_FIX,
    );
  }

  const algorithm = pickAlgorithm(opts.algorithm);
  const encoding = typeof opts.encoding === "string" && opts.encoding ? opts.encoding : "hex";
  const keyEncoding =
    typeof opts.keyEncoding === "string" && opts.keyEncoding ? opts.keyEncoding : "utf8";

  const keyBytes = decodeKey(key, keyEncoding);
  const digest = hmac(HASHES[algorithm], keyBytes, new TextEncoder().encode(message));
  const encoded = encodeDigest(digest, encoding);

  const base: HmacResult = {
    Algorithm: `${HASH_LABELS[algorithm]} (RFC 2104)`,
    MAC: encoded,
    "Digest size": `${digest.length} bytes (${digest.length * 8} bits)`,
    "Key size": `${keyBytes.length} byte${keyBytes.length === 1 ? "" : "s"}`,
  };

  if (keyBytes.length > BLOCK_BYTES[algorithm]) {
    base.Note = `HMAC hashes any key longer than the ${BLOCK_BYTES[algorithm]} byte block size down to a ${digest.length} byte key first, so a key this long adds no extra strength.`;
  } else if (keyBytes.length < 16) {
    base.Note = `A ${keyBytes.length} byte key is short for a message authentication code. RFC 2104 recommends a key at least as long as the digest, so ${digest.length} bytes or more here.`;
  }

  if (opts.mode !== "verify") return base;

  const expectedText = typeof opts.expected === "string" ? opts.expected : "";
  if (expectedText.trim() === "") {
    throw new ToolError(
      "verify-needs-expected",
      "Verify mode needs the MAC you are checking against.",
      'Paste it into the "Expected MAC" option, in hex or base64.',
    );
  }
  const expected = parseExpected(expectedText, digest.length);
  if (!expected) {
    throw new ToolError(
      "bad-expected",
      `The expected MAC is not readable as ${digest.length} bytes of hex or base64.`,
      `${HASH_LABELS[algorithm]} produces ${digest.length} bytes, which is ${digest.length * 2} hex characters. Check the algorithm matches the one that produced it.`,
    );
  }

  const match = constantTimeEqual(digest, expected);
  return {
    ...base,
    "Expected MAC": encodeDigest(expected, encoding),
    Match: match ? "yes" : "no",
    Comparison: match
      ? "The computed MAC equals the expected MAC. The message and key are the ones that produced it."
      : "The computed MAC differs from the expected MAC. Either the message changed, the key is wrong, or the MAC was produced with a different algorithm.",
  };
}

export default { run } satisfies ToolLogic<string, HmacResult, HmacOpts>;
