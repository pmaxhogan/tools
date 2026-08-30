<script setup lang="ts">
/**
 * Bespoke panel for the video trimmer.
 *
 * What this actually does, so nobody has to guess from the copy: the clip is
 * loaded into a plain <video> element, seeked to the start of the range, and
 * then played through once while captureStream() feeds a MediaRecorder. The
 * result is a re-encoded WebM, not a copy of the original bitstream. The
 * boundaries are frame accurate because the range is chosen against the frame
 * grid and the recorder is stopped on a per frame callback, but the pixels go
 * through an encoder on the way out.
 *
 * A true smart cut (copy the untouched groups of pictures, re-encode only the
 * two boundary regions) needs an MP4 demuxer and muxer. Browsers expose codecs
 * through WebCodecs but no container API, so that is a later upgrade.
 *
 * All frame math lives in src/tools/video-trimmer (rule 27); this component
 * only owns the browser work. Nothing touches a browser API until the
 * component is mounted, so it renders inert on the server.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { X } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadUrl } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import ProgressBar from "../ProgressBar.vue";

defineProps<{ meta: ToolMeta }>();

type TrimLogic = typeof import("@/tools/video-trimmer/index");
type TrimPlan = import("@/tools/video-trimmer/index").TrimPlan;
type TrimPlanError = import("@/tools/video-trimmer/index").TrimPlanError;

/** captureStream is not in the DOM typings, and Firefox uses a prefix. */
type CapturableVideo = HTMLVideoElement & {
  captureStream?: (frameRate?: number) => MediaStream;
  mozCaptureStream?: (frameRate?: number) => MediaStream;
};

/** Video bitrate for the re-encode. High enough that the cut looks like the source. */
const VIDEO_BITS_PER_SECOND = 8_000_000;
const AUDIO_BITS_PER_SECOND = 128_000;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<TrimLogic | null>(null);

const videoEl = ref<HTMLVideoElement>();

const fileName = ref("");
const fileSize = ref(0);
const sourceUrl = ref<string | null>(null);
const duration = ref(0);
const decodeFailed = ref(false);

const startSpec = ref("0");
const endSpec = ref("");
const fps = ref(30);
/** Mirrors the element's currentTime so the readout and the buttons stay live. */
const playhead = ref(0);

const recording = ref(false);
const captureProgress = ref(0);
const wentHidden = ref(false);

const outputUrl = ref<string | null>(null);
const outputSize = ref(0);
const outputName = ref("");

const error = ref<{ message: string; fix?: string } | null>(null);

let stopRequested = false;

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const hasFile = computed(() => sourceUrl.value !== null);
const ready = computed(() => hasFile.value && duration.value > 0 && !decodeFailed.value);

const startSec = computed(() => {
  if (!logic.value) return 0;
  return logic.value.parseTimeSpec(startSpec.value) ?? NaN;
});

/** An empty end field means "run to the end of the clip". */
const endSec = computed(() => {
  if (!logic.value) return 0;
  if (!endSpec.value.trim()) return duration.value;
  return logic.value.parseTimeSpec(endSpec.value) ?? NaN;
});

const planResult = computed<TrimPlan | TrimPlanError | null>(() => {
  if (!logic.value || !ready.value) return null;
  return logic.value.planTrim({
    durationSec: duration.value,
    startSec: startSec.value,
    endSec: endSec.value,
    fps: fps.value,
  });
});

const plan = computed<TrimPlan | null>(() => {
  const result = planResult.value;
  return result && !("error" in result) ? result : null;
});

const rangeError = computed<TrimPlanError | null>(() => {
  const result = planResult.value;
  return result && "error" in result ? result : null;
});

const canTrim = computed(() => ready.value && plan.value !== null && !recording.value);

function clock(seconds: number): string {
  return logic.value ? logic.value.formatSeconds(seconds) : "0:00.000";
}

const progressPercent = computed(() => Math.round(captureProgress.value * 100));

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "video";
}

function revoke(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

function clampTime(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(Math.max(seconds, 0), Math.max(duration.value - 0.000001, 0));
}

function setError(e: unknown) {
  error.value =
    e instanceof ToolError
      ? { message: e.message, fix: e.fix }
      : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

function clearOutput() {
  revoke(outputUrl.value);
  outputUrl.value = null;
  outputSize.value = 0;
  outputName.value = "";
  wentHidden.value = false;
  captureProgress.value = 0;
}

function loadFile(file: File) {
  revoke(sourceUrl.value);
  clearOutput();
  error.value = null;
  decodeFailed.value = false;
  duration.value = 0;
  playhead.value = 0;
  startSpec.value = "0";
  endSpec.value = "";
  fileName.value = file.name;
  fileSize.value = file.size;
  sourceUrl.value = URL.createObjectURL(file);
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) loadFile(file);
}

function clearFile() {
  revoke(sourceUrl.value);
  sourceUrl.value = null;
  clearOutput();
  fileName.value = "";
  fileSize.value = 0;
  duration.value = 0;
  playhead.value = 0;
  decodeFailed.value = false;
  error.value = null;
}

/* ---------------------------------------------------------------- */
/* preview                                                           */
/* ---------------------------------------------------------------- */

function onLoadedMetadata() {
  const video = videoEl.value;
  if (!video) return;
  // Some WebM and MP4 files report Infinity until they have been seeked once.
  duration.value = Number.isFinite(video.duration) ? video.duration : 0;
  decodeFailed.value = false;
  playhead.value = video.currentTime;
}

function onDurationChange() {
  const video = videoEl.value;
  if (video && Number.isFinite(video.duration)) duration.value = video.duration;
}

function onTimeUpdate() {
  const video = videoEl.value;
  if (video) playhead.value = video.currentTime;
}

function onVideoError() {
  decodeFailed.value = true;
  duration.value = 0;
}

/** Resolves once the element has actually landed on the requested time. */
function seekTo(seconds: number): Promise<void> {
  const video = videoEl.value;
  if (!video) return Promise.resolve();
  const target = clampTime(seconds);
  if (Math.abs(video.currentTime - target) < 0.0001) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      playhead.value = video.currentTime;
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = target;
  });
}

function setStartFromPlayhead() {
  const video = videoEl.value;
  if (!video) return;
  startSpec.value = clock(video.currentTime);
}

function setEndFromPlayhead() {
  const video = videoEl.value;
  if (!video) return;
  endSpec.value = clock(video.currentTime);
}

/** Frame stepping is nominal: it moves by 1/fps against the rate you entered. */
async function stepFrames(frames: number) {
  const video = videoEl.value;
  if (!video || !ready.value) return;
  video.pause();
  const rate = fps.value > 0 ? fps.value : 30;
  await seekTo(video.currentTime + frames / rate);
}

function setFps(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  fps.value = Math.min(120, Math.max(1, Math.round(n)));
}

/* ---------------------------------------------------------------- */
/* capture                                                           */
/* ---------------------------------------------------------------- */

function captureStreamOf(video: CapturableVideo): MediaStream | null {
  const capture = video.captureStream ?? video.mozCaptureStream;
  if (typeof capture !== "function") return null;
  return capture.call(video);
}

/**
 * Plays from here to `end` and resolves when the playhead reaches it.
 * requestVideoFrameCallback fires once per decoded frame, so the stop lands on
 * a frame boundary rather than on the ~4 Hz timeupdate grid. The animation
 * frame fallback is coarser but still far tighter than timeupdate.
 */
function playUntil(video: HTMLVideoElement, start: number, end: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      video.removeEventListener("ended", finish);
      video.pause();
      resolve();
    };

    function schedule() {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => tick());
      } else {
        requestAnimationFrame(() => tick());
      }
    }

    function tick() {
      if (finished) return;
      playhead.value = video.currentTime;
      const span = end - start;
      captureProgress.value =
        span > 0 ? Math.min(1, Math.max(0, (video.currentTime - start) / span)) : 1;
      if (stopRequested || video.currentTime >= end || video.ended) {
        finish();
        return;
      }
      schedule();
    }

    video.addEventListener("ended", finish);
    schedule();
  });
}

function onVisibilityChange() {
  if (document.hidden) wentHidden.value = true;
}

async function trim() {
  const video = videoEl.value as CapturableVideo | undefined;
  const currentPlan = plan.value;
  if (!video || !currentPlan || !logic.value || recording.value) return;

  if (typeof MediaRecorder === "undefined") {
    setError(
      new ToolError(
        "no-recorder",
        "This browser does not support MediaRecorder, which the trimmer uses to write the trimmed clip.",
        "Use a current version of Chrome, Edge, Firefox, or Safari.",
      ),
    );
    return;
  }

  const mimeType = logic.value.chooseRecorderMime((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    setError(
      new ToolError(
        "no-webm-encoder",
        "This browser cannot record WebM video, so there is no format to write the trimmed clip in.",
        "Use a current version of Chrome, Edge, or Firefox, where WebM recording is built in.",
      ),
    );
    return;
  }

  const from = startSec.value;
  const to = endSec.value;

  clearOutput();
  error.value = null;
  recording.value = true;
  stopRequested = false;
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.hidden) wentHidden.value = true;

  let stream: MediaStream | null = null;
  // The element is muted so the run is silent to watch. Per the capture spec
  // the element's own volume does not affect the captured audio track.
  const wasMuted = video.muted;
  try {
    // Seek first and wait for it to settle: starting the recorder before the
    // element has landed would capture frames from the old position.
    video.pause();
    video.playbackRate = 1;
    video.muted = true;
    await seekTo(from);

    stream = captureStreamOf(video);
    if (!stream) {
      throw new ToolError(
        "no-capture",
        "This browser will not let a video element be captured, so the clip cannot be recorded.",
        "Use a current version of Chrome, Edge, or Firefox.",
      );
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    let recorderError: string | null = null;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      recorderError = "The recorder stopped with an error part way through the clip.";
      stopRequested = true;
    };

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start();
    await video.play();
    await playUntil(video, from, to);
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;

    if (recorderError) throw new ToolError("recorder-failed", recorderError);

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      throw new ToolError(
        "empty-output",
        "The recording came back empty, so there is nothing to download.",
        "Keep this tab in front while the clip plays through, then trim again.",
      );
    }

    outputUrl.value = URL.createObjectURL(blob);
    outputSize.value = blob.size;
    outputName.value = `${baseName(fileName.value)}-trimmed.webm`;
    captureProgress.value = 1;
  } catch (e) {
    setError(e);
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    document.removeEventListener("visibilitychange", onVisibilityChange);
    video.muted = wasMuted;
    recording.value = false;
    stopRequested = false;
  }
}

function cancelTrim() {
  stopRequested = true;
}

function download() {
  if (!outputUrl.value) return;
  downloadUrl(outputUrl.value, outputName.value);
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(async () => {
  // The frame math lives in the logic layer, so the panel loads it rather than
  // reimplementing it. It is tiny and has no dependencies.
  logic.value = await import("@/tools/video-trimmer/index");
});

onUnmounted(() => {
  stopRequested = true;
  revoke(sourceUrl.value);
  revoke(outputUrl.value);
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Video
      </span>
      <FileDrop
        v-if="hasFile"
        compact
        accept="video/*"
        :label="fileName"
        :hint="formatBytes(fileSize)"
        @files="onFiles"
      >
        <template #actions>
          <Button variant="ghost" size="icon-sm" aria-label="Remove video" @click="clearFile">
            <X class="size-3.5" />
          </Button>
        </template>
      </FileDrop>
      <FileDrop
        v-else
        accept="video/*"
        label="Drop a video here or click to choose"
        hint="Cut a range out of it. Everything runs in this tab: your files and inputs never leave your device."
        @files="onFiles"
      />
    </div>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="hasFile">
      <!-- Preview -->
      <div class="flex flex-col gap-2">
        <video
          ref="videoEl"
          :src="sourceUrl ?? ''"
          controls
          playsinline
          preload="metadata"
          class="max-h-[360px] w-full rounded-[10px] bg-background shadow-[var(--sh-inset)]"
          @loadedmetadata="onLoadedMetadata"
          @durationchange="onDurationChange"
          @timeupdate="onTimeUpdate"
          @seeked="onTimeUpdate"
          @error="onVideoError"
        />
        <ErrorBanner
          v-if="decodeFailed"
          message="This browser cannot decode this file, so it cannot be trimmed here."
          hint="Try an MP4, WebM, or MOV recorded by a common camera or screen recorder."
        />
        <p v-else class="font-mono text-xs text-muted-foreground tabular-nums">
          Playhead {{ clock(playhead) }} of {{ clock(duration) }}
        </p>
      </div>

      <!-- Range -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Range
        </span>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-36 flex-col gap-1.5">
            <Label for="trim-start" class="text-xs text-muted-foreground">Start</Label>
            <Input
              id="trim-start"
              v-model="startSpec"
              class="h-9 bg-card font-mono"
              placeholder="0:00"
              :disabled="recording"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            class="mb-0.5"
            :disabled="!ready || recording"
            @click="setStartFromPlayhead"
          >
            Set from playhead
          </Button>

          <div class="flex w-36 flex-col gap-1.5">
            <Label for="trim-end" class="text-xs text-muted-foreground">End</Label>
            <Input
              id="trim-end"
              v-model="endSpec"
              class="h-9 bg-card font-mono"
              placeholder="end of clip"
              :disabled="recording"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            class="mb-0.5"
            :disabled="!ready || recording"
            @click="setEndFromPlayhead"
          >
            Set from playhead
          </Button>

          <div class="flex w-28 flex-col gap-1.5">
            <Label for="trim-fps" class="text-xs text-muted-foreground">Frame rate</Label>
            <Input
              id="trim-fps"
              type="number"
              min="1"
              max="120"
              :model-value="fps"
              class="h-9 bg-card"
              :disabled="recording"
              @update:model-value="setFps"
            />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="!ready || recording"
            @click="stepFrames(-1)"
          >
            Previous frame
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="!ready || recording"
            @click="stepFrames(1)"
          >
            Next frame
          </Button>
          <span class="text-xs text-muted-foreground">
            Steps move the playhead by one frame at the rate above.
          </span>
        </div>

        <ErrorBanner v-if="rangeError" :message="rangeError.error" :hint="rangeError.fix" />
        <p v-else-if="plan" class="font-mono text-xs text-muted-foreground tabular-nums">
          Frames {{ plan.startFrame }} to {{ plan.endFrame - 1 }} ({{ plan.frameCount }} frames),
          {{ clock(plan.outDurationSec) }} out.
        </p>
      </div>

      <!-- Trim -->
      <div class="flex flex-wrap items-center gap-2">
        <Button :disabled="!canTrim" @click="trim">
          {{ recording ? "Recording…" : "Trim" }}
        </Button>
        <Button v-if="recording" variant="outline" @click="cancelTrim"> Stop early </Button>
        <span v-if="recording" class="font-mono text-xs text-muted-foreground tabular-nums">
          {{ progressPercent }}%
        </span>
      </div>

      <ProgressBar v-if="recording" :value="progressPercent" label="Trim progress" />

      <p v-if="recording" class="text-xs text-muted-foreground">
        The clip plays through once while it records, so this takes about as long as the range
        itself. Keep this tab in front: browsers throttle a hidden tab, which can drop frames from
        the recording.
      </p>

      <ErrorBanner
        v-if="wentHidden"
        variant="info"
        message="This tab was in the background while the clip was recording, so frames may be missing or the timing may drift."
        hint="Run the trim again with the tab in front if the result looks wrong."
      />

      <!-- Output -->
      <div v-if="outputUrl" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Output
          </span>
        </div>
        <div class="flex flex-col gap-3 px-3 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate font-mono text-sm">
                {{ outputName }}
              </div>
              <div class="text-xs text-muted-foreground tabular-nums">
                {{ formatBytes(outputSize) }} from {{ formatBytes(fileSize) }} of source
              </div>
            </div>
            <Button size="sm" variant="outline" @click="download"> Download </Button>
          </div>
          <video
            :src="outputUrl"
            controls
            playsinline
            class="max-h-[360px] w-full rounded-[8px] bg-background"
          />
          <p class="text-xs text-muted-foreground">
            The trimmed range was re-encoded to WebM at a high bitrate. The cut lands on the frames
            listed above, but the file is a fresh encode rather than a copy of the original frames.
          </p>
        </div>
      </div>
    </template>
  </div>
</template>
