import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  columnLetter,
  decodeEntities,
  filterRows,
  generalNumber,
  parseCellRef,
  parseDelimited,
  parseSharedStrings,
  parseStyles,
  pickSheet,
  readWorkbook,
  run,
  serialToIso,
  sortRows,
  toCsv,
  toJson,
  toMarkdown,
  toTextTable,
  tokenizeXml,
  type WorkbookSheet,
  type XlsxOpts,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const SAMPLE_PATH = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "public",
  "samples",
  "sample.xlsx",
);

/** Fixed so a fixture never carries the wall clock into its bytes. */
const MTIME = new Date("2024-01-01T10:00:00Z");

/** Zip a set of XML parts into workbook bytes, deterministically. */
function makeXlsx(parts: Record<string, string>): Uint8Array {
  const zippable: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const [path, text] of Object.entries(parts)) {
    zippable[path] = [strToU8(text), { mtime: MTIME }];
  }
  return zipSync(zippable, { mtime: MTIME });
}

const MINIMAL_WORKBOOK_XML = `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const MINIMAL_RELS = `<?xml version="1.0"?>
<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/** A one sheet workbook whose sheet XML is supplied by the caller. */
function oneSheet(sheetXml: string, extra: Record<string, string> = {}): Uint8Array {
  return makeXlsx({
    "xl/workbook.xml": MINIMAL_WORKBOOK_XML,
    "xl/_rels/workbook.xml.rels": MINIMAL_RELS,
    "xl/worksheets/sheet1.xml": sheetXml,
    ...extra,
  });
}

function sheetData(rows: string): string {
  return `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
}

const defaultOpts: XlsxOpts = { sheet: "", view: "table", rows: 50, header: true };

/* ------------------------------------------------------------------ */
/* the XML tokenizer                                                   */
/* ------------------------------------------------------------------ */

describe("tokenizeXml", () => {
  it("reads tags, attributes and text", () => {
    const tokens = [...tokenizeXml(`<a href="x" n='2'>hi</a>`)];
    expect(tokens).toEqual([
      { kind: "open", name: "a", attrs: { href: "x", n: "2" }, selfClosing: false },
      { kind: "text", text: "hi" },
      { kind: "close", name: "a" },
    ]);
  });

  it("marks a self closing tag and keeps its attributes", () => {
    const tokens = [...tokenizeXml(`<c r="A1" s="3"/>`)];
    expect(tokens).toEqual([
      { kind: "open", name: "c", attrs: { r: "A1", s: "3" }, selfClosing: true },
    ]);
  });

  it("ignores the declaration, comments and a doctype", () => {
    const tokens = [
      ...tokenizeXml(`<?xml version="1.0"?><!DOCTYPE x><!-- note --><x>1</x>`),
    ].filter((t) => t.kind !== "text");
    expect(tokens).toEqual([
      { kind: "open", name: "x", attrs: {}, selfClosing: false },
      { kind: "close", name: "x" },
    ]);
  });

  it("treats CDATA as literal text", () => {
    const tokens = [...tokenizeXml(`<t><![CDATA[a < b & c]]></t>`)];
    expect(tokens[1]).toEqual({ kind: "text", text: "a < b & c" });
  });

  it("does not end a tag on a > inside a quoted attribute", () => {
    const tokens = [...tokenizeXml(`<c f="a>b">v</c>`)];
    expect(tokens[0]).toEqual({ kind: "open", name: "c", attrs: { f: "a>b" }, selfClosing: false });
    expect(tokens[1]).toEqual({ kind: "text", text: "v" });
  });
});

describe("decodeEntities", () => {
  it("decodes the five named entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`,
    );
  });

  it("decodes decimal and hex character references", () => {
    expect(decodeEntities("&#65;&#x42;&#8212;")).toBe("AB—");
  });

  it("leaves an unknown entity alone", () => {
    expect(decodeEntities("&nbsp;x")).toBe("&nbsp;x");
  });
});

/* ------------------------------------------------------------------ */
/* references, serials and numbers                                     */
/* ------------------------------------------------------------------ */

describe("columnLetter", () => {
  it("counts past Z the way a spreadsheet does", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });
});

describe("parseCellRef", () => {
  it("reads a reference into zero based coordinates", () => {
    expect(parseCellRef("A1")).toEqual({ col: 0, row: 0 });
    expect(parseCellRef("B3")).toEqual({ col: 1, row: 2 });
    expect(parseCellRef("AA10")).toEqual({ col: 26, row: 9 });
    expect(parseCellRef("$C$4")).toEqual({ col: 2, row: 3 });
  });

  it("rejects something that is not a reference", () => {
    expect(parseCellRef("")).toBeNull();
    expect(parseCellRef("12")).toBeNull();
    expect(parseCellRef("A0")).toBeNull();
  });
});

describe("serialToIso", () => {
  it("converts 1900 system serials", () => {
    expect(serialToIso(45351, false, false)).toBe("2024-02-29");
    expect(serialToIso(1, false, false)).toBe("1900-01-01");
    expect(serialToIso(59, false, false)).toBe("1900-02-28");
    expect(serialToIso(61, false, false)).toBe("1900-03-01");
  });

  it("names the phantom leap day rather than inventing a real date", () => {
    expect(serialToIso(60, false, false)).toBe("1900-02-29");
  });

  it("converts 1904 system serials", () => {
    expect(serialToIso(0, true, false)).toBe("1904-01-01");
    expect(serialToIso(43889, true, false)).toBe("2024-02-29");
  });

  it("adds the clock when the format asks for time", () => {
    expect(serialToIso(45351.5, false, true)).toBe("2024-02-29T12:00:00Z");
  });
});

describe("generalNumber", () => {
  it("keeps integers exact and trims float noise", () => {
    expect(generalNumber(42)).toBe("42");
    expect(generalNumber(0.1 + 0.2)).toBe("0.3");
    expect(generalNumber(1.5)).toBe("1.5");
  });
});

/* ------------------------------------------------------------------ */
/* part parsers                                                        */
/* ------------------------------------------------------------------ */

describe("parseSharedStrings", () => {
  it("reads plain and rich text items and keeps preserved spaces", () => {
    const xml = `<sst>
      <si><t>plain</t></si>
      <si><r><t>bold</t></r><r><t xml:space="preserve"> and more</t></r></si>
      <si><t xml:space="preserve">  padded</t></si>
      <si/>
    </sst>`;
    expect(parseSharedStrings(xml)).toEqual(["plain", "bold and more", "  padded", ""]);
  });
});

describe("parseStyles", () => {
  it("maps each cellXfs entry to its format code", () => {
    const xml = `<styleSheet>
      <numFmts><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
      <cellStyleXfs><xf numFmtId="9"/></cellStyleXfs>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>
    </styleSheet>`;
    // cellStyleXfs must not leak into the list: only cellXfs indexes cells.
    expect(parseStyles(xml)).toEqual(["General", "mm-dd-yy", "0.0%"]);
  });
});

/* ------------------------------------------------------------------ */
/* reading the sample workbook                                         */
/* ------------------------------------------------------------------ */

describe("readWorkbook on the checked in sample", () => {
  const bytes = new Uint8Array(readFileSync(SAMPLE_PATH));
  const workbook = readWorkbook(bytes);

  it("reads both sheets in workbook order", () => {
    expect(workbook.format).toBe("xlsx");
    expect(workbook.date1904).toBe(false);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Orders", "Notes"]);
  });

  it("resolves shared strings, dates, percentages and formula results", () => {
    const orders = workbook.sheets[0] as WorkbookSheet;
    expect(orders.rows[0]?.[0]).toBe("Quarterly orders");
    expect(orders.rows[1]).toEqual([
      "Customer",
      "Shipped",
      "Units",
      "Unit price",
      "Discount",
      "Line total",
    ]);
    // Customer (shared), date (numFmt 14), units, money (#,##0.00), percent.
    expect(orders.rows[2]?.[0]).toBe("Riverbend Roasters");
    expect(orders.rows[2]?.[1]).toBe("2024-03-04");
    expect(orders.rows[2]?.[2]).toBe("4");
    expect(orders.rows[2]?.[3]).toBe("91.50");
    expect(orders.rows[2]?.[4]).toBe("5.0%");
    // A formula cell shows its cached value, which is what Excel displays.
    expect(orders.rows[2]?.[5]).toBe("347.70");
  });

  it("keeps sparse rows in place and records the merged header", () => {
    const orders = workbook.sheets[0] as WorkbookSheet;
    expect(orders.merges.map((merge) => merge.ref)).toEqual(["A1:F1"]);
    expect(orders.merges[0]).toMatchObject({ startRow: 0, startCol: 0, endRow: 0, endCol: 5 });
    // The totals row sits one blank row below the data.
    expect(orders.rows[10]).toEqual(["", "", "", "", "", ""]);
    expect(orders.rows[11]?.[4]).toBe("Total");
    expect(orders.rowCount).toBe(12);
    expect(orders.colCount).toBe(6);
    expect(orders.truncated).toBe(false);
  });

  it("reads inline strings, booleans, errors and a datetime", () => {
    const notes = workbook.sheets[1] as WorkbookSheet;
    expect(notes.rows[0]).toEqual(["Field", "Value"]);
    expect(notes.rows[1]?.[1]).toBe("2024-04-03T09:30:00Z");
    expect(notes.rows[2]?.[1]).toBe("FALSE");
    expect(notes.rows[3]?.[1]).toBe("#N/A");
    expect(notes.rows[4]?.[1]).toBe('Prices are per kilo, "green" weight.');
  });
});

/* ------------------------------------------------------------------ */
/* worksheet edge cases                                                */
/* ------------------------------------------------------------------ */

describe("readWorkbook edge cases", () => {
  it("handles a sheet with no cells at all", () => {
    const workbook = readWorkbook(oneSheet(sheetData("")));
    const sheet = workbook.sheets[0] as WorkbookSheet;
    expect(sheet.rows).toEqual([]);
    expect(sheet.rowCount).toBe(0);
    expect(sheet.colCount).toBe(0);
  });

  it("fills gaps left by sparse rows and columns", () => {
    const xml = sheetData(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>` +
        `<row r="4"><c r="B4" t="inlineStr"><is><t>b</t></is></c></row>`,
    );
    const sheet = readWorkbook(oneSheet(xml)).sheets[0] as WorkbookSheet;
    expect(sheet.rows).toEqual([
      ["a", "", "c"],
      ["", "", ""],
      ["", "", ""],
      ["", "b", ""],
    ]);
  });

  it("stops at the row budget and says so", () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("");
    const sheet = readWorkbook(oneSheet(sheetData(rows)), { maxRows: 10 })
      .sheets[0] as WorkbookSheet;
    expect(sheet.rows).toHaveLength(10);
    expect(sheet.rowCount).toBe(30);
    expect(sheet.truncated).toBe(true);
  });

  it("reads a t=str formula result and skips the formula text itself", () => {
    const xml = sheetData(`<row r="1"><c r="A1" t="str"><f>UPPER(B1)</f><v>DONE</v></c></row>`);
    const sheet = readWorkbook(oneSheet(xml)).sheets[0] as WorkbookSheet;
    expect(sheet.rows[0]).toEqual(["DONE"]);
  });

  it("honors the 1904 date system when the workbook declares it", () => {
    const bytes = makeXlsx({
      "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": MINIMAL_RELS,
      "xl/styles.xml": `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": sheetData(`<row r="1"><c r="A1" s="1"><v>0</v></c></row>`),
    });
    const workbook = readWorkbook(bytes);
    expect(workbook.date1904).toBe(true);
    expect((workbook.sheets[0] as WorkbookSheet).rows[0]?.[0]).toBe("1904-01-01");
  });

  it("renders a text formatted number as written rather than as a number", () => {
    const bytes = oneSheet(sheetData(`<row r="1"><c r="A1" s="1"><v>007</v></c></row>`), {
      "xl/styles.xml": `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="49"/></cellXfs></styleSheet>`,
    });
    expect((readWorkbook(bytes).sheets[0] as WorkbookSheet).rows[0]?.[0]).toBe("007");
  });

  it("keeps a tab for a sheet whose part is missing", () => {
    const bytes = makeXlsx({
      "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Chart" sheetId="1" r:id="rId9"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships/>`,
    });
    const sheet = readWorkbook(bytes).sheets[0] as WorkbookSheet;
    expect(sheet.name).toBe("Chart");
    expect(sheet.rows).toEqual([]);
  });

  it("reports a macro enabled workbook as xlsm", () => {
    const bytes = oneSheet(sheetData(`<row r="1"><c r="A1"><v>1</v></c></row>`), {
      "xl/vbaProject.bin": "not really a binary, but the part is what matters",
    });
    expect(readWorkbook(bytes).format).toBe("xlsm");
  });
});

/* ------------------------------------------------------------------ */
/* CSV passthrough                                                     */
/* ------------------------------------------------------------------ */

describe("parseDelimited", () => {
  it("handles quotes, doubled quotes, embedded separators and CRLF", () => {
    expect(parseDelimited('a,b\r\n"x,1","he said ""hi"""')).toEqual([
      ["a", "b"],
      ["x,1", 'he said "hi"'],
    ]);
  });

  it("guesses a tab delimiter and strips a byte order mark", () => {
    expect(parseDelimited("﻿a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("drops trailing blank lines", () => {
    expect(parseDelimited("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("CSV input", () => {
  it("reads pasted text as a one sheet workbook", () => {
    const workbook = readWorkbook("name,qty\nbeans,3\nrice,10");
    expect(workbook.format).toBe("csv");
    const sheet = workbook.sheets[0] as WorkbookSheet;
    expect(sheet.rows).toEqual([
      ["name", "qty"],
      ["beans", "3"],
      ["rice", "10"],
    ]);
  });

  it("reads the bytes of a text file the same way and pads short rows", () => {
    const bytes = new TextEncoder().encode("a,b,c\n1,2\n");
    const sheet = readWorkbook(bytes).sheets[0] as WorkbookSheet;
    expect(sheet.rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", ""],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* views, exporters and grid helpers                                   */
/* ------------------------------------------------------------------ */

const GRID = [
  ["name", "qty", "note"],
  ["beans", "3", "a | b"],
  ["rice", "10", ""],
];

describe("exporters", () => {
  it("quotes only the CSV fields that need it", () => {
    expect(toCsv([["plain", 'has "quotes"', "has,comma"]])).toBe(
      'plain,"has ""quotes""","has,comma"',
    );
  });

  it("keys JSON objects by the header row", () => {
    expect(JSON.parse(toJson(GRID, true))).toEqual([
      { name: "beans", qty: "3", note: "a | b" },
      { name: "rice", qty: "10", note: "" },
    ]);
  });

  it("falls back to column letters for a blank header and de-duplicates repeats", () => {
    const rows = [
      ["id", "", "id"],
      ["1", "2", "3"],
    ];
    expect(JSON.parse(toJson(rows, true))).toEqual([{ id: "1", B: "2", id_2: "3" }]);
  });

  it("emits arrays when there is no header row", () => {
    expect(JSON.parse(toJson(GRID, false))).toEqual(GRID);
  });

  it("escapes pipes in a Markdown table", () => {
    expect(toMarkdown(GRID, true).split("\n")).toEqual([
      "| name | qty | note |",
      "| --- | --- | --- |",
      "| beans | 3 | a \\| b |",
      "| rice | 10 |  |",
    ]);
  });

  it("labels a headerless Markdown table with column letters", () => {
    expect(toMarkdown([["x", "y"]], false).split("\n")[0]).toBe("| A | B |");
  });

  it("returns empty output for no rows", () => {
    expect(toCsv([])).toBe("");
    expect(toJson([], true)).toBe("[]");
    expect(toMarkdown([], true)).toBe("");
  });

  it("draws a text grid with column letters", () => {
    const sheet: WorkbookSheet = {
      name: "S",
      index: 0,
      state: "visible",
      rows: GRID,
      merges: [],
      rowCount: 3,
      colCount: 3,
      truncated: false,
    };
    const lines = toTextTable(sheet, 10).split("\n");
    expect(lines[0]?.trim().split(/\s+/)).toEqual(["A", "B", "C"]);
    expect(lines[3]).toContain("beans");
  });
});

describe("sortRows", () => {
  it("compares numbers as numbers, not as text", () => {
    const rows = [["9"], ["10"], ["2"]];
    expect(sortRows(rows, 0, false).map((row) => row[0])).toEqual(["2", "9", "10"]);
    expect(sortRows(rows, 0, true).map((row) => row[0])).toEqual(["10", "9", "2"]);
  });

  it("sinks blanks to the bottom in both directions and is stable", () => {
    const rows = [["b"], [""], ["a"], [""]];
    expect(sortRows(rows, 0, false).map((row) => row[0])).toEqual(["a", "b", "", ""]);
    expect(sortRows(rows, 0, true).map((row) => row[0])).toEqual(["b", "a", "", ""]);
  });
});

describe("filterRows", () => {
  it("matches any cell, case insensitively", () => {
    expect(filterRows(GRID, "BEANS")).toEqual([GRID[1]]);
    expect(filterRows(GRID, "  ")).toEqual(GRID);
    expect(filterRows(GRID, "nothing")).toEqual([]);
  });
});

describe("pickSheet", () => {
  const workbook = readWorkbook(new Uint8Array(readFileSync(SAMPLE_PATH)));

  it("finds a sheet by name, by lowercase name, by number, and defaults to the first", () => {
    expect(pickSheet(workbook, "Notes").name).toBe("Notes");
    expect(pickSheet(workbook, "notes").name).toBe("Notes");
    expect(pickSheet(workbook, "2").name).toBe("Notes");
    expect(pickSheet(workbook, "").name).toBe("Orders");
  });

  it("throws for a sheet that is not there", () => {
    expect(() => pickSheet(workbook, "Budget")).toThrow(ToolError);
    try {
      pickSheet(workbook, "Budget");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-sheet");
      expect((e as ToolError).fix).toContain("Orders");
    }
  });
});

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

describe("run", () => {
  const bytes = new Uint8Array(readFileSync(SAMPLE_PATH));

  it("summarizes the workbook and draws the default table", () => {
    const out = run(bytes, defaultOpts);
    expect(out.Format).toBe("XLSX");
    expect(out.Sheets).toBe("Orders, Notes");
    expect(out.Sheet).toBe("Orders");
    expect(out.Size).toBe("12 rows by 6 columns");
    expect(out["Merged ranges"]).toBe("A1:F1");
    expect(out.Output).toContain("Riverbend Roasters");
  });

  it("renders the CSV, JSON and Markdown views of the chosen sheet", () => {
    const csv = run(bytes, { ...defaultOpts, sheet: "Notes", view: "csv" });
    expect(csv.Output?.split("\r\n")[0]).toBe("Field,Value");

    const json = run(bytes, { ...defaultOpts, sheet: "Notes", view: "json" });
    expect(JSON.parse(json.Output as string)[0]).toEqual({
      Field: "Exported at",
      Value: "2024-04-03T09:30:00Z",
    });

    const markdown = run(bytes, { ...defaultOpts, sheet: "2", view: "markdown" });
    expect(markdown.Output?.split("\n")[0]).toBe("| Field | Value |");
  });

  it("omits the output block in the summary view", () => {
    const out = run(bytes, { ...defaultOpts, view: "summary" });
    expect(out.Output).toBeUndefined();
    expect(out.Sheet).toBe("Orders");
  });

  it("honors the row limit", () => {
    const out = run(bytes, { ...defaultOpts, sheet: "Orders", view: "csv", rows: 2 });
    expect(out.Output?.split("\r\n")).toHaveLength(2);
  });

  it("reads pasted CSV text too", () => {
    const out = run("a,b\n1,2", { ...defaultOpts, view: "csv" });
    expect(out.Format).toBe("CSV");
    expect(out.Output).toBe("a,b\r\n1,2");
  });
});

/* ------------------------------------------------------------------ */
/* error branches                                                      */
/* ------------------------------------------------------------------ */

function expectToolError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe(code);
    expect((e as ToolError).fix).toBeTruthy();
    return;
  }
  throw new Error(`expected a ToolError with code ${code}`);
}

describe("errors", () => {
  it("rejects empty text and empty bytes", () => {
    expectToolError(() => readWorkbook("   "), "empty-input");
    expectToolError(() => readWorkbook(new Uint8Array(0)), "empty-input");
  });

  it("rejects a file past the size limit", () => {
    // Only the length is read before the limit check, so a sparse view is enough.
    const huge = { length: 200 * 1024 * 1024 } as unknown as Uint8Array;
    expectToolError(() => readWorkbook(huge), "too-large");
  });

  it("rejects binary that is not a zip", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expectToolError(() => readWorkbook(ole), "unsupported-format");
  });

  it("rejects a truncated zip header", () => {
    expectToolError(() => readWorkbook(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), "invalid-xlsx");
  });

  it("rejects a zip that holds no workbook part", () => {
    const zip = makeXlsx({ "word/document.xml": "<document/>" });
    expectToolError(() => readWorkbook(zip), "invalid-xlsx");
  });

  it("rejects a workbook that declares no sheets", () => {
    const zip = makeXlsx({
      "xl/workbook.xml": `<?xml version="1.0"?><workbook><sheets/></workbook>`,
    });
    expectToolError(() => readWorkbook(zip), "no-sheets");
  });

  it("reports an unreadable zip container", () => {
    // A valid local header followed by nothing the central directory can point at.
    const broken = new Uint8Array(64);
    broken.set([0x50, 0x4b, 0x03, 0x04], 0);
    expectToolError(() => readWorkbook(broken), "invalid-xlsx");
  });
});
