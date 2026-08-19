import { ToolError, type ToolLogic } from "../types";

export interface HttpHeaderInspectorOpts {
  /** 'explained' | 'raw' | 'curl' */
  view: string;
  [key: string]: unknown;
}

export type PrivacyLevel = "low" | "medium" | "high";

export interface HeaderDoc {
  /** One sentence: what this header is and what it reveals. */
  what: string;
  privacy: PrivacyLevel;
  /** Extra caveat, shown appended to `what`. */
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Header knowledge base
 * ------------------------------------------------------------------ */

export const HEADER_DOCS: Record<string, HeaderDoc> = {
  host: {
    what: "The domain and port the request is addressed to, taken from the URL. Required on every HTTP/1.1 request.",
    privacy: "low",
  },
  "user-agent": {
    what: "Identifies the browser, its rendering engine, and the operating system it is running on.",
    privacy: "medium",
  },
  accept: {
    what: "Lists the content types this client is willing to receive, most preferred first, such as text/html or image/webp.",
    privacy: "low",
  },
  "accept-language": {
    what: "Lists the languages and regional locales this client prefers to receive content in, most preferred first.",
    privacy: "medium",
  },
  "accept-encoding": {
    what: "Lists the compression formats this client can decode, such as gzip, br (Brotli), or zstd.",
    privacy: "low",
  },
  referer: {
    what: "The URL of the page that linked to this request, letting the destination site see where the visit came from.",
    note: "The header name is a decades old misspelling of referrer baked into the original HTTP spec, and it can never be fixed without breaking the web.",
    privacy: "medium",
  },
  origin: {
    what: "The scheme, host, and port the request originated from, sent on cross origin and some same origin requests so the server can enforce CORS.",
    privacy: "low",
  },
  cookie: {
    what: "Any cookies previously set by this site for this browser, sent back on every matching request.",
    note: "Its value is redacted here because it can carry a live session identifier.",
    privacy: "high",
  },
  connection: {
    what: "Controls whether the underlying TCP connection stays open (keep alive) or closes after this request.",
    privacy: "low",
  },
  "upgrade-insecure-requests": {
    what: "Signals that the browser prefers an encrypted and authenticated response, and will follow a redirect that upgrades to HTTPS.",
    privacy: "low",
  },
  dnt: {
    what: 'Do Not Track: a legacy opt out signal, "1" meaning tracking is unwanted.',
    note: "Almost no site honors it anymore, so most modern browsers have dropped support for sending it.",
    privacy: "low",
  },
  "sec-gpc": {
    what: 'Global Privacy Control: a newer opt out signal, "1" meaning do not sell or share this data.',
    note: "Some jurisdictions legally require sites to honor this one.",
    privacy: "low",
  },
  "sec-ch-ua": {
    what: "Client Hints: the browser's brand and significant version, a low entropy value sent instead of parsing it out of the full User-Agent string.",
    privacy: "medium",
  },
  "sec-ch-ua-mobile": {
    what: "Client Hints: whether this is a mobile device (?1) or not (?0).",
    privacy: "medium",
  },
  "sec-ch-ua-platform": {
    what: "Client Hints: the operating system family, such as Windows, macOS, or Android.",
    privacy: "medium",
  },
  "sec-ch-ua-platform-version": {
    what: "Client Hints: the operating system version number.",
    note: "A high entropy hint, only sent to origins that opted in with Accept-CH or a permissions policy.",
    privacy: "medium",
  },
  "sec-ch-ua-full-version": {
    what: "Client Hints: the browser's exact version number, deprecated in favor of full-version-list.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-ch-ua-full-version-list": {
    what: "Client Hints: every brand the browser identifies as, each with its exact version.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-ch-ua-arch": {
    what: "Client Hints: the CPU architecture, such as x86 or arm.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-ch-ua-model": {
    what: "Client Hints: the device model string, mostly populated on Android.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-ch-ua-bitness": {
    what: "Client Hints: whether the CPU architecture is 32 bit or 64 bit.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-ch-ua-wow64": {
    what: "Client Hints: whether a 32 bit browser is running under 64 bit Windows through the WOW64 compatibility layer.",
    note: "A high entropy hint, only sent to origins that opted in.",
    privacy: "medium",
  },
  "sec-fetch-site": {
    what: "Fetch Metadata: the relationship between the page making the request and the destination: same-origin, same-site, cross-site, or none.",
    privacy: "low",
  },
  "sec-fetch-mode": {
    what: "Fetch Metadata: the request mode, such as navigate, cors, no-cors, or same-origin.",
    privacy: "low",
  },
  "sec-fetch-dest": {
    what: "Fetch Metadata: what the request result will be used for, such as document, image, script, or style.",
    privacy: "low",
  },
  "sec-fetch-user": {
    what: "Fetch Metadata: present and set to ?1 only when the request was triggered by an actual user action like a click, not a script.",
    privacy: "low",
  },
  "cache-control": {
    what: "Caching directives the client is applying to this request, such as no-cache or max-age.",
    privacy: "low",
  },
  pragma: {
    what: "A legacy HTTP/1.0 caching directive, kept for backward compatibility with caches that predate Cache-Control.",
    privacy: "low",
  },
  "if-none-match": {
    what: "Sent with a previously received ETag so the server can reply 304 Not Modified instead of resending an unchanged response.",
    privacy: "low",
  },
  "if-modified-since": {
    what: "Sent with a previously received Last-Modified date so the server can reply 304 Not Modified if nothing has changed since.",
    privacy: "low",
  },
  range: {
    what: "Requests only part of a resource, by byte offset, used for resuming downloads and streaming video.",
    privacy: "low",
  },
  te: {
    what: "Lists the transfer encodings, such as trailers, the client can accept for chunked responses.",
    privacy: "low",
  },
  priority: {
    what: "The client's requested fetch priority for this resource relative to others on the page, from the Priority Hints spec.",
    privacy: "low",
  },
  "save-data": {
    what: 'Set to "on" when the browser\'s data saver mode is enabled, asking the server to send a lighter response.',
    privacy: "low",
  },
  "viewport-width": {
    what: "Client Hints: the layout viewport width in CSS pixels, letting the server pick an appropriately sized image.",
    privacy: "low",
  },
  "device-memory": {
    what: "Client Hints: an approximate, rounded amount of device RAM in gigabytes.",
    privacy: "low",
  },
  downlink: {
    what: "Client Hints (Network Information): the browser's estimate of the effective downlink bandwidth, in megabits per second.",
    privacy: "low",
  },
  ect: {
    what: "Client Hints (Network Information): the effective connection type bucket, one of slow-2g, 2g, 3g, or 4g.",
    privacy: "low",
  },
  rtt: {
    what: "Client Hints (Network Information): the browser's estimated round trip time to the server, rounded to the nearest 25ms.",
    privacy: "low",
  },
  "x-forwarded-for": {
    what: "Added by a proxy or load balancer in front of the server, listing the client IP address or addresses the request passed through.",
    privacy: "high",
  },
  "cf-connecting-ip": {
    what: "Added by Cloudflare: the original client IP address, since Cloudflare's own proxy IP would otherwise be all the origin server sees.",
    privacy: "high",
  },
  "cf-ipcountry": {
    what: "Added by Cloudflare: a two letter country code guessed from the client's IP address.",
    privacy: "low",
  },
  "x-real-ip": {
    what: "Added by a reverse proxy, commonly nginx: a simpler single IP alternative to X-Forwarded-For.",
    privacy: "low",
  },
  authorization: {
    what: "Carries credentials, such as a Bearer token or Basic auth string, proving who the request is acting as.",
    note: "Its value is redacted here because it is a secret.",
    privacy: "high",
  },
  via: {
    what: "Added by each proxy or gateway a request passes through, recording a chain of intermediaries.",
    privacy: "low",
  },
  forwarded: {
    what: "The standardized (RFC 7239) replacement for X-Forwarded-For, X-Forwarded-Proto, and X-Forwarded-Host in a single structured header.",
    privacy: "low",
  },
  "early-data": {
    what: "Set to 1 when the request was sent as TLS 1.3 early data (0-RTT), which is replayable and should not trigger side effects.",
    privacy: "low",
  },
};

/** Header names whose value is a secret and is never shown in full. */
const REDACT_HEADERS = new Set(["cookie", "authorization"]);

/** Canonical wire casing for headers this tool knows about. */
const CANONICAL_NAMES: Record<string, string> = {
  host: "Host",
  "user-agent": "User-Agent",
  accept: "Accept",
  "accept-language": "Accept-Language",
  "accept-encoding": "Accept-Encoding",
  referer: "Referer",
  origin: "Origin",
  cookie: "Cookie",
  connection: "Connection",
  "upgrade-insecure-requests": "Upgrade-Insecure-Requests",
  dnt: "DNT",
  "sec-gpc": "Sec-GPC",
  "sec-ch-ua": "Sec-CH-UA",
  "sec-ch-ua-mobile": "Sec-CH-UA-Mobile",
  "sec-ch-ua-platform": "Sec-CH-UA-Platform",
  "sec-ch-ua-platform-version": "Sec-CH-UA-Platform-Version",
  "sec-ch-ua-full-version": "Sec-CH-UA-Full-Version",
  "sec-ch-ua-full-version-list": "Sec-CH-UA-Full-Version-List",
  "sec-ch-ua-arch": "Sec-CH-UA-Arch",
  "sec-ch-ua-model": "Sec-CH-UA-Model",
  "sec-ch-ua-bitness": "Sec-CH-UA-Bitness",
  "sec-ch-ua-wow64": "Sec-CH-UA-WoW64",
  "sec-fetch-site": "Sec-Fetch-Site",
  "sec-fetch-mode": "Sec-Fetch-Mode",
  "sec-fetch-dest": "Sec-Fetch-Dest",
  "sec-fetch-user": "Sec-Fetch-User",
  "cache-control": "Cache-Control",
  pragma: "Pragma",
  "if-none-match": "If-None-Match",
  "if-modified-since": "If-Modified-Since",
  range: "Range",
  te: "TE",
  priority: "Priority",
  "save-data": "Save-Data",
  "viewport-width": "Viewport-Width",
  "device-memory": "Device-Memory",
  downlink: "Downlink",
  ect: "ECT",
  rtt: "RTT",
  "x-forwarded-for": "X-Forwarded-For",
  "cf-connecting-ip": "CF-Connecting-IP",
  "cf-ipcountry": "CF-IPCountry",
  "x-real-ip": "X-Real-IP",
  authorization: "Authorization",
  via: "Via",
  forwarded: "Forwarded",
  "early-data": "Early-Data",
};

/** Wire casing for a lowercase header name: the known casing, or a generic Title-Case guess. */
function displayName(lower: string): string {
  if (CANONICAL_NAMES[lower]) return CANONICAL_NAMES[lower];
  return lower
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

/* ------------------------------------------------------------------ *
 * Locale names, for a readable Accept-Language summary
 * ------------------------------------------------------------------ */

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  nl: "Dutch",
  sv: "Swedish",
  no: "Norwegian",
  nb: "Norwegian Bokmal",
  nn: "Norwegian Nynorsk",
  da: "Danish",
  fi: "Finnish",
  pl: "Polish",
  tr: "Turkish",
  ar: "Arabic",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  uk: "Ukrainian",
  cs: "Czech",
  el: "Greek",
  he: "Hebrew",
  ro: "Romanian",
  hu: "Hungarian",
  bg: "Bulgarian",
  hr: "Croatian",
  sk: "Slovak",
  sl: "Slovenian",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  fa: "Persian",
  ur: "Urdu",
  ms: "Malay",
  sr: "Serbian",
  ca: "Catalan",
  is: "Icelandic",
};

const REGION_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  IE: "Ireland",
  IN: "India",
  ZA: "South Africa",
  MX: "Mexico",
  ES: "Spain",
  AR: "Argentina",
  CO: "Colombia",
  CL: "Chile",
  PE: "Peru",
  BR: "Brazil",
  PT: "Portugal",
  FR: "France",
  BE: "Belgium",
  CH: "Switzerland",
  DE: "Germany",
  AT: "Austria",
  IT: "Italy",
  NL: "Netherlands",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  TR: "Turkey",
  RU: "Russia",
  UA: "Ukraine",
  JP: "Japan",
  KR: "South Korea",
  CN: "China",
  TW: "Taiwan",
  HK: "Hong Kong",
  SG: "Singapore",
  MY: "Malaysia",
  ID: "Indonesia",
  TH: "Thailand",
  VN: "Vietnam",
};

interface LangEntry {
  tag: string;
  q: number;
}

function parseAcceptLanguageEntries(value: string): LangEntry[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [tag, ...rest] = part.split(";").map((s) => s.trim());
      let q = 1;
      for (const param of rest) {
        const m = param.match(/^q=([\d.]+)$/i);
        if (m) q = parseFloat(m[1]);
      }
      return { tag, q };
    });
}

function localeLabel(tag: string): string {
  const [langCode, regionCode] = tag.split("-");
  const lang = LANGUAGE_NAMES[langCode.toLowerCase()] || tag;
  if (regionCode) {
    const region = REGION_NAMES[regionCode.toUpperCase()];
    return region ? `${lang} (${region})` : `${lang} (${tag})`;
  }
  return lang;
}

/** Formats an Accept-Language value as a readable, preference-ordered locale list. */
export function parseAcceptLanguage(value: string): string {
  const entries = parseAcceptLanguageEntries(value);
  if (!entries.length) return "";
  const sorted = [...entries].sort((a, b) => b.q - a.q);
  return sorted.map((e) => localeLabel(e.tag)).join(", ");
}

/* ------------------------------------------------------------------ *
 * A tiny User-Agent summary. This is deliberately not a full parser: for
 * that, this site has a dedicated User-Agent Parser tool.
 * ------------------------------------------------------------------ */

export function summarizeUserAgent(ua: string): string {
  if (!ua) return "not sent.";

  let browser = "an unrecognized browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/CriOS\//.test(ua)) browser = "Chrome (iOS)";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/FxiOS\//.test(ua)) browser = "Firefox (iOS)";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Version\/[\d.]+.*Safari\//.test(ua)) browser = "Safari";
  else if (/Safari\//.test(ua)) browser = "a Safari-based browser";

  let os = "an unrecognized OS";
  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";

  return `${browser} on ${os} (a quick pattern match; the User-Agent Parser tool gives the full breakdown).`;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const REQUEST_LINE = /^[A-Za-z]+\s+\S+\s+HTTP\/\d(?:\.\d)?$/;
const STATUS_LINE = /^HTTP\/\d(?:\.\d)?\s+\d{3}/;

/**
 * Parses header text into ordered [name, value] pairs. Accepts plain
 * "Name: value" lines, curl -v transcripts (leading "> " or "< " stripped,
 * the request/status line skipped), or a JSON object of name -> value.
 * Header names are normalized to lowercase; order of first appearance is
 * kept. Returns an empty array when nothing parses as a header.
 */
export function parseHeaderText(text: string): [string, string][] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
          k.trim().toLowerCase(),
          String(v),
        ]);
      }
    } catch {
      // Not valid JSON: fall through and try line-by-line parsing.
    }
  }

  const pairs: [string, string][] = [];
  const lines = trimmed.replace(/\r\n?/g, "\n").split("\n");

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(">") || line.startsWith("<")) {
      line = line.slice(1).trim();
      if (!line) continue;
    }
    if (line.startsWith("*")) continue; // curl -v info line, e.g. "* Connected to ..."
    if (REQUEST_LINE.test(line) || STATUS_LINE.test(line)) continue;

    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    pairs.push([name, value]);
  }

  return pairs;
}

function toPairs(headers: Record<string, string> | [string, string][]): [string, string][] {
  if (Array.isArray(headers)) return headers.map(([k, v]) => [k.trim().toLowerCase(), v]);
  return Object.entries(headers).map(([k, v]) => [k.trim().toLowerCase(), v]);
}

/** Assigns unique row keys, appending " (2)", " (3)", ... for repeated header names. */
function uniqueKey(label: string, seen: Map<string, number>): string {
  const count = (seen.get(label) ?? 0) + 1;
  seen.set(label, count);
  return count === 1 ? label : `${label} (${count})`;
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

function buildSummary(pairs: [string, string][]): string {
  const lookup = new Map(pairs);
  const total = pairs.length;

  let high = 0;
  let medium = 0;
  let lowOrUnknown = 0;
  for (const [name] of pairs) {
    const doc = HEADER_DOCS[name];
    if (!doc) lowOrUnknown++;
    else if (doc.privacy === "high") high++;
    else if (doc.privacy === "medium") medium++;
    else lowOrUnknown++;
  }

  const clientHintsOn = pairs.some(([name]) => name.startsWith("sec-ch-ua"));

  const dnt = lookup.get("dnt");
  const gpc = lookup.get("sec-gpc");
  const signals: string[] = [];
  if (dnt !== undefined) {
    signals.push(`Do Not Track is ${dnt === "1" ? "on" : dnt === "0" ? "off" : `set to "${dnt}"`}`);
  }
  if (gpc !== undefined) {
    signals.push(`Global Privacy Control is ${gpc === "1" ? "on" : `set to "${gpc}"`}`);
  }
  const signalText = signals.length
    ? `${signals.join(", ")}.`
    : "Neither Do Not Track nor Global Privacy Control is being sent.";

  const acceptLanguage = lookup.get("accept-language");
  const langText = acceptLanguage ? parseAcceptLanguage(acceptLanguage) : "";

  const ua = lookup.get("user-agent");

  const parts: string[] = [
    `${total} header${total === 1 ? "" : "s"} in this set.`,
    `${high} high-privacy, ${medium} medium-privacy, and ${lowOrUnknown} low-privacy or unrecognized header${lowOrUnknown === 1 ? "" : "s"}.`,
    clientHintsOn
      ? "Client Hints are on: this browser sends the newer Sec-CH-UA family alongside, or instead of, the classic User-Agent string."
      : "Client Hints are off: no Sec-CH-UA headers were present, so brand and platform details rely on User-Agent alone.",
    signalText,
    langText ? `Accept-Language: ${langText}.` : "No Accept-Language header was sent.",
    `User-Agent: ${ua ? summarizeUserAgent(ua) : "not sent."}`,
  ];

  return parts.join(" ");
}

/* ------------------------------------------------------------------ *
 * Explained view
 * ------------------------------------------------------------------ */

function explainedValue(rawValue: string, name: string): string {
  const doc = HEADER_DOCS[name];
  const shownValue = REDACT_HEADERS.has(name)
    ? `(redacted, ${rawValue.length} character${rawValue.length === 1 ? "" : "s"})`
    : rawValue;

  if (!doc) return `${shownValue} [(no description)]`;

  const explanation = doc.note ? `${doc.what} ${doc.note}` : doc.what;
  return `${shownValue} [${explanation}] [privacy: ${doc.privacy}]`;
}

/**
 * Turns a set of request headers into labeled, explained rows: one row per
 * header carrying its value plus a bracketed explanation and privacy tag,
 * and a trailing Summary row. Unknown header names still get a row, marked
 * "(no description)".
 */
export function analyzeHeaders(headers: Record<string, string> | [string, string][]): Record<string, string> {
  const pairs = toPairs(headers);
  const rows: Record<string, string> = {};
  const seen = new Map<string, number>();

  for (const [name, value] of pairs) {
    const key = uniqueKey(displayName(name), seen);
    rows[key] = explainedValue(value, name);
  }

  rows.Summary = buildSummary(pairs);
  return rows;
}

/** Values only, no explanations: the raw header set as sent, unredacted. */
function rawRows(pairs: [string, string][]): Record<string, string> {
  const rows: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const [name, value] of pairs) {
    const key = uniqueKey(displayName(name), seen);
    rows[key] = value;
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * curl view
 * ------------------------------------------------------------------ */

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Builds a curl command that reproduces the same headers. Secrets are omitted, not leaked. */
function buildCurlCommand(pairs: [string, string][]): string {
  const host = pairs.find(([name]) => name === "host")?.[1];
  const target = host ? `https://${host}/` : "https://example.com/";

  const flagLines: string[] = [];
  const omitted: string[] = [];

  for (const [name, value] of pairs) {
    if (name === "host") continue; // curl derives Host from the target URL itself
    if (REDACT_HEADERS.has(name)) {
      omitted.push(displayName(name));
      continue;
    }
    flagLines.push(`  -H "${displayName(name)}: ${escapeForDoubleQuotes(value)}" \\`);
  }

  const lines = ["curl \\", ...flagLines, `  "${target}"`];

  if (omitted.length) {
    lines.push("");
    lines.push(
      `# ${omitted.join(" and ")} header${omitted.length === 1 ? "" : "s"} omitted: it may carry a secret, so it is not reproduced in a copyable command.`,
    );
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function normalizeView(view: unknown): "explained" | "raw" | "curl" {
  const v = String(view ?? "explained")
    .trim()
    .toLowerCase();
  if (["raw", "values", "values only", "plain", "unexplained"].includes(v)) return "raw";
  if (["curl", "curl command", "as curl", "curl -h", "reproduce with curl"].includes(v)) return "curl";
  return "explained";
}

export function run(input: string, opts: HttpHeaderInspectorOpts): string | Record<string, string> {
  const raw = (input ?? "").trim();

  if (!raw) {
    return {
      Note:
        'Click "Show my headers" in the panel to fetch and analyze the headers your own browser just sent to ' +
        "this site, or paste header text or a JSON object of headers here yourself.",
      Example: "curl -v https://tools.maxhogan.dev/api/http-header-inspector",
    };
  }

  const pairs = parseHeaderText(raw);
  if (pairs.length === 0) {
    throw new ToolError(
      "bad-input",
      "That does not look like header lines or a JSON object of headers.",
      'Paste "Name: value" lines, one per line (a curl -v transcript works too), or a JSON object like {"user-agent": "..."}.',
    );
  }

  const view = normalizeView(opts?.view);
  if (view === "curl") return buildCurlCommand(pairs);
  if (view === "raw") return rawRows(pairs);
  return analyzeHeaders(pairs);
}

export default { run } satisfies ToolLogic<string, string | Record<string, string>, HttpHeaderInspectorOpts>;
