import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  alignSizes,
  changedBounds,
  cropToOverlap,
  describeDiff,
  diffPixels,
  run,
  ssim,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** A w by h RGBA buffer filled with one opaque color. */
function solid(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Paints an opaque rectangle into an RGBA buffer, in place. */
function rect(
  buf: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
  r: number,
  g: number,
  b: number,
): Uint8ClampedArray {
  for (let y = y0; y < y0 + rh; y += 1) {
    for (let x = x0; x < x0 + rw; x += 1) {
      const pos = (y * w + x) * 4;
      buf[pos] = r;
      buf[pos + 1] = g;
      buf[pos + 2] = b;
      buf[pos + 3] = 255;
    }
  }
  return buf;
}

/** Builds a buffer from a per pixel gray value function. */
function gray(w: number, h: number, at: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = at(x, y);
      const pos = (y * w + x) * 4;
      out[pos] = v;
      out[pos + 1] = v;
      out[pos + 2] = v;
      out[pos + 3] = 255;
    }
  }
  return out;
}

/** Reads the RGB triple of one mask pixel. */
function pixelAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const pos = (y * w + x) * 4;
  return [buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!];
}

function toBase64(bytes: Uint8ClampedArray): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function payload(extra: Record<string, unknown>): string {
  return JSON.stringify(extra);
}

/* ------------------------------------------------------------------ *
 * diffPixels
 * ------------------------------------------------------------------ */

describe("diffPixels", () => {
  it("reports nothing for two identical images and draws a faded gray ghost", () => {
    const a = solid(8, 8, 120, 40, 200);
    const b = solid(8, 8, 120, 40, 200);
    const result = diffPixels(a, b, 8, 8);

    expect(result.diffCount).toBe(0);
    expect(result.diffPercent).toBe(0);
    expect(result.aaCount).toBe(0);
    expect(result.mask.length).toBe(8 * 8 * 4);

    // Every mask pixel is gray (equal channels) and opaque.
    for (let i = 0; i < 64; i += 1) {
      const [r, g, bch, alpha] = pixelAt(result.mask, 8, i % 8, Math.floor(i / 8));
      expect(r).toBe(g);
      expect(g).toBe(bch);
      expect(alpha).toBe(255);
    }
    // alpha 0.1 keeps the ghost close to white, never the original color.
    expect(pixelAt(result.mask, 8, 0, 0)[0]).toBeGreaterThan(220);
  });

  it("counts exactly the symmetric difference of a square moved by 5 pixels", () => {
    const a = rect(solid(40, 40, 255, 255, 255), 40, 5, 5, 10, 10, 255, 0, 0);
    const b = rect(solid(40, 40, 255, 255, 255), 40, 10, 10, 10, 10, 255, 0, 0);

    const result = diffPixels(a, b, 40, 40);

    // 100 + 100 pixels of red, overlapping in a 5 by 5 block: 200 - 2 * 25.
    expect(result.diffCount).toBe(150);
    expect(result.diffPercent).toBe(9.375);
    // A two color image has no intensity slope, so nothing reads as anti-aliasing.
    expect(result.aaCount).toBe(0);

    expect(changedBounds(result.mask, 40, 40)).toEqual({
      x: 5,
      y: 5,
      width: 15,
      height: 15,
      found: true,
    });

    // The corner only image A has is red in the mask, the shared center is not.
    expect(pixelAt(result.mask, 40, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(result.mask, 40, 19, 19)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(result.mask, 40, 12, 12)[0]).toBe(pixelAt(result.mask, 40, 12, 12)[1]);
  });

  it("ignores a one step brightness shift at the default threshold", () => {
    const a = gray(32, 32, (x) => x * 4);
    const b = gray(32, 32, (x) => x * 4 + 1);

    const result = diffPixels(a, b, 32, 32);
    expect(result.diffCount).toBe(0);
    expect(result.aaCount).toBe(0);
    expect(changedBounds(result.mask, 32, 32).found).toBe(false);

    // The same shift is structurally visible: SSIM drops below a perfect 1.
    const structural = ssim(a, b, 32, 32);
    expect(structural.mssim).toBeLessThan(1);
    expect(structural.mssim).toBeGreaterThan(0.99);
  });

  it("catches the same shift once the threshold is tightened", () => {
    const a = gray(32, 32, (x) => x * 4);
    const b = gray(32, 32, (x) => x * 4 + 1);
    // 0.5053 is the squared YIQ distance for a one step gray shift, so a
    // threshold under sqrt(0.5053 / 35215) makes it count.
    const result = diffPixels(a, b, 32, 32, { threshold: 0.003, includeAA: true });
    expect(result.diffCount).toBe(32 * 32);
  });

  it("skips anti-aliased edge pixels unless includeAA is on", () => {
    // A hard diagonal edge, and the same edge with one intermediate step.
    const hard = gray(16, 16, (x, y) => (x < y ? 0 : 255));
    const smooth = gray(16, 16, (x, y) => (x === y ? 128 : x < y ? 0 : 255));

    const ignored = diffPixels(hard, smooth, 16, 16);
    expect(ignored.diffCount).toBe(0);
    expect(ignored.aaCount).toBe(16);
    expect(pixelAt(ignored.mask, 16, 7, 7)).toEqual([255, 255, 0, 255]);
    expect(changedBounds(ignored.mask, 16, 16).found).toBe(false);

    const counted = diffPixels(hard, smooth, 16, 16, { includeAA: true });
    expect(counted.diffCount).toBe(16);
    expect(counted.aaCount).toBe(0);
    expect(pixelAt(counted.mask, 16, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(changedBounds(counted.mask, 16, 16)).toEqual({
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      found: true,
    });
  });

  it("honors the alpha option when fading the unchanged background", () => {
    const a = solid(4, 4, 0, 0, 0);
    const b = solid(4, 4, 0, 0, 0);
    expect(pixelAt(diffPixels(a, b, 4, 4, { alpha: 0 }).mask, 4, 0, 0)).toEqual([
      255, 255, 255, 255,
    ]);
    expect(pixelAt(diffPixels(a, b, 4, 4, { alpha: 1 }).mask, 4, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("rejects a bad threshold, mismatched buffers, and a zero size", () => {
    const a = solid(2, 2, 1, 2, 3);
    const b = solid(2, 2, 1, 2, 3);

    expect(() => diffPixels(a, b, 2, 2, { threshold: 2 })).toThrow(ToolError);
    try {
      diffPixels(a, b, 2, 2, { threshold: -0.1 });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-threshold");
    }

    try {
      diffPixels(a, solid(3, 3, 0, 0, 0), 2, 2);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }

    try {
      diffPixels(a, b, 0, 2);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-size");
    }
  });
});

/* ------------------------------------------------------------------ *
 * changedBounds
 * ------------------------------------------------------------------ */

describe("changedBounds", () => {
  it("returns nothing found for a mask with no red pixels", () => {
    expect(changedBounds(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      found: false,
    });
  });

  it("rejects a mask that does not match the dimensions", () => {
    try {
      changedBounds(new Uint8ClampedArray(16), 4, 4);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });
});

/* ------------------------------------------------------------------ *
 * ssim
 * ------------------------------------------------------------------ */

describe("ssim", () => {
  it("scores identical images at 1 across a stride 4 window grid", () => {
    const a = gray(32, 32, (x, y) => (x * 7 + y * 3) % 256);
    const b = gray(32, 32, (x, y) => (x * 7 + y * 3) % 256);
    const result = ssim(a, b, 32, 32);

    expect(result.mssim).toBeCloseTo(1, 10);
    expect(result.windowSize).toBe(8);
    expect(result.stride).toBe(4);
    // (32 - 8) / 4 + 1 windows on each axis.
    expect(result.mapWidth).toBe(7);
    expect(result.mapHeight).toBe(7);
    expect(result.map.length).toBe(49);
    for (const v of result.map) expect(v).toBeCloseTo(1, 6);
  });

  it("drops sharply when half the image is replaced", () => {
    const a = solid(32, 32, 255, 255, 255);
    const b = rect(solid(32, 32, 255, 255, 255), 32, 0, 0, 16, 32, 0, 0, 0);
    const result = ssim(a, b, 32, 32);
    expect(result.mssim).toBeLessThan(0.5);
  });

  it("clamps the window to the image and rejects a window under one pixel", () => {
    const a = solid(4, 4, 10, 20, 30);
    const b = solid(4, 4, 10, 20, 30);
    const small = ssim(a, b, 4, 4);
    expect(small.windowSize).toBe(4);
    expect(small.mapWidth).toBe(1);
    expect(small.mapHeight).toBe(1);
    expect(small.mssim).toBeCloseTo(1, 10);

    try {
      ssim(a, b, 4, 4, { windowSize: 0 });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-window");
    }
  });
});

/* ------------------------------------------------------------------ *
 * alignSizes and cropToOverlap
 * ------------------------------------------------------------------ */

describe("alignSizes", () => {
  it("reports a matching pair plainly", () => {
    const aligned = alignSizes(20, 10, 20, 10);
    expect(aligned).toMatchObject({ width: 20, height: 10, sameSize: true });
    expect(aligned.note).toBe("Both images are 20 by 10 pixels.");
  });

  it("takes the overlapping top left region without resampling", () => {
    const aligned = alignSizes(20, 10, 12, 30);
    expect(aligned.width).toBe(12);
    expect(aligned.height).toBe(10);
    expect(aligned.sameSize).toBe(false);
    expect(aligned.note).toContain("overlapping top left 12 by 10 region");
    expect(aligned.note).toContain("neither image was resampled");
  });

  it("rejects a non positive size", () => {
    try {
      alignSizes(0, 10, 10, 10);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-size");
    }
  });
});

describe("cropToOverlap", () => {
  it("keeps the top left rectangle and returns the buffer untouched when it fits", () => {
    const src = gray(4, 3, (x, y) => x + y * 10);
    expect(cropToOverlap(src, 4, 3, 4, 3)).toBe(src);

    const cropped = cropToOverlap(src, 4, 3, 2, 2);
    expect(cropped.length).toBe(2 * 2 * 4);
    expect(pixelAt(cropped, 2, 0, 0)[0]).toBe(0);
    expect(pixelAt(cropped, 2, 1, 1)[0]).toBe(11);
  });

  it("refuses to grow an image or to take mismatched dimensions", () => {
    const src = gray(4, 3, () => 5);
    try {
      cropToOverlap(src, 4, 3, 6, 3);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
    try {
      cropToOverlap(src, 5, 3, 2, 2);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });
});

/* ------------------------------------------------------------------ *
 * describeDiff
 * ------------------------------------------------------------------ */

describe("describeDiff", () => {
  it("calls a matching pair identical", () => {
    const a = gray(16, 16, (x, y) => (x * 5 + y) % 256);
    const b = gray(16, 16, (x, y) => (x * 5 + y) % 256);
    const rows = describeDiff(diffPixels(a, b, 16, 16), ssim(a, b, 16, 16));

    expect(rows.Verdict).toContain("Identical");
    expect(rows["Different pixels"]).toBe("0 of 256 (0.000 percent)");
    expect(rows["Changed area"]).toContain("no bounding box");
    expect(rows.MSSIM).toBe("1.000000");
    expect(rows["What MSSIM means"]).toContain("Structurally the same picture");
  });

  it("calls a moved block significant and reports its bounding box", () => {
    const a = rect(solid(40, 40, 255, 255, 255), 40, 5, 5, 10, 10, 255, 0, 0);
    const b = rect(solid(40, 40, 255, 255, 255), 40, 10, 10, 10, 10, 255, 0, 0);
    const rows = describeDiff(diffPixels(a, b, 40, 40), ssim(a, b, 40, 40));

    expect(rows.Verdict).toContain("Significant");
    expect(rows["Different pixels"]).toBe("150 of 1,600 (9.375 percent)");
    expect(rows["Changed area"]).toBe("x 5, y 5, 15 by 15 pixels");
  });

  it("narrows the rows to one measure and carries the alignment note", () => {
    const a = solid(16, 16, 10, 10, 10);
    const b = solid(16, 16, 10, 10, 10);
    const diff = diffPixels(a, b, 16, 16);
    const structural = ssim(a, b, 16, 16);
    const aligned = alignSizes(16, 16, 24, 16);

    const onlyDiff = describeDiff(diff, structural, { view: "diff", aligned });
    expect(onlyDiff["Different pixels"]).toBeDefined();
    expect(onlyDiff.MSSIM).toBeUndefined();
    expect(onlyDiff["Compared region"]).toContain("overlapping top left 16 by 16 region");

    const onlySsim = describeDiff(diff, structural, { view: "ssim" });
    expect(onlySsim.MSSIM).toBeDefined();
    expect(onlySsim["Different pixels"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  const a = solid(8, 8, 255, 255, 255);
  const b = rect(solid(8, 8, 255, 255, 255), 8, 2, 2, 2, 2, 0, 0, 0);
  const both = payload({ width: 8, height: 8, a: toBase64(a), b: toBase64(b) });

  it("compares a raw RGBA payload and reports both measures", () => {
    const rows = run(both, {});
    expect(rows["Different pixels"]).toBe("4 of 64 (6.250 percent)");
    expect(rows["Changed area"]).toBe("x 2, y 2, 2 by 2 pixels");
    expect(rows["Compared region"]).toBe("Both images are 8 by 8 pixels.");
    expect(rows.Verdict).toContain("Significant");
    expect(rows["SSIM windows"]).toContain("Rec.601 luma");
  });

  it("accepts the payload as bytes and honors the view option", () => {
    const bytes = new TextEncoder().encode(both);
    expect(run(bytes, { view: "diff" }).MSSIM).toBeUndefined();
    expect(run(bytes, { view: "ssim" })["Different pixels"]).toBeUndefined();
    expect(run(bytes, { view: "both" }).MSSIM).toBeDefined();
  });

  it("compares only the overlapping region when the sizes differ", () => {
    const wide = solid(12, 8, 255, 255, 255);
    const rows = run(
      payload({
        aWidth: 8,
        aHeight: 8,
        bWidth: 12,
        bHeight: 8,
        a: toBase64(a),
        b: toBase64(wide),
      }),
      {},
    );
    expect(rows["Compared region"]).toContain(
      "The images are different sizes (8 by 8 and 12 by 8)",
    );
    expect(rows["Compared region"]).toContain("overlapping top left 8 by 8 region");
    expect(rows["Different pixels"]).toBe("0 of 64 (0.000 percent)");
    expect(rows.Verdict).toContain("Identical");
  });

  it("passes the threshold and includeAA options through", () => {
    const hard = gray(16, 16, (x, y) => (x < y ? 0 : 255));
    const smooth = gray(16, 16, (x, y) => (x === y ? 128 : x < y ? 0 : 255));
    const edges = payload({
      width: 16,
      height: 16,
      a: toBase64(hard),
      b: toBase64(smooth),
    });
    expect(run(edges, {})["Different pixels"]).toBe("0 of 256 (0.000 percent)");
    expect(run(edges, { includeAA: true })["Different pixels"]).toBe("16 of 256 (6.250 percent)");
    expect(run(edges, {})["Anti-aliased pixels"]).toContain("16 differ but look like");
  });

  it("throws two-images for anything that is not a two image payload", () => {
    const bad: string[] = [
      "",
      "   ",
      "not json at all",
      "[1, 2, 3]",
      '"a string"',
      payload({ width: 2, height: 2, a: toBase64(solid(2, 2, 0, 0, 0)) }),
      payload({ a: toBase64(solid(2, 2, 0, 0, 0)), b: toBase64(solid(2, 2, 0, 0, 0)) }),
      payload({ width: 2.5, height: 2, a: "AAAA", b: "AAAA" }),
      payload({ width: 2, height: 2, a: "not base64 !!", b: "not base64 !!" }),
    ];
    for (const input of bad) {
      try {
        run(input, {});
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("two-images");
        expect((err as ToolError).fix).toBe("Drop or pick two images in the panel.");
      }
    }
  });

  it("uses the exact wording the panel points at for a plain wrong input", () => {
    try {
      run("hello", {});
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).toBe("This tool needs two images; use the panel above.");
    }
  });

  it("throws size-mismatch when the byte count does not match the dimensions", () => {
    try {
      run(payload({ width: 8, height: 8, a: toBase64(a), b: toBase64(solid(4, 4, 0, 0, 0)) }), {});
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("size-mismatch");
    }
  });

  it("throws invalid-view for an unknown view", () => {
    try {
      run(both, { view: "sideways" as never });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("invalid-view");
    }
  });
});
