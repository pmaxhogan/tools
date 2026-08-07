import { ToolError, type ToolLogic } from "../types";

/**
 * SQLite browser logic.
 *
 * SQLite itself is a WebAssembly build (sql.js) that only makes sense inside a
 * browser tab, so this module never imports it. Instead every function here
 * takes a `SqlEngine`: anything that can answer `exec(sql)` with the shape
 * sql.js returns. The panel hands in a real `Database`, the tests hand in a
 * real one too (sql.js runs fine in Node), and a hand written stub can stand in
 * for the failure paths. That keeps the logic layer pure and testable while the
 * engine, the wasm binary and the file reading stay in the UI layer.
 */

/** One statement's result, mirroring sql.js `Database.exec`. */
export interface SqlExecResult {
  columns: string[];
  values: unknown[][];
}

/** The narrow slice of a SQLite database this module needs. */
export interface SqlEngine {
  exec(sql: string): SqlExecResult[];
}

export interface ColumnInfo {
  name: string;
  /** Declared type. SQLite allows columns with no declared type at all. */
  type: string;
  pk: boolean;
  notnull: boolean;
}

export interface TableInfo {
  name: string;
  /** Rows counted with COUNT(*), or -1 when the count could not be read. */
  rowCount: number;
  columns: ColumnInfo[];
}

export interface Introspection {
  tables: TableInfo[];
  views: string[];
  indexes: string[];
  sqliteVersion?: string;
}

export interface RenderOpts {
  /** Rows printed before the table is cut off. Default 100. */
  maxRows?: number;
  /** Characters printed per cell before it is shortened. Default 40. */
  maxCell?: number;
}

export interface SqliteOpts {
  maxRows: number;
  maxCell: number;
  [key: string]: unknown;
}

/** The first sixteen bytes of every SQLite database file. */
const SQLITE_MAGIC = "SQLite format 3\0";

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_CELL = 40;
const MIN_COL_WIDTH = 3;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/**
 * Quote an identifier for use in SQL. SQLite's rule is a double quoted string
 * with any interior double quote doubled, which is why a table literally named
 * `my "table"` becomes `"my ""table"""`. Every generated statement in this
 * module goes through here so a hostile or merely odd name cannot change the
 * shape of the query.
 */
export function safeIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Turn one cell from a result set into display text. NULL is spelled out so an
 * empty string and a missing value never look the same, and blobs report their
 * size rather than spraying bytes across the table.
 */
export function formatCell(value: unknown, maxCell?: number): string {
  if (value === null || value === undefined) return "NULL";

  if (value instanceof ArrayBuffer) {
    return `<blob ${value.byteLength} ${value.byteLength === 1 ? "byte" : "bytes"}>`;
  }
  if (ArrayBuffer.isView(value)) {
    const size = value.byteLength;
    return `<blob ${size} ${size === 1 ? "byte" : "bytes"}>`;
  }

  const text = typeof value === "string" ? value : String(value);
  const flat = text.replace(/\r\n|\r|\n|\t/g, " ");
  if (maxCell === undefined) return flat;
  return clip(flat, Math.max(4, Math.floor(maxCell)));
}

function firstResult(db: SqlEngine, sql: string): SqlExecResult | null {
  const results = db.exec(sql);
  const first = results.length > 0 ? results[0] : null;
  return first ?? null;
}

function rowsOf(db: SqlEngine, sql: string): unknown[][] {
  const first = firstResult(db, sql);
  return first ? first.values : [];
}

/**
 * Read the first cell of the first row as display text, or null when the query
 * returns nothing or fails. Used for the pragmas the panel shows in its header,
 * none of which are worth breaking a page over.
 */
export function scalar(db: SqlEngine, sql: string): string | null {
  try {
    const rows = rowsOf(db, sql);
    if (rows.length === 0) return null;
    const row = rows[0] ?? [];
    const value = row[0];
    return value === null || value === undefined ? null : formatCell(value);
  } catch {
    return null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read the schema: every user table with its row count and columns, plus the
 * names of views and indexes. Objects whose name starts with `sqlite_` are
 * SQLite's own bookkeeping (`sqlite_sequence`, `sqlite_stat1`, the automatic
 * indexes behind UNIQUE constraints) and are left out.
 */
export function introspect(db: SqlEngine): Introspection {
  let master: unknown[][];
  try {
    master = rowsOf(
      db,
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'index') ORDER BY name",
    );
  } catch (e) {
    throw new ToolError(
      "unreadable-database",
      `Could not read the schema of this database: ${errorText(e)}.`,
      "The file may not be a SQLite database, it may be truncated, or it may be encrypted with something like SQLCipher, which this tool cannot decrypt.",
    );
  }

  const tableNames: string[] = [];
  const views: string[] = [];
  const indexes: string[] = [];

  for (const row of master) {
    const kind = String(row[0] ?? "");
    const name = String(row[1] ?? "");
    if (name === "" || name.startsWith("sqlite_")) continue;
    if (kind === "table") tableNames.push(name);
    else if (kind === "view") views.push(name);
    else if (kind === "index") indexes.push(name);
  }

  const tables: TableInfo[] = tableNames.map((name) => {
    const ident = safeIdent(name);

    let rowCount = -1;
    try {
      const counted = rowsOf(db, `SELECT COUNT(*) FROM ${ident}`);
      const cell = counted.length > 0 ? (counted[0] ?? [])[0] : null;
      const n = Number(cell);
      if (Number.isFinite(n)) rowCount = n;
    } catch {
      rowCount = -1;
    }

    let columns: ColumnInfo[];
    try {
      columns = rowsOf(db, `PRAGMA table_info(${ident})`).map((info) => ({
        name: String(info[1] ?? ""),
        type: String(info[2] ?? ""),
        notnull: Number(info[3] ?? 0) !== 0,
        pk: Number(info[5] ?? 0) !== 0,
      }));
    } catch {
      columns = [];
    }

    return { name, rowCount, columns };
  });

  const version = scalar(db, "SELECT sqlite_version()");
  return version === null
    ? { tables, views, indexes }
    : { tables, views, indexes, sqliteVersion: version };
}

/**
 * Render a result set as an aligned monospace table, the same visual shape the
 * CSV viewer uses: a count line, a padded header, a dashed rule, then the rows,
 * with any cut noted underneath instead of silently swallowed.
 */
export function renderRows(result: SqlExecResult, o: RenderOpts = {}): string {
  const maxRows = clampInt(o.maxRows, 1, 100000, DEFAULT_MAX_ROWS);
  const maxCell = clampInt(o.maxCell, 4, 4000, DEFAULT_MAX_CELL);

  const columns = result?.columns ?? [];
  const values = result?.values ?? [];

  if (columns.length === 0) {
    return "This statement returned no columns.";
  }

  const shown = values.slice(0, maxRows);
  let shortened = 0;

  const cell = (value: unknown): string => {
    const full = formatCell(value);
    const cut = clip(full, maxCell);
    if (cut !== full) shortened++;
    return cut.replace(/\|/g, "\\|");
  };

  const header = columns.map((name) => clip(String(name), maxCell).replace(/\|/g, "\\|"));
  const body = shown.map((row) => columns.map((_, i) => cell(row[i])));

  const widths = header.map((h, i) =>
    Math.max(MIN_COL_WIDTH, h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;

  const rowWord = values.length === 1 ? "row" : "rows";
  const colWord = columns.length === 1 ? "column" : "columns";
  const out = [`${values.length} ${rowWord} x ${columns.length} ${colWord}`, ""];

  out.push(line(header));
  out.push(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
  for (const row of body) out.push(line(row));

  if (shown.length < values.length) {
    const remaining = values.length - shown.length;
    out.push(`... ${remaining} more ${remaining === 1 ? "row" : "rows"} (${values.length} total)`);
  }
  if (shortened > 0) {
    out.push(
      `Note: ${shortened} ${shortened === 1 ? "cell was" : "cells were"} shortened to ${maxCell} characters.`,
    );
  }

  return out.join("\n");
}

/** One column line in the schema overview, e.g. `id  INTEGER  primary key, not null`. */
function columnFlags(column: ColumnInfo): string {
  const flags: string[] = [];
  if (column.pk) flags.push("primary key");
  if (column.notnull) flags.push("not null");
  return flags.join(", ");
}

/** An overview of the whole database: tables with row counts and columns. */
export function summarize(db: SqlEngine): string {
  const info = introspect(db);
  const out: string[] = [];

  if (info.sqliteVersion) out.push(`SQLite ${info.sqliteVersion}`);

  const counts = [
    `${info.tables.length} ${info.tables.length === 1 ? "table" : "tables"}`,
    `${info.views.length} ${info.views.length === 1 ? "view" : "views"}`,
    `${info.indexes.length} ${info.indexes.length === 1 ? "index" : "indexes"}`,
  ];
  out.push(counts.join(", "));
  out.push("");

  if (info.tables.length === 0) {
    out.push("This database has no tables of its own.");
  }

  for (const table of info.tables) {
    const rows =
      table.rowCount < 0
        ? "row count unavailable"
        : `${table.rowCount} ${table.rowCount === 1 ? "row" : "rows"}`;
    out.push(`${table.name} (${rows})`);

    if (table.columns.length === 0) {
      out.push("  no columns reported");
    } else {
      const nameWidth = Math.max(...table.columns.map((c) => c.name.length));
      const typeWidth = Math.max(...table.columns.map((c) => (c.type || "(untyped)").length));
      for (const column of table.columns) {
        const type = column.type || "(untyped)";
        const flags = columnFlags(column);
        const line = `  ${column.name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}${flags ? `  ${flags}` : ""}`;
        out.push(line.trimEnd());
      }
    }
    out.push("");
  }

  if (info.views.length > 0) out.push(`Views: ${info.views.join(", ")}`);
  if (info.indexes.length > 0) out.push(`Indexes: ${info.indexes.join(", ")}`);

  return out.join("\n").trimEnd();
}

/**
 * A result set as CSV. NULL becomes an empty field, which is what every other
 * SQL export tool does, and blobs keep their `<blob N bytes>` placeholder
 * because there is no honest way to put raw bytes in a spreadsheet cell.
 */
export function toCsv(result: SqlExecResult): string {
  const columns = result?.columns ?? [];
  const values = result?.values ?? [];

  const escape = (raw: string): string =>
    /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;

  const lines = [columns.map((name) => escape(String(name))).join(",")];
  for (const row of values) {
    lines.push(
      columns
        .map((_, i) => {
          const value = row[i];
          return value === null || value === undefined ? "" : escape(formatCell(value));
        })
        .join(","),
    );
  }
  return lines.join("\n");
}

/**
 * Describe the first sixteen bytes of a file so a failure to open it can say
 * what was actually there. An encrypted database looks like random bytes; a
 * mistakenly picked zip or text file announces itself immediately.
 */
export function describeHeader(bytes: Uint8Array): { looksLikeSqlite: boolean; found: string } {
  const head = bytes.subarray(0, 16);

  let found = "";
  for (let i = 0; i < head.length; i++) {
    const byte = head[i] ?? 0;
    found +=
      byte >= 0x20 && byte <= 0x7e
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  }

  let looksLikeSqlite = head.length === SQLITE_MAGIC.length;
  for (let i = 0; looksLikeSqlite && i < SQLITE_MAGIC.length; i++) {
    if (head[i] !== SQLITE_MAGIC.charCodeAt(i)) looksLikeSqlite = false;
  }

  return { looksLikeSqlite, found: found || "(empty file)" };
}

/**
 * The generic shell path. SQLite is a WebAssembly engine that lives in the
 * panel, so this function cannot open a database itself and does not pretend
 * to: it reports what it can see about the bytes and points at the panel.
 */
export function run(input: Uint8Array | string, opts: SqliteOpts): Record<string, string> {
  const maxRows = clampInt(opts?.maxRows, 1, 5000, DEFAULT_MAX_ROWS);

  if (input instanceof Uint8Array) {
    const head = describeHeader(input);
    return {
      File: `${input.length} ${input.length === 1 ? "byte" : "bytes"} read.`,
      Header: head.looksLikeSqlite
        ? 'Starts with "SQLite format 3", so this is a SQLite database file.'
        : `The first bytes are ${head.found}. A SQLite database starts with "SQLite format 3", so this file is either something else or encrypted.`,
      "Open it above":
        "The SQLite engine is a WebAssembly build that runs in the panel on this page. Drop the file there to list its tables, page through rows and run SQL against it.",
      "Why the split":
        "This function stays free of the engine so it can be tested and reused. It formats result sets and reads a schema from whatever database is handed to it, and the panel owns the engine.",
    };
  }

  const text = String(input ?? "").trim();
  if (text === "") {
    throw new ToolError(
      "empty-input",
      "No database loaded yet.",
      "Drop a .db, .sqlite or .sqlite3 file onto the panel above, or pick one with the file button.",
    );
  }

  return {
    "Your SQL": clip(text.replace(/\s+/g, " "), 200),
    "Nothing to run it against":
      "A query needs a database. Load a .db, .sqlite or .sqlite3 file in the panel above, then paste this into the SQL box and press Run, or press Ctrl and Enter.",
    "Rows at a time": `${maxRows} rows are shown per page; the prev and next buttons walk through the rest.`,
    "Where it runs":
      "SQLite is compiled to WebAssembly and runs inside this tab, so your files and inputs never leave your device.",
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, SqliteOpts>;
