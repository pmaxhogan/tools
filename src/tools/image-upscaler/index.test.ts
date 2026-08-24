import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_MODEL_ID,
  MAX_OUTPUT_EDGE,
  MAX_SOURCE_EDGE,
  MODELS,
  OVERLAP,
  SCALE,
  TILE,
  addTile,
  blendTiles,
  checkSourceSize,
  createBlender,
  featherWeight,
  finishBlend,
  modelById,
  outputDims,
  pickProvider,
  planTiles,
  postprocess,
  preprocess,
  preprocessTile,
  providerNote,
  readImageHeader,
  run,
  stitch,
} from "./index";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** RGBA buffer whose channels follow a smooth two axis ramp. */
function gradientRgba(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      out[p] = Math.round((255 * x) / Math.max(1, width - 1));
      out[p + 1] = Math.round((255 * y) / Math.max(1, height - 1));
      out[p + 2] = Math.round((255 * (x + y)) / Math.max(1, width + height - 2));
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * The high resolution image the tests treat as ground truth: a smooth function
 * of the output coordinate alone, so every tile that covers a pixel agrees on
 * its value. Any deviation in the stitched result is therefore blending error,
 * not disagreement between tiles.
 */
function truth(x: number, y: number, w: number, h: number): [number, number, number] {
  return [
    0.15 + 0.7 * ((x + 0.5) / w),
    0.15 + 0.7 * ((y + 0.5) / h),
    0.15 + 0.7 * (((x + 0.5) / w + (y + 0.5) / h) / 2),
  ];
}

/**
 * A stand in for the model: returns the ground truth for the tile's slice of
 * the output, optionally with a per tile constant offset so a seam would show
 * if the feather were wrong.
 */
function fakeUpscale(plan: ReturnType<typeof planTiles>, index: number, bias = 0): Float32Array {
  const rect = plan.tiles[index]!;
  const tw = rect.w * plan.scale;
  const th = rect.h * plan.scale;
  const area = tw * th;
  const out = new Float32Array(area * 3);
  for (let v = 0; v < th; v += 1) {
    for (let u = 0; u < tw; u += 1) {
      const [r, g, b] = truth(
        rect.x * plan.scale + u,
        rect.y * plan.scale + v,
        plan.outputWidth,
        plan.outputHeight,
      );
      const i = v * tw + u;
      out[i] = r + bias;
      out[area + i] = g + bias;
      out[area * 2 + i] = b + bias;
    }
  }
  return out;
}

/** Largest absolute difference, in 0 to 255 units, from the ground truth. */
function maxDeviation(rgba: Uint8ClampedArray, w: number, h: number): number {
  let worst = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const expected = truth(x, y, w, h);
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        worst = Math.max(worst, Math.abs(rgba[p + c]! - expected[c]! * 255));
      }
    }
  }
  return worst;
}

/** Largest jump between horizontally adjacent pixels on one row. */
function maxRowJump(rgba: Uint8ClampedArray, w: number, y: number): number {
  let worst = 0;
  for (let x = 1; x < w; x += 1) {
    const a = (y * w + x) * 4;
    const b = (y * w + x - 1) * 4;
    for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(rgba[a + c]! - rgba[b + c]!));
  }
  return worst;
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* planTiles                                                           */
/* ------------------------------------------------------------------ */

describe("planTiles", () => {
  it("covers every source pixel", () => {
    const plan = planTiles(300, 190, 128, 16);
    const seen = new Uint8Array(300 * 190);
    for (const t of plan.tiles) {
      for (let y = t.y; y < t.y + t.h; y += 1) {
        for (let x = t.x; x < t.x + t.w; x += 1) seen[y * 300 + x] = 1;
      }
    }
    expect(seen.every((v) => v === 1)).toBe(true);
    expect(plan.tiles.length).toBe(plan.cols * plan.rows);
  });

  it("keeps every tile the same size and inside the image", () => {
    const plan = planTiles(300, 190, 128, 16);
    for (const t of plan.tiles) {
      expect(t.w).toBe(plan.tileWidth);
      expect(t.h).toBe(plan.tileHeight);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(300);
      expect(t.y + t.h).toBeLessThanOrEqual(190);
    }
  });

  it("overlaps neighbors by at least the requested amount", () => {
    const plan = planTiles(300, 190, 128, 16);
    for (let row = 0; row < plan.rows; row += 1) {
      for (let col = 1; col < plan.cols; col += 1) {
        const left = plan.tiles[row * plan.cols + col - 1]!;
        const here = plan.tiles[row * plan.cols + col]!;
        expect(left.x + left.w - here.x).toBeGreaterThanOrEqual(16);
      }
    }
    for (let row = 1; row < plan.rows; row += 1) {
      const above = plan.tiles[(row - 1) * plan.cols]!;
      const here = plan.tiles[row * plan.cols]!;
      expect(above.y + above.h - here.y).toBeGreaterThanOrEqual(16);
    }
  });

  it("shifts the last tile back so it sits flush with the edge", () => {
    const plan = planTiles(300, 190, 128, 16);
    const last = plan.tiles[plan.tiles.length - 1]!;
    expect(last.x + last.w).toBe(300);
    expect(last.y + last.h).toBe(190);
    expect(plan.tiles[plan.cols - 1]!.x + plan.tileWidth).toBe(300);
  });

  it("uses one tile, and no feather, when the image fits inside one", () => {
    const plan = planTiles(64, 48, 128, 16);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tileWidth).toBe(64);
    expect(plan.tileHeight).toBe(48);
    expect(plan.overlap).toBe(0);
    expect(plan.outputWidth).toBe(256);
    expect(plan.outputHeight).toBe(192);
  });

  it("handles an image smaller than a tile in one direction only", () => {
    const plan = planTiles(40, 400, 128, 16);
    expect(plan.cols).toBe(1);
    expect(plan.tileWidth).toBe(40);
    expect(plan.tileHeight).toBe(128);
    expect(plan.rows).toBeGreaterThan(1);
    expect(plan.overlap).toBe(16);
    const last = plan.tiles[plan.tiles.length - 1]!;
    expect(last.y + last.h).toBe(400);
  });

  it("shrinks the overlap when a side is narrower than the overlap itself", () => {
    // A 10 pixel wide strip cannot share 16 pixels with anything, so the
    // overlap drops to one less than the narrow side rather than going negative.
    const plan = planTiles(10, 400, 128, 16);
    expect(plan.tileWidth).toBe(10);
    expect(plan.overlap).toBe(9);
    expect(plan.rows).toBeGreaterThan(1);
    expect(plan.tiles.every((t) => t.x + t.w <= 10 && t.y + t.h <= 400)).toBe(true);
  });

  it("lands on exact multiples without a duplicate tile", () => {
    const plan = planTiles(240, 240, 128, 16);
    const step = 128 - 16;
    expect(plan.cols).toBe(1 + Math.ceil((240 - 128) / step));
    const xs = plan.tiles.filter((t) => t.row === 0).map((t) => t.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it("rejects a zero or negative size", () => {
    expect(() => planTiles(0, 100)).toThrow(ToolError);
    expect(() => planTiles(100, -4)).toThrow(ToolError);
  });

  it("rejects an overlap that does not fit inside the tile", () => {
    expect(() => planTiles(500, 500, 128, 128)).toThrow(/does not fit/);
    expect(() => planTiles(500, 500, 128, -1)).toThrow(/zero or more/);
  });
});

/* ------------------------------------------------------------------ */
/* outputDims and the size guard                                       */
/* ------------------------------------------------------------------ */

describe("outputDims", () => {
  it("multiplies both sides by the scale", () => {
    expect(outputDims(480, 320)).toEqual({ width: 1920, height: 1280 });
    expect(outputDims(100, 50, 2)).toEqual({ width: 200, height: 100 });
  });

  it("rejects a non-positive size", () => {
    expect(() => outputDims(0, 10)).toThrow(ToolError);
  });
});

describe("checkSourceSize", () => {
  it("accepts an ordinary small image", () => {
    expect(() => checkSourceSize(480, 320)).not.toThrow();
    expect(() => checkSourceSize(1024, 1024)).not.toThrow();
  });

  it("refuses a source over the per side ceiling", () => {
    try {
      checkSourceSize(MAX_SOURCE_EDGE + 1, 10);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("source-too-large");
      expect((e as ToolError).fix).toMatch(/Crop/);
    }
  });

  it("refuses a result wider than a canvas can be", () => {
    try {
      checkSourceSize(3000, 4);
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("output-too-wide");
      expect((e as ToolError).message).toContain(String(MAX_OUTPUT_EDGE));
    }
  });

  it("refuses a result with more pixels than the tab can hold", () => {
    try {
      checkSourceSize(2000, 1500);
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("output-too-large");
    }
  });
});

/* ------------------------------------------------------------------ */
/* preprocess and postprocess                                          */
/* ------------------------------------------------------------------ */

describe("preprocess and postprocess", () => {
  it("round trips an RGBA buffer through planar float", () => {
    const rgba = gradientRgba(11, 7);
    const planar = preprocess(rgba, 11, 7);
    expect(planar).toHaveLength(11 * 7 * 3);
    const back = postprocess(planar, 11, 7);
    for (let i = 0; i < 11 * 7; i += 1) {
      expect(back[i * 4]).toBe(rgba[i * 4]);
      expect(back[i * 4 + 1]).toBe(rgba[i * 4 + 1]);
      expect(back[i * 4 + 2]).toBe(rgba[i * 4 + 2]);
      expect(back[i * 4 + 3]).toBe(255);
    }
  });

  it("lays the planes out as red, then green, then blue", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const planar = preprocess(rgba, 2, 1);
    expect(Array.from(planar)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("clamps model output that overshoots 0 to 1", () => {
    const planar = Float32Array.from([-0.4, 1.9, 0.5, 0.5, 0.5, 0.5]);
    const rgba = postprocess(planar, 2, 1);
    expect(rgba[0]).toBe(0);
    expect(rgba[4]).toBe(255);
  });

  it("reads only the requested tile", () => {
    const rgba = gradientRgba(8, 8);
    const tile = preprocessTile(rgba, 8, 8, { col: 1, row: 1, x: 4, y: 4, w: 4, h: 4 });
    expect(tile).toHaveLength(4 * 4 * 3);
    expect(tile[0]).toBeCloseTo((rgba[(4 * 8 + 4) * 4]! ?? 0) / 255, 6);
  });

  it("rejects a short buffer and an out of bounds tile", () => {
    expect(() => preprocess(new Uint8ClampedArray(8), 4, 4)).toThrow(/short of/);
    expect(() =>
      preprocessTile(gradientRgba(8, 8), 8, 8, { col: 0, row: 0, x: 6, y: 0, w: 4, h: 4 }),
    ).toThrow(/does not fit/);
    expect(() => postprocess(new Float32Array(4), 4, 4)).toThrow(/short of/);
  });
});

/* ------------------------------------------------------------------ */
/* feathering and blending                                             */
/* ------------------------------------------------------------------ */

describe("featherWeight", () => {
  it("is flat in the middle and ramps at both ends", () => {
    expect(featherWeight(50, 100, 10)).toBe(1);
    expect(featherWeight(0, 100, 10)).toBeCloseTo(0.05, 6);
    expect(featherWeight(99, 100, 10)).toBeCloseTo(0.05, 6);
    expect(featherWeight(9, 100, 10)).toBeCloseTo(0.95, 6);
  });

  it("is never zero inside the tile, so a lone tile still normalizes", () => {
    for (let u = 0; u < 40; u += 1) expect(featherWeight(u, 40, 64)).toBeGreaterThan(0);
  });

  it("is flat everywhere when there is no feather", () => {
    expect(featherWeight(0, 40, 0)).toBe(1);
    expect(featherWeight(39, 40, 0)).toBe(1);
  });
});

describe("blendTiles", () => {
  it("reproduces the ground truth with no visible seam", () => {
    const plan = planTiles(300, 190, 128, 16);
    expect(plan.tiles.length).toBeGreaterThan(4);
    const tiles = plan.tiles.map((_, i) => fakeUpscale(plan, i));
    const out = blendTiles(tiles, plan);
    expect(out).toHaveLength(plan.outputWidth * plan.outputHeight * 4);
    // Under 1 of 255: every deviation left is the byte rounding at the end.
    expect(maxDeviation(out, plan.outputWidth, plan.outputHeight)).toBeLessThan(1);
  });

  it("spreads a per tile bias across the feather instead of stepping at the seam", () => {
    const plan = planTiles(300, 190, 128, 16);
    // Eight levels of 255 of disagreement between neighboring tiles: a hard
    // cut would show as an eight level edge at the boundary column.
    const tiles = plan.tiles.map((_, i) => fakeUpscale(plan, i, (i % 2 === 0 ? 8 : 0) / 255));
    const out = blendTiles(tiles, plan);
    const smooth = blendTiles(
      plan.tiles.map((_, i) => fakeUpscale(plan, i)),
      plan,
    );
    const row = Math.floor(plan.outputHeight / 2);
    // The gradient itself steps by at most one level between columns, so the
    // seam has to stay inside that plus the 2 of 255 tolerance.
    expect(maxRowJump(out, plan.outputWidth, row)).toBeLessThan(
      maxRowJump(smooth, plan.outputWidth, row) + 2,
    );
  });

  it("normalizes to exactly one, including the outer border", () => {
    const plan = planTiles(300, 190, 128, 16);
    const flat = plan.tiles.map((_, i) => {
      const rect = plan.tiles[i]!;
      return new Float32Array(rect.w * plan.scale * rect.h * plan.scale * 3).fill(0.4);
    });
    const out = blendTiles(flat, plan);
    let worst = 0;
    for (let i = 0; i < plan.outputWidth * plan.outputHeight; i += 1) {
      worst = Math.max(worst, Math.abs(out[i * 4]! - 102));
    }
    // A darkened border is the classic failure here, so this checks every pixel.
    expect(worst).toBe(0);
  });

  it("works when the whole image is a single tile", () => {
    const plan = planTiles(40, 30, 128, 16);
    const out = blendTiles([fakeUpscale(plan, 0)], plan);
    expect(maxDeviation(out, plan.outputWidth, plan.outputHeight)).toBeLessThan(1);
  });

  it("can be driven one tile at a time with the same result", () => {
    const plan = planTiles(200, 140, 128, 16);
    const tiles = plan.tiles.map((_, i) => fakeUpscale(plan, i));
    const blender = createBlender(plan);
    tiles.forEach((tile, i) => addTile(blender, i, tile));
    expect(blender.added).toBe(plan.tiles.length);
    expect(Array.from(finishBlend(blender))).toEqual(Array.from(blendTiles(tiles, plan)));
  });

  it("is exported as stitch too", () => {
    expect(stitch).toBe(blendTiles);
  });

  it("rejects a wrong tile count, a short tile, and an unknown index", () => {
    const plan = planTiles(300, 190, 128, 16);
    expect(() => blendTiles([new Float32Array(1)], plan)).toThrow(/upscaled tiles for a plan/);
    const blender = createBlender(plan);
    expect(() => addTile(blender, 0, new Float32Array(10))).toThrow(/short of/);
    expect(() => addTile(blender, 999, new Float32Array(10))).toThrow(/not in a plan/);
  });
});

/* ------------------------------------------------------------------ */
/* runtime and models                                                  */
/* ------------------------------------------------------------------ */

describe("pickProvider", () => {
  it("prefers WebGPU and falls back to WebAssembly", () => {
    expect(pickProvider(true)).toBe("webgpu");
    expect(pickProvider(false)).toBe("wasm");
    expect(providerNote("webgpu")).toContain("WebGPU");
    expect(providerNote("wasm")).toContain("WebAssembly");
  });
});

describe("MODELS", () => {
  it("describes two 4x models staged under /models/upscaler/", () => {
    expect(MODELS).toHaveLength(2);
    for (const model of MODELS) {
      expect(model.file.startsWith("/models/upscaler/")).toBe(true);
      expect(model.file.endsWith(".onnx")).toBe(true);
      expect(model.bytes).toBeGreaterThan(0);
      expect(model.scale).toBe(SCALE);
      expect(model.license).toContain("BSD 3-Clause");
      expect(model.label).not.toMatch(/[–—]/);
    }
  });

  it("defaults to the small model and falls back for an unknown id", () => {
    expect(modelById(DEFAULT_MODEL_ID).id).toBe("general");
    expect(modelById("nope").id).toBe(DEFAULT_MODEL_ID);
    expect(modelById(undefined).id).toBe(DEFAULT_MODEL_ID);
    expect(modelById("photo").bytes).toBeGreaterThan(modelById("general").bytes);
  });
});

/* ------------------------------------------------------------------ */
/* header sniffing                                                     */
/* ------------------------------------------------------------------ */

describe("readImageHeader", () => {
  it("reads a PNG size", () => {
    expect(readImageHeader(png(480, 320))).toEqual({ format: "PNG", width: 480, height: 320 });
  });

  it("reads a JPEG size from the start of frame marker", () => {
    const bytes = new Uint8Array(40);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
    bytes.set([0x4a, 0x46, 0x49, 0x46, 0x00], 6);
    bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
    bytes.set([0x01, 0x40], 25); // height 320
    bytes.set([0x01, 0xe0], 27); // width 480
    expect(readImageHeader(bytes)).toEqual({ format: "JPEG", width: 480, height: 320 });
  });

  it("reads GIF and BMP sizes", () => {
    const gif = new Uint8Array(16);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    gif.set([0xe0, 0x01, 0x40, 0x01], 6);
    expect(readImageHeader(gif)).toEqual({ format: "GIF", width: 480, height: 320 });

    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d], 0);
    new DataView(bmp.buffer).setInt32(18, 480, true);
    new DataView(bmp.buffer).setInt32(22, -320, true);
    expect(readImageHeader(bmp)).toEqual({ format: "BMP", width: 480, height: 320 });
  });

  it("reads an extended WebP size", () => {
    const webp = new Uint8Array(32);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x58], 12);
    webp.set([0xdf, 0x01, 0x00], 24); // width - 1 = 479
    webp.set([0x3f, 0x01, 0x00], 27); // height - 1 = 319
    expect(readImageHeader(webp)).toEqual({ format: "WebP", width: 480, height: 320 });
  });

  it("returns null for anything it does not recognize", () => {
    expect(readImageHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("describes the job for a dropped PNG", () => {
    const rows = run(png(480, 320));
    expect(rows.Loaded).toBe("PNG image, 480 by 320 pixels.");
    expect(rows.Result).toBe("1920 by 1280 pixels, 4x on each side.");
    expect(rows.Tiles).toContain(`${planTiles(480, 320, TILE, OVERLAP).tiles.length} tiles`);
    expect(rows.Privacy).toContain("your files and inputs never leave your device");
  });

  it("switches model wording with the option", () => {
    expect(run(png(64, 64), { model: "photo" }).Model).toContain("Photo x4plus");
    expect(run(png(64, 64)).Model).toContain("General");
  });

  it("explains itself when there is no image yet", () => {
    const rows = run("");
    expect(rows.Input).toBe("No image loaded yet.");
    expect(rows["How to use"]).toContain("Drop an image");
    expect(rows["What to expect"]).toContain("invents the detail");
  });

  it("says so when text was pasted instead of an image", () => {
    expect(run("hello there").Input).toContain("This tool enlarges images");
  });

  it("refuses an empty file", () => {
    try {
      run(new Uint8Array(0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-file");
    }
  });

  it("refuses an image that is too big before anything downloads", () => {
    expect(() => run(png(5000, 5000))).toThrow(/stops at 4096 pixels/);
  });

  it("still reports something for a format it cannot sniff", () => {
    const rows = run(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    expect(rows.Loaded).toContain("not one this tool recognizes");
    expect(rows.Result).toBeUndefined();
  });

  it("keeps every line free of em and en dashes", () => {
    for (const value of Object.values(run(png(480, 320)))) {
      expect(value).not.toMatch(/[–—]/);
    }
  });
});
