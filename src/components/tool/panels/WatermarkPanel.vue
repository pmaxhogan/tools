<script setup lang="ts">
/**
 * Bespoke panel for the Image Watermark tool.
 *
 * The picture, the preview, and the export all need a canvas, so they live
 * here. Every decision about where the mark goes does not, and does not:
 * `planWatermark` in `src/tools/image-watermark/` resolves the placements,
 * `textBox` wraps and measures the caption against an injected measure
 * function, `scaleLogo` sizes an uploaded logo, and `watermarkFilename` names
 * the output. This file measures with the real canvas, draws, and saves
 * (PROJECT.md rule 27).
 *
 * Drawing happens at the picture's own resolution rather than at preview size,
 * so the exported file is full size and the mark sits exactly where the preview
 * showed it. The canvas is displayed scaled down by CSS. Pictures beyond
 * MAX_EDGE on their long side are resized first, because a 60 megapixel canvas
 * costs a quarter of a gigabyte of memory per copy and no watermark needs it.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, FileArchive, ImageOff, Sparkles, X } from "lucide-vue-next";
import { zipSync } from "fflate";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  ANCHORS,
  planWatermark,
  scaleLogo,
  textBox,
  watermarkFilename,
} from "@/tools/image-watermark/index";
import type { Anchor, MeasureText, Size } from "@/tools/image-watermark/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import ProgressBar from "../ProgressBar.vue";

const props = defineProps<{ meta: ToolMeta }>();

/** Longest edge the working canvas is allowed. See the note at the top. */
const MAX_EDGE = 4000;
/** The face the caption is drawn in. Self hosted, so nothing is fetched. */
const FONT_STACK = "Geist, ui-sans-serif, system-ui, sans-serif";

type PanelError = { message: string; fix?: string };

/* ---------------------------------------------------------------- */
/* settings                                                          */
/* ---------------------------------------------------------------- */

const kind = ref<"text" | "image">("text");
const text = ref("© Your Name");
const mode = ref<"single" | "tile">("single");
const anchor = ref<Anchor>("bottom-right");
const fontPercent = ref(6);
const scalePercent = ref(20);
const opacity = ref(60);
const rotation = ref(0);
const marginPercent = ref(4);
const tileGapPercent = ref(40);
const color = ref("#ffffff");
const outline = ref("#000000");
const format = ref("image/png");
const quality = ref(90);

/**
 * What each native color swatch shows. `color` and `outline` stay free text,
 * since the canvas fillStyle they feed and the text box beside each swatch
 * both understand any CSS color, but a native `<input type="color">` only
 * accepts six digit hex: bound to shorthand like "#fff" it logs "does not
 * conform to the required format" and drops the value instead of showing it.
 */
function swatchHex(raw: string, fallback: string): string {
  const body = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(body) || /^[0-9a-fA-F]{4}$/.test(body)) {
    return `#${body
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(body) || /^[0-9a-fA-F]{8}$/.test(body)) {
    return `#${body.slice(0, 6)}`.toLowerCase();
  }
  return fallback;
}
const colorSwatch = computed(() => swatchHex(color.value, "#ffffff"));
const outlineSwatch = computed(() => swatchHex(outline.value || "#000000", "#000000"));

const KIND_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "image", label: "Logo" },
];
const MODE_OPTIONS = [
  { value: "single", label: "One copy" },
  { value: "tile", label: "Tiled" },
];
const FORMAT_OPTIONS = [
  { value: "image/png", label: "PNG" },
  { value: "image/jpeg", label: "JPEG" },
  { value: "image/webp", label: "WebP" },
];

function specFor(id: string, fallbackLabel: string): SelectOptionSpec {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === id);
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id,
    label: fallbackLabel,
    default: "bottom-right",
    options: ANCHORS.map((a) => ({ value: a, label: a.replace("-", " "), synonyms: [a] })),
  };
}

const anchorSpec = computed(() => specFor("anchor", "Position"));

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

interface Sheet {
  file: File;
  name: string;
  size: number;
  width: number;
  height: number;
  image: HTMLImageElement;
  url: string;
}

const sheets = shallowRef<Sheet[]>([]);
const active = ref(0);
const error = ref<PanelError | null>(null);
const logo = shallowRef<{ image: HTMLImageElement; url: string; name: string } | null>(null);

const current = computed<Sheet | null>(() => sheets.value[active.value] ?? null);

const canvas = ref<HTMLCanvasElement>();

function releaseSheets(): void {
  for (const sheet of sheets.value) URL.revokeObjectURL(sheet.url);
}

function releaseLogo(): void {
  if (logo.value) URL.revokeObjectURL(logo.value.url);
  logo.value = null;
}

async function decode(file: File): Promise<{ image: HTMLImageElement; url: string } | null> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  const ok = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  if (!ok || !image.naturalWidth) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { image, url };
}

async function addFiles(files: File[]): Promise<void> {
  const images = files.filter((f) => !f.type || f.type.startsWith("image/"));
  if (images.length === 0) {
    error.value = {
      message: "None of those files are images, so there is nothing to watermark.",
      fix: "Drop PNG, JPEG, WebP, or GIF files instead.",
    };
    return;
  }
  error.value = null;
  const next: Sheet[] = [];
  for (const file of images) {
    const decoded = await decode(file);
    if (!decoded) continue;
    next.push({
      file,
      name: file.name || "image",
      size: file.size,
      width: decoded.image.naturalWidth,
      height: decoded.image.naturalHeight,
      image: decoded.image,
      url: decoded.url,
    });
  }
  if (next.length === 0) {
    error.value = {
      message: "Those files could not be decoded.",
      fix: "Try re-saving them as PNG or JPEG first.",
    };
    return;
  }
  releaseSheets();
  sheets.value = next;
  active.value = 0;
  render();
}

function onFiles(files: File[]): void {
  void addFiles(files);
}

async function onLogo(files: File[]): Promise<void> {
  const file = files[0];
  if (!file) return;
  const decoded = await decode(file);
  if (!decoded) {
    error.value = {
      message: "That logo could not be decoded.",
      fix: "Use a PNG with transparency, or a JPEG.",
    };
    return;
  }
  releaseLogo();
  logo.value = { ...decoded, name: file.name || "logo" };
  kind.value = "image";
  render();
}

function removeSheet(index: number): void {
  const sheet = sheets.value[index];
  if (sheet) URL.revokeObjectURL(sheet.url);
  sheets.value = sheets.value.filter((_, i) => i !== index);
  if (active.value >= sheets.value.length) active.value = Math.max(0, sheets.value.length - 1);
  render();
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch("/samples/sample-photo.jpg");
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await addFiles([new File([blob], "sample-photo.jpg", { type: "image/jpeg" })]);
  } catch {
    error.value = {
      message: "Could not load the sample photo.",
      fix: "Try again, or drop a picture of your own.",
    };
  }
}

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

/** The size the canvas works at: the picture, capped on its long edge. */
function workingSize(sheet: { width: number; height: number }): Size {
  const scale = Math.min(1, MAX_EDGE / Math.max(sheet.width, sheet.height));
  return {
    width: Math.max(1, Math.round(sheet.width * scale)),
    height: Math.max(1, Math.round(sheet.height * scale)),
  };
}

/**
 * Compose one watermarked picture onto `target`. Shared by the live preview and
 * by every file in a batch export, so what you download is what you saw.
 */
function compose(
  target: HTMLCanvasElement,
  sheet: { image: HTMLImageElement; width: number; height: number },
): void {
  const size = workingSize(sheet);
  target.width = size.width;
  target.height = size.height;
  const ctx = target.getContext("2d");
  if (!ctx) {
    error.value = {
      message: "This browser would not give the page a 2D canvas.",
      fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
    };
    return;
  }
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(sheet.image, 0, 0, size.width, size.height);

  const settings = {
    mode: mode.value,
    anchor: anchor.value,
    rotation: rotation.value,
    marginPercent: marginPercent.value,
    tileGapPercent: tileGapPercent.value,
  };

  if (kind.value === "image") {
    const mark = logo.value;
    if (!mark) return;
    const box = scaleLogo(
      { width: mark.image.naturalWidth, height: mark.image.naturalHeight },
      size,
      scalePercent.value,
    );
    const plan = planWatermark(size, box, settings);
    ctx.save();
    ctx.globalAlpha = opacity.value / 100;
    for (const at of plan.placements) {
      ctx.save();
      ctx.translate(at.x, at.y);
      ctx.rotate((plan.rotation * Math.PI) / 180);
      ctx.drawImage(mark.image, -box.width / 2, -box.height / 2, box.width, box.height);
      ctx.restore();
    }
    ctx.restore();
    return;
  }

  const caption = text.value.trim();
  if (!caption) return;

  // The canvas is the only honest ruler for a font, so the measure function
  // handed to the pure layer is this context's own measureText.
  const measure: MeasureText = (line, fontSize) => {
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    return ctx.measureText(line).width;
  };
  const box = textBox(caption, size, { fontPercent: fontPercent.value }, measure);
  const plan = planWatermark(size, { width: box.width, height: box.height }, settings);

  ctx.save();
  ctx.globalAlpha = opacity.value / 100;
  ctx.font = `600 ${box.fontSize}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, box.fontSize / 8);
  ctx.strokeStyle = outline.value;
  ctx.fillStyle = color.value;

  for (const at of plan.placements) {
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate((plan.rotation * Math.PI) / 180);
    box.lines.forEach((line, i) => {
      const y = (i - (box.lines.length - 1) / 2) * box.lineHeight;
      if (outline.value) ctx.strokeText(line, 0, y);
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }
  ctx.restore();
}

function render(): void {
  const sheet = current.value;
  const target = canvas.value;
  if (!sheet || !target) return;
  try {
    compose(target, sheet);
    error.value = null;
  } catch (err) {
    error.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That watermark could not be drawn." };
  }
  syncFragment();
}

watch(
  [
    kind,
    text,
    mode,
    anchor,
    fontPercent,
    scalePercent,
    opacity,
    rotation,
    marginPercent,
    tileGapPercent,
    color,
    outline,
    active,
  ],
  render,
);

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

const busy = ref(false);
const progress = ref(0);

function toBlob(target: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    target.toBlob((blob) => resolve(blob), format.value, quality.value / 100);
  });
}

async function downloadOne(): Promise<void> {
  const target = canvas.value;
  const sheet = current.value;
  if (!target || !sheet) return;
  const blob = await toBlob(target);
  if (blob) downloadBlob(blob, watermarkFilename(sheet.name, format.value));
}

async function downloadAll(): Promise<void> {
  if (sheets.value.length === 0 || busy.value) return;
  busy.value = true;
  progress.value = 0;
  try {
    const work = document.createElement("canvas");
    const entries: Record<string, Uint8Array> = {};
    const taken = new Set<string>();
    for (let i = 0; i < sheets.value.length; i++) {
      const sheet = sheets.value[i]!;
      compose(work, sheet);
      const blob = await toBlob(work);
      if (blob) {
        let name = watermarkFilename(sheet.name, format.value);
        while (taken.has(name)) name = `copy-${taken.size}-${name}`;
        taken.add(name);
        entries[name] = new Uint8Array(await blob.arrayBuffer());
      }
      progress.value = Math.round(((i + 1) / sheets.value.length) * 100);
    }
    if (taken.size === 0) return;
    // Level 0 stores the entries: PNG, JPEG and WebP are already compressed.
    const zipped = zipSync(entries, { level: 0 });
    downloadBlob(
      new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" }),
      "watermarked.zip",
    );
  } catch (err) {
    error.value = {
      message: err instanceof Error ? err.message : "The batch export failed.",
      fix: "Try fewer files at a time, or a smaller export format.",
    };
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* fragment                                                          */
/* ---------------------------------------------------------------- */

function syncFragment(): void {
  writeFragment({
    opts: {
      kind: kind.value,
      text: text.value,
      mode: mode.value,
      anchor: anchor.value,
      fontPercent: String(fontPercent.value),
      scalePercent: String(scalePercent.value),
      opacity: String(opacity.value),
      rotation: String(rotation.value),
      marginPercent: String(marginPercent.value),
      tileGapPercent: String(tileGapPercent.value),
      color: color.value,
      outline: outline.value,
      format: format.value,
      quality: String(quality.value),
    },
  });
}

function readNumberOpt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

onMounted(() => {
  const { opts } = readFragment();
  if (opts["kind"] === "image") kind.value = "image";
  if (opts["text"] !== undefined) text.value = opts["text"];
  if (opts["mode"] === "tile") mode.value = "tile";
  if (opts["anchor"] && ANCHORS.includes(opts["anchor"] as Anchor)) {
    anchor.value = opts["anchor"] as Anchor;
  }
  fontPercent.value = readNumberOpt(opts["fontPercent"], fontPercent.value);
  scalePercent.value = readNumberOpt(opts["scalePercent"], scalePercent.value);
  opacity.value = readNumberOpt(opts["opacity"], opacity.value);
  rotation.value = readNumberOpt(opts["rotation"], rotation.value);
  marginPercent.value = readNumberOpt(opts["marginPercent"], marginPercent.value);
  tileGapPercent.value = readNumberOpt(opts["tileGapPercent"], tileGapPercent.value);
  if (opts["color"]) color.value = opts["color"];
  if (opts["outline"] !== undefined) outline.value = opts["outline"];
  if (opts["format"]) format.value = opts["format"];
  quality.value = readNumberOpt(opts["quality"], quality.value);
});

onUnmounted(() => {
  releaseSheets();
  releaseLogo();
});

const sizeNote = computed(() => {
  const sheet = current.value;
  if (!sheet) return "";
  const working = workingSize(sheet);
  const scaled =
    working.width !== sheet.width ? `, drawn at ${working.width} by ${working.height}` : "";
  return `${sheet.width} by ${sheet.height} pixels, ${formatBytes(sheet.size)}${scaled}`;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <FileDrop
      accept="image/*"
      multiple
      label="Pictures"
      hint="Drop one image or a whole folder. Everything is composited on a canvas in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="loadSample">
          <Sparkles class="size-3.5" aria-hidden="true" />
          Load sample
        </Button>
      </template>
    </FileDrop>

    <ul v-if="sheets.length > 1" class="flex flex-wrap gap-2">
      <li v-for="(sheet, i) in sheets" :key="`${sheet.name}-${i}`" class="min-w-0">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          :class="i === active ? 'bg-secondary' : 'bg-card'"
        >
          <button
            type="button"
            class="truncate outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-pressed="i === active"
            @click="active = i"
          >
            {{ sheet.name }}
          </button>
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-label="`Remove ${sheet.name}`"
            @click="removeSheet(i)"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </span>
      </li>
    </ul>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- settings -->
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">Watermark</Label>
          <Segmented
            :model-value="kind"
            :options="KIND_OPTIONS"
            label="Watermark kind"
            size="sm"
            @update:model-value="(v: string) => (kind = v as 'text' | 'image')"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">Placement</Label>
          <Segmented
            :model-value="mode"
            :options="MODE_OPTIONS"
            label="Placement"
            size="sm"
            @update:model-value="(v: string) => (mode = v as 'single' | 'tile')"
          />
        </div>
        <div v-if="mode === 'single'" class="flex w-52 flex-col gap-1.5">
          <Label for="wm-anchor" class="text-xs text-muted-foreground">Position</Label>
          <SearchableSelect
            id="wm-anchor"
            :spec="anchorSpec"
            :model-value="anchor"
            class="w-full bg-card"
            @update:model-value="(v: string) => (anchor = v as Anchor)"
          />
        </div>
      </div>

      <!-- text mode -->
      <template v-if="kind === 'text'">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="flex flex-col gap-1.5 sm:col-span-2">
            <Label for="wm-text" class="text-xs text-muted-foreground">Watermark text</Label>
            <Input
              id="wm-text"
              v-model="text"
              class="h-9 bg-card"
              placeholder="© Your Name"
              spellcheck="false"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="wm-color" class="text-xs text-muted-foreground">Text color</Label>
            <div class="flex items-center gap-2">
              <input
                id="wm-color"
                type="color"
                :value="colorSwatch"
                aria-label="Pick the text color"
                class="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
                @input="color = ($event.target as HTMLInputElement).value"
              />
              <Input v-model="color" class="h-9 bg-card font-mono" spellcheck="false" />
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="wm-outline" class="text-xs text-muted-foreground">Outline color</Label>
            <div class="flex items-center gap-2">
              <input
                id="wm-outline"
                type="color"
                :value="outlineSwatch"
                aria-label="Pick the outline color"
                class="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
                @input="outline = ($event.target as HTMLInputElement).value"
              />
              <Input v-model="outline" class="h-9 bg-card font-mono" spellcheck="false" />
            </div>
          </div>
        </div>
      </template>

      <!-- logo mode -->
      <template v-else>
        <FileDrop
          accept="image/*"
          compact
          label="Logo"
          hint="A PNG with transparency works best."
          @files="onLogo"
        />
        <p v-if="logo" class="text-xs text-muted-foreground">
          Using <span class="font-mono">{{ logo.name }}</span> as the watermark.
        </p>
      </template>

      <!-- sliders -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div v-if="kind === 'text'" class="flex flex-col gap-1.5">
          <Label for="wm-font" class="text-xs text-muted-foreground">
            Text size <span class="font-mono tabular-nums">{{ fontPercent }}%</span>
          </Label>
          <Slider
            id="wm-font"
            :model-value="[fontPercent]"
            :min="1"
            :max="30"
            :step="0.5"
            @update:model-value="(v: number[] | undefined) => (fontPercent = v?.[0] ?? fontPercent)"
          />
        </div>
        <div v-else class="flex flex-col gap-1.5">
          <Label for="wm-scale" class="text-xs text-muted-foreground">
            Logo size <span class="font-mono tabular-nums">{{ scalePercent }}%</span>
          </Label>
          <Slider
            id="wm-scale"
            :model-value="[scalePercent]"
            :min="2"
            :max="100"
            :step="1"
            @update:model-value="
              (v: number[] | undefined) => (scalePercent = v?.[0] ?? scalePercent)
            "
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="wm-opacity" class="text-xs text-muted-foreground">
            Opacity <span class="font-mono tabular-nums">{{ opacity }}%</span>
          </Label>
          <Slider
            id="wm-opacity"
            :model-value="[opacity]"
            :min="5"
            :max="100"
            :step="1"
            @update:model-value="(v: number[] | undefined) => (opacity = v?.[0] ?? opacity)"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="wm-rotation" class="text-xs text-muted-foreground">
            Rotation <span class="font-mono tabular-nums">{{ rotation }} degrees</span>
          </Label>
          <Slider
            id="wm-rotation"
            :model-value="[rotation]"
            :min="-90"
            :max="90"
            :step="1"
            @update:model-value="(v: number[] | undefined) => (rotation = v?.[0] ?? rotation)"
          />
        </div>

        <div v-if="mode === 'single'" class="flex flex-col gap-1.5">
          <Label for="wm-margin" class="text-xs text-muted-foreground">
            Margin <span class="font-mono tabular-nums">{{ marginPercent }}%</span>
          </Label>
          <Slider
            id="wm-margin"
            :model-value="[marginPercent]"
            :min="0"
            :max="25"
            :step="0.5"
            @update:model-value="
              (v: number[] | undefined) => (marginPercent = v?.[0] ?? marginPercent)
            "
          />
        </div>

        <div v-else class="flex flex-col gap-1.5">
          <Label for="wm-gap" class="text-xs text-muted-foreground">
            Tile gap <span class="font-mono tabular-nums">{{ tileGapPercent }}%</span>
          </Label>
          <Slider
            id="wm-gap"
            :model-value="[tileGapPercent]"
            :min="0"
            :max="300"
            :step="5"
            @update:model-value="
              (v: number[] | undefined) => (tileGapPercent = v?.[0] ?? tileGapPercent)
            "
          />
        </div>
      </div>
    </div>

    <!-- preview -->
    <div v-show="sheets.length > 0" class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">{{ sizeNote }}</span>
      </div>
      <canvas
        ref="canvas"
        class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
        aria-label="The watermarked picture"
      />
    </div>

    <p
      v-if="sheets.length === 0 && !error"
      class="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <ImageOff class="size-3.5" aria-hidden="true" />
      No picture loaded yet. Text size and margin are percentages of the picture, so a batch of
      mixed sizes comes out looking consistent.
    </p>

    <!-- export -->
    <div v-if="sheets.length > 0" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">Export format</Label>
          <Segmented
            :model-value="format"
            :options="FORMAT_OPTIONS"
            label="Export format"
            size="sm"
            @update:model-value="
              (v: string) => {
                format = v;
                syncFragment();
              }
            "
          />
        </div>
        <div v-if="format !== 'image/png'" class="flex w-44 flex-col gap-1.5">
          <Label for="wm-quality" class="text-xs text-muted-foreground">
            Quality <span class="font-mono tabular-nums">{{ quality }}</span>
          </Label>
          <Slider
            id="wm-quality"
            :model-value="[quality]"
            :min="30"
            :max="100"
            :step="1"
            @update:model-value="(v: number[] | undefined) => (quality = v?.[0] ?? quality)"
            @value-commit="syncFragment"
          />
        </div>

        <div class="ml-auto flex items-center gap-1">
          <Button type="button" variant="outline" :disabled="busy" @click="downloadOne">
            <Download class="size-3.5" aria-hidden="true" />
            Download
          </Button>
          <Button
            v-if="sheets.length >= 2"
            type="button"
            variant="outline"
            :disabled="busy"
            @click="downloadAll"
          >
            <FileArchive class="size-3.5" aria-hidden="true" />
            All {{ sheets.length }} as zip
          </Button>
        </div>
      </div>

      <ProgressBar
        v-if="busy"
        :value="progress"
        label="Watermarking the batch"
        :detail="`${progress}%`"
      />
    </div>
  </div>
</template>
