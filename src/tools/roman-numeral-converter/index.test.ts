import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const defaultOpts = { strict: true, useVinculum: false };

describe("roman-numeral-converter", () => {
  it("converts a number to a Roman numeral (happy path)", () => {
    const result = run("1994", defaultOpts);
    expect(result.Direction).toBe("Number to Roman");
    expect(result.Roman).toBe("MCMXCIV");
  });

  it("converts a Roman numeral to a number (happy path)", () => {
    const result = run("MCMXCIV", defaultOpts);
    expect(result.Direction).toBe("Roman to number");
    expect(result.Number).toBe("1994");
  });

  it("round trips zero as N", () => {
    const toRoman = run("0", defaultOpts);
    expect(toRoman.Roman).toBe("N");
    const toNumber = run("N", defaultOpts);
    expect(toNumber.Number).toBe("0");
  });

  it("rejects a non-canonical Roman numeral in strict mode", () => {
    expect(() => run("IIII", defaultOpts)).toThrow(ToolError);
  });

  it("accepts a non-canonical Roman numeral in lenient mode", () => {
    const result = run("IIII", { ...defaultOpts, strict: false });
    expect(result.Number).toBe("4");
  });

  it("encodes numbers above 3999 with repeated M when vinculum is off", () => {
    const result = run("4000", { ...defaultOpts, useVinculum: false });
    expect(result.Roman).toBe("MMMM");
  });

  it("encodes numbers above 3999 with a vinculum overline when requested", () => {
    const result = run("4783", { ...defaultOpts, useVinculum: true });
    expect(result.Roman).toBe("I̅V̅DCCLXXXIII");
  });

  it("decodes a vinculum numeral back to its number", () => {
    const encoded = run("4783", { ...defaultOpts, useVinculum: true });
    const decoded = run(encoded.Roman!, { ...defaultOpts, useVinculum: true });
    expect(decoded.Number).toBe("4783");
  });

  it("throws on an invalid Roman numeral character", () => {
    expect(() => run("MCMXCIW", defaultOpts)).toThrow(ToolError);
  });

  it("throws on a value out of range", () => {
    expect(() => run("4000000", defaultOpts)).toThrow(ToolError);
  });

  it("throws on empty input", () => {
    expect(() => run("", defaultOpts)).toThrow(ToolError);
    expect(() => run("   ", defaultOpts)).toThrow(ToolError);
  });

  it("throws on input that is neither a number nor Roman letters", () => {
    expect(() => run("12.5", defaultOpts)).toThrow(ToolError);
  });

  it("provides a breakdown of the conversion", () => {
    const result = run("MCMXCIV", defaultOpts);
    expect(result.Breakdown).toContain("M ->");
  });
});
