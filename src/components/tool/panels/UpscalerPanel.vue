<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Check, GripVertical, X, Zap } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { isMetered, onConnectionChange, shouldAutoDownload } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";

/**
 * Bespoke panel for the image upscaler.
 *
 * The generic ToolShell cannot host this one: it needs a canvas to decode the
 * image, a weights download that respects a metered connection, a per tile
 * progress loop that can be canceled, and a draggable before and after
 * compare. Every pixel decision (tiling, feathering, normalizing, packing
 * tensors) lives in the pure logic layer; this file owns the canvas, the ONNX
 * session, and the UI around them.
 *
 * How the model is wired, checked against the installed onnxruntime-web
 * 1.27.0 rather than from memory:
 *
 *  - The import is `onnxruntime-web/webgpu`, which resolves to
 *    ort.webgpu.bundle.min.mjs. That build carries BOTH the WebGPU and the
 *    WebAssembly execution providers, and the files it names are
 *    ort-wasm-simd-threaded.asyncify.wasm and its sibling .asyncify.mjs
 *    loader. Both are already staged under /models/ort/ by
 *    prepare-models.mjs. The plain `onnxruntime-web` entry point names
 *    ort-wasm-simd-threaded.jsep.wasm instead, which is NOT staged, so it
 *    would 404 at session create. Same reason transformers.js imports the
 *    webgpu build.
 *  - `env.wasm.wasmPaths` is set before the first session so the runtime never
 *    reaches for a CDN. Nothing a visitor loads comes from a third party.
 *  - `numThreads` is left alone. This site sends no COOP or COEP headers, so
 *    crossOriginIsolated is false and onnxruntime pins itself to one thread.
 *  - The weights are fetched by this panel, not by onnxruntime, so the
 *    download can report progress and land in Cache Storage. The session is
 *    created from the bytes. Handing it a URL instead would give neither.
 *  - Both graphs name their input "input" and their output "output", take
 *    NCHW float32 RGB in 0 to 1, and return 4x, unclipped. The clamp happens
 *    in postprocess and in the blender's Uint8ClampedArray.
 *
 * Nothing runs at import time and nothing touches the DOM, the network, or
 * WebAssembly until a visitor asks for it, so the component renders inert on
 * the server.
 */
defineProps<{ meta: ToolMeta }>();

type UpscalerLogic = typeof import("@/tools/image-upscaler/index");

/* ---------------------------------------------------------------- */
/* the narrow slice of onnxruntime-web this panel touches            */
/* ---------------------------------------------------------------- */

interface OrtTensorLike {
  data: Float32Array | Uint8Array | Int32Array;
  dims: readonly number[];
  dispose?: () => void;
}

interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?: () => Promise<void>;
}

interface OrtModuleLike {
  env: { wasm: { wasmPaths?: string } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
}

/** A loaded model, plus which execution provider actually accepted it. */
interface Engine {
  modelId: string;
  provider: "webgpu" | "wasm";
  session: OrtSessionLike;
  makeTensor: (data: Float32Array, dims: number[]) => unknown;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Cache Storage bucket for the weights. Bumped when the staged files change. */
const CACHE_PREFIX = "tools-upscaler-";
const CACHE_VERSION = "v1";

/**
 * Weights above this never start downloading on their own, even on a fast
 * connection. The small model is 4.9 MB and worth prefetching; the photo model
 * is 66 MB and nobody should pay for that without asking for it.
 */
const AUTO_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const supported = ref(true);

const fileName = ref("");
const originalUrl = ref<string | null>(null);
const sourceImg = shallowRef<HTMLImageElement | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);
const decodeFailed = ref(false);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const modelId = ref("general");
const models = shallowRef<UpscalerLogic["MODELS"]>([]);
const modelOptions = computed(() =>
  models.value.map((m) => ({ value: m.id, label: m.label, synonyms: [] })),
);
const activeModel = computed(() => models.value.find((m) => m.id === modelId.value) ?? null);

const hasWebGpu = ref(false);
const provider = ref<"webgpu" | "wasm">("wasm");
const providerText = ref("");

const engineState = ref<"idle" | "loading" | "ready">("idle");
const downloadedBytes = ref(0);
const downloadTotal = ref(0);
const metered = ref(false);
const weightsCached = ref(false);
let pendingAutoStart = false;
let stopConnectionWatch: () => void = () => {};

const running = ref(false);
const cancelRequested = ref(false);
const doneTiles = ref(0);
const totalTiles = ref(0);
const elapsedMs = ref(0);
const note = ref<string | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const resultUrl = ref<string | null>(null);
const resultBytes = ref(0);
const resultWidth = ref(0);
const resultHeight = ref(0);
let resultBlob: Blob | null = null;

/** Divider position over the compare view, as a percentage from the left. */
const dividerPercent = ref(50);
const actualPixels = ref(false);
const compareBox = ref<HTMLElement>();

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const hasFile = computed(() => sourceImg.value !== null);
const scale = computed(() => activeModel.value?.scale ?? 4);
const plannedOutput = computed(() =>
  hasFile.value
    ? { w: sourceWidth.value * scale.value, h: sourceHeight.value * scale.value }
    : null,
);
/** Widest the fit view may be so its height stays around 420 pixels. */
const fitMaxWidth = computed(() =>
  sourceHeight.value > 0 ? Math.round((420 * sourceWidth.value) / sourceHeight.value) : 640,
);
const sizeProblem = ref<{ message: string; fix?: string } | null>(null);
const canRun = computed(
  () => hasFile.value && !running.value && !sizeProblem.value && engineState.value !== "loading",
);
const modelBytes = computed(() => activeModel.value?.bytes ?? 0);
/** True when this model is small enough to prefetch without being asked. */
const autoStarts = computed(() => modelBytes.value <= AUTO_DOWNLOAD_MAX_BYTES);
const downloadPercent = computed(() => {
  const total = downloadTotal.value || modelBytes.value || 1;
  return Math.min(100, Math.round((downloadedBytes.value / total) * 100));
});
const downloadLabel = computed(
  () =>
    `Downloading the upscaling model (${formatBytes(downloadedBytes.value)} of ${formatBytes(
      downloadTotal.value || modelBytes.value,
    )})`,
);
const tileLabel = computed(() =>
  totalTiles.value > 0 ? `Tile ${doneTiles.value} of ${totalTiles.value}` : "Preparing tiles",
);
const tilePercent = computed(() =>
  totalTiles.value > 0 ? Math.round((doneTiles.value / totalTiles.value) * 100) : 0,
);
const providerLabel = computed(() => (provider.value === "webgpu" ? "WebGPU" : "WebAssembly"));

/* ---------------------------------------------------------------- */
/* small helpers                                                     */
/* ---------------------------------------------------------------- */

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "image";
}

function revoke(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/** Hands the event loop back so the tile counter actually repaints. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function drawInto(
  img: HTMLImageElement,
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new ToolError(
      "no-canvas",
      "This browser refused to give the page a 2D canvas, so the image cannot be read.",
      "Turn off canvas blocking or anti fingerprinting for this site, then try again.",
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

/* ---------------------------------------------------------------- */
/* logic + weights                                                   */
/* ---------------------------------------------------------------- */

let logicPromise: Promise<UpscalerLogic> | null = null;
function loadLogic(): Promise<UpscalerLogic> {
  logicPromise ??= import("@/tools/image-upscaler/index");
  return logicPromise;
}

/**
 * Opens the versioned weights cache and evicts every older one, so a model
 * swap never leaves 66 MB of dead bytes behind. Returns null wherever Cache
 * Storage is unavailable or refuses, which is what private browsing does.
 */
async function openWeightsCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  const name = `${CACHE_PREFIX}${CACHE_VERSION}`;
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

/** True when these weights are already in Cache Storage, so starting is free. */
async function isCached(url: string): Promise<boolean> {
  const cache = await openWeightsCache();
  if (!cache) return false;
  try {
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

/** Reads a body to completion, reporting bytes as they arrive. */
async function readWithProgress(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 0) downloadTotal.value = declared;

  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    downloadedBytes.value = whole.byteLength;
    downloadTotal.value = whole.byteLength;
    return whole;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    downloadedBytes.value = total;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Fetches the weights, preferring the copy the browser already kept. */
async function fetchWeights(url: string): Promise<Uint8Array> {
  const cache = await openWeightsCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await readWithProgress(hit);
    } catch {
      // A broken cache entry is not worth failing the load over.
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new ToolError(
      "weights-missing",
      `The model file at ${url} came back as ${response.status}.`,
      "Reload the page and try again. Large models are served in parts and stitched back together by this site, so a local preview server that does not do the stitching will fail here.",
    );
  }
  if (cache) {
    // Store a clone, and deliberately do NOT await it: cache.put only settles
    // once it has read the whole cloned body, so awaiting here would leave the
    // progress bar at zero for the entire 66 MB and then snap to 100. Both
    // halves of the tee are drained at the same time instead, which is what
    // src/lib/ffmpeg.ts does for the media engine. A rejection (out of quota,
    // a storage policy that says no) must not fail the load.
    cache.put(url, response.clone()).catch(() => {});
  }
  return await readWithProgress(response);
}

/* ---------------------------------------------------------------- */
/* engine                                                            */
/* ---------------------------------------------------------------- */

let ortPromise: Promise<OrtModuleLike> | null = null;
function loadOrt(): Promise<OrtModuleLike> {
  ortPromise ??= (async () => {
    // Imported here rather than at module scope so the runtime stays out of
    // the page bundle until a visitor asks to upscale something.
    const mod = (await import("onnxruntime-web/webgpu")) as unknown as OrtModuleLike;
    mod.env.wasm.wasmPaths = "/models/ort/";
    return mod;
  })();
  return ortPromise;
}

const engine = shallowRef<Engine | null>(null);

async function createEngine(model: UpscalerLogic["MODELS"][number]): Promise<Engine> {
  const [ort, logic] = await Promise.all([loadOrt(), loadLogic()]);
  const bytes = await fetchWeights(model.file);

  const wanted = logic.pickProvider(hasWebGpu.value);
  let session: OrtSessionLike;
  let used: "webgpu" | "wasm" = wanted;
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: [wanted],
      graphOptimizationLevel: "all",
    });
  } catch (e) {
    if (wanted === "wasm") throw e;
    // A machine can report an adapter and still refuse the session (a driver
    // block list, an out of memory adapter). Falling back beats failing.
    used = "wasm";
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }

  provider.value = used;
  providerText.value = logic.providerNote(used);
  return {
    modelId: model.id,
    provider: used,
    session,
    makeTensor: (data, dims) => new ort.Tensor("float32", data, dims),
  };
}

async function ensureEngine(): Promise<Engine> {
  const model = activeModel.value;
  if (!model) throw new ToolError("no-model", "No model is selected.", "Pick a model and retry.");
  const current = engine.value;
  if (current && current.modelId === model.id) return current;

  engineState.value = "loading";
  downloadedBytes.value = 0;
  downloadTotal.value = 0;
  try {
    const next = await createEngine(model);
    // Free the previous graph before the new one settles in, so switching
    // models does not hold two sets of weights in memory at once.
    if (current) await current.session.release?.();
    engine.value = next;
    engineState.value = "ready";
    downloadedBytes.value = downloadTotal.value || model.bytes;
    weightsCached.value = true;
    return next;
  } catch (e) {
    engineState.value = "idle";
    throw e instanceof ToolError
      ? e
      : new ToolError(
          "model-load-failed",
          `The upscaling model could not be started: ${e instanceof Error ? e.message : String(e)}`,
          "Check your connection and press Load model again. The weights are served from this site, so an ad blocker will not be the cause.",
        );
  }
}

async function loadModel() {
  // A manual press means the visitor chose to start it, so drop any hold.
  pendingAutoStart = false;
  error.value = null;
  try {
    await ensureEngine();
  } catch (e) {
    error.value = toToolError(e);
  }
}

/**
 * Starts the weights download without a click, but only when the connection is
 * unmetered AND the model is the small one. The 66 MB photo model always waits
 * for a press, whatever the connection says.
 */
async function maybeAutoStart() {
  const model = activeModel.value;
  if (!model || engineState.value !== "idle") return;

  weightsCached.value = await isCached(model.file);
  if (weightsCached.value) {
    void loadModel();
    return;
  }
  if (model.bytes > AUTO_DOWNLOAD_MAX_BYTES) return;
  if (shouldAutoDownload()) {
    void loadModel();
  } else {
    metered.value = true;
    pendingAutoStart = true;
  }
}

/* ---------------------------------------------------------------- */
/* file handling                                                     */
/* ---------------------------------------------------------------- */

function clearResult() {
  revoke(resultUrl.value);
  resultUrl.value = null;
  resultBlob = null;
  resultBytes.value = 0;
  resultWidth.value = 0;
  resultHeight.value = 0;
  elapsedMs.value = 0;
  doneTiles.value = 0;
  totalTiles.value = 0;
  note.value = null;
}

function loadSource(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      sourceImg.value = img;
      sourceWidth.value = img.naturalWidth || img.width;
      sourceHeight.value = img.naturalHeight || img.height;
      decodeFailed.value = false;
      resolve();
    };
    img.onerror = () => {
      sourceImg.value = null;
      sourceWidth.value = 0;
      sourceHeight.value = 0;
      decodeFailed.value = true;
      resolve();
    };
    img.src = url;
  });
}

/** Runs the size ceilings as soon as an image lands, before any download. */
async function checkSize() {
  sizeProblem.value = null;
  if (!hasFile.value) return;
  const logic = await loadLogic();
  try {
    logic.checkSourceSize(sourceWidth.value, sourceHeight.value);
  } catch (e) {
    sizeProblem.value = toToolError(e);
  }
}

async function readFile(file: File) {
  clearResult();
  revoke(originalUrl.value);
  error.value = null;
  fileName.value = file.name || "pasted-image.png";
  const url = URL.createObjectURL(file);
  originalUrl.value = url;
  await loadSource(url);
  if (decodeFailed.value) {
    error.value = {
      message: "This browser could not decode that file as an image.",
      fix: "Try a PNG, JPEG, or WebP file. HEIC photos from an iPhone need converting first.",
    };
    return;
  }
  await checkSize();
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  void readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) {
      e.preventDefault();
      void readFile(file);
      return;
    }
  }
}

function clearFile() {
  clearResult();
  revoke(originalUrl.value);
  originalUrl.value = null;
  sourceImg.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
  fileName.value = "";
  decodeFailed.value = false;
  sizeProblem.value = null;
  error.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

/** Thrown by the tile loop when Cancel is pressed. Reported as a note, not an error. */
class CanceledRun extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledRun";
  }
}

async function upscale() {
  const img = sourceImg.value;
  if (!img || running.value) return;
  running.value = true;
  cancelRequested.value = false;
  error.value = null;
  clearResult();

  try {
    const logic = await loadLogic();
    logic.checkSourceSize(sourceWidth.value, sourceHeight.value);
    const model = activeModel.value;
    const loaded = await ensureEngine();
    const started = performance.now();

    const width = sourceWidth.value;
    const height = sourceHeight.value;
    const plan = logic.planTiles(width, height, logic.TILE, logic.OVERLAP, model?.scale ?? 4);
    totalTiles.value = plan.tiles.length;
    doneTiles.value = 0;
    await yieldToBrowser();

    const source = drawInto(img, width, height);
    const rgba = source.ctx.getImageData(0, 0, width, height).data;
    const blender = logic.createBlender(plan);

    for (let i = 0; i < plan.tiles.length; i += 1) {
      if (cancelRequested.value) throw new CanceledRun();
      const rect = plan.tiles[i]!;
      const tile = logic.preprocessTile(rgba, width, height, rect);
      const outputs = await loaded.session.run({
        input: loaded.makeTensor(tile, [1, 3, rect.h, rect.w]),
      });
      const tensor = outputs.output;
      if (!tensor || !(tensor.data instanceof Float32Array)) {
        throw new ToolError(
          "unexpected-output",
          "The upscaling model returned a result this tool does not recognize.",
          "Reload the page so the model is read again from the browser cache.",
        );
      }
      logic.addTile(blender, i, tensor.data);
      tensor.dispose?.();
      doneTiles.value = i + 1;
      // One yield per tile: the counter repaints and Cancel stays responsive.
      await yieldToBrowser();
    }

    const pixels = logic.finishBlend(blender);
    const target = document.createElement("canvas");
    target.width = plan.outputWidth;
    target.height = plan.outputHeight;
    const ctx = target.getContext("2d");
    if (!ctx) {
      throw new ToolError(
        "no-canvas",
        "This browser refused to give the page a canvas for the result.",
        "Turn off canvas blocking for this site, or try a smaller image.",
      );
    }
    // The stitched pixels are typed over ArrayBufferLike, but the logic layer
    // always allocates them over a plain ArrayBuffer, so the cast is safe and
    // avoids copying a result that can reach tens of megabytes.
    const pixelData = pixels as Uint8ClampedArray<ArrayBuffer>;
    ctx.putImageData(new ImageData(pixelData, plan.outputWidth, plan.outputHeight), 0, 0);

    const blob = await canvasToBlob(target);
    if (!blob) {
      throw new ToolError(
        "encode-failed",
        "The browser could not encode the finished image as a PNG.",
        "Try a smaller image: a very large result can exceed what a canvas will encode.",
      );
    }
    resultBlob = blob;
    resultUrl.value = URL.createObjectURL(blob);
    resultBytes.value = blob.size;
    resultWidth.value = plan.outputWidth;
    resultHeight.value = plan.outputHeight;
    dividerPercent.value = 50;
    elapsedMs.value = performance.now() - started;
  } catch (e) {
    if (e instanceof CanceledRun) {
      note.value = `Stopped after ${doneTiles.value} of ${totalTiles.value} tiles. Nothing was saved.`;
    } else {
      error.value = toToolError(e);
    }
  } finally {
    running.value = false;
    cancelRequested.value = false;
  }
}

function cancelRun() {
  if (running.value) cancelRequested.value = true;
}

function downloadResult() {
  if (!resultBlob) return;
  downloadBlob(resultBlob, `${baseName(fileName.value)}-4x.png`);
}

/* ---------------------------------------------------------------- */
/* compare slider                                                    */
/* ---------------------------------------------------------------- */

function setDividerFromClientX(clientX: number) {
  const box = compareBox.value;
  if (!box) return;
  const rect = box.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = (clientX - rect.left) / rect.width;
  dividerPercent.value = Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function onComparePointerDown(e: PointerEvent) {
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  setDividerFromClientX(e.clientX);
}

function onComparePointerMove(e: PointerEvent) {
  const target = e.currentTarget as HTMLElement;
  if (!target.hasPointerCapture(e.pointerId)) return;
  setDividerFromClientX(e.clientX);
}

function onComparePointerUp(e: PointerEvent) {
  const target = e.currentTarget as HTMLElement;
  if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
}

function onDividerKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 2;
  let next = dividerPercent.value;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") next -= step;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") next += step;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = 100;
  else return;
  e.preventDefault();
  dividerPercent.value = Math.max(0, Math.min(100, next));
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

async function detectWebGpu(): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<unknown> };
  };
  if (!nav.gpu) return false;
  try {
    return (await nav.gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

watch(modelId, () => {
  // A different model means a different session. Keep any finished result on
  // screen, but make the next run load the newly chosen weights.
  engineState.value = engine.value && engine.value.modelId === modelId.value ? "ready" : "idle";
  void maybeAutoStart();
});

onMounted(async () => {
  supported.value = typeof WebAssembly !== "undefined";
  if (!supported.value) return;

  const logic = await loadLogic();
  models.value = logic.MODELS;
  modelId.value = logic.DEFAULT_MODEL_ID;

  hasWebGpu.value = await detectWebGpu();
  provider.value = logic.pickProvider(hasWebGpu.value);
  providerText.value = logic.providerNote(provider.value);

  metered.value = isMetered();
  void maybeAutoStart();
  stopConnectionWatch = onConnectionChange(() => {
    metered.value = isMetered();
    if (pendingAutoStart && shouldAutoDownload()) {
      pendingAutoStart = false;
      void maybeAutoStart();
    }
  });

  window.addEventListener("paste", onPaste);
});

onUnmounted(() => {
  stopConnectionWatch();
  if (typeof window !== "undefined") window.removeEventListener("paste", onPaste);
  revoke(originalUrl.value);
  revoke(resultUrl.value);
  void engine.value?.session.release?.();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Capability gate -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">This browser cannot run the upscaling model.</p>
      <p class="mt-1 text-muted-foreground">
        {{ meta.name }} runs a neural network inside this tab, which needs WebAssembly. If this
        message stays, your browser has WebAssembly turned off or is too old to run it.
      </p>
    </div>

    <template v-else>
      <!-- Input -->
      <div
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="dragging ? 'ring-2 ring-ring' : ''"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Image
          </span>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
        </div>

        <div v-if="hasFile" class="px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {{ sourceWidth }} x {{ sourceHeight }} px
            </span>
            <span v-if="plannedOutput" class="shrink-0 text-muted-foreground tabular-nums">
              to {{ plannedOutput.w }} x {{ plannedOutput.h }}
            </span>
            <button
              type="button"
              aria-label="Remove image"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
          Drop an image here, paste one, or pick a file. Everything runs in this tab: your files and
          inputs never leave your device.
        </p>
      </div>

      <!-- Size refusal -->
      <div
        v-if="sizeProblem"
        role="status"
        class="rounded-lg border border-[var(--warn)]/50 bg-[var(--warn-soft)] px-3 py-2 text-sm"
      >
        <p class="font-medium">{{ sizeProblem.message }}</p>
        <p v-if="sizeProblem.fix" class="mt-1 text-muted-foreground">{{ sizeProblem.fix }}</p>
      </div>

      <!-- Errors -->
      <div
        v-if="error"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">{{ error.message }}</p>
        <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
      </div>

      <!-- Model + provider -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Model
          </span>
          <span
            class="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium shadow-[var(--sh-sm)]"
            :title="providerText"
          >
            <Zap
              class="size-3"
              :class="provider === 'webgpu' ? 'text-[var(--positive)]' : 'text-muted-foreground'"
            />
            {{ providerLabel }}
          </span>
        </div>

        <Segmented
          v-if="modelOptions.length"
          :model-value="modelId"
          :options="modelOptions"
          label="Upscaling model"
          class="w-fit"
          @update:model-value="(v) => (modelId = v)"
        />

        <p class="text-xs text-muted-foreground">
          {{ activeModel?.note }}
        </p>
        <p class="text-xs text-muted-foreground">{{ providerText }}</p>
      </div>

      <!-- Weights -->
      <div
        v-if="engineState !== 'ready'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Model download
        </span>

        <p class="text-sm text-muted-foreground">
          This tool runs Real-ESRGAN, an open super resolution model, inside your browser. The
          weights are a one time download of
          {{ formatBytes(modelBytes) }} from this site, and your browser keeps them afterwards, so
          later visits start straight from the cache. Nothing is uploaded: your files and inputs
          never leave your device.
        </p>

        <p v-if="weightsCached && engineState === 'idle'" class="text-xs text-muted-foreground">
          Your browser already has these weights, so starting costs no data.
        </p>
        <p
          v-else-if="metered && engineState === 'idle' && autoStarts"
          class="text-xs text-muted-foreground"
        >
          Your connection looks metered, so the download waits for you to start it.
        </p>
        <p v-else-if="engineState === 'idle' && !autoStarts" class="text-xs text-muted-foreground">
          This one is large, so it never starts on its own.
        </p>

        <div v-if="engineState === 'loading'" class="flex flex-col gap-2">
          <div
            class="h-2 overflow-hidden rounded-full bg-background"
            role="progressbar"
            :aria-valuenow="downloadPercent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="downloadLabel"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              :style="{ width: `${downloadPercent}%` }"
            />
          </div>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">{{ downloadLabel }}</p>
        </div>

        <Button v-else class="self-start" size="sm" @click="loadModel">
          Load model ({{ formatBytes(modelBytes) }})
        </Button>
      </div>

      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check class="size-3.5 text-[var(--positive)]" />
        Model ready. It stays loaded for as long as this page is open.
      </p>

      <!-- Run -->
      <div class="flex flex-wrap items-center gap-3">
        <Button :disabled="!canRun" @click="upscale">
          {{ running ? "Upscaling…" : "Upscale 4x" }}
        </Button>
        <Button v-if="running" variant="ghost" size="sm" @click="cancelRun"> Cancel </Button>
        <span v-if="elapsedMs > 0" class="font-mono text-xs text-muted-foreground tabular-nums">
          {{ totalTiles }} tiles in {{ (elapsedMs / 1000).toFixed(1) }} s on {{ providerLabel }}
        </span>
      </div>

      <div v-if="running" class="flex flex-col gap-2">
        <div
          class="h-2 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          :aria-valuenow="tilePercent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="tileLabel"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
            :style="{ width: `${tilePercent}%` }"
          />
        </div>
        <p class="font-mono text-xs text-muted-foreground tabular-nums">{{ tileLabel }}</p>
      </div>

      <p v-if="note" class="text-xs text-muted-foreground">{{ note }}</p>

      <!-- Before and after -->
      <div v-if="hasFile && !decodeFailed" class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Compare
          </span>
          <div v-if="resultUrl" class="flex items-center gap-2">
            <Switch
              id="upscale-actual"
              :model-value="actualPixels"
              @update:model-value="(v) => (actualPixels = Boolean(v))"
            />
            <Label for="upscale-actual" class="text-xs text-muted-foreground">
              100 percent pixels
            </Label>
          </div>
        </div>

        <div
          class="overflow-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          :class="actualPixels ? 'max-h-[560px]' : ''"
        >
          <div
            ref="compareBox"
            class="relative mx-auto select-none"
            :class="resultUrl && actualPixels ? '' : 'touch-none'"
            :style="
              resultUrl && actualPixels
                ? { width: `${resultWidth}px`, height: `${resultHeight}px` }
                : {
                    width: '100%',
                    maxWidth: `${fitMaxWidth}px`,
                    aspectRatio: `${sourceWidth} / ${sourceHeight}`,
                  }
            "
            @pointerdown="onComparePointerDown"
            @pointermove="onComparePointerMove"
            @pointerup="onComparePointerUp"
            @pointercancel="onComparePointerUp"
          >
            <img
              v-if="resultUrl"
              :src="resultUrl"
              alt="The upscaled result"
              class="absolute inset-0 block h-full w-full object-contain"
              draggable="false"
            />
            <img
              :src="originalUrl ?? ''"
              alt="The image as it was dropped in, at the same display size"
              class="absolute inset-0 block h-full w-full object-contain"
              :style="resultUrl ? { clipPath: `inset(0 ${100 - dividerPercent}% 0 0)` } : undefined"
              draggable="false"
            />

            <template v-if="resultUrl">
              <div
                class="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
                :style="{ left: `${dividerPercent}%` }"
              />
              <button
                type="button"
                role="slider"
                aria-label="Compare original against the upscaled result"
                :aria-valuenow="dividerPercent"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuetext="`${dividerPercent} percent`"
                class="absolute top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full border bg-card shadow-[var(--sh-md)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                :style="{ left: `${dividerPercent}%` }"
                @keydown="onDividerKey"
              >
                <GripVertical class="size-4 text-muted-foreground" />
              </button>
              <span
                class="pointer-events-none absolute top-2 left-2 rounded-full bg-card/90 px-2 py-0.5 text-xs text-muted-foreground tabular-nums"
              >
                Original {{ sourceWidth }} x {{ sourceHeight }}
              </span>
              <span
                class="pointer-events-none absolute top-2 right-2 rounded-full bg-card/90 px-2 py-0.5 text-xs text-muted-foreground tabular-nums"
              >
                4x {{ resultWidth }} x {{ resultHeight }}
              </span>
            </template>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          <template v-if="resultUrl">
            Drag the divider, or focus the handle and use the arrow keys. The left side is your
            original stretched to the same size, which is what a plain resize would look like.
          </template>
          <template v-else> The result appears here with a divider to compare against. </template>
        </p>
      </div>

      <div v-if="resultUrl" class="flex flex-wrap items-center gap-2">
        <Button size="sm" @click="downloadResult"> Download PNG </Button>
        <span class="text-xs text-muted-foreground">
          {{ resultWidth }} x {{ resultHeight }} pixels, {{ formatBytes(resultBytes) }}
        </span>
      </div>

      <p class="text-xs text-muted-foreground">
        Real-ESRGAN invents the detail it adds, so faces, small text, and fine patterns can come
        back confidently wrong. Compare against the original before you rely on the result. The
        image is cut into 128 pixel tiles that overlap by 16 and are feathered back together, so
        memory stays flat and no seams show.
      </p>
    </template>
  </div>
</template>
