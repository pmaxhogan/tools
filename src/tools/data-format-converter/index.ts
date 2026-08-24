import Papa from "papaparse";
import * as TOML from "smol-toml";
import YAML from "yaml";
import { ToolError, type ToolLogic } from "../types";

export type DataFormat = "csv" | "json" | "yaml" | "toml";

const FORMATS: readonly DataFormat[] = ["csv", "json", "yaml", "toml"];

export interface ConvertOpts {
  /** Source format, or 'auto' to sniff it from the text. */
  from: "auto" | DataFormat;
  /** Target format. */
  to: DataFormat;
  /** Pretty-print width for JSON and YAML. 0 minifies JSON (YAML clamps to 2). */
  indent: number;
  /** First CSV row is a header. When false, columns are named col1, col2, and so on. */
  csvHeader: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** True for objects that behave like a record: not null, not an array, not a Date. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Library errors are often multi-line with a source excerpt. Keep the headline. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.trim();
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function clampIndent(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(8, Math.max(0, Math.floor(n)));
}

function asFormat(raw: unknown, field: "from" | "to"): DataFormat {
  const value = String(raw ?? "").toLowerCase();
  if ((FORMATS as readonly string[]).includes(value)) return value as DataFormat;
  throw new ToolError(
    "unknown-format",
    `Unknown ${field} format "${String(raw)}".`,
    "Choose one of csv, json, yaml, or toml.",
  );
}

/* ------------------------------------------------------------------ *
 * Parsers (one per format). Each throws a typed ToolError on failure,
 * so an explicit source format reports exactly what went wrong.
 * ------------------------------------------------------------------ */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ToolError(
      "invalid-json",
      `JSON parse failed: ${firstLine(err)}`,
      "Strict JSON needs double-quoted keys and strings, and no trailing commas or comments.",
    );
  }
}

function parseYaml(text: string): unknown {
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new ToolError(
      "invalid-yaml",
      `YAML parse failed: ${firstLine(err)}`,
      "Check the indentation (spaces only, never tabs) and that every key is followed by a colon and a space.",
    );
  }
}

function parseToml(text: string): unknown {
  try {
    return TOML.parse(text);
  } catch (err) {
    throw new ToolError(
      "invalid-toml",
      `TOML parse failed: ${firstLine(err)}`,
      "Every line must be a key = value pair, a [table] header, or a # comment.",
    );
  }
}

/**
 * papaparse with delimiter sniffing, so comma, semicolon, pipe, and tab
 * separated text all parse. dynamicTyping turns 30 into a number and true
 * into a boolean, which is what the JSON, YAML, and TOML outputs want.
 */
function parseCsv(text: string, csvHeader: boolean): unknown {
  const result = Papa.parse<unknown>(text, {
    header: csvHeader,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  // UndetectableDelimiter is a warning, not a failure: a single column file
  // is still perfectly good CSV once the user has picked the format by hand.
  const fatal = result.errors.filter((e) => e.code !== "UndetectableDelimiter");
  if (fatal.length > 0) {
    const first = fatal[0]!;
    const where = typeof first.row === "number" ? ` on row ${first.row + 1}` : "";
    throw new ToolError(
      "invalid-csv",
      `CSV parse failed${where}: ${first.message}`,
      "Make sure every row has the same number of fields and that quoted fields are closed.",
    );
  }

  if (csvHeader) return result.data;

  // Headerless mode: name the columns col1, col2, and so on.
  return (result.data as unknown[][]).map((row) => {
    const record: Record<string, unknown> = {};
    row.forEach((cell, i) => {
      record[`col${i + 1}`] = cell;
    });
    return record;
  });
}

function parseAs(text: string, format: DataFormat, csvHeader: boolean): unknown {
  switch (format) {
    case "json":
      return parseJson(text);
    case "yaml":
      return parseYaml(text);
    case "toml":
      return parseToml(text);
    case "csv":
      return parseCsv(text, csvHeader);
  }
}

/* ------------------------------------------------------------------ *
 * Auto-detection
 *
 * Order matters, because the parsers overlap. Every step below is a
 * silent try: a failure just moves to the next candidate, and only the
 * explicit source formats above report parse errors.
 *
 *   1. JSON, strict. Every valid JSON document is JSON, full stop.
 *      (YAML is a JSON superset, so JSON has to be tested first.)
 *   2. TOML, but only when the text has a "key = value" line or a
 *      [section] header. smol-toml is happy to accept fragments that a
 *      user meant as something else, so the shape hint keeps it honest.
 *   3. YAML, rejecting a plain string or a null result. YAML parses any
 *      prose as one long scalar, which means "it parsed" proves nothing
 *      unless the result came out structured.
 *   4. CSV, requiring a sniffed delimiter, at least two rows, at least
 *      two columns, and the same column count on every row.
 * ------------------------------------------------------------------ */

const TOML_HINT = /^\s*(\[[^\]\n]+\]\s*$|[^#\s=[\n][^\n=]*=)/m;

/** Structural CSV check: consistent delimiter usage on every line. */
function looksLikeCsv(text: string): boolean {
  const result = Papa.parse<unknown[]>(text, { skipEmptyLines: true });
  if (result.errors.length > 0) return false;
  if (!result.meta.delimiter) return false;
  const rows = result.data;
  if (rows.length < 2) return false;
  const width = rows[0]!.length;
  if (width < 2) return false;
  return rows.every((row) => row.length === width);
}

interface Detected {
  format: DataFormat;
  value: unknown;
}

function detect(text: string, csvHeader: boolean): Detected {
  try {
    return { format: "json", value: JSON.parse(text) };
  } catch {
    /* not JSON, keep looking */
  }

  if (TOML_HINT.test(text)) {
    try {
      return { format: "toml", value: TOML.parse(text) };
    } catch {
      /* the hint matched but the document did not parse, keep looking */
    }
  }

  try {
    const value = YAML.parse(text);
    if (value !== null && value !== undefined && typeof value !== "string") {
      return { format: "yaml", value };
    }
  } catch {
    /* not YAML, keep looking */
  }

  if (looksLikeCsv(text)) {
    return { format: "csv", value: parseCsv(text, csvHeader) };
  }

  throw new ToolError(
    "undetected-format",
    "Could not tell what format this text is.",
    'Pick the source format explicitly with the "From" option, or check the text for a typo.',
  );
}

/** Public helper: which format does auto-detection think this text is? */
export function detectFormat(text: string, csvHeader = true): DataFormat {
  return detect(stripBom(text ?? "").trim(), csvHeader).format;
}

/* ------------------------------------------------------------------ *
 * Value normalization
 * ------------------------------------------------------------------ */

/**
 * smol-toml returns TomlDate (a Date subclass) for TOML date values. JSON,
 * YAML, and CSV all want a plain ISO 8601 string instead, so flatten dates
 * on the way out of everything except a TOML target.
 */
function datesToIso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(datesToIso);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = datesToIso(item);
    return out;
  }
  return value;
}

/** Remove null and undefined, collecting dotted paths for the TOML comment. */
function stripNullish(value: unknown, path: string, dropped: string[]): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((item, i) => {
      const here = `${path}[${i}]`;
      if (item === null || item === undefined) {
        dropped.push(here);
        return;
      }
      out.push(stripNullish(item, here, dropped));
    });
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (item === null || item === undefined) {
        dropped.push(here);
        continue;
      }
      out[key] = stripNullish(item, here, dropped);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Serialisers
 * ------------------------------------------------------------------ */

function toJson(value: unknown, indent: number): string {
  const text = indent > 0 ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  return text ?? "null";
}

function toYaml(value: unknown, indent: number): string {
  // The yaml package rejects an indent of 0, and "0 means minified" is a
  // JSON-only idea anyway, so fall back to the default width of 2.
  return YAML.stringify(value, { indent: indent > 0 ? indent : 2 });
}

/** One CSV cell. Anything still structured after flattening becomes inline JSON. */
function toCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Flatten one level of nesting into dotted keys: { a: { b: 1 } } becomes
 * the column "a.b". Anything deeper than that (or an array value) is
 * serialized into the cell as inline JSON rather than exploding into an
 * unbounded number of columns.
 */
function flattenRow(row: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        out[`${key}.${inner}`] = toCell(innerValue);
      }
    } else {
      out[key] = toCell(value);
    }
  }
  return out;
}

function notTabular(detail: string): ToolError {
  return new ToolError(
    "not-tabular",
    `CSV needs rows and columns, and ${detail}`,
    "Convert to JSON or YAML instead, or reshape the data into an array of objects with the same keys.",
  );
}

function toCsv(value: unknown): string {
  let rows: unknown[];
  if (Array.isArray(value)) {
    rows = value;
  } else if (isPlainObject(value)) {
    rows = [value]; // a single object is a one row table
  } else {
    throw notTabular("this input is a single scalar value.");
  }

  if (rows.length === 0) return "";

  // Array of arrays: already a grid, so emit it as is with no header row.
  if (rows.every((row) => Array.isArray(row))) {
    const grid = (rows as unknown[][]).map((row) => row.map(toCell));
    return Papa.unparse(grid, { newline: "\n" });
  }

  if (!rows.every((row) => isPlainObject(row))) {
    throw notTabular("this input mixes scalars with objects or arrays.");
  }

  const flat = (rows as Record<string, unknown>[]).map(flattenRow);
  const fields: string[] = [];
  for (const row of flat) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) fields.push(key);
    }
  }
  // Build the grid by field name so rows with missing keys keep their columns.
  const data = flat.map((row) => fields.map((field) => (field in row ? row[field]! : "")));
  return Papa.unparse({ fields, data }, { newline: "\n" });
}

function toToml(value: unknown): string {
  const notes: string[] = [];
  let root: unknown = value;

  // TOML documents are always a table at the root, so anything else gets a
  // wrapper key and a comment saying so.
  if (Array.isArray(value)) {
    root = { items: value };
    notes.push(
      '# Root array wrapped under an "items" key because TOML requires a table at the root.',
    );
  } else if (!isPlainObject(value)) {
    root = { value };
    notes.push(
      '# Root scalar wrapped under a "value" key because TOML requires a table at the root.',
    );
  }

  const dropped: string[] = [];
  const cleaned = stripNullish(root, "", dropped);
  if (dropped.length > 0) {
    notes.push(`# TOML has no null, so these keys were dropped: ${dropped.join(", ")}`);
  }

  const body = TOML.stringify(cleaned as Record<string, unknown>);
  return notes.length > 0 ? `${notes.join("\n")}\n${body}` : body;
}

/**
 * Normalize then write. Both halves sit inside one try, because a pathological
 * input (a YAML anchor that points at its own parent, say) blows up during the
 * walk rather than during the write.
 */
function convert(parsed: unknown, to: DataFormat, indent: number): string {
  try {
    const value = to === "toml" ? parsed : datesToIso(parsed);
    switch (to) {
      case "json":
        return toJson(value, indent);
      case "yaml":
        return toYaml(value, indent);
      case "toml":
        return toToml(value);
      case "csv":
        return toCsv(value);
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    // A circular structure recurses forever and lands here as a RangeError.
    const detail =
      err instanceof RangeError ? "the structure is circular or too deeply nested" : firstLine(err);
    throw new ToolError(
      "conversion-failed",
      `Could not write this data as ${to.toUpperCase()}: ${detail}.`,
      "None of these formats can hold a circular reference, so remove any anchor that points back at its own parent.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function run(input: string, opts: ConvertOpts): string {
  const text = stripBom(input ?? "").trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "There is nothing to convert.",
      "Paste or drop some CSV, JSON, YAML, or TOML into the input.",
    );
  }

  const to = asFormat(opts?.to ?? "json", "to");
  const csvHeader = opts?.csvHeader !== false;
  const indent = clampIndent(opts?.indent ?? 2);
  const fromOpt = opts?.from ?? "auto";

  // from === to still runs a full parse and re-serialize, which is what
  // reformats the document: json to json applies the indent, csv to csv
  // normalizes quoting and line endings.
  const parsed =
    fromOpt === "auto"
      ? detect(text, csvHeader).value
      : parseAs(text, asFormat(fromOpt, "from"), csvHeader);

  return convert(parsed, to, indent);
}

export default { run } satisfies ToolLogic<string, string, ConvertOpts>;
