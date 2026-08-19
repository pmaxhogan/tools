<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Check, Copy, Download, ImageOff, MoveHorizontal, Sparkles } from "lucide-vue-next";
import type { OptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  ALGORITHMS,
  PALETTES,
  dither,
  paletteColors,
  resizeBox,
  uniqueColors,
} from "@/tools/image-dithering/index";
import type { DitherSettings } from "@/tools/image-dithering/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Image Dithering tool.
 *
 * The generic shell only renders text, and this tool is a picture in and a
 * picture out, so the pixels live here. Every piece of arithmetic still comes
 * from the pure layer in `src/tools/image-dithering/` (PROJECT.md rule 27):
 * `resizeBox` shrinks the source before the dither, `dither` quantizes it to
 * the palette, `paletteColors` resolves a palette id (including the custom hex
 * list), and `uniqueColors` counts what actually landed in the output. The
 * panel only decodes the file, paints canvases, and saves the result.
 *
 * Two decisions worth writing down:
 *
 * 1. The working image is capped at 2048 pixels on its long edge. `dither` is
 *    one indivisible pass, so it cannot be chunked the way a per pixel matrix
 *    multiply can, and the cap keeps the worst case (a 12 tap kernel over four
 *    megapixels) down to something a live preview can absorb. The panel says so
 *    on screen whenever a picture was actually scaled down.
 * 2. The preview canvas is painted at the dithered size and magnified by CSS
 *    with `image-rendering: pixelated`, so what you see is the real output with
 *    hard pixel edges rather than a browser resample of it. The download is the
 *    same canvas, so the PNG is always at its native dithered size.
 *
 * Nothing here touches the network: the file is read with an object URL and
 * drawn on a local canvas, so your files and inputs never leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * options, driven by the meta schema
 * ------------------------------------------------------------------ */

function defaultOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of props.meta.options ?? []) out[spec.id] = spec.default;
  return out;
}

const opts = ref<Record<string, unknown>>(defaultOpts());

function setOpt(id: string, value: unknown) {
  opts.value = { ...opts.value, [id]: value };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const algorithmId = computed(() => String(opts.value.algorithm ?? "floyd-steinberg"));
const paletteId = computed(() => String(opts.value.palette ?? "bw"));
const customPalette = computed(() => String(opts.value.customPalette ?? ""));
const scale = computed(() => Math.round(clampNumber(opts.value.scale, 1, 8, 1)));

/** The custom hex list is noise until the custom palette is actually selected. */
const visibleOptions = computed<OptionSpec[]>(() =>
  (props.meta.options ?? []).filter(
    (spec) => spec.id !== "customPalette" || paletteId.value === "custom",
  ),
);

const settings = computed<DitherSettings>(() => ({
  algorithm: algorithmId.value,
  palette: paletteId.value,
  customPalette: customPalette.value,
  serpentine: opts.value.serpentine !== false,
  strength: clampNumber(opts.value.strength, 0, 1, 1),
  gamma: opts.value.gamma !== false,
}));

const algorithmLabel = computed(
  () => ALGORITHMS.find((a) => a.id === algorithmId.value)?.label ?? algorithmId.value,
);
const paletteLabel = computed(
  () => PALETTES.find((p) => p.id === paletteId.value)?.label ?? paletteId.value,
);

/**
 * Swatches for the palette select. `paletteColors` throws on a custom list that
 * is empty or malformed, which is the normal state one keystroke into typing
 * one, so a failure here is an empty swatch row rather than an error.
 */
const swatches = computed<string[]>(() => {
  try {
    return paletteColors(paletteId.value, customPalette.value).map(
      ([r, g, b]) => `rgb(${r} ${g} ${b})`,
    );
  } catch {
    return [];
  }
});

const paletteSize = computed(() => swatches.value.length);

/* ------------------------------------------------------------------ *
 * panel state
 * ------------------------------------------------------------------ */

/** Longest edge the working image is capped at, so one dither pass stays quick. */
const MAX_EDGE = 2048;
/** Long enough to swallow a drag on a slider, short enough to feel live. */
const DEBOUNCE_MS = 150;

type ViewMode = "side" | "stacked" | "compare";

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "side", label: "Side by side" },
  { value: "stacked", label: "Stacked" },
  { value: "compare", label: "Compare" },
];

const view = ref<ViewMode>("side");
const wipe = ref(50);

const imageName = ref("");
const imageReady = ref(false);
const processing = ref(false);
const dragging = ref(false);
const copied = ref(false);
const canCopyImage = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);

const sourceWidth = ref(0);
const sourceHeight = ref(0);
/** True when the source was bigger than MAX_EDGE and had to be scaled down. */
const sourceCapped = ref(false);

const outWidth = ref(0);
const outHeight = ref(0);
const outColors = ref(0);

const fileInput = ref<HTMLInputElement>();
const originalCanvas = ref<HTMLCanvasElement>();
const ditheredCanvas = ref<HTMLCanvasElement>();

/**
 * The decoded source pixels and the cached downscale of them. Deliberately not
 * reactive: Vue must never proxy a multi megabyte typed array.
 */
let sourceImage: ImageData | null = null;
let scaled: { data: Uint8ClampedArray; width: number; height: number; scale: number } | null = null;
/** Guards against a superseded run painting over a newer one. */
let runSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let objectUrl: string | null = null;

const sizeNote = computed(() =>
  outWidth.value > 0 ? `${outWidth.value} by ${outHeight.value} pixels` : "",
);

const cappedNote = computed(() =>
  sourceCapped.value
    ? `The picture was scaled down to ${sourceWidth.value} by ${sourceHeight.value} pixels first, so the preview stays quick.`
    : "",
);

const downloadName = computed(() => {
  const base = imageName.value.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}-dithered.png`;
});

/**
 * In compare mode both canvases are stretched over one box, so the box needs a
 * shape of its own. A pixel scale of 3 leaves the dithered canvas a rounded
 * third of the original, and taking the aspect from the source keeps the two
 * layers in register instead of drifting apart by the rounding.
 */
const wrapperStyle = computed(() =>
  view.value === "compare" && sourceWidth.value > 0
    ? { aspectRatio: `${sourceWidth.value} / ${sourceHeight.value}` }
    : undefined,
);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function toPanelError(e: unknown): { message: string; fix?: string } {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : "That image could not be dithered." };
}

function releaseObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function workContext(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: true });
}

const NO_CANVAS = {
  message: "This browser would not give the page a 2D canvas.",
  fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
};

/* ------------------------------------------------------------------ *
 * the sample picture
 * ------------------------------------------------------------------ */

/**
 * A procedural sample: a gradient sky, a glow, a shaded sphere, a ridge of flat
 * shapes, and a stepped grey ramp. Gradients are what make one algorithm look
 * different from another, and the flat shapes and the ramp make banding and
 * palette clipping obvious. Drawn from arithmetic, so nothing is fetched.
 */
function drawSample(): ImageData | null {
  const width = 760;
  const height = 480;
  const ctx = workContext(width, height);
  if (!ctx) return null;

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#150f2e");
  sky.addColorStop(0.38, "#5b4bd6");
  sky.addColorStop(0.64, "#e0679a");
  sky.addColorStop(0.84, "#f4a259");
  sky.addColorStop(1, "#ffe9b8");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const glowX = width * 0.7;
  const glowY = height * 0.32;
  const glow = ctx.createRadialGradient(glowX, glowY, 4, glowX, glowY, 150);
  glow.addColorStop(0, "rgba(255, 252, 236, 1)");
  glow.addColorStop(0.35, "rgba(255, 214, 140, 0.85)");
  glow.addColorStop(1, "rgba(255, 214, 140, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(glowX - 160, glowY - 160, 320, 320);

  const ballX = width * 0.27;
  const ballY = height * 0.44;
  const ball = ctx.createRadialGradient(ballX - 34, ballY - 40, 6, ballX, ballY, 108);
  ball.addColorStop(0, "#ffffff");
  ball.addColorStop(0.45, "#5fb3d4");
  ball.addColorStop(1, "#10243a");
  ctx.fillStyle = ball;
  ctx.beginPath();
  ctx.arc(ballX, ballY, 96, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(width * 0.55, height * 0.14, 92, 92);

  ctx.fillStyle = "#d94f4f";
  ctx.beginPath();
  ctx.moveTo(width * 0.44, height * 0.3);
  ctx.lineTo(width * 0.5, height * 0.14);
  ctx.lineTo(width * 0.56, height * 0.3);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#2c2145";
  ctx.beginPath();
  ctx.moveTo(0, height * 0.78);
  ctx.lineTo(width * 0.22, height * 0.56);
  ctx.lineTo(width * 0.44, height * 0.79);
  ctx.lineTo(width * 0.68, height * 0.58);
  ctx.lineTo(width, height * 0.8);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  const steps = 19;
  const stripHeight = 44;
  for (let i = 0; i < steps; i += 1) {
    const level = Math.round((i * 255) / (steps - 1));
    ctx.fillStyle = `rgb(${level} ${level} ${level})`;
    ctx.fillRect((i * width) / steps, height - stripHeight, width / steps + 1, stripHeight);
  }

  return ctx.getImageData(0, 0, width, height);
}

/* ------------------------------------------------------------------ *
 * loading a picture
 * ------------------------------------------------------------------ */

function adoptSource(image: ImageData, name: string, capped: boolean) {
  sourceImage = image;
  scaled = null;
  sourceWidth.value = image.width;
  sourceHeight.value = image.height;
  sourceCapped.value = capped;
  imageName.value = name;
  imageReady.value = true;
}

async function loadSample() {
  // Retire any run still in flight before the source pixels change.
  runSeq += 1;
  processing.value = false;
  error.value = null;

  const image = drawSample();
  if (!image) {
    error.value = NO_CANVAS;
    return;
  }

  adoptSource(image, "sample", false);
  await nextTick();
  paintOriginal();
  await runDither();
}

async function acceptImage(file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image, so there is nothing to dither.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF instead.",
    };
    return;
  }

  runSeq += 1;
  processing.value = false;
  error.value = null;

  releaseObjectUrl();
  const url = URL.createObjectURL(file);
  objectUrl = url;

  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

  if (!loaded || !img.naturalWidth || !img.naturalHeight) {
    releaseObjectUrl();
    error.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }

  const fit = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * fit));
  const height = Math.max(1, Math.round(img.naturalHeight * fit));

  const ctx = workContext(width, height);
  if (!ctx) {
    releaseObjectUrl();
    error.value = NO_CANVAS;
    return;
  }
  ctx.drawImage(img, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  releaseObjectUrl();

  adoptSource(image, file.name || "image", fit < 1);
  await nextTick();
  paintOriginal();
  await runDither();
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  void acceptImage(e.dataTransfer?.files[0]);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  void acceptImage(picker.files?.[0]);
  picker.value = "";
}

/* ------------------------------------------------------------------ *
 * the preview
 * ------------------------------------------------------------------ */

function paintOriginal() {
  const canvas = originalCanvas.value;
  if (!canvas || !sourceImage) return;
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(sourceImage, 0, 0);
}

/**
 * The downscale, cached against the scale it was built at. A box filter over a
 * four megapixel source costs real time, and only a new picture or a new pixel
 * scale can invalidate it, so changing algorithm or palette reuses it.
 */
function downscaled(): { data: Uint8ClampedArray; width: number; height: number } | null {
  const src = sourceImage;
  if (!src) return null;
  const factor = scale.value;
  if (scaled && scaled.scale === factor) return scaled;

  if (factor === 1) {
    scaled = { data: src.data, width: src.width, height: src.height, scale: 1 };
    return scaled;
  }

  const width = Math.max(1, Math.floor(src.width / factor));
  const height = Math.max(1, Math.floor(src.height / factor));
  scaled = {
    data: resizeBox(src.data, src.width, src.height, width, height),
    width,
    height,
    scale: factor,
  };
  return scaled;
}

async function runDither() {
  const canvas = ditheredCanvas.value;
  if (!sourceImage || !canvas) return;

  const runId = ++runSeq;
  processing.value = true;

  // A rAF callback runs before the paint it was scheduled for, so yielding one
  // frame would start the dither with the processing state still undrawn. The
  // second frame is the one that resumes after the browser has shown it.
  await nextFrame();
  await nextFrame();
  if (runId !== runSeq) return;

  try {
    const source = downscaled();
    if (!source) return;

    const result = dither(source.data, source.width, source.height, settings.value);
    if (runId !== runSeq) return;

    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      error.value = NO_CANVAS;
      return;
    }
    const image = ctx.createImageData(source.width, source.height);
    image.data.set(result);
    ctx.putImageData(image, 0, 0);

    outWidth.value = source.width;
    outHeight.value = source.height;
    outColors.value = uniqueColors(result);
    error.value = null;
  } catch (e) {
    if (runId !== runSeq) return;
    error.value = toPanelError(e);
  } finally {
    if (runId === runSeq) processing.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

const canExport = computed(() => imageReady.value && outWidth.value > 0 && !processing.value);

function downloadPng() {
  const canvas = ditheredCanvas.value;
  if (!canvas || !canExport.value) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, downloadName.value);
  }, "image/png");
}

async function copyPng() {
  const canvas = ditheredCanvas.value;
  if (!canvas || !canExport.value || !canCopyImage.value) return;
  try {
    // The blob promise goes straight into ClipboardItem so the write still
    // counts as part of the click, which is what Safari requires.
    const png = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The canvas produced no PNG."));
      }, "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    error.value = {
      message: "This browser would not let the page put an image on the clipboard.",
      fix: "Use the download button instead, or try again in Chrome, Edge, or Safari.",
    };
  }
}

/* ------------------------------------------------------------------ *
 * the wipe handle
 * ------------------------------------------------------------------ */

let wipeDragging = false;

function wipeFrom(e: PointerEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return;
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  wipe.value = Math.min(100, Math.max(0, pct));
}

function onWipeDown(e: PointerEvent) {
  if (view.value !== "compare") return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  wipeDragging = true;
  wipeFrom(e, el);
}

function onWipeMove(e: PointerEvent) {
  if (!wipeDragging) return;
  wipeFrom(e, e.currentTarget as HTMLElement);
}

function onWipeUp(e: PointerEvent) {
  if (!wipeDragging) return;
  wipeDragging = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}

function onWipeKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 1;
  let next = wipe.value;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") next -= step;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") next += step;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = 100;
  else return;
  e.preventDefault();
  wipe.value = Math.min(100, Math.max(0, next));
}

/* ------------------------------------------------------------------ *
 * fragment and watchers
 * ------------------------------------------------------------------ */

/** Settings are shareable; the picture is not, so it never reaches the URL. */
function syncFragment() {
  writeFragment({
    opts: {
      algorithm: algorithmId.value,
      palette: paletteId.value,
      ...(paletteId.value === "custom" && customPalette.value
        ? { customPalette: customPalette.value }
        : {}),
      scale: String(scale.value),
      strength: String(clampNumber(opts.value.strength, 0, 1, 1)),
      serpentine: String(opts.value.serpentine !== false),
      gamma: String(opts.value.gamma !== false),
      view: view.value,
    },
  });
}

/**
 * A stale or hand edited fragment must never put an unusable value in a
 * control, so every field is validated before it is adopted. Nothing is
 * assigned unless the fragment actually carried something: replacing `opts`
 * wakes the watcher, and a pristine page load would otherwise stamp the
 * defaults into the URL before the user has touched a single control.
 */
function applyFragment() {
  const state = readFragment();
  const next = { ...opts.value };
  let found = false;

  const algorithm = state.opts["algorithm"];
  if (algorithm && ALGORITHMS.some((a) => a.id === algorithm)) {
    next.algorithm = algorithm;
    found = true;
  }

  const palette = state.opts["palette"];
  if (palette && PALETTES.some((p) => p.id === palette)) {
    next.palette = palette;
    found = true;
  }

  const custom = state.opts["customPalette"];
  if (typeof custom === "string" && custom.length <= 600) {
    next.customPalette = custom;
    found = true;
  }

  const factor = Number(state.opts["scale"]);
  if (Number.isInteger(factor) && factor >= 1 && factor <= 8) {
    next.scale = factor;
    found = true;
  }

  const strength = Number(state.opts["strength"]);
  if (Number.isFinite(strength) && strength >= 0 && strength <= 1) {
    next.strength = strength;
    found = true;
  }

  if (state.opts["serpentine"] !== undefined) {
    next.serpentine = state.opts["serpentine"] === "true";
    found = true;
  }

  if (state.opts["gamma"] !== undefined) {
    next.gamma = state.opts["gamma"] === "true";
    found = true;
  }

  if (found) opts.value = next;

  const mode = state.opts["view"];
  if (mode === "side" || mode === "stacked" || mode === "compare") view.value = mode;
}

watch(
  opts,
  () => {
    syncFragment();
    if (!imageReady.value) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runDither(), DEBOUNCE_MS);
  },
  { deep: true },
);

watch(view, syncFragment);

onMounted(() => {
  applyFragment();
  canCopyImage.value =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  clearTimeout(copyTimer);
  runSeq += 1;
  releaseObjectUrl();
  sourceImage = null;
  scaled = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Image
        </span>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="loadSample">
            <Sparkles class="size-3.5" aria-hidden="true" />
            Load sample
          </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
        </div>
      </div>
      <div class="px-3 pt-1 pb-4">
        <p class="text-sm text-muted-foreground">
          Drop a picture here, pick one with the file button, or load the sample. It is drawn and
          dithered on a canvas in this tab: your files and inputs never leave your device.
        </p>
      </div>
    </div>

    <!-- options -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="spec in visibleOptions" :key="spec.id" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="spec"
          :model-value="opts[spec.id]"
          @update:model-value="(value: unknown) => setOpt(spec.id, value)"
        />
        <div v-if="spec.id === 'palette'" class="flex min-h-4 flex-wrap items-center gap-1">
          <span
            v-for="(color, i) in swatches"
            :key="i"
            class="size-4 rounded-[4px] border"
            :style="{ backgroundColor: color }"
            aria-hidden="true"
          />
          <span
            v-if="swatches.length > 0"
            class="ml-1 font-mono text-xs tabular-nums text-muted-foreground"
          >
            {{ paletteSize }} {{ paletteSize === 1 ? "color" : "colors" }}
          </span>
          <span v-else class="text-xs text-muted-foreground">
            List two or more hex colors below.
          </span>
        </div>
      </div>
    </div>

    <!-- layout and export -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Preview layout">
        <Button
          v-for="mode in VIEW_MODES"
          :key="mode.value"
          type="button"
          size="sm"
          :variant="view === mode.value ? 'secondary' : 'ghost'"
          :aria-pressed="view === mode.value"
          @click="view = mode.value"
        >
          {{ mode.label }}
        </Button>
      </div>

      <div v-if="imageReady" class="flex flex-wrap items-center gap-2">
        <Button
          v-if="canCopyImage"
          type="button"
          variant="ghost"
          size="sm"
          :disabled="!canExport"
          @click="copyPng"
        >
          <Check v-if="copied" class="size-3.5" aria-hidden="true" />
          <Copy v-else class="size-3.5" aria-hidden="true" />
          {{ copied ? "Copied" : "Copy image" }}
        </Button>
        <Button type="button" variant="outline" :disabled="!canExport" @click="downloadPng">
          <Download class="size-3.5" aria-hidden="true" />
          Download PNG
        </Button>
      </div>
    </div>

    <div
      v-if="error"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">{{ error.message }}</span>
      <span v-if="error.fix" class="text-muted-foreground">{{ error.fix }}</span>
    </div>

    <!-- preview -->
    <div v-show="imageReady" class="flex flex-col gap-3">
      <div
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground"
      >
        <span class="font-mono">{{ imageName }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ sizeNote }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ outColors }} of {{ paletteSize }} palette colors used</span>
        <span aria-hidden="true">·</span>
        <span>{{ algorithmLabel }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ paletteLabel }}</span>
        <span v-if="processing" role="status" class="text-foreground">Processing…</span>
      </div>

      <div
        :class="
          view === 'compare'
            ? 'relative touch-none select-none'
            : view === 'stacked'
              ? 'grid grid-cols-1 gap-3'
              : 'grid grid-cols-1 gap-3 md:grid-cols-2'
        "
        :style="wrapperStyle"
        @pointerdown="onWipeDown"
        @pointermove="onWipeMove"
        @pointerup="onWipeUp"
        @pointercancel="onWipeUp"
      >
        <figure
          :class="
            view === 'compare' ? 'absolute inset-0 z-10 m-0' : 'order-1 flex flex-col gap-1.5'
          "
          :style="view === 'compare' ? { clipPath: `inset(0 ${100 - wipe}% 0 0)` } : undefined"
        >
          <figcaption
            v-show="view !== 'compare'"
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Original
          </figcaption>
          <canvas
            ref="originalCanvas"
            :class="
              view === 'compare'
                ? 'absolute inset-0 h-full w-full rounded-[10px]'
                : 'block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]'
            "
          />
        </figure>

        <figure
          :class="view === 'compare' ? 'absolute inset-0 m-0' : 'order-2 flex flex-col gap-1.5'"
        >
          <figcaption
            v-show="view !== 'compare'"
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Dithered
          </figcaption>
          <canvas
            ref="ditheredCanvas"
            style="image-rendering: pixelated"
            :class="[
              view === 'compare'
                ? 'absolute inset-0 h-full w-full rounded-[10px]'
                : 'block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]',
              processing || error ? 'opacity-60' : '',
            ]"
          />
        </figure>

        <template v-if="view === 'compare'">
          <span
            class="pointer-events-none absolute top-2 left-2 z-20 rounded-[8px] bg-card/85 px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          >
            Original
          </span>
          <span
            class="pointer-events-none absolute top-2 right-2 z-20 rounded-[8px] bg-card/85 px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          >
            Dithered
          </span>
          <div
            class="absolute inset-y-0 z-20 w-px bg-primary"
            :style="{ left: `${wipe}%` }"
            aria-hidden="true"
          />
          <div
            role="slider"
            tabindex="0"
            aria-label="Wipe position"
            :aria-valuenow="Math.round(wipe)"
            aria-valuemin="0"
            aria-valuemax="100"
            class="absolute top-1/2 z-20 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border bg-card text-muted-foreground shadow-[var(--sh-md)]"
            :style="{ left: `${wipe}%` }"
            @keydown="onWipeKey"
          >
            <MoveHorizontal class="size-4" aria-hidden="true" />
          </div>
        </template>
      </div>

      <p v-if="view === 'compare'" class="text-xs text-muted-foreground">
        Drag the handle to wipe between the original and the dithered result, or focus it and use
        the arrow keys.
      </p>
      <p v-if="cappedNote" class="text-xs text-muted-foreground">{{ cappedNote }}</p>
    </div>

    <p v-if="!imageReady" class="flex items-start gap-2 text-xs text-muted-foreground">
      <ImageOff class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        No image loaded yet. Pictures wider or taller than {{ MAX_EDGE }} pixels are scaled down
        first, and the preview is magnified with hard pixel edges so every dot the algorithm placed
        stays visible.
      </span>
    </p>

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
