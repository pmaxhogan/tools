/**
 * Pure geometry and post-processing for the ML-assisted deep scan.
 *
 * The ONNX model (trained in training/qr-detector/) takes a 512x512 RGB tensor
 * and emits a center heatmap (1x128x128 logits) plus point offsets
 * (16x128x128, output-grid units): four corners then four edge midpoints.
 * The midpoints ride the curve of a cylinder-wrapped code, which is what lets
 * rectification unbend it. Everything here is deterministic math over plain
 * arrays: packing the input, decoding detections, mapping them back to source
 * pixels, and rectifying a detected code out of the original image. The ONNX
 * session itself lives in src/lib/qr-scan.ts; this module never touches the
 * DOM, fetch, or WebAssembly, so it is unit-testable in Node.
 *
 * The heatmap decoder mirrors decode_np in training/qr-detector/dataset.py.
 * If one changes, the other must.
 */

export const DETECTOR_INPUT = 512;
export const DETECTOR_STRIDE = 4;
export const DETECTOR_GRID = DETECTOR_INPUT / DETECTOR_STRIDE; // 128

/** Neutral letterbox padding, matching the mid-gray bars the model trained on. */
export const PAD_GRAY = 128;

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface LetterboxParams {
  /** Source-to-model scale factor (applied uniformly to both axes). */
  scale: number;
  /** Top-left corner of the scaled image inside the model input, px. */
  dx: number;
  dy: number;
  /** Scaled image size inside the model input, px. */
  drawWidth: number;
  drawHeight: number;
  srcWidth: number;
  srcHeight: number;
}

/** One point as [x, y] in whatever space the context documents. */
export type Point = [number, number];
/** TL, TR, BR, BL in the code's own frame (finders at TL, TR, BL). */
export type Quad = [Point, Point, Point, Point];
/** Edge midpoints in edge order: top (TL-TR), right, bottom, left. */
export type EdgeMids = [Point, Point, Point, Point];

export interface Detection {
  score: number;
  /** Corners in model-input pixels until unletterboxed. */
  corners: Quad;
  /** On-curve edge midpoints, same space as corners. */
  mids: EdgeMids;
}

/* ------------------------------------------------------------------ */
/* input packing                                                       */
/* ------------------------------------------------------------------ */

/** Aspect-preserving fit of (w, h) into the square model input, centered. */
export function letterboxParams(srcWidth: number, srcHeight: number): LetterboxParams {
  const scale = Math.min(DETECTOR_INPUT / srcWidth, DETECTOR_INPUT / srcHeight);
  const drawWidth = Math.max(1, Math.round(srcWidth * scale));
  const drawHeight = Math.max(1, Math.round(srcHeight * scale));
  return {
    scale,
    dx: Math.floor((DETECTOR_INPUT - drawWidth) / 2),
    dy: Math.floor((DETECTOR_INPUT - drawHeight) / 2),
    drawWidth,
    drawHeight,
    srcWidth,
    srcHeight,
  };
}

/**
 * Resize + letterbox an RGBA buffer to the model input, in pure TS. The panel
 * uses a canvas for this instead (faster); this path serves Node evaluation
 * and tests, and both produce equivalent tensors.
 */
export function packLetterboxed(image: RawImage): { pixels: Uint8ClampedArray; params: LetterboxParams } {
  const params = letterboxParams(image.width, image.height);
  const out = new Uint8ClampedArray(DETECTOR_INPUT * DETECTOR_INPUT * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = PAD_GRAY;
    out[i + 3] = 255;
  }
  const { dx, dy, drawWidth, drawHeight } = params;
  const xRatio = image.width / drawWidth;
  const yRatio = image.height / drawHeight;
  for (let y = 0; y < drawHeight; y++) {
    // Bilinear sample at the center of each destination pixel.
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < drawWidth; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const o = ((y + dy) * DETECTOR_INPUT + (x + dx)) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c]!;
        const p01 = image.data[(y0 * image.width + x1) * 4 + c]!;
        const p10 = image.data[(y1 * image.width + x0) * 4 + c]!;
        const p11 = image.data[(y1 * image.width + x1) * 4 + c]!;
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { pixels: out, params };
}

/** RGBA (model-input sized) to NCHW float32 RGB in [0, 1]. */
export function rgbaToTensor(pixels: Uint8ClampedArray): Float32Array {
  const n = DETECTOR_INPUT * DETECTOR_INPUT;
  const tensor = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    tensor[i] = pixels[i * 4]! / 255;
    tensor[n + i] = pixels[i * 4 + 1]! / 255;
    tensor[2 * n + i] = pixels[i * 4 + 2]! / 255;
  }
  return tensor;
}

/* ------------------------------------------------------------------ */
/* head decoding                                                       */
/* ------------------------------------------------------------------ */

export interface DecodeOpts {
  threshold?: number;
  topK?: number;
}

/**
 * Decode raw head outputs into detections in model-input pixels. Mirrors
 * decode_np: sigmoid, 3x3 max-pool NMS, threshold, top-K by score, corners
 * reconstructed as (cell + offset) * stride.
 */
export function decodeDetections(
  hmLogits: Float32Array,
  offsets: Float32Array,
  opts?: DecodeOpts,
): Detection[] {
  const threshold = opts?.threshold ?? 0.35;
  const topK = opts?.topK ?? 8;
  const G = DETECTOR_GRID;
  const n = G * G;

  const prob = new Float32Array(n);
  for (let i = 0; i < n; i++) prob[i] = 1 / (1 + Math.exp(-hmLogits[i]!));

  const peaks: { score: number; x: number; y: number }[] = [];
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const p = prob[y * G + x]!;
      if (p < threshold) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= G || nx >= G) continue;
          if (prob[ny * G + nx]! > p) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ score: p, x, y });
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  return peaks.slice(0, topK).map(({ score, x, y }) => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
      const ox = offsets[2 * k * n + y * G + x]!;
      const oy = offsets[(2 * k + 1) * n + y * G + x]!;
      return [(x + ox) * DETECTOR_STRIDE, (y + oy) * DETECTOR_STRIDE] as Point;
    });
    return {
      score,
      corners: points.slice(0, 4) as Quad,
      mids: points.slice(4) as EdgeMids,
    };
  });
}

/** Map detection points from model-input px back to source-image px. */
export function unletterboxPoints<T extends Point[]>(points: T, params: LetterboxParams): T {
  return points.map(([x, y]) => {
    const sx = ((x - params.dx) / params.drawWidth) * params.srcWidth;
    const sy = ((y - params.dy) / params.drawHeight) * params.srcHeight;
    return [
      Math.min(params.srcWidth - 1, Math.max(0, sx)),
      Math.min(params.srcHeight - 1, Math.max(0, sy)),
    ] as Point;
  }) as T;
}

/* ------------------------------------------------------------------ */
/* rectification                                                       */
/* ------------------------------------------------------------------ */

export interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

/**
 * Projective map from the unit square to a quad (Heckbert's closed form).
 * (0,0)->TL, (1,0)->TR, (1,1)->BR, (0,1)->BL.
 */
export function squareToQuad(quad: Quad): Homography {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return {
    a: x1 - x0 + g * x1,
    b: x3 - x0 + h * x3,
    c: x0,
    d: y1 - y0 + g * y1,
    e: y3 - y0 + h * y3,
    f: y0,
    g,
    h,
  };
}

/** Apply the square-to-quad map to a unit-square point. */
export function applyHomography(H: Homography, u: number, v: number): Point {
  const w = H.g * u + H.h * v + 1;
  return [(H.a * u + H.b * v + H.c) / w, (H.d * u + H.e * v + H.f) / w];
}

/** Map an image point back into the unit square (inverse of squareToQuad). */
export function applyInverseHomography(H: Homography, x: number, y: number): Point {
  // Adjugate of [[a,b,c],[d,e,f],[g,h,1]].
  const { a, b, c, d, e, f, g, h } = H;
  const A = e - f * h;
  const B = c * h - b;
  const C = b * f - c * e;
  const D = f * g - d;
  const E = a - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const Hh = b * g - a * h;
  const I = a * e - b * d;
  const w = G * x + Hh * y + I;
  return [(A * x + B * y + C) / w, (D * x + E * y + F) / w];
}

/** Mean side length of a quad, px. */
export function quadSide(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i]!;
    const [bx, by] = quad[(i + 1) % 4]!;
    sum += Math.hypot(bx - ax, by - ay);
  }
  return sum / 4;
}

/** Output resolution for a rectified crop: upsample small codes hard. */
export function chooseRectifySize(quad: Quad): number {
  const side = quadSide(quad);
  return Math.round(Math.min(800, Math.max(240, side * 2.5)));
}

/**
 * The bow of each edge relative to the flat homography: the vector from where
 * the straight-edge midpoint would land under H to where the model actually
 * saw it. Near zero for planar codes, large for cylinder-wrapped ones.
 */
function edgeDeltas(H: Homography, mids: EdgeMids): [Point, Point, Point, Point] {
  const uv: Point[] = [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ];
  return uv.map(([u, v], k) => {
    const flat = applyHomography(H, u, v);
    return [mids[k]![0] - flat[0], mids[k]![1] - flat[1]] as Point;
  }) as [Point, Point, Point, Point];
}

/**
 * How strongly each edge pair bows, from the midpoint deviations relative to
 * the flat homography, normalized by the code side. Index 0 is the top and
 * bottom pair (a vertical-axis cylinder), 1 the left and right pair.
 */
export function bowMagnitudes(quad: Quad, mids: EdgeMids): [number, number] {
  const H = squareToQuad(quad);
  const side = Math.max(1, quadSide(quad));
  const dev = (
    [
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ] as const
  ).map(([u, v], k) => {
    const flat = applyHomography(H, u, v);
    return Math.hypot(mids[k]![0] - flat[0], mids[k]![1] - flat[1]) / side;
  });
  return [(dev[0]! + dev[2]!) / 2, (dev[1]! + dev[3]!) / 2];
}

/**
 * The outward sagitta of the bowed edge pair in unit-square space: how far
 * the top and bottom edge midpoints sit outside the corner quad. Positive
 * for a convex (toward the viewer) cylinder; near zero for a flat code.
 * Pass swapped=false for a vertical-axis cylinder (top/bottom bow), true for
 * a horizontal-axis one (left/right bow, measured on the u coordinate).
 */
export function unitSagitta(quad: Quad, mids: EdgeMids, swapped: boolean): number {
  const H = squareToQuad(quad);
  if (!swapped) {
    const top = applyInverseHomography(H, mids[0]![0], mids[0]![1]);
    const bottom = applyInverseHomography(H, mids[2]![0], mids[2]![1]);
    return (-top[1] + (bottom[1] - 1)) / 2;
  }
  const right = applyInverseHomography(H, mids[1]![0], mids[1]![1]);
  const left = applyInverseHomography(H, mids[3]![0], mids[3]![1]);
  return ((right[0] - 1) + -left[0]) / 2;
}

/**
 * How far the bowed edge midpoints sit off the quad's centerline, in unit
 * coordinates, along the arc axis. Zero for a flat or center-on wrap; grows
 * when the code wraps a cylinder off to one side (the label read at an
 * angle), which the symmetric bump correction cannot fit. The sign says
 * which side compresses.
 */
export function unitMidShift(quad: Quad, mids: EdgeMids, swapped: boolean): number {
  const H = squareToQuad(quad);
  if (!swapped) {
    const top = applyInverseHomography(H, mids[0]![0], mids[0]![1]);
    const bottom = applyInverseHomography(H, mids[2]![0], mids[2]![1]);
    return (top[0] - 0.5 + (bottom[0] - 0.5)) / 2;
  }
  const right = applyInverseHomography(H, mids[1]![0], mids[1]![1]);
  const left = applyInverseHomography(H, mids[3]![0], mids[3]![1]);
  return (right[1] - 0.5 + (left[1] - 0.5)) / 2;
}

/**
 * Rectify a cylinder-wrapped code with the true perspective-cylinder surface.
 *
 * Model: the code subtends arc theta on a cylinder viewed by a camera at
 * distance k radii from the axis. In the corner-normalized unit frame the
 * surface is u(t) = 0.5 + [sin p / (k - cos p)] / [2 sin(t2) / (k - cos t2)]
 * and v(t, s) = 0.5 + (s - 0.5) (k - cos t2)/(k - cos p), with p = (t-0.5)
 * theta and t2 = theta/2. This captures BOTH cylinder signatures at once:
 * the lateral crowding of modules toward the limbs and the outward bow of
 * the edges. k is recovered from the measured sagitta (k = 1 +
 * (1 - cos t2)/(2 sagitta)); theta is not observable from 8 points, so
 * callers sweep a few candidates and let the decoder judge.
 */
export function rectifyCylinder(
  image: RawImage,
  quad: Quad,
  mids: EdgeMids,
  outSize: number,
  margin: number,
  theta: number,
  axis: "u" | "v",
  sagittaScale = 1,
  phase = 0,
): RawImage {
  const H = squareToQuad(quad);
  // The detector under-predicts bow on strong cylinders (regression to the
  // mean), so callers sweep sagittaScale > 1 alongside theta.
  const sagitta = Math.max(0.002, unitSagitta(quad, mids, axis === "v") * sagittaScale);
  const t2 = theta / 2;
  const k = 1 + (1 - Math.cos(t2)) / (2 * sagitta);
  // Phase shifts the code center away from the cylinder's nearest line (a
  // label read from off to the side). The projection is renormalized so the
  // detected corners stay pinned to u = 0 and 1 whatever the phase.
  const xOf = (p: number) => Math.sin(p) / (k - Math.cos(p));
  const x0n = xOf(phase - t2);
  const x1n = xOf(phase + t2);

  const out = new Uint8ClampedArray(outSize * outSize * 4);
  const span = 1 + 2 * margin;
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  for (let j = 0; j < outSize; j++) {
    const s = ((j + 0.5) / outSize) * span - margin;
    for (let i = 0; i < outSize; i++) {
      const t = ((i + 0.5) / outSize) * span - margin;
      const arcT = axis === "u" ? t : s;
      const flatS = axis === "u" ? s : t;
      const p = (arcT - 0.5) * theta + phase;
      const depth = k - Math.cos(p);
      const un = (xOf(p) - x0n) / (x1n - x0n);
      const vn = 0.5 + (flatS - 0.5) * ((k - Math.cos(t2)) / depth);
      const [sx, sy] =
        axis === "u" ? applyHomography(H, un, vn) : applyHomography(H, vn, un);
      const o = (j * outSize + i) * 4;
      const cx = Math.min(maxX, Math.max(0, sx));
      const cy = Math.min(maxY, Math.max(0, sy));
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = cx - x0;
      const fy = cy - y0;
      for (let c = 0; c < 3; c++) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c]!;
        const p01 = image.data[(y0 * image.width + x1) * 4 + c]!;
        const p10 = image.data[(y1 * image.width + x0) * 4 + c]!;
        const p11 = image.data[(y1 * image.width + x1) * 4 + c]!;
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outSize, height: outSize };
}

/**
 * The bump-corrected sampling surface as a reusable map from unit-square
 * coordinates to source pixels: the same S(u, v) rectifyQuad samples. Used to
 * map points measured on a rectified crop back into the source image (the
 * second-pass refinement runs the detector on its own crop).
 */
export function makeBumpSurface(quad: Quad, mids?: EdgeMids): (u: number, v: number) => Point {
  const H = squareToQuad(quad);
  const deltas = mids ? edgeDeltas(H, mids) : null;
  return (u, v) => {
    let [sx, sy] = applyHomography(H, u, v);
    if (deltas) {
      const bu = 4 * u * (1 - u);
      const bv = 4 * v * (1 - v);
      const [dt, dr, db, dl] = deltas;
      sx += bu * ((1 - v) * dt[0] + v * db[0]) + bv * ((1 - u) * dl[0] + u * dr[0]);
      sy += bu * ((1 - v) * dt[1] + v * db[1]) + bv * ((1 - u) * dl[1] + u * dr[1]);
    }
    return [sx, sy];
  };
}

/**
 * Sample the region under a detected code (plus a margin for the quiet zone)
 * into an upright square RGBA image via inverse bilinear sampling.
 *
 * With `mids`, the sampling surface is the corner homography plus a quadratic
 * bow correction that passes exactly through the four on-curve edge
 * midpoints: S(u,v) = H(u,v) + B(u)((1-v) Dt + v Db) + B(v)((1-u) Dl + u Dr)
 * with B(t) = 4t(1-t). Exact for flat codes (deltas vanish) and unbends the
 * bow of cylinder-wrapped ones (rectifyCylinder handles the full cylinder
 * model when the bump is not enough). The margin is a fraction of the code
 * extrapolated outward in unit space, so the decoder gets the surrounding
 * quiet zone the detection deliberately excludes.
 */
export function rectifyQuad(
  image: RawImage,
  quad: Quad,
  outSize: number,
  margin = 0.12,
  mids?: EdgeMids,
): RawImage {
  const H = squareToQuad(quad);
  const deltas = mids ? edgeDeltas(H, mids) : null;
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  const span = 1 + 2 * margin;
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  for (let j = 0; j < outSize; j++) {
    const v = ((j + 0.5) / outSize) * span - margin;
    for (let i = 0; i < outSize; i++) {
      const u = ((i + 0.5) / outSize) * span - margin;
      let [sx, sy] = applyHomography(H, u, v);
      if (deltas) {
        const bu = 4 * u * (1 - u);
        const bv = 4 * v * (1 - v);
        const [dt, dr, db, dl] = deltas;
        sx += bu * ((1 - v) * dt[0] + v * db[0]) + bv * ((1 - u) * dl[0] + u * dr[0]);
        sy += bu * ((1 - v) * dt[1] + v * db[1]) + bv * ((1 - u) * dl[1] + u * dr[1]);
      }
      const o = (j * outSize + i) * 4;
      const cx = Math.min(maxX, Math.max(0, sx));
      const cy = Math.min(maxY, Math.max(0, sy));
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = cx - x0;
      const fy = cy - y0;
      for (let c = 0; c < 3; c++) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c]!;
        const p01 = image.data[(y0 * image.width + x1) * 4 + c]!;
        const p10 = image.data[(y1 * image.width + x0) * 4 + c]!;
        const p11 = image.data[(y1 * image.width + x1) * 4 + c]!;
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outSize, height: outSize };
}

/* ------------------------------------------------------------------ */
/* enhancement variants for stubborn crops                             */
/* ------------------------------------------------------------------ */

/**
 * Grayscale with a percentile contrast stretch: recovers low-contrast and
 * glare-washed codes before another decode attempt.
 */
export function contrastStretch(image: RawImage, lowPct = 0.02, highPct = 0.98): RawImage {
  const n = image.width * image.height;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const g =
      (image.data[i * 4]! * 299 + image.data[i * 4 + 1]! * 587 + image.data[i * 4 + 2]! * 114) / 1000;
    gray[i] = g;
    hist[gray[i]!]++;
  }
  let lo = 0;
  let hi = 255;
  let acc = 0;
  const loTarget = n * lowPct;
  const hiTarget = n * highPct;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc <= loTarget) lo = v;
    if (acc <= hiTarget) hi = v;
  }
  const range = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((gray[i]! - lo) / range) * 255;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: image.width, height: image.height };
}

/**
 * Local adaptive binarization via an integral-image mean threshold. Each
 * pixel is compared against the mean of its neighborhood, so a code under an
 * illumination ramp, a shadow edge, or partial glare binarizes cleanly where
 * any global threshold smears one side to solid black or white.
 */
export function adaptiveBinarize(image: RawImage, windowFrac = 0.125, bias = 0.06): RawImage {
  const { width, height, data } = image;
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114;
  }
  // Summed-area table with a zero row/column at the top/left.
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x]!;
      sat[(y + 1) * (width + 1) + (x + 1)] = sat[y * (width + 1) + (x + 1)]! + rowSum;
    }
  }
  const half = Math.max(4, Math.round((Math.min(width, height) * windowFrac) / 2));
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        sat[(y1 + 1) * (width + 1) + (x1 + 1)]! -
        sat[y0 * (width + 1) + (x1 + 1)]! -
        sat[(y1 + 1) * (width + 1) + x0]! +
        sat[y0 * (width + 1) + x0]!;
      const mean = sum / area;
      const v = gray[y * width + x]! < mean * (1 - bias) ? 0 : 255;
      const o = (y * width + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/** Unsharp-mask style 3x3 sharpen, for softly blurred crops. */
export function sharpen(image: RawImage, amount = 0.8): RawImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  const center = 1 + 4 * amount;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v =
          data[o + c]! * center -
          amount *
            (data[o - 4 + c]! + data[o + 4 + c]! + data[o - width * 4 + c]! + data[o + width * 4 + c]!);
        out[o + c] = v;
      }
    }
  }
  return { data: out, width, height };
}

/* ------------------------------------------------------------------ */
/* grid resampling: synthesize a clean code from a near-frontal crop   */
/* ------------------------------------------------------------------ */

interface FinderHit {
  x: number;
  y: number;
  /** Module size measured horizontally and vertically: they differ when the
   * crop carries residual anamorphic stretch, and mixing them corrupts the
   * version estimate. */
  mx: number;
  my: number;
  module: number;
}

/** Does a 5-run window match the 1:1:3:1:1 finder signature? */
function finderRatioOk(runs: number[]): boolean {
  const total = runs.reduce((a, b) => a + b, 0);
  const m = total / 7;
  if (m < 1.5) return false;
  const expected = [1, 1, 3, 1, 1];
  for (let i = 0; i < 5; i++) {
    if (Math.abs(runs[i]! - expected[i]! * m) > Math.max(1.6, m * 0.55)) return false;
  }
  return true;
}

/** Scan one line (row or column) of a binary image for finder signatures. */
function scanLine(
  dark: Uint8Array,
  width: number,
  fixed: number,
  horizontal: boolean,
  length: number,
  emit: (center: number, module: number) => void,
): void {
  const at = (i: number) => (horizontal ? dark[fixed * width + i]! : dark[i * width + fixed]!);
  const runs: number[] = [];
  const ends: number[] = [];
  let current = at(0);
  let count = 1;
  for (let i = 1; i < length; i++) {
    const v = at(i);
    if (v === current) {
      count++;
      continue;
    }
    runs.push(count);
    ends.push(i);
    current = v;
    count = 1;
  }
  runs.push(count);
  ends.push(length);
  // A finder is dark-light-dark-light-dark, so windows starting on dark runs.
  const firstDark = at(0) === 1 ? 0 : 1;
  for (let w = firstDark; w + 5 <= runs.length; w += 2) {
    const window = runs.slice(w, w + 5);
    if (finderRatioOk(window)) {
      const start = ends[w]! - runs[w]!;
      const total = window.reduce((a, b) => a + b, 0);
      emit(start + total / 2, total / 7);
    }
  }
}

/** Locate finder-pattern centers in a binarized crop. */
export function findFinderPatterns(image: RawImage): FinderHit[] {
  const bin = adaptiveBinarize(image);
  const { width, height } = bin;
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) dark[i] = bin.data[i * 4]! < 128 ? 1 : 0;

  const raw: FinderHit[] = [];
  for (let y = 0; y < height; y += 2) {
    scanLine(dark, width, y, true, width, (cx, module) => {
      // Verify the vertical signature through the candidate center.
      scanLine(dark, width, Math.round(cx), false, height, (cy, vModule) => {
        if (Math.abs(cy - y) < module * 2 && vModule > module * 0.4 && vModule < module * 2.5) {
          raw.push({ x: cx, y: cy, mx: module, my: vModule, module: (module + vModule) / 2 });
        }
      });
    });
  }

  // Cluster hits within a module radius; a real finder collects many rows.
  const clusters: (FinderHit & { hits: number })[] = [];
  for (const hit of raw) {
    const near = clusters.find(
      (c) => Math.hypot(c.x - hit.x, c.y - hit.y) < Math.max(4, c.module * 2),
    );
    if (near) {
      const n = near.hits;
      near.x = (near.x * n + hit.x) / (n + 1);
      near.y = (near.y * n + hit.y) / (n + 1);
      near.mx = (near.mx * n + hit.mx) / (n + 1);
      near.my = (near.my * n + hit.my) / (n + 1);
      near.module = (near.mx + near.my) / 2;
      near.hits = n + 1;
    } else {
      clusters.push({ ...hit, hits: 1 });
    }
  }
  return clusters
    .filter((c) => c.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8);
}

/**
 * Rebuild a clean, perfectly square QR bitmap from a near-frontal crop.
 *
 * The three finder patterns give an exact affine module grid (absorbing
 * rotation, shear, and aspect drift the projective rectification left
 * behind); walking the timing patterns then measures the smooth residual
 * bend (a bottle shoulder, a wavy poster) as separable drift curves. Every
 * module is sampled at its corrected center from a locally binarized image
 * and re-emitted as crisp square modules with a full quiet zone. Returns
 * null when the finder geometry cannot be established; the caller just moves
 * on to the next variant.
 */
export function gridResample(image: RawImage, useTiming = true): RawImage | null {
  const finders = findFinderPatterns(image);
  if (finders.length < 3) return null;

  // Choose TL, TR, BL: the pair with the longest span is TR-BL (the
  // diagonal); the remaining finder of the best right-angle triple is TL.
  let best: { tl: FinderHit; tr: FinderHit; bl: FinderHit; err: number } | null = null;
  for (let a = 0; a < finders.length; a++) {
    for (let b = 0; b < finders.length; b++) {
      for (let c = 0; c < finders.length; c++) {
        if (a === b || a === c || b === c) continue;
        const tl = finders[a]!;
        const tr = finders[b]!;
        const bl = finders[c]!;
        const vx = [tr.x - tl.x, tr.y - tl.y];
        const vy = [bl.x - tl.x, bl.y - tl.y];
        const lx = Math.hypot(vx[0]!, vx[1]!);
        const ly = Math.hypot(vy[0]!, vy[1]!);
        if (lx < tl.module * 8 || ly < tl.module * 8) continue;
        // Right-handed, roughly perpendicular, roughly equal legs.
        const cross = vx[0]! * vy[1]! - vx[1]! * vy[0]!;
        if (cross <= 0) continue;
        const dot = Math.abs(vx[0]! * vy[0]! + vx[1]! * vy[1]!) / (lx * ly);
        const aspect = Math.abs(Math.log(lx / ly));
        const err = dot + aspect;
        if (dot < 0.25 && aspect < 0.35 && (!best || err < best.err)) {
          best = { tl, tr, bl, err };
        }
      }
    }
  }
  if (!best) return null;
  const { tl, tr, bl } = best;

  // Version from the finder spacing, measured per axis so anamorphic stretch
  // cannot corrupt it: the horizontal leg is counted in horizontal modules
  // and the vertical leg in vertical modules.
  const moduleSize = (tl.module + tr.module + bl.module) / 3;
  const spanX = Math.hypot(tr.x - tl.x, tr.y - tl.y) / ((tl.mx + tr.mx) / 2) + 7;
  const spanY = Math.hypot(bl.x - tl.x, bl.y - tl.y) / ((tl.my + bl.my) / 2) + 7;
  const spanModules = (spanX + spanY) / 2;
  const version = Math.max(1, Math.min(40, Math.round((spanModules - 17) / 4)));
  const n = 17 + 4 * version;

  // Affine module-grid map from the three finder centers (at 3.5 modules in).
  // [x, y] = O + i * U + j * V with i, j in module units.
  const span = n - 7;
  const U = [(tr.x - tl.x) / span, (tr.y - tl.y) / span];
  const V = [(bl.x - tl.x) / span, (bl.y - tl.y) / span];
  const O = [tl.x - 3.5 * (U[0]! + V[0]!), tl.y - 3.5 * (U[1]! + V[1]!)];
  const gridAt = (i: number, j: number): Point => [
    O[0]! + i * U[0]! + j * V[0]!,
    O[1]! + i * U[1]! + j * V[1]!,
  ];

  const bin = adaptiveBinarize(image);
  const darkAt = (x: number, y: number): number => {
    const xi = Math.min(bin.width - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(bin.height - 1, Math.max(0, Math.round(y)));
    return bin.data[(yi * bin.width + xi) * 4]! < 128 ? 1 : 0;
  };
  // Majority vote over a 3x3 stencil inside the module: a single noisy pixel
  // must not flip a module the way point sampling would let it.
  const step = Math.max(1, moduleSize / 5);
  const moduleDark = (x: number, y: number): number => {
    let votes = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        votes += darkAt(x + dx * step, y + dy * step);
      }
    }
    return votes >= 5 ? 1 : 0;
  };

  // Grayscale bilinear sampler for subpixel drift scoring.
  const grayAt = (x: number, y: number): number => {
    const cx = Math.min(image.width - 1, Math.max(0, x));
    const cy = Math.min(image.height - 1, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const g = (xx: number, yy: number) => {
      const o = (yy * image.width + xx) * 4;
      return image.data[o]! * 0.299 + image.data[o + 1]! * 0.587 + image.data[o + 2]! * 0.114;
    };
    const top = g(x0, y0) + (g(x1, y0) - g(x0, y0)) * fx;
    const bot = g(x0, y1) + (g(x1, y1) - g(x0, y1)) * fx;
    return top + (bot - top) * fy;
  };

  // Timing walk: measure smooth drift along the timing row (drift of y as a
  // function of column) and the timing column (drift of x as a function of
  // row), in segments, and interpolate between segment centers. Scored by
  // gray correlation against the alternating pattern; a segment that does
  // not clearly look like a timing pattern contributes no correction.
  const measureDrift = (alongRow: boolean): ((t: number) => number) => {
    const coords: number[] = [];
    const values: number[] = [];
    const segment = 5;
    const offsets: number[] = [0];
    for (let o = 0.1; o <= 1.0001; o += 0.1) offsets.push(o, -o);
    for (let start = 8; start + segment <= n - 8; start += segment) {
      let bestOffset = 0;
      let bestScore = -Infinity;
      let zeroScore = 0;
      for (const o of offsets) {
        let score = 0;
        for (let k = start; k < start + segment; k++) {
          const expectDark = k % 2 === 0;
          const [x, y] = alongRow ? gridAt(k + 0.5, 6.5) : gridAt(6.5, k + 0.5);
          const px = alongRow ? x : x + o * moduleSize;
          const py = alongRow ? y + o * moduleSize : y;
          const v = grayAt(px, py) / 255;
          score += expectDark ? 1 - v : v;
        }
        if (o === 0) zeroScore = score;
        // Strictly greater plus small-offset-first ordering: ties keep the
        // smallest correction instead of drifting to the search boundary.
        if (score > bestScore + 1e-6) {
          bestScore = score;
          bestOffset = o;
        }
      }
      coords.push(start + segment / 2);
      // A correction is applied only when it clearly looks like a timing
      // pattern AND clearly beats applying no correction at all: noise must
      // never nudge an already-aligned grid.
      const accept = bestScore >= segment * 0.8 && bestScore > zeroScore + segment * 0.12;
      values.push(accept ? bestOffset : 0);
    }
    if (!coords.length) return () => 0;
    return (t: number) => {
      if (t <= coords[0]!) return values[0]!;
      if (t >= coords[coords.length - 1]!) return values[values.length - 1]!;
      let k = 0;
      while (k < coords.length - 1 && coords[k + 1]! < t) k++;
      const f = (t - coords[k]!) / (coords[k + 1]! - coords[k]!);
      return values[k]! + (values[k + 1]! - values[k]!) * f;
    };
  };
  const zero = () => 0;
  const dyOfColumn = useTiming ? measureDrift(true) : zero;
  const dxOfRow = useTiming ? measureDrift(false) : zero;

  // Sample every module and re-emit a clean code.
  const OUT_MODULE = 8;
  const QUIET = 4;
  const outN = n + 2 * QUIET;
  const outSize = outN * OUT_MODULE;
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  out.fill(255);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [gx, gy] = gridAt(i + 0.5, j + 0.5);
      const px = gx + dxOfRow(j) * moduleSize;
      const py = gy + dyOfColumn(i) * moduleSize;
      if (moduleDark(px, py) !== 1) continue;
      const x0 = (i + QUIET) * OUT_MODULE;
      const y0 = (j + QUIET) * OUT_MODULE;
      for (let y = y0; y < y0 + OUT_MODULE; y++) {
        for (let x = x0; x < x0 + OUT_MODULE; x++) {
          const o = (y * outSize + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = 0;
        }
      }
    }
  }
  return { data: out, width: outSize, height: outSize };
}

/* ------------------------------------------------------------------ */
/* multi-code bookkeeping                                              */
/* ------------------------------------------------------------------ */

/** Centroid distance below half the mean side means the same physical code. */
export function sameCode(a: Quad, b: Quad): boolean {
  const ca = quadCenter(a);
  const cb = quadCenter(b);
  const limit = (quadSide(a) + quadSide(b)) / 4;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < Math.max(8, limit);
}

/* ------------------------------------------------------------------ */
/* tiled detection planning                                            */
/* ------------------------------------------------------------------ */

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tiles for a second detection pass over a large image. The 512px model input
 * blinds the detector to codes that are tiny relative to a multi-megapixel
 * photo; running it again over overlapping tiles restores them. Returns an
 * empty list when the whole image is close enough to model resolution that
 * tiling adds nothing.
 */
export function planTiles(width: number, height: number, tileSize = 1024, overlap = 0.18): TileRect[] {
  if (Math.max(width, height) <= tileSize * 1.2) return [];
  const step = tileSize * (1 - overlap);
  const tiles: TileRect[] = [];
  const cols = Math.max(1, Math.ceil((width - tileSize * overlap) / step));
  const rows = Math.max(1, Math.ceil((height - tileSize * overlap) / step));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(Math.round(c * step), Math.max(0, width - tileSize));
      const y = Math.min(Math.round(r * step), Math.max(0, height - tileSize));
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
      });
    }
  }
  return tiles;
}

/** Copy one tile out of an RGBA buffer. */
export function cropTile(image: RawImage, tile: TileRect): RawImage {
  const out = new Uint8ClampedArray(tile.width * tile.height * 4);
  for (let y = 0; y < tile.height; y++) {
    const src = ((tile.y + y) * image.width + tile.x) * 4;
    out.set(image.data.subarray(src, src + tile.width * 4), y * tile.width * 4);
  }
  return { data: out, width: tile.width, height: tile.height };
}

export function quadCenter(quad: Quad): Point {
  let x = 0;
  let y = 0;
  for (const [px, py] of quad) {
    x += px;
    y += py;
  }
  return [x / 4, y / 4];
}
