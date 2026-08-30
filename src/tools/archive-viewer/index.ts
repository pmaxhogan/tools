import { gunzipSync, inflateSync, zipSync } from "fflate";
import { formatBytes } from "../../lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Archive reader for zip, tar, tar.gz and single file gzip.
 *
 * fflate supplies the two compressors that would be unreasonable to hand roll
 * (raw DEFLATE and the gzip wrapper) and nothing else. The zip container itself
 * is parsed here rather than through `unzipSync`, because `unzipSync` returns
 * only a name to bytes map: the dates, the per entry compressed sizes, the
 * compression methods and the archive comment all live in the central
 * directory and are exactly what a viewer exists to show. The tar reader is
 * fully hand rolled, including GNU long names and pax extended headers.
 *
 * Everything below is pure: no DOM, no fetch, no clock. Dates are formatted as
 * ISO-8601 without ever consulting the local zone, so a listing reads the same
 * on every machine. Whether a date carries a trailing Z depends on the format
 * it came out of rather than on a preference; see `isoFromDos`.
 */

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/** Refuse an archive past this: the whole file is held in memory. */
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * Refuse to inflate past this. A gzip member declares its uncompressed size in
 * the trailer, so a compression bomb is caught before any memory is committed
 * rather than after the tab has died.
 */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** Entries listed by `run()` before the tail is summarized as a count. */
const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5000;

/** Bytes of an entry decoded for the panel's text preview. */
export const TEXT_PREVIEW_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "gz";

/** What an entry is, beyond "a file". Drives the icon and the preview. */
export type EntryKind = "file" | "directory" | "symlink" | "hardlink" | "special";

export interface ArchiveEntry {
  /** Which container this entry came out of, so `readEntry` needs no context. */
  format: ArchiveFormat;
  /**
   * Path safe to show and to save under: backslashes normalized, a drive
   * letter and any leading slash removed, and every `..` segment dropped.
   */
  path: string;
  /** The path exactly as the archive recorded it, however hostile. */
  rawPath: string;
  /** Last segment of `path`. */
  name: string;
  kind: EntryKind;
  isDirectory: boolean;
  /** Uncompressed size in bytes. */
  size: number;
  /** Bytes the entry occupies inside the archive. Equals `size` when stored. */
  compressedSize: number;
  /**
   * Fraction of the original size saved by compression, 0 to 1, so 0.75 reads
   * as "75% smaller". Undefined for an empty entry, which saves nothing.
   */
  ratio?: number;
  /**
   * Last modified time as ISO-8601. A trailing Z means a real UTC instant, from
   * a tar mtime, a gzip header or zip's extended timestamp extra. No Z means a
   * zip MS-DOS timestamp, which records a bare wall clock and no zone at all.
   * Undefined when the archive stored no time. See `isoFromDos`.
   */
  modified?: string;
  /** Compression method, ready to display ("deflate", "stored"). */
  method: string;
  /** Numeric zip method id, or 0 for every stored format. Used by `readEntry`. */
  methodId: number;
  /** True when the recorded path tried to escape the archive root. */
  unsafe: boolean;
  /** True when the entry is encrypted and cannot be read here. */
  encrypted: boolean;
  /** Unix permissions as an octal string, when the format records them. */
  mode?: string;
  /** Target of a symlink or hard link. */
  linkTarget?: string;
  /** Byte offset of the entry inside the payload. Internal to `readEntry`. */
  offset: number;
  /** Bytes of stored data at `offset`. */
  storedSize: number;
}

/** One node of the collapsible tree. Directories carry their children. */
export interface ArchiveNode {
  name: string;
  path: string;
  isDirectory: boolean;
  /** The archive entry, absent on a directory the archive only implied. */
  entry?: ArchiveEntry;
  children: ArchiveNode[];
  /** Uncompressed bytes of every file at or below this node. */
  size: number;
  /** Files at or below this node, directories excluded. */
  fileCount: number;
}

export interface Archive {
  format: ArchiveFormat;
  /** Display name of the format, e.g. "gzipped tar". */
  formatLabel: string;
  /** Name the file was opened under, when one was supplied. */
  fileName?: string;
  /** Size of the archive itself. */
  archiveSize: number;
  entries: ArchiveEntry[];
  tree: ArchiveNode[];
  fileCount: number;
  directoryCount: number;
  /** Uncompressed bytes across every file entry. */
  totalSize: number;
  /** Bytes those entries occupy inside the archive. */
  totalCompressedSize: number;
  /** Archive level comment, zip only. */
  comment?: string;
  /** Anything the reader had to work around, ready to show the user. */
  warnings: string[];
}

export interface ArchiveOpts {
  /** summary | tree | list | paths */
  view: string;
  /** Entries listed before the rest is summarized as a count. */
  limit: number;
  /** path | size | ratio | date */
  sort: string;
  [key: string]: unknown;
}

/** One member of a rebuilt zip, for the panel's "extract all" button. */
export interface PackFile {
  path: string;
  data: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

/**
 * A 64 bit little endian field as a JS number. Zip64 sizes past 2^53 cannot be
 * represented exactly, but an archive that large is refused long before here.
 */
function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8_LOSSY = new TextDecoder("utf-8");
const LATIN1 = new TextDecoder("latin1");

/**
 * Decode a stored name. Zip flags UTF-8 with bit 11 and otherwise means CP437,
 * and tar has no encoding field at all, so the rule here is: try UTF-8 strictly
 * and fall back to Latin-1, which never throws and leaves every byte visible.
 * `fellBack` lets the caller warn that a name may be transliterated.
 */
function decodeName(bytes: Uint8Array): { text: string; fellBack: boolean } {
  try {
    return { text: UTF8.decode(bytes), fellBack: false };
  } catch {
    return { text: LATIN1.decode(bytes), fellBack: true };
  }
}

function isAscii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Zip slip defense. An archive may claim any path it likes, including
 * `../../etc/passwd` or `C:\Windows\system32\x.dll`, and a viewer that echoes
 * that path into a save dialog hands the attack straight to the user. The
 * sanitized path is what everything downstream uses; `rawPath` keeps the claim
 * so the entry can be shown for what it is.
 */
export function sanitizePath(raw: string): { path: string; unsafe: boolean } {
  let unsafe = false;
  let text = raw.replace(/\\/g, "/");

  if (/^[a-zA-Z]:/.test(text)) {
    text = text.slice(2);
    unsafe = true;
  }
  if (text.startsWith("/")) unsafe = true;

  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      unsafe = true;
      continue;
    }
    parts.push(part);
  }

  const path = parts.join("/");
  return { path: path || "(unnamed)", unsafe };
}

/* ------------------------------------------------------------------ */
/* dates                                                               */
/* ------------------------------------------------------------------ */

/** Seconds since the epoch as ISO-8601 in UTC, or undefined when unset. */
function isoFromSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(".000Z", "Z");
}

/**
 * MS-DOS date and time, as zip has stored it since 1989: six bit fields packed
 * into two 16 bit words, with two second resolution and no timezone whatsoever.
 *
 * Because there is no zone, the fields are emitted verbatim as an ISO-8601
 * string with **no** trailing Z, which is what every other unzip tool shows:
 * the wall clock on the machine that wrote the archive. Converting it to real
 * UTC would require guessing that machine's zone, and stamping a Z onto it
 * would assert a zone the format never recorded. Entries whose time came from
 * a genuine epoch field (a tar mtime, a gzip header, or zip's own extended
 * timestamp extra) do carry the Z, so the suffix says which kind of time it is.
 *
 * Reading is pure bit twiddling and never touches the local clock, so the same
 * archive lists the same times on every machine.
 */
function isoFromDos(dosDate: number, dosTime: number): string | undefined {
  if (dosDate === 0 && dosTime === 0) return undefined;
  const year = 1980 + ((dosDate >> 9) & 0x7f);
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/* ------------------------------------------------------------------ */
/* format detection                                                    */
/* ------------------------------------------------------------------ */

/**
 * A tar header's checksum is the sum of its 512 bytes with the checksum field
 * itself read as spaces. Nothing else identifies a plain tar (there is no
 * magic at offset zero), so this doubles as the format probe.
 */
function tarChecksumOk(block: Uint8Array, at: number): boolean {
  if (at + 512 > block.length) return false;
  const stored = parseOctal(block, at + 148, 8);
  if (stored === undefined) return false;
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 32 : block[at + i]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function looksLikeTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  // An all zero first block is a tar of nothing, which is still a tar.
  let allZero = true;
  for (let i = 0; i < 512 && allZero; i++) if (bytes[i] !== 0) allZero = false;
  if (allZero) return true;
  return isAscii(bytes, 257, "ustar") || tarChecksumOk(bytes, 0);
}

/** Which container these bytes are. Throws when nothing matches. */
export function detectFormat(bytes: Uint8Array, fileName?: string): ArchiveFormat {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // A gzip member wraps exactly one stream. Whether that stream is a tar is
    // only knowable by inflating it, which the caller does next anyway.
    return "gz";
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const sig = u32(bytes, 0);
    if (sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x06064b50 || sig === 0x08074b50) {
      return "zip";
    }
  }
  if (looksLikeTar(bytes)) return "tar";

  const hint = fileName ? ` The file is named ${fileName}.` : "";
  throw new ToolError(
    "unsupported-archive",
    `These bytes are not a zip, tar, tar.gz or gzip archive.${hint}`,
    "This viewer reads .zip, .tar, .tar.gz, .tgz and .gz. RAR, 7z, bzip2 and xz use different compressors and are not supported here.",
  );
}

/* ------------------------------------------------------------------ */
/* gzip                                                                */
/* ------------------------------------------------------------------ */

interface GzipHeader {
  /** Bytes before the deflate stream starts. */
  dataStart: number;
  /** Original file name from the FNAME field, when the writer stored one. */
  name?: string;
  /** Modification time as ISO-8601 UTC, when nonzero. */
  modified?: string;
}

function readGzipHeader(bytes: Uint8Array): GzipHeader {
  if (bytes.length < 18) {
    throw new ToolError(
      "bad-gzip",
      "This gzip file is too short to hold a header and a trailer.",
      "The file is probably truncated. Download it again.",
    );
  }
  if (bytes[2] !== 8) {
    throw new ToolError(
      "bad-gzip",
      `This gzip file uses compression method ${bytes[2]}, and only method 8 (deflate) exists.`,
      "The header is corrupt. Download the file again.",
    );
  }

  const flags = bytes[3]!;
  let at = 10;
  if (flags & 0x04) {
    // FEXTRA: a two byte length then that many bytes of subfields.
    at += 2 + u16(bytes, at);
  }
  let name: string | undefined;
  if (flags & 0x08) {
    const start = at;
    while (at < bytes.length && bytes[at] !== 0) at++;
    name = decodeName(bytes.subarray(start, at)).text;
    at++;
  }
  if (flags & 0x10) {
    while (at < bytes.length && bytes[at] !== 0) at++;
    at++;
  }
  if (flags & 0x02) at += 2; // FHCRC

  return { dataStart: at, name, modified: isoFromSeconds(u32(bytes, 4)) };
}

/** The uncompressed size from the gzip trailer, modulo 2^32 as the spec has it. */
function gzipIsize(bytes: Uint8Array): number {
  return u32(bytes, bytes.length - 4);
}

function inflateGzip(bytes: Uint8Array): Uint8Array {
  const declared = gzipIsize(bytes);
  if (declared > MAX_UNPACKED_BYTES) {
    throw new ToolError(
      "unpacked-too-large",
      `This archive expands to ${formatBytes(declared)}, past the ${formatBytes(MAX_UNPACKED_BYTES)} this page will hold in memory.`,
      "Unpack it with tar or gunzip on your own machine instead.",
    );
  }
  try {
    return gunzipSync(bytes);
  } catch (e) {
    throw new ToolError(
      "bad-gzip",
      `The gzip stream could not be decompressed: ${e instanceof Error ? e.message : String(e)}`,
      "The file is probably truncated or corrupt. Download it again.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* zip                                                                 */
/* ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b58;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Zip's numeric compression methods, by the names the spec gives them. */
const ZIP_METHODS: Record<number, string> = {
  0: "stored",
  1: "shrunk",
  6: "imploded",
  8: "deflate",
  9: "deflate64",
  12: "bzip2",
  14: "lzma",
  93: "zstd",
  95: "xz",
  96: "jpeg",
  98: "ppmd",
};

interface CentralDirectory {
  offset: number;
  count: number;
  comment?: string;
}

function findCentralDirectory(bytes: Uint8Array): CentralDirectory {
  // The end of central directory record sits at the very end unless a comment
  // follows it, and the comment length is capped at 65535 by the format.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (u32(bytes, at) === EOCD_SIG) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    throw new ToolError(
      "bad-zip",
      "This zip file has no end of central directory record, so its table of contents cannot be found.",
      "The file is probably truncated or is only the first part of a split archive. Download the whole file again.",
    );
  }

  let count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);

  const commentLength = u16(bytes, eocd + 20);
  const comment =
    commentLength > 0
      ? decodeName(bytes.subarray(eocd + 22, eocd + 22 + commentLength)).text
      : undefined;

  // Zip64: the 32 bit fields saturate and the real values live in a second
  // record, found through a locator immediately before the classic one.
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20) {
    const locator = eocd - 20;
    if (u32(bytes, locator) === EOCD64_LOCATOR_SIG) {
      const at = u64(bytes, locator + 8);
      if (at >= 0 && at + 56 <= bytes.length && u32(bytes, at) === EOCD64_SIG) {
        count = u64(bytes, at + 32);
        offset = u64(bytes, at + 48);
      }
    }
  }

  if (offset > bytes.length) {
    throw new ToolError(
      "bad-zip",
      "This zip file points its table of contents past the end of the file.",
      "The archive is corrupt, or it is one volume of a multi part zip. Recombine the parts first.",
    );
  }

  return { offset, count, comment };
}

/**
 * The zip64 extended information extra field, which restates whichever of the
 * uncompressed size, compressed size and local header offset saturated their
 * 32 bit slot. Only the saturated ones are present, in that fixed order.
 */
function readZip64Extra(
  extra: Uint8Array,
  saturated: { size: boolean; compressed: boolean; offset: boolean },
): { size?: number; compressed?: number; offset?: number } {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = u16(extra, at);
    const length = u16(extra, at + 2);
    const body = at + 4;
    if (body + length > extra.length) break;
    if (id === 0x0001) {
      const out: { size?: number; compressed?: number; offset?: number } = {};
      let cursor = body;
      if (saturated.size && cursor + 8 <= body + length) {
        out.size = u64(extra, cursor);
        cursor += 8;
      }
      if (saturated.compressed && cursor + 8 <= body + length) {
        out.compressed = u64(extra, cursor);
        cursor += 8;
      }
      if (saturated.offset && cursor + 8 <= body + length) {
        out.offset = u64(extra, cursor);
      }
      return out;
    }
    at = body + length;
  }
  return {};
}

/** The extended timestamp extra field (0x5455), a real UTC epoch second count. */
function readUnixTimeExtra(extra: Uint8Array): number | undefined {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = u16(extra, at);
    const length = u16(extra, at + 2);
    const body = at + 4;
    if (body + length > extra.length) break;
    if (id === 0x5455 && length >= 5 && (extra[body]! & 0x01) !== 0) {
      return u32(extra, body + 1);
    }
    at = body + length;
  }
  return undefined;
}

function readZip(
  bytes: Uint8Array,
  warnings: string[],
): { entries: ArchiveEntry[]; comment?: string } {
  const { offset, count, comment } = findCentralDirectory(bytes);
  const entries: ArchiveEntry[] = [];
  let at = offset;
  let fellBack = false;

  while (at + 46 <= bytes.length && u32(bytes, at) === CENTRAL_SIG) {
    const flags = u16(bytes, at + 8);
    const methodId = u16(bytes, at + 10);
    const dosTime = u16(bytes, at + 12);
    const dosDate = u16(bytes, at + 14);
    let compressedSize = u32(bytes, at + 20);
    let size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const externalAttrs = u32(bytes, at + 38);
    let localOffset = u32(bytes, at + 42);

    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const decoded = decodeName(nameBytes);
    if (decoded.fellBack) fellBack = true;
    const rawPath = decoded.text;

    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const zip64 = readZip64Extra(extra, {
      size: size === 0xffffffff,
      compressed: compressedSize === 0xffffffff,
      offset: localOffset === 0xffffffff,
    });
    if (zip64.size !== undefined) size = zip64.size;
    if (zip64.compressed !== undefined) compressedSize = zip64.compressed;
    if (zip64.offset !== undefined) localOffset = zip64.offset;

    const unixTime = readUnixTimeExtra(extra);
    const modified =
      unixTime !== undefined ? isoFromSeconds(unixTime) : isoFromDos(dosDate, dosTime);

    const isDirectory = rawPath.endsWith("/") || (size === 0 && (externalAttrs & 0x10) !== 0);
    const { path, unsafe } = sanitizePath(rawPath);
    // The high 16 bits of the external attributes are the Unix st_mode when the
    // archive was written on a Unix host; zero means it was not.
    const unixMode = (externalAttrs >>> 16) & 0xffff;

    entries.push({
      format: "zip",
      path,
      rawPath,
      name: path.split("/").pop() || path,
      kind: isDirectory ? "directory" : "file",
      isDirectory,
      size,
      compressedSize,
      ratio: size > 0 ? Math.max(0, Math.min(1, 1 - compressedSize / size)) : undefined,
      modified,
      method: ZIP_METHODS[methodId] ?? `method ${methodId}`,
      methodId,
      unsafe,
      encrypted: (flags & 0x01) !== 0,
      mode: unixMode ? (unixMode & 0o7777).toString(8).padStart(3, "0") : undefined,
      offset: localOffset,
      storedSize: compressedSize,
    });

    at += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length < count) {
    warnings.push(
      `The table of contents claims ${count} entries but only ${entries.length} could be read, so this archive is incomplete.`,
    );
  }
  if (fellBack) {
    warnings.push(
      "Some entry names are not valid UTF-8 and were read as Latin-1, so accented characters may look wrong.",
    );
  }

  return { entries, comment };
}

function readZipEntry(payload: Uint8Array, entry: ArchiveEntry): Uint8Array {
  if (entry.encrypted) {
    throw new ToolError(
      "entry-encrypted",
      `"${entry.path}" is password protected, so its contents cannot be read.`,
      "Open the archive with a tool that can ask you for the password, such as 7-Zip or the unzip command.",
    );
  }
  if (entry.methodId !== 0 && entry.methodId !== 8) {
    throw new ToolError(
      "entry-unsupported",
      `"${entry.path}" is compressed with ${entry.method}, which this reader does not implement.`,
      "Only stored and deflate entries can be read here. 7-Zip or the unzip command will handle the rest.",
    );
  }

  const header = entry.offset;
  if (header + 30 > payload.length || u32(payload, header) !== LOCAL_SIG) {
    throw new ToolError(
      "bad-zip",
      `The local header for "${entry.path}" is missing or corrupt.`,
      "The archive is damaged. Download it again.",
    );
  }
  const nameLength = u16(payload, header + 26);
  const extraLength = u16(payload, header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.storedSize;
  if (end > payload.length) {
    throw new ToolError(
      "bad-zip",
      `"${entry.path}" runs past the end of the archive.`,
      "The file is truncated. Download it again.",
    );
  }

  const stored = payload.slice(start, end);
  if (entry.methodId === 0) return stored;
  try {
    return entry.size > 0
      ? inflateSync(stored, { out: new Uint8Array(entry.size) })
      : inflateSync(stored);
  } catch (e) {
    throw new ToolError(
      "bad-zip",
      `"${entry.path}" could not be decompressed: ${e instanceof Error ? e.message : String(e)}`,
      "The entry is corrupt. Try extracting it with another tool to confirm.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* tar                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A numeric tar field: octal digits, space or NUL padded. GNU also writes a
 * base 256 form with the high bit of the first byte set, for sizes past 8 GB.
 */
function parseOctal(bytes: Uint8Array, at: number, length: number): number | undefined {
  const first = bytes[at];
  if (first === undefined) return undefined;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i]!;
    return value;
  }
  let text = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[at + i]!;
    if (byte === 0 || byte === 32) break;
    text += String.fromCharCode(byte);
  }
  text = text.trim();
  if (text === "") return 0;
  const value = parseInt(text, 8);
  return Number.isNaN(value) ? undefined : value;
}

function trimmedString(bytes: Uint8Array, at: number, length: number): string {
  let end = at;
  const stop = Math.min(at + length, bytes.length);
  while (end < stop && bytes[end] !== 0) end++;
  return decodeName(bytes.subarray(at, end)).text;
}

/**
 * A pax extended header is a run of `length key=value\n` records, where length
 * counts its own digits and the space. The keys that matter to a listing are
 * path, linkpath, size and mtime.
 *
 * The walk is over bytes, never over a decoded string. A pax length is a byte
 * count, and pax exists precisely to carry the non-ASCII paths that ustar
 * cannot: decoding first and slicing by character index desynchronizes the
 * cursor on the first accented path and drags the tail of one record into the
 * next.
 */
function parsePax(block: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < block.length) {
    let cursor = at;
    while (cursor < block.length && block[cursor]! >= 0x30 && block[cursor]! <= 0x39) cursor++;
    // A record must open with ASCII digits and exactly one space.
    if (cursor === at || block[cursor] !== 0x20) break;

    const length = Number(LATIN1.decode(block.subarray(at, cursor)));
    if (!Number.isFinite(length) || length <= 0 || at + length > block.length) break;

    let end = at + length;
    if (block[end - 1] === 0x0a) end--;
    const record = UTF8_LOSSY.decode(block.subarray(cursor + 1, end));
    const equals = record.indexOf("=");
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

const TAR_KINDS: Record<string, EntryKind> = {
  "0": "file",
  "\0": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "special",
  "4": "special",
  "5": "directory",
  "6": "special",
  "7": "file",
};

function readTar(bytes: Uint8Array, format: ArchiveFormat, warnings: string[]): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let at = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let paxNext: Record<string, string> = {};
  let paxGlobal: Record<string, string> = {};
  let zeroBlocks = 0;

  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);

    let allZero = true;
    for (let i = 0; i < 512 && allZero; i++) if (block[i] !== 0) allZero = false;
    if (allZero) {
      zeroBlocks++;
      at += 512;
      // Two zero blocks in a row is the end of archive marker.
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    if (!tarChecksumOk(bytes, at) && !isAscii(bytes, at + 257, "ustar")) {
      warnings.push(
        `A header at byte ${at} failed its checksum, so reading stopped there. Any entries after it are not listed.`,
      );
      break;
    }

    const size = parseOctal(bytes, at + 124, 12) ?? 0;
    const typeflag = String.fromCharCode(block[156]!);
    const dataStart = at + 512;
    const dataEnd = Math.min(dataStart + size, bytes.length);
    const padded = Math.ceil(size / 512) * 512;

    // GNU stores an over-long name as the body of its own 'L' entry, and the
    // real header follows immediately after.
    if (typeflag === "L") {
      longName = trimmedString(bytes, dataStart, size);
      at = dataStart + padded;
      continue;
    }
    if (typeflag === "K") {
      longLink = trimmedString(bytes, dataStart, size);
      at = dataStart + padded;
      continue;
    }
    if (typeflag === "x" || typeflag === "X") {
      paxNext = parsePax(bytes.subarray(dataStart, dataEnd));
      at = dataStart + padded;
      continue;
    }
    if (typeflag === "g") {
      paxGlobal = { ...paxGlobal, ...parsePax(bytes.subarray(dataStart, dataEnd)) };
      at = dataStart + padded;
      continue;
    }

    const prefix = trimmedString(bytes, at + 345, 155);
    const base = trimmedString(bytes, at, 100);
    const pax = { ...paxGlobal, ...paxNext };
    const rawPath = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const linkRaw = pax.linkpath ?? longLink ?? trimmedString(bytes, at + 157, 100);

    const realSize = pax.size !== undefined ? Number(pax.size) : size;
    const mtime =
      pax.mtime !== undefined ? Number(pax.mtime) : (parseOctal(bytes, at + 136, 12) ?? 0);
    const mode = parseOctal(bytes, at + 100, 8);
    const kind = TAR_KINDS[typeflag] ?? "special";
    const isDirectory = kind === "directory" || rawPath.endsWith("/");
    const { path, unsafe } = sanitizePath(rawPath);

    entries.push({
      format,
      path,
      rawPath,
      name: path.split("/").pop() || path,
      kind: isDirectory ? "directory" : kind,
      isDirectory,
      size: isDirectory ? 0 : realSize,
      // Inside a tar every entry is stored verbatim; the gzip layer compresses
      // the whole stream, so there is no honest per entry compressed size.
      compressedSize: isDirectory ? 0 : realSize,
      ratio: undefined,
      modified: isoFromSeconds(mtime),
      method: "stored",
      methodId: 0,
      unsafe,
      encrypted: false,
      mode: mode !== undefined ? (mode & 0o7777).toString(8).padStart(3, "0") : undefined,
      linkTarget: linkRaw || undefined,
      offset: dataStart,
      storedSize: Math.max(0, dataEnd - dataStart),
    });

    longName = undefined;
    longLink = undefined;
    paxNext = {};
    at = dataStart + padded;
  }

  if (entries.length === 0 && bytes.length > 0) {
    warnings.push("This tar archive holds no entries.");
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* tree                                                                */
/* ------------------------------------------------------------------ */

/**
 * Build the collapsible tree from the flat entry list. Directories that only
 * exist implicitly (a zip that stores `docs/readme.md` and no `docs/` entry)
 * are created here, which is why the tree is derived rather than stored.
 */
export function buildTree(entries: ArchiveEntry[]): ArchiveNode[] {
  const root: ArchiveNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
    size: 0,
    fileCount: 0,
  };
  const byPath = new Map<string, ArchiveNode>([["", root]]);

  function directoryAt(path: string): ArchiveNode {
    const found = byPath.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const parent = directoryAt(cut < 0 ? "" : path.slice(0, cut));
    const node: ArchiveNode = {
      name: cut < 0 ? path : path.slice(cut + 1),
      path,
      isDirectory: true,
      children: [],
      size: 0,
      fileCount: 0,
    };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  }

  for (const entry of entries) {
    const cut = entry.path.lastIndexOf("/");
    const parentPath = cut < 0 ? "" : entry.path.slice(0, cut);

    if (entry.isDirectory) {
      const node = directoryAt(entry.path);
      node.entry = entry;
      continue;
    }

    const parent = directoryAt(parentPath);
    parent.children.push({
      name: entry.name,
      path: entry.path,
      isDirectory: false,
      entry,
      children: [],
      size: entry.size,
      fileCount: 1,
    });
  }

  // Roll sizes and counts up, then sort directories first and alphabetically.
  function settle(node: ArchiveNode): void {
    if (!node.isDirectory) return;
    let size = 0;
    let files = 0;
    for (const child of node.children) {
      settle(child);
      size += child.size;
      files += child.fileCount;
    }
    node.size = size;
    node.fileCount = files;
    node.children.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, "en");
    });
  }
  settle(root);

  return root.children;
}

/* ------------------------------------------------------------------ */
/* the public reader                                                   */
/* ------------------------------------------------------------------ */

const FORMAT_LABELS: Record<ArchiveFormat, string> = {
  zip: "zip",
  tar: "tar",
  "tar.gz": "gzipped tar",
  gz: "gzip",
};

function guard(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new ToolError(
      "empty-input",
      "No archive was given.",
      "Drop a .zip, .tar, .tar.gz or .gz file onto the input, or pick one with the file button.",
    );
  }
  if (bytes.length > MAX_BYTES) {
    throw new ToolError(
      "archive-too-large",
      `This archive is ${formatBytes(bytes.length)}, past the ${formatBytes(MAX_BYTES)} limit for reading one inside a browser tab.`,
      "Unpack it with tar, unzip or 7-Zip on your own machine instead.",
    );
  }
}

/**
 * The bytes entries are read out of: the file itself for zip and tar, and the
 * inflated stream for anything gzipped. Exported so a panel can inflate once
 * and slice many entries out of the result instead of paying per click.
 */
export function archivePayload(bytes: Uint8Array, format: ArchiveFormat): Uint8Array {
  return format === "gz" || format === "tar.gz" ? inflateGzip(bytes) : bytes;
}

/** Open an archive and describe everything inside it. */
export function listArchive(bytes: Uint8Array, fileName?: string): Archive {
  guard(bytes);

  const warnings: string[] = [];
  const detected = detectFormat(bytes, fileName);

  let format: ArchiveFormat = detected;
  let entries: ArchiveEntry[];
  let comment: string | undefined;

  if (detected === "zip") {
    const zip = readZip(bytes, warnings);
    entries = zip.entries;
    comment = zip.comment;
  } else if (detected === "tar") {
    entries = readTar(bytes, "tar", warnings);
  } else {
    const header = readGzipHeader(bytes);
    const inflated = inflateGzip(bytes);
    if (looksLikeTar(inflated)) {
      format = "tar.gz";
      entries = readTar(inflated, "tar.gz", warnings);
    } else {
      // A lone gzip member holds exactly one file, whose name is either in the
      // header or implied by stripping .gz from the archive's own name.
      const stem = header.name ?? (fileName ? fileName.replace(/\.(gz|z)$/i, "") : "decompressed");
      const { path, unsafe } = sanitizePath(stem);
      const size = inflated.length;
      const compressed = bytes.length - header.dataStart - 8;
      entries = [
        {
          format: "gz",
          path,
          rawPath: stem,
          name: path.split("/").pop() || path,
          kind: "file",
          isDirectory: false,
          size,
          compressedSize: Math.max(0, compressed),
          ratio:
            size > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, compressed) / size)) : undefined,
          modified: header.modified,
          method: "deflate",
          methodId: 8,
          unsafe,
          encrypted: false,
          offset: 0,
          storedSize: size,
        },
      ];
    }
  }

  const unsafeCount = entries.filter((entry) => entry.unsafe).length;
  if (unsafeCount > 0) {
    warnings.push(
      `${unsafeCount} ${unsafeCount === 1 ? "entry claims a path" : "entries claim paths"} outside the archive root. They are shown and saved under a cleaned path, never the one the archive asked for.`,
    );
  }
  const encryptedCount = entries.filter((entry) => entry.encrypted).length;
  if (encryptedCount > 0) {
    warnings.push(
      `${encryptedCount} ${encryptedCount === 1 ? "entry is" : "entries are"} password protected and cannot be previewed or extracted here.`,
    );
  }

  const files = entries.filter((entry) => !entry.isDirectory);
  return {
    format,
    formatLabel: FORMAT_LABELS[format],
    fileName,
    archiveSize: bytes.length,
    entries,
    tree: buildTree(entries),
    fileCount: files.length,
    directoryCount: entries.length - files.length,
    totalSize: files.reduce((sum, entry) => sum + entry.size, 0),
    totalCompressedSize: files.reduce((sum, entry) => sum + entry.compressedSize, 0),
    comment,
    warnings,
  };
}

/** Read one entry out of an already inflated payload. */
export function readEntryFrom(payload: Uint8Array, entry: ArchiveEntry): Uint8Array {
  if (entry.isDirectory) {
    throw new ToolError(
      "entry-is-directory",
      `"${entry.path}" is a directory, so it has no contents of its own.`,
      "Pick a file inside it instead.",
    );
  }
  if (entry.format === "zip") return readZipEntry(payload, entry);
  if (entry.format === "gz") return payload.slice(0);

  const end = Math.min(entry.offset + entry.storedSize, payload.length);
  return payload.slice(entry.offset, end);
}

/** Read one entry straight from the original archive bytes. */
export function readEntry(bytes: Uint8Array, entry: ArchiveEntry): Uint8Array {
  guard(bytes);
  return readEntryFrom(archivePayload(bytes, entry.format), entry);
}

/**
 * Rebuild a set of entries as one zip, for the panel's "extract all" button.
 * `mtime` is explicit so a caller that needs reproducible bytes can get them:
 * fflate otherwise stamps the current time into every local header.
 */
export function packEntries(files: PackFile[], mtime?: number | Date): Uint8Array {
  const input: Record<string, [Uint8Array, { mtime?: number | Date }]> = {};
  for (const file of files) {
    input[file.path] = [file.data, mtime === undefined ? {} : { mtime }];
  }
  return zipSync(input, { level: 6 });
}

/* ------------------------------------------------------------------ */
/* preview helpers (pure, so the panel imports rather than reinvents)  */
/* ------------------------------------------------------------------ */

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "csv",
  "tsv",
  "log",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "env",
  "gitignore",
  "dockerfile",
  "makefile",
  "lock",
  "properties",
  "srt",
  "vtt",
  "diff",
  "patch",
]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

/** The MIME type to preview this path as an image, or undefined. */
export function imageTypeFor(path: string): string | undefined {
  return IMAGE_TYPES[extensionOf(path)];
}

/** True when the name suggests text worth showing in a preview pane. */
export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

/**
 * Decode the head of an entry as text. Invalid bytes become replacement
 * characters rather than throwing, because a preview of a mostly-text file is
 * still useful. `truncated` says whether the tail was cut.
 */
export function decodeTextPreview(
  data: Uint8Array,
  limit = TEXT_PREVIEW_BYTES,
): { text: string; truncated: boolean } {
  const head = data.subarray(0, limit);
  return { text: UTF8_LOSSY.decode(head), truncated: data.length > limit };
}

/** True when the first bytes look like something no text pane should render. */
export function looksBinary(data: Uint8Array): boolean {
  const sample = Math.min(data.length, 1024);
  for (let i = 0; i < sample; i++) if (data[i] === 0) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* text rendering for the generic shell                                */
/* ------------------------------------------------------------------ */

/** A saved fraction as a short phrase: "72% smaller", "stored". */
export function formatRatio(entry: ArchiveEntry): string {
  if (entry.isDirectory) return "";
  if (entry.ratio === undefined) return "empty";
  if (entry.ratio <= 0.005) return "stored";
  return `${Math.round(entry.ratio * 100)}% smaller`;
}

function sortEntries(entries: ArchiveEntry[], by: string): ArchiveEntry[] {
  const sorted = [...entries];
  switch (by) {
    case "size":
      sorted.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path, "en"));
      break;
    case "ratio":
      sorted.sort(
        (a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.path.localeCompare(b.path, "en"),
      );
      break;
    case "date":
      sorted.sort(
        (a, b) =>
          (b.modified ?? "").localeCompare(a.modified ?? "") || a.path.localeCompare(b.path, "en"),
      );
      break;
    default:
      sorted.sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  return sorted;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function listingText(archive: Archive, limit: number, sort: string): string {
  const shown = sortEntries(archive.entries, sort).slice(0, limit);
  if (shown.length === 0) return "This archive holds no entries.";

  const sizes = shown.map((entry) => (entry.isDirectory ? "" : formatBytes(entry.size)));
  const dates = shown.map((entry) => entry.modified ?? "");
  const sizeWidth = Math.max(4, ...sizes.map((s) => s.length));
  const dateWidth = Math.max(4, ...dates.map((d) => d.length));

  const lines = shown.map((entry, i) => {
    const marker = entry.isDirectory ? "d" : entry.unsafe ? "!" : "-";
    const suffix = entry.isDirectory ? "/" : "";
    const link = entry.linkTarget ? ` -> ${entry.linkTarget}` : "";
    return `${marker} ${padStart(sizes[i]!, sizeWidth)}  ${pad(dates[i]!, dateWidth)}  ${entry.path}${suffix}${link}`;
  });

  const hidden = archive.entries.length - shown.length;
  if (hidden > 0) lines.push(`... and ${hidden} more ${hidden === 1 ? "entry" : "entries"}`);
  return lines.join("\n");
}

function treeText(nodes: ArchiveNode[], prefix = ""): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    const branch = last ? "`-- " : "|-- ";
    const detail = node.isDirectory
      ? `${node.fileCount} ${node.fileCount === 1 ? "file" : "files"}, ${formatBytes(node.size)}`
      : formatBytes(node.size);
    lines.push(`${prefix}${branch}${node.name}${node.isDirectory ? "/" : ""}  (${detail})`);
    if (node.isDirectory && node.children.length > 0) {
      lines.push(...treeText(node.children, `${prefix}${last ? "    " : "|   "}`));
    }
  });
  return lines;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const TEXT_ENCODER = new TextEncoder();

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === "string" ? TEXT_ENCODER.encode(input) : input;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * The text surface on the same reader the panel uses. The bespoke panel is
 * where an archive is actually browsed; this keeps the tool honest for the
 * generic shell, the keyboard-only path and anyone reading the listing as text.
 */
export function run(
  input: Uint8Array | string,
  opts: Partial<ArchiveOpts> = {},
): Record<string, string> {
  const bytes = toBytes(input);
  const archive = listArchive(bytes);

  const view = typeof opts.view === "string" ? opts.view : "summary";
  const limit = clamp(opts.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const sort = typeof opts.sort === "string" ? opts.sort : "path";

  const saved =
    archive.totalSize > 0
      ? `${Math.round((1 - archive.totalCompressedSize / archive.totalSize) * 100)}% smaller than the contents`
      : "nothing to compress";

  if (view === "paths") {
    return {
      Paths: sortEntries(archive.entries, sort)
        .slice(0, limit)
        .map((entry) => entry.path + (entry.isDirectory ? "/" : ""))
        .join("\n"),
    };
  }

  const out: Record<string, string> = {
    Format: archive.formatLabel,
    "Archive size": formatBytes(archive.archiveSize),
    Contents: `${archive.fileCount} ${archive.fileCount === 1 ? "file" : "files"}, ${archive.directoryCount} ${archive.directoryCount === 1 ? "directory" : "directories"}`,
    Uncompressed: formatBytes(archive.totalSize),
    Compression: saved,
  };

  if (archive.comment) out.Comment = archive.comment;

  if (view === "tree") {
    out.Tree = treeText(archive.tree).join("\n") || "This archive holds no entries.";
  } else if (view === "list") {
    out.Entries = listingText(archive, limit, sort);
  } else {
    out.Entries = listingText(archive, Math.min(limit, 50), sort);
  }

  if (archive.warnings.length > 0) out.Warnings = archive.warnings.join("\n");
  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  Partial<ArchiveOpts>
>;
