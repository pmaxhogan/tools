import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  ALGORITHMS,
  PALETTES,
  bayerMatrix,
  blueNoiseMap,
  dither,
  paletteColors,
  parseCustomPalette,
  resizeBox,
  resizeNearest,
  run,
  toAsciiPreview,
  uniqueColors,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** A solid grey image, fully opaque. */
function flat(width: number, height: number, value: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = value;
    out[i * 4 + 1] = value;
    out[i * 4 + 2] = value;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A grey ramp running left to right and top to bottom, 0 to 255. */
function gradient(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const last = width * height - 1;
  for (let i = 0; i <= last; i += 1) {
    const v = Math.round((i / last) * 255);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Mean of the red channel, which equals mean brightness on a grey image. */
function meanRed(buf: Uint8ClampedArray): number {
  let sum = 0;
  for (let p = 0; p < buf.length; p += 4) sum += buf[p]!;
  return sum / (buf.length / 4);
}

function srgbToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function meanLinear(buf: Uint8ClampedArray): number {
  let sum = 0;
  for (let p = 0; p < buf.length; p += 4) sum += srgbToLinear(buf[p]!);
  return sum / (buf.length / 4);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Minimal base64 encoder, so the test does not depend on a runtime global. */
function toBase64(bytes: Uint8ClampedArray): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

function payload(buf: Uint8ClampedArray, width: number, height: number): string {
  return JSON.stringify({ width, height, rgbaBase64: toBase64(buf) });
}

/** Every color in a buffer as "r,g,b" strings, for readable assertions. */
function colorSet(buf: Uint8ClampedArray): Set<string> {
  const set = new Set<string>();
  for (let p = 0; p < buf.length; p += 4) set.add(`${buf[p]},${buf[p + 1]},${buf[p + 2]}`);
  return set;
}

/* ------------------------------------------------------------------ *
 * error diffusion
 * ------------------------------------------------------------------ */

describe("error diffusion", () => {
  it("reduces a 4x4 gradient to pure black and white and keeps the average", () => {
    const src = gradient(4, 4);
    const out = dither(src, 4, 4, {
      algorithm: "floyd-steinberg",
      palette: "bw",
      gamma: false,
    });

    expect(out.length).toBe(4 * 4 * 4);
    for (let p = 0; p < out.length; p += 4) {
      expect([0, 255]).toContain(out[p]);
      expect(out[p + 1]).toBe(out[p]);
      expect(out[p + 2]).toBe(out[p]);
      expect(out[p + 3]).toBe(255);
    }

    // 16 pixels can only be 16 pieces of a percentage, so the average moves a
    // long way when a single pixel flips. The error pushed off the right and
    // bottom edges has nowhere to go either.
    expect(Math.abs(meanRed(out) - meanRed(src))).toBeLessThan(24);
  });

  it("holds the average much tighter once there are enough pixels", () => {
    const src = gradient(32, 32);
    const out = dither(src, 32, 32, {
      algorithm: "floyd-steinberg",
      palette: "bw",
      gamma: false,
    });
    expect(Math.abs(meanRed(out) - meanRed(src))).toBeLessThan(4);
  });

  it("preserves the average in linear light when gamma is on", () => {
    const src = gradient(32, 32);
    const out = dither(src, 32, 32, { algorithm: "floyd-steinberg", palette: "bw" });
    expect(Math.abs(meanLinear(out) - meanLinear(src))).toBeLessThan(0.02);
  });

  it("dithers darker with gamma on than with gamma off", () => {
    const src = flat(32, 32, 128);
    const linear = dither(src, 32, 32, { algorithm: "floyd-steinberg", palette: "bw" });
    const plain = dither(src, 32, 32, {
      algorithm: "floyd-steinberg",
      palette: "bw",
      gamma: false,
    });
    // sRGB 128 is only 21.6 percent of the light of white, so correct math
    // lights up about a fifth of the pixels where naive math lights up half.
    expect(meanRed(linear)).toBeLessThan(meanRed(plain) - 40);
  });

  it("throws away a quarter of the error on Atkinson, so darks go darker", () => {
    const src = flat(24, 24, 64);
    const input = meanRed(src);
    const fs = meanRed(
      dither(src, 24, 24, {
        algorithm: "floyd-steinberg",
        palette: "bw",
        gamma: false,
      }),
    );
    const atkinson = meanRed(
      dither(src, 24, 24, {
        algorithm: "atkinson",
        palette: "bw",
        gamma: false,
      }),
    );

    expect(Math.abs(fs - input)).toBeLessThan(4);
    expect(atkinson).toBeLessThan(input - 10);
    expect(Math.abs(atkinson - input)).toBeGreaterThan(Math.abs(fs - input));
  });

  it("changes the result when serpentine scanning is turned off", () => {
    const src = gradient(16, 16);
    const snake = dither(src, 16, 16, { algorithm: "floyd-steinberg", palette: "bw" });
    const raster = dither(src, 16, 16, {
      algorithm: "floyd-steinberg",
      palette: "bw",
      serpentine: false,
    });
    expect(Array.from(snake)).not.toEqual(Array.from(raster));
  });

  it("ignores serpentine on ordered algorithms, which are position only", () => {
    const src = gradient(16, 16);
    const a = dither(src, 16, 16, { algorithm: "bayer-4", palette: "bw" });
    const b = dither(src, 16, 16, { algorithm: "bayer-4", palette: "bw", serpentine: false });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("collapses to plain thresholding at strength 0", () => {
    const src = gradient(16, 16);
    const off = dither(src, 16, 16, {
      algorithm: "floyd-steinberg",
      palette: "gray-4",
      strength: 0,
    });
    const plain = dither(src, 16, 16, { algorithm: "threshold", palette: "gray-4" });
    expect(Array.from(off)).toEqual(Array.from(plain));
  });

  it("runs every diffusion kernel without leaving the palette", () => {
    const src = gradient(20, 20);
    for (const algo of ALGORITHMS.filter((a) => a.kind === "diffusion")) {
      const out = dither(src, 20, 20, { algorithm: algo.id, palette: "gray-4" });
      expect(uniqueColors(out)).toBeLessThanOrEqual(4);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ordered dithering
 * ------------------------------------------------------------------ */

describe("ordered dithering", () => {
  it("builds the Bayer matrices with the standard recursion", () => {
    const two = bayerMatrix(2);
    expect(two.size).toBe(2);
    // Ranks 0, 2, 3, 1 normalized as (rank + 0.5) / 4.
    expect(Array.from(two.values)).toEqual([0.125, 0.625, 0.875, 0.375]);

    const four = bayerMatrix(4);
    const ranks = Array.from(four.values).map((v) => Math.round(v * 16 - 0.5));
    expect(ranks).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });

  it("turns flat 50 percent grey into an exact checkerboard with Bayer 4x4", () => {
    // sRGB 128 is 0.50196. The threshold offset is (rank + 0.5) / 16 - 0.5, so a
    // pixel goes white exactly when its Bayer rank is 8 or more, and in the 4x4
    // matrix that is precisely the squares where x + y is odd.
    const src = flat(4, 4, 128);
    const out = dither(src, 4, 4, { algorithm: "bayer-4", palette: "bw", gamma: false });

    const expected = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const v = (x + y) % 2 === 1 ? 255 : 0;
        const p = (y * 4 + x) * 4;
        expected[p] = v;
        expected[p + 1] = v;
        expected[p + 2] = v;
        expected[p + 3] = 255;
      }
    }

    expect(Array.from(out)).toEqual(Array.from(expected));
  });

  it("builds a 64x64 blue noise tile that ranks every cell exactly once", () => {
    const map = blueNoiseMap();
    expect(map.size).toBe(64);
    expect(map.values.length).toBe(4096);

    const ranks = new Set(Array.from(map.values).map((v) => Math.round(v * 4096 - 0.5)));
    expect(ranks.size).toBe(4096);
    expect(Math.min(...ranks)).toBe(0);
    expect(Math.max(...ranks)).toBe(4095);
  });

  it("returns the same blue noise tile every time it is asked", () => {
    expect(Array.from(blueNoiseMap().values)).toEqual(Array.from(blueNoiseMap().values));
  });

  it("is deterministic for the random algorithm too", () => {
    const src = gradient(16, 16);
    const a = dither(src, 16, 16, { algorithm: "random", palette: "bw" });
    const b = dither(src, 16, 16, { algorithm: "random", palette: "bw" });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

/* ------------------------------------------------------------------ *
 * palettes
 * ------------------------------------------------------------------ */

describe("palettes", () => {
  it("snaps a color to the nearest Game Boy green", () => {
    const greens = PALETTES.find((p) => p.id === "gameboy")!.colors;
    const lightest = greens[3]!;
    const darkest = greens[0]!;

    const nearlyLightest = new Uint8ClampedArray([
      lightest[0] + 4,
      lightest[1] - 3,
      lightest[2] + 5,
      255,
    ]);
    const light = dither(nearlyLightest, 1, 1, { algorithm: "threshold", palette: "gameboy" });
    expect(Array.from(light)).toEqual([...lightest, 255]);

    const nearlyDarkest = new Uint8ClampedArray([darkest[0], darkest[1] + 2, darkest[2], 255]);
    const dark = dither(nearlyDarkest, 1, 1, { algorithm: "threshold", palette: "gameboy" });
    expect(Array.from(dark)).toEqual([...darkest, 255]);
  });

  it("never emits a color outside the palette, for every algorithm and palette", () => {
    const src = gradient(24, 24);
    for (const algo of ALGORITHMS) {
      for (const pal of PALETTES) {
        const custom = "#1a1c2c, #5d275d, #ef7d57, #ffcd75";
        const colors = paletteColors(pal.id, custom);
        const out = dither(src, 24, 24, {
          algorithm: algo.id,
          palette: pal.id,
          customPalette: custom,
        });

        expect(uniqueColors(out)).toBeLessThanOrEqual(colors.length);

        const allowed = new Set(colors.map((c) => `${c[0]},${c[1]},${c[2]}`));
        for (const seen of colorSet(out)) expect(allowed.has(seen)).toBe(true);
      }
    }
  });

  it("composites semi transparent pixels onto white", () => {
    const clear = new Uint8ClampedArray([0, 0, 0, 0]);
    const out = dither(clear, 1, 1, { algorithm: "threshold", palette: "bw" });
    expect(Array.from(out)).toEqual([255, 255, 255, 255]);
  });

  it("parses hex shorthand and rejects junk", () => {
    expect(parseCustomPalette("#f00 0f0 #0000ff")).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
    expect(() => parseCustomPalette("#ff0000, chartreuse")).toThrow(ToolError);
    expect(() => parseCustomPalette("#ff0000")).toThrow(/at least 2/);
  });

  it("rejects an unknown palette id", () => {
    expect(() => paletteColors("sepia")).toThrow(ToolError);
    try {
      paletteColors("sepia");
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-palette");
    }
  });
});

/* ------------------------------------------------------------------ *
 * resampling
 * ------------------------------------------------------------------ */

describe("resampling", () => {
  it("averages every source pixel when a box filter shrinks 2x2 to 1x1", () => {
    const src = new Uint8ClampedArray([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 192, 192, 192, 255,
    ]);
    const out = resizeBox(src, 2, 2, 1, 1);
    expect(Array.from(out)).toEqual([96, 96, 96, 255]);
  });

  it("averages each block independently when shrinking 4x2 to 2x1", () => {
    const src = new Uint8ClampedArray(4 * 2 * 4);
    const values = [0, 100, 200, 244, 0, 100, 200, 244];
    for (let i = 0; i < 8; i += 1) {
      src[i * 4] = values[i]!;
      src[i * 4 + 1] = values[i]!;
      src[i * 4 + 2] = values[i]!;
      src[i * 4 + 3] = 255;
    }
    const out = resizeBox(src, 4, 2, 2, 1);
    expect(Array.from(out)).toEqual([50, 50, 50, 255, 222, 222, 222, 255]);
  });

  it("picks whole pixels with nearest neighbour, in both directions", () => {
    const src = new Uint8ClampedArray([
      10, 10, 10, 255, 250, 250, 250, 255, 40, 40, 40, 255, 90, 90, 90, 255,
    ]);
    const up = resizeNearest(src, 2, 2, 4, 4);
    expect(up.length).toBe(4 * 4 * 4);
    expect(Array.from(up.slice(0, 8))).toEqual([10, 10, 10, 255, 10, 10, 10, 255]);
    const down = resizeNearest(src, 2, 2, 1, 1);
    expect(Array.from(down)).toEqual([10, 10, 10, 255]);
  });

  it("rejects an impossible target size", () => {
    const src = flat(2, 2, 0);
    expect(() => resizeBox(src, 2, 2, 0, 4)).toThrow(ToolError);
    expect(() => resizeNearest(src, 2, 2, 3, 1.5)).toThrow(/not usable/);
  });
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

describe("helpers", () => {
  it("draws an ascii preview one character per pixel", () => {
    const preview = toAsciiPreview(gradient(4, 2), 4, 2);
    const rows = preview.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(4);
    expect(preview[0]).toBe(" ");
    expect(preview[preview.length - 1]).toBe("@");
  });

  it("counts distinct colors and ignores alpha", () => {
    const buf = new Uint8ClampedArray([1, 2, 3, 255, 1, 2, 3, 0, 9, 9, 9, 255]);
    expect(uniqueColors(buf)).toBe(2);
  });

  it("rejects a buffer that does not match its declared size", () => {
    expect(() => dither(new Uint8ClampedArray(8), 4, 4)).toThrow(ToolError);
    try {
      dither(new Uint8ClampedArray(8), 4, 4);
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });

  it("rejects a nonsense image size", () => {
    expect(() => dither(new Uint8ClampedArray(0), 0, 4)).toThrow(/not a usable image size/);
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  it("reports what it did for a pixel payload", () => {
    const out = run(payload(gradient(8, 8), 8, 8), {
      algorithm: "atkinson",
      palette: "gameboy",
    });

    expect(out.Algorithm).toBe("Atkinson (error diffusion)");
    expect(out.Palette).toBe("Game Boy (4 greens), 4 colors");
    expect(out["Output size"]).toBe("8 by 8 pixels");
    expect(out["Unique colors in output"]).toMatch(/^[1-4] of 4 palette colors used$/);
    expect(out.Settings).toContain("serpentine on");
    expect(out.Preview?.split("\n")).toHaveLength(8);
  });

  it("downscales first when a pixel scale is set", () => {
    const out = run(payload(gradient(16, 16), 16, 16), { scale: 4 });
    expect(out["Output size"]).toBe("4 by 4 pixels, downscaled 4 times from 16 by 16");
    expect(out.Preview?.split("\n")).toHaveLength(4);
  });

  it("says serpentine does not apply to an ordered algorithm", () => {
    const out = run(payload(flat(8, 8, 128), 8, 8), { algorithm: "bayer-8", palette: "bw" });
    expect(out.Settings).toContain("serpentine not used by this algorithm");
    expect(out.Settings).toContain("linear light");
  });

  it("accepts the payload as bytes as well as a string", () => {
    const text = payload(flat(2, 2, 200), 2, 2);
    const bytes = new TextEncoder().encode(text);
    expect(run(bytes, {})).toEqual(run(text, {}));
  });

  it("points at the panel for anything that is not a pixel payload", () => {
    for (const bad of ["", "   ", "not json", "[1,2,3]", '"a string"']) {
      expect(() => run(bad, {})).toThrow(ToolError);
      try {
        run(bad, {});
      } catch (err) {
        expect((err as ToolError).code).toBe("use-panel");
        expect((err as ToolError).fix).toContain("panel");
      }
    }
  });

  it("points at the panel when the payload is missing a field", () => {
    expect(() => run(JSON.stringify({ width: 2, height: 2 }), {})).toThrow(/rgbaBase64/);
    expect(() => run(JSON.stringify({ width: 0, height: 2, rgbaBase64: "AAAA" }), {})).toThrow(
      /width` and `height`/,
    );
    expect(() =>
      run(JSON.stringify({ width: 1, height: 1, rgbaBase64: "not base64!!" }), {}),
    ).toThrow(/base64/);
  });

  it("reports a byte count that does not match the declared size", () => {
    const text = JSON.stringify({ width: 4, height: 4, rgbaBase64: toBase64(flat(2, 2, 0)) });
    try {
      run(text, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });

  it("rejects settings outside their range", () => {
    const text = payload(flat(4, 4, 100), 4, 4);
    const cases: [Record<string, unknown>, string][] = [
      [{ algorithm: "ostromoukhov" }, "invalid-algorithm"],
      [{ palette: "sepia" }, "invalid-palette"],
      [{ palette: "custom", customPalette: "#fff" }, "invalid-palette"],
      [{ strength: 2 }, "invalid-strength"],
      [{ scale: 0 }, "invalid-scale"],
      [{ scale: 9 }, "invalid-scale"],
      [{ scale: 1.5 }, "invalid-scale"],
    ];
    for (const [opts, code] of cases) {
      try {
        run(text, opts);
        expect.unreachable(`should have thrown ${code}`);
      } catch (err) {
        expect((err as ToolError).code).toBe(code);
      }
    }
  });

  it("dithers to a custom palette", () => {
    const out = run(payload(gradient(8, 8), 8, 8), {
      palette: "custom",
      customPalette: "#1a1c2c #f4f4f4",
    });
    expect(out.Palette).toBe("Custom hex list, 2 colors");
  });
});
