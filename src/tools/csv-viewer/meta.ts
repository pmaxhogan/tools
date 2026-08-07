import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "csv-viewer",
  icon: "Table2",
  matrixSlug: "csv",
  name: "CSV Viewer",
  description: "Open, sort, filter and convert CSV and TSV right in your browser.",
  category: "Data",
  keywords: [
    "csv viewer online",
    "open csv without excel",
    "tsv viewer",
    "sort csv online",
    "filter csv",
    "csv to json",
    "view csv file",
    "csv column stats",
  ],
  searchTerms: [
    "excel alternative online",
    "spreadsheet viewer",
    "tsv opener",
    "csv to table",
    "csv reader online",
    "view csv without excel",
    "tabular data viewer",
    "delimited file viewer",
  ],
  input: "text/csv",
  output: "text/plain",
  options: [
    { kind: "boolean", id: "header", label: "First row is a header", default: true },
    {
      kind: "text",
      id: "sort",
      label: "Sort by",
      default: "",
      placeholder: "column name or -column for descending",
    },
    {
      kind: "text",
      id: "filter",
      label: "Filter",
      default: "",
      placeholder: "e.g. status=active or price>100",
    },
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "table",
      choices: [
        { value: "table", label: "Table" },
        { value: "stats", label: "Column stats" },
        { value: "json", label: "JSON" },
        { value: "csv", label: "CSV" },
      ],
    },
    { kind: "number", id: "limit", label: "Row limit", default: 100, min: 1, max: 1000 },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Opens CSV and TSV data in the browser and lays it out as an aligned table you can actually read. The delimiter is detected automatically, so comma, tab, semicolon and pipe files all work without a setup step. Sort by any column, filter the rows with a single condition, and switch to column statistics, a JSON array, or clean comma-delimited CSV.",
    how: "Paste your data or drop a .csv or .tsv file onto the input. Type a column name into the sort box, with a leading minus for descending order, and a condition like status=active, price>100 or name~smith into the filter box. Pick the view you want and raise the row limit if you need to see more than the first 100 rows.",
    why: "Spreadsheet apps mangle leading zeros and rewrite dates the moment you open a file, and the CSV sites that promise a quick preview upload your file to a server first. This one parses locally, keeps every value exactly as written, and sorts and filters without touching the data.",
    faq: [
      {
        q: "Can it edit cells?",
        a: "Not yet. Right now it covers viewing, sorting, filtering and converting; cell editing arrives with the table panel.",
      },
      {
        q: "How big a file works?",
        a: "Hundreds of thousands of rows parse fine. The table, JSON and CSV views render only the row limit you set, up to 1000 at a time, so a large file stays readable instead of freezing the page.",
      },
      {
        q: "Is my file uploaded anywhere?",
        a: "No. Parsing happens entirely in the browser: your files and inputs never leave your device.",
      },
    ],
  },
};
