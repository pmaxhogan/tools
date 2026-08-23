<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Copy, Download, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import {
  BACKGROUNDS,
  MAX_CANVAS,
  computeLayout,
  contrastingInk,
  gradientCss,
  renderFrameSvg,
  type Background,
  type Layout,
  type RenderOptions,
} from "@/tools/screenshot-beautifier/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the screenshot beautifier.
 *
 * The generic ToolShell can only print the layout math, so this tool gets its
 * own island. The split follows rule 27: the pure module owns the geometry
 * (computeLayout), the decoration markup (renderFrameSvg), and the two color
 * helpers the preview needs (gradientCss, contrastingInk). This component owns
 * the decoded screenshot, the canvas, the clipboard, and the download.
 *
 * How a frame is composited, and why it takes two passes instead of one:
 *
 *   renderFrameSvg leaves an `<image href="#screenshot">` placeholder marked
 *   with data-screenshot-slot where the picture belongs. Resolving it inside
 *   the SVG would mean base64ing the whole screenshot into the markup on every
 *   option change, which is megabytes of string per preview frame. Instead the
 *   placeholder is dropped from the markup, the decoration alone is rasterized,
 *   and the screenshot is drawn onto the canvas in the slot rect the layout
 *   reports, under a rounded rect clip that mirrors the SVG's own clipPath.
 *   Same geometry, same rounding, no base64. If that placeholder ever changes
 *   shape the pattern stops matching, and an unresolvable `#screenshot`
 *   reference draws nothing, so the failure mode is a missing picture rather
 *   than a corrupted one.
 *
 * The preview and the export run the same composite and differ only in the
 * scale handed to computeLayout, so what you see is what the file holds.
 *
 * Nothing touches the DOM until a screenshot arrives, so the server rendered
 * shell is inert, and the image itself never leaves this tab.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Drop shadow at 1x. Both lengths scale with the layout so 1x and 2x match. */
const SHADOW_BLUR = 32;
const SHADOW_OFFSET_Y = 18;
const SHADOW_OPACITY = 0.32;

/** JPEG carries no alpha, so a transparent canvas would come out black. */
const JPEG_MATTE = "#ffffff";
const JPEG_QUALITY = 0.92;

/** Longest edge of the on screen canvas. Exports are always built at full size. */
const PREVIEW_MAX = 1400;
const PREVIEW_DEBOUNCE = 90;

/** The screenshot placeholder renderFrameSvg leaves in the decoration markup. */
const SLOT_PATTERN = /<image\b[^>]*data-screenshot-slot="true"[^>]*\/>/;

/** Fragment keys for the custom color pickers, which are panel state, not meta options. */
const CUSTOM_KIND_KEY = "bgKind";
const CUSTOM_A_KEY = "bgA";
const CUSTOM_B_KEY = "bgB";
const CUSTOM_ANGLE = 135;

type CustomKind = "solid" | "gradient";
type ExportFormat = "png" | "jpeg";

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

const customKind = ref<CustomKind>("gradient");
const customA = ref(BACKGROUNDS.find((b) => b.id === "custom")?.stops[0] ?? "#5b6470");
const customB = ref("#2b3440");

const fileName = ref("");
const fileSize = ref(0);
const decodeFailed = ref(false);
const busy = ref(false);
const dragging = ref(false);

/** The decoded screenshot and the object URL keeping it alive, released together. */
const sourceImage = shallowRef<HTMLImageElement | null>(null);
const sourceUrl = ref<string | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);

const previewCanvas = ref<HTMLCanvasElement>();
const fileInput = ref<HTMLInputElement>();

const format = ref<ExportFormat>("png");
const renderError = ref("");
const exportNote = ref("");
const copyNote = ref("");
const clipboardSupported = ref(false);

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : fallback;
  return Math.min(max, Math.max(min, Math.round(safe)));
}

const backgroundId = computed(() => String(opts.value.background ?? "sunset"));
const frameId = computed(() => String(opts.value.frame ?? "mac"));
const aspectId = computed(() => String(opts.value.aspect ?? "auto"));
const padding = computed(() => clampInt(opts.value.padding, 64, 0, 400));
const cornerRadius = computed(() => clampInt(opts.value.cornerRadius, 12, 0, 48));
const shadowOn = computed(() => opts.value.shadow !== false);
const windowTitle = computed(() => String(opts.value.title ?? ""));
const isCustomBackground = computed(() => backgroundId.value === "custom");

/**
 * The "none" frame has a title bar height of zero, so renderFrameSvg draws no
 * chrome and the title text has nowhere to land. Say so rather than leaving a
 * filled in field with no effect on the picture.
 */
const titleIsInert = computed(() => frameId.value === "none" && windowTitle.value.trim() !== "");

/**
 * The "custom" preset is a seed, not a fixed color: picking it hands the panel's
 * own pickers to renderFrameSvg as a Background object, which is the escape
 * hatch that export documents.
 */
const resolvedBackground = computed<Background>(() => {
  if (isCustomBackground.value) {
    return {
      id: "custom",
      label: "Custom",
      kind: customKind.value,
      stops: customKind.value === "solid" ? [customA.value] : [customA.value, customB.value],
      angle: CUSTOM_ANGLE,
    };
  }
  return BACKGROUNDS.find((b) => b.id === backgroundId.value) ?? BACKGROUNDS[0]!;
});

const hasImage = computed(() => sourceImage.value !== null && sourceWidth.value > 0);

/* ---------------------------------------------------------------- */
/* layout                                                            */
/* ---------------------------------------------------------------- */

function layoutFor(scale: number): Layout | null {
  if (!hasImage.value) return null;
  return computeLayout({
    imageWidth: sourceWidth.value,
    imageHeight: sourceHeight.value,
    padding: padding.value,
    frame: frameId.value,
    cornerRadius: cornerRadius.value,
    shadow: shadowOn.value,
    aspect: aspectId.value,
    scale,
  });
}

const layout1x = computed(() => layoutFor(1));
const layout2x = computed(() => layoutFor(2));

/**
 * The preview shrinks whatever the 1x canvas would be down to PREVIEW_MAX so a
 * 4K screenshot does not rebuild a 4096px canvas on every keystroke. Every
 * length in the layout, the shadow included, scales together, so the small
 * canvas is a faithful thumbnail of the export rather than a different design.
 */
const previewLayout = computed(() => {
  const base = layout1x.value;
  if (!base) return null;
  const longest = Math.max(base.canvasWidth, base.canvasHeight);
  if (longest <= PREVIEW_MAX) return base;
  return layoutFor(PREVIEW_MAX / longest);
});

function sizeLabel(layout: Layout | null): string {
  return layout ? `${layout.canvasWidth} x ${layout.canvasHeight} px` : "";
}

const clampNote = computed(() => {
  const both = layout1x.value?.clamped === true && layout2x.value?.clamped === true;
  const one = layout1x.value?.clamped === true || layout2x.value?.clamped === true;
  if (!one) return "";
  const which = both
    ? "1x and 2x exports are"
    : layout1x.value?.clamped
      ? "1x export is"
      : "2x export is";
  return `The ${which} scaled down so the longest edge stays under ${MAX_CANVAS} px.`;
});

/* ---------------------------------------------------------------- */
/* compositing                                                       */
/* ---------------------------------------------------------------- */

/**
 * Shadow lengths scale with the layout so 1x, 2x, and the preview all carry the
 * same shadow. The second term is a floor for small frames: the filter region
 * in the logic layer reaches 60% past the caster, and a Gaussian blur reaches
 * about three times its deviation, so a blur wider than a fifth of the shorter
 * frame edge would come out cut off square instead of soft.
 */
function shadowScaleFor(layout: Layout): number {
  const shortest = Math.min(layout.frameRect.w, layout.frameRect.h);
  return Math.min(layout.appliedScale, shortest / (SHADOW_BLUR * 5));
}

function renderOptionsFor(layout: Layout): RenderOptions {
  const shadowScale = shadowScaleFor(layout);
  return {
    background: resolvedBackground.value,
    frame: frameId.value,
    title: windowTitle.value.trim() ? windowTitle.value.trim() : undefined,
    shadow: shadowOn.value
      ? {
          blur: SHADOW_BLUR * shadowScale,
          offsetY: SHADOW_OFFSET_Y * shadowScale,
          opacity: SHADOW_OPACITY,
        }
      : undefined,
    cornerRadius: layout.cornerRadius,
  };
}

/** Rasterize markup through an object URL, the only way a canvas takes SVG. */
function rasterizeSvg(svg: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** The SVG clipPath, rebuilt on the canvas so the screenshot rounds identically. */
function clipRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else if (r === 0) {
    ctx.rect(x, y, w, h);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
  ctx.clip();
}

/** The canvas twin of preserveAspectRatio="xMidYMid slice" on the SVG slot. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const sw = image.naturalWidth || image.width;
  const sh = image.naturalHeight || image.height;
  if (sw < 1 || sh < 1 || w < 1 || h < 1) return;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

async function composite(layout: Layout, matte: string | null): Promise<HTMLCanvasElement | null> {
  const source = sourceImage.value;
  if (!source) return null;

  const decoration = renderFrameSvg(layout, renderOptionsFor(layout)).replace(SLOT_PATTERN, "");
  const raster = await rasterizeSvg(decoration);
  if (!raster) return null;

  const canvas = document.createElement("canvas");
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(raster, 0, 0, canvas.width, canvas.height);

  const { x, y, w, h } = layout.frameRect;
  ctx.save();
  clipRoundedRect(ctx, x, y, w, h, layout.cornerRadius);
  drawCover(ctx, source, layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight);
  ctx.restore();

  return canvas;
}

function canvasToBlob(el: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => el.toBlob(resolve, type, quality));
}

/* ---------------------------------------------------------------- */
/* preview                                                           */
/* ---------------------------------------------------------------- */

/** Bumped per render so a slow composite can never paint over a newer one. */
let renderToken = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;

async function renderPreview(): Promise<void> {
  const layout = previewLayout.value;
  const target = previewCanvas.value;
  if (!layout || !target) return;

  const token = ++renderToken;
  const built = await composite(layout, null);
  if (token !== renderToken) return;

  if (!built) {
    renderError.value =
      "This browser could not rasterize the frame, so the preview is out of date.";
    return;
  }
  renderError.value = "";
  target.width = built.width;
  target.height = built.height;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(built, 0, 0);
}

function schedulePreview(): void {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void renderPreview(), PREVIEW_DEBOUNCE);
}

/* ---------------------------------------------------------------- */
/* the background swatch behind the empty state                      */
/* ---------------------------------------------------------------- */

const previewBackgroundCss = computed(() => gradientCss(resolvedBackground.value));
const previewTransparent = computed(() => previewBackgroundCss.value === "transparent");
const previewInk = computed(() => contrastingInk(resolvedBackground.value));

const emptyStyle = computed(() =>
  previewTransparent.value
    ? undefined
    : { background: previewBackgroundCss.value, color: previewInk.value },
);

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function releaseSource(): void {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value);
  sourceUrl.value = null;
  sourceImage.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
}

/**
 * Decode through an object URL and keep it: unlike a one shot read into
 * ImageData, this image is redrawn every time an option moves, so the URL has
 * to outlive the load and is released when the screenshot is replaced.
 */
function decode(file: File): Promise<void> {
  return new Promise((resolve) => {
    releaseSource();
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < 1 || h < 1) {
        URL.revokeObjectURL(url);
        decodeFailed.value = true;
        resolve();
        return;
      }
      sourceUrl.value = url;
      sourceImage.value = img;
      sourceWidth.value = w;
      sourceHeight.value = h;
      decodeFailed.value = false;
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      decodeFailed.value = true;
      resolve();
    };
    img.src = url;
  });
}

async function readFile(file: File): Promise<void> {
  busy.value = true;
  try {
    fileName.value = file.name;
    fileSize.value = file.size;
    exportNote.value = "";
    copyNote.value = "";
    renderError.value = "";
    await decode(file);
  } finally {
    busy.value = false;
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event): void {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  void readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearImage(): void {
  releaseSource();
  fileName.value = "";
  fileSize.value = 0;
  decodeFailed.value = false;
  renderError.value = "";
  exportNote.value = "";
  copyNote.value = "";
  if (fileInput.value) fileInput.value.value = "";
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

/**
 * A screenshot is usually on the clipboard before anything on this page has
 * been clicked, so the listener sits on the window rather than on the panel
 * root, where focus would have to be inside it already. Typing targets are
 * skipped so pasting a URL into the title field cannot swap the image out.
 */
function onPaste(e: ClipboardEvent): void {
  if (isTypingTarget(e.target)) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const pasted = item.getAsFile();
      if (pasted) {
        e.preventDefault();
        void readFile(pasted);
        return;
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function exportName(scale: number, extension: string): string {
  const base =
    (fileName.value || "screenshot")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 60) || "screenshot";
  const suffix = scale === 1 ? "" : `@${scale}x`;
  return `${base}-beautified${suffix}.${extension}`;
}

async function downloadExport(scale: number): Promise<void> {
  if (!hasImage.value || busy.value) return;
  busy.value = true;
  copyNote.value = "";
  exportNote.value = "";
  try {
    const layout = layoutFor(scale);
    if (!layout) return;
    const jpeg = format.value === "jpeg";
    const built = await composite(layout, jpeg ? JPEG_MATTE : null);
    if (!built) {
      renderError.value = "This browser could not rasterize the frame, so nothing was saved.";
      return;
    }
    renderError.value = "";
    const blob = await canvasToBlob(
      built,
      jpeg ? "image/jpeg" : "image/png",
      jpeg ? JPEG_QUALITY : undefined,
    );
    if (!blob) return;
    const name = exportName(scale, jpeg ? "jpg" : "png");
    downloadBlob(blob, name);
    exportNote.value = `Saved ${name}, ${sizeLabel(layout)}, ${formatBytes(blob.size)}.`;
  } finally {
    busy.value = false;
  }
}

/**
 * The ClipboardItem has to be constructed with a promise inside the click
 * handler itself. Awaiting the blob first breaks the user gesture and Safari
 * rejects the write. PNG is the only image type browsers reliably accept, so
 * the copy ignores the JPEG choice and keeps the alpha channel.
 */
function copyToClipboard(): void {
  if (!hasImage.value || !clipboardSupported.value) return;
  copyNote.value = "";
  exportNote.value = "";
  const blobPromise = (async () => {
    const layout = layoutFor(1);
    const built = layout ? await composite(layout, null) : null;
    const blob = built ? await canvasToBlob(built, "image/png") : null;
    if (!blob) throw new Error("The browser could not encode the image.");
    return blob;
  })();

  navigator.clipboard
    .write([new ClipboardItem({ "image/png": blobPromise })])
    .then(() => {
      copyNote.value = "Copied the composed image to the clipboard as a PNG at 1x.";
    })
    .catch(() => {
      copyNote.value = "The browser blocked the clipboard write, so download the image instead.";
    });
}

/* ---------------------------------------------------------------- */
/* fragment                                                          */
/* ---------------------------------------------------------------- */

/** Composition settings are shareable; the screenshot itself never is. */
let fragmentReady = false;

function isHex(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function saveFragment(): void {
  if (!fragmentReady) return;
  const out: Record<string, string> = {};
  for (const spec of props.meta.options ?? []) {
    out[spec.id] = String(opts.value[spec.id] ?? "");
  }
  if (isCustomBackground.value) {
    out[CUSTOM_KIND_KEY] = customKind.value;
    out[CUSTOM_A_KEY] = customA.value;
    out[CUSTOM_B_KEY] = customB.value;
  }
  writeFragment({ opts: out });
}

watch([opts, customKind, customA, customB], saveFragment, { deep: true });

watch([previewLayout, resolvedBackground, windowTitle, sourceImage], schedulePreview, {
  flush: "post",
});

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  const frag = readFragment();
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw === undefined) continue;
    if (spec.kind === "number" || spec.kind === "slider") opts.value[spec.id] = Number(raw);
    else if (spec.kind === "boolean") opts.value[spec.id] = raw === "true";
    else opts.value[spec.id] = raw;
  }
  const kind = frag.opts[CUSTOM_KIND_KEY];
  if (kind === "solid" || kind === "gradient") customKind.value = kind;
  const a = frag.opts[CUSTOM_A_KEY];
  if (isHex(a)) customA.value = a;
  const b = frag.opts[CUSTOM_B_KEY];
  if (isHex(b)) customB.value = b;

  clipboardSupported.value =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
  window.addEventListener("paste", onPaste);
  fragmentReady = true;
});

onUnmounted(() => {
  window.removeEventListener("paste", onPaste);
  clearTimeout(renderTimer);
  releaseSource();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Screenshot -->
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
        <Button variant="ghost" size="sm" @click="fileInput?.click()">Open file…</Button>
        <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
      </div>

      <div v-if="hasImage || decodeFailed" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span v-if="hasImage" class="shrink-0 text-muted-foreground tabular-nums">
            {{ sourceWidth }} x {{ sourceHeight }} px
          </span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <button
            type="button"
            aria-label="Remove screenshot"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearImage"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <template v-else>
        <p class="px-3 pt-1 pb-2 text-sm text-muted-foreground">
          Drop a screenshot here, pick a file, or paste one from the clipboard. Everything runs in
          this tab: your files and inputs never leave your device.
        </p>
        <p class="px-3 pb-4 text-xs text-muted-foreground">
          Paste a screenshot with
          <kbd class="rounded-[8px] border bg-card px-1.5 py-0.5 font-mono text-[11px]">Ctrl+V</kbd>
          (Cmd+V on a Mac).
        </p>
      </template>
    </div>

    <p
      v-if="decodeFailed"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <span class="font-medium text-destructive">
        This browser could not decode that file as an image.
      </span>
      <span class="mt-1 block text-muted-foreground">
        Try a PNG, JPEG, WebP, GIF, or BMP screenshot.
      </span>
    </p>

    <!-- Composition options, straight from the tool's meta -->
    <div v-if="meta.options?.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <div v-if="isCustomBackground" class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Custom fill</span>
        <div
          class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          role="group"
          aria-label="Custom fill"
        >
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="customKind === 'gradient'"
            :class="customKind === 'gradient' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="customKind = 'gradient'"
          >
            Gradient
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="customKind === 'solid'"
            :class="customKind === 'solid' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="customKind = 'solid'"
          >
            Solid
          </Button>
        </div>
      </div>

      <div class="flex w-28 flex-col gap-1.5">
        <Label for="sb-color-a" class="text-xs text-muted-foreground">
          {{ customKind === "solid" ? "Fill color" : "First stop" }}
        </Label>
        <input
          id="sb-color-a"
          v-model="customA"
          type="color"
          class="h-8 w-full cursor-pointer rounded-[10px] border bg-card p-1"
        />
      </div>

      <div v-if="customKind === 'gradient'" class="flex w-28 flex-col gap-1.5">
        <Label for="sb-color-b" class="text-xs text-muted-foreground">Second stop</Label>
        <input
          id="sb-color-b"
          v-model="customB"
          type="color"
          class="h-8 w-full cursor-pointer rounded-[10px] border bg-card p-1"
        />
      </div>
    </div>

    <p v-if="titleIsInert" role="status" class="text-xs text-muted-foreground">
      The window title only shows on a frame that has a title bar. Pick a macOS, Windows, or browser
      frame to see it.
    </p>

    <!-- Preview -->
    <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Preview
        </span>
        <span v-if="hasImage" class="font-mono text-xs text-muted-foreground tabular-nums">
          {{ sizeLabel(layout1x) }} at 1x, {{ sizeLabel(layout2x) }} at 2x
        </span>
      </div>

      <div v-if="hasImage" class="checker flex justify-center rounded-[8px] p-2">
        <canvas
          ref="previewCanvas"
          role="img"
          :aria-label="`Composed screenshot, ${sizeLabel(layout1x)} at 1x`"
          class="block h-auto max-w-full"
        />
      </div>

      <div
        v-else
        class="grid min-h-[200px] place-items-center rounded-[8px] p-6 text-center"
        :class="previewTransparent ? 'checker text-muted-foreground' : ''"
        :style="emptyStyle"
      >
        <div class="flex max-w-sm flex-col gap-1.5">
          <p class="text-sm font-medium">Your screenshot lands here</p>
          <p class="text-xs opacity-85">
            {{ resolvedBackground.label }} background, {{ padding }} px of padding. Drop, pick, or
            paste a screenshot to compose it.
          </p>
        </div>
      </div>

      <p v-if="clampNote" class="text-xs text-muted-foreground">{{ clampNote }}</p>
      <p v-if="renderError" role="alert" class="text-xs text-destructive">{{ renderError }}</p>
    </div>

    <!-- Export -->
    <template v-if="hasImage">
      <div class="flex flex-wrap items-center gap-2">
        <div
          class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          role="group"
          aria-label="Export format"
        >
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="format === 'png'"
            :class="format === 'png' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="format = 'png'"
          >
            PNG
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="format === 'jpeg'"
            :class="format === 'jpeg' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="format = 'jpeg'"
          >
            JPEG
          </Button>
        </div>

        <Button size="sm" :disabled="busy" @click="downloadExport(1)">
          <Download class="size-3.5" />
          Download 1x
        </Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="downloadExport(2)">
          <Download class="size-3.5" />
          Download 2x
        </Button>
        <Button
          v-if="clipboardSupported"
          variant="outline"
          size="sm"
          :disabled="busy"
          @click="copyToClipboard"
        >
          <Copy class="size-3.5" />
          Copy image
        </Button>
      </div>

      <p
        v-if="exportNote"
        role="status"
        class="font-mono text-xs text-muted-foreground tabular-nums"
      >
        {{ exportNote }}
      </p>
      <p v-if="copyNote" role="status" class="text-xs text-muted-foreground">{{ copyNote }}</p>

      <p class="text-xs text-muted-foreground">
        The export is composed on a fresh canvas at the size shown above, so no metadata from the
        original file comes along with it. JPEG is written at quality 0.92 on a white background,
        which flattens the transparent preset; export a PNG to keep the alpha channel.
      </p>
    </template>
  </div>
</template>

<style scoped>
/* Checkerboard so a transparent canvas reads as transparent, not as the surface. */
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
