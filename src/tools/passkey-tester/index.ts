import { decode as cborDecode } from "cbor-x";
import { ToolError, type ToolLogic } from "../types";

export interface PasskeyTesterOpts {
  /** "summary" (default) or "full" (adds raw hex and the whole COSE map). */
  view: string;
  [key: string]: unknown;
}

export type PasskeyTesterResult = Record<string, string>;

/** Well known passkey provider AAGUIDs. */
const WELL_KNOWN_AAGUIDS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
};

/** COSE algorithm identifiers (IANA COSE Algorithms registry). */
const COSE_ALGS: Record<string, string> = {
  "-7": "ES256",
  "-8": "EdDSA",
  "-35": "ES384",
  "-36": "ES512",
  "-37": "PS256",
  "-38": "PS384",
  "-39": "PS512",
  "-47": "ES256K",
  "-257": "RS256",
  "-258": "RS384",
  "-259": "RS512",
  "-65535": "RS1",
};

const COSE_KTY: Record<string, string> = {
  "1": "OKP (octet key pair)",
  "2": "EC2 (elliptic curve)",
  "3": "RSA",
  "4": "Symmetric",
};

const COSE_CRV: Record<string, string> = {
  "1": "P-256",
  "2": "P-384",
  "3": "P-521",
  "4": "X25519",
  "5": "X448",
  "6": "Ed25519",
  "7": "Ed448",
};

/* ------------------------------------------------------------------ bytes */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Any(text: string, what: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, "");
  if (!cleaned) {
    throw new ToolError("empty-input", `The ${what} is empty.`, "Paste the encoded value.");
  }
  const normalized = cleaned.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]+$/.test(normalized)) {
    throw new ToolError(
      "bad-base64",
      `The ${what} is not valid base64 or base64url.`,
      "Paste the value exactly as the browser produced it, or paste the whole credential JSON instead.",
    );
  }
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ToolError(
      "bad-base64",
      `The ${what} is not valid base64 or base64url.`,
      "Check for a truncated or partially copied value.",
    );
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function asBytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

/* ------------------------------------------------- minimal CBOR item reader
 * cbor-x decodes a whole buffer, but the COSE public key sits inside
 * authenticatorData with credential id bytes before it and optional extension
 * data after it, so that decode has to report how many bytes it consumed.
 * This reader returns both the value and the next offset.
 */

interface CborRead {
  value: unknown;
  next: number;
}

function cborFail(): never {
  throw new ToolError(
    "bad-cbor",
    "The CBOR data could not be decoded.",
    "Make sure the whole value was copied, including any trailing base64url characters.",
  );
}

function readUintBE(bytes: Uint8Array, pos: number, size: number): number {
  if (pos + size > bytes.length) cborFail();
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + bytes[pos + i];
  return n;
}

function readCborItem(bytes: Uint8Array, pos: number): CborRead {
  if (pos >= bytes.length) cborFail();
  const first = bytes[pos];
  const major = first >> 5;
  const minor = first & 0x1f;
  let p = pos + 1;

  if (major === 7) {
    if (minor === 20) return { value: false, next: p };
    if (minor === 21) return { value: true, next: p };
    if (minor === 22) return { value: null, next: p };
    if (minor === 23) return { value: undefined, next: p };
    cborFail();
  }

  let arg = 0;
  if (minor < 24) arg = minor;
  else if (minor === 24) {
    arg = readUintBE(bytes, p, 1);
    p += 1;
  } else if (minor === 25) {
    arg = readUintBE(bytes, p, 2);
    p += 2;
  } else if (minor === 26) {
    arg = readUintBE(bytes, p, 4);
    p += 4;
  } else if (minor === 27) {
    arg = readUintBE(bytes, p, 8);
    p += 8;
  } else cborFail();

  if (major === 0) return { value: arg, next: p };
  if (major === 1) return { value: -1 - arg, next: p };
  if (major === 2) {
    if (p + arg > bytes.length) cborFail();
    return { value: bytes.slice(p, p + arg), next: p + arg };
  }
  if (major === 3) {
    if (p + arg > bytes.length) cborFail();
    return { value: new TextDecoder().decode(bytes.slice(p, p + arg)), next: p + arg };
  }
  if (major === 4) {
    const items: unknown[] = [];
    for (let i = 0; i < arg; i++) {
      const item = readCborItem(bytes, p);
      items.push(item.value);
      p = item.next;
    }
    return { value: items, next: p };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < arg; i++) {
      const key = readCborItem(bytes, p);
      const val = readCborItem(bytes, key.next);
      map.set(key.value, val.value);
      p = val.next;
    }
    return { value: map, next: p };
  }
  // major 6 is a tag: report the tagged value and ignore the tag number.
  return readCborItem(bytes, p);
}

/* ------------------------------------------------------ authenticator data */

interface AuthData {
  raw: Uint8Array;
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  coseKey?: Map<unknown, unknown>;
  extensions?: unknown;
  /** Bytes past the parsed structure that no flag accounts for. */
  trailingBytes?: number;
}

function notWebauthn(detail: string): never {
  throw new ToolError(
    "not-webauthn",
    detail,
    "Paste an attestationObject, raw authenticatorData, or the credential JSON from navigator.credentials.",
  );
}

function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) notWebauthn("Authenticator data must be at least 37 bytes long.");
  const flags = bytes[32];
  const data: AuthData = {
    raw: bytes,
    rpIdHash: bytes.slice(0, 32),
    flags,
    signCount: ((bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36]) >>> 0,
  };

  let p = 37;
  if (flags & 0x40) {
    if (p + 18 > bytes.length) notWebauthn("The attested credential data is truncated.");
    data.aaguid = bytes.slice(p, p + 16);
    p += 16;
    const credLen = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    if (credLen === 0 || p + credLen > bytes.length) {
      notWebauthn("The credential id length is out of range.");
    }
    data.credentialId = bytes.slice(p, p + credLen);
    p += credLen;
    const key = readCborItem(bytes, p);
    if (!(key.value instanceof Map))
      notWebauthn("The credential public key is not a COSE key map.");
    data.coseKey = key.value;
    p = key.next;
  }
  if (flags & 0x80) {
    const ext = readCborItem(bytes, p);
    data.extensions = ext.value;
    p = ext.next;
  }
  if (p < bytes.length) data.trailingBytes = bytes.length - p;
  return data;
}

/* --------------------------------------------------------------- rendering */

function yesNo(on: boolean): string {
  return on ? "yes" : "no";
}

function aaguidToUuid(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function algLabel(id: unknown): string {
  if (typeof id !== "number") return "not stated";
  const name = COSE_ALGS[String(id)];
  return name ? `${name} (${id})` : `unknown algorithm (${id})`;
}

function coseLabelName(kty: unknown, label: unknown): string {
  if (typeof label !== "number") return String(label);
  if (label > 0) {
    const common: Record<string, string> = {
      "1": "kty",
      "2": "kid",
      "3": "alg",
      "4": "key_ops",
      "5": "base_iv",
    };
    return common[String(label)] ?? `label ${label}`;
  }
  if (kty === 3) {
    if (label === -1) return "n";
    if (label === -2) return "e";
  } else {
    if (label === -1) return "crv";
    if (label === -2) return "x";
    if (label === -3) return "y";
  }
  return `label ${label}`;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return toHex(value);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[String(k)] = jsonSafe(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  return value;
}

function coseToJson(key: Map<unknown, unknown>): string {
  const kty = key.get(1);
  const out: Record<string, unknown> = {};
  for (const [label, value] of key) {
    out[coseLabelName(kty, label)] = jsonSafe(value);
  }
  return JSON.stringify(out);
}

function addCoseRows(rows: PasskeyTesterResult, key: Map<unknown, unknown>, full: boolean): void {
  const kty = key.get(1);
  rows["Key type"] =
    typeof kty === "number" ? (COSE_KTY[String(kty)] ?? `unknown key type (${kty})`) : "not stated";
  rows["Algorithm"] = algLabel(key.get(3));

  if (kty === 3) {
    const n = asBytes(key.get(-1));
    const e = asBytes(key.get(-2));
    if (n) rows["Modulus (n)"] = `${n.length} bytes (${n.length * 8} bit key)`;
    if (e) rows["Exponent (e)"] = `${e.length} bytes`;
  } else {
    const crv = key.get(-1);
    if (typeof crv === "number") {
      rows["Curve"] = COSE_CRV[String(crv)] ?? `unknown curve (${crv})`;
    }
    const x = asBytes(key.get(-2));
    const y = asBytes(key.get(-3));
    if (x) rows["Public key x"] = `${x.length} bytes`;
    if (y) rows["Public key y"] = `${y.length} bytes`;
  }
  if (full) rows["COSE public key (JSON)"] = coseToJson(key);
}

function addAuthDataRows(rows: PasskeyTesterResult, data: AuthData, full: boolean): void {
  const hash = toHex(data.rpIdHash);
  rows["RP ID hash (SHA-256)"] = full ? hash : `${hash.slice(0, 16)}...`;
  rows["Flags byte"] = `0x${data.flags.toString(16).padStart(2, "0")}`;
  rows["User present (UP)"] = yesNo((data.flags & 0x01) !== 0);
  rows["User verified (UV)"] = yesNo((data.flags & 0x04) !== 0);
  rows["Backup eligible (BE)"] = yesNo((data.flags & 0x08) !== 0);
  rows["Backed up (BS)"] = yesNo((data.flags & 0x10) !== 0);
  rows["Attested credential data (AT)"] = yesNo((data.flags & 0x40) !== 0);
  rows["Extension data (ED)"] = yesNo((data.flags & 0x80) !== 0);
  rows["Signature counter"] = String(data.signCount);
  rows["Authenticator data size"] = `${data.raw.length} bytes`;

  if (data.aaguid) {
    const uuid = aaguidToUuid(data.aaguid);
    rows["AAGUID"] = uuid;
    rows["Authenticator"] = /^0+$/.test(uuid.replace(/-/g, ""))
      ? "none reported (all zero AAGUID)"
      : (WELL_KNOWN_AAGUIDS[uuid] ?? "unknown AAGUID");
  }
  if (data.credentialId) {
    rows["Credential ID length"] = `${data.credentialId.length} bytes`;
    rows["Credential ID (base64url)"] = toBase64Url(data.credentialId);
    if (full) rows["Credential ID (hex)"] = toHex(data.credentialId);
  }
  if (data.coseKey) addCoseRows(rows, data.coseKey, full);
  if (data.trailingBytes) {
    rows["Trailing bytes"] =
      `${data.trailingBytes} unexpected byte(s) follow the authenticator data. Real authenticator data ends after the last flagged section; this may be padding or a truncated paste of something else.`;
  }
  if (data.extensions !== undefined) {
    rows["Extensions"] = JSON.stringify(jsonSafe(data.extensions));
  }
  if (full) rows["Authenticator data (hex)"] = toHex(data.raw);
}

function get(container: unknown, key: string): unknown {
  if (container instanceof Map) return container.get(key);
  if (container && typeof container === "object")
    return (container as Record<string, unknown>)[key];
  return undefined;
}

function addAttestationRows(rows: PasskeyTesterResult, decoded: unknown, full: boolean): void {
  const fmt = get(decoded, "fmt");
  rows["Attestation format"] = typeof fmt === "string" ? fmt : "not stated";

  const stmt = get(decoded, "attStmt");
  let fields: string[] = [];
  if (stmt instanceof Map) fields = [...stmt.keys()].map(String);
  else if (stmt && typeof stmt === "object") fields = Object.keys(stmt);

  if (fmt === "none") {
    rows["Attestation statement"] = "empty, the authenticator sent no attestation";
  } else if (fields.length) {
    rows["Attestation statement fields"] = fields.join(", ");
  }

  const alg = get(stmt, "alg");
  if (alg !== undefined) rows["Attestation algorithm"] = algLabel(alg);

  const x5c = get(stmt, "x5c");
  if (Array.isArray(x5c)) {
    rows["Certificate chain (x5c)"] =
      `present, ${x5c.length} ${x5c.length === 1 ? "certificate" : "certificates"}`;
  } else if (fmt !== "none" && fields.length) {
    rows["Certificate chain (x5c)"] = "absent (self attestation or no certificate)";
  }

  rows["Signature verification"] = "not performed, this tool decodes and explains only";
  if (full) rows["Attestation statement (JSON)"] = JSON.stringify(jsonSafe(stmt));
}

function addClientDataRows(rows: PasskeyTesterResult, b64: string, full: boolean): void {
  const text = new TextDecoder().decode(fromBase64Any(b64, "clientDataJSON"));
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    notWebauthn("The clientDataJSON did not contain valid JSON.");
  }
  if (typeof parsed.type === "string") rows["Client data type"] = parsed.type;
  if (typeof parsed.challenge === "string") rows["Challenge (base64url)"] = parsed.challenge;
  if (typeof parsed.origin === "string") rows["Origin"] = parsed.origin;
  rows["Cross origin"] = yesNo(parsed.crossOrigin === true);
  if (full) rows["Client data JSON (raw)"] = text;
}

/* -------------------------------------------------------------- entry path */

function readAttestationObject(
  bytes: Uint8Array,
): { decoded: unknown; authData: Uint8Array } | undefined {
  let decoded: unknown;
  try {
    decoded = cborDecode(bytes);
  } catch {
    return undefined;
  }
  const authData = asBytes(get(decoded, "authData"));
  if (!authData) return undefined;
  return { decoded, authData };
}

function decodeBinary(
  bytes: Uint8Array,
  full: boolean,
  rows: PasskeyTesterResult,
): PasskeyTesterResult {
  const attestation = readAttestationObject(bytes);
  if (attestation) {
    rows["Detected input"] ??= "attestation object (registration)";
    addAttestationRows(rows, attestation.decoded, full);
    addAuthDataRows(rows, parseAuthData(attestation.authData), full);
    return rows;
  }

  // Not an attestation object. Anything long enough to be authenticator data
  // is read as such, so a malformed one reports its own specific problem.
  if (bytes.length >= 37) {
    rows["Detected input"] ??= "authenticator data (raw bytes)";
    addAuthDataRows(rows, parseAuthData(bytes), full);
    return rows;
  }

  let cborOk = true;
  try {
    cborDecode(bytes);
  } catch {
    cborOk = false;
  }
  if (!cborOk) cborFail();
  notWebauthn("The value decoded as CBOR but is not an attestation object or authenticator data.");
}

function decodeJson(raw: string, full: boolean): PasskeyTesterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notWebauthn("The input looks like JSON but could not be parsed.");
  }
  const top = (parsed ?? {}) as Record<string, unknown>;
  const response = (top.response ?? top) as Record<string, unknown>;
  const attestationObject =
    typeof response.attestationObject === "string" ? response.attestationObject : undefined;
  const authenticatorData =
    typeof response.authenticatorData === "string" ? response.authenticatorData : undefined;
  if (!attestationObject && !authenticatorData) {
    notWebauthn("The JSON has no attestationObject and no authenticatorData.");
  }

  const rows: PasskeyTesterResult = {};
  rows["Detected input"] = attestationObject
    ? "credential JSON (registration)"
    : "credential JSON (authentication)";
  if (typeof top.type === "string") rows["Credential type"] = top.type;
  const id =
    typeof top.id === "string" ? top.id : typeof top.rawId === "string" ? top.rawId : undefined;
  if (id) rows["Credential ID from JSON"] = id;

  if (typeof response.clientDataJSON === "string") {
    addClientDataRows(rows, response.clientDataJSON, full);
  }

  decodeBinary(
    fromBase64Any((attestationObject ?? authenticatorData)!, "credential data"),
    full,
    rows,
  );

  if (typeof response.signature === "string") {
    const sig = fromBase64Any(response.signature, "signature");
    rows["Signature"] = `${sig.length} bytes`;
    if (full) rows["Signature (hex)"] = toHex(sig);
  }
  if (authenticatorData) {
    rows["User handle"] =
      typeof response.userHandle === "string" && response.userHandle
        ? response.userHandle
        : "not provided";
  }
  return rows;
}

export function run(input: string, opts: PasskeyTesterOpts): PasskeyTesterResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Paste a passkey credential to decode.",
      "Paste an attestationObject, raw authenticatorData, or the JSON your registration or authentication callback produced.",
    );
  }
  const full = (opts?.view ?? "summary") === "full";
  if (raw.startsWith("{") || raw.startsWith("[")) return decodeJson(raw, full);
  return decodeBinary(fromBase64Any(raw, "input"), full, {});
}

export default { run } satisfies ToolLogic<string, PasskeyTesterResult, PasskeyTesterOpts>;
