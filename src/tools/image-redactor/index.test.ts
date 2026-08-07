import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  applyPixelateRect,
  applySolidRect,
  boxAtPoint,
  clampRect,
  collectTextBoxes,
  floodFillBounds,
  mulberry32,
  normalizeRect,
  run,
  sniffImageFormat,
  suggestExportName,
  type ImageLike,
  type Rect,
  type TextBox,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Checkerboard of opaque red and opaque blue, one pixel per square, plus a
 * per pixel alpha ramp so alpha changes are visible in the assertions too.
 */
function checkerboard(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = (x + y) % 2 === 0;
      data[i] = dark ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 200 + ((x + y) % 4);
    }
  }
  return data;
}

function pixelAt(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Every pixel outside `rect` must be byte identical to the untouched source. */
function expectOutsideUntouched(
  data: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  width: number,
  height: number,
  rect: Rect,
) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inRect(rect, x, y)) continue;
      expect(pixelAt(data, width, x, y)).toEqual(pixelAt(pristine, width, x, y));
    }
  }
}

const W = 8;
const H = 8;

/* ------------------------------------------------------------------ */
/* normalizeRect                                                       */
/* ------------------------------------------------------------------ */

describe("normalizeRect", () => {
  it("sorts a top left to bottom right drag unchanged", () => {
    expect(normalizeRect({ x1: 2, y1: 3, x2: 6, y2: 9 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it("sorts a drag made upward and to the left", () => {
    expect(normalizeRect({ x1: 6, y1: 9, x2: 2, y2: 3 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it("sorts a drag that is negative on one axis only", () => {
    expect(normalizeRect({ x1: 6, y1: 3, x2: 2, y2: 9 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it("clamps a drag that starts outside the image to the image bounds", () => {
    expect(normalizeRect({ x1: -20, y1: -5, x2: 40, y2: 40 }, 16, 10)).toEqual({
      x: 0,
      y: 0,
      w: 16,
      h: 10,
    });
  });

  it("rounds fractional pointer coordinates to whole pixels", () => {
    expect(normalizeRect({ x1: 1.4, y1: 2.6, x2: 5.5, y2: 8.2 })).toEqual({
      x: 1,
      y: 3,
      w: 5,
      h: 5,
    });
  });

  it("returns a zero size rectangle for a click without a drag", () => {
    expect(normalizeRect({ x1: 4, y1: 4, x2: 4, y2: 4 })).toEqual({ x: 4, y: 4, w: 0, h: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* clampRect                                                           */
/* ------------------------------------------------------------------ */

describe("clampRect", () => {
  it("trims a rectangle that hangs off the right and bottom edges", () => {
    expect(clampRect({ x: 6, y: 6, w: 10, h: 10 }, W, H)).toEqual({ x: 6, y: 6, w: 2, h: 2 });
  });

  it("returns null when the rectangle misses the image entirely", () => {
    expect(clampRect({ x: 20, y: 20, w: 4, h: 4 }, W, H)).toBeNull();
  });

  it("returns null for a zero size rectangle", () => {
    expect(clampRect({ x: 2, y: 2, w: 0, h: 5 }, W, H)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* floodFillBounds                                                     */
/* ------------------------------------------------------------------ */

/**
 * A flat background with a solid rectangle of a second color painted on it.
 * The two colors are far apart, so a modest threshold selects the rectangle
 * and nothing of the background.
 */
function blobImage(
  width: number,
  height: number,
  rect: Rect,
  bg: [number, number, number, number],
  fg: [number, number, number, number],
): ImageLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b, a] = inside ? fg : bg;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
}

describe("floodFillBounds", () => {
  it("selects a solid rectangle painted on a different background", () => {
    const rect = { x: 2, y: 3, w: 4, h: 3 };
    const image = blobImage(12, 12, rect, [10, 10, 10, 255], [200, 40, 40, 255]);
    expect(floodFillBounds(image, { x: 3, y: 4 }, 30)).toEqual(rect);
  });

  it("returns the tapped background region, not the shape sitting in it", () => {
    // Tapping the background selects everything except the inner rectangle, so
    // the bounds span the whole image.
    const rect = { x: 4, y: 4, w: 2, h: 2 };
    const image = blobImage(10, 10, rect, [240, 240, 240, 255], [0, 0, 0, 255]);
    expect(floodFillBounds(image, { x: 0, y: 0 }, 20)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it("selects only the tapped pixel when the threshold is zero and neighbors differ", () => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    // A gradient so no two pixels share a color.
    for (let i = 0; i < 9; i++) {
      data[i * 4] = i * 20;
      data[i * 4 + 3] = 255;
    }
    const image: ImageLike = { data, width: 3, height: 3 };
    expect(floodFillBounds(image, { x: 1, y: 1 }, 0)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });

  it("rounds a fractional tap to the nearest pixel", () => {
    const rect = { x: 1, y: 1, w: 3, h: 3 };
    const image = blobImage(8, 8, rect, [0, 0, 0, 255], [255, 255, 255, 255]);
    expect(floodFillBounds(image, { x: 2.4, y: 2.6 }, 30)).toEqual(rect);
  });

  it("returns null when the tap lands outside the image", () => {
    const image = blobImage(6, 6, { x: 0, y: 0, w: 2, h: 2 }, [0, 0, 0, 255], [1, 1, 1, 255]);
    expect(floodFillBounds(image, { x: -1, y: 3 }, 10)).toBeNull();
    expect(floodFillBounds(image, { x: 6, y: 6 }, 10)).toBeNull();
  });

  it("finds a blob boundary by alpha even when the color underneath matches", () => {
    // Fully transparent field with an opaque black square. RGB is identical
    // everywhere, so only the alpha term in the difference finds the edge.
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    const rect = { x: 2, y: 2, w: 3, h: 3 };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        data[i + 3] = inside ? 255 : 0;
      }
    }
    expect(floodFillBounds({ data, width, height }, { x: 3, y: 3 }, 40)).toEqual(rect);
  });

  it("is deterministic across repeated calls", () => {
    const rect = { x: 2, y: 2, w: 3, h: 2 };
    const image = blobImage(9, 9, rect, [30, 60, 90, 255], [200, 210, 220, 255]);
    const a = floodFillBounds(image, { x: 3, y: 3 }, 40);
    const b = floodFillBounds(image, { x: 3, y: 3 }, 40);
    expect(a).toEqual(b);
    expect(a).toEqual(rect);
  });
});

/* ------------------------------------------------------------------ */
/* collectTextBoxes and boxAtPoint                                     */
/* ------------------------------------------------------------------ */

function tapPage() {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 10, y0: 10, x1: 90, y1: 24 },
                words: [
                  { bbox: { x0: 10, y0: 10, x1: 40, y1: 24 } },
                  { bbox: { x0: 50, y0: 10, x1: 90, y1: 24 } },
                ],
              },
              {
                bbox: { x0: 10, y0: 40, x1: 70, y1: 54 },
                words: [{ bbox: { x0: 10, y0: 40, x1: 70, y1: 54 } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("collectTextBoxes", () => {
  it("flattens every word and pairs it with its line rectangle", () => {
    const boxes = collectTextBoxes(tapPage());
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toEqual({
      word: { x: 10, y: 10, w: 30, h: 14 },
      line: { x: 10, y: 10, w: 80, h: 14 },
    });
    // Both words on the first line share that line's rectangle.
    expect(boxes[0]!.line).toEqual(boxes[1]!.line);
  });

  it("returns an empty list for a page with no blocks", () => {
    expect(collectTextBoxes(null)).toEqual([]);
    expect(collectTextBoxes({ blocks: null })).toEqual([]);
    expect(collectTextBoxes({ blocks: [] })).toEqual([]);
  });

  it("skips words and lines with a degenerate bounding box", () => {
    const boxes = collectTextBoxes({
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  bbox: { x0: 0, y0: 0, x1: 0, y1: 10 }, // zero width line, dropped
                  words: [{ bbox: { x0: 0, y0: 0, x1: 5, y1: 10 } }],
                },
                {
                  bbox: { x0: 0, y0: 20, x1: 30, y1: 34 },
                  words: [
                    { bbox: { x0: 0, y0: 20, x1: 0, y1: 34 } }, // zero width word, dropped
                    { bbox: { x0: 10, y0: 20, x1: 30, y1: 34 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.word).toEqual({ x: 10, y: 20, w: 20, h: 14 });
  });
});

describe("boxAtPoint", () => {
  const boxes: TextBox[] = collectTextBoxes(tapPage());

  it("returns the word box containing the point in word mode", () => {
    expect(boxAtPoint(boxes, { x: 20, y: 15 }, "word")).toEqual({ x: 10, y: 10, w: 30, h: 14 });
  });

  it("returns the whole line box containing the point in line mode", () => {
    expect(boxAtPoint(boxes, { x: 20, y: 15 }, "line")).toEqual({ x: 10, y: 10, w: 80, h: 14 });
  });

  it("returns the second word when the point is inside it", () => {
    expect(boxAtPoint(boxes, { x: 70, y: 15 }, "word")).toEqual({ x: 50, y: 10, w: 40, h: 14 });
  });

  it("returns the nearest box when the point is outside every box", () => {
    // Just below the first line, closer to it than to the second line.
    expect(boxAtPoint(boxes, { x: 20, y: 30 }, "word")).toEqual({ x: 10, y: 10, w: 30, h: 14 });
  });

  it("returns null when the nearest box is beyond the max distance", () => {
    expect(boxAtPoint(boxes, { x: 200, y: 200 }, "word", 20)).toBeNull();
  });

  it("returns the box when it is within the max distance", () => {
    // The gap from y=15 down to the second line at y0=40 is 16 px on the word.
    expect(boxAtPoint(boxes, { x: 40, y: 56 }, "word", 10)).toEqual({ x: 10, y: 40, w: 60, h: 14 });
  });

  it("returns null for an empty box list", () => {
    expect(boxAtPoint([], { x: 0, y: 0 }, "word")).toBeNull();
  });

  it("defaults to word mode", () => {
    expect(boxAtPoint(boxes, { x: 20, y: 15 })).toEqual({ x: 10, y: 10, w: 30, h: 14 });
  });
});

/* ------------------------------------------------------------------ */
/* applySolidRect                                                      */
/* ------------------------------------------------------------------ */

describe("applySolidRect", () => {
  it("replaces every pixel in the rectangle with the color and leaves the rest alone", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 2, y: 1, w: 3, h: 4 };

    const written = applySolidRect(data, W, H, rect, [0, 0, 0]);

    expect(written).toEqual(rect);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        expect(pixelAt(data, W, x, y)).toEqual([0, 0, 0, 255]);
      }
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it("destroys the original values rather than covering them", () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 0, y: 0, w: W, h: H }, [0, 0, 0]);
    // Not one red or blue sample survives anywhere in the buffer.
    expect(Array.from(data).some((v, i) => i % 4 !== 3 && v !== 0)).toBe(false);
  });

  it("writes white when white is chosen and forces alpha opaque", () => {
    const data = checkerboard(W, H);
    // Make the target region fully transparent first.
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) data[(y * W + x) * 4 + 3] = 0;
    }
    applySolidRect(data, W, H, { x: 0, y: 0, w: 2, h: 2 }, [255, 255, 255]);
    expect(pixelAt(data, W, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(data, W, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it("clamps a rectangle that runs past the edge instead of writing out of bounds", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applySolidRect(data, W, H, { x: 6, y: 6, w: 100, h: 100 }, [0, 0, 0]);

    expect(pixelAt(data, W, 7, 7)).toEqual([0, 0, 0, 255]);
    expectOutsideUntouched(data, pristine, W, H, { x: 6, y: 6, w: 2, h: 2 });
    expect(data.length).toBe(W * H * 4);
  });

  it("is a no-op for a rectangle entirely outside the image", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    expect(applySolidRect(data, W, H, { x: -50, y: -50, w: 10, h: 10 }, [0, 0, 0])).toBeNull();
    expect(Array.from(data)).toEqual(Array.from(pristine));
  });

  it("defaults to black when no color is passed", () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 1, y: 1, w: 2, h: 2 });
    expect(pixelAt(data, W, 1, 1)).toEqual([0, 0, 0, 255]);
  });
});

/* ------------------------------------------------------------------ */
/* applyPixelateRect                                                   */
/* ------------------------------------------------------------------ */

describe("applyPixelateRect", () => {
  it("makes each block uniform and leaves the rest of the image alone", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 0, y: 0, w: 4, h: 4 };

    applyPixelateRect(data, W, H, rect, 2);

    // Each 2x2 block holds one color.
    for (let by = 0; by < 4; by += 2) {
      for (let bx = 0; bx < 4; bx += 2) {
        const first = pixelAt(data, W, bx, by);
        expect(pixelAt(data, W, bx + 1, by)).toEqual(first);
        expect(pixelAt(data, W, bx, by + 1)).toEqual(first);
        expect(pixelAt(data, W, bx + 1, by + 1)).toEqual(first);
      }
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it("averages the four channels of a block", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 2, h: 2 }, 2);

    // Source 2x2: two red (255,0,0) and two blue (0,0,255); alphas 200,201,201,202.
    expect(pixelAt(data, W, 0, 0)).toEqual([128, 0, 128, 201]);
  });

  it("clips an edge block to the rectangle instead of sampling past it", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 0, y: 0, w: 3, h: 3 };

    applyPixelateRect(data, W, H, rect, 2);

    // The trailing column is a 1x2 block, so it keeps its own two pixels averaged.
    const top = pixelAt(pristine, W, 2, 0);
    const bottom = pixelAt(pristine, W, 2, 1);
    const expected = top.map((v, i) => Math.round((v + bottom[i]!) / 2));
    expect(pixelAt(data, W, 2, 0)).toEqual(expected);
    expect(pixelAt(data, W, 2, 1)).toEqual(expected);
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it("collapses the whole rectangle to one color when the block is bigger than the rect", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 1, y: 1, w: 3, h: 3 };

    applyPixelateRect(data, W, H, rect, 64);

    const first = pixelAt(data, W, 1, 1);
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) expect(pixelAt(data, W, x, y)).toEqual(first);
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it("treats a block size below one as a single pixel block, leaving pixels unchanged", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 0);

    expect(Array.from(data)).toEqual(Array.from(pristine));
  });

  it("clamps a rectangle that runs past the edge", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    const written = applyPixelateRect(data, W, H, { x: 5, y: 5, w: 50, h: 50 }, 4);

    expect(written).toEqual({ x: 5, y: 5, w: 3, h: 3 });
    expectOutsideUntouched(data, pristine, W, H, { x: 5, y: 5, w: 3, h: 3 });
  });

  it("is a no-op for a rectangle entirely outside the image", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    expect(applyPixelateRect(data, W, H, { x: 100, y: 0, w: 4, h: 4 }, 4)).toBeNull();
    expect(Array.from(data)).toEqual(Array.from(pristine));
  });
});

/* ------------------------------------------------------------------ */
/* applyPixelateRect randomness                                        */
/* ------------------------------------------------------------------ */

describe("applyPixelateRect seeded randomness", () => {
  const rect = { x: 0, y: 0, w: 6, h: 6 };

  it("is byte identical to a plain block average at strength 0", () => {
    const plain = checkerboard(W, H);
    const perturbed = new Uint8ClampedArray(plain);

    applyPixelateRect(plain, W, H, rect, 2);
    applyPixelateRect(perturbed, W, H, rect, 2, { seed: 12345, strength: 0 });

    expect(Array.from(perturbed)).toEqual(Array.from(plain));
  });

  it("is byte identical to a plain block average when no perturbation options are passed", () => {
    const plain = checkerboard(W, H);
    const bare = new Uint8ClampedArray(plain);

    applyPixelateRect(plain, W, H, rect, 2);
    applyPixelateRect(bare, W, H, rect, 2);

    expect(Array.from(bare)).toEqual(Array.from(plain));
  });

  it("produces the same output every time for the same seed and strength", () => {
    const a = checkerboard(W, H);
    const b = checkerboard(W, H);

    applyPixelateRect(a, W, H, rect, 2, { seed: 42, strength: 0.6 });
    applyPixelateRect(b, W, H, rect, 2, { seed: 42, strength: 0.6 });

    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("diverges from the plain average once strength is above 0", () => {
    const plain = checkerboard(W, H);
    const perturbed = new Uint8ClampedArray(plain);

    applyPixelateRect(plain, W, H, rect, 2);
    applyPixelateRect(perturbed, W, H, rect, 2, { seed: 7, strength: 0.6 });

    expect(Array.from(perturbed)).not.toEqual(Array.from(plain));
  });

  it("produces different output for different seeds at the same strength", () => {
    const a = checkerboard(W, H);
    const b = checkerboard(W, H);

    applyPixelateRect(a, W, H, rect, 2, { seed: 1, strength: 0.6 });
    applyPixelateRect(b, W, H, rect, 2, { seed: 2, strength: 0.6 });

    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("keeps every channel within the 0 to 255 byte range even at strength 1", () => {
    const data = checkerboard(W, H);
    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 8, h: 8 }, 2, { seed: 99, strength: 1 });
    for (const v of Array.from(data)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it("leaves pixels outside the rectangle untouched with perturbation on", () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const innerRect = { x: 1, y: 1, w: 3, h: 3 };

    applyPixelateRect(data, W, H, innerRect, 2, { seed: 9, strength: 0.8 });

    expectOutsideUntouched(data, pristine, W, H, innerRect);
  });
});

/* ------------------------------------------------------------------ */
/* mulberry32                                                          */
/* ------------------------------------------------------------------ */

describe("mulberry32", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(5678);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("stays within the unit interval", () => {
    const next = mulberry32(0);
    for (let i = 0; i < 50; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* ordering                                                            */
/* ------------------------------------------------------------------ */

describe("overlapping regions", () => {
  it("applies regions in list order, so a later solid wins over an earlier pixelate", () => {
    const data = checkerboard(W, H);
    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 2);
    applySolidRect(data, W, H, { x: 2, y: 2, w: 4, h: 4 }, [0, 0, 0]);
    expect(pixelAt(data, W, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it("applies regions in list order, so a later pixelate averages the earlier solid", () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, [255, 255, 255]);
    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 4);
    expect(pixelAt(data, W, 1, 1)).toEqual([255, 255, 255, 255]);
  });
});

/* ------------------------------------------------------------------ */
/* suggestExportName                                                   */
/* ------------------------------------------------------------------ */

describe("suggestExportName", () => {
  it("adds the redacted suffix and keeps the png extension", () => {
    expect(suggestExportName("shot.png")).toBe("shot-redacted.png");
  });

  it("uses a jpg extension when exporting as JPEG", () => {
    expect(suggestExportName("shot.png", "jpeg")).toBe("shot-redacted.jpg");
  });

  it("falls back to a generic stem when there is no filename", () => {
    expect(suggestExportName("")).toBe("image-redacted.png");
    expect(suggestExportName("   ")).toBe("image-redacted.png");
  });

  it("does not stack the suffix when re-redacting its own output", () => {
    expect(suggestExportName("shot-redacted.png")).toBe("shot-redacted.png");
  });

  it("keeps dots inside the name and drops any directory part", () => {
    expect(suggestExportName("Screen Shot 2026.08.06.png")).toBe(
      "Screen Shot 2026.08.06-redacted.png",
    );
    expect(suggestExportName("C:\\Users\\me\\shot.jpeg", "jpeg")).toBe("shot-redacted.jpg");
  });

  it("handles a dotfile style name with no extension", () => {
    expect(suggestExportName("screenshot")).toBe("screenshot-redacted.png");
  });

  it("falls back to png for an unknown format", () => {
    expect(suggestExportName("shot.webp", "webp")).toBe("shot-redacted.png");
  });
});

/* ------------------------------------------------------------------ */
/* sniffImageFormat                                                    */
/* ------------------------------------------------------------------ */

describe("sniffImageFormat", () => {
  it("names the common containers from their magic bytes", () => {
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe("PNG");
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("JPEG");
    expect(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("GIF");
    expect(sniffImageFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe("BMP");
  });

  it("reports unknown for bytes it does not recognize", () => {
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("reports what was loaded and how to drive the panel", () => {
    const png = new Uint8Array(2048);
    png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 0);

    const rows = run(png, {});

    expect(rows.Loaded).toBe("PNG image, 2.0 KB.");
    expect(rows.Mode).toContain("Solid fill, black");
    expect(rows["How to use"]).toContain("drag a rectangle");
    expect(rows.Privacy).toContain("your files and inputs never leave your device");
  });

  it("warns that pixelate is the weaker choice when pixelate is selected", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const rows = run(jpeg, { mode: "pixelate", blockSize: 20 });
    expect(rows.Mode).toContain("20 px blocks");
    expect(rows.Mode).toContain("solid fill is the safer choice");
  });

  it("explains that the export is re-encoded and carries no metadata", () => {
    const rows = run(new Uint8Array([0x42, 0x4d, 1, 2]), { format: "jpeg" });
    expect(rows.Export).toContain("re-encoded from the canvas");
    expect(rows.Export).toContain("screenshot-redacted.jpg");
  });

  it("tells a text paste that this tool wants an image", () => {
    const rows = run("hello", {});
    expect(rows.Input).toContain("This tool redacts images");
    expect(rows["Why solid"]).toContain("Solid fill is the default");
  });

  it("handles an empty string as no image loaded yet", () => {
    const rows = run("", {});
    expect(rows.Input).toBe("No image loaded yet.");
  });

  it("throws a ToolError for an empty file", () => {
    expect(() => run(new Uint8Array(0), {})).toThrow(ToolError);
    try {
      run(new Uint8Array(0), {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-file");
      expect((e as ToolError).fix).toContain("screenshot");
    }
  });
});
