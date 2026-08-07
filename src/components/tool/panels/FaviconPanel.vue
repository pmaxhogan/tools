<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import { buildIco, buildLinkTags, buildManifest } from "@/tools/favicon-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the favicon generator. The pure logic layer can only pack
 * PNG bytes it is handed, because resizing needs a canvas and a canvas is DOM.
 * This island does the rasterizing: it decodes any image the browser can read
 * (PNG, JPEG, WebP, GIF, SVG), redraws it at every size a site needs, then
 * feeds the small PNGs back through buildIco and pairs them with buildManifest
 * and buildLinkTags. Nothing is uploaded: every step runs on this page.
 */
const props = defineProps<{ meta: ToolMeta }>();

/** Sizes packed into favicon.ico. */
const ICO_SIZES = [16, 32, 48];
/** Every size rendered, in preview order. */
const ALL_SIZES = [16, 32, 48, 180, 192, 512];
/** Widest a preview image may draw inside its cell. 16, 32 and 48 stay at
 *  natural size since they never reach this; 180, 192 and 512 scale down to it. */
const PREVIEW_CAP = 80;
/** Fixed size of every preview cell, so the strip stays aligned regardless of
 *  how small or large the icon inside each cell is. */
const PREVIEW_CELL = 96;
/** Gap between saves in "Download all" so browsers do not drop files. */
const DOWNLOAD_GAP_MS = 250;

interface Raster {
  size: number;
  blob: Blob;
  bytes: Uint8Array;
  url: string;
}

interface OutFile {
  name: string;
  blob: Blob;
  note: string;
}

/** Any drawable source, whether it came from createImageBitmap or an img tag. */
type Decoded = ImageBitmap | HTMLImageElement;

function optionDefault(id: string, fallback: string): string {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec?.default === undefined ? fallback : String(spec.default);
}

/** Expand and lowercase a 3 or 6 digit hex value, or null when it is not one. */
function parseHex(raw: string): string | null {
  const body = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    return `#${body
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(body)) return `#${body.toLowerCase()}`;
  return null;
}

const appName = ref(optionDefault("appName", "My App"));

// The picker refs always hold a valid #rrggbb value so the manifest is never
// written with junk. The text refs hold exactly what was typed.
const themeColor = ref(parseHex(optionDefault("themeColor", "#5B4BD6")) ?? "#5b4bd6");
const themeText = ref(optionDefault("themeColor", "#5B4BD6"));
const bgColor = ref(parseHex(optionDefault("bgColor", "#ffffff")) ?? "#ffffff");
const bgText = ref(optionDefault("bgColor", "#ffffff"));

const cropSquare = ref(false);
/** Set once from the source dimensions, then left to the user. */
const cropTouched = ref(false);

const fileName = ref("");
const sourceUrl = ref<string | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);
const source = shallowRef<Decoded | null>(null);

const rasters = shallowRef<Raster[]>([]);
const icoBlob = shallowRef<Blob | null>(null);
const busy = ref(false);
const downloadingAll = ref(false);
const dragging = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);
const fileInput = ref<HTMLInputElement>();
const mounted = ref(false);

const hasSource = computed(() => sourceWidth.value > 0 && sourceHeight.value > 0);
const isSquare = computed(() => hasSource.value && sourceWidth.value === sourceHeight.value);
const shortSide = computed(() => Math.min(sourceWidth.value, sourceHeight.value));

/** Non-blocking notes about the source. Generation runs regardless. */
const notices = computed(() => {
  const list: string[] = [];
  if (!hasSource.value) return list;
  if (!isSquare.value) {
    list.push(
      cropSquare.value
        ? `This image is ${sourceWidth.value} by ${sourceHeight.value}, so it is not square. The center square is being cropped out of it, which trims the long edges.`
        : `This image is ${sourceWidth.value} by ${sourceHeight.value}, so it is not square. Without a crop it gets squashed into the square icon box.`,
    );
  }
  if (shortSide.value < 512) {
    list.push(
      `The short side is ${shortSide.value} pixels, so the 512 pixel icon is upscaled and will look soft. Start from a square image of at least 512 by 512 for the sharpest result.`,
    );
  }
  return list;
});

const manifestText = computed(() =>
  buildManifest({
    name: appName.value.trim() || "My App",
    shortName: appName.value.trim() || "My App",
    themeColor: themeColor.value,
    bgColor: bgColor.value,
  }),
);

const linkTags = computed(() => buildLinkTags({ themeColor: themeColor.value }));

function rasterFor(size: number): Raster | undefined {
  return rasters.value.find((r) => r.size === size);
}

function blobFor(size: number): Blob | null {
  return rasterFor(size)?.blob ?? null;
}

const manifestBlob = computed(
  () => new Blob([manifestText.value], { type: "application/manifest+json" }),
);

/** The buttons listed one per file, in the order a site needs them. */
const files = computed<OutFile[]>(() => {
  if (!icoBlob.value) return [];
  const out: OutFile[] = [{ name: "favicon.ico", blob: icoBlob.value, note: "16, 32 and 48" }];
  const pairs: [number, string, string][] = [
    [180, "apple-touch-icon.png", "iOS home screen"],
    [192, "icon-192.png", "manifest"],
    [512, "icon-512.png", "manifest"],
  ];
  for (const [size, name, note] of pairs) {
    const blob = blobFor(size);
    if (blob) out.push({ name, blob, note });
  }
  out.push({ name: "site.webmanifest", blob: manifestBlob.value, note: "web manifest" });
  return out;
});

/**
 * The two standalone PNGs the generated link tags reference. They are not
 * given their own buttons, but "Download all" includes them so the snippet
 * you paste never points at a file you were not handed.
 */
const extraFiles = computed<OutFile[]>(() => {
  const out: OutFile[] = [];
  for (const size of [16, 32]) {
    const blob = blobFor(size);
    if (blob) out.push({ name: `favicon-${size}x${size}.png`, blob, note: "link tag" });
  }
  return out;
});

const allFiles = computed<OutFile[]>(() => {
  if (files.value.length === 0) return [];
  const [ico, ...rest] = files.value;
  return [ico, ...extraFiles.value, ...rest];
});

function previewWidth(size: number): number {
  return Math.min(size, PREVIEW_CAP);
}

function decodedWidth(image: Decoded): number {
  return image instanceof HTMLImageElement ? image.naturalWidth : image.width;
}

function decodedHeight(image: Decoded): number {
  return image instanceof HTMLImageElement ? image.naturalHeight : image.height;
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ToolError(
      "no-canvas",
      "This browser refused to hand back a 2D drawing context.",
      "Turn off any canvas blocking extension, or try the same image in another browser.",
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else
        reject(
          new ToolError(
            "encode-failed",
            "The browser could not encode a PNG from the resized image.",
            "Try a smaller source image, or re-export it and drop it in again.",
          ),
        );
    }, "image/png");
  });
}

/** The square region of the source that gets drawn, centered when cropping. */
function sourceRect(image: Decoded): { sx: number; sy: number; side: number } {
  const w = decodedWidth(image);
  const h = decodedHeight(image);
  if (!cropSquare.value || w === h) {
    // Not cropping: draw the whole frame into the square, squashing if needed.
    return { sx: 0, sy: 0, side: 0 };
  }
  const side = Math.min(w, h);
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side };
}

/**
 * Draw the source into a square canvas at `size`.
 *
 * Browsers resample in one step, which smears detail badly at 16 and 32
 * pixels, so small targets are stepped down by halves first. Each halving is
 * a clean 2:1 box filter, which is what makes tiny favicons stay legible.
 */
function rasterize(image: Decoded, size: number): HTMLCanvasElement {
  const w = decodedWidth(image);
  const h = decodedHeight(image);
  const rect = sourceRect(image);
  const baseSide = rect.side > 0 ? rect.side : Math.max(w, h);

  const base = makeCanvas(Math.max(1, baseSide));
  if (rect.side > 0) {
    base.ctx.drawImage(image, rect.sx, rect.sy, rect.side, rect.side, 0, 0, baseSide, baseSide);
  } else {
    base.ctx.drawImage(image, 0, 0, w, h, 0, 0, baseSide, baseSide);
  }

  let current = base.canvas;
  if (size <= 48) {
    while (Math.floor(current.width / 2) >= size) {
      const step = makeCanvas(Math.floor(current.width / 2));
      step.ctx.drawImage(current, 0, 0, step.canvas.width, step.canvas.height);
      current = step.canvas;
    }
  }

  const out = makeCanvas(size);
  out.ctx.drawImage(current, 0, 0, size, size);
  return out.canvas;
}

function releaseRasters() {
  for (const raster of rasters.value) URL.revokeObjectURL(raster.url);
  rasters.value = [];
  icoBlob.value = null;
}

async function generate() {
  const image = source.value;
  if (!image) return;
  busy.value = true;
  try {
    const next: Raster[] = [];
    for (const size of ALL_SIZES) {
      const blob = await canvasToPng(rasterize(image, size));
      next.push({
        size,
        blob,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        url: URL.createObjectURL(blob),
      });
    }
    const ico = buildIco(
      ICO_SIZES.map((size) => ({ size, png: next.find((r) => r.size === size)!.bytes })),
    );
    releaseRasters();
    rasters.value = next;
    // A fresh ArrayBuffer keeps the Blob independent of the Uint8Array view.
    icoBlob.value = new Blob([ico.slice().buffer as ArrayBuffer], { type: "image/x-icon" });
    error.value = null;
  } catch (e) {
    releaseRasters();
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

/**
 * createImageBitmap handles raster formats everywhere, but Firefox still
 * refuses SVG blobs, so an img element decode is the fallback path.
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

function releaseSource() {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value);
  sourceUrl.value = null;
  const current = source.value;
  if (current && !(current instanceof HTMLImageElement)) current.close();
  source.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
  fileName.value = "";
}

async function loadFile(file: File) {
  releaseRasters();
  releaseSource();
  error.value = null;

  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `"${file.name}" is a ${file.type} file, not an image.`,
      fix: "Pick a PNG, JPEG, WebP, GIF or SVG file and drop it in again.",
    };
    return;
  }

  const url = URL.createObjectURL(file);
  sourceUrl.value = url;
  fileName.value = file.name;
  busy.value = true;
  try {
    const image = await decodeImage(file, url);
    const w = decodedWidth(image);
    const h = decodedHeight(image);
    if (!w || !h) {
      throw new ToolError(
        "no-dimensions",
        "That image decoded with no pixel dimensions.",
        "SVG files need a width and height (or a viewBox) on the root svg element. Add one and try again.",
      );
    }
    source.value = image;
    sourceWidth.value = w;
    sourceHeight.value = h;
    // Cropping is offered on by default only when the source is not square,
    // and only until the user has made the call themselves.
    if (!cropTouched.value) cropSquare.value = w !== h;
  } catch (e) {
    releaseSource();
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : {
            message: "The browser could not decode that image.",
            fix: "Re-export it as PNG, JPEG or WebP, then drop it in again.",
          };
    busy.value = false;
    return;
  }
  busy.value = false;
  await generate();
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  loadFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function reset() {
  releaseRasters();
  releaseSource();
  error.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

function onCropChange(value: boolean) {
  cropTouched.value = true;
  cropSquare.value = value;
  if (source.value) generate();
}

function onThemePicker(value: string) {
  themeColor.value = value;
  themeText.value = value;
}

function onThemeText(value: string) {
  themeText.value = value;
  const hex = parseHex(value);
  if (hex) themeColor.value = hex;
}

function onBgPicker(value: string) {
  bgColor.value = value;
  bgText.value = value;
}

function onBgText(value: string) {
  bgText.value = value;
  const hex = parseHex(value);
  if (hex) bgColor.value = hex;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadAll() {
  if (downloadingAll.value) return;
  downloadingAll.value = true;
  try {
    const queue = allFiles.value;
    for (let i = 0; i < queue.length; i += 1) {
      triggerDownload(queue[i]!.blob, queue[i]!.name);
      if (i < queue.length - 1) await wait(DOWNLOAD_GAP_MS);
    }
  } finally {
    downloadingAll.value = false;
  }
}

// Options are preferences, not content, so they are the only thing that
// round-trips through the URL. The image itself never leaves this page.
watch([appName, themeColor, bgColor, cropSquare], () => {
  if (!mounted.value) return;
  writeFragment({
    opts: {
      appName: appName.value,
      themeColor: themeColor.value,
      bgColor: bgColor.value,
      crop: String(cropSquare.value),
    },
  });
});

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.appName !== undefined) appName.value = frag.opts.appName;
  if (frag.opts.themeColor) {
    const hex = parseHex(frag.opts.themeColor);
    if (hex) {
      themeColor.value = hex;
      themeText.value = hex;
    }
  }
  if (frag.opts.bgColor) {
    const hex = parseHex(frag.opts.bgColor);
    if (hex) {
      bgColor.value = hex;
      bgText.value = hex;
    }
  }
  if (frag.opts.crop !== undefined) {
    cropSquare.value = frag.opts.crop === "true";
    cropTouched.value = true;
  }
  mounted.value = true;
});

onUnmounted(() => {
  releaseRasters();
  releaseSource();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Source image</span
        >
        <div class="flex items-center gap-1">
          <Button v-if="hasSource" variant="ghost" size="sm" @click="reset"> Clear </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open image </Button>
          <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
        </div>
      </div>

      <div v-if="!hasSource" class="px-3 pt-2 pb-6 text-center">
        <p class="text-sm text-muted-foreground">
          Drop a square image here, or pick one. PNG, JPEG, WebP, GIF and SVG all work, and your
          files and inputs never leave your device.
        </p>
      </div>

      <div v-else class="flex flex-wrap items-center gap-4 px-3 pt-3 pb-4">
        <div
          class="grid size-20 shrink-0 place-items-center rounded-[6px] bg-background p-1.5 shadow-[var(--sh-inset)]"
        >
          <img
            :src="sourceUrl ?? ''"
            alt="Source image preview"
            class="max-h-full max-w-full object-contain"
          />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">
            {{ fileName }}
          </p>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ sourceWidth }} x {{ sourceHeight }} pixels
          </p>
        </div>
      </div>
    </div>

    <div
      v-if="notices.length"
      class="flex flex-col gap-1.5 rounded-[10px] border border-border bg-secondary px-3 py-2.5 text-sm shadow-[var(--sh-inset)]"
    >
      <p v-for="notice in notices" :key="notice" class="text-muted-foreground">
        {{ notice }}
      </p>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="favicon-app-name" class="text-xs text-muted-foreground">App name</Label>
        <Input id="favicon-app-name" v-model="appName" placeholder="My App" class="h-9" />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="favicon-theme-color" class="text-xs text-muted-foreground">Theme color</Label>
        <div
          class="flex h-9 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
        >
          <input
            id="favicon-theme-color"
            type="color"
            aria-label="Theme color picker"
            class="size-6 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
            :value="themeColor"
            @input="onThemePicker(($event.target as HTMLInputElement).value)"
          />
          <input
            type="text"
            aria-label="Theme color hex value"
            spellcheck="false"
            placeholder="#5B4BD6"
            class="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
            :value="themeText"
            @input="onThemeText(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="favicon-bg-color" class="text-xs text-muted-foreground">Background color</Label>
        <div
          class="flex h-9 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
        >
          <input
            id="favicon-bg-color"
            type="color"
            aria-label="Background color picker"
            class="size-6 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
            :value="bgColor"
            @input="onBgPicker(($event.target as HTMLInputElement).value)"
          />
          <input
            type="text"
            aria-label="Background color hex value"
            spellcheck="false"
            placeholder="#ffffff"
            class="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
            :value="bgText"
            @input="onBgText(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="favicon-crop" class="text-xs text-muted-foreground"
          >Center crop to square</Label
        >
        <div class="flex h-9 items-center">
          <Switch
            id="favicon-crop"
            :model-value="cropSquare"
            @update:model-value="onCropChange(Boolean($event))"
          />
        </div>
      </div>
    </div>

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

    <p v-if="busy" class="text-sm text-muted-foreground" aria-live="polite">
      Rendering the icon sizes.
    </p>

    <template v-if="rasters.length && !error">
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Preview</span
        >
        <div class="flex flex-wrap gap-3">
          <div
            v-for="raster in rasters"
            :key="raster.size"
            class="flex flex-col items-center gap-1.5"
            :style="{ width: `${PREVIEW_CELL}px` }"
          >
            <div
              class="grid shrink-0 place-items-center rounded-[6px] bg-background shadow-[var(--sh-inset)]"
              :style="{ width: `${PREVIEW_CELL}px`, height: `${PREVIEW_CELL}px` }"
            >
              <img
                :src="raster.url"
                :alt="`Icon rendered at ${raster.size} pixels`"
                :style="{
                  width: `${previewWidth(raster.size)}px`,
                  height: `${previewWidth(raster.size)}px`,
                }"
              />
            </div>
            <span class="font-mono text-[11px] text-muted-foreground tabular-nums">
              {{ raster.size }} px
            </span>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Files</span
        >
        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-for="file in files"
            :key="file.name"
            variant="outline"
            size="sm"
            @click="triggerDownload(file.blob, file.name)"
          >
            {{ file.name }}
          </Button>
          <Button size="sm" :disabled="downloadingAll" @click="downloadAll">
            {{ downloadingAll ? "Saving files" : "Download all" }}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Download all saves every file one by one, including the 16 and 32 pixel PNGs the link tags
          point at. Your browser may ask once for permission to save multiple files.
        </p>
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Link tags</span
          >
          <CopyButton :text="linkTags" label="Copy" />
        </div>
        <pre class="max-h-72 overflow-auto px-3 pt-1 pb-3 font-mono text-xs whitespace-pre">{{
          linkTags
        }}</pre>
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >site.webmanifest</span
          >
          <CopyButton :text="manifestText" label="Copy" />
        </div>
        <pre class="max-h-72 overflow-auto px-3 pt-1 pb-3 font-mono text-xs whitespace-pre">{{
          manifestText
        }}</pre>
      </div>

      <p class="text-xs text-muted-foreground">
        Save every file at the root of your site, then paste the link tags into the head of your
        pages.
      </p>
    </template>
  </div>
</template>
