import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import type { AsyncBuffer, FileMetaData, SchemaElement, SchemaTree } from "hyparquet";
import { formatBytes } from "../../lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Parquet reader.
 *
 * hyparquet is pure JavaScript with no dependencies, so unlike the SQLite
 * browser this module can do the real work itself: the whole file is decoded
 * here and the panel only draws the result. Everything below stays free of the
 * DOM and of fetch, which is why the AsyncBuffer wrapper is hand rolled instead
 * of using hyparquet's `asyncBufferFromUrl` or `asyncBufferFromFile`.
 */

/** Every Parquet file opens and closes with these four bytes. */
const PARQUET_MAGIC = "PAR1";
/** Arrow IPC files open with this instead. Detected so the error can be honest. */
const ARROW_MAGIC = "ARROW1";

/** The footer is four magic bytes plus a four byte metadata length. */
const MIN_PARQUET_BYTES = 12;

/** Refuse anything past this: the whole file is decoded in memory. */
const MAX_BYTES = 200 * 1024 * 1024;

/** Distinct values are counted up to here, then reported as "at least". */
const DISTINCT_CAP = 1000;

const CELL_CAP = 40;
const MIN_COL_WIDTH = 3;

const DEFAULT_PREVIEW_ROWS = 20;
const MIN_PREVIEW_ROWS = 5;
const MAX_PREVIEW_ROWS = 200;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** One line of the schema: a leaf column or an intermediate group. */
export interface ParquetColumnSchema {
  /** Dotted path, so a nested field reads `address.city`. */
  name: string;
  /** Physical type, or "group" for a struct, list or map wrapper. */
  type: string;
  /** Logical or converted type when the file declares one, e.g. "UTF8". */
  logicalType?: string;
  /** REQUIRED, OPTIONAL or REPEATED. */
  repetition: string;
}

/** Everything worth showing from the file footer. */
export interface ParquetMetadataSummary {
  /** Size of the file in bytes. */
  fileSize: number;
  /** Parquet format version recorded in the footer. */
  version: number;
  /** Writer that produced the file, when it said so. */
  createdBy?: string;
  /** Distinct compression codecs across every column chunk, sorted. */
  codecs: string[];
  /** Footer key/value metadata, as written (pandas, geo, and so on). */
  keyValue: { key: string; value?: string }[];
  /** Bytes the footer itself occupies. */
  metadataLength: number;
  /** Summed column chunk sizes across every row group. */
  compressedSize: number;
  uncompressedSize: number;
}

export interface ParquetFile {
  metadata: ParquetMetadataSummary;
  schema: ParquetColumnSchema[];
  /** Rows in the whole file, not in the preview. */
  rowCount: number;
  rowGroups: number;
  /** Top level column names, in file order. */
  columns: string[];
  /** The first N rows, decoded. */
  rows: Record<string, unknown>[];
}

export interface ReadParquetOptions {
  /** How many rows to decode for the preview. Default 20. */
  rows?: number;
  /** Restrict the decode to these top level columns. */
  columns?: string[];
}

/** What `summarizeColumn` reports about one column's sampled values. */
export interface ColumnSummary {
  /** Values inspected, nulls included. */
  total: number;
  nulls: number;
  /** Distinct non null values, counted up to DISTINCT_CAP. */
  distinct: number;
  /** True when the distinct count hit the cap and is a lower bound. */
  distinctCapped: boolean;
  /** Comparable values only: numbers, strings and dates. */
  min?: string;
  max?: string;
}

export interface ParquetOpts {
  /** Rows shown in the preview. */
  rows: number;
  /** Add per column stats sampled from the preview. */
  stats: boolean;
  /** summary | schema | preview | csv */
  view: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

function startsWithAscii(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function endsWithAscii(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  const start = bytes.length - text.length;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Decode pasted base64. A Parquet file is binary, so text input can only mean
 * base64: anything else is rejected rather than silently read as bytes.
 */
function decodeBase64(raw: string): Uint8Array {
  const withoutPrefix = raw.replace(/^data:[^,]*,/, "");
  const cleaned = withoutPrefix.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (cleaned === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to read yet.",
      "Drop a .parquet file onto the input, or pick one with the file button.",
    );
  }

  if ((cleaned.length * 3) / 4 > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `That is more than ${formatBytes(MAX_BYTES)} of data, which is past what this page will decode in memory.`,
      "Slice the file down with DuckDB, pandas or pyarrow first, or open it in a desktop tool.",
    );
  }

  const body = cleaned.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1) {
    throw new ToolError(
      "bad-encoding",
      "That text is not base64, and a Parquet file is binary so text input has to be base64.",
      "Drop the .parquet file onto the input instead, or paste the file encoded as base64.",
    );
  }

  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new ToolError(
      "bad-encoding",
      "That text could not be decoded as base64.",
      "Drop the .parquet file onto the input instead, or paste the file encoded as base64.",
    );
  }

  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Normalize the two shapes `run` can receive into raw bytes. */
export function toBytes(input: Uint8Array | string): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 0) {
      throw new ToolError(
        "empty-input",
        "That file is empty.",
        "Pick a .parquet file that actually has bytes in it.",
      );
    }
    return input;
  }

  const text = String(input ?? "").trim();
  if (text === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to read yet.",
      "Drop a .parquet file onto the input, or pick one with the file button.",
    );
  }
  return decodeBase64(text);
}

/**
 * Reject anything that is not a Parquet file, and name what it is when we can.
 * Arrow IPC gets its own message because the two formats travel together and
 * hyparquet cannot read Arrow at all.
 */
export function assertParquet(bytes: Uint8Array): void {
  if (bytes.length > MAX_BYTES) {
    throw new ToolError(
      "too-large",
      `That file is ${formatBytes(bytes.length)}, which is past the ${formatBytes(MAX_BYTES)} this page will decode in memory.`,
      "Slice the file down with DuckDB, pandas or pyarrow first, or open it in a desktop tool.",
    );
  }

  if (startsWithAscii(bytes, ARROW_MAGIC)) {
    throw new ToolError(
      "arrow-unsupported",
      "Arrow IPC files are not supported yet; export as Parquet.",
      "In pyarrow, read the file with pyarrow.ipc and write it back out with pyarrow.parquet.write_table, then drop the .parquet file here.",
    );
  }

  const head = startsWithAscii(bytes, PARQUET_MAGIC);
  const tail = endsWithAscii(bytes, PARQUET_MAGIC);
  if (bytes.length < MIN_PARQUET_BYTES || !head || !tail) {
    throw new ToolError(
      "not-parquet",
      'This is not a Parquet file. Every Parquet file starts and ends with the four bytes "PAR1", and this one does not.',
      "Check that you picked the right file. A .parquet written by Spark, DuckDB, pandas or pyarrow will pass this check; an Arrow, Avro, ORC or CSV file will not.",
    );
  }
}

/**
 * Wrap bytes as the AsyncBuffer hyparquet reads through. The copy is skipped
 * when the Uint8Array already spans a whole ArrayBuffer, which is the normal
 * case for a file the shell just read.
 */
export function asyncBufferFrom(bytes: Uint8Array): AsyncBuffer {
  const source = bytes.buffer;
  const spansWholeBuffer =
    bytes.byteOffset === 0 &&
    bytes.byteLength === source.byteLength &&
    source instanceof ArrayBuffer;

  const buffer: ArrayBuffer = spansWholeBuffer
    ? (source as ArrayBuffer)
    : (source.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  return {
    byteLength: buffer.byteLength,
    slice: (start: number, end?: number) =>
      end === undefined ? buffer.slice(start) : buffer.slice(start, end),
  };
}

/* ------------------------------------------------------------------ */
/* schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * A readable name for a column's logical type. Parquet has two overlapping
 * annotation systems: the old `converted_type` enum and the newer
 * `logical_type` struct. Writers often set only one, so both are consulted.
 */
export function describeLogicalType(element: SchemaElement): string | undefined {
  const logical = element.logical_type;
  if (logical) {
    switch (logical.type) {
      case "DECIMAL":
        return `DECIMAL(${logical.precision}, ${logical.scale})`;
      case "TIMESTAMP":
      case "TIME":
        return `${logical.type}(${logical.unit}${logical.isAdjustedToUTC ? ", UTC" : ""})`;
      case "INTEGER":
        return `INTEGER(${logical.bitWidth}, ${logical.isSigned ? "signed" : "unsigned"})`;
      default:
        return logical.type;
    }
  }
  return element.converted_type;
}

/** Flatten the schema tree, groups included, into one line per node. */
export function collectSchema(tree: SchemaTree): ParquetColumnSchema[] {
  const out: ParquetColumnSchema[] = [];

  const walk = (node: SchemaTree): void => {
    for (const child of node.children ?? []) {
      const element = child.element;
      const logical = describeLogicalType(element);
      out.push({
        name: child.path.join("."),
        type: element.type ?? "group",
        repetition: element.repetition_type ?? "REQUIRED",
        ...(logical ? { logicalType: logical } : {}),
      });
      walk(child);
    }
  };

  walk(tree);
  return out;
}

/** The schema block: one line per column, names aligned. */
export function renderSchema(schema: ParquetColumnSchema[]): string {
  if (schema.length === 0) return "This file declares no columns.";

  const width = Math.max(...schema.map((column) => column.name.length + 1));
  return schema
    .map((column) => {
      const logical = column.logicalType ? ` (${column.logicalType})` : "";
      return `${`${column.name}:`.padEnd(width)} ${column.type}${logical} ${column.repetition}`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* values                                                              */
/* ------------------------------------------------------------------ */

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * One decoded cell as display text. Parquet carries types JSON does not, so
 * INT64 arrives as a bigint, timestamps as Date objects and BYTE_ARRAY columns
 * without a UTF8 annotation as raw bytes; each gets an honest rendering rather
 * than "[object Object]".
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (isBinary(value)) {
    const size = value.byteLength;
    return `<binary ${size} ${size === 1 ? "byte" : "bytes"}>`;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value, (_key, inner) =>
        typeof inner === "bigint" ? inner.toString() : inner,
      );
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function displayCell(value: unknown): string {
  const flat = formatValue(value)
    .replace(/\r\n|\r|\n|\t/g, " ")
    .replace(/\|/g, "\\|");
  return flat.length > CELL_CAP ? `${flat.slice(0, CELL_CAP - 1)}…` : flat;
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function summarizeMetadata(metadata: FileMetaData, fileSize: number): ParquetMetadataSummary {
  const codecs = new Set<string>();
  let compressedSize = 0;
  let uncompressedSize = 0;

  for (const group of metadata.row_groups ?? []) {
    for (const chunk of group.columns ?? []) {
      const meta = chunk.meta_data;
      if (!meta) continue;
      codecs.add(meta.codec);
      compressedSize += Number(meta.total_compressed_size ?? 0n);
      uncompressedSize += Number(meta.total_uncompressed_size ?? 0n);
    }
  }

  return {
    fileSize,
    version: metadata.version,
    ...(metadata.created_by ? { createdBy: metadata.created_by } : {}),
    codecs: [...codecs].sort(),
    keyValue: metadata.key_value_metadata ?? [],
    metadataLength: metadata.metadata_length,
    compressedSize,
    uncompressedSize,
  };
}

/**
 * Open a Parquet file: validate it, read the footer, then decode the first N
 * rows. Only the preview rows are decoded, so a file with millions of rows
 * still opens in the time it takes to read one row group.
 */
export async function readParquet(
  bytes: Uint8Array,
  opts: ReadParquetOptions = {},
): Promise<ParquetFile> {
  assertParquet(bytes);

  const previewRows = clampInt(opts.rows, 1, 100000, DEFAULT_PREVIEW_ROWS);
  const file = asyncBufferFrom(bytes);

  let metadata: FileMetaData;
  let schema: ParquetColumnSchema[];
  let columns: string[];
  let rowCount: number;

  try {
    metadata = await parquetMetadataAsync(file);
    const tree = parquetSchema(metadata);
    schema = collectSchema(tree);
    columns = (tree.children ?? []).map((child) => child.element.name);
    rowCount = Number(metadata.num_rows ?? 0n);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      "read-failed",
      `Could not read this Parquet file: ${errorText(e)}.`,
      "The footer may be truncated, the file may have been written by an encoder this reader does not understand, or it may be encrypted.",
    );
  }

  const wanted = opts.columns?.filter((name) => columns.includes(name)) ?? [];
  const rowEnd = Math.min(previewRows, rowCount);

  let rows: Record<string, unknown>[] = [];
  if (rowEnd > 0) {
    try {
      rows = await parquetReadObjects({
        file,
        metadata,
        rowStart: 0,
        rowEnd,
        ...(wanted.length > 0 ? { columns: wanted } : {}),
      });
    } catch (e) {
      throw new ToolError(
        "read-failed",
        `Read the schema, but could not decode the rows: ${errorText(e)}.`,
        "This usually means a compression codec the reader does not ship, such as brotli or lzo. Re-encode the file with snappy, gzip, zstd or no compression.",
      );
    }
  }

  return {
    metadata: summarizeMetadata(metadata, bytes.length),
    schema,
    rowCount,
    rowGroups: (metadata.row_groups ?? []).length,
    columns: wanted.length > 0 ? wanted : columns,
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Decoded rows as CSV. NULL becomes an empty field, matching what pandas,
 * DuckDB and every spreadsheet export does, and binary cells keep their
 * `<binary N bytes>` placeholder because raw bytes have no honest CSV form.
 */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const escape = (raw: string): string =>
    /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;

  const cell = (value: unknown): string =>
    value === null || value === undefined ? "" : escape(formatValue(value));

  const lines = [columns.map((name) => escape(name)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((name) => cell(row[name])).join(","));
  }
  return lines.join("\n");
}

/** The preview table: a count line, an aligned header, then the rows. */
export function renderPreview(
  rows: Record<string, unknown>[],
  columns: string[],
  totalRows: number,
): string {
  if (columns.length === 0) return "This file declares no columns.";
  if (rows.length === 0) {
    return totalRows === 0 ? "This file has no rows." : "No rows were decoded.";
  }

  const header = columns.map((name) => displayCell(name));
  const body = rows.map((row) => columns.map((name) => displayCell(row[name])));

  const widths = header.map((text, i) =>
    Math.max(MIN_COL_WIDTH, text.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;

  const out = [line(header), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`];
  for (const row of body) out.push(line(row));

  if (rows.length < totalRows) {
    const remaining = totalRows - rows.length;
    out.push(`... ${remaining} more ${remaining === 1 ? "row" : "rows"} (${totalRows} total)`);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

type SortableKind = "number" | "date" | "text" | "mixed";

function kindOf(value: unknown): SortableKind {
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return "text";
  return "mixed";
}

/**
 * Null count, distinct count and range for one column's values. Distinct is
 * capped so a column of a million unique ids cannot blow up a Set, and min/max
 * only appear for values that have a real order: numbers, dates and strings.
 * Mixed or structured columns report the first two and skip the range.
 */
export function summarizeColumn(values: unknown[]): ColumnSummary {
  const total = values.length;
  const present: unknown[] = [];
  let nulls = 0;

  for (const value of values) {
    if (value === null || value === undefined) nulls++;
    else present.push(value);
  }

  const seen = new Set<string>();
  let capped = false;
  for (const value of present) {
    if (seen.size >= DISTINCT_CAP) {
      capped = true;
      break;
    }
    seen.add(formatValue(value));
  }

  const summary: ColumnSummary = {
    total,
    nulls,
    distinct: seen.size,
    distinctCapped: capped,
  };

  if (present.length === 0) return summary;

  const kinds = new Set(present.map(kindOf));
  if (kinds.size !== 1 || kinds.has("mixed")) return summary;

  let min = present[0];
  let max = present[0];
  const less = (a: unknown, b: unknown): boolean => {
    if (a instanceof Date && b instanceof Date) return a.getTime() < b.getTime();
    if (typeof a === "string" && typeof b === "string") return a < b;
    return (a as number | bigint) < (b as number | bigint);
  };

  for (const value of present) {
    if (less(value, min)) min = value;
    if (less(max, value)) max = value;
  }

  summary.min = formatValue(min);
  summary.max = formatValue(max);
  return summary;
}

/** One stats line, e.g. `8 values, 2 null, 4 distinct, min Lima, max Tokyo`. */
function renderColumnSummary(summary: ColumnSummary): string {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "value" : "values"}`,
    `${summary.nulls} null`,
    `${summary.distinctCapped ? "at least " : ""}${summary.distinct} distinct`,
  ];
  if (summary.min !== undefined) parts.push(`min ${summary.min}`);
  if (summary.max !== undefined) parts.push(`max ${summary.max}`);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function put(out: Record<string, string>, key: string, value: string): void {
  let name = key;
  let n = 2;
  while (name in out) name = `${key} (${n++})`;
  out[name] = value;
}

export async function run(
  input: Uint8Array | string,
  opts: ParquetOpts,
): Promise<string | Record<string, string>> {
  const bytes = toBytes(input);
  const previewRows = clampInt(
    opts?.rows,
    MIN_PREVIEW_ROWS,
    MAX_PREVIEW_ROWS,
    DEFAULT_PREVIEW_ROWS,
  );
  const view = String(opts?.view ?? "summary");
  const wantStats = opts?.stats === true;

  const parsed = await readParquet(bytes, { rows: previewRows });

  if (view === "csv") {
    return toCsv(parsed.rows, parsed.columns);
  }

  const { metadata } = parsed;
  const out: Record<string, string> = {};
  const shown = parsed.rows.length;

  put(
    out,
    "File",
    `${formatBytes(metadata.fileSize)}, Parquet format version ${metadata.version}, ${formatBytes(metadata.metadataLength)} of footer metadata`,
  );
  put(out, "Rows", `${parsed.rowCount}`);

  if (view !== "schema") {
    const ratio =
      metadata.compressedSize > 0
        ? `, ${formatBytes(metadata.compressedSize)} of column data, ${formatBytes(metadata.uncompressedSize)} before compression`
        : "";
    put(
      out,
      "Row groups",
      `${parsed.rowGroups}${parsed.rowGroups === 1 ? " group" : " groups"}${ratio}`,
    );
  }

  put(out, "Columns", `${parsed.columns.length}`);

  if (view === "summary") {
    put(
      out,
      "Compression codecs seen",
      metadata.codecs.length > 0 ? metadata.codecs.join(", ") : "none recorded",
    );
    put(out, "Created by", metadata.createdBy ?? "not recorded in this file");
    if (metadata.keyValue.length > 0) {
      put(
        out,
        "Key value metadata",
        metadata.keyValue
          .map((entry) => `${entry.key} = ${displayCell(entry.value ?? "")}`)
          .join("\n"),
      );
    }
  }

  if (view === "summary" || view === "schema") {
    put(out, "Schema", renderSchema(parsed.schema));
  }

  if (view === "summary" || view === "preview") {
    put(
      out,
      `Preview (first ${shown} ${shown === 1 ? "row" : "rows"})`,
      renderPreview(parsed.rows, parsed.columns, parsed.rowCount),
    );
  }

  if (wantStats && shown > 0) {
    put(
      out,
      "Column stats",
      `Sampled from the ${shown} ${shown === 1 ? "row" : "rows"} in the preview, not from the whole file. Raise the row count to widen the sample.`,
    );
    for (const name of parsed.columns) {
      put(
        out,
        `Stats: ${name}`,
        renderColumnSummary(summarizeColumn(parsed.rows.map((row) => row[name]))),
      );
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  string | Record<string, string>,
  ParquetOpts
>;
