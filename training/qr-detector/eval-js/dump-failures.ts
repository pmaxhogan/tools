/**
 * Debug tool: dump the detected-but-undecoded codes from the BoofCV set as
 * rectified crops plus annotated source context, so decode failures can be
 * inspected and classified instead of guessed at.
 *
 *   cd training/qr-detector/eval-js && npx -y tsx dump-failures.ts
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  type Quad,
  type RawImage,
  chooseRectifySize,
  quadSide,
  rectifyQuad,
} from "../../../src/tools/qr-code-scanner/detector";
import { type Det, decodeDetection, detectAll, encodePng, refineDetection } from "./pipeline";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data", "boofcv-qr", "qrcodes", "detection");
const MODEL = join(ROOT, "export", "qr-detector.onnx");
const OUT = join(import.meta.dirname, "failures");

function readImage(path: string): RawImage {
  const bytes = readFileSync(path);
  if (path.toLowerCase().endsWith(".png")) {
    const png = PNG.sync.read(bytes);
    return {
      data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
      width: png.width,
      height: png.height,
    };
  }
  const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return {
    data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
    width: img.width,
    height: img.height,
  };
}

function parseLabels(path: string): Quad[] {
  const quads: Quad[] = [];
  const pending: [number, number][] = [];
  if (!existsSync(path)) return quads;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t === "SETS") continue;
    const nums = t.split(/\s+/).map(Number);
    if (nums.some(Number.isNaN)) continue;
    if (nums.length >= 8) {
      quads.push([
        [nums[0]!, nums[1]!],
        [nums[2]!, nums[3]!],
        [nums[4]!, nums[5]!],
        [nums[6]!, nums[7]!],
      ]);
    } else if (nums.length === 2) {
      pending.push([nums[0]!, nums[1]!]);
      if (pending.length === 4) {
        quads.push([pending[0]!, pending[1]!, pending[2]!, pending[3]!]);
        pending.length = 0;
      }
    }
  }
  return quads;
}

function center(q: Quad): [number, number] {
  return [
    (q[0]![0] + q[1]![0] + q[2]![0] + q[3]![0]) / 4,
    (q[0]![1] + q[1]![1] + q[2]![1] + q[3]![1]) / 4,
  ];
}

function onLabel(q: Quad | undefined, label: Quad): boolean {
  if (!q) return false;
  const [cx, cy] = center(q);
  const [lx, ly] = center(label);
  return Math.hypot(cx - lx, cy - ly) < Math.max(12, quadSide(label) * 0.6);
}

type Zxing = typeof import("zxing-wasm/reader");
const ZXING_OPTIONS = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 16,
} as const;

/* ------------------------------------------------------------------ */

const session = await ort.InferenceSession.create(MODEL);
const zxing = (await import("zxing-wasm/reader")) as Zxing;
const makeTensor = (data: Float32Array) => new ort.Tensor("float32", data, [1, 3, 512, 512]);
const zxingPng = async (png: Uint8Array, binarizer?: string) =>
  (
    await zxing.readBarcodes(png, {
      ...ZXING_OPTIONS,
      ...(binarizer ? { binarizer: binarizer as "FixedThreshold" } : {}),
    })
  )
    .filter((r) => r.isValid)
    .map((r) => r.text);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface FailureMeta {
  file: string;
  category: string;
  sidePx: number;
  score: number;
  refinedMoved: boolean;
}
const meta: FailureMeta[] = [];
let dumped = 0;

const categories = readdirSync(DATA, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const category of categories) {
  const dir = join(DATA, category);
  const images = readdirSync(dir).filter((f) => /\.(jpg|png)$/i.test(f));
  for (const file of images) {
    const labels = parseLabels(join(dir, file.replace(/\.(jpg|png)$/i, ".txt")));
    if (!labels.length) continue;
    const image = readImage(join(dir, file));

    // Full pipeline: what did zxing on the raw file already get?
    const fileBytes = readFileSync(join(dir, file));
    const rawTexts = await zxing.readBarcodes(new Uint8Array(fileBytes), { ...ZXING_OPTIONS });
    const rawQuads: Quad[] = rawTexts
      .filter((r) => r.isValid && r.position)
      .map((r) => [
        [r.position.topLeft.x, r.position.topLeft.y],
        [r.position.topRight.x, r.position.topRight.y],
        [r.position.bottomRight.x, r.position.bottomRight.y],
        [r.position.bottomLeft.x, r.position.bottomLeft.y],
      ]);

    const dets = await detectAll(session, makeTensor, image);
    const refine = (img: RawImage, det: Det) => refineDetection(session, makeTensor, img, det);

    for (const label of labels) {
      if (rawQuads.some((q) => onLabel(q, label))) continue; // classical pass got it
      const det = dets.find((d) => onLabel(d.corners, label));
      if (!det) continue; // not detected: not a decode failure
      const texts = await decodeDetection(zxingPng, image, det, refine);
      if (texts.length) continue; // deep pass got it

      // A genuine detected-but-undecoded failure: dump crop + refined crop.
      const size = chooseRectifySize(det.corners);
      const crop = rectifyQuad(image, det.corners, size, 0.1, det.mids);
      const refined = await refineDetection(session, makeTensor, image, det);
      const refCrop = rectifyQuad(image, refined.corners, size, 0.1, refined.mids);
      const stem = `${String(dumped).padStart(3, "0")}-${category}`;
      writeFileSync(join(OUT, `${stem}-a.png`), encodePng(crop));
      writeFileSync(join(OUT, `${stem}-b.png`), encodePng(refCrop));
      meta.push({
        file: `${category}/${file}`,
        category,
        sidePx: Math.round(quadSide(det.corners)),
        score: Math.round(det.score * 100) / 100,
        refinedMoved: refined !== det,
      });
      dumped++;
    }
  }
  console.log(`${category} done (${dumped} failures so far)`);
}

writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
console.log(`dumped ${dumped} failing codes to ${OUT}`);
