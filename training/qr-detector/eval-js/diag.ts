/**
 * Diagnose one real failing image: run the exact deep-scan pipeline, print
 * every stage's outcome, and dump every intermediate crop for inspection.
 *
 *   npx -y tsx diag.ts <image> <outdir>
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import {
  type EdgeMids,
  type RawImage,
  adaptiveBinarize,
  bowMagnitudes,
  chooseRectifySize,
  contrastStretch,
  gridResampleCandidates,
  quadGridResample,
  QUAD_GRID_VERSIONS,
  quadSide,
  rectifyCylinder,
  rectifyQuad,
  sharpen,
  unitMidShift,
} from "../../../src/tools/qr-code-scanner/detector";
import { type Det, detectAll, encodePng, refineDetection } from "./pipeline";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");

const [, , imagePath, outDir = "diag-out"] = process.argv;
if (!imagePath) throw new Error("usage: tsx diag.ts <image> [outdir]");
mkdirSync(outDir, { recursive: true });

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

const save = (name: string, img: RawImage) => writeFileSync(join(outDir, name), encodePng(img));

const ZXING_OPTIONS = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 16,
} as const;

const zxing = (await import("zxing-wasm/reader")) as typeof import("zxing-wasm/reader");
const session = await ort.InferenceSession.create("../export/qr-detector.onnx");
const makeTensor = (data: Float32Array) => new ort.Tensor("float32", data, [1, 3, 512, 512]);

async function zx(img: RawImage, binarizer?: "FixedThreshold"): Promise<string[]> {
  const results = await zxing.readBarcodes(encodePng(img), {
    ...ZXING_OPTIONS,
    ...(binarizer ? { binarizer } : {}),
  });
  return results.filter((r) => r.isValid).map((r) => r.text);
}

function jq(img: RawImage): string[] {
  const j = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
  return j?.data ? [j.data] : [];
}

const image = readImage(imagePath);
console.log(`image ${image.width}x${image.height}`);

// Stage 0: classical on the full image.
console.log("full jsQR:", jq(image));
console.log("full zxing:", await zx(image));

// Stage 1: detection.
const dets = await detectAll(session, makeTensor, image);
console.log(`detections: ${dets.length}`);

const report = async (label: string, img: RawImage): Promise<boolean> => {
  const z = await zx(img);
  const j = z.length ? [] : jq(img);
  const hit = z[0] ?? j[0];
  console.log(`  ${label}: zxing=${z[0] ?? "-"} jsqr=${j[0] ?? "-"}`);
  return Boolean(hit);
};

for (let d = 0; d < Math.min(dets.length, 4); d++) {
  const det = dets[d]!;
  console.log(
    `det ${d}: score ${det.score.toFixed(2)} side ${Math.round(quadSide(det.corners))}px ` +
      `corners ${JSON.stringify(det.corners.map((c) => c.map(Math.round)))}`,
  );
  const variants: [string, Det][] = [["base", det]];
  const refined = await refineDetection(session, makeTensor, image, det);
  if (refined !== det) variants.push(["refined", refined]);
  else console.log("  refinement: no central redetection");

  for (const [tag, v] of variants) {
    const size = chooseRectifySize(v.corners);
    const crop = rectifyQuad(image, v.corners, size, 0.1, v.mids);
    save(`det${d}-${tag}-crop.png`, crop);
    if (await report(`${tag} crop`, crop)) continue;
    await report(`${tag} stretch`, contrastStretch(crop));
    await report(`${tag} sharp16`, sharpen(crop, 1.6));
    const bin = adaptiveBinarize(crop);
    save(`det${d}-${tag}-bin.png`, bin);
    await report(`${tag} binarized`, bin);
    const rebuilds = gridResampleCandidates(crop);
    if (!rebuilds.length) console.log(`  ${tag} gridResample: no finder grid`);
    for (let r = 0; r < rebuilds.length; r++) {
      save(`det${d}-${tag}-grid-${r}.png`, rebuilds[r]!);
      if (await report(`${tag} gridResample[${r}]`, rebuilds[r]!)) break;
    }
    let quadHit = "";
    for (const version of QUAD_GRID_VERSIONS) {
      const q = quadGridResample(crop, 0.1, version);
      const j = jq(q);
      if (j.length) {
        quadHit = `v${version}: ${j[0]}`;
        save(`det${d}-${tag}-quadgrid-v${version}.png`, q);
        break;
      }
    }
    console.log(`  ${tag} quadGrid sweep: ${quadHit || "no decode"}`);
    if (!quadHit) save(`det${d}-${tag}-quadgrid-v2.png`, quadGridResample(crop, 0.1, 2));
    const [bowU, bowV] = bowMagnitudes(v.corners, v.mids);
    const axis = bowU >= bowV ? ("u" as const) : ("v" as const);
    const shift = unitMidShift(v.corners, v.mids, axis === "v");
    console.log(
      `  ${tag} bowU ${bowU.toFixed(3)} bowV ${bowV.toFixed(3)} axis ${axis} shift ${shift.toFixed(3)}`,
    );
    let arcHit = "";
    for (const theta of [0.9, 1.6, 2.3]) {
      for (const scale of [1, 1.9]) {
        for (const pf of [0, 0.35, -0.35, 0.65, -0.65]) {
          const un = rectifyCylinder(image, v.corners, v.mids, size, 0.1, theta, axis, scale, (pf * theta) / 2);
          const z = await zx(un);
          if (z.length) {
            arcHit = `theta ${theta} scale ${scale} phase ${pf}: ${z[0]}`;
            save(`det${d}-${tag}-arc-hit.png`, un);
            break;
          }
        }
        if (arcHit) break;
      }
      if (arcHit) break;
    }
    console.log(`  ${tag} arc sweep: ${arcHit || "no decode"}`);
    if (!arcHit) {
      const un = rectifyCylinder(image, v.corners, v.mids, size, 0.1, 1.6, axis, 1, 0);
      save(`det${d}-${tag}-arc-sample.png`, un);
    }
  }
}
console.log("done; crops in", outDir);
