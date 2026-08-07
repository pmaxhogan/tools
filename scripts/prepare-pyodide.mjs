/**
 * Stages the Pyodide runtime and the jinja2 stack into public/pyodide/ before
 * `astro build`. Companion to scripts/prepare-models.mjs, same shape, much
 * smaller net: this only stages what is needed to run jinja2 in the browser,
 * not the hundreds of scientific packages the full Pyodide distribution ships.
 *
 * Why this exists:
 *  - The Jinja Template Tester runs real Python jinja2 in the browser through
 *    Pyodide, so every file the engine loads has to be served from this origin
 *    (PROJECT.md rule 8: no CDN at runtime). The panel calls
 *    loadPyodide({ indexURL: '/pyodide/' }); the loader then fetches
 *    pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip and pyodide-lock.json
 *    from /pyodide/, and loadPackage('jinja2') resolves jinja2 + markupsafe
 *    against that lock and fetches their wheels from /pyodide/ too. Nothing a
 *    visitor loads comes from a third party.
 *  - The largest file (pyodide.asm.wasm) is ~9.6 MiB, comfortably under the
 *    Cloudflare Workers 25 MiB per asset cap, so nothing is chunked here and
 *    worker/index.ts needs no changes. The script still asserts the cap.
 *  - public/pyodide/ is a gitignored build artifact.
 *
 * What is staged (all under public/pyodide/):
 *   pyodide.mjs            the API loader, imported at runtime from our origin
 *   pyodide.asm.mjs        the emscripten module the loader imports
 *   pyodide.asm.wasm       the CPython + runtime wasm binary
 *   python_stdlib.zip      the Python standard library
 *   pyodide-lock.json      the package index loadPackage() resolves against
 *   jinja2-*.whl           pure-python jinja2 wheel (fetched from the CDN once)
 *   markupsafe-*.whl       jinja2's only dependency, a wasm32 wheel for this ABI
 *   manifest.json          what is staged, for idempotence and the panel's
 *                          download progress total
 *
 * The pyodide version, the two wheel file names and their sha256 pins are read
 * from the installed package (package.json + pyodide-lock.json), so a Pyodide
 * upgrade updates the URLs and pins automatically and the version stamp in the
 * manifest forces a restage. The wheels are not shipped in the npm package, so
 * they are fetched once from the version-matched CDN distribution and verified
 * against the lock's own sha256 before staging. No dependencies beyond builtins.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cloudflare's hard per-asset limit. Asserted, never expected to trigger. */
const ASSET_MAX_BYTES = 25 * 1024 * 1024;
/** Download attempts per wheel before the build fails. */
const ATTEMPTS = 3;

/**
 * Bumped by hand whenever the staging shape below changes in a way that must
 * invalidate an already-staged public/pyodide/ tree.
 */
const STAGE_VERSION = 1;

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = join(root, 'public');
const outDir = join(publicDir, 'pyodide');
const pkgDir = join(root, 'node_modules', 'pyodide');
const manifestPath = join(outDir, 'manifest.json');

function fail(message) {
  console.error(`prepare-pyodide: ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (!existsSync(pkgDir)) {
  fail('node_modules/pyodide is missing. Run npm install so the runtime is present.');
}

const pyodideVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const lock = JSON.parse(readFileSync(join(pkgDir, 'pyodide-lock.json'), 'utf8'));

/** The lock is the source of truth for the wheel names, deps and hashes. */
function wheelEntry(name) {
  const p = lock.packages[name];
  if (!p) fail(`pyodide-lock.json has no "${name}" package. The Pyodide build changed.`);
  if (!p.file_name || !p.sha256) fail(`"${name}" is missing a file_name or sha256 in the lock.`);
  return { file: p.file_name, sha256: p.sha256 };
}

const jinja = wheelEntry('jinja2');
const markupsafe = wheelEntry('markupsafe');

/** Version-matched CDN distribution. Fetched at build time only, never at runtime. */
const cdnBase = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;

/**
 * source: 'pkg' is copied verbatim from node_modules/pyodide, so it can never
 * drift from the pinned version. source: 'cdn' is fetched once and verified
 * against the lock's sha256 before it is allowed to stage.
 */
const ENTRIES = [
  { source: 'pkg', from: 'pyodide.mjs' },
  { source: 'pkg', from: 'pyodide.asm.mjs' },
  { source: 'pkg', from: 'pyodide.asm.wasm' },
  { source: 'pkg', from: 'python_stdlib.zip' },
  { source: 'pkg', from: 'pyodide-lock.json' },
  { source: 'cdn', from: cdnBase + jinja.file, file: jinja.file, sha256: jinja.sha256 },
  {
    source: 'cdn',
    from: cdnBase + markupsafe.file,
    file: markupsafe.file,
    sha256: markupsafe.sha256,
  },
];

/** Every entry's destination basename under public/pyodide/. */
function destName(entry) {
  return entry.source === 'pkg' ? entry.from : entry.file;
}

/**
 * Fingerprint of the staging plan. Any change to the version, the wheel names,
 * their hashes or the entry list invalidates an already-staged tree.
 */
const entriesHash = sha256(
  Buffer.from(JSON.stringify({ pyodideVersion, ENTRIES })),
).slice(0, 16);

/** True when public/pyodide/ already holds exactly this manifest, bytes included. */
function isStaged(previous) {
  if (!previous || previous.stageVersion !== STAGE_VERSION) return false;
  if (previous.entriesHash !== entriesHash) return false;
  if (!Array.isArray(previous.files) || previous.files.length !== ENTRIES.length) return false;
  for (const file of previous.files) {
    const outPath = join(outDir, file.name);
    if (!existsSync(outPath) || statSync(outPath).size !== file.bytes) return false;
  }
  return true;
}

async function download(url, attempt = 1) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (attempt >= ATTEMPTS) {
      fail(`could not download ${url} after ${ATTEMPTS} attempts: ${err.message}`);
    }
    const waitMs = 1000 * attempt;
    console.warn(
      `prepare-pyodide: attempt ${attempt} for ${url} failed (${err.message}), retrying in ${waitMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return download(url, attempt + 1);
  }
}

/** Resolves one entry to a verified Buffer, from node_modules or the CDN. */
async function resolveEntry(entry) {
  if (entry.source === 'pkg') {
    const path = join(pkgDir, entry.from);
    if (!existsSync(path)) fail(`missing ${path}. Reinstall pyodide so every dist file is present.`);
    return readFileSync(path);
  }

  const outPath = join(outDir, destName(entry));
  // A correctly staged wheel from a previous run is reused without refetching.
  if (existsSync(outPath)) {
    const cached = readFileSync(outPath);
    if (sha256(cached) === entry.sha256) return cached;
  }

  const buffer = await download(entry.from);
  const actual = sha256(buffer);
  if (actual !== entry.sha256) {
    fail(
      `${entry.from} hashed ${actual}, expected ${entry.sha256} (from pyodide-lock.json). ` +
        'Refusing to stage a wheel that does not match its pin.',
    );
  }
  return buffer;
}

let previous = null;
if (existsSync(manifestPath)) {
  try {
    previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    previous = null;
  }
}

if (isStaged(previous)) {
  console.log(
    `prepare-pyodide: public/pyodide is current ` +
      `(pyodide ${previous.pyodideVersion}, ${previous.files.length} files, ${previous.totalBytes} bytes)`,
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const staged = [];
let downloaded = 0;
for (const entry of ENTRIES) {
  const buffer = await resolveEntry(entry);
  if (entry.source === 'cdn') downloaded += buffer.length;
  const name = destName(entry);
  if (buffer.length > ASSET_MAX_BYTES) {
    fail(`${name} is ${buffer.length} bytes, over the ${ASSET_MAX_BYTES} byte asset cap.`);
  }
  writeFileSync(join(outDir, name), buffer);
  staged.push({ name, bytes: buffer.length });
  console.log(`prepare-pyodide: ${name} ${buffer.length} bytes`);
}

// Remove any stale files a previous, differently shaped staging left behind, so
// dist/pyodide only ever contains the current set.
const keep = new Set(['manifest.json', ...staged.map((f) => f.name)]);
for (const name of readdirSync(outDir)) {
  if (!keep.has(name)) rmSync(join(outDir, name));
}

const totalBytes = staged.reduce((sum, f) => sum + f.bytes, 0);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    { stageVersion: STAGE_VERSION, pyodideVersion, entriesHash, totalBytes, files: staged },
    null,
    2,
  )}\n`,
);

// Belt and braces: nothing under public/pyodide may exceed the cap.
const tooBig = readdirSync(outDir).filter(
  (name) => statSync(join(outDir, name)).size > ASSET_MAX_BYTES,
);
if (tooBig.length) fail(`these staged files exceed the 25 MiB asset cap: ${tooBig.join(', ')}`);

console.log(
  `prepare-pyodide: staged ${staged.length} files for pyodide ${pyodideVersion}, ` +
    `${totalBytes} bytes total, ${downloaded} bytes newly downloaded`,
);
