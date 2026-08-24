import { describe, expect, it } from "vitest";
import { LONG_VALUE_CHARS, isLongValue, recordToRows, rowsToText } from "./key-value";

describe("isLongValue", () => {
  it("treats short single line values as short", () => {
    expect(isLongValue("")).toBe(false);
    expect(isLongValue("42")).toBe(false);
    expect(isLongValue("image/png")).toBe(false);
  });

  it("switches over at exactly the documented boundary", () => {
    expect(LONG_VALUE_CHARS).toBe(60);
    expect(isLongValue("x".repeat(59))).toBe(false);
    expect(isLongValue("x".repeat(60))).toBe(false);
    expect(isLongValue("x".repeat(61))).toBe(true);
  });

  it("treats any newline as long, however short the text is", () => {
    expect(isLongValue("a\nb")).toBe(true);
    expect(isLongValue("\n")).toBe(true);
    expect(isLongValue("trailing\n")).toBe(true);
  });

  it("counts characters, not words", () => {
    expect(isLongValue("word ".repeat(11).trim())).toBe(false);
    expect(isLongValue("word ".repeat(13).trim())).toBe(true);
  });
});

describe("recordToRows", () => {
  it("returns one row per entry, in insertion order", () => {
    expect(recordToRows({ Size: "1.2 MB", Type: "image/png", Width: "800" })).toEqual([
      { key: "Size", value: "1.2 MB" },
      { key: "Type", value: "image/png" },
      { key: "Width", value: "800" },
    ]);
  });

  it("keeps insertion order even when keys look numeric", () => {
    const record: Record<string, string> = {};
    record.zulu = "last written";
    record.alpha = "written second";
    expect(recordToRows(record).map((row) => row.key)).toEqual(["zulu", "alpha"]);
  });

  it("returns an empty array for an empty record", () => {
    expect(recordToRows({})).toEqual([]);
  });

  it("never sets long, so the length test stays in charge", () => {
    const rows = recordToRows({ Blob: "x".repeat(200) });
    expect(rows[0]!.long).toBeUndefined();
  });
});

describe("rowsToText", () => {
  it("writes one key: value line per row", () => {
    expect(
      rowsToText([
        { key: "Size", value: "1.2 MB" },
        { key: "Type", value: "image/png" },
      ]),
    ).toBe("Size: 1.2 MB\nType: image/png");
  });

  it("passes multi line values straight through", () => {
    expect(rowsToText([{ key: "Body", value: "one\ntwo" }])).toBe("Body: one\ntwo");
  });

  it("returns an empty string for no rows", () => {
    expect(rowsToText([])).toBe("");
  });

  it("matches the record it came from", () => {
    const record = { A: "1", B: "2" };
    expect(rowsToText(recordToRows(record))).toBe("A: 1\nB: 2");
  });
});
