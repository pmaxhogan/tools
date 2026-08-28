/**
 * Node-side mirror of the deep-scan pipeline in src/lib/qr-scan.ts (which is
 * browser-only: ImageData, Cache Storage). Keep the two in sync; the eval
 * numbers are only honest if this is the same algorithm the site runs.
 */
import { PNG } from "pngjs";
import jsQR from "jsqr";
import {
  type EdgeMids,
  type Quad,
  type RawImage,
  bowMagnitudes,
  chooseRectifySize,
  contrastStretch,
  cropTile,
  decodeDetections,
  makeBumpSurface,
  packLetterboxed,
  planTiles,
  quadSide,
  rectifyCylinder,
  rectifyQuad,
  rgbaToTensor,
  sameCode,
  sharpen,
  unletterboxPoints,
} from "../../../src/tools/qr-code-scanner/detector";

export interface Det {
  score: number;
  corners: Quad;
  mids: EdgeMids;
}

export const THRESHOLD = 0.3;

export function encodePng(image: RawImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length).copy(png.data);
  const out = PNG.sync.write(png);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
};
type MakeTensor = (data: Float32Array) => unknown;

async function detectOnce(
  session: OrtSession,
  makeTensor: MakeTensor,
  image: RawImage,
  topK: number,
): Promise<Det[]> {
  const { pixels, params } = packLetterboxed(image);
  const outputs = await session.run({ input: makeTensor(rgbaToTensor(pixels)) });
  return decodeDetections(
    outputs.heatmap!.data as Float32Array,
    outputs.offsets!.data as Float32Array,
    { threshold: THRESHOLD, topK },
  ).map((d) => ({
    score: d.score,
    corners: unletterboxPoints(d.corners, params),
    mids: unletterboxPoints(d.mids, params),
  }));
}

/** Full-image detection plus the tiled pass for large photos, deduped. */
export async function detectAll(
  session: OrtSession,
  makeTensor: MakeTensor,
  image: RawImage,
): Promise<Det[]> {
  const found = await detectOnce(session, makeTensor, image, 16);
  for (const tile of planTiles(image.width, image.height)) {
    const dets = await detectOnce(session, makeTensor, cropTile(image, tile), 16);
    for (const det of dets) {
      const shifted: Det = {
        score: det.score,
        corners: det.corners.map(([x, y]) => [x + tile.x, y + tile.y]) as Quad,
        mids: det.mids.map(([x, y]) => [x + tile.x, y + tile.y]) as EdgeMids,
      };
      const dup = found.findIndex((f) => sameCode(f.corners, shifted.corners));
      if (dup === -1) found.push(shifted);
      else if (found[dup]!.score < shifted.score) found[dup] = shifted;
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

const ARC_SWEEP = [0.9, 1.4, 1.9, 2.4];
const ARC_BOW_MIN = 0.012;
/** Margin used when a crop is cut for the second-pass refinement. */
const REFINE_MARGIN = 0.16;

/**
 * Second-pass refinement: rectify with the current 8 points, run the
 * detector again on the (near frontal) crop where it is far more accurate,
 * and map the refined points back to source space through the sampling
 * surface. Falls back to the original detection when nothing is found.
 */
export async function refineDetection(
  session: OrtSession,
  makeTensor: MakeTensor,
  image: RawImage,
  det: Det,
): Promise<Det> {
  const size = chooseRectifySize(det.corners);
  // Plain homography on purpose: the crop keeps whatever bow the code has
  // (the detector re-measures it at high resolution), and the crop-to-source
  // mapping is the exact homography rather than a bump surface built from
  // the very midpoints being corrected.
  const crop = rectifyQuad(image, det.corners, size, REFINE_MARGIN);
  const found = await detectOnce(session, makeTensor, crop, 4);
  if (!found.length) return det;
  // The code should fill the crop center; take the best-scoring detection
  // whose center lands mid-crop.
  const central = found.find((f) => {
    const cx = (f.corners[0]![0] + f.corners[2]![0]) / 2;
    const cy = (f.corners[0]![1] + f.corners[2]![1]) / 2;
    return Math.abs(cx - size / 2) < size * 0.25 && Math.abs(cy - size / 2) < size * 0.25;
  });
  if (!central) return det;
  const surface = makeBumpSurface(det.corners);
  const span = 1 + 2 * REFINE_MARGIN;
  const toSource = ([x, y]: [number, number]): [number, number] =>
    surface((x / size) * span - REFINE_MARGIN, (y / size) * span - REFINE_MARGIN);
  return {
    score: det.score,
    corners: central.corners.map(toSource) as Quad,
    mids: central.mids.map(toSource) as EdgeMids,
  };
}

async function decodeOneCrop(
  zxingPng: (png: Uint8Array) => Promise<string[]>,
  crop: RawImage,
  stretch: boolean,
): Promise<string[]> {
  let texts = await zxingPng(encodePng(crop));
  if (!texts.length) {
    const j = jsQR(crop.data, crop.width, crop.height, { inversionAttempts: "attemptBoth" });
    if (j?.data) texts = [j.data];
  }
  if (!texts.length && stretch) texts = await zxingPng(encodePng(contrastStretch(crop)));
  return texts;
}

/**
 * Decode one detection: bow-corrected crop with enhancement fallbacks, then
 * the cylinder sweep, then (when a refiner is available) the same again with
 * second-pass refined points.
 */
export async function decodeDetection(
  zxingPng: (png: Uint8Array) => Promise<string[]>,
  image: RawImage,
  det: Det,
  refine?: (image: RawImage, det: Det) => Promise<Det>,
): Promise<string[]> {
  if (quadSide(det.corners) < 8) return [];

  const attempt = async (d: Det): Promise<string[]> => {
    const size = chooseRectifySize(d.corners);
    const crop = rectifyQuad(image, d.corners, size, 0.1, d.mids);
    let texts = await decodeOneCrop(zxingPng, crop, true);
    if (!texts.length) texts = await zxingPng(encodePng(sharpen(contrastStretch(crop))));
    if (texts.length) return texts;

    const [bowU, bowV] = bowMagnitudes(d.corners, d.mids);
    if (Math.max(bowU, bowV) < ARC_BOW_MIN) return [];
    const axis = bowU >= bowV ? ("u" as const) : ("v" as const);
    for (const theta of ARC_SWEEP) {
      // The detector under-reports bow on strong wraps, so the measured
      // sagitta is also swept upward.
      for (const scale of [1, 1.6, 2.2]) {
        const unrolled = rectifyCylinder(image, d.corners, d.mids, size, 0.1, theta, axis, scale);
        const arcTexts = await decodeOneCrop(zxingPng, unrolled, scale === 1);
        if (arcTexts.length) return arcTexts;
      }
    }
    return [];
  };

  let texts = await attempt(det);
  if (!texts.length && refine) {
    let current = det;
    for (let pass = 0; pass < 2 && !texts.length; pass++) {
      const refined = await refine(image, current);
      if (refined === current) break;
      current = refined;
      texts = await attempt(current);
    }
  }
  return texts;
}
