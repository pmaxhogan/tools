import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const baseOpts = {
  operation: "sort-az",
  caseInsensitive: false,
  trim: false,
  removeEmpty: false,
  seed: "",
};

describe("line-sorter", () => {
  it("sorts lines alphabetically A-Z", () => {
    const out = run("banana\napple\ncherry", { ...baseOpts, operation: "sort-az" });
    expect(out).toBe("apple\nbanana\ncherry");
  });

  it("sorts lines alphabetically Z-A", () => {
    const out = run("banana\napple\ncherry", { ...baseOpts, operation: "sort-za" });
    expect(out).toBe("cherry\nbanana\napple");
  });

  it("sorts naturally so item2 comes before item10", () => {
    const out = run("item10\nitem2\nitem1", { ...baseOpts, operation: "sort-natural" });
    expect(out).toBe("item1\nitem2\nitem10");
  });

  it("sorts by line length", () => {
    const out = run("ccc\na\nbb", { ...baseOpts, operation: "sort-length" });
    expect(out).toBe("a\nbb\nccc");
  });

  it("deduplicates case-insensitively while keeping the first casing", () => {
    const out = run("Apple\napple\nBanana\nBANANA\nCherry", {
      ...baseOpts,
      operation: "dedupe",
      caseInsensitive: true,
    });
    expect(out).toBe("Apple\nBanana\nCherry");
  });

  it("deduplicates case-sensitively by default, preserving order", () => {
    const out = run("Apple\napple\nApple", { ...baseOpts, operation: "dedupe" });
    expect(out).toBe("Apple\napple");
  });

  it("reverses line order", () => {
    const out = run("one\ntwo\nthree", { ...baseOpts, operation: "reverse" });
    expect(out).toBe("three\ntwo\none");
  });

  it("shuffles deterministically for a given seed", () => {
    const input = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    const out1 = run(input, { ...baseOpts, operation: "shuffle", seed: "my-seed" });
    const out2 = run(input, { ...baseOpts, operation: "shuffle", seed: "my-seed" });
    expect(out1).toBe(out2);
    // Still a permutation of the original lines.
    expect(out1.split("\n").sort()).toEqual(input.split("\n").sort());
  });

  it("produces different shuffles for different seeds", () => {
    const input = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    const out1 = run(input, { ...baseOpts, operation: "shuffle", seed: "seed-one" });
    const out2 = run(input, { ...baseOpts, operation: "shuffle", seed: "seed-two" });
    expect(out1).not.toBe(out2);
  });

  it("trims each line and removes empty lines when combined", () => {
    const out = run("  foo  \n\n   \nbar\n  ", {
      ...baseOpts,
      operation: "reverse",
      trim: true,
      removeEmpty: true,
    });
    expect(out).toBe("bar\nfoo");
  });

  it("preserves input trailing-newline-lessness by splitting on CRLF/LF and joining with LF", () => {
    const out = run("b\r\na\r\nc", { ...baseOpts, operation: "sort-az" });
    expect(out).toBe("a\nb\nc");
  });

  it("throws a typed error on empty input", () => {
    expect(() => run("", baseOpts)).toThrowError(ToolError);
    expect(() => run("   ", baseOpts)).toThrowError(/Enter some lines/);
  });

  it("throws a typed error on an unknown operation", () => {
    expect(() => run("a\nb", { ...baseOpts, operation: "bogus" })).toThrowError(ToolError);
    expect(() => run("a\nb", { ...baseOpts, operation: "bogus" })).toThrowError(
      /Unknown operation/,
    );
  });
});
