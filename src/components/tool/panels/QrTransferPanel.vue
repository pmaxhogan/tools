<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Camera, Download, Maximize2, Pause, Play, Repeat, RotateCcw } from "lucide-vue-next";
import jsQR from "jsqr";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  FPS_MAX,
  FPS_MIN,
  FPS_RECOMMENDED,
  MAX_PAYLOAD_BYTES,
  Receiver,
  createFrameSource,
  decodeFrame,
  estimateTransfer,
  formatDuration,
  frameToQrMatrix,
  type FrameSource,
  type ReceiverResult,
} from "@/tools/qr-file-transfer/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";
import FileDrop from "../FileDrop.vue";
import ErrorBanner from "../ErrorBanner.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for the animated QR file transfer.
 *
 * The generic ToolShell can only print the first frame as text. This tool is
 * two devices looking at each other, so the panel owns the things a text
 * output cannot express: a canvas animating the frame stream at a chosen rate,
 * a fullscreen presentation surface, and a camera loop feeding decoded strings
 * back into the receiver.
 *
 * Every byte decision still comes from the pure layer (PROJECT.md rule 27):
 * `createFrameSource` builds the plan and hands out frame text, `frameToQrMatrix`
 * turns one frame into modules, `Receiver.ingest` rebuilds the payload, and
 * `estimateTransfer` plus `formatDuration` price the transfer up front. This
 * file only moves pixels, opens the camera, and paints state.
 *
 * Nothing starts on its own: the animation and the camera both wait for a
 * click, and both stop on unmount and whenever the tab is hidden. No payload
 * is ever written to the URL fragment or to localStorage.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Quiet zone around the symbol, in modules. Four is the QR spec minimum. */
const QUIET_MODULES = 4;

/**
 * Longest edge a camera frame is scaled to before decoding. Much larger than a
 * plain scanner needs: a version 25 symbol is 117 modules across, so a frame
 * that only fills half the view still has to leave several pixels per module.
 */
const SCAN_MAX_EDGE = 1280;

/** Decode at most this often, in milliseconds. */
const SCAN_INTERVAL_MS = 50;

/** Missing chunk indices listed before the rest are collapsed to a count. */
const MISSING_PREVIEW = 24;

/** Option edits rebuild the plan after this quiet period, in milliseconds. */
const REBUILD_DELAY_MS = 200;

/* ------------------------------------------------------------------ *
 * option specs, read from the tool's own meta
 * ------------------------------------------------------------------ */

function optionSpec(id: string) {
  return props.meta.options?.find((o) => o.id === id);
}

const sizeSelectSpec = computed<SelectOptionSpec | undefined>(() => {
  const spec = optionSpec("size");
  return spec?.kind === "select" ? spec : undefined;
});
const eccSelectSpec = computed<SelectOptionSpec | undefined>(() => {
  const spec = optionSpec("ecc");
  return spec?.kind === "select" ? spec : undefined;
});
const modeSelectSpec = computed<SelectOptionSpec | undefined>(() => {
  const spec = optionSpec("mode");
  return spec?.kind === "select" ? spec : undefined;
});
const fpsSpec = computed(() => {
  const spec = optionSpec("fps");
  return spec?.kind === "number" ? spec : undefined;
});
const nameSpec = computed(() => {
  const spec = optionSpec("fileName");
  return spec?.kind === "text" ? spec : undefined;
});

/**
 * The stream mode reads as a two button group rather than a dropdown, so the
 * meta labels ("Fountain: endless stream, missed frames are fine") are split at
 * the colon: the short half is the button, the whole label is its title.
 */
const modeChoices = computed(() =>
  (modeSelectSpec.value?.options ?? []).map((o) => ({
    value: o.value,
    short: o.label.split(":")[0],
    full: o.label,
  })),
);

const fpsMin = computed(() => fpsSpec.value?.min ?? FPS_MIN);
const fpsMax = computed(() => fpsSpec.value?.max ?? FPS_MAX);

/* ------------------------------------------------------------------ *
 * shared state
 * ------------------------------------------------------------------ */

type Direction = "send" | "receive";

interface PanelError {
  message: string;
  fix?: string;
}

const direction = ref<Direction>("send");
const sendError = ref<PanelError | null>(null);
const receiveError = ref<PanelError | null>(null);

function describeError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * sender: file, plan, options
 * ------------------------------------------------------------------ */

const payload = shallowRef<Uint8Array | null>(null);
const picked = ref<{ name: string; size: number } | null>(null);
/** Not a plain ref: the frame source holds every chunk, and Vue must not proxy them. */
const source = shallowRef<FrameSource | null>(null);

const sendSize = ref<string>(sizeSelectSpec.value?.default ?? "medium");
const sendEcc = ref<string>(eccSelectSpec.value?.default ?? "M");
const streamMode = ref<string>(modeSelectSpec.value?.default ?? "fountain");
const fps = ref<number>(fpsSpec.value?.default ?? FPS_RECOMMENDED);
const fileNameInput = ref("");

const reading = ref(false);

/* The sender zone's second line, also its accessible description. */
const senderHint = computed(
  () =>
    `Drop a file here or pick one with the button. Up to ${formatBytes(MAX_PAYLOAD_BYTES)}, ` +
    `chunked and animated on this screen for the other device's camera to read.`,
);
const playing = ref(false);
const looping = ref(true);
const isFullscreen = ref(false);
const position = ref(0);
/** True once a one shot pass has run to its end, so Play starts a fresh one. */
const finishedPass = ref(false);

const stageEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
/* The compact "choose another" zone: its button lives in the actions slot,
   so it opens the picker through the component instead of the zone click. */
const replaceDrop = ref<InstanceType<typeof FileDrop> | null>(null);

const effectiveName = computed(
  () => fileNameInput.value.trim() || picked.value?.name || "file.bin",
);

const estimate = computed(() => {
  const bytes = payload.value;
  if (!bytes) return null;
  try {
    return estimateTransfer(
      bytes.length,
      sendSize.value,
      fps.value,
      streamMode.value,
      sendEcc.value,
      effectiveName.value,
    );
  } catch {
    // The plan itself reports the same problem in the error block below.
    return null;
  }
});

const cycleLength = computed(() => source.value?.framesPerCycle ?? 0);

/**
 * A finished one shot pass sits one past its last frame, so the counter reads
 * the frame that is actually on screen rather than rolling over to the next.
 */
const shownPosition = computed(() =>
  finishedPass.value && position.value > 0 ? position.value - 1 : position.value,
);
const frameNumber = computed(() =>
  cycleLength.value ? (shownPosition.value % cycleLength.value) + 1 : 0,
);
const passNumber = computed(() =>
  cycleLength.value ? Math.floor(shownPosition.value / cycleLength.value) + 1 : 0,
);

/* ------------------------------------------------------------------ *
 * sender: building the plan
 * ------------------------------------------------------------------ */

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

function buildSource(): void {
  clearTimeout(rebuildTimer);
  stopSending();
  source.value = null;
  position.value = 0;
  finishedPass.value = false;
  const bytes = payload.value;
  if (!bytes) return;
  try {
    source.value = createFrameSource(bytes, {
      size: sendSize.value,
      ecc: sendEcc.value,
      mode: streamMode.value,
      fileName: effectiveName.value,
    });
    sendError.value = null;
  } catch (e) {
    sendError.value = describeError(e);
    return;
  }
  // The canvas only exists once a plan does, so lay it out after Vue paints it.
  void nextTick(() => {
    layoutCanvas();
    drawFrame(0);
  });
}

/**
 * Any option change mints a new transfer id, so it must not fire on every
 * keystroke in the name field. Playback stops at once, the rebuild follows once
 * typing settles.
 */
function scheduleRebuild(): void {
  stopSending();
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildSource, REBUILD_DELAY_MS);
}

watch([sendSize, sendEcc, streamMode, fileNameInput], scheduleRebuild);

async function acceptFile(file: File | null | undefined): Promise<void> {
  if (!file) return;
  stopSending();
  // Checked before the read, not after: the logic layer rejects the same size,
  // but only once the whole file is already in memory.
  if (file.size > MAX_PAYLOAD_BYTES) {
    sendError.value = {
      message: `${file.name} is ${formatBytes(file.size)}, and this tool stops at ${formatBytes(MAX_PAYLOAD_BYTES)}.`,
      fix: "A camera reads a couple of kilobytes per second, so a larger file would take hours on screen. Send a zipped selection of it instead.",
    };
    return;
  }
  sendError.value = null;
  reading.value = true;
  try {
    const buffer = await file.arrayBuffer();
    payload.value = new Uint8Array(buffer);
    picked.value = { name: file.name, size: file.size };
  } catch (e) {
    payload.value = null;
    picked.value = null;
    sendError.value = describeError(e);
  } finally {
    reading.value = false;
  }
  buildSource();
}

function onFiles(files: File[]): void {
  void acceptFile(files[0]);
}

/* ------------------------------------------------------------------ *
 * sender: canvas
 * ------------------------------------------------------------------ */

/**
 * Size the canvas so one QR module is a whole number of device pixels.
 *
 * A fractional module width leaves some modules a pixel wider than their
 * neighbors, which is exactly the artifact that makes a camera give up on a
 * dense symbol, so the backing store is a multiple of the module count and the
 * CSS size follows from it rather than the other way round.
 */
function layoutCanvas(): void {
  const src = source.value;
  const canvas = canvasEl.value;
  const stage = stageEl.value;
  if (!src || !canvas || !stage) return;
  const modules = src.moduleCount + QUIET_MODULES * 2;
  const rect = stage.getBoundingClientRect();
  const available = Math.max(160, Math.min(rect.width || 320, rect.height || 320));
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const cell = Math.max(2, Math.floor((available * dpr) / modules));
  const pixels = cell * modules;
  if (canvas.width !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  // Deliberately not rounded: a whole number of CSS pixels would ask the
  // browser for a fractional scale and undo the work above.
  const css = pixels / dpr;
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
}

function drawFrame(index: number): void {
  const src = source.value;
  const canvas = canvasEl.value;
  if (!src || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  try {
    // The plan's version is pinned so short frames cannot encode into a smaller
    // symbol than long ones, which would jitter the module count mid stream.
    const matrix = frameToQrMatrix(src.nextFrame(index), src.ecc, src.version);
    const modules = matrix.size + QUIET_MODULES * 2;
    const cell = Math.max(1, Math.floor(canvas.width / modules));
    const pad = Math.floor((canvas.width - cell * modules) / 2) + QUIET_MODULES * cell;
    // A QR symbol is dark on light in both themes: these two are not tokens.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < matrix.size; y++) {
      const row = y * matrix.size;
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.data[row + x]) ctx.fillRect(pad + x * cell, pad + y * cell, cell, cell);
      }
    }
  } catch (e) {
    stopSending();
    sendError.value = describeError(e);
  }
}

function redraw(): void {
  layoutCanvas();
  drawFrame(position.value);
}

/* ------------------------------------------------------------------ *
 * sender: playback
 * ------------------------------------------------------------------ */

let sendRaf = 0;
let nextDrawAt = 0;

function step(now: number): void {
  sendRaf = requestAnimationFrame(step);
  if (now < nextDrawAt) return;
  const interval = 1000 / Math.max(1, fps.value);
  // Accumulate the schedule instead of restarting it from `now`. Restarting
  // rounds every frame up to the next display refresh, so a requested 20 fps
  // quietly runs at 15 on a 60 Hz screen and the estimate stops being true.
  // A stall longer than one interval resyncs rather than bursting frames.
  nextDrawAt = now - nextDrawAt > interval ? now + interval : nextDrawAt + interval;

  const src = source.value;
  if (!src) {
    stopSending();
    return;
  }
  drawFrame(position.value);
  const next = position.value + 1;
  position.value = next;
  if (!looping.value && next >= src.framesPerCycle) {
    finishedPass.value = true;
    stopSending();
  }
}

function startSending(): void {
  const src = source.value;
  if (!src || playing.value) return;
  if (finishedPass.value) {
    position.value = 0;
    finishedPass.value = false;
  }
  playing.value = true;
  nextDrawAt = performance.now();
  sendRaf = requestAnimationFrame(step);
}

function stopSending(): void {
  if (sendRaf) cancelAnimationFrame(sendRaf);
  sendRaf = 0;
  playing.value = false;
}

function togglePlay(): void {
  if (playing.value) stopSending();
  else startSending();
}

/* ------------------------------------------------------------------ *
 * sender: fullscreen
 * ------------------------------------------------------------------ */

interface FsElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface FsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function fullscreenElement(): Element | null {
  const doc = document as FsDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function toggleFullscreen(): void {
  const stage = stageEl.value as FsElement | null;
  if (!stage) return;
  if (fullscreenElement()) {
    const doc = document as FsDocument;
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    // A refusal costs nothing: the panel stays exactly as it is.
    if (exit) Promise.resolve(exit.call(doc)).catch(() => {});
    return;
  }
  const request = stage.requestFullscreen ?? stage.webkitRequestFullscreen;
  if (!request) return;
  Promise.resolve(request.call(stage)).catch(() => {});
}

function onFullscreenChange(): void {
  isFullscreen.value = fullscreenElement() === stageEl.value;
  // The box only reaches its new size after the browser finishes the switch.
  requestAnimationFrame(redraw);
}

function onResize(): void {
  redraw();
}

/* ------------------------------------------------------------------ *
 * receiver
 * ------------------------------------------------------------------ */

const receiver = new Receiver();
/** Shallow: the result carries chunk arrays that Vue must not proxy. */
const status = shallowRef<ReceiverResult | null>(null);
const receivedFile = shallowRef<{ name: string; bytes: Uint8Array } | null>(null);
const expectedBytes = ref<number | null>(null);
const mismatchReason = ref<string | null>(null);
const scanning = ref(false);

const videoEl = ref<HTMLVideoElement | null>(null);

/** Live media objects are deliberately outside Vue's reactivity. */
let stream: MediaStream | null = null;
let scanCanvas: HTMLCanvasElement | null = null;
let scanRaf = 0;
let lastScanAt = 0;

const progressPercent = computed(() => Math.round((status.value?.progress ?? 0) * 100));
const missingPreview = computed(() => (status.value?.missing ?? []).slice(0, MISSING_PREVIEW));
const missingExtra = computed(() =>
  Math.max(0, (status.value?.missing?.length ?? 0) - MISSING_PREVIEW),
);

/**
 * Most rejected frames are ordinary misreads: a camera that catches a screen
 * mid repaint still hands jsQR a symbol its own error correction repairs, and
 * the frame then fails the CRC in the logic layer. At 20 decodes a second that
 * noise would strobe an alarming message through a perfectly healthy transfer.
 * Only these two reasons mean the receiver is locked onto a different stream,
 * which is the state the Reset button exists for.
 */
function isMismatch(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.includes("different transfer") || reason.includes("does not match the transfer");
}

function describeCameraError(e: unknown): PanelError {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      message: "Camera access was blocked, so the receiver cannot read the stream.",
      fix: "Allow the camera for this page in your browser, then press Start camera again.",
    };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return {
      message: "No camera was found on this device.",
      fix: "Open the Receive tab on a device that has a camera, and send from this one.",
    };
  return {
    message: `The camera could not be started: ${e instanceof Error ? e.message : String(e)}`,
    fix: "Close any other tab or app already using the camera and try again.",
  };
}

async function startCamera(): Promise<void> {
  receiveError.value = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    receiveError.value = describeCameraError(new DOMException("", "NotFoundError"));
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    const video = videoEl.value;
    if (!video) {
      // No element to attach to: hand the camera back rather than leaking it.
      stopCamera();
      return;
    }
    video.srcObject = stream;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });
    await video.play();
    scanning.value = true;
    lastScanAt = 0;
    scanRaf = requestAnimationFrame(scanStep);
  } catch (e) {
    receiveError.value = describeCameraError(e);
    stopCamera();
  }
}

function stopCamera(): void {
  if (scanRaf) cancelAnimationFrame(scanRaf);
  scanRaf = 0;
  scanning.value = false;
  if (videoEl.value) videoEl.value.srcObject = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function scanStep(now: number): void {
  scanRaf = requestAnimationFrame(scanStep);
  if (now - lastScanAt < SCAN_INTERVAL_MS) return;
  lastScanAt = now;
  scanFrame();
}

function scanFrame(): void {
  const video = videoEl.value;
  if (!video || video.readyState < 2) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  scanCanvas ??= document.createElement("canvas");
  scanCanvas.width = w;
  scanCanvas.height = h;
  const ctx = scanCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);

  // Frames come off a screen, so they are always dark on light: skipping the
  // inverted pass keeps the loop fast enough to catch a 20 fps sender.
  const found = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" });
  if (found) ingest(found.data);
}

function ingest(text: string): void {
  // `ingest` never throws, so it goes first: a frame the header reader would
  // reject can still be a frame the receiver wants.
  const result = receiver.ingest(text);
  status.value = result;
  if (!result.accepted) {
    if (isMismatch(result.reason)) mismatchReason.value = result.reason ?? null;
    return;
  }
  mismatchReason.value = null;
  if (expectedBytes.value === null) {
    try {
      expectedBytes.value = decodeFrame(text).totalLength;
    } catch {
      // The payload size is only a nicety; the transfer does not need it.
    }
  }
  if (result.done && result.file) {
    receivedFile.value = result.file;
    stopCamera();
  }
}

function resetReceive(): void {
  stopCamera();
  receiver.reset();
  status.value = null;
  receivedFile.value = null;
  expectedBytes.value = null;
  mismatchReason.value = null;
  receiveError.value = null;
}

function saveReceived(): void {
  const file = receivedFile.value;
  if (!file) return;
  downloadBlob(
    new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
    file.name,
  );
}

/* ------------------------------------------------------------------ *
 * direction and lifecycle
 * ------------------------------------------------------------------ */

function setDirection(next: Direction): void {
  if (next === direction.value) return;
  stopSending();
  stopCamera();
  direction.value = next;
  if (next === "send") void nextTick(redraw);
}

/** Leaving the tab stops both the animation and the camera. */
function onVisibilityChange(): void {
  if (!document.hidden) return;
  stopSending();
  stopCamera();
}

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  window.addEventListener("resize", onResize);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  window.removeEventListener("resize", onResize);
  clearTimeout(rebuildTimer);
  stopSending();
  stopCamera();
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Direction -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div
        class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
        role="tablist"
        aria-label="Transfer direction"
      >
        <Button
          role="tab"
          size="sm"
          variant="ghost"
          :aria-selected="direction === 'send'"
          :class="direction === 'send' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setDirection('send')"
        >
          Send
        </Button>
        <Button
          role="tab"
          size="sm"
          variant="ghost"
          :aria-selected="direction === 'receive'"
          :class="direction === 'receive' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setDirection('receive')"
        >
          Receive
        </Button>
      </div>
      <p v-if="meta.privacyNote" class="max-w-md text-xs text-muted-foreground">
        {{ meta.privacyNote }}
      </p>
    </div>

    <!-- Sender -->
    <template v-if="direction === 'send'">
      <ErrorBanner v-if="sendError" :message="sendError.message" :hint="sendError.fix" />

      <!-- File input -->
      <FileDrop v-if="!payload" bare label="File to send" :hint="senderHint" @files="onFiles">
        <template #default="{ open }">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              File to send
            </span>
            <Button variant="ghost" size="sm" @click="open">Open file…</Button>
          </div>
          <div class="px-3 pt-1 pb-4">
            <p class="text-sm text-muted-foreground">
              {{ reading ? "Reading the file…" : senderHint }}
            </p>
          </div>
        </template>
      </FileDrop>

      <FileDrop
        v-else
        ref="replaceDrop"
        compact
        :paste="false"
        :label="picked?.name ?? 'Chosen file'"
        :hint="formatBytes(picked?.size ?? 0)"
        @files="onFiles"
      >
        <template #actions>
          <Button variant="ghost" size="sm" @click="replaceDrop?.open()">Choose another…</Button>
        </template>
      </FileDrop>

      <!-- Options -->
      <div v-if="payload" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div v-if="sizeSelectSpec" class="flex flex-col gap-1.5">
          <Label for="qr-transfer-size" class="text-xs text-muted-foreground">
            {{ sizeSelectSpec.label }}
          </Label>
          <SearchableSelect
            id="qr-transfer-size"
            :spec="sizeSelectSpec"
            :model-value="sendSize"
            @update:model-value="(v: string) => (sendSize = v)"
          />
        </div>

        <div v-if="eccSelectSpec" class="flex flex-col gap-1.5">
          <Label for="qr-transfer-ecc" class="text-xs text-muted-foreground">
            {{ eccSelectSpec.label }}
          </Label>
          <SearchableSelect
            id="qr-transfer-ecc"
            :spec="eccSelectSpec"
            :model-value="sendEcc"
            @update:model-value="(v: string) => (sendEcc = v)"
          />
        </div>

        <div v-if="modeChoices.length" class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">
            {{ modeSelectSpec?.label ?? "Stream mode" }}
          </span>
          <div
            class="inline-flex w-fit gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          >
            <Button
              v-for="choice in modeChoices"
              :key="choice.value"
              variant="ghost"
              size="sm"
              :title="choice.full"
              :aria-pressed="streamMode === choice.value"
              :class="streamMode === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="streamMode = choice.value"
            >
              {{ choice.short }}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-xs text-muted-foreground">
              {{ fpsSpec?.label ?? "Frames per second" }}
            </span>
            <span class="font-mono text-xs tabular-nums">{{ fps }} fps</span>
          </div>
          <Slider
            aria-label="Frames per second"
            :model-value="[fps]"
            :min="fpsMin"
            :max="fpsMax"
            :step="fpsSpec?.step ?? 1"
            class="py-2"
            @update:model-value="(v) => (fps = v?.[0] ?? fps)"
          />
        </div>

        <div v-if="nameSpec" class="flex flex-col gap-1.5 sm:col-span-2">
          <Label for="qr-transfer-name" class="text-xs text-muted-foreground">
            {{ nameSpec.label }}
          </Label>
          <Input
            id="qr-transfer-name"
            :model-value="fileNameInput"
            :placeholder="nameSpec.placeholder ?? picked?.name"
            @update:model-value="(v) => (fileNameInput = String(v))"
          />
        </div>
      </div>

      <!-- Stage -->
      <div
        v-if="source"
        ref="stageEl"
        class="relative flex items-center justify-center overflow-hidden bg-white"
        :class="
          isFullscreen
            ? 'h-screen w-screen'
            : 'h-[min(72vw,440px)] w-full rounded-[10px] shadow-[var(--sh-inset)]'
        "
      >
        <canvas ref="canvasEl" class="block" aria-label="Animated transfer frame" />
        <div v-if="isFullscreen" class="absolute top-3 right-3 flex gap-1">
          <Button variant="outline" size="sm" @click="togglePlay">
            <component :is="playing ? Pause : Play" class="size-3.5" aria-hidden="true" />
            {{ playing ? "Pause" : "Play" }}
          </Button>
          <Button variant="outline" size="sm" @click="toggleFullscreen">Exit fullscreen</Button>
        </div>
      </div>

      <!-- Transport -->
      <div v-if="source" class="flex flex-wrap items-center gap-2">
        <Button size="sm" @click="togglePlay">
          <component :is="playing ? Pause : Play" class="size-3.5" aria-hidden="true" />
          {{ playing ? "Pause" : "Play" }}
        </Button>
        <span class="font-mono text-xs text-muted-foreground tabular-nums">
          Frame {{ frameNumber }} of {{ cycleLength }}, pass {{ passNumber }}
        </span>
        <span class="grow" />
        <Button
          variant="outline"
          size="sm"
          :aria-pressed="looping"
          :class="looping ? 'bg-accent' : ''"
          @click="looping = !looping"
        >
          <Repeat class="size-3.5" aria-hidden="true" />
          Loop
        </Button>
        <Button variant="ghost" size="sm" @click="toggleFullscreen">
          <Maximize2 class="size-3.5" aria-hidden="true" />
          Fullscreen
        </Button>
      </div>

      <p v-if="source && estimate" class="text-xs text-muted-foreground">
        One full pass takes about {{ formatDuration(estimate.seconds) }} at {{ fps }} fps, which is
        roughly {{ formatBytes(estimate.bytesPerSecond) }} per second.
        {{ source.totalChunks }} chunks of {{ formatBytes(source.chunkSize) }}, version
        {{ source.version }} at error correction {{ source.ecc }}, transfer ID
        {{ source.transferId }}.
      </p>
      <p v-if="source" class="text-xs text-muted-foreground">
        Fill as much of the receiving camera's view as you can. If frames are being missed, lower
        the frame rate or pick a smaller code size.
      </p>
    </template>

    <!-- Receiver -->
    <template v-else>
      <ErrorBanner v-if="receiveError" :message="receiveError.message" :hint="receiveError.fix" />

      <div class="relative overflow-hidden rounded-[10px] bg-black shadow-[var(--sh-inset)]">
        <video
          ref="videoEl"
          class="block max-h-[420px] w-full object-contain"
          :class="scanning ? '' : 'hidden'"
          autoplay
          muted
          playsinline
        />
        <div
          v-if="!scanning"
          class="flex min-h-56 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
        >
          <p class="max-w-sm text-sm text-white/80">
            Point this camera at the animated code on the sending device. Decoding runs in this tab.
          </p>
          <Button size="sm" @click="startCamera">
            <Camera class="size-3.5" aria-hidden="true" />
            Start camera
          </Button>
        </div>
      </div>

      <div v-if="scanning" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted-foreground">
          Scanning. Hold the whole code inside the frame.
        </span>
        <span class="grow" />
        <Button variant="ghost" size="sm" @click="stopCamera">Stop</Button>
      </div>

      <!-- Progress -->
      <div
        v-if="status?.total"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-sm font-medium break-all">
            {{ status.fileName ?? "Waiting for the file name frame" }}
          </span>
          <span class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ expectedBytes === null ? "" : formatBytes(expectedBytes) }}
          </span>
        </div>

        <ProgressBar :value="progressPercent" track="card" aria-label="Transfer progress" />

        <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
          <span>{{ status.received }} of {{ status.total }} chunks</span>
          <span class="text-muted-foreground">{{ progressPercent }}%</span>
          <span class="text-muted-foreground">{{ status.frames }} frames read</span>
          <span class="text-muted-foreground">ID {{ status.transferId }}</span>
        </div>

        <div v-if="!status.done && missingPreview.length" class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Chunks still missing</span>
          <span class="font-mono text-xs break-words text-muted-foreground tabular-nums">
            {{ missingPreview.join(", ") }}
            <template v-if="missingExtra">and {{ missingExtra }} more</template>
          </span>
        </div>
      </div>

      <p v-if="mismatchReason" class="text-xs text-muted-foreground">
        {{ mismatchReason }} Press Reset to listen for a new one.
      </p>

      <div v-if="receivedFile" class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-[var(--positive)]">
          Complete: {{ receivedFile.name }}, {{ formatBytes(receivedFile.bytes.length) }}
        </span>
        <span class="grow" />
        <Button size="sm" @click="saveReceived">
          <Download class="size-3.5" aria-hidden="true" />
          Save file
        </Button>
        <Button variant="ghost" size="sm" @click="resetReceive">Receive another</Button>
      </div>

      <div v-else-if="status" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted-foreground">
          A receiver locks onto the first transfer it sees. Reset it if the sender changed its
          options and started a new one.
        </span>
        <span class="grow" />
        <Button variant="ghost" size="sm" @click="resetReceive">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>
      </div>
    </template>
  </div>
</template>
