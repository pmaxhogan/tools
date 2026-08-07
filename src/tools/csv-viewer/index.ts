import Papa from "papaparse";
import { ToolError, type ToolLogic } from "../types";

export interface CsvOpts {
  /** Treat the first row as column names. */
  header: boolean;
  /** Column name, or "-column" for descending. Empty means no sort. */
  sort: string;
  /** One condition: col=value, col!=value, col~text, col>10, col<10, col>=10, col<=10. */
  filter: string;
  /** table | stats | json | csv */
  view: string;
  /** Rows shown in the table, json and csv views. */
  limit: number;
  [key: string]: unknown;
}

/** A column's inferred shape, used for sorting, comparisons and stats. */
type ColumnType = "number" | "date" | "text" | "empty";

interface Table {
  columns: string[];
  rows: string[][];
  /** Human name of the delimiter Papa detected. */
  delimiter: string;
  /** How many source rows had a different field count than the widest row. */
  ragged: number;
}

const NUMERIC = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

const CELL_CAP = 40;
const MIN_COL_WIDTH = 3;

const FILTER_SYNTAX =
  "Use one condition: col=value, col!=value, col~text (contains), col>10, col<10, col>=10, col<=10.";

function isNumeric(value: string): boolean {
  return NUMERIC.test(value.trim());
}

function isDate(value: string): boolean {
  const s = value.trim();
  return ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));
}

function delimiterName(raw: string): string {
  switch (raw) {
    case ",":
      return "comma";
    case "\t":
      return "tab";
    case ";":
      return "semicolon";
    case "|":
      return "pipe";
    case Papa.RECORD_SEP:
      return "record separator";
    case Papa.UNIT_SEP:
      return "unit separator";
    default:
      return raw ? `"${raw}"` : "unknown";
  }
}

/**
 * Parse with Papa in array mode (never header mode) so duplicate column names
 * survive and short rows are simply padded instead of producing field-count
 * errors. The `header` option is applied afterwards by taking the first row.
 */
function parseTable(input: string, useHeader: boolean): Table {
  const result = Papa.parse<string[]>(input, {
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });

  const fatal = result.errors.find((e) => e.type !== "Delimiter");
  if (fatal) {
    const line = typeof fatal.row === "number" ? fatal.row + 1 : undefined;
    throw new ToolError(
      "invalid-csv",
      line
        ? `Could not parse the CSV at line ${line}: ${fatal.message}.`
        : `Could not parse the CSV: ${fatal.message}.`,
      'Check that every quoted field has a matching closing quote, and that quotes inside a quoted field are doubled ("" not ").',
    );
  }

  const data = result.data.filter((row) => row.length > 0);
  if (data.length === 0) {
    throw new ToolError(
      "empty-input",
      "No rows found in the input.",
      "Paste CSV or TSV text, or drop a .csv file onto the input.",
    );
  }

  const headerRow = useHeader ? (data[0] as string[]) : [];
  const body = useHeader ? data.slice(1) : data;

  let width = headerRow.length;
  for (const row of body) width = Math.max(width, row.length);
  width = Math.max(width, 1);

  const columns: string[] = [];
  for (let i = 0; i < width; i++) {
    const name = useHeader ? (headerRow[i] ?? "").trim() : "";
    columns.push(name || (useHeader ? `column${i + 1}` : `col${i + 1}`));
  }

  let ragged = 0;
  const rows = body.map((row) => {
    if (row.length !== width) ragged++;
    const padded: string[] = [];
    for (let i = 0; i < width; i++) padded.push(row[i] ?? "");
    return padded;
  });

  return { columns, rows, delimiter: delimiterName(result.meta.delimiter), ragged };
}

function inferType(values: string[]): ColumnType {
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return "empty";
  if (filled.every(isNumeric)) return "number";
  if (filled.every(isDate)) return "date";
  return "text";
}

function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparator(type: ColumnType): (a: string, b: string) => number {
  if (type === "number") return (a, b) => Number(a.trim()) - Number(b.trim());
  if (type === "date") return (a, b) => Date.parse(a.trim()) - Date.parse(b.trim());
  return compareText;
}

function columnIndex(table: Table, name: string, context: string): number {
  const idx = table.columns.indexOf(name);
  if (idx === -1) {
    throw new ToolError(
      "unknown-column",
      `${context} refers to a column named "${name}", which is not in this file.`,
      `Available columns: ${table.columns.join(", ")}.`,
    );
  }
  return idx;
}

const OPERATORS = [">=", "<=", "!=", "~", "=", ">", "<"] as const;
type Operator = (typeof OPERATORS)[number];

function splitCondition(raw: string): { column: string; op: Operator; value: string } {
  for (let i = 0; i < raw.length; i++) {
    for (const op of OPERATORS) {
      if (!raw.startsWith(op, i)) continue;
      const column = raw.slice(0, i).trim();
      const value = raw.slice(i + op.length).trim();
      if (!column) {
        throw new ToolError("bad-filter", "The filter is missing a column name.", FILTER_SYNTAX);
      }
      if (!value && op !== "=" && op !== "!=") {
        throw new ToolError(
          "bad-filter",
          `The filter "${raw}" is missing a value after "${op}".`,
          FILTER_SYNTAX,
        );
      }
      return { column, op, value };
    }
  }
  throw new ToolError(
    "bad-filter",
    `Could not read "${raw}" as a filter condition.`,
    FILTER_SYNTAX,
  );
}

/** Ordered comparison of one cell against the filter value, per cell. */
function compareCell(cell: string, value: string): number {
  if (isNumeric(cell) && isNumeric(value)) return Number(cell.trim()) - Number(value.trim());
  if (isDate(cell) && isDate(value)) return Date.parse(cell.trim()) - Date.parse(value.trim());
  return compareText(cell, value);
}

function applyFilter(table: Table, raw: string): string[][] {
  const { column, op, value } = splitCondition(raw);
  const idx = columnIndex(table, column, "The filter");
  const needle = value.toLowerCase();

  return table.rows.filter((row) => {
    const cell = row[idx] ?? "";
    switch (op) {
      case "=":
        return cell.trim().toLowerCase() === needle;
      case "!=":
        return cell.trim().toLowerCase() !== needle;
      case "~":
        return cell.toLowerCase().includes(needle);
      default: {
        if (cell.trim() === "") return false;
        const c = compareCell(cell, value);
        if (op === ">") return c > 0;
        if (op === "<") return c < 0;
        if (op === ">=") return c >= 0;
        return c <= 0;
      }
    }
  });
}

function applySort(table: Table, rows: string[][], raw: string): string[][] {
  let name = raw;
  let dir = 1;
  if (table.columns.indexOf(raw) === -1 && raw.startsWith("-")) {
    name = raw.slice(1).trim();
    dir = -1;
  }
  const idx = columnIndex(table, name, "The sort");
  const cmp = comparator(inferType(rows.map((r) => r[idx] ?? "")));

  return [...rows].sort((ra, rb) => {
    const a = ra[idx] ?? "";
    const b = rb[idx] ?? "";
    const emptyA = a.trim() === "";
    const emptyB = b.trim() === "";
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    return dir * cmp(a, b);
  });
}

/** Flatten newlines, escape pipes, then cap the visible width. */
function displayCell(raw: string): string {
  const flat = raw.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return flat.length > CELL_CAP ? `${flat.slice(0, CELL_CAP - 1)}…` : flat;
}

function summaryLine(table: Table, rowCount: number): string {
  const rowWord = rowCount === 1 ? "row" : "rows";
  const colWord = table.columns.length === 1 ? "column" : "columns";
  return `${rowCount} ${rowWord} x ${table.columns.length} ${colWord} (delimiter: ${table.delimiter})`;
}

function truncationLine(shown: number, total: number): string | null {
  if (shown >= total) return null;
  const remaining = total - shown;
  return `... ${remaining} more ${remaining === 1 ? "row" : "rows"} (${total} total)`;
}

function renderTable(table: Table, rows: string[][], limit: number): string {
  const shown = rows.slice(0, limit);
  const header = table.columns.map(displayCell);
  const body = shown.map((row) => table.columns.map((_, i) => displayCell(row[i] ?? "")));

  const widths = header.map((h, i) =>
    Math.max(MIN_COL_WIDTH, h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;

  const out = [summaryLine(table, rows.length)];
  if (table.ragged > 0) {
    out.push(
      `Note: ${table.ragged} ${table.ragged === 1 ? "row has" : "rows have"} a different field count and were padded with empty cells.`,
    );
  }
  out.push("");
  out.push(line(header));
  out.push(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
  for (const row of body) out.push(line(row));

  const note = truncationLine(shown.length, rows.length);
  if (note) out.push(note);
  return out.join("\n");
}

function renderStats(table: Table, rows: string[][]): string {
  const out = [summaryLine(table, rows.length), ""];

  table.columns.forEach((name, i) => {
    const values = rows.map((row) => row[i] ?? "");
    const filled = values.filter((v) => v.trim() !== "");
    const type = inferType(values);
    const distinct = new Set(filled.map((v) => v.trim())).size;

    out.push(name);
    out.push(`  type: ${type}`);
    out.push(`  non-empty: ${filled.length} of ${values.length}`);
    out.push(`  distinct: ${distinct}`);

    if ((type === "number" || type === "date") && filled.length > 0) {
      const cmp = comparator(type);
      const sorted = [...filled].sort(cmp);
      out.push(`  min: ${sorted[0]}`);
      out.push(`  max: ${sorted[sorted.length - 1]}`);
    } else if (type === "text") {
      const counts = new Map<string, number>();
      for (const v of filled) {
        const key = v.trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let top = "";
      let best = 0;
      for (const [value, count] of counts) {
        if (count > best) {
          top = value;
          best = count;
        }
      }
      out.push(`  top value: ${displayCell(top)} (${best} ${best === 1 ? "row" : "rows"})`);
    }
    out.push("");
  });

  return out.join("\n").trimEnd();
}

function renderJson(table: Table, rows: string[][], limit: number): string {
  const shown = rows.slice(0, limit);
  const objects = shown.map((row) => {
    const obj: Record<string, string> = {};
    table.columns.forEach((name, i) => {
      obj[name] = row[i] ?? "";
    });
    return obj;
  });

  const json = JSON.stringify(objects, null, 2);
  const note = truncationLine(shown.length, rows.length);
  return note ? `${json}\n${note}` : json;
}

function renderCsv(table: Table, rows: string[][], limit: number, useHeader: boolean): string {
  const shown = rows.slice(0, limit);
  const csv = useHeader
    ? Papa.unparse({ fields: table.columns, data: shown }, { newline: "\n", delimiter: "," })
    : Papa.unparse(shown, { newline: "\n", delimiter: "," });

  const note = truncationLine(shown.length, rows.length);
  return note ? `${csv}\n${note}` : csv;
}

export function run(input: string, opts: CsvOpts): string {
  const text = input ?? "";
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Nothing to view yet.",
      "Paste CSV or TSV text, or drop a .csv file onto the input.",
    );
  }

  const useHeader = opts.header !== false;
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(opts.limit)) || 100));
  const view = opts.view || "table";

  const table = parseTable(text, useHeader);

  let rows = table.rows;
  const filter = (opts.filter ?? "").trim();
  if (filter) rows = applyFilter(table, filter);

  const sort = (opts.sort ?? "").trim();
  if (sort) rows = applySort(table, rows, sort);

  switch (view) {
    case "stats":
      return renderStats(table, rows);
    case "json":
      return renderJson(table, rows, limit);
    case "csv":
      return renderCsv(table, rows, limit, useHeader);
    default:
      return renderTable(table, rows, limit);
  }
}

export default { run } satisfies ToolLogic<string, string, CsvOpts>;
