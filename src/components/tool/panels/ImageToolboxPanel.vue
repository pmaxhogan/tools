<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import { X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the image toolbox. The generic ToolShell can render the
 * analysis rows, but this tool also needs a live canvas editor (resize, crop,
 * format conversion) that has no schema-driven equivalent, so it gets its own
 * island. The logic layer stays pure: it reads headers and strips metadata,
 * and every pixel operation here goes through a canvas the panel owns.
 *
 * Nothing touches the DOM until a file arrives, so the component renders inert
 * on the server.
 */
defineProps<{ meta: ToolMeta }>();

type ImageLogic = typeof import("@/tools/image-toolbox/index");

/**
 * The logic module pulls in an EXIF parser, so it is loaded on the first file
 * rather than on page load. The promise is cached so repeated drops reuse it.
 */
let logicPromise: Promise<ImageLogic> | null = null;
function loadLogic(): Promise<ImageLogic> {
  logicPromise ??= import("@/tools/image-toolbox/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileName = ref("");
const originalBytes = shallowRef<Uint8Array | null>(null);
const originalSize = ref(0);
/** Sniffed from the bytes, not from file.type, which browsers often leave blank. */
const originalMime = ref("");

/** Object URL for the file as dropped. Kept so "reset edits" can go back to it. */
const originalUrl = ref<string | null>(null);
/** Object URL currently feeding the preview: the original, or a baked crop. */
const previewUrl = ref<string | null>(null);

const sourceImg = shallowRef<HTMLImageElement | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);
const decodeFailed = ref(false);
const edited = ref(false);

const analysis = ref<Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();
const busy = ref(false);

const targetWidth = ref(0);
const targetHeight = ref(0);
const lockAspect = ref(true);

const cropMode = ref(false);
/** Crop rectangle as fractions of the source image, so it survives layout changes. */
const crop = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const cropSurface = ref<HTMLElement>();
const cropStart = ref<{ x: number; y: number } | null>(null);
const cropDragging = ref(false);

const format = ref("image/png");
const quality = ref(85);

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "img-format",
  label: "Format",
  default: "image/png",
  options: [
    {
      value: "image/png",
      label: "PNG",
      synonyms: ["lossless", "transparent", "portable network graphics"],
    },
    { value: "image/jpeg", label: "JPEG", synonyms: ["jpg", "lossy", "photo"] },
    { value: "image/webp", label: "WebP", synonyms: ["web p", "modern", "google"] },
  ],
};
const exportedSize = ref<number | null>(null);
const exportedName = ref("");

const hasFile = computed(() => originalBytes.value !== null);
const canEdit = computed(() => sourceImg.value !== null && sourceWidth.value > 0);
const analysisRows = computed(() => Object.entries(analysis.value ?? {}));
const allRowsText = computed(() => analysisRows.value.map(([k, v]) => `${k}: ${v}`).join("\n"));

const strippable = computed(
  () => originalMime.value === "image/jpeg" || originalMime.value === "image/png",
);

const cropPixels = computed(() => {
  const r = crop.value;
  if (!r) return null;
  return {
    w: Math.max(1, Math.round(r.w * sourceWidth.value)),
    h: Math.max(1, Math.round(r.h * sourceHeight.value)),
  };
});

const aspect = computed(() =>
  sourceHeight.value > 0 ? sourceWidth.value / sourceHeight.value : 1,
);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

function sniffMime(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return "";
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "image";
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function toDimension(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 20000);
}

function revoke(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function loadSource(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      sourceImg.value = img;
      sourceWidth.value = img.naturalWidth || img.width;
      sourceHeight.value = img.naturalHeight || img.height;
      targetWidth.value = sourceWidth.value;
      targetHeight.value = sourceHeight.value;
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

async function analyze(bytes: Uint8Array) {
  try {
    const { run } = await loadLogic();
    analysis.value = await run(bytes, { stripExif: false });
    error.value = null;
  } catch (e) {
    analysis.value = null;
    error.value = toToolError(e);
  }
}

async function readFile(file: File) {
  busy.value = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    revoke(previewUrl.value !== originalUrl.value ? previewUrl.value : null);
    revoke(originalUrl.value);

    originalBytes.value = bytes;
    originalSize.value = bytes.length;
    originalMime.value = sniffMime(bytes) || file.type;
    fileName.value = file.name;

    const url = URL.createObjectURL(file);
    originalUrl.value = url;
    previewUrl.value = url;

    crop.value = null;
    cropMode.value = false;
    exportedSize.value = null;
    exportedName.value = "";
    edited.value = false;

    // Preview and analysis are independent: a browser can often decode a file
    // the header parser rejects, and the reverse happens too.
    await Promise.all([loadSource(url), analyze(bytes)]);
  } finally {
    busy.value = false;
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
    picker.value = "";
  });
}

function clearFile() {
  revoke(previewUrl.value !== originalUrl.value ? previewUrl.value : null);
  revoke(originalUrl.value);
  originalUrl.value = null;
  previewUrl.value = null;
  originalBytes.value = null;
  originalSize.value = 0;
  originalMime.value = "";
  fileName.value = "";
  sourceImg.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
  decodeFailed.value = false;
  analysis.value = null;
  error.value = null;
  crop.value = null;
  cropMode.value = false;
  exportedSize.value = null;
  exportedName.value = "";
  edited.value = false;
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* resize                                                            */
/* ---------------------------------------------------------------- */

function setWidth(value: unknown) {
  targetWidth.value = toDimension(value);
  if (lockAspect.value) targetHeight.value = toDimension(targetWidth.value / aspect.value);
}

function setHeight(value: unknown) {
  targetHeight.value = toDimension(value);
  if (lockAspect.value) targetWidth.value = toDimension(targetHeight.value * aspect.value);
}

/** Presets are aspect preserving by definition, so they ignore the lock. */
function scaleBy(percent: number) {
  targetWidth.value = toDimension((sourceWidth.value * percent) / 100);
  targetHeight.value = toDimension((sourceHeight.value * percent) / 100);
}

function fitWidth(width: number) {
  targetWidth.value = toDimension(width);
  targetHeight.value = toDimension(width / aspect.value);
}

/** A width preset only makes sense when the source is at least that wide;
 *  otherwise applying it would upscale the image and add no real detail. */
function presetUpscales(width: number): boolean {
  return sourceWidth.value > 0 && sourceWidth.value < width;
}

function presetTitle(width: number): string | undefined {
  if (!presetUpscales(width)) return undefined;
  return `This image is only ${sourceWidth.value} px wide, so scaling up to ${width} px would upscale it and look soft.`;
}

/* ---------------------------------------------------------------- */
/* crop                                                              */
/* ---------------------------------------------------------------- */

function toggleCrop() {
  cropMode.value = !cropMode.value;
  if (!cropMode.value) crop.value = null;
}

function pointIn(e: PointerEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - rect.left) / rect.width),
    y: clamp01((e.clientY - rect.top) / rect.height),
  };
}

function onCropPointerDown(e: PointerEvent) {
  if (!cropMode.value || !canEdit.value) return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  const p = pointIn(e, el);
  cropStart.value = p;
  cropDragging.value = true;
  crop.value = { x: p.x, y: p.y, w: 0, h: 0 };
}

function onCropPointerMove(e: PointerEvent) {
  if (!cropDragging.value || !cropStart.value) return;
  const p = pointIn(e, e.currentTarget as HTMLElement);
  const start = cropStart.value;
  crop.value = {
    x: Math.min(start.x, p.x),
    y: Math.min(start.y, p.y),
    w: Math.abs(p.x - start.x),
    h: Math.abs(p.y - start.y),
  };
}

function onCropPointerUp(e: PointerEvent) {
  if (!cropDragging.value) return;
  cropDragging.value = false;
  cropStart.value = null;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  const size = cropPixels.value;
  // A stray click should not leave a one pixel selection behind.
  if (!size || size.w < 4 || size.h < 4) crop.value = null;
}

function cancelCrop() {
  crop.value = null;
  cropMode.value = false;
}

/* ---------------------------------------------------------------- */
/* canvas                                                            */
/* ---------------------------------------------------------------- */

function drawRegion(
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  background?: string,
): HTMLCanvasElement | null {
  const img = sourceImg.value;
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, dw, dh);
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, q));
}

async function applyCrop() {
  const r = crop.value;
  if (!r || !canEdit.value) return;
  busy.value = true;
  try {
    const sx = Math.round(r.x * sourceWidth.value);
    const sy = Math.round(r.y * sourceHeight.value);
    const sw = Math.max(1, Math.round(r.w * sourceWidth.value));
    const sh = Math.max(1, Math.round(r.h * sourceHeight.value));
    const canvas = drawRegion(sx, sy, sw, sh, sw, sh);
    if (!canvas) return;
    // PNG for the intermediate so repeated crops never stack lossy generations.
    const blob = await canvasToBlob(canvas, "image/png");
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    revoke(previewUrl.value !== originalUrl.value ? previewUrl.value : null);
    previewUrl.value = url;
    crop.value = null;
    cropMode.value = false;
    edited.value = true;
    exportedSize.value = null;
    exportedName.value = "";
    await loadSource(url);
  } finally {
    busy.value = false;
  }
}

function resetEdits() {
  if (!originalUrl.value) return;
  revoke(previewUrl.value !== originalUrl.value ? previewUrl.value : null);
  previewUrl.value = originalUrl.value;
  crop.value = null;
  cropMode.value = false;
  edited.value = false;
  exportedSize.value = null;
  exportedName.value = "";
  loadSource(originalUrl.value);
}

async function downloadExport() {
  if (!canEdit.value) return;
  busy.value = true;
  try {
    const width = toDimension(targetWidth.value);
    const height = toDimension(targetHeight.value);
    // JPEG has no alpha channel, so transparency would otherwise turn black.
    const background = format.value === "image/jpeg" ? "#ffffff" : undefined;
    const canvas = drawRegion(
      0,
      0,
      sourceWidth.value,
      sourceHeight.value,
      width,
      height,
      background,
    );
    if (!canvas) return;
    const blob = await canvasToBlob(
      canvas,
      format.value,
      format.value === "image/png" ? undefined : quality.value / 100,
    );
    if (!blob) {
      error.value = {
        message: "This browser could not encode the image in the selected format.",
        fix: "Choose PNG or JPEG, which every browser supports, and try again.",
      };
      return;
    }
    // Browsers may fall back to PNG for a format they cannot write, so the
    // extension and the size readout both come from what was actually produced.
    const ext = EXTENSIONS[blob.type] ?? "png";
    const name = `image-${width}x${height}.${ext}`;
    exportedSize.value = blob.size;
    exportedName.value = name;
    downloadBlob(blob, name);
  } finally {
    busy.value = false;
  }
}

async function downloadStripped() {
  const bytes = originalBytes.value;
  if (!bytes || !strippable.value) return;
  busy.value = true;
  try {
    const { stripExif } = await loadLogic();
    const result = stripExif(bytes);
    const ext = EXTENSIONS[originalMime.value] ?? "bin";
    // .slice() copies into a buffer that is exactly the stripped bytes, which
    // also keeps TypeScript happy about ArrayBufferLike versus ArrayBuffer.
    const blob = new Blob([result.bytes.slice().buffer as ArrayBuffer], {
      type: originalMime.value,
    });
    downloadBlob(blob, `${baseName(fileName.value)}-no-metadata.${ext}`);
    error.value = null;
  } catch (e) {
    error.value = toToolError(e);
  } finally {
    busy.value = false;
  }
}

onUnmounted(() => {
  revoke(previewUrl.value !== originalUrl.value ? previewUrl.value : null);
  revoke(originalUrl.value);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
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
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(originalSize) }}</span>
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
        Drop an image here to read what is inside it, then resize, crop, convert, or remove its
        metadata. Everything runs in this tab: your files and inputs never leave your device.
      </p>
    </div>

    <!-- Errors from the logic layer -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <!-- Analysis -->
    <div v-if="analysisRows.length" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Analysis
        </span>
        <CopyButton :text="allRowsText" label="Copy" />
      </div>
      <div class="divide-y divide-border/60">
        <div
          v-for="[key, value] in analysisRows"
          :key="key"
          class="flex items-center justify-between gap-3 px-3 py-2"
        >
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">
              {{ key }}
            </div>
            <div class="truncate font-mono text-sm">
              {{ value }}
            </div>
          </div>
          <CopyButton :text="value" />
        </div>
      </div>
    </div>

    <!-- Editor -->
    <div v-if="hasFile" class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Editor
        </span>
        <Button v-if="edited" variant="ghost" size="sm" @click="resetEdits"> Reset edits </Button>
      </div>

      <p
        v-if="decodeFailed"
        class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      >
        This browser cannot decode this file as an image, so the editor is unavailable. The analysis
        above still reads the file header directly.
      </p>

      <template v-else-if="canEdit">
        <div class="flex flex-col items-center gap-2">
          <div
            ref="cropSurface"
            class="checker relative inline-block max-w-full rounded-[10px] shadow-[var(--sh-inset)]"
            :class="cropMode ? 'cursor-crosshair touch-none' : ''"
            @pointerdown="onCropPointerDown"
            @pointermove="onCropPointerMove"
            @pointerup="onCropPointerUp"
            @pointercancel="onCropPointerUp"
          >
            <img
              :src="previewUrl ?? ''"
              alt="Preview of the loaded image"
              draggable="false"
              class="block h-auto max-h-[360px] min-h-[200px] w-auto max-w-full rounded-[10px] select-none"
              @dragstart.prevent
            />
            <template v-if="crop">
              <!-- Four shaded strips dim everything outside the crop marquee. -->
              <div
                class="pointer-events-none absolute inset-x-0 top-0 bg-black/50"
                :style="{ height: `${clamp01(crop.y) * 100}%` }"
              />
              <div
                class="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50"
                :style="{ height: `${clamp01(1 - crop.y - crop.h) * 100}%` }"
              />
              <div
                class="pointer-events-none absolute left-0 bg-black/50"
                :style="{
                  top: `${crop.y * 100}%`,
                  height: `${crop.h * 100}%`,
                  width: `${clamp01(crop.x) * 100}%`,
                }"
              />
              <div
                class="pointer-events-none absolute right-0 bg-black/50"
                :style="{
                  top: `${crop.y * 100}%`,
                  height: `${crop.h * 100}%`,
                  width: `${clamp01(1 - crop.x - crop.w) * 100}%`,
                }"
              />
              <div
                class="pointer-events-none absolute border border-primary"
                :style="{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                }"
              />
              <div
                v-if="cropPixels"
                class="pointer-events-none absolute rounded-[4px] bg-background px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground shadow-[var(--sh-sm)]"
                :style="{
                  left: `calc(${crop.x * 100}% + 4px)`,
                  top: `calc(${crop.y * 100}% + 4px)`,
                }"
              >
                {{ cropPixels.w }} x {{ cropPixels.h }} px
              </div>
            </template>
          </div>
          <p class="text-xs text-muted-foreground tabular-nums">
            Source: {{ sourceWidth }} x {{ sourceHeight }} px
          </p>
        </div>

        <!-- Resize -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Resize
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-24 flex-col gap-1.5">
              <Label for="img-width" class="text-xs text-muted-foreground">Width</Label>
              <Input
                id="img-width"
                type="number"
                min="1"
                :model-value="targetWidth"
                class="h-9 bg-card"
                @update:model-value="setWidth"
              />
            </div>
            <div class="flex w-24 flex-col gap-1.5">
              <Label for="img-height" class="text-xs text-muted-foreground">Height</Label>
              <Input
                id="img-height"
                type="number"
                min="1"
                :model-value="targetHeight"
                class="h-9 bg-card"
                @update:model-value="setHeight"
              />
            </div>
            <div class="flex items-center gap-2 pb-2.5">
              <Switch
                id="img-lock"
                :model-value="lockAspect"
                @update:model-value="(v) => (lockAspect = Boolean(v))"
              />
              <Label for="img-lock" class="text-xs text-muted-foreground">Lock aspect ratio</Label>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" @click="scaleBy(25)"> 25% </Button>
            <Button variant="outline" size="sm" @click="scaleBy(50)"> 50% </Button>
            <Button variant="outline" size="sm" @click="scaleBy(75)"> 75% </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="presetUpscales(1920)"
              :title="presetTitle(1920)"
              @click="fitWidth(1920)"
            >
              1920 wide
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="presetUpscales(1280)"
              :title="presetTitle(1280)"
              @click="fitWidth(1280)"
            >
              1280 wide
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="presetUpscales(640)"
              :title="presetTitle(640)"
              @click="fitWidth(640)"
            >
              640 wide
            </Button>
          </div>
        </div>

        <!-- Crop -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Crop
          </span>
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" :aria-pressed="cropMode" @click="toggleCrop">
              {{ cropMode ? "Crop mode on" : "Crop mode off" }}
            </Button>
            <Button v-if="cropMode" size="sm" :disabled="!crop || busy" @click="applyCrop">
              Apply crop
            </Button>
            <Button v-if="cropMode" variant="ghost" size="sm" @click="cancelCrop"> Cancel </Button>
            <span v-if="cropPixels" class="font-mono text-xs text-muted-foreground tabular-nums">
              Selection: {{ cropPixels.w }} x {{ cropPixels.h }} px
            </span>
          </div>
          <p class="text-xs text-muted-foreground">
            Turn crop mode on, then drag a rectangle across the preview. Applying the crop bakes it
            into the image and resets the resize fields to the new size.
          </p>
        </div>

        <!-- Convert and export -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Convert and export
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="img-format" class="text-xs text-muted-foreground">Format</Label>
              <SearchableSelect
                id="img-format"
                :spec="formatSpec"
                :model-value="format"
                class="w-full bg-card"
                @update:model-value="(v) => (format = String(v))"
              />
            </div>
            <div class="flex min-w-48 flex-1 flex-col gap-1.5">
              <!-- The slider's focusable element is its thumb, not the root,
                   so this is plain text plus an aria-label rather than a
                   <label for> pointing at something that cannot take focus. -->
              <span class="text-xs text-muted-foreground tabular-nums">
                Quality: {{ format === "image/png" ? "lossless" : quality }}
              </span>
              <Slider
                aria-label="Export quality"
                :model-value="[quality]"
                :min="1"
                :max="100"
                :step="1"
                :disabled="format === 'image/png'"
                class="py-2"
                @update:model-value="(v) => (quality = v?.[0] ?? quality)"
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="busy" @click="downloadExport"> Download </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="!strippable || busy"
              :title="
                strippable
                  ? 'Removes metadata segments without touching a single pixel.'
                  : 'In place metadata removal works on JPEG and PNG files only.'
              "
              @click="downloadStripped"
            >
              Download original with EXIF removed
            </Button>
          </div>

          <p
            v-if="exportedSize !== null"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ exportedName }}: {{ formatBytes(originalSize) }} before,
            {{ formatBytes(exportedSize) }} after.
          </p>

          <p class="text-xs text-muted-foreground">
            Exporting re-encodes the image through a canvas, which drops EXIF, XMP, and IPTC
            metadata automatically. The second button rewrites the file you dropped without its
            metadata segments and without re-encoding, so the pixels stay byte for byte identical.
            In place removal works on JPEG and PNG files only.
          </p>
        </div>
      </template>
    </div>
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
