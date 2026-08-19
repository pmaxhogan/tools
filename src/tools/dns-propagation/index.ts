import { ToolError, type ToolLogic } from "../types";

/**
 * DNS Propagation: compare the answers three public resolvers give for the same
 * record, so you can watch a change roll out.
 *
 * This layer is pure by contract (PROJECT.md rule 27): it never fetches. It
 * builds the DoH request URLs the panel should fetch, parses the JSON DoH
 * responses that come back, and compares them. The panel owns the network.
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

/** The three public resolvers compared side by side. All speak JSON DoH. */
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
  "CAA",
  "SRV",
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

/** Plain-language gloss for the statuses a user is likely to hit. */
const STATUS_NOTES: Record<string, string> = {
  NOERROR: "the query succeeded",
  FORMERR: "the resolver could not read the query",
  SERVFAIL: "the resolver failed, often a broken or unsigned DNSSEC chain",
  NXDOMAIN: "the domain does not exist",
  NOTIMP: "the resolver does not implement this query",
  REFUSED: "the resolver refused to answer",
  NOTAUTH: "the resolver is not authoritative for this zone",
};

/** Maps a numeric RR type to its mnemonic, or "TYPE123" for anything unknown. */
export function rrTypeName(type: unknown): string {
  if (typeof type === "string" && type.trim() !== "" && Number.isNaN(Number(type))) {
    return type.trim().toUpperCase();
  }
  const n = Number(type);
  if (!Number.isFinite(n) || n < 0) return "UNKNOWN";
  return RR_TYPE_NAMES[n] ?? `TYPE${n}`;
}

/** Maps a numeric RCODE to its label, with a short gloss where one helps. */
export function describeStatus(status: unknown): string {
  const n = Number(status);
  if (!Number.isFinite(n)) return "UNKNOWN";
  const name = STATUS_NAMES[n] ?? `RCODE${n}`;
  const note = STATUS_NOTES[name];
  return note ? `${name} (${note})` : name;
}

/** Just the mnemonic, no gloss. Used as the comparison key. */
export function statusCodeName(status: unknown): string {
  const n = Number(status);
  if (!Number.isFinite(n)) return "UNKNOWN";
  return STATUS_NAMES[n] ?? `RCODE${n}`;
}

/* ------------------------------------------------------------------ *
 * input validation
 * ------------------------------------------------------------------ */

const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * Accepts what people actually paste (a full URL, a trailing dot, mixed case)
 * and returns the bare lowercase hostname.
 */
export function normalizeDomain(raw: string): string {
  let name = (raw ?? "").trim();
  name = name.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  name = name.replace(/^[^/@]*@/, "");
  name = name.split(/[/?#]/)[0] ?? "";
  name = name.replace(/:\d+$/, "");
  name = name.replace(/\.$/, "");
  return name.toLowerCase();
}

/** Validates a hostname and returns the normalized form, or throws. */
export function assertDomain(raw: string): string {
  const name = normalizeDomain(raw);
  if (!name) {
    throw new ToolError("empty-input", "Enter a domain name to look up.", "Try example.com.");
  }
  if (name.length > 253 || !HOSTNAME_RE.test(name)) {
    throw new ToolError(
      "invalid-domain",
      `"${raw.trim()}" is not a valid domain name.`,
      "Use a hostname with at least one dot, like example.com or www.example.com. Leave off the protocol and any path.",
    );
  }
  return name;
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

/* ------------------------------------------------------------------ *
 * request building
 * ------------------------------------------------------------------ */

function resolveResolver(resolver: Resolver | string): Resolver {
  if (typeof resolver !== "string") return resolver;
  const found = RESOLVERS.find((r) => r.id === resolver.trim().toLowerCase());
  if (!found) {
    throw new ToolError(
      "unknown-resolver",
      `"${resolver}" is not one of the resolvers this tool queries.`,
      `Use one of ${RESOLVERS.map((r) => r.id).join(", ")}.`,
    );
  }
  return found;
}

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
  const domain = assertDomain(name);
  const recordType = assertRecordType(type);
  const params = [`name=${encodeURIComponent(domain)}`, `type=${encodeURIComponent(recordType)}`];
  if (target.needsContentTypeParam) {
    params.push(`ct=${encodeURIComponent("application/dns-json")}`);
  }
  return `${target.dohUrl}?${params.join("&")}`;
}

/** Every resolver's URL for one query, in RESOLVERS order. */
export function buildAllQueryUrls(
  name: string,
  type: string = "A",
): { id: string; label: string; url: string }[] {
  return RESOLVERS.map((r) => ({
    id: r.id,
    label: r.label,
    url: buildQueryUrl(r, name, type),
  }));
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
  answers: DohAnswer[];
}

const INVALID_DOH_FIX =
  'A DoH response is an object like {"Status":0,"Answer":[{"name":"example.com","type":1,"TTL":300,"data":"93.184.216.34"}]}.';

/**
 * Parses one JSON DoH response. Missing or empty `Answer` is normal (NXDOMAIN,
 * or a name with no record of that type), so it yields an empty answer list
 * rather than an error.
 */
export function parseDohResponse(json: unknown): ParsedDoh {
  let value: unknown = json;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ToolError(
        "invalid-doh",
        "The resolver response is not valid JSON.",
        INVALID_DOH_FIX,
      );
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError(
      "invalid-doh",
      "The resolver response is not a DoH JSON object.",
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
  return {
    status: describeStatus(statusRaw ?? 0),
    statusCode: statusCodeName(statusRaw ?? 0),
    answers,
  };
}

/* ------------------------------------------------------------------ *
 * comparison
 * ------------------------------------------------------------------ */

/**
 * Normalizes one answer's data for comparison: TXT strings arrive quoted, some
 * resolvers keep the trailing root dot on names, and case is not significant.
 */
export function normalizeAnswerData(data: string): string {
  return data
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** A stable signature of what a resolver returned: status plus the sorted data set. */
export function answerSignature(parsed: ParsedDoh): string {
  const data = parsed.answers.map((a) => `${a.type} ${normalizeAnswerData(a.data)}`).sort();
  return `${parsed.statusCode}|${data.join(",")}`;
}

export interface ResolverAnswers {
  id: string;
  parsed: ParsedDoh;
}

export interface PropagationSummary {
  /** The agreed answer set, or a per-resolver breakdown when they differ. */
  record: string;
  agree: boolean;
  note: string;
}

function labelFor(id: string): string {
  return RESOLVERS.find((r) => r.id === id)?.label ?? id;
}

function dataList(parsed: ParsedDoh): string {
  if (parsed.answers.length === 0) return `no records (${parsed.statusCode})`;
  return parsed.answers
    .map((a) => a.data)
    .sort()
    .join(", ");
}

/**
 * Compares what each resolver returned. TTLs deliberately do not count: they
 * tick down independently at every cache, so comparing them would report a
 * disagreement on every fully propagated record.
 */
export function compareAnswers(perResolver: ResolverAnswers[]): PropagationSummary {
  const list = perResolver ?? [];
  if (list.length === 0) {
    return { record: "", agree: false, note: "No resolver answers to compare yet." };
  }
  if (list.length === 1) {
    const only = list[0]!;
    return {
      record: dataList(only.parsed),
      agree: true,
      note: `Only ${labelFor(only.id)} answered, so there is nothing to compare against.`,
    };
  }

  const signatures = list.map((entry) => answerSignature(entry.parsed));
  const agree = signatures.every((sig) => sig === signatures[0]);

  if (agree) {
    const first = list[0]!.parsed;
    const empty = first.answers.length === 0;
    return {
      record: dataList(first),
      agree: true,
      note: empty
        ? `All ${list.length} resolvers returned no ${first.statusCode === "NXDOMAIN" ? "domain" : "record"} for this query, so they agree.`
        : `All ${list.length} resolvers returned the same answers, so the record has propagated.`,
    };
  }

  const breakdown = list
    .map((entry) => `${labelFor(entry.id)}: ${dataList(entry.parsed)}`)
    .join(" | ");
  return {
    record: breakdown,
    agree: false,
    note: "The resolvers disagree. The change is still propagating, or a cache is holding the old value until its TTL expires.",
  };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface DnsPropagationOpts {
  type?: string;
  [key: string]: unknown;
}

export type DnsPropagationResult = Record<string, string>;

function formatAnswers(parsed: ParsedDoh): string {
  if (parsed.answers.length === 0) return `no records returned (${parsed.status})`;
  const rows = parsed.answers.map((a) => `${a.data} (${a.type}, TTL ${a.ttl}s)`).sort();
  return rows.join("; ");
}

function isDohResponseShape(obj: Record<string, unknown>): boolean {
  return "Status" in obj || "Answer" in obj || "status" in obj || "answer" in obj;
}

function runBundle(
  bundle: Record<string, unknown>,
  out: DnsPropagationResult,
): DnsPropagationResult {
  const entries: ResolverAnswers[] = [];

  if (isDohResponseShape(bundle)) {
    entries.push({ id: "pasted", parsed: parseDohResponse(bundle) });
    out["Pasted response"] = formatAnswers(entries[0]!.parsed);
  } else {
    const seen = new Set<string>();
    for (const resolver of RESOLVERS) {
      const key = Object.keys(bundle).find((k) => k.trim().toLowerCase() === resolver.id);
      if (key === undefined) continue;
      seen.add(key);
      const parsed = parseDohResponse(bundle[key]);
      entries.push({ id: resolver.id, parsed });
      out[resolver.label] = formatAnswers(parsed);
    }
    for (const key of Object.keys(bundle)) {
      if (seen.has(key)) continue;
      const parsed = parseDohResponse(bundle[key]);
      entries.push({ id: key, parsed });
      out[key] = formatAnswers(parsed);
    }
  }

  if (entries.length === 0) {
    throw new ToolError(
      "empty-bundle",
      "That JSON has no resolver responses in it.",
      'Use an object keyed by resolver, like {"cloudflare": {...}, "google": {...}, "dnssb": {...}}, or just type a domain name.',
    );
  }

  const summary = compareAnswers(entries);
  out["Propagation"] = summary.agree ? "all resolvers agree" : "answers differ (still propagating)";
  out["Summary"] = summary.note;
  return out;
}

export function run(input: string, opts: DnsPropagationOpts = {}): DnsPropagationResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new ToolError("empty-input", "Enter a domain name to look up.", "Try example.com.");
  }

  // The input is either a domain name or a pasted bundle of DoH responses.
  // A domain name is never valid JSON, so JSON.parse is the discriminator.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    parsedJson = undefined;
  }

  const out: DnsPropagationResult = {};

  if (parsedJson !== null && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    return runBundle(parsedJson as Record<string, unknown>, out);
  }

  const name = assertDomain(raw);
  const type = assertRecordType(opts.type);
  out["Query"] = `${name} ${type}`;
  for (const entry of buildAllQueryUrls(name, type)) {
    out[entry.label] = entry.url;
  }
  out["Note"] =
    `These are the requests this page makes from your browser. ${RESOLVERS.map((r) => r.label).join(", ")} each see ${name}.`;
  return out;
}

export default { run } satisfies ToolLogic<string, DnsPropagationResult, DnsPropagationOpts>;
