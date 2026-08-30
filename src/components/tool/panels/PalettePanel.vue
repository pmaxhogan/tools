<script setup lang="ts">
/**
 * Bespoke panel for the Image Color Palette Extractor.
 *
 * The generic shell cannot decode a PNG and cannot draw a swatch, and both are
 * the point of this tool, so the panel owns the canvas work: it decodes the
 * dropped file, reads the pixels back, hands them to the pure layer, then
 * paints the swatch row and the downloadable palette strip.
 *
 * Rule 27 holds: no color math happens here. `extractPalette` in
 * `src/tools/image-color-palette-extractor/` does the sampling, the median cut,
 * the k-means refinement, and the per swatch label color, and `cssVariables`,
 * `tailwindConfig` and `paletteJson` write the exports. This file only decodes,
 * paints, and saves.
 *
 * The working canvas is capped at 900 pixels on its long edge. The clustering
 * already strides down to at most 24,000 samples, so a larger decode buys
 * nothing but memory, and the cap keeps a 40 megapixel phone photo from
 * allocating 160 MB of RGBA before the first sample is taken.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Check, Download, ImageOff, Sparkles } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  cssVariables,
  extractPalette,
  paletteJson,
  tailwindConfig,
} from "@/tools/image-color-palette-extractor/index";
import type { PaletteResult, Swatch } from "@/tools/image-color-palette-extractor/index";
import { copyText } from "@/lib/clipboard";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

const props = defineProps<{ meta: ToolMeta }>();

/** Longest edge of the working canvas. See the note at the top of this file. */
const MAX_EDGE = 900;
/** Pixel size of one square in the downloadable palette strip. */
const STRIP_SIZE = 160;

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

const colors = ref(6);
const sort = ref("share");
const ignoreTransparent = ref(true);
const cssPrefix = ref("color");

const sortSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "sort");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "sort",
    label: "Order",
    default: "share",
    options: [{ value: "share", label: "Most used first", synonyms: ["dominant"] }],
  };
});

/* ------------------------------------------------------------------ *
 * image
 * ------------------------------------------------------------------ */

const fileName = ref("");
const error = ref<{ message: string; fix?: string } | null>(null);
const result = shallowRef<PaletteResult | null>(null);
const previewUrl = ref("");

/** Decoded pixels. Deliberately not reactive: Vue must never proxy this. */
let pixels: ImageData | null = null;

function releasePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = "";
  }
}

function recompute(): void {
  if (!pixels) return;
  try {
    result.value = extractPalette(pixels, {
      colors: colors.value,
      sort: sort.value as "share" | "lightness" | "hue",
      ignoreTransparent: ignoreTransparent.value,
      cssPrefix: cssPrefix.value,
    });
    error.value = null;
  } catch (err) {
    result.value = null;
    error.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That image could not be read." };
  }
  syncFragment();
}

function syncFragment(): void {
  writeFragment({
    opts: {
      colors: String(colors.value),
      sort: sort.value,
      ignoreTransparent: String(ignoreTransparent.value),
      cssPrefix: cssPrefix.value,
    },
  });
}

watch([colors, sort, ignoreTransparent, cssPrefix], recompute);

async function acceptImage(file: File | undefined): Promise<void> {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image, so there are no colors to pull out.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF instead.",
    };
    return;
  }

  releasePreview();
  const url = URL.createObjectURL(file);
  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

  if (!loaded || !img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    pixels = null;
    result.value = null;
    error.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    URL.revokeObjectURL(url);
    error.value = {
      message: "This browser would not give the page a 2D canvas.",
      fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
    };
    return;
  }
  ctx.drawImage(img, 0, 0, w, h);
  pixels = ctx.getImageData(0, 0, w, h);

  previewUrl.value = url;
  fileName.value = file.name || "image";
  recompute();
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
  } catch {
    error.value = {
      message: "Could not load the sample photo.",
      fix: "Try again, or drop an image of your own.",
    };
  }
}

/* ------------------------------------------------------------------ *
 * exports
 * ------------------------------------------------------------------ */

const cssText = computed(() =>
  result.value ? cssVariables(result.value.swatches, cssPrefix.value) : "",
);
const tailwindText = computed(() =>
  result.value ? tailwindConfig(result.value.swatches, cssPrefix.value) : "",
);
const jsonText = computed(() => (result.value ? paletteJson(result.value) : ""));
const hexListText = computed(() =>
  result.value ? result.value.swatches.map((s) => s.hex).join("\n") : "",
);

const sampledNote = computed(() => {
  const current = result.value;
  if (!current) return "";
  const sampled = current.sampled.toLocaleString("en-US");
  const total = current.total.toLocaleString("en-US");
  return `${sampled} of ${total} pixels clustered`;
});

/** The copied swatch, so the grid can show a tick without a toast per click. */
const justCopied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copySwatch(swatch: Swatch): Promise<void> {
  if (await copyText(swatch.hex, "Copied the hex")) {
    justCopied.value = swatch.hex;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (justCopied.value = ""), 1200);
  }
}

/** Paint the palette as one PNG strip, one square per color, and save it. */
function downloadStrip(): void {
  const current = result.value;
  if (!current) return;
  const canvas = document.createElement("canvas");
  canvas.width = STRIP_SIZE * current.swatches.length;
  canvas.height = STRIP_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  current.swatches.forEach((swatch, i) => {
    ctx.fillStyle = swatch.hex;
    ctx.fillRect(i * STRIP_SIZE, 0, STRIP_SIZE, STRIP_SIZE);
    ctx.fillStyle = swatch.textColor;
    ctx.font = "600 18px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(swatch.hex, i * STRIP_SIZE + 14, STRIP_SIZE - 16);
  });
  const stem = fileName.value.replace(/\.[^./\\]+$/, "") || "palette";
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${stem}-palette.png`);
  }, "image/png");
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const { opts } = readFragment();
  const n = Number(opts["colors"]);
  if (Number.isFinite(n) && n >= 2 && n <= 16) colors.value = Math.round(n);
  if (opts["sort"]) sort.value = opts["sort"];
  if (opts["ignoreTransparent"]) ignoreTransparent.value = opts["ignoreTransparent"] !== "false";
  if (opts["cssPrefix"]) cssPrefix.value = opts["cssPrefix"];
});

onUnmounted(() => {
  clearTimeout(copiedTimer);
  releasePreview();
  pixels = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <FileDrop
      accept="image/*"
      label="Image"
      hint="Drop a picture here, paste one, or click to choose. It is decoded on a canvas in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="loadSample">
          <Sparkles class="size-3.5" aria-hidden="true" />
          Load sample
        </Button>
      </template>
    </FileDrop>

    <!-- options -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="flex flex-col gap-1.5">
        <Label for="palette-colors" class="text-xs text-muted-foreground">
          Colors <span class="font-mono tabular-nums">{{ colors }}</span>
        </Label>
        <Slider
          id="palette-colors"
          :model-value="[colors]"
          :min="2"
          :max="16"
          :step="1"
          @update:model-value="(v: number[] | undefined) => (colors = v?.[0] ?? colors)"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="palette-sort" class="text-xs text-muted-foreground">Order</Label>
        <SearchableSelect
          id="palette-sort"
          :spec="sortSpec"
          :model-value="sort"
          class="w-full bg-card"
          @update:model-value="(v: string) => (sort = v)"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="palette-prefix" class="text-xs text-muted-foreground">CSS name prefix</Label>
        <Input
          id="palette-prefix"
          v-model="cssPrefix"
          class="h-9 bg-card font-mono"
          spellcheck="false"
          placeholder="color"
        />
      </div>

      <div class="flex items-center gap-2 sm:pt-6">
        <Switch id="palette-alpha" v-model="ignoreTransparent" />
        <Label for="palette-alpha" class="text-xs text-muted-foreground">
          Skip transparent pixels
        </Label>
      </div>
    </div>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="result">
      <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
        <figure class="flex flex-col gap-1.5">
          <figcaption
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Source
          </figcaption>
          <img
            :src="previewUrl"
            :alt="`Preview of ${fileName}`"
            class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
          />
          <figcaption class="text-xs text-muted-foreground">{{ sampledNote }}</figcaption>
        </figure>

        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm">
              Dominant color
              <span class="font-mono">{{ result.dominant.hex }}</span>
              <span class="text-muted-foreground">
                , {{ Math.round(result.dominant.share * 100) }}% of the sampled pixels
              </span>
            </p>
            <div class="flex items-center gap-1">
              <CopyButton :text="hexListText" label="Copy hex list" />
              <Button type="button" variant="outline" size="sm" @click="downloadStrip">
                <Download class="size-3.5" aria-hidden="true" />
                PNG strip
              </Button>
            </div>
          </div>

          <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            <li v-for="swatch in result.swatches" :key="swatch.hex">
              <button
                type="button"
                class="flex w-full flex-col gap-1 rounded-[10px] border p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                :style="{ backgroundColor: swatch.hex, color: swatch.textColor }"
                :aria-label="`Copy ${swatch.hex}`"
                @click="copySwatch(swatch)"
              >
                <span class="flex items-center gap-1 font-mono text-sm">
                  {{ swatch.hex }}
                  <Check v-if="justCopied === swatch.hex" class="size-3.5" aria-hidden="true" />
                </span>
                <span class="font-mono text-[0.65rem] opacity-80">{{ swatch.rgb }}</span>
                <span class="font-mono text-[0.65rem] opacity-80">{{ swatch.oklch }}</span>
                <span class="text-[0.65rem] tabular-nums opacity-80">
                  {{ Math.round(swatch.share * 100) }}% of the image
                </span>
              </button>
            </li>
          </ul>
          <p class="text-xs text-muted-foreground">
            Click a swatch to copy its hex. The label on each one is the black or white with the
            better contrast against that color.
          </p>
        </div>
      </div>

      <!-- exports -->
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div
          v-for="block in [
            { title: 'CSS custom properties', text: cssText },
            { title: 'Tailwind theme', text: tailwindText },
            { title: 'JSON', text: jsonText },
          ]"
          :key="block.title"
          class="flex min-w-0 flex-col gap-1.5"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              {{ block.title }}
            </span>
            <CopyButton :text="block.text" label="Copy" />
          </div>
          <pre
            class="max-h-56 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
            >{{ block.text }}</pre>
        </div>
      </div>
    </template>

    <p v-else-if="!error" class="flex items-center gap-2 text-xs text-muted-foreground">
      <ImageOff class="size-3.5" aria-hidden="true" />
      No image loaded yet. Pictures wider or taller than {{ MAX_EDGE }} pixels are scaled down
      first, which does not change the palette.
    </p>
  </div>
</template>
