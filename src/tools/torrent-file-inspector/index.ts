import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Torrent file inspector.
 *
 * A .torrent file is a single bencoded dictionary (BEP 3). Everything below is
 * hand rolled: the bencode reader, the file tree walk, the magnet builder. The
 * only dependencies are SHA-1 and, for BitTorrent v2, SHA-256.
 *
 * The info hash is the SHA-1 of the *bencoded* info dictionary, so it must be
 * computed over the file's own bytes rather than over a re-encoding: an
 * encoder that sorted keys differently, or normalized an integer, would
 * produce a hash that matches no swarm. This reader therefore records the byte
 * span of every value it decodes and hashes the original slice verbatim, which
 * is exact for any input, canonical or not. There is no re-encoder here.
 */

/* ------------------------------------------------------------------ */
/* bencode                                                             */
/* ------------------------------------------------------------------ */

/**
 * A decoded bencode value. Every node carries the half-open byte span
 * [start, end) it occupied in the source, which is what makes the verbatim
 * info-dict slice possible.
 */
export type Bencode =
  | { kind: "int"; value: number; start: number; end: number }
  | { kind: "bytes"; value: Uint8Array; start: number; end: number }
  | { kind: "list"; value: Bencode[]; start: number; end: number }
  | { kind: "dict"; value: Map<string, Bencode>; start: number; end: number };

/** Nesting past this is a malformed or hostile file, not a real torrent. */
const MAX_DEPTH = 64;

/** Refuse anything past this: the whole file is decoded in memory. */
const MAX_BYTES = 64 * 1024 * 1024;

/** File rows listed before the output switches to "and N more". */
const FILE_CAP = 200;

/** Trackers written into the magnet link. Beyond this the URI is unusable. */
const MAGNET_TRACKER_CAP = 20;

/** Entries the v2 file tree walk will collect before it stops descending. */
const FILE_TREE_CAP = 100_000;

const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_COLON = 0x3a;
const CH_MINUS = 0x2d;
const CH_d = 0x64;
const CH_e = 0x65;
const CH_i = 0x69;
const CH_l = 0x6c;

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Replace the C0 control characters and DEL in a decoded byte string.
 *
 * Torrent strings are attacker controlled bytes, so a name or a path can carry
 * a newline, a NUL, or an ANSI escape that would corrupt the rendered output.
 * This is a character loop rather than a regex because the equivalent class
 * holds control characters, which eslint's no-control-regex bans for good
 * reason: written literally they are invisible in review, and written as
 * escapes they still trip the rule.
 */
function stripControls(text: string, replacement: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? replacement : ch;
  }
  return out;
}

function truncatedError(): ToolError {
  return new ToolError(
    "truncated-torrent",
    "The file ends in the middle of a bencoded value.",
    "The .torrent is incomplete. Re-download it and make sure the whole file was saved rather than a partial transfer.",
  );
}

function notBencodeError(offset: number): ToolError {
  return new ToolError(
    "not-bencode",
    `Byte ${offset} is not the start of a bencoded value.`,
    "Choose a .torrent file. A torrent is a single bencoded dictionary, so the file must start with the letter d.",
  );
}

function emptyInputError(): ToolError {
  return new ToolError(
    "empty-input",
    "No torrent data to read.",
    "Drop a .torrent file onto the panel or use the file picker. You can also load the sample torrent.",
  );
}

/** Read one bencoded value at `cursor.pos`, advancing the cursor past it. */
function parseValue(bytes: Uint8Array, cursor: { pos: number }, depth: number): Bencode {
  if (depth > MAX_DEPTH) {
    throw new ToolError(
      "too-deeply-nested",
      `This file nests bencoded values more than ${MAX_DEPTH} levels deep.`,
      "Real torrents nest three or four levels. A file this deep is corrupt or deliberately malformed.",
    );
  }
  if (cursor.pos >= bytes.length) throw truncatedError();

  const start = cursor.pos;
  const ch = bytes[start];
  if (ch === CH_i) return parseInteger(bytes, cursor, start);
  if (ch === CH_l) return parseList(bytes, cursor, start, depth);
  if (ch === CH_d) return parseDict(bytes, cursor, start, depth);
  if (ch >= CH_0 && ch <= CH_9) return parseByteString(bytes, cursor, start);
  throw notBencodeError(start);
}

/** `i<digits>e`. Leading zeros and negative zero are invalid bencode. */
function parseInteger(
  bytes: Uint8Array,
  cursor: { pos: number },
  start: number,
): Extract<Bencode, { kind: "int" }> {
  let i = start + 1;
  const negative = bytes[i] === CH_MINUS;
  if (negative) i += 1;

  const digitsStart = i;
  while (i < bytes.length && bytes[i] >= CH_0 && bytes[i] <= CH_9) i += 1;
  if (i >= bytes.length) throw truncatedError();
  if (bytes[i] !== CH_e || i === digitsStart) throw notBencodeError(start);

  const digits = decoder.decode(bytes.subarray(digitsStart, i));
  if (digits.length > 1 && digits.startsWith("0")) throw notBencodeError(start);
  if (negative && digits === "0") throw notBencodeError(start);

  cursor.pos = i + 1;
  return {
    kind: "int",
    value: negative ? -Number(digits) : Number(digits),
    start,
    end: cursor.pos,
  };
}

/**
 * `<length>:<bytes>`. The raw bytes are kept rather than decoded: torrent
 * strings are byte strings, not text, and `pieces` is a run of binary digests.
 */
function parseByteString(
  bytes: Uint8Array,
  cursor: { pos: number },
  start: number,
): Extract<Bencode, { kind: "bytes" }> {
  let i = start;
  while (i < bytes.length && bytes[i] >= CH_0 && bytes[i] <= CH_9) i += 1;
  if (i >= bytes.length) throw truncatedError();
  if (bytes[i] !== CH_COLON) throw notBencodeError(start);

  const length = Number(decoder.decode(bytes.subarray(start, i)));
  const from = i + 1;
  const to = from + length;
  if (!Number.isSafeInteger(length) || to > bytes.length) throw truncatedError();

  cursor.pos = to;
  return { kind: "bytes", value: bytes.subarray(from, to), start, end: to };
}

function parseList(
  bytes: Uint8Array,
  cursor: { pos: number },
  start: number,
  depth: number,
): Extract<Bencode, { kind: "list" }> {
  const items: Bencode[] = [];
  cursor.pos = start + 1;
  for (;;) {
    if (cursor.pos >= bytes.length) throw truncatedError();
    if (bytes[cursor.pos] === CH_e) {
      cursor.pos += 1;
      return { kind: "list", value: items, start, end: cursor.pos };
    }
    items.push(parseValue(bytes, cursor, depth + 1));
  }
}

/**
 * `d<key><value>...e`. Keys are byte strings, decoded as UTF-8 for lookup,
 * which is what every real torrent uses. A duplicate key keeps its first
 * occurrence rather than the last.
 */
function parseDict(
  bytes: Uint8Array,
  cursor: { pos: number },
  start: number,
  depth: number,
): Extract<Bencode, { kind: "dict" }> {
  const entries = new Map<string, Bencode>();
  cursor.pos = start + 1;
  for (;;) {
    if (cursor.pos >= bytes.length) throw truncatedError();
    if (bytes[cursor.pos] === CH_e) {
      cursor.pos += 1;
      return { kind: "dict", value: entries, start, end: cursor.pos };
    }
    const keyStart = cursor.pos;
    const key = parseValue(bytes, cursor, depth + 1);
    if (key.kind !== "bytes") throw notBencodeError(keyStart);
    const value = parseValue(bytes, cursor, depth + 1);
    const name = decoder.decode(key.value);
    if (!entries.has(name)) entries.set(name, value);
  }
}

/**
 * Decode one bencoded value from the start of `bytes`.
 *
 * Trailing bytes after the top level value are ignored rather than rejected:
 * some tools pad a .torrent, and refusing an otherwise perfect file over
 * trailing whitespace would help nobody.
 */
export function decodeBencode(bytes: Uint8Array): Bencode {
  if (bytes.length === 0) throw emptyInputError();
  return parseValue(bytes, { pos: 0 }, 0);
}

/* ------------------------------------------------------------------ */
/* typed accessors                                                     */
/* ------------------------------------------------------------------ */

function dictGet(node: Bencode | undefined, key: string): Bencode | undefined {
  return node && node.kind === "dict" ? node.value.get(key) : undefined;
}

function asText(node: Bencode | undefined): string | undefined {
  if (!node || node.kind !== "bytes") return undefined;
  const text = stripControls(decoder.decode(node.value), " ").trim();
  return text === "" ? undefined : text;
}

function asNumber(node: Bencode | undefined): number | undefined {
  return node && node.kind === "int" ? node.value : undefined;
}

/* ------------------------------------------------------------------ */
/* hashes and encodings                                                */
/* ------------------------------------------------------------------ */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32. A 20 byte SHA-1 is exactly 160 bits, so it encodes to 32
 * characters with no padding, which is the older magnet link form still
 * accepted by every client.
 */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

/* ------------------------------------------------------------------ */
/* torrent model                                                       */
/* ------------------------------------------------------------------ */

export interface TorrentFileEntry {
  /** Display path, already stripped of traversal segments. */
  path: string;
  length: number;
}

export type TorrentVersion = "v1" | "v2" | "hybrid";

export interface TorrentInfo {
  name: string;
  version: TorrentVersion;
  /** Lowercase hex SHA-1 of the bencoded info dictionary. */
  infoHash: string;
  infoHashBase32: string;
  /** Lowercase hex SHA-256 of the info dictionary, for v2 and hybrid files. */
  infoHashV2?: string;
  totalSize: number;
  pieceLength?: number;
  /** Piece count from the flat `pieces` string. Absent on a v2 only torrent. */
  pieceCount?: number;
  /** True when `pieces` is not a whole number of 20 byte digests. */
  piecesRagged: boolean;
  files: TorrentFileEntry[];
  /** True when the torrent describes one file rather than a directory. */
  singleFile: boolean;
  trackers: string[];
  webSeeds: string[];
  dhtNodes: string[];
  createdUnix?: number;
  createdBy?: string;
  comment?: string;
  encoding?: string;
  private: boolean;
  source?: string;
}

/**
 * Make one path safe to show. Torrent paths are attacker controlled, and the
 * classic bug is a `../../` component that escapes the download directory when
 * a client writes the file out. Nothing here writes files, but a viewer that
 * renders `../../../etc/passwd` as a plain path is still lying about where the
 * entry would land, so traversal segments are dropped and the result is always
 * relative.
 */
export function sanitizePath(segments: string[]): string {
  const clean: string[] = [];
  for (const raw of segments) {
    const segment = stripControls(raw, "").replace(/\\/g, "/");
    for (const part of segment.split("/")) {
      if (part === "" || part === "." || part === "..") continue;
      clean.push(part);
    }
  }
  return clean.length > 0 ? clean.join("/") : "(unnamed)";
}

function readV1Files(info: Bencode, name: string): { files: TorrentFileEntry[]; single: boolean } {
  const length = asNumber(dictGet(info, "length"));
  if (length !== undefined) {
    return { files: [{ path: sanitizePath([name]), length }], single: true };
  }

  const list = dictGet(info, "files");
  if (!list || list.kind !== "list") return { files: [], single: false };

  const files: TorrentFileEntry[] = [];
  for (const entry of list.value) {
    const size = asNumber(dictGet(entry, "length")) ?? 0;
    // "path.utf-8" is the legacy escape hatch some clients write beside "path".
    const pathNode = dictGet(entry, "path.utf-8") ?? dictGet(entry, "path");
    const segments =
      pathNode && pathNode.kind === "list"
        ? pathNode.value.map((part) => (part.kind === "bytes" ? decoder.decode(part.value) : ""))
        : [];
    files.push({ path: sanitizePath(segments), length: size });
  }
  return { files, single: false };
}

/**
 * Walk a BitTorrent v2 `file tree` (BEP 52). It is a dict tree of path
 * components; a leaf is the node whose empty-string key holds that file's own
 * `length` and `pieces root`.
 */
function readFileTree(node: Bencode | undefined, prefix: string[], out: TorrentFileEntry[]): void {
  if (!node || node.kind !== "dict" || out.length >= FILE_TREE_CAP) return;

  const leaf = node.value.get("");
  if (leaf && leaf.kind === "dict") {
    out.push({ path: sanitizePath(prefix), length: asNumber(dictGet(leaf, "length")) ?? 0 });
    return;
  }
  for (const [key, child] of node.value) {
    if (key === "") continue;
    readFileTree(child, [...prefix, key], out);
  }
}

function readTrackers(root: Bencode): string[] {
  const seen = new Set<string>();
  const push = (url: string | undefined) => {
    if (url) seen.add(url);
  };

  push(asText(dictGet(root, "announce")));

  // announce-list is a list of tiers, each tier a list of URLs (BEP 12). A Set
  // keeps tier order while dropping the announce URL's usual repeat in tier 1.
  const tiers = dictGet(root, "announce-list");
  if (tiers && tiers.kind === "list") {
    for (const tier of tiers.value) {
      if (tier.kind === "list") for (const url of tier.value) push(asText(url));
      else push(asText(tier));
    }
  }
  return [...seen];
}

function readWebSeeds(root: Bencode): string[] {
  const node = dictGet(root, "url-list");
  if (!node) return [];
  if (node.kind === "bytes") {
    const one = asText(node);
    return one ? [one] : [];
  }
  if (node.kind !== "list") return [];
  return node.value.map((item) => asText(item)).filter((url): url is string => url !== undefined);
}

/** `nodes` is a list of [host, port] pairs for a trackerless (DHT) torrent. */
function readDhtNodes(root: Bencode): string[] {
  const node = dictGet(root, "nodes");
  if (!node || node.kind !== "list") return [];
  const out: string[] = [];
  for (const pair of node.value) {
    if (pair.kind !== "list") continue;
    const host = asText(pair.value[0]);
    const port = asNumber(pair.value[1]);
    if (host) out.push(port === undefined ? host : `${host}:${port}`);
  }
  return out;
}

/** Decode a .torrent into the model the views render. */
export function readTorrent(bytes: Uint8Array): TorrentInfo {
  if (bytes.length > MAX_BYTES) {
    throw new ToolError(
      "torrent-too-large",
      `This file is ${formatBytes(bytes.length)}, past the ${formatBytes(MAX_BYTES)} limit.`,
      "A .torrent holds metadata, not the data itself, so a real one is kilobytes to a few megabytes. Check that you picked the .torrent rather than the download it describes.",
    );
  }

  const root = decodeBencode(bytes);
  if (root.kind !== "dict") {
    throw new ToolError(
      "not-a-torrent",
      "This file decodes as bencode, but its top level value is not a dictionary.",
      "A .torrent file is always a single bencoded dictionary holding an info key. This is some other bencoded value.",
    );
  }

  const info = root.value.get("info");
  if (!info) {
    throw new ToolError(
      "no-info-dict",
      "This bencoded file has no info dictionary.",
      "Every .torrent carries an info key describing the files and pieces. This looks like a different bencoded file, such as a client resume file.",
    );
  }
  if (info.kind !== "dict") {
    throw new ToolError(
      "bad-info-dict",
      "The info key in this file is not a dictionary.",
      "The file is corrupt. Re-download the .torrent from its source.",
    );
  }

  // Hash the original bytes, never a re-encoding: a re-encoder that reordered
  // one key would produce an info hash that matches no swarm.
  const infoSlice = bytes.subarray(info.start, info.end);
  const digest = sha1(infoSlice);

  const metaVersion = asNumber(dictGet(info, "meta version"));
  const fileTree = dictGet(info, "file tree");
  const pieces = dictGet(info, "pieces");
  const hasV2 = metaVersion === 2 && fileTree !== undefined;
  const hasV1 = pieces !== undefined && pieces.kind === "bytes";
  const version: TorrentVersion = hasV2 ? (hasV1 ? "hybrid" : "v2") : "v1";

  const name = asText(dictGet(info, "name.utf-8")) ?? asText(dictGet(info, "name")) ?? "(unnamed)";

  let files: TorrentFileEntry[];
  let singleFile: boolean;
  if (version === "v2") {
    const collected: TorrentFileEntry[] = [];
    readFileTree(fileTree, [], collected);
    files = collected;
    singleFile = collected.length === 1;
  } else {
    const read = readV1Files(info, name);
    files = read.files;
    singleFile = read.single;
  }

  const piecesLength = pieces && pieces.kind === "bytes" ? pieces.value.length : undefined;

  return {
    name,
    version,
    infoHash: toHex(digest),
    infoHashBase32: toBase32(digest),
    infoHashV2: hasV2 ? toHex(sha256(infoSlice)) : undefined,
    totalSize: files.reduce((sum, file) => sum + file.length, 0),
    pieceLength: asNumber(dictGet(info, "piece length")),
    pieceCount: piecesLength === undefined ? undefined : Math.floor(piecesLength / 20),
    piecesRagged: piecesLength !== undefined && piecesLength % 20 !== 0,
    files,
    singleFile,
    trackers: readTrackers(root),
    webSeeds: readWebSeeds(root),
    dhtNodes: readDhtNodes(root),
    createdUnix: asNumber(dictGet(root, "creation date")),
    createdBy: asText(dictGet(root, "created by")),
    comment: asText(dictGet(root, "comment")),
    encoding: asText(dictGet(root, "encoding")),
    private: asNumber(dictGet(info, "private")) === 1,
    source: asText(dictGet(info, "source")),
  };
}

/* ------------------------------------------------------------------ */
/* magnet                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build the magnet URI. A hybrid torrent carries both topics, v1 first, which
 * is what BEP 52 recommends so a v1 only client can still join the swarm.
 */
export function buildMagnet(info: TorrentInfo): string {
  const params: string[] = [];
  if (info.version !== "v2") params.push(`xt=urn:btih:${info.infoHash}`);
  if (info.infoHashV2) params.push(`xt=urn:btmh:1220${info.infoHashV2}`);
  if (info.name !== "(unnamed)") params.push(`dn=${encodeURIComponent(info.name)}`);
  if (info.totalSize > 0) params.push(`xl=${info.totalSize}`);
  for (const tracker of info.trackers.slice(0, MAGNET_TRACKER_CAP)) {
    params.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return `magnet:?${params.join("&")}`;
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

function looksBencoded(bytes: Uint8Array | null): bytes is Uint8Array {
  return bytes !== null && bytes.length > 0 && bytes[0] === CH_d;
}

function hexToBytes(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  if (text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * A .torrent is binary, so the normal path is a dropped file. A pasted string
 * is still accepted three ways: base64, a hex dump, or literal bencode text
 * such as `d3:cow3:mooe`, which is how a hand written example gets read.
 */
export function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInputError();
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === "") throw emptyInputError();

  const compact = trimmed.replace(/\s+/g, "");
  for (const bytes of [hexToBytes(compact), base64ToBytes(compact)]) {
    if (looksBencoded(bytes)) return bytes;
  }

  const literal = new TextEncoder().encode(trimmed);
  if (looksBencoded(literal)) return literal;

  throw new ToolError(
    "unreadable-input",
    "This text is not a torrent.",
    "Drop the .torrent file itself rather than pasting it: the file is binary and a text field mangles it. Pasted base64 or a hex dump of the file also works.",
  );
}

/* ------------------------------------------------------------------ */
/* views                                                               */
/* ------------------------------------------------------------------ */

export interface TorrentOpts {
  /** summary | files | magnet */
  view: string;
  /** List every file instead of stopping at 200 entries. */
  allFiles: boolean;
  [key: string]: unknown;
}

const DEFAULT_OPTS: TorrentOpts = { view: "summary", allFiles: false };

/** Unix seconds as ISO 8601 UTC. Never locale formatted: tests run anywhere. */
function isoUtc(unix: number | undefined): string {
  if (unix === undefined) return "not recorded";
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return `unreadable (${unix})`;
  return `${date.toISOString()} (unix ${unix})`;
}

function fileLines(info: TorrentInfo, all: boolean): string {
  if (info.files.length === 0) return "none listed in this torrent";
  const shown = all ? info.files : info.files.slice(0, FILE_CAP);
  const width = shown.reduce((max, file) => Math.max(max, formatBytes(file.length).length), 0);
  const lines = shown.map((file) => `${formatBytes(file.length).padStart(width)}  ${file.path}`);
  const hidden = info.files.length - shown.length;
  if (hidden > 0) lines.push(`and ${hidden.toLocaleString()} more`);
  return lines.join("\n");
}

function versionLabel(info: TorrentInfo): string {
  if (info.version === "hybrid") return "v1 and v2 hybrid (BEP 3 plus BEP 52)";
  if (info.version === "v2") return "v2 only (BEP 52)";
  return "v1 (BEP 3)";
}

function piecesLabel(info: TorrentInfo): string {
  if (info.pieceCount === undefined) {
    return "not stored as a flat piece list, which is normal for a v2 only torrent";
  }
  const ragged = info.piecesRagged ? ", and the pieces field is not a whole number of digests" : "";
  return `${info.pieceCount.toLocaleString()} SHA-1 digests${ragged}`;
}

function summaryView(info: TorrentInfo, opts: TorrentOpts): Record<string, string> {
  const out: Record<string, string> = {
    Name: info.name,
    "Protocol version": versionLabel(info),
    "Info hash (SHA-1 hex)": info.infoHash,
    "Info hash (base32)": info.infoHashBase32,
  };
  if (info.infoHashV2) out["Info hash v2 (SHA-256 hex)"] = info.infoHashV2;

  out["Total size"] = `${formatBytes(info.totalSize)} (${info.totalSize.toLocaleString()} bytes)`;
  out["Files"] = info.singleFile ? "1 (single file torrent)" : info.files.length.toLocaleString();
  out["Piece length"] =
    info.pieceLength === undefined ? "not recorded" : formatBytes(info.pieceLength);
  out["Pieces"] = piecesLabel(info);
  out["Private"] = info.private
    ? "yes, so clients use only the listed trackers"
    : "no, so DHT and peer exchange are allowed";
  out["Created"] = isoUtc(info.createdUnix);
  out["Created by"] = info.createdBy ?? "not recorded";
  out["Comment"] = info.comment ?? "none";
  if (info.encoding) out["Encoding"] = info.encoding;
  if (info.source) out["Source tag"] = info.source;

  out["Trackers"] =
    info.trackers.length === 0
      ? "none, so this is a trackerless torrent"
      : info.trackers.join("\n");
  if (info.webSeeds.length > 0) out["Web seeds"] = info.webSeeds.join("\n");
  if (info.dhtNodes.length > 0) out["DHT nodes"] = info.dhtNodes.join("\n");

  out["Magnet link"] = buildMagnet(info);
  out["File list"] = fileLines(info, opts.allFiles);
  return out;
}

function filesView(info: TorrentInfo, opts: TorrentOpts): Record<string, string> {
  return {
    Name: info.name,
    Files: info.files.length.toLocaleString(),
    "Total size": `${formatBytes(info.totalSize)} (${info.totalSize.toLocaleString()} bytes)`,
    "File list": fileLines(info, opts.allFiles),
  };
}

function magnetView(info: TorrentInfo): Record<string, string> {
  return {
    "Magnet link": buildMagnet(info),
    "Info hash (SHA-1 hex)": info.infoHash,
    "Info hash (base32)": info.infoHashBase32,
    Name: info.name,
  };
}

export function run(input: Uint8Array | string, opts: TorrentOpts): Record<string, string> {
  const settings = opts ?? DEFAULT_OPTS;
  const info = readTorrent(toBytes(input));
  switch (settings.view) {
    case "files":
      return filesView(info, settings);
    case "magnet":
      return magnetView(info);
    default:
      return summaryView(info, settings);
  }
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  TorrentOpts
>;
