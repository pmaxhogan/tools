import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  GRADIENT_PRESETS,
  formatBackground,
  formatGradientLayer,
  formatStopColor,
  formatTailwind,
  parseAngle,
  parseBackgroundImage,
  parseGradientLayer,
  orderPositionTokens,
  parseStopColor,
  presetLayers,
  resolveStopPositions,
  run,
  splitTop,
  trimNumber,
} from "./index";

describe("splitTop", () => {
  it("ignores separators inside parentheses", () => {
    expect(splitTop("linear-gradient(45deg, red, blue), radial-gradient(red, blue)", ",")).toEqual([
      "linear-gradient(45deg, red, blue)",
      "radial-gradient(red, blue)",
    ]);
  });

  it("splits words without breaking a color function", () => {
    expect(splitTop("rgba(255, 0, 0, 0.5) 50%", " ")).toEqual(["rgba(255, 0, 0, 0.5)", "50%"]);
  });
});

describe("parseAngle", () => {
  it("converts every CSS angle unit to degrees", () => {
    expect(parseAngle("45deg")).toBe(45);
    expect(parseAngle("0.25turn")).toBe(90);
    expect(parseAngle("100grad")).toBe(90);
    expect(parseAngle("3.14159265rad")).toBeCloseTo(180, 4);
  });

  it("normalizes into 0 to 360", () => {
    expect(parseAngle("-90deg")).toBe(270);
    expect(parseAngle("450deg")).toBe(90);
  });

  it("rejects something that is not an angle", () => {
    try {
      parseAngle("sideways");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-angle");
    }
  });
});

describe("parseStopColor", () => {
  it("reads hex, rgb, rgba, keywords, and transparent", () => {
    expect(parseStopColor("#f00")).toEqual({ hex: "#ff0000", opacity: 1 });
    expect(parseStopColor("rebeccapurple".replace("rebecca", "") || "purple")).toEqual({
      hex: "#800080",
      opacity: 1,
    });
    expect(parseStopColor("rgb(0, 128, 255)")).toEqual({ hex: "#0080ff", opacity: 1 });
    expect(parseStopColor("rgba(0, 0, 0, 0)")).toEqual({ hex: "#000000", opacity: 0 });
    expect(parseStopColor("transparent")).toEqual({ hex: "#000000", opacity: 0 });
  });

  it("refuses a color it cannot turn into a swatch", () => {
    try {
      parseStopColor("var(--brand)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-color");
    }
  });
});

describe("formatStopColor", () => {
  it("keeps hex at full opacity and switches syntax below it", () => {
    expect(formatStopColor("#ff0000", 1, "rgba")).toBe("#ff0000");
    expect(formatStopColor("#ff0000", 0.5, "rgba")).toBe("rgba(255, 0, 0, 0.5)");
    expect(formatStopColor("#ff0000", 0.5, "hex")).toBe("#ff000080");
    expect(formatStopColor("#ff0000", 0.5, "modern")).toBe("rgb(255 0 0 / 50%)");
  });
});

describe("orderPositionTokens", () => {
  it("puts a vertical-first keyword pair back into x then y order", () => {
    expect(orderPositionTokens(["top", "right"])).toEqual(["right", "top"]);
    expect(orderPositionTokens(["bottom", "left"])).toEqual(["left", "bottom"]);
  });

  it("leaves an already ordered pair alone", () => {
    expect(orderPositionTokens(["right", "top"])).toEqual(["right", "top"]);
    expect(orderPositionTokens(["center", "top"])).toEqual(["center", "top"]);
    expect(orderPositionTokens(["25%", "75%"])).toEqual(["25%", "75%"]);
  });

  it("centers the other axis when only one value is given", () => {
    expect(orderPositionTokens(["top"])).toEqual(["center", "top"]);
    expect(orderPositionTokens(["left"])).toEqual(["left", "center"]);
    expect(orderPositionTokens([])).toEqual(["center", "center"]);
  });
});

describe("parseGradientLayer", () => {
  it("reads an angle, an interpolation clause, and positioned stops", () => {
    const layer = parseGradientLayer("linear-gradient(45deg in oklch, #ff0000 0%, #0000ff 100%)");
    expect(layer.type).toBe("linear");
    expect(layer.angle).toBe(45);
    expect(layer.interpolation).toBe("oklch");
    expect(layer.repeating).toBe(false);
    expect(layer.stops).toEqual([
      { color: "#ff0000", opacity: 1, position: 0 },
      { color: "#0000ff", opacity: 1, position: 100 },
    ]);
  });

  it("turns a to-side direction into an angle", () => {
    expect(parseGradientLayer("linear-gradient(to right, red, blue)").angle).toBe(90);
    expect(parseGradientLayer("linear-gradient(to bottom left, red, blue)").angle).toBe(225);
  });

  it("defaults an angle-free linear gradient to 180 degrees, as CSS does", () => {
    expect(parseGradientLayer("linear-gradient(red, blue)").angle).toBe(180);
  });

  it("reads a radial shape, size, and center", () => {
    const layer = parseGradientLayer(
      "radial-gradient(circle farthest-side at 20% 80%, #fff, #000)",
    );
    expect(layer.shape).toBe("circle");
    expect(layer.size).toBe("farthest-side");
    expect(layer.centerX).toBe(20);
    expect(layer.centerY).toBe(80);
    expect(layer.stops[0].position).toBeNull();
  });

  it("reads a corner written in either keyword order", () => {
    const a = parseGradientLayer("radial-gradient(circle at top right, red, blue)");
    expect([a.centerX, a.centerY]).toEqual([100, 0]);
    const b = parseGradientLayer("radial-gradient(circle at right top, red, blue)");
    expect([b.centerX, b.centerY]).toEqual([100, 0]);
    const c = parseGradientLayer("radial-gradient(circle at bottom, red, blue)");
    expect([c.centerX, c.centerY]).toEqual([50, 100]);
  });

  it("reads a conic start angle and center keywords", () => {
    const layer = parseGradientLayer("conic-gradient(from 90deg at center top, red, blue)");
    expect(layer.type).toBe("conic");
    expect(layer.angle).toBe(90);
    expect(layer.centerX).toBe(50);
    expect(layer.centerY).toBe(0);
  });

  it("expands a double position stop into two stops", () => {
    const layer = parseGradientLayer("linear-gradient(90deg, red 0% 50%, blue 50% 100%)");
    expect(layer.stops).toHaveLength(4);
    expect(layer.stops[1]).toEqual({ color: "#ff0000", opacity: 1, position: 50 });
  });

  it("keeps the repeating prefix", () => {
    expect(parseGradientLayer("repeating-linear-gradient(45deg, red 0%, blue 10%)").repeating).toBe(
      true,
    );
  });

  it("rejects something that is not a gradient function", () => {
    try {
      parseGradientLayer("url(bg.png)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not-a-gradient");
    }
  });

  it("rejects a single stop gradient", () => {
    try {
      parseGradientLayer("linear-gradient(90deg, red)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("no-stops");
    }
  });

  it("says plainly that stop positions must be percentages", () => {
    try {
      parseGradientLayer("linear-gradient(90deg, red 0px, blue 40px)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unsupported-position");
    }
  });

  it("rejects an explicit radial size it cannot edit", () => {
    try {
      parseGradientLayer("radial-gradient(200px 100px at 50% 50%, red, blue)");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unsupported-gradient");
    }
  });
});

describe("parseBackgroundImage", () => {
  it("splits a stack of gradients into layers", () => {
    const layers = parseBackgroundImage(
      "background-image: radial-gradient(circle at 10% 10%, rgba(255,0,0,0.5) 0%, rgba(255,0,0,0) 60%), linear-gradient(180deg, #000 0%, #333 100%);",
    );
    expect(layers).toHaveLength(2);
    expect(layers[0].type).toBe("radial");
    expect(layers[0].stops[1].opacity).toBe(0);
    expect(layers[1].type).toBe("linear");
  });

  it("rejects an empty value", () => {
    try {
      parseBackgroundImage("  ");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("round-trips every preset", () => {
    for (const preset of GRADIENT_PRESETS) {
      const text = formatBackground(preset.layers);
      const back = parseBackgroundImage(text);
      expect(back).toHaveLength(preset.layers.length);
      expect(formatBackground(back)).toBe(text);
    }
  });
});

describe("formatGradientLayer", () => {
  it("writes the angle, the interpolation, and the stops", () => {
    expect(formatGradientLayer(presetLayers("ocean")[0])).toBe(
      "linear-gradient(180deg in oklch, #2e3192 0%, #1bffff 100%)",
    );
  });

  it("writes a radial prelude in the order CSS expects", () => {
    expect(formatGradientLayer(presetLayers("spotlight")[0])).toBe(
      "radial-gradient(circle farthest-corner at 30% 20% in oklch, #ffe259 0%, #ffa751 55%, #2b1055 100%)",
    );
  });

  it("has no spaces at all in compact mode", () => {
    const compact = formatGradientLayer(presetLayers("mesh")[0], "rgba", true);
    expect(compact).not.toContain(" ");
    expect(compact).toContain("rgba(255,77,157,0.75)");
  });
});

describe("formatTailwind", () => {
  it("wraps the whole stack in one arbitrary value", () => {
    const value = formatTailwind(presetLayers("ocean"));
    expect(value).toBe("bg-[linear-gradient(180deg_in_oklch,#2e3192_0%,#1bffff_100%)]");
    expect(value).not.toContain(" ");
  });

  it("falls back to the bg-none utility", () => {
    expect(formatTailwind([])).toBe("bg-none");
  });
});

describe("resolveStopPositions", () => {
  it("spaces unpositioned stops the way a browser does", () => {
    const stops = [
      { color: "#000000", opacity: 1, position: null },
      { color: "#111111", opacity: 1, position: null },
      { color: "#222222", opacity: 1, position: null },
    ];
    expect(resolveStopPositions(stops)).toEqual([0, 50, 100]);
  });

  it("respects the positions that are given", () => {
    const stops = [
      { color: "#000000", opacity: 1, position: 0 },
      { color: "#111111", opacity: 1, position: null },
      { color: "#222222", opacity: 1, position: null },
      { color: "#333333", opacity: 1, position: 100 },
    ];
    const resolved = resolveStopPositions(stops);
    expect(resolved[1]).toBeCloseTo(33.333, 3);
    expect(resolved[2]).toBeCloseTo(66.667, 3);
  });
});

describe("presetLayers", () => {
  it("returns a deep copy so the table cannot be mutated", () => {
    presetLayers("sunset")[0].stops[0].color = "#000000";
    expect(presetLayers("sunset")[0].stops[0].color).toBe("#ff9a44");
  });

  it("rejects an unknown preset", () => {
    try {
      presetLayers("lava lamp");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-preset");
    }
  });
});

describe("run", () => {
  it("generates the default preset as a background-image declaration", () => {
    expect(run("", {})).toBe(
      "background-image: linear-gradient(160deg in oklch, #ff9a44 0%, #ff5f6d 48%, #6a3093 100%);",
    );
  });

  it("parses an input value instead of the preset", () => {
    expect(run("linear-gradient(to right, red, blue)", {})).toBe(
      "background-image: linear-gradient(90deg, #ff0000, #0000ff);",
    );
  });

  it("rewrites the interpolation on every layer", () => {
    const out = run("", { preset: "mesh", interpolation: "oklab" });
    expect(out.match(/in oklab/g)).toHaveLength(3);
  });

  it("drops the interpolation clause when asked for none", () => {
    expect(run("", { preset: "ocean", interpolation: "none" })).toBe(
      "background-image: linear-gradient(180deg, #2e3192 0%, #1bffff 100%);",
    );
  });

  it("emits both blocks when asked", () => {
    const out = run("", { preset: "ocean", format: "both" });
    expect(out).toContain("background-image:");
    expect(out).toContain("bg-[linear-gradient(");
  });

  it("rejects bad options", () => {
    expect(() => run("", { colorSyntax: "cmyk" })).toThrowError(ToolError);
    expect(() => run("", { format: "less" })).toThrowError(ToolError);
    expect(() => run("", { interpolation: "lab" })).toThrowError(ToolError);
  });

  it("keeps trimNumber tidy for whole percentages", () => {
    expect(trimNumber(48, 3)).toBe("48");
    expect(trimNumber(33.333333, 3)).toBe("33.333");
  });
});
