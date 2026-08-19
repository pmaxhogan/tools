import { ToolError, type ToolLogic } from "../types";

/**
 * DNS Lookup: query one record over DNS-over-HTTPS at a resolver you pick, or
 * parse a DoH JSON response you already have.
 *
 * This layer is pure by contract (PROJECT.md rule 27): it never fetches. It
 * builds the DoH request URL the panel should fetch and parses the JSON DoH
 * response that comes back. The panel owns the network.
 */

export interface Resolver {
  id: string;
  label: string;
  /** JSON DoH endpoint (RFC 8484 style GET with name/type query params). */
  dohUrl: string;
  /**
   * True when the endpoint needs an explicit `ct=application/dns-json` param
   * because its default content type is the binary wire format.
   */
  needsContentTypeParam?: boolean;
}

/** The three public resolvers this tool can query. All speak JSON DoH. */
export const RESOLVERS: Resolver[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    dohUrl: "https://cloudflare-dns.com/dns-query",
    needsContentTypeParam: true,
  },
  {
    id: "google",
    label: "Google",
    dohUrl: "https://dns.google/resolve",
  },
  {
    id: "dnssb",
    label: "dns.sb",
    dohUrl: "https://doh.sb/dns-query",
  },
];

/** Record types this tool will query. */
export const RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "SOA",
  "SRV",
  "CAA",
  "PTR",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** Numeric RR type to mnemonic, covering the common types plus what resolvers
 * hand back inside an answer chain (CNAME hops, RRSIG on a signed zone). */
const RR_TYPE_NAMES: Record<number, string> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  12: "PTR",
  13: "HINFO",
  15: "MX",
  16: "TXT",
  17: "RP",
  24: "SIG",
  25: "KEY",
  28: "AAAA",
  29: "LOC",
  33: "SRV",
  35: "NAPTR",
  36: "KX",
  37: "CERT",
  39: "DNAME",
  41: "OPT",
  43: "DS",
  44: "SSHFP",
  46: "RRSIG",
  47: "NSEC",
  48: "DNSKEY",
  50: "NSEC3",
  51: "NSEC3PARAM",
  52: "TLSA",
  59: "CDS",
  60: "CDNSKEY",
  61: "OPENPGPKEY",
  64: "SVCB",
  65: "HTTPS",
  99: "SPF",
  108: "EUI48",
  109: "EUI64",
  249: "TKEY",
  250: "TSIG",
  252: "AXFR",
  255: "ANY",
  256: "URI",
  257: "CAA",
};

/** DNS RCODEs as they appear in the JSON DoH `Status` field. */
const STATUS_NAMES: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
  6: "YXDOMAIN",
  7: "YXRRSET",
  8: "NXRRSET",
  9: "NOTAUTH",
  10: "NOTZONE",
  16: "BADVERS",
};

/** Plain language gloss for the statuses a user is likely to hit. */
const STATUS_NOTES: Record<string, string> = {
  NOERROR: "the query succeeded",
  FORMERR: "the resolver could not read the query",
  SERVFAIL: "the resolver failed, often a broken or unsigned DNSSEC chain",
  NXDOMAIN: "the domain does not exist",
  NOTIMP: "the resolver does not implement this query",
  REFUSED: "the resolver refused to answer",
  NOTAUTH: "the resolver is not authoritative for this zone",
};

/** Maps a numeric RR type to its mnemonic, or "TYPEn" for anything unknown. */
export function rrTypeName(type: unknown): string {
  if (typeof type === "string" && type.trim() !== "" && Number.isNaN(Number(type))) {
    return type.trim().toUpperCase();
  }
  const n = Number(type);
  if (!Number.isFinite(n) || n < 0) return "UNKNOWN";
  return RR_TYPE_NAMES[n] ?? `TYPE${n}`;
}

/** Maps a numeric RCODE to its label, with a short plain-English gloss. */
export function describeStatus(status: unknown): string {
  const n = Number(status);
  if (!Number.isFinite(n)) return "UNKNOWN";
  const name = STATUS_NAMES[n] ?? `RCODE${n}`;
  const note = STATUS_NOTES[name];
  return note ? `${name} (${note})` : name;
}

/** Just the mnemonic, no gloss. */
export function statusCodeName(status: unknown): string {
  const n = Number(status);
  if (!Number.isFinite(n)) return "UNKNOWN";
  return STATUS_NAMES[n] ?? `RCODE${n}`;
}

/* ------------------------------------------------------------------ *
 * input normalization and validation
 * ------------------------------------------------------------------ */

const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * Accepts what people actually paste (a full URL, a bracketed IPv6 host, a
 * trailing dot, mixed case) and returns the bare lowercase host. Does not
 * strip a trailing `:port` from a bare IPv6 literal, since that would mangle
 * the address (an IPv6 address has more than one colon; a `host:port` pair
 * or an IPv4 `host:port` pair only ever has one).
 */
export function normalizeInput(raw: string): string {
  let s = (raw ?? "").trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^/@]*@/, "");
  const bracketed = s.match(/^\[([^\]]+)\](?::\d+)?(.*)$/);
  if (bracketed) {
    s = (bracketed[1] ?? "") + (bracketed[2] ?? "");
  }
  s = s.split(/[/?#]/)[0] ?? "";
  const colonCount = (s.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    s = s.replace(/:\d+$/, "");
  }
  s = s.replace(/\.$/, "");
  return s.toLowerCase();
}

/** True when the string is a dotted-quad IPv4 address. */
export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Expands an IPv6 literal to its 8 zero-padded hex groups, resolving a `::`
 * compression. Returns null when the string is not a valid IPv6 literal.
 * Embedded IPv4 tails (`::ffff:192.0.2.1`) are not supported.
 */
function expandIPv6Groups(raw: string): string[] | null {
  const ip = raw.trim();
  if (!ip || ip.includes(".")) return null;
  const doubleColonCount = (ip.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let groups: string[];
  if (ip.includes("::")) {
    const [before, after] = ip.split("::");
    const head = before ? before.split(":") : [];
    const tail = after ? after.split(":") : [];
    const missing = 8 - (head.length + tail.length);
    // "::" must stand in for at least one group of zeros (RFC 5952); a
    // fully written address should not also carry a "::".
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = ip.split(":");
  }

  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.toLowerCase().padStart(4, "0"));
}

/** True when the string is an IPv6 literal (any valid compression form). */
export function isIPv6(s: string): boolean {
  return expandIPv6Groups(s) !== null;
}

/**
 * Builds the reverse-DNS PTR query name for an IPv4 or IPv6 address, e.g.
 * "192.0.2.1" -> "1.2.0.192.in-addr.arpa" and "2001:db8::1" -> the nibble
 * form under ip6.arpa. Throws `ToolError` when the input is neither.
 */
export function toPtrName(ip: string): string {
  const trimmed = (ip ?? "").trim();
  if (isIPv4(trimmed)) {
    return `${trimmed.split(".").reverse().join(".")}.in-addr.arpa`;
  }
  const groups = expandIPv6Groups(trimmed);
  if (groups) {
    const nibbles = groups.join("").split("").reverse().join(".");
    return `${nibbles}.ip6.arpa`;
  }
  throw new ToolError(
    "invalid-domain",
    `"${ip}" is not a valid IPv4 or IPv6 address.`,
    "Use an address like 192.0.2.1 or 2001:db8::1.",
  );
}

/** Validates a record type and returns it uppercased, or throws. */
export function assertRecordType(raw: string | undefined): RecordType {
  const type = (raw ?? "A").trim().toUpperCase();
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new ToolError(
      "invalid-type",
      `"${raw}" is not a record type this tool can query.`,
      `Pick one of ${RECORD_TYPES.join(", ")}.`,
    );
  }
  return type as RecordType;
}

function resolveResolver(resolver: Resolver | string): Resolver {
  if (typeof resolver !== "string") return resolver;
  const found = RESOLVERS.find((r) => r.id === resolver.trim().toLowerCase());
  if (!found) {
    throw new ToolError(
      "invalid-resolver",
      `"${resolver}" is not one of the resolvers this tool queries.`,
      `Use one of ${RESOLVERS.map((r) => r.id).join(", ")}.`,
    );
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * request building
 * ------------------------------------------------------------------ */

/**
 * Builds the GET URL for one resolver. The panel fetches this with
 * `Accept: application/dns-json`; the `ct` param is there for the endpoints
 * that would otherwise answer in the binary wire format.
 */
export function buildQueryUrl(
  resolver: Resolver | string,
  name: string,
  type: string = "A",
): string {
  const target = resolveResolver(resolver);
  const recordType = assertRecordType(type);
  const host = normalizeInput(name ?? "");
  if (!host) {
    throw new ToolError(
      "empty-input",
      "Enter a domain name or IP address to look up.",
      "Try example.com or 192.0.2.1.",
    );
  }
  const params = [`name=${encodeURIComponent(host)}`, `type=${encodeURIComponent(recordType)}`];
  if (target.needsContentTypeParam) {
    params.push(`ct=${encodeURIComponent("application/dns-json")}`);
  }
  return `${target.dohUrl}?${params.join("&")}`;
}

/* ------------------------------------------------------------------ *
 * response parsing
 * ------------------------------------------------------------------ */

export interface DohAnswer {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export interface ParsedDoh {
  /** Status label with its gloss, e.g. "NOERROR (the query succeeded)". */
  status: string;
  /** Bare mnemonic, e.g. "NXDOMAIN". */
  statusCode: string;
  /** The queried name and type, when the response includes a Question section. */
  question?: string;
  answers: DohAnswer[];
}

const INVALID_DOH_FIX =
  'A DoH response is an object like {"Status":0,"Answer":[{"name":"example.com","type":1,"TTL":300,"data":"93.184.216.34"}]}.';

/**
 * Parses a pasted JSON DoH response. Missing or empty `Answer` is normal
 * (NXDOMAIN, or a name with no record of that type), so it yields an empty
 * answer list rather than an error. Throws `ToolError('invalid-json', ...)`
 * on a string that is not valid JSON or a value that is not an object.
 */
export function parseDohResponse(json: unknown): ParsedDoh {
  let value: unknown = json;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ToolError(
        "invalid-json",
        "That doesn't look like valid JSON.",
        INVALID_DOH_FIX,
      );
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError(
      "invalid-json",
      "That JSON is not a DoH response object.",
      INVALID_DOH_FIX,
    );
  }

  const obj = value as Record<string, unknown>;
  const rawAnswers = Array.isArray(obj.Answer)
    ? obj.Answer
    : Array.isArray(obj.answer)
      ? (obj.answer as unknown[])
      : [];

  const answers: DohAnswer[] = [];
  for (const entry of rawAnswers) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const ttlRaw = row.TTL ?? row.ttl;
    const ttl = Number(ttlRaw);
    answers.push({
      name: String(row.name ?? "").replace(/\.$/, ""),
      type: rrTypeName(row.type),
      ttl: Number.isFinite(ttl) ? ttl : 0,
      data: String(row.data ?? "").trim(),
    });
  }

  const statusRaw = obj.Status ?? obj.status;
  const rawQuestion = Array.isArray(obj.Question) ? obj.Question[0] : undefined;
  let question: string | undefined;
  if (rawQuestion !== null && typeof rawQuestion === "object") {
    const q = rawQuestion as Record<string, unknown>;
    const qName = String(q.name ?? "").replace(/\.$/, "");
    if (qName) question = `${qName} ${rrTypeName(q.type)}`;
  }

  return {
    status: describeStatus(statusRaw ?? 0),
    statusCode: statusCodeName(statusRaw ?? 0),
    question,
    answers,
  };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface DnsLookupOpts {
  type?: string;
  resolver?: string;
  [key: string]: unknown;
}

export type DnsLookupResult = Record<string, string>;

function runParsedJson(raw: string): DnsLookupResult {
  const parsed = parseDohResponse(raw);
  const out: DnsLookupResult = {};
  if (parsed.question) out["Query"] = parsed.question;
  out["Status"] = parsed.status;
  if (parsed.answers.length === 0) {
    out["Answers"] = `no records returned (${parsed.status})`;
    return out;
  }
  parsed.answers.forEach((a, i) => {
    out[`Answer ${i + 1} (${a.type})`] = `${a.name} -> ${a.data} (TTL ${a.ttl}s)`;
  });
  return out;
}

export function run(input: string, opts: DnsLookupOpts = {}): DnsLookupResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter a domain name or IP address to look up, or paste a DoH JSON response.",
      "Try example.com, 192.0.2.1, or 2001:db8::1.",
    );
  }

  if (raw.startsWith("{")) {
    return runParsedJson(raw);
  }

  const target = resolveResolver(opts.resolver ?? "cloudflare");
  let type = assertRecordType(opts.type);

  const normalized = normalizeInput(raw);
  const out: DnsLookupResult = {};
  let name: string;

  if (isIPv4(normalized) || isIPv6(normalized)) {
    name = toPtrName(normalized);
    if (type === "PTR") {
      out["Reverse lookup"] = `"${normalized}" is an IP address, so this queries PTR (reverse DNS) at ${name}.`;
    } else {
      out["Reverse lookup"] =
        `"${normalized}" is an IP address, so this queries PTR (reverse DNS) at ${name} instead of the ${type} record you selected.`;
      type = "PTR";
    }
  } else {
    if (normalized.length > 253 || !HOSTNAME_RE.test(normalized)) {
      throw new ToolError(
        "invalid-domain",
        `"${raw}" is not a valid domain name or IP address.`,
        "Use a hostname like example.com, or an IP address like 192.0.2.1 or 2001:db8::1.",
      );
    }
    name = normalized;
  }

  out["Query"] = `${name} ${type}`;
  out["Resolver"] = target.label;
  out["Request URL"] = buildQueryUrl(target, name, type);
  out["Note"] =
    `This is the request the page sends directly from your browser when you run the lookup. ${target.label} sees the ${name} query.`;
  return out;
}

export default { run } satisfies ToolLogic<string, DnsLookupResult, DnsLookupOpts>;
