import { argon2d, argon2i, argon2id, argon2Verify, bcrypt, bcryptVerify, scrypt } from "hash-wasm";
import { ToolError, type ToolLogic } from "../types";

export interface BcryptOpts {
  /** 'hash' | 'verify' */
  mode: string;
  /** 'bcrypt' | 'argon2id' | 'argon2i' | 'argon2d' | 'scrypt' */
  algorithm: string;
  /** bcrypt work factor, 4..15. */
  cost: number;
  /** argon2 passes, 1..10. */
  iterations: number;
  /** argon2 memory in kibibytes, 8192..1048576. */
  memoryKiB: number;
  /** argon2 lanes, 1..8. */
  parallelism: number;
  /** argon2 output size in bytes, 16..64. */
  hashLength: number;
  /** scrypt cost as log2(N), 10..20. */
  scryptN: number;
  /**
   * Salt as 16 bytes of hex. Deliberately NOT a panel option: real use always
   * wants a fresh random salt. Exposed only so tests can pin exact output.
   */
  salt?: string;
  [key: string]: unknown;
}

export type BcryptResult = Record<string, string>;

/** scrypt block size and parallelism are fixed; only the cost factor is tunable. */
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** scrypt has no standard encoded form, so this tool always derives 32 bytes. */
export const SCRYPT_HASH_LENGTH = 32;
/** bcrypt hashes the first 72 bytes of a password and ignores the rest. */
export const BCRYPT_MAX_BYTES = 72;
/** Random salts are 16 bytes, the size bcrypt requires and a good size for the rest. */
export const SALT_BYTES = 16;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** PHC-style base64: standard alphabet, no padding (matches argon2 encoded output). */
export function toB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 0b11) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += B64[((b1 & 0b1111) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += B64[b2 & 0b111111]!;
  }
  return out;
}

/** Inverse of toB64. Returns null when the string is not valid base64. */
export function fromB64(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, "");
  if (clean.length === 0) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
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

function hexToBytes(text: string): Uint8Array | null {
  const clean = text.trim().replace(/^0x/i, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a whole-number option, falling back to the default when the panel has
 * not supplied one. Out-of-range values are a user error, not a silent clamp:
 * a bcrypt cost of 31 would lock the tab up for hours.
 */
function intOption(
  raw: unknown,
  id: string,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ToolError(
      "bad-option",
      `The option "${id}" (${label}) must be a whole number from ${min} to ${max}.`,
      `Set ${label} to a value between ${min} and ${max}. The default is ${fallback}.`,
    );
  }
  return n;
}

function saltBytes(opts: BcryptOpts): Uint8Array {
  const given = typeof opts.salt === "string" ? opts.salt.trim() : "";
  if (!given) {
    const bytes = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(bytes);
    return bytes;
  }
  const parsed = hexToBytes(given);
  if (!parsed || parsed.length !== SALT_BYTES) {
    throw new ToolError(
      "bad-option",
      `The option "salt" must be exactly ${SALT_BYTES} bytes of hex (${SALT_BYTES * 2} hex characters).`,
      `Remove the salt to get a fresh random one, or supply ${SALT_BYTES * 2} hex characters.`,
    );
  }
  return parsed;
}

function mib(kib: number): string {
  const value = kib / 1024;
  return Number.isInteger(value) ? `${value} MiB` : `${value.toFixed(1)} MiB`;
}

function approxTime(ms: number): string {
  if (ms < 1) return "under 1 ms";
  if (ms < 1000) return `about ${Math.round(ms)} ms`;
  if (ms < 10000) return `about ${(ms / 1000).toFixed(1)} s`;
  return `about ${Math.round(ms / 1000)} s`;
}

const TIME_SUFFIX = "per hash on a typical laptop (rough estimate, not measured)";

const VERIFY_HINT =
  "Switch Mode to Verify, then paste the password on the first line and this hash on the second.";

/** Rough cost curves anchored on measured wasm timings. Never a promise. */
function bcryptTimeHint(cost: number): string {
  return `${approxTime(2 ** (cost - 10) * 100)} ${TIME_SUFFIX}`;
}

function argon2TimeHint(iterations: number, memoryKiB: number): string {
  return `${approxTime(iterations * (memoryKiB / 1024) * 2)} ${TIME_SUFFIX}`;
}

function scryptTimeHint(logN: number): string {
  const memoryMiB = (2 ** logN * SCRYPT_R * 128) / 1024 / 1024;
  return `${approxTime(memoryMiB * 5)} ${TIME_SUFFIX}`;
}

function bcryptParams(cost: number): string {
  return `cost ${cost} (2^${cost} = ${2 ** cost} rounds), ${SALT_BYTES} byte salt`;
}

function argon2Params(
  name: string,
  version: number,
  memoryKiB: number,
  iterations: number,
  parallelism: number,
  hashLength?: number,
): string {
  const parts = [
    `${name} v${version}`,
    `memory ${memoryKiB} KiB (${mib(memoryKiB)})`,
    `iterations ${iterations}`,
    `parallelism ${parallelism}`,
  ];
  if (hashLength !== undefined) parts.push(`hash length ${hashLength} bytes`);
  return parts.join(", ");
}

function scryptParams(logN: number, r: number, p: number, hashLength: number): string {
  const memoryMiB = (2 ** logN * r * 128) / 1024 / 1024;
  return `N ${2 ** logN} (log2 N = ${logN}), r ${r}, p ${p}, memory ${memoryMiB} MiB, hash length ${hashLength} bytes`;
}

const SCRYPT_FORMAT_NOTE =
  "scrypt has no standard encoded string, so this tool writes $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash> with the salt and hash in unpadded base64. Verify mode reads that same format back.";

const ARGON2_MEMORY_WARN_KIB = 262144;

const ARGON2_NAMES: Record<string, "argon2id" | "argon2i" | "argon2d"> = {
  argon2id: "argon2id",
  argon2i: "argon2i",
  argon2d: "argon2d",
};

const ARGON2_FNS = { argon2id, argon2i, argon2d };

/** Recognized hash prefixes. $2x$ is deliberately absent: it is the buggy variant. */
const BCRYPT_RE = /^\$(2[aby])\$(\d{2})\$([./A-Za-z0-9]{53})$/;
const BCRYPT_PREFIX_RE = /^\$2[aby]\$/;
const ARGON2_PREFIX_RE = /^\$argon2(id|i|d)\$/;
const SCRYPT_PREFIX_RE = /^\$scrypt\$/;
const ARGON2_RE =
  /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const SCRYPT_RE = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** True when a pasted line carries a prefix this tool knows how to verify. */
export function looksLikeHash(line: string): boolean {
  return BCRYPT_PREFIX_RE.test(line) || ARGON2_PREFIX_RE.test(line) || SCRYPT_PREFIX_RE.test(line);
}

async function hashMode(password: string, opts: BcryptOpts): Promise<BcryptResult> {
  const algorithm =
    typeof opts.algorithm === "string" && opts.algorithm ? opts.algorithm : "bcrypt";
  const passwordBytes = new TextEncoder().encode(password);

  if (algorithm === "bcrypt") {
    const cost = intOption(opts.cost, "cost", "Bcrypt cost", 4, 15, 10);
    const salt = saltBytes(opts);
    // hash-wasm refuses a password over 72 bytes, so do the truncation bcrypt
    // itself would do and say so out loud instead of failing.
    const truncated = passwordBytes.length > BCRYPT_MAX_BYTES;
    const used = truncated ? passwordBytes.subarray(0, BCRYPT_MAX_BYTES) : passwordBytes;
    const encoded = await bcrypt({
      password: used,
      salt,
      costFactor: cost,
      outputType: "encoded",
    });
    // hash-wasm labels its output $2a$. The $2b$ revision is the same
    // algorithm for any password bcrypt actually hashes (the $2a$ vs $2b$
    // difference only concerns a wraparound bug on inputs over 255 bytes,
    // which the 72 byte truncation above rules out), and $2b$ is what every
    // current bcrypt library emits, so the modern prefix is used here.
    const modern = encoded.startsWith("$2a$") ? `$2b$${encoded.slice(4)}` : encoded;
    const result: BcryptResult = {
      Algorithm: "bcrypt",
      Parameters: bcryptParams(cost),
      Hash: modern,
      "Time hint": bcryptTimeHint(cost),
      "Verify hint": VERIFY_HINT,
    };
    if (truncated) {
      const ignored = passwordBytes.length - BCRYPT_MAX_BYTES;
      const tail = ignored === 1 ? "the last byte was" : `the last ${ignored} bytes were`;
      result.Warning = `bcrypt hashes only the first ${BCRYPT_MAX_BYTES} bytes of a password. This one is ${passwordBytes.length} bytes, so ${tail} ignored. Use argon2id if the whole password has to count.`;
    }
    return result;
  }

  const argon2Name = ARGON2_NAMES[algorithm];
  if (argon2Name) {
    const iterations = intOption(opts.iterations, "iterations", "Argon2 iterations", 1, 10, 3);
    const memoryKiB = intOption(opts.memoryKiB, "memoryKiB", "Argon2 memory", 8192, 1048576, 65536);
    const parallelism = intOption(opts.parallelism, "parallelism", "Argon2 parallelism", 1, 8, 1);
    const hashLength = intOption(opts.hashLength, "hashLength", "Argon2 hash length", 16, 64, 32);
    const salt = saltBytes(opts);
    const encoded = await ARGON2_FNS[argon2Name]({
      password: passwordBytes,
      salt,
      iterations,
      parallelism,
      memorySize: memoryKiB,
      hashLength,
      outputType: "encoded",
    });
    const result: BcryptResult = {
      Algorithm: argon2Name,
      Parameters: argon2Params(argon2Name, 19, memoryKiB, iterations, parallelism, hashLength),
      Hash: encoded,
      "Time hint": argon2TimeHint(iterations, memoryKiB),
      "Verify hint": VERIFY_HINT,
    };
    if (memoryKiB > ARGON2_MEMORY_WARN_KIB) {
      result.Note = `Memory above ${ARGON2_MEMORY_WARN_KIB} KiB (${mib(ARGON2_MEMORY_WARN_KIB)}) can be slow in a browser tab and may fail outright on a phone. A server can afford more than a browser can.`;
    }
    return result;
  }

  if (algorithm === "scrypt") {
    const logN = intOption(opts.scryptN, "scryptN", "Scrypt cost (log2 N)", 10, 20, 15);
    const salt = saltBytes(opts);
    const hex = await scrypt({
      password: passwordBytes,
      salt,
      costFactor: 2 ** logN,
      blockSize: SCRYPT_R,
      parallelism: SCRYPT_P,
      hashLength: SCRYPT_HASH_LENGTH,
      outputType: "hex",
    });
    const digest = hexToBytes(hex) ?? new Uint8Array(0);
    const encoded = `$scrypt$ln=${logN},r=${SCRYPT_R},p=${SCRYPT_P}$${toB64(salt)}$${toB64(digest)}`;
    return {
      Algorithm: "scrypt",
      Parameters: scryptParams(logN, SCRYPT_R, SCRYPT_P, SCRYPT_HASH_LENGTH),
      Hash: encoded,
      "Time hint": scryptTimeHint(logN),
      "Verify hint": VERIFY_HINT,
      Note: SCRYPT_FORMAT_NOTE,
    };
  }

  throw new ToolError(
    "bad-option",
    `The option "algorithm" does not recognize "${algorithm}".`,
    "Choose bcrypt, argon2id, argon2i, argon2d, or scrypt.",
  );
}

function badHash(detail: string): ToolError {
  return new ToolError(
    "bad-hash",
    `That hash could not be read: ${detail}.`,
    "Paste the complete hash exactly as it was stored, with no line breaks or stray characters.",
  );
}

async function verifyBcrypt(password: string, hash: string): Promise<BcryptResult> {
  const parsed = BCRYPT_RE.exec(hash);
  const prefix = parsed ? parsed[1]! : hash.slice(1, 3);
  // hash-wasm reads $2a$ and $2b$; $2y$ is the same algorithm under a PHP-era
  // label, so relabel it rather than rejecting a perfectly good hash.
  const normalized = prefix === "2y" ? `$2b$${hash.slice(4)}` : hash;
  const passwordBytes = new TextEncoder().encode(password);
  const used =
    passwordBytes.length > BCRYPT_MAX_BYTES
      ? passwordBytes.subarray(0, BCRYPT_MAX_BYTES)
      : passwordBytes;

  let match: boolean;
  try {
    match = await bcryptVerify({ password: used, hash: normalized });
  } catch (err) {
    throw badHash(err instanceof Error ? err.message.toLowerCase() : "bcrypt rejected it");
  }

  const cost = parsed ? Number(parsed[2]) : Number.NaN;
  const result: BcryptResult = {
    "Algorithm detected": `bcrypt ($${prefix}$ prefix)`,
    Parameters: Number.isFinite(cost) ? bcryptParams(cost) : "could not be read from the hash",
    Match: match ? "yes" : "no",
  };
  if (prefix === "2y") {
    result.Note =
      "This hash uses the $2y$ prefix, which was normalized to $2b$ before verifying. Both prefixes describe the same bcrypt algorithm.";
  }
  if (passwordBytes.length > BCRYPT_MAX_BYTES) {
    result.Warning = `bcrypt compares only the first ${BCRYPT_MAX_BYTES} bytes of a password, so nothing after byte ${BCRYPT_MAX_BYTES} affected this result.`;
  }
  return result;
}

/** Largest m= a pasted argon2 hash may ask for before verify refuses (1 GiB). */
const ARGON2_VERIFY_MAX_MEMORY_KIB = 1_048_576;

async function verifyArgon2(password: string, hash: string): Promise<BcryptResult> {
  const pre = ARGON2_RE.exec(hash);
  if (pre) {
    const memory = Number(pre[3]);
    if (memory > ARGON2_VERIFY_MAX_MEMORY_KIB) {
      throw new ToolError(
        "bad-hash",
        `This hash asks for ${memory} KiB of memory to verify, which is more than this page will allocate.`,
        `Hashes up to m=${ARGON2_VERIFY_MAX_MEMORY_KIB} (1 GiB) can be verified here; check a larger one with a native argon2 tool.`,
      );
    }
  }
  let match: boolean;
  try {
    match = await argon2Verify({ password: new TextEncoder().encode(password), hash });
  } catch (err) {
    throw badHash(err instanceof Error ? err.message.toLowerCase() : "argon2 rejected it");
  }
  const parsed = ARGON2_RE.exec(hash);
  const digest = parsed ? fromB64(parsed[7]!) : null;
  const fallbackName = `argon2${hash.slice(7).split("$")[0] ?? ""}`;
  return {
    "Algorithm detected": parsed ? `argon2${parsed[1]!}` : fallbackName,
    Parameters: parsed
      ? argon2Params(
          `argon2${parsed[1]!}`,
          Number(parsed[2]),
          Number(parsed[3]),
          Number(parsed[4]),
          Number(parsed[5]),
          digest ? digest.length : undefined,
        )
      : "could not be read from the hash",
    Match: match ? "yes" : "no",
  };
}

async function verifyScrypt(password: string, hash: string): Promise<BcryptResult> {
  const parsed = SCRYPT_RE.exec(hash);
  if (!parsed) throw badHash("it is not in the $scrypt$ln=..,r=..,p=..$salt$hash format");
  const logN = Number(parsed[1]);
  const r = Number(parsed[2]);
  const p = Number(parsed[3]);
  const salt = fromB64(parsed[4]!);
  const digest = fromB64(parsed[5]!);
  if (!salt || !digest) throw badHash("the salt or the hash is not valid base64");
  if (logN < 1 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw badHash("its parameters are outside the range this tool will run in a browser tab");
  }
  let hex: string;
  try {
    hex = await scrypt({
      password: new TextEncoder().encode(password),
      salt,
      costFactor: 2 ** logN,
      blockSize: r,
      parallelism: p,
      hashLength: digest.length,
      outputType: "hex",
    });
  } catch (err) {
    throw badHash(err instanceof Error ? err.message.toLowerCase() : "scrypt rejected it");
  }
  return {
    "Algorithm detected": "scrypt",
    Parameters: scryptParams(logN, r, p, digest.length),
    Match: hex === bytesToHex(digest) ? "yes" : "no",
    Note: SCRYPT_FORMAT_NOTE,
  };
}

async function verifyMode(input: string): Promise<BcryptResult> {
  const lines = input
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    throw new ToolError(
      "verify-needs-two",
      "Verify mode needs two lines: the password and the hash.",
      "Put the password on the first line and the hash on the second line.",
    );
  }

  // The documented order is password first, so test the second line first.
  // That way the documented order wins when a password also looks like a hash.
  let hash: string;
  let password: string;
  if (looksLikeHash(lines[1]!.trim())) {
    password = lines[0]!;
    hash = lines[1]!.trim();
  } else if (looksLikeHash(lines[0]!.trim())) {
    hash = lines[0]!.trim();
    password = lines[1]!;
  } else {
    throw new ToolError(
      "unknown-hash",
      "Neither line looks like a password hash.",
      "Paste a hash starting with $2a$, $2b$, $2y$, $argon2id$, $argon2i$, $argon2d$, or $scrypt$.",
    );
  }

  if (BCRYPT_PREFIX_RE.test(hash)) return verifyBcrypt(password, hash);
  if (ARGON2_PREFIX_RE.test(hash)) return verifyArgon2(password, hash);
  return verifyScrypt(password, hash);
}

export async function run(input: string, opts: BcryptOpts): Promise<BcryptResult> {
  // Only a trailing newline is stripped. A leading or trailing space is a
  // legitimate part of a password, and dropping it would produce a hash the
  // user's own login form would never reproduce.
  const text = (input ?? "").replace(/\r?\n$/, "");
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to hash or verify.",
      "In Hash mode, type the password. In Verify mode, put the password on the first line and the hash on the second.",
    );
  }

  if (opts.mode === "verify") return verifyMode(text);
  return hashMode(text, opts);
}

export default { run } satisfies ToolLogic<string, BcryptResult, BcryptOpts>;
