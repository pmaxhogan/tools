import { ToolError, type ToolLogic } from "../types";

export interface JwtGeneratorOpts {
  /** "sign" (default) or "verify". */
  mode?: string;
  /**
   * The shared secret, or the PEM key. Declared `sensitive` and `multiline` in
   * meta.ts, so the panel folds it away behind a Reveal button and the shell
   * never writes it to the URL fragment.
   */
  key?: string;
  /** "HS256" (default), "HS384", "HS512", "RS256", or "ES256". */
  alg?: string;
  /** Sign an RS256 or ES256 token with a throwaway key pair generated here. */
  demoKey?: boolean;
  /** Add an iat claim set to the current time. */
  addIat?: boolean;
  /** Add an nbf claim set to the current time. */
  addNbf?: boolean;
  /** Seconds until the exp claim. 0 leaves exp out. */
  expiresIn?: number;
  /** Clock override in unix seconds for the iat, nbf, and exp math. 0 means live. */
  now?: number;
  [key: string]: unknown;
}

export type JwtGeneratorResult = Record<string, string>;

export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "ES256";

const ALGORITHMS: JwtAlgorithm[] = ["HS256", "HS384", "HS512", "RS256", "ES256"];

const HMAC_HASH: Record<string, string> = {
  HS256: "SHA-256",
  HS384: "SHA-384",
  HS512: "SHA-512",
};

const SEPARATOR_RE = /^-{3,}$/;

const KEY_FIX =
  'Put the signing key in the "Secret or private key" option: the shared secret for an HS algorithm, or a PKCS#8 PEM private key for RS256 and ES256.';

/* ------------------------------------------------------------------ */
/* Base64url                                                           */
/* ------------------------------------------------------------------ */

const B64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

function decodeBase64(text: string, alphabet: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
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

export function fromBase64Url(text: string): Uint8Array | null {
  return decodeBase64(text.replace(/\+/g, "-").replace(/\//g, "_"), B64URL_CHARS);
}

function toBase64(bytes: Uint8Array): string {
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

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ */
/* PEM                                                                 */
/* ------------------------------------------------------------------ */

export interface ParsedPem {
  label: string;
  bytes: Uint8Array;
}

const PEM_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

/** Reads the first PEM block out of a blob of text. Null when there is none. */
export function parsePem(text: string): ParsedPem | null {
  const match = PEM_RE.exec(text);
  if (!match) return null;
  const bytes = decodeBase64(match[2]!, B64_CHARS);
  if (!bytes) return null;
  return { label: match[1]!, bytes };
}

/** Wraps DER bytes into a 64 column PEM block. */
export function toPem(label: string, bytes: Uint8Array): string {
  const body = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/* ------------------------------------------------------------------ */
/* Input splitting                                                     */
/* ------------------------------------------------------------------ */

export interface SplitInput {
  body: string;
  key: string;
  hasKey: boolean;
}

/**
 * Splits "payload or token, then a --- line, then the signing key".
 *
 * The key has its own option now, flagged sensitive, which the panel folds
 * away and the shell never writes to the URL fragment. This separator is the
 * older way in and is still honored so a note or a link written before the
 * option existed keeps working: when the key option is empty and the input
 * carries a --- line, the text below the last one is the key. The LAST
 * separator wins, and a PEM's own dashes never match because the separator
 * line must contain nothing but dashes.
 */
export function splitBodyAndKey(input: string): SplitInput {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i]!.trim())) at = i;
  }
  if (at === -1) return { body: input.replace(/\r\n/g, "\n"), key: "", hasKey: false };
  const key = lines.slice(at + 1).join("\n");
  return { body: lines.slice(0, at).join("\n"), key, hasKey: key.trim() !== "" };
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

function pickAlgorithm(raw: unknown): JwtAlgorithm {
  const value = typeof raw === "string" && raw ? raw.toUpperCase() : "HS256";
  if ((ALGORITHMS as string[]).includes(value)) return value as JwtAlgorithm;
  throw new ToolError(
    "bad-option",
    `The option "alg" does not recognize "${String(raw)}".`,
    `Choose one of ${ALGORITHMS.join(", ")}. The alg=none family is deliberately not offered.`,
  );
}

function boolOption(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return raw === "true" || raw === "1";
}

function intOption(raw: unknown, id: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolError(
      "bad-option",
      `The option "${id}" must be a whole number from ${min} to ${max}.`,
      `Leave it at ${fallback} to use the default.`,
    );
  }
  return n;
}

/** Unix seconds, from the clock override when one is given. */
function nowSeconds(opts: JwtGeneratorOpts): number {
  const override = intOption(opts.now, "now", 0, 4_102_444_800, 0);
  return override > 0 ? override : Math.floor(Date.now() / 1000);
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

const RSA_PARAMS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const EC_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;

function keyImportError(alg: JwtAlgorithm, label: string): ToolError {
  return new ToolError(
    "key-import-failed",
    `That ${label} block could not be read as a ${alg} key.`,
    alg === "RS256"
      ? "RS256 needs an RSA key. Generate one with openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048, or switch the algorithm to ES256 if the key is an elliptic curve key."
      : "ES256 needs an elliptic curve key on P-256. Generate one with openssl ecparam -name prime256v1 -genkey -noout, or switch the algorithm to RS256 if the key is an RSA key.",
  );
}

async function importPrivateKey(alg: JwtAlgorithm, keyText: string): Promise<CryptoKey> {
  const pem = parsePem(keyText);
  if (!pem) {
    throw new ToolError(
      "bad-pem",
      `${alg} needs a PEM private key, and no PEM block was found in the "Secret or private key" option.`,
      "Paste the whole block including the BEGIN PRIVATE KEY and END PRIVATE KEY lines.",
    );
  }
  if (!pem.label.includes("PRIVATE")) {
    throw new ToolError(
      "bad-pem",
      `Signing needs a private key, and this is a ${pem.label} block.`,
      "Paste the PRIVATE KEY block. A public key can only verify a token, not sign one.",
    );
  }
  if (pem.label !== "PRIVATE KEY") {
    throw new ToolError(
      "bad-pem",
      `This is a ${pem.label} block, and only the PKCS#8 "PRIVATE KEY" form can be read here.`,
      `Convert it with openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem, then paste that file.`,
    );
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pem.bytes as BufferSource,
      alg === "RS256" ? RSA_PARAMS : EC_PARAMS,
      false,
      ["sign"],
    );
  } catch {
    throw keyImportError(alg, pem.label);
  }
}

async function importPublicKey(alg: JwtAlgorithm, keyText: string): Promise<CryptoKey> {
  const pem = parsePem(keyText);
  if (!pem) {
    throw new ToolError(
      "bad-pem",
      `Verifying an ${alg} token needs a PEM public key, and no PEM block was found in the "Secret or private key" option.`,
      "Paste the whole block including the BEGIN PUBLIC KEY and END PUBLIC KEY lines. Derive it from a private key with openssl pkey -in key.pem -pubout.",
    );
  }
  if (pem.label !== "PUBLIC KEY") {
    throw new ToolError(
      "bad-pem",
      `Verifying needs the SubjectPublicKeyInfo "PUBLIC KEY" block, and this is a ${pem.label} block.`,
      "Derive the public key with openssl pkey -in key.pem -pubout and paste that.",
    );
  }
  try {
    return await crypto.subtle.importKey(
      "spki",
      pem.bytes as BufferSource,
      alg === "RS256" ? RSA_PARAMS : EC_PARAMS,
      false,
      ["verify"],
    );
  } catch {
    throw keyImportError(alg, pem.label);
  }
}

async function importHmacKey(
  alg: JwtAlgorithm,
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret) as BufferSource,
    { name: "HMAC", hash: HMAC_HASH[alg]! },
    false,
    usages,
  );
}

export interface DemoKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  key: CryptoKey;
}

/** Generates a throwaway key pair so an RS256 or ES256 token can be tried in one click. */
export async function generateDemoKeyPair(alg: JwtAlgorithm): Promise<DemoKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    alg === "RS256"
      ? { ...RSA_PARAMS, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
      : EC_PARAMS,
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    privateKeyPem: toPem("PRIVATE KEY", pkcs8),
    publicKeyPem: toPem("PUBLIC KEY", spki),
    key: pair.privateKey,
  };
}

function signParams(alg: JwtAlgorithm): AlgorithmIdentifier | EcdsaParams {
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  return { name: "HMAC" };
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

function parsePayload(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new ToolError(
      "empty-payload",
      "There is no payload to sign.",
      'Put the claims as JSON, for example {"sub":"1234567890","name":"Ada Lovelace"}.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ToolError(
      "bad-payload-json",
      `The payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`,
      "Check for a trailing comma, a single quote where a double quote belongs, or an unquoted key.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "bad-payload-json",
      "A JWT payload has to be a JSON object, not an array or a bare value.",
      'Wrap the claims in braces, for example {"sub":"1234567890"}.',
    );
  }
  return parsed as Record<string, unknown>;
}

function formatTime(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "not set";
  return `${seconds} (${new Date(seconds * 1000).toISOString().replace(".000Z", "Z")})`;
}

/* ------------------------------------------------------------------ */
/* Sign                                                                */
/* ------------------------------------------------------------------ */

async function sign(
  body: string,
  keyText: string,
  hasKey: boolean,
  opts: JwtGeneratorOpts,
): Promise<JwtGeneratorResult> {
  const alg = pickAlgorithm(opts.alg);
  const payload = parsePayload(body);
  const now = nowSeconds(opts);
  const expiresIn = intOption(opts.expiresIn, "expiresIn", 0, 315_360_000, 0);

  if (boolOption(opts.addIat, false)) payload.iat = now;
  if (boolOption(opts.addNbf, false)) payload.nbf = now;
  if (expiresIn > 0) payload.exp = now + expiresIn;

  const header = { alg, typ: "JWT" };
  const signingInput = `${toBase64Url(utf8(JSON.stringify(header)))}.${toBase64Url(utf8(JSON.stringify(payload)))}`;

  let key: CryptoKey;
  let demo: DemoKeyPair | null = null;
  if (alg.startsWith("HS")) {
    if (!hasKey) throw new ToolError("missing-key", `${alg} needs a shared secret.`, KEY_FIX);
    key = await importHmacKey(alg, keyText.trim(), ["sign"]);
  } else if (hasKey) {
    key = await importPrivateKey(alg, keyText);
  } else if (boolOption(opts.demoKey, false)) {
    demo = await generateDemoKeyPair(alg);
    key = demo.key;
  } else {
    throw new ToolError(
      "missing-key",
      `${alg} needs a PEM private key.`,
      `${KEY_FIX} Or turn on "Generate a demo key pair" to sign with a throwaway key.`,
    );
  }

  const signature = new Uint8Array(
    await crypto.subtle.sign(signParams(alg), key, utf8(signingInput) as BufferSource),
  );
  const token = `${signingInput}.${toBase64Url(signature)}`;

  const result: JwtGeneratorResult = {
    Token: token,
    Algorithm: alg.startsWith("HS")
      ? `${alg}, HMAC with ${HMAC_HASH[alg]}. Anyone who can verify this token can also forge one.`
      : alg === "RS256"
        ? "RS256, RSASSA-PKCS1-v1_5 with SHA-256. Only the private key can sign; the public key only verifies."
        : "ES256, ECDSA on P-256 with SHA-256. Only the private key can sign; the public key only verifies.",
    Header: JSON.stringify(header, null, 2),
    Payload: JSON.stringify(payload, null, 2),
    "Signature (base64url)": token.split(".")[2]!,
    "Issued at": formatTime(payload.iat),
    "Not before": formatTime(payload.nbf),
    Expires: formatTime(payload.exp),
  };
  if (demo) {
    result["Demo private key (PKCS#8 PEM)"] = demo.privateKeyPem;
    result["Demo public key (SPKI PEM)"] = demo.publicKeyPem;
    result.Warning =
      "This token was signed with a throwaway key pair generated for this run. It is gone when you leave the page, so save both PEM blocks now if you need to verify the token later.";
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Verify                                                              */
/* ------------------------------------------------------------------ */

function decodeSegment(segment: string, name: string): Record<string, unknown> {
  const bytes = fromBase64Url(segment);
  if (!bytes)
    throw new ToolError(
      "bad-token",
      `The ${name} is not valid base64url.`,
      "Copy the whole token, with nothing but the two dots separating its three parts.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ToolError(
      "bad-token",
      `The ${name} does not decode to JSON.`,
      "This may not be a JWT. Check that the token was copied in full.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ToolError("bad-token", `The ${name} is not a JSON object.`, "Check the token.");
  return parsed as Record<string, unknown>;
}

async function verify(
  body: string,
  keyText: string,
  hasKey: boolean,
  opts: JwtGeneratorOpts,
): Promise<JwtGeneratorResult> {
  const token = body.trim();
  if (token === "")
    throw new ToolError(
      "empty-token",
      "There is no token to verify.",
      'Paste the JWT into the input box, and put the secret or PEM public key in the "Secret or private key" option.',
    );
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new ToolError(
      "bad-token",
      `A JWT has three dot separated parts, and this has ${parts.length}.`,
      "Paste the whole token. A JWE (five parts) cannot be checked here.",
    );
  if (!hasKey)
    throw new ToolError(
      "missing-key",
      "Verifying needs the secret or public key the token was signed with.",
      'Put the shared secret, or the SubjectPublicKeyInfo PEM public key, in the "Secret or private key" option.',
    );

  const header = decodeSegment(parts[0]!, "header");
  const payload = decodeSegment(parts[1]!, "payload");
  const signature = fromBase64Url(parts[2]!);
  if (!signature)
    throw new ToolError(
      "bad-token",
      "The signature is not valid base64url.",
      "Copy the whole token, including everything after the last dot.",
    );

  const headerAlg = typeof header.alg === "string" ? header.alg.toUpperCase() : "";
  if (headerAlg === "NONE")
    throw new ToolError(
      "alg-none",
      'This token declares alg "none", which means it carries no signature at all.',
      "Never accept such a token. The JWT Vulnerability Check tool explains why in detail.",
    );
  const alg = pickAlgorithm(opts.alg && opts.alg !== "" ? opts.alg : headerAlg || "HS256");

  let valid: boolean;
  if (alg.startsWith("HS")) {
    const key = await importHmacKey(alg, keyText.trim(), ["verify"]);
    valid = await crypto.subtle.verify(
      { name: "HMAC" },
      key,
      signature as BufferSource,
      utf8(`${parts[0]}.${parts[1]}`) as BufferSource,
    );
  } else {
    const key = await importPublicKey(alg, keyText);
    valid = await crypto.subtle.verify(
      signParams(alg),
      key,
      signature as BufferSource,
      utf8(`${parts[0]}.${parts[1]}`) as BufferSource,
    );
  }

  const now = nowSeconds(opts);
  const exp = payload.exp;
  const nbf = payload.nbf;
  const expired = typeof exp === "number" && exp <= now;
  const early = typeof nbf === "number" && nbf > now;

  return {
    Signature: valid ? "valid" : "invalid",
    Verdict: valid
      ? expired
        ? "The signature is correct, but the token has expired."
        : early
          ? "The signature is correct, but the token is not valid yet."
          : "The signature is correct and the token is within its validity window."
      : "The signature does not match. Either the key is wrong, the algorithm is wrong, or the token was altered.",
    "Algorithm checked": `${alg} (the header declares ${headerAlg || "nothing"})`,
    Header: JSON.stringify(header, null, 2),
    Payload: JSON.stringify(payload, null, 2),
    "Expiry check":
      typeof exp === "number"
        ? `${expired ? "expired" : "valid"} at ${formatTime(exp)}`
        : "no exp claim, so this token never expires on its own",
    "Not before check":
      typeof nbf === "number"
        ? `${early ? "not usable yet" : "in effect"} from ${formatTime(nbf)}`
        : "no nbf claim",
    "Checked against": formatTime(now),
  };
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export async function run(input: string, opts: JwtGeneratorOpts): Promise<JwtGeneratorResult> {
  const text = input ?? "";
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to sign or verify.",
      'Put the payload JSON (or the token, in Verify mode) in the input box and the key in the "Secret or private key" option. For example {"sub":"1234567890"} with your-256-bit-secret as the key.',
    );
  }

  /*
   * Two ways in, and the option wins. A key in the key option means the whole
   * input is the payload or the token, dashes and all. Only when that option
   * is empty does the older "--- then the key" form apply, so a note or a link
   * written before the option existed still signs and verifies the same way.
   */
  const optionKey = typeof opts.key === "string" ? opts.key : "";
  const split = splitBodyAndKey(text);
  const usingOption = optionKey.trim() !== "";
  const body = usingOption ? text.replace(/\r\n/g, "\n") : split.body;
  const key = usingOption ? optionKey : split.key;
  const hasKey = usingOption || split.hasKey;
  const mode = typeof opts.mode === "string" && opts.mode ? opts.mode : "sign";
  if (mode === "sign") return sign(body, key, hasKey, opts);
  if (mode === "verify") return verify(body, key, hasKey, opts);
  throw new ToolError(
    "bad-option",
    `The option "mode" does not recognize "${mode}".`,
    "Choose Sign or Verify.",
  );
}

export default { run } satisfies ToolLogic<string, JwtGeneratorResult, JwtGeneratorOpts>;
