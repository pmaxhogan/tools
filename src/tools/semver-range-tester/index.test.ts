import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { run, type SemverRangeTesterOpts } from "./index";

/** The normalized comparator sets for a range, which is the row users read first. */
function parsed(range: string, opts: SemverRangeTesterOpts = {}): string {
  return run("1.0.0", { range, ...opts })["Parsed range"];
}

/** Does one version satisfy one range? */
function ok(version: string, range: string, opts: SemverRangeTesterOpts = {}): boolean {
  return run(version, { range, ...opts })["Satisfies"].startsWith("1 of 1");
}

describe("semver-range-tester", () => {
  it("reports satisfying and failing versions with counts", () => {
    const out = run("1.2.3\n1.9.9\n2.0.0", { range: "^1.2.3" });

    expect(out["Range"]).toBe("^1.2.3");
    expect(out["Parsed range"]).toBe(">=1.2.3 <2.0.0-0");
    expect(out["In plain English"]).toBe("1.2.3 or newer, but below 2.0.0");
    expect(out["Satisfies"]).toBe("2 of 3\n1.2.3\n1.9.9");
    expect(out["Does not satisfy"]).toBe("1 of 3\n2.0.0");
    expect(out["Max satisfying"]).toBe("1.9.9");
    expect(out["Min satisfying"]).toBe("1.2.3");
  });

  it("says (none) when nothing satisfies", () => {
    const out = run("1.0.0\n1.5.0", { range: "^5" });

    expect(out["Satisfies"]).toBe("0 of 2\n(none)");
    expect(out["Max satisfying"]).toBe("(none)");
    expect(out["Min satisfying"]).toBe("(none)");
  });

  it("accepts a leading v or = on a version", () => {
    expect(ok("v1.2.3", "1.2.3")).toBe(true);
    expect(ok("=1.2.3", "1.2.3")).toBe(true);
  });

  describe("caret ranges", () => {
    it("keeps the leftmost non zero field for a 1.x version", () => {
      expect(parsed("^1.2.3")).toBe(">=1.2.3 <2.0.0-0");
      expect(ok("1.9.9", "^1.2.3")).toBe(true);
      expect(ok("2.0.0", "^1.2.3")).toBe(false);
      expect(ok("1.2.2", "^1.2.3")).toBe(false);
    });

    it("locks a 0.2.3 version to its minor", () => {
      expect(parsed("^0.2.3")).toBe(">=0.2.3 <0.3.0-0");
      expect(ok("0.2.9", "^0.2.3")).toBe(true);
      expect(ok("0.3.0", "^0.2.3")).toBe(false);
    });

    it("locks a 0.0.3 version to that exact patch", () => {
      expect(parsed("^0.0.3")).toBe(">=0.0.3 <0.0.4-0");
      expect(ok("0.0.3", "^0.0.3")).toBe(true);
      expect(ok("0.0.4", "^0.0.3")).toBe(false);
    });

    it("handles partial caret forms", () => {
      expect(parsed("^1.2")).toBe(">=1.2.0 <2.0.0-0");
      expect(parsed("^1")).toBe(">=1.0.0 <2.0.0-0");
      expect(parsed("^0")).toBe(">=0.0.0 <1.0.0-0");
      expect(parsed("^0.0")).toBe(">=0.0.0 <0.1.0-0");
      expect(parsed("^1.2.x")).toBe(">=1.2.0 <2.0.0-0");
      expect(parsed("^0.0.x")).toBe(">=0.0.0 <0.1.0-0");
      expect(parsed("^*")).toBe("*");
    });

    it("keeps a prerelease floor on a caret range", () => {
      expect(parsed("^1.2.3-beta.2")).toBe(">=1.2.3-beta.2 <2.0.0-0");
      expect(parsed("^0.0.3-beta")).toBe(">=0.0.3-beta <0.0.4-0");
      expect(ok("1.2.3-beta.4", "^1.2.3-beta.2")).toBe(true);
      expect(ok("1.2.3-beta.1", "^1.2.3-beta.2")).toBe(false);
    });
  });

  describe("tilde ranges", () => {
    it("allows patch level changes when a minor is given", () => {
      expect(parsed("~1.2.3")).toBe(">=1.2.3 <1.3.0-0");
      expect(parsed("~1.2")).toBe(">=1.2.0 <1.3.0-0");
      expect(parsed("~0.2.3")).toBe(">=0.2.3 <0.3.0-0");
      expect(ok("1.2.9", "~1.2.3")).toBe(true);
      expect(ok("1.3.0", "~1.2.3")).toBe(false);
    });

    it("allows minor level changes when only a major is given", () => {
      expect(parsed("~1")).toBe(">=1.0.0 <2.0.0-0");
      expect(ok("1.9.0", "~1")).toBe(true);
      expect(ok("2.0.0", "~1")).toBe(false);
    });
  });

  describe("x-ranges", () => {
    it("expands x, X, and star the same way", () => {
      expect(parsed("1.x")).toBe(">=1.0.0 <2.0.0-0");
      expect(parsed("1.X")).toBe(">=1.0.0 <2.0.0-0");
      expect(parsed("1.*")).toBe(">=1.0.0 <2.0.0-0");
      expect(parsed("1.2.x")).toBe(">=1.2.0 <1.3.0-0");
    });

    it("treats a lone star as any version", () => {
      expect(parsed("*")).toBe("*");
      expect(run("1.0.0", { range: "*" })["In plain English"]).toBe("any version");
      expect(ok("0.0.1", "*")).toBe(true);
      expect(ok("99.9.9", "*")).toBe(true);
    });

    it("treats an empty comparator set between pipes as any version", () => {
      expect(parsed(">=2.0.0 ||")).toBe(">=2.0.0 || *");
      expect(ok("1.0.0", ">=2.0.0 ||")).toBe(true);
    });

    it("promotes an operator applied to a partial version", () => {
      expect(parsed(">=1.2.x")).toBe(">=1.2.0");
      expect(parsed(">1.2.x")).toBe(">=1.3.0");
      expect(parsed(">1.x")).toBe(">=2.0.0");
      expect(parsed("<=1.2.x")).toBe("<1.3.0-0");
      expect(parsed("<1.x")).toBe("<1.0.0-0");
    });

    it("normalizes a bare version into an equality comparator", () => {
      expect(parsed("1.2.3")).toBe("=1.2.3");
      expect(parsed("=1.2.3")).toBe("=1.2.3");
      expect(parsed("v1.2.3")).toBe("=1.2.3");
      expect(run("1.2.3", { range: "1.2.3" })["In plain English"]).toBe("exactly 1.2.3");
    });

    it("drops a redundant star that sits beside a real comparator", () => {
      expect(parsed("* >=1.2.3")).toBe(">=1.2.3");
    });
  });

  describe("hyphen ranges", () => {
    it("builds an inclusive span from two full versions", () => {
      expect(parsed("1.2.3 - 2.3.4")).toBe(">=1.2.3 <=2.3.4");
      expect(ok("2.3.4", "1.2.3 - 2.3.4")).toBe(true);
      expect(ok("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
      expect(ok("1.2.2", "1.2.3 - 2.3.4")).toBe(false);
    });

    it("zero fills a partial lower bound", () => {
      expect(parsed("1.2 - 2.3.4")).toBe(">=1.2.0 <=2.3.4");
      expect(ok("1.2.0", "1.2 - 2.3.4")).toBe(true);
    });

    it("rounds a partial upper bound up to the next field", () => {
      expect(parsed("1.2.3 - 2.3")).toBe(">=1.2.3 <2.4.0-0");
      expect(parsed("1.2.3 - 2")).toBe(">=1.2.3 <3.0.0-0");
      expect(ok("2.3.9", "1.2.3 - 2.3")).toBe(true);
      expect(ok("2.4.0", "1.2.3 - 2.3")).toBe(false);
      expect(ok("2.4.0-alpha", "1.2.3 - 2.3")).toBe(false);
    });
  });

  describe("comparator sets", () => {
    it("joins whitespace separated comparators with AND", () => {
      expect(parsed(">=1.2.7 <1.3.0")).toBe(">=1.2.7 <1.3.0");
      expect(ok("1.2.7", ">=1.2.7 <1.3.0")).toBe(true);
      expect(ok("1.2.99", ">=1.2.7 <1.3.0")).toBe(true);
      expect(ok("1.3.0", ">=1.2.7 <1.3.0")).toBe(false);
      expect(ok("1.2.6", ">=1.2.7 <1.3.0")).toBe(false);
    });

    it("tolerates a space between an operator and its version", () => {
      expect(parsed(">= 1.2.7 < 1.3.0")).toBe(">=1.2.7 <1.3.0");
    });

    it("joins pipe separated sets with OR", () => {
      expect(parsed("^1.2.3 || >=2 <3")).toBe(">=1.2.3 <2.0.0-0 || >=2.0.0 <3.0.0-0");
      expect(ok("1.5.0", "^1.2.3 || >=2 <3")).toBe(true);
      expect(ok("2.5.0", "^1.2.3 || >=2 <3")).toBe(true);
      expect(ok("3.0.0", "^1.2.3 || >=2 <3")).toBe(false);
    });

    it("writes each OR'd set out in plain English", () => {
      expect(run("1.0.0", { range: "^1.2.3 || >=2 <3" })["In plain English"]).toBe(
        "1.2.3 or newer, but below 2.0.0; or 2.0.0 or newer, but below 3.0.0",
      );
      expect(run("1.0.0", { range: ">1.0.0" })["In plain English"]).toBe("newer than 1.0.0");
      expect(run("1.0.0", { range: "<=1.0.0" })["In plain English"]).toBe("1.0.0 or older");
    });
  });

  describe("precedence", () => {
    it("sorts prereleases in the order the spec defines", () => {
      const input = [
        "1.0.0",
        "1.0.0-rc.1",
        "1.0.0-beta.11",
        "1.0.0-beta.2",
        "1.0.0-beta",
        "1.0.0-alpha.beta",
        "1.0.0-alpha.1",
        "1.0.0-alpha",
      ].join("\n");

      expect(run(input, { range: "*" })["Sorted"].split("\n")).toEqual([
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
      ]);
    });

    it("sorts release versions by major, then minor, then patch", () => {
      const out = run("1.10.0\n1.2.0\n0.9.9\n2.0.0", { range: "*" });
      expect(out["Sorted"].split("\n")).toEqual(["0.9.9", "1.2.0", "1.10.0", "2.0.0"]);
      expect(out["Max satisfying"]).toBe("2.0.0");
      expect(out["Min satisfying"]).toBe("0.9.9");
    });

    it("ignores build metadata in precedence but keeps it in the echo", () => {
      const out = run("1.0.0+build.2\n1.0.0+build.1", { range: "1.0.0" });
      expect(out["Satisfies"]).toBe("2 of 2\n1.0.0+build.2\n1.0.0+build.1");
      expect(out["Sorted"]).toBe("1.0.0+build.2\n1.0.0+build.1");
      expect(ok("1.0.0+sha.abc", ">=1.0.0")).toBe(true);
    });
  });

  describe("the prerelease inclusion rule", () => {
    it("keeps a prerelease out of a range with no prerelease in it", () => {
      expect(ok("1.2.4-alpha", ">=1.2.3")).toBe(false);
      expect(ok("1.2.4-alpha", "^1.2.3")).toBe(false);
      expect(ok("1.0.0-alpha", "*")).toBe(false);
      expect(ok("1.0.0-alpha", "1.x")).toBe(false);
    });

    it("lets a prerelease through when a comparator pins the same three numbers", () => {
      expect(ok("1.2.3-beta", ">=1.2.3-alpha")).toBe(true);
      expect(ok("1.2.4-beta", ">=1.2.3-alpha")).toBe(false);
      expect(ok("1.2.3-rc.1", ">=1.2.3-alpha <1.3.0")).toBe(true);
      // The two ranges the page copy offers as the way to opt a prerelease in.
      expect(ok("1.2.4-alpha", ">=1.2.4-alpha")).toBe(true);
      expect(ok("1.2.4-alpha", ">=1.2.4-0")).toBe(true);
      // A prerelease bound on a different tuple does not help, however wide the span.
      expect(ok("1.2.4-alpha", ">=1.2.3 <1.2.5-0")).toBe(false);
    });

    it("applies the rule per comparator set, not across the whole range", () => {
      expect(ok("1.2.3-beta.4", "^1.2.3-beta.2 || >=2")).toBe(true);
      expect(ok("2.1.0-rc.1", "^1.2.3-beta.2 || >=2")).toBe(false);
    });

    it("drops the restriction when includePrerelease is on", () => {
      expect(ok("1.2.4-alpha", ">=1.2.3", { includePrerelease: true })).toBe(true);
      expect(ok("1.0.0-alpha", "*", { includePrerelease: true })).toBe(true);
      expect(ok("1.0.0-alpha", "1.x", { includePrerelease: true })).toBe(true);
      expect(ok("1.2.0-alpha", "^1.2", { includePrerelease: true })).toBe(true);
      expect(parsed("1.x", { includePrerelease: true })).toBe(">=1.0.0-0 <2.0.0-0");
    });

    it("reads includePrerelease as a string from a shared link", () => {
      expect(ok("1.2.4-alpha", ">=1.2.3", { includePrerelease: "true" })).toBe(true);
      expect(ok("1.2.4-alpha", ">=1.2.3", { includePrerelease: "false" })).toBe(false);
      expect(ok("1.2.4-alpha", ">=1.2.3", { includePrerelease: "" })).toBe(false);
    });
  });

  describe("errors", () => {
    it("rejects a blank range", () => {
      expect(() => run("1.0.0", {})).toThrow(ToolError);
      try {
        run("1.0.0", { range: "   " });
      } catch (err) {
        expect((err as ToolError).code).toBe("empty-range");
        expect((err as ToolError).fix).toContain("*");
      }
    });

    it("rejects an empty version list", () => {
      try {
        run("   \n\n", { range: "^1.0.0" });
        throw new Error("expected a ToolError");
      } catch (err) {
        expect((err as ToolError).code).toBe("empty-input");
      }
    });

    it("names the line that is not a valid version", () => {
      try {
        run("1.0.0\n1.2\n2.0.0", { range: "*" });
        throw new Error("expected a ToolError");
      } catch (err) {
        expect((err as ToolError).code).toBe("bad-version");
        expect((err as ToolError).message).toContain('"1.2"');
      }
    });

    it("rejects leading zeros in a version", () => {
      expect(() => run("01.2.3", { range: "*" })).toThrow(ToolError);
      expect(() => run("1.0.0-01", { range: "*" })).toThrow(ToolError);
    });

    it("names the comparator it cannot parse", () => {
      try {
        run("1.0.0", { range: ">=1.2.7 <<1.3.0" });
        throw new Error("expected a ToolError");
      } catch (err) {
        expect((err as ToolError).code).toBe("bad-range");
        expect((err as ToolError).message).toContain("<<1.3.0");
      }
    });

    it("rejects a hyphen range whose bounds run backwards", () => {
      try {
        run("1.5.0", { range: "2.0.0 - 1.0.0" });
        throw new Error("expected a ToolError");
      } catch (err) {
        expect((err as ToolError).code).toBe("inverted-range");
        expect((err as ToolError).fix).toContain("1.0.0 - 2.0.0");
      }
    });

    it("caps the number of versions it will test at once", () => {
      const many = Array.from({ length: 5001 }, (_, i) => `1.0.${i}`).join("\n");
      try {
        run(many, { range: "*" });
        throw new Error("expected a ToolError");
      } catch (err) {
        expect((err as ToolError).code).toBe("too-many-versions");
        expect((err as ToolError).message).toContain("5000");
      }
    });
  });
});
