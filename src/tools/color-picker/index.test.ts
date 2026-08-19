import { describe, expect, it } from "vitest";
import {
  NAMED_COLORS,
  PALETTE_KINDS,
  buildPalette,
  contrastRatio,
  formatHex,
  formatOklch,
  gamutMapOklch,
  hwbToSrgb,
  nearestNamedColor,
  num,
  parseColor,
  relativeLuminance,
  run,
  splitOperands,
  srgbToHsl,
  srgbToLabD50,
  srgbToLabD65,
  srgbToOklab,
  srgbToOklch,
  wcagVerdicts,
} from "./index";
import { ToolError } from "../types";

const CONVERT = { mode: "convert", paletteKind: "all" };
const CONTRAST = { mode: "contrast", paletteKind: "all" };
const PALETTE = { mode: "palette", paletteKind: "all" };

const RED: [number, number, number] = [1, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];

describe("color-picker named colours", () => {
  it("carries all 148 CSS named colours", () => {
    expect(Object.keys(NAMED_COLORS)).toHaveLength(148);
  });

  it("pins the names most often mistyped", () => {
    expect(NAMED_COLORS.rebeccapurple).toBe("#663399");
    expect(NAMED_COLORS.cornflowerblue).toBe("#6495ed");
    expect(NAMED_COLORS.mediumspringgreen).toBe("#00fa9a");
    // The famous trap: darkgray is lighter than gray, and green is not lime.
    expect(NAMED_COLORS.darkgray).toBe("#a9a9a9");
    expect(NAMED_COLORS.gray).toBe("#808080");
    expect(NAMED_COLORS.green).toBe("#008000");
    expect(NAMED_COLORS.lime).toBe("#00ff00");
    // The grey and gray spellings are both keywords and must agree.
    expect(NAMED_COLORS.grey).toBe(NAMED_COLORS.gray);
    expect(NAMED_COLORS.darkslategrey).toBe(NAMED_COLORS.darkslategray);
  });

  it("parses a colour name and reports the format", () => {
    const c = parseColor("rebeccapurple");
    expect(formatHex(c)).toBe("#663399");
    expect(c.format).toBe("named");
    expect(nearestNamedColor([c.r, c.g, c.b])).toEqual({
      name: "rebeccapurple",
      hex: "#663399",
      deltaE: 0,
    });
  });
});

describe("color-picker conversions", () => {
  it("converts pure red to the published OKLCH reference", () => {
    const [l, c, h] = srgbToOklch(RED);
    expect(l).toBeCloseTo(0.628, 3);
    expect(c).toBeCloseTo(0.2577, 3);
    expect(h).toBeCloseTo(29.23, 2);

    const [ol, oa, ob] = srgbToOklab(RED);
    expect(ol).toBeCloseTo(0.628, 3);
    expect(oa).toBeCloseTo(0.2249, 3);
    expect(ob).toBeCloseTo(0.1258, 3);
  });

  it("puts CIE Lab on D50 for CSS lab(), and still reports the D65 numbers", () => {
    // CSS Color 4 defines lab() and lch() against D50, reached by Bradford.
    const [l50, a50, b50] = srgbToLabD50(RED);
    expect(l50).toBeCloseTo(54.29, 2);
    expect(a50).toBeCloseTo(80.8, 2);
    expect(b50).toBeCloseTo(69.89, 2);

    // The widely quoted 53.24 / 80.09 / 67.20 triple is the D65 Lab of red.
    const [l65, a65, b65] = srgbToLabD65(RED);
    expect(l65).toBeCloseTo(53.24, 2);
    expect(a65).toBeCloseTo(80.09, 2);
    expect(b65).toBeCloseTo(67.2, 2);
  });

  it("reports every syntax for red", () => {
    const out = run("#ff0000", CONVERT);
    expect(out.Hex).toBe("#ff0000");
    expect(out.RGB).toBe("rgb(255 0 0)");
    expect(out.HSL).toBe("hsl(0 100% 50%)");
    expect(out.HWB).toBe("hwb(0 0% 0%)");
    expect(out.OKLCH).toBe("oklch(0.628 0.2577 29.23)");
    expect(out.OKLab).toBe("oklab(0.628 0.2249 0.1258)");
    expect(out["Lab (D50)"]).toBe("lab(54.29 80.8 69.89)");
    expect(out["LCH (D50)"]).toBe("lch(54.29 106.84 40.86)");
    expect(out.Input).toBe("#ff0000 (read as hex)");
    expect(out["sRGB gamut"]).toBe("Inside sRGB, nothing was changed.");
    expect(srgbToHsl(RED)).toEqual([0, 100, 50]);
  });

  it("writes an achromatic hue as the CSS none keyword", () => {
    const out = run("white", CONVERT);
    expect(out.OKLCH).toBe("oklch(1 0 none)");
    expect(out["LCH (D50)"]).toBe("lch(100 0 none)");
    expect(out.OKLab).toBe("oklab(1 0 0)");
    expect(formatOklch({ r: 0.5, g: 0.5, b: 0.5, a: 1 })).toContain("none");
  });

  it("round trips every accepted syntax back to the same colour", () => {
    const forms = [
      "#663399",
      "#639",
      "663399",
      "rgb(102 51 153)",
      "rgb(102, 51, 153)",
      "rgb(40% 20% 60%)",
      "hsl(270 50% 40%)",
      "hsl(270, 50%, 40%)",
      "hsl(0.75turn 50% 40%)",
      "hwb(270 20% 40%)",
      "rebeccapurple",
      "oklch(0.44027 0.16030 303.373)",
      "oklab(0.44027 0.08818 -0.13386)",
      "lab(32.39 38.44 -47.69)",
      "lch(32.39 61.2 308.86)",
    ];
    for (const form of forms) {
      const c = parseColor(form);
      expect(formatHex(c), form).toBe("#663399");
    }
  });

  it("detects which syntax the input was written in", () => {
    expect(parseColor("#639").format).toBe("hex");
    expect(parseColor("rgb(1 2 3)").format).toBe("rgb");
    expect(parseColor("hsl(1 2% 3%)").format).toBe("hsl");
    expect(parseColor("hwb(1 2% 3%)").format).toBe("hwb");
    expect(parseColor("lab(50 10 10)").format).toBe("lab");
    expect(parseColor("lch(50 10 10)").format).toBe("lch");
    expect(parseColor("oklab(0.5 0.1 0.1)").format).toBe("oklab");
    expect(parseColor("oklch(0.5 0.1 10)").format).toBe("oklch");
    expect(parseColor("tomato").format).toBe("named");
  });

  it("reads alpha from every place CSS allows it", () => {
    const slash = parseColor("rgb(255 0 0 / 50%)");
    expect(slash.a).toBe(0.5);
    expect(formatHex(slash)).toBe("#ff000080");

    expect(parseColor("rgba(255, 0, 0, 0.5)").a).toBe(0.5);
    expect(parseColor("#ff000080").a).toBeCloseTo(0.502, 3);
    expect(parseColor("#f008").a).toBeCloseTo(0.533, 3);
    expect(parseColor("hsl(0 100% 50% / 0.25)").a).toBe(0.25);
    // Opaque colours never grow an alpha pair on the hex.
    expect(formatHex(parseColor("#ff0000"))).toBe("#ff0000");
  });

  it("handles hue units and the none keyword", () => {
    expect(formatHex(parseColor("hsl(120deg 100% 50%)"))).toBe("#00ff00");
    expect(formatHex(parseColor("hsl(0.3333333turn 100% 50%)"))).toBe("#00ff00");
    expect(formatHex(parseColor("hsl(2.0943951rad 100% 50%)"))).toBe("#00ff00");
    expect(formatHex(parseColor("hsl(133.3333grad 100% 50%)"))).toBe("#00ff00");
    expect(formatHex(parseColor("rgb(none 255 none)"))).toBe("#00ff00");
    expect(formatHex(parseColor("oklch(1 none none)"))).toBe("#ffffff");
  });

  it("collapses hwb to grey once whiteness and blackness fill the colour", () => {
    expect(hwbToSrgb([0, 60, 60])).toEqual([0.5, 0.5, 0.5]);
    expect(formatHex(parseColor("hwb(210 60% 60%)"))).toBe("#808080");
    expect(formatHex(parseColor("hwb(210 100% 0%)"))).toBe("#ffffff");
  });

  it("trims trailing zeros without eating whole numbers", () => {
    expect(num(1, 3)).toBe("1");
    expect(num(100, 2)).toBe("100");
    expect(num(0.628, 3)).toBe("0.628");
    expect(num(-0.0001, 2)).toBe("0");
    expect(num(80.8049, 2)).toBe("80.8");
  });
});

describe("color-picker gamut mapping", () => {
  it("reduces chroma until an out of gamut OKLCH fits sRGB", () => {
    const mapped = gamutMapOklch(0.9, 0.4, 150);
    expect(mapped.clipped).toBe(true);
    expect(mapped.chroma).toBeCloseTo(0.1816, 3);
    expect(mapped.chroma).toBeLessThan(0.4);

    const parsed = parseColor("oklch(0.9 0.4 150)");
    expect(parsed.clipped).toBe(true);
    expect(parsed.requestedChroma).toBeCloseTo(0.4, 6);
    expect(parsed.mappedChroma).toBeCloseTo(0.1816, 3);
    expect(formatHex(parsed)).toBe("#77ff9b");

    const out = run("oklch(0.9 0.4 150)", CONVERT);
    expect(out["sRGB gamut"]).toBe(
      "Outside sRGB. Chroma reduced from 0.4 to 0.1816 in OKLCH, holding lightness and hue.",
    );
    // Lightness and hue survive the reduction.
    expect(out.OKLCH).toBe("oklch(0.9 0.1816 150)");
  });

  it("leaves an in gamut colour untouched and reports it as such", () => {
    const mapped = gamutMapOklch(0.628, 0.2, 29.23);
    expect(mapped.clipped).toBe(false);
    expect(mapped.chroma).toBe(0.2);
    expect(parseColor("#00ff00").clipped).toBe(false);
    expect(run("#00ff00", CONVERT)["sRGB gamut"]).toBe("Inside sRGB, nothing was changed.");
  });

  it("clamps a lightness that no chroma reduction can rescue", () => {
    // L above 1 is brighter than sRGB white, so chroma alone cannot fix it.
    const mapped = gamutMapOklch(1.2, 0.05, 30);
    expect(mapped.clipped).toBe(true);
    expect(mapped.rgb.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(formatHex(parseColor("lab(140 0 0)"))).toBe("#ffffff");
  });
});

describe("color-picker contrast", () => {
  it("pins the WCAG extremes", () => {
    expect(contrastRatio([0, 0, 0], WHITE)).toBeCloseTo(21, 10);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
    expect(relativeLuminance(RED)).toBeCloseTo(0.2126, 6);

    const out = run("#000 on #fff", CONTRAST);
    expect(out["Contrast ratio"]).toBe("21.00:1");
    expect(out["WCAG AAA normal text"]).toBe("pass (needs 7:1)");
  });

  it("fails AA normal but passes AA large for mid grey on white", () => {
    expect(contrastRatio([119 / 255, 119 / 255, 119 / 255], WHITE)).toBeCloseTo(4.48, 2);
    const out = run("#777 on #fff", CONTRAST);
    expect(out["Contrast ratio"]).toBe("4.48:1");
    expect(out["WCAG AA normal text"]).toBe("fail (needs 4.5:1)");
    expect(out["WCAG AA large text"]).toBe("pass (needs 3:1)");
    expect(out["WCAG AAA normal text"]).toBe("fail (needs 7:1)");
    expect(out.Foreground).toBe("#777777 (read as hex)");
    expect(out.Background).toBe("#ffffff (read as hex)");

    expect(wcagVerdicts(4.48)).toEqual({
      "AA normal": false,
      "AA large": true,
      "AAA normal": false,
      "AAA large": false,
    });
  });

  it("checks a single colour against white and black", () => {
    const out = run("#777777", CONTRAST);
    expect(out["On white (#ffffff)"]).toContain("4.48:1");
    expect(out["On black (#000000)"]).toContain("4.69:1");
    expect(out["Better background"]).toBe("black at 4.69:1");
    expect(out.Foreground).toBeUndefined();
  });

  it("splits two colours without tripping over commas inside rgb()", () => {
    expect(splitOperands("rgb(255, 0, 0), white")).toEqual(["rgb(255, 0, 0)", "white"]);
    expect(splitOperands("#fff on #000")).toEqual(["#fff", "#000"]);
    const out = run("rgb(255, 0, 0), white", CONTRAST);
    expect(out.Foreground).toBe("#ff0000 (read as rgb)");
    expect(out.Background).toBe("#ffffff (read as named)");
    expect(out["Contrast ratio"]).toBe("4.00:1");
  });

  it("says alpha is ignored rather than pretending it is not there", () => {
    const out = run("rgb(0 0 0 / 50%) on white", CONTRAST);
    expect(out.Alpha).toContain("ignored");
    expect(out["Contrast ratio"]).toBe("21.00:1");
  });
});

describe("color-picker palettes", () => {
  it("builds every family with hue rotations that hold lightness", () => {
    const out = run("#663399", PALETTE);
    // Base, 31 swatches, the gamut note and the method note.
    expect(Object.keys(out)).toHaveLength(34);
    expect(out.Base).toBe("#663399 | oklch(0.44 0.1603 303.37)");
    expect(out["Complementary (hue +180)"]).toContain("#475c00");
    expect(out["Analogous (hue -30)"]).toContain("#3a44a9");
    expect(out["Scale 50"]).toContain("#f7f3ff");
    expect(out["Scale 950"]).toContain("#300053");

    const base = srgbToOklch([0x66 / 255, 0x33 / 255, 0x99 / 255]);
    const swatches = buildPalette(base, "all");
    expect(swatches).toHaveLength(31);
    for (const rotation of swatches.filter((s) => s.label.includes("hue"))) {
      // OKLCH rotation keeps the base lightness, which an HSL rotation does not.
      expect(rotation.oklch[0]).toBeCloseTo(base[0], 10);
    }
  });

  it("filters to a single family and keeps the scale at 11 stops", () => {
    for (const kind of PALETTE_KINDS) {
      expect(Object.keys(run("#663399", { ...PALETTE, paletteKind: kind })).length).toBeGreaterThan(
        2,
      );
    }
    const scale = run("#663399", { ...PALETTE, paletteKind: "scale" });
    // Base, 11 stops, gamut note, method note.
    expect(Object.keys(scale)).toHaveLength(14);
    expect(scale["Scale 500"]).toBeDefined();
    expect(scale["Complementary (hue +180)"]).toBeUndefined();

    expect(buildPalette(srgbToOklch(RED), "tints")).toHaveLength(5);
    expect(buildPalette(srgbToOklch(RED), "shades")).toHaveLength(5);
    expect(buildPalette(srgbToOklch(RED), "complementary")).toHaveLength(1);
  });

  it("ramps a grey without inventing a hue", () => {
    const out = run("#808080", { ...PALETTE, paletteKind: "tints" });
    expect(out["Tint 1"]).toBe("#949494 | oklch(0.667 0 none)");
    expect(out["Tint 5"]).toBe("#e9e9e9 | oklch(0.933 0 none)");
    expect(out["sRGB gamut"]).toBe("Every swatch fits inside sRGB at the base chroma.");
  });

  it("reports how many swatches had to be pulled into sRGB", () => {
    const out = run("#663399", PALETTE);
    expect(out["sRGB gamut"]).toMatch(/^\d+ of 31 swatches had their chroma reduced/);
  });
});

describe("color-picker errors", () => {
  it("throws empty-input on nothing at all", () => {
    for (const bad of ["", "   ", "\n"]) {
      try {
        run(bad, CONVERT);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("empty-input");
        expect((err as ToolError).fix).toContain("rebeccapurple");
      }
    }
  });

  it("throws bad-color naming the token and listing the syntaxes", () => {
    for (const bad of ["notacolour", "#12345", "rgb(1 2)", "hsl(a b% c%)", "cmyk(0 0 0 1)", "#"]) {
      try {
        run(bad, CONVERT);
        expect.unreachable(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("bad-color");
        expect((err as ToolError).message).toContain(bad);
        expect((err as ToolError).fix).toContain("oklch(");
        expect((err as ToolError).fix).toContain("#rrggbbaa");
      }
    }
  });

  it("throws second-color-required when the separator has nothing after it", () => {
    for (const bad of ["#ffffff on ", "#ffffff,", "#ffffff;"]) {
      try {
        run(bad, CONTRAST);
        expect.unreachable(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("second-color-required");
        expect((err as ToolError).fix).toContain("on");
      }
    }
  });

  it("throws bad-mode and bad-palette-kind for unknown option values", () => {
    try {
      run("#fff", { ...CONVERT, mode: "sideways" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-mode");
      expect((err as ToolError).fix).toContain("palette");
    }

    try {
      run("#fff", { ...PALETTE, paletteKind: "rainbow" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-palette-kind");
      expect((err as ToolError).fix).toContain("tetradic");
    }
  });
});
