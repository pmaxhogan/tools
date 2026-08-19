import { ToolError, type ToolLogic } from "../types";

/**
 * The shape the /api/echo Worker handler (and the page's own fetch of that
 * endpoint) must produce. Everything but the request line and the timestamp
 * is optional because it depends on what the runtime exposes: Cloudflare's
 * `request.cf` fields are absent locally and in any non-Cloudflare caller.
 */
export type EchoRequest = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  ip?: string;
  country?: string;
  city?: string;
  asn?: string | number;
  colo?: string;
  tlsVersion?: string;
  httpProtocol?: string;
  userAgent?: string;
  body?: string;
  bodyBytes?: number;
  timestamp: string;
};

export interface EchoOpts {
  /** 'json' (default), 'text', or 'table'. Synonyms accepted, see normalizeFormat. */
  format: string;
  [key: string]: unknown;
}

const USAGE_ENDPOINT = "https://tools.maxhogan.dev/api/echo";

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/** Header names that are always redacted verbatim, regardless of content. */
const REDACT_EXACT = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

/** Header names containing any of these substrings are redacted too. */
const REDACT_SUBSTRING = ["token", "secret", "key"];

function shouldRedact(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  if (REDACT_EXACT.has(lower)) return true;
  return REDACT_SUBSTRING.some((needle) => lower.includes(needle));
}

/**
 * Replaces sensitive header values with a length-only placeholder so the
 * response still shows that a header was sent (and roughly how big it was)
 * without ever echoing a credential back to the caller.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = shouldRedact(name) ? `<redacted, ${value.length} chars>` : value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * parseQuery
 * ------------------------------------------------------------------ */

/**
 * Parses the query string out of a URL (absolute or relative) into a record.
 * A key that appears once maps to its string value; a key that repeats maps
 * to an array of every value, in the order it appeared.
 */
export function parseQuery(url: string): Record<string, string | string[]> {
  let search: string;
  try {
    search = new URL(url, "http://echo.invalid").search;
  } catch {
    const q = url.indexOf("?");
    search = q >= 0 ? url.slice(q) : "";
  }

  const params = new URLSearchParams(search);
  const out: Record<string, string | string[]> = {};
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * describeIp
 * ------------------------------------------------------------------ */

const V4_PRIVATE_RANGES: [RegExp, string][] = [
  [/^127\./, "loopback, RFC 5735 127.0.0.0/8"],
  [/^10\./, "private, RFC 1918 10.0.0.0/8"],
  [/^172\.(1[6-9]|2\d|3[0-1])\./, "private, RFC 1918 172.16.0.0/12"],
  [/^192\.168\./, "private, RFC 1918 192.168.0.0/16"],
  [/^169\.254\./, "link local, RFC 3927 169.254.0.0/16"],
];

/** Describes an IP address: version, and whether it falls in a private or reserved range. */
export function describeIp(ip: string): string {
  const s = (ip ?? "").trim();
  if (!s) return "no IP address given";

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split(".").map(Number);
    if (octets.some((o) => o > 255)) return "not a valid IPv4 address";
    for (const [re, note] of V4_PRIVATE_RANGES) {
      if (re.test(s)) return `IPv4, ${note}`;
    }
    return "IPv4, public";
  }

  if (s.includes(":")) {
    const lower = s.toLowerCase();
    if (lower === "::1") return "IPv6, loopback, ::1";
    if (lower.startsWith("fe80:")) return "IPv6, link local, fe80::/10";
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return "IPv6, unique local, fc00::/7";
    if (lower.startsWith("::ffff:")) return "IPv6, IPv4 mapped";
    return "IPv6, public";
  }

  return "not a recognized IPv4 or IPv6 address";
}

/* ------------------------------------------------------------------ *
 * formatEcho
 * ------------------------------------------------------------------ */

function normalizeFormat(raw: string | undefined): "json" | "text" | "table" {
  const f = (raw ?? "json").trim().toLowerCase();
  if (["text", "plain", "plaintext", "txt"].includes(f)) return "text";
  if (["table", "record", "rows", "kv"].includes(f)) return "table";
  return "json";
}

function queryLines(query: Record<string, string | string[]>): string[] {
  return Object.entries(query ?? {}).map(([key, value]) =>
    Array.isArray(value) ? `${key} = ${value.join(", ")}` : `${key} = ${value}`,
  );
}

/**
 * Renders one EchoRequest in the requested format. Header redaction always
 * applies, in every format, so a curl of the raw JSON is exactly as safe as
 * the pretty table.
 */
export function formatEcho(req: EchoRequest, opts: { format: string }): string | Record<string, string> {
  const format = normalizeFormat(opts?.format);
  const headers = redactHeaders(req.headers ?? {});
  const query = req.query ?? {};

  if (format === "table") {
    const rows: Record<string, string> = {};
    rows["Method"] = req.method;
    rows["URL"] = req.url;
    rows["Path"] = req.path;
    const qLines = queryLines(query);
    if (qLines.length) rows["Query"] = qLines.join("\n");
    if (req.ip) rows["IP"] = `${req.ip} (${describeIp(req.ip)})`;
    if (req.country) rows["Country"] = req.country;
    if (req.city) rows["City"] = req.city;
    if (req.asn !== undefined) rows["ASN"] = String(req.asn);
    if (req.colo) rows["Cloudflare colo"] = req.colo;
    if (req.tlsVersion) rows["TLS version"] = req.tlsVersion;
    if (req.httpProtocol) rows["HTTP protocol"] = req.httpProtocol;
    if (req.userAgent) rows["User agent"] = req.userAgent;
    if (req.bodyBytes !== undefined) rows["Body bytes"] = String(req.bodyBytes);
    if (req.body) rows["Body"] = req.body;
    rows["Timestamp"] = req.timestamp;
    for (const [name, value] of Object.entries(headers)) rows[`Header: ${name}`] = value;
    return rows;
  }

  if (format === "text") {
    const lines: string[] = [`${req.method} ${req.path}`, `URL: ${req.url}`];

    if (req.ip) lines.push(`IP: ${req.ip} (${describeIp(req.ip)})`);
    const location = [req.city, req.country].filter(Boolean).join(", ");
    if (location) lines.push(`Location: ${location}`);
    if (req.asn !== undefined) lines.push(`ASN: ${req.asn}`);
    if (req.colo) lines.push(`Colo: ${req.colo}`);
    if (req.tlsVersion) lines.push(`TLS: ${req.tlsVersion}`);
    if (req.httpProtocol) lines.push(`Protocol: ${req.httpProtocol}`);
    if (req.userAgent) lines.push(`User-Agent: ${req.userAgent}`);
    lines.push(`Timestamp: ${req.timestamp}`);

    const qLines = queryLines(query);
    if (qLines.length) {
      lines.push("", "Query:");
      for (const l of qLines) lines.push(`  ${l}`);
    }

    const headerEntries = Object.entries(headers);
    if (headerEntries.length) {
      lines.push("", "Headers:");
      for (const [name, value] of headerEntries) lines.push(`  ${name}: ${value}`);
    }

    if (req.body) {
      lines.push("", `Body (${req.bodyBytes ?? req.body.length} bytes):`, req.body);
    }

    return lines.join("\n");
  }

  const out = {
    method: req.method,
    url: req.url,
    path: req.path,
    query,
    headers,
    ip: req.ip,
    country: req.country,
    city: req.city,
    asn: req.asn,
    colo: req.colo,
    tlsVersion: req.tlsVersion,
    httpProtocol: req.httpProtocol,
    userAgent: req.userAgent,
    body: req.body,
    bodyBytes: req.bodyBytes,
    timestamp: req.timestamp,
  };
  return JSON.stringify(out, null, 2);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

function usageRows(): Record<string, string> {
  return {
    Usage: [
      `curl ${USAGE_ENDPOINT}`,
      `curl -X POST -d '{"hello":"world"}' ${USAGE_ENDPOINT}`,
      `curl -H "X-Foo: bar" ${USAGE_ENDPOINT}`,
    ].join("\n"),
    Endpoint: USAGE_ENDPOINT,
  };
}

/** Builds a normalized EchoRequest out of parsed JSON, tolerating missing optional fields. */
function normalizeRequest(raw: Record<string, unknown>): EchoRequest {
  const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  return {
    method: String(raw.method),
    url: String(raw.url),
    path: asString(raw.path) ?? "",
    query: asRecord(raw.query) as Record<string, string | string[]>,
    headers: asRecord(raw.headers) as Record<string, string>,
    ip: asString(raw.ip),
    country: asString(raw.country),
    city: asString(raw.city),
    asn: typeof raw.asn === "string" || typeof raw.asn === "number" ? raw.asn : undefined,
    colo: asString(raw.colo),
    tlsVersion: asString(raw.tlsVersion),
    httpProtocol: asString(raw.httpProtocol),
    userAgent: asString(raw.userAgent),
    body: asString(raw.body),
    bodyBytes: typeof raw.bodyBytes === "number" ? raw.bodyBytes : undefined,
    timestamp: asString(raw.timestamp) ?? "",
  };
}

/**
 * `input` is the JSON text of an EchoRequest, produced either by the Worker's
 * /api/echo handler or by the page fetching that endpoint itself. Empty input
 * is a legitimate "show me how to use this" state, not an error, since there
 * is nothing to echo yet.
 */
export function run(input: string, opts: EchoOpts): string | Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) return usageRows();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "Input is not valid JSON.",
      `Call ${USAGE_ENDPOINT} yourself and paste the JSON object it returns, or POST a body to it and paste that response instead.`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).method !== "string" ||
    typeof (parsed as Record<string, unknown>).url !== "string"
  ) {
    throw new ToolError(
      "not-echo",
      "That JSON does not look like an echo response.",
      'Expected an object with at least "method" and "url" string fields, as returned by /api/echo.',
    );
  }

  const req = normalizeRequest(parsed as Record<string, unknown>);
  return formatEcho(req, { format: opts?.format ?? "json" });
}

export default { run } satisfies ToolLogic<string, string | Record<string, string>, EchoOpts>;
