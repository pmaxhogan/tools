/**
 * Rasterizes the brand SVGs into every PNG the site and PWA need.
 *
 * Sources (public/):
 *   logo.svg     full-detail claw-hammer + magnifying-glass mark (transparent)
 *   favicon.svg  chunkier, small-size-legible variant of the same mark
 *
 * Outputs (public/):
 *   favicon-16.png / favicon-32.png / favicon-48.png  transparent tab icons
 *   favicon.ico                                        PNG-compressed .ico (32px)
 *   apple-touch-icon.png   180x180, mark padded on the paper background so iOS
 *                          never clips a transparent glyph to a black square
 *   icon-192.png / icon-512.png            transparent PWA icons (purpose any)
 *   icon-maskable-512.png  mark inside the central safe zone on a filled paper
 *                          background (purpose maskable)
 *
 * Idempotent: every run overwrites the same files. Self-contained: the only
 * dependency is sharp (already a devDependency). Run: node scripts/generate-icons.mjs
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Warm paper background (DESIGN.md --background, light). Used behind the
// maskable and apple-touch icons so the violet glyph reads on iOS/Android.
const PAPER = { r: 0xf6, g: 0xf4, b: 0xf1, alpha: 1 };

const logo = readFileSync(join(publicDir, 'logo.svg'));
const favicon = readFileSync(join(publicDir, 'favicon.svg'));

// The SVGs use a 64-unit viewBox. sharp rasterizes SVGs at 72dpi by default,
// which would upscale (blur) any target larger than 64px. Scaling the density
// to the target renders the vector crisply at native resolution.
function rasterize(svg, size) {
  return sharp(svg, { density: Math.ceil((72 * size) / 64) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// A glyph centered at `fraction` of the canvas on the paper background.
async function padded(svg, canvas, fraction) {
  const glyph = await rasterize(svg, Math.round(canvas * fraction));
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: PAPER },
  })
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toBuffer();
}

// Minimal Vista-era .ico: a single PNG-compressed entry. No new dependency.
function pngToIco(png, dim) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(dim >= 256 ? 0 : dim, 0); // width (0 == 256)
  entry.writeUInt8(dim >= 256 ? 0 : dim, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // offset to PNG bytes
  return Buffer.concat([header, entry, png]);
}

async function write(name, buf) {
  writeFileSync(join(publicDir, name), buf);
  console.log(`  wrote public/${name} (${buf.length} bytes)`);
}

async function main() {
  console.log('Generating icons from logo.svg / favicon.svg');

  // Transparent tab favicons from the chunky small-size variant.
  await write('favicon-16.png', await rasterize(favicon, 16));
  const fav32 = await rasterize(favicon, 32);
  await write('favicon-32.png', fav32);
  await write('favicon-48.png', await rasterize(favicon, 48));

  // Legacy / crawler-blind .ico, built from the 32px favicon PNG.
  await write('favicon.ico', pngToIco(fav32, 32));

  // Transparent PWA icons (purpose: any) from the full-detail mark.
  await write('icon-192.png', await rasterize(logo, 192));
  await write('icon-512.png', await rasterize(logo, 512));

  // Filled-background icons. iOS home screen: ~70% glyph on paper.
  await write('apple-touch-icon.png', await padded(logo, 180, 0.7));

  // Maskable: content must sit inside the central safe circle, so the mark is
  // rendered at ~65% of the canvas, centered, on the paper background.
  await write('icon-maskable-512.png', await padded(logo, 512, 0.65));

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
