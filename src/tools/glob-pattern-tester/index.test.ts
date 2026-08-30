import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, type GlobPatternTesterOpts } from "./index";

type Extra = Omit<GlobPatternTesterOpts, "pattern">;

/** The paths listed under the "Matched" row, without its count line. */
function matched(paths: string[], pattern: string, extra: Extra = {}): string[] {
  const out = run(paths.join("\n"), { pattern, ...extra });
  const block = out["Matched"]!;
  return block === "(none)" ? [] : block.split("\n").slice(1);
}

/** Does this single path match this pattern? */
function hits(path: string, pattern: string, extra: Extra = {}): boolean {
  return matched([path], pattern, extra).length === 1;
}

/** The ToolError code a call throws, so every branch can be asserted by name. */
function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ToolError ? err.code : `not-a-tool-error: ${String(err)}`;
  }
  return "no-throw";
}

describe("glob-pattern-tester", () => {
  it("matches a star inside one segment and never across a slash", () => {
    expect(hits("src/a.ts", "src/*.ts")).toBe(true);
    expect(hits("src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(hits("a", "*")).toBe(true);
    expect(hits("a/b", "*")).toBe(false);
  });

  it("treats a globstar as zero or more segments", () => {
    expect(hits("a/b", "a/**/b")).toBe(true);
    expect(hits("a/x/b", "a/**/b")).toBe(true);
    expect(hits("a/x/y/b", "a/**/b")).toBe(true);
    expect(hits("a/b/c", "a/**/b")).toBe(false);
    expect(hits("ab", "a/**/b")).toBe(false);
  });

  it("matches everything below a trailing globstar but not the prefix itself", () => {
    expect(hits("src/a.ts", "src/**")).toBe(true);
    expect(hits("src/deep/a.ts", "src/**")).toBe(true);
    expect(hits("src", "src/**")).toBe(false);
    expect(hits("srcx/a.ts", "src/**")).toBe(false);
  });

  it("lets a leading globstar reach any depth", () => {
    expect(matched(["a.ts", "src/a.ts", "src/x/a.ts", "a.js"], "**/*.ts")).toEqual([
      "a.ts",
      "src/a.ts",
      "src/x/a.ts",
    ]);
    expect(matched(["a", "a/b", "a/b/c"], "**")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("matches exactly one character with a question mark", () => {
    expect(hits("abc", "a?c")).toBe(true);
    expect(hits("ac", "a?c")).toBe(false);
    expect(hits("abbc", "a?c")).toBe(false);
    expect(hits("a/c", "a?c")).toBe(false);
  });

  it("supports character classes, ranges, and both negation forms", () => {
    expect(matched(["a.txt", "b.txt", "d.txt"], "[abc].txt")).toEqual(["a.txt", "b.txt"]);
    expect(hits("src/main.ts", "src/[a-z]*.ts")).toBe(true);
    expect(hits("src/Main.ts", "src/[a-z]*.ts")).toBe(false);
    expect(hits("zc", "[!ab]c")).toBe(true);
    expect(hits("ac", "[!ab]c")).toBe(false);
    expect(hits("zc", "[^ab]c")).toBe(true);
    expect(hits("]x", "[]]x")).toBe(true);
  });

  it("never lets a class match a slash", () => {
    expect(hits("a/c", "a[!b]c")).toBe(false);
    expect(hits("axc", "a[!b]c")).toBe(true);
  });

  it("expands brace groups, including nested ones", () => {
    expect(matched(["src/a.ts", "src/a.tsx", "src/a.js"], "src/*.{ts,tsx}")).toEqual([
      "src/a.ts",
      "src/a.tsx",
    ]);
    expect(matched(["a.txt", "b.txt", "c.txt", "d.txt"], "{a,{b,c}}.txt")).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(hits("{ab}.txt", "{a{b,c}}.txt")).toBe(true);
  });

  it("keeps a brace literal when it lists no alternatives", () => {
    expect(hits("file{a}.txt", "file{a}.txt")).toBe(true);
    expect(hits("file{a.txt", "file{a.txt")).toBe(true);
    expect(hits("filea.txt", "file{a}.txt")).toBe(false);
  });

  it("treats a leading exclamation mark as an exclusion", () => {
    expect(matched(["a.log", "a.txt"], "!*.log")).toEqual(["a.txt"]);
    expect(matched(["src/a.ts", "src/a.test.ts"], "src/**\n!src/**/*.test.ts")).toEqual([
      "src/a.ts",
    ]);
  });

  it("takes several include patterns, one per line", () => {
    expect(matched(["a.ts", "a.md", "a.js"], "*.ts\n*.md")).toEqual(["a.ts", "a.md"]);
  });

  it("escapes metacharacters after a backslash", () => {
    expect(hits("a*b", "a\\*b")).toBe(true);
    expect(hits("axb", "a\\*b")).toBe(false);
    expect(hits("a?b", "a\\?b")).toBe(true);
    expect(hits("axb", "a\\?b")).toBe(false);
    expect(hits("[abc]", "\\[abc]")).toBe(true);
  });

  it("hides dotfiles from wildcards by default", () => {
    expect(hits(".env", "*")).toBe(false);
    expect(hits(".env", ".*")).toBe(true);
    expect(hits(".config/a.ts", "**/*.ts")).toBe(false);
    expect(hits("src/.hidden.ts", "src/*.ts")).toBe(false);
    expect(hits(".env", "?env")).toBe(false);
  });

  it("matches dotfiles when the dot option is on", () => {
    expect(hits(".env", "*", { dot: true })).toBe(true);
    expect(hits(".config/a.ts", "**/*.ts", { dot: true })).toBe(true);
    expect(hits("src/.hidden.ts", "src/*.ts", { dot: true })).toBe(true);
  });

  it("compares case sensitively unless told otherwise", () => {
    expect(hits("src/a.ts", "SRC/*.TS")).toBe(false);
    expect(hits("src/a.ts", "SRC/*.TS", { caseSensitive: false })).toBe(true);
    expect(hits("src/a.ts", "SRC/*.TS", { caseSensitive: true })).toBe(false);
  });

  it("matches the file name at any depth only when matchBase is on", () => {
    expect(matched(["a.ts", "src/a.ts"], "*.ts")).toEqual(["a.ts"]);
    expect(matched(["a.ts", "src/a.ts"], "*.ts", { matchBase: true })).toEqual([
      "a.ts",
      "src/a.ts",
    ]);
    expect(hits("x/src/a.ts", "src/*.ts", { matchBase: true })).toBe(false);
    expect(hits("src/.env", "*.env", { matchBase: true })).toBe(false);
  });

  it("reports matched, unmatched, a summary, and the compiled regex", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/deep/c.ts", "readme.md"];
    const out = run(paths.join("\n"), { pattern: "src/*.ts" });

    expect(out["Summary"]).toBe("2 of 4 paths match");
    expect(out["Matched"]).toBe("2 of 4\nsrc/a.ts\nsrc/b.ts");
    expect(out["Not matched"]).toBe("2 of 4\nsrc/deep/c.ts\nreadme.md");
    expect(out["Regex"]).toBe("^src/(?!\\.)[^/]*\\.ts$");
  });

  it("says (none) for an empty side and agrees with the count", () => {
    const out = run("a.js\nb.js", { pattern: "*.ts" });
    expect(out["Matched"]).toBe("(none)");
    expect(out["Summary"]).toBe("0 of 2 paths match");
    expect(out["Not matched"]).toBe("2 of 2\na.js\nb.js");

    const one = run("a.ts", { pattern: "*.ts" });
    expect(one["Summary"]).toBe("1 of 1 path matches");
    expect(one["Not matched"]).toBe("(none)");
  });

  it("labels each regex when several patterns are in play", () => {
    const out = run("a.ts\na.log", { pattern: "*\n!*.log" });
    expect(out["Regex"]).toBe(
      "include * -> ^(?!\\.)[^/]*$\nexclude !*.log -> ^(?!\\.)[^/]*\\.log$",
    );
    expect(out["Summary"]).toBe("1 of 2 paths match");
  });

  it("notes the i flag in the regex row when case is ignored", () => {
    const out = run("a.ts", { pattern: "*.TS", caseSensitive: false });
    expect(out["Regex"]).toBe("^(?!\\.)[^/]*\\.TS$\n(compiled with the i flag)");
  });

  it("rejects an empty path list", () => {
    expect(code(() => run("", { pattern: "*" }))).toBe("empty-input");
    expect(code(() => run("   \n\n", { pattern: "*" }))).toBe("empty-input");
  });

  it("rejects an empty pattern", () => {
    expect(code(() => run("a.ts", { pattern: "" }))).toBe("empty-pattern");
    expect(code(() => run("a.ts", { pattern: "   " }))).toBe("empty-pattern");
    expect(code(() => run("a.ts", { pattern: "!" }))).toBe("empty-pattern");
  });

  it("rejects an unterminated character class", () => {
    expect(code(() => run("a.ts", { pattern: "src/[abc" }))).toBe("unterminated-class");
    expect(code(() => run("a.ts", { pattern: "[]" }))).toBe("unterminated-class");
  });

  it("rejects a brace group that lists alternatives but never closes", () => {
    expect(code(() => run("a.ts", { pattern: "src/{ts,tsx" }))).toBe("unterminated-brace");
    expect(code(() => run("a.ts", { pattern: "src/{ts" }))).toBe("no-throw");
  });

  it("rejects a trailing lone backslash", () => {
    expect(code(() => run("a.ts", { pattern: "src/a\\" }))).toBe("trailing-backslash");
  });

  it("rejects more paths than it will process", () => {
    const many = Array.from({ length: 20001 }, (_, i) => `file${i}.ts`).join("\n");
    expect(code(() => run(many, { pattern: "*.ts" }))).toBe("too-many-paths");
  });

  it("rejects a brace expansion that would blow up", () => {
    expect(code(() => run("a.ts", { pattern: "{a,b}".repeat(14) }))).toBe("brace-explosion");
  });

  it("throws a ToolError instance, not a bare string", () => {
    expect(() => run("a.ts", { pattern: "" })).toThrow(ToolError);
  });
});
