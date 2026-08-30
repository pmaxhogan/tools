<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Check, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  FORMATS,
  LANGUAGES,
  LOW_CONFIDENCE,
  collectWords,
  confidenceSummary,
  formatResult,
  type OcrPage,
} from "@/tools/image-to-text/index";
import { shouldAutoDownload, isMetered, onConnectionChange } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for the OCR tool.
 *
 * The generic ToolShell cannot host this one: recognition needs a WebAssembly
 * worker that is downloaded on demand, reports progress while it runs, and has
 * to be torn down when the language changes. The pure layer in
 * `src/tools/image-to-text/` owns every transformation of the result, and this
 * file owns only the engine, the image, and the canvas overlay.
 *
 * Engine wiring, all three paths pinned so nothing is ever fetched from a CDN:
 *   corePath   the exact core file, not its directory. Given a directory,
 *              tesseract.js appends a relaxed-SIMD filename that this site does
 *              not stage.
 *   workerPath the worker script on this origin, with workerBlobURL off. A blob
 *              wrapped worker reports a blob: URL as its own location, and the
 *              emscripten glue resolves the sibling .wasm against exactly that,
 *              so the core would fail to find its wasm.
 *   langPath   the staged .traineddata.gz packs.
 *
 * Nothing runs at import time, so the component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

type TesseractModule = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;

const CORE_PATH = "/tesseract/tesseract-core-simd-lstm.js";
const WORKER_PATH = "/tesseract/worker.min.js";
const LANG_PATH = "/tesseract/lang";
/** The core wasm, rounded from the staged file. Shown before anything downloads. */
const CORE_MB = 2.9;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps the capability check off the server. */
const supported = ref(false);

const file = shallowRef<File | null>(null);
const fileName = ref("");
const imageUrl = ref<string | null>(null);
const imageEl = ref<HTMLImageElement>();
const overlayEl = ref<HTMLCanvasElement>();
const naturalWidth = ref(0);
const naturalHeight = ref(0);

type EngineState = "idle" | "loading" | "ready";
const engineState = ref<EngineState>("idle");
/** Sticky once the engine has been fetched once, so the button can say restart. */
const engineFetched = ref(false);
const running = ref(false);

/** True when a metered or Save-Data connection is holding the auto-start back. */
const metered = ref(false);
/** Consumed once by the connection listener if a metered link turns unmetered. */
let pendingAutoStart = false;
let stopConnectionWatch: () => void = () => {};

/** Latest logger tick: tesseract reports a status string and 0 to 1 progress. */
const status = ref("");
const progress = ref(0);

const result = shallowRef<OcrPage | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const language = ref("eng");
const format = ref("text");
const preserveLayout = ref(false);
const showBoxes = ref(false);

// The language and format dropdowns are built from the tool's own constant
// tables, so each option carries the download size (language) and real search
// synonyms for the shared searchable-select.
const languageSpec: SelectOptionSpec = {
  kind: "select",
  id: "ocr-language",
  label: "Language",
  default: "eng",
  options: Object.entries(LANGUAGES).map(([code, pack]) => ({
    value: code,
    label: `${pack.name} (${pack.megabytes} MB)`,
    synonyms: [pack.name.toLowerCase(), code],
  })),
};

const FORMAT_SYNONYMS: Record<string, string[]> = {
  text: ["plain", "txt", "raw"],
  blocks: ["confidence", "layout", "structured"],
  tsv: ["tab separated", "positions", "coordinates", "spreadsheet"],
};

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "ocr-format",
  label: "Output format",
  default: "text",
  options: Object.entries(FORMATS).map(([value, label]) => ({
    value,
    label,
    synonyms: FORMAT_SYNONYMS[value] ?? [label.toLowerCase()],
  })),
};

/** The worker is not reactive: Vue must never proxy a postMessage bridge. */
let worker: TesseractWorker | null = null;
/** Which pack the live worker holds, so a language switch knows to rebuild. */
let workerLanguage = "";
/** Bumped on every teardown so a slow load cannot resurrect a dead engine. */
let generation = 0;
let modulePromise: Promise<TesseractModule> | null = null;

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const languageName = computed(() => LANGUAGES[language.value]?.name ?? language.value);
const languageMb = computed(() => LANGUAGES[language.value]?.megabytes ?? 0);

/** Engine core plus the selected language pack, rounded for the button copy. */
const engineTotalMb = computed(() => Math.round(CORE_MB + languageMb.value));

const engineButtonLabel = computed(() => {
  if (engineFetched.value) return "Reload OCR engine";
  return metered.value ? `Load OCR engine (about ${engineTotalMb.value} MB)` : "Load OCR engine";
});

const hasImage = computed(() => file.value !== null);
const canRun = computed(
  () => supported.value && hasImage.value && engineState.value === "ready" && !running.value,
);

const words = computed(() => collectWords(result.value));
const summary = computed(() => (result.value ? confidenceSummary(words.value) : null));

const output = computed(() => {
  if (!result.value) return "";
  return formatResult(
    result.value,
    { format: format.value, preserveLayout: preserveLayout.value },
    naturalWidth.value,
  );
});

const outputEmpty = computed(() => result.value !== null && output.value.trim().length === 0);

const downloadName = computed(() => {
  const base = fileName.value.replace(/\.[^.]+$/, "") || "extracted-text";
  return `${base}.${format.value === "tsv" ? "tsv" : "txt"}`;
});

const progressPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round(progress.value * 100))),
);

const verdictClass = computed(() => {
  const verdict = summary.value?.verdict;
  if (verdict === "great") return "text-[var(--positive)]";
  if (verdict === "poor") return "text-destructive";
  return "text-muted-foreground";
});

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function describeError(e: unknown): { message: string; fix?: string } {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (/fetch|network|failed to load|404/i.test(raw)) {
    return {
      message: `The OCR engine could not be downloaded: ${raw}`,
      fix: "Check your connection and press Load OCR engine again. The engine and the language pack are both served from this site.",
    };
  }
  return {
    message: raw || "The OCR engine stopped without saying why.",
    fix: "Press Reload OCR engine and try the image again. If it keeps failing, a smaller image often gets through where a very large one does not.",
  };
}

function loadModule(): Promise<TesseractModule> {
  // Imported here rather than at module scope so the OCR library stays out of
  // the page bundle until a visitor actually asks for the engine.
  modulePromise ??= import("tesseract.js").then((mod) => {
    const cjs = (mod as unknown as { default?: TesseractModule }).default;
    return cjs?.createWorker ? cjs : (mod as unknown as TesseractModule);
  });
  return modulePromise;
}

async function destroyWorker() {
  const dying = worker;
  worker = null;
  workerLanguage = "";
  generation += 1;
  if (!dying) return;
  try {
    await dying.terminate();
  } catch {
    // Terminating a half dead worker is not worth surfacing.
  }
}

/* ---------------------------------------------------------------- */
/* engine                                                            */
/* ---------------------------------------------------------------- */

/**
 * Starts the engine download without a click on first visit, unless the
 * connection is metered or Save-Data. When it is, the panel keeps a one-tap
 * start and remembers to auto-start later if the link turns unmetered.
 */
function autoStartEngine() {
  if (engineState.value !== "idle") return;
  if (shouldAutoDownload()) {
    void loadEngine();
  } else {
    metered.value = true;
    pendingAutoStart = true;
  }
}

async function loadEngine() {
  // A press (or the automatic start) commits to the download, so drop any hold.
  pendingAutoStart = false;
  // Deliberately re-entrant: switching language mid load has to win. The
  // generation bump inside destroyWorker invalidates the load already in
  // flight, and its worker is terminated the moment it resolves.
  await destroyWorker();
  // terminate() never rejects the jobs already queued on the dead worker, so a
  // recognize that was in flight is suspended forever and its own cleanup can
  // never run. The run flag is cleared here instead, or the button would sit on
  // "Working…" until the page reloaded.
  running.value = false;
  const token = generation;

  engineState.value = "loading";
  status.value = "starting the engine";
  progress.value = 0;
  error.value = null;

  try {
    const { createWorker, OEM } = await loadModule();
    const created = await createWorker(language.value, OEM.LSTM_ONLY, {
      corePath: CORE_PATH,
      workerPath: WORKER_PATH,
      langPath: LANG_PATH,
      // See the header note: a blob wrapped worker cannot find the core wasm.
      workerBlobURL: false,
      logger: (message) => {
        if (token !== generation) return;
        status.value = message.status ?? "";
        progress.value = Number.isFinite(message.progress) ? message.progress : 0;
      },
      // Without this, tesseract.js rethrows worker failures out of a message
      // handler, where nothing on this page could ever catch them.
      errorHandler: (e: unknown) => {
        if (token !== generation) return;
        error.value = describeError(e);
        running.value = false;
      },
    });

    if (token !== generation) {
      await created.terminate();
      return;
    }

    worker = created;
    workerLanguage = language.value;
    engineFetched.value = true;
    engineState.value = "ready";
    status.value = "";
    progress.value = 0;
  } catch (e) {
    if (token !== generation) return;
    engineState.value = "idle";
    status.value = "";
    error.value = describeError(e);
  }
}

/* ---------------------------------------------------------------- */
/* recognition                                                       */
/* ---------------------------------------------------------------- */

async function extract() {
  const image = file.value;
  if (!image || !worker || running.value) return;
  const token = generation;

  running.value = true;
  status.value = "recognizing text";
  progress.value = 0;
  error.value = null;

  try {
    // Tesseract keeps parameters on the worker between runs, so both states are
    // written explicitly: toggling the option off has to actually turn it off.
    await worker.setParameters({
      preserve_interword_spaces: preserveLayout.value ? "1" : "0",
    });
    // `blocks` is off by default, and it is the only source of the word boxes
    // the overlay, the TSV, and the layout rebuild all read.
    const recognized = await worker.recognize(image, {}, { text: true, blocks: true });
    if (token !== generation) return;
    result.value = recognized.data as unknown as OcrPage;
    await nextTick();
    drawBoxes();
  } catch (e) {
    if (token !== generation) return;
    result.value = null;
    error.value = describeError(e);
  } finally {
    if (token === generation) {
      running.value = false;
      status.value = "";
      progress.value = 0;
    }
  }
}

/* ---------------------------------------------------------------- */
/* overlay                                                           */
/* ---------------------------------------------------------------- */

/** Green above 85, amber down to the low confidence threshold, red below it. */
function boxColor(confidence: number): string {
  if (confidence >= 85) return "rgba(22, 163, 74, 0.9)";
  if (confidence >= LOW_CONFIDENCE) return "rgba(217, 119, 6, 0.9)";
  return "rgba(220, 38, 38, 0.95)";
}

/**
 * Strokes every word box onto a canvas sized to the image's own pixels, which
 * CSS then scales to whatever the preview is showing. Drawing in source pixels
 * means the boxes stay aligned at any display size.
 */
function drawBoxes() {
  const canvas = overlayEl.value;
  if (!canvas) return;
  const width = naturalWidth.value;
  const height = naturalHeight.value;
  if (width <= 0 || height <= 0) return;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (!showBoxes.value) return;

  // One pixel at display size, whatever the image's own resolution is.
  ctx.lineWidth = Math.max(1, Math.round(width / 700));
  for (const word of words.value) {
    const box = word.bbox;
    if (!box) continue;
    ctx.strokeStyle = boxColor(word.confidence ?? 0);
    ctx.strokeRect(box.x0, box.y0, Math.max(1, box.x1 - box.x0), Math.max(1, box.y1 - box.y0));
  }
}

/* ---------------------------------------------------------------- */
/* input                                                             */
/* ---------------------------------------------------------------- */

function revoke() {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = null;
}

function acceptFile(candidate: File | null | undefined) {
  if (!candidate) return;
  if (candidate.type && !candidate.type.startsWith("image/")) {
    error.value = {
      message: `${candidate.name || "That file"} is not an image, so there is nothing to recognize.`,
      fix: "Drop a PNG, JPEG, WebP, GIF, or BMP. For a PDF, export the page as an image first.",
    };
    return;
  }
  revoke();
  file.value = candidate;
  fileName.value = candidate.name || "pasted-image.png";
  imageUrl.value = URL.createObjectURL(candidate);
  result.value = null;
  error.value = null;
  naturalWidth.value = 0;
  naturalHeight.value = 0;
}

function onImageLoad() {
  const img = imageEl.value;
  if (!img) return;
  naturalWidth.value = img.naturalWidth || img.width;
  naturalHeight.value = img.naturalHeight || img.height;
  drawBoxes();
}

function onFiles(files: File[]) {
  acceptFile(files[0]);
}

function clearImage() {
  revoke();
  file.value = null;
  fileName.value = "";
  result.value = null;
  error.value = null;
  naturalWidth.value = 0;
  naturalHeight.value = 0;
}

function download() {
  downloadText(output.value, downloadName.value);
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

/** A language switch cannot be applied in place: the pack is baked into the worker. */
watch(language, () => {
  if (engineState.value === "idle") return;
  if (workerLanguage === language.value) return;
  result.value = null;
  loadEngine();
});

watch([showBoxes, result], () => {
  nextTick(drawBoxes);
});

onMounted(() => {
  supported.value = typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";
  if (!supported.value) return;
  metered.value = isMetered();
  autoStartEngine();
  stopConnectionWatch = onConnectionChange(() => {
    metered.value = isMetered();
    if (pendingAutoStart && shouldAutoDownload()) {
      pendingAutoStart = false;
      autoStartEngine();
    }
  });
});

onUnmounted(() => {
  stopConnectionWatch();
  revoke();
  destroyWorker();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      bare
      accept="image/*"
      label="Image"
      hint="Drop a screenshot or photo here or click to choose one"
      @files="onFiles"
    >
      <template #default="{ open }">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Image
          </span>
          <Button variant="ghost" size="sm" @click="open"> Open file… </Button>
        </div>

        <div v-if="hasImage" class="px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span v-if="file" class="shrink-0 text-muted-foreground">{{
              formatBytes(file.size)
            }}</span>
            <button
              type="button"
              aria-label="Remove image"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearImage"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <div v-else class="px-3 pt-1 pb-4">
          <p class="text-sm text-muted-foreground">
            Drop a screenshot or photo here, click to choose one, or press Ctrl+V to paste one
            straight from the clipboard. Everything runs in this tab: your files and inputs never
            leave your device.
          </p>
          <p class="mt-2 text-xs text-muted-foreground">
            Tesseract reads flat, level text well and struggles with anything else. A phone photo
            taken at an angle, a curved page, or a rotated scan will come back garbled, so
            straighten and crop the image before you run it and keep the text as large as you can.
          </p>
        </div>
      </template>
    </FileDrop>

    <!-- Unsupported browser -->
    <p
      v-if="!supported"
      class="rounded-[10px] bg-secondary px-3 py-4 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
    >
      This browser cannot run the OCR engine, which needs WebAssembly and web workers. Use a current
      version of Chrome, Edge, Firefox, or Safari.
    </p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- Engine -->
    <template v-if="supported">
      <div
        v-if="engineState !== 'ready'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          OCR engine
        </span>

        <p class="text-sm text-muted-foreground">
          This tool runs Tesseract inside your browser. Loading it downloads about
          {{ CORE_MB }} MB of engine plus the {{ languageName }} language pack, roughly
          {{ languageMb }} MB, and your browser keeps both afterwards so later visits start from the
          cache. It downloads automatically the first time, except on a metered connection, and
          nothing is uploaded: your files and inputs never leave your device.
        </p>

        <p v-if="metered && engineState === 'idle'" class="text-xs text-muted-foreground">
          Your connection looks metered, so the engine waits for you to start it.
        </p>

        <ProgressBar
          v-if="engineState === 'loading'"
          :value="progressPercent"
          :label="status || 'starting the engine'"
          :detail="`${progressPercent}%`"
          track="card"
        />

        <Button v-else class="self-start" size="sm" @click="loadEngine">
          {{ engineButtonLabel }}
        </Button>
      </div>

      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check class="size-3.5 text-[var(--positive)]" />
        Engine ready with the {{ languageName }} pack. It stays loaded for as long as this page is
        open.
      </p>

      <!-- Options -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Options
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-44 flex-col gap-1.5">
            <Label for="ocr-language" class="text-xs text-muted-foreground">Language</Label>
            <SearchableSelect
              id="ocr-language"
              :spec="languageSpec"
              :model-value="language"
              class="w-full bg-card"
              @update:model-value="(v) => (language = String(v))"
            />
          </div>

          <div class="flex w-52 flex-col gap-1.5">
            <Label for="ocr-format" class="text-xs text-muted-foreground">Output format</Label>
            <SearchableSelect
              id="ocr-format"
              :spec="formatSpec"
              :model-value="format"
              class="w-full bg-card"
              @update:model-value="(v) => (format = String(v))"
            />
          </div>

          <div class="flex items-center gap-2 pb-2.5">
            <Switch
              id="ocr-layout"
              :model-value="preserveLayout"
              @update:model-value="(v) => (preserveLayout = Boolean(v))"
            />
            <Label for="ocr-layout" class="text-xs text-muted-foreground">Rebuild layout</Label>
          </div>

          <div class="flex items-center gap-2 pb-2.5">
            <Switch
              id="ocr-boxes"
              :model-value="showBoxes"
              @update:model-value="(v) => (showBoxes = Boolean(v))"
            />
            <Label for="ocr-boxes" class="text-xs text-muted-foreground">Show word boxes</Label>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Switching the output format or the layout toggle re-renders the result you already have,
          so nothing runs again. Changing the language restarts the engine with the new pack, which
          means the image has to be recognized once more.
        </p>
      </div>

      <!-- Run -->
      <div class="flex flex-wrap items-center gap-2">
        <Button :disabled="!canRun" @click="extract">
          {{ running ? "Working…" : "Extract text" }}
        </Button>
        <span v-if="running" class="font-mono text-xs text-muted-foreground tabular-nums">
          {{ status || "recognizing text" }} · {{ progressPercent }}%
        </span>
        <span v-else-if="hasImage && engineState !== 'ready'" class="text-xs text-muted-foreground">
          Load the engine first.
        </span>
      </div>

      <ProgressBar v-if="running" :value="progressPercent" label="Recognition progress" />
    </template>

    <!-- Preview with the box overlay -->
    <div v-if="imageUrl" class="flex flex-col items-center gap-2">
      <div class="relative inline-block max-w-full rounded-[10px] shadow-[var(--sh-inset)]">
        <img
          ref="imageEl"
          :src="imageUrl"
          alt="Preview of the image being recognized"
          draggable="false"
          class="block h-auto max-h-[380px] w-auto max-w-full rounded-[10px] select-none"
          @load="onImageLoad"
        />
        <canvas
          ref="overlayEl"
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 h-full w-full rounded-[10px]"
        />
      </div>
      <p v-if="naturalWidth" class="text-xs text-muted-foreground tabular-nums">
        {{ naturalWidth }} x {{ naturalHeight }} px
        <template v-if="showBoxes && words.length">
          · {{ words.length }} words boxed, green above 85%, amber down to {{ LOW_CONFIDENCE }}%,
          red below
        </template>
      </p>
    </div>

    <!-- Output -->
    <div v-if="result" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Extracted text
        </span>
        <div class="flex items-center gap-1">
          <CopyButton :text="output" label="Copy" />
          <Button variant="ghost" size="sm" :disabled="outputEmpty" @click="download">
            Download {{ downloadName.endsWith(".tsv") ? ".tsv" : ".txt" }}
          </Button>
        </div>
      </div>

      <p v-if="outputEmpty" class="px-3 pt-1 pb-3 text-sm text-muted-foreground">
        Tesseract found no text in this image. If there is clearly text in it, the image is probably
        too small, too dark, or rotated. Crop tightly around the text, straighten it, and try again.
      </p>
      <pre
        v-else
        class="max-h-[420px] overflow-auto px-3 pt-1 pb-3 font-mono text-sm whitespace-pre-wrap"
        >{{ output }}</pre>

      <p v-if="summary" class="border-t border-border/60 px-3 py-2 text-xs" :class="verdictClass">
        {{ summary.summary }}
      </p>
    </div>
  </div>
</template>
