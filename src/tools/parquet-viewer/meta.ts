import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "parquet-viewer",
  matrixSlug: "parquet",
  icon: "Database",
  name: "Parquet Viewer",
  description: "Open a Parquet file and read its schema, row counts and data in your browser.",
  category: "Data",
  keywords: [
    "parquet viewer",
    "open parquet file online",
    "view parquet in browser",
    "parquet schema viewer",
    "parquet to csv",
    "arrow file viewer",
    "read parquet without python",
  ],
  searchTerms: [
    "pyarrow file viewer",
    "columnar file viewer",
    "inspect parquet metadata",
    "parquet row groups",
    "snappy parquet reader",
    "duckdb parquet preview",
    "spark output viewer",
    "feather file viewer",
    "parquet column types",
    "parquet null counts",
    "parquet to json",
    "big data file viewer",
    "s3 parquet preview",
    "pandas parquet viewer",
    "parquet file explorer",
    "parquet row count",
    "gzip parquet reader",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "rows",
      label: "Preview rows",
      default: 20,
      min: 5,
      max: 200,
      step: 5,
    },
    {
      kind: "boolean",
      id: "stats",
      label: "Per column stats",
      default: false,
    },
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Everything",
          synonyms: ["overview", "metadata", "file info", "all", "footer"],
        },
        {
          value: "schema",
          label: "Schema only",
          synonyms: ["columns", "types", "fields", "structure", "dtypes"],
        },
        {
          value: "preview",
          label: "Rows only",
          synonyms: ["data", "table", "head", "sample", "records"],
        },
        {
          value: "csv",
          label: "CSV of the preview",
          synonyms: ["export", "comma separated", "spreadsheet", "excel", "download"],
        },
      ],
    },
  ],
  copy: {
    what: "Reads an Apache Parquet file and shows you what is inside it: the file size and format version, the total row count, how many row groups it holds, which compression codecs each column chunk uses, and the string the writer stamped into the footer so you can tell a Spark file from a pandas one. The schema is listed one line per column with the physical type, the logical or converted type annotation, and whether the field is required, optional or repeated, with nested structs shown by their dotted path. A preview decodes the first rows into an aligned table, and turning on per column stats adds null counts, distinct counts and a value range for each column. Only the rows you ask for are decoded, so a file with millions of rows still opens quickly.",
    how: "Drop a .parquet file onto the input or pick one with the file button. Set the preview row count to decide how much data is decoded, then switch the view between everything, schema only, rows only, and CSV of the preview when you want the sample as a spreadsheet. Turn on per column stats to see nulls, distinct values and the min and max for each column across the previewed rows. Files up to a couple of hundred megabytes are accepted, and snappy, gzip, zstd and uncompressed files all read.",
    why: "The usual answer to opening a Parquet file is installing Python, pandas and pyarrow, or uploading the file to a viewer site. That file is usually production data, event logs, transactions or a model training set, and handing it to a stranger just to read a column list is a bad trade. This one decodes Parquet with a pure JavaScript reader that runs inside the tab, so your files and inputs never leave your device, and it still gives you the footer metadata, the real schema annotations and the row group layout instead of a truncated preview behind a signup.",
    faq: [
      {
        q: "Is my Parquet file uploaded anywhere?",
        a: "No. The reader is a JavaScript library served from this site, and the file is decoded inside the page you already have open: your files and inputs never leave your device. There is deliberately no API endpoint for this tool, because posting a data file to a server is exactly the risk it exists to remove.",
      },
      {
        q: "Can it open .arrow or .feather files?",
        a: "Not yet. Arrow IPC is a different container from Parquet even though the two formats share a type system and usually travel together, and the reader behind this page only understands Parquet. If you drop an Arrow file it is recognized by its ARROW1 magic bytes and told apart from a corrupt Parquet file, so you get a clear message rather than a decode error. To read one here, convert it first: load it with pyarrow.ipc and write it back out with pyarrow.parquet.write_table.",
      },
      {
        q: "How large a file can it open?",
        a: "The limit is your tab's memory, not a row cap. Files in the tens of megabytes open comfortably on an ordinary laptop, and the tool accepts up to two hundred megabytes before it refuses outright. Reading the schema and the footer only touches the end of the file, so metadata on a large file is fast; it is the row preview that costs, which is why the preview row count is yours to set. Past a few hundred megabytes, DuckDB or pyarrow on your own machine is the right tool.",
      },
    ],
  },
};
