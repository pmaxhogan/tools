import { ToolError, type ToolLogic } from "../types";

export interface DecodeOpts {
  /** How many nested decode steps to follow. 1 to 20, default 10. */
  maxDepth?: number;
  /** Show the value at each intermediate step, not just the final one. */
  showIntermediates?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* values                                                              */
/* ------------------------------------------------------------------ */

interface BinaryFormat {
  name: string;
  /** Compression algorithm DecompressionStream can undo, when applicable. */
  decompress?: "gzip" | "deflate";
}

type Value =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array; format: BinaryFormat | null };

function textValue(text: string): Value {
  return { kind: "text", text };
}

function bytesValue(bytes: Uint8Array): Value {
  return { kind: "bytes", bytes, format: identify(bytes) };
}

/** Identity key for the cycle guard. Bounded so huge values stay cheap. */
function keyOf(v: Value): string {
  if (v.kind === "text") return `t:${v.text.length}:${v.text.slice(0, 4096)}`;
  return `b:${v.bytes.length}:${toHex(v.bytes.subarray(0, 512), "")}`;
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_STD.length; i++) B64_LOOKUP[B64_STD[i] as string] = i;
B64_LOOKUP["-"] = 62;
B64_LOOKUP["_"] = 63;

function base64ToBytes(raw: string): Uint8Array | null {
  const core = raw.replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of core) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, i);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array, sep = " "): string {
  const parts: string[] = [];
  for (const b of bytes) parts.push(b.toString(16).padStart(2, "0"));
  return parts.join(sep);
}

function hexHead(bytes: Uint8Array, count = 16): string {
  const head = toHex(bytes.subarray(0, count));
  return bytes.length > count ? `${head} ...` : head;
}

/** Strict UTF-8 decode. Returns null when the bytes are not valid UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch {
    return null;
  }
}

/** Fraction of code points that a human would consider readable. */
function printableRatio(s: string): number {
  let ok = 0;
  let total = 0;
  for (const ch of s) {
    total++;
    const c = ch.codePointAt(0) as number;
    if (c === 9 || c === 10 || c === 13) ok++;
    else if (c >= 32 && c !== 127 && !(c >= 128 && c <= 159)) ok++;
  }
  return total === 0 ? 0 : ok / total;
}

/** Bytes that read as text a person would recognize, or null. */
function asReadableText(bytes: Uint8Array): string | null {
  if (bytes.length < 3) return null;
  const s = utf8(bytes);
  if (s === null) return null;
  return printableRatio(s) >= 0.95 ? s : null;
}

function identify(b: Uint8Array): BinaryFormat | null {
  const has = (...sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
  if (has(0x1f, 0x8b)) return { name: "gzip archive", decompress: "gzip" };
  if (
    b.length >= 2 &&
    ((b[0] as number) & 0x0f) === 8 &&
    (((b[0] as number) << 8) | (b[1] as number)) % 31 === 0
  )
    return { name: "zlib stream", decompress: "deflate" };
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06) || has(0x50, 0x4b, 0x07, 0x08))
    return { name: "ZIP archive" };
  if (has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { name: "PNG image" };
  if (has(0xff, 0xd8, 0xff)) return { name: "JPEG image" };
  if (has(0x25, 0x50, 0x44, 0x46)) return { name: "PDF document" };
  if (has(0x47, 0x49, 0x46, 0x38)) return { name: "GIF image" };
  if (
    has(0x52, 0x49, 0x46, 0x46) &&
    b.length >= 12 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return { name: "WebP image" };
  if (has(0x7f, 0x45, 0x4c, 0x46)) return { name: "ELF binary" };
  if (has(0xca, 0xfe, 0xba, 0xbe)) return { name: "Java class file" };
  if (has(0x00, 0x61, 0x73, 0x6d)) return { name: "WebAssembly module" };
  if (has(0x49, 0x44, 0x33)) return { name: "MP3 audio with ID3 tag" };
  if (has(0x4f, 0x67, 0x67, 0x53)) return { name: "Ogg container" };
  if (has(0x42, 0x4d)) return { name: "BMP image" };
  return null;
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Never throws: returns null when the stream rejects the bytes. */
async function inflate(bytes: Uint8Array, algo: "gzip" | "deflate"): Promise<Uint8Array | null> {
  try {
    const stream = new DecompressionStream(algo);
    const writer = stream.writable.getWriter();
    const [out] = await Promise.all([
      collect(stream.readable),
      writer.write(bytes as BufferSource).then(() => writer.close()),
    ]);
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* time helpers                                                        */
/* ------------------------------------------------------------------ */

const SANE_SECONDS_MIN = 1_000_000_000; // 2001-09-09
const SANE_SECONDS_MAX = 2_000_000_000; // 2033-05-18
const SANE_MS_MIN = SANE_SECONDS_MIN * 1000;
const SANE_MS_MAX = SANE_SECONDS_MAX * 1000;

function iso(ms: number): string {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? "out of range" : d.toISOString();
}

function relative(ms: number): string {
  const deltaSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === "second") return rtf.format(Math.trunc(deltaSec / secs), unit);
  }
  return "now";
}

function stamp(ms: number): string {
  return `${iso(ms)} (${relative(ms)})`;
}

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */

interface Step {
  title: string;
  /** Short label used to build the "Chain:" summary line. */
  chain?: string;
  notes: string[];
  body?: string;
  /** Render body even when showIntermediates is off (structured payloads). */
  always?: boolean;
  children: Step[];
}

interface Hit {
  title: string;
  chain?: string;
  notes?: string[];
  body?: string;
  always?: boolean;
  produced?: Value;
  children?: Step[];
}

interface Ctx {
  depth: number;
  seen: Set<string>;
  maxDepth: number;
  /** Detectors that decline but have something worth mentioning push here. */
  asides: string[];
  /**
   * Set while walking JSON string leaves whose key gives no hint of time or
   * identity. Any long digit string can be read as a timestamp, so inside a
   * document that reading needs support from the field name.
   */
  skipNumeric?: boolean;
}

type Detector = (v: Value, ctx: Ctx) => Promise<Hit | null> | Hit | null;

const MAX_JSON_LEAVES = 25;

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

function parseJson(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function describeJson(parsed: unknown): string {
  if (Array.isArray(parsed)) return `JSON (array, ${parsed.length} items)`;
  const keys = Object.keys(parsed as Record<string, unknown>);
  return `JSON (object, ${keys.length} ${keys.length === 1 ? "key" : "keys"})`;
}

type Leaf =
  { path: string; kind: "string"; value: string } | { path: string; kind: "number"; value: number };

function collectLeaves(node: unknown, path: string, out: Leaf[]): void {
  if (out.length >= MAX_JSON_LEAVES * 4) return;
  if (typeof node === "string") {
    out.push({ path, kind: "string", value: node });
    return;
  }
  if (typeof node === "number") {
    out.push({ path, kind: "number", value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectLeaves(child, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      const safe = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
      collectLeaves(v, `${path}${safe}`, out);
    }
  }
}

const KEY_HINT_SNAKE =
  /(^|[_\-.])(id|ts|time|timestamp|date|created|updated|expires|expiry|exp|iat|nbf|at|epoch|since|until|seen|stamp)$/i;
const KEY_HINT_CAMEL = /[a-z](Id|Ts|Time|Timestamp|Date|At|Epoch|Stamp)$/;

/** Does the last path segment suggest the value is a time or an identifier? */
function keyHintsAtTimeOrId(path: string): boolean {
  const m = /\.([A-Za-z_$][\w$]*)$/.exec(path) ?? /\["([^"]*)"\]$/.exec(path);
  const key = m?.[1];
  if (!key) return false;
  return KEY_HINT_SNAKE.test(key) || KEY_HINT_CAMEL.test(key);
}

/** Recurse into the string and number leaves of a parsed JSON document. */
async function jsonLeafSteps(parsed: unknown, ctx: Ctx, includeNumbers = true): Promise<Step[]> {
  const leaves: Leaf[] = [];
  collectLeaves(parsed, "$", leaves);

  const steps: Step[] = [];
  for (const leaf of leaves) {
    if (steps.length >= MAX_JSON_LEAVES) break;

    if (leaf.kind === "number") {
      if (!includeNumbers) continue;
      const n = leaf.value;
      if (!Number.isInteger(n)) continue;
      if (n >= SANE_MS_MIN && n <= SANE_MS_MAX) {
        steps.push({
          title: `${leaf.path} = ${n}`,
          notes: [`Looks like a unix timestamp in milliseconds: ${stamp(n)}.`],
          children: [],
        });
      } else if (n >= SANE_SECONDS_MIN && n <= SANE_SECONDS_MAX) {
        steps.push({
          title: `${leaf.path} = ${n}`,
          notes: [`Looks like a unix timestamp in seconds: ${stamp(n * 1000)}.`],
          children: [],
        });
      }
      continue;
    }

    if (leaf.value.trim().length < 8) continue;
    const branch: Ctx = {
      depth: ctx.depth - 1,
      seen: new Set(ctx.seen),
      maxDepth: ctx.maxDepth,
      asides: [],
      skipNumeric: !keyHintsAtTimeOrId(leaf.path),
    };
    const sub = await expand(textValue(leaf.value), branch);
    // Only surface a leaf that genuinely decoded. Attaching every "also
    // possible" aside from every string in a document buries the real answer.
    if (sub.children.length === 0) continue;
    steps.push({
      title: `${leaf.path} decodes further`,
      notes: sub.notes,
      children: sub.children,
    });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* detectors                                                           */
/* ------------------------------------------------------------------ */

const jwtDetector: Detector = async (v, ctx) => {
  if (v.kind !== "text") return null;
  const s = v.text.trim();
  const parts = s.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  if (!h || !p) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(h) || !/^[A-Za-z0-9_-]+$/.test(p)) return null;
  if (sig && !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  const headerBytes = base64ToBytes(h);
  const payloadBytes = base64ToBytes(p);
  if (!headerBytes || !payloadBytes) return null;
  const headerText = utf8(headerBytes);
  const payloadText = utf8(payloadBytes);
  if (headerText === null || payloadText === null) return null;

  const header = parseJson(headerText);
  const payload = parseJson(payloadText);
  if (header === undefined || Array.isArray(header)) return null;
  const alg = (header as Record<string, unknown>)["alg"];
  if (typeof alg !== "string") return null;

  const notes = ["The signature is never checked here, so treat the contents as unverified."];
  if (alg.toLowerCase() === "none")
    notes.push(
      'The header declares alg "none", which means the token is unsigned. Do not trust it.',
    );
  if (!sig) notes.push("The signature segment is empty.");

  const headerStep: Step = {
    title: "header",
    always: true,
    notes: [],
    body: JSON.stringify(header, null, 2),
    children: [],
  };

  const claimNotes: string[] = [];
  const now = Date.now();
  if (payload !== undefined && !Array.isArray(payload)) {
    const claims = payload as Record<string, unknown>;
    const times: [string, string][] = [
      ["iat", "issued at"],
      ["nbf", "not valid before"],
      ["exp", "expires"],
      ["auth_time", "authenticated at"],
    ];
    for (const [key, label] of times) {
      const raw = claims[key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const ms = raw > 1e11 ? raw : raw * 1000;
      let suffix = "";
      if (key === "exp") suffix = ms < now ? " (expired)" : " (still valid)";
      if (key === "nbf") suffix = ms > now ? " (not valid yet)" : "";
      claimNotes.push(`${key} (${label}): ${raw} = ${iso(ms)}${suffix}`);
    }
  }

  const payloadStep: Step = {
    title: "payload",
    always: true,
    notes: claimNotes,
    body: payload === undefined ? payloadText : JSON.stringify(payload, null, 2),
    children: payload === undefined ? [] : await jsonLeafSteps(payload, ctx, false),
  };

  const sigBytes = sig ? base64ToBytes(sig) : new Uint8Array(0);
  const sigStep: Step = {
    title: "signature",
    notes: ["Not verified."],
    body: sigBytes ? `${sigBytes.length} bytes: ${hexHead(sigBytes, 12)}` : sig,
    always: true,
    children: [],
  };

  return {
    title: `JWT (alg ${alg}, 3 segments)`,
    chain: "JWT",
    notes,
    children: [headerStep, payloadStep, sigStep],
  };
};

const dataUrlDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const s = v.text.trim();
  const m = /^data:([^,]*),([\s\S]*)$/.exec(s);
  if (!m) return null;
  const meta = m[1] as string;
  const payload = m[2] as string;
  const isBase64 = /;base64$/i.test(meta);
  const mediaType = meta.replace(/;base64$/i, "") || "text/plain;charset=US-ASCII";

  const decodePayload = (): Uint8Array | null => {
    if (isBase64) return base64ToBytes(payload.replace(/\s+/g, ""));
    try {
      return new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
      return null;
    }
  };
  const bytes = decodePayload();
  if (!bytes) return null;

  const text = asReadableText(bytes);
  return {
    title: `data URL (${mediaType}, ${isBase64 ? "base64" : "percent-encoded"}, ${bytes.length} bytes)`,
    chain: "data URL",
    produced: text !== null ? textValue(text) : bytesValue(bytes),
  };
};

const jsonDetector: Detector = async (v, ctx) => {
  if (v.kind !== "text") return null;
  const parsed = parseJson(v.text);
  if (parsed === undefined) return null;
  return {
    title: describeJson(parsed),
    chain: "JSON",
    always: true,
    body: JSON.stringify(parsed, null, 2),
    children: await jsonLeafSteps(parsed, ctx),
  };
};

const urlEncodedDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const s = v.text.trim();
  const matches = s.match(/%[0-9a-fA-F]{2}/g);
  if (!matches || matches.length === 0) return null;
  // Require the escapes to carry real weight, not be one stray % in prose.
  if ((matches.length * 3) / s.length < 0.05 && matches.length < 2) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return null;
  }
  if (decoded === s) return null;
  if (printableRatio(decoded) < 0.9) return null;
  const notes: string[] = [];
  if (s.includes("+"))
    notes.push(
      'The input contains "+" characters, which form encoding treats as spaces. They were left as is.',
    );
  return {
    title: `URL-encoded (${matches.length} escapes)`,
    chain: "URL-encoded",
    notes,
    produced: textValue(decoded),
  };
};

const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

const uuidDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const s = v.text
    .trim()
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{|\}$/g, "");
  const m = UUID_RE.exec(s);
  if (!m) return null;
  const [, timeLow, timeMid, timeHi, clockSeq, node] = m as unknown as string[];
  const hex = (timeLow + timeMid + timeHi + clockSeq + node).toLowerCase();

  if (hex === "0".repeat(32)) {
    return { title: "UUID (nil UUID, all zero bits)", chain: "UUID", children: [] };
  }
  if (hex === "f".repeat(32)) {
    return { title: "UUID (max UUID, all one bits)", chain: "UUID", children: [] };
  }

  const version = parseInt((timeHi as string)[0] as string, 16);
  const variantNibble = parseInt((clockSeq as string)[0] as string, 16);
  let variant = "reserved";
  if (variantNibble >> 3 === 0) variant = "NCS (legacy Apollo)";
  else if (variantNibble >> 2 === 0b10) variant = "RFC 4122 / RFC 9562";
  else if (variantNibble >> 1 === 0b110) variant = "Microsoft GUID";

  const lines = [`Variant: ${variant}`];
  if (version === 1) {
    const ticks =
      (BigInt(parseInt(timeHi as string, 16) & 0x0fff) << 48n) |
      (BigInt(parseInt(timeMid as string, 16)) << 32n) |
      BigInt(parseInt(timeLow as string, 16));
    const ms = Number(ticks / 10000n) - 12219292800000;
    lines.push(`Version 1 timestamp: ${stamp(ms)}`);
    lines.push(`Node (MAC or random): ${(node as string).match(/../g)?.join(":")}`);
  } else if (version === 6) {
    const ticks =
      (BigInt(parseInt(timeLow as string, 16)) << 28n) |
      (BigInt(parseInt(timeMid as string, 16)) << 12n) |
      BigInt(parseInt(timeHi as string, 16) & 0x0fff);
    const ms = Number(ticks / 10000n) - 12219292800000;
    lines.push(`Version 6 timestamp: ${stamp(ms)}`);
  } else if (version === 7) {
    const ms = parseInt(hex.slice(0, 12), 16);
    lines.push(`Version 7 timestamp: ${stamp(ms)}`);
  } else if (version === 4) {
    lines.push("Version 4 is random, so it carries no timestamp or machine identity.");
  } else if (version === 3 || version === 5) {
    lines.push(
      `Version ${version} is a ${version === 3 ? "MD5" : "SHA-1"} hash of a namespace and a name, which cannot be reversed.`,
    );
  }

  return {
    title: `UUID version ${Number.isNaN(version) ? "?" : version}`,
    chain: "UUID",
    body: lines.join("\n"),
    always: true,
    children: [],
  };
};

const MAC_RE =
  /^([0-9a-f]{2})([:-])([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})$/i;
const MAC_DOT_RE = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/i;

function macBody(hex: string): string {
  const pairs = hex.match(/../g) as string[];
  const first = parseInt(pairs[0] as string, 16);
  const lines = [
    `Normalized: ${pairs.join(":")}`,
    `OUI (vendor prefix): ${pairs.slice(0, 3).join(":")}`,
    `Device part: ${pairs.slice(3).join(":")}`,
    first & 0b1 ? "Multicast address" : "Unicast address",
    first & 0b10
      ? "Locally administered, so the OUI is not a registered vendor"
      : "Globally unique, so the OUI belongs to a registered vendor",
  ];
  if (hex === "ffffffffffff") lines.push("This is the broadcast address.");
  return lines.join("\n");
}

const macDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const s = v.text.trim();
  const m = MAC_RE.exec(s);
  if (m) {
    const hex = [m[1], m[3], m[4], m[5], m[6], m[7]].join("").toLowerCase();
    return {
      title: "MAC address (EUI-48)",
      chain: "MAC address",
      body: macBody(hex),
      always: true,
      children: [],
    };
  }
  const d = MAC_DOT_RE.exec(s);
  if (d) {
    const hex = [d[1], d[2], d[3]].join("").toLowerCase();
    return {
      title: "MAC address (EUI-48, Cisco dotted form)",
      chain: "MAC address",
      body: macBody(hex),
      always: true,
      children: [],
    };
  }
  return null;
};

const DISCORD_EPOCH = 1420070400000;
const TWITTER_EPOCH = 1288834974657;

function ipv4FromInt(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

const numericDetector: Detector = (v, ctx) => {
  if (v.kind !== "text") return null;
  if (ctx.skipNumeric) return null;
  const s = v.text.trim();
  if (!/^\d+$/.test(s)) return null;
  const digits = s.length;

  const alsoPossible: string[] = [];
  const ipCandidate =
    digits <= 10 && Number(s) >= 16777216 && Number(s) <= 4294967295
      ? ipv4FromInt(Number(s))
      : null;

  // Unix milliseconds.
  if (digits === 13) {
    const ms = Number(s);
    if (ms >= SANE_MS_MIN && ms <= SANE_MS_MAX) {
      return {
        title: "Unix timestamp (milliseconds)",
        chain: "unix timestamp",
        body: `${stamp(ms)}\nAs seconds it would be ${iso(ms * 1000)}, which is far outside any plausible range.`,
        always: true,
        children: [],
      };
    }
  }

  // Unix seconds.
  if (digits === 10) {
    const sec = Number(s);
    if (sec >= SANE_SECONDS_MIN && sec <= SANE_SECONDS_MAX) {
      if (ipCandidate)
        alsoPossible.push(`Also possible: an IPv4 address stored as an integer, ${ipCandidate}.`);
      return {
        title: "Unix timestamp (seconds)",
        chain: "unix timestamp",
        body: stamp(sec * 1000),
        always: true,
        notes: alsoPossible,
        children: [],
      };
    }
  }

  // Snowflake IDs.
  if (digits >= 17 && digits <= 20) {
    const id = BigInt(s);
    const shifted = Number(id >> 22n);
    const discordMs = shifted + DISCORD_EPOCH;
    const twitterMs = shifted + TWITTER_EPOCH;
    const worker = Number((id >> 17n) & 0x1fn);
    const process = Number((id >> 12n) & 0x1fn);
    const increment = Number(id & 0xfffn);
    const instagramMs = Number(id >> 23n);

    const lines = [
      `Assuming the Discord epoch: ${stamp(discordMs)}`,
      `Assuming the Twitter/X epoch: ${stamp(twitterMs)}`,
      `Internal fields (Discord layout): worker ${worker}, process ${process}, increment ${increment}`,
    ];
    if (instagramMs >= SANE_MS_MIN && instagramMs <= SANE_MS_MAX)
      lines.push(`Assuming the Instagram layout: ${stamp(instagramMs)}`);

    return {
      title: `Snowflake ID (${digits} digits)`,
      chain: "snowflake ID",
      body: lines.join("\n"),
      always: true,
      notes: [
        "Snowflake IDs carry no marker for which service issued them, so each reading below is an assumption.",
      ],
      children: [],
    };
  }

  if (ipCandidate) {
    return {
      title: "IPv4 address stored as an integer",
      chain: "IPv4 integer",
      body: `${ipCandidate}\nHex: 0x${Number(s).toString(16).padStart(8, "0")}`,
      always: true,
      children: [],
    };
  }

  return null;
};

const quotedPrintableDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const s = v.text;
  const escapes = s.match(/=[0-9A-F]{2}/g);
  const softBreaks = /=\r?\n/.test(s);
  if (!escapes && !softBreaks) return null;
  // Query strings look like "a=42&b=43"; real quoted-printable has a soft line
  // break or an escape whose hex digits include a letter (=C3, =3D, =20 ...).
  const strong =
    softBreaks ||
    (escapes ?? []).some((e) => /[A-F]/.test(e.slice(1)) || e === "=3D" || e === "=20");
  if (!strong) return null;

  const unfolded = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i] as string;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
    }
  }
  const decoded = utf8(new Uint8Array(bytes));
  if (decoded === null || decoded === s) return null;
  if (printableRatio(decoded) < 0.9) return null;

  return {
    title: `Quoted-printable (${escapes?.length ?? 0} escapes${softBreaks ? ", soft line breaks" : ""})`,
    chain: "quoted-printable",
    produced: textValue(decoded),
  };
};

/** Shared tail for base64 and hex: turn bytes into the next value, or decline. */
function bytesToValue(bytes: Uint8Array): { value: Value; detail: string } | null {
  const text = asReadableText(bytes);
  if (text !== null)
    return { value: textValue(text), detail: `${bytes.length} bytes of UTF-8 text` };
  const format = identify(bytes);
  if (format) return { value: bytesValue(bytes), detail: `${bytes.length} bytes, ${format.name}` };
  return null;
}

const hexDetector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const raw = v.text.trim().replace(/^0x/i, "");
  const compact = raw.replace(/[\s:-]/g, "");
  if (compact.length < 8 || compact.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(compact)) return null;

  const bytes = hexToBytes(compact.toLowerCase());
  const next = bytesToValue(bytes);
  if (!next) {
    return null;
  }
  return {
    title: `Hex bytes (${compact.length} hex digits -> ${next.detail})`,
    chain: "hex",
    produced: next.value,
  };
};

/** Aside for hex-shaped input that decodes to nothing recognisable. */
function hexAside(v: Value, ctx: Ctx): void {
  if (v.kind !== "text") return;
  const compact = v.text
    .trim()
    .replace(/^0x/i, "")
    .replace(/[\s:-]/g, "");
  if (compact.length < 8 || compact.length % 2 !== 0) return;
  if (!/^[0-9a-fA-F]+$/.test(compact)) return;
  const bytes = hexToBytes(compact.toLowerCase());
  ctx.asides.push(
    `Also possible: ${bytes.length} raw bytes written in hex (${hexHead(bytes, 8)}), but they match no known file format or text encoding.`,
  );
  if (compact.length === 12)
    ctx.asides.push(
      `Also possible: a MAC address written without separators, ${(compact.toLowerCase().match(/../g) as string[]).join(":")}.`,
    );
}

const BASE64_SHAPE = /^([A-Za-z0-9+/]+|[A-Za-z0-9_-]+)(={0,2})$/;

function base64Candidate(text: string): { core: string; urlSafe: boolean; padded: boolean } | null {
  let s = text.trim();
  if (/\n/.test(s) && !/[^\sA-Za-z0-9+/=_-]/.test(s)) s = s.replace(/\s+/g, "");
  if (s.length < 8) return null;
  const m = BASE64_SHAPE.exec(s);
  if (!m) return null;
  const core = m[1] as string;
  const pad = m[2] as string;
  if (pad.length > 0) {
    if ((core.length + pad.length) % 4 !== 0) return null;
  } else if (core.length % 4 === 1) {
    return null;
  }
  const urlSafe = /[-_]/.test(core);
  return { core: core + pad, urlSafe, padded: pad.length > 0 };
}

const base64Detector: Detector = (v) => {
  if (v.kind !== "text") return null;
  const cand = base64Candidate(v.text);
  if (!cand) return null;
  const bytes = base64ToBytes(cand.core);
  if (!bytes || bytes.length < 3) return null;

  const next = bytesToValue(bytes);
  if (!next) return null;
  if (next.value.kind === "text" && next.value.text === v.text.trim()) return null;

  // Short unpadded tokens are usually ordinary words that happen to sit in the
  // base64 alphabet, so demand a structural signal before claiming a decode.
  if (next.value.kind === "text") {
    const decoded = next.value.text;
    const strong =
      cand.padded ||
      cand.core.length >= 16 ||
      parseJson(decoded) !== undefined ||
      /[\s:/{="]/.test(decoded);
    if (!strong) return null;
  }

  const label = cand.urlSafe ? "base64url" : "base64";
  return {
    title: `${label} (${cand.core.length} chars -> ${next.detail})`,
    chain: label,
    produced: next.value,
  };
};

const binaryDetector: Detector = async (v) => {
  if (v.kind !== "bytes") return null;
  const format = v.format;
  if (!format?.decompress) return null;
  const out = await inflate(v.bytes, format.decompress);
  if (!out) {
    return {
      title: `${format.name} (${v.bytes.length} bytes)`,
      notes: [
        "The header matches this format but the data would not decompress, so it may be truncated or mislabeled.",
      ],
      children: [],
    };
  }
  const next = bytesToValue(out);
  const chain = format.decompress === "gzip" ? "gzip" : "zlib";
  return {
    title: `${chain} (${v.bytes.length} bytes -> ${out.length} bytes)`,
    chain,
    produced: next ? next.value : bytesValue(out),
  };
};

const DETECTORS: Detector[] = [
  jwtDetector,
  dataUrlDetector,
  jsonDetector,
  urlEncodedDetector,
  uuidDetector,
  macDetector,
  numericDetector,
  quotedPrintableDetector,
  hexDetector,
  base64Detector,
  binaryDetector,
];

/* ------------------------------------------------------------------ */
/* the recursive engine                                                */
/* ------------------------------------------------------------------ */

function display(v: Value): string {
  if (v.kind === "text") return v.text;
  const name = v.format ? v.format.name : "unknown format";
  return `binary: ${name} (${v.bytes.length} bytes)\nhex: ${hexHead(v.bytes)}`;
}

async function expand(value: Value, ctx: Ctx): Promise<{ children: Step[]; notes: string[] }> {
  const asides: string[] = [];
  const local: Ctx = { ...ctx, asides };

  for (const detect of DETECTORS) {
    const hit = await detect(value, local);
    if (!hit) continue;

    if (ctx.depth <= 0) {
      return {
        children: [
          {
            title: `Depth limit reached (maxDepth is ${ctx.maxDepth}).`,
            notes: ["There is more to unwrap here. Raise the maxDepth option to keep going."],
            children: [],
          },
        ],
        notes: asides,
      };
    }

    const step: Step = {
      title: hit.title,
      chain: hit.chain,
      notes: [...(hit.notes ?? [])],
      body: hit.body,
      always: hit.always,
      children: [...(hit.children ?? [])],
    };

    if (hit.produced) {
      const key = keyOf(hit.produced);
      if (local.seen.has(key)) {
        step.notes.push(
          "Decoding this again produces a value already seen, so this branch stops here.",
        );
        step.body ??= display(hit.produced);
      } else {
        const nextSeen = new Set(local.seen);
        nextSeen.add(key);
        step.body ??= display(hit.produced);
        const sub = await expand(hit.produced, {
          depth: ctx.depth - 1,
          seen: nextSeen,
          maxDepth: ctx.maxDepth,
          asides: [],
        });
        step.children.push(...sub.children);
        step.notes.push(...sub.notes);
      }
    }

    return { children: [step], notes: asides };
  }

  hexAside(value, local);
  return { children: [], notes: asides };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const FINAL_BODY_MAX = 4000;
const INTERMEDIATE_BODY_MAX = 240;

function bodyLines(body: string, isFinal: boolean): string[] {
  const limit = isFinal ? FINAL_BODY_MAX : INTERMEDIATE_BODY_MAX;
  let text = body;
  if (text.length > limit)
    text = `${text.slice(0, limit)}\n... (${body.length - limit} more characters)`;
  return text.split("\n");
}

function pad(n: number): string {
  return " ".repeat(n);
}

function render(steps: Step[], indent: number, showIntermediates: boolean, out: string[]): void {
  for (const step of steps) {
    out.push(pad(indent) + step.title);
    for (const note of step.notes) out.push(pad(indent + 2) + note);
    const isFinal = step.children.length === 0;
    if (step.body !== undefined && (isFinal || step.always || showIntermediates)) {
      for (const line of bodyLines(step.body, isFinal || step.always === true))
        out.push(pad(indent + 2) + line);
    }
    render(step.children, indent + 2, showIntermediates, out);
  }
}

function chainOf(steps: Step[]): string[] {
  const labels: string[] = [];
  let current = steps[0];
  while (current && current.chain) {
    labels.push(current.chain);
    current = current.children[0];
  }
  return labels;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export async function run(input: string, opts: DecodeOpts = {}): Promise<string> {
  const raw = typeof input === "string" ? input : "";
  if (raw.trim() === "")
    throw new ToolError(
      "empty-input",
      "Enter something to decode.",
      "Paste a token, a base64 blob, a JWT, a hex dump, an ID, or a timestamp.",
    );

  const rawDepth = Number(opts.maxDepth);
  const maxDepth = Number.isFinite(rawDepth) ? Math.min(20, Math.max(1, Math.trunc(rawDepth))) : 10;
  const showIntermediates = opts.showIntermediates !== false;

  const start = textValue(raw.trim());
  const { children, notes } = await expand(start, {
    depth: maxDepth,
    seen: new Set([keyOf(start)]),
    maxDepth,
    asides: [],
  });

  const chain = chainOf(children);
  const lines: string[] = [];
  lines.push(`Chain: ${chain.length ? chain.join(" -> ") : "none detected"}`);
  lines.push("");
  lines.push(`Input (${raw.trim().length} characters)`);
  if (children.length === 0 || showIntermediates) {
    for (const line of bodyLines(raw.trim(), children.length === 0)) lines.push(pad(2) + line);
  }
  for (const note of notes) lines.push(pad(2) + note);
  render(children, 2, showIntermediates, lines);
  lines.push("");
  lines.push("Nothing more to decode.");

  return lines.join("\n");
}

export default { run } satisfies ToolLogic<string, string, DecodeOpts>;
