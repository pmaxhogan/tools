import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  SHADOW_PRESETS,
  formatShadow,
  formatShadowColor,
  formatShadowLayer,
  formatTailwind,
  parseBoxShadow,
  parseShadowColor,
  parseShadowLayer,
  presetLayers,
  run,
  scaleLayers,
} from "./index";

describe("parseShadowColor", () => {
  it("reads hex in every length", () => {
    expect(parseShadowColor("#000")).toEqual({ hex: "#000000", opacity: 1 });
    expect(parseShadowColor("#FFFFFF")).toEqual({ hex: "#ffffff", opacity: 1 });
    const short = parseShadowColor("#0008");
    expect(short.hex).toBe("#000000");
    expect(short.opacity).toBeCloseTo(0.5333, 4);
    const long = parseShadowColor("#11223380");
    expect(long.hex).toBe("#112233");
    expect(long.opacity).toBeCloseTo(0.502, 3);
  });

  it("reads rgb and rgba in both the legacy and the modern syntax", () => {
    expect(parseShadowColor("rgb(255, 0, 0)")).toEqual({ hex: "#ff0000", opacity: 1 });
    expect(parseShadowColor("rgba(0,0,0,.2)")).toEqual({ hex: "#000000", opacity: 0.2 });
    const modern = parseShadowColor("rgb(0 0 0 / 25%)");
    expect(modern.hex).toBe("#000000");
    expect(modern.opacity).toBeCloseTo(0.25, 6);
  });

  it("reads the handful of named colors it carries", () => {
    expect(parseShadowColor("black")).toEqual({ hex: "#000000", opacity: 1 });
    expect(parseShadowColor("transparent")).toEqual({ hex: "#000000", opacity: 0 });
  });

  it("refuses a keyword it cannot split into a color and an opacity", () => {
    try {
      parseShadowColor("currentColor");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-color");
    }
  });

  it("refuses a hex of the wrong length and a broken rgb()", () => {
    expect(() => parseShadowColor("#12345")).toThrowError(ToolError);
    expect(() => parseShadowColor("rgb(0, 0)")).toThrowError(ToolError);
    expect(() => parseShadowColor("rgb(a, b, c)")).toThrowError(ToolError);
  });
});

describe("formatShadowColor", () => {
  it("drops to a plain hex at full opacity", () => {
    expect(formatShadowColor("#123456", 1, "rgba")).toBe("#123456");
  });

  it("writes each syntax the way CSS expects it", () => {
    expect(formatShadowColor("#000000", 0.2, "rgba")).toBe("rgba(0, 0, 0, 0.2)");
    expect(formatShadowColor("#000000", 0.5, "hex")).toBe("#00000080");
    expect(formatShadowColor("#000000", 0.25, "modern")).toBe("rgb(0 0 0 / 25%)");
  });

  it("removes every space in compact mode, which Tailwind requires", () => {
    expect(formatShadowColor("#000000", 0.2, "rgba", true)).toBe("rgba(0,0,0,0.2)");
    expect(formatShadowColor("#000000", 0.25, "modern", true)).toBe("rgb(0_0_0_/_25%)");
  });
});

describe("parseShadowLayer", () => {
  it("reads two, three, and four lengths", () => {
    expect(parseShadowLayer("2px 4px")).toEqual({
      x: 2,
      y: 4,
      blur: 0,
      spread: 0,
      color: "#000000",
      opacity: 1,
      inset: false,
    });
    expect(parseShadowLayer("0 1px 3px rgba(0,0,0,0.2)").blur).toBe(3);
    expect(parseShadowLayer("0 1px 3px -1px #fff").spread).toBe(-1);
  });

  it("takes the inset keyword from anywhere in the layer", () => {
    expect(parseShadowLayer("inset 0 1px 2px black").inset).toBe(true);
    expect(parseShadowLayer("0 1px 2px black inset").inset).toBe(true);
  });

  it("rejects a layer with too few lengths, two colors, or a negative blur", () => {
    for (const [text, code] of [
      ["0", "too-few-lengths"],
      ["0 1px red blue", "two-colors"],
      ["0 1px -2px black", "negative-blur"],
      ["0 1px 2px 3px 4px black", "too-many-lengths"],
    ] as const) {
      try {
        parseShadowLayer(text);
        throw new Error(`expected a ToolError for ${text}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe(code);
      }
    }
  });

  it("says plainly that the editor works in pixels", () => {
    try {
      parseShadowLayer("0 0.5rem 1rem black");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unsupported-unit");
      expect((e as ToolError).fix).toContain("px");
    }
  });
});

describe("parseBoxShadow", () => {
  it("splits layers on commas that are not inside a color function", () => {
    const layers = parseBoxShadow(
      "0 1px 2px rgba(0, 0, 0, 0.2), inset 0 2px 4px 1px rgb(10 20 30 / 50%)",
    );
    expect(layers).toHaveLength(2);
    expect(layers[0].opacity).toBeCloseTo(0.2, 6);
    expect(layers[1].inset).toBe(true);
    expect(layers[1].color).toBe("#0a141e");
    expect(layers[1].opacity).toBeCloseTo(0.5, 6);
  });

  it("tolerates the property name and the trailing semicolon", () => {
    expect(parseBoxShadow("box-shadow: 0 1px 2px #000;")).toHaveLength(1);
  });

  it("reads none as an empty layer list", () => {
    expect(parseBoxShadow("none")).toEqual([]);
    expect(formatShadow([])).toBe("none");
  });

  it("rejects an empty value", () => {
    try {
      parseBoxShadow("   ");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("round-trips every preset through format and parse", () => {
    for (const preset of SHADOW_PRESETS) {
      const text = formatShadow(preset.layers, "rgba", false);
      const back = parseBoxShadow(text);
      expect(back).toHaveLength(preset.layers.length);
      back.forEach((l, i) => {
        const original = preset.layers[i];
        expect(l.x).toBeCloseTo(original.x, 3);
        expect(l.y).toBeCloseTo(original.y, 3);
        expect(l.blur).toBeCloseTo(original.blur, 3);
        expect(l.spread).toBeCloseTo(original.spread, 3);
        expect(l.color).toBe(original.color);
        expect(l.opacity).toBeCloseTo(original.opacity, 3);
        expect(l.inset).toBe(original.inset);
      });
    }
  });
});

describe("formatShadowLayer", () => {
  it("omits a zero spread and keeps a non-zero one", () => {
    expect(formatShadowLayer({ ...presetLayers("hard")[0], spread: 0 })).toBe("4px 4px 0 #111111");
    expect(formatShadowLayer(presetLayers("material-1")[0])).toBe(
      "0 2px 1px -1px rgba(0, 0, 0, 0.2)",
    );
  });

  it("puts inset first, where CSS examples always show it", () => {
    expect(formatShadowLayer(presetLayers("inset-well")[0])).toBe(
      "inset 0 1px 2px rgba(0, 0, 0, 0.15)",
    );
  });
});

describe("formatTailwind", () => {
  it("replaces every space with an underscore", () => {
    const value = formatTailwind(presetLayers("soft"), "rgba");
    expect(value).toBe("shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-4px_rgba(0,0,0,0.1)]");
    expect(value).not.toContain(" ");
  });

  it("falls back to the shadow-none utility", () => {
    expect(formatTailwind([], "rgba")).toBe("shadow-none");
  });
});

describe("scaleLayers", () => {
  it("multiplies the lengths and leaves the colors alone", () => {
    const [scaled] = scaleLayers([presetLayers("soft")[1]], 2);
    expect(scaled.y).toBe(16);
    expect(scaled.blur).toBe(48);
    expect(scaled.spread).toBe(-8);
    expect(scaled.opacity).toBeCloseTo(0.1, 6);
  });
});

describe("presetLayers", () => {
  it("returns a fresh copy so the caller cannot mutate the table", () => {
    const first = presetLayers("hard");
    first[0].x = 999;
    expect(presetLayers("hard")[0].x).toBe(4);
  });

  it("rejects a preset name it does not carry", () => {
    try {
      presetLayers("brutalist");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-preset");
    }
  });
});

describe("run", () => {
  it("generates the default preset as multiline CSS", () => {
    expect(run("", {})).toBe(
      "box-shadow: 0 3px 1px -2px rgba(0, 0, 0, 0.2),\n  0 2px 2px rgba(0, 0, 0, 0.14),\n  0 1px 5px rgba(0, 0, 0, 0.12);",
    );
  });

  it("parses an input value instead of using the preset", () => {
    expect(run("0 4px 8px #0000004d", { colorSyntax: "hex" })).toBe(
      "box-shadow: 0 4px 8px #0000004d;",
    );
  });

  it("emits both blocks when asked", () => {
    const out = run("0 2px 4px rgba(0,0,0,0.2)", { format: "both" });
    expect(out).toContain("box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);");
    expect(out).toContain("shadow-[0_2px_4px_rgba(0,0,0,0.2)]");
  });

  it("applies the scale option", () => {
    expect(run("0 2px 4px #000", { scale: 1.5 })).toBe("box-shadow: 0 3px 6px #000000;");
  });

  it("rejects bad options", () => {
    expect(() => run("", { colorSyntax: "hsl" })).toThrowError(ToolError);
    expect(() => run("", { format: "sass" })).toThrowError(ToolError);
    expect(() => run("", { scale: 0 })).toThrowError(ToolError);
  });
});
