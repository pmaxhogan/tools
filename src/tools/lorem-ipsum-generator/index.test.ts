import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const defaultOpts = {
  units: "paragraphs",
  count: 3,
  variant: "classic",
  startWithLorem: false,
  format: "plain",
};

describe("lorem-ipsum-generator", () => {
  it("generates the requested number of paragraphs (happy path)", () => {
    const result = run("test-seed", defaultOpts);
    const paragraphs = result.split("\n\n");
    expect(paragraphs.length).toBe(3);
    expect(paragraphs[0]!.charAt(0)).toBe(paragraphs[0]!.charAt(0).toUpperCase());
    expect(paragraphs[0]!.trim().endsWith(".")).toBe(true);
  });

  it("is deterministic for the same seed", () => {
    const first = run("consistent-seed", defaultOpts);
    const second = run("consistent-seed", defaultOpts);
    expect(first).toBe(second);
  });

  it("produces different output for different seeds", () => {
    const a = run("seed-a", defaultOpts);
    const b = run("seed-b", defaultOpts);
    expect(a).not.toBe(b);
  });

  it("generates an exact word count when units is words", () => {
    const result = run("word-seed", { ...defaultOpts, units: "words", count: 12 });
    expect(result.split(" ").length).toBe(12);
  });

  it("generates an exact sentence count when units is sentences", () => {
    const result = run("sentence-seed", { ...defaultOpts, units: "sentences", count: 4 });
    const sentences = result.split(". ").filter(Boolean);
    expect(sentences.length).toBe(4);
  });

  it("starts with the classic Lorem ipsum opener when requested", () => {
    const result = run("seed", { ...defaultOpts, startWithLorem: true });
    expect(result.startsWith("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")).toBe(
      true,
    );
  });

  it("starts with the English opener for the english variant", () => {
    const result = run("seed", {
      ...defaultOpts,
      variant: "english",
      startWithLorem: true,
      units: "sentences",
      count: 2,
    });
    expect(result.startsWith("This is placeholder text for your design.")).toBe(true);
  });

  it("uses English filler words for the english variant, never Latin lorem ipsum words", () => {
    const result = run("english-seed", { ...defaultOpts, variant: "english", count: 5 });
    expect(result.toLowerCase()).not.toContain("lorem");
    expect(result.toLowerCase()).not.toContain("ipsum");
  });

  it("wraps each paragraph in <p> tags for html format", () => {
    const result = run("html-seed", { ...defaultOpts, format: "html", count: 2 });
    expect(
      result.split("\n").every((line) => line.startsWith("<p>") && line.endsWith("</p>")),
    ).toBe(true);
  });

  it("throws on a count of zero or less", () => {
    expect(() => run("seed", { ...defaultOpts, count: 0 })).toThrow(ToolError);
    expect(() => run("seed", { ...defaultOpts, count: -5 })).toThrow(ToolError);
  });

  it("throws on a count above the maximum", () => {
    expect(() => run("seed", { ...defaultOpts, count: 5000 })).toThrow(ToolError);
  });

  it("does not throw on empty input (no seed means random generation)", () => {
    expect(() => run("", defaultOpts)).not.toThrow();
    const result = run("", defaultOpts);
    expect(result.length).toBeGreaterThan(0);
  });
});
