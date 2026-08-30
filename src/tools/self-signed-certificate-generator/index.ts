// `reflect-metadata` must be evaluated before @peculiar/x509 is imported: the
// ASN.1 schema decorators read the metadata reflection API at module scope and
// throw at import time without it. Keep this as the first import of the file.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { ToolError, type ToolLogic } from "../types";

export interface SelfSignedCertOpts {
  /** Subject and issuer common name, usually the hostname. */
  commonName?: string;
  /** Subject organization (O). Left out when empty. */
  organization?: string;
  /** Subject country (C), a two letter ISO 3166-1 code. Left out when empty. */
  country?: string;
  /** Comma or newline separated subject alternative names: hostnames and IP addresses. */
  sans?: string;
  /** How many days the certificate is valid for, starting now. */
  days?: number;
  /** "rsa-2048" or "ecdsa-p256" (default). */
  keyAlgorithm?: string;
  /** "server" (default), "client", or "ca". */
  usage?: string;
  /**
   * Clock override in unix seconds for notBefore, so tests are deterministic.
   * 0 means use the real clock. Not a panel option: a certificate backdated by
   * hand is a support ticket waiting to happen.
   */
  now?: number;
  [key: string]: unknown;
}

export type SelfSignedCertResult = Record<string, string>;

const MS_PER_DAY = 86_400_000;
const MIN_DAYS = 1;
const MAX_DAYS = 7300;
const DEFAULT_DAYS = 825;
/** Public browsers reject a server certificate valid for more than 398 days. */
const BROWSER_MAX_DAYS = 398;
/** Certificate serial numbers must be positive, so the top bit stays clear. */
const SERIAL_BYTES = 8;

const RSA_MODULUS_BITS = 2048;

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Escapes one attribute value for an RFC 4514 distinguished name string: the
 * six special characters, a leading # or space, and a trailing space.
 */
export function escapeDnValue(value: string): string {
  return value
    .replace(/([\\,+"<>;=])/g, "\\$1")
    .replace(/^([#\s])/, "\\$1")
    .replace(/(\s)$/, "\\$1");
}

/** Builds `CN=..., O=..., C=...`, skipping the parts that were left blank. */
export function buildSubject(commonName: string, organization: string, country: string): string {
  const parts = [`CN=${escapeDnValue(commonName)}`];
  if (organization) parts.push(`O=${escapeDnValue(organization)}`);
  if (country) parts.push(`C=${escapeDnValue(country)}`);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ */
/* Subject alternative names                                           */
/* ------------------------------------------------------------------ */

export interface ParsedSans {
  dns: string[];
  ip: string[];
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Loose IPv6 shape check: hex groups and at most one :: run. */
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function looksLikeIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value);
  return m !== null && [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255);
}

function looksLikeIpv6(value: string): boolean {
  return value.includes(":") && IPV6_RE.test(value) && (value.match(/::/g) ?? []).length <= 1;
}

/**
 * Splits the SAN list on commas, semicolons, and newlines, then sorts each
 * entry into the DNS or the IP bucket. A bare IP written as a DNS name is the
 * classic reason a certificate fails against an IP address, so the split is
 * done here rather than left to the caller.
 */
export function parseSans(raw: string): ParsedSans {
  const dns: string[] = [];
  const ip: string[] = [];
  const seen = new Set<string>();
  for (const piece of (raw ?? "").split(/[,;\n\r]+/)) {
    const value = piece.trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    if (looksLikeIpv4(value) || looksLikeIpv6(value)) {
      ip.push(value);
      continue;
    }
    if (!/^[A-Za-z0-9*._-]+$/.test(value)) {
      throw new ToolError(
        "bad-san",
        `"${value}" is not a usable subject alternative name.`,
        "List hostnames such as example.com or *.example.com, and IP addresses such as 127.0.0.1, separated by commas.",
      );
    }
    dns.push(value);
  }
  return { dns, ip };
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

type KeyAlgorithm = "rsa-2048" | "ecdsa-p256";
type UsagePreset = "server" | "client" | "ca";

function textOption(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function pickKeyAlgorithm(raw: unknown): KeyAlgorithm {
  const value = typeof raw === "string" && raw ? raw : "ecdsa-p256";
  if (value === "rsa-2048" || value === "ecdsa-p256") return value;
  throw new ToolError(
    "bad-option",
    `The option "keyAlgorithm" does not recognize "${String(raw)}".`,
    "Choose RSA 2048 or ECDSA P-256.",
  );
}

function pickUsage(raw: unknown): UsagePreset {
  const value = typeof raw === "string" && raw ? raw : "server";
  if (value === "server" || value === "client" || value === "ca") return value;
  throw new ToolError(
    "bad-option",
    `The option "usage" does not recognize "${String(raw)}".`,
    "Choose Server TLS, Client TLS, or Certificate authority.",
  );
}

function pickDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    throw new ToolError(
      "bad-option",
      `The option "days" must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}.`,
      `The default is ${DEFAULT_DAYS} days, which is a little over two years.`,
    );
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array, separator = ""): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(separator);
}

function isoDay(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Describes the extensions the preset actually wrote. RSA server certificates
 * additionally claim key encipherment, which an EC key can never do, so the
 * wording follows the key algorithm rather than the preset alone.
 */
function usageLabel(usage: UsagePreset, algorithm: KeyAlgorithm): string {
  if (usage === "ca")
    return "Certificate authority: certificate signing and CRL signing, basic constraints CA true";
  if (usage === "client") return "Client TLS: digital signature, extended key usage clientAuth";
  return algorithm === "rsa-2048"
    ? "Server TLS: digital signature and key encipherment, extended key usage serverAuth"
    : "Server TLS: digital signature, extended key usage serverAuth";
}

const KEY_LABEL: Record<KeyAlgorithm, string> = {
  "rsa-2048": "RSA 2048 bit, signed with RSASSA-PKCS1-v1_5 and SHA-256",
  "ecdsa-p256": "ECDSA on NIST P-256, signed with ECDSA and SHA-256",
};

/* ------------------------------------------------------------------ */
/* PEM                                                                 */
/* ------------------------------------------------------------------ */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

/** Wraps DER bytes into a 64 column PEM block. */
export function toPem(label: string, bytes: Uint8Array): string {
  const body = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

function keyGenParams(algorithm: KeyAlgorithm) {
  return algorithm === "rsa-2048"
    ? {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: RSA_MODULUS_BITS,
        publicExponent: new Uint8Array([1, 0, 1]),
      }
    : { name: "ECDSA", namedCurve: "P-256" };
}

function extensionsFor(usage: UsagePreset, algorithm: KeyAlgorithm): x509.Extension[] {
  if (usage === "ca") {
    return [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ];
  }
  // RSA can also be used to encipher a key, which the old TLS RSA key exchange
  // needed; an EC key never can, so claiming it would be a lie in the profile.
  const keyUsages =
    usage === "server" && algorithm === "rsa-2048"
      ? x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
      : x509.KeyUsageFlags.digitalSignature;
  return [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(keyUsages, true),
    new x509.ExtendedKeyUsageExtension(
      [usage === "server" ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth],
      false,
    ),
  ];
}

export async function run(
  _input: undefined,
  opts: SelfSignedCertOpts,
): Promise<SelfSignedCertResult> {
  const commonName = textOption(opts.commonName) || "localhost";
  const organization = textOption(opts.organization);
  const country = textOption(opts.country);
  if (country && !/^[A-Za-z]{2}$/.test(country)) {
    throw new ToolError(
      "bad-country",
      `"${country}" is not a two letter country code.`,
      "Use an ISO 3166-1 alpha-2 code such as US, GB, or DE, or leave the field empty.",
    );
  }

  const algorithm = pickKeyAlgorithm(opts.keyAlgorithm);
  const usage = pickUsage(opts.usage);
  const days = pickDays(opts.days);
  const sans = parseSans(textOption(opts.sans) || commonName);

  const nowOverride = Number(opts.now ?? 0);
  const notBefore = new Date(
    Number.isFinite(nowOverride) && nowOverride > 0 ? nowOverride * 1000 : Date.now(),
  );
  const notAfter = new Date(notBefore.getTime() + days * MS_PER_DAY);

  const serial = new Uint8Array(SERIAL_BYTES);
  crypto.getRandomValues(serial);
  serial[0] = (serial[0] as number) & 0x7f;

  const keys = (await crypto.subtle.generateKey(keyGenParams(algorithm), true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const extensions = extensionsFor(usage, algorithm);
  if (sans.dns.length > 0 || sans.ip.length > 0) {
    // The extension takes a flat list of typed general names, so hostnames and
    // IP addresses are two different `type` values rather than two fields.
    extensions.push(
      new x509.SubjectAlternativeNameExtension([
        ...sans.dns.map((value) => ({ type: "dns" as const, value })),
        ...sans.ip.map((value) => ({ type: "ip" as const, value })),
      ]),
    );
  }
  extensions.push(await x509.SubjectKeyIdentifierExtension.create(keys.publicKey));

  const subject = buildSubject(commonName, organization, country);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: toHex(serial),
    name: subject,
    notBefore,
    notAfter,
    signingAlgorithm:
      algorithm === "rsa-2048"
        ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
        : { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions,
  });

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const sha256 = new Uint8Array(await certificate.getThumbprint("SHA-256"));
  const sha1 = new Uint8Array(await certificate.getThumbprint("SHA-1"));

  const result: SelfSignedCertResult = {
    "Certificate (PEM)": certificate.toString("pem").replace(/\r\n/g, "\n").trimEnd() + "\n",
    "Private key (PKCS#8 PEM)": toPem("PRIVATE KEY", pkcs8),
    Subject: subject,
    Issuer: `${subject} (self signed, so the issuer is the subject)`,
    "Serial number": toHex(serial),
    "Key algorithm": KEY_LABEL[algorithm],
    "Key usage preset": usageLabel(usage, algorithm),
    "Subject alternative names":
      sans.dns.length + sans.ip.length === 0
        ? "none"
        : [...sans.dns.map((d) => `DNS:${d}`), ...sans.ip.map((i) => `IP:${i}`)].join(", "),
    "Valid from": isoDay(notBefore),
    "Valid until": `${isoDay(notAfter)} (${days} day${days === 1 ? "" : "s"})`,
    "SHA-256 fingerprint": toHex(sha256, ":").toUpperCase(),
    "SHA-1 fingerprint": toHex(sha1, ":").toUpperCase(),
    "How to use it":
      "Save the certificate as cert.pem and the key as key.pem, then point your server at both. Because nothing signed this certificate but itself, browsers and curl will reject it until you add cert.pem to the trust store you are testing against, or pass a flag such as curl --cacert cert.pem.",
  };

  if (usage !== "ca" && days > BROWSER_MAX_DAYS) {
    result.Note = `Public browsers refuse a server certificate whose lifetime is longer than ${BROWSER_MAX_DAYS} days. That limit applies to publicly trusted certificates, so a ${days} day certificate is fine for a local trust store, but shorten it if a browser is going to check the lifetime.`;
  }

  return result;
}

export default { run } satisfies ToolLogic<undefined, SelfSignedCertResult, SelfSignedCertOpts>;
