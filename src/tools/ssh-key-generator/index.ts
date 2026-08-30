import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ToolError, type ToolLogic } from "../types";

export interface SshKeyOpts {
  /** "ed25519" (default) or "ecdsa-p256". */
  algorithm?: string;
  /** Trailing comment on the public key line, usually you@host. */
  comment?: string;
  /**
   * Deterministic randomness for tests. Real use leaves this empty so every
   * byte comes from crypto.getRandomValues. A non-empty seed makes the whole
   * key pair reproducible, which is exactly why it is not a panel option: a
   * key anyone can regenerate from a shared string is not a secret.
   */
  seed?: string;
  [key: string]: unknown;
}

export type SshKeyResult = Record<string, string>;

export type SshAlgorithm = "ed25519" | "ecdsa-p256";

/** OpenSSH key type names, as they appear on the public key line. */
const SSH_TYPE: Record<SshAlgorithm, string> = {
  ed25519: "ssh-ed25519",
  "ecdsa-p256": "ecdsa-sha2-nistp256",
};

/** The "none" cipher pads the private block to a multiple of 8 bytes. */
const NO_CIPHER_BLOCK = 8;

/* ------------------------------------------------------------------ */
/* Bytes, base64, PEM                                                  */
/* ------------------------------------------------------------------ */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (RFC 4648 section 4), hand written so this file stays Buffer-free. */
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

/** Wraps base64 into a PEM block. OpenSSH uses 70 columns, everything else 64. */
export function pem(label: string, bytes: Uint8Array, columns: number): string {
  const body = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += columns) lines.push(body.slice(i, i + columns));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/* ------------------------------------------------------------------ */
/* Randomness                                                          */
/* ------------------------------------------------------------------ */

/** FNV-1a over the seed string, used only to spread a seed across the PRNG state. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * xorshift128 stream, used ONLY when a seed is supplied so tests can pin exact
 * output. It is not a cryptographic generator and never runs for a real key:
 * with no seed the bytes come from crypto.getRandomValues.
 */
export function seededBytes(seed: string, count: number): Uint8Array {
  let x = hashSeed(seed) || 1;
  let y = hashSeed(`${seed}:y`) || 2;
  let z = hashSeed(`${seed}:z`) || 3;
  let w = hashSeed(`${seed}:w`) || 4;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = (((w ^ (w >>> 19)) >>> 0) ^ ((t ^ (t >>> 8)) >>> 0)) >>> 0;
    out[i] = w & 0xff;
  }
  return out;
}

function randomBytes(count: number, seed?: string): Uint8Array {
  if (seed) return seededBytes(seed, count);
  const out = new Uint8Array(count);
  crypto.getRandomValues(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* SSH wire format (RFC 4251 section 5)                                */
/* ------------------------------------------------------------------ */

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** A length-prefixed byte string, the one composite type the format uses. */
function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(uint32(bytes.length), bytes);
}

/**
 * An SSH mpint: a big-endian two's complement integer with no redundant leading
 * bytes, so a leading zero is prepended when the top bit would otherwise read
 * as a negative sign. OpenSSH stores the ECDSA private scalar this way.
 */
export function sshMpint(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  const needsPad = (trimmed[0] as number) & 0x80;
  return sshString(needsPad ? concat(new Uint8Array([0]), trimmed) : trimmed);
}

/* ------------------------------------------------------------------ */
/* DER                                                                 */
/* ------------------------------------------------------------------ */

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(content.length), content);
}

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_OCTET_STRING = 0x04;
const DER_BIT_STRING = 0x03;
const DER_CONTEXT_1 = 0xa1;

/** OID 1.3.101.112, id-Ed25519 (RFC 8410). */
const OID_ED25519 = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]);
/** OID 1.2.840.10045.2.1, id-ecPublicKey. */
const OID_EC_PUBLIC_KEY = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
/** OID 1.2.840.10045.3.1.7, prime256v1 (NIST P-256). */
const OID_P256 = new Uint8Array([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);

/** A DER BIT STRING with no unused trailing bits, which is all keys ever need. */
function bitString(bytes: Uint8Array): Uint8Array {
  return der(DER_BIT_STRING, concat(new Uint8Array([0]), bytes));
}

/* ------------------------------------------------------------------ */
/* Key material                                                        */
/* ------------------------------------------------------------------ */

export interface RawKeypair {
  algorithm: SshAlgorithm;
  /** Ed25519: the 32 byte seed. P-256: the 32 byte private scalar. */
  privateKey: Uint8Array;
  /** Ed25519: the 32 byte point. P-256: the 65 byte uncompressed 0x04 X Y point. */
  publicKey: Uint8Array;
}

/**
 * Draws a valid key pair. Ed25519 accepts any 32 bytes, so one draw always
 * works. P-256 needs a scalar in [1, n-1], so an out-of-range draw is retried
 * rather than reduced: reducing would bias the low end of the range.
 */
export function generateKeypair(algorithm: SshAlgorithm, seed?: string): RawKeypair {
  if (algorithm === "ed25519") {
    const privateKey = randomBytes(32, seed);
    return { algorithm, privateKey, publicKey: ed25519.getPublicKey(privateKey) };
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = randomBytes(32, seed ? `${seed}:p256:${attempt}` : undefined);
    if (!p256.utils.isValidSecretKey(candidate)) continue;
    // `false` asks for the uncompressed 0x04 X Y form. OpenSSH and RFC 5656
    // require it; the library's default is the 33 byte compressed point.
    return { algorithm, privateKey: candidate, publicKey: p256.getPublicKey(candidate, false) };
  }
  /* c8 ignore next 5 */
  throw new ToolError(
    "key-generation-failed",
    "Could not draw a valid P-256 private scalar after 32 attempts.",
    "Try again, or switch the key type to Ed25519.",
  );
}

/** The base64 blob that follows the key type on an authorized_keys line. */
export function publicKeyBlob(key: RawKeypair): Uint8Array {
  if (key.algorithm === "ed25519") {
    return concat(sshString(SSH_TYPE.ed25519), sshString(key.publicKey));
  }
  return concat(sshString(SSH_TYPE["ecdsa-p256"]), sshString("nistp256"), sshString(key.publicKey));
}

/** `ssh-ed25519 AAAAC3... you@host`, the line that goes in authorized_keys. */
export function openSshPublicKey(key: RawKeypair, comment: string): string {
  const line = `${SSH_TYPE[key.algorithm]} ${toBase64(publicKeyBlob(key))}`;
  return comment ? `${line} ${comment}` : line;
}

/**
 * The `SHA256:...` fingerprint `ssh-keygen -lf` prints: SHA-256 over the same
 * blob the public key line carries, base64 encoded with the padding stripped.
 */
export function fingerprint(key: RawKeypair): string {
  return `SHA256:${toBase64(sha256(publicKeyBlob(key))).replace(/=+$/, "")}`;
}

/**
 * The unencrypted "openssh-key-v1" private key container.
 *
 * Layout (PROTOCOL.key in the OpenSSH source): the magic string, the cipher,
 * KDF name and KDF options (all "none" here), the key count, the public key
 * blob, and then the private section as one length-prefixed block. That block
 * opens with the same random 32 bit checkint twice, which is how a client
 * detects a wrong passphrase, then the key material, then the comment, then
 * padding bytes counting 1, 2, 3 up to the cipher's block size.
 */
export function openSshPrivateKey(key: RawKeypair, comment: string, seed?: string): string {
  const checkint = randomBytes(4, seed ? `${seed}:checkint` : undefined);
  const keyBody =
    key.algorithm === "ed25519"
      ? concat(
          sshString(SSH_TYPE.ed25519),
          sshString(key.publicKey),
          // OpenSSH stores the expanded 64 byte form: seed followed by the point.
          sshString(concat(key.privateKey, key.publicKey)),
        )
      : concat(
          sshString(SSH_TYPE["ecdsa-p256"]),
          sshString("nistp256"),
          sshString(key.publicKey),
          sshMpint(key.privateKey),
        );

  const unpadded = concat(checkint, checkint, keyBody, sshString(comment));
  const padCount = (NO_CIPHER_BLOCK - (unpadded.length % NO_CIPHER_BLOCK)) % NO_CIPHER_BLOCK;
  const padding = new Uint8Array(padCount);
  for (let i = 0; i < padCount; i++) padding[i] = i + 1;

  const container = concat(
    new TextEncoder().encode("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(new Uint8Array(0)),
    uint32(1),
    sshString(publicKeyBlob(key)),
    sshString(concat(unpadded, padding)),
  );
  return pem("OPENSSH PRIVATE KEY", container, 70);
}

/** The unencrypted PKCS#8 (RFC 5208) private key, the format most libraries read. */
export function pkcs8PrivateKey(key: RawKeypair): string {
  if (key.algorithm === "ed25519") {
    // RFC 8410: the CurvePrivateKey is itself an OCTET STRING, so the seed is
    // wrapped twice inside the PrivateKeyInfo privateKey field.
    const inner = der(DER_OCTET_STRING, key.privateKey);
    const body = concat(
      der(DER_INTEGER, new Uint8Array([0])),
      der(DER_SEQUENCE, OID_ED25519),
      der(DER_OCTET_STRING, inner),
    );
    return pem("PRIVATE KEY", der(DER_SEQUENCE, body), 64);
  }
  // RFC 5915 ECPrivateKey, wrapped in a PKCS#8 PrivateKeyInfo.
  const ecPrivateKey = der(
    DER_SEQUENCE,
    concat(
      der(DER_INTEGER, new Uint8Array([1])),
      der(DER_OCTET_STRING, key.privateKey),
      der(DER_CONTEXT_1, bitString(key.publicKey)),
    ),
  );
  const body = concat(
    der(DER_INTEGER, new Uint8Array([0])),
    der(DER_SEQUENCE, concat(OID_EC_PUBLIC_KEY, OID_P256)),
    der(DER_OCTET_STRING, ecPrivateKey),
  );
  return pem("PRIVATE KEY", der(DER_SEQUENCE, body), 64);
}

/** The SubjectPublicKeyInfo (RFC 5280) form of the public key. */
export function spkiPublicKey(key: RawKeypair): string {
  const algorithm =
    key.algorithm === "ed25519"
      ? der(DER_SEQUENCE, OID_ED25519)
      : der(DER_SEQUENCE, concat(OID_EC_PUBLIC_KEY, OID_P256));
  const body = der(DER_SEQUENCE, concat(algorithm, bitString(key.publicKey)));
  return pem("PUBLIC KEY", body, 64);
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

/** Comments end up on one line of authorized_keys, so newlines cannot survive. */
const COMMENT_RE = /^[^\n\r]*$/;

const ALGORITHM_LABEL: Record<SshAlgorithm, string> = {
  ed25519: "Ed25519 (ssh-ed25519), 256 bit key, 128 bit security level",
  "ecdsa-p256": "ECDSA on NIST P-256 (ecdsa-sha2-nistp256), 256 bit key, 128 bit security level",
};

function pickAlgorithm(raw: unknown): SshAlgorithm {
  const value = typeof raw === "string" && raw ? raw : "ed25519";
  if (value === "ed25519" || value === "ecdsa-p256") return value;
  throw new ToolError(
    "bad-option",
    `The option "algorithm" does not recognize "${String(raw)}".`,
    "Choose Ed25519 or ECDSA P-256.",
  );
}

function pickComment(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!COMMENT_RE.test(value)) {
    throw new ToolError(
      "bad-comment",
      "The comment cannot contain a line break.",
      "An authorized_keys entry is a single line, so keep the comment on one line.",
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export function run(_input: undefined, opts: SshKeyOpts): SshKeyResult {
  const algorithm = pickAlgorithm(opts.algorithm);
  const comment = pickComment(opts.comment);
  const seed = typeof opts.seed === "string" && opts.seed.trim() !== "" ? opts.seed : undefined;

  const key = generateKeypair(algorithm, seed);
  const result: SshKeyResult = {
    "Key type": ALGORITHM_LABEL[algorithm],
    "Public key (OpenSSH)": openSshPublicKey(key, comment),
    "Fingerprint (SHA256)": fingerprint(key),
    "Private key (OpenSSH)": openSshPrivateKey(key, comment, seed),
    "Private key (PKCS#8 PEM)": pkcs8PrivateKey(key),
    "Public key (PEM)": spkiPublicKey(key),
    "Install the public key":
      "Append the OpenSSH public key line to ~/.ssh/authorized_keys on the server, on its own line. Locally, save the OpenSSH private key as ~/.ssh/id_" +
      (algorithm === "ed25519" ? "ed25519" : "ecdsa") +
      " and run chmod 600 on it, or ssh will refuse to use it.",
    "Add a passphrase":
      "This key is written unencrypted, because the encrypted OpenSSH format needs the bcrypt_pbkdf key derivation that is not available here. After saving the private key, run ssh-keygen -p -f ~/.ssh/id_" +
      (algorithm === "ed25519" ? "ed25519" : "ecdsa") +
      " to set a passphrase on it.",
  };
  if (seed) {
    result.Warning =
      "A seed was supplied, so this key pair is reproducible by anyone who knows that seed. Seeded keys exist for testing only. Clear the seed before generating a key you will actually use.";
  }
  return result;
}

export default { run } satisfies ToolLogic<undefined, SshKeyResult, SshKeyOpts>;
