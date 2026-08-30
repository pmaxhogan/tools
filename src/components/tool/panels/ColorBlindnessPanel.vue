<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, ImageOff } from "lucide-vue-next";
import type { SelectGroup, SelectOption, SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  CVD_KINDS,
  MATRICES,
  parseColor,
  run,
  simulateRgb,
  toHex,
} from "@/tools/color-blindness-simulator/index";
import type { ColorBlindnessResult, CvdKind } from "@/tools/color-blindness-simulator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the Color Blindness Simulator.
 *
 * Two things the generic shell cannot do live here. The palette tab renders
 * real swatches beside the text report, and the image tab runs the same
 * simulation over every pixel of a picture on a canvas. Both defer to the pure
 * layer in `src/tools/color-blindness-simulator/` for the color science
 * (PROJECT.md rule 27): `run` produces the report, `parseColor` reads a token,
 * `simulateRgb` transforms a swatch, `toHex` formats one.
 *
 * The pixel loop is the one exception, and only for speed: a full picture is
 * millions of `simulateRgb` calls, so it inlines the same matrix multiply using
 * MATRICES plus a 256 entry decode table. It is the same arithmetic in the same
 * order, checked to be byte identical across a sample of the color cube.
 *
 * Nothing here touches the network. The picture is read with an object URL and
 * drawn on a local canvas, so your files and inputs never leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * deficiency selects, built from the meta spec
 * ------------------------------------------------------------------ */

const FALLBACK_KIND_LABELS: Record<CvdKind, string> = {
  protanopia: "Protanopia",
  protanomaly: "Protanomaly",
  deuteranopia: "Deuteranopia",
  deuteranomaly: "Deuteranomaly",
  tritanopia: "Tritanopia",
  tritanomaly: "Tritanomaly",
  achromatopsia: "Achromatopsia",
};

const metaKindSpec = computed<SelectOptionSpec | null>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "kind");
  return found && found.kind === "select" ? found : null;
});

/** Every leaf value the meta spec already covers, at any nesting depth. */
function collectValues(spec: SelectOptionSpec | null): Set<string> {
  const seen = new Set<string>();
  const walkGroup = (group: SelectGroup) => {
    for (const option of group.options ?? []) seen.add(option.value);
    for (const child of group.groups ?? []) walkGroup(child);
  };
  for (const option of spec?.options ?? []) seen.add(option.value);
  for (const group of spec?.groups ?? []) walkGroup(group);
  return seen;
}

/** Drop the "all" entry from a group tree, pruning any group that empties out. */
function withoutAll(groups: SelectGroup[]): SelectGroup[] {
  const out: SelectGroup[] = [];
  for (const group of groups) {
    const options = (group.options ?? []).filter((o) => o.value !== "all");
    const children = withoutAll(group.groups ?? []);
    if (options.length === 0 && children.length === 0) continue;
    out.push({
      label: group.label,
      synonyms: group.synonyms,
      ...(options.length > 0 ? { options } : {}),
      ...(children.length > 0 ? { groups: children } : {}),
    });
  }
  return out;
}

/** Any CVD_KINDS entry the meta has not caught up with, so the dropdown always
 * offers exactly what the logic layer can simulate. */
const extraKindOptions = computed<SelectOption[]>(() => {
  const seen = collectValues(metaKindSpec.value);
  return CVD_KINDS.filter((k) => !seen.has(k)).map((k) => ({
    value: k,
    label: FALLBACK_KIND_LABELS[k],
    synonyms: [k],
  }));
});

const paletteKindSpec = computed<SelectOptionSpec>(() => {
  const base = metaKindSpec.value;
  const extra = extraKindOptions.value;
  return {
    kind: "select",
    id: "cb-palette-kind",
    label: base?.label ?? "Deficiency",
    default: "all",
    ...(base?.groups ? { groups: base.groups } : {}),
    options: [...(base?.options ?? []), ...extra],
  };
});

const imageKindSpec = computed<SelectOptionSpec>(() => {
  const base = metaKindSpec.value;
  const extra = extraKindOptions.value;
  const groups = withoutAll(base?.groups ?? []);
  const flat = [...(base?.options ?? []), ...extra].filter((o) => o.value !== "all");
  return {
    kind: "select",
    id: "cb-image-kind",
    label: base?.label ?? "Deficiency",
    default: "protanopia",
    ...(groups.length > 0 ? { groups } : {}),
    options: flat,
  };
});

/* ------------------------------------------------------------------ *
 * palette tab
 * ------------------------------------------------------------------ */

const tab = ref<"palette" | "image">("palette");

const paletteText = ref("");
const paletteKind = ref("all");
const paletteResult = shallowRef<ColorBlindnessResult | null>(null);
const paletteError = ref<{ message: string; fix?: string } | null>(null);

interface SwatchRow {
  /** The color exactly as the logic layer read it. */
  hex: string;
  sims: { kind: CvdKind; hex: string }[];
}

const swatches = shallowRef<SwatchRow[]>([]);

/** Mirrors the splitter in the pure layer so the swatch grid is built from the
 * same tokens the report used. `parseColor` stays the authority on what each
 * token means; this only decides where one token ends and the next begins,
 * keeping rgb(...) groups intact. */
function tokenizePalette(input: string): string[] {
  const out: string[] = [];
  const re = /rgba?\([^)]*\)?|[^\s,;]+/gi;
  let m: RegExpExecArray | null = re.exec(input);
  while (m !== null) {
    out.push(m[0]);
    m = re.exec(input);
  }
  return out;
}

const shownKinds = computed<CvdKind[]>(() => {
  if (paletteKind.value === "all") return [...CVD_KINDS];
  return (CVD_KINDS as readonly string[]).includes(paletteKind.value)
    ? [paletteKind.value as CvdKind]
    : [...CVD_KINDS];
});

function runPalette() {
  const raw = paletteText.value.trim();
  writeFragment({ input: raw, opts: { kind: paletteKind.value } });

  // An untouched textarea is an empty state, not a mistake, so it never gets
  // the error style.
  if (!raw) {
    paletteResult.value = null;
    paletteError.value = null;
    swatches.value = [];
    return;
  }

  try {
    paletteResult.value = run(raw, { kind: paletteKind.value, contrast: true });
    paletteError.value = null;
    // run() succeeded, so every token parses and no per token guard is needed.
    swatches.value = tokenizePalette(raw).map((token) => {
      const rgb = parseColor(token);
      return {
        hex: toHex(rgb),
        sims: shownKinds.value.map((kind) => ({ kind, hex: toHex(simulateRgb(rgb, kind)) })),
      };
    });
  } catch (err) {
    paletteResult.value = null;
    swatches.value = [];
    paletteError.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That palette could not be simulated." };
  }
}

/** Typing should not re-run the whole report on every keystroke. */
const DEBOUNCE_MS = 200;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

watch([paletteText, paletteKind], () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runPalette, DEBOUNCE_MS);
});

/* ------------------------------------------------------------------ *
 * image tab
 * ------------------------------------------------------------------ */

/** Longest edge the working canvas is capped at. Bigger pictures are scaled
 * down first so the pixel loop stays inside a few frames. */
const MAX_EDGE = 1600;
/** Roughly how many pixels are transformed before yielding back to the browser. */
const CHUNK_PIXELS = 180_000;

/**
 * sRGB transfer functions, matching the pure layer exactly so the pixel loop
 * can skip a call into it per channel. See the note at the top of this file.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Decode table for the 256 gamma encoded levels one byte can hold. */
const DECODE = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i / 255);
  return table;
})();

function encodeChannel(v: number): number {
  return Math.round(linearToSrgb(v < 0 ? 0 : v > 1 ? 1 : v) * 255);
}

const imageKind = ref<CvdKind>("protanopia");
const imageName = ref("");
const imageReady = ref(false);
const imageError = ref<{ message: string; fix?: string } | null>(null);
const processing = ref(false);
const progress = ref(0);

const imageWidth = ref(0);
const imageHeight = ref(0);

const originalCanvas = ref<HTMLCanvasElement>();
const simulatedCanvas = ref<HTMLCanvasElement>();

/** The decoded source pixels. Deliberately not reactive: Vue must never proxy
 * a multi megabyte typed array. */
let sourceImage: ImageData | null = null;
/** Guards against a superseded run painting over a newer one. */
let imageSeq = 0;
/** The object URL currently held for the picked file, so it can be released. */
let objectUrl: string | null = null;

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

function paintOriginal() {
  const canvas = originalCanvas.value;
  if (!canvas || !sourceImage) return;
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(sourceImage, 0, 0);
}

async function runSimulation() {
  const src = sourceImage;
  const canvas = simulatedCanvas.value;
  if (!src || !canvas) return;

  const runId = ++imageSeq;
  processing.value = true;
  progress.value = 0;

  const w = src.width;
  const h = src.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    processing.value = false;
    return;
  }

  const m = MATRICES[imageKind.value];
  const m00 = m[0][0];
  const m01 = m[0][1];
  const m02 = m[0][2];
  const m10 = m[1][0];
  const m11 = m[1][1];
  const m12 = m[1][2];
  const m20 = m[2][0];
  const m21 = m[2][1];
  const m22 = m[2][2];

  // A fresh buffer every run, so switching deficiency never compounds.
  const outImage = ctx.createImageData(w, h);
  const source = src.data;
  const target = outImage.data;

  const rowsPerChunk = Math.max(1, Math.round(CHUNK_PIXELS / Math.max(1, w)));

  for (let y = 0; y < h; y += rowsPerChunk) {
    if (runId !== imageSeq) return;
    const yEnd = Math.min(h, y + rowsPerChunk);
    const end = yEnd * w * 4;
    for (let i = y * w * 4; i < end; i += 4) {
      const lr = DECODE[source[i]];
      const lg = DECODE[source[i + 1]];
      const lb = DECODE[source[i + 2]];
      target[i] = encodeChannel(m00 * lr + m01 * lg + m02 * lb);
      target[i + 1] = encodeChannel(m10 * lr + m11 * lg + m12 * lb);
      target[i + 2] = encodeChannel(m20 * lr + m21 * lg + m22 * lb);
      target[i + 3] = source[i + 3];
    }
    progress.value = Math.round((yEnd / h) * 100);
    await nextFrame();
  }

  if (runId !== imageSeq) return;
  ctx.putImageData(outImage, 0, 0);
  processing.value = false;
}

async function acceptImage(file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    imageError.value = {
      message: `${file.name || "That file"} is not an image, so there is nothing to simulate.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF instead.",
    };
    return;
  }

  // Retire any run still in flight before the source pixels change.
  imageSeq++;
  processing.value = false;
  imageError.value = null;

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
    sourceImage = null;
    imageReady.value = false;
    imageError.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  if (!workCtx) {
    releaseObjectUrl();
    imageError.value = {
      message: "This browser would not give the page a 2D canvas.",
      fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
    };
    return;
  }
  workCtx.drawImage(img, 0, 0, w, h);
  sourceImage = workCtx.getImageData(0, 0, w, h);
  releaseObjectUrl();

  imageName.value = file.name || "image";
  imageWidth.value = w;
  imageHeight.value = h;
  imageReady.value = true;

  // The canvases only exist once imageReady flips, so wait for the DOM.
  await nextTick();
  paintOriginal();
  await runSimulation();
}

function onFiles(files: File[]) {
  void acceptImage(files[0]);
}

const downloadName = computed(() => {
  const base = imageName.value.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}-${imageKind.value}.png`;
});

function downloadSimulated() {
  const canvas = simulatedCanvas.value;
  if (!canvas || processing.value) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, downloadName.value);
  }, "image/png");
}

watch(imageKind, () => {
  if (!imageReady.value) return;
  void runSimulation();
});

const scaledNote = computed(() =>
  imageReady.value ? `${imageWidth.value} by ${imageHeight.value} pixels` : "",
);

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  if (state.input) paletteText.value = state.input;
  const fromHash = state.opts["kind"];
  if (fromHash && (fromHash === "all" || (CVD_KINDS as readonly string[]).includes(fromHash))) {
    paletteKind.value = fromHash;
  }
  if (paletteText.value.trim()) runPalette();
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  imageSeq++;
  releaseObjectUrl();
  sourceImage = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="palette"> Palette </TabsTrigger>
        <TabsTrigger value="image"> Image </TabsTrigger>
      </TabsList>

      <!-- palette -->
      <TabsContent value="palette" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-1.5">
          <Label for="cb-palette-input" class="text-xs text-muted-foreground">Colors</Label>
          <Textarea
            id="cb-palette-input"
            v-model="paletteText"
            class="min-h-32 bg-secondary font-mono shadow-[var(--sh-inset)]"
            spellcheck="false"
            autocapitalize="off"
            placeholder="#1d4ed8&#10;#f97316&#10;rgb(22, 163, 74)"
            :aria-invalid="paletteError ? 'true' : undefined"
          />
          <p class="text-xs text-muted-foreground">
            One color per line, or separated by commas. Short hex, long hex, bare hex, and rgb() all
            parse.
          </p>
        </div>

        <div class="flex w-full flex-col gap-1.5 sm:w-72">
          <Label for="cb-palette-kind" class="text-xs text-muted-foreground">Deficiency</Label>
          <SearchableSelect
            id="cb-palette-kind"
            :spec="paletteKindSpec"
            :model-value="paletteKind"
            class="w-full bg-card"
            @update:model-value="(v: string) => (paletteKind = v)"
          />
        </div>

        <ErrorBanner v-if="paletteError" :message="paletteError.message" :hint="paletteError.fix" />

        <!-- swatches -->
        <div v-if="swatches.length > 0" class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Swatches
          </span>
          <div class="flex flex-col gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div
              v-for="(row, i) in swatches"
              :key="`${i}-${row.hex}`"
              class="flex flex-wrap items-start gap-2"
            >
              <figure class="flex w-[5.5rem] flex-col gap-1">
                <div
                  class="h-11 w-full rounded-[8px] border"
                  :style="{ backgroundColor: row.hex }"
                  aria-hidden="true"
                />
                <figcaption class="flex flex-col">
                  <span class="font-mono text-xs">{{ row.hex }}</span>
                  <span class="text-[0.65rem] text-muted-foreground">original</span>
                </figcaption>
              </figure>

              <figure
                v-for="sim in row.sims"
                :key="sim.kind"
                class="flex w-[5.5rem] flex-col gap-1"
              >
                <div
                  class="h-11 w-full rounded-[8px] border"
                  :style="{ backgroundColor: sim.hex }"
                  aria-hidden="true"
                />
                <figcaption class="flex flex-col">
                  <span class="font-mono text-xs">{{ sim.hex }}</span>
                  <span class="truncate text-[0.65rem] text-muted-foreground" :title="sim.kind">
                    {{ sim.kind }}
                  </span>
                </figcaption>
              </figure>
            </div>
          </div>
        </div>

        <OutputView v-if="paletteResult" :output="paletteResult" />

        <p v-else-if="!paletteError" class="text-xs text-muted-foreground">
          Paste a palette above to see every color simulated, with the WCAG contrast and CIE76
          deltaE of each neighboring pair.
        </p>
      </TabsContent>

      <!-- image -->
      <TabsContent value="image" class="flex flex-col gap-4 pt-4">
        <FileDrop
          accept="image/*"
          label="Image"
          hint="Drop a picture here or click to choose one. It is drawn and transformed on a canvas in this tab: your files and inputs never leave your device."
          @files="onFiles"
        />

        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div class="flex w-full flex-col gap-1.5 sm:w-72">
            <Label for="cb-image-kind" class="text-xs text-muted-foreground">Deficiency</Label>
            <SearchableSelect
              id="cb-image-kind"
              :spec="imageKindSpec"
              :model-value="imageKind"
              class="w-full bg-card"
              @update:model-value="(v: string) => (imageKind = v as CvdKind)"
            />
          </div>

          <Button
            v-if="imageReady"
            type="button"
            variant="outline"
            :disabled="processing"
            @click="downloadSimulated"
          >
            <Download class="size-3.5" aria-hidden="true" />
            Download PNG
          </Button>
        </div>

        <ErrorBanner v-if="imageError" :message="imageError.message" :hint="imageError.fix" />

        <div v-if="imageReady" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span class="font-mono">{{ imageName }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ scaledNote }}</span>
            <span v-if="processing" role="status" class="text-foreground">
              Processing… {{ progress }}%
            </span>
          </div>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <figure class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                Original
              </figcaption>
              <canvas
                ref="originalCanvas"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
              />
            </figure>

            <figure class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                {{ imageKind }}
              </figcaption>
              <canvas
                ref="simulatedCanvas"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
                :class="processing ? 'opacity-60' : ''"
              />
            </figure>
          </div>
        </div>

        <p v-else-if="!imageError" class="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageOff class="size-3.5" aria-hidden="true" />
          No image loaded yet. Pictures wider or taller than {{ MAX_EDGE }} pixels are scaled down
          first so the preview stays quick.
        </p>
      </TabsContent>
    </Tabs>

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
