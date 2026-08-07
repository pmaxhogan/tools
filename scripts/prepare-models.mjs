/**
 * Stages the Phase 4 Wave 3 model and engine payloads into public/ before
 * `astro build`. Companion to scripts/prepare-ffmpeg.mjs, same idea, wider net.
 *
 * Why this exists:
 *  - Wave 3 (Whisper transcription, MODNet background removal, Tesseract OCR)
 *    runs entirely in the browser, so every weight file has to be served from
 *    this origin. transformers.js is configured with allowRemoteModels=false,
 *    which means it fetches `<localModelPath>/<modelId>/<file>` from us and
 *    never touches huggingface.co at runtime. Nothing a visitor loads comes
 *    from a third party.
 *  - Cloudflare Workers cap a single static asset at 25 MiB. Two of the
 *    Whisper decoders are larger than that, so they are split into 16 MiB
 *    parts here and stitched back together by worker/index.ts on the way out.
 *    The browser sees one ordinary file at one ordinary URL.
 *  - public/models/ and public/tesseract/ are gitignored build artifacts, and
 *    .model-cache/ keeps the raw downloads so a rebuild refetches nothing.
 *
 * Output layout (all under public/):
 *   models/whisper-tiny/**          transformers.js repo layout, onnx/ included
 *   models/whisper-base/**          same
 *   models/modnet/onnx/model_quantized.onnx
 *   models/ort/*.wasm               onnxruntime-web runtime, set as wasmPaths
 *   tesseract/*.js, *.wasm          tesseract.js worker and core
 *   tesseract/lang/*.traineddata.gz language data
 *   models/manifest.json            what is staged, for the idempotence check
 *
 * Any output over 25 MiB becomes `<name>.part0..N` plus `<name>.chunks.json`
 * ({ totalBytes, parts: [{ name, bytes }] }) and the oversized original is
 * deleted, so no file that ships can breach the cap.
 *
 * Client wiring notes for whoever builds the tools on top of this:
 *  - transformers.js: env.allowRemoteModels = false, env.allowLocalModels =
 *    true, env.localModelPath = '/models/', and
 *    env.backends.onnx.wasm.wasmPaths = '/models/ort/'.
 *  - tesseract.js: corePath must be the exact file
 *    '/tesseract/tesseract-core-simd-lstm.js', not the directory. Given a
 *    directory, tesseract.js appends a relaxed-SIMD filename that is not
 *    staged here. Also workerPath: '/tesseract/worker.min.js' (same origin, so
 *    no blob wrapper, so the emscripten glue finds the sibling .wasm) and
 *    langPath: '/tesseract/lang'.
 *
 * No dependencies beyond node builtins.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cloudflare's hard per-asset limit. */
const ASSET_MAX_BYTES = 25 * 1024 * 1024;
/** Chunk boundary, matching prepare-ffmpeg.mjs. Comfortably under the cap. */
const CHUNK_BYTES = 16 * 1024 * 1024;
/** Download attempts per file before the build fails. */
const ATTEMPTS = 3;

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = join(root, 'public');
const cacheDir = join(root, '.model-cache');
const manifestPath = join(publicDir, 'models', 'manifest.json');

/**
 * Bumped by hand whenever the entry list below changes in a way that must
 * invalidate an already-staged public/ tree.
 */
const STAGE_VERSION = 1;

const hfBase = 'https://huggingface.co';
/** Revision-pinned resolve URL. `main` is what the spike verified against. */
const hf = (repo, path) => `${hfBase}/${repo}/resolve/main/${path}?download=true`;

/** The small config and tokenizer files every transformers.js repo needs. */
const WHISPER_SUPPORT = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
];
/** Present in some Whisper repos and absent in others. A 404 is not an error. */
const WHISPER_OPTIONAL = ['added_tokens.json', 'special_tokens_map.json'];

/**
 * One Whisper repo as a list of entries. The onnx weights are hash pinned
 * because they are the bytes that matter; the JSON files are small and the
 * URLs are revision pinned, so a byte-size sanity check is enough for them.
 */
function whisper(dir, repo, encoder, decoder) {
  return [
    {
      source: 'url',
      from: hf(repo, 'onnx/encoder_model_quantized.onnx'),
      to: `models/${dir}/onnx/encoder_model_quantized.onnx`,
      sha256: encoder.sha256,
      expectedBytes: encoder.bytes,
    },
    {
      source: 'url',
      from: hf(repo, 'onnx/decoder_model_merged_quantized.onnx'),
      to: `models/${dir}/onnx/decoder_model_merged_quantized.onnx`,
      sha256: decoder.sha256,
      expectedBytes: decoder.bytes,
    },
    ...WHISPER_SUPPORT.map((name) => ({
      source: 'url',
      from: hf(repo, name),
      to: `models/${dir}/${name}`,
    })),
    ...WHISPER_OPTIONAL.map((name) => ({
      source: 'url',
      from: hf(repo, name),
      to: `models/${dir}/${name}`,
      optional: true,
    })),
  ];
}

const TESSERACT_LANGS = ['eng', 'spa', 'fra', 'deu', 'jpn'];

/**
 * The manifest. `source: 'url'` is fetched once into .model-cache and copied
 * from there forever after; `source: 'node_modules'` is copied verbatim from
 * the installed package, so it can never drift from the pinned version.
 */
const ENTRIES = [
  ...whisper(
    'whisper-tiny',
    'Xenova/whisper-tiny',
    {
      bytes: 10_124_910,
      sha256: 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e',
    },
    {
      bytes: 30_727_765,
      sha256: '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0',
    }
  ),
  ...whisper(
    'whisper-base',
    'Xenova/whisper-base',
    {
      bytes: 23_200_850,
      sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9',
    },
    {
      bytes: 53_707_539,
      sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861',
    }
  ),
  {
    source: 'url',
    from: hf('Xenova/modnet', 'onnx/model_quantized.onnx'),
    to: 'models/modnet/onnx/model_quantized.onnx',
    expectedBytes: 6_632_188,
    sha256: '92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a',
  },

  // onnxruntime-web runtime. The plain build is what runs when the page has
  // cross origin isolation; the asyncify build is the fallback without it.
  // The jsep and jspi builds are for WebGPU and are deliberately not staged.
  {
    source: 'node_modules',
    from: 'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    to: 'models/ort/ort-wasm-simd-threaded.wasm',
  },
  {
    source: 'node_modules',
    from: 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
    to: 'models/ort/ort-wasm-simd-threaded.asyncify.wasm',
  },
  // The .mjs glue loaders next to the wasm binaries. onnxruntime-web
  // dynamically imports these siblings at runtime; without them the engine
  // dies with "no available backend found" before inference ever starts.
  {
    source: 'node_modules',
    from: 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    to: 'models/ort/ort-wasm-simd-threaded.mjs',
  },
  {
    source: 'node_modules',
    from: 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
    to: 'models/ort/ort-wasm-simd-threaded.asyncify.mjs',
  },

  // Tesseract OCR. See the corePath note in the header comment.
  {
    source: 'node_modules',
    from: 'tesseract.js/dist/worker.min.js',
    to: 'tesseract/worker.min.js',
  },
  {
    source: 'node_modules',
    from: 'tesseract.js-core/tesseract-core-simd-lstm.js',
    to: 'tesseract/tesseract-core-simd-lstm.js',
  },
  {
    source: 'node_modules',
    from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm',
    to: 'tesseract/tesseract-core-simd-lstm.wasm',
  },
  ...TESSERACT_LANGS.map((lang) => ({
    source: 'node_modules',
    from: `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    to: `tesseract/lang/${lang}.traineddata.gz`,
  })),
];

function fail(message) {
  console.error(`prepare-models: ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Stable, filesystem-safe cache filename for a remote URL. */
function cacheNameFor(url) {
  const clean = url.split('?')[0].replace(/^https?:\/\//, '');
  const slug = clean.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-96);
  return `${sha256(Buffer.from(url)).slice(0, 16)}-${slug}`;
}

async function download(url, attempt = 1) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    if (attempt >= ATTEMPTS) {
      fail(`could not download ${url} after ${ATTEMPTS} attempts: ${err.message}`);
    }
    const waitMs = 1000 * attempt;
    console.warn(
      `prepare-models: attempt ${attempt} for ${url} failed (${err.message}), retrying in ${waitMs}ms`
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return download(url, attempt + 1);
  }
}

/**
 * Resolves one entry to bytes on disk in .model-cache (for urls) or in
 * node_modules (for packages). Returns null when an optional file is absent.
 */
async function resolveSource(entry) {
  if (entry.source === 'node_modules') {
    const path = join(root, 'node_modules', entry.from);
    if (!existsSync(path)) {
      fail(`missing ${path}. Run npm install so every model package is present.`);
    }
    return { path, bytes: statSync(path).size };
  }

  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, cacheNameFor(entry.from));

  if (existsSync(path)) {
    const cached = readFileSync(path);
    const okBytes = entry.expectedBytes === undefined || cached.length === entry.expectedBytes;
    const okHash = entry.sha256 === undefined || sha256(cached) === entry.sha256;
    if (okBytes && okHash) return { path, bytes: cached.length };
    console.warn(`prepare-models: cached copy of ${entry.to} did not verify, refetching`);
    rmSync(path);
  }

  const result = await download(entry.from);
  if (result.missing) {
    if (entry.optional) return null;
    fail(`${entry.from} returned 404 and is required`);
  }

  const { buffer } = result;
  if (entry.expectedBytes !== undefined && buffer.length !== entry.expectedBytes) {
    fail(
      `${entry.from} is ${buffer.length} bytes, expected ${entry.expectedBytes}. ` +
        'The upstream file changed; update the pin in scripts/prepare-models.mjs.'
    );
  }
  if (buffer.length === 0) fail(`${entry.from} downloaded as an empty file`);
  if (entry.sha256 !== undefined) {
    const actual = sha256(buffer);
    if (actual !== entry.sha256) {
      fail(
        `${entry.from} hashed ${actual}, expected ${entry.sha256}. ` +
          'Refusing to stage a file that does not match its pin.'
      );
    }
  }

  writeFileSync(path, buffer);
  return { path, bytes: buffer.length };
}

/** Removes any previously staged form of `to`: the file, its parts, its manifest. */
function clearOutput(to) {
  const outPath = join(publicDir, to);
  const dir = dirname(outPath);
  if (existsSync(outPath)) rmSync(outPath);
  if (!existsSync(dir)) return;
  const base = to.split('/').pop();
  const partPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.part\\d+$`);
  for (const name of readdirSync(dir)) {
    if (partPattern.test(name) || name === `${base}.chunks.json`) {
      rmSync(join(dir, name));
    }
  }
}

/**
 * Writes one resolved source into public/, splitting it when it would breach
 * the asset cap. Returns the record stored in the output manifest.
 */
function stage(entry, source) {
  const outPath = join(publicDir, entry.to);
  mkdirSync(dirname(outPath), { recursive: true });
  clearOutput(entry.to);

  if (source.bytes <= ASSET_MAX_BYTES) {
    copyFileSync(source.path, outPath);
    return { to: entry.to, bytes: source.bytes, chunked: false, sha256: entry.sha256 ?? null };
  }

  const data = readFileSync(source.path);
  const count = Math.ceil(data.length / CHUNK_BYTES);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${entry.to.split('/').pop()}.part${i}`;
    const slice = data.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, data.length));
    writeFileSync(join(dirname(outPath), name), slice);
    parts.push({ name, bytes: slice.length });
  }
  writeFileSync(
    `${outPath}.chunks.json`,
    `${JSON.stringify({ totalBytes: data.length, parts }, null, 2)}\n`
  );
  // The oversized original must never reach dist/, or the deploy is rejected.
  if (existsSync(outPath)) rmSync(outPath);

  return {
    to: entry.to,
    bytes: data.length,
    chunked: true,
    parts: parts.length,
    sha256: entry.sha256 ?? null,
  };
}

/**
 * Fingerprint of the entry list. Any edit to a source, destination or pin
 * changes this, which invalidates an already-staged public/ tree.
 */
const entriesHash = sha256(Buffer.from(JSON.stringify(ENTRIES))).slice(0, 16);

/** True when public/ already holds exactly this manifest, byte counts included. */
function isStaged(previous) {
  if (!previous || previous.stageVersion !== STAGE_VERSION) return false;
  if (previous.entriesHash !== entriesHash) return false;
  if (!Array.isArray(previous.files) || previous.files.length === 0) return false;

  for (const file of previous.files) {
    const outPath = join(publicDir, file.to);
    if (file.chunked) {
      const chunksPath = `${outPath}.chunks.json`;
      if (!existsSync(chunksPath)) return false;
      if (existsSync(outPath)) return false;
      let chunks;
      try {
        chunks = JSON.parse(readFileSync(chunksPath, 'utf8'));
      } catch {
        return false;
      }
      if (chunks.totalBytes !== file.bytes || chunks.parts.length !== file.parts) return false;
      let seen = 0;
      for (const part of chunks.parts) {
        const partPath = join(dirname(outPath), part.name);
        if (!existsSync(partPath) || statSync(partPath).size !== part.bytes) return false;
        seen += part.bytes;
      }
      if (seen !== file.bytes) return false;
    } else {
      if (!existsSync(outPath) || statSync(outPath).size !== file.bytes) return false;
    }
  }
  return true;
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
  const chunked = previous.files.filter((f) => f.chunked).length;
  console.log(
    `prepare-models: public/models and public/tesseract are current ` +
      `(${previous.files.length} files, ${chunked} chunked, ${previous.totalBytes} bytes)`
  );
  process.exit(0);
}

mkdirSync(join(publicDir, 'models'), { recursive: true });

const staged = [];
let downloaded = 0;
for (const entry of ENTRIES) {
  const cached = entry.source === 'url' && existsSync(join(cacheDir, cacheNameFor(entry.from)));
  const source = await resolveSource(entry);
  if (!source) {
    console.log(`prepare-models: ${entry.to} is not published upstream, skipping`);
    clearOutput(entry.to);
    continue;
  }
  if (entry.source === 'url' && !cached) downloaded += source.bytes;
  const record = stage(entry, source);
  staged.push(record);
  console.log(
    `prepare-models: ${record.to} ${record.bytes} bytes` +
      (record.chunked ? ` split into ${record.parts} parts` : '')
  );
}

const totalBytes = staged.reduce((sum, f) => sum + f.bytes, 0);
writeFileSync(
  manifestPath,
  `${JSON.stringify({ stageVersion: STAGE_VERSION, entriesHash, totalBytes, files: staged }, null, 2)}\n`
);

// Belt and braces: nothing under public/models or public/tesseract may exceed
// the cap, whatever the manifest claims.
function oversized(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return oversized(full);
    return statSync(full).size > ASSET_MAX_BYTES ? [full] : [];
  });
}
const tooBig = [
  ...oversized(join(publicDir, 'models')),
  ...oversized(join(publicDir, 'tesseract')),
];
if (tooBig.length) fail(`these staged files exceed the 25 MiB asset cap: ${tooBig.join(', ')}`);

const chunkedCount = staged.filter((f) => f.chunked).length;
console.log(
  `prepare-models: staged ${staged.length} files, ${totalBytes} bytes, ` +
    `${chunkedCount} chunked, ${downloaded} bytes newly downloaded`
);
