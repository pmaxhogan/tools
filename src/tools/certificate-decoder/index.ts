// `reflect-metadata` must be evaluated before @peculiar/x509 is imported: the
// ASN.1 schema decorators read the metadata reflection API at module scope and
// throw at import time without it. Keep this as the first import of the file.
// @peculiar/x509 itself is loaded lazily (see ../../lib/x509): in the
// production build it lands in a chunk shared with other tools, and a static
// import of it here would risk evaluating before this reflect-metadata
// import has run. `import type` below is erased at compile time, so it does
// not reintroduce that static import.
import "reflect-metadata";
import type * as X509 from "@peculiar/x509";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { loadX509, type X509 as X509Module } from "../../lib/x509";
import { ToolError, type ToolLogic } from "../types";

export interface CertificateDecoderOpts {
  /** "summary" (default) or "full". */
  view?: string;
  /**
   * Clock injection for the expiry math, in epoch milliseconds. Deliberately
   * absent from meta.options: it exists so tests are deterministic, not as a
   * user-facing control. Defaults to Date.now().
   */
  now?: number;
  [key: string]: unknown;
}

export type CertificateDecoderResult = Record<string, string>;

/* ------------------------------------------------------------------ */
/* Lookup tables                                                       */
/* ------------------------------------------------------------------ */

const KEY_USAGE_WORDS: ReadonlyArray<readonly [number, string]> = [
  [1, "Digital signature"],
  [2, "Non repudiation"],
  [4, "Key encipherment"],
  [8, "Data encipherment"],
  [16, "Key agreement"],
  [32, "Certificate signing"],
  [64, "CRL signing"],
  [128, "Encipher only"],
  [256, "Decipher only"],
];

const EXTENDED_KEY_USAGE_WORDS: Record<string, string> = {
  "2.5.29.37.0": "Any extended key usage",
  "1.3.6.1.5.5.7.3.1": "TLS server authentication",
  "1.3.6.1.5.5.7.3.2": "TLS client authentication",
  "1.3.6.1.5.5.7.3.3": "Code signing",
  "1.3.6.1.5.5.7.3.4": "Email protection",
  "1.3.6.1.5.5.7.3.5": "IPsec end system",
  "1.3.6.1.5.5.7.3.6": "IPsec tunnel",
  "1.3.6.1.5.5.7.3.7": "IPsec user",
  "1.3.6.1.5.5.7.3.8": "Time stamping",
  "1.3.6.1.5.5.7.3.9": "OCSP signing",
  "1.3.6.1.4.1.311.10.3.4": "Microsoft encrypting file system",
  "1.3.6.1.4.1.311.20.2.2": "Microsoft smart card logon",
};

const EXTENSION_NAMES: Record<string, string> = {
  "2.5.29.9": "Subject directory attributes",
  "2.5.29.14": "Subject key identifier",
  "2.5.29.15": "Key usage",
  "2.5.29.16": "Private key usage period",
  "2.5.29.17": "Subject alternative name",
  "2.5.29.18": "Issuer alternative name",
  "2.5.29.19": "Basic constraints",
  "2.5.29.30": "Name constraints",
  "2.5.29.31": "CRL distribution points",
  "2.5.29.32": "Certificate policies",
  "2.5.29.33": "Policy mappings",
  "2.5.29.35": "Authority key identifier",
  "2.5.29.36": "Policy constraints",
  "2.5.29.37": "Extended key usage",
  "2.5.29.46": "Freshest CRL",
  "2.5.29.54": "Inhibit any policy",
  "1.3.6.1.5.5.7.1.1": "Authority information access",
  "1.3.6.1.5.5.7.1.11": "Subject information access",
  "1.3.6.1.5.5.7.1.24": "TLS feature (OCSP must staple)",
  "1.3.6.1.4.1.11129.2.4.2": "Signed certificate timestamps",
};

const SIGNATURE_NAMES: Record<string, string> = {
  "RSASSA-PKCS1-v1_5": "RSA PKCS#1 v1.5",
  "RSA-PSS": "RSA-PSS",
  ECDSA: "ECDSA",
  Ed25519: "Ed25519",
  Ed448: "Ed448",
};

const SAN_LABELS: Record<string, string> = {
  dns: "DNS",
  ip: "IP",
  email: "email",
  url: "URI",
  dn: "directory name",
  guid: "GUID",
  upn: "UPN",
  id: "registered ID",
};

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

function colonHex(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return (hex.match(/../g) ?? []).join(":");
}

function normalizeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return clean.length % 2 === 1 ? `0${clean}` : clean;
}

function humanDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Plain-English validity, relative to an injected clock. */
export function describeValidity(notBefore: Date, notAfter: Date, now: number): string {
  const start = notBefore.getTime();
  const end = notAfter.getTime();
  if (now < start) return `not valid yet, starts in ${humanDuration(start - now)}`;
  if (now > end) return `EXPIRED ${humanDuration(now - end)} ago`;
  return `expires in ${humanDuration(end - now)}`;
}

/** "RSA 2048", "EC P-256", "Ed25519". */
function describePublicKey(algorithm: Algorithm): string {
  const name = algorithm.name;
  if (name.startsWith("RSA")) {
    const bits = (algorithm as RsaHashedKeyAlgorithm).modulusLength;
    return bits ? `RSA ${bits}` : "RSA";
  }
  if (name === "ECDSA" || name === "ECDH") {
    const curve = (algorithm as EcKeyAlgorithm).namedCurve;
    return curve ? `EC ${curve}` : "EC";
  }
  return name;
}

/** "ECDSA with SHA-256", "Ed25519" (no hash on the pure EdDSA algorithms). */
function describeSignature(algorithm: X509.HashedAlgorithm): string {
  const base = SIGNATURE_NAMES[algorithm.name] ?? algorithm.name;
  const hash = algorithm.hash?.name;
  return hash ? `${base} with ${hash}` : base;
}

function describeKeyUsage(flags: number): string {
  const words = KEY_USAGE_WORDS.filter(([bit]) => (flags & bit) !== 0).map(([, word]) => word);
  return words.length ? words.join(", ") : "none set";
}

function describeDistinguishedName(name: X509.Name): string {
  const parts: string[] = [];
  for (const rdn of name.toJSON()) {
    for (const [key, values] of Object.entries(rdn)) {
      const texts = (values as unknown[]).map((v) =>
        typeof v === "string" ? v : Object.values(v as Record<string, string>).join(""),
      );
      parts.push(`${key}=${texts.join("+")}`);
    }
  }
  return parts.length ? parts.join(", ") : "(empty)";
}

/** Adds a row, keeping every key unique so nothing is silently overwritten. */
function put(out: CertificateDecoderResult, key: string, value: string): void {
  if (!(key in out)) {
    out[key] = value;
    return;
  }
  let n = 2;
  while (`${key} (${n})` in out) n += 1;
  out[`${key} (${n})`] = value;
}

/* ------------------------------------------------------------------ */
/* Input handling                                                      */
/* ------------------------------------------------------------------ */

const CERT_BLOCK_RE =
  /-----BEGIN (?:TRUSTED |X509 )?CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END (?:TRUSTED |X509 )?CERTIFICATE-----/g;
const ANY_BLOCK_RE = /-----BEGIN ([A-Z0-9][A-Z0-9 ]*)-----/g;
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]+$/;

const PARSE_FIX =
  "Paste a certificate: the block between BEGIN CERTIFICATE and END CERTIFICATE, a bare base64 DER certificate, or a .cer/.crt/.der file. A private key or a certificate signing request will not decode here.";

/** Names any non-certificate PEM block, so the error can say what was found. */
function findOtherBlocks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ANY_BLOCK_RE)) {
    const label = match[1].trim();
    if (/CERTIFICATE$/.test(label)) continue;
    if (!found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * Pulls every base64 certificate body out of arbitrary text: PEM blocks
 * embedded in an nginx config or `openssl s_client` output, or a bare base64
 * DER blob with no armor at all.
 */
function extractCandidates(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(CERT_BLOCK_RE)) {
    const body = match[1].replace(/\s+/g, "");
    if (body.length > 0) blocks.push(body);
  }
  if (blocks.length > 0) return blocks;

  const others = findOtherBlocks(text);
  const keyOrRequest = others.filter((label) =>
    /PRIVATE KEY|PUBLIC KEY|CERTIFICATE REQUEST/.test(label),
  );
  if (keyOrRequest.length > 0) {
    throw new ToolError(
      "bad-der",
      `That is a ${keyOrRequest.join(" and ")} block, not a certificate.`,
      PARSE_FIX,
    );
  }

  const compact = text.replace(/\s+/g, "");
  if (compact.length >= 100 && BASE64ISH_RE.test(compact)) return [compact];

  throw new ToolError(
    "no-cert",
    others.length > 0
      ? `No certificate found. The input holds a ${others.join(" and ")} block instead.`
      : "No certificate found in the input.",
    PARSE_FIX,
  );
}

function parseCandidates(
  x509: X509Module,
  candidates: (string | Uint8Array)[],
): X509.X509Certificate[] {
  const total = candidates.length;
  return candidates.map((candidate, i) => {
    try {
      // The copy is only for typing: it pins the backing buffer to ArrayBuffer,
      // which is what @peculiar/x509 declares it accepts.
      return new x509.X509Certificate(
        typeof candidate === "string" ? candidate : new Uint8Array(candidate),
      );
    } catch {
      throw new ToolError(
        "bad-der",
        total > 1
          ? `Certificate ${i + 1} of ${total} could not be parsed as X.509 DER.`
          : "That input could not be parsed as an X.509 certificate.",
        PARSE_FIX,
      );
    }
  });
}

function decodeInput(x509: X509Module, input: string | Uint8Array): X509.X509Certificate[] {
  if (input instanceof Uint8Array) {
    if (input.length === 0) throw new ToolError("empty-input", "Drop or paste a certificate.");
    const asText = new TextDecoder("utf-8", { fatal: false }).decode(input);
    if (asText.includes("-----BEGIN")) return parseCandidates(x509, extractCandidates(asText));
    return parseCandidates(x509, [input]);
  }

  const text = input ?? "";
  if (text.trim().length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter a certificate to decode.",
      "Paste a PEM block starting with -----BEGIN CERTIFICATE----- or drop a .crt, .cer, or .pem file.",
    );
  }
  return parseCandidates(x509, extractCandidates(text));
}

/* ------------------------------------------------------------------ */
/* Row builders                                                        */
/* ------------------------------------------------------------------ */

function summaryRows(
  x509: X509Module,
  cert: X509.X509Certificate,
  der: Uint8Array,
  now: number,
  prefix: string,
  out: CertificateDecoderResult,
): void {
  const row = (label: string, value: string) => put(out, `${prefix}${label}`, value);

  row("Subject", cert.subject || "(empty)");
  row("Issuer", cert.issuer || "(empty)");
  row("Serial", normalizeHexString(cert.serialNumber));
  row("Not before", cert.notBefore.toISOString());
  row("Not after", cert.notAfter.toISOString());
  row("Validity", describeValidity(cert.notBefore, cert.notAfter, now));
  row("Public key", describePublicKey(cert.publicKey.algorithm));
  row("Signature algorithm", describeSignature(cert.signatureAlgorithm));

  const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
  if (san) {
    const names = san.names
      .toJSON()
      .map((n) => `${SAN_LABELS[n.type] ?? n.type} ${n.value}`)
      .join(", ");
    row("Subject alternative names", names || "none");
  } else {
    row("Subject alternative names", "none");
  }

  const keyUsage = cert.getExtension(x509.KeyUsagesExtension);
  row(
    "Key usage",
    keyUsage ? describeKeyUsage(keyUsage.usages) : "not restricted (no key usage extension)",
  );

  const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
  row(
    "Extended key usage",
    eku
      ? eku.usages.map((oid) => EXTENDED_KEY_USAGE_WORDS[String(oid)] ?? String(oid)).join(", ") ||
          "none"
      : "not restricted (no extended key usage extension)",
  );

  const basic = cert.getExtension(x509.BasicConstraintsExtension);
  if (!basic) {
    row("Basic constraints", "not present, so this is treated as an end entity certificate");
  } else if (!basic.ca) {
    row("Basic constraints", "CA: no (end entity certificate)");
  } else if (typeof basic.pathLength === "number") {
    row("Basic constraints", `CA: yes, path length ${basic.pathLength}`);
  } else {
    row("Basic constraints", "CA: yes, no path length limit");
  }

  const ski = cert.getExtension(x509.SubjectKeyIdentifierExtension);
  const aki = cert.getExtension(x509.AuthorityKeyIdentifierExtension);
  const keyIdsMatch = Boolean(ski && aki?.keyId && ski.keyId === aki.keyId);
  if (cert.subject === cert.issuer) {
    row(
      "Self signed",
      keyIdsMatch
        ? "Likely yes: subject equals issuer, and the authority key identifier matches the subject key identifier. The signature is not verified."
        : "Likely yes: subject equals issuer. The signature is not verified.",
    );
  } else {
    row(
      "Self signed",
      "No: the issuer differs from the subject, so another certificate signed this one.",
    );
  }

  row("SHA-256 fingerprint", colonHex(sha256(der)));
  row("SHA-1 fingerprint", colonHex(sha1(der)));
  if (ski) row("Subject key identifier", normalizeHexString(ski.keyId));
  if (aki?.keyId) row("Authority key identifier", normalizeHexString(aki.keyId));
}

function fullRows(cert: X509.X509Certificate, prefix: string, out: CertificateDecoderResult): void {
  put(out, `${prefix}Subject components`, describeDistinguishedName(cert.subjectName));
  put(out, `${prefix}Issuer components`, describeDistinguishedName(cert.issuerName));
  for (const ext of cert.extensions) {
    const name = EXTENSION_NAMES[ext.type];
    const label = name
      ? `${prefix}Extension ${ext.type} (${name})`
      : `${prefix}Extension ${ext.type}`;
    const critical = ext.critical ? "critical" : "not critical";
    put(out, label, `${critical}, value ${toHex(new Uint8Array(ext.value))}`);
  }
}

function chainRows(
  x509: X509Module,
  certs: X509.X509Certificate[],
  out: CertificateDecoderResult,
): void {
  const broken: number[] = [];
  for (let i = 0; i < certs.length - 1; i += 1) {
    const linked = certs[i].issuer === certs[i + 1].subject;
    if (!linked) broken.push(i + 1);
    put(
      out,
      `Chain ${i + 1} to ${i + 2}`,
      linked
        ? `cert ${i + 1} issuer matches cert ${i + 2} subject, so this is a likely chain link`
        : `cert ${i + 1} issuer "${certs[i].issuer}" does not match cert ${i + 2} subject "${certs[i + 1].subject}"`,
    );
  }

  const last = certs[certs.length - 1];
  const first = certs[0];
  const lastSelfSigned = last.subject === last.issuer;
  const firstIsCa = first.getExtension(x509.BasicConstraintsExtension)?.ca === true;
  const reversed = certs.every((cert, i) => i === 0 || cert.issuer === certs[i - 1].subject);

  let verdict: string;
  if (broken.length === 0) {
    const shape = certs.length > 2 ? "leaf -> intermediate -> root" : "leaf -> root";
    if (!lastSelfSigned) {
      verdict = `Order looks correct, but the last certificate is not self signed, so the chain is probably missing its root.`;
    } else if (firstIsCa) {
      verdict = `Order looks correct, but the first certificate is a CA, so there is no leaf certificate in this chain.`;
    } else {
      verdict = `${shape} order looks correct.`;
    }
  } else if (reversed) {
    verdict =
      "The chain looks reversed: the root is first. Put the leaf certificate first, then each issuer after it.";
  } else {
    const pairs = broken.map((n) => `${n} and ${n + 1}`).join("; ");
    verdict = `Order is wrong: certificates ${pairs} do not chain. Put the leaf first, then each issuer after it.`;
  }
  put(out, "Chain order", verdict);
  put(
    out,
    "Chain note",
    "Names and order only. This tool does not verify chain signatures, so a matching name is not proof of a valid chain.",
  );
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function run(
  input: string | Uint8Array,
  opts: CertificateDecoderOpts = {},
): Promise<CertificateDecoderResult> {
  const x509 = await loadX509();
  const certs = decodeInput(x509, input);
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const full = opts.view === "full";

  const out: CertificateDecoderResult = {};
  if (certs.length > 1) put(out, "Certificates found", String(certs.length));

  certs.forEach((cert, i) => {
    const prefix = certs.length > 1 ? `Cert ${i + 1}: ` : "";
    const der = new Uint8Array(cert.rawData);
    summaryRows(x509, cert, der, now, prefix, out);
    if (full) fullRows(cert, prefix, out);
  });

  if (certs.length > 1) chainRows(x509, certs, out);
  return out;
}

export default { run } satisfies ToolLogic<
  string | Uint8Array,
  CertificateDecoderResult,
  CertificateDecoderOpts
>;
