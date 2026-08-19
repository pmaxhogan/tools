import Papa from "papaparse";
import { ToolError, type ToolLogic } from "../types";

/** Column alignment as encoded by the colons in a GFM delimiter row. */
export type Align = "left" | "center" | "right" | "none";

/** The parsed shape every operation and exporter works on. */
export interface Table {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** Input shapes the parser understands. */
export type TableFormat = "markdown" | "tsv" | "csv" | "html" | "whitespace";

/** Parse output with the detected format and any non-fatal notes. */
export interface ParseResult {
  table: Table;
  format: TableFormat;
  /** Non-fatal notes, for example ragged rows that were filled with empty cells. */
  warnings: string[];
}

export interface FormatOpts {
  /** Per-column alignment override. Missing entries fall back to no alignment. */
  align?: Align[];
  /** Pad cells so the columns line up in a monospace editor. */
  pad?: boolean;
  /** Minimal pipes: no padding, no spaces, shortest legal delimiter row. */
  compact?: boolean;
  /** Escape pipe characters inside cells so they do not split the row. */
  escapePipes?: boolean;
  /** When false, the table's header becomes the first body row and a generic header is generated. */
  headerFromFirstRow?: boolean;
}

export interface MdTableOpts {
  /** markdown | csv | tsv | html | json | ascii | latex, plus synonyms. */
  output?: string;
  /** keep | left | center | right, applied to every column. */
  align?: string;
  pad?: boolean;
  compact?: boolean;
  /** none | asc | desc. Not exposed in meta; the custom panel drives it. */
  sort?: string;
  /** Zero-based column index the sort applies to. */
  sortColumn?: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Display width
 * ------------------------------------------------------------------ */

const COMBINING = /\p{Mn}|\p{Me}/u;

/** East Asian Wide and Fullwidth ranges inside the BMP. */
const WIDE_BMP = new RegExp(
  "[" +
    "\u1100-\u115F" + // Hangul Jamo
    "\u2E80-\u303E" + // CJK radicals, Kangxi, CJK symbols
    "\u3041-\u33FF" + // kana, Hangul compatibility jamo, CJK compatibility
    "\u3400-\u4DBF" + // CJK extension A
    "\u4E00-\u9FFF" + // CJK unified ideographs
    "\uA000-\uA4CF" + // Yi
    "\uA960-\uA97F" + // Hangul Jamo extended A
    "\uAC00-\uD7A3" + // Hangul syllables
    "\uF900-\uFAFF" + // CJK compatibility ideographs
    "\uFE10-\uFE19\uFE30-\uFE6F" + // vertical and compatibility forms
    "\uFF00-\uFF60\uFFE0-\uFFE6" + // fullwidth forms
    "]",
);

function isWide(ch: string, cp: number): boolean {
  if (cp >= 0x1f300 && cp <= 0x1f64f) return true;
  if (cp >= 0x1f900 && cp <= 0x1f9ff) return true;
  if (cp >= 0x20000 && cp <= 0x3fffd) return true;
  return WIDE_BMP.test(ch);
}

/**
 * Monospace columns, not code units. CJK and fullwidth characters take two
 * cells, combining marks take none. This is a heuristic rather than a full
 * Unicode width table, but it is what makes a padded table line up in a real
 * editor.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (COMBINING.test(ch)) continue;
    width += isWide(ch, ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function padContent(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - displayWidth(text));
  if (gap === 0) return text;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

/* ------------------------------------------------------------------ *
 * Markdown row splitting
 * ------------------------------------------------------------------ */

const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Split one Markdown row into cells.
 *
 * A pipe only ends a cell when it is unescaped and outside an inline code
 * span, so an escaped pipe and a code span containing a pipe both stay in one
 * cell. Leading and trailing pipes are optional and are dropped when present.
 */
export function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let fence = 0;
  let splits = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "\\" && i + 1 < line.length) {
      cell += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (fence === 0) fence = run;
      else if (fence === run) fence = 0;
      cell += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && fence === 0) {
      cells.push(cell);
      cell = "";
      splits++;
      continue;
    }
    cell += ch;
  }
  cells.push(cell);

  if (splits > 0) {
    if (
      cells.length > 1 &&
      (cells[0] as string).trim() === "" &&
      line.trimStart().startsWith("|")
    ) {
      cells.shift();
    }
    if (cells.length > 1 && (cells[cells.length - 1] as string).trim() === "") cells.pop();
  }
  return cells;
}

function unescapeCell(text: string): string {
  return text.replace(/\\\|/g, "|").trim();
}

/** A delimiter row: pipes plus cells made only of dashes and optional colons. */
function isSeparatorLine(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitPipeRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => SEPARATOR_CELL.test(cell.trim()));
}

function alignOfCell(raw: string): Align {
  const cell = raw.trim();
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

/* ------------------------------------------------------------------ *
 * Format detection
 * ------------------------------------------------------------------ */

function contentLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * Pick the input shape by content. Order matters: a delimiter row is the one
 * unambiguous Markdown signal, tabs beat a stray pipe inside a spreadsheet
 * cell, and whitespace columns are the last resort.
 */
export function detectTableFormat(text: string): TableFormat {
  if (/<table\b/i.test(text)) return "html";
  if (/<tr\b/i.test(text) && /<t[dh]\b/i.test(text)) return "html";

  const lines = contentLines(text);
  if (lines.length === 0) return "csv";
  if (lines.some(isSeparatorLine)) return "markdown";
  if (lines.some((line) => line.includes("\t"))) return "tsv";

  const piped = lines.filter((line) => splitPipeRow(line).length > 1).length;
  if (piped > 0 && piped >= Math.ceil(lines.length * 0.6)) return "markdown";

  if ((lines[0] as string).includes(",")) return "csv";
  if (lines.some((line) => /\S {2,}\S/.test(line))) return "whitespace";
  return "csv";
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

const ALIGNS: Align[] = ["left", "center", "right", "none"];

function resolveAlign(align: Align[] | undefined, width: number): Align[] {
  const out: Align[] = [];
  for (let i = 0; i < width; i++) {
    const value = align?.[i];
    out.push(value && ALIGNS.includes(value) ? value : "none");
  }
  return out;
}

function padTo(row: string[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < width; i++) out.push(row[i] ?? "");
  return out;
}

/** Square the grid up, note how many rows had to be filled, and split off the header. */
function gridToTable(grid: string[][], align: Align[], warnings: string[]): Table {
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  let ragged = 0;
  const squared = grid.map((row) => {
    if (row.length !== width) ragged++;
    return padTo(row, width);
  });
  if (ragged > 0) {
    warnings.push(
      `${ragged} ${ragged === 1 ? "row had" : "rows had"} a different number of cells and were filled with empty cells.`,
    );
  }

  const header = squared.shift() ?? [];
  return { header, align: resolveAlign(align, width), rows: squared };
}

function parseMarkdown(text: string, warnings: string[]): Table {
  const lines = contentLines(text);
  const headerCells = splitPipeRow(lines[0] ?? "").map(unescapeCell);

  let align: Align[] = [];
  let body = lines.slice(1);
  if (lines.length > 1 && isSeparatorLine(lines[1] as string)) {
    align = splitPipeRow(lines[1] as string).map(alignOfCell);
    body = lines.slice(2);
    if (align.length !== headerCells.length) {
      warnings.push(
        `The alignment row has ${align.length} cells but the header has ${headerCells.length}, so the columns without one are left unaligned.`,
      );
    }
  }

  const grid = [headerCells, ...body.map((line) => splitPipeRow(line).map(unescapeCell))];
  return gridToTable(grid, align, warnings);
}

function parseDelimited(text: string, delimiter: string, warnings: string[]): Table {
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  const grid = result.data
    .filter((row) => row.length > 0)
    .map((row) => row.map((cell) => (cell ?? "").trim()));
  return gridToTable(grid, [], warnings);
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  return String.fromCodePoint(value);
}

/** Numeric and named entities first, ampersand last, or a double encoding decodes twice. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(
      /&(lt|gt|quot|apos|nbsp);/gi,
      (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m,
    )
    .replace(/&amp;/gi, "&");
}

function cleanHtmlCell(raw: string): string {
  const text = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ");
  return decodeEntities(text).trim();
}

/**
 * A tolerant HTML table reader. There is no DOM here, so this walks tr and
 * th/td with regexes and accepts unclosed cells, which is what a copied
 * fragment usually looks like.
 */
function parseHtml(text: string, warnings: string[]): Table {
  const region = /<table\b[^>]*>([\s\S]*?)(?:<\/table\s*>|$)/i.exec(text);
  const source = region ? (region[1] as string) : text;

  const rowRe = /<tr\b[^>]*>([\s\S]*?)(?=<\/tr\s*>|<tr\b|$)/gi;
  const grid: string[][] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(source)) !== null) {
    const inner = rowMatch[1] as string;
    const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)(?=<\/t[hd]\s*>|<t[hd]\b|<\/tr\s*>|$)/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      cells.push(cleanHtmlCell(cellMatch[2] as string));
    }
    if (cells.length > 0) grid.push(cells);
  }

  if (grid.length === 0) {
    throw new ToolError(
      "no-table",
      "Found HTML but no table rows inside it.",
      "Paste the markup from the opening table tag through its closing tag, including the tr and td elements.",
    );
  }
  return gridToTable(grid, [], warnings);
}

function parseWhitespace(text: string, warnings: string[]): Table {
  const grid = contentLines(text).map((line) => line.trim().split(/\s{2,}/));
  return gridToTable(grid, [], warnings);
}

const NO_TABLE_FIX =
  "Paste a Markdown table, rows copied from Excel or Google Sheets, CSV text, or an HTML table. Two or more columns are needed.";

/** Parse plus the detected format and any non-fatal notes a panel can surface. */
export function parseTableDetailed(text: string): ParseResult {
  const raw = text ?? "";
  if (raw.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to read yet.",
      "Paste a Markdown table, or rows copied from Excel, Google Sheets, a CSV file, or an HTML table.",
    );
  }

  const warnings: string[] = [];
  const format = detectTableFormat(raw);
  let table: Table;
  switch (format) {
    case "markdown":
      table = parseMarkdown(raw, warnings);
      break;
    case "tsv":
      table = parseDelimited(raw, "\t", warnings);
      break;
    case "html":
      table = parseHtml(raw, warnings);
      break;
    case "whitespace":
      table = parseWhitespace(raw, warnings);
      break;
    default:
      table = parseDelimited(raw, ",", warnings);
      break;
  }

  if (table.header.length < 2) {
    throw new ToolError(
      "no-table",
      "Could not find a table with two or more columns.",
      NO_TABLE_FIX,
    );
  }
  return { table, format, warnings };
}

/** Parse any supported table text into the canonical shape. */
export function parseTable(text: string): Table {
  return parseTableDetailed(text).table;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function tableWidth(table: Table): number {
  return table.rows.reduce((max, row) => Math.max(max, row.length), table.header.length);
}

/** Newlines cannot survive a Markdown cell; pipes can, once escaped. */
function renderCell(raw: string, escapePipes: boolean): string {
  const flat = raw.replace(/\r?\n/g, " ");
  return escapePipes ? flat.replace(/\\?\|/g, "\\|") : flat;
}

const COMPACT_SEP: Record<Align, string> = {
  none: "-",
  left: ":-",
  center: ":-:",
  right: "-:",
};

function paddedSeparator(width: number, align: Align): string {
  const w = Math.max(3, width);
  if (align === "left") return ":" + "-".repeat(w - 1);
  if (align === "right") return "-".repeat(w - 1) + ":";
  if (align === "center") return ":" + "-".repeat(w - 2) + ":";
  return "-".repeat(w);
}

/**
 * Render a table as GitHub Flavored Markdown.
 *
 * With `headerFromFirstRow: false` the table's header is treated as data: it
 * moves into the body and a generic "Column N" header takes its place, because
 * GFM has no way to write a table without a header row.
 */
export function formatMarkdownTable(table: Table, opts: FormatOpts = {}): string {
  const pad = opts.pad !== false;
  const compact = opts.compact === true;
  const escapePipes = opts.escapePipes !== false;
  const width = Math.max(1, tableWidth(table));

  let header = padTo(table.header, width);
  let rows = table.rows.map((row) => padTo(row, width));
  if (opts.headerFromFirstRow === false) {
    rows = [header, ...rows];
    header = Array.from({ length: width }, (_unused, i) => `Column ${i + 1}`);
  }

  const align = resolveAlign(opts.align ?? table.align, width);
  const headerCells = header.map((cell) => renderCell(cell, escapePipes));
  const bodyCells = rows.map((row) => row.map((cell) => renderCell(cell, escapePipes)));

  if (compact) {
    const lines = [`|${headerCells.join("|")}|`];
    lines.push(`|${align.map((a) => COMPACT_SEP[a]).join("|")}|`);
    for (const row of bodyCells) lines.push(`|${row.join("|")}|`);
    return lines.join("\n");
  }

  const widths = align.map((_unused, i) => {
    if (!pad) return 3;
    let max = displayWidth(headerCells[i] ?? "");
    for (const row of bodyCells) max = Math.max(max, displayWidth(row[i] ?? ""));
    return Math.max(3, max);
  });

  const line = (cells: string[]): string =>
    `| ${cells
      .map((cell, i) => (pad ? padContent(cell, widths[i] ?? 0, align[i] ?? "none") : cell))
      .join(" | ")} |`;

  const out = [line(headerCells)];
  out.push(`| ${widths.map((w, i) => paddedSeparator(w, align[i] ?? "none")).join(" | ")} |`);
  for (const row of bodyCells) out.push(line(row));
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Operations. Every one returns a new table; none mutates its argument.
 * ------------------------------------------------------------------ */

function clone(table: Table): Table {
  const width = Math.max(1, tableWidth(table));
  return {
    header: padTo(table.header, width),
    align: resolveAlign(table.align, width),
    rows: table.rows.map((row) => padTo(row, width)),
  };
}

function checkIndex(value: number, count: number, what: string): number {
  const index = Math.trunc(Number(value));
  if (!Number.isFinite(index) || index < 0 || index >= count) {
    const plural = count === 1 ? what : `${what}s`;
    throw new ToolError(
      "bad-index",
      `There is no ${what} at index ${value}; this table has ${count} ${plural}.`,
      count > 0 ? `Use an index between 0 and ${count - 1}.` : `Add a ${what} first.`,
    );
  }
  return index;
}

function clampInsert(value: number | undefined, count: number): number {
  if (value === undefined) return count;
  const index = Math.trunc(Number(value));
  if (!Number.isFinite(index)) return count;
  return Math.min(Math.max(index, 0), count);
}

export function addRow(table: Table, at?: number): Table {
  const next = clone(table);
  next.rows.splice(
    clampInsert(at, next.rows.length),
    0,
    next.header.map(() => ""),
  );
  return next;
}

export function removeRow(table: Table, at: number): Table {
  const next = clone(table);
  next.rows.splice(checkIndex(at, next.rows.length, "row"), 1);
  return next;
}

export function addColumn(table: Table, at?: number, name = ""): Table {
  const next = clone(table);
  const index = clampInsert(at, next.header.length);
  next.header.splice(index, 0, name);
  next.align.splice(index, 0, "none");
  for (const row of next.rows) row.splice(index, 0, "");
  return next;
}

export function removeColumn(table: Table, at: number): Table {
  const next = clone(table);
  const index = checkIndex(at, next.header.length, "column");
  next.header.splice(index, 1);
  next.align.splice(index, 1);
  for (const row of next.rows) row.splice(index, 1);
  return next;
}

function move<T>(list: T[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item as T);
}

export function moveColumn(table: Table, from: number, to: number): Table {
  const next = clone(table);
  const a = checkIndex(from, next.header.length, "column");
  const b = checkIndex(to, next.header.length, "column");
  move(next.header, a, b);
  move(next.align, a, b);
  for (const row of next.rows) move(row, a, b);
  return next;
}

export function moveRow(table: Table, from: number, to: number): Table {
  const next = clone(table);
  const a = checkIndex(from, next.rows.length, "row");
  const b = checkIndex(to, next.rows.length, "row");
  move(next.rows, a, b);
  return next;
}

/** Row index -1 targets the header cell. */
export function setCell(table: Table, row: number, col: number, value: string): Table {
  const next = clone(table);
  const c = checkIndex(col, next.header.length, "column");
  if (row === -1) {
    next.header[c] = value;
    return next;
  }
  const r = checkIndex(row, next.rows.length, "row");
  (next.rows[r] as string[])[c] = value;
  return next;
}

const NUMERIC = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

export function sortBy(
  table: Table,
  col: number,
  dir: "asc" | "desc" = "asc",
  numericAware = true,
): Table {
  const next = clone(table);
  const index = checkIndex(col, next.header.length, "column");
  const sign = dir === "desc" ? -1 : 1;

  next.rows.sort((rowA, rowB) => {
    const a = (rowA[index] ?? "").trim();
    const b = (rowB[index] ?? "").trim();
    if (a === "" && b === "") return 0;
    if (a === "") return 1;
    if (b === "") return -1;
    if (numericAware && NUMERIC.test(a) && NUMERIC.test(b)) return sign * (Number(a) - Number(b));
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x !== y) return sign * (x < y ? -1 : 1);
    if (a === b) return 0;
    return sign * (a < b ? -1 : 1);
  });
  return next;
}

/** Flip rows and columns. The old header becomes the first column. */
export function transpose(table: Table): Table {
  const source = clone(table);
  const grid = [source.header, ...source.rows];
  const width = Math.max(1, tableWidth(source));
  const flipped: string[][] = [];
  for (let c = 0; c < width; c++) flipped.push(grid.map((row) => row[c] ?? ""));
  const header = flipped.shift() ?? [];
  return { header, align: resolveAlign([], header.length), rows: flipped };
}

export function setAlign(table: Table, col: number, align: Align): Table {
  const next = clone(table);
  const index = checkIndex(col, next.header.length, "column");
  next.align[index] = ALIGNS.includes(align) ? align : "none";
  return next;
}

export function trimCells(table: Table): Table {
  const next = clone(table);
  next.header = next.header.map((cell) => cell.trim());
  next.rows = next.rows.map((row) => row.map((cell) => cell.trim()));
  return next;
}

export function fillEmpty(table: Table, placeholder: string): Table {
  const next = clone(table);
  const fill = (cell: string): string => (cell.trim() === "" ? placeholder : cell);
  next.header = next.header.map(fill);
  next.rows = next.rows.map((row) => row.map(fill));
  return next;
}

/* ------------------------------------------------------------------ *
 * Exporters
 * ------------------------------------------------------------------ */

export function toCsv(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  return Papa.unparse(
    { fields: padTo(table.header, width), data: table.rows.map((row) => padTo(row, width)) },
    { newline: "\n", delimiter: "," },
  );
}

export function toTsv(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  return Papa.unparse(
    { fields: padTo(table.header, width), data: table.rows.map((row) => padTo(row, width)) },
    { newline: "\n", delimiter: "\t" },
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toHtml(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  const align = resolveAlign(table.align, width);
  const style = (i: number): string => {
    const a = align[i];
    return a && a !== "none" ? ` style="text-align: ${a}"` : "";
  };

  const head = padTo(table.header, width)
    .map((cell, i) => `      <th${style(i)}>${escapeHtml(cell)}</th>`)
    .join("\n");
  const body = table.rows
    .map((row) => {
      const cells = padTo(row, width)
        .map((cell, i) => `      <td${style(i)}>${escapeHtml(cell)}</td>`)
        .join("\n");
      return `    <tr>\n${cells}\n    </tr>`;
    })
    .join("\n");

  const parts = ["<table>", "  <thead>", "    <tr>", head, "    </tr>", "  </thead>", "  <tbody>"];
  if (body) parts.push(body);
  parts.push("  </tbody>", "</table>");
  return parts.join("\n");
}

function uniqueKeys(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    const base = raw.trim() || `column${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export function toJson(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  const keys = uniqueKeys(padTo(table.header, width));
  const objects = table.rows.map((row) => {
    const record: Record<string, string> = {};
    keys.forEach((key, i) => {
      record[key] = row[i] ?? "";
    });
    return record;
  });
  return JSON.stringify(objects, null, 2);
}

export function toAsciiTable(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  const align = resolveAlign(table.align, width);
  const header = padTo(table.header, width);
  const rows = table.rows.map((row) => padTo(row, width));

  const widths = header.map((cell, i) => {
    let max = displayWidth(cell);
    for (const row of rows) max = Math.max(max, displayWidth(row[i] ?? ""));
    return Math.max(1, max);
  });

  const border = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, i) => padContent(cell, widths[i] ?? 0, align[i] ?? "none")).join(" | ")} |`;

  const out = [border, line(header), border];
  for (const row of rows) out.push(line(row));
  out.push(border);
  return out.join("\n");
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

export function toLatex(table: Table): string {
  const width = Math.max(1, tableWidth(table));
  const align = resolveAlign(table.align, width);
  const spec = align.map((a) => (a === "center" ? "c" : a === "right" ? "r" : "l")).join("|");
  const row = (cells: string[]): string => `  ${cells.map(escapeLatex).join(" & ")} \\\\`;

  const out = [
    `\\begin{tabular}{|${spec}|}`,
    "  \\hline",
    row(padTo(table.header, width)),
    "  \\hline",
  ];
  for (const line of table.rows) out.push(row(padTo(line, width)));
  out.push("  \\hline", "\\end{tabular}");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const OUTPUTS: Record<string, string> = {
  markdown: "markdown",
  md: "markdown",
  gfm: "markdown",
  table: "markdown",
  csv: "csv",
  comma: "csv",
  tsv: "tsv",
  tab: "tsv",
  tabs: "tsv",
  excel: "tsv",
  html: "html",
  htm: "html",
  json: "json",
  ascii: "ascii",
  box: "ascii",
  pretty: "ascii",
  latex: "latex",
  tex: "latex",
};

const ALIGN_CHOICES = ["keep", "", "none", "left", "center", "right"];
const SORT_CHOICES = ["none", "", "asc", "desc"];

export function run(input: string, opts: MdTableOpts = {}): string {
  const { table } = parseTableDetailed(input ?? "");

  const alignChoice = String(opts.align ?? "keep")
    .toLowerCase()
    .trim();
  if (!ALIGN_CHOICES.includes(alignChoice)) {
    throw new ToolError(
      "bad-option",
      `"${String(opts.align)}" is not a column alignment.`,
      "Pick one of: keep, left, center, right.",
    );
  }

  let working = table;
  if (alignChoice !== "keep" && alignChoice !== "") {
    const align = alignChoice as Align;
    working = { ...working, align: working.header.map(() => align) };
  }

  const sortChoice = String(opts.sort ?? "none")
    .toLowerCase()
    .trim();
  if (!SORT_CHOICES.includes(sortChoice)) {
    throw new ToolError(
      "bad-option",
      `"${String(opts.sort)}" is not a sort direction.`,
      "Pick one of: none, asc, desc.",
    );
  }
  if (sortChoice === "asc" || sortChoice === "desc") {
    const column = Math.trunc(Number(opts.sortColumn ?? 0)) || 0;
    working = sortBy(working, column, sortChoice);
  }

  const requested = String(opts.output ?? "markdown")
    .toLowerCase()
    .trim();
  const output = OUTPUTS[requested === "" ? "markdown" : requested];
  if (!output) {
    throw new ToolError(
      "bad-option",
      `"${String(opts.output)}" is not an output format.`,
      "Pick one of: markdown, csv, tsv, html, json, ascii, latex.",
    );
  }

  switch (output) {
    case "csv":
      return toCsv(working);
    case "tsv":
      return toTsv(working);
    case "html":
      return toHtml(working);
    case "json":
      return toJson(working);
    case "ascii":
      return toAsciiTable(working);
    case "latex":
      return toLatex(working);
    default:
      return formatMarkdownTable(working, {
        pad: opts.pad !== false,
        compact: opts.compact === true,
      });
  }
}

export default { run } satisfies ToolLogic<string, string, MdTableOpts>;
