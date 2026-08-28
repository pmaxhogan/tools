/**
 * Score the real JS scan pipeline against the held-out eval sets.
 *
 * Stages, cumulative, mirroring src/lib/qr-scan.ts:
 *   A  jsQR on the full image (the old scanner)
 *   B  A + zxing-wasm with every robustness flag (the new standard pass)
 *   C  B + deep scan: ONNX detector, bow-corrected rectification, decode
 *      cascade on each crop (the new deep pass)
 *
 * A GT code counts as decoded by a stage when its exact payload was returned
 * by that stage or an earlier one. Run AFTER export.py has produced
 * export/qr-detector.onnx and make_eval_set.py has written data/eval/:
 *
 *   cd training/qr-detector/eval-js && npm install && npx -y tsx run.ts
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { type Quad, type RawImage } from "../../../src/tools/qr-code-scanner/detector";
import { type Det, decodeDetection, detectAll, refineDetection } from "./pipeline";

const require = createRequire(import.meta.url);
// onnxruntime-node is CJS; require keeps tsx happy on every platform.
const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");

const ROOT = join(import.meta.dirname, "..");
const MODEL = join(ROOT, "export", "qr-detector.onnx");

/* ------------------------------------------------------------------ */
/* ground truth                                                        */
/* ------------------------------------------------------------------ */

interface GtCode {
  payload: string;
  points: [number, number][];
  side_px: number;
  n_modules: number;
  ecc: string;
  logo_frac: number;
  cylinder: boolean;
  occluded: boolean;
}

interface GtRow {
  index: number;
  blur_sigma: number;
  noise_std: number;
  jpeg_q: number;
  codes: GtCode[];
}

function loadSet(name: string): { dir: string; rows: GtRow[] } {
  const dir = join(ROOT, "data", "eval", name);
  const rows = readFileSync(join(dir, "gt.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as GtRow);
  return { dir, rows };
}

function readPng(path: string): { image: RawImage; bytes: Uint8Array } {
  const bytes = readFileSync(path);
  const png = PNG.sync.read(bytes);
  return {
    image: {
      data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
      width: png.width,
      height: png.height,
    },
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
  };
}

/* ------------------------------------------------------------------ */
/* engines                                                             */
/* ------------------------------------------------------------------ */

type Zxing = typeof import("zxing-wasm/reader");

async function loadZxing(): Promise<Zxing> {
  const mod = (await import("zxing-wasm/reader")) as Zxing;
  return mod;
}

const ZXING_OPTIONS = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 8,
} as const;

async function zxingTexts(zxing: Zxing, pngBytes: Uint8Array): Promise<string[]> {
  const results = await zxing.readBarcodes(pngBytes, { ...ZXING_OPTIONS });
  return results.filter((r) => r.isValid && r.text.length > 0).map((r) => r.text);
}

function jsqrTexts(image: RawImage): string[] {
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
  return found && found.data ? [found.data] : [];
}

/* ------------------------------------------------------------------ */
/* deep stage: see pipeline.ts, the shared mirror of src/lib/qr-scan   */
/* ------------------------------------------------------------------ */

const makeTensor = (data: Float32Array) => new ort.Tensor("float32", data, [1, 3, 512, 512]);

async function deepTexts(
  zxing: Zxing,
  session: import("onnxruntime-node").InferenceSession,
  image: RawImage,
  dets: Det[],
): Promise<string[]> {
  const texts: string[] = [];
  const refine = (img: RawImage, det: Det) => refineDetection(session, makeTensor, img, det);
  for (const det of dets) {
    texts.push(...(await decodeDetection((png) => zxingTexts(zxing, png), image, det, refine)));
  }
  return texts;
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

interface CodeOutcome {
  gt: GtCode;
  blurSigma: number;
  detected: boolean;
  byStage: [boolean, boolean, boolean]; // A, B, C cumulative
}

function cornersOf(code: GtCode): Quad {
  return code.points.slice(0, 4) as Quad;
}

function detMatches(det: Det, code: GtCode): boolean {
  const gt = cornersOf(code);
  let err = 0;
  for (let k = 0; k < 4; k++) {
    err += Math.hypot(det.corners[k]![0] - gt[k]![0], det.corners[k]![1] - gt[k]![1]);
  }
  err /= 4;
  return err < Math.max(6, code.side_px * 0.15);
}

async function evalSet(
  name: string,
  session: import("onnxruntime-node").InferenceSession | null,
  zxing: Zxing,
) {
  const { dir, rows } = loadSet(name);
  const outcomes: CodeOutcome[] = [];
  let falsePositives = 0;
  let images = 0;

  for (const row of rows) {
    const { image, bytes } = readPng(join(dir, `${String(row.index).padStart(5, "0")}.png`));
    images++;

    const a = new Set(jsqrTexts(image));
    const b = new Set([...a, ...(await zxingTexts(zxing, bytes))]);
    const dets = session ? await detectAll(session, makeTensor, image) : [];
    const c = new Set([...b, ...(session ? await deepTexts(zxing, session, image, dets) : [])]);

    for (const det of dets) {
      if (!row.codes.some((code) => detMatches(det, code))) falsePositives++;
    }
    for (const code of row.codes) {
      outcomes.push({
        gt: code,
        blurSigma: row.blur_sigma,
        detected: dets.some((det) => detMatches(det, code)),
        byStage: [a.has(code.payload), b.has(code.payload), c.has(code.payload)],
      });
    }
    if (images % 100 === 0) console.log(`${name}: ${images}/${rows.length} images`);
  }

  const rate = (subset: CodeOutcome[], stage: number) =>
    subset.length
      ? (subset.filter((o) => o.byStage[stage]).length / subset.length) * 100
      : NaN;
  const detRate = (subset: CodeOutcome[]) =>
    subset.length ? (subset.filter((o) => o.detected).length / subset.length) * 100 : NaN;

  const buckets: [string, (o: CodeOutcome) => boolean][] = [
    ["all", () => true],
    ["small (side < 48px)", (o) => o.gt.side_px < 48],
    ["medium (48 to 96px)", (o) => o.gt.side_px >= 48 && o.gt.side_px < 96],
    ["large (>= 96px)", (o) => o.gt.side_px >= 96],
    ["cylinder wrapped", (o) => o.gt.cylinder],
    ["center logo", (o) => o.gt.logo_frac > 0],
    ["logo > ECC limit /2", (o) => o.gt.logo_frac > 0.12],
    ["occluded patch", (o) => o.gt.occluded],
    ["heavy blur (sigma > 1.6)", (o) => o.blurSigma > 1.6],
  ];

  console.log(`\n=== ${name}: ${outcomes.length} codes in ${images} images ===`);
  console.log("bucket | n | jsQR | +zxing | +deep | det recall");
  const table = buckets.map(([label, pred]) => {
    const subset = outcomes.filter(pred);
    const line = {
      bucket: label,
      n: subset.length,
      jsqr: +rate(subset, 0).toFixed(1),
      zxing: +rate(subset, 1).toFixed(1),
      deep: +rate(subset, 2).toFixed(1),
      detRecall: +detRate(subset).toFixed(1),
    };
    console.log(
      `${line.bucket} | ${line.n} | ${line.jsqr}% | ${line.zxing}% | ${line.deep}% | ${line.detRecall}%`,
    );
    return line;
  });
  console.log(`false positives: ${falsePositives} in ${images} images`);
  return { name, images, codes: outcomes.length, falsePositives, table };
}

import { existsSync } from "node:fs";
const session = existsSync(MODEL) ? await ort.InferenceSession.create(MODEL) : null;
if (!session) console.log("NOTE: export/qr-detector.onnx missing, deep stage skipped");
const zxing = await loadZxing();
const results = [];
for (const set of ["hard", "liketrain", "lookalike"]) {
  results.push(await evalSet(set, session, zxing));
}
writeFileSync(join(import.meta.dirname, "results.json"), JSON.stringify(results, null, 2));
console.log("\nwrote results.json");
