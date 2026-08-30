import { unzipSync, strFromU8 } from "fflate";
import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * XLSX reader, hand rolled on top of fflate.
 *
 * An .xlsx file is a zip of XML parts, so the whole job is unzip plus parse.
 * There is no XML parser here beyond the tokenizer below, deliberately:
 * `DOMParser` only exists in a browser, and rule 27 says this layer has to run
 * unchanged in Node so the tests can be real. The tokenizer is a few hundred
 * bytes of state machine and covers what the SpreadsheetML parts actually
 * contain: self closing tags, quoted attributes, CDATA, entities, and nothing
 * exotic.
 *
 * Everything below is pure. The panel decides what to ask for and how to draw
 * it; the formatting decisions (which serial numbers are dates, how a percent
 * renders, what a merged range covers) all live here so they are testable.
 */

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/** Refuse anything past this: the archive is inflated wholly in memory. */
const MAX_BYTES = 100 * 1024 * 1024;

/** Default rows kept per sheet. The panel asks for its own budget. */
const DEFAULT_MAX_ROWS = 5000;
const MAX_MAX_ROWS = 200000;

/** Guard against a sheet that declares one cell in the last column. */
const MAX_COLUMNS = 1024;

/** Rows rendered by `run()`'s text views before it stops. */
const DEFAULT_RUN_ROWS = 50;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** One tag or run of text from the tokenizer. */
export type XmlToken =
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/** A merged range, both as written ("A1:C1") and as zero based bounds. */
export interface MergeRange {
  ref: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface WorkbookSheet {
  name: string;
  /** Position in the workbook's own tab order, zero based. */
  index: number;
  /** "visible", "hidden" or "veryHidden", as the workbook declares it. */
  state: string;
  /** Formatted cell text, rectangular, row major. */
  rows: string[][];
  merges: MergeRange[];
  /** Rows the sheet holds, which may exceed the rows loaded here. */
  rowCount: number;
  colCount: number;
  /** True when the sheet holds more rows than the load budget allowed. */
  truncated: boolean;
}

export interface Workbook {
  /** "xlsx", "xlsm" or "csv". */
  format: string;
  sheets: WorkbookSheet[];
  /** True when the workbook counts days from 1904 instead of 1900. */
  date1904: boolean;
  /** Size of the input in bytes. */
  fileSize: number;
}

export interface ReadWorkbookOptions {
  /** Rows to load per sheet. Default 5000, hard ceiling 200000. */
  maxRows?: number;
}

export interface XlsxOpts {
  /** Sheet name, or a 1 based index. Empty means the first sheet. */
  sheet: string;
  /** table | csv | json | markdown | summary */
  view: string;
  /** Rows included in the rendered view. */
  rows: number;
  /** Treat the first row as column names in the JSON and Markdown views. */
  header: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* XML tokenizer                                                       */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** The five XML entities plus decimal and hex character references. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? codePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? codePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function codePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Skip a `<!...>` declaration, honoring a bracketed internal subset. */
function skipDeclaration(xml: string, start: number): number {
  let i = start + 2;
  let depth = 0;
  while (i < xml.length) {
    const ch = xml[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth <= 0) return i + 1;
    i++;
  }
  return xml.length;
}

/** Attributes of one tag, from just past the tag name to just before `>`. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i] as string)) i++;
    if (i >= source.length) break;

    const nameStart = i;
    while (i < source.length && !/[\s=]/.test(source[i] as string)) i++;
    const name = source.slice(nameStart, i);
    if (!name) break;

    while (i < source.length && /\s/.test(source[i] as string)) i++;
    if (source[i] !== "=") {
      // A valueless attribute is not legal XML, but tolerate it rather than
      // dropping the rest of the tag on the floor.
      attrs[name] = "";
      continue;
    }
    i++;
    while (i < source.length && /\s/.test(source[i] as string)) i++;

    const quote = source[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valueStart = i;
      while (i < source.length && source[i] !== quote) i++;
      attrs[name] = decodeEntities(source.slice(valueStart, i));
      i++;
    } else {
      const valueStart = i;
      while (i < source.length && !/\s/.test(source[i] as string)) i++;
      attrs[name] = decodeEntities(source.slice(valueStart, i));
    }
  }
  return attrs;
}

/**
 * Walk an XML string as a flat token stream.
 *
 * A generator rather than a tree: a worksheet part for a large sheet is tens of
 * megabytes of XML, and building a node object per cell costs far more than the
 * strings the caller actually keeps.
 */
export function* tokenizeXml(xml: string): Generator<XmlToken> {
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail) yield { kind: "text", text: decodeEntities(tail) };
      return;
    }
    if (lt > i) yield { kind: "text", text: decodeEntities(xml.slice(i, lt)) };

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      // CDATA content is literal: entities inside it are not entities.
      const raw = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      if (raw) yield { kind: "text", text: raw };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      i = skipDeclaration(xml, lt);
      continue;
    }

    if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      if (end === -1) return;
      yield { kind: "close", name: xml.slice(lt + 2, end).trim() };
      i = end + 1;
      continue;
    }

    // An open tag. Find its `>`, skipping any that sits inside a quoted value.
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = xml[j] as string;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    if (j >= n) return;

    let body = xml.slice(lt + 1, j);
    let selfClosing = false;
    if (body.endsWith("/")) {
      selfClosing = true;
      body = body.slice(0, -1);
    }

    let k = 0;
    while (k < body.length && !/\s/.test(body[k] as string)) k++;
    const name = body.slice(0, k);
    const attrs = k < body.length ? parseAttributes(body.slice(k)) : {};

    yield { kind: "open", name, attrs, selfClosing };
    i = j + 1;
  }
}

/** Strip a namespace prefix: "r:id" reads as "id", "xdr:col" as "col". */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/* ------------------------------------------------------------------ */
/* cell references                                                     */
/* ------------------------------------------------------------------ */

/** Column index (zero based) to its spreadsheet letters: 0 to "A", 27 to "AB". */
export function columnLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = "";
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/** "BC12" to { col: 54, row: 11 }, both zero based. Null when unparseable. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const letters = (match[1] as string).toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  const row = Number.parseInt(match[2] as string, 10);
  if (!Number.isFinite(row) || row < 1) return null;
  return { col: col - 1, row: row - 1 };
}

/* ------------------------------------------------------------------ */
/* number formats                                                      */
/* ------------------------------------------------------------------ */

/**
 * The built in format codes worth naming. Anything else the file uses arrives
 * as a custom `numFmt` entry, so this only has to cover the ids Excel never
 * writes out.
 */
const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/** What a format code means for rendering, worked out once per style. */
interface FormatShape {
  code: string;
  date: boolean;
  time: boolean;
  /** True for `[h]`, where hours run past 24 as elapsed time. */
  elapsed: boolean;
  percent: boolean;
  decimals: number;
  grouped: boolean;
  text: boolean;
}

/**
 * Drop the parts of a format code that are literals rather than placeholders:
 * quoted runs, bracketed conditions and color names, and backslash escapes.
 * What remains is the part that says what the number means.
 */
function formatSkeleton(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    if (ch === '"') {
      i++;
      while (i < code.length && code[i] !== '"') i++;
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < code.length && code[i] !== "]") i++;
      i++;
      continue;
    }
    if (ch === "\\" || ch === "_" || ch === "*") {
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function classifyFormat(rawCode: string): FormatShape {
  // Only the first section applies to a positive value, which is the case that
  // decides whether a cell reads as a date, a percent, or a plain number.
  const code = (rawCode.split(";")[0] ?? rawCode).trim();
  const skeleton = formatSkeleton(code).toLowerCase();

  const percent = skeleton.includes("%");
  const hasHourOrSecond = /[hs]/.test(skeleton);
  const hasYearOrDay = /[yd]/.test(skeleton);
  // "m" is minutes next to a clock and months otherwise, so it only counts as a
  // date token when no clock token shares the code.
  const date = hasYearOrDay || (/m/.test(skeleton) && !hasHourOrSecond);
  const time = hasHourOrSecond;
  const elapsed = /\[\s*h+\s*\]/i.test(code) || /\[\s*m+\s*\]/i.test(code);

  const decimalMatch = /\.([0#?]+)/.exec(skeleton);
  const decimals = decimalMatch ? (decimalMatch[1] as string).length : 0;
  const grouped = skeleton.includes("#,#") || skeleton.includes("0,0");

  return {
    code,
    date: date && !percent,
    time: time && !percent,
    elapsed,
    percent,
    decimals,
    grouped,
    text: skeleton.trim() === "@",
  };
}

/* ------------------------------------------------------------------ */
/* number and date rendering                                           */
/* ------------------------------------------------------------------ */

/** Days between 1899-12-30 (the 1900 system's zero) and 1970-01-01. */
const EPOCH_OFFSET_1900 = 25569;
/** Days between the 1904 system's zero and 1970-01-01. */
const EPOCH_OFFSET_1904 = 24107;
const MS_PER_DAY = 86400000;

function pad(value: number, width = 2): string {
  return String(Math.floor(Math.abs(value))).padStart(width, "0");
}

/**
 * An Excel serial number as an ISO-8601 UTC string.
 *
 * The 1900 system counts a February 29th that 1900 never had, so serials at or
 * below 59 sit one day later than the naive arithmetic says, and serial 60 is
 * the phantom day itself. Rendering it as anything real would be a lie, so it
 * comes back as the date the file means, spelled out.
 */
export function serialToIso(serial: number, date1904: boolean, withTime: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);

  if (!date1904 && Math.floor(serial) === 60) {
    const fraction = serial - Math.floor(serial);
    return withTime ? `1900-02-29T${clockFromFraction(fraction)}Z` : "1900-02-29";
  }

  const offset = date1904
    ? EPOCH_OFFSET_1904
    : serial < 60
      ? EPOCH_OFFSET_1900 - 1
      : EPOCH_OFFSET_1900;

  const ms = Math.round((serial - offset) * MS_PER_DAY);
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return String(serial);

  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  if (!withTime) return day;
  return `${day}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}Z`;
}

/** The clock part of a day fraction, as HH:MM:SS. */
function clockFromFraction(fraction: number): string {
  const seconds = Math.round(Math.abs(fraction) * 86400) % 86400;
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/** Elapsed time (`[h]:mm:ss`), where the hours are a running total. */
function elapsedFromSerial(serial: number): string {
  const sign = serial < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(serial) * 86400);
  const hours = Math.floor(totalSeconds / 3600);
  return `${sign}${hours}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
}

/** Group the integer part in threes without asking the runtime's locale. */
function groupDigits(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

function fixedNumber(value: number, decimals: number, grouped: boolean): string {
  const text = value.toFixed(decimals);
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? "" : body.slice(dot);
  return `${negative ? "-" : ""}${grouped ? groupDigits(whole) : whole}${rest}`;
}

/**
 * A number the way Excel's General format shows it: no exponent for ordinary
 * magnitudes, and float noise trimmed. A cell that stores 0.1 + 0.2 shows 0.3,
 * which is what the spreadsheet shows too.
 */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const trimmed = Number(value.toPrecision(12));
  return String(trimmed);
}

/** Render one numeric cell through its style's number format. */
export function formatNumericCell(value: number, shape: FormatShape, date1904: boolean): string {
  if (shape.percent) return `${fixedNumber(value * 100, shape.decimals, shape.grouped)}%`;
  if (shape.elapsed && shape.time && !shape.date) return elapsedFromSerial(value);
  if (shape.date) return serialToIso(value, date1904, shape.time);
  if (shape.time) return clockFromFraction(value - Math.floor(value));
  if (shape.decimals > 0 || shape.grouped) {
    return fixedNumber(value, shape.decimals, shape.grouped);
  }
  return generalNumber(value);
}

/* ------------------------------------------------------------------ */
/* zip helpers                                                         */
/* ------------------------------------------------------------------ */

type ZipParts = Record<string, Uint8Array>;

/** Case insensitive part lookup: producers disagree on `xl/` vs `XL/`. */
function findPart(parts: ZipParts, path: string): Uint8Array | undefined {
  const direct = parts[path];
  if (direct) return direct;
  const wanted = path.toLowerCase();
  for (const key of Object.keys(parts)) {
    if (key.toLowerCase() === wanted) return parts[key];
  }
  return undefined;
}

function partText(parts: ZipParts, path: string): string | undefined {
  const bytes = findPart(parts, path);
  return bytes ? strFromU8(bytes) : undefined;
}

/** Resolve a relationship target against the part that declared it. */
function resolveTarget(target: string, baseDir: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/* ------------------------------------------------------------------ */
/* part parsers                                                        */
/* ------------------------------------------------------------------ */

interface SheetRef {
  name: string;
  state: string;
  rid: string;
}

interface WorkbookHeader {
  sheets: SheetRef[];
  date1904: boolean;
}

function parseWorkbookXml(xml: string): WorkbookHeader {
  const sheets: SheetRef[] = [];
  let date1904 = false;

  for (const token of tokenizeXml(xml)) {
    if (token.kind !== "open") continue;
    const name = localName(token.name);
    if (name === "sheet") {
      sheets.push({
        name: token.attrs.name ?? `Sheet${sheets.length + 1}`,
        state: token.attrs.state ?? "visible",
        rid: token.attrs["r:id"] ?? token.attrs.id ?? "",
      });
    } else if (name === "workbookPr") {
      const flag = token.attrs.date1904 ?? token.attrs.dateCompatibility ?? "";
      date1904 = flag === "1" || flag.toLowerCase() === "true";
    }
  }

  return { sheets, date1904 };
}

/** rId to part path, resolved against `xl/`. */
function parseRelationships(xml: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of tokenizeXml(xml)) {
    if (token.kind !== "open" || localName(token.name) !== "Relationship") continue;
    const id = token.attrs.Id ?? token.attrs.id;
    const target = token.attrs.Target ?? token.attrs.target;
    if (!id || !target) continue;
    // An external target points outside the package; there is nothing to read.
    if ((token.attrs.TargetMode ?? "") === "External") continue;
    map.set(id, resolveTarget(target, baseDir));
  }
  return map;
}

/**
 * The shared string table.
 *
 * Every `<si>` is one string, and a string with mixed formatting arrives as a
 * run of `<r><t>` pieces that concatenate. `xml:space="preserve"` matters: the
 * leading spaces in " total" are content, not indentation.
 */
export function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let inItem = false;
  let inText = false;
  let current = "";

  for (const token of tokenizeXml(xml)) {
    if (token.kind === "open") {
      const name = localName(token.name);
      if (name === "si") {
        inItem = true;
        current = "";
        if (token.selfClosing) {
          strings.push("");
          inItem = false;
        }
      } else if (name === "t" && inItem) {
        inText = !token.selfClosing;
      }
    } else if (token.kind === "close") {
      const name = localName(token.name);
      if (name === "t") inText = false;
      else if (name === "si" && inItem) {
        strings.push(current);
        inItem = false;
        current = "";
      }
    } else if (token.kind === "text" && inText) {
      current += token.text;
    }
  }

  return strings;
}

/** Style index to the format code it resolves to. */
export function parseStyles(xml: string): string[] {
  const custom = new Map<number, string>();
  const styleFormats: number[] = [];
  let inCellXfs = false;

  for (const token of tokenizeXml(xml)) {
    if (token.kind === "open") {
      const name = localName(token.name);
      if (name === "numFmt") {
        const id = Number.parseInt(token.attrs.numFmtId ?? "", 10);
        const code = token.attrs.formatCode ?? "";
        if (Number.isFinite(id)) custom.set(id, code);
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        const id = Number.parseInt(token.attrs.numFmtId ?? "0", 10);
        styleFormats.push(Number.isFinite(id) ? id : 0);
      }
    } else if (token.kind === "close" && localName(token.name) === "cellXfs") {
      inCellXfs = false;
    }
  }

  return styleFormats.map((id) => custom.get(id) ?? BUILTIN_FORMATS[id] ?? "General");
}

interface SheetParseResult {
  rows: string[][];
  merges: MergeRange[];
  rowCount: number;
  colCount: number;
  truncated: boolean;
}

interface SheetParseContext {
  sharedStrings: string[];
  /** Format code per style index, from `cellXfs`. */
  styleFormats: string[];
  date1904: boolean;
  maxRows: number;
}

/**
 * Parse one worksheet part into rectangular text.
 *
 * Cells are sparse in the file and rows may skip indexes entirely, so values
 * land in a map keyed by row and are materialized into a rectangle at the end.
 * A row past the budget is dropped as it is read rather than kept and sliced:
 * a sheet can declare a row at index 1048576 and holding the gap would cost a
 * million empty arrays.
 */
export function parseWorksheet(xml: string, context: SheetParseContext): SheetParseResult {
  const { sharedStrings, styleFormats, date1904, maxRows } = context;

  const shapeCache = new Map<string, FormatShape>();
  const shapeFor = (styleIndex: number): FormatShape => {
    const code = styleFormats[styleIndex] ?? "General";
    let shape = shapeCache.get(code);
    if (!shape) {
      shape = classifyFormat(code);
      shapeCache.set(code, shape);
    }
    return shape;
  };

  const cellsByRow = new Map<number, Map<number, string>>();
  const merges: MergeRange[] = [];

  let maxRowSeen = -1;
  let maxColSeen = -1;
  let truncated = false;

  let inSheetData = false;
  let rowIndex = -1;
  let autoRow = -1;

  let cellRow = -1;
  let cellCol = -1;
  let autoCol = -1;
  let cellType = "n";
  let cellStyle = 0;
  let inCell = false;
  let inValue = false;
  let inInlineString = false;
  let inInlineText = false;
  let valueText = "";
  let inlineText = "";

  for (const token of tokenizeXml(xml)) {
    if (token.kind === "open") {
      const name = localName(token.name);

      if (name === "sheetData") {
        inSheetData = !token.selfClosing;
        continue;
      }
      if (name === "mergeCell") {
        const ref = token.attrs.ref ?? "";
        const range = parseRange(ref);
        if (range) merges.push(range);
        continue;
      }
      if (!inSheetData) continue;

      if (name === "row") {
        const declared = Number.parseInt(token.attrs.r ?? "", 10);
        autoRow = Number.isFinite(declared) && declared >= 1 ? declared - 1 : autoRow + 1;
        rowIndex = autoRow;
        autoCol = -1;
        if (rowIndex > maxRowSeen) maxRowSeen = rowIndex;
        if (rowIndex >= maxRows) truncated = true;
        continue;
      }

      if (name === "c") {
        const ref = token.attrs.r ? parseCellRef(token.attrs.r) : null;
        if (ref) {
          cellRow = ref.row;
          cellCol = ref.col;
          autoCol = ref.col;
        } else {
          cellRow = rowIndex;
          cellCol = ++autoCol;
        }
        cellType = token.attrs.t ?? "n";
        const styleAttr = Number.parseInt(token.attrs.s ?? "0", 10);
        cellStyle = Number.isFinite(styleAttr) ? styleAttr : 0;
        inCell = !token.selfClosing;
        valueText = "";
        inlineText = "";
        if (token.selfClosing) {
          // `<c r="B2" s="3"/>` carries a style and no value: nothing to store.
          inCell = false;
        }
        continue;
      }

      if (!inCell) continue;
      if (name === "v") inValue = !token.selfClosing;
      else if (name === "is") inInlineString = !token.selfClosing;
      else if (name === "t" && inInlineString) inInlineText = !token.selfClosing;
      continue;
    }

    if (token.kind === "close") {
      const name = localName(token.name);
      if (name === "sheetData") {
        inSheetData = false;
      } else if (name === "v") {
        inValue = false;
      } else if (name === "t") {
        inInlineText = false;
      } else if (name === "is") {
        inInlineString = false;
      } else if (name === "c" && inCell) {
        inCell = false;
        if (cellRow < 0 || cellRow >= maxRows || cellCol < 0 || cellCol >= MAX_COLUMNS) {
          if (cellRow >= maxRows) truncated = true;
          continue;
        }
        const text = renderCell({
          type: cellType,
          value: valueText,
          inline: inlineText,
          shape: shapeFor(cellStyle),
          sharedStrings,
          date1904,
        });
        if (text !== "") {
          let row = cellsByRow.get(cellRow);
          if (!row) {
            row = new Map<number, string>();
            cellsByRow.set(cellRow, row);
          }
          row.set(cellCol, text);
          if (cellCol > maxColSeen) maxColSeen = cellCol;
          if (cellRow > maxRowSeen) maxRowSeen = cellRow;
        }
      }
      continue;
    }

    if (inValue) valueText += token.text;
    else if (inInlineText) inlineText += token.text;
  }

  for (const merge of merges) {
    if (merge.endCol > maxColSeen && merge.endCol < MAX_COLUMNS) maxColSeen = merge.endCol;
    if (merge.endRow > maxRowSeen) maxRowSeen = merge.endRow;
  }

  const rowCount = maxRowSeen + 1;
  const colCount = maxColSeen + 1;
  const loadedRows = Math.min(rowCount, maxRows);

  const rows: string[][] = [];
  for (let r = 0; r < loadedRows; r++) {
    const source = cellsByRow.get(r);
    const row: string[] = new Array<string>(colCount).fill("");
    if (source) {
      for (const [col, text] of source) {
        if (col < colCount) row[col] = text;
      }
    }
    rows.push(row);
  }

  return { rows, merges, rowCount, colCount, truncated: truncated || rowCount > loadedRows };
}

function parseRange(ref: string): MergeRange | null {
  const [from, to] = ref.split(":");
  if (!from) return null;
  const start = parseCellRef(from);
  if (!start) return null;
  const end = to ? parseCellRef(to) : start;
  if (!end) return null;
  return {
    ref,
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

interface RenderCellInput {
  type: string;
  value: string;
  inline: string;
  shape: FormatShape;
  sharedStrings: string[];
  date1904: boolean;
}

const ERROR_HINTS: Record<string, string> = {
  "#DIV/0!": "#DIV/0!",
  "#N/A": "#N/A",
  "#NAME?": "#NAME?",
  "#NULL!": "#NULL!",
  "#NUM!": "#NUM!",
  "#REF!": "#REF!",
  "#VALUE!": "#VALUE!",
};

/** One cell's display text. Formulas render their cached result, as Excel does. */
function renderCell(input: RenderCellInput): string {
  const { type, value, inline, shape, sharedStrings, date1904 } = input;

  switch (type) {
    case "s": {
      const index = Number.parseInt(value.trim(), 10);
      return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
    }
    case "inlineStr":
      return inline;
    case "str":
      return value;
    case "b":
      return value.trim() === "1" ? "TRUE" : "FALSE";
    case "e":
      return ERROR_HINTS[value.trim()] ?? value.trim();
    case "d":
      // ISO 8601 dates, written directly by newer producers.
      return value.trim();
    default: {
      const trimmed = value.trim();
      if (trimmed === "") return inline;
      const number = Number(trimmed);
      if (!Number.isFinite(number)) return trimmed;
      if (shape.text) return trimmed;
      return formatNumericCell(number, shape, date1904);
    }
  }
}

/* ------------------------------------------------------------------ */
/* CSV passthrough                                                     */
/* ------------------------------------------------------------------ */

/**
 * RFC 4180 with the tolerances real files need: CRLF or LF, a doubled quote
 * inside a quoted field, and a delimiter guessed from the first line so tab and
 * semicolon files open too.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter ?? guessDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing blank lines are formatting, not data.
  while (rows.length > 0) {
    const last = rows[rows.length - 1] as string[];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  return rows;
}

/** The delimiter that splits the first line into the most fields. */
function guessDelimiter(text: string): string {
  const line = text.slice(0, text.search(/\r|\n/) === -1 ? 4096 : text.search(/\r|\n/));
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", "\t", ";", "|"]) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === candidate) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function sheetFromGrid(name: string, grid: string[][], maxRows: number): WorkbookSheet {
  const rowCount = grid.length;
  let colCount = 0;
  for (const row of grid) colCount = Math.max(colCount, row.length);
  colCount = Math.min(colCount, MAX_COLUMNS);

  const rows = grid.slice(0, maxRows).map((row) => {
    const padded: string[] = new Array<string>(colCount).fill("");
    for (let i = 0; i < colCount; i++) padded[i] = row[i] ?? "";
    return padded;
  });

  return {
    name,
    index: 0,
    state: "visible",
    rows,
    merges: [],
    rowCount,
    colCount,
    truncated: rowCount > rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return ZIP_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** An empty or truncated zip still starts with "PK", so say so specifically. */
function looksLikeEmptyZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b && !isZip(bytes);
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string {
  return strFromU8(bytes);
}

/* ------------------------------------------------------------------ */
/* the reader                                                          */
/* ------------------------------------------------------------------ */

/**
 * Open a workbook.
 *
 * Accepts the bytes of an .xlsx or .xlsm file, or CSV/TSV text (as a string, or
 * as the bytes of a text file). A CSV comes back as a one sheet workbook so the
 * panel can render both through the same grid.
 */
export function readWorkbook(
  input: Uint8Array | string,
  options: ReadWorkbookOptions = {},
): Workbook {
  const maxRows = Math.max(1, Math.min(options.maxRows ?? DEFAULT_MAX_ROWS, MAX_MAX_ROWS));

  if (typeof input === "string") {
    if (input.trim() === "") {
      throw new ToolError(
        "empty-input",
        "No spreadsheet to read.",
        "Drop an .xlsx, .xlsm or .csv file onto the input, or paste delimited text.",
      );
    }
    const grid = parseDelimited(input);
    return {
      format: "csv",
      sheets: [sheetFromGrid("Pasted data", grid, maxRows)],
      date1904: false,
      fileSize: input.length,
    };
  }

  if (input.length === 0) {
    throw new ToolError(
      "empty-input",
      "That file is empty.",
      "Pick an .xlsx, .xlsm or .csv file that has some content in it.",
    );
  }
  if (input.length > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `That file is ${formatBytes(input.length)}, past the ${formatBytes(MAX_BYTES)} limit for reading a workbook in the browser.`,
      "Open it in a spreadsheet app and save a smaller range, or split the sheets into separate files.",
    );
  }

  if (!isZip(input)) {
    if (looksLikeEmptyZip(input)) {
      throw new ToolError(
        "invalid-xlsx",
        "That file starts like a zip archive but the entry header is incomplete, so it is not a readable workbook.",
        "Re-download or re-export the file; it was probably truncated in transfer.",
      );
    }
    if (looksBinary(input)) {
      throw new ToolError(
        "unsupported-format",
        "That is not an .xlsx workbook: it has no zip header, and its bytes are not text either.",
        "An .xls file from Excel 97 to 2003 is a different format entirely. Open it in a spreadsheet app and save as .xlsx or .csv first.",
      );
    }
    const grid = parseDelimited(decodeUtf8(input));
    return {
      format: "csv",
      sheets: [sheetFromGrid("Sheet1", grid, maxRows)],
      date1904: false,
      fileSize: input.length,
    };
  }

  let parts: ZipParts;
  try {
    parts = unzipSync(input) as ZipParts;
  } catch (cause) {
    throw new ToolError(
      "invalid-xlsx",
      `The zip container could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`,
      "The file may be truncated or password protected. Try re-saving it from your spreadsheet app.",
    );
  }

  const workbookXml =
    partText(parts, "xl/workbook.xml") ??
    partText(parts, "xl/workbook2.xml") ??
    findWorkbookPart(parts);

  if (!workbookXml) {
    throw new ToolError(
      "invalid-xlsx",
      "That zip file has no xl/workbook.xml part, so it is not an Excel workbook.",
      "DOCX, PPTX and ODS files are also zips but hold different parts. Check that the file really is an .xlsx or .xlsm.",
    );
  }

  const header = parseWorkbookXml(workbookXml);
  if (header.sheets.length === 0) {
    throw new ToolError(
      "no-sheets",
      "This workbook declares no sheets.",
      "Open it in a spreadsheet app, confirm it has at least one sheet, and save it again.",
    );
  }

  const rels = parseRelationships(partText(parts, "xl/_rels/workbook.xml.rels") ?? "", "xl");
  const sharedStrings = parseSharedStrings(partText(parts, "xl/sharedStrings.xml") ?? "");
  const styleFormats = parseStyles(partText(parts, "xl/styles.xml") ?? "");

  const macroEnabled =
    findPart(parts, "xl/vbaProject.bin") !== undefined ||
    (partText(parts, "[Content_Types].xml") ?? "").includes("macroEnabled");

  const sheets: WorkbookSheet[] = [];
  header.sheets.forEach((ref, i) => {
    const path = rels.get(ref.rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
    const xml = partText(parts, path);
    if (xml === undefined) {
      // A chartsheet or a dialog sheet has no grid to show. Keep the tab so the
      // workbook's own order still reads correctly.
      sheets.push({
        name: ref.name,
        index: i,
        state: ref.state,
        rows: [],
        merges: [],
        rowCount: 0,
        colCount: 0,
        truncated: false,
      });
      return;
    }
    const parsed = parseWorksheet(xml, {
      sharedStrings,
      styleFormats,
      date1904: header.date1904,
      maxRows,
    });
    sheets.push({
      name: ref.name,
      index: i,
      state: ref.state,
      rows: parsed.rows,
      merges: parsed.merges,
      rowCount: parsed.rowCount,
      colCount: parsed.colCount,
      truncated: parsed.truncated,
    });
  });

  return {
    format: macroEnabled ? "xlsm" : "xlsx",
    sheets,
    date1904: header.date1904,
    fileSize: input.length,
  };
}

/** Last resort when the workbook part is not where the standard puts it. */
function findWorkbookPart(parts: ZipParts): string | undefined {
  for (const key of Object.keys(parts)) {
    if (/(^|\/)workbook\.xml$/i.test(key)) return partText(parts, key);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* views and exporters                                                 */
/* ------------------------------------------------------------------ */

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The sheet as RFC 4180 CSV, CRLF terminated. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/**
 * The sheet as JSON.
 *
 * With a header row, every row becomes an object keyed by the header text, with
 * a blank or duplicate header falling back to its column letter so no value is
 * silently dropped. Without one, every row stays an array.
 */
export function toJson(rows: string[][], header: boolean): string {
  if (rows.length === 0) return "[]";
  if (!header) return JSON.stringify(rows, null, 2);

  const headerRow = rows[0] as string[];
  const used = new Set<string>();
  const keys = headerRow.map((cell, i) => {
    const base = cell.trim() || columnLetter(i);
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}_${n++}`;
    used.add(key);
    return key;
  });

  const objects = rows.slice(1).map((row) => {
    const object: Record<string, string> = {};
    keys.forEach((key, i) => {
      object[key] = row[i] ?? "";
    });
    return object;
  });
  return JSON.stringify(objects, null, 2);
}

/** The sheet as a GitHub flavored Markdown table. */
export function toMarkdown(rows: string[][], header: boolean): string {
  if (rows.length === 0) return "";
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const escape = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const line = (row: string[]) => {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push(escape(row[i] ?? ""));
    return `| ${cells.join(" | ")} |`;
  };

  const headerRow = header
    ? (rows[0] as string[])
    : Array.from({ length: width }, (_, i) => columnLetter(i));
  const body = header ? rows.slice(1) : rows;

  const out = [line(headerRow), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
  for (const row of body) out.push(line(row));
  return out.join("\n");
}

/** A fixed width text grid with column letters, for the plain text view. */
export function toTextTable(sheet: WorkbookSheet, limit: number): string {
  const rows = sheet.rows.slice(0, limit);
  if (rows.length === 0) return "This sheet has no cells.";

  const width = sheet.colCount || 1;
  const headers = Array.from({ length: width }, (_, i) => columnLetter(i));
  const gutter = String(rows.length).length + 1;

  const widths = headers.map((letter, i) => {
    let max = letter.length;
    for (const row of rows) max = Math.max(max, (row[i] ?? "").length);
    return Math.min(Math.max(max, 3), 40);
  });

  const clip = (value: string, size: number) =>
    (value.length > size ? `${value.slice(0, size - 1)}…` : value).padEnd(size);

  const lines = [
    `${"".padEnd(gutter)}${headers.map((letter, i) => clip(letter, widths[i] as number)).join(" ")}`,
    `${"".padEnd(gutter)}${widths.map((size) => "-".repeat(size)).join(" ")}`,
  ];
  rows.forEach((row, r) => {
    const cells = widths.map((size, i) => clip(row[i] ?? "", size));
    lines.push(`${String(r + 1).padEnd(gutter)}${cells.join(" ")}`);
  });
  return lines.join("\n");
}

/**
 * Sort a sheet's rows by one column, comparing numbers as numbers and
 * everything else as text. Blank cells always sink to the bottom so a sparse
 * column does not bury the values you sorted to see.
 */
export function sortRows(rows: string[][], column: number, descending: boolean): string[][] {
  const indexed = rows.map((row, i) => ({ row, i }));
  const direction = descending ? -1 : 1;

  indexed.sort((a, b) => {
    const left = a.row[column] ?? "";
    const right = b.row[column] ?? "";
    if (left === right) return a.i - b.i;
    if (left === "") return 1;
    if (right === "") return -1;

    const leftNumber = Number(left.replace(/,/g, ""));
    const rightNumber = Number(right.replace(/,/g, ""));
    if (
      Number.isFinite(leftNumber) &&
      Number.isFinite(rightNumber) &&
      left !== "" &&
      right !== ""
    ) {
      return (leftNumber - rightNumber) * direction || a.i - b.i;
    }
    return left.localeCompare(right, "en") * direction || a.i - b.i;
  });

  return indexed.map((entry) => entry.row);
}

/** Rows holding `needle` in any cell, case insensitively. */
export function filterRows(rows: string[][], needle: string): string[][] {
  const query = needle.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(query)));
}

/** Pick a sheet by name, or by a 1 based index, or the first one. */
export function pickSheet(workbook: Workbook, wanted: string): WorkbookSheet {
  const trimmed = wanted.trim();
  if (!trimmed) return workbook.sheets[0] as WorkbookSheet;

  const byName = workbook.sheets.find((sheet) => sheet.name === trimmed);
  if (byName) return byName;

  const lower = trimmed.toLowerCase();
  const byLowerName = workbook.sheets.find((sheet) => sheet.name.toLowerCase() === lower);
  if (byLowerName) return byLowerName;

  const index = Number.parseInt(trimmed, 10);
  if (Number.isFinite(index) && index >= 1 && index <= workbook.sheets.length) {
    return workbook.sheets[index - 1] as WorkbookSheet;
  }

  throw new ToolError(
    "unknown-sheet",
    `This workbook has no sheet called "${trimmed}".`,
    `Available sheets: ${workbook.sheets.map((sheet) => sheet.name).join(", ")}. A sheet number such as 1 works too.`,
  );
}

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

export function run(input: Uint8Array | string, opts: XlsxOpts): Record<string, string> {
  const limit = Math.max(1, Math.min(Math.floor(opts.rows ?? DEFAULT_RUN_ROWS), MAX_MAX_ROWS));
  const workbook = readWorkbook(input, { maxRows: Math.max(limit, DEFAULT_MAX_ROWS) });
  const sheet = pickSheet(workbook, opts.sheet ?? "");
  const rows = sheet.rows.slice(0, limit);
  const header = opts.header !== false;

  const result: Record<string, string> = {
    Format: workbook.format.toUpperCase(),
    "File size": formatBytes(workbook.fileSize),
    Sheets: workbook.sheets.map((s) => s.name).join(", "),
    Sheet: sheet.name,
    Size: `${sheet.rowCount.toLocaleString("en-US")} rows by ${sheet.colCount} columns`,
  };

  if (sheet.merges.length > 0) {
    const shown = sheet.merges.slice(0, 12).map((merge) => merge.ref);
    result["Merged ranges"] =
      sheet.merges.length > shown.length
        ? `${shown.join(", ")} and ${sheet.merges.length - shown.length} more`
        : shown.join(", ");
  }
  if (workbook.date1904) {
    result["Date system"] = "1904 (dates count from January 1st 1904)";
  }
  if (sheet.truncated) {
    result["Rows loaded"] =
      `${sheet.rows.length.toLocaleString("en-US")} of ${sheet.rowCount.toLocaleString("en-US")}`;
  }

  switch (opts.view) {
    case "csv":
      result.Output = toCsv(rows);
      break;
    case "json":
      result.Output = toJson(rows, header);
      break;
    case "markdown":
      result.Output = toMarkdown(rows, header);
      break;
    case "summary":
      break;
    default:
      result.Output = toTextTable({ ...sheet, rows }, limit);
      break;
  }

  return result;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, XlsxOpts>;
