import { describe, expect, it } from "vitest";
import { run, parseDiceNotation } from "./index";
import { ToolError } from "../types";

const baseOpts = { mode: "dice", count: 1, seed: "" };

describe("random-picker / dice", () => {
  it("rolls an exact, reproducible result from a seed", () => {
    const out = run("3d6+2", { ...baseOpts, seed: "test-seed-1" });
    expect(out).toBe("Rolls: 5, 5, 2 | Modifier: +2 | Total: 14");
  });

  it("produces the same output every time for the same seed", () => {
    const a = run("2d6+3", { ...baseOpts, seed: "repeat-me" });
    const b = run("2d6+3", { ...baseOpts, seed: "repeat-me" });
    expect(a).toBe(b);
  });

  it("parses implicit single-die notation (d20)", () => {
    expect(parseDiceNotation("d20")).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it("parses NdM+K notation (2d6+3)", () => {
    expect(parseDiceNotation("2d6+3")).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it("parses negative modifiers", () => {
    expect(parseDiceNotation("4d8-1")).toEqual({ count: 4, sides: 8, modifier: -1 });
  });

  it("rejects invalid notation with a typed error", () => {
    expect(() => run("3x6", baseOpts)).toThrowError(ToolError);
    try {
      run("3x6", baseOpts);
    } catch (e) {
      expect((e as ToolError).message).toMatch(/dice notation/i);
      expect((e as ToolError).fix).toMatch(/3d6/);
    }
  });

  it("rejects empty input with a typed error", () => {
    expect(() => run("", baseOpts)).toThrowError(ToolError);
  });

  it("formats rolls, modifier, and total readably", () => {
    const out = run("3d6+2", { ...baseOpts, seed: "format-check" });
    expect(out).toMatch(/^Rolls: \d+(, \d+){2} \| Modifier: \+2 \| Total: \d+$/);
  });

  it("omits the modifier segment when there is none", () => {
    const out = run("d20", { ...baseOpts, seed: "no-modifier" });
    expect(out).toMatch(/^Rolls: \d+ \| Total: \d+$/);
  });
});

describe("random-picker / coin", () => {
  it("flips once by default", () => {
    const out = run("", { mode: "coin", count: 1, seed: "coin-seed" });
    expect(["Heads", "Tails"]).toContain(out);
  });

  it("flips N times and summarizes with a count", () => {
    const out = run("", { mode: "coin", count: 10, seed: "coin-seed-10" });
    expect(out).toMatch(/^Flips: (Heads|Tails)(, (Heads|Tails)){9} \| Heads: \d+, Tails: \d+$/);
    const headsMatch = out.match(/Heads: (\d+)/)!;
    const tailsMatch = out.match(/Tails: (\d+)/)!;
    expect(Number(headsMatch[1]) + Number(tailsMatch[1])).toBe(10);
  });

  it("ignores the input text", () => {
    const out = run("this text is irrelevant", { mode: "coin", count: 1, seed: "ignore-me" });
    expect(["Heads", "Tails"]).toContain(out);
  });
});

describe("random-picker / pick", () => {
  const list = "alice\nbob\ncharlie\ndave\neve";

  it("picks the requested number of distinct items", () => {
    const out = run(list, { mode: "pick", count: 3, seed: "pick-seed" });
    expect(out.startsWith("Picked: ")).toBe(true);
    const picked = out.replace("Picked: ", "").split(", ");
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    for (const p of picked) expect(["alice", "bob", "charlie", "dave", "eve"]).toContain(p);
  });

  it("throws when asked for more items than are available", () => {
    expect(() => run("alice\nbob", { mode: "pick", count: 5, seed: "x" })).toThrowError(ToolError);
    try {
      run("alice\nbob", { mode: "pick", count: 5, seed: "x" });
    } catch (e) {
      expect((e as ToolError).code).toBe("not-enough-items");
    }
  });

  it("throws on empty list input", () => {
    expect(() => run("", { mode: "pick", count: 1, seed: "x" })).toThrowError(ToolError);
    expect(() => run("   \n  \n", { mode: "pick", count: 1, seed: "x" })).toThrowError(ToolError);
  });
});

describe("random-picker / teams", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"].join("\n");

  it("splits 7 names into 3 teams as 3/2/2", () => {
    const out = run(names, { mode: "teams", count: 3, seed: "team-seed" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    const sizes = lines.map((l) => l.split(": ")[1]!.split(", ").length).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 2, 2]);
  });

  it("labels each team and includes every name exactly once", () => {
    const out = run(names, { mode: "teams", count: 3, seed: "label-check" });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^Team 1: /);
    expect(lines[1]).toMatch(/^Team 2: /);
    expect(lines[2]).toMatch(/^Team 3: /);
    const allNames = lines.flatMap((l) => l.split(": ")[1]!.split(", ")).sort();
    expect(allNames).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("throws when there are fewer names than teams", () => {
    expect(() => run("a\nb", { mode: "teams", count: 5, seed: "x" })).toThrowError(ToolError);
    try {
      run("a\nb", { mode: "teams", count: 5, seed: "x" });
    } catch (e) {
      expect((e as ToolError).code).toBe("not-enough-items");
    }
  });

  it("throws on empty list input", () => {
    expect(() => run("", { mode: "teams", count: 2, seed: "x" })).toThrowError(ToolError);
  });
});

describe("random-picker / bad mode", () => {
  it("throws a typed error for an unknown mode", () => {
    expect(() => run("", { mode: "nonsense", count: 1, seed: "" })).toThrowError(ToolError);
  });
});
