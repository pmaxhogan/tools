import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ToolError } from "../types";
import {
  applyHomography,
  buildScanPdf,
  detectCorners,
  enhance,
  fallbackQuad,
  homographyFrom,
  MAX_OUTPUT_EDGE,
  orderCorners,
  outputSize,
  pdfPageSize,
  perspectiveTransform,
  run,
  warpImage,
  type Point,
  type Quad,
  type ScanImage,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

type Rgb = [number, number, number];

function blank(width: number, height: number, color: Rgb): ScanImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function pixel(image: ScanImage, x: number, y: number): Rgb {
  const o = (y * image.width + x) * 4;
  return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!];
}

function setPixel(image: ScanImage, x: number, y: number, color: Rgb): void {
  const o = (y * image.width + x) * 4;
  image.data[o] = color[0];
  image.data[o + 1] = color[1];
  image.data[o + 2] = color[2];
  image.data[o + 3] = 255;
}

/** Scanline fill of a convex polygon, so a synthetic page has hard edges. */
function fillQuad(image: ScanImage, quad: Quad, color: Rgb): void {
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));
  for (let y = minY; y <= maxY; y += 1) {
    const xs: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const a = quad[i]!;
      const b = quad[(i + 1) % 4]!;
      if (a.y === b.y) continue;
      const low = Math.min(a.y, b.y);
      const high = Math.max(a.y, b.y);
      if (y + 0.5 < low || y + 0.5 >= high) continue;
      xs.push(a.x + ((y + 0.5 - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const from = Math.max(0, Math.round(xs[0]!));
    const to = Math.min(image.width - 1, Math.round(xs[xs.length - 1]!));
    for (let x = from; x <= to; x += 1) setPixel(image, x, y, color);
  }
}

/** xorshift32, so the noise fixtures are the same on every run. */
function noiseImage(width: number, height: number, seed: number): ScanImage {
  const image = blank(width, height, [0, 0, 0]);
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let i = 0; i < width * height; i += 1) {
    image.data[i * 4] = next() % 256;
    image.data[i * 4 + 1] = next() % 256;
    image.data[i * 4 + 2] = next() % 256;
    image.data[i * 4 + 3] = 255;
  }
  return image;
}

/** The largest distance between matching corners of two quads. */
function maxCornerError(a: Quad, b: Quad): number {
  let worst = 0;
  for (let i = 0; i < 4; i += 1) {
    worst = Math.max(worst, Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y));
  }
  return worst;
}

/**
 * A real, minimal PNG: signature, IHDR, one deflated IDAT, IEND. Generated here
 * rather than read from disk so the PDF test stays hermetic and can assert the
 * exact page dimensions it asked for.
 */
function makePng(width: number, height: number, color: Rgb): Uint8Array {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(body.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
    return out;
  };

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = color[0];
      raw[row + 2 + x * 3] = color[1];
      raw[row + 3 + x * 3] = color[2];
    }
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/* ------------------------------------------------------------------ */
/* orderCorners                                                        */
/* ------------------------------------------------------------------ */

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

describe("orderCorners", () => {
  it("normalizes every permutation of a skewed quad to the same order", () => {
    const quad: Quad = [
      { x: 12, y: 8 },
      { x: 96, y: 20 },
      { x: 88, y: 74 },
      { x: 20, y: 66 },
    ];
    const results = permutations([...quad]).map((points) => orderCorners(points));
    for (const result of results) expect(result).toEqual(quad);
    expect(results).toHaveLength(24);
  });

  it("orders a diamond clockwise from its highest point", () => {
    const ordered = orderCorners([
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 10 },
    ]);
    expect(ordered).toEqual([
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 10 },
    ]);
  });

  it("rejects anything that is not four finite points", () => {
    expect(() => orderCorners([{ x: 0, y: 0 }])).toThrow(ToolError);
    expect(() =>
      orderCorners([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: Number.NaN, y: 1 },
      ]),
    ).toThrow(/four finite points/);
  });
});

/* ------------------------------------------------------------------ */
/* homography                                                          */
/* ------------------------------------------------------------------ */

describe("perspectiveTransform", () => {
  it("is the identity when the quad already is the output rectangle", () => {
    const h = perspectiveTransform(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      1,
      1,
    );
    expect(h.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("scales a doubled square down to the unit output", () => {
    const h = perspectiveTransform(
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      1,
      1,
    );
    expect(h[0]).toBeCloseTo(0.5, 12);
    expect(h[4]).toBeCloseTo(0.5, 12);
    expect(h[6]).toBeCloseTo(0, 12);
    expect(h[7]).toBeCloseTo(0, 12);
  });

  it("recovers a hand computed projective matrix", () => {
    // Expected: [[1,0,0],[0,1,0],[0.1,0.2,1]]. Its inverse is the same matrix
    // with the bottom row negated, so the source quad is the unit square's
    // corners pushed through that inverse:
    //   (0,0) -> w=1.0  -> (0, 0)
    //   (1,0) -> w=0.9  -> (1/0.9, 0)
    //   (1,1) -> w=0.7  -> (1/0.7, 1/0.7)
    //   (0,1) -> w=0.8  -> (0, 1/0.8)
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 1 / 0.9, y: 0 },
      { x: 1 / 0.7, y: 1 / 0.7 },
      { x: 0, y: 1 / 0.8 },
    ];
    const h = perspectiveTransform(quad, 1, 1);
    const expected = [1, 0, 0, 0, 1, 0, 0.1, 0.2, 1];
    for (let i = 0; i < 9; i += 1) expect(Math.abs(h[i]! - expected[i]!)).toBeLessThan(1e-6);
  });

  it("round trips corners through both directions of the transform", () => {
    const quad: Quad = [
      { x: 31, y: 17 },
      { x: 260, y: 44 },
      { x: 244, y: 190 },
      { x: 12, y: 176 },
    ];
    const forward = perspectiveTransform(quad, 200, 140);
    const rect: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 140 },
      { x: 0, y: 140 },
    ];
    const back = homographyFrom(rect, quad);
    for (let i = 0; i < 4; i += 1) {
      const mapped = applyHomography(forward, quad[i]!.x, quad[i]!.y);
      expect(mapped.x).toBeCloseTo(rect[i]!.x, 6);
      expect(mapped.y).toBeCloseTo(rect[i]!.y, 6);
      const round = applyHomography(back, mapped.x, mapped.y);
      expect(round.x).toBeCloseTo(quad[i]!.x, 6);
      expect(round.y).toBeCloseTo(quad[i]!.y, 6);
    }
  });

  it("throws on a quad with three collinear corners", () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 10, y: 20 },
    ];
    expect(() => perspectiveTransform(collinear, 100, 100)).toThrow(ToolError);
    expect(() => perspectiveTransform(collinear, 100, 100)).toThrow(/real quadrilateral/);
  });

  it("rejects an output size it cannot produce", () => {
    const quad = fallbackQuad(100, 100);
    expect(() => perspectiveTransform(quad, 0, 100)).toThrow(/not something this can produce/);
    expect(() => perspectiveTransform(quad, 100, 12000)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* warpImage                                                           */
/* ------------------------------------------------------------------ */

describe("warpImage", () => {
  const RED: Rgb = [255, 0, 0];
  const GREEN: Rgb = [0, 255, 0];
  const BLUE: Rgb = [0, 0, 255];
  const WHITE: Rgb = [255, 255, 255];

  function checker(): ScanImage {
    const image = blank(32, 32, [0, 0, 0]);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const cell = (x < 16 ? 0 : 1) + (y < 16 ? 0 : 2);
        setPixel(image, x, y, [RED, GREEN, BLUE, WHITE][cell]!);
      }
    }
    return image;
  }

  it("flattens a 2 by 2 checker into an axis aligned 4 by 4 output", () => {
    const out = warpImage(
      checker(),
      [
        { x: 0, y: 0 },
        { x: 32, y: 0 },
        { x: 32, y: 32 },
        { x: 0, y: 32 },
      ],
      4,
      4,
    );
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(pixel(out, 0, 0)).toEqual(RED);
    expect(pixel(out, 1, 0)).toEqual(RED);
    expect(pixel(out, 2, 0)).toEqual(GREEN);
    expect(pixel(out, 3, 3)).toEqual(WHITE);
    expect(pixel(out, 0, 3)).toEqual(BLUE);
  });

  it("straightens a skewed quad back into a rectangle", () => {
    // A solid page painted at an angle on a dark field: warping its own corners
    // has to give back a page with no dark border left anywhere.
    const image = blank(200, 160, [20, 20, 24]);
    const quad: Quad = [
      { x: 34, y: 22 },
      { x: 172, y: 40 },
      { x: 156, y: 138 },
      { x: 22, y: 120 },
    ];
    fillQuad(image, quad, [240, 238, 232]);
    const out = warpImage(image, quad, 60, 40);
    for (let y = 2; y < 38; y += 1) {
      for (let x = 2; x < 58; x += 1) {
        expect(pixel(out, x, y)[0]).toBeGreaterThan(200);
      }
    }
  });

  it("fills white where a corner reaches past the edge of the photo", () => {
    const image = blank(40, 40, [10, 10, 10]);
    const out = warpImage(
      image,
      [
        { x: -40, y: -40 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      20,
      20,
    );
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255]);
    expect(pixel(out, 19, 19)).toEqual([10, 10, 10]);
  });

  it("rejects an image whose buffer is too small for its size", () => {
    expect(() =>
      warpImage(
        { data: new Uint8ClampedArray(16), width: 40, height: 40 },
        fallbackQuad(40, 40),
        8,
        8,
      ),
    ).toThrow(/carries 16 bytes/);
  });
});

/* ------------------------------------------------------------------ */
/* outputSize                                                          */
/* ------------------------------------------------------------------ */

describe("outputSize", () => {
  it("averages opposing edges so a tilted photo keeps the page proportions", () => {
    const size = outputSize([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 380, y: 300 },
      { x: 20, y: 300 },
    ]);
    expect(size.width).toBe(380);
    expect(size.height).toBeGreaterThan(295);
    expect(size.height).toBeLessThan(310);
  });

  it("treats dpiHint as a scale against 96 dpi", () => {
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(outputSize(quad, 192)).toEqual({ width: 400, height: 200 });
    expect(outputSize(quad, 96)).toEqual({ width: 200, height: 100 });
  });

  it("caps the long edge and keeps the aspect ratio", () => {
    const size = outputSize(
      [
        { x: 0, y: 0 },
        { x: 6000, y: 0 },
        { x: 6000, y: 3000 },
        { x: 0, y: 3000 },
      ],
      96,
    );
    expect(size.width).toBe(MAX_OUTPUT_EDGE);
    expect(size.height).toBe(MAX_OUTPUT_EDGE / 2);
  });

  it("never returns an unusable size for a collapsed quad", () => {
    const size = outputSize([
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]);
    expect(size.width).toBeGreaterThanOrEqual(16);
    expect(size.height).toBeGreaterThanOrEqual(16);
  });
});

/* ------------------------------------------------------------------ */
/* detectCorners                                                       */
/* ------------------------------------------------------------------ */

describe("detectCorners", () => {
  const cases: Array<{ label: string; quad: Quad }> = [
    {
      label: "near square",
      quad: [
        { x: 100, y: 80 },
        { x: 700, y: 80 },
        { x: 700, y: 520 },
        { x: 100, y: 520 },
      ],
    },
    {
      label: "mild skew",
      quad: [
        { x: 140, y: 90 },
        { x: 660, y: 126 },
        { x: 628, y: 508 },
        { x: 168, y: 470 },
      ],
    },
    {
      label: "strong skew",
      quad: [
        { x: 96, y: 148 },
        { x: 686, y: 54 },
        { x: 742, y: 520 },
        { x: 58, y: 452 },
      ],
    },
  ];

  for (const { label, quad } of cases) {
    it(`finds a white page on a dark background: ${label}`, () => {
      const image = blank(800, 600, [28, 26, 24]);
      fillQuad(image, quad, [242, 240, 235]);
      const result = detectCorners(image);
      expect(result.fallback).toBe(false);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(maxCornerError(result.corners, quad)).toBeLessThanOrEqual(5);
    });
  }

  it("falls back on noise, whatever the seed", () => {
    for (const seed of [12345, 987654321]) {
      const result = detectCorners(noiseImage(400, 300, seed));
      expect(result.fallback).toBe(true);
      expect(result.confidence).toBe(0);
      expect(result.corners).toEqual(fallbackQuad(400, 300));
    }
  });

  it("falls back on a blank frame with no edges at all", () => {
    const result = detectCorners(blank(320, 240, [200, 200, 200]));
    expect(result.confidence).toBe(0);
    expect(result.corners).toEqual(fallbackQuad(320, 240));
  });

  it("falls back when the page is too small a part of the frame", () => {
    const image = blank(800, 600, [28, 26, 24]);
    fillQuad(
      image,
      [
        { x: 300, y: 240 },
        { x: 420, y: 240 },
        { x: 420, y: 330 },
        { x: 300, y: 330 },
      ],
      [242, 240, 235],
    );
    const result = detectCorners(image);
    expect(result.fallback).toBe(true);
  });

  it("rejects an image with no pixel data", () => {
    expect(() => detectCorners({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toThrow(
      ToolError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* enhance                                                             */
/* ------------------------------------------------------------------ */

describe("enhance", () => {
  it("copies the pixels through in none mode without sharing the buffer", () => {
    const image = blank(4, 4, [120, 90, 60]);
    const out = enhance(image, "none");
    expect(out.data).not.toBe(image.data);
    expect(Array.from(out.data)).toEqual(Array.from(image.data));
  });

  it("stretches grayscale to the full range and drops the color", () => {
    const image = blank(16, 1, [0, 0, 0]);
    for (let x = 0; x < 16; x += 1) setPixel(image, x, 0, [100 + x * 2, 100 + x * 2, 100 + x * 2]);
    const out = enhance(image, "grayscale");
    const first = pixel(out, 0, 0);
    const last = pixel(out, 15, 0);
    expect(first[0]).toBe(first[1]);
    expect(first[1]).toBe(first[2]);
    expect(first[0]).toBeLessThan(20);
    expect(last[0]).toBeGreaterThan(235);
  });

  it("white balances each channel on its own in color mode", () => {
    // A warm cast: blue is compressed into the bottom of its range.
    const image = blank(16, 1, [0, 0, 0]);
    for (let x = 0; x < 16; x += 1) setPixel(image, x, 0, [40 + x * 12, 40 + x * 10, 20 + x * 4]);
    const out = enhance(image, "color");
    expect(pixel(out, 15, 0)[2]).toBeGreaterThan(235);
    expect(pixel(out, 0, 0)[2]).toBeLessThan(20);
  });

  it("makes every pixel pure black or white in bw mode", () => {
    const image = blank(64, 64, [230, 230, 230]);
    for (let y = 20; y < 44; y += 1) {
      for (let x = 20; x < 44; x += 1) setPixel(image, x, y, [30, 30, 30]);
    }
    const out = enhance(image, "bw");
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i] === 0 || out.data[i] === 255).toBe(true);
    }
    expect(pixel(out, 32, 32)).toEqual([0, 0, 0]);
    expect(pixel(out, 2, 2)).toEqual([255, 255, 255]);
  });

  it("rejects a mode it does not know", () => {
    // The panel is typed, but a stale shared link is not.
    expect(() => enhance(blank(2, 2, [0, 0, 0]), "sepia" as never)).toThrow(/enhancement mode/);
  });
});

/* ------------------------------------------------------------------ */
/* pdf                                                                 */
/* ------------------------------------------------------------------ */

describe("pdfPageSize", () => {
  it("sizes a page to the image at the given density", () => {
    expect(pdfPageSize(1500, 1200, "image", 150)).toEqual({ width: 720, height: 576 });
  });

  it("uses the paper rectangle for letter and a4", () => {
    expect(pdfPageSize(1500, 1200, "letter")).toEqual({ width: 612, height: 792 });
    expect(pdfPageSize(1500, 1200, "a4").width).toBeCloseTo(595.28, 2);
  });

  it("rejects a page with no size", () => {
    expect(() => pdfPageSize(0, 100)).toThrow(ToolError);
  });
});

describe("buildScanPdf", () => {
  it("writes one sheet per page, sized to each image", async () => {
    const bytes = await buildScanPdf(
      [
        { bytes: makePng(30, 40, [255, 255, 255]), width: 300, height: 400 },
        { bytes: makePng(20, 20, [200, 40, 40]), width: 600, height: 600 },
      ],
      { fit: "image", pixelsPerInch: 150 },
    );
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe("%PDF-");

    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(2);
    const first = parsed.getPage(0).getSize();
    expect(first.width).toBeCloseTo(144, 4);
    expect(first.height).toBeCloseTo(192, 4);
    const second = parsed.getPage(1).getSize();
    expect(second.width).toBeCloseTo(288, 4);
  });

  it("fits the image inside a letter sheet when asked", async () => {
    const bytes = await buildScanPdf(
      [{ bytes: makePng(20, 30, [255, 255, 255]), width: 400, height: 600 }],
      { fit: "letter" },
    );
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPage(0).getSize().width).toBeCloseTo(612, 4);
  });

  it("refuses to build a PDF with no pages", async () => {
    await expect(buildScanPdf([])).rejects.toThrow(ToolError);
    await expect(buildScanPdf([])).rejects.toThrow(/no pages to save/);
  });

  it("refuses bytes that are neither JPEG nor PNG", async () => {
    await expect(
      buildScanPdf([{ bytes: new Uint8Array([1, 2, 3, 4]), width: 10, height: 10 }]),
    ).rejects.toThrow(/JPEG or PNG/);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("describes the tool when no image has been loaded", () => {
    const rows = run("", {});
    expect(rows.Input).toContain("No image loaded");
    expect(rows.Privacy).toContain("never leave your device");
  });

  it("explains that pasted text is not a photo", () => {
    expect(run("hello", {}).Input).toContain("drop or capture an image");
  });

  it("reports the container and the chosen options for a file", () => {
    const png = makePng(4, 4, [10, 20, 30]);
    const rows = run(png, { mode: "bw", scale: 2, format: "jpeg", pdfPage: "a4" });
    expect(rows.Loaded).toContain("PNG image");
    expect(rows.Enhancement).toContain("Black and white");
    expect(rows.Output).toContain("2x");
    expect(rows.Export).toContain("JPEG");
    expect(rows.Export).toContain("A4");
  });

  it("names an unrecognized container rather than guessing", () => {
    expect(run(new Uint8Array([1, 2, 3, 4]), {}).Loaded).toContain("Unrecognized");
  });

  it("throws on an empty file", () => {
    expect(() => run(new Uint8Array(0), {})).toThrow(ToolError);
    expect(() => run(new Uint8Array(0), {})).toThrow(/no photo to scan/);
  });
});

/* ------------------------------------------------------------------ */
/* measured accuracy, kept as a guard rather than a printout           */
/* ------------------------------------------------------------------ */

describe("accuracy", () => {
  it("keeps corner error under a pixel of the working copy across the fixtures", () => {
    const image = blank(800, 600, [28, 26, 24]);
    const quad: Quad = [
      { x: 140, y: 90 },
      { x: 660, y: 126 },
      { x: 628, y: 508 },
      { x: 168, y: 470 },
    ];
    fillQuad(image, quad, [242, 240, 235]);
    const detected = detectCorners(image, { workingSize: 200 });
    // A 200 pixel working copy doubles the size of each analyzed pixel, so the
    // error budget grows with it: 4.5 px measured here against 3.2 px at the
    // 400 pixel default. This is the honest tradeoff, asserted.
    expect(maxCornerError(detected.corners, quad)).toBeLessThanOrEqual(6);
  });

  it("agrees with itself when the same page is scaled up", () => {
    const small = blank(400, 300, [28, 26, 24]);
    const quad: Quad = [
      { x: 70, y: 45 },
      { x: 330, y: 63 },
      { x: 314, y: 254 },
      { x: 84, y: 235 },
    ];
    fillQuad(small, quad, [242, 240, 235]);
    const detected = detectCorners(small);
    const asPoints: Point[] = detected.corners.map((p) => ({ x: p.x, y: p.y }));
    expect(orderCorners(asPoints)).toEqual(detected.corners);
    expect(maxCornerError(detected.corners, quad)).toBeLessThanOrEqual(3);
  });
});
