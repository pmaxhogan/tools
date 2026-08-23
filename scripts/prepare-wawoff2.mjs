/**
 * Stages the wawoff2 emscripten glue into public/wawoff2/ before `astro build`.
 *
 * Why this exists:
 *  - wawoff2's glue only assigns `module.exports` inside its Node branch, so a
 *    browser bundle imports a dead object and `onRuntimeInitialized` never
 *    fires (the font subsetter hung forever on WOFF2 input). The two binding
 *    files also collide on emscripten globals (`Module`, `calledRun`), so they
 *    cannot share one scope. src/lib/woff2.ts therefore runs each binding in
 *    its own dedicated Worker via importScripts, where the glue's classic
 *    script path works as designed.
 *  - public/wawoff2/*_binding.js is gitignored: derived from node_modules, it
 *    never diverges from the installed wawoff2 version. worker.js is committed.
 *
 * Idempotent: skips copying when sizes already match. Node builtins only.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const src = join("node_modules", "wawoff2", "build");
const dest = join("public", "wawoff2");
mkdirSync(dest, { recursive: true });

let copied = 0;
for (const name of ["compress_binding.js", "decompress_binding.js"]) {
  const from = join(src, name);
  const to = join(dest, name);
  if (!existsSync(from)) {
    console.error(`prepare-wawoff2: missing ${from}; is wawoff2 installed?`);
    process.exit(1);
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied += 1;
}
console.log(`prepare-wawoff2: staged ${copied} file(s) into ${dest}`);
