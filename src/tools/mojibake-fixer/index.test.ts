import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

/**
 * Fixtures are written as escapes so the file stays pure ASCII and the exact
 * codepoints are visible. Derivations:
 *   e-acute      U+00E9 -> UTF-8 C3 A9   -> cp1252 -> \u00C3\u00A9      (A-tilde, copyright)
 *   right quote  U+2019 -> UTF-8 E2 80 99 -> cp1252 -> \u00E2\u20AC\u2122 (a-circumflex, euro, tm)
 *   double pass  \u00C3\u00A9 -> UTF-8 C3 83 C2 A9 -> cp1252 -> \u00C3\u0192\u00C2\u00A9
 */
const auto = { chain: "auto" };

describe("mojibake-fixer", () => {
  it("repairs a single mis-decoded e-acute", () => {
    const out = run("\u00C3\u00A9", auto);
    expect(out["Fixed text"]).toBe("\u00E9");
    expect(out["Applied fix"]).toMatch(/Windows-1252 once/);
    expect(out["Confidence"]).toMatch(/^High/);
  });

  it("repairs a mis-decoded right single quotation mark", () => {
    const out = run("\u00E2\u20AC\u2122", auto);
    expect(out["Fixed text"]).toBe("\u2019");
  });

  it("repairs a word containing the classic apostrophe mojibake", () => {
    const out = run("don\u00E2\u20AC\u2122t", auto);
    expect(out["Fixed text"]).toBe("don\u2019t");
  });

  it("repairs curly double quotes, including the undefined cp1252 slot 0x9D", () => {
    const out = run("\u00E2\u20AC\u0153quoted\u00E2\u20AC\u009D", auto);
    expect(out["Fixed text"]).toBe("\u201Cquoted\u201D");
  });

  it("repairs double encoded text in auto mode", () => {
    const out = run("\u00C3\u0192\u00C2\u00A9", auto);
    expect(out["Fixed text"]).toBe("\u00E9");
    expect(out["Applied fix"]).toMatch(/twice/);
  });

  it("repairs double encoded text with the forced cp1252-twice chain", () => {
    const out = run("\u00C3\u0192\u00C2\u00A9", { chain: "cp1252-twice" });
    expect(out["Fixed text"]).toBe("\u00E9");
  });

  it("reports clean English text as already clean", () => {
    const out = run("The quick brown fox jumps over the lazy dog.", auto);
    expect(Object.keys(out)).toEqual(["Result"]);
    expect(out["Result"]).toMatch(/already looks like correct UTF-8/);
  });

  it("does not mangle clean text that has legitimate accents", () => {
    const out = run("caf\u00E9 au lait, na\u00EFve r\u00E9sum\u00E9", auto);
    expect(Object.keys(out)).toEqual(["Result"]);
    expect(out["Result"]).toMatch(/nothing was changed/);
  });

  it("strips and reports a byte order mark that arrived as mojibake", () => {
    const out = run("\u00EF\u00BB\u00BFid,name", auto);
    expect(out["Fixed text"]).toBe("id,name");
    expect(out["Byte order mark"]).toMatch(/byte order mark/);
  });

  it("tolerates a few unmappable characters and marks the result partial", () => {
    // 25 broken e-acutes (50 chars) plus one CJK char: 1/51 is under the 2% budget.
    const input = "\u00C3\u00A9".repeat(25) + "\u4E2D";
    const out = run(input, auto);
    expect(out["Fixed text"]).toBe("\u00E9".repeat(25) + "\u4E2D");
    expect(out["Applied fix"]).toMatch(/passed through unchanged/);
    expect(out["Confidence"]).toMatch(/^Medium/);
  });

  it("rejects a chain when too many characters are unmappable", () => {
    // Same shape, but the unmappable character is well over 2% of the text,
    // so every chain is rejected and the text is returned untouched.
    const out = run("\u00C3\u00A9\u4E2D", auto);
    expect(out["Fixed text"]).toBe("\u00C3\u00A9\u4E2D");
    expect(out["Applied fix"]).toMatch(/^None\./);
    expect(out["Confidence"]).toMatch(/^Low/);
  });

  it("applies a forced latin1 chain", () => {
    const out = run("\u00C3\u00A9", { chain: "latin1-once" });
    expect(out["Fixed text"]).toBe("\u00E9");
    expect(out["Applied fix"]).toMatch(/Latin-1 once/);
  });

  it("reports honestly when a forced chain cannot decode", () => {
    const out = run("caf\u00E9", { chain: "cp1252-once" });
    expect(out["Fixed text"]).toBe("caf\u00E9");
    expect(out["Applied fix"]).toMatch(/^None\./);
    expect(out["Confidence"]).toMatch(/^Low/);
  });

  it("throws ToolError on empty input", () => {
    expect(() => run("", auto)).toThrowError(ToolError);
    expect(() => run("   ", auto)).toThrowError(/Enter some text/);
    try {
      run("", auto);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws ToolError on an unknown chain id", () => {
    expect(() => run("\u00C3\u00A9", { chain: "koi8-r-thrice" })).toThrowError(ToolError);
    try {
      run("\u00C3\u00A9", { chain: "koi8-r-thrice" });
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-chain");
    }
  });
});
