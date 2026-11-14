<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Dices, Download, RotateCcw, Sparkles } from "lucide-vue-next";
import type { OptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  addToHistogram,
  backgroundColor,
  buildPalette,
  createHistogram,
  createMapper,
  encodeLoadingGif,
  formatSeconds,
  prepareFrame,
  quantizeFrame,
  randomSeed,
  readSettings,
  type DialUpOpts,
  type Palette,
} from "@/tools/dial-up-loading-gif/index";
import { flattenSelectOptions } from "@/lib/select-options";
import { coerceOpts, readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import OptionControl from "../OptionControl.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import ProgressBar from "../ProgressBar.vue";
import EmptyState from "../EmptyState.vue";

/**
 * Dial-up loading GIF maker.
 *
 * The panel's job is the part the pure logic cannot do: decode a picture into
 * RGBA. A still goes through an <img> and a canvas. An animated GIF, APNG or
 * WebP goes through ImageDecoder, which hands back fully composited frames and
 * their durations; where the browser has no ImageDecoder only the first frame
 * is used and a notice says so.
 *
 * Frames are streamed through the logic layer twice (once to count colors,
 * once to map them onto the palette) so a long animation never sits in memory
 * as raw RGBA. The quantized frames are cached, because they depend only on
 * the picture, the width, the background and dithering. Moving the timing
 * controls therefore only re-runs the encoder, which is what keeps the preview
 * live.
 *
 * Nothing here touches the network: the file is read in this tab and the GIF
 * is written in this tab, so your files and inputs never leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/** Index bytes (one per pixel per source frame) the cache may hold. */
const MAX_INDEX_BYTES = 64_000_000;
const MAX_SOURCE_FRAMES = 400;
const DEBOUNCE_MS = 180;

/* ------------------------------------------------------------------ *
 * options, driven by the meta schema
 * ------------------------------------------------------------------ */

const specs = computed<OptionSpec[]>(() => props.meta.options ?? []);

function defaultOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs.value) out[spec.id] = spec.default;
  return out;
}

const opts = ref<Record<string, unknown>>(defaultOpts());

/** Used while the seed box is empty, so a render is still reproducible. */
const autoSeed = ref(randomSeed());

function setOpt(id: string, value: unknown) {
  opts.value = { ...opts.value, [id]: value };
}

/**
 * Every value clamped to what its control allows. A half typed number or a
 * hand edited link must never reach the encoder as an out of range value.
 */
function safeOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs.value) {
    const value = opts.value[spec.id];
    if (spec.kind === "number" || spec.kind === "slider") {
      const n = Number(value);
      const min = spec.min ?? -Infinity;
      const max = spec.max ?? Infinity;
      out[spec.id] =
        value === "" || value === null || !Number.isFinite(n)
          ? spec.default
          : Math.min(max, Math.max(min, n));
    } else if (spec.kind === "boolean") {
      out[spec.id] = value !== false;
    } else if (spec.kind === "select") {
      const allowed = flattenSelectOptions(spec).some((o) => o.value === value);
      out[spec.id] = allowed ? value : spec.default;
    } else {
      out[spec.id] = typeof value === "string" ? value.slice(0, 64) : spec.default;
    }
  }
  return out;
}

function effectiveSeed(): string {
  const typed = String(safeOpts().seed ?? "").trim();
  return typed || autoSeed.value;
}

/* ------------------------------------------------------------------ *
 * decoding
 * ------------------------------------------------------------------ */

interface Source {
  name: string;
  width: number;
  height: number;
  frameCount: number;
  /** Paint frame `index` over the whole canvas; resolves to its length in ms. */
  draw(index: number, ctx: CanvasRenderingContext2D, w: number, h: number): Promise<number>;
  close(): void;
}

let source: Source | null = null;
const sourceInfo = ref<{ name: string; width: number; height: number; frames: number } | null>(
  null,
);
const notice = ref("");

async function openAnimated(file: File): Promise<Source | null> {
  if (typeof ImageDecoder === "undefined" || !file.type) return null;
  try {
    if (!(await ImageDecoder.isTypeSupported(file.type))) return null;
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 2) {
      decoder.close();
      return null;
    }
    const first = await decoder.decode({ frameIndex: 0 });
    const width = first.image.displayWidth;
    const height = first.image.displayHeight;
    first.image.close();
    return {
      name: file.name,
      width,
      height,
      frameCount: track.frameCount,
      async draw(index, ctx, w, h) {
        const { image } = await decoder.decode({ frameIndex: index });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(image, 0, 0, w, h);
        const ms = (image.duration ?? 0) / 1000;
        image.close();
        return ms;
      },
      close: () => decoder.close(),
    };
  } catch {
    // Anything ImageDecoder cannot open falls through to the still path.
    return null;
  }
}

function openStill(file: Blob, name: string): Promise<Source> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        name,
        width: image.naturalWidth || 300,
        height: image.naturalHeight || 150,
        frameCount: 1,
        draw(_index, ctx, w, h) {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(image, 0, 0, w, h);
          return Promise.resolve(0);
        },
        close: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new ToolError(
          "decode-failed",
          `${name || "That file"} could not be read as an image.`,
          "Use a PNG, JPEG, WebP, GIF, AVIF or SVG file.",
        ),
      );
    };
    image.src = url;
  });
}

async function adopt(file: File) {
  runSeq += 1;
  error.value = null;
  notice.value = "";
  if (file.type && !file.type.startsWith("image/")) {
    error.value = new ToolError(
      "not-an-image",
      `${file.name || "That file"} is not an image, so there is nothing to load in.`,
      "Use a PNG, JPEG, WebP, GIF, AVIF or SVG file.",
    );
    return;
  }

  let next: Source;
  try {
    next = (await openAnimated(file)) ?? (await openStill(file, file.name));
  } catch (err) {
    error.value = asToolError(err);
    return;
  }

  source?.close();
  source = next;
  prepared = null;
  const notes: string[] = [];
  if (
    typeof ImageDecoder === "undefined" &&
    ["image/gif", "image/webp", "image/apng"].includes(file.type)
  ) {
    notes.push(
      "This browser cannot read animation frames, so if this picture is animated only its first frame is used.",
    );
  }
  if (next.frameCount > MAX_SOURCE_FRAMES) {
    notes.push(
      `This animation has ${next.frameCount} frames. Only the first ${MAX_SOURCE_FRAMES} are used.`,
    );
  }
  notice.value = notes.join(" ");
  sourceInfo.value = {
    name: next.name,
    width: next.width,
    height: next.height,
    frames: Math.min(next.frameCount, MAX_SOURCE_FRAMES),
  };
  await render();
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) void adopt(file);
}

async function loadSample() {
  try {
    const response = await fetch("/samples/sample-photo.jpg");
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await adopt(new File([blob], "sample-photo.jpg", { type: "image/jpeg" }));
  } catch {
    error.value = new ToolError(
      "sample-failed",
      "The sample picture could not be loaded.",
      "Check your connection, or drop a picture of your own.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

interface Prepared {
  key: string;
  width: number;
  height: number;
  frames: Uint8Array[];
  delays: number[];
  palette: Palette;
}

/** Thrown through the encoder when a newer render has started. */
class Superseded extends Error {}

let prepared: Prepared | null = null;
let runSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let gifBlob: Blob | null = null;

const error = ref<ToolError | null>(null);
const busy = ref(false);
const progress = ref<number | undefined>(undefined);
const stage = ref("");
const gifUrl = ref("");
const result = ref<{
  width: number;
  height: number;
  frames: number;
  totalMs: number;
  bytes: number;
  fullFrames: boolean;
} | null>(null);

function asToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError(
    "failed",
    err instanceof Error && err.message ? err.message : "The GIF could not be built.",
    "Try a smaller maximum width, or a different picture.",
  );
}

/** Lets the page paint and stay responsive during a long encode. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function prepare(seq: number, key: string, width: number, height: number): Promise<Prepared> {
  const active = source!;
  const settings = readSettings(safeOpts() as DialUpOpts);
  const background = backgroundColor(settings.background);
  const count = Math.min(active.frameCount, MAX_SOURCE_FRAMES);

  if (width * height * count > MAX_INDEX_BYTES) {
    throw new ToolError(
      "too-large",
      `${count} frames at ${width} by ${height} pixels is more than this tab can comfortably hold.`,
      "Lower the maximum width and it will fit.",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new ToolError(
      "no-canvas",
      "This browser would not provide a canvas to read the picture with.",
      "Close other heavy tabs and reload, or try another browser.",
    );
  }
  ctx.imageSmoothingQuality = "high";

  const read = async (index: number) => {
    const ms = await active.draw(index, ctx, width, height);
    if (seq !== runSeq) throw new Superseded();
    const pixels = ctx.getImageData(0, 0, width, height).data;
    prepareFrame(pixels, background);
    return { pixels, ms };
  };

  // Pass one: count colors across the whole animation for one shared palette.
  const hist = createHistogram();
  const stride = Math.max(1, Math.ceil((width * height * count) / 3_000_000));
  const delays: number[] = [];
  let only: Uint8ClampedArray | null = null;
  let last = performance.now();
  for (let i = 0; i < count; i += 1) {
    const { pixels, ms } = await read(i);
    addToHistogram(hist, pixels, stride);
    delays.push(ms);
    if (count === 1) only = pixels;
    if (performance.now() - last > 40) {
      stage.value = "Reading frames";
      progress.value = ((i + 1) / count) * 40;
      await breathe();
      last = performance.now();
    }
  }
  const palette = buildPalette(hist, { background });
  const mapper = createMapper(palette);

  // Pass two: map every frame onto that palette.
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const pixels = only ?? (await read(i)).pixels;
    frames.push(quantizeFrame(pixels, width, height, palette, mapper, settings.dither));
    if (performance.now() - last > 40) {
      stage.value = "Picking colors";
      progress.value = 40 + ((i + 1) / count) * 30;
      await breathe();
      last = performance.now();
    }
  }
  if (seq !== runSeq) throw new Superseded();
  return { key, width, height, frames, delays, palette };
}

async function render() {
  if (!source) return;
  const seq = ++runSeq;
  error.value = null;
  busy.value = true;
  progress.value = undefined;
  stage.value = "Building GIF";

  try {
    const safe = safeOpts();
    const settings = readSettings({ ...(safe as DialUpOpts), seed: effectiveSeed() });
    const width = Math.max(1, Math.min(Math.round(Number(safe.width)), source.width));
    const height = Math.max(1, Math.round((source.height * width) / source.width));
    const key = `${width}|${settings.dither}|${settings.background}`;

    await breathe();
    if (seq !== runSeq) return;
    if (!prepared || prepared.key !== key) {
      prepared = null;
      prepared = await prepare(seq, key, width, height);
    }
    const ready = prepared;

    let last = performance.now();
    const made = await encodeLoadingGif(
      {
        width: ready.width,
        height: ready.height,
        frames: ready.frames,
        frameDelaysMs: ready.delays,
        palette: ready.palette,
        settings,
      },
      async (done, total) => {
        if (performance.now() - last < 40) return;
        if (seq !== runSeq) throw new Superseded();
        stage.value = "Writing frames";
        progress.value = 70 + (done / total) * 30;
        await breathe();
        last = performance.now();
        if (seq !== runSeq) throw new Superseded();
      },
    );
    if (seq !== runSeq) return;

    gifBlob = new Blob([made.bytes.slice().buffer], { type: "image/gif" });
    showBlob();
    result.value = {
      width: ready.width,
      height: ready.height,
      frames: made.frameCount,
      totalMs: made.totalMs,
      bytes: made.bytes.length,
      fullFrames: made.fullFrames,
    };
    syncFragment();
  } catch (err) {
    if (err instanceof Superseded || seq !== runSeq) return;
    error.value = asToolError(err);
  } finally {
    if (seq === runSeq) busy.value = false;
  }
}

/** A fresh object URL restarts the animation from its first frame. */
function showBlob() {
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value);
  gifUrl.value = gifBlob ? URL.createObjectURL(gifBlob) : "";
}

function reroll() {
  setOpt("seed", randomSeed());
}

function download() {
  if (!gifBlob) return;
  const base = (sourceInfo.value?.name ?? "image").replace(/\.[^.]+$/, "") || "image";
  downloadBlob(gifBlob, `${base}-dial-up.gif`);
}

const summary = computed(() => {
  const r = result.value;
  if (!r) return [];
  return [
    `${r.width} by ${r.height} pixels`,
    `${r.frames} ${r.frames === 1 ? "frame" : "frames"}`,
    `${formatSeconds(r.totalMs)} per loop`,
    formatBytes(r.bytes),
  ];
});

/* ------------------------------------------------------------------ *
 * fragment and watchers
 * ------------------------------------------------------------------ */

/** Settings are shareable; the picture is not, so it never reaches the URL. */
function syncFragment() {
  const safe = safeOpts();
  const out: Record<string, string> = {};
  for (const spec of specs.value) out[spec.id] = String(safe[spec.id]);
  out.seed = effectiveSeed();
  writeFragment({ opts: out });
}

/**
 * Nothing is assigned unless the fragment actually carried something:
 * replacing `opts` wakes the watcher, and a pristine page load would otherwise
 * stamp the defaults into the URL before the visitor has touched a control.
 * `safeOpts` clamps whatever a stale or hand edited link put there.
 */
function applyFragment() {
  const found = coerceOpts(specs.value, readFragment().opts);
  if (Object.keys(found).length > 0) opts.value = { ...opts.value, ...found };
}

watch(
  opts,
  () => {
    syncFragment();
    if (!source) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void render(), DEBOUNCE_MS);
  },
  { deep: true },
);

onMounted(applyFragment);

onUnmounted(() => {
  clearTimeout(debounceTimer);
  runSeq += 1;
  source?.close();
  source = null;
  prepared = null;
  gifBlob = null;
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- input -->
    <FileDrop
      accept="image/*"
      label="Drop an image here or click to choose"
      hint="Still or animated: PNG, JPEG, WebP, GIF, APNG, AVIF. The GIF is built in this tab: your files and inputs never leave your device."
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
    <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="spec in specs" :key="spec.id" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="spec"
          :model-value="opts[spec.id]"
          @update:model-value="(value: unknown) => setOpt(spec.id, value)"
        />
      </div>
    </div>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />
    <ErrorBanner v-if="notice" variant="info" :message="notice" />

    <!-- output -->
    <EmptyState
      v-if="!sourceInfo"
      icon="Hourglass"
      title="No picture yet"
      hint="Drop an image above, paste one, or load the sample to watch it crawl in."
    />

    <div v-else class="flex flex-col gap-3">
      <div
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground"
      >
        <span class="font-mono">{{ sourceInfo.name }}</span>
        <span aria-hidden="true">·</span>
        <span>
          {{ sourceInfo.width }} by {{ sourceInfo.height }} pixels<template
            v-if="sourceInfo.frames > 1"
            >, {{ sourceInfo.frames }} frames</template
          >
        </span>
        <template v-for="part in summary" :key="part">
          <span aria-hidden="true">·</span>
          <span>{{ part }}</span>
        </template>
      </div>

      <div class="min-h-5">
        <ProgressBar v-if="busy" :value="progress" :label="stage" size="sm" />
      </div>

      <figure
        v-if="gifUrl"
        class="m-0 flex justify-center overflow-hidden rounded-[12px] border bg-secondary p-3"
      >
        <img
          :src="gifUrl"
          :width="result?.width"
          :height="result?.height"
          alt="Preview of the loading GIF"
          class="h-auto max-h-[70vh] max-w-full"
        />
      </figure>

      <div v-if="gifUrl" class="flex flex-wrap items-center gap-2">
        <Button size="sm" @click="download">
          <Download class="size-3.5" aria-hidden="true" />
          Download GIF
        </Button>
        <Button variant="outline" size="sm" @click="reroll">
          <Dices class="size-3.5" aria-hidden="true" />
          Reroll
        </Button>
        <Button variant="ghost" size="sm" @click="showBlob">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Replay
        </Button>
      </div>

      <p v-if="result?.fullFrames" class="text-xs text-muted-foreground">
        Some pixels turn clear again partway through this GIF, so every frame is stored whole and
        the file is larger. Pick a solid color for the unloaded area to shrink it.
      </p>
    </div>
  </div>
</template>
