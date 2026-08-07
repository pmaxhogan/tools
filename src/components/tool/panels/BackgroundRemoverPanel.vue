<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { Check, X } from 'lucide-vue-next';
import { ToolError, type ToolMeta } from '@/tools/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Bespoke panel for the background remover.
 *
 * The generic ToolShell cannot host this tool: it needs a canvas to decode and
 * rescale the photo, an opt in download of neural network weights, and a
 * before and after view. The logic layer stays pure and owns every pixel
 * operation (matte to alpha, feathering, compositing); this file owns the
 * canvas, the model session, and the UI around them.
 *
 * Model wiring, taken from the Xenova/modnet model card and the installed
 * @huggingface/transformers 4.2.0 source rather than from memory:
 *
 *  - The weights live at /models/modnet/onnx/model_quantized.onnx, staged by
 *    scripts/prepare-models.mjs. transformers.js is pointed at this origin
 *    (allowRemoteModels = false, localModelPath = '/models/') so nothing is
 *    fetched from a third party at runtime.
 *  - That staged copy is the ONNX file only, without the repo's config.json,
 *    so the config is passed inline. `PretrainedConfig.from_pretrained` uses a
 *    supplied config object as is and skips the network read entirely, and
 *    `modnet` is a registered custom architecture that resolves to a plain
 *    encoder only model.
 *  - dtype "q8" maps to the `_quantized` file suffix, which is exactly the
 *    file that is staged. The device is pinned to wasm because the WebGPU
 *    runtime files are deliberately not staged.
 *  - The ONNX graph names its input "input" and its output "output", and the
 *    output is a single channel alpha matte in the 0 to 1 range.
 *  - Preprocessing mirrors the repo's preprocessor_config.json exactly:
 *    resize so the shortest edge is 512 with the aspect ratio kept, floor each
 *    side to a multiple of 32, rescale to 0 to 1, then normalize with mean 0.5
 *    and standard deviation 0.5, laid out as NCHW float32.
 *
 * Nothing runs at import time and nothing touches the DOM until a file
 * arrives, so the component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

type MatteLogic = typeof import('@/tools/background-remover/index');

/** The shape of the one model output this panel reads. */
interface MatteTensor {
  data: Float32Array;
  dims: number[];
}

/** A loaded MODNet session plus the tensor constructor that feeds it. */
interface Engine {
  run: (inputs: Record<string, unknown>) => Promise<Record<string, MatteTensor>>;
  makeTensor: (data: Float32Array, dims: number[]) => unknown;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Directory name under /models/, which is what transformers.js resolves. */
const MODEL_ID = 'modnet';
/** Staged size of the quantized weights, used before the real total arrives. */
const MODEL_BYTES = 6_632_188;
/** Photos larger than this are scaled down first, with a note in the UI. */
const MAX_SOURCE_EDGE = 4096;
/** preprocessor_config.json: size.shortest_edge. */
const MODEL_SHORTEST_EDGE = 512;
/** preprocessor_config.json: size_divisibility. */
const MODEL_DIVISOR = 32;
/**
 * Not part of the reference preprocessing. A very wide panorama would push the
 * long side past 3000 pixels once the short side is 512, which the wasm build
 * cannot run in a sane amount of time, so the model input is capped here.
 */
const MODEL_MAX_EDGE = 1024;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const supported = ref(true);
const fileName = ref('');
const originalUrl = ref<string | null>(null);
const sourceImg = shallowRef<HTMLImageElement | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);
const decodeFailed = ref(false);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const engineState = ref<'idle' | 'loading' | 'ready'>('idle');
const downloadedBytes = ref(0);
const downloadTotal = ref(0);

const outputMode = ref('transparent');
const bgColor = ref('#ffffff');
const featherEdges = ref(true);

const running = ref(false);
const resultUrl = ref<string | null>(null);
const resultType = ref('image/png');
const resultBytes = ref(0);
const elapsedMs = ref(0);
const downscaleNote = ref<string | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const hasFile = computed(() => sourceImg.value !== null);
const canRun = computed(() => hasFile.value && !running.value && engineState.value !== 'loading');
const downloadPercent = computed(() => {
  const total = downloadTotal.value || MODEL_BYTES;
  return Math.min(100, Math.round((downloadedBytes.value / total) * 100));
});
const downloadLabel = computed(
  () =>
    `Downloading the matting model (${megabytes(downloadedBytes.value)} of ${megabytes(
      downloadTotal.value || MODEL_BYTES,
    )} MB)`,
);
const resultExtension = computed(() => (resultType.value === 'image/png' ? 'png' : 'jpg'));

/* ---------------------------------------------------------------- */
/* small helpers                                                     */
/* ---------------------------------------------------------------- */

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || 'photo';
}

function revoke(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, q));
}

/* ---------------------------------------------------------------- */
/* logic + model loading                                             */
/* ---------------------------------------------------------------- */

let logicPromise: Promise<MatteLogic> | null = null;
function loadLogic(): Promise<MatteLogic> {
  logicPromise ??= import('@/tools/background-remover/index');
  return logicPromise;
}

let enginePromise: Promise<Engine> | null = null;
const engine = shallowRef<Engine | null>(null);
/** True once a `progress_total` tick arrives, which supersedes per file ticks. */
let sawAggregateProgress = false;

function onModelProgress(info: { status: string; loaded?: number; total?: number }) {
  if (info.status === 'progress_total') sawAggregateProgress = true;
  else if (info.status !== 'progress' || sawAggregateProgress) return;
  if (typeof info.total === 'number' && info.total > 0) downloadTotal.value = info.total;
  if (typeof info.loaded === 'number') downloadedBytes.value = info.loaded;
}

async function createEngine(): Promise<Engine> {
  // Imported here rather than at module scope so the ~1 MB runtime and the
  // ONNX backend stay out of the page bundle until a visitor asks for them.
  const tf = await import('@huggingface/transformers');

  // Everything is served from this origin. Setting wasmPaths before the first
  // session is created is what stops the runtime reaching for a CDN.
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = '/models/';
  if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.wasmPaths = '/models/ort/';

  const model = await tf.AutoModel.from_pretrained(MODEL_ID, {
    // The staged copy is the weights only, so the config is supplied inline.
    config: { model_type: 'modnet' } as never,
    dtype: 'q8',
    device: 'wasm',
    progress_callback: onModelProgress,
  });

  const callable = model as unknown as (
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, MatteTensor>>;

  return {
    run: (inputs) => callable(inputs),
    makeTensor: (data, dims) => new tf.Tensor('float32', data, dims),
  };
}

async function ensureEngine(): Promise<Engine> {
  if (engine.value) return engine.value;
  engineState.value = 'loading';
  enginePromise ??= createEngine();
  try {
    const loaded = await enginePromise;
    engine.value = loaded;
    engineState.value = 'ready';
    downloadedBytes.value = downloadTotal.value || MODEL_BYTES;
    return loaded;
  } catch (e) {
    // A failed load must not poison the singleton: the next press retries.
    enginePromise = null;
    engineState.value = 'idle';
    throw new ToolError(
      'model-load-failed',
      `The matting model could not be started: ${e instanceof Error ? e.message : String(e)}`,
      'Check your connection and press Load model again. The weights are served from this site, so an ad blocker will not be the cause.',
    );
  }
}

async function loadModel() {
  error.value = null;
  try {
    await ensureEngine();
  } catch (e) {
    error.value = toToolError(e);
  }
}

/* ---------------------------------------------------------------- */
/* file handling                                                     */
/* ---------------------------------------------------------------- */

function clearResult() {
  revoke(resultUrl.value);
  resultUrl.value = null;
  resultBytes.value = 0;
  elapsedMs.value = 0;
  downscaleNote.value = null;
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

async function readFile(file: File) {
  clearResult();
  revoke(originalUrl.value);
  error.value = null;
  fileName.value = file.name;
  const url = URL.createObjectURL(file);
  originalUrl.value = url;
  await loadSource(url);
  if (decodeFailed.value) {
    error.value = {
      message: 'This browser could not decode that file as an image.',
      fix: 'Try a JPEG, PNG, or WebP file. HEIC photos from an iPhone need converting first.',
    };
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = '';
  });
}

function clearFile() {
  clearResult();
  revoke(originalUrl.value);
  originalUrl.value = null;
  sourceImg.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
  fileName.value = '';
  decodeFailed.value = false;
  error.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

/* ---------------------------------------------------------------- */
/* geometry                                                          */
/* ---------------------------------------------------------------- */

/** The resolution the result is produced at: the original, capped at 4096. */
function workSize(w: number, h: number): { w: number; h: number; scaled: boolean } {
  const longest = Math.max(w, h);
  if (longest <= MAX_SOURCE_EDGE) return { w, h, scaled: false };
  const factor = MAX_SOURCE_EDGE / longest;
  return {
    w: Math.max(1, Math.round(w * factor)),
    h: Math.max(1, Math.round(h * factor)),
    scaled: true,
  };
}

/**
 * The resolution the model sees. Shortest edge to 512 with the aspect ratio
 * kept, then each side floored to a multiple of 32, which is what the
 * reference image processor does for this model.
 */
function modelInputSize(w: number, h: number): { w: number; h: number } {
  const factor = Math.max(MODEL_SHORTEST_EDGE / w, MODEL_SHORTEST_EDGE / h);
  let mw = Math.floor(Number((w * factor).toFixed(2)));
  let mh = Math.floor(Number((h * factor).toFixed(2)));
  const longest = Math.max(mw, mh);
  if (longest > MODEL_MAX_EDGE) {
    const cap = MODEL_MAX_EDGE / longest;
    mw = Math.floor(mw * cap);
    mh = Math.floor(mh * cap);
  }
  return {
    w: Math.max(1, Math.floor(mw / MODEL_DIVISOR)) * MODEL_DIVISOR,
    h: Math.max(1, Math.floor(mh / MODEL_DIVISOR)) * MODEL_DIVISOR,
  };
}

/** A blur wide enough to soften the edge without eating thin strands of hair. */
function featherRadius(w: number, h: number): number {
  return Math.max(1, Math.round(Math.min(w, h) / 400));
}

function drawInto(
  img: HTMLImageElement,
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new ToolError(
      'no-canvas',
      'This browser refused to give the page a 2D canvas, so the photo cannot be read.',
      'Turn off canvas blocking or anti fingerprinting for this site, then try again.',
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

/**
 * Copies a matte with every value clamped into 0 to 1.
 *
 * This matters more than it looks: `normalizeMatte` decides whether a float
 * matte is 0 to 1 or 0 to 255 by asking whether anything in it exceeds 1, so a
 * single quantization overshoot of 1.0001 would make the whole matte read as
 * byte scaled and the cutout would come out fully transparent.
 */
function clampMatte(matte: Float32Array): Float32Array {
  const out = new Float32Array(matte.length);
  for (let i = 0; i < matte.length; i += 1) {
    const v = matte[i] ?? 0;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/**
 * Scales the predicted matte back up to the size of the photo. A canvas gives
 * a smoothly interpolated edge, so that is the preferred path; the pure
 * nearest neighbour helper in the logic layer is the fallback when a browser
 * will not hand over a second 2D context.
 */
function upscaleMatte(
  matte: Float32Array,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
  fallback: MatteLogic['resizeMatteNearest'],
): Float32Array | Uint8ClampedArray {
  if (fromW === toW && fromH === toH) return clampMatte(matte);
  const src = document.createElement('canvas');
  src.width = fromW;
  src.height = fromH;
  const srcCtx = src.getContext('2d', { willReadFrequently: true });
  const dst = document.createElement('canvas');
  dst.width = toW;
  dst.height = toH;
  const dstCtx = dst.getContext('2d', { willReadFrequently: true });
  if (!srcCtx || !dstCtx) return clampMatte(fallback(matte, fromW, fromH, toW, toH));

  const clamped = clampMatte(matte);
  const grey = srcCtx.createImageData(fromW, fromH);
  for (let i = 0; i < fromW * fromH; i += 1) {
    const v = Math.round((clamped[i] ?? 0) * 255);
    grey.data[i * 4] = v;
    grey.data[i * 4 + 1] = v;
    grey.data[i * 4 + 2] = v;
    grey.data[i * 4 + 3] = 255;
  }
  srcCtx.putImageData(grey, 0, 0);

  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = 'high';
  dstCtx.drawImage(src, 0, 0, toW, toH);

  const scaled = dstCtx.getImageData(0, 0, toW, toH).data;
  const out = new Uint8ClampedArray(toW * toH);
  for (let i = 0; i < out.length; i += 1) out[i] = scaled[i * 4]!;
  return out;
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

async function removeBackground() {
  const img = sourceImg.value;
  if (!img || running.value) return;
  running.value = true;
  error.value = null;
  clearResult();

  try {
    const [loaded, logic] = await Promise.all([ensureEngine(), loadLogic()]);
    const started = performance.now();

    const work = workSize(sourceWidth.value, sourceHeight.value);
    if (work.scaled) {
      downscaleNote.value = `The photo is ${sourceWidth.value} by ${sourceHeight.value} pixels, so it was scaled down to ${work.w} by ${work.h} before matting.`;
    }
    const model = modelInputSize(work.w, work.h);

    // Preprocess: draw the photo at the model's input size, then rescale to
    // 0 to 1 and normalize with mean 0.5 and standard deviation 0.5, which is
    // the same as mapping each channel onto minus 1 to 1.
    const small = drawInto(img, model.w, model.h);
    const pixels = model.w * model.h;
    const rgba = small.ctx.getImageData(0, 0, model.w, model.h).data;
    const planar = new Float32Array(pixels * 3);
    for (let i = 0; i < pixels; i += 1) {
      planar[i] = (rgba[i * 4]! / 255) * 2 - 1;
      planar[pixels + i] = (rgba[i * 4 + 1]! / 255) * 2 - 1;
      planar[pixels * 2 + i] = (rgba[i * 4 + 2]! / 255) * 2 - 1;
    }

    const outputs = await loaded.run({
      input: loaded.makeTensor(planar, [1, 3, model.h, model.w]),
    });
    const matte = outputs.output?.data;
    if (!matte || matte.length !== pixels) {
      throw new ToolError(
        'unexpected-output',
        'The matting model returned a result this tool does not recognise.',
        'Reload the page so the model is read again from the browser cache.',
      );
    }

    // Back to full size, into the alpha channel, then soften and composite.
    const full = upscaleMatte(matte, model.w, model.h, work.w, work.h, logic.resizeMatteNearest);
    const target = drawInto(img, work.w, work.h);
    const image = target.ctx.getImageData(0, 0, work.w, work.h);
    logic.applyMatte(image.data, full, work.w, work.h);
    if (featherEdges.value) {
      logic.boxBlurAlpha(image.data, work.w, work.h, featherRadius(work.w, work.h));
    }

    if (outputMode.value === 'transparent') {
      target.ctx.putImageData(image, 0, 0);
      resultType.value = 'image/png';
    } else {
      const fill = outputMode.value === 'white' ? '#ffffff' : bgColor.value;
      const composed = logic.compositeOnColor(image.data, work.w, work.h, fill);
      target.ctx.putImageData(new ImageData(composed, work.w, work.h), 0, 0);
      resultType.value = 'image/jpeg';
    }

    const blob = await canvasToBlob(
      target.canvas,
      resultType.value,
      resultType.value === 'image/jpeg' ? 0.92 : undefined,
    );
    if (!blob) {
      throw new ToolError(
        'encode-failed',
        'The browser could not encode the finished image.',
        'Try a smaller photo, or switch the background option and run it again.',
      );
    }
    resultUrl.value = URL.createObjectURL(blob);
    resultBytes.value = blob.size;
    elapsedMs.value = performance.now() - started;
  } catch (e) {
    error.value = toToolError(e);
  } finally {
    running.value = false;
  }
}

function downloadResult() {
  if (!resultUrl.value) return;
  triggerDownload(
    resultUrl.value,
    `${baseName(fileName.value)}-no-background.${resultExtension.value}`,
  );
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  supported.value = typeof WebAssembly !== 'undefined';
});

onUnmounted(() => {
  revoke(originalUrl.value);
  revoke(resultUrl.value);
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
      <p class="font-medium text-muted-foreground">
        This browser cannot run the matting model.
      </p>
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
            Photo
          </span>
          <Button
            variant="ghost"
            size="sm"
            @click="fileInput?.click()"
          >
            Open file…
          </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept="image/*"
            @change="onPickFile"
          >
        </div>

        <div
          v-if="hasFile"
          class="px-3 pt-2 pb-3"
        >
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {{ sourceWidth }} x {{ sourceHeight }} px
            </span>
            <button
              type="button"
              aria-label="Remove photo"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <p
          v-else
          class="px-3 pt-1 pb-4 text-sm text-muted-foreground"
        >
          Drop a photo of a person here, or pick one with the button. Everything runs in this tab:
          your files and inputs never leave your device.
        </p>
      </div>

      <!-- Errors -->
      <div
        v-if="error"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ error.message }}
        </p>
        <p
          v-if="error.fix"
          class="mt-1 text-muted-foreground"
        >
          {{ error.fix }}
        </p>
      </div>

      <!-- Model -->
      <div
        v-if="engineState !== 'ready'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Matting model
        </span>

        <p class="text-sm text-muted-foreground">
          This tool runs MODNet, an open portrait matting model, inside your browser. The weights
          are a one time download of about 6.3 MB from this site, and your browser keeps them
          afterwards, so later visits start straight from the cache and work offline. Nothing is
          uploaded: your files and inputs never leave your device.
        </p>

        <div
          v-if="engineState === 'loading'"
          class="flex flex-col gap-2"
        >
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
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ downloadLabel }}
          </p>
        </div>

        <Button
          v-else
          class="self-start"
          size="sm"
          @click="loadModel"
        >
          Load model (6.3 MB)
        </Button>
      </div>

      <p
        v-else
        class="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Check class="size-3.5 text-[var(--positive)]" />
        Model ready. It stays loaded for as long as this page is open.
      </p>

      <!-- Options -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Output
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-44 flex-col gap-1.5">
            <Label
              for="bg-output"
              class="text-xs text-muted-foreground"
            >Background</Label>
            <Select
              :model-value="outputMode"
              @update:model-value="(v) => (outputMode = String(v))"
            >
              <SelectTrigger
                id="bg-output"
                size="sm"
                class="w-full bg-card"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transparent">
                  Transparent PNG
                </SelectItem>
                <SelectItem value="white">
                  White
                </SelectItem>
                <SelectItem value="color">
                  Custom color
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div
            v-if="outputMode === 'color'"
            class="flex w-32 flex-col gap-1.5"
          >
            <Label
              for="bg-color"
              class="text-xs text-muted-foreground"
            >Color</Label>
            <Input
              id="bg-color"
              :model-value="bgColor"
              class="h-9 bg-card font-mono"
              placeholder="#ffffff"
              @update:model-value="(v) => (bgColor = String(v))"
            />
          </div>

          <div class="flex items-center gap-2 pb-2.5">
            <Switch
              id="bg-feather"
              :model-value="featherEdges"
              @update:model-value="(v) => (featherEdges = Boolean(v))"
            />
            <Label
              for="bg-feather"
              class="text-xs text-muted-foreground"
            >Feather edges</Label>
          </div>
        </div>
      </div>

      <!-- Run -->
      <div class="flex flex-wrap items-center gap-3">
        <Button
          :disabled="!canRun"
          @click="removeBackground"
        >
          {{ running ? 'Working…' : 'Remove background' }}
        </Button>
        <span
          v-if="elapsedMs > 0"
          class="font-mono text-xs text-muted-foreground tabular-nums"
        >
          Done in {{ (elapsedMs / 1000).toFixed(1) }} s
        </span>
      </div>

      <p
        v-if="downscaleNote"
        class="text-xs text-muted-foreground"
      >
        {{ downscaleNote }}
      </p>

      <!-- Before and after -->
      <div
        v-if="hasFile && !decodeFailed"
        class="grid gap-3 sm:grid-cols-2"
      >
        <figure class="flex flex-col gap-1.5">
          <img
            :src="originalUrl ?? ''"
            alt="The photo as it was dropped in"
            class="block max-h-[360px] w-full rounded-[10px] object-contain shadow-[var(--sh-inset)]"
          >
          <figcaption class="text-xs text-muted-foreground">
            Original
          </figcaption>
        </figure>
        <figure class="flex flex-col gap-1.5">
          <div class="checker rounded-[10px] shadow-[var(--sh-inset)]">
            <img
              v-if="resultUrl"
              :src="resultUrl"
              alt="The photo with its background removed"
              class="block max-h-[360px] w-full rounded-[10px] object-contain"
            >
            <p
              v-else
              class="px-3 py-16 text-center text-sm text-muted-foreground"
            >
              The cutout appears here.
            </p>
          </div>
          <figcaption class="text-xs text-muted-foreground">
            <template v-if="resultUrl">
              Result, {{ humanSize(resultBytes) }} as {{ resultExtension.toUpperCase() }}
            </template>
            <template v-else>
              Result
            </template>
          </figcaption>
        </figure>
      </div>

      <div
        v-if="resultUrl"
        class="flex flex-wrap items-center gap-2"
      >
        <Button
          size="sm"
          @click="downloadResult"
        >
          Download {{ resultExtension.toUpperCase() }}
        </Button>
      </div>

      <p class="text-xs text-muted-foreground">
        MODNet is a portrait matting model, so it is at its best on photos of people and gets
        noticeably vaguer on products, pets, and busy objects. The model always sees a copy of the
        photo scaled to about 512 pixels on its shortest side, and the matte is scaled back up and
        applied at full resolution, so the file you download keeps the size it came in at.
      </p>
    </template>
  </div>
</template>

<style scoped>
/* Checkerboard so transparent regions read as transparent, not as the surface. */
.checker {
  background-color: var(--card);
  background-image:
    linear-gradient(
      45deg,
      var(--secondary) 25%,
      transparent 25%,
      transparent 75%,
      var(--secondary) 75%
    ),
    linear-gradient(
      45deg,
      var(--secondary) 25%,
      transparent 25%,
      transparent 75%,
      var(--secondary) 75%
    );
  background-size: 16px 16px;
  background-position:
    0 0,
    8px 8px;
}
</style>
