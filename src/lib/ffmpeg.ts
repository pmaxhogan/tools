/**
 * The shared ffmpeg.wasm runtime for the media tools (Phase 3).
 *
 * Design notes, because several of these are not obvious from the 0.12 API:
 *
 *  - Single thread core only. There is no SharedArrayBuffer requirement and no
 *    COOP/COEP header, so the media tools work on a plain static host.
 *  - The core wasm is ~30.7 MiB, above the Cloudflare Workers 25 MiB per file
 *    cap, so `scripts/prepare-ffmpeg.mjs` splits it into 16 MiB parts at build
 *    time. This module downloads the parts in parallel, concatenates them, and
 *    hands the result to ffmpeg as a blob URL.
 *  - Downloaded parts are stored in Cache Storage under a key that carries the
 *    core version, so the second visit loads the engine without touching the
 *    network and old versions are evicted automatically.
 *  - Nothing here runs at import time. The engine is only fetched when a caller
 *    asks for it, which is what keeps a ~31 MB download off page load.
 *  - Everything is guarded for server side rendering: no top level DOM access.
 *
 * The engine is a module level singleton. Two callers share one worker, one
 * wasm instance, and one in memory filesystem, so jobs are serialized.
 */
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { ToolError } from "@/tools/types";

/* ------------------------------------------------------------------ */
/* public types                                                        */
/* ------------------------------------------------------------------ */

/** One tick of job progress. Any field may be null when ffmpeg cannot report it. */
export interface MediaJobProgress {
  /** 0 to 1 completion, or null when ffmpeg cannot estimate it for this job. */
  ratio: number | null;
  /** Position in the output timeline in milliseconds, or null. */
  timeMs: number | null;
  /** The log line that triggered this tick. Empty string on progress-only ticks. */
  logLine: string;
}

export type MediaProgressHandler = (progress: MediaJobProgress) => void;

/** Engine download progress. `totalBytes` comes from the build manifest. */
export type MediaDownloadHandler = (loadedBytes: number, totalBytes: number) => void;

export interface MediaFile {
  name: string;
  data: Uint8Array;
}

export interface MediaJobOptions {
  /** Files written into the ffmpeg filesystem before the run. */
  inputs: MediaFile[];
  /** Full ffmpeg argument list. `-nostdin -y` are prepended by ffmpeg itself. */
  args: string[];
  /** File names the run is expected to produce, read back after it exits. */
  outputs: string[];
  onProgress?: MediaProgressHandler;
  onDownload?: MediaDownloadHandler;
}

/**
 * What `MediaShell` hands a tool when it asks for the ffmpeg arguments.
 * File names are already sanitized for the ffmpeg filesystem.
 */
export interface MediaBuildContext {
  /** Name of the first input inside the ffmpeg filesystem, e.g. "input.mov". */
  inputName: string;
  /** All input names, in the order the files were selected. */
  inputNames: string[];
  /** Original name and byte size of each selected file, same order. */
  files: { name: string; size: number }[];
  /** The option values the parent panel owns. */
  opts: Record<string, unknown>;
}

/** Either a runnable command, or the reason this option combination cannot run. */
export type MediaBuildResult =
  { args: string[]; outputs: string[] } | { error: string; fix?: string };

/** The function a media tool panel passes to `MediaShell` as `buildArgs`. */
export type MediaBuildArgs = (ctx: MediaBuildContext) => MediaBuildResult;

/** A failed run: carries the tail of the ffmpeg log, which is where the reason is. */
export class MediaJobError extends ToolError {
  /** Last log lines ffmpeg emitted, oldest first. */
  log: string[];

  constructor(code: string, message: string, fix: string | undefined, log: string[]) {
    super(code, message, fix);
    this.name = "MediaJobError";
    this.log = log;
  }
}

/* ------------------------------------------------------------------ */
/* module state                                                        */
/* ------------------------------------------------------------------ */

interface CoreManifest {
  version: string;
  wasmParts: number;
  wasmBytes: number;
}

const MANIFEST_URL = "/ffmpeg/manifest.json";
const CORE_JS_URL = "/ffmpeg/ffmpeg-core.js";
const CACHE_PREFIX = "ffmpeg-core-";
/** How many log lines to keep for error reports and the UI log tail. */
const LOG_TAIL_MAX = 200;
/** How many of those travel with a MediaJobError. */
const LOG_TAIL_ON_ERROR = 20;

let engine: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let manifest: CoreManifest | null = null;

/**
 * Progress callbacks live here rather than being attached per call: the
 * singleton keeps its listeners across calls, so attaching on every `getFFmpeg`
 * would leak listeners and a cached instance would never see a new caller's
 * callback.
 */
let progressHandler: MediaProgressHandler | null = null;
let downloadHandler: MediaDownloadHandler | null = null;

let lastRatio: number | null = null;
let lastTimeMs: number | null = null;
const logTail: string[] = [];

/** Jobs share one filesystem, so overlapping runs would interleave writes. */
let jobChain: Promise<unknown> = Promise.resolve();

/* ------------------------------------------------------------------ */
/* capability check                                                    */
/* ------------------------------------------------------------------ */

/**
 * True when this browser can run the media engine at all. ffmpeg.wasm needs
 * WebAssembly and a module worker; both are absent during server rendering.
 */
export function isMediaSupported(): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

/** True when the engine is loaded in this page session and ready to run. */
export function isEngineReady(): boolean {
  return engine !== null && engine.loaded;
}

/** Last log lines ffmpeg produced, oldest first. Useful for a live log view. */
export function getLogTail(lines = 30): string[] {
  return logTail.slice(-lines);
}

/* ------------------------------------------------------------------ */
/* download                                                            */
/* ------------------------------------------------------------------ */

function emitProgress(logLine: string): void {
  progressHandler?.({ ratio: lastRatio, timeMs: lastTimeMs, logLine });
}

function pushLog(line: string): void {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_MAX) logTail.splice(0, logTail.length - LOG_TAIL_MAX);
}

/**
 * Opens the versioned cache for the core and evicts every older one, so a core
 * upgrade never leaves 30 MB of dead bytes behind. Returns null whenever Cache
 * Storage is unavailable or refuses, which happens in private browsing modes.
 */
async function openCoreCache(version: string): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  const name = `${CACHE_PREFIX}${version}`;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => caches.delete(k)),
    );
    return await caches.open(name);
  } catch {
    return null;
  }
}

/**
 * Reads a response body to completion, reporting each chunk. Streaming is what
 * makes a live byte counter possible; a body without a reader falls back to a
 * single arrayBuffer read and one final report.
 */
async function readWithProgress(
  response: Response,
  onChunk: (bytes: number) => void,
): Promise<Uint8Array[]> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onChunk(buffer.byteLength);
    return [buffer];
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      onChunk(value.byteLength);
    }
  }
  return chunks;
}

/** Fetches one wasm part, serving it from Cache Storage when it is already there. */
async function fetchPart(
  url: string,
  cache: Cache | null,
  onChunk: (bytes: number) => void,
): Promise<Uint8Array[]> {
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await readWithProgress(hit, onChunk);
    } catch {
      // A broken cache entry is not worth failing the load over.
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new ToolError(
      "media-engine-download",
      `The media engine could not be downloaded (${response.status} on ${url}).`,
      "Check your connection and try loading the engine again.",
    );
  }
  if (cache) {
    // Store a clone so the caching write and the progress read work off one
    // request rather than downloading 30 MB twice.
    cache.put(url, response.clone()).catch(() => {});
  }
  return await readWithProgress(response, onChunk);
}

async function loadManifest(): Promise<CoreManifest> {
  if (manifest) return manifest;
  const response = await fetch(MANIFEST_URL);
  if (!response.ok) {
    throw new ToolError(
      "media-engine-missing",
      "The media engine files are not available on this server.",
      "Reload the page. If it keeps failing, the site build did not publish the engine.",
    );
  }
  manifest = (await response.json()) as CoreManifest;
  return manifest;
}

/**
 * Downloads every wasm part in parallel and concatenates them in order. Total
 * size comes from the build manifest rather than Content-Length, because a
 * compressing CDN reports compressed bytes while the reader yields decompressed
 * ones, which would push the progress bar past 100 percent.
 */
async function downloadWasm(core: CoreManifest): Promise<Uint8Array> {
  const cache = await openCoreCache(core.version);
  let loaded = 0;
  const onChunk = (bytes: number) => {
    loaded += bytes;
    downloadHandler?.(Math.min(loaded, core.wasmBytes), core.wasmBytes);
  };

  const parts = await Promise.all(
    Array.from({ length: core.wasmParts }, (_, i) =>
      fetchPart(`/ffmpeg/ffmpeg-core.wasm.part${i}`, cache, onChunk),
    ),
  );

  const total = parts.reduce(
    (sum, chunks) => sum + chunks.reduce((n, c) => n + c.byteLength, 0),
    0,
  );
  if (total !== core.wasmBytes) {
    throw new ToolError(
      "media-engine-corrupt",
      "The media engine downloaded incompletely.",
      "Reload the page and load the engine again.",
    );
  }

  const wasm = new Uint8Array(core.wasmBytes);
  let offset = 0;
  for (const chunks of parts) {
    for (const chunk of chunks) {
      wasm.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  downloadHandler?.(core.wasmBytes, core.wasmBytes);
  return wasm;
}

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

async function createEngine(): Promise<FFmpeg> {
  const core = await loadManifest();

  const [coreSource, wasm] = await Promise.all([
    fetch(CORE_JS_URL).then((r) => {
      if (!r.ok) {
        throw new ToolError(
          "media-engine-missing",
          "The media engine loader could not be downloaded.",
          "Reload the page and try again.",
        );
      }
      return r.text();
    }),
    downloadWasm(core),
  ]);

  // ffmpeg only accepts URLs, so both pieces become blob URLs. The wasm blob
  // carries application/wasm so the core can use instantiateStreaming.
  const coreURL = URL.createObjectURL(new Blob([coreSource], { type: "text/javascript" }));
  const wasmURL = URL.createObjectURL(
    new Blob([wasm.buffer as ArrayBuffer], { type: "application/wasm" }),
  );

  try {
    // Imported here rather than at module scope: the package resolves to a
    // throwing stub under node, and this keeps it out of the page bundle until
    // a visitor actually asks for the engine.
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const instance = new FFmpeg();

    instance.on("log", ({ message }) => {
      pushLog(message);
      emitProgress(message);
    });
    instance.on("progress", ({ progress, time }) => {
      // The 0.12 ratio is only meaningful when input and output durations
      // match, so anything outside a sane range is reported as unknown.
      lastRatio =
        Number.isFinite(progress) && progress >= 0 && progress <= 1.1
          ? Math.min(1, progress)
          : null;
      // ffmpeg reports the output position in microseconds.
      lastTimeMs = Number.isFinite(time) && time >= 0 ? time / 1000 : null;
      emitProgress("");
    });

    await instance.load({ coreURL, wasmURL });
    return instance;
  } finally {
    // The core has the bytes now, so releasing ~31 MB of blob is safe. A later
    // reload after terminate() re-reads them from Cache Storage instead.
    URL.revokeObjectURL(coreURL);
    URL.revokeObjectURL(wasmURL);
  }
}

/**
 * Returns the loaded ffmpeg singleton, downloading and starting the engine on
 * first use. The first call is expensive (about 31 MB); every later call
 * resolves immediately with the same instance.
 *
 * @param onProgress receives log and progress ticks for the calls that follow.
 * @param onDownload receives engine download progress in bytes.
 */
export async function getFFmpeg(
  onProgress?: MediaProgressHandler,
  onDownload?: MediaDownloadHandler,
): Promise<FFmpeg> {
  if (!isMediaSupported()) {
    throw new ToolError(
      "media-unsupported",
      "This browser cannot run the media engine.",
      "Use a current version of Chrome, Edge, Firefox, or Safari.",
    );
  }

  progressHandler = onProgress ?? null;
  downloadHandler = onDownload ?? null;

  if (engine && engine.loaded) {
    if (manifest) onDownload?.(manifest.wasmBytes, manifest.wasmBytes);
    return engine;
  }

  loadPromise ??= createEngine();
  try {
    engine = await loadPromise;
    return engine;
  } catch (error) {
    // A failed load must not poison the singleton: the next attempt retries.
    loadPromise = null;
    engine = null;
    throw toMediaError(error, "media-engine-load", "The media engine failed to start.");
  }
}

/**
 * Stops the engine and any run in flight. The next `runJob` or `getFFmpeg`
 * starts a fresh worker, which reloads the wasm from Cache Storage rather than
 * from the network.
 */
export function terminateEngine(): void {
  try {
    engine?.terminate();
  } catch {
    // Terminating a half dead worker is not an error worth surfacing.
  }
  engine = null;
  loadPromise = null;
  lastRatio = null;
  lastTimeMs = null;
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */

function toMediaError(error: unknown, code: string, fallback: string): MediaJobError {
  if (error instanceof MediaJobError) return error;
  const tail = getLogTail(LOG_TAIL_ON_ERROR);
  if (error instanceof ToolError) {
    return new MediaJobError(error.code, error.message, error.fix, tail);
  }
  // The ffmpeg worker rejects with plain strings, not Error objects.
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  return new MediaJobError(code, message || fallback, undefined, tail);
}

/**
 * Runs one ffmpeg command end to end: writes the inputs, executes, reads the
 * outputs, and clears the filesystem afterwards whether or not it succeeded.
 *
 * Jobs are serialized because the engine has a single in memory filesystem.
 * A non zero ffmpeg exit code becomes a `MediaJobError` carrying the log tail,
 * since ffmpeg reports failures through the exit code, not through a rejection.
 */
export function runJob(options: MediaJobOptions): Promise<MediaFile[]> {
  const run = jobChain.then(
    () => executeJob(options),
    () => executeJob(options),
  );
  // Keep the chain alive even when a job throws, without an unhandled rejection.
  jobChain = run.catch(() => undefined);
  return run;
}

async function executeJob(options: MediaJobOptions): Promise<MediaFile[]> {
  const ffmpeg = await getFFmpeg(options.onProgress, options.onDownload);

  lastRatio = null;
  lastTimeMs = null;
  logTail.length = 0;

  const written: string[] = [];
  try {
    for (const input of options.inputs) {
      // writeFile transfers the underlying buffer, which detaches the caller's
      // array. Passing a copy keeps the caller's bytes reusable for a re-run.
      await ffmpeg.writeFile(input.name, input.data.slice());
      written.push(input.name);
    }

    const code = await ffmpeg.exec(options.args);
    if (code !== 0) {
      throw new MediaJobError(
        "ffmpeg-failed",
        `ffmpeg stopped with exit code ${code}.`,
        "Check the log below: it names the stream or option ffmpeg rejected.",
        getLogTail(LOG_TAIL_ON_ERROR),
      );
    }

    const results: MediaFile[] = [];
    for (const name of options.outputs) {
      let data: Uint8Array | string;
      try {
        data = await ffmpeg.readFile(name);
      } catch {
        throw new MediaJobError(
          "ffmpeg-no-output",
          `ffmpeg finished but produced no ${name}.`,
          "Check the log below: the run may have skipped every frame.",
          getLogTail(LOG_TAIL_ON_ERROR),
        );
      }
      if (typeof data === "string") {
        throw new MediaJobError(
          "ffmpeg-no-output",
          `ffmpeg returned ${name} as text rather than bytes.`,
          undefined,
          getLogTail(LOG_TAIL_ON_ERROR),
        );
      }
      results.push({ name, data });
    }
    return results;
  } catch (error) {
    throw toMediaError(error, "ffmpeg-failed", "The media job failed.");
  } finally {
    // Cleanup runs even after a failure or a terminate, so the next job starts
    // on an empty filesystem. Every delete is independent: a file that was
    // never created, or a worker that is already gone, must not mask the error.
    for (const name of [...written, ...options.outputs]) {
      try {
        await engine?.deleteFile(name);
      } catch {
        // Nothing to clean up for this name.
      }
    }
  }
}
