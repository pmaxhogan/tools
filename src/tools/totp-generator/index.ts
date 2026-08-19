import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { ToolError, type ToolLogic } from "../types";

export interface TotpOpts {
  /** "SHA1" | "SHA256" | "SHA512". Ignored when the input is an otpauth URI that names one. */
  algorithm?: string;
  /** 6, 7, or 8. Arrives as a string from the select. */
  digits?: string | number;
  /** Step length in seconds. */
  period?: string | number;
  /**
   * Time override in unix SECONDS. 0 (or missing) means live: use the wall
   * clock. Tests always pass a real value so results are deterministic.
   */
  now?: string | number;
  [key: string]: unknown;
}

export type TotpResult = Record<string, string>;

const HASHES = {
  SHA1: sha1,
  SHA256: sha256,
  SHA512: sha512,
} as const;

type AlgorithmName = keyof typeof HASHES;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 Base32 decode. Uppercases, drops whitespace and "=" padding, and
 * tolerates the hyphens some providers print between groups. Any other
 * character is a hard error: silently ignoring it would produce a plausible
 * looking code that never matches the server.
 */
export function base32Decode(raw: string): Uint8Array {
  const cleaned = raw.toUpperCase().replace(/[\s=-]/g, "");

  if (!cleaned) {
    throw new ToolError(
      "bad-secret",
      "That secret is not valid Base32.",
      "TOTP secrets use A-Z and 2-7. Remove other characters.",
    );
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new ToolError(
        "bad-secret",
        "That secret is not valid Base32.",
        "TOTP secrets use A-Z and 2-7. Remove other characters.",
      );
    }
    buffer = buffer * 32 + value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(buffer / 2 ** bits) & 0xff);
      buffer = buffer % 2 ** bits;
    }
  }

  if (!bytes.length) {
    throw new ToolError(
      "bad-secret",
      "That secret is not valid Base32.",
      "TOTP secrets use A-Z and 2-7. Remove other characters.",
    );
  }

  return Uint8Array.from(bytes);
}

/** 8-byte big-endian counter. Division, not shifts: counters exceed 2^32. */
function counterBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8);
  let rest = Math.floor(counter);
  for (let i = 7; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** RFC 4226 HOTP: HMAC, dynamic truncation, modulo, zero padded. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  algorithm: AlgorithmName,
  digits: number,
): string {
  const mac = hmac(HASHES[algorithm], secret, counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** "123456" -> "123 456", "94287082" -> "9428 7082". Easier to read aloud. */
function group(code: string): string {
  const half = Math.floor(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

export interface OtpauthUri {
  type: "totp" | "hotp";
  secret: string;
  account?: string;
  issuer?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
  counter?: number;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Hand-written otpauth:// parser. `URL` mangles the label (it lower cases the
 * "host" segment and an issuer prefix lands there), so the path is split by
 * hand and only the query goes through the standard decoding rules.
 */
export function parseOtpauth(raw: string): OtpauthUri {
  const withoutScheme = raw.trim().slice("otpauth://".length);
  const queryAt = withoutScheme.indexOf("?");
  const path = queryAt === -1 ? withoutScheme : withoutScheme.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutScheme.slice(queryAt + 1);

  const slashAt = path.indexOf("/");
  const type = (slashAt === -1 ? path : path.slice(0, slashAt)).toLowerCase();
  if (type !== "totp" && type !== "hotp") {
    throw new ToolError(
      "bad-uri",
      `"${type}" is not a supported otpauth type.`,
      "The URI must start with otpauth://totp/ or otpauth://hotp/.",
    );
  }

  const label = slashAt === -1 ? "" : decodeComponent(path.slice(slashAt + 1));

  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeComponent(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? "" : decodeComponent(pair.slice(eq + 1));
    if (!params.has(key)) params.set(key, value);
  }

  const secret = params.get("secret") ?? "";
  if (!secret.trim()) {
    throw new ToolError(
      "bad-uri",
      "That otpauth URI has no secret parameter.",
      "A usable URI looks like otpauth://totp/Example:you@example.com?secret=JBSWY3DPEHPK3PXP.",
    );
  }

  // Label is "Issuer:Account" or just "Account". The issuer query parameter
  // wins when both are present, which is what authenticator apps do.
  const colonAt = label.indexOf(":");
  const labelIssuer = colonAt === -1 ? "" : label.slice(0, colonAt).trim();
  const account = (colonAt === -1 ? label : label.slice(colonAt + 1)).trim();
  const issuer = (params.get("issuer") ?? labelIssuer).trim();

  const numeric = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new ToolError(
        "bad-uri",
        `The ${key} parameter in that otpauth URI is not a number.`,
        `Remove ${key}= from the URI or give it a whole number.`,
      );
    }
    return n;
  };

  return {
    type,
    secret,
    account: account || undefined,
    issuer: issuer || undefined,
    algorithm: params.get("algorithm"),
    digits: numeric("digits"),
    period: numeric("period"),
    counter: numeric("counter"),
  };
}

function normalizeAlgorithm(value: string | undefined, fallback: AlgorithmName): AlgorithmName {
  if (value === undefined || String(value).trim() === "") return fallback;
  const key = String(value)
    .trim()
    .toUpperCase()
    .replace(/[\s_-]/g, "");
  if (key === "SHA" || key === "SHA1") return "SHA1";
  if (key === "SHA256" || key === "SHA2256") return "SHA256";
  if (key === "SHA512" || key === "SHA2512") return "SHA512";
  throw new ToolError(
    "bad-algorithm",
    `"${value}" is not a supported TOTP algorithm.`,
    "Use SHA1, SHA256, or SHA512. Almost every provider uses SHA1.",
  );
}

function normalizeDigits(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 6 || n > 8) {
    throw new ToolError(
      "bad-digits",
      `"${value}" is not a supported code length.`,
      "TOTP codes are 6, 7, or 8 digits long.",
    );
  }
  return n;
}

function normalizePeriod(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new ToolError(
      "bad-period",
      `"${value}" is not a usable period.`,
      "The period is the number of seconds each code lasts. Most providers use 30.",
    );
  }
  return Math.floor(n);
}

/** opts.now is unix SECONDS; 0 or missing means live. */
function resolveNow(value: string | number | undefined): number {
  if (value === undefined || value === "") return Date.now() / 1000;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolError(
      "bad-time",
      `"${value}" is not a unix timestamp.`,
      "Enter unix seconds, or 0 to use the current time.",
    );
  }
  if (n === 0) return Date.now() / 1000;
  return n;
}

export function run(input: string, opts: TotpOpts = {}): TotpResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a TOTP secret or an otpauth:// URI.",
      "Paste the Base32 secret from your provider.",
    );
  }

  const isUri = /^otpauth:\/\//i.test(raw);
  const uri = isUri ? parseOtpauth(raw) : undefined;

  // A URI describes itself completely, so its parameters beat the panel controls.
  const algorithm = normalizeAlgorithm(
    uri?.algorithm ?? (opts.algorithm as string | undefined),
    "SHA1",
  );
  const digits = normalizeDigits(uri?.digits ?? opts.digits, 6);
  const period = normalizePeriod(uri?.period ?? opts.period, 30);
  const secretBytes = base32Decode(uri ? uri.secret : raw);

  const out: TotpResult = {};

  if (uri?.type === "hotp") {
    const counter = Math.max(0, Math.floor(uri.counter ?? 0));
    out.Code = group(hotp(secretBytes, counter, algorithm, digits));
    out.Counter = String(counter);
    out.Previous = counter > 0 ? group(hotp(secretBytes, counter - 1, algorithm, digits)) : "none";
    out.Next = group(hotp(secretBytes, counter + 1, algorithm, digits));
  } else {
    const nowSeconds = Math.floor(resolveNow(opts.now));
    const counter = Math.floor(nowSeconds / period);
    out.Code = group(hotp(secretBytes, counter, algorithm, digits));
    out["Valid for"] = `${period - (((nowSeconds % period) + period) % period)}s`;
    out.Previous = group(hotp(secretBytes, counter - 1, algorithm, digits));
    out.Next = group(hotp(secretBytes, counter + 1, algorithm, digits));
  }

  out.Algorithm = algorithm;
  out.Digits = String(digits);
  if (uri?.type === "hotp") {
    out.Type = "HOTP (counter based)";
  } else {
    out.Period = `${period}s`;
  }
  if (uri?.account) out.Account = uri.account;
  if (uri?.issuer) out.Issuer = uri.issuer;

  return out;
}

export default { run } satisfies ToolLogic<string, TotpResult, TotpOpts>;
