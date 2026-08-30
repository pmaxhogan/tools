<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Camera, Lock, LockOpen, RotateCcw } from "lucide-vue-next";
import { ToolError, type SelectOption, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  describeLux,
  estimateCct,
  estimateLux,
  linearLuma,
  rollingAverage,
  run,
  sRGBToLinear,
  type CctEstimate,
  type LuxEstimate,
} from "@/tools/light-meter/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CopyButton from "../CopyButton.vue";
import OutputView from "../OutputView.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for the Light Meter.
 *
 * The generic ToolShell reads one textarea. This tool needs a live camera
 * preview, a frame sampler, an exposure lock, and a calibration control, so
 * all of that lives here. Every number it shows still comes from the pure
 * layer at `src/tools/light-meter/` (PROJECT.md rule 27): sRGBToLinear and
 * linearLuma turn canvas bytes into a mean luma, rollingAverage smooths the
 * series, estimateLux and estimateCct interpret it, describeLux names the
 * light level, and run() builds the copyable report. This file only moves
 * pixels into those functions and paints what comes back.
 *
 * Nothing starts on mount. The camera opens on a click, pauses when the tab
 * goes to the background, and stops on Stop and on unmount. No frame is
 * recorded or uploaded. The only value that persists is the calibration
 * factor, a single number kept in localStorage as a preference (rule 7):
 * never a frame, never a reading.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Sampling grid. 64x48 is 3072 pixels: a stable mean, cheap to run at 5 Hz. */
const SAMPLE_W = 64;
const SAMPLE_H = 48;
/** Five frames a second. Sampling faster than this mostly adds sensor noise. */
const SAMPLE_INTERVAL_MS = 200;
/** Smoothing window for mean luma, about 1.6 seconds of frames. */
const LUMA_WINDOW = 8;
/** Averaging window for the min, average, max strip: about 5 seconds. */
const AVERAGE_WINDOW = 25;
/** Longest series kept in memory, about a minute at 5 Hz. */
const SERIES_MAX = 300;
/** The report rows are rebuilt at most once a second so they stay readable. */
const OUTPUT_INTERVAL_MS = 1000;
/**
 * 1 foot-candle = 10.7639 lux. The logic layer holds the same constant but
 * keeps it and its formatter private, so the big readout needs its own copy.
 */
const LUX_PER_FOOTCANDLE = 10.7639;
/** MediaStreamTrack reports exposureTime in units of 100 microseconds. */
const EXPOSURE_TIME_UNIT_SEC = 1e-4;
/** The calibration range the logic layer accepts. */
const CALIBRATION_MIN = 0.1;
const CALIBRATION_MAX = 10;
/** Preference key. Holds one number, never a reading and never a frame. */
const CALIBRATION_KEY = "light-meter:calibration";

/* ------------------------------------------------------------------ *
 * units, read from the tool metadata so the panel and the page agree
 * ------------------------------------------------------------------ */

type Units = "lux" | "footcandles";

const FALLBACK_UNITS: SelectOption[] = [
  { value: "lux", label: "Lux", synonyms: [] },
  { value: "footcandles", label: "Footcandles", synonyms: [] },
];

function findUnitSpec(meta: ToolMeta): SelectOptionSpec | undefined {
  return meta.options?.find(
    (option): option is SelectOptionSpec => option.kind === "select" && option.id === "units",
  );
}

function asUnits(value: string): Units {
  return value === "footcandles" ? "footcandles" : "lux";
}

const units = ref<Units>(asUnits(findUnitSpec(props.meta)?.default ?? "lux"));
const unitChoices = computed<SelectOption[]>(() => {
  const listed = findUnitSpec(props.meta)?.options ?? [];
  return listed.length > 0 ? listed : FALLBACK_UNITS;
});
const unitLabel = computed(() => (units.value === "footcandles" ? "fc" : "lux"));

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

interface PanelError {
  message: string;
  fix?: string;
}

/** One analyzed frame: mean linear channels plus a swatch for the white point. */
interface FrameSample {
  meanLuma: number;
  r: number;
  g: number;
  b: number;
  swatch: string;
}

/** The JSON shape the logic layer's run() parses. */
interface FrameReport {
  meanLuma: number;
  r: number;
  g: number;
  b: number;
  exposureTimeSec?: number;
  iso?: number;
  fNumber?: number;
}

interface Reading {
  lux: LuxEstimate;
  cct: CctEstimate;
  description: string;
  swatch: string;
}

/**
 * Exposure fields are an Image Capture extension that lib.dom does not carry
 * on MediaTrackCapabilities, MediaTrackSettings, or MediaTrackConstraintSet,
 * so the three shapes this panel reads are declared locally and the browser
 * results are cast to them. Everything is optional: a browser that reports
 * none of it falls through to the rough estimate.
 */
interface ExposureRange {
  min?: number;
  max?: number;
  step?: number;
}

interface CameraCapabilities {
  exposureMode?: string[];
  exposureTime?: ExposureRange;
  iso?: ExposureRange;
}

interface CameraSettings {
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
}

interface ExposureConstraintSet {
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
}

/* ------------------------------------------------------------------ *
 * live objects (never reactive: Vue must not proxy a live track)
 * ------------------------------------------------------------------ */

let stream: MediaStream | null = null;
let videoTrack: MediaStreamTrack | null = null;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let sampleCanvas: HTMLCanvasElement | null = null;
let lumaSeries: number[] = [];
let luxSeries: number[] = [];
let lastSample: FrameSample | null = null;
let lastMeanLuma = 0;
/** True once the track has actually reported a shutter time or an ISO. */
let exposureAvailable = false;
let lastOutputAt = 0;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const videoEl = ref<HTMLVideoElement>();

const running = ref(false);
const starting = ref(false);
const pausedByTab = ref(false);
const source = ref<"camera" | "photo">("camera");

const panelError = ref<PanelError | null>(null);
const reading = shallowRef<Reading | null>(null);
const output = shallowRef<Record<string, string> | null>(null);

const statsMin = ref<number | null>(null);
const statsAvg = ref<number | null>(null);
const statsMax = ref<number | null>(null);

const manualExposureSupported = ref(false);
const exposureLocked = ref(false);
const exposureSettings = ref<CameraSettings | null>(null);
const exposureNote = ref("");
const fNumberText = ref("");

const calibration = ref(1);
const knownReadingText = ref("");
const calibrationError = ref<string | null>(null);
const storageBlocked = ref(false);

/* ------------------------------------------------------------------ *
 * derived exposure values
 * ------------------------------------------------------------------ */

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const exposureTimeSec = computed<number | null>(() => {
  const raw = positiveOrNull(exposureSettings.value?.exposureTime);
  return raw === null ? null : raw * EXPOSURE_TIME_UNIT_SEC;
});

const isoValue = computed<number | null>(() => positiveOrNull(exposureSettings.value?.iso));

const fNumber = computed<number | null>(() => {
  const text = fNumberText.value.trim();
  if (text === "") return null;
  return positiveOrNull(Number(text));
});

/**
 * estimateLux only takes its measured path when shutter, ISO, and aperture
 * are all known. No browser reports aperture through MediaStreamTrack, so
 * the f-number below is the one value the visitor has to supply by hand.
 */
const hasMeasuredInputs = computed(
  () =>
    source.value === "camera" &&
    exposureTimeSec.value !== null &&
    isoValue.value !== null &&
    fNumber.value !== null,
);

const exposureReported = computed(() => exposureTimeSec.value !== null || isoValue.value !== null);

/** Both halves are needed before an f-number can unlock the measured path. */
const shutterAndIsoReported = computed(
  () => exposureTimeSec.value !== null && isoValue.value !== null,
);

const shutterText = computed(() => {
  const seconds = exposureTimeSec.value;
  if (seconds === null) return "not reported";
  if (seconds >= 1) return `${seconds.toFixed(1)} s`;
  return `1/${Math.round(1 / seconds)} s`;
});

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

function toDisplay(lux: number): number {
  return units.value === "footcandles" ? lux / LUX_PER_FOOTCANDLE : lux;
}

function fromDisplay(value: number): number {
  return units.value === "footcandles" ? value * LUX_PER_FOOTCANDLE : value;
}

/** Display precision for the big readout, tightening as the value gets small. */
function formatMeasure(lux: number): string {
  const value = toDisplay(lux);
  if (!Number.isFinite(value)) return "?";
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toExponential(2);
}

const readingText = computed(() =>
  reading.value ? `${formatMeasure(reading.value.lux.lux)} ${unitLabel.value}` : "",
);

const rangeText = computed(() => {
  const current = reading.value;
  if (!current) return "";
  const [low, high] = current.lux.range;
  return `${formatMeasure(low)} to ${formatMeasure(high)} ${unitLabel.value}`;
});

const confidenceLabel = computed(() =>
  reading.value?.lux.confidence === "measured"
    ? "Measured from exposure settings"
    : "Rough estimate, brightness only",
);

const calibrationLabel = computed(() => `${calibration.value.toFixed(2)}x`);

/* ------------------------------------------------------------------ *
 * frame analysis
 * ------------------------------------------------------------------ */

/**
 * The estimated white point as a CSS color. The channel means here are still
 * gamma encoded sRGB straight off the canvas, so the only step is scaling the
 * brightest channel up to full: a dim scene still shows its color cast, and
 * no color math is duplicated from the logic layer.
 */
function whitePointSwatch(r: number, g: number, b: number): string {
  const peak = Math.max(r, g, b);
  if (!(peak > 0)) return "rgb(0 0 0)";
  const scale = 255 / peak;
  const channel = (value: number): number => Math.round(Math.min(255, Math.max(0, value * scale)));
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)})`;
}

function analyzeFrame(image: ImageData): FrameSample {
  const px = image.data;
  const count = px.length / 4;
  if (count <= 0) {
    return { meanLuma: 0, r: 0, g: 0, b: 0, swatch: "rgb(0 0 0)" };
  }

  let linR = 0;
  let linG = 0;
  let linB = 0;
  let rawR = 0;
  let rawG = 0;
  let rawB = 0;

  for (let i = 0; i < px.length; i += 4) {
    const r8 = px[i] ?? 0;
    const g8 = px[i + 1] ?? 0;
    const b8 = px[i + 2] ?? 0;
    rawR += r8;
    rawG += g8;
    rawB += b8;
    linR += sRGBToLinear(r8 / 255);
    linG += sRGBToLinear(g8 / 255);
    linB += sRGBToLinear(b8 / 255);
  }

  const r = linR / count;
  const g = linG / count;
  const b = linB / count;

  return {
    meanLuma: linearLuma(r, g, b),
    r,
    g,
    b,
    swatch: whitePointSwatch(rawR / count, rawG / count, rawB / count),
  };
}

/** Draws into the reused sampling canvas and hands back its pixels. */
function withSampleContext(draw: (ctx: CanvasRenderingContext2D) => void): ImageData | null {
  sampleCanvas ??= document.createElement("canvas");
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
  draw(ctx);
  return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
}

/* ------------------------------------------------------------------ *
 * readings
 * ------------------------------------------------------------------ */

function buildReport(sample: FrameSample, meanLuma: number): FrameReport {
  const report: FrameReport = { meanLuma, r: sample.r, g: sample.g, b: sample.b };
  if (hasMeasuredInputs.value) {
    report.exposureTimeSec = exposureTimeSec.value ?? undefined;
    report.iso = isoValue.value ?? undefined;
    report.fNumber = fNumber.value ?? undefined;
  }
  return report;
}

function refreshOutput(report: FrameReport) {
  try {
    output.value = run(JSON.stringify(report), {
      calibration: calibration.value,
      units: units.value,
    });
  } catch (err) {
    output.value = null;
    panelError.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : String(err) };
  }
}

/** Turns a report into the visible readout. Never touches the series. */
function render(report: FrameReport, swatch: string, force: boolean) {
  const lux = estimateLux({
    meanLuma: report.meanLuma,
    exposureTimeSec: report.exposureTimeSec,
    iso: report.iso,
    fNumber: report.fNumber,
    calibration: calibration.value,
  });

  reading.value = {
    lux,
    cct: estimateCct({ r: report.r, g: report.g, b: report.b }),
    description: describeLux(lux.lux),
    swatch,
  };

  const now = Date.now();
  if (force || now - lastOutputAt >= OUTPUT_INTERVAL_MS) {
    lastOutputAt = now;
    refreshOutput(report);
  }
  return lux.lux;
}

function pushLux(lux: number) {
  luxSeries.push(lux);
  if (luxSeries.length > SERIES_MAX) luxSeries.shift();
  statsMin.value = statsMin.value === null ? lux : Math.min(statsMin.value, lux);
  statsMax.value = statsMax.value === null ? lux : Math.max(statsMax.value, lux);
  statsAvg.value = rollingAverage(luxSeries, AVERAGE_WINDOW);
}

function commitSample(sample: FrameSample, meanLuma: number, force: boolean) {
  lastSample = sample;
  lastMeanLuma = meanLuma;
  pushLux(render(buildReport(sample, meanLuma), sample.swatch, force));
}

/**
 * Repaints the last reading after an option change, without a new sample. The
 * report is rebuilt rather than reused so a units, calibration, or f-number
 * change is picked up even while the camera is stopped.
 */
function recompute(force: boolean) {
  const sample = lastSample;
  if (!sample) return;
  render(buildReport(sample, lastMeanLuma), sample.swatch, force);
}

function resetSeries() {
  lumaSeries = [];
  luxSeries = [];
  statsMin.value = null;
  statsAvg.value = null;
  statsMax.value = null;
}

/* ------------------------------------------------------------------ *
 * sampling loop
 * ------------------------------------------------------------------ */

function sampleFrame() {
  const video = videoEl.value;
  if (!video || video.readyState < 2) return;
  if (!video.videoWidth || !video.videoHeight) return;

  if (exposureAvailable) syncExposureSettings();

  const image = withSampleContext((ctx) => ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H));
  if (!image) return;

  const sample = analyzeFrame(image);
  lumaSeries.push(sample.meanLuma);
  if (lumaSeries.length > SERIES_MAX) lumaSeries.shift();
  commitSample(sample, rollingAverage(lumaSeries, LUMA_WINDOW), false);
}

function startTimer() {
  stopTimer();
  sampleTimer = setInterval(sampleFrame, SAMPLE_INTERVAL_MS);
}

function stopTimer() {
  if (sampleTimer !== undefined) clearInterval(sampleTimer);
  sampleTimer = undefined;
}

/* ------------------------------------------------------------------ *
 * camera
 * ------------------------------------------------------------------ */

function describeCameraError(err: unknown): PanelError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message: "Permission to use the camera was denied, so the meter cannot read live light.",
      fix: "Click the camera or lock icon at the left of your address bar, set the camera to Allow, reload the page, then press Start camera again. You can also drop a photo below for a one shot reading.",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError"
  ) {
    return {
      message: "No camera was found on this device.",
      fix: "Drop a photo below instead, or open this page on a phone with a rear camera.",
    };
  }
  return {
    message: `The camera could not be started: ${err instanceof Error ? err.message : String(err)}`,
    fix: "Close any other app or tab using the camera, then try again. You can also drop a photo below for a one shot reading.",
  };
}

function readExposureSettings(): CameraSettings | null {
  if (!videoTrack) return null;
  // MediaTrackSettings in lib.dom has no exposure fields; read them locally.
  const settings = videoTrack.getSettings() as CameraSettings;
  return {
    exposureMode: settings.exposureMode,
    exposureTime: settings.exposureTime,
    iso: settings.iso,
  };
}

/**
 * Pulls the track's current exposure into state. Under auto exposure these
 * numbers move constantly, so the sampling loop calls this every frame once
 * the camera has proved it reports them at all.
 */
function syncExposureSettings() {
  const settings = readExposureSettings();
  exposureSettings.value = settings;
  exposureAvailable =
    positiveOrNull(settings?.exposureTime) !== null || positiveOrNull(settings?.iso) !== null;
}

function readExposureCapabilities() {
  // Cast the result, not the track: the same shape QrReaderPanel uses for torch.
  const caps = videoTrack?.getCapabilities?.() as CameraCapabilities | undefined;
  manualExposureSupported.value = (caps?.exposureMode ?? []).includes("manual");
  syncExposureSettings();
  exposureLocked.value = exposureSettings.value?.exposureMode === "manual";
  exposureNote.value = manualExposureSupported.value
    ? "This camera reports a manual exposure mode. Locking it freezes the shutter and ISO the camera has chosen, which stops the reading from drifting as you move."
    : "This browser does not expose a manual exposure mode for this camera, so auto exposure keeps re-adjusting to whatever you point at. That makes the reading relative rather than absolute: trust the direction it moves more than the number itself.";
}

async function setExposureLock(lock: boolean) {
  const track = videoTrack;
  if (!track) return;

  const constraint: ExposureConstraintSet = { exposureMode: lock ? "manual" : "continuous" };
  if (lock) {
    const current = readExposureSettings();
    const time = positiveOrNull(current?.exposureTime);
    const iso = positiveOrNull(current?.iso);
    if (time !== null) constraint.exposureTime = time;
    if (iso !== null) constraint.iso = iso;
  }

  try {
    // MediaTrackConstraintSet has no exposure fields either, so widen the
    // track's applyConstraints signature for this one call.
    await (
      track as MediaStreamTrack & {
        applyConstraints(c: { advanced: ExposureConstraintSet[] }): Promise<void>;
      }
    ).applyConstraints({ advanced: [constraint] });

    syncExposureSettings();
    exposureLocked.value = exposureSettings.value?.exposureMode === "manual";
    if (lock && !exposureLocked.value) {
      exposureNote.value =
        "This camera accepted the request but stayed on auto exposure, so the reading is still relative.";
    }
    resetSeries();
    recompute(true);
  } catch {
    manualExposureSupported.value = false;
    exposureLocked.value = false;
    exposureNote.value =
      "This camera advertised a manual exposure mode but rejected the request, so auto exposure stays on and the reading is relative.";
  }
}

async function startCamera() {
  if (running.value || starting.value) return;
  panelError.value = null;

  if (!navigator.mediaDevices?.getUserMedia) {
    panelError.value = {
      message: "This browser does not offer camera access to web pages.",
      fix: "Drop a photo below for a one shot reading, or try a current version of Chrome, Edge, Firefox, or Safari.",
    };
    return;
  }

  starting.value = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    videoTrack = stream.getVideoTracks()[0] ?? null;

    const video = videoEl.value;
    if (!video) {
      stopCamera();
      return;
    }
    video.srcObject = stream;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });
    await video.play();
    // Only meaningful once frames are flowing: a track that has not started
    // yet reports an empty settings object on most browsers.
    readExposureCapabilities();

    source.value = "camera";
    resetSeries();
    running.value = true;
    startTimer();
  } catch (err) {
    panelError.value = describeCameraError(err);
    stopCamera();
  } finally {
    starting.value = false;
  }
}

function stopCamera() {
  stopTimer();
  running.value = false;
  pausedByTab.value = false;
  exposureAvailable = false;
  if (videoEl.value) videoEl.value.srcObject = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  videoTrack = null;
}

/* ------------------------------------------------------------------ *
 * one shot photo reading
 * ------------------------------------------------------------------ */

function readPhoto(img: HTMLImageElement) {
  if (!img.naturalWidth || !img.naturalHeight) {
    panelError.value = {
      message: "That image has no pixels to read.",
      fix: "Try a different photo.",
    };
    return;
  }

  stopCamera();
  exposureSettings.value = null;
  exposureLocked.value = false;
  manualExposureSupported.value = false;
  exposureNote.value = "";
  source.value = "photo";
  resetSeries();

  const image = withSampleContext((ctx) => ctx.drawImage(img, 0, 0, SAMPLE_W, SAMPLE_H));
  if (!image) {
    panelError.value = {
      message: "This browser could not open a canvas to read the photo.",
      fix: "Reload the page and try again, or use the live camera instead.",
    };
    return;
  }

  panelError.value = null;
  const sample = analyzeFrame(image);
  commitSample(sample, sample.meanLuma, true);
}

function acceptFile(file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    panelError.value = {
      message: `${file.name || "That file"} is not an image, so there is no light in it to read.`,
      fix: "Drop a PNG, JPEG, or WebP photo taken in the light you want to measure.",
    };
    return;
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    readPhoto(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    panelError.value = {
      message: "That image could not be decoded.",
      fix: "Try a different photo, or export it as a PNG or JPEG first.",
    };
  };
  img.src = url;
}

function onFiles(files: File[]) {
  acceptFile(files[0]);
}

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

function setUnits(value: string) {
  const next = asUnits(value);
  if (next === units.value) return;
  units.value = next;
  recompute(true);
}

/**
 * An f-number switches estimateLux between its measured and rough paths, so
 * every earlier reading in the series was computed on the other scale.
 */
watch(fNumberText, () => {
  resetSeries();
  recompute(true);
});

function readStoredCalibration(): number | null {
  try {
    const stored = window.localStorage.getItem(CALIBRATION_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed >= CALIBRATION_MIN && parsed <= CALIBRATION_MAX) {
      return parsed;
    }
  } catch {
    storageBlocked.value = true;
  }
  return null;
}

function writeStoredCalibration(value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(CALIBRATION_KEY);
    else window.localStorage.setItem(CALIBRATION_KEY, String(value));
    storageBlocked.value = false;
  } catch {
    storageBlocked.value = true;
  }
}

/**
 * Calibration solves for the factor that makes the current frame read the
 * value a real meter reports. estimateLux is linear in `calibration` on its
 * rough path, so the factor is simply the ratio against an uncalibrated run.
 */
function applyCalibration() {
  calibrationError.value = null;

  const typed = Number(knownReadingText.value.trim());
  if (knownReadingText.value.trim() === "" || !Number.isFinite(typed) || typed <= 0) {
    calibrationError.value = `Enter the reading from your meter as a positive number of ${unitLabel.value}.`;
    return;
  }

  const sample = lastSample;
  if (!sample) {
    calibrationError.value =
      "Take a reading first: start the camera or drop a photo, let the number settle, then calibrate against it.";
    return;
  }
  const report = buildReport(sample, lastMeanLuma);

  if (report.exposureTimeSec !== undefined) {
    calibrationError.value =
      "This reading already comes from the camera's own exposure settings, which calibration does not change. Clear the lens f-number first if you want to calibrate the brightness only estimate.";
    return;
  }

  const uncalibrated = estimateLux({ meanLuma: report.meanLuma }).lux;
  if (!(uncalibrated > 0)) {
    calibrationError.value =
      "This frame is too dark to calibrate against. Point the camera at the light you are measuring and try again.";
    return;
  }

  const factor = fromDisplay(typed) / uncalibrated;
  if (factor < CALIBRATION_MIN || factor > CALIBRATION_MAX) {
    calibrationError.value = `That would need a calibration factor of ${factor.toFixed(2)}x, outside the ${CALIBRATION_MIN}x to ${CALIBRATION_MAX}x range this tool accepts. Check that your meter and the camera are pointed at the same light, then try again.`;
    return;
  }

  calibration.value = factor;
  writeStoredCalibration(factor);
  resetSeries();
  recompute(true);
}

function resetCalibration() {
  calibration.value = 1;
  calibrationError.value = null;
  knownReadingText.value = "";
  writeStoredCalibration(null);
  resetSeries();
  recompute(true);
}

function resetStats() {
  resetSeries();
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    if (running.value) {
      stopTimer();
      pausedByTab.value = true;
    }
    return;
  }
  if (running.value && pausedByTab.value) {
    pausedByTab.value = false;
    startTimer();
  }
}

onMounted(() => {
  const stored = readStoredCalibration();
  if (stored !== null) calibration.value = stored;
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopCamera();
  sampleCanvas = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Privacy line and unit toggle -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-[52ch] text-xs text-muted-foreground">
        Frames are sampled and averaged in this tab, then discarded. Your files and inputs never
        leave your device.
      </p>
      <div
        class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
        role="group"
        aria-label="Units"
      >
        <Button
          v-for="choice in unitChoices"
          :key="choice.value"
          variant="ghost"
          size="sm"
          :aria-pressed="units === choice.value"
          :class="units === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setUnits(choice.value)"
        >
          {{ choice.label }}
        </Button>
      </div>
    </div>

    <!-- Errors -->
    <ErrorBanner v-if="panelError" :message="panelError.message" :hint="panelError.fix" />

    <!-- Live preview -->
    <div class="relative overflow-hidden rounded-[10px] bg-black shadow-[var(--sh-inset)]">
      <video
        ref="videoEl"
        class="block max-h-[300px] w-full object-contain"
        :class="running ? '' : 'hidden'"
        autoplay
        muted
        playsinline
      />
      <div
        v-if="!running"
        class="flex min-h-44 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      >
        <p class="max-w-sm text-sm text-white/80">
          Point your camera at the light you want to measure. The camera only turns on when you
          press Start, and it stops when you leave.
        </p>
        <Button size="sm" :disabled="starting" @click="startCamera">
          <Camera class="size-4" aria-hidden="true" />
          {{ starting ? "Starting…" : "Start camera" }}
        </Button>
      </div>
    </div>

    <div v-if="running" class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-muted-foreground">
        {{
          pausedByTab
            ? "Paused while this tab is in the background."
            : "Reading five frames a second. Hold the camera steady and let the number settle."
        }}
      </span>
      <span class="grow" />
      <Button
        v-if="manualExposureSupported"
        variant="outline"
        size="sm"
        :aria-pressed="exposureLocked"
        @click="setExposureLock(!exposureLocked)"
      >
        <Lock v-if="exposureLocked" class="size-3.5" aria-hidden="true" />
        <LockOpen v-else class="size-3.5" aria-hidden="true" />
        {{ exposureLocked ? "Back to auto exposure" : "Lock exposure" }}
      </Button>
      <Button variant="ghost" size="sm" @click="stopCamera"> Stop </Button>
    </div>

    <!-- Reading -->
    <div
      v-if="reading"
      class="flex flex-col gap-4 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Illuminance
          </span>
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-4xl leading-none font-semibold tabular-nums">
              {{ formatMeasure(reading.lux.lux) }}
            </span>
            <span class="text-lg text-muted-foreground">{{ unitLabel }}</span>
          </div>
          <span class="text-sm text-muted-foreground">{{ reading.description }}</span>
        </div>
        <div class="flex flex-col items-end gap-1.5">
          <span class="rounded-[8px] bg-card px-2 py-1 text-xs text-muted-foreground">
            {{ confidenceLabel }}
          </span>
          <CopyButton :text="readingText" label="Copy reading" />
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">Likely range</dt>
          <dd class="font-mono text-sm tabular-nums">{{ rangeText }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">EV100</dt>
          <dd class="font-mono text-sm tabular-nums">{{ reading.lux.ev.toFixed(2) }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">Source</dt>
          <dd class="text-sm">{{ source === "photo" ? "Dropped photo" : "Live camera" }}</dd>
        </div>
      </dl>

      <!-- Color temperature and white point -->
      <div class="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
        <span
          class="size-10 shrink-0 rounded-[8px] border"
          :style="{ backgroundColor: reading.swatch }"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col">
          <span class="text-xs text-muted-foreground">
            Color temperature and estimated white point
          </span>
          <span class="font-mono text-sm tabular-nums">
            {{ Math.round(reading.cct.cct) }} K, {{ reading.cct.label }}
          </span>
        </div>
      </div>

      <!-- Min, average, max -->
      <div class="flex flex-col gap-2 border-t border-border/60 pt-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Min, average, max
          </span>
          <Button variant="ghost" size="sm" @click="resetStats">
            <RotateCcw class="size-3.5" aria-hidden="true" />
            Reset
          </Button>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div class="flex flex-col rounded-[8px] bg-card px-2.5 py-2">
            <span class="text-xs text-muted-foreground">Min</span>
            <span class="font-mono text-sm tabular-nums">
              {{ statsMin === null ? "?" : formatMeasure(statsMin) }}
            </span>
          </div>
          <div class="flex flex-col rounded-[8px] bg-card px-2.5 py-2">
            <span class="text-xs text-muted-foreground">Average</span>
            <span class="font-mono text-sm tabular-nums">
              {{ statsAvg === null ? "?" : formatMeasure(statsAvg) }}
            </span>
          </div>
          <div class="flex flex-col rounded-[8px] bg-card px-2.5 py-2">
            <span class="text-xs text-muted-foreground">Max</span>
            <span class="font-mono text-sm tabular-nums">
              {{ statsMax === null ? "?" : formatMeasure(statsMax) }}
            </span>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Average covers the last five seconds. Min and max cover everything since the last reset.
          All three are in {{ unitLabel }}.
        </p>
      </div>
    </div>

    <!-- Exposure -->
    <div
      v-if="source === 'camera' && (running || exposureNote)"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Camera exposure
      </span>
      <p v-if="exposureNote" class="max-w-[68ch] text-xs text-muted-foreground">
        {{ exposureNote }}
      </p>

      <dl v-if="exposureReported" class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">Shutter</dt>
          <dd class="font-mono text-sm tabular-nums">{{ shutterText }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">ISO</dt>
          <dd class="font-mono text-sm tabular-nums">{{ isoValue ?? "not reported" }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">Mode</dt>
          <dd class="font-mono text-sm">{{ exposureSettings?.exposureMode ?? "not reported" }}</dd>
        </div>
      </dl>

      <div v-if="shutterAndIsoReported" class="flex flex-col gap-1.5">
        <Label for="light-meter-fnumber" class="text-xs text-muted-foreground">
          Lens f-number
        </Label>
        <Input
          id="light-meter-fnumber"
          v-model="fNumberText"
          class="w-40 bg-card"
          type="text"
          inputmode="decimal"
          placeholder="1.8"
        />
        <p class="max-w-[68ch] text-xs text-muted-foreground">
          This camera reports its shutter and ISO, but no browser reports the lens aperture. Enter
          the f-number from your camera's spec sheet and the reading switches to the same
          incident-light formula a handheld meter uses. Leave it empty to stay on the brightness
          only estimate.
        </p>
      </div>
    </div>

    <!-- Calibration -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Calibration
        </span>
        <span class="font-mono text-sm tabular-nums">{{ calibrationLabel }}</span>
      </div>

      <p class="max-w-[68ch] text-xs text-muted-foreground">
        Point this page and a real light meter at the same light, type what the meter says, and the
        factor that makes the two agree is applied to every later brightness only reading. It is
        saved on this device as a preference, never a reading and never a frame.
      </p>

      <div class="flex flex-wrap items-end gap-2">
        <div class="flex flex-col gap-1.5">
          <Label for="light-meter-known" class="text-xs text-muted-foreground">
            Known reading ({{ unitLabel }})
          </Label>
          <Input
            id="light-meter-known"
            v-model="knownReadingText"
            class="w-40 bg-card"
            type="text"
            inputmode="decimal"
            placeholder="320"
            @keydown.enter="applyCalibration"
          />
        </div>
        <Button variant="outline" size="sm" @click="applyCalibration"> Calibrate </Button>
        <Button variant="ghost" size="sm" :disabled="calibration === 1" @click="resetCalibration">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset to 1.00x
        </Button>
      </div>

      <p v-if="calibrationError" role="alert" class="max-w-[68ch] text-xs text-destructive">
        {{ calibrationError }}
      </p>
      <p v-if="storageBlocked" class="max-w-[68ch] text-xs text-muted-foreground">
        This browser blocked local storage, so the factor applies to this visit only.
      </p>
    </div>

    <!-- One shot photo -->
    <FileDrop
      accept="image/*"
      label="Read a photo instead"
      hint="Drop a photo here for a one shot reading, or click to choose one. The camera that took it already picked its own exposure and tone curve, so a photo reads as relative brightness rather than an absolute level, and it stops the live camera while it is shown."
      @files="onFiles"
    />

    <!-- Report -->
    <OutputView v-if="output" :output="output" />
    <p v-else class="text-xs text-muted-foreground">
      Press Start camera or drop a photo to see the full report, including the formula and its
      caveats.
    </p>
  </div>
</template>
