import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { type RawImage, quadGridResample } from "../../../src/tools/qr-code-scanner/detector";
const readPng = (p: string): RawImage => {
  const png = PNG.sync.read(readFileSync(p));
  return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
};
const enc = (img: RawImage) => {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(png.data);
  return PNG.sync.write(png);
};
const [,, cropPath, outPrefix, ...versions] = process.argv;
const crop = readPng(cropPath!);
for (const v of versions.map(Number)) {
  writeFileSync(`${outPrefix}-v${v}.png`, enc(quadGridResample(crop, 0.1, v)));
}
console.log("ok");
