import { describe, expect, it } from "vitest";
import {
  analyzePair,
  apcaGuidance,
  apcaLc,
  compositeOver,
  contrastRatio,
  formatHex,
  parseColor,
  readPair,
  relativeLuminance,
  run,
  suggestForeground,
  thresholdRatio,
  wcagChecks,
} from "./index";
import { ToolError } from "../types";

const WHITE = parseColor("#ffffff");
const BLACK = parseColor("#000000");

function vec(hex: string): [number, number, number] {
  const c = parseColor(hex);
  return [c.r, c.g, c.b];
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

describe("parseColor", () => {
  it("reads every syntax the tool advertises", () => {
    expect(formatHex(parseColor("#f00"))).toBe("#ff0000");
    expect(formatHex(parseColor("rgb(255 0 0)"))).toBe("#ff0000");
    expect(formatHex(parseColor("rgba(255, 0, 0, 1)"))).toBe("#ff0000");
    expect(formatHex(parseColor("hsl(0 100% 50%)"))).toBe("#ff0000");
    expect(formatHex(parseColor("rebeccapurple"))).toBe("#663399");
  });

  it("gamut maps an oklch color that sits outside sRGB", () => {
    const wild = parseColor("oklch(0.7 0.4 150)");
    expect(wild.clipped).toBe(true);
    expect(wild.mappedChroma).toBeLessThan(wild.requestedChroma ?? 1);
  });

  it("throws a ToolError on a color it cannot read", () => {
    expect(() => parseColor("not-a-color")).toThrow(ToolError);
    expect(() => parseColor("")).toThrow(/Enter a color/);
  });
});

/* ------------------------------------------------------------------ */
/* WCAG                                                                */
/* ------------------------------------------------------------------ */

describe("relativeLuminance", () => {
  it("anchors at the ends of the range", () => {
    expect(relativeLuminance([1, 1, 1])).toBeCloseTo(1, 10);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 10);
  });
});

describe("contrastRatio", () => {
  it("is 21 for black against white and 1 for a color against itself", () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 10);
    expect(contrastRatio(vec("#5b4bd6"), vec("#5b4bd6"))).toBeCloseTo(1, 10);
  });

  it("does not care which argument is the text", () => {
    expect(contrastRatio(vec("#333333"), vec("#ffffff"))).toBeCloseTo(
      contrastRatio(vec("#ffffff"), vec("#333333")),
      12,
    );
  });
});

describe("wcagChecks", () => {
  it("passes everything at 21:1 and nothing at 1:1", () => {
    expect(wcagChecks(21).every((c) => c.pass)).toBe(true);
    expect(wcagChecks(1).some((c) => c.pass)).toBe(false);
  });

  it("splits exactly on the threshold", () => {
    const byId = Object.fromEntries(wcagChecks(4.5).map((c) => [c.id, c.pass]));
    expect(byId["aa-normal"]).toBe(true);
    expect(byId["aa-large"]).toBe(true);
    expect(byId["aaa-normal"]).toBe(false);
    expect(byId["aaa-large"]).toBe(true);
  });
});

describe("thresholdRatio", () => {
  it("reads a named threshold and falls back to AA normal", () => {
    expect(thresholdRatio("aaa-normal")).toBe(7);
    expect(thresholdRatio("nonsense")).toBe(4.5);
  });
});

/* ------------------------------------------------------------------ */
/* APCA                                                                */
/* ------------------------------------------------------------------ */

describe("apcaLc", () => {
  it("reproduces the two published anchors", () => {
    expect(apcaLc([0, 0, 0], [1, 1, 1])).toBeCloseTo(106.04, 2);
    expect(apcaLc([1, 1, 1], [0, 0, 0])).toBeCloseTo(-107.88, 2);
  });

  it("signs the value by polarity, so it is not symmetric", () => {
    const dark = apcaLc(vec("#111111"), vec("#eeeeee"));
    const light = apcaLc(vec("#eeeeee"), vec("#111111"));
    expect(dark).toBeGreaterThan(0);
    expect(light).toBeLessThan(0);
    expect(Math.abs(dark)).not.toBeCloseTo(Math.abs(light), 1);
  });

  it("is zero when the two colors are the same", () => {
    expect(apcaLc(vec("#5b4bd6"), vec("#5b4bd6"))).toBe(0);
  });
});

describe("apcaGuidance", () => {
  it("reads the level off the magnitude, whichever polarity it is", () => {
    expect(apcaGuidance(95)).toMatch(/Preferred for body text/);
    expect(apcaGuidance(-95)).toMatch(/Preferred for body text/);
    expect(apcaGuidance(31)).toMatch(/floor for any readable text/);
    expect(apcaGuidance(4)).toMatch(/invisible in practice/);
  });
});

/* ------------------------------------------------------------------ */
/* alpha                                                               */
/* ------------------------------------------------------------------ */

describe("compositeOver", () => {
  it("blends by alpha and leaves an opaque color alone", () => {
    const half = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
    expect(half.r).toBeCloseTo(0.5, 10);
    expect(half.a).toBe(1);
    expect(compositeOver(BLACK, WHITE).r).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* suggestions                                                         */
/* ------------------------------------------------------------------ */

describe("suggestForeground", () => {
  it("returns null when the pair already passes", () => {
    expect(suggestForeground(BLACK, WHITE, 4.5)).toBeNull();
  });

  it("finds a darker foreground that really passes once rounded to hex", () => {
    const s = suggestForeground(parseColor("#777777"), WHITE, 4.5);
    expect(s).not.toBeNull();
    expect(s?.direction).toBe("darker");
    // The suggestion must survive being written as a hex color, which is the
    // whole point of searching on the rounded value.
    expect(contrastRatio(vec(s?.hex ?? "#000"), [1, 1, 1])).toBeGreaterThanOrEqual(4.5);
  });

  it("goes lighter when the background is dark", () => {
    const s = suggestForeground(parseColor("#555555"), parseColor("#333333"), 4.5);
    expect(s?.direction).toBe("lighter");
    expect(contrastRatio(vec(s?.hex ?? "#000"), vec("#333333"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the hue of a brand color while darkening it", () => {
    const s = suggestForeground(parseColor("#5b4bd6"), WHITE, 7);
    expect(s?.hex).toBe("#5341cc");
    expect(s?.ratio).toBeGreaterThanOrEqual(7);
  });

  it("returns null when no lightness can reach the target", () => {
    // A mid gray background tops out around 5.3:1 against black.
    expect(suggestForeground(parseColor("#808080"), parseColor("#808080"), 7)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* analyzePair                                                         */
/* ------------------------------------------------------------------ */

describe("analyzePair", () => {
  it("flattens alpha before measuring and says so", () => {
    const report = analyzePair(parseColor("rgb(0 0 0 / 50%)"), WHITE);
    expect(report.composited).toBe(true);
    expect(formatHex(report.effectiveForeground)).toBe("#808080");
  });

  it("aims the suggestion at the requested threshold", () => {
    const aa = analyzePair(parseColor("#5b4bd6"), WHITE, "aa-normal");
    const aaa = analyzePair(parseColor("#5b4bd6"), WHITE, "aaa-normal");
    expect(aa.suggestion).toBeNull();
    expect(aaa.suggestion?.ratio).toBeGreaterThanOrEqual(7);
  });
});

/* ------------------------------------------------------------------ */
/* readPair and run                                                    */
/* ------------------------------------------------------------------ */

describe("readPair", () => {
  it('splits on "on", on a comma, and on a newline', () => {
    expect(readPair("#333 on #fff", {})).toEqual({ foreground: "#333", background: "#fff" });
    expect(readPair("#333, #fff", {})).toEqual({ foreground: "#333", background: "#fff" });
    expect(readPair("#333\n#fff", {})).toEqual({ foreground: "#333", background: "#fff" });
  });

  it("keeps a function call intact while splitting", () => {
    expect(readPair("rgb(255, 0, 0) on white", {}).foreground).toBe("rgb(255, 0, 0)");
  });

  it("falls back to the option boxes", () => {
    expect(readPair("", { foreground: "#111", background: "#eee" })).toEqual({
      foreground: "#111",
      background: "#eee",
    });
  });

  it("throws when only one color is given", () => {
    expect(() => readPair("#333", {})).toThrow(ToolError);
    expect(() => readPair("", {})).toThrow(/needs two colors/);
  });
});

describe("run", () => {
  it("reports the ratio, every level, and the APCA value", () => {
    const out = run("#333333 on #ffffff", {});
    expect(out["Contrast ratio"]).toBe("12.63:1");
    expect(out["AA normal text"]).toMatch(/^Pass/);
    expect(out["AAA normal text"]).toMatch(/^Pass/);
    expect(out["APCA Lc"]).toMatch(/dark text on a light surface/);
  });

  it("reports the reverse polarity for light text on a dark surface", () => {
    expect(run("#ffffff on #111111", {})["APCA Lc"]).toMatch(/light text on a dark surface/);
  });

  it("suggests a passing foreground when the pair fails", () => {
    const out = run("skyblue on white", {});
    expect(out["Nearest passing foreground for AA normal text"]).toContain("4.5");
    expect(out["Suggested foreground in OKLCH"]).toMatch(/^oklch\(/);
  });

  it("says so plainly when nothing needs to change", () => {
    expect(run("#000 on #fff", {})["Meets AA normal text"]).toBe("Yes, no change needed.");
  });

  it("notes when a translucent color had to be flattened", () => {
    expect(run("rgb(0 0 0 / 40%) on white", {})["Alpha"]).toMatch(/flattened before measuring/);
  });

  it("takes the pair from the options when the input is empty", () => {
    const out = run("", { foreground: "black", background: "white" });
    expect(out["Contrast ratio"]).toBe("21.00:1");
  });

  it("throws on a color it cannot read", () => {
    expect(() => run("blurple on white", {})).toThrow(ToolError);
    expect(() => run("blurple on white", {})).toThrow(/Could not read/);
  });

  it("throws when the pair is incomplete", () => {
    expect(() => run("", {})).toThrow(/needs two colors/);
  });
});
