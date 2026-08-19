import { describe, expect, it } from "vitest";
import { run, minify, SHELF } from "./index";
import { ToolError } from "../types";

describe("bookmarklets", () => {
  describe("encode", () => {
    it("strips comments but preserves strings containing // and /*", () => {
      const src = [
        'const a = "http://example.com"; // grab it',
        "const b = `template /* not a comment */ end`;",
      ].join("\n");
      const out = run(src, { mode: "encode" }) as string;
      const decoded = decodeURIComponent(out.slice("javascript:".length));
      expect(decoded).toContain("http://example.com");
      expect(decoded).toContain("template /* not a comment */ end");
      expect(decoded).not.toContain("grab it");
    });

    it("wraps as an IIFE and produces a URL starting with javascript:(", () => {
      const out = run("alert(1)", { mode: "encode" }) as string;
      expect(out.startsWith("javascript:(")).toBe(true);
    });

    it("does not double-wrap a source that already starts with javascript:", () => {
      const already = "javascript:alert(2)";
      const out = run(already, { mode: "encode" }) as string;
      const decoded = decodeURIComponent(out.slice("javascript:".length));
      expect(decoded).toBe("alert(2)");
    });

    it("throws too-long for a source past the URL length cap", () => {
      const huge = "var a=1;".repeat(9000);
      expect(() => run(huge, { mode: "encode" })).toThrowError(ToolError);
      try {
        run(huge, { mode: "encode" });
      } catch (e) {
        expect((e as ToolError).code).toBe("too-long");
      }
    });

    it("throws empty-input for blank source", () => {
      expect(() => run("", { mode: "encode" })).toThrowError(ToolError);
      try {
        run("   ", { mode: "encode" });
      } catch (e) {
        expect((e as ToolError).code).toBe("empty-input");
      }
    });
  });

  describe("decode", () => {
    it("round-trips encode output back to something containing the original identifiers", () => {
      const src = "function myUniqueFunctionName(){return 42;}myUniqueFunctionName();";
      const encoded = run(src, { mode: "encode" }) as string;
      const decoded = run(encoded, { mode: "decode" }) as string;
      expect(decoded).toContain("myUniqueFunctionName");
    });

    it("throws not-bookmarklet for input that is not a javascript: URL", () => {
      expect(() => run("https://example.com", { mode: "decode" })).toThrowError(ToolError);
      try {
        run("https://example.com", { mode: "decode" });
      } catch (e) {
        expect((e as ToolError).code).toBe("not-bookmarklet");
      }
    });

    it("throws empty-input for blank input", () => {
      try {
        run("", { mode: "decode" });
        throw new Error("expected ToolError");
      } catch (e) {
        expect((e as ToolError).code).toBe("empty-input");
      }
    });
  });

  describe("shelf", () => {
    it("returns every named bookmarklet as a valid javascript: URL with no raw newline", () => {
      const out = run("ignored input", { mode: "shelf" }) as Record<string, string>;
      const names = SHELF.map((e) => e.name);
      expect(Object.keys(out).sort()).toEqual(names.sort());
      for (const value of Object.values(out)) {
        expect(value.startsWith("javascript:")).toBe(true);
        expect(value).not.toContain("\n");
      }
    });

    it("has between 8 and 10 entries", () => {
      expect(SHELF.length).toBeGreaterThanOrEqual(8);
      expect(SHELF.length).toBeLessThanOrEqual(10);
    });
  });

  describe("minify", () => {
    it("collapses whitespace across lines while keeping identifiers separated", () => {
      const out = minify("const   a\n  =\n1;\nconst b = 2;");
      expect(out).toContain("const a = 1;");
      expect(out).not.toContain("  ");
    });

    it("leaves a regex literal containing a slash-star sequence intact", () => {
      const out = minify("var re = /a\\/\\*b/; // trailing comment");
      expect(out).toContain("/a\\/\\*b/");
      expect(out).not.toContain("trailing comment");
    });
  });

  it("throws bad-mode for an unrecognized mode", () => {
    expect(() => run("x", { mode: "bogus" })).toThrowError(ToolError);
    try {
      run("x", { mode: "bogus" });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-mode");
    }
  });
});
