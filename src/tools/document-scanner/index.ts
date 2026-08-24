import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Document scanning math: find the page in a photo, flatten it, clean it up.
 *
 * Everything here is plain pixel and geometry work on `{ data, width, height }`
 * buffers, so it runs identically in Node and in the browser and is unit tested
 * against synthetic images. The panel decodes a photo or a camera frame once,
 * hands the raw ImageData to these functions, and paints the results. Nothing
 * in this module touches the DOM.
 *
 * The pipeline is deliberately heuristic rather than a computer vision port:
 * downscale, grayscale, Sobel, adaptive threshold, take the strongest connected
 * edge region, reduce its convex hull to four corners, and score the result.
 * A photo of a page on a contrasting surface lands within a few pixels; a busy
 * scene often does not, which is why the corners are draggable in the panel and
 * why every detection carries an honest confidence instead of pretending.
 */

/** An RGBA image buffer. Shaped like ImageData so a canvas result drops in. */
export interface ScanImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A point in image pixel space. Top left origin, y grows downward. */
export interface Point {
  x: number;
  y: number;
}

/** Four corners in a stable order: top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point];

/**
 * A 3x3 projective matrix in row major order, normalized so the last entry is
 * 1. Maps (x, y) to ((h0x + h1y + h2) / w, (h3x + h4y + h5) / w) with
 * w = h6x + h7y + h8.
 */
export type Homography = [number, number, number, number, number, number, number, number, number];

export type EnhanceMode = "none" | "bw" | "grayscale" | "color";

export interface DetectOpts {
  /** Longest edge of the working copy the detector analyzes. Smaller is faster. */
  workingSize?: number;
  /** A quad smaller than this fraction of the frame is rejected. */
  minAreaFraction?: number;
  /** A quad with any corner sharper than this many degrees is rejected. */
  minAngleDeg?: number;
  /** Fraction of pixels kept as strong edges when the gradient is noisy. */
  edgePercentile?: number;
  /** Inset of the fallback quad, as a fraction of the frame. */
  fallbackMargin?: number;
}

export interface DetectResult {
  /** Corners in original image coordinates, ordered top left, top right, bottom right, bottom left. */
  corners: Quad;
  /** 0 to 1. How much of the quad's outline is backed by real edge pixels, penalized for odd angles. */
  confidence: number;
  /** True when nothing convincing was found and the corners are the inset default. */
  fallback: boolean;
}

/** One page handed to the PDF builder: encoded image bytes plus its pixel size. */
export interface ScanPdfPage {
  /** JPEG or PNG bytes. The format is sniffed from the first bytes. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ScanPdfOpts {
  /**
   * "image" sizes each page to its image at `pixelsPerInch`; "letter" and "a4"
   * fit the image inside that paper size, centered, aspect preserved.
   */
  fit?: "image" | "letter" | "a4";
  /** Assumed pixel density for `fit: "image"`. 150 keeps a phone photo near paper size. */
  pixelsPerInch?: number;
}

export interface ScannerOpts {
  mode?: EnhanceMode;
  /** Output scale relative to the measured page size. 1 keeps the photo's own resolution. */
  scale?: number;
  format?: "png" | "jpeg";
  pdfPage?: "image" | "letter" | "a4";
  [key: string]: unknown;
}

export type ScannerResult = Record<string, string>;

/** Longest edge the warp will produce. Past this the file grows without gaining detail. */
export const MAX_OUTPUT_EDGE = 2400;
/** Shortest edge the warp will produce, so a sliver quad still yields a usable image. */
export const MIN_OUTPUT_EDGE = 16;
/** The dpi that `outputSize`'s dpiHint is measured against, matching a CSS pixel. */
const BASE_DPI = 96;
/** PDF points per inch. Fixed by the format. */
const POINTS_PER_INCH = 72;
/** Paper sizes in points, for the PDF page fit choices. */
const PAPER_POINTS = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 },
} as const;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function isFinitePoint(p: Point | undefined): p is Point {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function assertImage(image: ScanImage, what = "image"): void {
  const w = image?.width;
  const h = image?.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new ToolError(
      "invalid-image",
      `That ${what} has no usable size (${String(w)} by ${String(h)} pixels).`,
      "Pass an image with a width and a height of at least one pixel.",
    );
  }
  if (!image.data || image.data.length < w * h * 4) {
    throw new ToolError(
      "invalid-image",
      `That ${what} carries ${String(image?.data?.length ?? 0)} bytes, but ${w} by ${h} pixels needs ${w * h * 4}.`,
      "Pass RGBA pixel data, four bytes per pixel, the same shape as canvas ImageData.",
    );
  }
}

function assertQuad(corners: Quad, what = "quad"): void {
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(isFinitePoint)) {
    throw new ToolError(
      "invalid-quad",
      `That ${what} is not four finite points.`,
      "Pass exactly four corners, each with numeric x and y.",
    );
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shoelace area of a polygon, always positive. */
function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/* ------------------------------------------------------------------ */
/* corner ordering                                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalize any four points to top left, top right, bottom right, bottom left.
 *
 * Sorting by angle around the centroid gives a clockwise ring on screen (y
 * grows downward), and rotating that ring so it starts at the point nearest the
 * top left corner of the bounding box fixes which vertex is which. Ties on
 * x + y break toward the higher point, so a diamond still reads as a diamond
 * instead of flipping between runs.
 */
export function orderCorners(points: Point[]): Quad {
  if (!Array.isArray(points) || points.length !== 4 || !points.every(isFinitePoint)) {
    throw new ToolError(
      "invalid-corners",
      `Corner ordering needs exactly four finite points, and got ${String(points?.length ?? 0)}.`,
      "Pass the four detected or dragged corners, each with numeric x and y.",
    );
  }

  const cx = (points[0]!.x + points[1]!.x + points[2]!.x + points[3]!.x) / 4;
  const cy = (points[0]!.y + points[1]!.y + points[2]!.y + points[3]!.y) / 4;

  const ring = points
    .map((p) => ({ p, angle: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((a, b) => a.angle - b.angle)
    .map((entry) => entry.p);

  let start = 0;
  let best = Infinity;
  let bestY = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const p = ring[i]!;
    const score = p.x + p.y;
    if (score < best - 1e-9 || (Math.abs(score - best) <= 1e-9 && p.y < bestY)) {
      best = score;
      bestY = p.y;
      start = i;
    }
  }

  return [
    ring[start]!,
    ring[(start + 1) % 4]!,
    ring[(start + 2) % 4]!,
    ring[(start + 3) % 4]!,
  ] as Quad;
}

/** The default quad: an inset rectangle, used when detection finds nothing. */
export function fallbackQuad(width: number, height: number, margin = 0.08): Quad {
  const mx = width * margin;
  const my = height * margin;
  return [
    { x: mx, y: my },
    { x: width - mx, y: my },
    { x: width - mx, y: height - my },
    { x: mx, y: height - my },
  ];
}

/* ------------------------------------------------------------------ */
/* homography                                                          */
/* ------------------------------------------------------------------ */

/**
 * Solve a square linear system by Gaussian elimination with partial pivoting.
 *
 * Returns null when the matrix is singular for practical purposes: the pivot
 * check is relative to the largest entry in the original system, so it behaves
 * the same whether the coordinates are in tens or in thousands.
 */
function solveLinearSystem(rows: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = rows.map((row, i) => [...row, rhs[i]!]);

  let scale = 0;
  for (const row of a) for (const value of row) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return null;
  const epsilon = scale * 1e-12;

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(a[pivot]![col]!) <= epsilon) return null;
    if (pivot !== col) {
      const swap = a[col]!;
      a[col] = a[pivot]!;
      a[pivot] = swap;
    }
    const pivotRow = a[col]!;
    const pivotValue = pivotRow[col]!;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = a[row]!;
      const factor = target[col]! / pivotValue;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) target[k] = target[k]! - factor * pivotRow[k]!;
    }
  }

  return a.map((row, i) => row[n]! / row[i]!);
}

/**
 * The projective matrix taking the four `src` points to the four `dst` points,
 * normalized so h8 is 1. Throws when the quad is degenerate, which is what a
 * user dragging three handles onto one line produces.
 */
export function homographyFrom(src: Quad, dst: Quad): Homography {
  assertQuad(src, "source quad");
  assertQuad(dst, "destination quad");

  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }

  const solved = solveLinearSystem(rows, rhs);
  if (!solved || solved.some((value) => !Number.isFinite(value))) {
    throw new ToolError(
      "degenerate-quad",
      "Those four corners do not form a real quadrilateral, so the page cannot be flattened.",
      "Move the handles apart so no three of them sit on the same line.",
    );
  }

  return [...solved, 1] as Homography;
}

/** The axis aligned destination rectangle for an output of this size. */
function rectQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/**
 * The 3x3 matrix mapping the page quad onto a `outW` by `outH` rectangle.
 * The warp itself uses the opposite direction, solved separately, so the two
 * are independent matrices and both are tested.
 */
export function perspectiveTransform(corners: Quad, outW: number, outH: number): Homography {
  assertOutputSize(outW, outH);
  return homographyFrom(orderCorners([...corners]), rectQuad(outW, outH));
}

/** Push one point through a homography. Convenience for overlays and tests. */
export function applyHomography(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    throw new ToolError(
      "degenerate-homography",
      `That point maps to infinity under this transform (${x}, ${y}).`,
      "Move the corner handles so the quad is not folded over on itself.",
    );
  }
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function assertOutputSize(outW: number, outH: number): void {
  const okW = Number.isInteger(outW) && outW >= 1 && outW <= 8000;
  const okH = Number.isInteger(outH) && outH >= 1 && outH <= 8000;
  if (!okW || !okH) {
    throw new ToolError(
      "invalid-size",
      `An output of ${String(outW)} by ${String(outH)} pixels is not something this can produce.`,
      "Ask for whole pixel dimensions between 1 and 8000.",
    );
  }
}

/**
 * Flatten the quad into an axis aligned image.
 *
 * Inverse mapping: every output pixel center is pushed back through the
 * rectangle to quad matrix and sampled bilinearly, so the result has no holes.
 * Samples that land outside the source come back white, which is the right
 * answer for a document: a corner dragged past the edge of the photo reads as
 * blank paper rather than as a black wedge or a transparent notch.
 */
export function warpImage(image: ScanImage, corners: Quad, outW: number, outH: number): ScanImage {
  assertImage(image);
  assertQuad(corners);
  assertOutputSize(outW, outH);

  const ordered = orderCorners([...corners]);
  const h = homographyFrom(rectQuad(outW, outH), ordered);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = h;

  const { data, width, height } = image;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < outH; y += 1) {
    const dy = y + 0.5;
    for (let x = 0; x < outW; x += 1) {
      const dx = x + 0.5;
      const w = h6 * dx + h7 * dy + h8;
      const o = (y * outW + x) * 4;
      if (w === 0 || !Number.isFinite(w)) {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      const sx = (h0 * dx + h1 * dy + h2) / w;
      const sy = (h3 * dx + h4 * dy + h5) / w;

      if (!(sx >= 0 && sy >= 0 && sx < width && sy < height)) {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }

      const fx = sx - 0.5;
      const fy = sy - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const x1 = clamp(x0 + 1, 0, width - 1);
      const y1 = clamp(y0 + 1, 0, height - 1);
      const cx0 = clamp(x0, 0, width - 1);
      const cy0 = clamp(y0, 0, height - 1);

      const i00 = (cy0 * width + cx0) * 4;
      const i10 = (cy0 * width + x1) * 4;
      const i01 = (y1 * width + cx0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      for (let c = 0; c < 4; c += 1) {
        out[o + c] =
          data[i00 + c]! * w00 + data[i10 + c]! * w10 + data[i01 + c]! * w01 + data[i11 + c]! * w11;
      }
      out[o + 3] = 255;
    }
  }

  return { data: out, width: outW, height: outH };
}

/**
 * A sensible output size for a quad: the average of each pair of opposing
 * edges, so a photo taken at an angle comes out with the page's own proportions
 * rather than the squashed ones the camera saw.
 *
 * `dpiHint` is a plain scale relative to 96 dpi, not a claim about the source:
 * a photo carries no reliable pixel density, so 192 simply means "twice the
 * measured size". The long edge is capped at 2400 pixels, past which the file
 * grows without carrying more detail.
 */
export function outputSize(corners: Quad, dpiHint?: number): { width: number; height: number } {
  assertQuad(corners);
  const [tl, tr, br, bl] = orderCorners([...corners]);

  let width = (distance(tl, tr) + distance(bl, br)) / 2;
  let height = (distance(tl, bl) + distance(tr, br)) / 2;

  if (typeof dpiHint === "number" && Number.isFinite(dpiHint) && dpiHint > 0) {
    const scale = dpiHint / BASE_DPI;
    width *= scale;
    height *= scale;
  }

  if (!(width > 0) || !(height > 0)) {
    return { width: MIN_OUTPUT_EDGE, height: MIN_OUTPUT_EDGE };
  }

  const longest = Math.max(width, height);
  if (longest > MAX_OUTPUT_EDGE) {
    const shrink = MAX_OUTPUT_EDGE / longest;
    width *= shrink;
    height *= shrink;
  }

  return {
    width: clamp(Math.round(width), MIN_OUTPUT_EDGE, MAX_OUTPUT_EDGE),
    height: clamp(Math.round(height), MIN_OUTPUT_EDGE, MAX_OUTPUT_EDGE),
  };
}

/* ------------------------------------------------------------------ */
/* enhancement                                                         */
/* ------------------------------------------------------------------ */

/** Rec. 601 luma. Matches what the eye reads as brightness closely enough. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The value range holding all but the tails of a channel, from a 256 bin
 * histogram. Returns null when the channel is flat, so the caller leaves it
 * alone instead of amplifying nothing into everything.
 */
function stretchRange(histogram: Uint32Array, total: number, tail = 0.02): [number, number] | null {
  if (total === 0) return null;
  const cut = Math.max(1, Math.floor(total * tail));

  let low = 0;
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += histogram[i]!;
    if (seen >= cut) {
      low = i;
      break;
    }
  }

  let high = 255;
  seen = 0;
  for (let i = 255; i >= 0; i -= 1) {
    seen += histogram[i]!;
    if (seen >= cut) {
      high = i;
      break;
    }
  }

  if (high - low < 8) return null;
  return [low, high];
}

/** A 256 entry lookup table mapping [low, high] onto the full range. */
function stretchTable(low: number, high: number): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256);
  const span = high - low;
  for (let i = 0; i < 256; i += 1) table[i] = ((i - low) / span) * 255;
  return table;
}

/**
 * Local mean of the luma plane, from a summed area table. The accumulator is
 * Float64Array on purpose: a 2400 by 3200 page at full brightness sums to about
 * 1.96e9, which a signed 32 bit accumulator cannot hold.
 */
function localMeanTable(gray: Float32Array, width: number, height: number, radius: number) {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x]!;
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)]! + rowSum;
    }
  }
  return (x: number, y: number): number => {
    const x0 = clamp(x - radius, 0, width - 1);
    const y0 = clamp(y - radius, 0, height - 1);
    const x1 = clamp(x + radius, 0, width - 1);
    const y1 = clamp(y + radius, 0, height - 1);
    const stride = width + 1;
    const sum =
      integral[(y1 + 1) * stride + (x1 + 1)]! -
      integral[y0 * stride + (x1 + 1)]! -
      integral[(y1 + 1) * stride + x0]! +
      integral[y0 * stride + x0]!;
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    return sum / count;
  };
}

/**
 * Clean up a flattened page.
 *
 * - "none" copies the pixels through untouched.
 * - "grayscale" converts to luma and stretches the contrast, which is the
 *   safe default for a photo of printed text.
 * - "bw" runs a local adaptive threshold, so uneven lighting and a shadow
 *   across one corner do not swallow half the page the way one global cut
 *   would. Every output pixel is black or white.
 * - "color" stretches each channel on its own, which both lifts the contrast
 *   and pulls a warm indoor cast back toward white paper.
 */
export function enhance(image: ScanImage, mode: EnhanceMode): ScanImage {
  assertImage(image);
  if (mode !== "none" && mode !== "bw" && mode !== "grayscale" && mode !== "color") {
    throw new ToolError(
      "unknown-mode",
      `"${String(mode)}" is not an enhancement mode this tool knows.`,
      'Use one of "none", "grayscale", "color", or "bw".',
    );
  }

  const { data, width, height } = image;
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);

  if (mode === "none") {
    out.set(data.subarray(0, count * 4));
    return { data: out, width, height };
  }

  if (mode === "color") {
    const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      histograms[0]![data[o]!]! += 1;
      histograms[1]![data[o + 1]!]! += 1;
      histograms[2]![data[o + 2]!]! += 1;
    }
    const tables = histograms.map((histogram) => {
      const range = stretchRange(histogram, count);
      return range ? stretchTable(range[0], range[1]) : null;
    });
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      for (let c = 0; c < 3; c += 1) {
        const table = tables[c];
        out[o + c] = table ? table[data[o + c]!]! : data[o + c]!;
      }
      out[o + 3] = data[o + 3]!;
    }
    return { data: out, width, height };
  }

  const gray = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    gray[i] = luma(data[o]!, data[o + 1]!, data[o + 2]!);
  }

  if (mode === "grayscale") {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < count; i += 1) histogram[clamp(Math.round(gray[i]!), 0, 255)]! += 1;
    const range = stretchRange(histogram, count);
    const table = range ? stretchTable(range[0], range[1]) : null;
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      const value = clamp(Math.round(gray[i]!), 0, 255);
      const mapped = table ? table[value]! : value;
      out[o] = mapped;
      out[o + 1] = mapped;
      out[o + 2] = mapped;
      out[o + 3] = data[o + 3]!;
    }
    return { data: out, width, height };
  }

  // Black and white: local mean threshold. The window is a sixteenth of the
  // shorter edge, wide enough to hold a line of text and its paper.
  const radius = Math.max(4, Math.round(Math.min(width, height) / 32));
  const meanAt = localMeanTable(gray, width, height, radius);

  // A purely local threshold has one well known failure: inside a large solid
  // dark area the local mean is the dark value itself, so the whole block comes
  // back white. Anchoring the cut to the page's own paper level fixes that. Ink
  // is never brighter than a third of the paper, whatever the local window says.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < count; i += 1) histogram[clamp(Math.round(gray[i]!), 0, 255)]! += 1;
  const range = stretchRange(histogram, count);
  const paperLevel = range ? range[1] : 255;
  const floor = paperLevel * 0.35;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 4;
      // 12 percent below the local mean is the classic ink cut: it keeps thin
      // strokes without turning paper grain into speckle.
      const value = gray[i]! > Math.max(meanAt(x, y) * 0.88, floor) ? 255 : 0;
      out[o] = value;
      out[o + 1] = value;
      out[o + 2] = value;
      out[o + 3] = data[o + 3]!;
    }
  }
  return { data: out, width, height };
}

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

/** Box filter downscale straight to a luma plane. */
function downscaleToGray(image: ScanImage, target: number) {
  const { data, width, height } = image;
  const longest = Math.max(width, height);
  const scale = longest > target ? target / longest : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const gray = new Float32Array(w * h);

  for (let y = 0; y < h; y += 1) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < width; sx += 1) {
          const o = (sy * width + sx) * 4;
          sum += luma(data[o]!, data[o + 1]!, data[o + 2]!);
          n += 1;
        }
      }
      gray[y * w + x] = n > 0 ? sum / n : 0;
    }
  }

  return { gray, width: w, height: h, scaleX: width / w, scaleY: height / h };
}

/** Sobel gradient magnitude. The one pixel border stays zero. */
function sobelMagnitude(gray: Float32Array, width: number, height: number): Float32Array {
  const magnitude = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = gray[i - width - 1]!;
      const t = gray[i - width]!;
      const tr = gray[i - width + 1]!;
      const l = gray[i - 1]!;
      const r = gray[i + 1]!;
      const bl = gray[i + width - 1]!;
      const b = gray[i + width]!;
      const br = gray[i + width + 1]!;
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      magnitude[i] = Math.hypot(gx, gy);
    }
  }
  return magnitude;
}

/**
 * The cut between edge and background.
 *
 * Two rules, whichever is stricter. A fraction of the peak handles a clean
 * scene, where almost every gradient is zero and a percentile would sit at
 * zero too. A percentile handles a noisy or busy scene, where a fraction of
 * the peak would let most of the frame through. Taking the larger of the two
 * is what keeps a noise-only image from producing a confident answer.
 */
function edgeThreshold(magnitude: Float32Array, percentile: number): number {
  let peak = 0;
  for (let i = 0; i < magnitude.length; i += 1) if (magnitude[i]! > peak) peak = magnitude[i]!;
  if (peak <= 0) return Infinity;

  const bins = new Uint32Array(256);
  for (let i = 0; i < magnitude.length; i += 1) {
    bins[Math.min(255, Math.floor((magnitude[i]! / peak) * 255))]! += 1;
  }
  const wanted = magnitude.length * percentile;
  let seen = 0;
  let cut = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += bins[i]!;
    if (seen >= wanted) {
      cut = ((i + 1) / 256) * peak;
      break;
    }
  }
  return Math.max(cut, peak * 0.12);
}

interface Component {
  size: number;
  pixels: number[];
}

/** Label the strong edge mask into 8 connected components, largest first. */
function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    const pixels: number[] = [];

    while (stack.length > 0) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const n = ny * width + nx;
          if (mask[n] === 1 && seen[n] === 0) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }

    components.push({ size: pixels.length, pixels });
  }

  components.sort((a, b) => b.size - a.size);
  return components;
}

/** Andrew's monotone chain. Returns the hull counterclockwise in math axes. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Drop hull vertices until only `limit` remain, always removing the one whose
 * triangle with its neighbors is smallest. That keeps the corners, which are
 * the vertices a document's hull actually cares about, and discards the
 * staircase points along each straight edge.
 */
function reduceHull(hull: Point[], limit: number): Point[] {
  const points = [...hull];
  while (points.length > limit) {
    let worst = 0;
    let worstArea = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const prev = points[(i - 1 + points.length) % points.length]!;
      const next = points[(i + 1) % points.length]!;
      const area = polygonArea([prev, points[i]!, next]);
      if (area < worstArea) {
        worstArea = area;
        worst = i;
      }
    }
    points.splice(worst, 1);
  }
  return points;
}

/** The largest area quadrilateral whose corners are hull vertices, in hull order. */
function largestQuad(hull: Point[]): Quad | null {
  if (hull.length < 4) return null;
  let best: Quad | null = null;
  let bestArea = 0;
  for (let i = 0; i < hull.length - 3; i += 1) {
    for (let j = i + 1; j < hull.length - 2; j += 1) {
      for (let k = j + 1; k < hull.length - 1; k += 1) {
        for (let l = k + 1; l < hull.length; l += 1) {
          const quad: Quad = [hull[i]!, hull[j]!, hull[k]!, hull[l]!];
          const area = polygonArea(quad);
          if (area > bestArea) {
            bestArea = area;
            best = quad;
          }
        }
      }
    }
  }
  return best;
}

/** Smallest interior angle of a quad, in degrees. */
function minInteriorAngle(quad: Quad): number {
  let smallest = 180;
  for (let i = 0; i < 4; i += 1) {
    const prev = quad[(i + 3) % 4]!;
    const here = quad[i]!;
    const next = quad[(i + 1) % 4]!;
    const ax = prev.x - here.x;
    const ay = prev.y - here.y;
    const bx = next.x - here.x;
    const by = next.y - here.y;
    const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (magnitude === 0) return 0;
    const angle = (Math.acos(clamp((ax * bx + ay * by) / magnitude, -1, 1)) * 180) / Math.PI;
    smallest = Math.min(smallest, angle);
  }
  return smallest;
}

/** Is the quad convex, walking its four corners in order? */
function isConvex(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return sign !== 0;
}

/**
 * How much of the quad's outline sits on real edge pixels: walk each side and
 * look for a strong edge within two pixels. A page traced on its true border
 * scores near 1; a quad drawn around unrelated clutter scores low even when its
 * area and angles look fine.
 */
function edgeSupport(quad: Quad, mask: Uint8Array, width: number, height: number): number {
  const samplesPerEdge = 48;
  let hits = 0;
  let total = 0;
  for (let e = 0; e < 4; e += 1) {
    const a = quad[e]!;
    const b = quad[(e + 1) % 4]!;
    for (let s = 0; s < samplesPerEdge; s += 1) {
      const t = (s + 0.5) / samplesPerEdge;
      const px = Math.round(a.x + (b.x - a.x) * t);
      const py = Math.round(a.y + (b.y - a.y) * t);
      total += 1;
      let found = false;
      for (let dy = -2; dy <= 2 && !found; dy += 1) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx] === 1) {
            found = true;
            break;
          }
        }
      }
      if (found) hits += 1;
    }
  }
  return total === 0 ? 0 : hits / total;
}

/**
 * Find the page in a photo.
 *
 * Downscale, grayscale, Sobel, threshold, take the strongest connected edge
 * regions, reduce each hull to four corners, and keep the best quad that passes
 * the sanity checks: at least a fifth of the frame, convex, and no corner
 * sharper than 35 degrees. The corners come back in original image coordinates,
 * ordered top left, top right, bottom right, bottom left.
 *
 * When nothing passes, the result is the inset default quad with a confidence
 * of 0. That is a starting point for the corner handles, not a detection, and
 * the panel says so.
 */
export function detectCorners(image: ScanImage, opts: DetectOpts = {}): DetectResult {
  assertImage(image);

  const workingSize = Math.max(80, Math.round(opts.workingSize ?? 400));
  const minAreaFraction = clamp(opts.minAreaFraction ?? 0.2, 0, 1);
  const minAngleDeg = clamp(opts.minAngleDeg ?? 35, 0, 90);
  const percentile = clamp(opts.edgePercentile ?? 0.9, 0, 1);
  const margin = clamp(opts.fallbackMargin ?? 0.08, 0, 0.45);
  const miss: DetectResult = {
    corners: fallbackQuad(image.width, image.height, margin),
    confidence: 0,
    fallback: true,
  };

  if (image.width < 16 || image.height < 16) return miss;

  const small = downscaleToGray(image, workingSize);
  const magnitude = sobelMagnitude(small.gray, small.width, small.height);
  const threshold = edgeThreshold(magnitude, percentile);
  if (!Number.isFinite(threshold)) return miss;

  const mask = new Uint8Array(magnitude.length);
  for (let i = 0; i < magnitude.length; i += 1) mask[i] = magnitude[i]! >= threshold ? 1 : 0;

  const frameArea = small.width * small.height;
  const components = connectedComponents(mask, small.width, small.height);

  let bestQuad: Quad | null = null;
  let bestConfidence = 0;

  for (const component of components.slice(0, 5)) {
    // A quad covering a fifth of the frame needs a hull with at least that
    // reach, and a handful of pixels can never provide it.
    if (component.size < 24) continue;

    const points: Point[] = component.pixels.map((index) => ({
      x: index % small.width,
      y: Math.floor(index / small.width),
    }));
    const hull = reduceHull(convexHull(points), 16);
    const quad = largestQuad(hull);
    if (!quad) continue;

    const ordered = orderCorners([...quad]);
    if (!isConvex(ordered)) continue;
    if (polygonArea(ordered) < frameArea * minAreaFraction) continue;
    const angle = minInteriorAngle(ordered);
    if (angle < minAngleDeg) continue;

    const support = edgeSupport(ordered, mask, small.width, small.height);
    // Angles far from square are suspicious even when they clear the floor, so
    // they scale the confidence down rather than disqualifying the candidate.
    const angleScore = clamp((angle - minAngleDeg) / (90 - minAngleDeg), 0, 1);
    const confidence = support * (0.5 + 0.5 * angleScore);
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestQuad = ordered;
    }
  }

  if (!bestQuad || bestConfidence <= 0) return miss;

  const corners = bestQuad.map((p) => ({
    x: clamp((p.x + 0.5) * small.scaleX, 0, image.width),
    y: clamp((p.y + 0.5) * small.scaleY, 0, image.height),
  })) as Quad;

  return {
    corners: orderCorners(corners),
    confidence: Math.round(clamp(bestConfidence, 0, 1) * 1000) / 1000,
    fallback: false,
  };
}

/* ------------------------------------------------------------------ */
/* pdf assembly                                                        */
/* ------------------------------------------------------------------ */

/** JPEG starts FF D8 FF; PNG starts with the eight byte signature. */
function sniffPageFormat(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((value, i) => bytes[i] === value)) return "png";
  return null;
}

/** The page rectangle in PDF points for one scanned image. */
export function pdfPageSize(
  width: number,
  height: number,
  fit: "image" | "letter" | "a4" = "image",
  pixelsPerInch = 150,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    throw new ToolError(
      "invalid-page-size",
      `A page of ${String(width)} by ${String(height)} pixels cannot be placed in a PDF.`,
      "Send the pixel width and height of each scanned page.",
    );
  }
  if (fit === "image") {
    const density = Number.isFinite(pixelsPerInch) && pixelsPerInch > 0 ? pixelsPerInch : 150;
    return {
      width: (width / density) * POINTS_PER_INCH,
      height: (height / density) * POINTS_PER_INCH,
    };
  }
  const paper = PAPER_POINTS[fit];
  return { width: paper.width, height: paper.height };
}

/**
 * Assemble scanned pages into one PDF.
 *
 * pdf-lib is loaded on demand rather than at module load, so opening the tool
 * page does not pull it in: it only arrives when someone actually saves a PDF.
 * It runs the same in Node and in the browser, which is why this stays in the
 * logic layer instead of the panel.
 */
export async function buildScanPdf(
  pages: ScanPdfPage[],
  opts: ScanPdfOpts = {},
): Promise<Uint8Array> {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new ToolError(
      "no-pages",
      "There are no pages to save.",
      "Add at least one page before saving a PDF.",
    );
  }

  const fit = opts.fit === "letter" || opts.fit === "a4" ? opts.fit : "image";
  const density = opts.pixelsPerInch ?? 150;

  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]!;
    const format = page?.bytes ? sniffPageFormat(page.bytes) : null;
    if (!format) {
      throw new ToolError(
        "unsupported-page",
        `Page ${i + 1} is not JPEG or PNG data.`,
        "Encode each page as a JPEG or a PNG before building the PDF.",
      );
    }

    const embedded =
      format === "jpeg" ? await pdf.embedJpg(page.bytes) : await pdf.embedPng(page.bytes);
    const size = pdfPageSize(page.width, page.height, fit, density);
    const sheet = pdf.addPage([size.width, size.height]);

    // Fit the image inside the sheet, centered. For "image" the two match, so
    // the scale is 1 and the image fills the page exactly.
    const scale = Math.min(size.width / embedded.width, size.height / embedded.height);
    const drawWidth = embedded.width * scale;
    const drawHeight = embedded.height * scale;
    sheet.drawImage(embedded, {
      x: (size.width - drawWidth) / 2,
      y: (size.height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return pdf.save();
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const USAGE =
  "Drop a photo, pick a file, or start the camera and capture a frame. The tool guesses the page corners, you drag any handle that landed wrong, then add the page and save.";
const OUTPUT_NOTE =
  "The flattened page keeps the proportions of the page itself, not the angle the camera saw, and the long edge stops at 2400 pixels.";
const EXPORT_NOTE =
  "One page saves as PNG or JPEG. Several pages save as a single PDF, each sheet sized to its own scan.";
const PRIVACY =
  "Detection, flattening, and PDF assembly all run in this tab: your files and inputs never leave your device.";

const MODE_NOTES: Record<EnhanceMode, string> = {
  none: "Original, no cleanup. The flattened page keeps the photo's own colors.",
  grayscale: "Grayscale with a contrast stretch. The safe default for printed text.",
  color:
    "Color, with each channel stretched, which lifts contrast and pulls a warm indoor cast back toward white paper.",
  bw: "Black and white, using a local adaptive threshold so a shadow across one corner does not swallow the text under it.",
};

/** Identify the container from its first bytes. Enough for a friendly readout. */
function sniffImageFormat(bytes: Uint8Array): string {
  if (sniffPageFormat(bytes) === "png") return "PNG";
  if (sniffPageFormat(bytes) === "jpeg") return "JPEG";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "WebP";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") return "GIF";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
  return "Unrecognized";
}

/**
 * The text summary of a scan. Flattening a page needs a canvas, a live preview,
 * and four handles you can drag, so the tool ships a bespoke panel and this
 * function reports what the panel will do rather than pretending to do it.
 */
export function run(input: Uint8Array | string, opts: ScannerOpts = {}): ScannerResult {
  const mode: EnhanceMode =
    opts.mode === "bw" || opts.mode === "grayscale" || opts.mode === "color" ? opts.mode : "none";
  const scale = Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : 1;
  const format = opts.format === "jpeg" ? "jpeg" : "png";
  const pdfPage = opts.pdfPage === "letter" || opts.pdfPage === "a4" ? opts.pdfPage : "image";

  const rows: ScannerResult = {};

  if (typeof input === "string") {
    rows.Input = input.trim()
      ? "Text was pasted. This tool scans photos of documents, so drop or capture an image instead."
      : "No image loaded yet.";
    rows["How to use"] = USAGE;
    rows.Enhancement = MODE_NOTES[mode];
    rows.Output = OUTPUT_NOTE;
    rows.Export = EXPORT_NOTE;
    rows.Privacy = PRIVACY;
    return rows;
  }

  if (input.length === 0) {
    throw new ToolError(
      "empty-file",
      "That file is empty, so there is no photo to scan.",
      "Pick a PNG, JPEG, WebP, GIF, or BMP photo of a document and try again.",
    );
  }

  rows.Loaded = `${sniffImageFormat(input)} image, ${formatBytes(input.length)}.`;
  rows["How to use"] = USAGE;
  rows.Detection =
    "Corner detection runs on a downscaled copy: grayscale, Sobel edges, then the largest strong edge region reduced to four corners. Every guess carries a confidence, and the four handles are draggable when it lands wrong.";
  rows.Enhancement = MODE_NOTES[mode];
  rows.Output = `${OUTPUT_NOTE} The scale is ${scale}x the measured page size.`;
  rows.Export = `${EXPORT_NOTE} A single page saves as ${format.toUpperCase()}, and the PDF uses ${
    pdfPage === "image"
      ? "a sheet sized to each scan"
      : `${pdfPage === "a4" ? "A4" : "Letter"} sheets`
  }.`;
  rows.Privacy = PRIVACY;
  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, ScannerResult, ScannerOpts>;
