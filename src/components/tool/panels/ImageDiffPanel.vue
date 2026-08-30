<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, ImageOff, MoveHorizontal } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  alignSizes,
  changedBounds,
  cropToOverlap,
  describeDiff,
  diffPixels,
  ssim,
} from "@/tools/image-diff/index";
import type {
  AlignedSize,
  ChangedBounds,
  DiffResult,
  SsimResult,
  ViewMode,
} from "@/tools/image-diff/index";
import { downloadBlob } from "@/lib/download";
import { formatBytes } from "@/lib/format";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import OutputView from "../OutputView.vue";
import FileDrop from "../FileDrop.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the Perceptual Image Diff.
 *
 * The generic shell can only hand a tool one input, and a comparison needs two,
 * so this island owns the pair of drop zones, the decode to pixels, and the
 * viewer. Every measurement still comes from the pure layer in
 * `src/tools/image-diff/` (PROJECT.md rule 27): `alignSizes` and `cropToOverlap`
 * work out the shared region, `diffPixels` paints the highlight mask, `ssim`
 * scores the structure, `changedBounds` finds the bounding box, and
 * `describeDiff` writes the rows.
 *
 * The one thing this panel decides on its own is scale. Pictures are capped at
 * MAX_EDGE on the long edge, and both images are scaled by the same factor so a
 * pixel in one still lines up with the same pixel in the other. Nothing is ever
 * resampled to make two different sizes match: that is what the overlap crop in
 * the logic layer is for.
 *
 * Both images are decoded and compared on a canvas in this tab, so your files
 * and inputs never leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

type Zone = "before" | "after";

/** Longest edge the working canvases are capped at. */
const MAX_EDGE = 2000;
/** How long option changes settle before the comparison re-runs. */
const DEBOUNCE_MS = 250;

const ZONES: { key: Zone; label: string; hint: string }[] = [
  { key: "before", label: "Before", hint: "The baseline image." },
  { key: "after", label: "After", hint: "The image you are checking." },
];

const VIEWER_MODES: { value: "diff" | "slider" | "side"; label: string }[] = [
  { value: "diff", label: "Diff" },
  { value: "slider", label: "Slider" },
  { value: "side", label: "Side by side" },
];

/* ------------------------------------------------------------------ *
 * option specs, read from the meta so the panel and the shell agree
 * ------------------------------------------------------------------ */

function findNumber(id: string) {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && (found.kind === "number" || found.kind === "slider") ? found : null;
}

function findBoolean(id: string) {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && found.kind === "boolean" ? found : null;
}

const thresholdSpec = findNumber("threshold");
const T_DEFAULT = thresholdSpec?.default ?? 0.1;
const T_MIN = thresholdSpec?.min ?? 0.05;
const T_MAX = thresholdSpec?.max ?? 0.5;
const T_STEP = thresholdSpec?.step ?? 0.01;
const T_LABEL = thresholdSpec?.label ?? "Match threshold";

const aaSpec = findBoolean("includeAA");
const AA_DEFAULT = aaSpec?.default ?? false;
const AA_LABEL = aaSpec?.label ?? "Count anti-aliased pixels";

const viewSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "view");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "view",
    label: "Show",
    default: "both",
    options: [
      { value: "both", label: "Pixel diff and SSIM", synonyms: ["everything", "both measures"] },
      { value: "diff", label: "Pixel diff only", synonyms: ["pixelmatch", "changed pixels"] },
      { value: "ssim", label: "SSIM only", synonyms: ["structural similarity", "mssim"] },
    ],
  };
});

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface Slot {
  name: string;
  size: number;
  /** Object URL kept alive for the thumbnail, released on replace or unmount. */
  url: string;
  width: number;
  height: number;
}

const files = ref<Record<Zone, Slot | null>>({ before: null, after: null });
/** Which zone a paste lands in: whichever one was touched last. */

const threshold = ref(T_DEFAULT);
const includeAA = ref(AA_DEFAULT);
const view = ref<ViewMode>((viewSpec.value.default as ViewMode) ?? "both");

const mode = ref<"diff" | "slider" | "side">("diff");
/** Wipe position of the slider view, as a percentage from the left edge. */
const wipe = ref(50);

const rows = shallowRef<Record<string, string> | null>(null);
const bounds = shallowRef<ChangedBounds | null>(null);
const compared = ref<{ width: number; height: number } | null>(null);
const scale = ref(1);
const processing = ref(false);
const stage = ref("");
const ready = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);

const diffCanvas = ref<HTMLCanvasElement>();
const beforeCanvas = ref<HTMLCanvasElement>();
const afterCanvas = ref<HTMLCanvasElement>();

/**
 * Decoded images and pixel buffers are deliberately outside the reactive
 * system: Vue must never proxy a multi megabyte typed array.
 */
const decoded: Record<Zone, HTMLImageElement | null> = { before: null, after: null };
let lastDiff: DiffResult | null = null;
let lastSsim: SsimResult | null = null;
let lastAligned: AlignedSize | null = null;
/** Guards against a superseded comparison painting over a newer one. */
let seq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let wipeDragging = false;

const bothLoaded = computed(() => files.value.before !== null && files.value.after !== null);

const scaleNote = computed(() => {
  if (scale.value >= 1) return "";
  return `Both images were scaled to ${Math.round(scale.value * 100)} percent so the long edge fits ${MAX_EDGE} pixels. The same factor is used for both, so the comparison stays aligned.`;
});

const comparedNote = computed(() =>
  compared.value ? `${compared.value.width} by ${compared.value.height} pixels compared` : "",
);

/** Percentage box for the bounding-box outline drawn over the diff canvas. */
const boxStyle = computed(() => {
  const b = bounds.value;
  const c = compared.value;
  if (!b || !c || !b.found) return null;
  return {
    left: `${(b.x / c.width) * 100}%`,
    top: `${(b.y / c.height) * 100}%`,
    width: `${(b.width / c.width) * 100}%`,
    height: `${(b.height / c.height) * 100}%`,
  };
});

const downloadName = computed(() => {
  const strip = (n: string) => n.replace(/\.[^./\\]+$/, "") || "image";
  const a = strip(files.value.before?.name ?? "before");
  const b = strip(files.value.after?.name ?? "after");
  return `${a}-vs-${b}-diff.png`;
});

/* ------------------------------------------------------------------ *
 * file intake
 * ------------------------------------------------------------------ */

function releaseZone(zone: Zone) {
  const slot = files.value[zone];
  if (slot) URL.revokeObjectURL(slot.url);
  files.value[zone] = null;
  decoded[zone] = null;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function acceptFile(zone: Zone, file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image, so there is nothing to compare.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF in each of the two zones.",
    };
    return;
  }

  // Retire anything still in flight before the source pixels change.
  seq += 1;
  processing.value = false;
  error.value = null;

  const url = URL.createObjectURL(file);
  const img = await loadImage(url);

  if (!img || !img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    releaseZone(zone);
    error.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }

  releaseZone(zone);
  decoded[zone] = img;
  files.value[zone] = {
    name: file.name || "image",
    size: file.size,
    url,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };

  void compare();
}

/* Drop, pick and paste all arrive here, one zone at a time. FileDrop owns the
   single document paste listener for the page and hands the files to the zone
   focus is inside, so a pasted screenshot still lands where the user is. */
function onFiles(zone: Zone, files: File[]) {
  void acceptFile(zone, files[0]);
}

/* ------------------------------------------------------------------ *
 * the comparison
 * ------------------------------------------------------------------ */

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Draws an image at the working size and reads the pixels back. */
function rasterize(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function paint(
  canvas: HTMLCanvasElement | undefined,
  buf: Uint8ClampedArray,
  w: number,
  h: number,
) {
  if (!canvas) return;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(w, h);
  image.data.set(buf);
  ctx.putImageData(image, 0, 0);
}

function describe() {
  if (!lastDiff || !lastSsim || !lastAligned) return;
  rows.value = describeDiff(lastDiff, lastSsim, { aligned: lastAligned, view: view.value });
}

async function compare() {
  const a = decoded.before;
  const b = decoded.after;
  const sa = files.value.before;
  const sb = files.value.after;
  if (!a || !b || !sa || !sb) {
    rows.value = null;
    return;
  }

  const runId = (seq += 1);
  processing.value = true;
  stage.value = "Reading pixels";
  error.value = null;

  try {
    const longest = Math.max(sa.width, sa.height, sb.width, sb.height);
    const s = Math.min(1, MAX_EDGE / longest);
    scale.value = s;

    const aw = Math.max(1, Math.round(sa.width * s));
    const ah = Math.max(1, Math.round(sa.height * s));
    const bw = Math.max(1, Math.round(sb.width * s));
    const bh = Math.max(1, Math.round(sb.height * s));

    // Let the processing state paint before the synchronous passes begin.
    await nextFrame();
    await nextFrame();
    if (runId !== seq) return;

    const aPixels = rasterize(a, aw, ah);
    const bPixels = rasterize(b, bw, bh);
    if (!aPixels || !bPixels) {
      error.value = {
        message: "This browser would not give the page a 2D canvas.",
        fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
      };
      return;
    }

    const aligned = alignSizes(aw, ah, bw, bh);
    const aCrop = cropToOverlap(aPixels, aw, ah, aligned.width, aligned.height);
    const bCrop = cropToOverlap(bPixels, bw, bh, aligned.width, aligned.height);

    stage.value = "Comparing pixels";
    await nextFrame();
    if (runId !== seq) return;

    const diff = diffPixels(aCrop, bCrop, aligned.width, aligned.height, {
      threshold: threshold.value,
      includeAA: includeAA.value,
    });

    stage.value = "Scoring structure";
    await nextFrame();
    if (runId !== seq) return;

    const structural = ssim(aCrop, bCrop, aligned.width, aligned.height);
    if (runId !== seq) return;

    lastDiff = diff;
    lastSsim = structural;
    lastAligned = aligned;
    bounds.value = changedBounds(diff.mask, aligned.width, aligned.height);
    compared.value = { width: aligned.width, height: aligned.height };
    describe();

    ready.value = true;
    await nextTick();
    if (runId !== seq) return;
    paint(diffCanvas.value, diff.mask, aligned.width, aligned.height);
    paint(beforeCanvas.value, aCrop, aligned.width, aligned.height);
    paint(afterCanvas.value, bCrop, aligned.width, aligned.height);
  } catch (err) {
    rows.value = null;
    error.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : {
            message: err instanceof Error ? err.message : "Those two images could not be compared.",
            fix: "Try a different pair of files.",
          };
  } finally {
    if (runId === seq) {
      processing.value = false;
      stage.value = "";
    }
  }
}

function schedule() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void compare(), DEBOUNCE_MS);
}

function syncFragment() {
  writeFragment({
    opts: {
      threshold: String(threshold.value),
      includeAA: String(includeAA.value),
      view: view.value,
    },
  });
}

// A new threshold or anti-aliasing setting means the pixel pass has to run
// again. Changing which measures are shown only rewrites the rows.
watch([threshold, includeAA], () => {
  syncFragment();
  if (bothLoaded.value) schedule();
});

watch(view, () => {
  syncFragment();
  describe();
});

/* ------------------------------------------------------------------ *
 * the wipe handle
 * ------------------------------------------------------------------ */

function wipeFrom(e: PointerEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return;
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  wipe.value = Math.min(100, Math.max(0, pct));
}

function onWipeDown(e: PointerEvent) {
  if (mode.value !== "slider") return;
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
 * download
 * ------------------------------------------------------------------ */

function downloadDiff() {
  const canvas = diffCanvas.value;
  if (!canvas || processing.value) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, downloadName.value);
  }, "image/png");
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  const t = Number(state.opts["threshold"]);
  if (Number.isFinite(t) && t >= T_MIN && t <= T_MAX) threshold.value = t;
  if (state.opts["includeAA"] === "true") includeAA.value = true;
  const v = state.opts["view"];
  if (v === "diff" || v === "ssim" || v === "both") view.value = v;
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  seq += 1;
  releaseZone("before");
  releaseZone("after");
  lastDiff = null;
  lastSsim = null;
  lastAligned = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- the pair of drop zones -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <FileDrop
        v-for="zone in ZONES"
        :key="zone.key"
        accept="image/*"
        bare
        :label="zone.label"
        :hint="`${zone.hint} Drop it here, paste it, or pick a file.`"
        @files="(files: File[]) => onFiles(zone.key, files)"
      >
        <template #default="{ open }">
          <div class="flex flex-col gap-2 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                {{ zone.label }}
              </span>
              <Button variant="ghost" size="sm" @click="open"> Open file… </Button>
            </div>

            <div v-if="files[zone.key]" class="flex items-start gap-3">
              <img
                :src="files[zone.key]?.url"
                :alt="`${zone.label} image thumbnail`"
                class="h-16 w-16 rounded-[8px] border bg-card object-contain"
              />
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate font-mono text-xs" :title="files[zone.key]?.name">
                  {{ files[zone.key]?.name }}
                </span>
                <span class="text-xs text-muted-foreground tabular-nums">
                  {{ files[zone.key]?.width }} by {{ files[zone.key]?.height }} pixels
                </span>
                <span class="text-xs text-muted-foreground tabular-nums">
                  {{ formatBytes(files[zone.key]?.size ?? 0) }}
                </span>
              </div>
            </div>

            <p v-else class="text-sm text-muted-foreground">
              {{ zone.hint }} Drop it here, paste it, or pick a file.
            </p>
          </div>
        </template>
      </FileDrop>
    </div>

    <!-- options -->
    <div class="flex flex-wrap items-end gap-4">
      <div class="flex min-w-56 flex-1 flex-col gap-1.5">
        <!-- The slider's focusable element is its thumb, not the root, so this
             is plain text plus an aria-label rather than a <label for>
             pointing at something that cannot take focus. -->
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ T_LABEL }}: {{ threshold.toFixed(2) }}
        </span>
        <Slider
          :aria-label="T_LABEL"
          :model-value="[threshold]"
          :min="T_MIN"
          :max="T_MAX"
          :step="T_STEP"
          class="py-2"
          @update:model-value="(v) => (threshold = v?.[0] ?? threshold)"
        />
        <span class="text-xs text-muted-foreground">
          Smaller is stricter. Raise it when compression noise is lighting up areas you do not care
          about.
        </span>
      </div>

      <div class="flex items-center gap-2 pb-2.5">
        <Checkbox
          id="image-diff-aa"
          :model-value="includeAA"
          @update:model-value="(v) => (includeAA = v === true)"
        />
        <Label for="image-diff-aa" class="text-xs text-muted-foreground">{{ AA_LABEL }}</Label>
      </div>

      <div class="flex w-full flex-col gap-1.5 sm:w-60">
        <Label for="image-diff-view" class="text-xs text-muted-foreground">
          {{ viewSpec.label }}
        </Label>
        <SearchableSelect
          id="image-diff-view"
          :spec="viewSpec"
          :model-value="view"
          class="w-full bg-card"
          @update:model-value="(v: string) => (view = v as ViewMode)"
        />
      </div>
    </div>

    <!-- error -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- status -->
    <div v-if="processing" role="status" class="text-xs text-muted-foreground">
      {{ stage }}… Large images take a moment.
    </div>

    <p v-if="!bothLoaded && !error" class="flex items-center gap-2 text-xs text-muted-foreground">
      <ImageOff class="size-3.5" aria-hidden="true" />
      Load both images to run the comparison. Pictures larger than {{ MAX_EDGE }} pixels on the long
      edge are scaled down first, both by the same factor.
    </p>

    <!-- report -->
    <OutputView v-if="rows" :output="rows" />

    <!-- viewer -->
    <div v-show="ready" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Viewer"
          class="inline-flex gap-0.5 rounded-[10px] bg-secondary p-0.5 shadow-[var(--sh-inset)]"
        >
          <Button
            v-for="m in VIEWER_MODES"
            :key="m.value"
            size="sm"
            :variant="mode === m.value ? 'default' : 'ghost'"
            :aria-pressed="mode === m.value"
            @click="mode = m.value"
          >
            {{ m.label }}
          </Button>
        </div>

        <Button variant="outline" size="sm" :disabled="processing" @click="downloadDiff">
          <Download class="size-3.5" aria-hidden="true" />
          Download diff PNG
        </Button>
      </div>

      <p v-if="scaleNote" class="text-xs text-muted-foreground">{{ scaleNote }}</p>
      <p v-if="comparedNote" class="text-xs text-muted-foreground tabular-nums">
        {{ comparedNote }}
      </p>

      <!-- diff mask, with the bounding box of everything that changed -->
      <figure v-show="mode === 'diff'" class="relative flex flex-col gap-1.5">
        <figcaption class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Diff mask
        </figcaption>
        <div class="relative">
          <canvas
            ref="diffCanvas"
            class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
            :class="processing ? 'opacity-60' : ''"
          />
          <div
            v-if="boxStyle"
            class="pointer-events-none absolute border border-primary ring-1 ring-background"
            :style="boxStyle"
            aria-hidden="true"
          />
        </div>
        <p class="text-xs text-muted-foreground">
          Red is a real difference, yellow is an edge that looks like anti-aliasing, and the violet
          outline is the bounding box of everything that changed.
        </p>
      </figure>

      <!-- before and after, either wiped or side by side -->
      <div
        v-show="mode !== 'diff'"
        :class="
          mode === 'slider'
            ? 'relative touch-none select-none'
            : 'grid grid-cols-1 gap-3 sm:grid-cols-2'
        "
        @pointerdown="onWipeDown"
        @pointermove="onWipeMove"
        @pointerup="onWipeUp"
        @pointercancel="onWipeUp"
      >
        <figure :class="mode === 'slider' ? 'order-2 m-0' : 'order-2 flex flex-col gap-1.5'">
          <figcaption
            v-show="mode !== 'slider'"
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            After
          </figcaption>
          <canvas
            ref="afterCanvas"
            class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
          />
        </figure>

        <figure
          :class="
            mode === 'slider' ? 'absolute inset-0 order-1 m-0' : 'order-1 flex flex-col gap-1.5'
          "
          :style="mode === 'slider' ? { clipPath: `inset(0 ${100 - wipe}% 0 0)` } : undefined"
        >
          <figcaption
            v-show="mode !== 'slider'"
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Before
          </figcaption>
          <canvas
            ref="beforeCanvas"
            :class="
              mode === 'slider'
                ? 'absolute inset-0 h-full w-full rounded-[10px]'
                : 'block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]'
            "
          />
        </figure>

        <template v-if="mode === 'slider'">
          <span
            class="pointer-events-none absolute top-2 left-2 rounded-[8px] bg-card/85 px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          >
            Before
          </span>
          <span
            class="pointer-events-none absolute top-2 right-2 rounded-[8px] bg-card/85 px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          >
            After
          </span>
          <div
            class="absolute inset-y-0 z-10 w-px bg-primary"
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
            class="absolute top-1/2 z-10 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border bg-card text-muted-foreground shadow-[var(--sh-md)]"
            :style="{ left: `${wipe}%` }"
            @keydown="onWipeKey"
          >
            <MoveHorizontal class="size-4" aria-hidden="true" />
          </div>
        </template>
      </div>

      <p v-if="mode === 'slider'" class="text-xs text-muted-foreground">
        Drag the handle to wipe between the two images, or focus it and use the arrow keys.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      {{
        props.meta.privacyNote ??
        "Both images are decoded and compared on a canvas in this tab: your files and inputs never leave your device."
      }}
    </p>
  </div>
</template>
