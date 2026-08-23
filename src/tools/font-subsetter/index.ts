import { zlibSync } from "fflate";
// @ts-expect-error: opentype.js ships no type declarations.
import opentypeRaw from "opentype.js";
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Font subsetter: strip a font down to the characters you actually use and
 * write it back out as WOFF2, WOFF, or an uncompressed OpenType file.
 *
 * Two honest limits are baked into this layer and reported in the output
 * rather than hidden:
 *
 * 1. opentype.js 2.x has no `glyf` writer (its glyf module exports only a
 *    parser), so every font it writes carries CFF outlines and the OTTO
 *    flavor. A TrueType input therefore comes back out as an .otf, not a
 *    .ttf. The bytes are a valid OpenType font either way and WOFF2 wraps
 *    them fine, which is what almost everybody actually ships.
 * 2. Advanced layout tables are not carried over. GSUB (ligatures, contextual
 *    alternates, small caps), GPOS (kerning, mark attachment), GDEF, and the
 *    legacy `kern` table are all dropped, because the font is rebuilt from
 *    glyph outlines rather than edited in place. For most UI and body text
 *    that is invisible; for a script face or a font that leans on `liga` it
 *    is not, so the tool names the tables it threw away.
 *
 * Everything here is pure: bytes in, text and bytes out. `btoa` and `atob`
 * are platform primitives present in browsers, Workers, and Node, the same
 * way `crypto` is. The WOFF2 codec (wawoff2, a wasm build of Google's woff2)
 * is pulled in with a dynamic import so a page that only inspects a font
 * never pays for it.
 */

/* ------------------------------------------------------------------ */
/* opentype.js surface                                                */
/* ------------------------------------------------------------------ */

interface OtPath {
  commands: unknown[];
}

interface OtGlyph {
  name?: string;
  index: number;
  unicode?: number;
  unicodes?: number[];
  advanceWidth?: number;
  path: OtPath;
}

interface OtGlyphSet {
  length: number;
  get(index: number): OtGlyph;
}

/** `{ en: "Inter" }`, keyed by BCP 47 language tag. */
type OtNameValue = Record<string, string>;

/** `font.names` is keyed by platform first in opentype.js 2.x. */
type OtNames = Record<string, Record<string, OtNameValue> | undefined>;

interface OtCmap {
  /** Code point (a decimal string key) to glyph index. */
  glyphIndexMap?: Record<string, number>;
}

interface OtFont {
  glyphs: OtGlyphSet;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  outlinesFormat?: string;
  names: OtNames;
  tables: Record<string, unknown> & { cmap?: OtCmap };
  toArrayBuffer(): ArrayBuffer;
}

interface OtFontSpec {
  familyName: string;
  styleName: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: OtGlyph[];
}

interface OtGlyphSpec {
  name: string;
  unicode?: number;
  unicodes?: number[];
  advanceWidth: number;
  path: OtPath;
}

interface OpenTypeModule {
  parse(buffer: Uint8Array | ArrayBuffer): OtFont;
  Font: new (spec: OtFontSpec) => OtFont;
  Glyph: new (spec: OtGlyphSpec) => OtGlyph;
  Path: new () => OtPath;
}

const opentype = opentypeRaw as OpenTypeModule;

/** wawoff2 is a wasm build of Google's woff2 codec. It ships no types. */
export interface Woff2Codec {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

let woff2Codec: Promise<Woff2Codec> | null = null;
let injectedCodec: Woff2Codec | null = null;

/**
 * Browser panels inject a working codec (src/lib/woff2.ts runs the glue in
 * dedicated workers) because wawoff2's emscripten build only wires up
 * `module.exports` under Node: bundled directly in a browser it imports as a
 * dead object and its init promise never settles. Node (vitest, scripts)
 * needs no injection; the dynamic import below works there.
 */
export function setWoff2Codec(codec: Woff2Codec): void {
  injectedCodec = codec;
}

/**
 * The codec is close to a megabyte of emscripten output with its wasm inlined
 * as a data URL, so it loads on first use instead of on import.
 */
function loadWoff2(): Promise<Woff2Codec> {
  if (injectedCodec) return Promise.resolve(injectedCodec);
  // @ts-expect-error: wawoff2 ships no type declarations.
  woff2Codec ??= import("wawoff2") as Promise<Woff2Codec>;
  return woff2Codec;
}

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

function emptyInput(): ToolError {
  return new ToolError(
    "empty-input",
    "Provide a font file.",
    "Drop a .ttf, .otf, .woff, or .woff2 file, or paste it as a base64 data URL.",
  );
}

function notAFont(detail?: string): ToolError {
  return new ToolError(
    "not-a-font",
    detail ?? "This does not look like a font file.",
    "Use a .ttf, .otf, .woff, or .woff2 file. Font collections (.ttc, .otc) and bare .pfb files are not supported.",
  );
}

function badRange(detail: string, fix: string): ToolError {
  return new ToolError("bad-range", detail, fix);
}

function nothingKept(detail: string, fix: string): ToolError {
  return new ToolError("nothing-kept", detail, fix);
}

function subsetFailed(reason: string): ToolError {
  return new ToolError(
    "subset-failed",
    `The font could not be rebuilt: ${reason}`,
    "Some fonts use outline data this rebuilder cannot re-emit. Try a static instance of a variable font, or a plain .ttf or .otf export.",
  );
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                       */
/* ------------------------------------------------------------------ */

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tagAt(bytes: Uint8Array, offset: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** Chunked, so a large font never blows the argument limit of `fromCharCode`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array | null {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (normal.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normal)) return null;
  try {
    const binary = atob(normal);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* format sniffing                                                    */
/* ------------------------------------------------------------------ */

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

const FORMAT_LABELS: Record<FontFormat, string> = {
  ttf: "TrueType (.ttf)",
  otf: "OpenType CFF (.otf)",
  woff: "WOFF",
  woff2: "WOFF2",
};

const FORMAT_MIME: Record<FontFormat, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** The CSS `format()` hint that belongs in a `src:` descriptor. */
const FORMAT_CSS: Record<FontFormat, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

export function detectFormat(bytes: Uint8Array): FontFormat {
  if (bytes.length < 4) throw notAFont("This file is too short to be a font.");
  const tag = tagAt(bytes, 0);
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || tag === "typ1") return "ttf";
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)
    return "ttf";
  if (tag === "ttcf") {
    throw notAFont(
      "This is a TrueType or OpenType collection, which packs several fonts into one file.",
    );
  }
  throw notAFont();
}

/* ------------------------------------------------------------------ */
/* sfnt and WOFF containers                                           */
/* ------------------------------------------------------------------ */

export interface SfntTable {
  tag: string;
  /** The checksum recorded in the source directory, copied through verbatim. */
  checksum: number;
  offset: number;
  length: number;
}

export interface SfntDirectory {
  /** The sfnt version: 0x00010000 for TrueType, the tag "OTTO" for CFF. */
  flavor: number;
  tables: SfntTable[];
}

/** Reads the table directory of an uncompressed .ttf or .otf. */
export function readSfntDirectory(bytes: Uint8Array): SfntDirectory {
  if (bytes.length < 12) throw notAFont("This file is too short to hold a font table directory.");
  const view = viewOf(bytes);
  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.length) {
    throw notAFont("The font table directory is missing or truncated.");
  }
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const table: SfntTable = {
      tag: tagAt(bytes, at),
      checksum: view.getUint32(at + 4),
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12),
    };
    if (table.offset + table.length > bytes.length) {
      throw notAFont(`The ${table.tag} table runs past the end of the file.`);
    }
    tables.push(table);
  }
  return { flavor: view.getUint32(0), tables };
}

/** Reads the table tag list of a WOFF file without decompressing anything. */
export function readWoffTags(bytes: Uint8Array): string[] {
  if (bytes.length < 44) throw notAFont("This WOFF file is truncated.");
  const view = viewOf(bytes);
  const numTables = view.getUint16(12);
  if (44 + numTables * 20 > bytes.length) throw notAFont("The WOFF table directory is truncated.");
  const tags: string[] = [];
  for (let i = 0; i < numTables; i++) tags.push(tagAt(bytes, 44 + i * 20));
  return tags;
}

/**
 * Wraps an uncompressed sfnt in a WOFF 1.0 container.
 *
 * The container is deliberately plain: every table is deflated on its own with
 * a zlib wrapper, stored uncompressed when deflate does not help, and the
 * original directory checksums are copied through rather than recomputed. That
 * last part matters, because the `head` table's checksum has its own rule
 * about the checkSumAdjustment field, and reusing the value the source font
 * already agreed on sidesteps it entirely.
 */
export function toWoff(
  sfnt: Uint8Array,
  version: { major?: number; minor?: number } = {},
): Uint8Array {
  const { flavor, tables } = readSfntDirectory(sfnt);
  const bodies = tables.map((table) => {
    const raw = sfnt.subarray(table.offset, table.offset + table.length);
    const deflated = zlibSync(raw, { level: 9 });
    // A WOFF reader treats compLength < origLength as the only "compressed"
    // signal, so a table that did not shrink must be stored verbatim.
    return deflated.length < raw.length ? deflated : raw;
  });

  const offsets: number[] = [];
  let cursor = 44 + tables.length * 20;
  for (const body of bodies) {
    offsets.push(cursor);
    cursor = pad4(cursor + body.length);
  }

  const out = new Uint8Array(cursor);
  const view = viewOf(out);
  out.set([0x77, 0x4f, 0x46, 0x46], 0); // "wOFF"
  view.setUint32(4, flavor);
  view.setUint32(8, cursor);
  view.setUint16(12, tables.length);
  view.setUint16(14, 0);
  view.setUint32(16, 12 + tables.length * 16 + tables.reduce((sum, t) => sum + pad4(t.length), 0));
  view.setUint16(20, version.major ?? 1);
  view.setUint16(22, version.minor ?? 0);
  // metaOffset, metaLength, metaOrigLength, privOffset and privLength stay zero.

  tables.forEach((table, i) => {
    const at = 44 + i * 20;
    for (let c = 0; c < 4; c++) out[at + c] = table.tag.charCodeAt(c);
    view.setUint32(at + 4, offsets[i]);
    view.setUint32(at + 8, bodies[i].length);
    view.setUint32(at + 12, table.length);
    view.setUint32(at + 16, table.checksum);
    out.set(bodies[i], offsets[i]);
  });

  return out;
}

/** Compresses an uncompressed sfnt to WOFF2 with the wasm woff2 encoder. */
export async function toWoff2(sfnt: Uint8Array): Promise<Uint8Array> {
  const codec = await loadWoff2();
  try {
    return new Uint8Array(await codec.compress(sfnt));
  } catch (error) {
    throw subsetFailed(`the WOFF2 encoder rejected the font (${(error as Error).message})`);
  }
}

/** Expands a WOFF2 file back to an uncompressed sfnt. */
export async function fromWoff2(woff2: Uint8Array): Promise<Uint8Array> {
  const codec = await loadWoff2();
  try {
    return new Uint8Array(await codec.decompress(woff2));
  } catch (error) {
    throw notAFont(`This WOFF2 file could not be decompressed (${(error as Error).message}).`);
  }
}

/* ------------------------------------------------------------------ */
/* unicode blocks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Start, end, name. Only the blocks a Latin, Greek, or Cyrillic face is likely
 * to touch, plus the big CJK and symbol ones. Anything else lands in "Other".
 */
const BLOCKS: [number, number, string][] = [
  [0x0000, 0x007f, "Basic Latin"],
  [0x0080, 0x00ff, "Latin-1 Supplement"],
  [0x0100, 0x017f, "Latin Extended-A"],
  [0x0180, 0x024f, "Latin Extended-B"],
  [0x0250, 0x02af, "IPA Extensions"],
  [0x02b0, 0x02ff, "Spacing Modifier Letters"],
  [0x0300, 0x036f, "Combining Diacritical Marks"],
  [0x0370, 0x03ff, "Greek and Coptic"],
  [0x0400, 0x04ff, "Cyrillic"],
  [0x0500, 0x052f, "Cyrillic Supplement"],
  [0x0530, 0x058f, "Armenian"],
  [0x0590, 0x05ff, "Hebrew"],
  [0x0600, 0x06ff, "Arabic"],
  [0x0900, 0x097f, "Devanagari"],
  [0x0e00, 0x0e7f, "Thai"],
  [0x10a0, 0x10ff, "Georgian"],
  [0x1e00, 0x1eff, "Latin Extended Additional"],
  [0x1f00, 0x1fff, "Greek Extended"],
  [0x2000, 0x206f, "General Punctuation"],
  [0x2070, 0x209f, "Superscripts and Subscripts"],
  [0x20a0, 0x20cf, "Currency Symbols"],
  [0x2100, 0x214f, "Letterlike Symbols"],
  [0x2150, 0x218f, "Number Forms"],
  [0x2190, 0x21ff, "Arrows"],
  [0x2200, 0x22ff, "Mathematical Operators"],
  [0x2300, 0x23ff, "Miscellaneous Technical"],
  [0x2500, 0x257f, "Box Drawing"],
  [0x25a0, 0x25ff, "Geometric Shapes"],
  [0x2600, 0x26ff, "Miscellaneous Symbols"],
  [0x2700, 0x27bf, "Dingbats"],
  [0x2c60, 0x2c7f, "Latin Extended-C"],
  [0x3000, 0x303f, "CJK Symbols and Punctuation"],
  [0x3040, 0x309f, "Hiragana"],
  [0x30a0, 0x30ff, "Katakana"],
  [0x4e00, 0x9fff, "CJK Unified Ideographs"],
  [0xa720, 0xa7ff, "Latin Extended-D"],
  [0xac00, 0xd7af, "Hangul Syllables"],
  [0xe000, 0xf8ff, "Private Use Area"],
  [0xfb00, 0xfb4f, "Alphabetic Presentation Forms"],
  [0xfe00, 0xfe0f, "Variation Selectors"],
  [0x1d400, 0x1d7ff, "Mathematical Alphanumeric Symbols"],
  [0x1f300, 0x1f5ff, "Miscellaneous Symbols and Pictographs"],
  [0x1f600, 0x1f64f, "Emoticons"],
  [0x1f900, 0x1f9ff, "Supplemental Symbols and Pictographs"],
];

export function blockOf(codePoint: number): string {
  for (const [start, end, name] of BLOCKS) {
    if (codePoint >= start && codePoint <= end) return name;
  }
  return "Other";
}

export interface BlockCount {
  name: string;
  count: number;
}

/** Code points grouped by unicode block, largest group first. */
export function summariseBlocks(codePoints: number[]): BlockCount[] {
  const counts = new Map<string, number>();
  for (const cp of codePoints) {
    const name = blockOf(cp);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* character selection                                                */
/* ------------------------------------------------------------------ */

export type PresetName =
  | "basic-latin"
  | "latin-1"
  | "latin-ext"
  | "greek"
  | "cyrillic"
  | "punctuation"
  | "digits"
  | "currency";

/** Inclusive code point ranges per preset. */
const PRESETS: Record<PresetName, [number, number][]> = {
  "basic-latin": [[0x0020, 0x007e]],
  "latin-1": [
    [0x0020, 0x007e],
    [0x00a0, 0x00ff],
  ],
  "latin-ext": [
    [0x0100, 0x024f],
    [0x1e00, 0x1eff],
    [0x2c60, 0x2c7f],
    [0xa720, 0xa7ff],
  ],
  greek: [[0x0370, 0x03ff]],
  cyrillic: [[0x0400, 0x04ff]],
  punctuation: [
    [0x0021, 0x002f],
    [0x003a, 0x0040],
    [0x005b, 0x0060],
    [0x007b, 0x007e],
    [0x00a1, 0x00a1],
    [0x00ab, 0x00ab],
    [0x00bb, 0x00bb],
    [0x00bf, 0x00bf],
    [0x2010, 0x2015],
    [0x2018, 0x201f],
    [0x2020, 0x2022],
    [0x2026, 0x2026],
    [0x2039, 0x203a],
  ],
  digits: [[0x0030, 0x0039]],
  currency: [
    [0x0024, 0x0024],
    [0x00a2, 0x00a5],
    [0x20a0, 0x20bf],
  ],
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** A selection larger than this is a mistake, not a request. */
const MAX_CODE_POINTS = 200_000;

export interface CharacterRequest {
  /** Literal characters to keep. Surrogate pairs are handled. */
  text?: string;
  /** A unicode-range style list, for example "U+0020-007E, U+00A0-00FF". */
  ranges?: string;
  /** Named blocks to add wholesale. */
  presets?: PresetName[];
}

function addRange(into: Set<number>, start: number, end: number): void {
  if (into.size + (end - start + 1) > MAX_CODE_POINTS) {
    throw badRange(
      `That selection covers more than ${MAX_CODE_POINTS.toLocaleString("en-US")} code points.`,
      "Narrow the ranges. A subset is meant to be smaller than the font, so a few thousand characters is already generous.",
    );
  }
  for (let cp = start; cp <= end; cp++) into.add(cp);
}

/**
 * Turns text, explicit ranges, and preset names into one sorted, unique list of
 * code points. Control characters are dropped: they have no glyph, so keeping
 * them would only pad the cmap.
 */
export function resolveCharacters(request: CharacterRequest): number[] {
  const selected = new Set<number>();

  for (const preset of request.presets ?? []) {
    const ranges = PRESETS[preset];
    if (!ranges) {
      throw badRange(
        `"${preset}" is not a known character preset.`,
        `Use one of: ${PRESET_NAMES.join(", ")}.`,
      );
    }
    for (const [start, end] of ranges) addRange(selected, start, end);
  }

  for (const char of request.text ?? "") {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 || cp === 0x7f) continue;
    selected.add(cp);
  }

  const rangeText = (request.ranges ?? "").trim();
  if (rangeText !== "") {
    for (const rawToken of rangeText.split(/[,;\s]+/)) {
      const token = rawToken.trim();
      if (token === "") continue;
      const match = /^(?:u\+)?([0-9a-f]{1,6})(?:-(?:u\+)?([0-9a-f]{1,6}))?$/i.exec(token);
      if (!match) {
        throw badRange(
          `"${token}" is not a unicode range.`,
          'Write ranges like "U+0020-007E, U+00A0-00FF". Hex only, with or without the U+ prefix.',
        );
      }
      const start = Number.parseInt(match[1], 16);
      const end = match[2] === undefined ? start : Number.parseInt(match[2], 16);
      if (end < start) {
        throw badRange(
          `The range "${token}" ends before it starts.`,
          "Put the lower code point first, for example U+0020-007E.",
        );
      }
      if (end > 0x10ffff) {
        throw badRange(
          `"${token}" goes past U+10FFFF, the last unicode code point.`,
          "Use a range inside U+0000-10FFFF.",
        );
      }
      addRange(selected, start, end);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* unicode-range and @font-face CSS                                   */
/* ------------------------------------------------------------------ */

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

/** `U+0041` for one code point, `U+0041-0043` for a run. */
export function unicodeRangeCss(codePoints: number[]): string {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cp = sorted[i];
    if (cp === previous + 1) {
      previous = cp;
      continue;
    }
    parts.push(start === previous ? `U+${hex(start)}` : `U+${hex(start)}-${hex(previous)}`);
    start = cp;
    previous = cp;
  }
  return parts.join(", ");
}

export interface FontFaceRequest {
  family: string;
  format: FontFormat;
  fileName: string;
  unicodeRange?: string;
  weight?: string;
  style?: string;
  display?: string;
}

export function fontFaceCss(request: FontFaceRequest): string {
  const lines = [
    "@font-face {",
    `  font-family: "${request.family.replace(/"/g, "'")}";`,
    `  src: url("${request.fileName}") format("${FORMAT_CSS[request.format]}");`,
    `  font-style: ${request.style ?? "normal"};`,
    `  font-weight: ${request.weight ?? "400"};`,
    `  font-display: ${request.display ?? "swap"};`,
  ];
  if (request.unicodeRange) lines.push(`  unicode-range: ${request.unicodeRange};`);
  lines.push("}");
  return lines.join("\n");
}

/** "Inter Tight" becomes "inter-tight-subset.woff2". */
export function subsetFileName(family: string, format: FontFormat): string {
  const stem =
    family
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "font";
  return `${stem}-subset.${format}`;
}

/* ------------------------------------------------------------------ */
/* inspection                                                         */
/* ------------------------------------------------------------------ */

const LAYOUT_TABLES = ["GSUB", "GPOS", "GDEF", "kern", "morx"];

export interface FontInfo {
  format: FontFormat;
  formatLabel: string;
  /** Size of the file exactly as it was handed in. */
  size: number;
  familyName: string;
  styleName: string;
  fullName: string;
  glyphCount: number;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** "truetype" or "cff", as opentype.js reports it. */
  outlines: string;
  /** Four character sfnt table tags, in directory order. */
  tables: string[];
  /** Layout tables present in the source that a rebuild cannot carry over. */
  layoutTables: string[];
  /** Every code point the font's cmap maps, sorted. */
  codePoints: number[];
  blocks: BlockCount[];
  /**
   * The bytes opentype.js was given. WOFF2 input is expanded first, so this is
   * a plain sfnt for .ttf, .otf, and .woff2 input. For .woff input it is the
   * original WOFF container, because opentype.js reads WOFF directly and
   * nothing here needs it unwrapped. Do not hand this straight to `toWoff` or
   * `toWoff2` without checking `format` first: both want an sfnt.
   */
  sfnt: Uint8Array;
  /** The parsed font, reused by `subsetFont` so a file is parsed once. */
  font: OtFont;
}

function pickName(names: OtNames, keys: string[]): string {
  for (const platform of ["windows", "unicode", "macintosh"]) {
    const table = names?.[platform];
    if (!table) continue;
    for (const key of keys) {
      const entry = table[key];
      if (!entry) continue;
      const value = entry.en ?? Object.values(entry)[0];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return "";
}

function parseFont(bytes: Uint8Array): OtFont {
  try {
    return opentype.parse(bytes);
  } catch (error) {
    throw notAFont(`This font could not be parsed (${(error as Error).message}).`);
  }
}

/** Reads a font's identity, coverage, and table list without changing it. */
export async function inspectFont(bytes: Uint8Array): Promise<FontInfo> {
  if (!bytes || bytes.length === 0) throw emptyInput();
  const format = detectFormat(bytes);

  // opentype.js reads .ttf, .otf, and .woff directly but refuses WOFF2, so
  // WOFF2 input is expanded first and every later step sees a plain sfnt.
  const sfnt = format === "woff2" ? await fromWoff2(bytes) : bytes;
  const font = parseFont(format === "woff2" ? sfnt : bytes);
  const tables =
    format === "woff" ? readWoffTags(bytes) : readSfntDirectory(sfnt).tables.map((t) => t.tag);

  const cmap = font.tables.cmap?.glyphIndexMap ?? {};
  const codePoints = Object.keys(cmap)
    .map((key) => Number(key))
    .filter((cp) => Number.isFinite(cp))
    .sort((a, b) => a - b);

  const familyName = pickName(font.names, ["fontFamily", "preferredFamily"]) || "Unnamed";
  const styleName = pickName(font.names, ["fontSubfamily", "preferredSubfamily"]) || "Regular";

  return {
    format,
    formatLabel: FORMAT_LABELS[format],
    size: bytes.length,
    familyName,
    styleName,
    fullName: pickName(font.names, ["fullName"]) || `${familyName} ${styleName}`.trim(),
    glyphCount: font.glyphs.length,
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    outlines: font.outlinesFormat ?? "unknown",
    tables,
    layoutTables: LAYOUT_TABLES.filter((tag) => tables.includes(tag)),
    codePoints,
    blocks: summariseBlocks(codePoints),
    sfnt,
    font,
  };
}

/* ------------------------------------------------------------------ */
/* subsetting                                                         */
/* ------------------------------------------------------------------ */

export interface SubsetOptions {
  /**
   * Keep the original .notdef outline, the box or question mark a browser
   * shows for an unmapped character. Glyph 0 is .notdef by definition in
   * OpenType, so the slot is always written; turning this off empties its
   * outline rather than promoting another glyph into slot 0.
   */
  keepNotdef?: boolean;
  /** Override the family name written into the subset. */
  familyName?: string;
  /** Override the style name written into the subset. */
  styleName?: string;
}

export interface SubsetResult {
  /**
   * The rebuilt font as an uncompressed sfnt. opentype.js 2.x writes CFF
   * outlines with the OTTO flavor, so these bytes are an .otf even when the
   * source was a .ttf. Name a download accordingly.
   */
  ttf: Uint8Array;
  /** Glyphs in the subset, including .notdef. */
  glyphCount: number;
  /** Requested code points the source font has no glyph for. */
  missing: number[];
  /** Requested code points the source font does map. */
  kept: number[];
  /** Layout tables the rebuild dropped, for example ["GSUB", "GPOS"]. */
  droppedTables: string[];
  info: FontInfo;
}

/**
 * Rebuilds a font from just the glyphs the requested characters need.
 *
 * Composite glyph components are deliberately not pulled in as extra glyphs.
 * opentype.js resolves a composite's components into a flat outline while
 * parsing, and its writer emits CFF charstrings, which have no composite
 * reference mechanism, so every component glyph added here would be an
 * unreachable charstring that only made the output bigger.
 */
export async function subsetFont(
  bytes: Uint8Array,
  codePoints: number[],
  options: SubsetOptions = {},
): Promise<SubsetResult> {
  const info = await inspectFont(bytes);
  if (codePoints.length === 0) {
    throw nothingKept(
      "No characters were selected, so there would be nothing to keep.",
      "Type the characters you need, pick a preset, or give a unicode range like U+0020-007E.",
    );
  }

  const cmap = info.font.tables.cmap?.glyphIndexMap ?? {};
  const kept: number[] = [];
  const missing: number[] = [];
  /** Glyph index to the code points that reach it. */
  const wanted = new Map<number, number[]>();

  for (const cp of codePoints) {
    const index = cmap[String(cp)];
    if (index === undefined || index === 0) {
      missing.push(cp);
      continue;
    }
    kept.push(cp);
    const list = wanted.get(index);
    if (list) list.push(cp);
    else wanted.set(index, [cp]);
  }

  if (kept.length === 0) {
    throw nothingKept(
      `None of the ${codePoints.length.toLocaleString("en-US")} selected characters exist in this font.`,
      "Check the Coverage row for the blocks this font actually supports, then select characters from one of them.",
    );
  }

  const glyphs: OtGlyph[] = [];
  try {
    const notdef = info.font.glyphs.get(0);
    glyphs.push(
      new opentype.Glyph({
        name: ".notdef",
        advanceWidth: notdef?.advanceWidth ?? Math.round(info.unitsPerEm / 2),
        path: options.keepNotdef === false ? new opentype.Path() : notdef.path,
      }),
    );

    for (const index of [...wanted.keys()].sort((a, b) => a - b)) {
      const glyph = info.font.glyphs.get(index);
      const unicodes = wanted.get(index) ?? [];
      glyphs.push(
        new opentype.Glyph({
          name: glyph.name || `uni${hex(unicodes[0])}`,
          unicodes,
          advanceWidth: glyph.advanceWidth ?? Math.round(info.unitsPerEm / 2),
          path: glyph.path,
        }),
      );
    }
  } catch (error) {
    throw subsetFailed((error as Error).message);
  }

  let ttf: Uint8Array;
  try {
    const subset = new opentype.Font({
      familyName: options.familyName ?? info.familyName,
      styleName: options.styleName ?? info.styleName,
      unitsPerEm: info.unitsPerEm,
      ascender: info.ascender,
      descender: info.descender,
      glyphs,
    });
    ttf = new Uint8Array(subset.toArrayBuffer());
  } catch (error) {
    throw subsetFailed((error as Error).message);
  }

  return {
    ttf,
    glyphCount: glyphs.length,
    missing,
    kept,
    droppedTables: info.layoutTables,
    info,
  };
}

/* ------------------------------------------------------------------ */
/* run                                                                */
/* ------------------------------------------------------------------ */

export interface FontSubsetterOpts {
  /** Literal characters to keep, on top of the preset. */
  text: string;
  /** Extra unicode ranges, for example "U+2018-201F". */
  ranges: string;
  /** basic-latin | latin-1 | latin-ext | greek | cyrillic | none. */
  preset: string;
  /** woff2 | woff | ttf (ttf writes an uncompressed OpenType file). */
  format: string;
  /** Add the digits and punctuation presets. */
  includeDigitsPunct: boolean;
  [key: string]: unknown;
}

/** The single-select preset in the panel maps onto a cumulative preset list. */
const PRESET_CHOICES: Record<string, PresetName[]> = {
  "basic-latin": ["basic-latin"],
  "latin-1": ["basic-latin", "latin-1"],
  "latin-ext": ["basic-latin", "latin-1", "latin-ext"],
  greek: ["basic-latin", "greek"],
  cyrillic: ["basic-latin", "cyrillic"],
  none: [],
};

const OUTPUT_FORMATS: Record<string, FontFormat> = {
  woff2: "woff2",
  woff: "woff",
  // opentype.js has no glyf writer, so the uncompressed flavor is always OTTO.
  ttf: "otf",
  otf: "otf",
};

/** Past this, an inline data URL is slower to copy than the file is to remake. */
const DATA_URL_LIMIT = 200 * 1024;

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInput();
    return input;
  }
  const trimmed = input.trim();
  if (trimmed === "") throw emptyInput();

  let payload = trimmed;
  const dataUrl = /^data:[^,]*,/.exec(trimmed);
  if (dataUrl) {
    if (!/;base64/i.test(dataUrl[0])) throw notAFont("That data URL is not base64 encoded.");
    payload = trimmed.slice(dataUrl[0].length);
  }

  const bytes = base64ToBytes(payload);
  if (!bytes || bytes.length === 0) {
    throw notAFont("A font is binary, so pasted text only works as base64 or as a data URL.");
  }
  return bytes;
}

function describeCodePoints(codePoints: number[], limit = 12): string {
  const shown = codePoints.slice(0, limit).map((cp) => {
    const char = cp > 0x20 && cp !== 0x7f ? ` ${String.fromCodePoint(cp)}` : "";
    return `U+${hex(cp)}${char}`;
  });
  const rest = codePoints.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? `, and ${rest.toLocaleString("en-US")} more` : ""}`;
}

function describeSaving(
  originalSize: number,
  outputSize: number,
  info: FontInfo,
  format: FontFormat,
): string {
  if (originalSize === 0) return "size unknown";
  const ratio = 1 - outputSize / originalSize;
  if (Math.abs(ratio) < 0.0005) return "the same size as the original";
  if (ratio > 0) return `${(ratio * 100).toFixed(1)}% smaller than the original`;
  const why =
    info.format === "woff2" && format !== "woff2"
      ? " because the original was already WOFF2 compressed and this output is not"
      : "";
  return `${(-ratio * 100).toFixed(1)}% larger than the original${why}`;
}

export async function run(
  input: Uint8Array | string,
  opts: FontSubsetterOpts,
): Promise<Record<string, string>> {
  const bytes = toBytes(input);

  const presetKey = opts?.preset ?? "basic-latin";
  const presets = PRESET_CHOICES[presetKey];
  if (!presets) {
    throw badRange(
      `"${presetKey}" is not a known preset.`,
      `Pick one of: ${Object.keys(PRESET_CHOICES).join(", ")}.`,
    );
  }
  const selectedPresets: PresetName[] = [...presets];
  if (opts?.includeDigitsPunct !== false) selectedPresets.push("digits", "punctuation");

  const requested = resolveCharacters({
    text: opts?.text ?? "",
    ranges: opts?.ranges ?? "",
    presets: selectedPresets,
  });

  const result = await subsetFont(bytes, requested);
  const info = result.info;

  const format = OUTPUT_FORMATS[opts?.format ?? "woff2"] ?? "woff2";
  let output: Uint8Array;
  if (format === "woff2") output = await toWoff2(result.ttf);
  else if (format === "woff") output = toWoff(result.ttf);
  else output = result.ttf;

  const range = unicodeRangeCss(result.kept);
  const fileName = subsetFileName(info.familyName, format);
  const coverage = info.blocks
    .slice(0, 6)
    .map((block) => `${block.name} (${block.count.toLocaleString("en-US")})`)
    .join(", ");

  const rows: Record<string, string> = {
    Original: `${info.formatLabel}, ${formatBytes(info.size)}, ${info.glyphCount.toLocaleString("en-US")} glyphs, ${info.fullName}, ${info.unitsPerEm} units per em`,
    Coverage: coverage === "" ? "no character map, so nothing is mapped" : coverage,
    "Kept characters": `${result.kept.length.toLocaleString("en-US")} of ${requested.length.toLocaleString("en-US")} selected`,
    Missing:
      result.missing.length === 0
        ? "none, the font has a glyph for every selected character"
        : `${result.missing.length.toLocaleString("en-US")}: ${describeCodePoints(result.missing)}`,
    "Subset glyphs": `${result.glyphCount.toLocaleString("en-US")} including .notdef`,
    Output: `${FORMAT_LABELS[format]}, ${formatBytes(output.length)}, ${describeSaving(info.size, output.length, info, format)}`,
    "Layout features":
      result.droppedTables.length === 0
        ? "the original had no GSUB, GPOS, GDEF, or kern table, so nothing was lost"
        : `${result.droppedTables.join(", ")} dropped. Ligatures, kerning, and the other OpenType features in those tables are not carried into the subset.`,
    "unicode-range": range,
    "@font-face CSS": fontFaceCss({
      family: info.familyName,
      format,
      fileName,
      unicodeRange: range,
    }),
    Download: `The generic panel shows text, so it cannot hand you a file. The Font Subsetter panel saves the subset as ${fileName}.`,
    "Data URL":
      output.length <= DATA_URL_LIMIT
        ? `data:${FORMAT_MIME[format]};base64,${toBase64(output)}`
        : `skipped, the subset is ${formatBytes(output.length)} and the inline limit here is ${formatBytes(DATA_URL_LIMIT)}`,
  };

  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  FontSubsetterOpts
>;
