import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "xlsx-viewer",
  icon: "Table2",
  name: "XLSX Viewer",
  description: "Open, sort and filter Excel spreadsheets without uploading them anywhere.",
  category: "Data",
  keywords: [
    "xlsx viewer online",
    "open excel file without excel",
    "view xlsx in browser",
    "excel to csv converter",
    "xlsm viewer",
    "read spreadsheet online free",
    "xlsx to json",
    "excel file preview",
  ],
  searchTerms: [
    "excel viewer",
    "spreadsheet opener",
    "open xlsx no software",
    "microsoft excel alternative",
    "workbook reader",
    "sheet viewer",
    "xls opener",
    "office spreadsheet viewer",
    "excel to markdown table",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "sheet",
      label: "Sheet",
      default: "",
      placeholder: "sheet name or number, blank for the first",
    },
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "table",
      options: [
        { value: "table", label: "Table", synonyms: ["grid", "cells", "spreadsheet view"] },
        {
          value: "csv",
          label: "CSV",
          synonyms: ["comma separated", "excel to csv", "export csv"],
        },
        {
          value: "json",
          label: "JSON",
          synonyms: ["json array", "xlsx to json", "objects"],
        },
        {
          value: "markdown",
          label: "Markdown table",
          synonyms: ["md table", "github table", "readme table"],
        },
        {
          value: "summary",
          label: "Summary only",
          synonyms: ["metadata", "sheet list", "no data"],
        },
      ],
    },
    { kind: "number", id: "rows", label: "Rows to show", default: 50, min: 1, max: 5000 },
    { kind: "boolean", id: "header", label: "First row is a header", default: true },
  ],
  examples: [
    { label: "Sample workbook", file: "sample.xlsx", opts: { view: "table", rows: "50" } },
    { label: "Plain CSV file", file: "sample.csv", opts: { view: "table", rows: "50" } },
  ],
  copy: {
    what: "Opens .xlsx and .xlsm workbooks in the browser and shows every sheet as a readable grid, with the tab order, column letters and merged ranges the file actually declares. Cell values come out the way Excel shows them: shared strings resolved, dates and percentages rendered through the sheet's own number formats, and formula cells showing their cached results. Plain .csv and .tsv files open in the same grid, so a folder of mixed exports needs only one tool.",
    how: "Drop an .xlsx, .xlsm or .csv file onto the input, or use the file picker. Switch sheets with the tabs, type in the search box to keep only rows containing that text, and click a column heading to sort by it. Export the sheet you are looking at as CSV or JSON, or copy it as a Markdown table for a pull request or a README.",
    why: "The free Excel viewers online upload your workbook to a server before showing you a single cell, which is a poor trade when the file holds salaries or customer data. This one parses the zip and its XML in the tab you already have open, so your files and inputs never leave your device, and it does not ask you to sign in or cap you at a preview of the first few rows.",
    faq: [
      {
        q: "Does it show formulas or their results?",
        a: "It shows the cached result Excel stored with the formula, which is the value you would see on screen. The formula text itself is not recalculated here, so a workbook saved without cached values will show blank cells in those columns.",
      },
      {
        q: "Can it open .xls files from older versions of Excel?",
        a: "No. The old .xls format is a binary compound document, not a zip of XML, and it is a different parser entirely. Open the file once in Excel, LibreOffice or Numbers and save it as .xlsx or .csv, then it will open here.",
      },
      {
        q: "How large a workbook can it handle?",
        a: "Files up to 100 MB are accepted, and the grid loads the first 5,000 rows of each sheet so a large sheet still opens quickly instead of freezing the page. When a sheet holds more than that, the panel says so rather than quietly showing you a slice.",
      },
    ],
  },
};
