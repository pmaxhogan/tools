<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import jsQR from "jsqr";
import { Check, ScanSearch, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { interpret, type DecodeResult } from "@/tools/qr-code-scanner/index";
import type { RawImage } from "@/tools/qr-code-scanner/detector";
import {
  type DeepEngine,
  type DownloadProgress,
  type Inversion,
  type ScanHit,
  type ScanMethod,
  deepModelCached,
  deepScan,
  ensureDeepEngine,
  scanStandard,
} from "@/lib/qr-scan";
import { shouldAutoDownload } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for the QR scanner. The generic ToolShell reads one textarea;
 * this tool needs a live camera feed, a decode loop over canvas frames, an
 * image upload path, and the staged engine cascade in src/lib/qr-scan.ts:
 * jsQR, then zxing-wasm, then the ML deep scan (detector + bow-corrected
 * rectification). The pure layer in src/tools/qr-code-scanner/ owns payload
 * interpretation and all geometry; this file moves pixels and paints results.
 *
 * Nothing here is ever written to the URL fragment or localStorage except the
 * deep-scan preference flag. A scanned code can hold a plaintext Wi-Fi
 * password or a private contact, so decoded content is deliberately kept out
 * of any persistent, shareable, or logged surface.
 */
defineProps<{ meta: ToolMeta }>();

type Mode = "camera" | "upload";
const mode = ref<Mode>("camera");
const MODE_OPTIONS: SegmentedOption[] = [
  { value: "camera", label: "Camera" },
  { value: "upload", label: "Upload image" },
];
const inversionStill = ref<Inversion>("attemptBoth");

const inversionSpec: SelectOptionSpec = {
  kind: "select",
  id: "qr-inversion",
  label: "Color handling",
  default: "attemptBoth",
  options: [
    {
      value: "attemptBoth",
      label: "Standard and inverted",
      synonyms: ["both", "auto", "either", "try both"],
    },
    {
      value: "dontInvert",
      label: "Standard only (dark on light)",
      synonyms: ["normal", "dark on light", "no invert"],
    },
    {
      value: "onlyInvert",
      label: "Inverted only (light on dark)",
      synonyms: ["invert", "light on dark", "reversed"],
    },
  ],
};

/** One decoded code, interpreted for display. */
interface ResultItem {
  result: DecodeResult;
  method: ScanMethod;
}

const results = shallowRef<ResultItem[]>([]);
const unreadCount = ref(0);
const error = ref<{ message: string; fix?: string } | null>(null);
const busyMessage = ref("");

const METHOD_LABELS: Record<ScanMethod, string> = {
  jsqr: "quick scan",
  zxing: "standard scan",
  deep: "deep scan",
};

function publishHits(hits: ScanHit[]) {
  const seen = new Set(results.value.map((r) => r.result.text));
  const next = [...results.value];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    next.push({ result: interpret(hit.text), method: hit.method });
  }
  results.value = next;
}

/* ---------------------------------------------------------------- */
/* deep scan engine state                                            */
/* ---------------------------------------------------------------- */

/**
 * The one-time engine download is about 40 MB (the ONNX runtime plus the
 * trained detector), kept in the browser cache afterwards. It starts on its
 * own where the connection is not metered; on metered connections it waits
 * for a tap, matching every other engine download on this site.
 */
const DEEP_DOWNLOAD_BYTES = 40 * 1024 * 1024;
/** localStorage key for "the visitor turned deep scan on" (a preference). */
const DEEP_PREF_KEY = "qr-scanner-deep";

type DeepState = "idle" | "offered" | "downloading" | "ready" | "failed";
const deepState = ref<DeepState>("idle");
const deepProgress = ref<DownloadProgress>({ received: 0, total: 0 });
let engine: DeepEngine | null = null;

function deepPreferred(): boolean {
  try {
    return localStorage.getItem(DEEP_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDeepPreference() {
  try {
    localStorage.setItem(DEEP_PREF_KEY, "1");
  } catch {
    // Preferences only; losing this costs one extra tap next visit.
  }
}

async function loadDeepEngine(): Promise<DeepEngine | null> {
  if (engine) return engine;
  deepState.value = "downloading";
  try {
    engine = await ensureDeepEngine((p) => (deepProgress.value = p));
    deepState.value = "ready";
    rememberDeepPreference();
    return engine;
  } catch {
    deepState.value = "failed";
    return null;
  }
}

/** Whether the deep engine may start loading without a tap right now. */
async function deepMayAutoload(): Promise<boolean> {
  if (engine) return true;
  if (deepPreferred() || (await deepModelCached())) return true;
  return shouldAutoDownload();
}

/* ---------------------------------------------------------------- */
/* upload                                                            */
/* ---------------------------------------------------------------- */

/** The last uploaded image, kept so a deep scan tap can rerun it. */
let lastUpload: RawImage | null = null;
let lastUploadHits: ScanHit[] = [];

async function runDeepOn(image: RawImage, known: ScanHit[]) {
  const eng = await loadDeepEngine();
  if (!eng) return;
  const hadResults = results.value.length > 0;
  busyMessage.value = hadResults
    ? "Deep scan is checking for more codes…"
    : "Deep scan is looking for codes…";
  try {
    const deep = await deepScan(eng, image, known);
    publishHits(deep.hits);
    unreadCount.value = deep.unread.length;
    if (!results.value.length && !deep.unread.length) {
      error.value = {
        message: "No QR code was found, even with the deep scan.",
        fix: "Try a shot where the code is larger, sharper, or better lit.",
      };
    }
  } finally {
    busyMessage.value = "";
  }
}

async function processUpload(image: RawImage) {
  results.value = [];
  unreadCount.value = 0;
  error.value = null;
  busyMessage.value = "Scanning…";
  lastUpload = image;
  try {
    const hits = await scanStandard(image, inversionStill.value);
    lastUploadHits = hits;
    publishHits(hits);
  } finally {
    busyMessage.value = "";
  }

  if (!results.value.length) {
    // Nothing found: the deep pass runs on its own, downloading the engine
    // if the connection allows, otherwise waiting for one tap.
    if (await deepMayAutoload()) {
      await runDeepOn(image, lastUploadHits);
    } else {
      deepState.value = "offered";
      error.value = {
        message: "No QR code was found by the standard scan.",
        fix: "The deep scan can find small, warped, or damaged codes.",
      };
    }
  } else if (engine || (await deepModelCached())) {
    // Something found and the engine is already on hand: sweep for further
    // codes the classical pass missed. No download is started just for this.
    await runDeepOn(image, lastUploadHits);
  } else {
    deepState.value = "offered";
  }
}

async function startOfferedDeep() {
  if (!lastUpload) return;
  error.value = null;
  await runDeepOn(lastUpload, lastUploadHits);
}

function decodeImageElement(img: HTMLImageElement) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    error.value = { message: "That image has no pixels to read.", fix: "Try a different file." };
    return;
  }
  // Very large photos are decoded at up to ~12 MP; enough detail for the
  // decoders while keeping the pixel buffers manageable.
  const scale = Math.min(1, 3500 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  void processUpload({ data: image.data, width: image.width, height: image.height });
}

function acceptFile(file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image, so there is no code to read.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF that shows a QR code.",
    };
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    decodeImageElement(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    error.value = { message: "That image could not be decoded.", fix: "Try a different file." };
  };
  img.src = url;
}

/**
 * A QR screenshot is a common input, and FileDrop listens for a pasted file
 * while it is mounted, which is exactly while upload mode is on.
 */
function onFiles(files: File[]) {
  acceptFile(files[0]);
}

/* ---------------------------------------------------------------- */
/* camera                                                            */
/* ---------------------------------------------------------------- */

const videoEl = ref<HTMLVideoElement>();
const scanning = ref(false);
const torchOn = ref(false);
const torchSupported = ref(false);
const deepAssist = ref(false);

/** The MediaStream is not reactive: Vue must never proxy a live track. */
let stream: MediaStream | null = null;
let videoTrack: MediaStreamTrack | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;
/** Reused offscreen canvases so we are not allocating per frame. */
let fastCanvas: HTMLCanvasElement | null = null;
let fullCanvas: HTMLCanvasElement | null = null;

/** Longest edge for the cheap per-tick jsQR pass. */
const SCAN_MAX_EDGE = 720;
const SCAN_INTERVAL_MS = 150;
/** The zxing pass reads the full frame, a few times a second at most. */
const ZXING_INTERVAL_MS = 600;
/** Deep assist cadence adapts to measured inference time. */
const DEEP_MIN_INTERVAL_MS = 1200;

let zxingBusy = false;
let lastZxingAt = 0;
let deepBusy = false;
let lastDeepAt = 0;
let lastDeepCostMs = 0;

function describeCameraError(e: unknown): { message: string; fix?: string } {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      message: "Camera access was blocked, so the live scanner cannot start.",
      fix: "Allow the camera for this page in your browser, or switch to Upload image and scan a photo of the code instead.",
    };
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  )
    return {
      message: "No camera was found on this device.",
      fix: "Switch to Upload image and scan a photo or screenshot of the code instead.",
    };
  return {
    message: `The camera could not be started: ${e instanceof Error ? e.message : String(e)}`,
    fix: "Switch to Upload image and scan a photo of the code instead.",
  };
}

async function startCamera() {
  error.value = null;
  results.value = [];
  unreadCount.value = 0;
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = describeCameraError(new DOMException("", "NotFoundError"));
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
    videoTrack = stream.getVideoTracks()[0] ?? null;

    // Torch is a Chromium-on-mobile extension and is not in the DOM types.
    const caps = videoTrack?.getCapabilities?.() as { torch?: boolean } | undefined;
    torchSupported.value = Boolean(caps?.torch);
    torchOn.value = false;

    const video = videoEl.value;
    if (!video) return;
    video.srcObject = stream;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });
    await video.play();

    scanning.value = true;
    lastZxingAt = 0;
    lastDeepAt = 0;
    scanTimer = setInterval(scanTick, SCAN_INTERVAL_MS);
    if (deepAssist.value) void loadDeepEngine();
  } catch (e) {
    error.value = describeCameraError(e);
    stopCamera();
  }
}

function stopCamera() {
  clearInterval(scanTimer);
  scanTimer = undefined;
  scanning.value = false;
  torchOn.value = false;
  torchSupported.value = false;
  if (videoEl.value) videoEl.value.srcObject = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  videoTrack = null;
}

async function toggleTorch() {
  if (!videoTrack) return;
  const next = !torchOn.value;
  try {
    await (
      videoTrack as MediaStreamTrack & {
        applyConstraints(c: { advanced: { torch: boolean }[] }): Promise<void>;
      }
    ).applyConstraints({ advanced: [{ torch: next }] });
    torchOn.value = next;
  } catch {
    torchSupported.value = false;
  }
}

function grabFrame(maxEdge: number, reuse: "fast" | "full"): RawImage | null {
  const video = videoEl.value;
  if (!video || video.readyState < 2) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxEdge / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  let canvas = reuse === "fast" ? fastCanvas : fullCanvas;
  canvas ??= document.createElement("canvas");
  if (reuse === "fast") fastCanvas = canvas;
  else fullCanvas = canvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  return { data: image.data, width: w, height: h };
}

function cameraHit(hits: ScanHit[]) {
  if (!hits.length || !scanning.value) return;
  publishHits(hits);
  error.value = null;
  stopCamera();
}

function scanTick() {
  if (!scanning.value) return;

  // Cheap pass: jsQR on a downscaled frame, every tick. Live frames are
  // usually dark on light, so the inverted second pass is skipped here.
  const fast = grabFrame(SCAN_MAX_EDGE, "fast");
  if (fast) {
    const found = fastDecode(fast);
    if (found.length) return cameraHit(found);
  }

  const now = Date.now();

  // Robust pass: zxing on the full frame, throttled, never overlapping.
  if (!zxingBusy && now - lastZxingAt >= ZXING_INTERVAL_MS) {
    const full = grabFrame(1920, "full");
    if (full) {
      zxingBusy = true;
      lastZxingAt = now;
      void scanStandard(full, "dontInvert")
        .then((hits) => cameraHit(hits))
        .finally(() => (zxingBusy = false));
    }
  }

  // Deep assist: the detector every couple of seconds, cadence scaled to how
  // long inference actually takes so a slow device is not starved.
  const deepInterval = Math.max(DEEP_MIN_INTERVAL_MS, lastDeepCostMs * 2.5);
  if (deepAssist.value && engine && !deepBusy && now - lastDeepAt >= deepInterval) {
    const full = grabFrame(1920, "full");
    if (full) {
      deepBusy = true;
      lastDeepAt = now;
      const t0 = performance.now();
      void deepScan(engine, full)
        .then((deep) => {
          lastDeepCostMs = performance.now() - t0;
          cameraHit(deep.hits);
        })
        .finally(() => (deepBusy = false));
    }
  }
}

/** The synchronous per-tick pass, kept out of the async engine cascade. */
function fastDecode(image: RawImage): ScanHit[] {
  const found = jsQR(image.data, image.width, image.height, {
    inversionAttempts: "dontInvert",
  });
  return found && found.data ? [{ text: found.data, method: "jsqr" }] : [];
}

async function toggleDeepAssist() {
  if (deepAssist.value) {
    deepAssist.value = false;
    return;
  }
  deepAssist.value = true;
  if (!engine) {
    if (await deepMayAutoload()) void loadDeepEngine();
    else deepState.value = "offered";
  }
}

async function confirmDeepDownload() {
  await loadDeepEngine();
}

/* ---------------------------------------------------------------- */
/* mode + lifecycle                                                  */
/* ---------------------------------------------------------------- */

function setMode(next: Mode) {
  if (next === mode.value) return;
  stopCamera();
  mode.value = next;
  results.value = [];
  unreadCount.value = 0;
  error.value = null;
  busyMessage.value = "";
}

function scanAgain() {
  results.value = [];
  unreadCount.value = 0;
  error.value = null;
  if (mode.value === "camera") void startCamera();
}

function linkFor(item: ResultItem): string | null {
  return item.result.url && item.result.kind === "url" ? item.result.url : null;
}

const deepDownloadPercent = computed(() => {
  const { received, total } = deepProgress.value;
  if (!total) return null;
  return Math.min(100, Math.round((received / total) * 100));
});

onUnmounted(() => {
  stopCamera();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Mode toggle -->
    <Segmented
      :model-value="mode"
      :options="MODE_OPTIONS"
      label="Scan source"
      class="w-fit"
      @update:model-value="(v: string) => setMode(v as Mode)"
    />

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- Deep scan download states -->
    <div
      v-if="deepState === 'offered'"
      class="flex flex-wrap items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm shadow-[var(--sh-inset)]"
    >
      <ScanSearch class="size-4 shrink-0 text-muted-foreground" />
      <span class="text-muted-foreground">
        Deep scan finds small, warped, and damaged codes. It is a one time download of about
        {{ formatBytes(DEEP_DOWNLOAD_BYTES) }} that is saved for next time, and it runs entirely on
        your device.
      </span>
      <Button size="sm" @click="mode === 'upload' ? startOfferedDeep() : confirmDeepDownload()">
        Download and scan
      </Button>
    </div>
    <div
      v-else-if="deepState === 'downloading'"
      class="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
    >
      <span
        class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent"
        aria-hidden="true"
      />
      <span>
        Preparing the deep scanner{{
          deepDownloadPercent === null ? "…" : `: ${deepDownloadPercent}% downloaded`
        }}
      </span>
    </div>
    <div v-else-if="deepState === 'failed'" class="text-sm text-muted-foreground">
      The deep scanner could not be loaded. The standard scan still works; check your connection and
      try again.
    </div>

    <!-- Busy -->
    <div
      v-if="busyMessage"
      class="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <span
        class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent"
        aria-hidden="true"
      />
      {{ busyMessage }}
    </div>

    <!-- Camera -->
    <div v-if="mode === 'camera'" class="flex flex-col gap-3">
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
          v-if="scanning"
          class="scan-frame pointer-events-none absolute inset-0"
          aria-hidden="true"
        />
        <div
          v-if="!scanning && !results.length"
          class="flex min-h-56 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
        >
          <p class="max-w-sm text-sm text-white/80">
            Point your camera at a QR code. The scan runs in this tab and your files and inputs
            never leave your device.
          </p>
          <Button size="sm" @click="startCamera"> Start camera </Button>
        </div>
      </div>

      <div v-if="scanning" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted-foreground"
          >Scanning… hold the code steady in the frame.</span
        >
        <span class="grow" />
        <Button variant="outline" size="sm" :aria-pressed="deepAssist" @click="toggleDeepAssist">
          {{ deepAssist ? "Deep scan on" : "Deep scan" }}
        </Button>
        <Button
          v-if="torchSupported"
          variant="outline"
          size="sm"
          :aria-pressed="torchOn"
          @click="toggleTorch"
        >
          {{ torchOn ? "Torch off" : "Torch on" }}
        </Button>
        <Button variant="ghost" size="sm" @click="stopCamera"> Stop </Button>
      </div>
    </div>

    <!-- Upload -->
    <div v-else class="flex flex-col gap-3">
      <FileDrop
        accept="image/*"
        label="Drop an image of a QR code here or click to choose"
        hint="You can also press Ctrl+V to paste a screenshot. It is decoded on your device: your files and inputs never leave your device."
        @files="onFiles"
      />

      <div class="flex w-56 flex-col gap-1.5">
        <Label for="qr-inversion" class="text-xs text-muted-foreground">Color handling</Label>
        <SearchableSelect
          id="qr-inversion"
          :spec="inversionSpec"
          :model-value="inversionStill"
          class="w-full bg-card"
          @update:model-value="(v) => (inversionStill = v as Inversion)"
        />
      </div>
    </div>

    <!-- Results -->
    <div
      v-for="(item, index) in results"
      :key="item.result.text"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span
          class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <Check class="size-3.5 text-[var(--positive)]" />
          {{ item.result.label }}
          <span v-if="results.length > 1" class="font-normal normal-case">
            ({{ index + 1 }} of {{ results.length }})
          </span>
        </span>
        <div class="flex items-center gap-1">
          <span class="text-[11px] text-muted-foreground"
            >found by {{ METHOD_LABELS[item.method] }}</span
          >
          <CopyButton :text="item.result.text" label="Copy" />
          <Button v-if="index === 0" variant="ghost" size="sm" @click="scanAgain">
            Scan again
          </Button>
        </div>
      </div>

      <!-- Structured fields, when the payload shape is understood -->
      <dl
        v-if="item.result.fields?.length"
        class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]"
      >
        <template v-for="field in item.result.fields" :key="field.label">
          <dt class="text-xs text-muted-foreground sm:pt-0.5">
            {{ field.label }}
          </dt>
          <dd class="text-sm break-words">
            {{ field.value }}
          </dd>
        </template>
      </dl>

      <!-- Safe link: shown, never auto-opened, and only for http(s) -->
      <a
        v-if="linkFor(item)"
        :href="linkFor(item)!"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm font-medium break-all text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {{ linkFor(item) }}
      </a>

      <!-- Raw decoded text -->
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Decoded text</span>
        <pre
          class="max-h-56 overflow-auto rounded-[6px] bg-card p-2 font-mono text-xs break-all whitespace-pre-wrap shadow-[var(--sh-inset)]"
          >{{ item.result.text }}</pre>
      </div>
    </div>

    <!-- Detected but unreadable codes -->
    <div v-if="unreadCount > 0" class="flex items-center gap-2 text-xs text-muted-foreground">
      <ScanSearch class="size-3.5 shrink-0" />
      <span>
        The deep scan saw {{ unreadCount === 1 ? "a code shape" : `${unreadCount} code shapes` }} it
        could not read. Too much of the pattern is missing or blurred; a closer, sharper shot may
        decode.
      </span>
    </div>

    <!-- Empty result affordance for a stopped camera -->
    <div
      v-else-if="mode === 'camera' && !scanning && !results.length"
      class="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <X class="size-3.5" />
      Nothing scanned yet.
    </div>
  </div>
</template>

<style scoped>
/*
 * A single sweeping guide line over the live feed. It is purely decorative, so
 * it is removed entirely for anyone who prefers reduced motion.
 */
.scan-frame::after {
  content: "";
  position: absolute;
  left: 8%;
  right: 8%;
  top: 0;
  height: 2px;
  background: var(--primary);
  opacity: 0.8;
  box-shadow: 0 0 8px var(--primary);
  animation: qr-scan 2s ease-in-out infinite;
}

@keyframes qr-scan {
  0% {
    top: 12%;
  }
  50% {
    top: 88%;
  }
  100% {
    top: 12%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scan-frame::after {
    animation: none;
    top: 50%;
  }
}
</style>
