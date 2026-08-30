<script setup lang="ts">
/**
 * Bespoke panel for the Meme Generator.
 *
 * The picture, the drag, the preview, and the export all need a canvas, so they
 * live here. The layout does not: `layoutMeme` in `src/tools/meme-generator/`
 * decides the canvas size, where the picture sits, how the text wraps, what
 * size it shrinks to, and where each block is centered, measuring through this
 * context's own `measureText`. This file draws what it is told and saves the
 * result (PROJECT.md rule 27).
 *
 * Dragging is deliberately stored as a percentage of the canvas rather than as
 * pixels. The same meme then looks the same whether the source was 600 pixels
 * wide or 6000, and the position survives switching pictures, which is what
 * people do when they are trying a caption on three different images.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Clipboard, Download, ImageOff, Sparkles } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  BLANK_SIZES,
  MEME_FONT_STACK,
  layoutMeme,
  memeFilename,
  swatchHex,
} from "@/tools/meme-generator/index";
import type { MeasureText, MemeLayout, Size } from "@/tools/meme-generator/index";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

const props = defineProps<{ meta: ToolMeta }>();

/** Longest edge the working canvas is allowed, to keep the drag responsive. */
const MAX_EDGE = 2400;

type PanelError = { message: string; fix?: string };

/* ---------------------------------------------------------------- */
/* settings                                                          */
/* ---------------------------------------------------------------- */

const mode = ref<"classic" | "caption">("classic");
const topText = ref("");
const bottomText = ref("");
const captionText = ref("");
const fontPercent = ref(11);
const color = ref("#ffffff");
const outline = ref("#000000");
const outlinePercent = ref(8);
const uppercase = ref(true);
const blank = ref("none");
const blankColor = ref("#111111");
const topX = ref(50);
const topY = ref(12);
const bottomX = ref(50);
const bottomY = ref(88);

const MODE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "caption", label: "Caption bar" },
];

/**
 * What each native color swatch shows. The refs above stay free text, since
 * the canvas fillStyle they feed and the paired text box both understand any
 * CSS color, but the swatch itself only understands six digit hex.
 */
const colorSwatch = computed(() => swatchHex(color.value, "#ffffff"));
const outlineSwatch = computed(() => swatchHex(outline.value || "#000000", "#000000"));
const blankColorSwatch = computed(() => swatchHex(blankColor.value, "#111111"));

const blankSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "blank");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "blank",
    label: "Blank canvas",
    default: "none",
    options: [
      { value: "none", label: "Use my picture", synonyms: ["photo"] },
      ...Object.keys(BLANK_SIZES).map((k) => ({ value: k, label: k, synonyms: [k] })),
    ],
  };
});

/* ---------------------------------------------------------------- */
/* picture                                                           */
/* ---------------------------------------------------------------- */

const fileName = ref("meme");
const error = ref<PanelError | null>(null);
const canvas = ref<HTMLCanvasElement>();

/**
 * The decoded picture. A `shallowRef` rather than a plain variable: Vue must
 * never proxy the element, but the ref itself still has to be trackable, or
 * `sourceSize` below never notices a picture arrived (see the comment there).
 */
const picture = shallowRef<HTMLImageElement | null>(null);
let pictureUrl = "";

function releasePicture(): void {
  if (pictureUrl) {
    URL.revokeObjectURL(pictureUrl);
    pictureUrl = "";
  }
}

/**
 * The canvas the layout is computed against: the picture, or a blank preset.
 *
 * The `picture.value` read has to happen unconditionally, not behind
 * `!picture.value ||`, because Vue only tracks a dependency it actually read
 * on the last run: short circuiting past it on the first evaluation (picture
 * still null) would leave this computed subscribed to nothing but `blank`,
 * so loading a picture would change `picture.value` and never invalidate it.
 */
const sourceSize = computed<Size | null>(() => {
  if (blank.value !== "none") return BLANK_SIZES[blank.value] ?? null;
  const img = picture.value;
  if (!img) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  return {
    width: Math.max(1, Math.round(img.naturalWidth * scale)),
    height: Math.max(1, Math.round(img.naturalHeight * scale)),
  };
});

async function acceptImage(file: File | undefined): Promise<void> {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF instead.",
    };
    return;
  }
  releasePicture();
  const url = URL.createObjectURL(file);
  const image = new Image();
  const ok = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  if (!ok || !image.naturalWidth) {
    URL.revokeObjectURL(url);
    picture.value = null;
    error.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }
  picture.value = image;
  pictureUrl = url;
  fileName.value = file.name || "meme";
  blank.value = "none";
  error.value = null;
}

function onFiles(files: File[]): void {
  void acceptImage(files[0]);
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch("/samples/sample-photo.jpg");
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await acceptImage(new File([blob], "sample-photo.jpg", { type: "image/jpeg" }));
    if (!topText.value && !bottomText.value) {
      topText.value = "one does not simply";
      bottomText.value = "ship on a friday";
    }
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

/** The layout the last render used, so the drag knows what it is grabbing. */
let lastLayout: MemeLayout | null = null;

function currentOpts(): Record<string, unknown> {
  return {
    mode: mode.value,
    topText: topText.value,
    bottomText: bottomText.value,
    captionText: captionText.value,
    fontPercent: fontPercent.value,
    color: color.value,
    outline: outline.value,
    outlinePercent: outlinePercent.value,
    uppercase: uppercase.value,
    topX: topX.value,
    topY: topY.value,
    bottomX: bottomX.value,
    bottomY: bottomY.value,
  };
}

function render(): void {
  const size = sourceSize.value;
  const target = canvas.value;
  if (!size || !target) return;

  const ctx = target.getContext("2d");
  if (!ctx) {
    error.value = {
      message: "This browser would not give the page a 2D canvas.",
      fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
    };
    return;
  }

  // The layout needs a measurer, and the only honest one is this context.
  const measure: MeasureText = (line, fontSize) => {
    ctx.font = `${fontSize}px ${MEME_FONT_STACK}`;
    return ctx.measureText(line).width;
  };

  let layout: MemeLayout;
  try {
    layout = layoutMeme(size, currentOpts(), measure);
    error.value = null;
  } catch (err) {
    error.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That meme could not be drawn." };
    return;
  }
  lastLayout = layout;

  target.width = layout.canvas.width;
  target.height = layout.canvas.height;

  // The caption bar first, so it fills the strip the picture does not cover.
  ctx.fillStyle = layout.barHeight > 0 ? layout.barColor : blankColor.value;
  ctx.fillRect(0, 0, layout.canvas.width, layout.canvas.height);

  if (blank.value === "none" && picture.value) {
    ctx.drawImage(
      picture.value,
      layout.imageAt.x,
      layout.imageAt.y,
      layout.imageAt.width,
      layout.imageAt.height,
    );
  } else if (blank.value !== "none") {
    ctx.fillStyle = blankColor.value;
    ctx.fillRect(layout.imageAt.x, layout.imageAt.y, layout.imageAt.width, layout.imageAt.height);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const block of layout.blocks) {
    ctx.font = `${block.fontSize}px ${MEME_FONT_STACK}`;
    ctx.fillStyle = block.color;
    ctx.strokeStyle = block.outline;
    ctx.lineWidth = block.outlineWidth;
    block.lines.forEach((line, i) => {
      const y = block.y + (i - (block.lines.length - 1) / 2) * block.lineHeight;
      if (block.outline && block.outlineWidth > 0) ctx.strokeText(line, block.x, y);
      ctx.fillText(line, block.x, y);
    });
  }

  syncFragment();
}

/**
 * Redraws on every setting that can change the picture. `picture` and `blank`
 * are what decide whether a `<canvas>` exists at all (see `sourceSize`), so
 * `flush: "post"` matters here, not just for tidiness: the default "pre"
 * timing runs this callback before Vue has patched the DOM, meaning the very
 * first draw after a picture loads, or after picking a blank canvas for the
 * first time, would find `canvas.value` still undefined and silently draw
 * nothing. Waiting for "post" guarantees the element is there once one of
 * these actually turns `ready` on.
 */
watch(
  [
    mode,
    topText,
    bottomText,
    captionText,
    fontPercent,
    color,
    outline,
    outlinePercent,
    uppercase,
    blank,
    blankColor,
    picture,
    topX,
    topY,
    bottomX,
    bottomY,
  ],
  render,
  { flush: "post" },
);

/* ---------------------------------------------------------------- */
/* dragging                                                          */
/* ---------------------------------------------------------------- */

let dragging: "top" | "bottom" | null = null;

/** Canvas coordinates for a pointer event, whatever the CSS size is. */
function toCanvasPoint(event: PointerEvent): { x: number; y: number } | null {
  const target = canvas.value;
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * target.width,
    y: ((event.clientY - rect.top) / rect.height) * target.height,
  };
}

function onPointerDown(event: PointerEvent): void {
  const layout = lastLayout;
  const point = toCanvasPoint(event);
  if (!layout || !point) return;
  // Nearest draggable block whose box the pointer is actually inside, with a
  // generous vertical pad so a thin line is still easy to grab.
  for (const block of layout.blocks) {
    if (!block.draggable) continue;
    const padX = Math.max(block.width / 2, 40);
    const padY = Math.max(block.height / 2, 24);
    if (Math.abs(point.x - block.x) <= padX && Math.abs(point.y - block.y) <= padY) {
      dragging = block.id === "top" ? "top" : "bottom";
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return;
  const target = canvas.value;
  const point = toCanvasPoint(event);
  if (!target || !point) return;
  const x = Math.round((point.x / target.width) * 1000) / 10;
  const y = Math.round((point.y / target.height) * 1000) / 10;
  if (dragging === "top") {
    topX.value = Math.min(100, Math.max(0, x));
    topY.value = Math.min(100, Math.max(0, y));
  } else {
    bottomX.value = Math.min(100, Math.max(0, x));
    bottomY.value = Math.min(100, Math.max(0, y));
  }
}

function endDrag(): void {
  dragging = null;
}

function resetPositions(): void {
  topX.value = 50;
  topY.value = 12;
  bottomX.value = 50;
  bottomY.value = 88;
}

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

/** Copy image needs the async clipboard with image support. */
const canCopyImage =
  typeof window !== "undefined" &&
  typeof ClipboardItem !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.clipboard?.write === "function";

function toBlob(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const target = canvas.value;
    if (!target) {
      resolve(null);
      return;
    }
    target.toBlob((blob) => resolve(blob), "image/png");
  });
}

async function savePng(): Promise<void> {
  const blob = await toBlob();
  if (blob) downloadBlob(blob, memeFilename(fileName.value));
}

/**
 * Copy the finished meme to the clipboard as an image.
 *
 * `copyText` in lib/clipboard only handles text, so this writes the blob
 * directly and raises the same shaped toasts by hand, including the fix hint an
 * error toast owes the reader.
 */
async function copyImage(): Promise<void> {
  const blob = await toBlob();
  if (!blob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast({ title: "Copied the image", variant: "success" });
  } catch {
    toast({
      title: "Could not copy the image",
      description: "Use Save PNG instead, then attach the file.",
      variant: "error",
    });
  }
}

/* ---------------------------------------------------------------- */
/* fragment                                                          */
/* ---------------------------------------------------------------- */

function syncFragment(): void {
  writeFragment({
    opts: {
      mode: mode.value,
      topText: topText.value,
      bottomText: bottomText.value,
      captionText: captionText.value,
      fontPercent: String(fontPercent.value),
      color: color.value,
      outline: outline.value,
      outlinePercent: String(outlinePercent.value),
      uppercase: String(uppercase.value),
      blank: blank.value,
      blankColor: blankColor.value,
      topX: String(topX.value),
      topY: String(topY.value),
      bottomX: String(bottomX.value),
      bottomY: String(bottomY.value),
    },
  });
}

function numberOpt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

onMounted(() => {
  const { opts } = readFragment();
  if (opts["mode"] === "caption") mode.value = "caption";
  if (opts["topText"] !== undefined) topText.value = opts["topText"];
  if (opts["bottomText"] !== undefined) bottomText.value = opts["bottomText"];
  if (opts["captionText"] !== undefined) captionText.value = opts["captionText"];
  fontPercent.value = numberOpt(opts["fontPercent"], fontPercent.value);
  if (opts["color"]) color.value = opts["color"];
  if (opts["outline"] !== undefined) outline.value = opts["outline"];
  outlinePercent.value = numberOpt(opts["outlinePercent"], outlinePercent.value);
  if (opts["uppercase"]) uppercase.value = opts["uppercase"] !== "false";
  if (opts["blank"] && (opts["blank"] === "none" || BLANK_SIZES[opts["blank"]])) {
    blank.value = opts["blank"];
  }
  if (opts["blankColor"]) blankColor.value = opts["blankColor"];
  topX.value = numberOpt(opts["topX"], topX.value);
  topY.value = numberOpt(opts["topY"], topY.value);
  bottomX.value = numberOpt(opts["bottomX"], bottomX.value);
  bottomY.value = numberOpt(opts["bottomY"], bottomY.value);
  render();
});

onUnmounted(releasePicture);

const ready = computed(() => sourceSize.value !== null);
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <FileDrop
      accept="image/*"
      label="Picture"
      hint="Drop a picture here, paste one, or click to choose. Everything is drawn on a canvas in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="loadSample">
          <Sparkles class="size-3.5" aria-hidden="true" />
          Load sample
        </Button>
      </template>
    </FileDrop>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- layout and text -->
    <div class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground">Layout</Label>
        <Segmented
          :model-value="mode"
          :options="MODE_OPTIONS"
          label="Layout"
          size="sm"
          @update:model-value="(v: string) => (mode = v as 'classic' | 'caption')"
        />
      </div>
      <div class="flex w-56 flex-col gap-1.5">
        <Label for="meme-blank" class="text-xs text-muted-foreground">Blank canvas</Label>
        <SearchableSelect
          id="meme-blank"
          :spec="blankSpec"
          :model-value="blank"
          class="w-full bg-card"
          @update:model-value="(v: string) => (blank = v)"
        />
      </div>
      <div v-if="blank !== 'none'" class="flex flex-col gap-1.5">
        <Label for="meme-blank-color" class="text-xs text-muted-foreground">Canvas color</Label>
        <input
          id="meme-blank-color"
          type="color"
          :value="blankColorSwatch"
          aria-label="Pick the blank canvas color"
          class="h-9 w-14 cursor-pointer rounded-[8px] border bg-card p-1"
          @input="blankColor = ($event.target as HTMLInputElement).value"
        />
      </div>
    </div>

    <div v-if="mode === 'classic'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="meme-top" class="text-xs text-muted-foreground">Top text</Label>
        <Input
          id="meme-top"
          v-model="topText"
          class="h-9 bg-card"
          placeholder="One does not simply"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="meme-bottom" class="text-xs text-muted-foreground">Bottom text</Label>
        <Input
          id="meme-bottom"
          v-model="bottomText"
          class="h-9 bg-card"
          placeholder="Ship on a Friday"
        />
      </div>
    </div>

    <div v-else class="flex flex-col gap-1.5">
      <Label for="meme-caption" class="text-xs text-muted-foreground">Caption</Label>
      <Textarea
        id="meme-caption"
        v-model="captionText"
        class="min-h-20 bg-secondary shadow-[var(--sh-inset)]"
        placeholder="when the tests finally pass"
      />
    </div>

    <!-- styling -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="flex flex-col gap-1.5">
        <Label for="meme-size" class="text-xs text-muted-foreground">
          Text size <span class="font-mono tabular-nums">{{ fontPercent }}%</span>
        </Label>
        <Slider
          id="meme-size"
          :model-value="[fontPercent]"
          :min="2"
          :max="30"
          :step="0.5"
          @update:model-value="(v: number[] | undefined) => (fontPercent = v?.[0] ?? fontPercent)"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="meme-outline-width" class="text-xs text-muted-foreground">
          Outline <span class="font-mono tabular-nums">{{ outlinePercent }}%</span>
        </Label>
        <Slider
          id="meme-outline-width"
          :model-value="[outlinePercent]"
          :min="0"
          :max="30"
          :step="1"
          @update:model-value="
            (v: number[] | undefined) => (outlinePercent = v?.[0] ?? outlinePercent)
          "
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="meme-color" class="text-xs text-muted-foreground">Text color</Label>
        <div class="flex items-center gap-2">
          <input
            id="meme-color"
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
        <Label for="meme-outline" class="text-xs text-muted-foreground">Outline color</Label>
        <div class="flex items-center gap-2">
          <input
            id="meme-outline"
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

    <div class="flex flex-wrap items-center gap-4">
      <div class="flex items-center gap-2">
        <Switch id="meme-caps" v-model="uppercase" />
        <Label for="meme-caps" class="text-xs text-muted-foreground">Shout it in capitals</Label>
      </div>
      <Button
        v-if="mode === 'classic'"
        type="button"
        variant="ghost"
        size="sm"
        @click="resetPositions"
      >
        Reset text positions
      </Button>
    </div>

    <!-- preview -->
    <div v-if="ready" class="flex flex-col gap-2">
      <canvas
        ref="canvas"
        class="block h-auto w-full touch-none rounded-[10px] shadow-[var(--sh-inset)]"
        :class="mode === 'classic' ? 'cursor-move' : ''"
        aria-label="The meme, with draggable caption text"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      />
      <p v-if="mode === 'classic'" class="text-xs text-muted-foreground">
        Drag either line to move it. Positions are stored as a percentage of the canvas, so they
        survive switching to another picture.
      </p>
    </div>

    <p v-else-if="!error" class="flex items-center gap-2 text-xs text-muted-foreground">
      <ImageOff class="size-3.5" aria-hidden="true" />
      No picture loaded yet. Drop one, or pick a blank canvas size to make a meme that is only
      words.
    </p>

    <!-- export -->
    <div v-if="ready" class="flex flex-wrap items-center gap-1">
      <Button type="button" variant="outline" @click="savePng">
        <Download class="size-3.5" aria-hidden="true" />
        Save PNG
      </Button>
      <Button v-if="canCopyImage" type="button" variant="outline" @click="copyImage">
        <Clipboard class="size-3.5" aria-hidden="true" />
        Copy image
      </Button>
      <span v-else class="ml-2 text-xs text-muted-foreground">
        This browser cannot put an image on the clipboard, so use Save PNG instead.
      </span>
    </div>
  </div>
</template>
