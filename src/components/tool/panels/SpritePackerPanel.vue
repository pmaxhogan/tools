<script setup lang="ts">
/**
 * Bespoke panel for the Sprite Sheet Packer.
 *
 * The generic ToolShell hands a tool exactly one input, and packing an atlas
 * needs a whole folder of images at once, so this tool gets its own island.
 * Rule 27 still holds: nothing here knows how to solve a bin packing problem.
 * `packRects`, `trimTransparent`, `occupiedBox`, and the metadata exporters in
 * src/tools/sprite-sheet-packer/index.ts own all of that. The panel owns only
 * the parts that need a browser: decoding the dropped files, measuring their
 * opaque bounds, compositing the atlas on a canvas, and saving the results.
 *
 * Nothing touches window, document, or a File until a handler or onMounted
 * runs, so the component renders inert on the server.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, FileArchive, X } from "lucide-vue-next";
import { zipSync, type Zippable } from "fflate";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  occupiedBox,
  packRects,
  toCsv,
  toCss,
  toJsonArray,
  toJsonHash,
  toXml,
  trimTransparent,
  type Box,
  type ExportFormat,
  type ExportOpts,
  type FrameTrim,
  type PackAlgorithm,
  type PackItem,
  type PackResult,
  type TrimBounds,
} from "@/tools/sprite-sheet-packer/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob, downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/**
 * One name for the atlas image, shared by the PNG download, the zip entry, and
 * the `imageName` every exporter writes into its metadata. If these ever drift
 * the metadata points at a file that is not in the zip.
 */
const IMAGE_NAME = "spritesheet.png";
const ZIP_NAME = "sprite-sheet.zip";

/**
 * A drop of a few thousand files would decode the tab into the ground before
 * anyone saw a preview, so the pile is capped and the overflow is reported.
 */
const MAX_SPRITES = 500;

/** Backing store size the preview aims for, in pixels on the long side. */
const RENDER_TARGET = 1400;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

interface FormatChoice {
  value: ExportFormat;
  label: string;
  file: string;
  mime: string;
}

/** Values mirror the `format` option in meta.ts; the labels are shortened. */
const FORMATS: FormatChoice[] = [
  { value: "json-hash", label: "JSON hash", file: "spritesheet.json", mime: "application/json" },
  { value: "json-array", label: "JSON array", file: "spritesheet.json", mime: "application/json" },
  { value: "css", label: "CSS", file: "spritesheet.css", mime: "text/css" },
  { value: "xml", label: "XML", file: "spritesheet.xml", mime: "application/xml" },
  { value: "csv", label: "CSV", file: "spritesheet.csv", mime: "text/csv" },
];

const ALGORITHMS: string[] = ["maxrects", "guillotine", "shelf"];

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** One decoded source image, held until it is removed or the page goes away. */
interface Sprite {
  /** Stable list key, independent of the frame name. */
  key: string;
  /** Frame name written into the metadata. Unique across the pile. */
  id: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
  /** The decoded pixels, kept so the atlas can be composited at any moment. */
  canvas: HTMLCanvasElement;
  /** Object URL behind the thumbnail. */
  url: string;
  /** Opaque bounds measured once by the logic layer, reused on every repack. */
  trim: TrimBounds;
}

const sprites = shallowRef<Sprite[]>([]);
const loading = ref(false);
const notice = ref<string | null>(null);
/* FileDrop owns the file picker. The folder button keeps its own input because
   one FileDrop offers either a file picker or a folder picker, not both. */
const folderInput = ref<HTMLInputElement>();

const pack = shallowRef<PackResult | null>(null);
const atlas = shallowRef<HTMLCanvasElement | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const previewCanvas = ref<HTMLCanvasElement>();
const showOutlines = ref(true);
const hoverId = ref<string | null>(null);

const format = ref<ExportFormat>(readDefaultFormat());

/** Every meta option except the format, which gets the segmented picker below. */
const gridOptions = computed(() => (props.meta.options ?? []).filter((o) => o.id !== "format"));

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

let keySeed = 0;
let packTimer: ReturnType<typeof setTimeout> | undefined;

/* ---------------------------------------------------------------- */
/* option readers                                                    */
/* ---------------------------------------------------------------- */

function readDefaultFormat(): ExportFormat {
  const spec = props.meta.options?.find((o) => o.id === "format");
  const fallback = spec && spec.kind === "select" ? spec.default : "json-hash";
  const known = FORMATS.find((f) => f.value === fallback);
  return known ? known.value : "json-hash";
}

function numberOpt(id: string, fallback: number): number {
  const value = Number(opts.value[id]);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function boolOpt(id: string, fallback: boolean): boolean {
  const value = opts.value[id];
  return typeof value === "boolean" ? value : fallback;
}

const maxSize = computed(() => numberOpt("maxSize", 2048));
const padding = computed(() => numberOpt("padding", 2));
const trimOn = computed(() => boolOpt("trim", true));
const powerOfTwo = computed(() => boolOpt("powerOfTwo", false));
const allowRotate = computed(() => boolOpt("allowRotate", false));
const algorithm = computed<PackAlgorithm>(() => {
  const value = String(opts.value.algorithm ?? "");
  return ALGORITHMS.includes(value) ? (value as PackAlgorithm) : "maxrects";
});

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/** Two folders can both hold "walk.png", and frame names have to be unique. */
function uniqueId(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The region of the source image that gets packed and drawn.
 *
 * Logic layer gap, worked around rather than fixed: `trimTransparent` reports
 * a zero sized box for an image that is transparent everywhere, and
 * `packRects` rejects any side that is not a positive whole number. A single
 * pixel keeps that frame in the atlas and in the metadata instead of throwing
 * the whole pack away over one blank file.
 */
function boxFor(sprite: Sprite): Box {
  if (!trimOn.value) return { x: 0, y: 0, w: sprite.width, h: sprite.height };
  if (sprite.trim.empty) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: sprite.trim.x, y: sprite.trim.y, w: sprite.trim.w, h: sprite.trim.h };
}

function dimsLabel(sprite: Sprite): string {
  const box = boxFor(sprite);
  const source = `${sprite.width} by ${sprite.height}`;
  if (!trimOn.value || (box.w === sprite.width && box.h === sprite.height)) return source;
  return `${source}, trims to ${box.w} by ${box.h}`;
}

/** Reads the brand violet off the live theme so the overlay follows dark mode. */
function readBrand(el: HTMLElement): string {
  const value = getComputedStyle(el).getPropertyValue("--primary").trim();
  return value === "" ? "#8a79f5" : value;
}

/* ---------------------------------------------------------------- */
/* loading files                                                     */
/* ---------------------------------------------------------------- */

type Decoded = ImageBitmap | HTMLImageElement;

/**
 * createImageBitmap handles every raster format the packer accepts, but it is
 * the fallback path that keeps working when a browser refuses a blob it can
 * still render in an img element.
 */
async function decodeImage(file: File, url: string): Promise<Decoded> {
  try {
    return await createImageBitmap(file);
  } catch {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
}

function decodedWidth(image: Decoded): number {
  return image instanceof HTMLImageElement ? image.naturalWidth : image.width;
}

function decodedHeight(image: Decoded): number {
  return image instanceof HTMLImageElement ? image.naturalHeight : image.height;
}

async function loadSprite(file: File, id: string): Promise<Sprite | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(file, url);
    const width = decodedWidth(image);
    const height = decodedHeight(image);
    if (width < 1 || height < 1) throw new Error("empty image");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(image, 0, 0);
    if (!(image instanceof HTMLImageElement)) image.close();

    const pixels = ctx.getImageData(0, 0, width, height);
    keySeed += 1;
    return {
      key: `sprite-${keySeed}`,
      id,
      name: file.name,
      bytes: file.size,
      width,
      height,
      canvas,
      url,
      trim: trimTransparent(pixels.data, width, height),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}

async function addFiles(incoming: File[]): Promise<void> {
  const images = incoming.filter(looksLikeImage);
  if (images.length === 0) {
    if (incoming.length > 0) notice.value = "None of those files are images this tool can decode.";
    return;
  }

  loading.value = true;
  notice.value = null;
  try {
    const next = sprites.value.slice();
    const taken = new Set(next.map((s) => s.id));
    const failed: string[] = [];
    let capped = false;

    for (const file of images) {
      if (next.length >= MAX_SPRITES) {
        capped = true;
        break;
      }
      const id = uniqueId(taken, file.name);
      const sprite = await loadSprite(file, id);
      if (!sprite) {
        failed.push(file.name);
        continue;
      }
      taken.add(id);
      next.push(sprite);
    }

    sprites.value = next;
    const parts: string[] = [];
    if (capped) parts.push(`Only the first ${MAX_SPRITES} images were kept.`);
    if (failed.length > 0) {
      parts.push(
        failed.length === 1
          ? `${failed[0]} could not be decoded.`
          : `${failed.length} files could not be decoded.`,
      );
    }
    notice.value = parts.length > 0 ? parts.join(" ") : null;
  } finally {
    loading.value = false;
  }
  schedulePack();
}

function onFiles(files: File[]): void {
  void addFiles(files);
}

function onPickFiles(e: Event): void {
  const picker = e.target as HTMLInputElement;
  const picked = Array.from(picker.files ?? []);
  // Cleared so picking the same files twice in a row still fires a change.
  picker.value = "";
  void addFiles(picked);
}

function removeSprite(key: string): void {
  const going = sprites.value.find((s) => s.key === key);
  if (going) {
    URL.revokeObjectURL(going.url);
    if (hoverId.value === going.id) hoverId.value = null;
  }
  sprites.value = sprites.value.filter((s) => s.key !== key);
  schedulePack();
}

function clearAll(): void {
  for (const sprite of sprites.value) URL.revokeObjectURL(sprite.url);
  sprites.value = [];
  hoverId.value = null;
  notice.value = null;
  schedulePack();
}

/* ---------------------------------------------------------------- */
/* packing and compositing                                           */
/* ---------------------------------------------------------------- */

function buildAtlas(result: PackResult): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, result.width);
  canvas.height = Math.max(1, result.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const byId = new Map(sprites.value.map((s) => [s.id, s]));
  for (const place of result.placements) {
    const sprite = byId.get(place.id);
    if (!sprite) continue;
    const src = boxFor(sprite);
    if (src.w <= 0 || src.h <= 0) continue;
    ctx.save();
    if (place.rotated) {
      // Turned 90 degrees clockwise, matching blitInto: source pixel (sx, sy)
      // lands at atlas pixel (x + h - 1 - sy, y + sx).
      ctx.translate(place.x + place.h, place.y);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(sprite.canvas, src.x, src.y, src.w, src.h, 0, 0, place.w, place.h);
    } else {
      ctx.drawImage(sprite.canvas, src.x, src.y, src.w, src.h, place.x, place.y, place.w, place.h);
    }
    ctx.restore();
  }
  return canvas;
}

function repack(): void {
  const list = sprites.value;
  if (list.length === 0) {
    pack.value = null;
    atlas.value = null;
    error.value = null;
    hoverId.value = null;
    return;
  }

  try {
    const items: PackItem[] = list.map((sprite) => {
      const box = boxFor(sprite);
      return { id: sprite.id, w: box.w, h: box.h };
    });
    const result = packRects(items, {
      maxWidth: maxSize.value,
      maxHeight: maxSize.value,
      padding: padding.value,
      powerOfTwo: powerOfTwo.value,
      allowRotate: allowRotate.value,
      algorithm: algorithm.value,
    });
    const canvas = buildAtlas(result);
    if (!canvas) {
      throw new ToolError(
        "no-canvas",
        "This browser refused to hand back a 2D drawing context.",
        "Turn off any canvas blocking extension, or try the same images in another browser.",
      );
    }
    pack.value = result;
    atlas.value = canvas;
    error.value = null;
  } catch (e) {
    pack.value = null;
    atlas.value = null;
    error.value = toToolError(e);
  }
}

function schedulePack(): void {
  clearTimeout(packTimer);
  packTimer = setTimeout(repack, 180);
}

watch(opts, schedulePack, { deep: true });

/* ---------------------------------------------------------------- */
/* preview                                                           */
/* ---------------------------------------------------------------- */

/**
 * How many backing pixels the preview spends per atlas pixel. Small atlases
 * are drawn larger so a 64 pixel sheet is still readable, huge ones are drawn
 * smaller so the canvas stays a sane size, and the CSS then scales whatever
 * comes out down to the width of the pane.
 */
const renderScale = computed(() => {
  const result = pack.value;
  if (!result || result.width < 1 || result.height < 1) return 1;
  const raw = RENDER_TARGET / Math.max(result.width, result.height);
  return Math.min(8, Math.max(0.25, raw));
});

const hovered = computed(() => {
  const id = hoverId.value;
  const result = pack.value;
  if (!id || !result) return null;
  const place = result.placements.find((p) => p.id === id);
  if (!place) return null;
  const box = occupiedBox(place);
  return { id: place.id, rotated: place.rotated, ...box };
});

function drawPreview(): void {
  const canvas = previewCanvas.value;
  const source = atlas.value;
  const result = pack.value;
  if (!canvas || !source || !result) return;

  const scale = renderScale.value;
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  // Assigning width or height reallocates the backing store and resets the
  // context, so it happens only when the size really changed.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Everything below is drawn in atlas pixels.
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(source, 0, 0);

  const brand = readBrand(canvas);
  const hair = 1 / scale;
  if (showOutlines.value) {
    ctx.strokeStyle = brand;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = hair;
    for (const place of result.placements) {
      const box = occupiedBox(place);
      ctx.strokeRect(
        box.x + hair / 2,
        box.y + hair / 2,
        Math.max(hair, box.w - hair),
        Math.max(hair, box.h - hair),
      );
    }
    ctx.globalAlpha = 1;
  }

  const hit = hovered.value;
  if (hit) {
    ctx.fillStyle = brand;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(hit.x, hit.y, hit.w, hit.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = brand;
    ctx.lineWidth = hair * 2;
    ctx.strokeRect(
      hit.x + hair,
      hit.y + hair,
      Math.max(hair, hit.w - hair * 2),
      Math.max(hair, hit.h - hair * 2),
    );
  }
}

// The canvas only exists once a pack does, so the redraw waits for the render.
watch([pack, showOutlines, hoverId], () => {
  void nextTick(drawPreview);
});

function onPreviewMove(e: PointerEvent): void {
  const canvas = previewCanvas.value;
  const result = pack.value;
  if (!canvas || !result) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;

  const ax = ((e.clientX - rect.left) / rect.width) * result.width;
  const ay = ((e.clientY - rect.top) / rect.height) * result.height;
  let hit: string | null = null;
  for (const place of result.placements) {
    const box = occupiedBox(place);
    if (ax >= box.x && ax < box.x + box.w && ay >= box.y && ay < box.y + box.h) {
      hit = place.id;
      break;
    }
  }
  // Only a real change redraws: a mousemove over a 1400 pixel canvas is cheap
  // to receive and expensive to repaint.
  if (hit !== hoverId.value) hoverId.value = hit;
}

/* ---------------------------------------------------------------- */
/* readouts                                                          */
/* ---------------------------------------------------------------- */

const totalBytes = computed(() => sprites.value.reduce((sum, s) => sum + s.bytes, 0));

const stats = computed<{ label: string; value: string }[]>(() => {
  const result = pack.value;
  if (!result) return [];
  return [
    { label: "Atlas size", value: `${result.width} by ${result.height} px` },
    { label: "Fill efficiency", value: `${(result.efficiency * 100).toFixed(1)}%` },
    { label: "Packed", value: `${result.placements.length} of ${sprites.value.length}` },
    { label: "Padding", value: `${result.padding} px` },
  ];
});

const activeFormat = computed<FormatChoice>(
  () => FORMATS.find((f) => f.value === format.value) ?? FORMATS[0],
);

/** Trim offsets are only meaningful when trimming ran, so they go in only then. */
const frames = computed<Record<string, FrameTrim> | undefined>(() => {
  if (!trimOn.value) return undefined;
  const out: Record<string, FrameTrim> = {};
  for (const sprite of sprites.value) {
    const box = boxFor(sprite);
    out[sprite.id] = {
      sourceW: sprite.width,
      sourceH: sprite.height,
      offsetX: box.x,
      offsetY: box.y,
    };
  }
  return out;
});

const metadata = computed(() => {
  const result = pack.value;
  if (!result) return "";
  const exportOpts: ExportOpts = { imageName: IMAGE_NAME, frames: frames.value };
  switch (format.value) {
    case "json-array":
      return toJsonArray(result, exportOpts);
    case "css":
      return toCss(result, exportOpts);
    case "xml":
      return toXml(result, exportOpts);
    case "csv":
      return toCsv(result, exportOpts);
    default:
      return toJsonHash(result, exportOpts);
  }
});

/* ---------------------------------------------------------------- */
/* saving                                                            */
/* ---------------------------------------------------------------- */

const saving = ref(false);

function encodePng(source: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    source.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** Encoded on demand, so two fast repacks can never hand back a stale atlas. */
async function currentPng(): Promise<Blob | null> {
  const source = atlas.value;
  if (!source) return null;
  const blob = await encodePng(source);
  if (!blob) {
    error.value = {
      message: "The browser could not encode a PNG from the packed atlas.",
      fix: "Lower the maximum atlas side, or remove the largest sprites and pack again.",
    };
  }
  return blob;
}

async function savePng(): Promise<void> {
  saving.value = true;
  try {
    const blob = await currentPng();
    if (blob) downloadBlob(blob, IMAGE_NAME);
  } finally {
    saving.value = false;
  }
}

function saveMetadata(): void {
  const choice = activeFormat.value;
  downloadText(metadata.value, choice.file, choice.mime);
}

async function saveZip(): Promise<void> {
  saving.value = true;
  try {
    // Both halves of the zip are read before the first await. Encoding a large
    // atlas takes longer than the repack debounce, so reading the metadata
    // afterwards could describe a layout the PNG in the same zip does not have.
    const choice = activeFormat.value;
    const text = new TextEncoder().encode(metadata.value);
    const blob = await currentPng();
    if (!blob) return;
    const entries: Zippable = {
      // A PNG is already deflated, so storing it costs nothing and saves the
      // seconds of CPU that compressing it twice would burn. The metadata is
      // plain text, and that does compress.
      [IMAGE_NAME]: [new Uint8Array(await blob.arrayBuffer()), { level: 0 }],
      [choice.file]: [text, { level: 6 }],
    };
    const zipped = zipSync(entries);
    downloadBlob(
      new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" }),
      ZIP_NAME,
    );
  } finally {
    saving.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  // Set as a property rather than an attribute: webkitdirectory is not part of
  // the standard attribute surface, and the input has to exist to take it.
  if (folderInput.value) folderInput.value.webkitdirectory = true;
});

onUnmounted(() => {
  clearTimeout(packTimer);
  for (const sprite of sprites.value) URL.revokeObjectURL(sprite.url);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- input -->
    <FileDrop
      bare
      multiple
      accept="image/*"
      label="Sprites"
      hint="Drop every sprite here at once, or click to choose the files"
      @files="onFiles"
    >
      <template #default="{ open }">
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Sprites
          </span>
          <div class="flex items-center gap-1">
            <Button
              v-if="sprites.length > 0"
              variant="ghost"
              size="sm"
              :disabled="loading"
              @click="clearAll"
            >
              Clear
            </Button>
            <Button variant="ghost" size="sm" :disabled="loading" @click="folderInput?.click()">
              Choose folder…
            </Button>
            <Button variant="ghost" size="sm" :disabled="loading" @click="open">
              Choose files…
            </Button>
          </div>
          <input ref="folderInput" type="file" class="hidden" multiple @change="onPickFiles" />
        </div>

        <div class="px-3 pt-1 pb-4">
          <p v-if="sprites.length === 0" class="text-sm text-muted-foreground">
            Drop every sprite here at once, click to choose the files, or point the folder button at
            a sprite directory. PNG, JPEG, GIF, and WebP all work, and transparency is kept.
          </p>
          <template v-else>
            <p class="text-sm text-muted-foreground" aria-live="polite">
              {{ sprites.length === 1 ? "1 image" : `${sprites.length} images` }},
              {{ formatBytes(totalBytes) }} in total.
              <span v-if="loading">Decoding…</span>
            </p>
            <ul class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <li v-for="sprite in sprites" :key="sprite.key" class="min-w-0">
                <div
                  class="flex items-center gap-2 rounded-[10px] border bg-card py-1.5 pr-1 pl-1.5 shadow-[var(--sh-sm)]"
                  @mouseenter="hoverId = sprite.id"
                  @mouseleave="hoverId = null"
                >
                  <span
                    class="checker grid size-10 shrink-0 place-items-center overflow-hidden rounded-[6px]"
                  >
                    <img :src="sprite.url" :alt="sprite.name" class="max-h-10 max-w-10" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-xs font-medium" :title="sprite.id">
                      {{ sprite.id }}
                    </span>
                    <span class="truncate text-xs text-muted-foreground tabular-nums">
                      {{ dimsLabel(sprite) }}, {{ formatBytes(sprite.bytes) }}
                    </span>
                  </span>
                  <button
                    type="button"
                    class="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                    :aria-label="`Remove ${sprite.id}`"
                    :disabled="loading"
                    @click="removeSprite(sprite.key)"
                  >
                    <X class="size-3" aria-hidden="true" />
                  </button>
                </div>
              </li>
            </ul>
          </template>

          <p v-if="notice" class="mt-2 text-xs text-muted-foreground" role="status">
            {{ notice }}
          </p>
        </div>
      </template>
    </FileDrop>

    <!-- options -->
    <div v-if="gridOptions.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <OptionControl
        v-for="spec in gridOptions"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <!-- a pack that could not be solved -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- atlas -->
    <template v-if="pack">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <dl class="flex flex-wrap gap-x-6 gap-y-2">
            <div v-for="stat in stats" :key="stat.label" class="min-w-0">
              <dt class="text-xs text-muted-foreground">{{ stat.label }}</dt>
              <dd class="font-mono text-sm tabular-nums">{{ stat.value }}</dd>
            </div>
          </dl>
          <div class="flex items-center gap-2">
            <Switch id="sprite-outlines" v-model="showOutlines" />
            <Label for="sprite-outlines" class="cursor-pointer text-xs text-muted-foreground">
              Outline every frame
            </Label>
          </div>
        </div>

        <div class="checker overflow-auto rounded-[10px] p-2 shadow-[var(--sh-inset)]">
          <canvas
            ref="previewCanvas"
            class="mx-auto block h-auto max-h-[520px] w-auto max-w-full"
            :class="renderScale >= 1 ? 'pixelated' : ''"
            @pointermove="onPreviewMove"
            @pointerleave="hoverId = null"
          ></canvas>
        </div>

        <p class="min-h-5 font-mono text-xs text-muted-foreground tabular-nums" aria-live="polite">
          <template v-if="hovered">
            {{ hovered.id }} at x {{ hovered.x }}, y {{ hovered.y }}, {{ hovered.w }} by
            {{ hovered.h }}<template v-if="hovered.rotated">, rotated 90 degrees</template>
          </template>
          <template v-else>Point at a frame to read its rectangle.</template>
        </p>

        <ErrorBanner
          v-if="pack.unplaced.length > 0"
          variant="warning"
          :message="`${pack.unplaced.length} ${pack.unplaced.length === 1 ? 'sprite did not fit' : 'sprites did not fit'}`"
        >
          <p class="font-mono break-words text-muted-foreground">{{ pack.unplaced.join(", ") }}</p>
          <p class="mt-1 text-muted-foreground">
            Raise the maximum atlas side, turn on trimming, or allow 90 degree rotation.
          </p>
        </ErrorBanner>
      </div>

      <!-- export -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div
            class="inline-flex flex-wrap gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          >
            <Button
              v-for="choice in FORMATS"
              :key="choice.value"
              variant="ghost"
              size="sm"
              :aria-pressed="format === choice.value"
              :class="format === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="format = choice.value"
            >
              {{ choice.label }}
            </Button>
          </div>
          <div class="flex items-center gap-1">
            <CopyButton :text="metadata" label="Copy" />
            <Button variant="outline" size="sm" @click="saveMetadata">
              <Download class="size-3.5" aria-hidden="true" />
              {{ activeFormat.file }}
            </Button>
          </div>
        </div>

        <pre
          class="max-h-64 overflow-auto rounded-[10px] bg-secondary p-3 font-mono text-xs shadow-[var(--sh-inset)]"
          >{{ metadata }}</pre>

        <div class="flex flex-wrap items-center gap-2">
          <Button :disabled="saving" @click="savePng">
            <Download class="size-3.5" aria-hidden="true" />
            {{ saving ? "Saving…" : "Download atlas PNG" }}
          </Button>
          <Button variant="outline" :disabled="saving" @click="saveZip">
            <FileArchive class="size-3.5" aria-hidden="true" />
            Download zip
          </Button>
          <span class="text-xs text-muted-foreground">
            The zip holds {{ IMAGE_NAME }} and {{ activeFormat.file }}.
          </span>
        </div>
      </div>
    </template>

    <p class="text-xs text-muted-foreground">
      Decoding, trimming, packing, and the PNG export all run in this browser tab, so your files and
      inputs never leave your device.
    </p>
  </div>
</template>

<style scoped>
/* Checkerboard so transparent atlas space reads as transparent, not as the surface. */
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

/* Nearest neighbor on the way up keeps pixel art from turning to mush. */
.pixelated {
  image-rendering: pixelated;
}
</style>
