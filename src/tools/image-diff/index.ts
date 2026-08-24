import { ToolError, type ToolLogic } from "../types";

/**
 * Perceptual image diff: pixel comparison plus structural similarity.
 *
 * Everything here is arithmetic on raw RGBA buffers, so it stays pure and
 * testable in Node. Decoding a PNG or a JPEG into pixels needs a canvas, so the
 * panel does that part and hands these functions the bytes it read back.
 *
 * Two independent measures run over the same pair of buffers:
 *
 * 1. `diffPixels` is a faithful reimplementation of the pixelmatch algorithm.
 *    Colors are compared with the YIQ difference metric from "Measuring
 *    perceived color difference using YIQ NTSC transmission color space in
 *    mobile applications" (Kotsarenko and Ramos), and pixels that look like
 *    anti-aliasing are detected with the intensity slope heuristic from
 *    "Anti-aliased Pixel and Intensity Slope Detector" (Vysniauskas, 2009) so a
 *    font rendered half a pixel differently does not light up the whole page.
 *
 * 2. `ssim` computes mean structural similarity on Rec.601 luma. A pixel diff
 *    answers "how many pixels changed"; SSIM answers "does this look like the
 *    same picture", which is the question you actually have when comparing two
 *    exports of the same screenshot.
 *
 * `describeDiff` turns both results into the labeled rows the generic shell
 * renders, including the bounding box of everything that changed.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

export type ViewMode = "diff" | "ssim" | "both";

export interface DiffOpts {
  /**
   * Matching threshold from 0 to 1, smaller is stricter. The squared YIQ
   * distance must exceed `35215 * threshold * threshold` to count. Default 0.1.
   */
  threshold?: number;
  /** Count anti-aliased looking pixels as real differences. Default false. */
  includeAA?: boolean;
  /** Opacity of the faded original drawn under the highlights. Default 0.1. */
  alpha?: number;
}

export interface DiffResult {
  /** Pixels that differ beyond the threshold and are not anti-aliasing. */
  diffCount: number;
  /** `diffCount` as a percentage of the compared area, from 0 to 100. */
  diffPercent: number;
  /** Pixels that differ but look like anti-aliasing. Always 0 when includeAA. */
  aaCount: number;
  width: number;
  height: number;
  /**
   * RGBA highlight image the panel paints on a canvas: unchanged pixels are the
   * first image faded to gray at `alpha`, changed pixels are red, anti-aliased
   * looking pixels are yellow.
   */
  mask: Uint8ClampedArray;
}

export interface SsimOpts {
  /** Side of the square comparison window in pixels. Default 8. */
  windowSize?: number;
  /** Stabiliser for the luminance term. Default 0.01. */
  k1?: number;
  /** Stabiliser for the contrast and structure terms. Default 0.03. */
  k2?: number;
  /** Distance in pixels between window origins. Default 4. */
  stride?: number;
}

export interface SsimResult {
  /** Mean structural similarity over every window, from -1 to 1. */
  mssim: number;
  /** Per window SSIM, row major, `mapWidth * mapHeight` values. */
  map: Float32Array;
  mapWidth: number;
  mapHeight: number;
  /** The window size actually used, after clamping to the image. */
  windowSize: number;
  /** The stride actually used. */
  stride: number;
}

export interface AlignedSize {
  /** Width of the region both images share. */
  width: number;
  /** Height of the region both images share. */
  height: number;
  /** True when the two images were already the same size. */
  sameSize: boolean;
  /** One sentence for the report explaining what was compared. */
  note: string;
}

export interface ChangedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** False when nothing changed, in which case the other fields are 0. */
  found: boolean;
}

export interface ImageDiffOpts {
  threshold?: number;
  includeAA?: boolean;
  view?: ViewMode;
  [key: string]: unknown;
}

export type ImageDiffResult = Record<string, string>;

/** Highlight color for a real difference. */
const DIFF_COLOR = [255, 0, 0] as const;
/** Highlight color for a pixel that looks like anti-aliasing. */
const AA_COLOR = [255, 255, 0] as const;

const TWO_IMAGES_FIX = "Drop or pick two images in the panel.";

/* ------------------------------------------------------------------ *
 * shared validation
 * ------------------------------------------------------------------ */

function assertSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new ToolError(
      "invalid-size",
      `A width and height of ${w} by ${h} is not a usable image size.`,
      "Pass the pixel width and height of the compared region as positive whole numbers.",
    );
  }
}

function assertBuffers(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): void {
  assertSize(w, h);
  const need = w * h * 4;
  if (a.length !== need || b.length !== need) {
    throw new ToolError(
      "size-mismatch",
      `The two buffers hold ${a.length} and ${b.length} bytes, but ${w} by ${h} pixels needs ${need} each.`,
      "Crop both images to the overlapping region first, for example with alignSizes and cropToOverlap.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * pixelmatch: color math
 * ------------------------------------------------------------------ */

function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}
function rgb2i(r: number, g: number, b: number): number {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
}
function rgb2q(r: number, g: number, b: number): number {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
}

/** Blends a semi transparent channel with white, the pixelmatch convention. */
function blend(c: number, a: number): number {
  return 255 + (c - 255) * a;
}

/**
 * Squared YIQ distance between two pixels, signed so the caller can tell which
 * way the brightness moved. Returns the raw brightness difference instead when
 * `yOnly` is set, which is what the anti-aliasing detector needs.
 */
function colorDelta(
  img1: Uint8ClampedArray,
  img2: Uint8ClampedArray,
  k: number,
  m: number,
  yOnly = false,
): number {
  let r1 = img1[k]!;
  let g1 = img1[k + 1]!;
  let b1 = img1[k + 2]!;
  let a1 = img1[k + 3]!;

  let r2 = img2[m]!;
  let g2 = img2[m + 1]!;
  let b2 = img2[m + 2]!;
  let a2 = img2[m + 3]!;

  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;

  if (a1 < 255) {
    a1 /= 255;
    r1 = blend(r1, a1);
    g1 = blend(g1, a1);
    b1 = blend(b1, a1);
  }

  if (a2 < 255) {
    a2 /= 255;
    r2 = blend(r2, a2);
    g2 = blend(g2, a2);
    b2 = blend(b2, a2);
  }

  const y1 = rgb2y(r1, g1, b1);
  const y2 = rgb2y(r2, g2, b2);
  const y = y1 - y2;

  if (yOnly) return y;

  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);

  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;

  return y1 > y2 ? -delta : delta;
}

function drawPixel(output: Uint8ClampedArray, pos: number, rgb: readonly number[]): void {
  output[pos] = rgb[0]!;
  output[pos + 1] = rgb[1]!;
  output[pos + 2] = rgb[2]!;
  output[pos + 3] = 255;
}

/** Draws the source pixel as gray, faded toward white by `alpha`. */
function drawGrayPixel(
  img: Uint8ClampedArray,
  i: number,
  alpha: number,
  output: Uint8ClampedArray,
): void {
  const val = blend(rgb2y(img[i]!, img[i + 1]!, img[i + 2]!), (alpha * img[i + 3]!) / 255);
  output[i] = val;
  output[i + 1] = val;
  output[i + 2] = val;
  output[i + 3] = 255;
}

/* ------------------------------------------------------------------ *
 * pixelmatch: anti-aliasing detection
 * ------------------------------------------------------------------ */

/** True when a pixel has three or more adjacent pixels of exactly its color. */
function hasManySiblings(
  img: Uint8ClampedArray,
  x1: number,
  y1: number,
  width: number,
  height: number,
): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

  for (let x = x0; x <= x2; x += 1) {
    for (let y = y0; y <= y2; y += 1) {
      if (x === x1 && y === y1) continue;

      const pos2 = (y * width + x) * 4;
      if (
        img[pos] === img[pos2] &&
        img[pos + 1] === img[pos2 + 1] &&
        img[pos + 2] === img[pos2 + 2] &&
        img[pos + 3] === img[pos2 + 3]
      ) {
        zeroes += 1;
      }

      if (zeroes > 2) return true;
    }
  }

  return false;
}

/**
 * The intensity slope detector: a pixel is probably anti-aliasing when it has
 * both a darker and a brighter neighbor, no more than two identical
 * neighbors, and the extreme neighbor is a flat run of color in both images.
 */
function antialiased(
  img: Uint8ClampedArray,
  x1: number,
  y1: number,
  width: number,
  height: number,
  img2: Uint8ClampedArray,
): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;

  for (let x = x0; x <= x2; x += 1) {
    for (let y = y0; y <= y2; y += 1) {
      if (x === x1 && y === y1) continue;

      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true);

      if (delta === 0) {
        zeroes += 1;
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = x;
        minY = y;
      } else if (delta > max) {
        max = delta;
        maxX = x;
        maxY = y;
      }
    }
  }

  if (min === 0 || max === 0) return false;

  return (
    (hasManySiblings(img, minX, minY, width, height) &&
      hasManySiblings(img2, minX, minY, width, height)) ||
    (hasManySiblings(img, maxX, maxY, width, height) &&
      hasManySiblings(img2, maxX, maxY, width, height))
  );
}

/* ------------------------------------------------------------------ *
 * pixelmatch: the diff
 * ------------------------------------------------------------------ */

/**
 * Compares two RGBA buffers of the same size and paints a highlight image.
 *
 * Unchanged pixels are drawn as the first image, converted to gray and faded
 * toward white by `alpha`, so the highlights sit on a readable ghost of the
 * original. Real differences are red. Pixels that trip the anti-aliasing
 * heuristic are yellow and do not count toward `diffCount`, unless `includeAA`
 * is on, in which case the heuristic is skipped entirely and every difference
 * above the threshold is red.
 */
export function diffPixels(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  opts: DiffOpts = {},
): DiffResult {
  assertBuffers(a, b, width, height);

  const threshold = opts.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new ToolError(
      "invalid-threshold",
      `A threshold of ${threshold} is outside the 0 to 1 range.`,
      "Use a value between 0 and 1. The default is 0.1, and smaller is stricter.",
    );
  }
  const includeAA = opts.includeAA === true;
  const alpha = opts.alpha ?? 0.1;

  const total = width * height;
  const mask = new Uint8ClampedArray(total * 4);

  // Fast path: byte identical images only need the faded background drawn.
  let identical = true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      identical = false;
      break;
    }
  }
  if (identical) {
    for (let i = 0; i < total; i += 1) drawGrayPixel(a, i * 4, alpha, mask);
    return { diffCount: 0, diffPercent: 0, aaCount: 0, width, height, mask };
  }

  // 35215 is the largest possible squared YIQ distance between two colors.
  const maxDelta = 35215 * threshold * threshold;
  let diff = 0;
  let aa = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pos = (y * width + x) * 4;
      const delta = colorDelta(a, b, pos, pos);

      if (Math.abs(delta) > maxDelta) {
        if (
          !includeAA &&
          (antialiased(a, x, y, width, height, b) || antialiased(b, x, y, width, height, a))
        ) {
          drawPixel(mask, pos, AA_COLOR);
          aa += 1;
        } else {
          drawPixel(mask, pos, DIFF_COLOR);
          diff += 1;
        }
      } else {
        drawGrayPixel(a, pos, alpha, mask);
      }
    }
  }

  return {
    diffCount: diff,
    diffPercent: (diff / total) * 100,
    aaCount: aa,
    width,
    height,
    mask,
  };
}

/**
 * Smallest rectangle containing every red pixel of a highlight mask.
 *
 * Read straight off the mask rather than tracked during the diff, so it stays
 * correct for a mask the panel has edited. Gray background pixels always have
 * equal channels and anti-aliasing highlights are yellow, so an exact match on
 * pure red is unambiguous.
 */
export function changedBounds(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
): ChangedBounds {
  assertSize(width, height);
  if (mask.length !== width * height * 4) {
    throw new ToolError(
      "size-mismatch",
      `The mask holds ${mask.length} bytes, but ${width} by ${height} pixels needs ${width * height * 4}.`,
      "Pass the mask together with the width and height the diff was run at.",
    );
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pos = (y * width + x) * 4;
      if (
        mask[pos] === DIFF_COLOR[0] &&
        mask[pos + 1] === DIFF_COLOR[1] &&
        mask[pos + 2] === DIFF_COLOR[2] &&
        mask[pos + 3] === 255
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0, found: false };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, found: true };
}

/* ------------------------------------------------------------------ *
 * structural similarity
 * ------------------------------------------------------------------ */

/** Rec.601 luma, the grayscale SSIM is computed on. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function toLuma(rgba: Uint8ClampedArray, total: number): Float64Array {
  const out = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    out[i] = luma(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
  }
  return out;
}

/**
 * Mean structural similarity between two RGBA buffers of the same size.
 *
 * The documented choices, so results here can be reproduced elsewhere:
 *
 * - Grayscale is Rec.601 luma, `0.299 R + 0.587 G + 0.114 B`. Alpha is ignored,
 *   because the panel always hands over images composited onto a background.
 * - Windows are square, 8 by 8 by default, and slide with a stride of 4, so
 *   neighboring windows overlap by half. Overlap is what keeps a single
 *   changed block from being averaged away by the windows around it.
 * - Weighting inside a window is a box, not a gaussian. A box is what makes the
 *   per window values easy to reason about and to hand check in a test, at the
 *   cost of slightly more blocking than the gaussian weighted original.
 * - Variance and covariance divide by N, the population form.
 * - The dynamic range L is 255, so `C1 = (k1 * 255)^2` and `C2 = (k2 * 255)^2`.
 *
 * Windows always sit fully inside the image, so a trailing strip narrower than
 * the window is not scored. The window is clamped down when the image is
 * smaller than the requested size.
 */
export function ssim(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  opts: SsimOpts = {},
): SsimResult {
  assertBuffers(a, b, width, height);

  const k1 = opts.k1 ?? 0.01;
  const k2 = opts.k2 ?? 0.03;
  const requested = opts.windowSize ?? 8;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ToolError(
      "invalid-window",
      `A window size of ${requested} is not usable.`,
      "Use a whole number of pixels, such as the default 8.",
    );
  }
  const win = Math.max(1, Math.min(requested, width, height));
  const requestedStride = opts.stride ?? 4;
  const stride = Math.max(1, Math.min(Math.floor(requestedStride), win));

  const L = 255;
  const c1 = (k1 * L) ** 2;
  const c2 = (k2 * L) ** 2;

  const total = width * height;
  const ya = toLuma(a, total);
  const yb = toLuma(b, total);

  const mapWidth = Math.floor((width - win) / stride) + 1;
  const mapHeight = Math.floor((height - win) / stride) + 1;
  const map = new Float32Array(mapWidth * mapHeight);

  const n = win * win;
  let sum = 0;

  for (let wy = 0; wy < mapHeight; wy += 1) {
    for (let wx = 0; wx < mapWidth; wx += 1) {
      const ox = wx * stride;
      const oy = wy * stride;

      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;

      for (let y = 0; y < win; y += 1) {
        const row = (oy + y) * width + ox;
        for (let x = 0; x < win; x += 1) {
          const va = ya[row + x]!;
          const vb = yb[row + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }

      const muA = sa / n;
      const muB = sb / n;
      const varA = saa / n - muA * muA;
      const varB = sbb / n - muB * muB;
      const covAB = sab / n - muA * muB;

      const value =
        ((2 * muA * muB + c1) * (2 * covAB + c2)) /
        ((muA * muA + muB * muB + c1) * (varA + varB + c2));

      map[wy * mapWidth + wx] = value;
      sum += value;
    }
  }

  return {
    mssim: map.length > 0 ? sum / map.length : 1,
    map,
    mapWidth,
    mapHeight,
    windowSize: win,
    stride,
  };
}

/* ------------------------------------------------------------------ *
 * size handling
 * ------------------------------------------------------------------ */

/**
 * Works out the region two images have in common.
 *
 * Nothing is ever resampled: scaling one image to match the other would invent
 * pixels and make every comparison after it meaningless. Instead the overlapping
 * top left rectangle is compared and the report says so.
 */
export function alignSizes(aW: number, aH: number, bW: number, bH: number): AlignedSize {
  assertSize(aW, aH);
  assertSize(bW, bH);
  const width = Math.min(aW, bW);
  const height = Math.min(aH, bH);
  const sameSize = aW === bW && aH === bH;
  const note = sameSize
    ? `Both images are ${aW} by ${aH} pixels.`
    : `The images are different sizes (${aW} by ${aH} and ${bW} by ${bH}). Only the overlapping top left ${width} by ${height} region was compared, and neither image was resampled.`;
  return { width, height, sameSize, note };
}

/**
 * Copies the top left `w` by `h` rectangle out of an RGBA buffer. Returns the
 * same buffer untouched when it is already exactly that size.
 */
export function cropToOverlap(
  rgba: Uint8ClampedArray,
  fromW: number,
  fromH: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  assertSize(fromW, fromH);
  assertSize(w, h);
  if (rgba.length !== fromW * fromH * 4) {
    throw new ToolError(
      "size-mismatch",
      `The buffer holds ${rgba.length} bytes, but ${fromW} by ${fromH} pixels needs ${fromW * fromH * 4}.`,
      "Pass the width and height the pixel data was read at.",
    );
  }
  if (w > fromW || h > fromH) {
    throw new ToolError(
      "size-mismatch",
      `Cannot crop a ${fromW} by ${fromH} image to ${w} by ${h}.`,
      "Use alignSizes to work out the overlapping region before cropping.",
    );
  }
  if (w === fromW && h === fromH) return rgba;

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const from = y * fromW * 4;
    out.set(rgba.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Plain English for an MSSIM value, so the number is not the only answer. */
function readMssim(mssim: number): string {
  if (mssim >= 0.99) return "Structurally the same picture. Nothing a viewer would notice.";
  if (mssim >= 0.95)
    return "Very close. This is the level a re-encode or light compression noise lands at.";
  if (mssim >= 0.85)
    return "Noticeably different. Side by side, a viewer would see something moved or changed.";
  if (mssim >= 0.6) return "Clearly different content, not just a rendering difference.";
  return "Very different images. Check that you compared the pair you meant to.";
}

/**
 * Verdict thresholds, kept in one place so the report and the copy agree.
 *
 * - identical: no pixel differences at all and MSSIM at least 0.9999.
 * - minor: under 1 percent of pixels changed and MSSIM at least 0.95.
 * - significant: anything else.
 */
function verdict(result: DiffResult, mssim: number): string {
  if (result.diffCount === 0 && mssim >= 0.9999) {
    return "Identical. No pixel differs beyond the threshold and the structure matches.";
  }
  if (result.diffPercent < 1 && mssim >= 0.95) {
    return "Minor differences. Under 1 percent of pixels changed and the structure is intact.";
  }
  return "Significant differences. Either the changed area is over 1 percent of the image or the structure moved.";
}

/**
 * Turns both measurements into the labeled rows the shell renders. The optional
 * third argument adds the compared region note and narrows the rows to one
 * measure when the panel is showing only the diff or only the SSIM map.
 */
export function describeDiff(
  result: DiffResult,
  ssimResult: SsimResult,
  opts: { aligned?: AlignedSize; view?: ViewMode } = {},
): Record<string, string> {
  const view = opts.view ?? "both";
  const total = result.width * result.height;
  const rows: Record<string, string> = {
    Verdict: verdict(result, ssimResult.mssim),
    "Compared region": opts.aligned
      ? opts.aligned.note
      : `${result.width} by ${result.height} pixels, ${count(total)} in total.`,
  };

  if (view !== "ssim") {
    const bounds = changedBounds(result.mask, result.width, result.height);
    rows["Different pixels"] =
      `${count(result.diffCount)} of ${count(total)} (${result.diffPercent.toFixed(3)} percent)`;
    rows["Anti-aliased pixels"] =
      result.aaCount > 0
        ? `${count(result.aaCount)} differ but look like anti-aliasing, so they were not counted.`
        : "None found. No edge was flagged as an anti-aliasing artifact.";
    rows["Changed area"] = bounds.found
      ? `x ${bounds.x}, y ${bounds.y}, ${bounds.width} by ${bounds.height} pixels`
      : "Nothing changed, so there is no bounding box.";
  }

  if (view !== "diff") {
    rows.MSSIM = ssimResult.mssim.toFixed(6);
    rows["What MSSIM means"] = readMssim(ssimResult.mssim);
    rows["SSIM windows"] =
      `${ssimResult.mapWidth} by ${ssimResult.mapHeight} windows of ${ssimResult.windowSize} pixels, stride ${ssimResult.stride}, box weighted on Rec.601 luma.`;
  }

  return rows;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_LOOKUP[B64_ALPHABET[i] as string] = i;
B64_LOOKUP["-"] = 62;
B64_LOOKUP["_"] = 63;

/** Standard or URL safe base64 to bytes. Returns null on anything invalid. */
function base64ToBytes(raw: string): Uint8ClampedArray | null {
  const core = raw.replace(/\s+/g, "").replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  const out = new Uint8ClampedArray(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of core) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[i] = (acc >> bits) & 0xff;
      i += 1;
    }
  }
  return i === out.length ? out : out.slice(0, i);
}

function twoImages(detail: string): ToolError {
  return new ToolError("two-images", `This tool needs two images; ${detail}`, TWO_IMAGES_FIX);
}

/** The error for input that is not a two image payload at all. */
function needsTwo(): ToolError {
  return twoImages("use the panel above.");
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readView(value: unknown): ViewMode {
  if (value === undefined || value === null || value === "") return "both";
  if (value === "diff" || value === "ssim" || value === "both") return value;
  throw new ToolError(
    "invalid-view",
    `"${String(value)}" is not a view.`,
    "Choose one of: diff, ssim, both.",
  );
}

/**
 * Text surface for the tool.
 *
 * The generic shell can only hand a tool one input, and this tool needs two
 * images, so the real work happens in the panel on this page. What `run` accepts
 * is a small JSON payload of raw pixels, which is what makes the whole pipeline
 * runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 4, "height": 4, "a": "<base64 RGBA>", "b": "<base64 RGBA>" }
 * ```
 *
 * `aWidth`, `aHeight`, `bWidth`, and `bHeight` may be given instead when the two
 * images are different sizes, in which case the overlapping top left region is
 * compared. Anything that is not this shape gets a clear error pointing at the
 * panel, because pasting a single PNG here can never be a comparison.
 */
export function run(input: Uint8Array | string, opts: ImageDiffOpts = {}): ImageDiffResult {
  const view = readView(opts.view);

  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    text = new TextDecoder().decode(input);
  } else {
    throw needsTwo();
  }

  if (text.trim() === "") throw needsTwo();

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw needsTwo();
    payload = parsed as Record<string, unknown>;
  } catch {
    throw needsTwo();
  }

  if (typeof payload.a !== "string" || typeof payload.b !== "string") {
    throw twoImages("the payload needs an `a` and a `b` of base64 RGBA pixels.");
  }

  const shared = positiveInt(payload.width);
  const aW = positiveInt(payload.aWidth) ?? shared;
  const aH = positiveInt(payload.aHeight) ?? positiveInt(payload.height);
  const bW = positiveInt(payload.bWidth) ?? shared;
  const bH = positiveInt(payload.bHeight) ?? positiveInt(payload.height);
  if (aW === null || aH === null || bW === null || bH === null) {
    throw twoImages("the payload needs a positive whole `width` and `height`.");
  }

  const aBytes = base64ToBytes(payload.a);
  const bBytes = base64ToBytes(payload.b);
  if (aBytes === null || bBytes === null) {
    throw twoImages("`a` and `b` must be base64 encoded raw RGBA pixels.");
  }
  if (aBytes.length !== aW * aH * 4 || bBytes.length !== bW * bH * 4) {
    throw new ToolError(
      "size-mismatch",
      `The payload carries ${aBytes.length} and ${bBytes.length} bytes, but ${aW} by ${aH} and ${bW} by ${bH} pixels need ${aW * aH * 4} and ${bW * bH * 4}.`,
      "Send four bytes per pixel, in red, green, blue, alpha order, with no header.",
    );
  }

  const aligned = alignSizes(aW, aH, bW, bH);
  const a = cropToOverlap(aBytes, aW, aH, aligned.width, aligned.height);
  const b = cropToOverlap(bBytes, bW, bH, aligned.width, aligned.height);

  const threshold = typeof opts.threshold === "number" ? opts.threshold : 0.1;
  const result = diffPixels(a, b, aligned.width, aligned.height, {
    threshold,
    includeAA: opts.includeAA === true,
  });
  const structural = ssim(a, b, aligned.width, aligned.height);

  return describeDiff(result, structural, { aligned, view });
}

export default { run } satisfies ToolLogic<Uint8Array | string, ImageDiffResult, ImageDiffOpts>;
