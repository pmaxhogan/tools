import { ToolError, type ToolLogic } from "../types";

export interface EmailHeaderOpts {
  /** Append the full unfolded header list to the report. */
  showRaw: boolean;
  /** Which report section to render: 'all' | 'summary' | 'auth' | 'hops'. */
  section: string;
  [key: string]: unknown;
}

/** One unfolded header field, in the order it appeared in the message. */
interface Header {
  /** Field name as written, e.g. "Message-ID". */
  name: string;
  /** Lowercased field name, for case-insensitive lookup. */
  lower: string;
  /** Unfolded field value with the leading colon and whitespace removed. */
  value: string;
}

/** One parsed `method=result` chunk of an Authentication-Results header. */
interface AuthEntry {
  method: string;
  result: string;
  props: Record<string, string>;
  reason?: string;
  comment?: string;
}

/** One Received header, plus whatever could be pulled out of it. */
interface Hop {
  raw: string;
  from?: string;
  fromComment?: string;
  by?: string;
  withProto?: string;
  id?: string;
  date?: Date;
}

const HOST_WIDTH = 30;
const DELAY_WIDTH = 9;
const BAR_MAX = 24;
const BLOCK = "█";

const AUTH_HONESTY_NOTE =
  "Note: these are the verdicts the receiving mail server recorded in the headers; this tool reads them as written and never re-verifies them, because real verification needs DNS lookups this tool does not make.";

/* ------------------------------------------------------------------ *
 * Small string helpers
 * ------------------------------------------------------------------ */

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 3))}...`;
}

/* ------------------------------------------------------------------ *
 * RFC 5322 header parsing
 * ------------------------------------------------------------------ */

/**
 * Split the message at the first blank line and unfold the header section.
 * Continuation lines (those starting with a space or tab) belong to the
 * previous field. Anything after the blank line is the body and is dropped.
 */
function parseHeaders(raw: string): Header[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;

  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    block.push(lines[i]);
  }

  const headers: Header[] = [];
  let current: string | null = null;

  const flush = (): void => {
    if (current === null) return;
    const line = current;
    current = null;
    const colon = line.indexOf(":");
    if (colon <= 0) return; // mbox "From " separator or junk: skip it
    const name = line.slice(0, colon).trim();
    if (!/^[!-9;-~]+$/.test(name)) return; // printable, no spaces, per RFC 5322
    headers.push({ name, lower: name.toLowerCase(), value: line.slice(colon + 1).trim() });
  };

  for (const line of block) {
    if (/^[ \t]/.test(line)) {
      if (current !== null) current += ` ${line.trim()}`;
      continue;
    }
    flush();
    current = line;
  }
  flush();

  return headers;
}

function first(headers: Header[], name: string): string | undefined {
  const hit = headers.find((h) => h.lower === name);
  return hit ? hit.value : undefined;
}

function all(headers: Header[], name: string): string[] {
  return headers.filter((h) => h.lower === name).map((h) => h.value);
}

/** Pull the domain out of an address field like `Alice <alice@example.com>`. */
function addressDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = value.match(/<([^>]*)>/);
  const addr = (angle ? angle[1] : value).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = addr
    .slice(at + 1)
    .replace(/[>,;\s].*$/, "")
    .trim()
    .toLowerCase();
  return domain || undefined;
}

/* ------------------------------------------------------------------ *
 * Comment-aware tokenizing (shared by Authentication-Results and Received)
 * ------------------------------------------------------------------ */

/** Split on a separator that sits outside quoted strings and parenthesised comments. */
function splitTopLevel(value: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip parenthesised comments, returning the remaining text and the comments. */
function extractComments(s: string): { clean: string; comments: string[] } {
  let clean = "";
  let cur = "";
  const comments: string[] = [];
  let depth = 0;
  let quoted = false;

  const put = (c: string): void => {
    if (depth === 0) clean += c;
    else cur += c;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      put(c);
      if (c === "\\" && i + 1 < s.length) put(s[++i]);
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      put(c);
      continue;
    }
    if (c === "(") {
      depth++;
      if (depth === 1) cur = "";
      else cur += c;
      continue;
    }
    if (c === ")" && depth > 0) {
      depth--;
      if (depth === 0) {
        comments.push(cur.trim());
        cur = "";
        clean += " ";
      } else {
        cur += c;
      }
      continue;
    }
    put(c);
  }
  if (depth > 0 && cur.trim()) comments.push(cur.trim());
  return { clean, comments };
}

/** Whitespace tokenizer that keeps quoted strings together. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < s.length) cur += s[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2
    ? s.slice(1, -1).replace(/\\(.)/g, "$1")
    : s;
}

/* ------------------------------------------------------------------ *
 * Authentication-Results (RFC 8601)
 * ------------------------------------------------------------------ */

function parseAuthResults(values: string[]): { servers: string[]; entries: AuthEntry[] } {
  const servers: string[] = [];
  const entries: AuthEntry[] = [];

  for (const value of values) {
    const segments = splitTopLevel(value, ";");
    segments.forEach((segment, index) => {
      const { clean, comments } = extractComments(segment);
      const tokens = tokenize(clean);
      if (tokens.length === 0) return;

      const head = tokens[0].match(/^([A-Za-z][A-Za-z0-9-]*)(?:\/\d+)?=([A-Za-z][A-Za-z0-9_-]*)$/);
      if (!head) {
        // Not a method=result chunk. The opening segment is the authserv-id.
        if (index === 0) {
          const id = tokens[0].replace(/[;,]$/, "");
          if (id && !servers.includes(id)) servers.push(id);
        }
        return;
      }

      const entry: AuthEntry = {
        method: head[1].toLowerCase(),
        result: head[2].toLowerCase(),
        props: {},
        comment: comments[0] || undefined,
      };

      for (const token of tokens.slice(1)) {
        const eq = token.indexOf("=");
        if (eq <= 0) continue;
        const key = token.slice(0, eq).toLowerCase();
        const val = unquote(token.slice(eq + 1));
        if (key === "reason") entry.reason = val;
        else entry.props[key] = val;
      }
      entries.push(entry);
    });
  }

  return { servers, entries };
}

/** Parse a DKIM-Signature value into its tag=value pairs. */
function parseDkimSignature(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key) tags[key] = part.slice(eq + 1).trim();
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * Received parsing
 * ------------------------------------------------------------------ */

/** Parse an RFC 5322 date, tolerating trailing "(UTC)" style comments. */
function parseHeaderDate(raw: string): Date | undefined {
  let s = raw.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();
  }
  if (!s || s.length > 80) return undefined;
  if (!/\d{1,2}:\d{2}/.test(s) || !/\b\d{4}\b/.test(s)) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseReceived(value: string): Hop {
  const hop: Hop = { raw: value };

  // Per RFC 5321 the timestamp follows the final semicolon. Some senders put a
  // semicolon inside the clause list, so walk backwards until a date parses.
  let cut = value.length;
  while (cut > 0) {
    const semi = value.lastIndexOf(";", cut - 1);
    if (semi < 0) break;
    const date = parseHeaderDate(value.slice(semi + 1));
    if (date) {
      hop.date = date;
      cut = semi;
      break;
    }
    cut = semi;
  }
  const head = hop.date ? value.slice(0, cut) : value;

  const { clean } = extractComments(head);
  const from = clean.match(/(?:^|\s)from\s+([^\s;]+)/i);
  const by = clean.match(/(?:^|\s)by\s+([^\s;]+)/i);
  const withProto = clean.match(/(?:^|\s)with\s+([^\s;]+)/i);
  const id = clean.match(/(?:^|\s)id\s+([^\s;]+)/i);

  if (from) hop.from = from[1];
  if (by) hop.by = by[1];
  if (withProto) hop.withProto = withProto[1];
  if (id) hop.id = id[1];

  const fromComment = head.match(/(?:^|\s)from\s+[^\s(;]+\s*\(([^()]*)\)/i);
  if (fromComment) hop.fromComment = fromComment[1].trim();

  return hop;
}

function formatDelay(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/* ------------------------------------------------------------------ *
 * Report sections
 * ------------------------------------------------------------------ */

function renderSummary(headers: Header[]): string[] {
  const out: string[] = ["SUMMARY", "-------"];

  const fields: [string, string][] = [];
  const add = (label: string, name: string): void => {
    const value = first(headers, name);
    if (value) fields.push([label, value]);
  };
  add("From", "from");
  add("To", "to");
  add("Cc", "cc");
  add("Subject", "subject");
  add("Date", "date");
  add("Message-ID", "message-id");
  add("Reply-To", "reply-to");
  add("Return-Path", "return-path");

  if (fields.length === 0) {
    out.push("No From, To, Subject, Date or Message-ID header is present in this input.");
    return out;
  }

  const width = Math.max(...fields.map(([label]) => label.length)) + 2;
  for (const [label, value] of fields) out.push(padRight(`${label}:`, width) + value);

  const fromDomain = addressDomain(first(headers, "from"));
  const replyDomain = addressDomain(first(headers, "reply-to"));
  const returnDomain = addressDomain(first(headers, "return-path"));

  const notes: string[] = [];
  if (fromDomain && replyDomain && replyDomain !== fromDomain) {
    notes.push(
      `Warning: the Reply-To domain (${replyDomain}) is not the From domain (${fromDomain}). Replies to this message go to ${replyDomain}, which is the shape of a reply-address swap as well as of a normal support alias.`,
    );
  }
  if (fromDomain && returnDomain && returnDomain !== fromDomain) {
    notes.push(
      `Note: the Return-Path domain (${returnDomain}) is not the From domain (${fromDomain}). That is completely normal for mailing lists, ticketing systems and bulk senders, so on its own it proves nothing. Read it together with the SPF and DMARC results.`,
    );
  }
  if (first(headers, "return-path") !== undefined && !returnDomain) {
    notes.push(
      "Note: the Return-Path is the null sender, which is what bounce messages and some automated reports use.",
    );
  }
  if (notes.length) {
    out.push("");
    out.push(...notes);
  }

  return out;
}

function renderAuth(headers: Header[]): string[] {
  const out: string[] = ["AUTHENTICATION", "--------------", AUTH_HONESTY_NOTE, ""];

  const arcValues = all(headers, "arc-authentication-results");
  const values = all(headers, "authentication-results");
  const { servers, entries } = parseAuthResults(values);
  const arcParsed = parseAuthResults(arcValues);
  const signatures = all(headers, "dkim-signature").map(parseDkimSignature);

  if (values.length === 0) {
    out.push(
      "No Authentication-Results header is present, so this message carries no recorded SPF, DKIM or DMARC verdict. That absence says nothing about whether the message would pass or fail; it only means the receiving server did not write a verdict down.",
    );
  } else if (servers.length) {
    out.push(`Recorded by: ${servers.join(", ")}`);
  }

  const lines: string[] = [];
  const describe = (entry: AuthEntry, keys: string[]): string => {
    const details: string[] = [];
    for (const key of keys) if (entry.props[key]) details.push(`${key}=${entry.props[key]}`);
    if (entry.reason) details.push(`reason: ${entry.reason}`);
    let text = details.join(", ");
    if (entry.comment) text = text ? `${text} (${entry.comment})` : `(${entry.comment})`;
    return text;
  };

  for (const entry of entries.filter((e) => e.method === "spf")) {
    const detail = describe(entry, ["smtp.mailfrom", "smtp.helo", "envelope-from"]);
    lines.push(`SPF    ${padRight(entry.result, 8)}${detail}`);
  }

  const dkimEntries = entries.filter((e) => e.method === "dkim");
  if (dkimEntries.length) {
    const counts = new Map<string, number>();
    for (const entry of dkimEntries) counts.set(entry.result, (counts.get(entry.result) ?? 0) + 1);
    const word = counts.size === 1 ? dkimEntries[0].result : "mixed";
    const breakdown = [...counts.entries()].map(([result, n]) => `${n} ${result}`).join(", ");
    lines.push(
      `DKIM   ${padRight(word, 8)}${dkimEntries.length} signature${dkimEntries.length === 1 ? "" : "s"} recorded: ${breakdown}`,
    );
  } else if (values.length) {
    lines.push(
      `DKIM   ${padRight("absent", 8)}the Authentication-Results header records no DKIM verdict`,
    );
  }

  for (const entry of entries.filter((e) => e.method === "dmarc")) {
    const detail = describe(entry, ["header.from", "policy.dmarc"]);
    lines.push(`DMARC  ${padRight(entry.result, 8)}${detail}`);
  }
  for (const entry of entries.filter((e) => e.method === "arc")) {
    const detail = describe(entry, ["smtp.remote-ip", "header.oldest-pass"]);
    lines.push(`ARC    ${padRight(entry.result, 8)}${detail}`);
  }
  if (arcParsed.entries.length) {
    lines.push(
      `ARC    ${padRight("sealed", 8)}${arcParsed.entries.length} verdict(s) carried over from an earlier hop by ARC-Authentication-Results`,
    );
  }
  const known = new Set(["spf", "dmarc", "arc", "dkim"]);
  for (const entry of entries.filter((e) => !known.has(e.method))) {
    lines.push(`${padRight(entry.method.toUpperCase(), 7)}${padRight(entry.result, 8)}`);
  }

  if (lines.length) {
    out.push("");
    out.push(...lines);
  }

  // DKIM: one row per signature in the message, matched to its recorded verdict.
  const used = new Set<number>();
  const dkimRows: string[] = [];

  signatures.forEach((tags, i) => {
    const domain = (tags.d || "").toLowerCase();
    const selector = tags.s || "";
    let matched = dkimEntries.findIndex(
      (e, j) =>
        !used.has(j) &&
        (e.props["header.d"] || "").toLowerCase() === domain &&
        (!e.props["header.s"] || e.props["header.s"] === selector),
    );
    if (matched < 0) {
      matched = dkimEntries.findIndex(
        (e, j) => !used.has(j) && (e.props["header.d"] || "").toLowerCase() === domain,
      );
    }
    const entry = matched >= 0 ? dkimEntries[matched] : undefined;
    if (matched >= 0) used.add(matched);

    const parts = [
      `${i + 1}. domain ${tags.d || "(no d= tag)"}`,
      `selector ${selector || "(no s= tag)"}`,
    ];
    if (tags.a) parts.push(`algorithm ${tags.a}`);
    parts.push(
      entry
        ? `recorded result: ${entry.result}${entry.reason ? ` (${entry.reason})` : ""}`
        : "recorded result: not recorded for this signature",
    );
    dkimRows.push(`  ${parts.join(", ")}`);
  });

  dkimEntries.forEach((entry, j) => {
    if (used.has(j)) return;
    const domain = entry.props["header.d"] || entry.props["header.i"] || "(no domain given)";
    const selector = entry.props["header.s"];
    const parts = [
      `${signatures.length + j + 1}. domain ${domain}`,
      selector ? `selector ${selector}` : "selector not recorded",
      "no DKIM-Signature header for it is still on the message",
      `recorded result: ${entry.result}${entry.reason ? ` (${entry.reason})` : ""}`,
    ];
    dkimRows.push(`  ${parts.join(", ")}`);
  });

  out.push("");
  if (dkimRows.length) {
    out.push(`DKIM signatures (${dkimRows.length})`);
    out.push(...dkimRows);
  } else {
    out.push("DKIM signatures: none. The message carries no DKIM-Signature header.");
  }

  return out;
}

function renderHops(headers: Header[]): string[] {
  const out: string[] = ["HOP WATERFALL", "-------------"];

  const received = all(headers, "received");
  if (received.length === 0) {
    out.push("No Received header is present, so there is no delivery path to trace.");
    return out;
  }

  // Received headers are prepended by each server, so the topmost is the most
  // recent. Reverse for oldest first.
  const hops = received.map(parseReceived).reverse();

  const delays: (number | undefined)[] = [];
  const backwards: number[] = [];
  let lastDate: Date | undefined;

  for (const hop of hops) {
    backwards.push(0);
    if (!hop.date) {
      delays.push(undefined);
      continue;
    }
    if (!lastDate) {
      delays.push(undefined);
      lastDate = hop.date;
      continue;
    }
    const delta = hop.date.getTime() - lastDate.getTime();
    delays.push(Math.max(0, delta));
    if (delta < 0) backwards[backwards.length - 1] = -delta;
    lastDate = hop.date;
  }

  const dated = hops.filter((h) => h.date);
  const measured = delays.filter((d): d is number => d !== undefined);
  const maxDelay = measured.length ? Math.max(...measured) : 0;
  const slowest = maxDelay > 0 ? delays.indexOf(maxDelay) : -1;

  const originHost = hops[0]?.from;
  const originIp = hops[0]?.fromComment?.match(/\[([0-9A-Fa-f.:]+)\]/)?.[1];

  out.push(
    `${hops.length} Received header${hops.length === 1 ? "" : "s"}, oldest first. Delay is the gap between this hop and the one before it.`,
  );
  if (originHost)
    out.push(
      "Hop 0 is the originating host named by the oldest Received header. It writes no timestamp of its own, so it carries no delay.",
    );
  out.push("");

  if (originHost) {
    out.push(
      `${padLeft("0", 2)}  ${padRight(truncate(originHost, HOST_WIDTH), HOST_WIDTH)}  ${padLeft("origin", DELAY_WIDTH)}  ${originIp ? `IP ${originIp}` : ""}`.trimEnd(),
    );
  }

  hops.forEach((hop, i) => {
    const host = truncate(hop.by || hop.from || "(host not recorded)", HOST_WIDTH);
    const delay = delays[i];
    let text: string;
    if (!hop.date) text = "?";
    else if (delay === undefined) text = "-";
    else text = formatDelay(delay);

    const bar =
      delay !== undefined && delay > 0 && maxDelay > 0
        ? BLOCK.repeat(Math.max(1, Math.round((delay / maxDelay) * BAR_MAX)))
        : "";

    const trailer: string[] = [];
    if (bar) trailer.push(bar);
    if (!hop.date) trailer.push("no timestamp could be parsed from this line");
    if (backwards[i] > 0)
      trailer.push(
        `clock skew: the recorded time moved backwards by ${formatDelay(backwards[i])}, clamped to 0`,
      );
    if (i === slowest) trailer.push("<- slowest hop");

    out.push(
      `${padLeft(String(i + 1), 2)}  ${padRight(host, HOST_WIDTH)}  ${padLeft(text, DELAY_WIDTH)}  ${trailer.join("  ")}`.trimEnd(),
    );
  });

  out.push("");
  if (dated.length >= 2) {
    const total = dated[dated.length - 1].date!.getTime() - dated[0].date!.getTime();
    out.push(`Total transit time: ${formatDelay(Math.max(0, total))}`);
  } else if (hops.length === 1) {
    out.push("Only one Received header, so there is no hop to hop delay to measure.");
  } else {
    out.push(
      "Total transit time: not available, because fewer than two hops carry a timestamp that could be parsed.",
    );
  }

  out.push("");
  out.push("Hop details");
  hops.forEach((hop, i) => {
    const bits: string[] = [];
    if (hop.from) bits.push(`from ${hop.from}${hop.fromComment ? ` (${hop.fromComment})` : ""}`);
    if (hop.by) bits.push(`by ${hop.by}`);
    if (hop.withProto) bits.push(`with ${hop.withProto}`);
    if (hop.id) bits.push(`id ${hop.id}`);
    if (hop.date) bits.push(hop.date.toISOString());
    out.push(`${padLeft(String(i + 1), 2)}. ${bits.length ? bits.join(", ") : "nothing parsable"}`);
    if (!hop.date || bits.length === 0) out.push(`    raw: ${hop.raw}`);
  });

  return out;
}

function renderExtras(headers: Header[]): string[] {
  const wanted: [string, string][] = [
    ["X-Mailer", "x-mailer"],
    ["User-Agent", "user-agent"],
    ["List-Unsubscribe", "list-unsubscribe"],
    ["List-Id", "list-id"],
    ["X-Spam-Status", "x-spam-status"],
    ["X-Spam-Score", "x-spam-score"],
    ["X-Spam-Level", "x-spam-level"],
    ["X-Originating-IP", "x-originating-ip"],
  ];

  const rows: [string, string][] = [];
  for (const [label, name] of wanted) {
    const value = first(headers, name);
    if (value) rows.push([label, value]);
  }
  if (rows.length === 0) return [];

  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    "EXTRAS",
    "------",
    ...rows.map(([label, value]) => padRight(`${label}:`, width) + value),
  ];
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function run(input: string, opts: EmailHeaderOpts): string {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Paste the raw email headers to analyze.",
      'In Gmail open the message menu and choose "Show original"; in Outlook open Properties and copy the internet headers. A whole .eml file works too.',
    );

  const headers = parseHeaders(raw);
  if (headers.length === 0)
    throw new ToolError(
      "no-headers",
      "No email headers were found in that input.",
      'Header lines look like "Received: from ..." or "Subject: ...", one field per line. Make sure you pasted the header block and not just the message body.',
    );

  const section = (opts?.section || "all").toLowerCase();
  const blocks: string[][] = [];

  if (section === "all" || section === "summary") blocks.push(renderSummary(headers));
  if (section === "all" || section === "auth") blocks.push(renderAuth(headers));
  if (section === "all" || section === "hops") blocks.push(renderHops(headers));
  if (section === "all") {
    const extras = renderExtras(headers);
    if (extras.length) blocks.push(extras);
  }

  if (opts?.showRaw) {
    blocks.push([
      `UNFOLDED HEADERS (${headers.length})`,
      "-".repeat(`UNFOLDED HEADERS (${headers.length})`.length),
      ...headers.map((h) => `${h.name}: ${h.value}`),
    ]);
  }

  return blocks
    .filter((b) => b.length > 0)
    .map((b) => b.join("\n"))
    .join("\n\n");
}

export default { run } satisfies ToolLogic<string, string, EmailHeaderOpts>;
