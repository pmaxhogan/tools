import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { formatByteCount, formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";
import { BUILTIN_TEMPLATES, findTemplate } from "./templates";

/**
 * Hex Viewer: a byte level dump, a small struct template language, string
 * extraction, and an entropy profile, all computed in the page.
 *
 * The template language is the reason this tool exists as more than a dump.
 * Every binary format worth staring at has a header shaped like a C struct, so
 * the language is deliberately struct shaped and nothing more: sized fields,
 * a seek, a skip, a repeat, and a conditional. It has no arithmetic beyond a
 * constant offset and no user defined types, because the moment a template
 * needs either of those the honest answer is a parser, not a template.
 *
 * Grammar (one statement per line, `#` starts a comment):
 *
 *   u8 | i8 | u16le | u16be | i16le | i16be | u32le | u32be | i32le | i32be
 *   u64le | u64be | i64le | i64be | f32le | f32be | f64le | f64be   name
 *   bytes[EXPR] name        raw bytes, value is hex
 *   char[EXPR] name         ASCII, trailing NUL padding trimmed
 *   utf8[EXPR] name         UTF-8 text
 *   utf16le[EXPR] name      UTF-16 text (also utf16be); EXPR counts BYTES
 *   octal[EXPR] name        ASCII digits read as base 8 (tar sizes)
 *   cstring name            bytes up to the next NUL
 *   skip EXPR               advance
 *   align N                 advance to the next multiple of N
 *   @EXPR                   seek to an absolute offset
 *   repeat EXPR { ... }     run the block EXPR times
 *   repeat * { ... }        run the block until the bytes run out
 *   if NAME OP VALUE { ... } run the block when an earlier field matches
 *
 * EXPR is a decimal or 0x literal, or the name of a field parsed earlier,
 * optionally followed by `+ N` or `- N`. Offsets are absolute, so `@0x3c`
 * means byte 0x3c of the file even when the template started later.
 */

/* ------------------------------------------------------------------ */
/* limits                                                             */
/* ------------------------------------------------------------------ */

/** Hard ceiling on the input. Past this a browser tab is not the right tool. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** Bytes rendered in one dump. Beyond this, move the window with `offset`. */
export const DUMP_WINDOW_BYTES = 64 * 1024;
/** Safety valve for `repeat *` on data that does not match the template. */
export const MAX_REPEAT_ITERATIONS = 4096;
/** Rows in the strings view before it is truncated. */
export const MAX_STRINGS = 500;
/** Bytes of raw hex shown next to a template field before it is elided. */
const FIELD_HEX_PREVIEW_BYTES = 32;
/** Bytes per hex group in the dump, the `hexdump -C` convention. */
const GROUP_SIZE = 8;

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

function emptyInput(): ToolError {
  return new ToolError(
    "empty-input",
    "There are no bytes to inspect.",
    "Drop a file, or paste a hex dump, a base64 string, or any text you want to see the bytes of.",
  );
}

function tooLarge(size: number): ToolError {
  return new ToolError(
    "too-large",
    `That input is ${formatByteCount(size)}, over the ${formatBytes(MAX_INPUT_BYTES)} limit for inspecting in the page.`,
    "Split the file, or cut out the region you care about with a tool that streams from disk.",
  );
}

function badTemplate(line: number, text: string, problem: string, fix: string): ToolError {
  const where = text === "" ? `Line ${line}` : `Line ${line}, "${text}"`;
  return new ToolError("bad-template", `${where}: ${problem}`, fix);
}

function templateOverflow(name: string, line: number, offset: number, need: number, have: number) {
  return new ToolError(
    "template-overflow",
    `Field "${name}" on line ${line} wants ${need} ${need === 1 ? "byte" : "bytes"} at offset 0x${offset.toString(16)}, but only ${have - offset} of ${have} bytes are left.`,
    "Check the template matches this file, or set the start offset so the struct begins where the template expects it.",
  );
}

/* ------------------------------------------------------------------ */
/* input decoding                                                     */
/* ------------------------------------------------------------------ */

export type InputEncoding = "raw bytes" | "hex text" | "base64 text" | "UTF-8 text";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
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

/**
 * Base64 and hex share an alphabet, and so does ordinary English, so a hex
 * viewer has to pick a precedence and stick to it. This one is deliberately
 * conservative, because the honest default for pasted text is to show the bytes
 * of that text rather than to guess it was an encoding:
 *
 *   1. a `data:...;base64,` URL is base64
 *   2. text that is entirely hex digits, of even length, is a hex dump
 *      (a leading 0x and any whitespace are ignored)
 *   3. text that is a whole number of base64 quanta AND carries a character
 *      only base64 has (`=` padding, `+`, `/`, `-`, `_`) is base64
 *   4. everything else is text, encoded as UTF-8
 *
 * So "48656c6c6f" is five bytes of hex, "aGVsbG8=" is five bytes of base64, and
 * "Hello" is five bytes of UTF-8.
 */
export function toBytes(input: Uint8Array | string): {
  bytes: Uint8Array;
  encoding: InputEncoding;
} {
  if (typeof input !== "string") {
    if (!input || input.length === 0) throw emptyInput();
    return { bytes: input, encoding: "raw bytes" };
  }

  const trimmed = input.trim();
  if (trimmed === "") throw emptyInput();

  const dataUrl = /^data:[^,]*;base64,/i.exec(trimmed);
  if (dataUrl) {
    const decoded = base64ToBytes(trimmed.slice(dataUrl[0].length).replace(/\s+/g, ""));
    if (decoded && decoded.length > 0) return { bytes: decoded, encoding: "base64 text" };
  }

  const compact = trimmed.replace(/\s+/g, "");
  const hexBody = /^0[xX]/.test(compact) ? compact.slice(2) : compact;
  if (hexBody.length >= 2 && hexBody.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hexBody)) {
    return { bytes: hexToBytes(hexBody), encoding: "hex text" };
  }

  if (compact.length >= 4 && compact.length % 4 === 0 && /[=+/\-_]/.test(compact)) {
    const decoded = base64ToBytes(compact);
    if (decoded && decoded.length > 0) return { bytes: decoded, encoding: "base64 text" };
  }

  return { bytes: new TextEncoder().encode(input), encoding: "UTF-8 text" };
}

/* ------------------------------------------------------------------ */
/* hex dump                                                           */
/* ------------------------------------------------------------------ */

export interface HexDumpOptions {
  /** First byte to show. Absolute, and reflected in the offset column. */
  offset?: number;
  /** How many bytes to show. Defaults to everything after `offset`. */
  length?: number;
  /** Bytes per row. Default 16. */
  bytesPerRow?: number;
  /** Uppercase every hex digit, offsets included, the way `xxd -u` does. */
  uppercase?: boolean;
  /** Render the ASCII gutter. Default true. */
  ascii?: boolean;
}

/** One dump row. `hex` holds one two digit string per real byte, unpadded. */
export interface HexRow {
  offset: number;
  hex: string[];
  ascii: string;
}

function clampBytesPerRow(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 16;
  if (n < 1) return 16;
  return Math.min(n, 256);
}

function byteHex(byte: number, uppercase: boolean): string {
  const text = byte.toString(16).padStart(2, "0");
  return uppercase ? text.toUpperCase() : text;
}

function offsetHex(offset: number, uppercase: boolean): string {
  const text = offset.toString(16).padStart(8, "0");
  return uppercase ? text.toUpperCase() : text;
}

function printableChar(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
}

/** Structured dump rows, for a panel that wants to render its own grid. */
export function hexDumpRows(bytes: Uint8Array, options: HexDumpOptions = {}): HexRow[] {
  const bytesPerRow = clampBytesPerRow(options.bytesPerRow);
  const uppercase = options.uppercase === true;
  const start = Math.max(0, Math.min(Math.floor(options.offset ?? 0), bytes.length));
  const available = bytes.length - start;
  const length =
    options.length === undefined
      ? available
      : Math.max(0, Math.min(Math.floor(options.length), available));

  const rows: HexRow[] = [];
  for (let i = 0; i < length; i += bytesPerRow) {
    const rowStart = start + i;
    const rowLength = Math.min(bytesPerRow, length - i);
    const hex: string[] = [];
    let ascii = "";
    for (let j = 0; j < rowLength; j++) {
      const byte = bytes[rowStart + j];
      hex.push(byteHex(byte, uppercase));
      ascii += printableChar(byte);
    }
    rows.push({ offset: rowStart, hex, ascii });
  }
  return rows;
}

function renderRow(row: HexRow, bytesPerRow: number, uppercase: boolean, ascii: boolean): string {
  const groups: string[] = [];
  for (let g = 0; g < bytesPerRow; g += GROUP_SIZE) {
    const cells: string[] = [];
    for (let j = g; j < Math.min(g + GROUP_SIZE, bytesPerRow); j++) {
      cells.push(j < row.hex.length ? row.hex[j] : "  ");
    }
    groups.push(cells.join(" "));
  }
  const column = groups.join("  ");
  const head = `${offsetHex(row.offset, uppercase)}  ${column}`;
  return ascii ? `${head}  |${row.ascii}|` : head.replace(/\s+$/, "");
}

/**
 * A classic `hexdump -C` style dump: an eight digit offset column, hex bytes in
 * groups of eight, and an ASCII gutter with a dot for every byte outside the
 * printable range. Short final rows are padded so the gutter stays aligned.
 */
export function hexDump(bytes: Uint8Array, options: HexDumpOptions = {}): string {
  const bytesPerRow = clampBytesPerRow(options.bytesPerRow);
  const uppercase = options.uppercase === true;
  const ascii = options.ascii !== false;
  return hexDumpRows(bytes, options)
    .map((row) => renderRow(row, bytesPerRow, uppercase, ascii))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* template language: types                                           */
/* ------------------------------------------------------------------ */

/** A count or an offset: a literal or a field name, plus a constant delta. */
export interface TemplateExpr {
  literal: number | null;
  field: string | null;
  delta: number;
}

export type CompareOp = "==" | "!=" | ">" | "<" | ">=" | "<=";

export type TemplateNode =
  | { kind: "field"; line: number; type: string; name: string; count: TemplateExpr | null }
  | { kind: "skip"; line: number; amount: TemplateExpr }
  | { kind: "align"; line: number; to: number }
  | { kind: "seek"; line: number; to: TemplateExpr }
  | { kind: "repeat"; line: number; count: TemplateExpr | null; body: TemplateNode[] }
  | {
      kind: "if";
      line: number;
      field: string;
      op: CompareOp;
      value: string;
      body: TemplateNode[];
    };

export interface TemplateField {
  name: string;
  /** The declared type, with its resolved length for sized types. */
  type: string;
  offset: number;
  size: number;
  value: string | number | bigint;
  /** Raw bytes of the field as hex, elided past 32 bytes. */
  hex: string;
}

export interface TemplateResult {
  fields: TemplateField[];
  endOffset: number;
  warnings: string[];
}

const NUMERIC_SIZES: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16le: 2,
  u16be: 2,
  i16le: 2,
  i16be: 2,
  u32le: 4,
  u32be: 4,
  i32le: 4,
  i32be: 4,
  u64le: 8,
  u64be: 8,
  i64le: 8,
  i64be: 8,
  f32le: 4,
  f32be: 4,
  f64le: 8,
  f64be: 8,
};

const SIZED_TYPES = new Set(["bytes", "char", "utf8", "utf16le", "utf16be", "octal"]);

/* ------------------------------------------------------------------ */
/* template language: parser                                          */
/* ------------------------------------------------------------------ */

/** Drop a `#` comment, ignoring one inside a quoted string. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

const EXPR_RE =
  /^(0[xX][0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*)(?:\s*([+-])\s*(0[xX][0-9a-fA-F]+|\d+))?$/;

function parseExpr(text: string, line: number, raw: string): TemplateExpr {
  const match = EXPR_RE.exec(text.trim());
  if (!match) {
    throw badTemplate(
      line,
      raw,
      `"${text.trim()}" is not a count or an offset.`,
      "Write a number (12 or 0x0c), the name of a field parsed earlier, or either of those with a constant added, like size - 8.",
    );
  }
  const base = match[1];
  const isLiteral = /^(0[xX]|\d)/.test(base);
  const delta = match[2] ? (match[2] === "-" ? -Number(match[3]) : Number(match[3])) : 0;
  return {
    literal: isLiteral ? Number(base) : null,
    field: isLiteral ? null : base,
    delta,
  };
}

const FIELD_RE = /^([A-Za-z][A-Za-z0-9]*)(?:\[([^\]]*)\])?\s+([A-Za-z_][A-Za-z0-9_]*)$/;
const REPEAT_RE = /^repeat\s+(.+?)\s*\{$/;
const IF_RE = /^if\s+([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*\{$/;

/**
 * Parse template source into nodes. Every failure names the line and the text
 * on it, because a template is edited by hand and "syntax error" alone is
 * useless when you are twelve lines into a header you half remember.
 */
export function parseTemplate(text: string): TemplateNode[] {
  if (typeof text !== "string" || text.trim() === "") {
    throw badTemplate(
      1,
      "",
      "The template is empty.",
      "Add at least one field line, for example: u32be magic",
    );
  }

  const root: TemplateNode[] = [];
  const stack: TemplateNode[][] = [root];
  const open: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const statement = stripComment(lines[i]).trim();
    if (statement === "") continue;
    const body = stack[stack.length - 1];

    if (statement === "}") {
      if (stack.length === 1) {
        throw badTemplate(
          line,
          statement,
          "There is no open block for this closing brace.",
          "Delete the stray } or add the repeat or if line it was meant to close.",
        );
      }
      stack.pop();
      open.pop();
      continue;
    }

    if (statement.startsWith("@")) {
      body.push({ kind: "seek", line, to: parseExpr(statement.slice(1), line, statement) });
      continue;
    }

    const repeat = REPEAT_RE.exec(statement);
    if (repeat) {
      const countText = repeat[1].trim();
      const node: TemplateNode = {
        kind: "repeat",
        line,
        count: countText === "*" ? null : parseExpr(countText, line, statement),
        body: [],
      };
      body.push(node);
      stack.push(node.body);
      open.push({ line, text: statement });
      continue;
    }

    if (statement.startsWith("repeat")) {
      throw badTemplate(
        line,
        statement,
        "A repeat needs a count and an opening brace.",
        "Write repeat 4 { on its own line, or repeat * { to walk until the bytes run out, and close it with } on a line of its own.",
      );
    }

    const conditional = IF_RE.exec(statement);
    if (conditional) {
      const node: TemplateNode = {
        kind: "if",
        line,
        field: conditional[1],
        op: conditional[2] as CompareOp,
        value: conditional[3].trim(),
        body: [],
      };
      body.push(node);
      stack.push(node.body);
      open.push({ line, text: statement });
      continue;
    }

    if (statement.startsWith("if")) {
      throw badTemplate(
        line,
        statement,
        "An if needs a field, a comparison, a value, and an opening brace.",
        'Write if class == 2 { on its own line. The operators are ==, !=, >, <, >= and <=, and a text value can be quoted like "IHDR".',
      );
    }

    if (statement.startsWith("skip")) {
      const rest = statement.slice(4).trim();
      if (rest === "") {
        throw badTemplate(line, statement, "skip needs an amount.", "Write skip 4, or skip length to use a field parsed earlier.");
      }
      body.push({ kind: "skip", line, amount: parseExpr(rest, line, statement) });
      continue;
    }

    if (statement.startsWith("align")) {
      const rest = statement.slice(5).trim();
      const to = /^(0[xX][0-9a-fA-F]+|\d+)$/.test(rest) ? Number(rest) : 0;
      if (to < 1) {
        throw badTemplate(
          line,
          statement,
          "align needs a whole number greater than zero.",
          "Write align 4 to advance to the next multiple of four bytes.",
        );
      }
      body.push({ kind: "align", line, to });
      continue;
    }

    const field = FIELD_RE.exec(statement);
    if (!field) {
      throw badTemplate(
        line,
        statement,
        "This is not a statement the template language knows.",
        "Each line is one of: a field like u32be magic or char[4] tag, skip, align, @offset, repeat, if, or a closing }.",
      );
    }

    const type = field[1];
    const bracket = field[2];
    const name = field[3];

    if (SIZED_TYPES.has(type)) {
      if (bracket === undefined || bracket.trim() === "") {
        throw badTemplate(
          line,
          statement,
          `${type} needs a length in brackets.`,
          `Write ${type}[4] ${name}, or ${type}[nameLength] ${name} to take the length from a field parsed earlier.`,
        );
      }
      body.push({ kind: "field", line, type, name, count: parseExpr(bracket, line, statement) });
      continue;
    }

    if (NUMERIC_SIZES[type] !== undefined || type === "cstring") {
      if (bracket !== undefined) {
        throw badTemplate(
          line,
          statement,
          `${type} has a fixed size, so it takes no length in brackets.`,
          `Write ${type} ${name}. Use bytes[n] when you want a run of n raw bytes.`,
        );
      }
      body.push({ kind: "field", line, type, name, count: null });
      continue;
    }

    throw badTemplate(
      line,
      statement,
      `"${type}" is not a known field type.`,
      "The types are u8, i8, u16le, u16be, i16le, i16be, u32le, u32be, i32le, i32be, u64le, u64be, i64le, i64be, f32le, f32be, f64le, f64be, bytes[n], char[n], utf8[n], utf16le[n], utf16be[n], octal[n] and cstring.",
    );
  }

  if (stack.length > 1) {
    const last = open[open.length - 1];
    throw badTemplate(
      last.line,
      last.text,
      "This block is never closed.",
      "Add a } on a line of its own to close it.",
    );
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* template language: evaluator                                       */
/* ------------------------------------------------------------------ */

interface EvalState {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  fields: TemplateField[];
  values: Map<string, string | number | bigint>;
  warnings: string[];
  indexPath: number[];
  uppercase: boolean;
}

function outputName(state: EvalState, base: string): string {
  return base + state.indexPath.map((i) => `[${i}]`).join("");
}

function sliceHex(state: EvalState, offset: number, size: number): string {
  const shown = Math.min(size, FIELD_HEX_PREVIEW_BYTES);
  let out = "";
  for (let i = offset; i < offset + shown && i < state.bytes.length; i++) {
    out += byteHex(state.bytes[i], state.uppercase);
  }
  return size > shown ? `${out}...` : out;
}

function resolveExpr(state: EvalState, expr: TemplateExpr, line: number, what: string): number {
  let base: number;
  if (expr.literal !== null) {
    base = expr.literal;
  } else {
    const held = state.values.get(expr.field as string);
    if (held === undefined) {
      throw badTemplate(
        line,
        `${what} ${expr.field}`,
        `"${expr.field}" has not been parsed yet, so it cannot be used as a count or an offset.`,
        "Move the field above this line. A template can only refer backwards.",
      );
    }
    if (typeof held === "bigint") base = Number(held);
    else if (typeof held === "number") base = held;
    else base = Number(held);
    if (!Number.isFinite(base)) {
      throw badTemplate(
        line,
        `${what} ${expr.field}`,
        `"${expr.field}" holds text, not a number, so it cannot be used as a count or an offset.`,
        "Point this at an integer field instead.",
      );
    }
  }
  return Math.trunc(base) + expr.delta;
}

function readNumeric(view: DataView, type: string, at: number): number | bigint {
  const little = type.endsWith("le");
  switch (type) {
    case "u8":
      return view.getUint8(at);
    case "i8":
      return view.getInt8(at);
    case "u16le":
    case "u16be":
      return view.getUint16(at, little);
    case "i16le":
    case "i16be":
      return view.getInt16(at, little);
    case "u32le":
    case "u32be":
      return view.getUint32(at, little);
    case "i32le":
    case "i32be":
      return view.getInt32(at, little);
    case "u64le":
    case "u64be":
      return view.getBigUint64(at, little);
    case "i64le":
    case "i64be":
      return view.getBigInt64(at, little);
    case "f32le":
    case "f32be":
      return view.getFloat32(at, little);
    default:
      return view.getFloat64(at, little);
  }
}

/** Fixed width fields are NUL or space padded in every format that uses them. */
function trimPadding(text: string): string {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0 && code !== 0x20) break;
    end--;
  }
  return text.slice(0, end);
}

function decodeSized(state: EvalState, type: string, at: number, size: number): string {
  const slice = state.bytes.subarray(at, at + size);
  switch (type) {
    case "bytes":
      return sliceHex(state, at, size);
    case "char": {
      let end = slice.length;
      while (end > 0 && (slice[end - 1] === 0 || slice[end - 1] === 0x20)) end--;
      let out = "";
      for (let i = 0; i < end; i++) out += printableChar(slice[i]);
      return out;
    }
    case "utf8":
      return trimPadding(new TextDecoder("utf-8").decode(slice));
    case "utf16le":
      return trimPadding(new TextDecoder("utf-16le").decode(slice));
    case "utf16be": {
      const swapped = new Uint8Array(slice.length);
      for (let i = 0; i + 1 < slice.length; i += 2) {
        swapped[i] = slice[i + 1];
        swapped[i + 1] = slice[i];
      }
      return trimPadding(new TextDecoder("utf-16le").decode(swapped));
    }
    default: {
      // octal: tar stores its numbers as ASCII digits in base 8, padded with
      // spaces or NULs. A field that is not octal at all comes back as its own
      // text, so the mismatch is visible instead of silently reading as zero.
      let text = "";
      for (let i = 0; i < slice.length; i++) {
        const byte = slice[i];
        if (byte === 0 || byte === 0x20) continue;
        text += String.fromCharCode(byte);
      }
      if (text === "") return "0";
      if (!/^[0-7]+$/.test(text)) return text;
      return String(Number.parseInt(text, 8));
    }
  }
}

function readField(
  state: EvalState,
  node: Extract<TemplateNode, { kind: "field" }>,
): void {
  const name = outputName(state, node.name);
  const type = node.type;

  if (type === "cstring") {
    let end = state.offset;
    while (end < state.bytes.length && state.bytes[end] !== 0) end++;
    const terminated = end < state.bytes.length;
    if (!terminated) {
      if (state.offset >= state.bytes.length) {
        throw templateOverflow(name, node.line, state.offset, 1, state.bytes.length);
      }
      state.warnings.push(
        `Field "${name}" on line ${node.line} ran to the end of the data without a NUL terminator.`,
      );
    }
    const size = end - state.offset + (terminated ? 1 : 0);
    const value = new TextDecoder("utf-8").decode(state.bytes.subarray(state.offset, end));
    state.fields.push({
      name,
      type: "cstring",
      offset: state.offset,
      size,
      value,
      hex: sliceHex(state, state.offset, size),
    });
    state.values.set(node.name, value);
    state.offset += size;
    return;
  }

  const fixed = NUMERIC_SIZES[type];
  if (fixed !== undefined) {
    if (state.offset + fixed > state.bytes.length) {
      throw templateOverflow(name, node.line, state.offset, fixed, state.bytes.length);
    }
    const value = readNumeric(state.view, type, state.offset);
    state.fields.push({
      name,
      type,
      offset: state.offset,
      size: fixed,
      value,
      hex: sliceHex(state, state.offset, fixed),
    });
    state.values.set(node.name, value);
    state.offset += fixed;
    return;
  }

  const size = resolveExpr(state, node.count as TemplateExpr, node.line, type);
  if (size < 0) {
    throw new ToolError(
      "template-overflow",
      `Field "${name}" on line ${node.line} works out to a length of ${size} bytes.`,
      "Check the field the length comes from: the value in this file does not fit what the template expects.",
    );
  }
  if (state.offset + size > state.bytes.length) {
    throw templateOverflow(name, node.line, state.offset, size, state.bytes.length);
  }
  const at = state.offset;
  const value = decodeSized(state, type, at, size);
  state.fields.push({
    name,
    type: `${type}[${size}]`,
    offset: at,
    size,
    value,
    hex: sliceHex(state, at, size),
  });
  state.values.set(node.name, type === "octal" && /^\d+$/.test(value) ? Number(value) : value);
  state.offset = at + size;
}

function parseComparand(text: string): string | number {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (/^-?(0[xX][0-9a-fA-F]+|\d+(\.\d+)?)$/.test(text)) return Number(text);
  return text;
}

function compare(left: string | number | bigint, op: CompareOp, right: string | number): boolean {
  let equal: boolean;
  let order: number;
  if (typeof right === "number" && typeof left !== "string") {
    const a = Number(left);
    equal = a === right;
    order = a < right ? -1 : a > right ? 1 : 0;
  } else {
    const a = String(left);
    const b = String(right);
    equal = a === b;
    order = a < b ? -1 : a > b ? 1 : 0;
  }
  switch (op) {
    case "==":
      return equal;
    case "!=":
      return !equal;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    case ">=":
      return order >= 0;
    default:
      return order <= 0;
  }
}

function walk(state: EvalState, nodes: TemplateNode[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "field":
        readField(state, node);
        break;

      case "skip": {
        const amount = resolveExpr(state, node.amount, node.line, "skip");
        if (amount < 0) {
          throw new ToolError(
            "template-overflow",
            `The skip on line ${node.line} works out to ${amount} bytes, and a template only reads forwards.`,
            "Check the field the amount comes from. Use @offset when you mean to jump to an absolute position.",
          );
        }
        const target = state.offset + amount;
        if (target > state.bytes.length) {
          throw templateOverflow("skip", node.line, state.offset, amount, state.bytes.length);
        }
        state.offset = target;
        break;
      }

      case "align": {
        const remainder = state.offset % node.to;
        const target = remainder === 0 ? state.offset : state.offset + (node.to - remainder);
        if (target > state.bytes.length) {
          throw templateOverflow(
            "align",
            node.line,
            state.offset,
            target - state.offset,
            state.bytes.length,
          );
        }
        state.offset = target;
        break;
      }

      case "seek": {
        const target = resolveExpr(state, node.to, node.line, "@");
        if (target < 0 || target > state.bytes.length) {
          throw new ToolError(
            "template-overflow",
            `The seek on line ${node.line} points at offset 0x${Math.abs(target).toString(16)}, outside the ${state.bytes.length} bytes of this input.`,
            "Check the field the offset comes from, or set the start offset so the struct begins where the template expects it.",
          );
        }
        state.offset = target;
        break;
      }

      case "if": {
        const held = state.values.get(node.field);
        if (held === undefined) {
          state.warnings.push(
            `The if on line ${node.line} names "${node.field}", which has not been parsed, so the block was skipped.`,
          );
          break;
        }
        if (compare(held, node.op, parseComparand(node.value))) walk(state, node.body);
        break;
      }

      case "repeat": {
        const limit =
          node.count === null
            ? MAX_REPEAT_ITERATIONS
            : Math.max(0, resolveExpr(state, node.count, node.line, "repeat"));
        runRepeat(state, node, limit);
        break;
      }
    }
  }
}

function runRepeat(
  state: EvalState,
  node: Extract<TemplateNode, { kind: "repeat" }>,
  limit: number,
): void {
  const unbounded = node.count === null;
  let iteration = 0;

  for (; iteration < limit; iteration++) {
    if (unbounded && state.offset >= state.bytes.length) break;

    const startOffset = state.offset;
    const fieldsBefore = state.fields.length;
    state.indexPath.push(iteration);
    try {
      walk(state, node.body);
    } catch (error) {
      state.indexPath.pop();
      if (!unbounded || !(error instanceof ToolError) || error.code !== "template-overflow") {
        throw error;
      }
      // A bounded repeat is a promise about the data, so an overflow inside one
      // is a real error. An unbounded walk is the opposite: running out of bytes
      // is how it is meant to end. Stopping cleanly at an exact boundary is
      // silent; stopping halfway through a record is worth a warning.
      if (!(state.fields.length === fieldsBefore && startOffset === state.bytes.length)) {
        state.warnings.push(
          `The repeat on line ${node.line} stopped after ${iteration} full ${iteration === 1 ? "pass" : "passes"}: ${error.message}`,
        );
      }
      return;
    }
    state.indexPath.pop();

    // An `align`-only or all-conditional body can consume nothing, and an
    // unbounded repeat over it would spin until the iteration cap. Stop instead.
    if (state.offset === startOffset && state.fields.length === fieldsBefore) {
      state.warnings.push(
        `The repeat on line ${node.line} read no bytes on pass ${iteration}, so it was stopped to avoid looping forever.`,
      );
      return;
    }
  }

  if (unbounded && iteration === limit && state.offset < state.bytes.length) {
    state.warnings.push(
      `The repeat on line ${node.line} hit the ${MAX_REPEAT_ITERATIONS} pass limit with ${state.bytes.length - state.offset} bytes still unread.`,
    );
  }
}

/**
 * Walk `bytes` with a parsed template, starting at `startOffset`.
 *
 * Bounds are checked before every read, so a template that does not match the
 * file fails with a `template-overflow` naming the field rather than returning
 * nonsense. The one exception is `repeat *`, where running out of bytes is the
 * documented way to finish: there it stops and, if it stopped mid record, adds
 * a warning.
 */
export function applyTemplate(
  bytes: Uint8Array,
  template: TemplateNode[],
  startOffset = 0,
  options: { uppercase?: boolean } = {},
): TemplateResult {
  const start = Math.max(0, Math.min(Math.floor(startOffset), bytes.length));
  const state: EvalState = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: start,
    fields: [],
    values: new Map(),
    warnings: [],
    indexPath: [],
    uppercase: options.uppercase === true,
  };
  walk(state, template);
  return { fields: state.fields, endOffset: state.offset, warnings: state.warnings };
}

/* ------------------------------------------------------------------ */
/* format detection                                                   */
/* ------------------------------------------------------------------ */

export interface DetectedType {
  id: string;
  label: string;
  /** Id of the built in template that fits, when there is one. */
  templateId?: string;
}

interface Signature {
  id: string;
  label: string;
  templateId?: string;
  at: number;
  magic: number[];
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/**
 * A small magic number table. Deliberately its own copy rather than a shared
 * import: the file type identifier tool answers "what is this file", which
 * wants breadth, while this one only needs the handful of formats that have a
 * built in template plus the few neighbors a user would otherwise think were
 * missing. Ordered most specific first, so the two byte signatures at the end
 * never shadow a longer match.
 */
const SIGNATURES: Signature[] = [
  { id: "png", label: "PNG image", templateId: "png", at: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { id: "gif", label: "GIF image", templateId: "gif", at: 0, magic: ascii("GIF8") },
  { id: "zip", label: "ZIP archive", templateId: "zip", at: 0, magic: [0x50, 0x4b, 0x03, 0x04] },
  { id: "zip-empty", label: "ZIP archive (empty)", templateId: "zip", at: 0, magic: [0x50, 0x4b, 0x05, 0x06] },
  { id: "zip-spanned", label: "ZIP archive (spanned)", templateId: "zip", at: 0, magic: [0x50, 0x4b, 0x07, 0x08] },
  { id: "elf", label: "ELF executable or shared object", templateId: "elf", at: 0, magic: [0x7f, 0x45, 0x4c, 0x46] },
  { id: "wasm", label: "WebAssembly module", at: 0, magic: [0x00, 0x61, 0x73, 0x6d] },
  { id: "macho-64le", label: "Mach-O 64 bit, little endian", templateId: "macho", at: 0, magic: [0xcf, 0xfa, 0xed, 0xfe] },
  { id: "macho-32le", label: "Mach-O 32 bit, little endian", templateId: "macho", at: 0, magic: [0xce, 0xfa, 0xed, 0xfe] },
  { id: "macho-64be", label: "Mach-O 64 bit, big endian", templateId: "macho", at: 0, magic: [0xfe, 0xed, 0xfa, 0xcf] },
  { id: "macho-32be", label: "Mach-O 32 bit, big endian", templateId: "macho", at: 0, magic: [0xfe, 0xed, 0xfa, 0xce] },
  { id: "fat", label: "Mach-O universal binary or Java class file", at: 0, magic: [0xca, 0xfe, 0xba, 0xbe] },
  { id: "pdf", label: "PDF document", at: 0, magic: ascii("%PDF-") },
  { id: "sqlite", label: "SQLite database", at: 0, magic: ascii("SQLite format 3") },
  { id: "7z", label: "7-Zip archive", at: 0, magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { id: "rar", label: "RAR archive", at: 0, magic: ascii("Rar!") },
  { id: "xz", label: "XZ compressed data", at: 0, magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { id: "zstd", label: "Zstandard compressed data", at: 0, magic: [0x28, 0xb5, 0x2f, 0xfd] },
  { id: "flac", label: "FLAC audio", at: 0, magic: ascii("fLaC") },
  { id: "ogg", label: "Ogg container", at: 0, magic: ascii("OggS") },
  { id: "webp", label: "WebP image", templateId: "wav", at: 8, magic: ascii("WEBP") },
  { id: "wav", label: "WAV audio", templateId: "wav", at: 8, magic: ascii("WAVE") },
  { id: "avi", label: "AVI video", templateId: "wav", at: 8, magic: ascii("AVI ") },
  { id: "mp4", label: "MP4 or ISO base media container", templateId: "mp4", at: 4, magic: ascii("ftyp") },
  { id: "tar", label: "TAR archive", templateId: "tar", at: 257, magic: ascii("ustar") },
  { id: "jpeg", label: "JPEG image", at: 0, magic: [0xff, 0xd8, 0xff] },
  { id: "gzip", label: "gzip compressed data", at: 0, magic: [0x1f, 0x8b] },
  { id: "bzip2", label: "bzip2 compressed data", at: 0, magic: ascii("BZh") },
  { id: "utf8-bom", label: "Text with a UTF-8 byte order mark", templateId: "bom", at: 0, magic: [0xef, 0xbb, 0xbf] },
  { id: "bmp", label: "BMP bitmap", templateId: "bmp", at: 0, magic: ascii("BM") },
  { id: "pe", label: "DOS or Windows PE executable", templateId: "pe", at: 0, magic: ascii("MZ") },
  { id: "riff", label: "RIFF container", templateId: "wav", at: 0, magic: ascii("RIFF") },
  { id: "utf16le-bom", label: "Text with a UTF-16LE byte order mark", templateId: "bom", at: 0, magic: [0xff, 0xfe] },
  { id: "utf16be-bom", label: "Text with a UTF-16BE byte order mark", templateId: "bom", at: 0, magic: [0xfe, 0xff] },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  const { at, magic } = signature;
  if (bytes.length < at + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[at + i] !== magic[i]) return false;
  }
  return true;
}

/** Identify the format by magic bytes, and name the template that fits it. */
export function detectType(bytes: Uint8Array): DetectedType | null {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature)) {
      return {
        id: signature.id,
        label: signature.label,
        ...(signature.templateId ? { templateId: signature.templateId } : {}),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* strings                                                            */
/* ------------------------------------------------------------------ */

export interface ExtractedString {
  offset: number;
  text: string;
  encoding: "ascii" | "utf16le";
}

export interface ExtractStringsOptions {
  /** Shortest run worth reporting. Default 4. */
  minLength?: number;
  /** "ascii" for single byte runs, "utf16le" for ASCII interleaved with NULs. */
  encoding?: "ascii" | "utf16le";
  /** Stop after this many runs. Default 500. */
  limit?: number;
}

/**
 * Printable runs with their offsets, the `strings(1)` idea. UTF-16LE mode looks
 * for printable bytes at even positions with a NUL after each, which is what
 * Windows resource strings and .NET metadata actually look like on disk.
 */
export function extractStrings(
  bytes: Uint8Array,
  options: ExtractStringsOptions = {},
): ExtractedString[] {
  const minLength = Math.max(1, Math.floor(options.minLength ?? 4));
  const encoding = options.encoding === "utf16le" ? "utf16le" : "ascii";
  const limit = Math.max(1, Math.floor(options.limit ?? MAX_STRINGS));
  const step = encoding === "utf16le" ? 2 : 1;
  const found: ExtractedString[] = [];

  let runStart = -1;
  let run = "";

  const flush = (): boolean => {
    if (run.length >= minLength) {
      found.push({ offset: runStart, text: run, encoding });
    }
    runStart = -1;
    run = "";
    return found.length < limit;
  };

  for (let i = 0; i + step <= bytes.length; i += step) {
    const byte = bytes[i];
    const printable =
      byte >= 0x20 && byte <= 0x7e && (encoding === "ascii" || bytes[i + 1] === 0x00);
    if (printable) {
      if (runStart < 0) runStart = i;
      run += String.fromCharCode(byte);
    } else if (runStart >= 0) {
      if (!flush()) return found;
    }
  }
  if (runStart >= 0) flush();
  return found.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* entropy                                                            */
/* ------------------------------------------------------------------ */

/** Shannon entropy in bits per byte: 0 for one repeated byte, 8 at the ceiling. */
export function entropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let total = 0;
  for (let i = 0; i < 256; i++) {
    const count = counts[i];
    if (count === 0) continue;
    const p = count / bytes.length;
    total -= p * Math.log2(p);
  }
  return total;
}

/** Per block entropy, for a sparkline that shows where the packed regions are. */
export function entropyBlocks(bytes: Uint8Array, blockSize = 4096): number[] {
  const size = Math.max(1, Math.floor(blockSize));
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(entropy(bytes.subarray(i, Math.min(i + size, bytes.length))));
  }
  return out;
}

const SPARK = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  return values
    .map((v) => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.floor((v / 8) * SPARK.length)))])
    .join("");
}

function entropyVerdict(bits: number): string {
  if (bits < 0.5) return "one byte value dominates, so this region is padding or a blank run";
  if (bits < 4.5) return "low, the shape of text, source code, or a sparse binary";
  if (bits < 7) return "mixed, the shape of a binary with headers, tables, and code";
  if (bits < 7.5) return "high, the shape of packed or already compressed data";
  return "near the 8 bit ceiling, the shape of compressed or encrypted data";
}

/* ------------------------------------------------------------------ */
/* options                                                            */
/* ------------------------------------------------------------------ */

export interface HexViewerOpts {
  view?: string;
  template?: string;
  customTemplate?: string;
  bytesPerRow?: number;
  offset?: number;
  uppercase?: boolean;
  [key: string]: unknown;
}

export type ViewId = "dump" | "template" | "strings" | "info";

const VIEW_ALIASES: Record<string, ViewId> = {
  dump: "dump",
  hex: "dump",
  hexdump: "dump",
  bytes: "dump",
  template: "template",
  struct: "template",
  fields: "template",
  strings: "strings",
  text: "strings",
  info: "info",
  summary: "info",
  stats: "info",
};

function normalizeView(value: unknown): ViewId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VIEW_ALIASES[id] ?? "dump";
}

function normalizeTemplate(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (id === "custom") return "custom";
  if (findTemplate(id)) return id;
  return "auto";
}

function clampOffset(value: unknown, length: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (n <= 0) return 0;
  return Math.min(n, length);
}

/* ------------------------------------------------------------------ */
/* views                                                              */
/* ------------------------------------------------------------------ */

function dumpView(bytes: Uint8Array, opts: HexViewerOpts): string {
  const requested =
    typeof opts?.offset === "number" && Number.isFinite(opts.offset) ? Math.floor(opts.offset) : 0;
  const start = Math.max(0, Math.min(requested, bytes.length - 1));
  const shown = Math.min(DUMP_WINDOW_BYTES, bytes.length - start);
  const dump = hexDump(bytes, {
    offset: start,
    length: shown,
    bytesPerRow: opts?.bytesPerRow,
    uppercase: opts?.uppercase === true,
  });

  const notes: string[] = [];
  if (requested >= bytes.length && bytes.length > 0) {
    notes.push(
      `Offset 0x${requested.toString(16)} is past the end of these ${formatByteCount(bytes.length)}, so the window starts at the last byte instead.`,
    );
  }
  if (shown < bytes.length - start || start > 0) {
    notes.push(
      `Showing ${formatByteCount(shown)} of ${formatByteCount(bytes.length)}, offset 0x${start.toString(16)} to 0x${(start + Math.max(0, shown - 1)).toString(16)}. Change the start offset to move the window.`,
    );
  }
  if (notes.length === 0) return dump;
  return dump === "" ? notes.join("\n") : `${dump}\n\n${notes.join("\n")}`;
}

function templateRow(field: TemplateField): string {
  const value = typeof field.value === "bigint" ? field.value.toString() : String(field.value);
  const at = `${field.type} @ 0x${field.offset.toString(16)}`;
  if (field.type.startsWith("bytes[") || field.hex === "" || value === field.hex) {
    return `${value === "" ? "(empty)" : value} (${at})`;
  }
  return `${value === "" ? "(empty)" : value} (${at}, raw ${field.hex})`;
}

function templateView(bytes: Uint8Array, opts: HexViewerOpts): Record<string, string> {
  const choice = normalizeTemplate(opts?.template);
  const detected = detectType(bytes);

  let source: string;
  let label: string;

  if (choice === "custom") {
    const text = typeof opts?.customTemplate === "string" ? opts.customTemplate : "";
    if (text.trim() === "") {
      throw new ToolError(
        "bad-template",
        "The custom template is empty, so there is nothing to apply.",
        "Write one field per line, for example: char[4] magic then u32be length. Or switch the template option to a built in one.",
      );
    }
    source = text;
    label = "Custom";
  } else if (choice === "auto") {
    if (!detected?.templateId) {
      return {
        "Detected type": detected ? detected.label : "Not recognized by magic bytes",
        Template: "No built in template matches these bytes.",
        "Next step": `Pick a template from the list, or choose Custom and write one. The built in templates are ${BUILTIN_TEMPLATES.map((t) => t.label).join(", ")}.`,
        "First bytes": hexDump(bytes, { length: Math.min(32, bytes.length) }),
      };
    }
    const builtin = findTemplate(detected.templateId);
    source = builtin?.text ?? "";
    label = `${builtin?.label ?? detected.templateId} (matched by magic bytes)`;
  } else {
    const builtin = findTemplate(choice);
    source = builtin?.text ?? "";
    label = builtin?.label ?? choice;
  }

  const start = clampOffset(opts?.offset, bytes.length);
  const nodes = parseTemplate(source);
  const result = applyTemplate(bytes, nodes, start, { uppercase: opts?.uppercase === true });

  const rows: Record<string, string> = {
    Template: label,
    "Detected type": detected ? detected.label : "Not recognized by magic bytes",
    "Fields read": `${result.fields.length} from offset 0x${start.toString(16)} to 0x${result.endOffset.toString(16)} (${formatByteCount(result.endOffset - start)})`,
  };
  if (result.warnings.length > 0) rows.Warnings = result.warnings.join("\n");
  if (result.fields.length === 0) {
    rows.Fields = "The template read no fields from these bytes.";
    return rows;
  }

  for (const field of result.fields) {
    let key = field.name;
    let n = 2;
    while (rows[key] !== undefined) key = `${field.name} (${n++})`;
    rows[key] = templateRow(field);
  }
  return rows;
}

function stringsSection(
  bytes: Uint8Array,
  encoding: "ascii" | "utf16le",
  heading: string,
): string[] {
  const found = extractStrings(bytes, { encoding, limit: MAX_STRINGS + 1 });
  const capped = found.slice(0, MAX_STRINGS);
  const lines = [
    `${heading}: ${capped.length}${found.length > MAX_STRINGS ? ` shown, capped at ${MAX_STRINGS}` : ""}`,
  ];
  if (capped.length === 0) {
    lines.push("  none found");
    return lines;
  }
  for (const item of capped) {
    lines.push(`  ${offsetHex(item.offset, false)}  ${item.text}`);
  }
  return lines;
}

function stringsView(bytes: Uint8Array): string {
  return [
    ...stringsSection(bytes, "ascii", "ASCII runs of 4 characters or more"),
    "",
    ...stringsSection(bytes, "utf16le", "UTF-16LE runs of 4 characters or more"),
  ].join("\n");
}

function infoView(bytes: Uint8Array, encoding: InputEncoding): Record<string, string> {
  const detected = detectType(bytes);
  const bits = entropy(bytes);
  // Aim for 64 bars, but never below 256 bytes a block: entropy over a handful
  // of bytes is capped well under 8 by the block size alone, so a small file
  // would draw a flat map that disagrees with its own entropy number.
  const blockSize = Math.min(bytes.length, Math.max(256, Math.ceil(bytes.length / 64)));
  const blocks = entropyBlocks(bytes, blockSize);

  let printable = 0;
  let nulls = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable++;
    }
    if (byte === 0) nulls++;
  }

  const head = bytes.subarray(0, Math.min(16, bytes.length));
  const headHex = bytesToHex(head).replace(/(..)/g, "$1 ").trim();
  let headAscii = "";
  for (let i = 0; i < head.length; i++) headAscii += printableChar(head[i]);

  const rows: Record<string, string> = {
    Size:
      bytes.length < 1024
        ? formatByteCount(bytes.length)
        : `${formatByteCount(bytes.length)} (${formatBytes(bytes.length)})`,
    Input: encoding,
    "Detected type": detected
      ? detected.label
      : "Not recognized by magic bytes. It may be plain data, an encrypted blob, or a format without a signature.",
    "Suggested template": detected?.templateId
      ? (findTemplate(detected.templateId)?.label ?? detected.templateId)
      : "None built in for this format",
    "First 16 bytes": `${headHex}  |${headAscii}|`,
    "SHA-256": bytesToHex(sha256(bytes)),
    Entropy: `${bits.toFixed(3)} bits per byte, ${entropyVerdict(bits)}`,
    "Entropy map": `${sparkline(blocks)}  (${blocks.length} ${blocks.length === 1 ? "block" : "blocks"} of ${formatByteCount(blockSize)}, low to high)`,
    "Printable ASCII": `${((printable / bytes.length) * 100).toFixed(1)}% of bytes`,
    "NUL bytes": `${((nulls / bytes.length) * 100).toFixed(1)}% of bytes`,
  };
  return rows;
}

/* ------------------------------------------------------------------ */
/* entry point                                                        */
/* ------------------------------------------------------------------ */

export function run(
  input: Uint8Array | string,
  opts: HexViewerOpts = {},
): string | Record<string, string> {
  const { bytes, encoding } = toBytes(input);
  if (bytes.length > MAX_INPUT_BYTES) throw tooLarge(bytes.length);

  switch (normalizeView(opts?.view)) {
    case "template":
      return templateView(bytes, opts);
    case "strings":
      return stringsView(bytes);
    case "info":
      return infoView(bytes, encoding);
    default:
      return dumpView(bytes, opts);
  }
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  string | Record<string, string>,
  HexViewerOpts
>;
