import { describe, expect, it } from "vitest";
import { CVD_KINDS, MATRICES, parseColor, run, simulateRgb, toHex } from "./index";
import { ToolError } from "../types";

const ALL = { kind: "all", contrast: true };

describe("color-blindness-simulator", () => {
  it("simulates pure red under protanopia with the Machado matrix pipeline", () => {
    // linear (1,0,0) through the severity 1.0 protanomaly matrix, re-encoded to sRGB.
    expect(toHex(simulateRgb([255, 0, 0], "protanopia"))).toBe("#6d5f00");

    const out = run("#FF0000", { kind: "protanopia", contrast: false });
    expect(out["Color 1 (#ff0000)"]).toBe("#ff0000 -> #6d5f00");
  });

  it("leaves a mid gray unchanged under every deficiency", () => {
    for (const kind of CVD_KINDS) {
      const [r, g, b] = simulateRgb([128, 128, 128], kind);
      expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
      expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    }
  });

  it("maps red to the Rec. 709 luminance gray under achromatopsia", () => {
    // Rec. 709 luminance of linear red is 0.2126; encoded to sRGB that is 127.
    const encode = (v: number) => Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
    const expected = encode(0.2126);
    expect(expected).toBe(127);
    expect(simulateRgb([255, 0, 0], "achromatopsia")).toEqual([expected, expected, expected]);
    expect(toHex(simulateRgb([255, 0, 0], "achromatopsia"))).toBe("#7f7f7f");
  });

  it("keeps the achromatopsia matrix on Rec. 709 weights", () => {
    expect(MATRICES.achromatopsia[0]).toEqual([0.2126, 0.7152, 0.0722]);
    expect(MATRICES.achromatopsia[0]).toEqual(MATRICES.achromatopsia[2]);
  });

  it("parses hex short, hex long, bare hex and rgb() forms", () => {
    expect(parseColor("#f00")).toEqual([255, 0, 0]);
    expect(parseColor("#1D4ED8")).toEqual([29, 78, 216]);
    expect(parseColor("1d4ed8")).toEqual([29, 78, 216]);
    expect(parseColor("rgb(29, 78, 216)")).toEqual([29, 78, 216]);
    expect(parseColor("rgba(29 78 216 / 0.5)")).toEqual([29, 78, 216]);
  });

  it("emits one row per color listing every deficiency for kind=all", () => {
    const out = run("#ff0000\n#00ff00", ALL);
    const row = out["Color 1 (#ff0000)"];
    const parts = row.split(" | ");
    expect(parts).toHaveLength(CVD_KINDS.length);
    expect(parts[0]).toBe("protanopia #6d5f00");
    expect(parts[parts.length - 1]).toBe("achromatopsia #7f7f7f");
    for (const part of parts) expect(part).toMatch(/^[a-z]+ #[0-9a-f]{6}$/);
    expect(out["Summary"]).toMatch(/2 colors simulated as all seven deficiencies/);
  });

  it("splits colors on newlines, commas and spaces", () => {
    const out = run("#f00, #0f0 #00f", { kind: "deuteranopia", contrast: false });
    expect(Object.keys(out)).toContain("Color 3 (#0000ff)");
    expect(out["Color 3 (#0000ff)"]).toBe("#0000ff -> #003dfb");
  });

  it("flags an adjacent pair that collapses under a deficiency", () => {
    const out = run("#d62728\n#2ca02c", { kind: "deuteranopia", contrast: true });
    const pair = out["Pair 1 and 2 (#d62728, #2ca02c)"];
    expect(pair).toContain("original contrast");
    expect(pair).toContain("deuteranopia contrast");
    expect(pair).toContain("hard to tell apart");
    expect(out["Warnings"]).toContain("pair 1 and 2 under deuteranopia");
  });

  it("reports no warnings for a pair that stays distinguishable", () => {
    const out = run("#000000\n#ffffff", { kind: "protanopia", contrast: true });
    expect(out["Warnings"]).toMatch(/^None\./);
    expect(out["Pair 1 and 2 (#000000, #ffffff)"]).toContain("original contrast 21.00:1");
  });

  it("omits contrast rows when the option is off", () => {
    const out = run("#ff0000\n#00ff00", { kind: "all", contrast: false });
    expect(out["Warnings"]).toBeUndefined();
    expect(Object.keys(out).filter((k) => k.startsWith("Pair "))).toHaveLength(0);
  });

  it("explains that pair contrast needs two colors", () => {
    const out = run("#ff0000", ALL);
    expect(out["Contrast check"]).toBe("Add a second color to compare adjacent pairs.");
  });

  it("throws empty-input for blank input", () => {
    expect(() => run("   \n  ", ALL)).toThrowError(ToolError);
    try {
      run("", ALL);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/one color per line/);
    }
  });

  it("throws bad-color naming the offending token", () => {
    expect(() => run("#ff0000\nnotacolour", ALL)).toThrowError(ToolError);
    try {
      run("#ff0000\nnotacolour", ALL);
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-color");
      expect((e as ToolError).message).toContain("notacolour");
      expect((e as ToolError).fix).toMatch(/#rrggbb/);
    }
  });

  it("throws bad-color for an rgb() call with too few channels", () => {
    expect(() => parseColor("rgb(1, 2)")).toThrowError(/Could not read/);
  });

  it("throws bad-kind for an unknown deficiency", () => {
    try {
      run("#ff0000", { kind: "tetranopia", contrast: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-kind");
      expect((e as ToolError).fix).toContain("protanopia");
    }
  });
});
