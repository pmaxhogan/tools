import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { type RawImage, findFinderPatterns } from "../../../src/tools/qr-code-scanner/detector";
const png = PNG.sync.read(readFileSync(process.argv[2]!));
const img: RawImage = { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
const finders = findFinderPatterns(img);
console.log(`crop ${img.width}x${img.height}`);
for (const f of finders) {
  console.log(`finder (${Math.round(f.x)}, ${Math.round(f.y)}) mx ${f.mx.toFixed(1)} my ${f.my.toFixed(1)} hits ${(f as any).hits}`);
}
