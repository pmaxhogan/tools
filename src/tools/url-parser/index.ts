import { ToolError, type ToolLogic } from "../types";

export interface UrlParserOpts {
  [key: string]: unknown;
}

export type UrlParserResult = Record<string, string>;

/** Known default ports by scheme, keyed by `protocol` (includes trailing colon). */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "ftp:": "21",
  "ftps:": "990",
  "ssh:": "22",
  "sftp:": "22",
  "telnet:": "23",
  "smtp:": "25",
  "smtps:": "465",
  "pop3:": "110",
  "pop3s:": "995",
  "imap:": "143",
  "imaps:": "993",
  "ldap:": "389",
  "ldaps:": "636",
  "rtsp:": "554",
};

/**
 * Parse a URL, retrying with an "https://" prefix if the raw string has no
 * scheme (no "://" substring) and fails to parse as-is.
 */
function parse(raw: string): { url: URL; note?: string } {
  try {
    return { url: new URL(raw) };
  } catch {
    // fall through to retry
  }

  if (!raw.includes("://")) {
    try {
      const url = new URL(`https://${raw}`);
      return { url, note: `No scheme in input: assumed "https://".` };
    } catch {
      // fall through to error
    }
  }

  throw new ToolError(
    "unparseable-url",
    `Could not parse "${raw}" as a URL.`,
    "Check for typos, stray spaces, or unbalanced brackets, and include a scheme like https://.",
  );
}

/** Percent-decode, falling back to the raw string on malformed escapes. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function run(input: string, _opts: UrlParserOpts): UrlParserResult {
  const raw = (input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "Enter a URL to parse.",
      "Paste a full URL like https://example.com/path?q=1, or a bare domain and https:// is assumed.",
    );

  const { url, note } = parse(raw);
  const out: UrlParserResult = {};

  if (note) out["Note"] = note;

  out["Scheme"] = url.protocol;
  out["Host"] = url.hostname;

  if (url.username || url.password) {
    out["Warning"] =
      `Contains embedded credentials ("user:pass@host" pattern) before the host: ` +
      `a common phishing trick to disguise the real destination. ` +
      `The actual host is "${url.hostname}", not the text before the "@".`;
  }

  if (url.port) {
    out["Port"] = url.port;
  } else {
    const def = DEFAULT_PORTS[url.protocol];
    out["Port"] = def ? `${def} (default)` : "(none)";
  }

  out["Path"] = url.pathname;

  const seen = new Map<string, number>();
  for (const [key, value] of url.searchParams.entries()) {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const label = n === 1 ? `? ${key}` : `? ${key} [${n}]`;
    out[label] = value;
  }

  out["Fragment"] = url.hash ? safeDecode(url.hash.slice(1)) : "";
  out["Origin"] = url.origin;
  out["Decoded URL"] = safeDecode(url.href);

  return out;
}

export default { run } satisfies ToolLogic<string, UrlParserResult, UrlParserOpts>;
