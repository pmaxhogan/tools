import { ToolError, type ToolLogic } from "../types";

export interface TextEncrypterOpts {
  /** "encrypt" (default) or "decrypt". */
  mode?: string;
  /**
   * The passphrase. Declared `sensitive` in meta.ts, so the panel masks it and
   * the shell never writes it to the URL fragment.
   */
  password?: string;
  /** PBKDF2 iterations used when encrypting. Decryption reads its own from the message. */
  iterations?: number;
  /**
   * Deterministic salt and nonce for tests, as hex. Never a panel option:
   * reusing a nonce with the same key destroys AES-GCM's security, so real
   * use always draws fresh random bytes.
   */
  fixedRandom?: string;
  [key: string]: unknown;
}

export type TextEncrypterResult = Record<string, string>;

/**
 * Armored message layout, version 1:
 *
 *   byte  0       format version (1)
 *   bytes 1..4    PBKDF2 iteration count, big endian uint32
 *   bytes 5..20   PBKDF2 salt (16 bytes)
 *   bytes 21..32  AES-GCM nonce (12 bytes)
 *   bytes 33..    AES-256-GCM ciphertext with its 16 byte tag appended
 *
 * The whole thing is base64url with the padding stripped, so it survives a
 * URL, a chat message, and a QR code without escaping. The first 33 bytes are
 * also passed to AES-GCM as additional authenticated data, so editing the
 * version or the iteration count makes decryption fail rather than silently
 * changing how the key is derived.
 */
export const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const HEADER_BYTES = 1 + 4 + SALT_BYTES + NONCE_BYTES;
/** AES-GCM appends a 16 byte authentication tag, so nothing shorter can be valid. */
const TAG_BYTES = 16;

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256, and the default here. */
export const DEFAULT_ITERATIONS = 600_000;
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 5_000_000;
/** Below this the derivation is fast enough to be worth brute forcing offline. */
const WEAK_ITERATIONS = 100_000;

const SEPARATOR_RE = /^-{3,}$/;

/* ------------------------------------------------------------------ */
/* Base64url                                                           */
/* ------------------------------------------------------------------ */

const B64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64URL_CHARS[(chunk >> 18) & 63];
    out += B64URL_CHARS[(chunk >> 12) & 63];
    if (b1 !== undefined) out += B64URL_CHARS[(chunk >> 6) & 63];
    if (b2 !== undefined) out += B64URL_CHARS[chunk & 63];
  }
  return out;
}

/** Decodes base64url, also tolerating the +/ alphabet and padding. Null when invalid. */
export function fromBase64Url(text: string): Uint8Array | null {
  const clean = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (clean.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64URL_CHARS.indexOf(ch);
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

function fromHex(text: string): Uint8Array | null {
  const clean = text.trim().replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Input splitting                                                     */
/* ------------------------------------------------------------------ */

export interface SplitInput {
  payload: string;
  password: string;
  /** False when the input carries no --- line, so all of it is the message. */
  hasPassword: boolean;
}

/**
 * Splits "message, then a --- line, then the password".
 *
 * The passphrase has its own option now, flagged sensitive, which the panel
 * masks and the shell never writes to the URL fragment. This separator is the
 * older way in and is still honored so a note or a link written before the
 * option existed keeps working: when the Password option is empty and the
 * input carries a --- line, the text below the last one is the passphrase.
 *
 * The LAST separator wins so a message containing its own row of dashes still
 * round-trips, and CRLF is normalized first.
 */
export function splitPayloadAndPassword(input: string): SplitInput {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i]!.trim())) at = i;
  }
  if (at === -1) return { payload: normalized, password: "", hasPassword: false };
  const password = lines.slice(at + 1).join("\n");
  return {
    payload: lines.slice(0, at).join("\n"),
    password,
    hasPassword: password.trim() !== "",
  };
}

/* ------------------------------------------------------------------ */
/* Key derivation                                                      */
/* ------------------------------------------------------------------ */

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

function pickIterations(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_ITERATIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new ToolError(
      "bad-option",
      `The option "iterations" must be a whole number from ${MIN_ITERATIONS} to ${MAX_ITERATIONS}.`,
      `Leave it at the default of ${DEFAULT_ITERATIONS}, which is the current recommended floor for PBKDF2 with SHA-256.`,
    );
  }
  return n;
}

function randomBytes(count: number, fixed: Uint8Array | null, offset: number): Uint8Array {
  if (fixed) {
    if (fixed.length < offset + count) {
      throw new ToolError(
        "bad-option",
        `The option "fixedRandom" needs at least ${SALT_BYTES + NONCE_BYTES} bytes of hex.`,
        "Supply 56 hex characters, or remove the option to use real randomness.",
      );
    }
    return fixed.slice(offset, offset + count);
  }
  const out = new Uint8Array(count);
  crypto.getRandomValues(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Encrypt and decrypt                                                 */
/* ------------------------------------------------------------------ */

async function encrypt(
  plaintext: string,
  password: string,
  opts: TextEncrypterOpts,
): Promise<TextEncrypterResult> {
  if (plaintext === "") {
    throw new ToolError(
      "empty-message",
      "There is no message to encrypt.",
      "Type the text you want to protect into the box, and put the passphrase in the Password option.",
    );
  }
  const iterations = pickIterations(opts.iterations);
  const fixed =
    typeof opts.fixedRandom === "string" && opts.fixedRandom.trim() !== ""
      ? fromHex(opts.fixedRandom)
      : null;
  if (typeof opts.fixedRandom === "string" && opts.fixedRandom.trim() !== "" && !fixed) {
    throw new ToolError(
      "bad-option",
      'The option "fixedRandom" is not valid hexadecimal.',
      "Supply an even number of hex characters, or remove the option.",
    );
  }

  const salt = randomBytes(SALT_BYTES, fixed, 0);
  const nonce = randomBytes(NONCE_BYTES, fixed, SALT_BYTES);
  const header = concat(new Uint8Array([FORMAT_VERSION]), uint32(iterations), salt, nonce);

  const key = await deriveKey(password, salt, iterations);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );

  const armored = toBase64Url(concat(header, ciphertext));
  const result: TextEncrypterResult = {
    Mode: "Encrypted",
    "Armored message": armored,
    Parameters: `AES-256-GCM, PBKDF2-HMAC-SHA256 with ${iterations.toLocaleString("en-US")} iterations, ${SALT_BYTES} byte salt, ${NONCE_BYTES} byte nonce, 16 byte tag`,
    Size: `${plaintext.length} character${plaintext.length === 1 ? "" : "s"} in, ${armored.length} characters out`,
    "To read it back":
      "Send the armored message to whoever needs it, then share the passphrase another way. They paste the message here, type the passphrase into the Password option, and switch Mode to Decrypt.",
  };
  if (iterations < WEAK_ITERATIONS) {
    result.Warning = `Only ${iterations.toLocaleString("en-US")} PBKDF2 iterations were used, which makes an offline guessing attack on the password much cheaper. Use ${DEFAULT_ITERATIONS.toLocaleString("en-US")} unless you have a reason not to.`;
  }
  return result;
}

async function decrypt(armor: string, password: string): Promise<TextEncrypterResult> {
  const trimmed = armor.trim();
  if (trimmed === "") {
    throw new ToolError(
      "empty-message",
      "There is no armored message to decrypt.",
      "Paste the encrypted message into the box, and put the passphrase in the Password option.",
    );
  }
  const bytes = fromBase64Url(trimmed);
  if (!bytes) {
    throw new ToolError(
      "bad-armor",
      "That does not look like an armored message: it is not valid base64url.",
      "Paste the message exactly as it was produced, with no quotes or trailing text. If you meant to encrypt, switch Mode to Encrypt.",
    );
  }
  if (bytes.length < HEADER_BYTES + TAG_BYTES) {
    throw new ToolError(
      "bad-armor",
      `An armored message is at least ${HEADER_BYTES + TAG_BYTES} bytes, and this one decodes to ${bytes.length}.`,
      "The message is truncated. Copy the whole thing, including the last characters.",
    );
  }
  const version = bytes[0]!;
  if (version !== FORMAT_VERSION) {
    throw new ToolError(
      "unsupported-version",
      `This message says it is format version ${version}, and this tool reads version ${FORMAT_VERSION}.`,
      "Decrypt it with the version of the tool that produced it.",
    );
  }
  const iterations = readUint32(bytes, 1);
  if (iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new ToolError(
      "bad-armor",
      `This message asks for ${iterations.toLocaleString("en-US")} PBKDF2 iterations, which is outside the range this tool will run.`,
      "The message is probably corrupted. Check that it was copied in full.",
    );
  }

  const header = bytes.subarray(0, HEADER_BYTES);
  const salt = bytes.subarray(5, 5 + SALT_BYTES);
  const nonce = bytes.subarray(5 + SALT_BYTES, HEADER_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES);

  const key = await deriveKey(password, salt, iterations);
  let plainBytes: ArrayBuffer;
  try {
    plainBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // AES-GCM cannot tell a wrong key from a tampered message: both fail the
    // same authentication check, and the browser reports both as one opaque
    // error. Saying so is more useful than repeating the browser's message.
    throw new ToolError(
      "decrypt-failed",
      "That password did not decrypt this message.",
      "Check the password, including its capitalization and any trailing spaces. If the password is right, the message was altered in transit: AES-GCM refuses to decrypt a message whose bytes changed.",
    );
  }

  const plaintext = new TextDecoder().decode(plainBytes);
  return {
    Mode: "Decrypted",
    Plaintext: plaintext,
    Parameters: `AES-256-GCM, PBKDF2-HMAC-SHA256 with ${iterations.toLocaleString("en-US")} iterations, format version ${version}`,
    Size: `${ciphertext.length} bytes in, ${plaintext.length} character${plaintext.length === 1 ? "" : "s"} out`,
  };
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export async function run(input: string, opts: TextEncrypterOpts): Promise<TextEncrypterResult> {
  const text = input ?? "";
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to encrypt or decrypt.",
      "Type the message into the box, and put the passphrase in the Password option.",
    );
  }

  /*
   * Two ways in, and the option wins. A passphrase in the Password option
   * means the whole input is the message, dashes and all. Only when that
   * option is empty does the older "--- then the password" form apply, so a
   * note written before the option existed still decrypts.
   */
  const optionPassword = typeof opts.password === "string" ? opts.password : "";
  const split = splitPayloadAndPassword(text);
  const usingOption = optionPassword.trim() !== "";
  const payload = usingOption ? text.replace(/\r\n/g, "\n") : split.payload;
  const password = usingOption ? optionPassword : split.password;
  if (password.trim() === "") {
    throw new ToolError(
      "empty-password",
      "There is no passphrase to encrypt or decrypt with.",
      "Type the passphrase into the Password option. Text below a line of three dashes in the message box still works, which is how this tool took the passphrase before the option existed.",
    );
  }

  const mode = typeof opts.mode === "string" && opts.mode ? opts.mode : "encrypt";
  if (mode === "encrypt") return encrypt(payload, password, opts);
  if (mode === "decrypt") return decrypt(payload, password);
  throw new ToolError(
    "bad-option",
    `The option "mode" does not recognize "${mode}".`,
    "Choose Encrypt or Decrypt.",
  );
}

export default { run } satisfies ToolLogic<string, TextEncrypterResult, TextEncrypterOpts>;
