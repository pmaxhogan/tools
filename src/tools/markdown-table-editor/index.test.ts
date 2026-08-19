import { describe, expect, it } from "vitest";
import {
  addColumn,
  addRow,
  detectTableFormat,
  displayWidth,
  fillEmpty,
  formatMarkdownTable,
  moveColumn,
  moveRow,
  parseTable,
  parseTableDetailed,
  removeColumn,
  removeRow,
  run,
  setAlign,
  setCell,
  sortBy,
  splitPipeRow,
  toAsciiTable,
  toCsv,
  toHtml,
  toJson,
  toLatex,
  toTsv,
  transpose,
  trimCells,
  type Align,
  type Table,
} from "./index";
import { ToolError } from "../types";

const table = (header: string[], rows: string[][], align: Align[] = []): Table => ({
  header,
  align: header.map((_cell, i) => align[i] ?? "none"),
  rows,
});

const MD = [
  "| Name | Age | City |",
  "| :--- | ---: | :--: |",
  "| Alice | 30 | Paris |",
  "| Bob | 7 | Rome |",
].join("\n");

const PEOPLE = table(
  ["Name", "Age"],
  [
    ["Alice", "30"],
    ["Bob", "7"],
  ],
  ["none", "right"],
);

describe("markdown-table-editor parsing", () => {
  it("parses a Markdown table with alignment colons", () => {
    expect(parseTable(MD)).toEqual({
      header: ["Name", "Age", "City"],
      align: ["left", "right", "center"],
      rows: [
        ["Alice", "30", "Paris"],
        ["Bob", "7", "Rome"],
      ],
    });
  });

  it("parses a table with no leading or trailing pipes", () => {
    const parsed = parseTable("Name | Age\n--- | ---\nAlice | 30");
    expect(parsed.header).toEqual(["Name", "Age"]);
    expect(parsed.rows).toEqual([["Alice", "30"]]);
  });

  it("keeps an escaped pipe inside a cell", () => {
    const parsed = parseTable("| expr | note |\n| --- | --- |\n| a \\| b | or |");
    expect(parsed.rows).toEqual([["a | b", "or"]]);
  });

  it("keeps a pipe inside an inline code span", () => {
    const parsed = parseTable("| expr | note |\n| --- | --- |\n| `a | b` | or |");
    expect(parsed.rows).toEqual([["`a | b`", "or"]]);
  });

  it("accepts a Markdown table with a header and no data rows", () => {
    const parsed = parseTable("| Name | Age |\n| --- | --- |");
    expect(parsed.header).toEqual(["Name", "Age"]);
    expect(parsed.rows).toEqual([]);
  });

  it("parses tab separated text pasted from a spreadsheet", () => {
    const parsed = parseTable("Name\tAge\nAlice\t30\nBob\t7");
    expect(parsed).toEqual({
      header: ["Name", "Age"],
      align: ["none", "none"],
      rows: [
        ["Alice", "30"],
        ["Bob", "7"],
      ],
    });
  });

  it("parses CSV with quoted commas", () => {
    const parsed = parseTable('name,note\nAlice,"Paris, France"\nBob,Rome');
    expect(parsed.header).toEqual(["name", "note"]);
    expect(parsed.rows).toEqual([
      ["Alice", "Paris, France"],
      ["Bob", "Rome"],
    ]);
  });

  it("parses an HTML table and decodes entities in the right order", () => {
    const html =
      "<table><thead><tr><th>Name</th><th>Note</th></tr></thead>" +
      "<tbody><tr><td>Alice</td><td>A &amp;lt; B</td></tr>" +
      "<tr><td>Bob</td><td>Rome&nbsp;IT</td></tr></tbody></table>";
    expect(parseTable(html)).toEqual({
      header: ["Name", "Note"],
      align: ["none", "none"],
      rows: [
        ["Alice", "A &lt; B"],
        ["Bob", "Rome IT"],
      ],
    });
  });

  it("parses an HTML fragment with unclosed cells", () => {
    const parsed = parseTable("<tr><td>a<td>b<tr><td>c<td>d");
    expect(parsed.header).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([["c", "d"]]);
  });

  it("parses whitespace aligned columns as a fallback", () => {
    const parsed = parseTable("Name     Age   City\nAlice    30    Paris\nBob      7     Rome");
    expect(parsed.header).toEqual(["Name", "Age", "City"]);
    expect(parsed.rows).toEqual([
      ["Alice", "30", "Paris"],
      ["Bob", "7", "Rome"],
    ]);
  });

  it("fills ragged rows and reports it as a warning, not an error", () => {
    const result = parseTableDetailed("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |");
    expect(result.table.rows).toEqual([["1", "2", ""]]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("filled with empty cells");
  });

  it("tolerates an alignment row that is shorter than the header", () => {
    const result = parseTableDetailed("| a | b | c |\n| :-- | --: |\n| 1 | 2 | 3 |");
    expect(result.table.align).toEqual(["left", "right", "none"]);
    expect(result.warnings.some((w) => w.includes("alignment row"))).toBe(true);
  });

  it("detects each supported input format", () => {
    expect(detectTableFormat(MD)).toBe("markdown");
    expect(detectTableFormat("a\tb\nc\td")).toBe("tsv");
    expect(detectTableFormat("a,b\nc,d")).toBe("csv");
    expect(detectTableFormat("<table><tr><td>a</td></tr></table>")).toBe("html");
    expect(detectTableFormat("a   b\nc   d")).toBe("whitespace");
  });

  it("does not read a horizontal rule as a delimiter row", () => {
    expect(detectTableFormat("title\n---\nbody text")).not.toBe("markdown");
  });

  it("splits rows on unescaped pipes only", () => {
    expect(splitPipeRow("| a | b |")).toEqual([" a ", " b "]);
    expect(splitPipeRow("a|b")).toEqual(["a", "b"]);
    expect(splitPipeRow("| a | |")).toEqual([" a ", " "]);
  });
});

describe("markdown-table-editor formatting", () => {
  it("pads columns and writes the alignment row", () => {
    expect(formatMarkdownTable(PEOPLE)).toBe(
      ["| Name  | Age |", "| ----- | --: |", "| Alice |  30 |", "| Bob   |   7 |"].join("\n"),
    );
  });

  it("writes minimal pipes in compact mode", () => {
    expect(formatMarkdownTable(PEOPLE, { compact: true })).toBe(
      ["|Name|Age|", "|-|-:|", "|Alice|30|", "|Bob|7|"].join("\n"),
    );
  });

  it("uses a single space per cell when padding is off", () => {
    expect(formatMarkdownTable(PEOPLE, { pad: false })).toBe(
      ["| Name | Age |", "| --- | --: |", "| Alice | 30 |", "| Bob | 7 |"].join("\n"),
    );
  });

  it("counts CJK characters as two columns when padding", () => {
    const cjk = table(
      ["名前", "City"],
      [
        ["太郎", "Kyoto"],
        ["Bo", "Rome"],
      ],
    );
    expect(formatMarkdownTable(cjk)).toBe(
      ["| 名前 | City  |", "| ---- | ----- |", "| 太郎 | Kyoto |", "| Bo   | Rome  |"].join("\n"),
    );
  });

  it("measures display width, not code units", () => {
    expect(displayWidth("名前")).toBe(4);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("Bo")).toBe(2);
  });

  it("escapes pipes inside cells and round trips them", () => {
    const piped = table(["expr", "note"], [["a|b", "or"]]);
    const out = formatMarkdownTable(piped);
    expect(out).toContain("a\\|b");
    expect(parseTable(out).rows).toEqual([["a|b", "or"]]);
  });

  it("takes a per-column alignment override", () => {
    const out = formatMarkdownTable(PEOPLE, { align: ["center", "center"] });
    expect(out.split("\n")[1]).toBe("| :---: | :-: |");
  });

  it("moves the header into the body when headerFromFirstRow is false", () => {
    const raw = table(["a", "b"], [["1", "2"]]);
    expect(formatMarkdownTable(raw, { headerFromFirstRow: false })).toBe(
      [
        "| Column 1 | Column 2 |",
        "| -------- | -------- |",
        "| a        | b        |",
        "| 1        | 2        |",
      ].join("\n"),
    );
  });

  it("round trips: formatting a formatted table is idempotent", () => {
    const once = formatMarkdownTable(parseTable(MD));
    const twice = formatMarkdownTable(parseTable(once));
    expect(twice).toBe(once);
    expect(once).toBe(
      [
        "| Name  | Age | City  |",
        "| :---- | --: | :---: |",
        "| Alice |  30 | Paris |",
        "| Bob   |   7 | Rome  |",
      ].join("\n"),
    );
  });

  it("round trips a spreadsheet paste into aligned Markdown", () => {
    const once = run("Name\tAge\nAlice\t30\nBob\t7", {});
    expect(once).toBe(
      ["| Name  | Age |", "| ----- | --- |", "| Alice | 30  |", "| Bob   | 7   |"].join("\n"),
    );
    expect(run(once, {})).toBe(once);
  });
});

describe("markdown-table-editor operations", () => {
  it("adds and removes rows without mutating the source", () => {
    const grown = addRow(PEOPLE, 1);
    expect(grown.rows).toEqual([
      ["Alice", "30"],
      ["", ""],
      ["Bob", "7"],
    ]);
    expect(PEOPLE.rows).toHaveLength(2);
    expect(removeRow(grown, 1).rows).toEqual(PEOPLE.rows);
  });

  it("adds and removes columns, keeping alignment in step", () => {
    const grown = addColumn(PEOPLE, 1, "City");
    expect(grown.header).toEqual(["Name", "City", "Age"]);
    expect(grown.align).toEqual(["none", "none", "right"]);
    expect(grown.rows[0]).toEqual(["Alice", "", "30"]);
    expect(removeColumn(grown, 1)).toEqual(PEOPLE);
  });

  it("moves a column and its alignment together", () => {
    const three = table(["a", "b", "c"], [["1", "2", "3"]], ["left", "center", "right"]);
    const moved = moveColumn(three, 0, 2);
    expect(moved.header).toEqual(["b", "c", "a"]);
    expect(moved.align).toEqual(["center", "right", "left"]);
    expect(moved.rows).toEqual([["2", "3", "1"]]);
  });

  it("moves a row", () => {
    expect(moveRow(PEOPLE, 1, 0).rows).toEqual([
      ["Bob", "7"],
      ["Alice", "30"],
    ]);
  });

  it("sets a cell, and row -1 targets the header", () => {
    expect(setCell(PEOPLE, 0, 1, "31").rows[0]).toEqual(["Alice", "31"]);
    expect(setCell(PEOPLE, -1, 0, "Person").header).toEqual(["Person", "Age"]);
  });

  it("sorts numerically when the column is numeric", () => {
    const nums = table(
      ["item", "qty"],
      [
        ["a", "9"],
        ["b", "10"],
        ["c", "2"],
      ],
    );
    expect(sortBy(nums, 1, "asc").rows.map((r) => r[1])).toEqual(["2", "9", "10"]);
    expect(sortBy(nums, 1, "desc").rows.map((r) => r[1])).toEqual(["10", "9", "2"]);
  });

  it("falls back to text order when numeric awareness is off", () => {
    const nums = table(
      ["item", "qty"],
      [
        ["a", "9"],
        ["b", "10"],
        ["c", "2"],
      ],
    );
    expect(sortBy(nums, 1, "asc", false).rows.map((r) => r[1])).toEqual(["10", "2", "9"]);
  });

  it("transposes rows and columns", () => {
    const grid = table(
      ["a", "b"],
      [
        ["1", "2"],
        ["3", "4"],
      ],
    );
    expect(transpose(grid)).toEqual({
      header: ["a", "1", "3"],
      align: ["none", "none", "none"],
      rows: [["b", "2", "4"]],
    });
  });

  it("sets one column's alignment", () => {
    expect(setAlign(PEOPLE, 0, "center").align).toEqual(["center", "right"]);
  });

  it("trims cells and fills empty ones", () => {
    const messy = table([" Name ", "Age"], [["  Alice", "  "]]);
    expect(trimCells(messy).rows).toEqual([["Alice", ""]]);
    expect(fillEmpty(trimCells(messy), "n/a").rows).toEqual([["Alice", "n/a"]]);
  });
});

describe("markdown-table-editor exporters", () => {
  it("exports CSV with quoting", () => {
    const notes = table(["Name", "Note"], [["Alice", "Paris, France"]]);
    expect(toCsv(notes)).toBe('Name,Note\nAlice,"Paris, France"');
  });

  it("exports TSV", () => {
    expect(toTsv(PEOPLE)).toBe("Name\tAge\nAlice\t30\nBob\t7");
  });

  it("exports HTML with a head, a body, escaping, and alignment", () => {
    const escaped = table(["Name", "Age"], [["A & B", "30"]], ["none", "right"]);
    expect(toHtml(escaped)).toBe(
      [
        "<table>",
        "  <thead>",
        "    <tr>",
        "      <th>Name</th>",
        '      <th style="text-align: right">Age</th>',
        "    </tr>",
        "  </thead>",
        "  <tbody>",
        "    <tr>",
        "      <td>A &amp; B</td>",
        '      <td style="text-align: right">30</td>',
        "    </tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("exports JSON keyed by the header", () => {
    expect(JSON.parse(toJson(PEOPLE))).toEqual([
      { Name: "Alice", Age: "30" },
      { Name: "Bob", Age: "7" },
    ]);
  });

  it("gives duplicate and empty header names unique JSON keys", () => {
    const dupes = table(["a", "a", ""], [["1", "2", "3"]]);
    expect(JSON.parse(toJson(dupes))).toEqual([{ a: "1", a_2: "2", column3: "3" }]);
  });

  it("exports a box drawing ASCII table", () => {
    expect(toAsciiTable(PEOPLE)).toBe(
      [
        "+-------+-----+",
        "| Name  | Age |",
        "+-------+-----+",
        "| Alice |  30 |",
        "| Bob   |   7 |",
        "+-------+-----+",
      ].join("\n"),
    );
  });

  it("exports a LaTeX tabular with escaped specials", () => {
    const latex = table(["Name", "Cost %"], [["A & B", "10$"]], ["none", "right"]);
    expect(toLatex(latex)).toBe(
      [
        "\\begin{tabular}{|l|r|}",
        "  \\hline",
        "  Name & Cost \\% \\\\",
        "  \\hline",
        "  A \\& B & 10\\$ \\\\",
        "  \\hline",
        "\\end{tabular}",
      ].join("\n"),
    );
  });
});

describe("markdown-table-editor run", () => {
  it("formats to Markdown by default", () => {
    expect(run(MD, {}).split("\n")[1]).toBe("| :---- | --: | :---: |");
  });

  it("accepts output synonyms", () => {
    expect(run("a,b\n1,2", { output: "excel" })).toBe("a\tb\n1\t2");
    expect(run("a,b\n1,2", { output: "MD" })).toContain("| --- |");
  });

  it("overrides alignment for every column", () => {
    expect(run(MD, { align: "center" }).split("\n")[1]).toBe("| :---: | :-: | :---: |");
  });

  it("sorts on demand for the panel", () => {
    const out = run("item,qty\na,9\nb,10\nc,2", { sort: "asc", sortColumn: 1, compact: true });
    expect(out.split("\n").slice(2)).toEqual(["|c|2|", "|a|9|", "|b|10|"]);
  });

  it("converts CSV to every export format", () => {
    const csv = "name,city\nAlice,Paris";
    expect(run(csv, { output: "json" })).toBe(
      JSON.stringify([{ name: "Alice", city: "Paris" }], null, 2),
    );
    expect(run(csv, { output: "html" })).toContain("<th>name</th>");
    expect(run(csv, { output: "ascii" }).startsWith("+")).toBe(true);
    expect(run(csv, { output: "latex" })).toContain("\\begin{tabular}");
    expect(run(csv, { output: "tsv" })).toBe("name\tcity\nAlice\tParis");
    expect(run(csv, { output: "csv" })).toBe(csv);
  });
});

describe("markdown-table-editor errors", () => {
  it("throws empty-input on blank input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    expect(() => run("   \n  ", {})).toThrowError(expect.objectContaining({ code: "empty-input" }));
  });

  it("throws no-table when there is only one column", () => {
    expect(() => run("hello", {})).toThrowError(expect.objectContaining({ code: "no-table" }));
  });

  it("throws no-table for HTML without rows", () => {
    expect(() => run("<table></table>", {})).toThrowError(
      expect.objectContaining({ code: "no-table" }),
    );
  });

  it("throws bad-option for an unknown output format", () => {
    expect(() => run(MD, { output: "pdf" })).toThrowError(
      expect.objectContaining({ code: "bad-option" }),
    );
  });

  it("throws bad-option for an unknown alignment", () => {
    expect(() => run(MD, { align: "justify" })).toThrowError(
      expect.objectContaining({ code: "bad-option" }),
    );
  });

  it("throws bad-option for an unknown sort direction", () => {
    expect(() => run(MD, { sort: "random" })).toThrowError(
      expect.objectContaining({ code: "bad-option" }),
    );
  });

  it("throws bad-index when an operation points outside the table", () => {
    expect(() => removeRow(PEOPLE, 9)).toThrowError(expect.objectContaining({ code: "bad-index" }));
    expect(() => removeColumn(PEOPLE, -1)).toThrowError(
      expect.objectContaining({ code: "bad-index" }),
    );
    expect(() => moveColumn(PEOPLE, 0, 5)).toThrowError(
      expect.objectContaining({ code: "bad-index" }),
    );
    expect(() => setCell(PEOPLE, 0, 7, "x")).toThrowError(
      expect.objectContaining({ code: "bad-index" }),
    );
  });

  it("says how to fix a bad option", () => {
    try {
      run(MD, { output: "pdf" });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).fix).toContain("markdown");
    }
  });
});
