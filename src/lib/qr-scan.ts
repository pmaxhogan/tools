/**
 * Scanning engines for the QR code scanner, in escalating power and cost:
 *
 *  1. jsQR: tiny, synchronous, already in the page bundle. First look.
 *  2. zxing-cpp compiled to WebAssembly (~1 MB, lazy): the robust classical
 *     decoder. Handles perspective, damage, small codes, inverted and
 *     mirrored codes, and several codes per image.
 *  3. Deep scan: the corner detector trained in training/qr-detector/ running
 *     under onnxruntime-web (WebGPU when available, WASM otherwise), plus
 *     bow-aware rectification from src/tools/qr-code-scanner/detector.ts,
 *     with zxing and jsQR decoding the rectified crops.
 *
 * Everything downloads from this origin (prepare-models.mjs stages it all)
 * and executes on the visitor's device; nothing about the image ever leaves
 * it. This module owns the impure parts: dynamic imports, fetch with
 * progress, Cache Storage, WebAssembly. The geometry stays in the pure layer.
 */
import jsQR from "jsqr";
import type { ReadResult, ReaderOptions } from "zxing-wasm/reader";
import {
  type Detection,
  type EdgeMids,
  type Quad,
  type RawImage,
  bowMagnitudes,
  chooseRectifySize,
  adaptiveBinarize,
  contrastStretch,
  cropTile,
  decodeDetections,
  gridResample,
  makeBumpSurface,
  packLetterboxed,
  planTiles,
  quadSide,
  rectifyCylinder,
  rectifyQuad,
  rgbaToTensor,
  sameCode,
  sharpen,
  unitMidShift,
  unletterboxPoints,
} from "@/tools/qr-code-scanner/detector";

export type ScanMethod = "jsqr" | "zxing" | "deep";

export interface ScanHit {
  text: string;
  method: ScanMethod;
  /** Corners in source-image px when the engine reports them. */
  corners?: Quad;
}

export interface DeepScanResult {
  hits: ScanHit[];
  /** Detected code quads (source px) that no decoder could read. */
  unread: Quad[];
}

/* ------------------------------------------------------------------ */
/* zxing                                                               */
/* ------------------------------------------------------------------ */

const ZXING_WASM_URL = "/models/zxing/zxing_reader.wasm";

type ZxingReader = typeof import("zxing-wasm/reader");
let zxingModule: Promise<ZxingReader> | null = null;

/** Load the zxing reader once, pointing emscripten at our staged wasm. */
export function loadZxing(): Promise<ZxingReader> {
  zxingModule ??= import("zxing-wasm/reader").then((mod) => {
    mod.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm") ? ZXING_WASM_URL : prefix + path,
      },
    });
    return mod;
  });
  return zxingModule;
}

const ZXING_OPTIONS: ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 8,
};

function zxingQuad(result: ReadResult): Quad | undefined {
  const p = result.position;
  if (!p) return undefined;
  return [
    [p.topLeft.x, p.topLeft.y],
    [p.topRight.x, p.topRight.y],
    [p.bottomRight.x, p.bottomRight.y],
    [p.bottomLeft.x, p.bottomLeft.y],
  ];
}

async function zxingDecode(image: RawImage, opts?: Partial<ReaderOptions>): Promise<ScanHit[]> {
  const zxing = await loadZxing();
  // The DOM lib types ImageData's buffer as non-shared; ours always is.
  const data = new ImageData(
    image.data as Uint8ClampedArray<ArrayBuffer>,
    image.width,
    image.height,
  );
  const results = await zxing.readBarcodes(data, { ...ZXING_OPTIONS, ...opts });
  return results
    .filter((r) => r.isValid && r.text.length > 0)
    .map((r) => ({ text: r.text, method: "zxing" as const, corners: zxingQuad(r) }));
}

/* ------------------------------------------------------------------ */
/* standard scan: jsQR then zxing on the full image                    */
/* ------------------------------------------------------------------ */

export type Inversion = "attemptBoth" | "dontInvert" | "onlyInvert";

function jsqrDecode(image: RawImage, inversion: Inversion): ScanHit[] {
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: inversion });
  if (!found || !found.data) return [];
  const loc = found.location;
  const corners: Quad | undefined = loc
    ? [
        [loc.topLeftCorner.x, loc.topLeftCorner.y],
        [loc.topRightCorner.x, loc.topRightCorner.y],
        [loc.bottomRightCorner.x, loc.bottomRightCorner.y],
        [loc.bottomLeftCorner.x, loc.bottomLeftCorner.y],
      ]
    : undefined;
  return [{ text: found.data, method: "jsqr", corners }];
}

function mergeHits(into: ScanHit[], hits: ScanHit[]): ScanHit[] {
  for (const hit of hits) {
    if (!into.some((h) => h.text === hit.text)) into.push(hit);
  }
  return into;
}

/**
 * The classical pass: jsQR synchronously, then zxing with every robustness
 * flag on. Returns all distinct codes found.
 */
export async function scanStandard(image: RawImage, inversion: Inversion): Promise<ScanHit[]> {
  const hits = jsqrDecode(image, inversion);
  try {
    mergeHits(hits, await zxingDecode(image));
  } catch {
    // zxing failing to load (offline before first cache) must not take down
    // the jsQR path; the deep scan can still be attempted independently.
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* deep scan engine                                                    */
/* ------------------------------------------------------------------ */

const MODEL_URL = "/models/qr-detector/qr-detector.onnx";
/** Bumped whenever the trained model changes: the URL stays the same, so the
 * cache name is what forces returning visitors onto the new weights. */
const CACHE_PREFIX = "tools-qr-deep-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
export const DETECTOR_THRESHOLD = 0.3;

/** The narrow slice of onnxruntime-web this module touches. */
interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
}
interface OrtModuleLike {
  env: { wasm: { wasmPaths?: string } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
}

export interface DeepEngine {
  session: OrtSessionLike;
  makeTensor: (data: Float32Array) => unknown;
  provider: "webgpu" | "wasm";
}

export interface DownloadProgress {
  received: number;
  total: number;
}

let enginePromise: Promise<DeepEngine> | null = null;

/** True once the model bytes are in Cache Storage (no network needed). */
export async function deepModelCached(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(MODEL_URL)) !== undefined;
  } catch {
    return false;
  }
}

async function openModelCache(): Promise<Cache | null> {
  try {
    // Drop buckets from older model versions so a stale 15 MB detector never
    // lingers next to the current one.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)),
    );
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function fetchModel(onProgress?: (p: DownloadProgress) => void): Promise<Uint8Array> {
  const cache = await openModelCache();
  const hit = cache ? await cache.match(MODEL_URL) : undefined;
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("Content-Length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (cache) {
    try {
      await cache.put(MODEL_URL, new Response(bytes.slice().buffer));
    } catch {
      // Quota pressure: run from memory this visit, refetch next time.
    }
  }
  return bytes;
}

/**
 * Download the detector (once; Cache Storage after that) and open an ONNX
 * session, WebGPU first with WASM fallback, exactly like the upscaler. The
 * import is `onnxruntime-web/webgpu` on purpose: that bundle carries both
 * execution providers and loads the .asyncify wasm files staged under
 * /models/ort/; the plain entry point wants a jsep build that is not staged.
 */
export function ensureDeepEngine(onProgress?: (p: DownloadProgress) => void): Promise<DeepEngine> {
  enginePromise ??= (async () => {
    const [ortModule, model] = await Promise.all([
      import("onnxruntime-web/webgpu") as Promise<unknown>,
      fetchModel(onProgress),
    ]);
    const ort = ortModule as OrtModuleLike;
    ort.env.wasm.wasmPaths = "/models/ort/";
    const makeTensor = (data: Float32Array) => new ort.Tensor("float32", data, [1, 3, 512, 512]);
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ["webgpu"],
      });
      return { session, makeTensor, provider: "webgpu" as const };
    } catch {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ["wasm"],
      });
      return { session, makeTensor, provider: "wasm" as const };
    }
  })();
  enginePromise.catch(() => {
    // A failed load must not poison every later attempt.
    enginePromise = null;
  });
  return enginePromise;
}

/* ------------------------------------------------------------------ */
/* deep scan                                                           */
/* ------------------------------------------------------------------ */

async function detectOnce(
  engine: DeepEngine,
  image: RawImage,
  threshold: number,
  topK: number,
): Promise<Detection[]> {
  const { pixels, params } = packLetterboxed(image);
  const tensor = rgbaToTensor(pixels);
  const outputs = await engine.session.run({ input: engine.makeTensor(tensor) });
  const hm = outputs.heatmap;
  const off = outputs.offsets;
  if (!hm || !off) throw new Error("detector returned unexpected outputs");
  const dets = decodeDetections(hm.data, off.data, { threshold, topK });
  return dets.map((d) => ({
    score: d.score,
    corners: unletterboxPoints(d.corners, params),
    mids: unletterboxPoints(d.mids, params),
  }));
}

function shiftDetection(det: Detection, dx: number, dy: number): Detection {
  const move = (points: [number, number][]) =>
    points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
  return {
    score: det.score,
    corners: move(det.corners) as Quad,
    mids: move(det.mids) as EdgeMids,
  };
}

/**
 * Run the detector on the full image and, for large photos, again over
 * overlapping tiles so codes that are tiny relative to the photo still land
 * on enough model pixels. Detections come back in source px, deduped.
 */
export async function detectCodes(
  engine: DeepEngine,
  image: RawImage,
  threshold = DETECTOR_THRESHOLD,
): Promise<Detection[]> {
  const found = await detectOnce(engine, image, threshold, 16);
  for (const tile of planTiles(image.width, image.height)) {
    const tileDets = await detectOnce(engine, cropTile(image, tile), threshold, 16);
    for (const det of tileDets) {
      const shifted = shiftDetection(det, tile.x, tile.y);
      const dup = found.findIndex((f) => sameCode(f.corners, shifted.corners));
      if (dup === -1) found.push(shifted);
      else if (found[dup]!.score < shifted.score) found[dup] = shifted;
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

/** Decode one rectified crop with every trick available. */
async function decodeCrop(crop: RawImage): Promise<ScanHit[]> {
  // tryDownscale stays on: soft, upscaled crops often decode only after
  // zxing halves them back toward their native module size.
  let hits = await zxingDecode(crop);
  if (hits.length) return hits;
  const direct = jsqrDecode(crop, "attemptBoth");
  if (direct.length) return direct;
  const stretched = contrastStretch(crop);
  hits = await zxingDecode(stretched);
  if (hits.length) return hits;
  hits = await zxingDecode(sharpen(stretched));
  if (hits.length) return hits;
  // Strong sharpen on the plain crop: soft focus over an upscaled crop
  // responds to aggressive unsharp masking where the mild pass does not.
  hits = await zxingDecode(sharpen(crop, 1.6));
  if (hits.length) return hits;
  hits = await decodeBinarized(crop);
  if (hits.length) return hits;
  // Grid resample: rebuild a perfect synthetic code from the finder grid,
  // absorbing shear, aspect drift, and smooth bends the surface models left
  // behind.
  const rebuilt = gridResample(crop);
  if (!rebuilt) return [];
  hits = jsqrDecode(rebuilt, "dontInvert");
  if (hits.length) return hits;
  return zxingDecode(rebuilt, { tryInvert: false, tryDownscale: false });
}

/**
 * Local-threshold rescue: binarize adaptively, then hand the clean binary
 * image to both decoders. Recovers ramps, shadow edges, and partial glare
 * that no global operation can fix.
 */
async function decodeBinarized(crop: RawImage): Promise<ScanHit[]> {
  const bin = adaptiveBinarize(crop);
  // The image is already two-level; re-binarizing with a local average would
  // only reintroduce artifacts at block boundaries.
  const hits = await zxingDecode(bin, { tryDownscale: false, binarizer: "FixedThreshold" });
  if (hits.length) return hits;
  return jsqrDecode(bin, "attemptBoth");
}

/**
 * Candidate arc angles for the cylinder sweep, radians. The 8 predicted
 * points cannot reveal how much lateral arc compression a wrapped code has,
 * so when the bow-corrected crop refuses to decode we resample at a few
 * plausible arcs and let Reed-Solomon pick the right one. The measured
 * sagitta is swept upward alongside because the detector under-reports bow
 * on strong wraps.
 */
const ARC_SWEEP = [0.9, 1.6, 2.3];
const ARC_SAGITTA_SCALES = [1, 1.9];
/** Bow (midpoint deviation / side) above which a code looks wrapped. */
const ARC_BOW_MIN = 0.012;
/** Margin used when a crop is cut for the second-pass refinement. */
const REFINE_MARGIN = 0.16;

/**
 * Second-pass refinement: rectify with the plain corner homography, run the
 * detector again on the near-frontal crop where it is far more accurate, and
 * map the refined points back to source space through the exact homography.
 */
async function refineDetection(
  engine: DeepEngine,
  image: RawImage,
  det: Detection,
): Promise<Detection> {
  const size = chooseRectifySize(det.corners);
  const crop = rectifyQuad(image, det.corners, size, REFINE_MARGIN);
  const found = await detectOnce(engine, crop, DETECTOR_THRESHOLD, 4);
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

async function attemptDetection(image: RawImage, det: Detection): Promise<ScanHit[]> {
  const size = chooseRectifySize(det.corners);
  const crop = rectifyQuad(image, det.corners, size, 0.1, det.mids as EdgeMids);
  let hits = await decodeCrop(crop);
  if (hits.length) return hits;

  // Margin sweep: with corners slightly off, a tighter or looser quiet zone
  // assumption realigns the module grid enough to decode.
  for (const margin of [0.04, 0.22]) {
    const m = rectifyQuad(image, det.corners, size, margin, det.mids as EdgeMids);
    hits = await zxingDecode(m);
    if (!hits.length) hits = jsqrDecode(m, "attemptBoth");
    if (hits.length) return hits;
  }

  // Scale bump: small codes suffer module aliasing at the default size.
  if (size < 460) {
    const big = rectifyQuad(image, det.corners, Math.round(size * 1.8), 0.1, det.mids as EdgeMids);
    hits = await zxingDecode(big);
    if (!hits.length) hits = await decodeBinarized(big);
    if (hits.length) return hits;
  }

  const [bowU, bowV] = bowMagnitudes(det.corners, det.mids as EdgeMids);
  const axis = bowU >= bowV ? ("u" as const) : ("v" as const);
  const shift = unitMidShift(det.corners, det.mids as EdgeMids, axis === "v");
  if (Math.max(bowU, bowV) < ARC_BOW_MIN && Math.abs(shift) < 0.02) return [];
  // Off-center wraps (a label read from the side) need a phase term; the
  // measured midpoint shift orders the sweep so the likely side goes first.
  const phaseOrder = shift >= 0 ? [0, 0.35, -0.35, 0.65, -0.65] : [0, -0.35, 0.35, -0.65, 0.65];
  for (const theta of ARC_SWEEP) {
    for (const scale of ARC_SAGITTA_SCALES) {
      for (const phaseFrac of phaseOrder) {
        const unrolled = rectifyCylinder(
          image,
          det.corners,
          det.mids as EdgeMids,
          size,
          0.1,
          theta,
          axis,
          scale,
          (phaseFrac * theta) / 2,
        );
        let arcHits = await zxingDecode(unrolled);
        if (!arcHits.length && phaseFrac === 0) arcHits = jsqrDecode(unrolled, "attemptBoth");
        if (!arcHits.length && scale === 1 && phaseFrac === 0) {
          arcHits = await zxingDecode(contrastStretch(unrolled));
        }
        if (arcHits.length) return arcHits;
      }
    }
  }
  return [];
}

async function decodeDetection(
  engine: DeepEngine,
  image: RawImage,
  det: Detection,
): Promise<ScanHit[]> {
  let hits = await attemptDetection(image, det);
  let current = det;
  for (let pass = 0; pass < 2 && !hits.length; pass++) {
    const refined = await refineDetection(engine, image, current);
    if (refined === current) break;
    current = refined;
    hits = await attemptDetection(image, current);
  }
  return hits;
}

/**
 * The full ML-assisted pass: detect codes, rectify each (bow-corrected via
 * the predicted edge midpoints) out of the original full-resolution image,
 * and throw the decoders at every crop. `known` suppresses codes the
 * standard pass already read.
 */
export async function deepScan(
  engine: DeepEngine,
  image: RawImage,
  known: ScanHit[] = [],
): Promise<DeepScanResult> {
  const detections = await detectCodes(engine, image);
  const hits: ScanHit[] = [];
  const unread: Quad[] = [];
  const knownTexts = new Set(known.map((h) => h.text));

  for (const det of detections) {
    if (quadSide(det.corners) < 8) continue;
    const covered = [...known, ...hits].some(
      (h) => h.corners && sameCode(h.corners, det.corners),
    );
    if (covered) continue;

    const cropHits = await decodeDetection(engine, image, det);
    const fresh = cropHits.filter((h) => !knownTexts.has(h.text));
    if (fresh.length) {
      for (const hit of fresh) {
        knownTexts.add(hit.text);
        hits.push({ text: hit.text, method: "deep", corners: det.corners });
      }
    } else if (!cropHits.length && det.score >= 0.5) {
      // Only confidently detected shapes earn the "could not read" hint;
      // marginal detections from the tiled pass stay silent rather than
      // teasing codes that may not exist.
      unread.push(det.corners);
    }
  }
  return { hits, unread };
}
