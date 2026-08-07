<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Trash2, Undo2, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  applyPixelateRect,
  applySolidRect,
  normalizeRect,
  suggestExportName,
  SOLID_COLORS,
  type Rect,
  type RedactMode,
} from "@/tools/image-redactor/index";

/**
 * Bespoke panel for the redaction tool. The generic ToolShell has no way to
 * express "drag rectangles over a canvas", and the whole point of this tool is
 * that the pixels really are overwritten, which needs a canvas.
 *
 * The pixel math lives in the pure logic module and is unit tested there. This
 * component owns only the decoded image, the pointer handling, and the export.
 *
 * Two invariants keep the redaction honest:
 *   1. The pristine ImageData is never mutated. Every redraw copies it and
 *      replays the region list in order, so overlapping regions compose the
 *      same way they will in the export.
 *   2. The export re-encodes from a fresh canvas built the same way, so the
 *      original compressed bytes and every metadata block are left behind.
 *
 * The region list lives in memory only. Nothing is written to the URL fragment
 * or to storage, so closing the tab discards it.
 */
defineProps<{ meta: ToolMeta }>();

interface Region {
  id: number;
  mode: RedactMode;
  color: "black" | "white";
  blockSize: number;
  /** Pixelate randomness strength, 0 to 100. Unused for solid regions. */
  randomness: number;
  /** Seed for the pixelate perturbation PRNG, captured once per region so redraws stay stable. */
  seed: number;
  rect: Rect;
}

/**
 * A fresh 32 bit seed for one pixelate region. Math.random is fine here: this
 * is the Vue panel, not the pure logic module, and the seed only needs to be
 * unpredictable, not itself reproducible. Once captured on a region it is
 * reused for every redraw so the preview and the export stay stable.
 */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileName = ref("");
const fileSize = ref(0);
const decodeFailed = ref(false);
const busy = ref(false);
const dragging = ref(false);

const canvas = ref<HTMLCanvasElement>();
const fileInput = ref<HTMLInputElement>();

/** The decoded image, never mutated. Every redraw starts from a copy of it. */
const pristine = shallowRef<ImageData | null>(null);
const imgWidth = ref(0);
const imgHeight = ref(0);

const regions = ref<Region[]>([]);
let nextId = 1;

const mode = ref<RedactMode>("solid");
const color = ref<"black" | "white">("black");
const blockSize = ref(12);
/** Pixelate randomness strength, 0 to 100. Matches meta.ts's default. */
const randomness = ref(35);
const format = ref<"png" | "jpeg">("png");

/** The rectangle currently being dragged, in image pixel space. */
const pending = ref<Rect | null>(null);
const dragStart = ref<{ x: number; y: number } | null>(null);
const drawing = ref(false);
/**
 * Seed for the region currently being dragged. Drawn fresh on pointerdown so
 * the live preview and the finalized region use the same seed, then replaced
 * before the next drag so no two regions share one.
 */
const dragSeed = ref(randomSeed());

const exportedName = ref("");
const exportedSize = ref<number | null>(null);

const hasImage = computed(() => pristine.value !== null);
const pixelateChosen = computed(
  () => mode.value === "pixelate" || regions.value.some((r) => r.mode === "pixelate"),
);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function regionLabel(region: Region): string {
  const size = `${region.rect.w} x ${region.rect.h} px`;
  return region.mode === "solid"
    ? `Solid ${region.color}, ${size}`
    : `Pixelate ${region.blockSize} px, ${region.randomness}% random, ${size}`;
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

/**
 * Decode through an object URL and read the pixels once. Everything after this
 * point works on the raw RGBA buffer, so the original file bytes are never
 * needed again and are not kept around.
 */
function decode(file: File): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx || w === 0 || h === 0) {
        decodeFailed.value = true;
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      ctx.drawImage(img, 0, 0);
      pristine.value = ctx.getImageData(0, 0, w, h);
      imgWidth.value = w;
      imgHeight.value = h;
      decodeFailed.value = false;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      pristine.value = null;
      imgWidth.value = 0;
      imgHeight.value = 0;
      decodeFailed.value = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

async function readFile(file: File) {
  busy.value = true;
  try {
    fileName.value = file.name;
    fileSize.value = file.size;
    regions.value = [];
    pending.value = null;
    exportedName.value = "";
    exportedSize.value = null;
    await decode(file);
    redraw();
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
  pristine.value = null;
  imgWidth.value = 0;
  imgHeight.value = 0;
  regions.value = [];
  pending.value = null;
  fileName.value = "";
  fileSize.value = 0;
  decodeFailed.value = false;
  exportedName.value = "";
  exportedSize.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* rendering                                                         */
/* ---------------------------------------------------------------- */

/** A copy of the pristine pixels with every region applied, in list order. */
function composite(extra?: Region | null): ImageData | null {
  const source = pristine.value;
  if (!source) return null;
  const data = new Uint8ClampedArray(source.data);
  const list = extra ? [...regions.value, extra] : regions.value;
  for (const region of list) {
    if (region.mode === "solid") {
      applySolidRect(data, source.width, source.height, region.rect, SOLID_COLORS[region.color]);
    } else {
      applyPixelateRect(data, source.width, source.height, region.rect, region.blockSize, {
        seed: region.seed,
        strength: region.randomness / 100,
      });
    }
  }
  return new ImageData(data, source.width, source.height);
}

function pendingRegion(): Region | null {
  const rect = pending.value;
  if (!rect || rect.w < 1 || rect.h < 1) return null;
  return {
    id: 0,
    mode: mode.value,
    color: color.value,
    blockSize: blockSize.value,
    randomness: randomness.value,
    seed: dragSeed.value,
    rect,
  };
}

/**
 * The canvas always shows the real redacted pixels, so what you see is what
 * the export contains. The marquee outline is stroked on top afterwards and is
 * never part of the exported canvas, which is built separately.
 */
function redraw() {
  const el = canvas.value;
  const image = pristine.value;
  if (!el || !image) return;
  // Assigning width or height clears the canvas, so only do it on a new image.
  if (el.width !== image.width) el.width = image.width;
  if (el.height !== image.height) el.height = image.height;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  const composed = composite(pendingRegion());
  if (!composed) return;
  ctx.putImageData(composed, 0, 0);

  const rect = pending.value;
  if (drawing.value && rect && rect.w > 0 && rect.h > 0) {
    ctx.save();
    ctx.lineWidth = Math.max(1, Math.round(image.width / 400));
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 4]);
    ctx.strokeStyle = "#000000";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }
}

watch(regions, redraw, { deep: true });

/* ---------------------------------------------------------------- */
/* marquee                                                           */
/* ---------------------------------------------------------------- */

/**
 * The canvas is sized in real image pixels and scaled down by CSS to fit, so
 * pointer coordinates need the ratio between the two. Reading it per event
 * keeps it correct across window resizes and zoom without a resize observer.
 */
function pointIn(e: PointerEvent, el: HTMLCanvasElement) {
  const box = el.getBoundingClientRect();
  const scaleX = box.width > 0 ? imgWidth.value / box.width : 1;
  const scaleY = box.height > 0 ? imgHeight.value / box.height : 1;
  return {
    x: (e.clientX - box.left) * scaleX,
    y: (e.clientY - box.top) * scaleY,
  };
}

function onPointerDown(e: PointerEvent) {
  const el = canvas.value;
  if (!el || !hasImage.value) return;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  const p = pointIn(e, el);
  dragStart.value = p;
  drawing.value = true;
  // Fresh seed per drag so this region's perturbation never repeats another
  // region's, while staying stable across the drag's own redraws.
  dragSeed.value = randomSeed();
  pending.value = normalizeRect(
    { x1: p.x, y1: p.y, x2: p.x, y2: p.y },
    imgWidth.value,
    imgHeight.value,
  );
  redraw();
}

function onPointerMove(e: PointerEvent) {
  const el = canvas.value;
  const start = dragStart.value;
  if (!drawing.value || !start || !el) return;
  const p = pointIn(e, el);
  pending.value = normalizeRect(
    { x1: start.x, y1: start.y, x2: p.x, y2: p.y },
    imgWidth.value,
    imgHeight.value,
  );
  redraw();
}

function onPointerUp(e: PointerEvent) {
  const el = canvas.value;
  if (!drawing.value || !el) return;
  drawing.value = false;
  dragStart.value = null;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

  const rect = pending.value;
  pending.value = null;
  // A stray click should not leave a one pixel redaction behind.
  if (!rect || rect.w < 3 || rect.h < 3) {
    redraw();
    return;
  }
  regions.value = [
    ...regions.value,
    {
      id: nextId++,
      mode: mode.value,
      color: color.value,
      blockSize: blockSize.value,
      randomness: randomness.value,
      seed: dragSeed.value,
      rect,
    },
  ];
  exportedName.value = "";
  exportedSize.value = null;
  redraw();
}

function cancelDrag() {
  if (!drawing.value && !pending.value) return;
  drawing.value = false;
  dragStart.value = null;
  pending.value = null;
  redraw();
}

function undoLast() {
  if (regions.value.length === 0) return;
  regions.value = regions.value.slice(0, -1);
  exportedName.value = "";
  exportedSize.value = null;
}

function removeRegion(id: number) {
  regions.value = regions.value.filter((r) => r.id !== id);
  exportedName.value = "";
  exportedSize.value = null;
}

function clearRegions() {
  regions.value = [];
  exportedName.value = "";
  exportedSize.value = null;
}

/* ---------------------------------------------------------------- */
/* keyboard                                                          */
/* ---------------------------------------------------------------- */

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function onKeydown(e: KeyboardEvent) {
  if (!hasImage.value) return;
  if (e.key === "Escape") {
    cancelDrag();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !isTypingTarget(e.target)) {
    if (regions.value.length === 0) return;
    e.preventDefault();
    undoLast();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function canvasToBlob(el: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => el.toBlob(resolve, type, quality));
}

async function downloadExport() {
  const composed = composite();
  if (!composed) return;
  busy.value = true;
  try {
    // A fresh canvas, so the marquee outline drawn on the preview can never
    // reach the file, and so the export is built purely from redacted pixels.
    const out = document.createElement("canvas");
    out.width = composed.width;
    out.height = composed.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    if (format.value === "jpeg") {
      // JPEG has no alpha channel, so transparent areas would turn black.
      // putImageData ignores compositing, hence the staging canvas.
      const stage = document.createElement("canvas");
      stage.width = composed.width;
      stage.height = composed.height;
      const stageCtx = stage.getContext("2d");
      if (!stageCtx) return;
      stageCtx.putImageData(composed, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(stage, 0, 0);
    } else {
      ctx.putImageData(composed, 0, 0);
    }

    const type = format.value === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(out, type, format.value === "jpeg" ? 0.9 : undefined);
    if (!blob) return;

    const name = suggestExportName(fileName.value, format.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportedName.value = name;
    exportedSize.value = blob.size;
  } finally {
    busy.value = false;
  }
}
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
          Screenshot
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
        <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
      </div>

      <div v-if="hasImage || decodeFailed" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ humanSize(fileSize) }}</span>
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
        Drop a screenshot here, then drag rectangles over anything sensitive. The pixels underneath
        are overwritten, not covered. Everything runs in this tab: your files and inputs never leave
        your device.
      </p>
    </div>

    <p
      v-if="decodeFailed"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <span class="font-medium text-destructive"
        >This browser could not decode that file as an image.</span
      >
      <span class="mt-1 block text-muted-foreground">
        Try a PNG, JPEG, WebP, GIF, or BMP screenshot.
      </span>
    </p>

    <template v-if="hasImage">
      <!-- Canvas -->
      <div class="flex flex-col items-center gap-2">
        <canvas
          ref="canvas"
          class="checker block h-auto max-h-[520px] w-auto max-w-full cursor-crosshair touch-none rounded-[10px] shadow-[var(--sh-inset)]"
          aria-label="Redaction canvas. Drag to draw a rectangle over anything sensitive."
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <p class="text-xs text-muted-foreground tabular-nums">
          {{ imgWidth }} x {{ imgHeight }} px. Drag on the image to redact. Escape cancels a drag,
          Delete removes the last region.
        </p>
      </div>

      <!-- Style -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Redaction style
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="redact-mode" class="text-xs text-muted-foreground">Style</Label>
            <Select
              :model-value="mode"
              @update:model-value="(v) => (mode = v === 'pixelate' ? 'pixelate' : 'solid')"
            >
              <SelectTrigger id="redact-mode" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="solid"> Solid fill (safest) </SelectItem>
                <SelectItem value="pixelate"> Pixelate (weaker) </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="mode === 'solid'" class="flex w-32 flex-col gap-1.5">
            <Label for="redact-color" class="text-xs text-muted-foreground">Color</Label>
            <Select
              :model-value="color"
              @update:model-value="(v) => (color = v === 'white' ? 'white' : 'black')"
            >
              <SelectTrigger id="redact-color" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="black"> Black </SelectItem>
                <SelectItem value="white"> White </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-else class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Block size: {{ blockSize }} px
            </span>
            <Slider
              aria-label="Pixelate block size"
              :model-value="[blockSize]"
              :min="4"
              :max="64"
              :step="1"
              class="py-2"
              @update:model-value="(v) => (blockSize = v?.[0] ?? blockSize)"
            />
          </div>

          <div v-if="mode === 'pixelate'" class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Randomness: {{ randomness }}%
            </span>
            <Slider
              aria-label="Pixelate randomness strength"
              :model-value="[randomness]"
              :min="0"
              :max="100"
              :step="5"
              class="py-2"
              @update:model-value="(v) => (randomness = v?.[0] ?? randomness)"
            />
          </div>
        </div>

        <p
          v-if="mode === 'pixelate' && randomness === 0"
          role="note"
          class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-destructive"
            >Randomness is off: this is a plain block average.</span
          >
          Every block is replaced with the flat average of the pixels it covers, and that average is
          a fixed function of the source image, the exact case researchers have reconstructed by
          rendering candidate words through the same block grid until the output matches. Raise the
          randomness slider above 0% or switch to solid fill for anything you truly need gone.
        </p>
        <p
          v-else-if="pixelateChosen"
          role="note"
          class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-destructive">Pixelate is still the weaker choice.</span>
          When randomness is above 0%, each block mixes seeded random noise into its average,
          generated fresh per region, so the output is no longer a fixed function of the source
          image and the classic attack of rendering candidate words through the same block grid no
          longer lands the same way. That makes reconstruction much harder, not impossible: a rough
          trace of the original brightness still survives the average. Use solid fill for anything
          you truly need gone.
        </p>
        <p v-else class="text-xs text-muted-foreground">
          Solid fill replaces every pixel under the rectangle with one flat color, so nothing of the
          original remains in the image data.
        </p>
      </div>

      <!-- Regions -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Regions ({{ regions.length }})
          </span>
          <div class="flex items-center gap-2">
            <Button variant="outline" size="sm" :disabled="regions.length === 0" @click="undoLast">
              <Undo2 class="size-3.5" />
              Undo last
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :disabled="regions.length === 0"
              @click="clearRegions"
            >
              Clear all
            </Button>
          </div>
        </div>

        <ul v-if="regions.length" class="flex flex-col divide-y divide-border/60">
          <li
            v-for="(region, index) in regions"
            :key="region.id"
            class="flex items-center justify-between gap-3 py-2"
          >
            <span class="min-w-0 truncate font-mono text-xs tabular-nums">
              {{ index + 1 }}. {{ regionLabel(region) }} at {{ region.rect.x }},
              {{ region.rect.y }}
            </span>
            <button
              type="button"
              :aria-label="`Remove region ${index + 1}`"
              class="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="removeRegion(region.id)"
            >
              <Trash2 class="size-3.5" />
            </button>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No regions yet. Drag a rectangle on the image above to add one. Regions apply in order, so
          a later one draws over an earlier one.
        </p>
      </div>

      <!-- Export -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Export
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="redact-format" class="text-xs text-muted-foreground">Format</Label>
            <Select
              :model-value="format"
              @update:model-value="(v) => (format = v === 'jpeg' ? 'jpeg' : 'png')"
            >
              <SelectTrigger id="redact-format" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png"> PNG (lossless) </SelectItem>
                <SelectItem value="jpeg"> JPEG (quality 90) </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" :disabled="busy" class="mb-0.5" @click="downloadExport">
            Download redacted image
          </Button>
        </div>

        <p v-if="exportedName" class="font-mono text-xs text-muted-foreground tabular-nums">
          Saved {{ exportedName }}, {{ humanSize(exportedSize ?? 0) }}.
        </p>

        <p class="text-xs text-muted-foreground">
          The download is re-encoded from the canvas, so it is built out of the redacted pixels
          alone. None of the original compressed data survives and no EXIF, XMP, or IPTC metadata
          comes along with it. The region list stays in memory: it is never written to the URL or to
          storage.
        </p>
      </div>
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
