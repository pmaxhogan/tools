import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  applyReplacement,
  buildRegex,
  captureGroupNames,
  describeFlags,
  explainPattern,
  findMatches,
  MAX_MATCHES,
  MAX_TEST_TEXT,
  run,
} from "./index";

/** Join an explanation into one searchable string. */
function explainText(pattern: string): string {
  return explainPattern(pattern)
    .map((t) => `${t.source} ${t.description}`)
    .join("\n");
}

describe("buildRegex", () => {
  it("builds a regex from a pattern and flags", () => {
    const re = buildRegex("\\d+", "gi");
    expect(re.source).toBe("\\d+");
    expect(re.flags).toBe("gi");
  });

  it("rejects an empty pattern", () => {
    expect(() => buildRegex("", "g")).toThrow(ToolError);
    try {
      buildRegex("", "g");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-pattern");
      expect((e as ToolError).fix).toContain("Type a pattern");
    }
  });

  it("rejects an unknown flag letter", () => {
    try {
      buildRegex("a", "gx");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-flags");
      expect((e as ToolError).message).toContain('"x"');
    }
  });

  it("rejects a repeated flag", () => {
    try {
      buildRegex("a", "gg");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-flags");
      expect((e as ToolError).message).toContain("twice");
    }
  });

  it("rejects u and v together", () => {
    try {
      buildRegex("a", "uv");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-flags");
      expect((e as ToolError).message).toContain("cannot be used together");
    }
  });

  it("turns a syntax error into an actionable ToolError", () => {
    try {
      buildRegex("(unclosed", "g");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-pattern");
      expect((e as ToolError).fix).toContain("unclosed bracket");
    }
  });
});

describe("captureGroupNames", () => {
  it("numbers plain groups and records named ones in order", () => {
    expect(captureGroupNames("(\\w+)-(?<year>\\d{4})")).toEqual([null, "year"]);
  });

  it("skips non-capturing groups and lookarounds", () => {
    expect(captureGroupNames("(?:a)(?=b)(?<!c)(d)")).toEqual([null]);
  });

  it("ignores a parenthesis inside a character class or escape", () => {
    expect(captureGroupNames("[(]\\((x)")).toEqual([null]);
  });
});

describe("findMatches", () => {
  it("finds every match with offsets and capture groups", () => {
    const set = findMatches(buildRegex("(\\w+)@(\\w+)", "g"), "ann@one and bob@two");
    expect(set.matches).toHaveLength(2);
    expect(set.matches[0]!.value).toBe("ann@one");
    expect(set.matches[0]!.start).toBe(0);
    expect(set.matches[0]!.end).toBe(7);
    expect(set.matches[1]!.start).toBe(12);
    expect(set.matches[1]!.groups.map((g) => g.value)).toEqual(["bob", "two"]);
  });

  it("labels named groups by name and numbered groups by number", () => {
    const set = findMatches(buildRegex("(?<user>\\w+)@(\\w+)", "g"), "ann@one");
    expect(set.matches[0]!.groups[0]).toEqual({ number: 1, name: "user", value: "ann" });
    expect(set.matches[0]!.groups[1]).toEqual({ number: 2, name: null, value: "one" });
  });

  it("reports an optional group that did not participate as undefined", () => {
    const set = findMatches(buildRegex("a(b)?c", "g"), "ac");
    expect(set.matches[0]!.groups[0]!.value).toBeUndefined();
  });

  it("stops after the first match without the g flag", () => {
    const set = findMatches(buildRegex("\\d", ""), "1 2 3");
    expect(set.matches).toHaveLength(1);
    expect(set.repeats).toBe(false);
  });

  it("does not hang on a pattern that matches the empty string", () => {
    const set = findMatches(buildRegex("a*", "g"), "aab");
    expect(set.matches.map((m) => m.value)).toEqual(["aa", "", ""]);
  });

  it("returns no matches rather than throwing when nothing matches", () => {
    const set = findMatches(buildRegex("zzz", "g"), "abc");
    expect(set.matches).toEqual([]);
    expect(set.truncated).toBe(false);
  });

  it("stops at the match cap and flags the result as truncated", () => {
    const set = findMatches(buildRegex("a", "g"), "a".repeat(MAX_MATCHES + 10));
    expect(set.matches).toHaveLength(MAX_MATCHES);
    expect(set.truncated).toBe(true);
  });

  it("refuses a test text over the size cap", () => {
    try {
      findMatches(buildRegex("a", "g"), "a".repeat(MAX_TEST_TEXT + 1));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("input-too-large");
    }
  });
});

describe("applyReplacement", () => {
  it("expands numbered groups", () => {
    const out = applyReplacement(buildRegex("(\\w+) (\\w+)", "g"), "john smith", "$2, $1");
    expect(out).toBe("smith, john");
  });

  it("expands named groups", () => {
    const re = buildRegex("(?<y>\\d{4})-(?<m>\\d{2})", "g");
    expect(applyReplacement(re, "2026-08", "$<m>/$<y>")).toBe("08/2026");
  });

  it("replaces only the first match without the g flag", () => {
    expect(applyReplacement(buildRegex("a", ""), "aaa", "b")).toBe("baa");
  });

  it("supports the whole match token and a literal dollar sign", () => {
    expect(applyReplacement(buildRegex("\\d+", "g"), "cost 40", "$$$&")).toBe("cost $40");
  });
});

describe("explainPattern", () => {
  it("names anchors, classes and quantifiers in plain English", () => {
    const text = explainText("^\\d{2,4}$");
    expect(text).toContain("Start of the text");
    expect(text).toContain("any digit");
    expect(text).toContain("2 to 4 times");
    expect(text).toContain("End of the text");
  });

  it("describes a named group, a lookahead and alternation", () => {
    const text = explainText("(?<word>ab|cd)(?=x)");
    expect(text).toContain('named "word"');
    expect(text).toContain("Or: either");
    expect(text).toContain("lookahead");
  });

  it("describes negative lookbehind and non-capturing groups", () => {
    const text = explainText("(?<!a)(?:bc)");
    expect(text).toContain("negative lookbehind");
    expect(text).toContain("captures nothing");
  });

  it("reads a character class as a range list and honors negation", () => {
    expect(explainText("[a-z0-9_]")).toContain('any character from "a" to "z"');
    expect(explainText("[^abc]")).toContain("NOT");
  });

  it("binds a quantifier to the last character of a literal run", () => {
    const tokens = explainPattern("abc+");
    expect(tokens.map((t) => t.source)).toEqual(["ab", "c", "+"]);
    expect(tokens[2]!.description).toContain("one or more times");
  });

  it("marks a lazy quantifier as lazy", () => {
    expect(explainText(".*?")).toContain("lazy");
  });

  it("indents the body of a group", () => {
    const tokens = explainPattern("a(b)c");
    const inner = tokens.find((t) => t.source === "b");
    expect(inner!.depth).toBe(1);
    expect(tokens[0]!.depth).toBe(0);
  });

  it("explains backreferences by number and by name", () => {
    expect(explainText("(a)\\1")).toContain("capture group 1 matched");
    expect(explainText("(?<x>a)\\k<x>")).toContain('group named "x"');
  });

  it("never throws on an unfinished pattern", () => {
    expect(() => explainPattern("(?<name>[a-z")).not.toThrow();
    expect(() => explainPattern("\\")).not.toThrow();
    expect(explainPattern("")).toEqual([]);
  });
});

describe("describeFlags", () => {
  it("spells out each flag", () => {
    expect(describeFlags("gi")).toContain("find every match");
    expect(describeFlags("gi")).toContain("ignore case");
  });

  it("says none for no flags", () => {
    expect(describeFlags("")).toBe("none");
  });
});

describe("run", () => {
  it("reports matches, groups and the explanation", () => {
    const out = run("ann@one and bob@two", { pattern: "(?<user>\\w+)@(\\w+)", flags: "g" });
    expect(out.Pattern).toBe("/(?<user>\\w+)@(\\w+)/g");
    expect(out.Matches).toBe("2 matches");
    expect(out["Match list"]).toContain('1. [0-7] "ann@one"');
    expect(out["Match list"]).toContain('user="ann"');
    expect(out.Explanation).toContain("any word character");
  });

  it("says No matches instead of listing an empty table", () => {
    const out = run("abc", { pattern: "\\d+", flags: "g" });
    expect(out.Matches).toBe("No matches");
    expect(out["Match list"]).toBeUndefined();
  });

  it("adds the replace preview only when a replacement is given", () => {
    const plain = run("a1", { pattern: "\\d", flags: "g" });
    expect(plain["Replace preview"]).toBeUndefined();
    const replaced = run("a1", { pattern: "(\\d)", flags: "g", replacement: "[$1]" });
    expect(replaced["Replace preview"]).toBe("a[1]");
  });

  it("escapes control characters in the match list so a row stays on one line", () => {
    const out = run("a\nb", { pattern: "\\n", flags: "g" });
    expect(out["Match list"]).toContain('"\\n"');
  });

  it("defaults to the g flag when none is given", () => {
    const out = run("aaa", { pattern: "a" });
    expect(out.Matches).toBe("3 matches");
  });

  it("throws on empty test text", () => {
    try {
      run("", { pattern: "a", flags: "g" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws on an empty pattern before it looks at the text", () => {
    try {
      run("some text", { pattern: "", flags: "g" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-pattern");
    }
  });
});
