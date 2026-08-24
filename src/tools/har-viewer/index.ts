import { ToolError, type ToolLogic } from "../types";

/**
 * HAR (HTTP Archive) viewer.
 *
 * A .har file is a full recording of a browser session: every URL, every
 * header, every cookie, and often the response bodies too. That makes it the
 * single most sensitive file a developer routinely emails around, so this
 * module ships a sanitizer alongside the reader and reports exactly what the
 * sanitizer would remove.
 *
 * The logic layer stays pure text in, text out. The panel reuses the same
 * exports for its table, its warning card, and its sanitized download.
 */

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text?: string;
  params: HarNameValue[];
}

export interface HarRequest {
  method: string;
  url: string;
  headers: HarNameValue[];
  cookies: HarNameValue[];
  queryString: HarNameValue[];
  postData?: HarPostData;
}

export interface HarContent {
  size: number;
  mimeType: string;
  /** Present only when the capture was saved with response bodies. */
  hasText: boolean;
  textBytes: number;
}

export interface HarResponse {
  status: number;
  statusText: string;
  headers: HarNameValue[];
  cookies: HarNameValue[];
  content: HarContent;
  bodySize: number;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  startedDateTime: string;
  /** Milliseconds from the start of the capture. Derived, not from the file. */
  startMs: number;
  /** Total round trip in milliseconds, as recorded. */
  time: number;
  /** Host of the request URL, or an empty string when the URL is unparseable. */
  host: string;
  /** Bytes counted toward the transfer total. */
  bytes: number;
  request: HarRequest;
  response: HarResponse;
  timings: HarTimings;
}

export interface HarPage {
  id: string;
  title: string;
  startedDateTime: string;
}

export interface HarModel {
  version: string;
  creator: string;
  pages: HarPage[];
  entries: HarEntry[];
  /**
   * The untouched parsed JSON. The sanitizer works on a copy of this rather
   * than of the trimmed model, so a sanitized download keeps cache blocks,
   * page timings and vendor `_` extensions instead of silently dropping them.
   */
  raw: unknown;
}

export interface HarSummary {
  requests: number;
  /** Sum of the per-entry transfer sizes described by `entryBytes`. */
  transferred: number;
  /** Sum of uncompressed response body sizes. */
  contentBytes: number;
  startedDateTime: string;
  /** Wall clock length of the capture in milliseconds. */
  spanMs: number;
  /** Sum of every entry's round trip, which overlaps and so exceeds the span. */
  totalTimeMs: number;
  byStatus: { key: string; count: number }[];
  byMime: { key: string; count: number }[];
  slowest: HarEntry[];
  largest: HarEntry[];
  domains: { host: string; count: number; bytes: number }[];
  /** Host of the first request, treated as the page under test. */
  primaryHost: string;
  thirdPartyRequests: number;
  /** Third party requests as a fraction of all requests, 0 to 1. */
  thirdPartyShare: number;
}

export interface SensitiveReport {
  /** Cookie objects in request.cookies and response.cookies. */
  cookies: number;
  /** Cookie and Set-Cookie headers. */
  cookieHeaders: number;
  /** Authorization and Proxy-Authorization headers. */
  authHeaders: number;
  /** Entries carrying a request body (postData text or params). */
  requestBodies: number;
  /** Query string parameters whose name looks like a credential. */
  queryParams: number;
  /** Entries with a captured response body. */
  responseBodies: number;
  /** Total size of the captured response bodies, in characters. */
  responseBodyChars: number;
  /** Entries touched by at least one of the categories above. */
  entries: number;
  /** Everything above except the byte and entry counters. */
  total: number;
}

export interface HarOpts {
  /** summary | waterfall | slowest | largest | domains */
  view: string;
  /** Case insensitive substring match on the request URL. */
  filter: string;
  /** all | 2xx | 3xx | 4xx | 5xx */
  status: string;
  /** Hide anything faster than this many milliseconds. */
  minMs: number;
  [key: string]: unknown;
}

export interface WaterfallOpts {
  /** Total character width of a row, including the bar. */
  width?: number;
  filter?: string;
  status?: string;
  /** Case insensitive substring match on the response MIME type. */
  mime?: string;
  minMs?: number;
  /** Rows to print before the truncation note. */
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* sensitive field vocabulary                                          */
/* ------------------------------------------------------------------ */

/** Header names whose value is a credential. Compared case insensitively. */
export const SENSITIVE_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
] as const;

const COOKIE_HEADERS = new Set(["cookie", "set-cookie"]);

/** Query parameter name fragments that usually carry a secret. */
export const SECRET_PARAM_WORDS = [
  "token",
  "key",
  "auth",
  "session",
  "password",
  "code",
  "signature",
] as const;

export const REDACTED = "[redacted]";

/** True when a header name is one this tool redacts. */
export function isSensitiveHeader(name: string): boolean {
  return (SENSITIVE_HEADERS as readonly string[]).includes(String(name ?? "").toLowerCase());
}

/** True when a query parameter name looks like it carries a credential. */
export function isSecretParam(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return SECRET_PARAM_WORDS.some((word) => lower.includes(word));
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** HAR writes -1 for "not applicable", which must never reach arithmetic. */
function nonNegative(value: unknown): number {
  const n = asNumber(value, 0);
  return n > 0 ? n : 0;
}

function nameValues(value: unknown): HarNameValue[] {
  return asArray(value)
    .filter(isRecord)
    .map((item) => ({ name: asString(item.name), value: asString(item.value) }));
}

export function humanBytes(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function humanMs(ms: number): string {
  const n = Math.max(0, ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)} s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = (n % 60_000) / 1000;
  return `${minutes} min ${seconds.toFixed(1)} s`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Transfer size for one entry. HAR writes -1 when the browser could not tell,
 * in which case the uncompressed body size is the closest honest stand in.
 */
function entryBytes(bodySize: number, contentSize: number): number {
  if (bodySize > 0) return bodySize;
  return contentSize > 0 ? contentSize : 0;
}

export function statusClass(status: number): string {
  if (status >= 100 && status < 600) return `${Math.floor(status / 100)}xx`;
  return "other";
}

/** Strips parameters and normalizes a MIME type down to its bucket name. */
export function mimeBucket(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return "unknown";
  return base;
}

/* ------------------------------------------------------------------ */
/* parse                                                               */
/* ------------------------------------------------------------------ */

const HAR_FIX =
  'Export the capture from the browser network panel with "Save all as HAR", then drop the whole .har file in without editing it.';

/**
 * Reads a HAR file into a validated model. Missing optional fields are filled
 * with neutral defaults so a capture from any tool renders, but a file without
 * `log.entries` is not a HAR and is rejected outright.
 */
export function parseHar(text: string): HarModel {
  const source = typeof text === "string" ? text : "";
  if (source.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to read yet.",
      "Drop a .har file here, or paste the contents of one.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ToolError("invalid-har", `This file is not valid JSON: ${detail}.`, HAR_FIX);
  }

  const log = isRecord(parsed) && isRecord(parsed.log) ? parsed.log : null;
  if (!log || !Array.isArray(log.entries)) {
    throw new ToolError(
      "invalid-har",
      "This JSON has no log.entries array, so it is not a HAR capture.",
      HAR_FIX,
    );
  }

  const creator = isRecord(log.creator)
    ? [asString(log.creator.name), asString(log.creator.version)].filter(Boolean).join(" ")
    : "";

  const pages: HarPage[] = asArray(log.pages)
    .filter(isRecord)
    .map((page) => ({
      id: asString(page.id),
      title: asString(page.title),
      startedDateTime: asString(page.startedDateTime),
    }));

  const rawEntries = log.entries.filter(isRecord);
  const parsedEntries = rawEntries.map((entry) => {
    const request = isRecord(entry.request) ? entry.request : {};
    const response = isRecord(entry.response) ? entry.response : {};
    const content = isRecord(response.content) ? response.content : {};
    const timings = isRecord(entry.timings) ? entry.timings : {};
    const postDataRaw = isRecord(request.postData) ? request.postData : null;

    const url = asString(request.url);
    const contentText = asString(content.text);
    const bodySize = asNumber(response.bodySize, -1);
    const contentSize = asNumber(content.size, -1);

    const postData: HarPostData | undefined = postDataRaw
      ? {
          mimeType: asString(postDataRaw.mimeType),
          ...(typeof postDataRaw.text === "string" ? { text: postDataRaw.text } : {}),
          params: nameValues(postDataRaw.params),
        }
      : undefined;

    return {
      startedDateTime: asString(entry.startedDateTime),
      startMs: 0,
      time: nonNegative(entry.time),
      host: hostOf(url),
      bytes: entryBytes(bodySize, contentSize),
      request: {
        method: asString(request.method, "GET").toUpperCase(),
        url,
        headers: nameValues(request.headers),
        cookies: nameValues(request.cookies),
        queryString: nameValues(request.queryString),
        ...(postData ? { postData } : {}),
      },
      response: {
        status: asNumber(response.status, 0),
        statusText: asString(response.statusText),
        headers: nameValues(response.headers),
        cookies: nameValues(response.cookies),
        content: {
          size: contentSize,
          mimeType: asString(content.mimeType),
          hasText: contentText.length > 0,
          textBytes: contentText.length,
        },
        bodySize,
      },
      timings: {
        blocked: nonNegative(timings.blocked),
        dns: nonNegative(timings.dns),
        connect: nonNegative(timings.connect),
        ssl: nonNegative(timings.ssl),
        send: nonNegative(timings.send),
        wait: nonNegative(timings.wait),
        receive: nonNegative(timings.receive),
      },
    } satisfies HarEntry;
  });

  // Timestamps are absolute in the file. Everything downstream wants an offset
  // from the first request, so resolve that once here.
  const stamps = parsedEntries
    .map((entry) => Date.parse(entry.startedDateTime))
    .filter((n) => Number.isFinite(n));
  const origin = stamps.length > 0 ? Math.min(...stamps) : 0;
  for (const entry of parsedEntries) {
    const at = Date.parse(entry.startedDateTime);
    entry.startMs = Number.isFinite(at) ? at - origin : 0;
  }

  return {
    version: asString(log.version, "1.2"),
    creator,
    pages,
    entries: parsedEntries,
    raw: parsed,
  };
}

/* ------------------------------------------------------------------ */
/* summarize                                                           */
/* ------------------------------------------------------------------ */

function countBy<T>(items: T[], key: (item: T) => string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Totals, buckets and leaderboards for a set of entries. */
export function summarize(entries: HarEntry[]): HarSummary {
  const list = entries ?? [];
  const requests = list.length;

  let transferred = 0;
  let contentBytes = 0;
  let totalTimeMs = 0;
  let spanMs = 0;
  for (const entry of list) {
    transferred += entry.bytes;
    if (entry.response.content.size > 0) contentBytes += entry.response.content.size;
    totalTimeMs += entry.time;
    spanMs = Math.max(spanMs, entry.startMs + entry.time);
  }

  const domainCounts = new Map<string, { count: number; bytes: number }>();
  for (const entry of list) {
    const host = entry.host || "unknown";
    const row = domainCounts.get(host) ?? { count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += entry.bytes;
    domainCounts.set(host, row);
  }
  const domains = [...domainCounts.entries()]
    .map(([host, row]) => ({ host, ...row }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes || a.host.localeCompare(b.host));

  const primaryHost = list[0]?.host ?? "";
  const thirdPartyRequests = primaryHost
    ? list.filter((entry) => entry.host !== primaryHost).length
    : 0;

  return {
    requests,
    transferred,
    contentBytes,
    startedDateTime: list[0]?.startedDateTime ?? "",
    spanMs,
    totalTimeMs,
    byStatus: countBy(list, (entry) => statusClass(entry.response.status)),
    byMime: countBy(list, (entry) => mimeBucket(entry.response.content.mimeType)),
    slowest: [...list].sort((a, b) => b.time - a.time).slice(0, 10),
    largest: [...list].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    domains,
    primaryHost,
    thirdPartyRequests,
    thirdPartyShare: requests > 0 ? thirdPartyRequests / requests : 0,
  };
}

/* ------------------------------------------------------------------ */
/* filtering                                                           */
/* ------------------------------------------------------------------ */

/** Applies the URL, status class, MIME and duration filters in one pass. */
export function filterEntries(entries: HarEntry[], o: WaterfallOpts = {}): HarEntry[] {
  const needle = (o.filter ?? "").trim().toLowerCase();
  const status = (o.status ?? "all").trim().toLowerCase();
  const mime = (o.mime ?? "").trim().toLowerCase();
  const minMs = Math.max(0, asNumber(o.minMs, 0));

  return (entries ?? []).filter((entry) => {
    if (needle && !entry.request.url.toLowerCase().includes(needle)) return false;
    if (status && status !== "all" && statusClass(entry.response.status) !== status) return false;
    if (mime && !entry.response.content.mimeType.toLowerCase().includes(mime)) return false;
    if (minMs > 0 && entry.time < minMs) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* waterfall                                                           */
/* ------------------------------------------------------------------ */

const PHASE_CHARS = { dns: "░", connect: "▒", wait: "▓", receive: "█" } as const;
const BAR_CHAR = "█";
const DEFAULT_WIDTH = 100;
const DEFAULT_LIMIT = 200;

/**
 * Splits `total` characters across weighted phases without losing or inventing
 * a character, using largest remainder so a short phase still shows up.
 */
function distribute(weights: number[], total: number): number[] {
  const out = weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return out;

  const exact = weights.map((w) => (w / sum) * total);
  let used = 0;
  for (let i = 0; i < exact.length; i++) {
    out[i] = Math.floor(exact[i] ?? 0);
    used += out[i] ?? 0;
  }
  const order = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < total && k < order.length; k++) {
    const idx = order[k]?.i ?? 0;
    out[idx] = (out[idx] ?? 0) + 1;
    used += 1;
  }
  return out;
}

/**
 * The four phase segments of one bar, in order. `ssl` is part of `connect` in
 * the HAR spec, so it is never added on top of it, and `blocked` folds into the
 * lookup segment because both are stalls before any bytes move.
 */
export function phaseWeights(timings: HarTimings): number[] {
  return [
    timings.blocked + timings.dns,
    timings.connect,
    timings.send + timings.wait,
    timings.receive,
  ];
}

function barFor(entry: HarEntry, span: number, barWidth: number): string {
  const scale = barWidth / span;
  const offset = Math.min(barWidth - 1, Math.max(0, Math.floor(entry.startMs * scale)));
  const length = Math.min(barWidth - offset, Math.max(1, Math.round(entry.time * scale)));

  let body = "";
  const weights = phaseWeights(entry.timings);
  if (length >= 4 && weights.some((w) => w > 0)) {
    const parts = distribute(weights, length);
    const chars = [PHASE_CHARS.dns, PHASE_CHARS.connect, PHASE_CHARS.wait, PHASE_CHARS.receive];
    for (let i = 0; i < parts.length; i++) body += chars[i]?.repeat(parts[i] ?? 0) ?? "";
  } else {
    body = BAR_CHAR.repeat(length);
  }

  return `${" ".repeat(offset)}${body}`.padEnd(barWidth);
}

/** Shortens a URL to `host/tail` so the interesting end stays visible. */
export function shortUrl(url: string, max: number): string {
  if (max <= 1) return "";
  let text: string;
  try {
    const parsed = new URL(url);
    text = `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    text = url;
  }
  if (text.length <= max) return text;
  const head = Math.max(1, Math.ceil((max - 1) * 0.45));
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * ASCII waterfall sorted by start time. Bars sit on the timeline of the whole
 * capture, so filtering the rows never moves the remaining bars.
 */
export function renderWaterfall(entries: HarEntry[], o: WaterfallOpts = {}): string {
  const all = entries ?? [];
  const width = Math.min(400, Math.max(48, Math.round(asNumber(o.width, DEFAULT_WIDTH))));
  const limit = Math.max(1, Math.round(asNumber(o.limit, DEFAULT_LIMIT)));

  const span = Math.max(1, ...all.map((entry) => entry.startMs + entry.time));
  const rows = filterEntries(all, o).sort(
    (a, b) => a.startMs - b.startMs || a.request.url.localeCompare(b.request.url),
  );

  if (rows.length === 0) {
    return "No requests match these filters.";
  }

  const barWidth = Math.max(12, Math.floor(width * 0.4));
  const fixed = 6 + 1 + 3 + 1 + 9 + 1 + 8 + 1 + barWidth;
  const urlWidth = Math.max(16, width - fixed);

  const out: string[] = [
    `Timeline 0 to ${humanMs(span)} across ${barWidth} columns.`,
    `Phases: ${PHASE_CHARS.dns} dns  ${PHASE_CHARS.connect} connect  ${PHASE_CHARS.wait} wait  ${PHASE_CHARS.receive} receive`,
    "",
  ];

  const shown = rows.slice(0, limit);
  for (const entry of shown) {
    const method = entry.request.method.slice(0, 6).padEnd(6);
    const status = String(entry.response.status || "-").padStart(3);
    const url = shortUrl(entry.request.url, urlWidth).padEnd(urlWidth);
    const size = humanBytes(entry.bytes).padStart(9);
    const time = `${Math.round(entry.time)} ms`.padStart(8);
    out.push(
      `${method} ${status} ${url} ${size} ${time} ${barFor(entry, span, barWidth)}`.trimEnd(),
    );
  }

  if (shown.length < rows.length) {
    const rest = rows.length - shown.length;
    out.push(
      `... ${rest} more ${rest === 1 ? "request" : "requests"} (${rows.length} shown by the filters)`,
    );
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* sanitize                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rewrites a URL's query string so credential shaped parameters lose their
 * values. The URL carries the same secrets as `request.queryString`, so
 * redacting only the parsed list would leave them in plain sight.
 */
function redactUrl(url: string): { url: string; redacted: number } {
  try {
    const parsed = new URL(url);
    let redacted = 0;
    const names = [...new Set([...parsed.searchParams.keys()])];
    for (const name of names) {
      if (!isSecretParam(name)) continue;
      redacted += parsed.searchParams.getAll(name).length;
      parsed.searchParams.set(name, REDACTED);
    }
    if (redacted === 0) return { url, redacted };
    // URLSearchParams percent encodes the brackets, which reads like noise in
    // a bug report, so put the plain marker back.
    const rebuilt = parsed.toString().split(encodeURIComponent(REDACTED)).join(REDACTED);
    return { url: rebuilt, redacted };
  } catch {
    return { url, redacted: 0 };
  }
}

function emptyReport(): SensitiveReport {
  return {
    cookies: 0,
    cookieHeaders: 0,
    authHeaders: 0,
    requestBodies: 0,
    queryParams: 0,
    responseBodies: 0,
    responseBodyChars: 0,
    entries: 0,
    total: 0,
  };
}

/**
 * The single walker behind both `listSensitive` and `sanitizeHar`. Counting and
 * redacting share one pass so the warning card can never promise a redaction
 * the download does not perform.
 */
function scan(root: unknown, mutate: boolean): SensitiveReport {
  const report = emptyReport();
  const log = isRecord(root) && isRecord(root.log) ? root.log : null;
  if (!log) return report;

  for (const entry of asArray(log.entries)) {
    if (!isRecord(entry)) continue;
    const before = { ...report };

    const request = isRecord(entry.request) ? entry.request : null;
    const response = isRecord(entry.response) ? entry.response : null;

    // Cookie arrays on both sides.
    for (const holder of [request, response]) {
      if (!holder) continue;
      const cookies = asArray(holder.cookies);
      report.cookies += cookies.length;
      if (mutate && cookies.length > 0) holder.cookies = [];
    }

    // Headers on both sides, matched case insensitively.
    for (const holder of [request, response]) {
      if (!holder) continue;
      for (const header of asArray(holder.headers)) {
        if (!isRecord(header)) continue;
        const name = asString(header.name).toLowerCase();
        if (!isSensitiveHeader(name)) continue;
        if (COOKIE_HEADERS.has(name)) report.cookieHeaders += 1;
        else report.authHeaders += 1;
        if (mutate) header.value = REDACTED;
      }
    }

    if (request) {
      // Query parameters, in the parsed list and in the URL itself.
      for (const param of asArray(request.queryString)) {
        if (!isRecord(param)) continue;
        if (!isSecretParam(asString(param.name))) continue;
        report.queryParams += 1;
        if (mutate) param.value = REDACTED;
      }
      const url = asString(request.url);
      const rewritten = redactUrl(url);
      // Only count URL parameters the parsed list did not already cover.
      if (asArray(request.queryString).length === 0) report.queryParams += rewritten.redacted;
      if (mutate && rewritten.redacted > 0) request.url = rewritten.url;

      // Request bodies: form posts and JSON payloads both carry credentials.
      const postData = isRecord(request.postData) ? request.postData : null;
      if (postData) {
        const text = asString(postData.text);
        const params = asArray(postData.params);
        if (text.length > 0 || params.length > 0) {
          report.requestBodies += 1;
          if (mutate) {
            if (text.length > 0) postData.text = `[redacted ${byteLength(text)} bytes]`;
            for (const param of params) {
              if (isRecord(param)) param.value = REDACTED;
            }
          }
        }
      }
    }

    if (response) {
      const content = isRecord(response.content) ? response.content : null;
      const text = content ? asString(content.text) : "";
      if (content && text.length > 0) {
        report.responseBodies += 1;
        report.responseBodyChars += text.length;
        if (mutate) delete content.text;
      }
    }

    const changed =
      report.cookies !== before.cookies ||
      report.cookieHeaders !== before.cookieHeaders ||
      report.authHeaders !== before.authHeaders ||
      report.requestBodies !== before.requestBodies ||
      report.queryParams !== before.queryParams ||
      report.responseBodies !== before.responseBodies;
    if (changed) report.entries += 1;
  }

  report.total =
    report.cookies +
    report.cookieHeaders +
    report.authHeaders +
    report.requestBodies +
    report.queryParams +
    report.responseBodies;
  return report;
}

/** Counts what `sanitizeHar` would remove, without changing anything. */
export function listSensitive(model: HarModel): SensitiveReport {
  return scan(model?.raw, false);
}

/**
 * Returns a deep copy of the original HAR with every credential removed:
 * cookie arrays emptied, Cookie, Set-Cookie, Authorization and
 * Proxy-Authorization headers redacted, request bodies replaced by their size,
 * credential shaped query parameters redacted in both the parsed list and the
 * URL, and captured response bodies dropped. The input model is never touched.
 */
export function sanitizeHar(model: HarModel): unknown {
  const source = model?.raw;
  if (source === undefined) {
    throw new ToolError(
      "invalid-har",
      "There is no parsed capture to sanitize.",
      "Load a .har file first, then export the sanitized copy.",
    );
  }
  const copy: unknown = JSON.parse(JSON.stringify(source));
  scan(copy, true);
  return copy;
}

/* ------------------------------------------------------------------ */
/* text report                                                         */
/* ------------------------------------------------------------------ */

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function bucketLine(buckets: { key: string; count: number }[]): string {
  if (buckets.length === 0) return "none";
  return buckets.map((b) => `${b.key} ${b.count}`).join(", ");
}

function summaryBlock(model: HarModel, s: HarSummary): string {
  const out = [
    "Capture summary",
    `  Requests: ${s.requests}`,
    `  Transferred: ${humanBytes(s.transferred)} (${humanBytes(s.contentBytes)} uncompressed)`,
    `  Time span: ${humanMs(s.spanMs)}`,
    `  Domains: ${s.domains.length}`,
  ];
  if (s.primaryHost) {
    out.push(
      `  Third party: ${s.thirdPartyRequests} of ${s.requests} requests (${percent(s.thirdPartyShare)}) went somewhere other than ${s.primaryHost}`,
    );
  }
  out.push(`  Status: ${bucketLine(s.byStatus)}`);
  out.push(`  Types: ${bucketLine(s.byMime.slice(0, 8))}`);
  if (s.startedDateTime) out.push(`  Started: ${s.startedDateTime}`);
  if (model.creator) out.push(`  Recorded by: ${model.creator}`);
  if (model.pages.length > 0) {
    out.push(`  Pages: ${model.pages.map((p) => p.title || p.id).join(", ")}`);
  }
  return out.join("\n");
}

function entryList(title: string, entries: HarEntry[], metric: (e: HarEntry) => string): string {
  if (entries.length === 0) return `${title}\n  none`;
  const out = [title];
  entries.forEach((entry, i) => {
    out.push(
      `  ${String(i + 1).padStart(2)}. ${metric(entry).padStart(9)}  ${entry.response.status || "-"} ${shortUrl(entry.request.url, 70)}`,
    );
  });
  return out.join("\n");
}

function domainBlock(s: HarSummary): string {
  if (s.domains.length === 0) return "Domains\n  none";
  const out = ["Domains"];
  const nameWidth = Math.min(40, Math.max(6, ...s.domains.map((d) => d.host.length)));
  for (const domain of s.domains) {
    const flag = s.primaryHost && domain.host !== s.primaryHost ? " third party" : "";
    out.push(
      `  ${shortUrl(domain.host, nameWidth).padEnd(nameWidth)}  ${String(domain.count).padStart(4)} req  ${humanBytes(domain.bytes).padStart(9)}${flag}`,
    );
  }
  return out.join("\n");
}

function sensitiveBlock(report: SensitiveReport): string {
  const out = ["Sensitive content"];
  if (report.total === 0) {
    out.push("  Nothing that looks like a credential was found in this capture.");
    out.push("  Check it yourself before sharing it anyway: a session id can hide in any field.");
    return out.join("\n");
  }
  out.push(`  Cookies: ${report.cookies}`);
  out.push(`  Cookie headers: ${report.cookieHeaders}`);
  out.push(`  Authorization headers: ${report.authHeaders}`);
  out.push(`  Request bodies: ${report.requestBodies}`);
  out.push(`  Credential shaped query parameters: ${report.queryParams}`);
  out.push(`  Captured response bodies: ${report.responseBodies}`);
  out.push(
    `  ${report.entries} of the requests carry at least one of these. Treat this file like a password.`,
  );
  out.push(
    '  Use "Download sanitized copy" on the tool page to get a version with all of the above redacted.',
  );
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export function run(input: string, opts: HarOpts): string {
  const model = parseHar(input);
  const view = (opts?.view || "summary").toLowerCase();
  const waterfallOpts: WaterfallOpts = {
    filter: opts?.filter ?? "",
    status: opts?.status ?? "all",
    minMs: asNumber(opts?.minMs, 0),
  };

  const filtered = filterEntries(model.entries, waterfallOpts);
  const summary = summarize(filtered);
  const sections = [summaryBlock(model, summary)];

  switch (view) {
    case "waterfall":
      sections.push(renderWaterfall(model.entries, { ...waterfallOpts, limit: 200 }));
      break;
    case "slowest":
      sections.push(
        entryList("Slowest requests", summary.slowest, (e) => `${Math.round(e.time)} ms`),
      );
      break;
    case "largest":
      sections.push(entryList("Largest responses", summary.largest, (e) => humanBytes(e.bytes)));
      break;
    case "domains":
      sections.push(domainBlock(summary));
      break;
    default:
      sections.push(renderWaterfall(model.entries, { ...waterfallOpts, limit: 40 }));
      break;
  }

  sections.push(sensitiveBlock(listSensitive(model)));
  return sections.join("\n\n");
}

export default { run } satisfies ToolLogic<string, string, HarOpts>;
