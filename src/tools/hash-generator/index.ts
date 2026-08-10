import { type ToolLogic } from "../types";

export interface HashOpts {
  /** Known-good hash to compare (case-insensitive) against every computed digest. */
  verify: string;
  [key: string]: unknown;
}

export type HashResult = Record<string, string>;

/**
 * MD5 (RFC 1321), pure TypeScript. Kept alongside the WebCrypto-backed
 * algorithms below because SubtleCrypto does not implement MD5 (it's
 * cryptographically broken — this exists only for legacy checksum
 * comparison, never for security).
 */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i + 1)) * 2^32), precomputed as int32.
const MD5_K = Int32Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32),
);

function leftRotate(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** Pad a byte message per RFC 1321: 0x80, zeros, then 64-bit little-endian bit length. */
function md5Pad(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const padLen = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const total = bytes.length + 1 + padLen + 8;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;

  const lenLow = bitLen >>> 0;
  const lenHigh = Math.floor(bitLen / 0x100000000) >>> 0;
  const offset = total - 8;
  out[offset] = lenLow & 0xff;
  out[offset + 1] = (lenLow >>> 8) & 0xff;
  out[offset + 2] = (lenLow >>> 16) & 0xff;
  out[offset + 3] = (lenLow >>> 24) & 0xff;
  out[offset + 4] = lenHigh & 0xff;
  out[offset + 5] = (lenHigh >>> 8) & 0xff;
  out[offset + 6] = (lenHigh >>> 16) & 0xff;
  out[offset + 7] = (lenHigh >>> 24) & 0xff;
  return out;
}

/** int32 -> 4 hex bytes, little-endian (MD5 outputs its words this way). */
function wordToHexLE(word: number): string {
  const u = word >>> 0;
  let hex = "";
  for (let i = 0; i < 4; i++) {
    hex += ((u >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/** MD5 digest of a UTF-8 string, returned as lowercase hex. */
export function md5(input: string): string {
  const msg = md5Pad(new TextEncoder().encode(input));

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let chunk = 0; chunk < msg.length; chunk += 64) {
    for (let j = 0; j < 16; j++) {
      const o = chunk + j * 4;
      M[j] = msg[o]! | (msg[o + 1]! << 8) | (msg[o + 2]! << 16) | (msg[o + 3]! << 24);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i]! + M[g]!) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + leftRotate(F, MD5_SHIFTS[i]!)) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return [a0, b0, c0, d0].map(wordToHexLE).join("");
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-* digest via WebCrypto (Node 20+ and all browsers), lowercase hex. */
async function subtleHex(
  algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512",
  data: Uint8Array,
): Promise<string> {
  const buf = await crypto.subtle.digest(algorithm, data as BufferSource);
  return bufToHex(buf);
}

export async function run(input: string, opts: HashOpts): Promise<HashResult> {
  // The empty string is a valid, well-known input (hashes of "" are
  // documented, common test vectors) — never rejected.
  const text = input ?? "";
  const data = new TextEncoder().encode(text);

  const [sha1, sha256, sha384, sha512] = await Promise.all([
    subtleHex("SHA-1", data),
    subtleHex("SHA-256", data),
    subtleHex("SHA-384", data),
    subtleHex("SHA-512", data),
  ]);

  const result: HashResult = {
    MD5: md5(text),
    "SHA-1": sha1,
    "SHA-256": sha256,
    "SHA-384": sha384,
    "SHA-512": sha512,
  };

  const verify = (opts.verify ?? "").trim();
  if (verify) {
    const target = verify.toLowerCase();
    const match = Object.entries(result).find(([, v]) => v === target);
    result.Verification = match ? `Matches ${match[0]}` : "No match";
  }

  return result;
}

export default { run } satisfies ToolLogic<string, HashResult, HashOpts>;
