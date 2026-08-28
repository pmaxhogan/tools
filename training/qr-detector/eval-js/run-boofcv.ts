/**
 * Score the JS scan pipeline on BoofCV's real-photo QR benchmark
 * (boofcv.org, qrcodes_v3): 16 difficulty categories of hand-labeled
 * photographs. The labels are corner quads only (no payload ground truth), so
 * the metrics are location-matched: a code counts as decoded by a stage when
 * that stage returned a payload whose reported position sits on the labeled
 * quad (Reed-Solomon validation makes a false decode astronomically
 * unlikely), and detector recall counts labeled quads matched by a detection.
 *
 *   cd training/qr-detector/eval-js && npx -y tsx run-boofcv.ts
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { type Quad, type RawImage, quadSide } from "../../../src/tools/qr-code-scanner/detector";
import { type Det, decodeDetection, detectAll, encodePng, refineDetection } from "./pipeline";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data", "boofcv-qr", "qrcodes", "detection");
const MODEL = join(ROOT, "export", "qr-detector.onnx");

/* ------------------------------------------------------------------ */

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

/**
 * Parse BoofCV's hand-label files. Two formats exist in the set: "SETS" files
 * with 8 floats per line (one quad per line), and point-per-line files where
 * every 4 consecutive x y lines form one quad.
 */
function parseLabels(path: string): Quad[] {
  const quads: Quad[] = [];
  const pending: [number, number][] = [];
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

/* ------------------------------------------------------------------ */

type Zxing = typeof import("zxing-wasm/reader");
const ZXING_OPTIONS = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 16,
} as const;

interface Located {
  text: string;
  quad?: Quad;
}

async function zxingHits(zxing: Zxing, input: Uint8Array | RawImage): Promise<Located[]> {
  const payload = input instanceof Uint8Array ? input : encodePng(input);
  const results = await zxing.readBarcodes(payload, { ...ZXING_OPTIONS });
  return results
    .filter((r) => r.isValid && r.text.length > 0)
    .map((r) => ({
      text: r.text,
      quad: r.position
        ? ([
            [r.position.topLeft.x, r.position.topLeft.y],
            [r.position.topRight.x, r.position.topRight.y],
            [r.position.bottomRight.x, r.position.bottomRight.y],
            [r.position.bottomLeft.x, r.position.bottomLeft.y],
          ] as Quad)
        : undefined,
    }));
}

function jsqrHits(image: RawImage): Located[] {
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
  if (!found || !found.data) return [];
  const loc = found.location;
  return [
    {
      text: found.data,
      quad: loc
        ? ([
            [loc.topLeftCorner.x, loc.topLeftCorner.y],
            [loc.topRightCorner.x, loc.topRightCorner.y],
            [loc.bottomRightCorner.x, loc.bottomRightCorner.y],
            [loc.bottomLeftCorner.x, loc.bottomLeftCorner.y],
          ] as Quad)
        : undefined,
    },
  ];
}

const makeTensor = (data: Float32Array) => new ort.Tensor("float32", data, [1, 3, 512, 512]);

async function deepHits(
  zxing: Zxing,
  session: import("onnxruntime-node").InferenceSession,
  image: RawImage,
  dets: Det[],
): Promise<Located[]> {
  const hits: Located[] = [];
  const zxingPng = async (png: Uint8Array) => (await zxingHits(zxing, png)).map((h) => h.text);
  const refine = (img: RawImage, det: Det) => refineDetection(session, makeTensor, img, det);
  for (const det of dets) {
    for (const text of await decodeDetection(zxingPng, image, det, refine)) {
      hits.push({ text, quad: det.corners });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */

const session = existsSync(MODEL) ? await ort.InferenceSession.create(MODEL) : null;
if (!session) console.log("NOTE: export/qr-detector.onnx missing, deep stage skipped");
const zxing = (await import("zxing-wasm/reader")) as Zxing;

const categories = readdirSync(DATA, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

interface CatResult {
  category: string;
  images: number;
  codes: number;
  jsqr: number;
  zxing: number;
  deep: number;
  detRecall: number;
  falsePositives: number;
}

const rows: CatResult[] = [];
for (const category of categories) {
  const dir = join(DATA, category);
  const images = readdirSync(dir).filter((f) => /\.(jpg|png)$/i.test(f));
  const result: CatResult = {
    category,
    images: images.length,
    codes: 0,
    jsqr: 0,
    zxing: 0,
    deep: 0,
    detRecall: 0,
    falsePositives: 0,
  };
  for (const file of images) {
    const labels = parseLabels(join(dir, file.replace(/\.(jpg|png)$/i, ".txt")));
    if (!labels.length) continue;
    const image = readImage(join(dir, file));
    const fileBytes = readFileSync(join(dir, file));
    const raw = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.length);

    const a = jsqrHits(image);
    const b = [...a, ...(await zxingHits(zxing, raw))];
    const dets = session ? await detectAll(session, makeTensor, image) : [];
    const c = [...b, ...(session ? await deepHits(zxing, session, image, dets) : [])];

    result.codes += labels.length;
    for (const label of labels) {
      if (a.some((h) => onLabel(h.quad, label))) result.jsqr++;
      if (b.some((h) => onLabel(h.quad, label))) result.zxing++;
      if (c.some((h) => onLabel(h.quad, label))) result.deep++;
      if (dets.some((d) => onLabel(d.corners, label))) result.detRecall++;
    }
    for (const det of dets) {
      if (!labels.some((label) => onLabel(det.corners, label))) result.falsePositives++;
    }
  }
  console.log(
    `${category}: ${result.codes} codes | jsQR ${result.jsqr} | +zxing ${result.zxing} | ` +
      `+deep ${result.deep} | det ${result.detRecall} | FP ${result.falsePositives}`,
  );
  rows.push(result);
}

const total = rows.reduce(
  (acc, r) => ({
    category: "TOTAL",
    images: acc.images + r.images,
    codes: acc.codes + r.codes,
    jsqr: acc.jsqr + r.jsqr,
    zxing: acc.zxing + r.zxing,
    deep: acc.deep + r.deep,
    detRecall: acc.detRecall + r.detRecall,
    falsePositives: acc.falsePositives + r.falsePositives,
  }),
  { category: "TOTAL", images: 0, codes: 0, jsqr: 0, zxing: 0, deep: 0, detRecall: 0, falsePositives: 0 },
);
rows.push(total);
console.log(
  `TOTAL: ${total.codes} codes | jsQR ${total.jsqr} | +zxing ${total.zxing} | +deep ${total.deep} | ` +
    `det ${total.detRecall} | FP ${total.falsePositives}`,
);
writeFileSync(join(import.meta.dirname, "results-boofcv.json"), JSON.stringify(rows, null, 2));
console.log("wrote results-boofcv.json");
