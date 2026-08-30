<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { Aperture, Camera, Mic, RefreshCw } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  analyzeSamples,
  describeAudioTrack,
  describeVideoTrack,
  run,
  summarizeDevices,
  type AudioTrackSettings,
  type DeviceEntry,
  type Level,
  type VideoTrackSettings,
} from "@/tools/webcam-mic-test/index";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the Webcam & Mic Test.
 *
 * The generic ToolShell reads a textarea; this tool needs a live camera
 * preview, a per frame audio level meter, device pickers, and a short test
 * recording, none of which fit that shape. Every formatting decision still
 * lives in the pure layer at `src/tools/webcam-mic-test/`: this file only
 * opens the streams, feeds raw PCM frames into `analyzeSamples`, and hands
 * the collected settings to `run()` for the copyable report.
 *
 * Nothing here is written to the URL fragment or to localStorage, and no
 * frame, sample, or recording is uploaded: the streams live in this
 * component's memory and stop on Stop or on unmount.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Analyser window. 2048 samples is roughly 43 ms at 48 kHz. */
const FFT_SIZE = 2048;
/** Quietest level the meter bar draws; anything below reads as empty. */
const METER_FLOOR_DB = -60;
/** How long the peak tick stays put before it starts falling back. */
const PEAK_HOLD_MS = 1200;
/** Length of the test recording. */
const CLIP_MS = 3000;
/** The report only needs a level a few times a second, not every frame. */
const REPORT_INTERVAL_MS = 500;

/* ------------------------------------------------------------------ *
 * live objects (never reactive: Vue must not proxy a live track)
 * ------------------------------------------------------------------ */

let videoTrack: MediaStreamTrack | null = null;
let audioTrack: MediaStreamTrack | null = null;
let audioCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
/** Explicitly backed by a plain ArrayBuffer: getFloatTimeDomainData rejects the
 * default ArrayBufferLike widening, which would allow a SharedArrayBuffer. */
let sampleBuffer: Float32Array<ArrayBuffer> | null = null;
let rafId: number | null = null;
let recorder: MediaRecorder | null = null;
let recorderTimer: ReturnType<typeof setTimeout> | null = null;
let peakHoldAt = 0;
let lastReportAt = 0;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface PanelError {
  message: string;
  fix: string;
}

const videoEl = ref<HTMLVideoElement>();
const waveEl = ref<HTMLCanvasElement>();

const cameraOn = ref(false);
const micOn = ref(false);
const starting = ref(false);
const cameraError = ref<PanelError | null>(null);
const micError = ref<PanelError | null>(null);

const devices = ref<DeviceEntry[]>([]);
const selectedCameraId = ref("");
const selectedMicId = ref("");

const mirror = ref(true);
const videoSettings = ref<VideoTrackSettings | null>(null);
const audioSettings = ref<AudioTrackSettings | null>(null);

const rmsDb = ref(METER_FLOOR_DB);
const peakDb = ref(METER_FLOOR_DB);
const peakHoldDb = ref(METER_FLOOR_DB);
const level = ref<Level>("silent");
const clippedCount = ref(0);
/** Linear 0..1 values, held at a slow cadence for the report. */
const reportRms = ref(0);
const reportPeak = ref(0);

const recordSupported = ref(false);
const recording = ref(false);
const clipUrl = ref<string | null>(null);
const clipMimeType = ref("");

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

type Kind = "camera" | "microphone";

function startLabel(kind: Kind): string {
  return kind === "camera" ? "Start camera" : "Start microphone";
}

/**
 * Turns a getUserMedia rejection into the message plus the fix hint the
 * design rules require. The four names below are the ones a visitor can act
 * on; anything else falls through to the raw message.
 */
function describeMediaError(err: unknown, kind: Kind): PanelError {
  const name = err instanceof Error ? err.name : "";
  const device = kind === "camera" ? "camera" : "microphone";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message: `Permission to use the ${device} was denied, so nothing can start.`,
      fix: `Click the camera or lock icon at the left of your browser address bar, set the ${device} to Allow, reload the page, then press ${startLabel(kind)} again. In a private window some browsers ask every time.`,
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      message: `No ${device} was found on this device.`,
      fix: `Plug one in (a headset counts as a microphone), then press Refresh devices and try ${startLabel(kind)} again.`,
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      message: `The ${device} is already in use by another app, so this page cannot open it.`,
      fix: `Close any video call, recording, or camera app that is holding the ${device}, then press ${startLabel(kind)} again.`,
    };
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      message: `The selected ${device} could not be opened with the requested settings.`,
      fix: `Pick a different ${device} from the list above, or press Refresh devices if you unplugged something.`,
    };
  }
  return {
    message: `The ${device} could not be started: ${err instanceof Error ? err.message : String(err)}`,
    fix: `Check that no other app is using the ${device}, then press ${startLabel(kind)} again.`,
  };
}

/* ------------------------------------------------------------------ *
 * devices
 * ------------------------------------------------------------------ */

async function refreshDevices() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    devices.value = list.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }));
  } catch {
    // A browser that refuses to enumerate still lets the default stream run,
    // so this stays silent rather than blocking the preview.
  }
}

const cameraDevices = computed(() =>
  devices.value.filter((d) => d.kind === "videoinput" && d.deviceId),
);
const micDevices = computed(() =>
  devices.value.filter((d) => d.kind === "audioinput" && d.deviceId),
);

function deviceSpec(id: string, label: string, list: DeviceEntry[], current: string, noun: string) {
  const spec: SelectOptionSpec = {
    kind: "select",
    id,
    label,
    default: current,
    options: list.map((d, i) => ({
      value: d.deviceId,
      label: d.label?.trim() ? d.label.trim() : `${noun} ${i + 1}`,
      synonyms: [],
    })),
  };
  return spec;
}

const cameraSpec = computed(() =>
  deviceSpec("webcam-mic-camera", "Camera", cameraDevices.value, selectedCameraId.value, "Camera"),
);
const micSpec = computed(() =>
  deviceSpec(
    "webcam-mic-microphone",
    "Microphone",
    micDevices.value,
    selectedMicId.value,
    "Microphone",
  ),
);

const deviceSummary = computed(() =>
  devices.value.length ? summarizeDevices(devices.value) : null,
);

/* ------------------------------------------------------------------ *
 * starting and stopping
 * ------------------------------------------------------------------ */

/**
 * MediaTrackConstraints is a type-only global, so naming it trips eslint's
 * no-undef the same way MediaTrackCapabilities does in the QR scanner panel.
 * Only the deviceId field is ever set here, so spell that shape out instead.
 */
type TrackConstraint = boolean | { deviceId: { exact: string } };

function videoConstraint(exact: boolean): TrackConstraint {
  const id = selectedCameraId.value;
  return exact && id ? { deviceId: { exact: id } } : true;
}

function audioConstraint(exact: boolean): TrackConstraint {
  const id = selectedMicId.value;
  return exact && id ? { deviceId: { exact: id } } : true;
}

/**
 * One getUserMedia call for whichever sides are requested, so "Start both"
 * shows a single permission prompt instead of two. Tracks are routed to the
 * preview and to the analyser, and anything extra is stopped immediately.
 */
async function startStreams(want: { video: boolean; audio: boolean }, exact = true) {
  if (!want.video && !want.audio) return;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    const unsupported: PanelError = {
      message: "This browser will not hand out camera or microphone access on this page.",
      fix: "Open the page over https in a recent version of Chrome, Edge, Firefox, or Safari, then try again.",
    };
    if (want.video) cameraError.value = unsupported;
    if (want.audio) micError.value = unsupported;
    return;
  }

  if (want.video) {
    cameraError.value = null;
    stopCamera();
  }
  if (want.audio) {
    micError.value = null;
    stopMic();
  }

  starting.value = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: want.video ? videoConstraint(exact) : false,
      audio: want.audio ? audioConstraint(exact) : false,
    });

    for (const track of stream.getTracks()) {
      if (track.kind === "video" && want.video && !videoTrack) attachVideo(track);
      else if (track.kind === "audio" && want.audio && !audioTrack) attachAudio(track);
      else track.stop();
    }

    await refreshDevices();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    // A remembered device that has been unplugged fails the exact match. Try
    // once more on the default device before reporting anything.
    if (exact && (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError")) {
      if (want.video) selectedCameraId.value = "";
      if (want.audio) selectedMicId.value = "";
      starting.value = false;
      await startStreams(want, false);
      return;
    }
    if (want.video) cameraError.value = describeMediaError(err, "camera");
    if (want.audio) micError.value = describeMediaError(err, "microphone");
  } finally {
    starting.value = false;
  }
}

function attachVideo(track: MediaStreamTrack) {
  videoTrack = track;
  const settings = track.getSettings() as VideoTrackSettings;
  videoSettings.value = settings;
  if (settings.deviceId) selectedCameraId.value = settings.deviceId;
  // A rear camera is not a mirror, so only self view cameras start flipped.
  // Desktop webcams report no facing mode at all, and those are self view.
  mirror.value = settings.facingMode !== "environment";

  const el = videoEl.value;
  if (el) {
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {
      // Autoplay was refused; the visitor can press play on the element.
    });
  }
  track.addEventListener("ended", () => stopCamera());
  cameraOn.value = true;
}

function attachAudio(track: MediaStreamTrack) {
  audioTrack = track;
  const settings = { ...track.getSettings() } as AudioTrackSettings;

  try {
    audioCtx = new AudioContext();
    // Firefox leaves sampleRate off the track settings, so the rate the
    // analyser actually runs at stands in for it rather than dropping the row.
    if (settings.sampleRate === undefined) settings.sampleRate = audioCtx.sampleRate;
    sourceNode = audioCtx.createMediaStreamSource(new MediaStream([track]));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    // Deliberately not connected to the destination: routing a live
    // microphone to the speakers is an instant feedback loop.
    sourceNode.connect(analyser);
    sampleBuffer = new Float32Array(analyser.fftSize);
  } catch (err) {
    micError.value = describeMediaError(err, "microphone");
    track.stop();
    audioTrack = null;
    return;
  }

  audioSettings.value = settings;
  if (settings.deviceId) selectedMicId.value = settings.deviceId;
  recordSupported.value = typeof MediaRecorder !== "undefined";
  track.addEventListener("ended", () => stopMic());
  micOn.value = true;
  peakHoldDb.value = METER_FLOOR_DB;
  peakHoldAt = 0;
  lastReportAt = 0;
  rafId = requestAnimationFrame(tick);
}

function stopMeter() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function stopRecording() {
  if (recorderTimer !== null) {
    clearTimeout(recorderTimer);
    recorderTimer = null;
  }
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      // Already stopped, or the track went away underneath it.
    }
  }
  recording.value = false;
}

function stopCamera() {
  videoTrack?.stop();
  videoTrack = null;
  if (videoEl.value) videoEl.value.srcObject = null;
  videoSettings.value = null;
  cameraOn.value = false;
}

function stopMic() {
  stopRecording();
  recorder = null;
  stopMeter();
  audioTrack?.stop();
  audioTrack = null;
  try {
    sourceNode?.disconnect();
  } catch {
    // The graph is already torn down.
  }
  sourceNode = null;
  analyser = null;
  sampleBuffer = null;
  if (audioCtx && audioCtx.state !== "closed") void audioCtx.close().catch(() => {});
  audioCtx = null;
  audioSettings.value = null;
  micOn.value = false;
  recording.value = false;
  rmsDb.value = METER_FLOOR_DB;
  peakDb.value = METER_FLOOR_DB;
  peakHoldDb.value = METER_FLOOR_DB;
  level.value = "silent";
  clippedCount.value = 0;
  reportRms.value = 0;
  reportPeak.value = 0;
}

function stopEverything() {
  stopCamera();
  stopMic();
}

/* ------------------------------------------------------------------ *
 * the meter loop
 * ------------------------------------------------------------------ */

function tick() {
  rafId = requestAnimationFrame(tick);
  if (!analyser || !sampleBuffer) return;

  analyser.getFloatTimeDomainData(sampleBuffer);
  const reading = analyzeSamples(sampleBuffer);

  rmsDb.value = reading.rmsDb;
  peakDb.value = reading.peakDb;
  level.value = reading.level;
  clippedCount.value = reading.clippedCount;

  const now = performance.now();
  if (reading.peakDb >= peakHoldDb.value || now - peakHoldAt > PEAK_HOLD_MS) {
    peakHoldDb.value = reading.peakDb;
    peakHoldAt = now;
  }
  // The report re-renders a list of rows, so it samples the linear level a
  // few times a second instead of on every animation frame.
  if (now - lastReportAt > REPORT_INTERVAL_MS) {
    lastReportAt = now;
    reportRms.value = reading.rms;
    reportPeak.value = reading.peak;
  }

  drawWaveform(sampleBuffer);
}

function drawWaveform(samples: Float32Array) {
  const canvas = waveEl.value;
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // The canvas carries a text color class, so the trace follows the theme
  // tokens without hard coding either palette here.
  const stroke = getComputedStyle(canvas).color || "#5b4bd6";
  ctx.clearRect(0, 0, w, h);

  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = ratio;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5 * ratio;
  ctx.lineJoin = "round";
  ctx.beginPath();
  const step = samples.length / w;
  for (let x = 0; x < w; x++) {
    const sample = samples[Math.min(samples.length - 1, Math.floor(x * step))] ?? 0;
    const y = (1 - Math.max(-1, Math.min(1, sample))) * (h / 2);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * meter presentation
 * ------------------------------------------------------------------ */

function meterPercent(db: number): number {
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  return ((clamped - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
}

const rmsPercent = computed(() => meterPercent(rmsDb.value));
const peakPercent = computed(() => meterPercent(peakHoldDb.value));

const LEVEL_BAR: Record<Level, string> = {
  silent: "bg-muted-foreground/50",
  "very quiet": "bg-amber-500 dark:bg-amber-400",
  good: "bg-positive",
  loud: "bg-amber-500 dark:bg-amber-400",
  clipping: "bg-destructive",
};

const LEVEL_TEXT: Record<Level, string> = {
  silent: "text-muted-foreground",
  "very quiet": "text-amber-700 dark:text-amber-400",
  good: "text-positive",
  loud: "text-amber-700 dark:text-amber-400",
  clipping: "text-destructive",
};

const LEVEL_HINT: Record<Level, string> = {
  silent:
    "No sound is reaching the browser. Check that the right microphone is selected and that it is not muted in your system settings.",
  "very quiet":
    "Audible but thin. Move the microphone closer, or raise the input volume in your system sound settings.",
  good: "A healthy speaking level. This is what you want on a call.",
  loud: "Strong, with little headroom left. Back off slightly so sudden laughs do not distort.",
  clipping:
    "The signal is hitting the ceiling and distorting. Lower the input volume or move back from the microphone.",
};

const barClass = computed(() => LEVEL_BAR[level.value]);
const textClass = computed(() => LEVEL_TEXT[level.value]);
const levelHint = computed(() => LEVEL_HINT[level.value]);
const dbLabel = computed(() => `${rmsDb.value.toFixed(1)} dB`);
const peakLabel = computed(() => `${peakDb.value.toFixed(1)} dB`);

/* ------------------------------------------------------------------ *
 * rows and report
 * ------------------------------------------------------------------ */

const videoRows = computed(() =>
  videoSettings.value ? describeVideoTrack(videoSettings.value) : null,
);
const audioRows = computed(() =>
  audioSettings.value ? describeAudioTrack(audioSettings.value) : null,
);

const report = computed<Record<string, string> | null>(() => {
  const payload: Record<string, unknown> = {};
  if (devices.value.length) payload.devices = devices.value;
  if (videoSettings.value) payload.video = videoSettings.value;
  if (audioSettings.value) payload.audio = audioSettings.value;
  // run() converts linear amplitude to dB itself, so these stay linear.
  if (micOn.value) payload.levels = { rms: reportRms.value, peak: reportPeak.value };
  if (Object.keys(payload).length === 0) return null;
  try {
    return run(JSON.stringify(payload), {});
  } catch {
    return null;
  }
});

const reportText = computed(() =>
  report.value
    ? Object.entries(report.value)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "",
);

/* ------------------------------------------------------------------ *
 * snapshot
 * ------------------------------------------------------------------ */

function takeSnapshot() {
  const el = videoEl.value;
  if (!el) return;
  const w = el.videoWidth;
  const h = el.videoHeight;
  if (!w || !h) {
    cameraError.value = {
      message: "The preview has not produced a frame yet, so there is nothing to save.",
      fix: "Wait a moment for the camera to warm up, then press Take snapshot again.",
    };
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Always drawn unmirrored, whatever the preview toggle says, so the saved
  // file matches what the camera sends to everyone else.
  ctx.drawImage(el, 0, 0, w, h);
  canvas.toBlob((blob) => {
    if (!blob) {
      cameraError.value = {
        message: "The snapshot could not be encoded as a PNG.",
        fix: "Try again, or restart the camera if the preview has frozen.",
      };
      return;
    }
    downloadBlob(blob, "webcam-snapshot.png");
  }, "image/png");
}

/* ------------------------------------------------------------------ *
 * test recording
 * ------------------------------------------------------------------ */

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

function releaseClip() {
  if (clipUrl.value) URL.revokeObjectURL(clipUrl.value);
  clipUrl.value = null;
}

function recordClip() {
  if (!audioTrack || recording.value) return;
  const mimeType = pickMimeType();
  const chunks: Blob[] = [];

  try {
    recorder = new MediaRecorder(
      new MediaStream([audioTrack]),
      mimeType ? { mimeType } : undefined,
    );
  } catch (err) {
    micError.value = {
      message: `A test recording could not be started: ${err instanceof Error ? err.message : String(err)}`,
      fix: "The level meter above still works without it. Try a different browser if you need the playback check.",
    };
    recorder = null;
    return;
  }

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    recording.value = false;
    const type = recorder?.mimeType || mimeType || "audio/webm";
    recorder = null;
    if (chunks.length === 0) return;
    releaseClip();
    const blob = new Blob(chunks, { type });
    clipMimeType.value = type;
    clipUrl.value = URL.createObjectURL(blob);
  });

  recording.value = true;
  recorder.start();
  recorderTimer = setTimeout(() => {
    recorderTimer = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        recording.value = false;
      }
    }
  }, CLIP_MS);
}

/* ------------------------------------------------------------------ *
 * device switching
 * ------------------------------------------------------------------ */

watch(selectedCameraId, (id) => {
  if (!id || !cameraOn.value) return;
  if (videoTrack?.getSettings().deviceId === id) return;
  void startStreams({ video: true, audio: false });
});

watch(selectedMicId, (id) => {
  if (!id || !micOn.value) return;
  if (audioTrack?.getSettings().deviceId === id) return;
  void startStreams({ video: false, audio: true });
});

onUnmounted(() => {
  stopEverything();
  releaseClip();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- controls -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-2">
        <Button
          v-if="!cameraOn"
          size="lg"
          :disabled="starting"
          @click="startStreams({ video: true, audio: false })"
        >
          <Camera class="size-4" aria-hidden="true" />
          Start camera
        </Button>
        <Button v-else size="lg" variant="secondary" @click="stopCamera">Stop camera</Button>

        <Button
          v-if="!micOn"
          size="lg"
          :disabled="starting"
          @click="startStreams({ video: false, audio: true })"
        >
          <Mic class="size-4" aria-hidden="true" />
          Start microphone
        </Button>
        <Button v-else size="lg" variant="secondary" @click="stopMic">Stop microphone</Button>

        <Button
          v-if="!cameraOn || !micOn"
          size="lg"
          variant="outline"
          :disabled="starting"
          @click="startStreams({ video: !cameraOn, audio: !micOn })"
        >
          Start both
        </Button>

        <span class="grow" />

        <Button variant="ghost" size="sm" @click="refreshDevices">
          <RefreshCw class="size-4" aria-hidden="true" />
          Refresh devices
        </Button>
      </div>

      <p class="max-w-[68ch] text-xs text-muted-foreground">
        Nothing starts until you press a button, and your files and inputs never leave your device:
        the preview, the level meter, and the test clip all stay in this tab and stop the moment you
        press Stop or navigate away.
      </p>

      <!-- device pickers, named only after a permission grant -->
      <div v-if="cameraDevices.length || micDevices.length" class="grid gap-3 sm:grid-cols-2">
        <div v-if="cameraDevices.length" class="flex flex-col gap-1.5">
          <Label for="webcam-mic-camera" class="text-xs text-muted-foreground">Camera</Label>
          <SearchableSelect
            id="webcam-mic-camera"
            :spec="cameraSpec"
            :model-value="selectedCameraId"
            class="w-full bg-card"
            @update:model-value="(v) => (selectedCameraId = v)"
          />
        </div>
        <div v-if="micDevices.length" class="flex flex-col gap-1.5">
          <Label for="webcam-mic-microphone" class="text-xs text-muted-foreground">
            Microphone
          </Label>
          <SearchableSelect
            id="webcam-mic-microphone"
            :spec="micSpec"
            :model-value="selectedMicId"
            class="w-full bg-card"
            @update:model-value="(v) => (selectedMicId = v)"
          />
        </div>
      </div>
      <p v-else class="text-xs text-muted-foreground">
        Browsers hide device names until you grant permission once, so the camera and microphone
        lists appear here after the first start.
      </p>
    </div>

    <!-- camera -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span
          class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <Camera class="size-3.5" aria-hidden="true" />
          Camera
        </span>
        <div v-if="cameraOn" class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <Switch
              id="webcam-mic-mirror"
              :model-value="mirror"
              @update:model-value="(v) => (mirror = Boolean(v))"
            />
            <Label for="webcam-mic-mirror" class="cursor-pointer text-xs text-muted-foreground">
              Mirror preview
            </Label>
          </div>
          <Button variant="outline" size="sm" @click="takeSnapshot">
            <Aperture class="size-4" aria-hidden="true" />
            Take snapshot
          </Button>
        </div>
      </div>

      <ErrorBanner v-if="cameraError" :message="cameraError.message" :hint="cameraError.fix" />

      <div class="overflow-hidden rounded-[10px] bg-black shadow-[var(--sh-inset)]">
        <video
          v-show="cameraOn"
          ref="videoEl"
          class="block max-h-[420px] w-full object-contain"
          :style="mirror ? { transform: 'scaleX(-1)' } : undefined"
          autoplay
          playsinline
          muted
        />
        <div
          v-if="!cameraOn"
          class="flex min-h-56 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
        >
          <p class="max-w-sm text-sm text-white/80">
            The camera is off. Press Start camera to see the live preview, check your framing, and
            read the exact resolution and frame rate the browser is getting.
          </p>
        </div>
      </div>

      <p v-if="cameraOn" class="text-xs text-muted-foreground">
        Take snapshot saves a PNG of the current frame. The saved file is never mirrored, even when
        the preview above is, so it matches what other people see.
      </p>

      <dl v-if="videoRows" class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <template v-for="(value, key) in videoRows" :key="key">
          <dt class="text-xs text-muted-foreground sm:pt-0.5">{{ key }}</dt>
          <dd class="font-mono text-sm break-all tabular-nums">{{ value }}</dd>
        </template>
      </dl>
    </div>

    <!-- microphone -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span
          class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <Mic class="size-3.5" aria-hidden="true" />
          Microphone
        </span>
        <Button
          v-if="micOn && recordSupported"
          variant="outline"
          size="sm"
          :disabled="recording"
          @click="recordClip"
        >
          {{ recording ? "Recording…" : "Record 3 s test clip" }}
        </Button>
      </div>

      <ErrorBanner v-if="micError" :message="micError.message" :hint="micError.fix" />

      <EmptyState
        v-if="!micOn"
        title="The microphone is off"
        hint="Press Start microphone, then talk at your normal call volume and watch the meter: you want it sitting in the green band, not pinned at either end."
        icon="Mic"
      />

      <template v-else>
        <!-- level meter -->
        <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="text-xs text-muted-foreground">Input level (RMS)</span>
            <span class="flex items-baseline gap-2">
              <span class="font-mono text-lg font-semibold tabular-nums" :class="textClass">
                {{ dbLabel }}
              </span>
              <span class="text-sm capitalize" :class="textClass">{{ level }}</span>
            </span>
          </div>

          <div class="relative h-4 overflow-hidden rounded-[6px] bg-card shadow-[var(--sh-inset)]">
            <div
              class="h-full rounded-[6px] transition-[width] duration-75 ease-out"
              :class="barClass"
              :style="{ width: `${rmsPercent}%` }"
            />
            <div
              class="absolute inset-y-0 w-0.5 bg-foreground/70"
              :style="{ left: `calc(${peakPercent}% - 1px)` }"
              aria-hidden="true"
            />
          </div>

          <div
            class="flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums"
          >
            <span>-60 dB</span>
            <span>-40</span>
            <span>-20</span>
            <span>0 dB</span>
          </div>

          <p class="text-xs text-muted-foreground">
            {{ levelHint }} Peak hold {{ peakLabel
            }}<span v-if="clippedCount > 0">
              , {{ clippedCount }} clipped samples in the last window</span
            >.
          </p>
        </div>

        <!-- waveform -->
        <canvas
          ref="waveEl"
          class="block h-16 w-full rounded-[10px] bg-secondary text-primary shadow-[var(--sh-inset)]"
          aria-hidden="true"
        />

        <!-- test clip playback -->
        <div v-if="clipUrl" class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">
            Test clip ({{ clipMimeType || "audio" }}). It plays back from memory and is never
            uploaded or saved to disk.
          </span>
          <audio :src="clipUrl" controls class="w-full" />
        </div>

        <dl
          v-if="audioRows"
          class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]"
        >
          <template v-for="(value, key) in audioRows" :key="key">
            <dt class="text-xs text-muted-foreground sm:pt-0.5">{{ key }}</dt>
            <dd class="font-mono text-sm break-all tabular-nums">{{ value }}</dd>
          </template>
        </dl>
      </template>
    </div>

    <!-- devices and report -->
    <div
      v-if="deviceSummary || report"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Devices and report
        </span>
        <CopyButton v-if="reportText" :text="reportText" label="Copy report" />
      </div>

      <dl
        v-if="deviceSummary"
        class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]"
      >
        <template v-for="(value, key) in deviceSummary" :key="key">
          <dt class="text-xs text-muted-foreground sm:pt-0.5">{{ key }}</dt>
          <dd class="text-sm break-words">{{ value }}</dd>
        </template>
      </dl>

      <OutputView v-if="report" :output="report" />
    </div>
  </div>
</template>
