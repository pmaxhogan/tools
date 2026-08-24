<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import { Check, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { decodeQr, type DecodeResult } from "@/tools/qr-code-scanner/index";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the QR scanner. The generic ToolShell reads one textarea;
 * this tool needs a live camera feed, a throttled decode loop over canvas
 * frames, and an image upload path, all of which live here. The pure layer in
 * `src/tools/qr-code-scanner/` owns every payload interpretation and the
 * jsQR call; this file only moves pixels into it and paints the result.
 *
 * Nothing here is ever written to the URL fragment or localStorage. A scanned
 * code can hold a plaintext Wi-Fi password or a private contact, so the decoded
 * content is deliberately kept out of any persistent, shareable, or logged
 * surface (mirroring the Wi-Fi exclusion in the QR generator panel).
 */
defineProps<{ meta: ToolMeta }>();

type Mode = "camera" | "upload";
const mode = ref<Mode>("camera");
const MODE_OPTIONS: SegmentedOption[] = [
  { value: "camera", label: "Camera" },
  { value: "upload", label: "Upload image" },
];
/** Subset of QrOpts['inversion'] the UI offers; 'invertFirst' has no control here. */
type Inversion = "attemptBoth" | "dontInvert" | "onlyInvert";
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

const result = shallowRef<DecodeResult | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

/* ---------------------------------------------------------------- */
/* camera                                                           */
/* ---------------------------------------------------------------- */

const videoEl = ref<HTMLVideoElement>();
const scanning = ref(false);
const torchOn = ref(false);
const torchSupported = ref(false);

/** The MediaStream is not reactive: Vue must never proxy a live track. */
let stream: MediaStream | null = null;
let videoTrack: MediaStreamTrack | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;
/** A reused offscreen canvas so we are not allocating one per frame. */
let scanCanvas: HTMLCanvasElement | null = null;

/** Longest edge we downscale a camera frame to before decoding, for speed. */
const SCAN_MAX_EDGE = 720;
/** Decode a handful of times a second rather than on every animation frame. */
const SCAN_INTERVAL_MS = 150;

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
  result.value = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = describeCameraError(new DOMException("", "NotFoundError"));
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    videoTrack = stream.getVideoTracks()[0] ?? null;

    // Torch is a Chromium-on-mobile extension and is not in the DOM types, and
    // MediaTrackCapabilities itself has no runtime global (unlike
    // MediaStreamTrack), so referencing it by name trips eslint's no-undef.
    // Assert only the one field this panel reads instead.
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
    scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
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
    // Some devices report the capability but reject the constraint; hide it.
    torchSupported.value = false;
  }
}

function scanFrame() {
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

  try {
    // Live frames are always dark-on-light off a screen or print, so we skip the
    // second inverted pass here to keep the loop cheap.
    const decoded = decodeQr(image, { inversion: "dontInvert" });
    // Freeze on a hit: stop the camera, show the result, offer "Scan again".
    result.value = decoded;
    error.value = null;
    stopCamera();
  } catch {
    // No code in this frame. Keep scanning silently.
  }
}

/* ---------------------------------------------------------------- */
/* upload                                                           */
/* ---------------------------------------------------------------- */

const fileInput = ref<HTMLInputElement>();
const dragging = ref(false);

function decodeImageElement(img: HTMLImageElement) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    error.value = { message: "That image has no pixels to read.", fix: "Try a different file." };
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, w, h);
  try {
    result.value = decodeQr(image, { inversion: inversionStill.value });
    error.value = null;
  } catch (e) {
    result.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
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

function onDrop(e: DragEvent) {
  dragging.value = false;
  acceptFile(e.dataTransfer?.files[0]);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  acceptFile(picker.files?.[0]);
  picker.value = "";
}

/**
 * A QR screenshot is a common input and the visitor has not clicked into the
 * panel yet, so the paste listener sits on the window while upload mode is on.
 */
function onPaste(e: ClipboardEvent) {
  if (mode.value !== "upload") return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const pasted = item.getAsFile();
      if (pasted) {
        e.preventDefault();
        acceptFile(pasted);
        return;
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* mode + lifecycle                                                 */
/* ---------------------------------------------------------------- */

function setMode(next: Mode) {
  if (next === mode.value) return;
  stopCamera();
  mode.value = next;
  result.value = null;
  error.value = null;
}

function scanAgain() {
  result.value = null;
  error.value = null;
  if (mode.value === "camera") startCamera();
}

const linkResult = computed(() =>
  result.value?.url && result.value.kind === "url" ? result.value.url : null,
);

if (typeof window !== "undefined") window.addEventListener("paste", onPaste);

onUnmounted(() => {
  if (typeof window !== "undefined") window.removeEventListener("paste", onPaste);
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
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
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
          v-if="!scanning && !result"
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
      <div
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="dragging ? 'ring-2 ring-ring' : ''"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Image
          </span>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
        </div>
        <div class="px-3 pt-1 pb-4">
          <p class="text-sm text-muted-foreground">
            Drop an image of a QR code here, pick one with the file button, or press Ctrl+V to paste
            a screenshot. It is decoded on your device: your files and inputs never leave your
            device.
          </p>
        </div>
      </div>

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

    <!-- Result -->
    <div
      v-if="result"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span
          class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <Check class="size-3.5 text-[var(--positive)]" />
          {{ result.label }}
        </span>
        <div class="flex items-center gap-1">
          <CopyButton :text="result.text" label="Copy" />
          <Button variant="ghost" size="sm" @click="scanAgain"> Scan again </Button>
        </div>
      </div>

      <!-- Structured fields, when the payload shape is understood -->
      <dl
        v-if="result.fields?.length"
        class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]"
      >
        <template v-for="field in result.fields" :key="field.label">
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
        v-if="linkResult"
        :href="linkResult"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm font-medium break-all text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {{ linkResult }}
      </a>

      <!-- Raw decoded text -->
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Decoded text</span>
        <pre
          class="max-h-56 overflow-auto rounded-[6px] bg-card p-2 font-mono text-xs break-all whitespace-pre-wrap shadow-[var(--sh-inset)]"
          >{{ result.text }}</pre>
      </div>
    </div>

    <!-- Empty result affordance for a stopped camera -->
    <div
      v-else-if="mode === 'camera' && !scanning"
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
