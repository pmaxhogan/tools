<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Check, Trash2, Undo2, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  applyPixelateRect,
  applySolidRect,
  boxAtPoint,
  clampRect,
  collectTextBoxes,
  floodFillBounds,
  normalizeRect,
  suggestExportName,
  SOLID_COLORS,
  type OcrTapPage,
  type Rect,
  type RedactMode,
  type TapTarget,
  type TextBox,
} from "@/tools/image-redactor/index";
import { isMetered, onConnectionChange, shouldAutoDownload } from "@/lib/connection";

/**
 * Bespoke panel for the redaction tool. The generic ToolShell has no way to
 * express "drag rectangles over a canvas", and the whole point of this tool is
 * that the pixels really are overwritten, which needs a canvas.
 *
 * The pixel math lives in the pure logic module and is unit tested there. This
 * component owns only the decoded image, the pointer handling, and the export.
 *
 * Two invariants keep the redaction honest:
 *   1. The pristine ImageData is never mutated. Every redraw copies it and
 *      replays the region list in order, so overlapping regions compose the
 *      same way they will in the export.
 *   2. The export re-encodes from a fresh canvas built the same way, so the
 *      original compressed bytes and every metadata block are left behind.
 *
 * The region list lives in memory only. Nothing is written to the URL fragment
 * or to storage, so closing the tab discards it.
 */
defineProps<{ meta: ToolMeta }>();

interface Region {
  id: number;
  mode: RedactMode;
  color: "black" | "white";
  blockSize: number;
  /** Pixelate randomness strength, 0 to 100. Unused for solid regions. */
  randomness: number;
  /** Seed for the pixelate perturbation PRNG, captured once per region so redraws stay stable. */
  seed: number;
  rect: Rect;
}

/**
 * A fresh 32 bit seed for one pixelate region. Math.random is fine here: this
 * is the Vue panel, not the pure logic module, and the seed only needs to be
 * unpredictable, not itself reproducible. Once captured on a region it is
 * reused for every redraw so the preview and the export stay stable.
 */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileName = ref("");
const fileSize = ref(0);
const decodeFailed = ref(false);
const busy = ref(false);
const dragging = ref(false);

const canvas = ref<HTMLCanvasElement>();
const fileInput = ref<HTMLInputElement>();

/** The decoded image, never mutated. Every redraw starts from a copy of it. */
const pristine = shallowRef<ImageData | null>(null);
const imgWidth = ref(0);
const imgHeight = ref(0);

const regions = ref<Region[]>([]);
let nextId = 1;

const mode = ref<RedactMode>("solid");
const color = ref<"black" | "white">("black");
const blockSize = ref(12);
/** Pixelate randomness strength, 0 to 100. Matches meta.ts's default. */
const randomness = ref(35);
const format = ref<"png" | "jpeg">("png");

/** The rectangle currently being dragged, in image pixel space. */
const pending = ref<Rect | null>(null);
const dragStart = ref<{ x: number; y: number } | null>(null);
const drawing = ref(false);
/**
 * Seed for the region currently being dragged. Drawn fresh on pointerdown so
 * the live preview and the finalized region use the same seed, then replaced
 * before the next drag so no two regions share one.
 */
const dragSeed = ref(randomSeed());

const exportedName = ref("");
const exportedSize = ref<number | null>(null);

const hasImage = computed(() => pristine.value !== null);
const pixelateChosen = computed(
  () => mode.value === "pixelate" || regions.value.some((r) => r.mode === "pixelate"),
);

/* ---------------------------------------------------------------- */
/* smart tap                                                         */
/* ---------------------------------------------------------------- */

/**
 * Smart tap adds a second way to draw a region: instead of dragging a
 * rectangle, the user clicks a spot and the tool selects what is under it. Text
 * comes first, read by the same self hosted Tesseract engine the OCR tool uses,
 * with the three paths pinned so nothing is ever fetched from a CDN. When no
 * text sits near the tap, it falls back to the pure flood fill blob selector.
 *
 * The engine and the recognition it produces both live outside Vue's reactive
 * graph on purpose: the worker is a postMessage bridge, and the recognition is
 * cached per loaded image so repeated taps never re-run OCR.
 */
const CORE_PATH = "/tesseract/tesseract-core-simd-lstm.js";
const WORKER_PATH = "/tesseract/worker.min.js";
const LANG_PATH = "/tesseract/lang";
const OCR_LANGUAGE = "eng";
/** Core (about 2.9 MB) plus the English pack (about 2.8 MB), rounded for copy. */
const ENGINE_MB = 6;
/** Sum of absolute per channel RGBA difference the blob selector tolerates. */
const FLOOD_THRESHOLD = 48;
/** Grow a tapped rectangle a touch so anti-aliased glyph edges are covered. */
const SMART_PAD = 2;

type TesseractModule = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;

const interaction = ref<"rectangle" | "smart">("rectangle");
const tapTarget = ref<TapTarget>("word");

/** False until mounted, which keeps the WebAssembly check off the server. */
const supported = ref(false);
type EngineState = "idle" | "loading" | "ready";
const engineState = ref<EngineState>("idle");
const engineStatus = ref("");
const engineProgress = ref(0);
const engineError = ref<string | null>(null);

/** True when a metered or Save-Data connection holds the auto-start back. */
const metered = ref(false);
let pendingAutoStart = false;
let stopConnectionWatch: () => void = () => {};

/** null until the current image has been recognized; [] means "no text found". */
const ocrBoxes = shallowRef<TextBox[] | null>(null);
const ocrRunning = ref(false);
/** The in-flight recognition, so a tap can await it instead of racing it. */
let ocrPromise: Promise<void> | null = null;
/** A short line describing what the last tap selected. */
const smartNote = ref("");

/** The worker is never reactive: Vue must not proxy a postMessage bridge. */
let worker: TesseractWorker | null = null;
/** Bumped on teardown so a slow load cannot resurrect a dead engine. */
let generation = 0;
/** Bumped when the image changes so a stale recognition cannot land on it. */
let imageToken = 0;
let modulePromise: Promise<TesseractModule> | null = null;

const enginePercent = computed(() =>
  Math.max(0, Math.min(100, Math.round(engineProgress.value * 100))),
);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function regionLabel(region: Region): string {
  const size = `${region.rect.w} x ${region.rect.h} px`;
  return region.mode === "solid"
    ? `Solid ${region.color}, ${size}`
    : `Pixelate ${region.blockSize} px, ${region.randomness}% random, ${size}`;
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

/**
 * Decode through an object URL and read the pixels once. Everything after this
 * point works on the raw RGBA buffer, so the original file bytes are never
 * needed again and are not kept around.
 */
function decode(file: File): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx || w === 0 || h === 0) {
        decodeFailed.value = true;
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      ctx.drawImage(img, 0, 0);
      pristine.value = ctx.getImageData(0, 0, w, h);
      imgWidth.value = w;
      imgHeight.value = h;
      decodeFailed.value = false;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      pristine.value = null;
      imgWidth.value = 0;
      imgHeight.value = 0;
      decodeFailed.value = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

async function readFile(file: File) {
  busy.value = true;
  try {
    fileName.value = file.name;
    fileSize.value = file.size;
    regions.value = [];
    pending.value = null;
    exportedName.value = "";
    exportedSize.value = null;
    // A new image invalidates any recognition still in flight for the old one.
    imageToken += 1;
    ocrBoxes.value = null;
    smartNote.value = "";
    engineError.value = null;
    await decode(file);
    redraw();
  } finally {
    busy.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearFile() {
  pristine.value = null;
  imgWidth.value = 0;
  imgHeight.value = 0;
  regions.value = [];
  pending.value = null;
  fileName.value = "";
  fileSize.value = 0;
  decodeFailed.value = false;
  exportedName.value = "";
  exportedSize.value = null;
  imageToken += 1;
  ocrBoxes.value = null;
  smartNote.value = "";
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* rendering                                                         */
/* ---------------------------------------------------------------- */

/** A copy of the pristine pixels with every region applied, in list order. */
function composite(extra?: Region | null): ImageData | null {
  const source = pristine.value;
  if (!source) return null;
  const data = new Uint8ClampedArray(source.data);
  const list = extra ? [...regions.value, extra] : regions.value;
  for (const region of list) {
    if (region.mode === "solid") {
      applySolidRect(data, source.width, source.height, region.rect, SOLID_COLORS[region.color]);
    } else {
      applyPixelateRect(data, source.width, source.height, region.rect, region.blockSize, {
        seed: region.seed,
        strength: region.randomness / 100,
      });
    }
  }
  return new ImageData(data, source.width, source.height);
}

function pendingRegion(): Region | null {
  const rect = pending.value;
  if (!rect || rect.w < 1 || rect.h < 1) return null;
  return {
    id: 0,
    mode: mode.value,
    color: color.value,
    blockSize: blockSize.value,
    randomness: randomness.value,
    seed: dragSeed.value,
    rect,
  };
}

/**
 * The canvas always shows the real redacted pixels, so what you see is what
 * the export contains. The marquee outline is stroked on top afterwards and is
 * never part of the exported canvas, which is built separately.
 */
function redraw() {
  const el = canvas.value;
  const image = pristine.value;
  if (!el || !image) return;
  // Assigning width or height clears the canvas, so only do it on a new image.
  if (el.width !== image.width) el.width = image.width;
  if (el.height !== image.height) el.height = image.height;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  const composed = composite(pendingRegion());
  if (!composed) return;
  ctx.putImageData(composed, 0, 0);

  const rect = pending.value;
  if (drawing.value && rect && rect.w > 0 && rect.h > 0) {
    ctx.save();
    ctx.lineWidth = Math.max(1, Math.round(image.width / 400));
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 4]);
    ctx.strokeStyle = "#000000";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }
}

watch(regions, redraw, { deep: true });

/* ---------------------------------------------------------------- */
/* marquee                                                           */
/* ---------------------------------------------------------------- */

/**
 * The canvas is sized in real image pixels and scaled down by CSS to fit, so
 * pointer coordinates need the ratio between the two. Reading it per event
 * keeps it correct across window resizes and zoom without a resize observer.
 */
function pointIn(e: PointerEvent, el: HTMLCanvasElement) {
  const box = el.getBoundingClientRect();
  const scaleX = box.width > 0 ? imgWidth.value / box.width : 1;
  const scaleY = box.height > 0 ? imgHeight.value / box.height : 1;
  return {
    x: (e.clientX - box.left) * scaleX,
    y: (e.clientY - box.top) * scaleY,
  };
}

function onPointerDown(e: PointerEvent) {
  const el = canvas.value;
  if (!el || !hasImage.value) return;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  const p = pointIn(e, el);
  // Smart tap draws no marquee: the release resolves the tap into a region.
  if (interaction.value === "smart") return;
  dragStart.value = p;
  drawing.value = true;
  // Fresh seed per drag so this region's perturbation never repeats another
  // region's, while staying stable across the drag's own redraws.
  dragSeed.value = randomSeed();
  pending.value = normalizeRect(
    { x1: p.x, y1: p.y, x2: p.x, y2: p.y },
    imgWidth.value,
    imgHeight.value,
  );
  redraw();
}

function onPointerMove(e: PointerEvent) {
  if (interaction.value === "smart") return;
  const el = canvas.value;
  const start = dragStart.value;
  if (!drawing.value || !start || !el) return;
  const p = pointIn(e, el);
  pending.value = normalizeRect(
    { x1: start.x, y1: start.y, x2: p.x, y2: p.y },
    imgWidth.value,
    imgHeight.value,
  );
  redraw();
}

function onPointerUp(e: PointerEvent) {
  const el = canvas.value;
  if (!el) return;

  if (interaction.value === "smart") {
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!hasImage.value) return;
    const p = pointIn(e, el);
    void smartTap(p);
    return;
  }

  if (!drawing.value) return;
  drawing.value = false;
  dragStart.value = null;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

  const rect = pending.value;
  pending.value = null;
  // A stray click should not leave a one pixel redaction behind.
  if (!rect) {
    redraw();
    return;
  }
  commitRegion(rect, dragSeed.value);
  redraw();
}

/** A cancelled pointer must never resolve into a tap or a stray region. */
function onPointerCancel(e: PointerEvent) {
  const el = canvas.value;
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  if (interaction.value === "smart") return;
  cancelDrag();
}

function cancelDrag() {
  if (!drawing.value && !pending.value) return;
  drawing.value = false;
  dragStart.value = null;
  pending.value = null;
  redraw();
}

function undoLast() {
  if (regions.value.length === 0) return;
  regions.value = regions.value.slice(0, -1);
  exportedName.value = "";
  exportedSize.value = null;
}

function removeRegion(id: number) {
  regions.value = regions.value.filter((r) => r.id !== id);
  exportedName.value = "";
  exportedSize.value = null;
}

function clearRegions() {
  regions.value = [];
  exportedName.value = "";
  exportedSize.value = null;
}

/**
 * Append one region from a rectangle, the shared path for both a finished drag
 * and a smart tap. Clamps to the image and drops anything smaller than a few
 * pixels, so a stray click never leaves a speck of a redaction behind. Returns
 * whether a region was actually added.
 */
function commitRegion(rect: Rect, seed = randomSeed()): boolean {
  const box = clampRect(rect, imgWidth.value, imgHeight.value);
  if (!box || box.w < 3 || box.h < 3) return false;
  regions.value = [
    ...regions.value,
    {
      id: nextId++,
      mode: mode.value,
      color: color.value,
      blockSize: blockSize.value,
      randomness: randomness.value,
      seed,
      rect: box,
    },
  ];
  exportedName.value = "";
  exportedSize.value = null;
  return true;
}

/* ---------------------------------------------------------------- */
/* smart tap: engine                                                */
/* ---------------------------------------------------------------- */

function loadModule(): Promise<TesseractModule> {
  // Imported here, not at module scope, so the OCR library stays out of the
  // page bundle until a visitor actually turns on Smart tap.
  modulePromise ??= import("tesseract.js").then((mod) => {
    const cjs = (mod as unknown as { default?: TesseractModule }).default;
    return cjs?.createWorker ? cjs : (mod as unknown as TesseractModule);
  });
  return modulePromise;
}

function describeEngineError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  return raw || "The OCR engine stopped without saying why.";
}

async function destroyWorker() {
  const dying = worker;
  worker = null;
  generation += 1;
  if (!dying) return;
  try {
    await dying.terminate();
  } catch {
    // Terminating a half dead worker is not worth surfacing.
  }
}

/**
 * Start the engine download without a click, unless the connection is metered
 * or Save-Data. There it keeps a one-tap start and remembers to auto-start
 * later if the link turns unmetered.
 */
function autoStartEngine() {
  if (!supported.value || engineState.value !== "idle") return;
  if (shouldAutoDownload()) {
    void loadEngine();
  } else {
    metered.value = true;
    pendingAutoStart = true;
  }
}

async function loadEngine() {
  if (!supported.value) return;
  pendingAutoStart = false;
  await destroyWorker();
  const token = generation;

  engineState.value = "loading";
  engineStatus.value = "starting the engine";
  engineProgress.value = 0;
  engineError.value = null;

  try {
    const { createWorker, OEM } = await loadModule();
    const created = await createWorker(OCR_LANGUAGE, OEM.LSTM_ONLY, {
      corePath: CORE_PATH,
      workerPath: WORKER_PATH,
      langPath: LANG_PATH,
      // A blob wrapped worker reports a blob: URL as its location and the core
      // wasm resolves against that, so it is turned off to keep paths on origin.
      workerBlobURL: false,
      logger: (message) => {
        if (token !== generation) return;
        engineStatus.value = message.status ?? "";
        engineProgress.value = Number.isFinite(message.progress) ? message.progress : 0;
      },
      errorHandler: (e: unknown) => {
        if (token !== generation) return;
        engineError.value = describeEngineError(e);
      },
    });

    if (token !== generation) {
      await created.terminate();
      return;
    }

    worker = created;
    engineState.value = "ready";
    engineStatus.value = "";
    engineProgress.value = 0;
    // Read the loaded image now so the first tap on text is instant.
    void runOcr();
  } catch (e) {
    if (token !== generation) return;
    engineState.value = "idle";
    engineStatus.value = "";
    engineError.value = describeEngineError(e);
  }
}

/* ---------------------------------------------------------------- */
/* smart tap: recognition                                           */
/* ---------------------------------------------------------------- */

/**
 * Recognize the current image once and cache its word boxes. It reads the
 * pristine pixels through a throwaway canvas rather than the original file:
 * the browser already applied any EXIF orientation when it decoded the image,
 * so recognizing those pixels keeps every word box aligned with the redaction
 * canvas the user is tapping on.
 */
async function runOcr(): Promise<void> {
  if (ocrPromise) return ocrPromise;
  const image = pristine.value;
  if (!worker || !image || ocrBoxes.value !== null) return;

  const gen = generation;
  const tok = imageToken;
  ocrRunning.value = true;
  engineStatus.value = "reading text";
  engineProgress.value = 0;

  const task = (async () => {
    try {
      const off = document.createElement("canvas");
      off.width = image.width;
      off.height = image.height;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("Could not read the image for recognition.");
      ctx.putImageData(image, 0, 0);
      const recognized = await worker!.recognize(off, {}, { text: true, blocks: true });
      if (gen !== generation || tok !== imageToken) return;
      ocrBoxes.value = collectTextBoxes(recognized.data as unknown as OcrTapPage);
    } catch (e) {
      if (gen !== generation || tok !== imageToken) return;
      // Empty, not null, so taps fall back to the blob selector instead of
      // retrying recognition on every click.
      ocrBoxes.value = [];
      engineError.value = describeEngineError(e);
    } finally {
      // Reset unconditionally: the ocrPromise guard serializes runs, so there
      // is never a concurrent recognition whose progress this would clobber.
      // Clearing it even when the image was swapped mid run keeps the status
      // line honest and lets the recognition watcher pick up the new image.
      ocrRunning.value = false;
      engineStatus.value = "";
      engineProgress.value = 0;
      ocrPromise = null;
    }
  })();

  ocrPromise = task;
  return task;
}

/** Grow a tapped rectangle by a small pad on every side, then let the caller clamp. */
function padRect(rect: Rect): Rect {
  return {
    x: rect.x - SMART_PAD,
    y: rect.y - SMART_PAD,
    w: rect.w + SMART_PAD * 2,
    h: rect.h + SMART_PAD * 2,
  };
}

/**
 * How far a tap may sit from a text box and still count as hitting it: about
 * one word height, so a tap just above or below a line still lands on it,
 * floored so tiny text is still forgiving.
 */
function tapDistance(boxes: TextBox[]): number {
  const heights = boxes
    .map((b) => b.word.h)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)]! : 0;
  return Math.max(24, median);
}

async function smartTap(point: { x: number; y: number }) {
  const image = pristine.value;
  if (!image) return;
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));

  // Text first: if the engine is ready, or still reading, wait for the boxes
  // rather than grabbing a single glyph's blob out from under the recognition.
  if (supported.value && (engineState.value === "ready" || ocrRunning.value)) {
    if (ocrBoxes.value === null || ocrRunning.value) await runOcr();
    const boxes = ocrBoxes.value;
    if (boxes && boxes.length > 0) {
      const rect = boxAtPoint(boxes, { x, y }, tapTarget.value, tapDistance(boxes));
      if (rect) {
        if (commitRegion(padRect(rect))) {
          smartNote.value =
            tapTarget.value === "line"
              ? "Redacted the line of text under your tap."
              : "Redacted the word under your tap.";
        }
        return;
      }
    }
  }

  // No text near the tap: select the contiguous same colored region under it.
  const blob = floodFillBounds(image, { x, y }, FLOOD_THRESHOLD);
  if (blob && commitRegion(padRect(blob))) {
    smartNote.value =
      engineState.value === "ready" && (ocrBoxes.value?.length ?? 0) > 0
        ? "No text near your tap, so the shape under it was redacted."
        : "Redacted the shape under your tap.";
  } else {
    smartNote.value = "Nothing solid to select there. Tap directly on the text or object.";
  }
}

/* ---------------------------------------------------------------- */
/* keyboard                                                          */
/* ---------------------------------------------------------------- */

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function onKeydown(e: KeyboardEvent) {
  if (!hasImage.value) return;
  if (e.key === "Escape") {
    cancelDrag();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !isTypingTarget(e.target)) {
    if (regions.value.length === 0) return;
    e.preventDefault();
    undoLast();
  }
}

/* ---------------------------------------------------------------- */
/* smart tap: lifecycle                                             */
/* ---------------------------------------------------------------- */

/** Switching to Smart tap starts the engine and abandons any half drawn box. */
watch(interaction, (value) => {
  smartNote.value = "";
  if (value === "smart") {
    cancelDrag();
    autoStartEngine();
  }
});

/** Recognize whenever Smart tap is active, the engine is ready, and the image is fresh. */
watch([engineState, interaction, ocrRunning, () => pristine.value], () => {
  if (
    interaction.value === "smart" &&
    engineState.value === "ready" &&
    pristine.value &&
    ocrBoxes.value === null &&
    !ocrRunning.value
  ) {
    void runOcr();
  }
});

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  supported.value =
    typeof WebAssembly !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof document !== "undefined";
  metered.value = isMetered();
  stopConnectionWatch = onConnectionChange(() => {
    metered.value = isMetered();
    if (pendingAutoStart && shouldAutoDownload()) {
      pendingAutoStart = false;
      autoStartEngine();
    }
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  stopConnectionWatch();
  void destroyWorker();
});

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function canvasToBlob(el: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => el.toBlob(resolve, type, quality));
}

async function downloadExport() {
  const composed = composite();
  if (!composed) return;
  busy.value = true;
  try {
    // A fresh canvas, so the marquee outline drawn on the preview can never
    // reach the file, and so the export is built purely from redacted pixels.
    const out = document.createElement("canvas");
    out.width = composed.width;
    out.height = composed.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    if (format.value === "jpeg") {
      // JPEG has no alpha channel, so transparent areas would turn black.
      // putImageData ignores compositing, hence the staging canvas.
      const stage = document.createElement("canvas");
      stage.width = composed.width;
      stage.height = composed.height;
      const stageCtx = stage.getContext("2d");
      if (!stageCtx) return;
      stageCtx.putImageData(composed, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(stage, 0, 0);
    } else {
      ctx.putImageData(composed, 0, 0);
    }

    const type = format.value === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(out, type, format.value === "jpeg" ? 0.9 : undefined);
    if (!blob) return;

    const name = suggestExportName(fileName.value, format.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportedName.value = name;
    exportedSize.value = blob.size;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
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
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
        <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
      </div>

      <div v-if="hasImage || decodeFailed" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ humanSize(fileSize) }}</span>
          <button
            type="button"
            aria-label="Remove image"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
        Drop a screenshot here, then drag rectangles over anything sensitive. The pixels underneath
        are overwritten, not covered. Everything runs in this tab: your files and inputs never leave
        your device.
      </p>
    </div>

    <p
      v-if="decodeFailed"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <span class="font-medium text-destructive"
        >This browser could not decode that file as an image.</span
      >
      <span class="mt-1 block text-muted-foreground">
        Try a PNG, JPEG, WebP, GIF, or BMP screenshot.
      </span>
    </p>

    <template v-if="hasImage">
      <!-- Mode -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Selection mode
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-44 flex-col gap-1.5">
            <Label for="redact-interaction" class="text-xs text-muted-foreground">Mode</Label>
            <Select
              :model-value="interaction"
              @update:model-value="(v) => (interaction = v === 'smart' ? 'smart' : 'rectangle')"
            >
              <SelectTrigger id="redact-interaction" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rectangle"> Rectangle (drag) </SelectItem>
                <SelectItem value="smart"> Smart tap (click) </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="interaction === 'smart'" class="flex w-40 flex-col gap-1.5">
            <Label for="redact-tap-target" class="text-xs text-muted-foreground">Tap selects</Label>
            <Select
              :model-value="tapTarget"
              @update:model-value="(v) => (tapTarget = v === 'line' ? 'line' : 'word')"
            >
              <SelectTrigger id="redact-tap-target" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="word"> The tapped word </SelectItem>
                <SelectItem value="line"> The whole line </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          <template v-if="interaction === 'smart'">
            Click a word or object and the tool selects it and redacts it with your current style.
            Text is found first, and if there is none near the tap, the contiguous shape under it is
            selected instead.
          </template>
          <template v-else>
            Drag a rectangle over each thing you want gone. Every rectangle overwrites the pixels
            underneath it right away.
          </template>
        </p>
      </div>

      <!-- Smart tap engine -->
      <div
        v-if="interaction === 'smart'"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Smart tap engine
        </span>

        <p v-if="!supported" class="text-sm text-muted-foreground">
          This browser cannot run the in-browser OCR engine, which needs WebAssembly and web
          workers, so Smart tap selects the contiguous shape under your tap instead of reading text.
          Everything still runs in this tab: your files and inputs never leave your device.
        </p>

        <template v-else>
          <p v-if="engineState !== 'ready'" class="text-sm text-muted-foreground">
            Smart tap reads text with Tesseract running in your browser. Loading it downloads about
            {{ ENGINE_MB }} MB once, then your browser keeps it for later visits. It starts
            automatically, except on a metered connection, and nothing is uploaded: your files and
            inputs never leave your device.
          </p>

          <p v-if="metered && engineState === 'idle'" class="text-xs text-muted-foreground">
            Your connection looks metered, so the engine waits for you to start it.
          </p>

          <div v-if="engineState === 'loading'" class="flex flex-col gap-2">
            <div
              class="h-2 overflow-hidden rounded-full bg-background"
              role="progressbar"
              :aria-valuenow="enginePercent"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="OCR engine loading"
            >
              <div
                class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
                :style="{ width: `${enginePercent}%` }"
              />
            </div>
            <p class="font-mono text-xs text-muted-foreground tabular-nums">
              {{ engineStatus || "starting the engine" }} · {{ enginePercent }}%
            </p>
          </div>

          <Button
            v-else-if="engineState === 'idle'"
            class="self-start"
            size="sm"
            @click="loadEngine"
          >
            {{ metered ? `Load OCR engine (about ${ENGINE_MB} MB)` : "Load OCR engine" }}
          </Button>

          <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check class="size-3.5 shrink-0 text-[var(--positive)]" />
            <span v-if="ocrRunning">Reading text… {{ enginePercent }}%</span>
            <span v-else-if="ocrBoxes && ocrBoxes.length">
              Engine ready. {{ ocrBoxes.length }} words found, so tap any of them.
            </span>
            <span v-else-if="ocrBoxes">
              Engine ready. No text found, so a tap selects the shape under it.
            </span>
            <span v-else>Engine ready.</span>
          </p>

          <p v-if="engineError" role="alert" class="text-xs">
            <span class="font-medium text-destructive">OCR is unavailable.</span>
            <span class="text-muted-foreground">
              {{ engineError }} Smart tap still selects the shape under your tap.
            </span>
          </p>
        </template>

        <p v-if="smartNote" class="text-xs text-muted-foreground">{{ smartNote }}</p>
      </div>

      <!-- Canvas -->
      <div class="flex flex-col items-center gap-2">
        <canvas
          ref="canvas"
          class="checker block h-auto max-h-[520px] w-auto max-w-full touch-none rounded-[10px] shadow-[var(--sh-inset)]"
          :class="interaction === 'smart' ? 'cursor-pointer' : 'cursor-crosshair'"
          :aria-label="
            interaction === 'smart'
              ? 'Redaction canvas. Tap a word or object to redact it.'
              : 'Redaction canvas. Drag to draw a rectangle over anything sensitive.'
          "
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerCancel"
        />
        <p class="text-xs text-muted-foreground tabular-nums">
          {{ imgWidth }} x {{ imgHeight }} px.
          <template v-if="interaction === 'smart'">Tap on the image to redact.</template>
          <template v-else>Drag on the image to redact.</template>
          Escape cancels a drag, Delete removes the last region.
        </p>
      </div>

      <!-- Style -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Redaction style
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="redact-mode" class="text-xs text-muted-foreground">Style</Label>
            <Select
              :model-value="mode"
              @update:model-value="(v) => (mode = v === 'pixelate' ? 'pixelate' : 'solid')"
            >
              <SelectTrigger id="redact-mode" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="solid"> Solid fill (safest) </SelectItem>
                <SelectItem value="pixelate"> Pixelate (weaker) </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="mode === 'solid'" class="flex w-32 flex-col gap-1.5">
            <Label for="redact-color" class="text-xs text-muted-foreground">Color</Label>
            <Select
              :model-value="color"
              @update:model-value="(v) => (color = v === 'white' ? 'white' : 'black')"
            >
              <SelectTrigger id="redact-color" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="black"> Black </SelectItem>
                <SelectItem value="white"> White </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-else class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Block size: {{ blockSize }} px
            </span>
            <Slider
              aria-label="Pixelate block size"
              :model-value="[blockSize]"
              :min="4"
              :max="64"
              :step="1"
              class="py-2"
              @update:model-value="(v) => (blockSize = v?.[0] ?? blockSize)"
            />
          </div>

          <div v-if="mode === 'pixelate'" class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Randomness: {{ randomness }}%
            </span>
            <Slider
              aria-label="Pixelate randomness strength"
              :model-value="[randomness]"
              :min="0"
              :max="100"
              :step="5"
              class="py-2"
              @update:model-value="(v) => (randomness = v?.[0] ?? randomness)"
            />
          </div>
        </div>

        <p
          v-if="mode === 'pixelate' && randomness === 0"
          role="note"
          class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-destructive"
            >Randomness is off: this is a plain block average.</span
          >
          Every block is replaced with the flat average of the pixels it covers, and that average is
          a fixed function of the source image, the exact case researchers have reconstructed by
          rendering candidate words through the same block grid until the output matches. Raise the
          randomness slider above 0% or switch to solid fill for anything you truly need gone.
        </p>
        <p
          v-else-if="pixelateChosen"
          role="note"
          class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-destructive">Pixelate is still the weaker choice.</span>
          When randomness is above 0%, each block mixes seeded random noise into its average,
          generated fresh per region, so the output is no longer a fixed function of the source
          image and the classic attack of rendering candidate words through the same block grid no
          longer lands the same way. That makes reconstruction much harder, not impossible: a rough
          trace of the original brightness still survives the average. Use solid fill for anything
          you truly need gone.
        </p>
        <p v-else class="text-xs text-muted-foreground">
          Solid fill replaces every pixel under the rectangle with one flat color, so nothing of the
          original remains in the image data.
        </p>
      </div>

      <!-- Regions -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Regions ({{ regions.length }})
          </span>
          <div class="flex items-center gap-2">
            <Button variant="outline" size="sm" :disabled="regions.length === 0" @click="undoLast">
              <Undo2 class="size-3.5" />
              Undo last
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :disabled="regions.length === 0"
              @click="clearRegions"
            >
              Clear all
            </Button>
          </div>
        </div>

        <ul v-if="regions.length" class="flex flex-col divide-y divide-border/60">
          <li
            v-for="(region, index) in regions"
            :key="region.id"
            class="flex items-center justify-between gap-3 py-2"
          >
            <span class="min-w-0 truncate font-mono text-xs tabular-nums">
              {{ index + 1 }}. {{ regionLabel(region) }} at {{ region.rect.x }},
              {{ region.rect.y }}
            </span>
            <button
              type="button"
              :aria-label="`Remove region ${index + 1}`"
              class="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="removeRegion(region.id)"
            >
              <Trash2 class="size-3.5" />
            </button>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No regions yet. Drag a rectangle on the image above to add one. Regions apply in order, so
          a later one draws over an earlier one.
        </p>
      </div>

      <!-- Export -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Export
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="redact-format" class="text-xs text-muted-foreground">Format</Label>
            <Select
              :model-value="format"
              @update:model-value="(v) => (format = v === 'jpeg' ? 'jpeg' : 'png')"
            >
              <SelectTrigger id="redact-format" size="sm" class="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png"> PNG (lossless) </SelectItem>
                <SelectItem value="jpeg"> JPEG (quality 90) </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" :disabled="busy" class="mb-0.5" @click="downloadExport">
            Download redacted image
          </Button>
        </div>

        <p v-if="exportedName" class="font-mono text-xs text-muted-foreground tabular-nums">
          Saved {{ exportedName }}, {{ humanSize(exportedSize ?? 0) }}.
        </p>

        <p class="text-xs text-muted-foreground">
          The download is re-encoded from the canvas, so it is built out of the redacted pixels
          alone. None of the original compressed data survives and no EXIF, XMP, or IPTC metadata
          comes along with it. The region list stays in memory: it is never written to the URL or to
          storage.
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Checkerboard so transparent regions read as transparent, not as the surface. */
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
