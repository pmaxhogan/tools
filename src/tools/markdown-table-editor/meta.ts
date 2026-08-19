import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "markdown-table-editor",
  matrixSlug: "md-table",
  name: "Markdown Table Editor",
  description:
    "Paste a table from Excel, a CSV, or HTML and get a tidy, aligned Markdown table back.",
  category: "Data",
  icon: "Table2",
  keywords: [
    "markdown table generator",
    "markdown table editor",
    "excel to markdown table",
    "csv to markdown table",
    "format markdown table",
    "align markdown table",
    "markdown table formatter",
  ],
  searchTerms: [
    "gfm table",
    "pipe table",
    "google sheets to markdown",
    "tsv to markdown",
    "html table to markdown",
    "markdown table to csv",
    "markdown table to json",
    "pretty print table",
    "ascii table generator",
    "latex tabular",
    "readme table",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "output",
      label: "Output format",
      default: "markdown",
      options: [
        {
          value: "markdown",
          label: "Markdown table",
          synonyms: ["md", "gfm", "github", "pipe table", "readme"],
        },
        { value: "csv", label: "CSV", synonyms: ["comma separated", "spreadsheet", "excel file"] },
        {
          value: "tsv",
          label: "TSV (tab separated)",
          synonyms: ["tab separated", "excel paste", "google sheets", "clipboard"],
        },
        { value: "html", label: "HTML table", synonyms: ["web", "thead", "tbody", "table tag"] },
        {
          value: "json",
          label: "JSON records",
          synonyms: ["array of objects", "api", "javascript", "records"],
        },
        {
          value: "ascii",
          label: "ASCII box table",
          synonyms: ["plain text", "box drawing", "terminal", "console", "pretty"],
        },
        {
          value: "latex",
          label: "LaTeX tabular",
          synonyms: ["tex", "overleaf", "paper", "thesis"],
        },
      ],
    },
    {
      kind: "select",
      id: "align",
      label: "Column alignment",
      default: "keep",
      options: [
        {
          value: "keep",
          label: "Keep what the table has",
          synonyms: ["auto", "as is", "unchanged", "original"],
        },
        { value: "left", label: "Left", synonyms: ["start", "flush left"] },
        { value: "center", label: "Center", synonyms: ["middle", "centre"] },
        { value: "right", label: "Right", synonyms: ["end", "numbers", "flush right"] },
      ],
    },
    { kind: "boolean", id: "pad", label: "Pad cells so columns line up", default: true },
    { kind: "boolean", id: "compact", label: "Compact output (minimal pipes)", default: false },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Turns whatever table you have into a clean GitHub Flavored Markdown table. It reads Markdown tables (with or without outer pipes, with alignment colons, with escaped pipes and inline code), rows copied straight out of Excel or Google Sheets, CSV text with quoted commas, HTML tables, and even columns separated by runs of spaces. The output is padded so every column lines up in a monospace editor, with wide characters such as Chinese, Japanese, and Korean counted as two columns so the alignment holds. The same table can also come back out as CSV, TSV, HTML, JSON records, an ASCII box table, or a LaTeX tabular.",
    how: "Paste your table into the input box. The format is detected from the content, so a spreadsheet paste, a comma separated file, and an existing Markdown table all work with no setting to change. Pick an output format, choose whether to force a column alignment, and copy the result. Turn off padding, or turn on compact mode, when you want the shortest possible Markdown instead of the aligned kind.",
    why: "Most Markdown table generators make you retype your data into a grid one cell at a time, and the ones that accept a paste usually send it to a server first. This one detects the format for you, and your files and inputs never leave your device. Rows with a missing cell are filled in rather than rejected, pipes inside your text are escaped for you instead of breaking the table, and there is no row limit, no sign-up, and no ad wall.",
    faq: [
      {
        q: "Can I paste a table straight from Excel or Google Sheets?",
        a: "Yes. Spreadsheets copy rows to the clipboard as tab separated text, and that is detected automatically, including cells that were quoted because they contain a comma or a line break. Paste and the Markdown table appears.",
      },
      {
        q: "Why do pipe characters break my table?",
        a: "In Markdown a pipe ends a cell, so a pipe inside your text splits the row. This tool escapes every pipe it writes as a backslash followed by a pipe, which renders as a normal pipe character, and when reading a table back it understands both escaped pipes and pipes inside inline code spans.",
      },
      {
        q: "Does it handle merged cells?",
        a: "No, and nothing can. GitHub Flavored Markdown has no syntax for colspan or rowspan, so a merged cell in a pasted HTML table comes out as a single ordinary cell and the rest of the row is filled with empty cells. Keep merged cells in HTML if you need them.",
      },
    ],
  },
};
