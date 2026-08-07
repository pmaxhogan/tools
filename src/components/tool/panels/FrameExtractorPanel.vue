<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { ChevronLeft, ChevronRight, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  formatTimecode,
  frameName,
  isBurstError,
  parseTimeSpec,
  planBurst,
} from "@/tools/video-frame-extractor/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the frame extractor. There is no pure transform that turns
 * a video into a still: the pixels have to come off a decoder. So the panel
 * owns a video element plus a canvas, and the logic layer owns everything that
 * can be decided without decoding (time parsing, timecodes, file names, burst
 * planning).
 *
 * Nothing touches the DOM until a file arrives, so this renders inert on the
 * server.
 */
const props = defineProps<{ meta: ToolMeta }>();

/** Defaults live in meta.ts so the page copy and the panel cannot drift apart. */
function optionDefault<T>(id: string, fallback: T): T {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec ? (spec.default as T) : fallback;
}

interface CapturedFrame {
  id: number;
  /** Position the video actually reported, not the one that was requested. */
  time: number;
  url: string;
  name: string;
  size: number;
  width: number;
  height: number;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileInput = ref<HTMLInputElement>();
const videoEl = ref<HTMLVideoElement>();

const fileName = ref("");
const videoUrl = ref<string | null>(null);
const duration = ref(0);
const currentTime = ref(0);
const videoWidth = ref(0);
const videoHeight = ref(0);
const decodeFailed = ref(false);
const dragging = ref(false);
const busy = ref(false);

const frames = ref<CapturedFrame[]>([]);
let nextFrameId = 1;

// Numeric fields keep their raw text so a half typed "0." is never rewritten
// under the cursor. The parsed value falls back only when it is actually used.
const stepText = ref("0.033");
const timeText = ref("");
const timeInvalid = ref(false);

const burstCountText = ref(String(optionDefault("count", 1)));
const burstInterval = ref(String(optionDefault("interval", "1")));
const format = ref(String(optionDefault("format", "png")));
const quality = ref(Number(optionDefault("quality", 92)));

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "fx-format",
  label: "Format",
  default: "png",
  options: [
    {
      value: "png",
      label: "PNG",
      synonyms: ["lossless", "portable network graphics", "transparent"],
    },
    { value: "jpeg", label: "JPEG", synonyms: ["jpg", "lossy", "photo", "compressed"] },
    { value: "webp", label: "WebP", synonyms: ["web picture", "google webp", "modern format"] },
  ],
};

const error = ref<{ message: string; fix?: string } | null>(null);

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const MIME_FOR_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const hasVideo = computed(() => videoUrl.value !== null);
const canCapture = computed(() => hasVideo.value && videoWidth.value > 0 && !decodeFailed.value);

/** One nudge of the frame buttons, in seconds. Defaults to a 30 fps frame. */
const stepSec = computed(() => {
  const value = Number(stepText.value);
  return Number.isFinite(value) && value > 0 ? value : 0.033;
});

/** Empty or nonsense reads as 0, which planBurst rejects with a real message. */
const burstCount = computed(() => Number(burstCountText.value));

/**
 * Browsers do not expose a video's real frame rate, so the frame number in the
 * readout is derived from the step setting. It is a reading aid, not a claim
 * about the file.
 */
const assumedFps = computed(() => {
  const fps = Math.round(1 / stepSec.value);
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : undefined;
});

const timecode = computed(() => formatTimecode(currentTime.value, assumedFps.value));
const durationLabel = computed(() => formatTimecode(duration.value));
const isLossless = computed(() => format.value === "png");

const burstPreview = computed(() => {
  const intervalSec = parseTimeSpec(burstInterval.value);
  if (intervalSec === null) return null;
  return planBurst({
    startSec: currentTime.value,
    count: burstCount.value,
    intervalSec,
    durationSec: duration.value || Number.POSITIVE_INFINITY,
  });
});

const burstReady = computed(() => burstPreview.value !== null && !isBurstError(burstPreview.value));

const totalCapturedBytes = computed(() => frames.value.reduce((sum, frame) => sum + frame.size, 0));

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

function clampTime(seconds: number): number {
  const end = duration.value > 0 ? duration.value : seconds;
  return Math.min(Math.max(0, seconds), end);
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function revokeFrames() {
  for (const frame of frames.value) URL.revokeObjectURL(frame.url);
  frames.value = [];
}

function loadFile(file: File) {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
  revokeFrames();
  error.value = null;
  decodeFailed.value = false;
  duration.value = 0;
  currentTime.value = 0;
  videoWidth.value = 0;
  videoHeight.value = 0;
  timeText.value = "";
  timeInvalid.value = false;
  fileName.value = file.name;
  videoUrl.value = URL.createObjectURL(file);
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (file) loadFile(file);
  // Reset so picking the same file again still fires a change event.
  picker.value = "";
}

function clearFile() {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
  videoUrl.value = null;
  revokeFrames();
  fileName.value = "";
  duration.value = 0;
  currentTime.value = 0;
  videoWidth.value = 0;
  videoHeight.value = 0;
  decodeFailed.value = false;
  error.value = null;
  timeText.value = "";
  timeInvalid.value = false;
  if (fileInput.value) fileInput.value.value = "";
}

function onLoadedMetadata() {
  const el = videoEl.value;
  if (!el) return;
  duration.value = Number.isFinite(el.duration) ? el.duration : 0;
  videoWidth.value = el.videoWidth;
  videoHeight.value = el.videoHeight;
  decodeFailed.value = false;
}

function onTimeUpdate() {
  const el = videoEl.value;
  if (el) currentTime.value = el.currentTime;
}

function onVideoError() {
  decodeFailed.value = true;
  error.value = {
    message: "This browser cannot play that file, so there is nothing to capture from.",
    fix: "Try an MP4 (H.264), WebM, or MOV file. Formats a browser cannot decode need a converter first.",
  };
}

/* ---------------------------------------------------------------- */
/* seeking                                                           */
/* ---------------------------------------------------------------- */

/**
 * Seek and wait for the frame to actually be presented. A seek to the position
 * the video is already at never fires "seeked", so that case returns straight
 * away, and the wait is capped so a codec quirk cannot wedge a burst forever.
 */
function seekTo(target: number): Promise<void> {
  const el = videoEl.value;
  if (!el) return Promise.resolve();
  const wanted = clampTime(target);
  if (Math.abs(el.currentTime - wanted) < 0.0005) {
    currentTime.value = el.currentTime;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("seeked", finish);
      currentTime.value = el.currentTime;
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    el.addEventListener("seeked", finish);
    el.currentTime = wanted;
  });
}

async function stepBy(direction: number) {
  const el = videoEl.value;
  if (!el) return;
  el.pause();
  await seekTo(el.currentTime + direction * stepSec.value);
}

async function goToTypedTime() {
  const parsed = parseTimeSpec(timeText.value);
  if (parsed === null) {
    timeInvalid.value = true;
    return;
  }
  timeInvalid.value = false;
  const el = videoEl.value;
  if (el) el.pause();
  await seekTo(parsed);
}

function onTimeTextInput(value: unknown) {
  timeText.value = String(value ?? "");
  timeInvalid.value = false;
}

function useCurrentTime() {
  timeText.value = formatTimecode(currentTime.value);
  timeInvalid.value = false;
}

/* ---------------------------------------------------------------- */
/* capture                                                           */
/* ---------------------------------------------------------------- */

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, q);
  });
}

/** Draws the current video frame at its native pixel size and stores the result. */
async function captureCurrentFrame(index?: number): Promise<boolean> {
  const el = videoEl.value;
  if (!el || !el.videoWidth || !el.videoHeight) {
    error.value = {
      message: "The video has not decoded a frame yet, so there is nothing to capture.",
      fix: "Let the player load, then scrub to the moment you want and try again.",
    };
    return false;
  }

  const canvas = document.createElement("canvas");
  canvas.width = el.videoWidth;
  canvas.height = el.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    error.value = {
      message: "This browser did not give the page a 2D canvas to draw the frame on.",
      fix: "Hardware acceleration or canvas support may be switched off. Try another browser.",
    };
    return false;
  }

  const type = MIME_FOR_FORMAT[format.value] ?? "image/png";
  // undefined means the read itself was refused (a tainted or protected video),
  // null means the encoder declined the format. They need different advice.
  const blob = await (async (): Promise<Blob | null | undefined> => {
    try {
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      return await canvasToBlob(canvas, type, isLossless.value ? undefined : quality.value / 100);
    } catch {
      return undefined;
    }
  })();

  if (blob === undefined) {
    error.value = {
      message: "The browser refused to read pixels back from this video.",
      fix: "This happens with protected or DRM video. Use a file that is not encrypted.",
    };
    return false;
  }

  if (!blob) {
    error.value = {
      message: "This browser could not encode the frame in the selected format.",
      fix: "Choose PNG or JPEG, which every browser can write, and try again.",
    };
    return false;
  }

  // A browser may quietly fall back to PNG for a format it cannot write, so the
  // extension comes from what was actually produced.
  const ext = EXTENSION_FOR_MIME[blob.type] ?? "png";
  const time = el.currentTime;
  frames.value = [
    ...frames.value,
    {
      id: nextFrameId++,
      time,
      url: URL.createObjectURL(blob),
      name: frameName(fileName.value, time, index, ext),
      size: blob.size,
      width: canvas.width,
      height: canvas.height,
    },
  ];
  error.value = null;
  return true;
}

async function captureOne() {
  if (busy.value) return;
  busy.value = true;
  try {
    videoEl.value?.pause();
    await captureCurrentFrame();
  } finally {
    busy.value = false;
  }
}

async function captureBurst() {
  if (busy.value) return;
  const el = videoEl.value;
  if (!el) return;

  const intervalSec = parseTimeSpec(burstInterval.value);
  if (intervalSec === null) {
    error.value = {
      message: `"${burstInterval.value}" is not a readable interval.`,
      fix: "Give the gap between burst frames in seconds, such as 1 or 0.5.",
    };
    return;
  }

  // Capturing while the video plays would grab whatever frame is current, not
  // the planned one.
  el.pause();

  const plan = planBurst({
    startSec: el.currentTime,
    count: burstCount.value,
    intervalSec,
    durationSec: duration.value || Number.POSITIVE_INFINITY,
  });
  if (isBurstError(plan)) {
    error.value = { message: plan.error, fix: plan.fix };
    return;
  }

  busy.value = true;
  try {
    const multiple = plan.times.length > 1;
    for (let i = 0; i < plan.times.length; i++) {
      await seekTo(plan.times[i]!);
      const ok = await captureCurrentFrame(multiple ? i + 1 : undefined);
      if (!ok) break;
    }
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* the captured strip                                                */
/* ---------------------------------------------------------------- */

function downloadFrame(frame: CapturedFrame) {
  triggerDownload(frame.url, frame.name);
}

async function downloadAll() {
  if (busy.value || frames.value.length === 0) return;
  busy.value = true;
  try {
    // Saved one at a time rather than zipped, so nothing has to be held twice
    // in memory. Browsers throttle back to back downloads, hence the spacing.
    for (const frame of [...frames.value]) {
      triggerDownload(frame.url, frame.name);
      await delay(250);
    }
  } finally {
    busy.value = false;
  }
}

function removeFrame(id: number) {
  const frame = frames.value.find((f) => f.id === id);
  if (!frame) return;
  URL.revokeObjectURL(frame.url);
  frames.value = frames.value.filter((f) => f.id !== id);
}

function clearFrames() {
  revokeFrames();
}

async function goToFrameTime(frame: CapturedFrame) {
  videoEl.value?.pause();
  await seekTo(frame.time);
}

onUnmounted(() => {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
  for (const frame of frames.value) URL.revokeObjectURL(frame.url);
});
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
          Video
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
        <input ref="fileInput" type="file" class="hidden" accept="video/*" @change="onPickFile" />
      </div>

      <div v-if="hasVideo" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span v-if="videoWidth" class="shrink-0 text-muted-foreground tabular-nums"
            >{{ videoWidth }} x {{ videoHeight }}</span
          >
          <button
            type="button"
            aria-label="Remove video"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
        Drop a video here to scrub through it and save frames at full resolution. Everything runs in
        this tab: your files and inputs never leave your device.
      </p>
    </div>

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

    <!-- Player and capture controls -->
    <div v-if="hasVideo" class="flex flex-col gap-4">
      <div class="overflow-hidden rounded-[10px] bg-black shadow-[var(--sh-inset)]">
        <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
        <video
          ref="videoEl"
          :src="videoUrl ?? ''"
          controls
          playsinline
          preload="auto"
          class="block max-h-[440px] w-full bg-black"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
          @seeked="onTimeUpdate"
          @error="onVideoError"
        />
      </div>

      <!-- Fine scrub -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Scrub
          </span>
          <span class="font-mono text-sm tabular-nums">
            {{ timecode }}
            <span class="text-muted-foreground">/ {{ durationLabel }}</span>
          </span>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex items-center gap-2 pb-0.5">
            <Button
              variant="outline"
              size="sm"
              aria-label="Step one frame back"
              :disabled="busy"
              @click="stepBy(-1)"
            >
              <ChevronLeft class="size-4" />
              Frame
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Step one frame forward"
              :disabled="busy"
              @click="stepBy(1)"
            >
              Frame
              <ChevronRight class="size-4" />
            </Button>
          </div>

          <div class="flex w-28 flex-col gap-1.5">
            <Label for="fx-step" class="text-xs text-muted-foreground">Step (seconds)</Label>
            <Input
              id="fx-step"
              type="number"
              min="0.001"
              step="0.001"
              :model-value="stepText"
              class="h-9 bg-card"
              @update:model-value="(v) => (stepText = String(v ?? ''))"
            />
          </div>

          <div class="flex w-44 flex-col gap-1.5">
            <Label for="fx-time" class="text-xs text-muted-foreground">Go to time</Label>
            <Input
              id="fx-time"
              type="text"
              placeholder="00:01:12.500"
              :model-value="timeText"
              :aria-invalid="timeInvalid"
              class="h-9 bg-card font-mono"
              @update:model-value="onTimeTextInput"
              @keyup.enter="goToTypedTime"
            />
          </div>

          <div class="flex items-center gap-2 pb-0.5">
            <Button size="sm" :disabled="busy" @click="goToTypedTime"> Go </Button>
            <Button variant="ghost" size="sm" @click="useCurrentTime"> Use current </Button>
          </div>
        </div>

        <p v-if="timeInvalid" class="text-xs text-destructive">
          That is not a time this tool can read. Use seconds (12.5), mm:ss (01:12), or hh:mm:ss.mmm
          (00:01:12.500).
        </p>
        <p class="text-xs text-muted-foreground">
          Browsers do not report a video's real frame rate, so the frame number after the timecode
          is worked out from the step above. Set the step to match your footage: 0.042 for 24 fps,
          0.033 for 30 fps, 0.017 for 60 fps.
        </p>
      </div>

      <!-- Capture -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Capture
        </span>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-28 flex-col gap-1.5">
            <Label for="fx-format" class="text-xs text-muted-foreground">Format</Label>
            <SearchableSelect
              id="fx-format"
              :spec="formatSpec"
              :model-value="format"
              @update:model-value="(v) => (format = String(v))"
            />
          </div>

          <div class="flex min-w-44 flex-1 flex-col gap-1.5">
            <!-- The slider's focusable element is its thumb, not the root, so
                 this is plain text plus an aria-label rather than a <label for>
                 pointing at something that cannot take focus. -->
            <span class="text-xs text-muted-foreground tabular-nums">
              Quality: {{ isLossless ? "lossless" : quality }}
            </span>
            <Slider
              aria-label="Capture quality"
              :model-value="[quality]"
              :min="1"
              :max="100"
              :step="1"
              :disabled="isLossless"
              class="py-2"
              @update:model-value="(v) => (quality = v?.[0] ?? quality)"
            />
          </div>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-24 flex-col gap-1.5">
            <Label for="fx-count" class="text-xs text-muted-foreground">Burst frames</Label>
            <Input
              id="fx-count"
              type="number"
              min="1"
              max="30"
              :model-value="burstCountText"
              class="h-9 bg-card"
              @update:model-value="(v) => (burstCountText = String(v ?? ''))"
            />
          </div>
          <div class="flex w-28 flex-col gap-1.5">
            <Label for="fx-interval" class="text-xs text-muted-foreground">Interval (s)</Label>
            <Input
              id="fx-interval"
              type="text"
              :model-value="burstInterval"
              class="h-9 bg-card font-mono"
              @update:model-value="(v) => (burstInterval = String(v ?? ''))"
            />
          </div>
          <div class="flex flex-wrap items-center gap-2 pb-0.5">
            <Button size="sm" :disabled="!canCapture || busy" @click="captureOne">
              Capture this frame
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="!canCapture || busy || !burstReady"
              @click="captureBurst"
            >
              Capture burst
            </Button>
          </div>
        </div>

        <p v-if="!burstPreview" class="text-xs text-destructive">
          The interval must be a number of seconds, such as 1 or 0.5.
        </p>
        <p v-else-if="isBurstError(burstPreview)" class="text-xs text-destructive">
          {{ burstPreview.error }}
          <span v-if="burstPreview.fix" class="text-muted-foreground">{{ burstPreview.fix }}</span>
        </p>
        <p class="text-xs text-muted-foreground">
          Captures are drawn at the video's own pixel size, so nothing is scaled down. A burst
          pauses playback, seeks to each planned time in turn, and captures there. Browsers seek to
          the nearest decodable frame, so a capture can land a few milliseconds either side of the
          time you asked for. Each thumbnail below is labelled with the position the video actually
          reported.
        </p>
      </div>

      <!-- Captured frames -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Captured frames
            <span v-if="frames.length" class="tabular-nums"
              >({{ frames.length }}, {{ humanSize(totalCapturedBytes) }})</span
            >
          </span>
          <div v-if="frames.length" class="flex items-center gap-2">
            <Button size="sm" :disabled="busy" @click="downloadAll"> Download all </Button>
            <Button variant="ghost" size="sm" :disabled="busy" @click="clearFrames"> Clear </Button>
          </div>
        </div>

        <p
          v-if="!frames.length"
          class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
        >
          No frames yet. Scrub to a moment and press "Capture this frame".
        </p>

        <ul v-else class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
          <li
            v-for="frame in frames"
            :key="frame.id"
            class="flex flex-col gap-2 rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
          >
            <button
              type="button"
              class="block overflow-hidden rounded-[8px] bg-black outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              :title="`Seek the player back to ${formatTimecode(frame.time)}`"
              @click="goToFrameTime(frame)"
            >
              <img
                :src="frame.url"
                :alt="`Frame captured at ${formatTimecode(frame.time)}`"
                class="block h-auto w-full"
              />
            </button>
            <div class="min-w-0">
              <div class="truncate font-mono text-xs tabular-nums">
                {{ formatTimecode(frame.time, assumedFps) }}
              </div>
              <div class="truncate text-[11px] text-muted-foreground tabular-nums">
                {{ frame.width }} x {{ frame.height }}, {{ humanSize(frame.size) }}
              </div>
              <div class="truncate text-[11px] text-muted-foreground">
                {{ frame.name }}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" class="flex-1" @click="downloadFrame(frame)">
                Download
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :aria-label="`Remove the frame at ${formatTimecode(frame.time)}`"
                @click="removeFrame(frame.id)"
              >
                <X class="size-4" />
              </Button>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
