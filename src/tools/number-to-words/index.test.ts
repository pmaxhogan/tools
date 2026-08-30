import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const defaultOpts = { ordinal: false, currency: "none", checkStyle: false };

describe("number-to-words", () => {
  it("converts a basic integer to words (happy path)", () => {
    const result = run("1234", defaultOpts);
    expect(result.Direction).toBe("Number to words");
    expect(result.Output).toBe("one thousand two hundred thirty-four");
  });

  it("converts zero", () => {
    const result = run("0", defaultOpts);
    expect(result.Output).toBe("zero");
  });

  it("converts a negative number", () => {
    const result = run("-42", defaultOpts);
    expect(result.Output).toBe("negative forty-two");
  });

  it("converts a decimal number digit by digit", () => {
    const result = run("3.14", defaultOpts);
    expect(result.Output).toBe("three point one four");
  });

  it("converts an ordinal number", () => {
    const result = run("21", { ...defaultOpts, ordinal: true });
    expect(result.Output).toBe("twenty-first");
    const hundred = run("100", { ...defaultOpts, ordinal: true });
    expect(hundred.Output).toBe("one hundredth");
    const thousand = run("2000", { ...defaultOpts, ordinal: true });
    expect(thousand.Output).toBe("two thousandth");
  });

  it("converts USD currency", () => {
    const result = run("123.45", { ...defaultOpts, currency: "usd" });
    expect(result.Output).toBe("one hundred twenty-three dollars and forty-five cents");
  });

  it("converts GBP currency with singular units", () => {
    const result = run("1.01", { ...defaultOpts, currency: "gbp" });
    expect(result.Output).toBe("one pound and one penny");
  });

  it("converts check-writing style currency", () => {
    const result = run("123.45", { ...defaultOpts, currency: "usd", checkStyle: true });
    expect(result.Output).toBe("one hundred twenty-three and 45/100 dollars");
  });

  it("handles very large numbers up to vigintillion (10^63)", () => {
    const big = `1${"0".repeat(63)}`;
    const result = run(big, defaultOpts);
    expect(result.Output).toBe("one vigintillion");
  });

  it("throws on a number larger than vigintillion", () => {
    const tooBig = `1${"0".repeat(66)}`;
    expect(() => run(tooBig, defaultOpts)).toThrow(ToolError);
  });

  it("parses number words back into a number (reverse mode)", () => {
    const result = run("one thousand two hundred thirty-four", defaultOpts);
    expect(result.Direction).toBe("Words to number");
    expect(result.Output).toBe("1234");
  });

  it("parses negative and decimal number words back into a number", () => {
    const result = run("negative forty-two point one four", defaultOpts);
    expect(result.Output).toBe("-42.14");
  });

  it("throws ToolError on an invalid number string", () => {
    expect(() => run("12.34.56", defaultOpts)).toThrow(ToolError);
  });

  it("throws ToolError on an unrecognized number word", () => {
    expect(() => run("one gazillion", defaultOpts)).toThrow(ToolError);
  });

  it("throws ToolError on empty input", () => {
    expect(() => run("", defaultOpts)).toThrow(ToolError);
    expect(() => run("   ", defaultOpts)).toThrow(ToolError);
  });
});
