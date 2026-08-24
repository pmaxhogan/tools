<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import { Download, Loader2, Monitor } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  QUALITY,
  buildRecorderOptions,
  estimateSize,
  extForMime,
  mp4RemuxArgs,
  pickMimeType,
  recordingFilename,
} from "@/tools/screen-recorder/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { isMetered, shouldAutoDownload } from "@/lib/connection";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the Screen Recorder.
 *
 * The pure layer owns mime negotiation, recorder options, filenames, size
 * estimation, and the ffmpeg remux arguments. Everything that is browser API
 * surface lives here: getDisplayMedia, getUserMedia, the optional AudioContext
 * mixer, MediaRecorder, and the preview blob.
 *
 * Nothing touches navigator or MediaRecorder until a click handler runs, so
 * the island renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

const quality = ref("1080p");
const format = ref("webm");
const micAudio = ref(false);
const systemAudio = ref(true);

const qualitySpec: SelectOptionSpec = {
  kind: "select",
  id: "sr-quality",
  label: "Quality",
  default: "1080p",
  options: QUALITY.map((preset) => ({
    value: preset.id,
    label: `${preset.label} (${preset.videoKbps} kbps)`,
    synonyms: [preset.label, `${preset.videoKbps} kbps`, preset.id],
  })),
};

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "sr-format",
  label: "Export format",
  default: "webm",
  options: [
    {
      value: "webm",
      label: "WebM",
      synonyms: ["vp9", "native", "instant export", "no conversion"],
    },
    {
      value: "mp4",
      label: "MP4",
      synonyms: ["h264", "universal playback", "convert in browser"],
    },
  ],
};

/** Audio bitrate the recorder options use, mirrored here for the live estimate. */
const AUDIO_KBPS = 128;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

type Stage = "idle" | "starting" | "recording" | "recorded";

const stage = ref<Stage>("idle");
const error = ref<{ message: string; fix?: string } | null>(null);
/** Set when both audio sources are on but the mixer could not be built. */
const audioNote = ref<string | null>(null);

const elapsedMs = ref(0);
const recordedMime = ref("");
const recordedBlob = shallowRef<Blob | null>(null);
const previewUrl = ref<string | null>(null);

/* Non reactive capture plumbing. */
let chunks: Blob[] = [];
let recorder: MediaRecorder | null = null;
let displayStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let mixedStream: MediaStream | null = null;
let mixContext: AudioContext | null = null;
let timer: number | null = null;
let startedAt = 0;

/* ---------------------------------------------------------------- */
/* mp4 conversion                                                    */
/* ---------------------------------------------------------------- */

type ConvertStage = "idle" | "engine-prompt" | "loading-engine" | "converting" | "done";

const convertStage = ref<ConvertStage>("idle");
const convertError = ref<{ message: string; fix?: string } | null>(null);
const convertRatio = ref<number | null>(null);
const downloadBytes = ref(0);
const downloadTotal = ref(0);
const mp4Blob = shallowRef<Blob | null>(null);
/** True once the visitor has asked for the engine, so a retry never re-prompts. */
let engineRequested = false;

/* ---------------------------------------------------------------- */
/* teardown helpers                                                  */
/* ---------------------------------------------------------------- */

function clearTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that is already dead is not worth reporting.
    }
  }
}

/**
 * Stops every capture source, which is what makes the browser's sharing bar
 * disappear and the microphone indicator go out. The mixer output tracks are
 * stopped too, and the AudioContext is closed so the audio thread is released.
 */
function stopStreams() {
  stopStream(mixedStream);
  stopStream(micStream);
  stopStream(displayStream);
  mixedStream = null;
  micStream = null;
  displayStream = null;
  if (mixContext) {
    mixContext.close().catch(() => {});
    mixContext = null;
  }
}

function releasePreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = null;
  }
}

/* ---------------------------------------------------------------- */
/* starting a recording                                              */
/* ---------------------------------------------------------------- */

/** True for the two rejections that mean "the visitor closed the picker". */
function isCancellation(e: unknown): boolean {
  const name = e instanceof DOMException ? e.name : "";
  return name === "NotAllowedError" || name === "AbortError";
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

async function startRecording() {
  if (stage.value === "starting" || stage.value === "recording") return;
  error.value = null;
  audioNote.value = null;
  convertError.value = null;
  convertStage.value = "idle";
  convertRatio.value = null;
  mp4Blob.value = null;

  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (
    !devices ||
    typeof devices.getDisplayMedia !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    error.value = {
      message: "This browser cannot record the screen.",
      fix: "Screen capture needs getDisplayMedia and MediaRecorder, which desktop Chrome, Edge, Firefox, and Safari all support. Mobile browsers generally do not offer screen capture at all.",
    };
    return;
  }

  stage.value = "starting";

  // The display picker comes first: asking for the microphone before the
  // visitor has chosen a screen puts two permission prompts on screen at once.
  try {
    displayStream = await devices.getDisplayMedia({ video: true, audio: systemAudio.value });
  } catch (e) {
    stage.value = "idle";
    displayStream = null;
    if (isCancellation(e)) return;
    error.value = {
      message: messageOf(e, "The screen could not be captured."),
      fix: "Try again, and choose a screen, window, or tab in the picker.",
    };
    return;
  }

  if (micAudio.value) {
    try {
      micStream = await devices.getUserMedia({ audio: true });
    } catch (e) {
      // The screen is already shared at this point, so it has to be released
      // before the message goes up, or the sharing bar stays on screen.
      stopStreams();
      stage.value = "idle";
      error.value = {
        message: messageOf(e, "The microphone could not be used."),
        fix: "Allow microphone access for this site, or turn the microphone toggle off and record without it.",
      };
      return;
    }
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  if (!videoTrack) {
    stopStreams();
    stage.value = "idle";
    error.value = {
      message: "The browser shared no video track.",
      fix: "Start again and pick a screen, window, or tab rather than canceling the picker.",
    };
    return;
  }

  const captureStream = new MediaStream([videoTrack, ...collectAudioTracks()]);

  const mime = pickMimeType(format.value === "mp4" ? "mp4" : "webm-vp9", (m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const options = buildRecorderOptions({
    quality: quality.value,
    mimeType: mime,
    micAudio: micAudio.value,
    systemAudio: systemAudio.value,
  });

  try {
    recorder = createRecorder(captureStream, options, mime);
  } catch (e) {
    stopStreams();
    stage.value = "idle";
    error.value = {
      message: messageOf(e, "The recorder could not be started."),
      fix: "This browser rejected every recording format offered. Try a current version of Chrome, Edge, or Firefox.",
    };
    return;
  }

  chunks = [];
  recordedBlob.value = null;
  releasePreview();
  recordedMime.value = recorder.mimeType || mime;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => finalize();
  recorder.onerror = () => {
    error.value = {
      message: "The recording stopped because of a recorder error.",
      fix: "Anything captured before the error is still available below when it is long enough to keep.",
    };
    stopRecording();
  };

  // Stopping the share from the browser's own bar ends the track rather than
  // calling anything here, so that path has to lead back to the same stop.
  videoTrack.addEventListener("ended", () => {
    if (stage.value === "recording") stopRecording();
  });

  // A one second timeslice keeps chunks flowing, so a crashed tab still leaves
  // most of the recording behind rather than one unwritten buffer.
  recorder.start(1000);
  startedAt = Date.now();
  elapsedMs.value = 0;
  stage.value = "recording";
  timer = window.setInterval(() => {
    elapsedMs.value = Date.now() - startedAt;
  }, 250);
}

/**
 * Builds the audio track list for the recorded stream.
 *
 * MediaRecorder in Chromium records only the first audio track of a stream, so
 * system audio and microphone are combined into one track with a Web Audio
 * mixer when both are present. If the mixer cannot be built, both tracks are
 * attached and the panel says plainly that one of them may be dropped.
 */
function collectAudioTracks(): MediaStreamTrack[] {
  const systemTracks = displayStream ? displayStream.getAudioTracks() : [];
  const micTracks = micStream ? micStream.getAudioTracks() : [];
  const system = systemTracks[0];
  const mic = micTracks[0];

  if (system && mic) {
    try {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(new MediaStream([system])).connect(destination);
      context.createMediaStreamSource(new MediaStream([mic])).connect(destination);
      mixContext = context;
      mixedStream = destination.stream;
      return destination.stream.getAudioTracks();
    } catch {
      audioNote.value =
        "System audio and microphone could not be mixed in this browser, so both tracks were attached separately. Some browsers keep only the first one.";
      return [system, mic];
    }
  }

  if (system) return [system];
  if (mic) return [mic];
  if (systemAudio.value && !micAudio.value) {
    audioNote.value =
      "This recording has no sound: the share picker did not offer system audio for the screen or window you chose. Sharing a browser tab, with the audio box ticked, is the reliable way to capture it.";
  }
  return [];
}

/** Constructs the recorder, degrading gracefully when options are rejected. */
function createRecorder(
  stream: MediaStream,
  options: { mimeType: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number },
  mime: string,
): MediaRecorder {
  try {
    return new MediaRecorder(stream, options);
  } catch {
    try {
      return new MediaRecorder(stream, { mimeType: mime });
    } catch {
      return new MediaRecorder(stream);
    }
  }
}

/* ---------------------------------------------------------------- */
/* stopping and the result                                           */
/* ---------------------------------------------------------------- */

function stopRecording() {
  clearTimer();
  if (recorder && recorder.state !== "inactive") {
    // finalize() runs from onstop once the last chunk has been flushed.
    recorder.stop();
    return;
  }
  finalize();
}

function finalize() {
  clearTimer();
  const type = recordedMime.value || "video/webm";
  const blob = chunks.length > 0 ? new Blob(chunks, { type }) : null;
  chunks = [];
  recorder = null;
  stopStreams();

  if (!blob || blob.size === 0) {
    stage.value = "idle";
    if (!error.value) {
      error.value = {
        message: "Nothing was recorded.",
        fix: "The share ended before any video arrived. Start again and let it run for a second or two.",
      };
    }
    return;
  }

  releasePreview();
  recordedBlob.value = blob;
  previewUrl.value = URL.createObjectURL(blob);
  stage.value = "recorded";
}

function discard() {
  releasePreview();
  recordedBlob.value = null;
  mp4Blob.value = null;
  convertStage.value = "idle";
  convertError.value = null;
  convertRatio.value = null;
  elapsedMs.value = 0;
  error.value = null;
  audioNote.value = null;
  stage.value = "idle";
}

function downloadRecording() {
  const blob = recordedBlob.value;
  if (!blob) return;
  downloadBlob(
    blob,
    recordingFilename({ prefix: "screen-recording", ext: extForMime(recordedMime.value) }),
  );
}

function downloadMp4() {
  const blob = mp4Blob.value;
  if (!blob) return;
  downloadBlob(blob, recordingFilename({ prefix: "screen-recording", ext: "mp4" }));
}

/* ---------------------------------------------------------------- */
/* mp4 conversion with the shared ffmpeg engine                      */
/* ---------------------------------------------------------------- */

/**
 * Chromium records WebM whatever the picker said, so an MP4 export is a local
 * ffmpeg pass over the finished recording. The engine module is imported here
 * rather than at the top of the file, so a WebM-only visit never pulls it in.
 */
async function convertToMp4() {
  const blob = recordedBlob.value;
  if (!blob || convertStage.value === "loading-engine" || convertStage.value === "converting") {
    return;
  }
  convertError.value = null;

  const media = await import("@/lib/ffmpeg");
  if (!media.isMediaSupported()) {
    convertError.value = {
      message: "This browser cannot run the MP4 converter.",
      fix: "Converting needs WebAssembly and workers. The WebM file above plays in every current browser and in VLC.",
    };
    return;
  }

  if (!media.isEngineReady() && !shouldAutoDownload() && !engineRequested) {
    convertStage.value = "engine-prompt";
    return;
  }

  engineRequested = true;
  convertStage.value = media.isEngineReady() ? "converting" : "loading-engine";
  convertRatio.value = null;
  downloadBytes.value = 0;
  downloadTotal.value = 0;

  const inputName = "recording.webm";
  const outputName = "recording.mp4";

  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const produced = await media.runJob({
      inputs: [{ name: inputName, data }],
      args: mp4RemuxArgs(inputName, outputName),
      outputs: [outputName],
      onDownload: (loaded, total) => {
        downloadBytes.value = loaded;
        downloadTotal.value = total;
        if (total > 0 && loaded < total) convertStage.value = "loading-engine";
      },
      onProgress: (p) => {
        // Any tick means the engine is in memory and ffmpeg is working.
        convertStage.value = "converting";
        convertRatio.value = p.ratio;
      },
    });

    const out = produced[0];
    if (!out || out.data.byteLength === 0) {
      throw new Error("ffmpeg produced an empty MP4 file.");
    }
    const mp4 = new Blob([out.data.buffer as ArrayBuffer], { type: "video/mp4" });
    mp4Blob.value = mp4;
    convertStage.value = "done";
    downloadBlob(mp4, recordingFilename({ prefix: "screen-recording", ext: "mp4" }));
  } catch (e) {
    convertStage.value = "idle";
    const fix = e instanceof Error && "fix" in e ? (e as { fix?: string }).fix : undefined;
    convertError.value = {
      message: messageOf(e, "The recording could not be converted to MP4."),
      fix: fix ?? "The WebM file above is unchanged and still downloads instantly.",
    };
  }
}

/** Starts the engine download after the one tap prompt on a metered connection. */
function startEngineDownload() {
  engineRequested = true;
  convertToMp4();
}

/* ---------------------------------------------------------------- */
/* derived view state                                                */
/* ---------------------------------------------------------------- */

const preset = computed(() => QUALITY.find((q) => q.id === quality.value) ?? QUALITY[1]!);

const elapsedSeconds = computed(() => Math.floor(elapsedMs.value / 1000));

const elapsedText = computed(() => {
  const total = elapsedSeconds.value;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
});

const estimatedText = computed(() => {
  const audioKbps = micAudio.value || systemAudio.value ? AUDIO_KBPS : 0;
  return formatBytes(estimateSize(preset.value.videoKbps + audioKbps, elapsedSeconds.value));
});

const recordedSizeText = computed(() =>
  recordedBlob.value ? formatBytes(recordedBlob.value.size) : "",
);

const recordedFormat = computed(() => extForMime(recordedMime.value).toUpperCase());

const controlsDisabled = computed(() => stage.value === "starting" || stage.value === "recording");

const needsConversion = computed(
  () =>
    stage.value === "recorded" &&
    format.value === "mp4" &&
    extForMime(recordedMime.value) === "webm",
);

const converting = computed(
  () => convertStage.value === "loading-engine" || convertStage.value === "converting",
);

const convertLabel = computed(() => {
  if (convertStage.value === "loading-engine") {
    if (downloadTotal.value > 0) {
      return `Loading the converter, ${formatBytes(downloadBytes.value)} of ${formatBytes(downloadTotal.value)}`;
    }
    return "Loading the converter";
  }
  if (convertRatio.value !== null) {
    return `Converting to MP4, ${Math.round(convertRatio.value * 100)} percent`;
  }
  return "Converting to MP4";
});

const convertBarWidth = computed(() => {
  if (convertStage.value === "loading-engine" && downloadTotal.value > 0) {
    return `${Math.max(4, Math.round((downloadBytes.value / downloadTotal.value) * 100))}%`;
  }
  if (convertRatio.value !== null) return `${Math.max(4, Math.round(convertRatio.value * 100))}%`;
  return "100%";
});

const convertIndeterminate = computed(
  () =>
    converting.value &&
    !(convertStage.value === "loading-engine" && downloadTotal.value > 0) &&
    convertRatio.value === null,
);

const connectionMetered = computed(() => isMetered());

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onUnmounted(() => {
  clearTimer();
  if (recorder && recorder.state !== "inactive") {
    recorder.onstop = null;
    recorder.ondataavailable = null;
    try {
      recorder.stop();
    } catch {
      // Already gone.
    }
  }
  recorder = null;
  chunks = [];
  stopStreams();
  releasePreview();
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Setup -->
    <div
      v-if="stage === 'idle' || stage === 'starting'"
      class="flex flex-col gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex w-44 flex-col gap-1.5">
          <Label for="sr-quality" class="text-xs text-muted-foreground">Quality</Label>
          <SearchableSelect
            id="sr-quality"
            :spec="qualitySpec"
            :model-value="quality"
            @update:model-value="(v) => (quality = String(v))"
          />
        </div>

        <div class="flex w-36 flex-col gap-1.5">
          <Label for="sr-format" class="text-xs text-muted-foreground">Export format</Label>
          <SearchableSelect
            id="sr-format"
            :spec="formatSpec"
            :model-value="format"
            @update:model-value="(v) => (format = String(v))"
          />
        </div>

        <div class="flex items-center gap-2 pb-2">
          <Switch
            id="sr-mic"
            :model-value="micAudio"
            :disabled="controlsDisabled"
            @update:model-value="(v) => (micAudio = Boolean(v))"
          />
          <Label for="sr-mic" class="text-xs text-muted-foreground">Microphone</Label>
        </div>

        <div class="flex items-center gap-2 pb-2">
          <Switch
            id="sr-system"
            :model-value="systemAudio"
            :disabled="controlsDisabled"
            @update:model-value="(v) => (systemAudio = Boolean(v))"
          />
          <Label for="sr-system" class="text-xs text-muted-foreground">System or tab audio</Label>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <Button size="lg" :disabled="stage === 'starting'" @click="startRecording">
          <Monitor class="size-4" aria-hidden="true" />
          {{ stage === "starting" ? "Waiting for the picker…" : "Start recording" }}
        </Button>
        <span class="text-xs text-muted-foreground">
          Your browser asks which screen, window, or tab to share.
        </span>
      </div>

      <p v-if="format === 'mp4'" class="text-xs text-muted-foreground">
        Browsers capture WebM, so an MP4 export runs a local conversion after you stop. The
        conversion needs a one time engine download of about 31 MB.
      </p>
    </div>

    <!-- Recording -->
    <div
      v-if="stage === 'recording'"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="inline-flex items-center gap-2 text-sm font-semibold text-destructive">
          <span class="rec-dot" aria-hidden="true"></span>
          REC
        </span>
        <span class="text-2xl font-semibold tabular-nums" role="timer" aria-live="off">
          {{ elapsedText }}
        </span>
        <span class="text-xs text-muted-foreground">
          about {{ estimatedText }} so far at {{ preset.label }}
        </span>
        <Button class="ml-auto" size="sm" variant="destructive" @click="stopRecording">
          <span class="stop-square" aria-hidden="true"></span>
          Stop recording
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        You can also stop from your browser's own sharing bar. Recording happens on your device.
        Your files and inputs never leave your device.
      </p>
    </div>

    <!-- Result -->
    <div v-if="stage === 'recorded' && previewUrl" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Recording
        </span>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ elapsedText }} · {{ recordedSizeText }} · {{ recordedFormat }}
        </span>
      </div>

      <video
        :src="previewUrl"
        controls
        playsinline
        class="w-full rounded-[10px] bg-black shadow-[var(--sh-inset)]"
      ></video>

      <div class="flex flex-wrap items-center gap-3">
        <Button @click="downloadRecording">
          <Download class="size-4" aria-hidden="true" />
          Download {{ recordedFormat }}
        </Button>

        <Button
          v-if="needsConversion && convertStage !== 'done'"
          variant="outline"
          :disabled="converting"
          @click="convertToMp4"
        >
          <Loader2 v-if="converting" class="size-4 animate-spin" aria-hidden="true" />
          {{ converting ? "Converting…" : "Convert to MP4" }}
        </Button>

        <Button v-if="mp4Blob" variant="outline" @click="downloadMp4">
          <Download class="size-4" aria-hidden="true" />
          Download MP4 again
        </Button>

        <Button variant="ghost" :disabled="converting" @click="discard">Record again</Button>
      </div>

      <p v-if="needsConversion && convertStage === 'idle'" class="text-xs text-muted-foreground">
        You asked for MP4 and this browser captured WebM, which is normal. Converting runs ffmpeg
        inside this tab, so the video still never leaves your device.
      </p>

      <!-- Metered engine prompt -->
      <div
        v-if="convertStage === 'engine-prompt'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          MP4 converter
        </span>
        <p class="text-sm text-muted-foreground">
          Converting to MP4 needs a one time download of about 31 MB, an ffmpeg engine that runs
          inside this tab.
          {{ connectionMetered ? "Your connection looks metered, so it" : "It" }} will not start
          until you ask. Your browser keeps the engine afterwards, so later conversions start
          straight from the cache.
        </p>
        <Button class="self-start" size="sm" @click="startEngineDownload">
          Convert to MP4 (about 31 MB)
        </Button>
      </div>

      <!-- Conversion progress -->
      <div
        v-if="converting"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ convertLabel }}</span>
        </div>
        <div
          class="h-1.5 overflow-hidden rounded-full bg-card"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="convertLabel"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-150"
            :class="{ 'convert-pulse': convertIndeterminate }"
            :style="{ width: convertBarWidth }"
          />
        </div>
      </div>

      <p v-if="convertStage === 'done'" class="text-xs text-muted-foreground">
        MP4 saved. The WebM original is still available above.
      </p>

      <div
        v-if="convertError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">{{ convertError.message }}</p>
        <p v-if="convertError.fix" class="mt-1 text-muted-foreground">{{ convertError.fix }}</p>
      </div>
    </div>

    <!-- Errors and notes -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <p v-if="audioNote" class="text-xs text-muted-foreground">{{ audioNote }}</p>

    <p class="text-xs text-muted-foreground">
      Recording happens on your device and is never uploaded: your files and inputs never leave your
      device.
    </p>
  </div>
</template>

<style scoped>
.rec-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 999px;
  background: var(--destructive);
  animation: rec-blink 1.4s ease-in-out infinite;
}

.stop-square {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  background: currentColor;
}

.convert-pulse {
  animation: convert-pulse 1.4s ease-in-out infinite;
}

@keyframes rec-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

@keyframes convert-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rec-dot,
  .convert-pulse {
    animation: none;
  }
}
</style>
