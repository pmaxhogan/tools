import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Log file analyzer.
 *
 * Reads a whole log in one pass and reports counters rather than rows. That
 * shape is the point: a 50 MB access log holds a few hundred thousand lines,
 * and building an array of parsed objects for all of them costs more memory
 * than the text itself. Everything below accumulates into fixed maps and a
 * bounded "slowest" list, so peak memory is the input string plus the distinct
 * paths, addresses and agents the log happens to contain.
 *
 * Four formats are recognized: the Apache/nginx combined and common access log
 * formats, JSON lines (one object per line, fields found by name), and generic
 * lines that merely start with a timestamp. The format is chosen by scoring a
 * sample of the first lines, then the whole file is parsed with the winner;
 * lines the winner cannot read are counted as skipped and still scanned for
 * error keywords, because a stack trace interleaved in an access log is
 * exactly the thing worth surfacing.
 *
 * Every timestamp is normalized to UTC and rendered as ISO 8601. Nothing here
 * calls toLocaleString: the same log must produce the same report on every
 * machine, and a shared result should not shift by the reader's time zone.
 */

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/** Refuse text past this. The whole log is held in memory while it is read. */
const MAX_CHARS = 50 * 1024 * 1024;

/** Lines sampled to pick a parser before the full pass. */
const DETECT_SAMPLE = 200;

/**
 * Distinct keys kept per counter. A log with a unique path per request (a
 * cache buster, a session id in the URL) would otherwise grow one map entry
 * per line; past the cap the counts still accrue but new keys are not named.
 */
const MAX_DISTINCT = 200_000;

/** Characters kept from a sampled error line. */
const LINE_CAP = 300;

/** Error lines quoted in the report. */
const DEFAULT_ERROR_SAMPLES = 8;

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

export interface LogAnalyzerOpts {
  /** all | traffic | errors | timing */
  view: string;
  /** Entries listed in each top list. */
  top: number;
  /** Replace the last octet of every IPv4 address (last group of an IPv6). */
  maskIps: boolean;
  /** Count /search?q=a and /search?q=b as one path. */
  stripQuery: boolean;
  [key: string]: unknown;
}

interface Settings {
  view: string;
  top: number;
  maskIps: boolean;
  stripQuery: boolean;
}

function resolve(opts: Partial<LogAnalyzerOpts> | undefined): Settings {
  const top = Number(opts?.top ?? 10);
  return {
    view: typeof opts?.view === "string" && opts.view ? opts.view : "all",
    top: Number.isFinite(top) ? Math.min(50, Math.max(1, Math.round(top))) : 10,
    maskIps: opts?.maskIps === undefined ? true : Boolean(opts.maskIps),
    stripQuery: opts?.stripQuery === undefined ? true : Boolean(opts.stripQuery),
  };
}

/* ------------------------------------------------------------------ */
/* parsed shapes                                                       */
/* ------------------------------------------------------------------ */

export type LogFormat = "combined" | "common" | "json" | "timestamped";

/** One line, as far as the chosen parser could read it. */
export interface ParsedLine {
  ip?: string;
  /** Epoch milliseconds, when the timestamp carried enough to place it. */
  timeMs?: number;
  /** The timestamp exactly as written, kept for formats with no year. */
  timeRaw?: string;
  method?: string;
  path?: string;
  status?: number;
  bytes?: number;
  agent?: string;
  /** Request duration in milliseconds. */
  durationMs?: number;
  /** Uppercased severity, when the line names one. */
  level?: string;
}

const FORMAT_LABELS: Record<LogFormat, string> = {
  combined: "Apache/nginx combined access log",
  common: "Apache/nginx common access log",
  json: "JSON lines",
  timestamped: "generic timestamped lines",
};

/* ------------------------------------------------------------------ */
/* timestamps                                                          */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** 10/Oct/2000:13:55:36 -0700, the timestamp inside a CLF bracket. */
const CLF_TIME_RE =
  /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/;

/** 2026-08-30T12:00:00.123Z, 2026-08-30 12:00:00,123 and the forms between. */
const ISO_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|z|[+-]\d{2}:?\d{2})?/;

/** Aug 30 12:00:00, the syslog timestamp. It carries no year. */
const SYSLOG_TIME_RE = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;

/** Epoch milliseconds for a CLF bracket body, or undefined if it is not one. */
export function parseClfTime(raw: string): number | undefined {
  const m = CLF_TIME_RE.exec(raw.trim());
  if (!m) return undefined;
  const month = MONTHS[(m[2] as string).toLowerCase()];
  if (month === undefined) return undefined;
  const base = Date.UTC(
    Number(m[3]),
    month,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  if (!m[7]) return base;
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000;
  return m[7] === "+" ? base - offset : base + offset;
}

/**
 * An ISO 8601 timestamp at the start of `line`.
 *
 * A form with no zone designator is read as UTC rather than handed to
 * Date.parse, which would read it as local time and make the report depend on
 * the machine running it.
 */
export function parseIsoTime(line: string): { ms: number; raw: string } | undefined {
  const m = ISO_TIME_RE.exec(line);
  if (!m) return undefined;
  const fraction = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  const base = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Math.floor(fraction),
  );
  if (!Number.isFinite(base)) return undefined;
  const zone = m[8];
  if (!zone || zone === "Z" || zone === "z") return { ms: base, raw: m[0].trim() };
  const sign = zone[0] === "-" ? 1 : -1;
  const digits = zone.slice(1).replace(":", "");
  const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  return { ms: base + sign * offset, raw: m[0].trim() };
}

/** An epoch milliseconds value as ISO 8601 in UTC. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** A span of milliseconds as "2h 14m 3s". Always at least "0s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const total = Math.round(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* addresses                                                           */
/* ------------------------------------------------------------------ */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Drop the host identifying tail of an address: the last octet of an IPv4, the
 * last group of an IPv6. The network part is what makes a top list useful, and
 * the host part is the part that identifies a person.
 */
export function maskAddress(ip: string): string {
  const v4 = IPV4_RE.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(":")) {
    const cut = ip.lastIndexOf(":");
    if (cut > 0) return `${ip.slice(0, cut + 1)}x`;
  }
  return ip;
}

/** The first address in an X-Forwarded-For style list, trimmed. */
function firstAddress(raw: string): string {
  const comma = raw.indexOf(",");
  return (comma === -1 ? raw : raw.slice(0, comma)).trim();
}

/* ------------------------------------------------------------------ */
/* counters                                                            */
/* ------------------------------------------------------------------ */

/** A bounded frequency table. Past MAX_DISTINCT it stops learning new keys. */
class Counter {
  readonly counts = new Map<string, number>();
  /** Hits for keys that arrived after the cap and so were never named. */
  overflow = 0;
  total = 0;

  add(key: string, by = 1): void {
    this.total += by;
    const existing = this.counts.get(key);
    if (existing !== undefined) {
      this.counts.set(key, existing + by);
      return;
    }
    if (this.counts.size >= MAX_DISTINCT) {
      this.overflow += by;
      return;
    }
    this.counts.set(key, by);
  }

  get capped(): boolean {
    return this.overflow > 0;
  }

  /** The `n` most frequent keys, ties broken by key so the report is stable. */
  top(n: number): { key: string; count: number }[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));
  }
}

/** The `n` largest durations seen, kept sorted so no full list is retained. */
class SlowestList {
  private readonly items: { ms: number; label: string }[] = [];

  constructor(private readonly limit: number) {}

  add(ms: number, label: string): void {
    const last = this.items[this.items.length - 1];
    if (this.items.length >= this.limit && last !== undefined && ms <= last.ms) return;
    let at = this.items.length;
    while (at > 0 && (this.items[at - 1] as { ms: number }).ms < ms) at -= 1;
    this.items.splice(at, 0, { ms, label });
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  get list(): readonly { ms: number; label: string }[] {
    return this.items;
  }
}

/* ------------------------------------------------------------------ */
/* access log parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * The Apache/nginx access log line.
 *
 * The quoted fields allow backslash escapes because nginx escapes a quote
 * inside a request or user agent rather than dropping it, and a line holding
 * one would otherwise be counted as unreadable. The referer and agent pair is
 * optional, which is what separates the combined format from the common one,
 * and the trailing group holds whatever the server appended after them.
 *
 * The first field accepts a comma separated list because nginx's
 * $proxy_add_x_forwarded_for writes "client, proxy" there, spaces included.
 * The alternation is written over [^\s,] rather than \S so a comma can only
 * be matched by the separator, which keeps the group unambiguous and the
 * match linear instead of backtracking through every split of the list.
 */
const ACCESS_RE =
  /^((?:[^\s,]+,\s*)*[^\s,]+)\s+(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+"((?:[^"\\]|\\.)*)"\s+(\d{3}|-)\s+(\d+|-)(?:\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

/** nginx writes $request_time with three decimals; rt= is the logfmt spelling. */
const TRAILING_SECONDS_RE = /(?:^|\s)(\d+\.\d{1,6})\s*$/;
const RT_FIELD_RE = /\b(?:rt|request_time|upstream_response_time)=(\d+(?:\.\d+)?)/;

function parseAccessLine(line: string): { parsed: ParsedLine; combined: boolean } | undefined {
  const m = ACCESS_RE.exec(line);
  if (!m) return undefined;

  const parsed: ParsedLine = {};

  const ip = m[1] as string;
  if (ip !== "-") parsed.ip = firstAddress(ip);

  const stamp = m[4] as string;
  const ms = parseClfTime(stamp);
  if (ms !== undefined) parsed.timeMs = ms;
  if (stamp) parsed.timeRaw = stamp;

  // "GET /path HTTP/1.1". A malformed request line is kept whole as the path
  // so a probe for "/../../etc/passwd" still shows up in the top list.
  const request = m[5] as string;
  const firstSpace = request.indexOf(" ");
  const lastSpace = request.lastIndexOf(" ");
  if (firstSpace > 0 && lastSpace > firstSpace) {
    parsed.method = request.slice(0, firstSpace);
    parsed.path = request.slice(firstSpace + 1, lastSpace);
  } else if (request) {
    parsed.path = request;
  }

  const status = m[6] as string;
  if (status !== "-") parsed.status = Number(status);

  const bytes = m[7] as string;
  if (bytes !== "-") parsed.bytes = Number(bytes);

  const combined = m[9] !== undefined;
  if (combined) {
    const agent = m[9] as string;
    if (agent && agent !== "-") parsed.agent = agent;
  }

  const tail = (m[10] as string) ?? "";
  const rt = RT_FIELD_RE.exec(tail);
  const trailing = rt ? undefined : TRAILING_SECONDS_RE.exec(tail);
  const seconds = rt ? Number(rt[1]) : trailing ? Number(trailing[1]) : undefined;
  if (seconds !== undefined && Number.isFinite(seconds)) parsed.durationMs = seconds * 1000;

  return { parsed, combined };
}

/* ------------------------------------------------------------------ */
/* JSON line parsing                                                   */
/* ------------------------------------------------------------------ */

const JSON_KEYS = {
  time: [
    "timestamp",
    "time",
    "ts",
    "@timestamp",
    "time_local",
    "datetime",
    "date",
    "eventtime",
    "event_time",
  ],
  status: ["status", "status_code", "statuscode", "response_code", "http_status", "code"],
  path: ["path", "url", "uri", "request_uri", "request_path", "route", "target", "request"],
  ip: ["ip", "remote_addr", "client_ip", "clientip", "remote_ip", "x_forwarded_for", "remoteaddr"],
  agent: ["user_agent", "useragent", "http_user_agent", "agent", "ua"],
  bytes: [
    "bytes",
    "body_bytes_sent",
    "bytes_sent",
    "response_size",
    "size",
    "content_length",
    "length",
  ],
  duration: [
    "duration_ms",
    "latency_ms",
    "elapsed_ms",
    "response_time_ms",
    "took_ms",
    "duration_us",
    "duration_ns",
    "request_time",
    "upstream_response_time",
    "response_time",
    "duration",
    "latency",
    "elapsed",
    "took",
  ],
  level: ["level", "severity", "lvl", "loglevel", "log_level"],
  method: ["method", "http_method", "verb", "request_method"],
  message: ["message", "msg", "error", "err", "event"],
} as const;

/**
 * Keys whose numeric value is already in seconds. Everything else with a
 * duration-ish name is read as milliseconds, which is what application JSON
 * loggers overwhelmingly write; the assumption is reported alongside the
 * result rather than hidden.
 */
const SECOND_KEYS = new Set(["request_time", "upstream_response_time"]);

function lowerKeys(value: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, v] of Object.entries(value)) out.set(key.toLowerCase(), v);
  return out;
}

function pick(
  fields: Map<string, unknown>,
  names: readonly string[],
): [string, unknown] | undefined {
  for (const name of names) {
    const value = fields.get(name);
    if (value !== undefined && value !== null && value !== "") return [name, value];
  }
  return undefined;
}

/** "250ms", "1.5s", "3m" or a bare number of milliseconds. */
export function durationToMs(key: string, value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (key.endsWith("_ns")) return value / 1e6;
    if (key.endsWith("_us")) return value / 1000;
    if (SECOND_KEYS.has(key)) return value * 1000;
    return value;
  }
  if (typeof value !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ns|us|ms|s|m|h)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ns":
      return n / 1e6;
    case "us":
      return n / 1000;
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return SECOND_KEYS.has(key) ? n * 1000 : n;
  }
}

function parseJsonLine(line: string): ParsedLine | undefined {
  const text = line.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const fields = lowerKeys(value as Record<string, unknown>);
  const parsed: ParsedLine = {};

  const time = pick(fields, JSON_KEYS.time);
  if (time) {
    const raw = time[1];
    if (typeof raw === "number") {
      // Epoch values arrive in seconds or milliseconds depending on the
      // logger; anything below 1e11 is far too small to be milliseconds.
      parsed.timeMs = raw < 1e11 ? raw * 1000 : raw;
      parsed.timeRaw = String(raw);
    } else if (typeof raw === "string") {
      const iso = parseIsoTime(raw);
      const clf = iso ? undefined : parseClfTime(raw);
      if (iso) {
        parsed.timeMs = iso.ms;
      } else if (clf !== undefined) {
        parsed.timeMs = clf;
      }
      parsed.timeRaw = raw;
    }
  }

  const status = pick(fields, JSON_KEYS.status);
  if (status) {
    const n = Number(status[1]);
    if (Number.isFinite(n) && n >= 100 && n < 600) parsed.status = n;
  }

  const path = pick(fields, JSON_KEYS.path);
  if (path && typeof path[1] === "string") {
    // A "request" key sometimes holds the whole "GET /x HTTP/1.1" line.
    const raw = path[1];
    const space = raw.indexOf(" ");
    const end = raw.lastIndexOf(" ");
    if (path[0] === "request" && space > 0 && end > space) {
      parsed.method = raw.slice(0, space);
      parsed.path = raw.slice(space + 1, end);
    } else {
      parsed.path = raw;
    }
  }

  const method = pick(fields, JSON_KEYS.method);
  if (method && typeof method[1] === "string" && !parsed.method) parsed.method = method[1];

  const ip = pick(fields, JSON_KEYS.ip);
  if (ip && typeof ip[1] === "string") parsed.ip = firstAddress(ip[1]);

  const agent = pick(fields, JSON_KEYS.agent);
  if (agent && typeof agent[1] === "string") parsed.agent = agent[1];

  const bytes = pick(fields, JSON_KEYS.bytes);
  if (bytes) {
    const n = Number(bytes[1]);
    if (Number.isFinite(n) && n >= 0) parsed.bytes = n;
  }

  const duration = pick(fields, JSON_KEYS.duration);
  if (duration) {
    const ms = durationToMs(duration[0], duration[1]);
    if (ms !== undefined) parsed.durationMs = ms;
  }

  const level = pick(fields, JSON_KEYS.level);
  if (level && (typeof level[1] === "string" || typeof level[1] === "number")) {
    parsed.level = String(level[1]).toUpperCase();
  }

  return parsed;
}

/** The message-ish text of a JSON line, for the error samples. */
function jsonMessage(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line.trim());
    if (typeof value !== "object" || value === null) return undefined;
    const fields = lowerKeys(value as Record<string, unknown>);
    const message = pick(fields, JSON_KEYS.message);
    return message && typeof message[1] === "string" ? message[1] : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* generic timestamped lines                                           */
/* ------------------------------------------------------------------ */

const LOGFMT_LEVEL_RE = /\blevel=("?)([A-Za-z]+)\1/;
const UPPER_LEVEL_RE =
  /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL|CRIT|SEVERE|PANIC)\b/;

/** The severity a plain text line names, uppercased, if it names one. */
export function detectLevel(line: string): string | undefined {
  const logfmt = LOGFMT_LEVEL_RE.exec(line);
  if (logfmt) return (logfmt[2] as string).toUpperCase();
  const upper = UPPER_LEVEL_RE.exec(line);
  return upper ? (upper[1] as string) : undefined;
}

const ERROR_LEVELS = new Set([
  "ERROR",
  "ERR",
  "FATAL",
  "CRITICAL",
  "CRIT",
  "SEVERE",
  "PANIC",
  "EMERG",
  "ALERT",
]);

const ERROR_TEXT_RE =
  /\b(ERROR|FATAL|CRITICAL|PANIC|EXCEPTION)\b|Traceback \(most recent call last\)/;

function parseTimestampedLine(line: string): ParsedLine | undefined {
  const trimmed = line.startsWith("[") ? line.slice(1) : line;
  const iso = parseIsoTime(trimmed);
  const parsed: ParsedLine = {};
  if (iso) {
    parsed.timeMs = iso.ms;
    parsed.timeRaw = iso.raw;
  } else {
    const syslog = SYSLOG_TIME_RE.exec(trimmed);
    if (!syslog) return undefined;
    // No year, so no absolute instant. The raw text still orders the file.
    parsed.timeRaw = syslog[0];
  }
  const level = detectLevel(line);
  if (level) parsed.level = level;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* format detection                                                    */
/* ------------------------------------------------------------------ */

export interface Detection {
  format: LogFormat;
  /** Lines inspected to decide. */
  sampled: number;
  /** Lines in the sample the winning parser could read. */
  matched: number;
}

/**
 * Score every parser against the first non-empty lines and take the best.
 *
 * Order matters where two parsers both fit: an access log line also starts
 * with something the generic reader would call a timestamp only after the
 * bracket, so the access reader is tried first, and JSON before the generic
 * reader because a JSON object may embed an ISO timestamp anywhere.
 */
export function detectFormat(lines: readonly string[]): Detection {
  let access = 0;
  let combinedHits = 0;
  let json = 0;
  let timestamped = 0;
  const sampled = lines.length;

  for (const line of lines) {
    const hit = parseAccessLine(line);
    if (hit) {
      access += 1;
      if (hit.combined) combinedHits += 1;
      continue;
    }
    if (parseJsonLine(line)) {
      json += 1;
      continue;
    }
    if (parseTimestampedLine(line)) timestamped += 1;
  }

  if (access >= json && access >= timestamped && access > 0) {
    const format: LogFormat = combinedHits * 2 >= access ? "combined" : "common";
    return { format, sampled, matched: access };
  }
  if (json >= timestamped && json > 0) return { format: "json", sampled, matched: json };
  return { format: "timestamped", sampled, matched: timestamped };
}

function parseWith(format: LogFormat, line: string): ParsedLine | undefined {
  if (format === "combined" || format === "common") return parseAccessLine(line)?.parsed;
  if (format === "json") return parseJsonLine(line);
  return parseTimestampedLine(line);
}

/* ------------------------------------------------------------------ */
/* the pass                                                            */
/* ------------------------------------------------------------------ */

export interface LogStats {
  detection: Detection;
  totalLines: number;
  parsedLines: number;
  skippedLines: number;
  firstMs?: number;
  lastMs?: number;
  firstRaw?: string;
  lastRaw?: string;
  statusClasses: Map<string, number>;
  statusCodes: Counter;
  paths: Counter;
  ips: Counter;
  agents: Counter;
  methods: Counter;
  levels: Counter;
  bytes: number;
  bytesLines: number;
  durationLines: number;
  durationTotalMs: number;
  slowest: readonly { ms: number; label: string }[];
  errorSamples: string[];
  errorLines: number;
  /** Whether any duration value was read as milliseconds by assumption. */
  durationAssumed: boolean;
}

function shorten(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > LINE_CAP ? `${flat.slice(0, LINE_CAP)}...` : flat;
}

/**
 * Read every line once, accumulating counters.
 *
 * Exported so a caller (and the tests) can inspect the raw numbers without
 * going through the formatted record.
 */
export function analyze(text: string, settings: Settings): LogStats {
  const sample: string[] = [];
  // The sample is taken from the head of the file, which is where a rotated
  // log's format is decided; a mixed file still parses, the odd lines just
  // land in the skipped count.
  {
    let at = 0;
    while (sample.length < DETECT_SAMPLE && at < text.length) {
      const end = text.indexOf("\n", at);
      const line = (end === -1 ? text.slice(at) : text.slice(at, end)).replace(/\r$/, "");
      if (line.trim()) sample.push(line);
      if (end === -1) break;
      at = end + 1;
    }
  }

  const detection = detectFormat(sample);
  const format = detection.format;

  const statusClasses = new Map<string, number>();
  const stats: LogStats = {
    detection,
    totalLines: 0,
    parsedLines: 0,
    skippedLines: 0,
    statusClasses,
    statusCodes: new Counter(),
    paths: new Counter(),
    ips: new Counter(),
    agents: new Counter(),
    methods: new Counter(),
    levels: new Counter(),
    bytes: 0,
    bytesLines: 0,
    durationLines: 0,
    durationTotalMs: 0,
    slowest: [],
    errorSamples: [],
    errorLines: 0,
    durationAssumed: false,
  };

  const slowest = new SlowestList(settings.top);

  let at = 0;
  while (at <= text.length) {
    const end = text.indexOf("\n", at);
    const raw = end === -1 ? text.slice(at) : text.slice(at, end);
    at = end === -1 ? text.length + 1 : end + 1;

    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) {
      if (end === -1) break;
      continue;
    }
    stats.totalLines += 1;

    const parsed = parseWith(format, line);
    if (!parsed) {
      stats.skippedLines += 1;
      // An unreadable line is still worth reading for the word ERROR: a stack
      // trace inside an access log is exactly what a reader is looking for.
      if (ERROR_TEXT_RE.test(line)) {
        stats.errorLines += 1;
        if (stats.errorSamples.length < DEFAULT_ERROR_SAMPLES)
          stats.errorSamples.push(shorten(line));
      }
      if (end === -1) break;
      continue;
    }

    stats.parsedLines += 1;

    if (parsed.timeMs !== undefined) {
      if (stats.firstMs === undefined || parsed.timeMs < stats.firstMs)
        stats.firstMs = parsed.timeMs;
      if (stats.lastMs === undefined || parsed.timeMs > stats.lastMs) stats.lastMs = parsed.timeMs;
    }
    if (parsed.timeRaw) {
      stats.firstRaw ??= parsed.timeRaw;
      stats.lastRaw = parsed.timeRaw;
    }

    if (parsed.status !== undefined) {
      const cls = `${Math.floor(parsed.status / 100)}xx`;
      statusClasses.set(cls, (statusClasses.get(cls) ?? 0) + 1);
      stats.statusCodes.add(String(parsed.status));
    }

    if (parsed.path) {
      let key = parsed.path;
      if (settings.stripQuery) {
        const q = key.indexOf("?");
        if (q !== -1) key = key.slice(0, q);
      }
      stats.paths.add(key || "/");
    }

    if (parsed.ip) stats.ips.add(settings.maskIps ? maskAddress(parsed.ip) : parsed.ip);
    if (parsed.agent) stats.agents.add(parsed.agent);
    if (parsed.method) stats.methods.add(parsed.method);
    if (parsed.level) stats.levels.add(parsed.level);

    if (parsed.bytes !== undefined) {
      stats.bytes += parsed.bytes;
      stats.bytesLines += 1;
    }

    if (parsed.durationMs !== undefined) {
      stats.durationLines += 1;
      stats.durationTotalMs += parsed.durationMs;
      const label = parsed.path
        ? `${parsed.method ? `${parsed.method} ` : ""}${parsed.path}`
        : shorten(line).slice(0, 80);
      slowest.add(parsed.durationMs, label);
    }

    const isError =
      (parsed.status !== undefined && parsed.status >= 400) ||
      (parsed.level !== undefined && ERROR_LEVELS.has(parsed.level)) ||
      (parsed.level === undefined && parsed.status === undefined && ERROR_TEXT_RE.test(line));
    if (isError) {
      stats.errorLines += 1;
      if (stats.errorSamples.length < DEFAULT_ERROR_SAMPLES) {
        const message = format === "json" ? jsonMessage(line) : undefined;
        stats.errorSamples.push(
          message
            ? `${parsed.level ?? parsed.status ?? "error"}: ${shorten(message)}`
            : shorten(line),
        );
      }
    }

    if (end === -1) break;
  }

  stats.slowest = slowest.list;
  stats.durationAssumed = format === "json" && stats.durationLines > 0;
  return stats;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function renderTop(counter: Counter, n: number, unit: string): string {
  const rows = counter.top(n);
  if (rows.length === 0) return `no ${unit} recorded`;
  const width = String(rows[0]?.count ?? 0).length;
  const lines = rows.map(
    (row) =>
      `${String(row.count).padStart(width)}  ${pct(row.count, counter.total).padStart(5)}  ${row.key}`,
  );
  if (counter.capped) {
    lines.push(
      `plus ${counter.overflow.toLocaleString()} hits across more than ${MAX_DISTINCT.toLocaleString()} distinct ${unit}, which were counted but not named`,
    );
  }
  return lines.join("\n");
}

const CLASS_ORDER = ["1xx", "2xx", "3xx", "4xx", "5xx"];

const CLASS_LABELS: Record<string, string> = {
  "1xx": "informational",
  "2xx": "success",
  "3xx": "redirect",
  "4xx": "client error",
  "5xx": "server error",
};

function renderStatusClasses(stats: LogStats, top: number): string {
  const total = [...stats.statusClasses.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return "no status codes in this log";
  const known = new Set(CLASS_ORDER);
  const order = [...CLASS_ORDER, ...[...stats.statusClasses.keys()].filter((k) => !known.has(k))];
  const lines: string[] = [];
  for (const cls of order) {
    const count = stats.statusClasses.get(cls);
    if (!count) continue;
    const label = CLASS_LABELS[cls] ?? "other";
    lines.push(`${cls} ${label}: ${count.toLocaleString()} (${pct(count, total)})`);
  }
  const codes = stats.statusCodes.top(Math.min(top, 8));
  if (codes.length > 0) {
    lines.push("");
    lines.push(`by code: ${codes.map((c) => `${c.key} x${c.count.toLocaleString()}`).join(", ")}`);
  }
  return lines.join("\n");
}

function renderTimeSpan(stats: LogStats): string {
  if (stats.firstMs !== undefined && stats.lastMs !== undefined) {
    const lines = [
      `first: ${isoUtc(stats.firstMs)}`,
      `last:  ${isoUtc(stats.lastMs)}`,
      `span:  ${formatDuration(stats.lastMs - stats.firstMs)}`,
    ];
    if (stats.lastMs > stats.firstMs && stats.parsedLines > 1) {
      const perHour = (stats.parsedLines / ((stats.lastMs - stats.firstMs) / 3_600_000)).toFixed(0);
      lines.push(`rate:  about ${Number(perHour).toLocaleString()} lines per hour`);
    }
    lines.push("All times are UTC.");
    return lines.join("\n");
  }
  if (stats.firstRaw && stats.lastRaw) {
    return [
      `first: ${stats.firstRaw}`,
      `last:  ${stats.lastRaw}`,
      "These timestamps carry no year or time zone, so no absolute span is computed.",
    ].join("\n");
  }
  return "no timestamps found in this log";
}

function renderSlowest(stats: LogStats, top: number): string {
  if (stats.slowest.length === 0) return "no duration field found in this log";
  const lines = stats.slowest
    .slice(0, top)
    .map((row) => `${row.ms.toFixed(1).padStart(9)} ms  ${row.label}`);
  const mean = stats.durationTotalMs / stats.durationLines;
  lines.push("");
  lines.push(
    `${stats.durationLines.toLocaleString()} lines carried a duration, mean ${mean.toFixed(1)} ms`,
  );
  if (stats.durationAssumed) {
    lines.push(
      "Numeric JSON durations are read as milliseconds unless the key names another unit, or is request_time or upstream_response_time, which are read as seconds.",
    );
  }
  return lines.join("\n");
}

function renderErrors(stats: LogStats): string {
  if (stats.errorLines === 0) return "no error lines found";
  const lines = [
    `${stats.errorLines.toLocaleString()} error lines (status 400 and above, or a line naming ERROR, FATAL, CRITICAL, PANIC, EXCEPTION or a Python traceback)`,
    "",
    ...stats.errorSamples,
  ];
  if (stats.errorLines > stats.errorSamples.length) {
    lines.push(`and ${(stats.errorLines - stats.errorSamples.length).toLocaleString()} more`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function toText(input: Uint8Array | string): string {
  if (typeof input === "string") {
    if (input.length > MAX_CHARS) {
      throw new ToolError(
        "too-large",
        `That is ${formatBytes(input.length)} of text, past the ${formatBytes(MAX_CHARS)} this page reads in one go.`,
        "Take a slice of the log (head, tail or a single day) and paste that instead, or split the file and run it in parts.",
      );
    }
    return input;
  }
  if (input.byteLength > MAX_CHARS) {
    throw new ToolError(
      "too-large",
      `That file is ${formatBytes(input.byteLength)}, past the ${formatBytes(MAX_CHARS)} this page reads in one go.`,
      "Split the log first, for example with split, head or tail, and drop one part at a time.",
    );
  }
  return new TextDecoder("utf-8").decode(input);
}

export function run(
  input: Uint8Array | string,
  opts?: Partial<LogAnalyzerOpts>,
): Record<string, string> {
  const settings = resolve(opts);
  const text = toText(input);

  if (!text.trim()) {
    throw new ToolError(
      "empty-input",
      "There is no log to analyze.",
      "Paste some log lines, or drop a .log or .txt file onto the input.",
    );
  }

  const stats = analyze(text, settings);

  if (stats.totalLines === 0) {
    throw new ToolError(
      "empty-input",
      "There is no log to analyze.",
      "Paste some log lines, or drop a .log or .txt file onto the input.",
    );
  }

  if (stats.parsedLines === 0) {
    throw new ToolError(
      "unrecognized-format",
      `None of the ${stats.totalLines.toLocaleString()} lines matched an access log, a JSON line, or a line starting with a timestamp.`,
      "This page reads Apache and nginx access logs, one JSON object per line, and plain lines that start with an ISO 8601 or syslog timestamp. For anything else, try the hex viewer or the CSV viewer.",
    );
  }

  const detection = stats.detection;
  const confidence = detection.sampled > 0 ? pct(detection.matched, detection.sampled) : "0%";
  const out: Record<string, string> = {};

  out["Format detected"] =
    `${FORMAT_LABELS[detection.format]}\n${confidence} of the first ${detection.sampled.toLocaleString()} lines matched this shape`;

  out["Lines"] = [
    `${stats.totalLines.toLocaleString()} non-empty lines`,
    `${stats.parsedLines.toLocaleString()} parsed, ${stats.skippedLines.toLocaleString()} skipped`,
  ].join("\n");

  out["Time span"] = renderTimeSpan(stats);

  const wantTraffic = settings.view === "all" || settings.view === "traffic";
  const wantErrors = settings.view === "all" || settings.view === "errors";
  const wantTiming = settings.view === "all" || settings.view === "timing";

  if (wantTraffic || wantErrors) {
    out["Status classes"] = renderStatusClasses(stats, settings.top);
  }

  if (stats.levels.total > 0 && (wantTraffic || wantErrors)) {
    out["Severity levels"] = renderTop(stats.levels, settings.top, "levels");
  }

  if (wantTraffic) {
    if (stats.methods.total > 0) {
      out["Methods"] = renderTop(stats.methods, Math.min(settings.top, 10), "methods");
    }
    out[`Top ${settings.top} paths`] = renderTop(stats.paths, settings.top, "paths");
    out[`Top ${settings.top} addresses`] = [
      renderTop(stats.ips, settings.top, "addresses"),
      settings.maskIps
        ? "\nThe host part of every address is replaced with x. Turn masking off to see them in full."
        : "",
    ]
      .join("")
      .trimEnd();
    out[`Top ${settings.top} user agents`] = renderTop(stats.agents, settings.top, "user agents");
    out["Bytes served"] =
      stats.bytesLines > 0
        ? `${formatBytes(stats.bytes)} across ${stats.bytesLines.toLocaleString()} lines (${stats.bytes.toLocaleString()} bytes), mean ${formatBytes(stats.bytes / stats.bytesLines)} per line`
        : "no response size field in this log";
  }

  if (wantTiming) {
    out[`Slowest ${settings.top} requests`] = renderSlowest(stats, settings.top);
  }

  if (wantErrors) {
    out["Error lines"] = renderErrors(stats);
  }

  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  Partial<LogAnalyzerOpts>
>;
