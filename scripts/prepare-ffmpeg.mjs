/**
 * Stages the single thread ffmpeg.wasm core into public/ffmpeg/ before `astro build`.
 *
 * Why this exists:
 *  - `@ffmpeg/core` ships a ~30.7 MiB `ffmpeg-core.wasm`. Cloudflare Workers
 *    static assets cap a single file at 25 MiB, so the wasm cannot be deployed
 *    as one file. It is split here into fixed 16 MiB chunks and reassembled in
 *    the browser by `src/lib/ffmpeg.ts`.
 *  - `public/ffmpeg/` is gitignored: it is a build artifact derived from
 *    node_modules, so it never diverges from the installed core version.
 *
 * Output (all under public/ffmpeg/):
 *   ffmpeg-core.js            verbatim copy of the ESM core loader
 *   ffmpeg-core.wasm.part0..N 16 MiB chunks of ffmpeg-core.wasm
 *   manifest.json             { version, wasmParts, wasmBytes }
 *
 * The script is idempotent and fast: when the manifest already matches the
 * installed core version and every staged file is present at the right size,
 * it does nothing. No dependencies beyond node builtins.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Chunk boundary. 16 MiB keeps every part comfortably under the 25 MiB cap. */
const CHUNK_BYTES = 16 * 1024 * 1024;

const root = fileURLToPath(new URL("../", import.meta.url));
const coreDir = join(root, "node_modules", "@ffmpeg", "core");
const srcJs = join(coreDir, "dist", "esm", "ffmpeg-core.js");
const srcWasm = join(coreDir, "dist", "esm", "ffmpeg-core.wasm");
const outDir = join(root, "public", "ffmpeg");
const outJs = join(outDir, "ffmpeg-core.js");
const outManifest = join(outDir, "manifest.json");

function fail(message) {
  console.error(`prepare-ffmpeg: ${message}`);
  process.exit(1);
}

for (const file of [srcJs, srcWasm]) {
  if (!existsSync(file)) {
    fail(`missing ${file}. Run npm install so @ffmpeg/core is present.`);
  }
}

const version = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")).version;
const wasmBytes = statSync(srcWasm).size;
const wasmParts = Math.ceil(wasmBytes / CHUNK_BYTES);
const jsBytes = statSync(srcJs).size;

const partPath = (i) => join(outDir, `ffmpeg-core.wasm.part${i}`);

/** True when public/ffmpeg/ already holds exactly this core, byte counts included. */
function isStaged() {
  if (!existsSync(outManifest) || !existsSync(outJs)) return false;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(outManifest, "utf8"));
  } catch {
    return false;
  }
  if (manifest.version !== version) return false;
  if (manifest.wasmParts !== wasmParts || manifest.wasmBytes !== wasmBytes) return false;
  if (statSync(outJs).size !== jsBytes) return false;

  let staged = 0;
  for (let i = 0; i < wasmParts; i += 1) {
    const path = partPath(i);
    if (!existsSync(path)) return false;
    staged += statSync(path).size;
  }
  return staged === wasmBytes;
}

if (isStaged()) {
  console.log(
    `prepare-ffmpeg: public/ffmpeg is current (core ${version}, ${wasmParts} wasm parts, ${wasmBytes} bytes)`,
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

// Drop parts left over from a different core version so a stale part can never
// be concatenated into a new build.
for (const name of readdirSync(outDir)) {
  if (/^ffmpeg-core\.wasm\.part\d+$/.test(name)) rmSync(join(outDir, name));
}

writeFileSync(outJs, readFileSync(srcJs));

const wasm = readFileSync(srcWasm);
for (let i = 0; i < wasmParts; i += 1) {
  const start = i * CHUNK_BYTES;
  writeFileSync(partPath(i), wasm.subarray(start, Math.min(start + CHUNK_BYTES, wasmBytes)));
}

writeFileSync(outManifest, `${JSON.stringify({ version, wasmParts, wasmBytes }, null, 2)}\n`);

const sizes = Array.from({ length: wasmParts }, (_, i) => statSync(partPath(i)).size);
console.log(
  `prepare-ffmpeg: staged core ${version} to public/ffmpeg (${wasmParts} parts: ${sizes.join(", ")} bytes)`,
);
