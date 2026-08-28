import { describe, expect, it } from "vitest";
// Ensures Node has URLPattern available; the logic prefers a native one when present.
import "urlpattern-polyfill";
import { ToolError } from "../types";
import { run } from "./index";

describe("urlpattern-tester", () => {
  it("matches a named group and reports its value", () => {
    const out = run("https://example.com/users/42", {
      pattern: "/users/:id",
      baseURL: "https://example.com",
    });

    expect(out["Match"]).toBe("yes");
    expect(out["URL"]).toBe("https://example.com/users/42");
    expect(out["pathname.groups.id"]).toBe("42");
    expect(out["Base URL"]).toBe("https://example.com");
    expect(out["Pattern"]).toContain("pathname=/users/:id");
  });

  it("does not leak empty wildcard groups from untouched components", () => {
    const out = run("https://example.com/users/42", {
      pattern: "/users/:id",
      baseURL: "https://example.com",
    });

    expect(out["username.groups.0"]).toBeUndefined();
    expect(out["search.groups.0"]).toBeUndefined();
  });

  it("captures a wildcard as an indexed group", () => {
    const out = run("https://example.com/files/docs/report.pdf", {
      pattern: "/files/*",
      baseURL: "https://example.com",
    });

    expect(out["Match"]).toBe("yes");
    expect(out["pathname.groups.0"]).toBe("docs/report.pdf");
  });

  it("reports no match without any group rows", () => {
    const out = run("https://example.com/posts/42", {
      pattern: "/users/:id",
      baseURL: "https://example.com",
    });

    expect(out["Match"]).toBe("no");
    expect(out["pathname.groups.id"]).toBeUndefined();
  });

  it("says (none) when a match has no groups to show", () => {
    const out = run("https://example.com/about", {
      pattern: "/about",
      baseURL: "https://example.com",
    });

    expect(out["Match"]).toBe("yes");
    expect(out["Groups"]).toBe("(none)");
  });

  it("summarizes several URLs in one run", () => {
    const input = [
      "https://example.com/users/1",
      "https://example.com/users/abc",
      "https://example.com/teams/9",
    ].join("\n");

    const out = run(input, { pattern: "/users/:id", baseURL: "https://example.com" });

    expect(out["Summary"]).toBe("2 of 3 URLs matched.");
    expect(out["https://example.com/users/1"]).toBe("match: pathname.id=1");
    expect(out["https://example.com/users/abc"]).toBe("match: pathname.id=abc");
    expect(out["https://example.com/teams/9"]).toBe("no match");
    expect(out["Match"]).toBeUndefined();
  });

  it("labels a repeated URL so no row is lost", () => {
    const out = run("https://example.com/users/7\nhttps://example.com/users/7", {
      pattern: "/users/:id",
      baseURL: "https://example.com",
    });

    expect(out["https://example.com/users/7"]).toBe("match: pathname.id=7");
    expect(out["https://example.com/users/7 [2]"]).toBe("match: pathname.id=7");
  });

  it("matches an absolute pattern with a hostname group and no base URL", () => {
    const out = run("https://api.example.com/v2/status", { pattern: "https://:sub.example.com/*" });

    expect(out["Match"]).toBe("yes");
    expect(out["hostname.groups.sub"]).toBe("api");
    expect(out["pathname.groups.0"]).toBe("v2/status");
    expect(out["Base URL"]).toBeUndefined();
  });

  it("accepts a relative URL when a base URL is given", () => {
    const out = run("/users/42", { pattern: "/users/:id", baseURL: "https://example.com" });

    expect(out["Match"]).toBe("yes");
    expect(out["pathname.groups.id"]).toBe("42");
  });

  it("treats an unparseable line as no match instead of crashing", () => {
    const out = run("not a url at all", { pattern: "https://example.com/*" });

    expect(out["Match"]).toBe("no");
  });

  it("throws bad-pattern on invalid syntax", () => {
    expect(() => run("https://example.com/x", { pattern: "((", baseURL: "https://example.com" })) //
      .toThrowError(ToolError);

    try {
      run("https://example.com/x", { pattern: "((", baseURL: "https://example.com" });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-pattern");
      expect((err as ToolError).fix).toContain("URLPattern syntax");
    }
  });

  /**
   * Broken syntax is a syntax problem whether or not a base URL is filled in.
   * Only the pattern is asserted on, never the thrown message: implementations
   * word these differently, and the native one says nothing useful at all.
   */
  it("throws bad-pattern with the syntax hint for broken syntax and no base", () => {
    try {
      run("https://example.com/x", { pattern: "((" });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-pattern");
      expect((err as ToolError).fix).toContain("URLPattern syntax");
    }
  });

  it("throws bad-pattern with a base URL hint for a relative pattern and no base", () => {
    try {
      run("https://example.com/users/42", { pattern: "/users/:id" });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-pattern");
      expect((err as ToolError).fix).toContain("Base URL");
    }
  });

  it("blames the base URL, not the pattern, when the base is not a URL", () => {
    try {
      run("https://example.com/users/42", { pattern: "/users/:id", baseURL: "not a url" });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-base-url");
      expect((err as ToolError).fix).toContain("Base URL");
    }
  });

  it("throws empty-pattern when no pattern is given, even with no URLs", () => {
    try {
      run("", { pattern: "   " });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-pattern");
    }
  });

  it("throws empty-input when the pattern is set but no URLs are given", () => {
    try {
      run("  \n \n", { pattern: "/users/:id", baseURL: "https://example.com" });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
    }
  });
});
