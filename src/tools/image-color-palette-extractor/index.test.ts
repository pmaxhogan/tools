import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  cssVariables,
  extractPalette,
  medianCut,
  oklabToSrgb,
  paletteJson,
  refine,
  run,
  samplePixels,
  srgbToOklab,
  tailwindConfig,
  textColorFor,
  toHex,
  type ImageLike,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

type Rgb = [number, number, number];

/** An image made of solid blocks, one per color, in the given proportions. */
function blocks(spec: { color: Rgb; pixels: number; alpha?: number }[]): ImageLike {
  const total = spec.reduce((n, s) => n + s.pixels, 0);
  const data = new Uint8Array(total * 4);
  let at = 0;
  for (const part of spec) {
    for (let i = 0; i < part.pixels; i++) {
      data[at] = part.color[0];
      data[at + 1] = part.color[1];
      data[at + 2] = part.color[2];
      data[at + 3] = part.alpha ?? 255;
      at += 4;
    }
  }
  return { width: total, height: 1, data };
}

const RED: Rgb = [220, 30, 40];
const BLUE: Rgb = [30, 60, 200];
const CREAM: Rgb = [245, 240, 230];

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    out +=
      b === undefined
        ? "=="
        : alphabet[(n >> 6) & 63]! + (c === undefined ? "=" : alphabet[n & 63]!);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* color math                                                          */
/* ------------------------------------------------------------------ */

describe("srgbToOklab", () => {
  it("puts white and black on the lightness axis", () => {
    const white = srgbToOklab([1, 1, 1]);
    expect(white[0]).toBeCloseTo(1, 3);
    expect(Math.hypot(white[1], white[2])).toBeCloseTo(0, 3);
    expect(srgbToOklab([0, 0, 0])[0]).toBeCloseTo(0, 6);
  });

  it("round trips through oklabToSrgb", () => {
    for (const hex of [
      [220, 30, 40],
      [30, 60, 200],
      [128, 128, 128],
    ] as Rgb[]) {
      const unit: [number, number, number] = [hex[0] / 255, hex[1] / 255, hex[2] / 255];
      const back = oklabToSrgb(srgbToOklab(unit));
      expect(Math.round(back[0] * 255)).toBe(hex[0]);
      expect(Math.round(back[1] * 255)).toBe(hex[1]);
      expect(Math.round(back[2] * 255)).toBe(hex[2]);
    }
  });
});

describe("textColorFor", () => {
  it("picks the label color with the better contrast", () => {
    expect(textColorFor([255, 255, 255]).color).toBe("#000000");
    expect(textColorFor([0, 0, 0]).color).toBe("#ffffff");
  });

  it("reports the contrast it actually achieved", () => {
    const chosen = textColorFor([90, 80, 210]);
    expect(chosen.contrast).toBeGreaterThan(1);
    expect(chosen.contrast).toBeCloseTo(
      contrastRatio(
        [90 / 255, 80 / 255, 210 / 255],
        chosen.color === "#000000" ? [0, 0, 0] : [1, 1, 1],
      ),
      10,
    );
  });
});

describe("toHex", () => {
  it("pads and clamps", () => {
    expect(toHex([0, 8, 255])).toBe("#0008ff");
    expect(toHex([-20, 300, 128])).toBe("#00ff80");
  });
});

/* ------------------------------------------------------------------ */
/* sampling                                                            */
/* ------------------------------------------------------------------ */

describe("samplePixels", () => {
  it("keeps every pixel of a small image", () => {
    const set = samplePixels(blocks([{ color: RED, pixels: 10 }]));
    expect(set.count).toBe(10);
    expect(set.total).toBe(10);
  });

  it("skips transparent pixels when asked and counts them", () => {
    const image = blocks([
      { color: RED, pixels: 6 },
      { color: BLUE, pixels: 4, alpha: 0 },
    ]);
    const set = samplePixels(image, true);
    expect(set.count).toBe(6);
    expect(set.skippedTransparent).toBe(4);
    expect(samplePixels(image, false).count).toBe(10);
  });

  it("throws when the buffer is shorter than the dimensions claim", () => {
    expect(() => samplePixels({ width: 4, height: 4, data: new Uint8Array(8) })).toThrow(ToolError);
  });

  it("throws when every pixel is transparent", () => {
    expect(() => samplePixels(blocks([{ color: RED, pixels: 4, alpha: 0 }]))).toThrow(
      /Every pixel/,
    );
  });

  it("throws on an image with no pixels", () => {
    expect(() => samplePixels({ width: 0, height: 0, data: new Uint8Array(0) })).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* clustering                                                          */
/* ------------------------------------------------------------------ */

describe("medianCut", () => {
  it("returns one center per requested color when the image has enough", () => {
    const set = samplePixels(
      blocks([
        { color: RED, pixels: 40 },
        { color: BLUE, pixels: 40 },
        { color: CREAM, pixels: 40 },
      ]),
    );
    expect(medianCut(set, 3).length / 3).toBe(3);
  });

  it("stops splitting when there is nothing left to split", () => {
    const set = samplePixels(blocks([{ color: RED, pixels: 1 }]));
    expect(medianCut(set, 8).length / 3).toBe(1);
  });
});

describe("refine", () => {
  it("lands each center on the block color it belongs to", () => {
    const set = samplePixels(
      blocks([
        { color: RED, pixels: 30 },
        { color: BLUE, pixels: 30 },
      ]),
    );
    const out = refine(set, medianCut(set, 2));
    const hexes = [0, 1].map((c) =>
      toHex([out.means[c * 3]!, out.means[c * 3 + 1]!, out.means[c * 3 + 2]!]),
    );
    expect(hexes.sort()).toEqual([toHex(BLUE), toHex(RED)].sort());
    expect(Array.from(out.counts).sort()).toEqual([30, 30]);
  });
});

/* ------------------------------------------------------------------ */
/* extractPalette                                                      */
/* ------------------------------------------------------------------ */

describe("extractPalette", () => {
  const image = blocks([
    { color: RED, pixels: 60 },
    { color: BLUE, pixels: 30 },
    { color: CREAM, pixels: 10 },
  ]);

  it("finds the three block colors and names the dominant one", () => {
    const result = extractPalette(image, { colors: 3 });
    expect(result.swatches.map((s) => s.hex).sort()).toEqual(
      [toHex(RED), toHex(BLUE), toHex(CREAM)].sort(),
    );
    expect(result.dominant.hex).toBe(toHex(RED));
    expect(result.dominant.share).toBeCloseTo(0.6, 2);
  });

  it("is deterministic across repeated runs", () => {
    const a = extractPalette(image, { colors: 3 });
    const b = extractPalette(image, { colors: 3 });
    expect(a.swatches.map((s) => s.hex)).toEqual(b.swatches.map((s) => s.hex));
  });

  it("clamps the requested color count into 2 to 16", () => {
    expect(extractPalette(image, { colors: 99 }).swatches.length).toBeLessThanOrEqual(16);
    expect(extractPalette(image, { colors: 0 }).swatches.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns an empty cluster as a color", () => {
    // Two flat colors asked for eight swatches: only the real ones come back.
    const flat = blocks([
      { color: RED, pixels: 20 },
      { color: BLUE, pixels: 20 },
    ]);
    expect(extractPalette(flat, { colors: 8 }).swatches.length).toBe(2);
  });

  it("sorts by lightness and by hue on request", () => {
    const byLightness = extractPalette(image, { colors: 3, sort: "lightness" });
    expect(byLightness.swatches[0]!.hex).toBe(toHex(CREAM));
    const byHue = extractPalette(image, { colors: 3, sort: "hue" });
    expect(byHue.swatches.map((s) => s.hex)).not.toEqual(byLightness.swatches.map((s) => s.hex));
  });

  it("gives every swatch a readable label color", () => {
    for (const swatch of extractPalette(image, { colors: 3 }).swatches) {
      expect(["#000000", "#ffffff"]).toContain(swatch.textColor);
      expect(swatch.textContrast).toBeGreaterThan(2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* exports                                                             */
/* ------------------------------------------------------------------ */

describe("cssVariables and tailwindConfig", () => {
  const result = extractPalette(
    blocks([
      { color: RED, pixels: 30 },
      { color: BLUE, pixels: 10 },
    ]),
    { colors: 2 },
  );

  it("numbers the properties in hundreds", () => {
    const css = cssVariables(result.swatches, "brand");
    expect(css).toContain("--brand-100:");
    expect(css).toContain("--brand-200:");
  });

  it("emits the Tailwind 4 theme block", () => {
    expect(tailwindConfig(result.swatches, "brand")).toContain("@theme {");
    expect(tailwindConfig(result.swatches, "brand")).toContain("--color-brand-100:");
  });

  it("sanitizes a prefix that is not a valid identifier", () => {
    expect(cssVariables(result.swatches, "my brand!")).toContain("--my-brand-100:");
    expect(cssVariables(result.swatches, "   ")).toContain("--color-100:");
  });

  it("serializes the palette as JSON with the dominant color named", () => {
    const parsed: unknown = JSON.parse(paletteJson(result));
    const object = parsed as { dominant: string; colors: { hex: string }[] };
    expect(object.dominant).toBe(toHex(RED));
    expect(object.colors).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  const image = blocks([
    { color: RED, pixels: 6 },
    { color: BLUE, pixels: 2 },
  ]);
  const payload = JSON.stringify({
    width: 8,
    height: 1,
    rgbaBase64: base64(image.data as Uint8Array),
  });

  it("reads a pixel payload and reports the palette", () => {
    const out = run(payload, { colors: 2 });
    expect(out["Dominant color"]).toContain(toHex(RED));
    expect(out["Colors found"]).toBe("2");
    expect(out["CSS custom properties"]).toContain(":root {");
    expect(out["Tailwind theme"]).toContain("@theme {");
  });

  it("accepts the payload as bytes as well as text", () => {
    const bytes = new TextEncoder().encode(payload);
    expect(run(bytes, { colors: 2 })["Colors found"]).toBe("2");
  });

  it("throws when there is no input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    expect(() => run("   ", {})).toThrow(/no image was given/);
  });

  it("throws when the input is not a payload", () => {
    expect(() => run("hello", {})).toThrow(/not a pixel payload/);
    expect(() => run("[1,2,3]", {})).toThrow(/not a pixel payload/);
  });

  it("throws when the payload is missing its parts", () => {
    expect(() => run(JSON.stringify({ width: 2, height: 2 }), {})).toThrow(/rgbaBase64/);
    expect(() => run(JSON.stringify({ rgbaBase64: "AAAA" }), {})).toThrow(/width/);
    expect(() => run(JSON.stringify({ width: 1, height: 1, rgbaBase64: "!!" }), {})).toThrow(
      /base64 encoded/,
    );
  });
});
