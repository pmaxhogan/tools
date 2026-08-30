<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { isEngineReady, isMediaSupported, runJob } from "@/lib/ffmpeg";
import { isMetered, shouldAutoDownload } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import type { ColorScheme, FreqAxis, FreqScale } from "@/tools/audio-spectrogram/index";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for the Spectrogram Viewer.
 *
 * The generic ToolShell cannot render this tool: the output is a picture with
 * two axes, a hover readout, and a playhead, none of which fit a text or
 * record shape. The DSP and the plot geometry still live in the pure logic
 * layer, so this file only decodes audio, drives the analysis in chunks, and
 * paints canvases.
 *
 * Nothing touches the DOM or the audio stack until a file arrives, so the
 * component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

type SpecLogic = typeof import("@/tools/audio-spectrogram/index");

/** The FFT module loads on the first file rather than on page load. */
let logicPromise: Promise<SpecLogic> | null = null;
function loadLogic(): Promise<SpecLogic> {
  logicPromise ??= import("@/tools/audio-spectrogram/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Honest ceiling: past this the analysis stops and the panel says so. */
const MAX_ANALYSIS_SECONDS = 600;
/** Column budget handed to the logic layer. Two screens wide is plenty. */
const MAX_COLUMNS = 2000;
/**
 * Rates an OfflineAudioContext is asked to run at. The spec allows 8000 to
 * 96000 everywhere and browsers accept far more, but a header can hold any
 * number at all, so anything outside this band decodes the ordinary way.
 */
const MIN_DECODE_RATE = 8000;
const MAX_DECODE_RATE = 384000;

const GUTTER_LEFT = 56;
const GUTTER_RIGHT = 12;
/** Top strip holding the decibel legend. */
const TOP_H = 22;
const WAVE_H = 64;
const GAP = 10;
const SPEC_H = 320;
/** Bottom strip holding the time ticks. */
const AXIS_H = 26;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<SpecLogic | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const error = ref<{ message: string; fix?: string } | null>(null);

const audioBuffer = shallowRef<AudioBuffer | null>(null);
const mono = shallowRef<Float32Array | null>(null);
/** The rate of the decoded buffer. Everything on the frequency axis uses this. */
const sampleRate = ref(48000);
/** The rate the file's own header states, or null when it could not be read. */
const sourceRate = ref<number | null>(null);
const fullDuration = ref(0);
const analyzedDuration = ref(0);
const channelCount = ref(0);

const columns = shallowRef<Float32Array[]>([]);
const freqBins = ref(1024);
const peaks = shallowRef<{ min: Float32Array; max: Float32Array } | null>(null);

const stage = ref<
  "idle" | "engine-prompt" | "loading-engine" | "extracting" | "decoding" | "analyzing" | "ready"
>("idle");
const progress = ref(0);

/**
 * Video support. A video file is routed through ffmpeg.wasm, which extracts its
 * audio track to WAV before the existing decode and FFT path takes over. The
 * engine is a one time download, so it never loads until a video actually
 * arrives, and on a metered connection it waits for a tap.
 */
const isVideo = ref(false);
/** A video held back on a metered connection until the visitor starts the load. */
const pendingVideo = shallowRef<File | null>(null);
const downloadBytes = ref(0);
const downloadTotal = ref(0);
/** ffmpeg extraction progress, or null while it cannot be estimated. */
const extractRatio = ref<number | null>(null);
/** The video's true duration, read from the ffmpeg log, before any analysis cap. */
const videoDuration = ref<number | null>(null);

const fftSize = ref("2048");
const colors = ref("viridis");
const axisScale = ref("linear");
const showWaveform = ref(true);

const fftSpec: SelectOptionSpec = {
  kind: "select",
  id: "spec-fft",
  label: "FFT size",
  default: "2048",
  options: [
    {
      value: "1024",
      label: "1024 (sharper in time)",
      synonyms: ["small window", "time resolution", "sharper in time"],
    },
    {
      value: "2048",
      label: "2048 (balanced)",
      synonyms: ["default", "balanced", "medium window"],
    },
    {
      value: "4096",
      label: "4096 (sharper in frequency)",
      synonyms: ["large window", "frequency resolution", "sharper in frequency"],
    },
  ],
};

const colorSpec: SelectOptionSpec = {
  kind: "select",
  id: "spec-colors",
  label: "Colors",
  default: "viridis",
  options: [
    {
      value: "viridis",
      label: "Viridis",
      synonyms: ["green blue", "perceptual", "default colormap"],
    },
    { value: "magma", label: "Magma", synonyms: ["black purple", "warm", "inferno like"] },
    { value: "gray", label: "Grayscale", synonyms: ["greyscale", "black and white", "monochrome"] },
  ],
};

const axisSpec: SelectOptionSpec = {
  kind: "select",
  id: "spec-scale",
  label: "Frequency axis",
  default: "linear",
  options: [
    { value: "linear", label: "Linear", synonyms: ["even spacing", "hertz linear"] },
    { value: "log", label: "Logarithmic", synonyms: ["log scale", "octaves", "musical"] },
  ],
};

/**
 * `x` and `y` are canvas coordinates (what the crosshair is drawn in);
 * `px` and `py` are the same point in laid-out CSS pixels, which is what the
 * absolutely positioned readout chip needs. The two differ whenever the
 * canvas is displayed at anything other than its logical width.
 */
const hover = ref<{
  x: number;
  y: number;
  px: number;
  py: number;
  time: number;
  freq: number;
  db: number;
} | null>(null);
const playing = ref(false);
const playhead = ref<number | null>(null);

const wrapper = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
const cssWidth = ref(880);
const renderScale = ref(1);

const truncated = computed(() => fullDuration.value > analyzedDuration.value + 0.01);
const hasAudio = computed(() => mono.value !== null);
const ready = computed(() => stage.value === "ready" && columns.value.length > 0);

const specTop = computed(() => TOP_H + (showWaveform.value ? WAVE_H + GAP : 0));
const canvasHeight = computed(() => specTop.value + SPEC_H + AXIS_H);
const plotWidth = computed(() =>
  Math.max(160, Math.round(cssWidth.value - GUTTER_LEFT - GUTTER_RIGHT)),
);

/* ---------------------------------------------------------------- */
/* small helpers                                                     */
/* ---------------------------------------------------------------- */

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "audio";
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* video detection and naming                                        */
/* ---------------------------------------------------------------- */

/** How much of a long file is analyzed, and how long the extracted audio runs. */
const EXTRACT_SECONDS = MAX_ANALYSIS_SECONDS;

/**
 * Containers that carry video. The MIME type is the first signal, but Windows
 * often hands drag and drop files an empty type for .mkv and .ts, so the
 * extension is the fallback that keeps those on the video path.
 */
const VIDEO_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "ogv",
  "ts",
  "m2ts",
  "mts",
  "flv",
  "wmv",
  "mpg",
  "mpeg",
  "3gp",
  "3g2",
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileIsVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  if (file.type.startsWith("audio/")) return false;
  return VIDEO_EXTENSIONS.includes(extensionOf(file.name));
}

/**
 * Collapse a file name to a safe ASCII name for the ffmpeg filesystem while
 * keeping the extension, which is how ffmpeg chooses the demuxer. Spaces and
 * unicode are legal there but make the log unreadable on a failure.
 */
function safeName(file: File): string {
  const ext = extensionOf(file.name);
  const stem =
    file.name
      .slice(0, ext ? file.name.length - ext.length - 1 : undefined)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "input";
  return ext ? `${stem}.${ext.replace(/[^A-Za-z0-9]/g, "")}` : "input.bin";
}

/** Pull the source duration in seconds out of an ffmpeg "Duration:" log line. */
function parseFfmpegDuration(line: string): number | null {
  const match = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
}

/* ---------------------------------------------------------------- */
/* audio context and playback                                        */
/* ---------------------------------------------------------------- */

let audioCtx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let rafId = 0;
let playFromCtxTime = 0;
let playFromOffset = 0;

function ensureAudioContext(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

function stopPlayback() {
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped: nothing to undo.
    }
    source.disconnect();
    source = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  playing.value = false;
  playhead.value = null;
  draw();
}

function followPlayhead() {
  if (!playing.value || !audioCtx) return;
  const at = playFromOffset + (audioCtx.currentTime - playFromCtxTime);
  if (at >= analyzedDuration.value) {
    stopPlayback();
    return;
  }
  playhead.value = at;
  draw();
  rafId = requestAnimationFrame(followPlayhead);
}

async function playFrom(time: number) {
  const buffer = audioBuffer.value;
  if (!buffer) return;
  stopPlayback();
  try {
    const ac = ensureAudioContext();
    // A context created before any gesture starts suspended, which would play
    // silence, so it is resumed here inside the click handler.
    if (ac.state === "suspended") await ac.resume();
    const node = ac.createBufferSource();
    node.buffer = buffer;
    node.connect(ac.destination);
    const start = clamp(time, 0, Math.max(0, analyzedDuration.value - 0.01));
    node.onended = () => {
      if (source === node) stopPlayback();
    };
    node.start(0, start, Math.max(0.01, analyzedDuration.value - start));
    source = node;
    playFromCtxTime = ac.currentTime;
    playFromOffset = start;
    playing.value = true;
    playhead.value = start;
    rafId = requestAnimationFrame(followPlayhead);
  } catch (e) {
    error.value = toToolError(e);
  }
}

/* ---------------------------------------------------------------- */
/* loading and analysis                                              */
/* ---------------------------------------------------------------- */

/** Bumped on every new file or setting change so stale chunks abandon quietly. */
let analysisToken = 0;

function resetAudio() {
  stopPlayback();
  specImage = null;
  audioBuffer.value = null;
  mono.value = null;
  sourceRate.value = null;
  columns.value = [];
  peaks.value = null;
  hover.value = null;
  fullDuration.value = 0;
  analyzedDuration.value = 0;
  channelCount.value = 0;
  progress.value = 0;
  stage.value = "idle";
  isVideo.value = false;
  pendingVideo.value = null;
  downloadBytes.value = 0;
  downloadTotal.value = 0;
  extractRatio.value = null;
  videoDuration.value = null;
}

/** Average every channel into one track: a spectrogram has a single Y axis. */
function toMono(buffer: AudioBuffer, maxSamples: number): Float32Array {
  const length = Math.min(buffer.length, maxSamples);
  const out = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] = out[i]! + data[i]!;
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) out[i] = out[i]! / channels;
  }
  return out;
}

/**
 * Decode without letting the browser rewrite the sample rate.
 *
 * `decodeAudioData` resamples to whatever rate its context runs at, which is
 * normally 48 kHz, so an 8 kHz recording came back claiming 48 kHz and the
 * frequency axis ran to 24 kHz with nothing above 4 kHz in it. Decoding on an
 * OfflineAudioContext pinned to the file's own rate skips the resampler, so
 * `buffer.sampleRate` is the real one and the axis follows.
 *
 * The fallback matters: not every browser accepts an arbitrary offline rate or
 * implements decodeAudioData on an offline context, and a resampled picture is
 * much better than no picture. The caller labels that case honestly.
 */
async function decodeAudio(bytes: Uint8Array, rate: number | null): Promise<AudioBuffer> {
  // decodeAudioData detaches the buffer it is handed, so every attempt gets a
  // fresh copy and the sniffed bytes stay readable for the error path.
  if (rate !== null && rate >= MIN_DECODE_RATE && rate <= MAX_DECODE_RATE) {
    try {
      const offline = new OfflineAudioContext({
        numberOfChannels: 1,
        length: 1,
        sampleRate: rate,
      });
      return await offline.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    } catch {
      // Fall through to the shared context below.
    }
  }
  const ac = ensureAudioContext();
  return await ac.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
}

async function readFile(file: File) {
  analysisToken += 1;
  const token = analysisToken;
  resetAudio();
  error.value = null;
  fileName.value = file.name;
  fileSize.value = file.size;
  isVideo.value = fileIsVideo(file);

  if (isVideo.value) {
    if (!isMediaSupported()) {
      stage.value = "idle";
      error.value = {
        message: "This browser cannot extract audio from a video file.",
        fix: "Reading a video track needs WebAssembly. Use a current version of Chrome, Edge, Firefox, or Safari, or convert the video to an audio file first.",
      };
      return;
    }
    // The engine is already in memory, or the connection is not metered: start
    // now. On a metered connection the video waits for a tap instead, so a page
    // visit never quietly pulls the ~31 MB engine over mobile data.
    if (isEngineReady() || shouldAutoDownload()) {
      await processVideo(file, token);
    } else {
      pendingVideo.value = file;
      stage.value = "engine-prompt";
    }
    return;
  }

  stage.value = "decoding";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    error.value = toToolError(e);
    return;
  }
  if (token !== analysisToken) return;
  await decodeAndAnalyze(bytes, token);
}

/**
 * Decode a block of audio bytes and drive the FFT. The bytes are either the
 * file itself, or the WAV that ffmpeg extracted from a video: from here down
 * the two inputs are identical, so the whole DSP path is shared.
 */
async function decodeAndAnalyze(bytes: Uint8Array, token: number) {
  stage.value = "decoding";
  try {
    logic.value ??= await loadLogic();
    if (token !== analysisToken) return;
    // The container header is the only honest source of the original rate.
    const sniffed = logic.value.sniffSampleRate(bytes);
    sourceRate.value = sniffed;
    const buffer = await decodeAudio(bytes, sniffed);
    if (token !== analysisToken) return;
    audioBuffer.value = buffer;
    sampleRate.value = buffer.sampleRate;
    fullDuration.value = buffer.duration;
    // A long video is extracted only up to the analysis cap, so the decoded
    // buffer is shorter than the film. Report the real length so the truncation
    // note is honest rather than pretending the movie is ten minutes long.
    if (videoDuration.value !== null && videoDuration.value > fullDuration.value) {
      fullDuration.value = videoDuration.value;
    }
    channelCount.value = buffer.numberOfChannels;
    const cap = Math.floor(MAX_ANALYSIS_SECONDS * buffer.sampleRate);
    const samples = toMono(buffer, cap);
    mono.value = samples;
    analyzedDuration.value = samples.length / buffer.sampleRate;
    await analyze();
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    // The module is loaded by the line above unless the import itself failed,
    // which is not a decode problem and gets the generic message.
    const format = logic.value?.sniffAudioFormat(bytes) ?? "";
    if (e instanceof ToolError) {
      error.value = toToolError(e);
    } else {
      error.value = {
        message: format
          ? `This browser could not decode this ${format} file as audio.`
          : "This browser could not decode this file as audio, and its first bytes do not match any audio container this tool recognizes.",
        fix: format
          ? "The container is recognized but the codec inside it is not supported here. Convert it to WAV or MP3 and try again."
          : "Try a WAV, MP3, FLAC, OGG, or M4A file, or a video with an audio track.",
      };
    }
  }
}

/**
 * Extract a video's audio track to WAV with ffmpeg, then hand the bytes to the
 * shared decode path. The engine downloads on first use, which is why this only
 * runs once a video is actually here. Extraction is capped to the analysis
 * window so a two hour film never expands into a gigabyte of PCM.
 */
async function processVideo(file: File, token: number) {
  stage.value = isEngineReady() ? "extracting" : "loading-engine";
  downloadBytes.value = 0;
  downloadTotal.value = 0;
  extractRatio.value = null;

  let data: Uint8Array;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    error.value = toToolError(e);
    return;
  }
  if (token !== analysisToken) return;

  const inputName = safeName(file);
  const outputName = "spectrogram-audio.wav";

  try {
    const produced = await runJob({
      inputs: [{ name: inputName, data }],
      // -vn drops the video, -t caps the length, pcm_s16le keeps a WAV whose
      // RIFF header states the true sample rate so the decode path reads it.
      args: [
        "-i",
        inputName,
        "-vn",
        "-t",
        String(EXTRACT_SECONDS),
        "-c:a",
        "pcm_s16le",
        outputName,
      ],
      outputs: [outputName],
      onDownload: (loaded, total) => {
        if (token !== analysisToken) return;
        downloadBytes.value = loaded;
        downloadTotal.value = total;
        if (total > 0 && loaded < total) stage.value = "loading-engine";
      },
      onProgress: (p) => {
        if (token !== analysisToken) return;
        // Any progress tick means the download is done and ffmpeg is running.
        stage.value = "extracting";
        extractRatio.value = p.ratio;
        if (p.logLine && videoDuration.value === null) {
          const parsed = parseFfmpegDuration(p.logLine);
          if (parsed !== null) videoDuration.value = parsed;
        }
      },
    });
    if (token !== analysisToken) return;
    const wav = produced[0]?.data;
    if (!wav || wav.byteLength === 0) {
      stage.value = "idle";
      error.value = {
        message: "No audio track was found in this video.",
        fix: "This file carries video but no sound to analyze. Try a different file.",
      };
      return;
    }
    await decodeAndAnalyze(wav, token);
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    const base = toToolError(e);
    error.value = {
      message: base.message || "The audio could not be extracted from this video.",
      fix:
        base.fix ??
        "The video may have no audio track, or its audio codec is not supported here. Try another file.",
    };
  }
}

/** Start a video that was held back on a metered connection. */
async function startPendingVideo() {
  const file = pendingVideo.value;
  if (!file) return;
  pendingVideo.value = null;
  await processVideo(file, analysisToken);
}

async function analyze() {
  const samples = mono.value;
  const mod = logic.value;
  if (!samples || !mod) return;
  const token = ++analysisToken;
  stage.value = "analyzing";
  progress.value = 0;
  columns.value = [];

  const size = Number(fftSize.value);
  const options = { fftSize: size as 1024 | 2048 | 4096, hop: size / 4, maxColumns: MAX_COLUMNS };

  try {
    const plan = mod.planSpectrogram(samples.length, options);
    // Chunk by frames, not columns: on a long file one column can fold in
    // dozens of frames, and a fixed column chunk would stall the main thread.
    const chunk = Math.max(1, Math.floor(256 / plan.group));
    const out: Float32Array[] = [];
    for (let c = 0; c < plan.columnCount; c += chunk) {
      if (token !== analysisToken) return;
      const slice = mod.computeSpectrogramColumns(samples, options, c, chunk);
      for (const column of slice) out.push(column);
      progress.value = Math.min(99, Math.round(((c + chunk) / plan.columnCount) * 100));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token !== analysisToken) return;
    columns.value = out;
    freqBins.value = plan.freqBins;
    progress.value = 100;
    stage.value = "ready";
    rebuildPeaks();
    renderSpecImage();
    draw();
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    error.value = toToolError(e);
  }
}

function rebuildPeaks() {
  const samples = mono.value;
  const mod = logic.value;
  if (!samples || !mod) return;
  peaks.value = mod.computeWaveformPeaks(samples, plotWidth.value);
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

function clearFile() {
  analysisToken += 1;
  resetAudio();
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  draw();
}

/* ---------------------------------------------------------------- */
/* frequency mapping                                                 */
/* ---------------------------------------------------------------- */

const nyquist = computed(() => sampleRate.value / 2);

/**
 * The axis every frequency is mapped through, built by the logic layer so the
 * log floor rule lives with the maths that uses it. Null until the module has
 * loaded, which is also before there is anything to plot.
 */
const axis = computed<FreqAxis | null>(() => {
  const mod = logic.value;
  return mod ? mod.freqAxis(sampleRate.value, axisScale.value as FreqScale) : null;
});

/* ---------------------------------------------------------------- */
/* spectrogram image                                                 */
/* ---------------------------------------------------------------- */

let specImage: HTMLCanvasElement | null = null;

/**
 * Paint the columns into an offscreen bitmap once, so hover, playback, and
 * axis redraws are a single drawImage rather than a million pixel writes.
 *
 * The pooling and the frequency remap are the logic layer's; this function
 * only owns the canvas the pixels land in.
 */
function renderSpecImage() {
  const mod = logic.value;
  const plot = axis.value;
  const cols = columns.value;
  if (!mod || !plot || cols.length === 0) {
    specImage = null;
    return;
  }
  const scale = renderScale.value;
  const w = Math.max(1, Math.round(plotWidth.value * scale));
  const h = Math.max(1, Math.round(SPEC_H * scale));

  specImage ??= document.createElement("canvas");
  specImage.width = w;
  specImage.height = h;
  const ctx = specImage.getContext("2d");
  if (!ctx) return;

  const image = ctx.createImageData(w, h);
  mod.paintSpectrogram(
    {
      columns: cols,
      freqBins: freqBins.value,
      width: w,
      height: h,
      axis: plot,
      lut: mod.buildColorLut(colors.value as ColorScheme),
    },
    image.data,
  );
  ctx.putImageData(image, 0, 0);
}

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

interface Theme {
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  well: string;
}

function readTheme(el: HTMLElement): Theme {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    surface: pick("--card", "#ffffff"),
    text: pick("--foreground", "#1b1917"),
    muted: pick("--muted-foreground", "#79726b"),
    border: pick("--border", "#e7e2da"),
    accent: pick("--primary", "#5b4bd6"),
    well: pick("--secondary", "#f0ede8"),
  };
}

/**
 * Paint the whole figure: legend, waveform strip, spectrogram, both axes, and
 * optionally the crosshair and playhead. The export path calls this with the
 * overlays turned off, so the PNG is the picture without the cursor in it.
 */
function drawAll(ctx: CanvasRenderingContext2D, theme: Theme, overlays: boolean) {
  const width = cssWidth.value;
  const height = canvasHeight.value;
  const plotW = plotWidth.value;
  const top = specTop.value;
  const duration = analyzedDuration.value;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "middle";
  ctx.font = '11px "Geist Mono", ui-monospace, "Cascadia Code", "Source Code Pro", monospace';

  const mod = logic.value;
  const plot = axis.value;

  // Designed empty state: axes for a file that is not loaded would be a lie.
  if (!hasAudio.value) {
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, TOP_H, plotW, height - TOP_H - AXIS_H);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "center";
    ctx.font = '13px "Geist", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(
      "Drop an audio or video file to see its waveform and spectrogram",
      GUTTER_LEFT + plotW / 2,
      TOP_H + (height - TOP_H - AXIS_H) / 2,
    );
    return;
  }

  // Decibel legend, right aligned above the plot.
  if (mod) {
    const rampW = 96;
    const rampX = GUTTER_LEFT + plotW - rampW;
    const rampY = 6;
    const rampH = 9;
    for (let i = 0; i < rampW; i++) {
      const [r, g, b] = mod.dbToColor(
        mod.DB_FLOOR + (-mod.DB_FLOOR * i) / (rampW - 1),
        colors.value as "viridis" | "magma" | "gray",
      );
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(rampX + i, rampY, 1, rampH);
    }
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "right";
    ctx.fillText(`${mod.DB_FLOOR} dB`, rampX - 6, rampY + rampH / 2);
    ctx.textAlign = "left";
    ctx.fillText("0 dB", GUTTER_LEFT + plotW + 2, rampY + rampH / 2);
  }

  // Waveform strip.
  const wave = peaks.value;
  if (showWaveform.value) {
    const waveTop = TOP_H;
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, waveTop, plotW, WAVE_H);
    const mid = waveTop + WAVE_H / 2;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT, mid + 0.5);
    ctx.lineTo(GUTTER_LEFT + plotW, mid + 0.5);
    ctx.stroke();
    if (wave) {
      ctx.fillStyle = theme.accent;
      const half = WAVE_H / 2 - 2;
      for (let x = 0; x < plotW && x < wave.min.length; x++) {
        const hi = mid - clamp(wave.max[x]!, -1, 1) * half;
        const lo = mid - clamp(wave.min[x]!, -1, 1) * half;
        ctx.fillRect(GUTTER_LEFT + x, hi, 1, Math.max(1, lo - hi));
      }
    }
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "right";
    ctx.fillText("Wave", GUTTER_LEFT - 8, mid);
  }

  // Spectrogram bitmap.
  if (specImage) {
    ctx.drawImage(specImage, GUTTER_LEFT, top, plotW, SPEC_H);
  } else {
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, top, plotW, SPEC_H);
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(GUTTER_LEFT + 0.5, top + 0.5, plotW - 1, SPEC_H - 1);

  // Frequency axis on the left.
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.border;
  ctx.textAlign = "right";
  if (mod && plot) {
    for (const hz of mod.freqTicks(plot, SPEC_H)) {
      const y = top + mod.fractionAtFreq(plot, hz) * SPEC_H;
      ctx.beginPath();
      ctx.moveTo(GUTTER_LEFT - 4, Math.round(y) + 0.5);
      ctx.lineTo(GUTTER_LEFT, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(mod.freqToLabel(hz), GUTTER_LEFT - 8, clamp(y, top + 6, top + SPEC_H - 6));
    }
  }

  // Time axis underneath.
  if (duration > 0 && mod) {
    const ticks = mod.timeTicks(duration, Math.max(3, Math.floor(plotW / 84)));
    ctx.textAlign = "center";
    for (const t of ticks.times) {
      const x = GUTTER_LEFT + (t / duration) * plotW;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top + SPEC_H);
      ctx.lineTo(Math.round(x) + 0.5, top + SPEC_H + 4);
      ctx.stroke();
      ctx.fillText(
        mod.secondsToLabel(t, ticks.decimals),
        clamp(x, GUTTER_LEFT + 16, GUTTER_LEFT + plotW - 16),
        top + SPEC_H + 14,
      );
    }
  }

  if (!overlays) return;

  // Playhead across both strips.
  if (playhead.value !== null && duration > 0) {
    const x = GUTTER_LEFT + clamp(playhead.value / duration, 0, 1) * plotW;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, TOP_H);
    ctx.lineTo(x, top + SPEC_H);
    ctx.stroke();
  }

  // Crosshair on the spectrogram.
  const point = hover.value;
  if (point) {
    ctx.save();
    ctx.strokeStyle = theme.text;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT, Math.round(point.y) + 0.5);
    ctx.lineTo(GUTTER_LEFT + plotW, Math.round(point.y) + 0.5);
    ctx.moveTo(Math.round(point.x) + 0.5, top);
    ctx.lineTo(Math.round(point.x) + 0.5, top + SPEC_H);
    ctx.stroke();
    ctx.restore();
  }
}

function draw() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const scale = renderScale.value;
  const width = cssWidth.value;
  const height = canvasHeight.value;
  const backingW = Math.round(width * scale);
  const backingH = Math.round(height * scale);
  // Assigning width or height resets the whole canvas, so only do it when the
  // size really changed: hover redraws happen on every pointer move.
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawAll(ctx, readTheme(canvas), true);
}

function exportPng() {
  const canvas = canvasEl.value;
  if (!canvas || !ready.value) return;
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(renderScale.value, 0, 0, renderScale.value, 0, 0);
  drawAll(ctx, readTheme(canvas), false);
  out.toBlob((blob) => {
    if (!blob) {
      error.value = {
        message: "This browser could not encode the spectrogram as a PNG.",
        fix: "Take a screenshot of the panel instead, or try another browser.",
      };
      return;
    }
    downloadBlob(blob, `${baseName(fileName.value)}-spectrogram.png`);
  }, "image/png");
}

/* ---------------------------------------------------------------- */
/* pointer                                                           */
/* ---------------------------------------------------------------- */

interface PlotPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

/**
 * Convert a pointer event into canvas coordinates, or null when it landed
 * outside the spectrogram itself. The canvas is laid out at 100 percent width,
 * which is not always its logical width, so the ratio is applied explicitly.
 */
function pointerAt(e: PointerEvent | MouseEvent): PlotPoint | null {
  const canvas = canvasEl.value;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const x = (px * cssWidth.value) / rect.width;
  const y = (py * canvasHeight.value) / rect.height;
  const top = specTop.value;
  if (x < GUTTER_LEFT || x > GUTTER_LEFT + plotWidth.value) return null;
  if (y < top || y > top + SPEC_H) return null;
  return { x, y, px, py };
}

function onPointerMove(e: PointerEvent) {
  if (!ready.value) return;
  const point = pointerAt(e);
  if (!point) {
    if (hover.value) {
      hover.value = null;
      draw();
    }
    return;
  }
  const mod = logic.value;
  const plot = axis.value;
  if (!mod || !plot) return;
  const cols = columns.value;
  const fraction = (point.x - GUTTER_LEFT) / plotWidth.value;
  const time = fraction * analyzedDuration.value;
  const freq = mod.freqAtFraction(plot, (point.y - specTop.value) / SPEC_H);
  const columnIndex = mod.columnIndexAt(fraction, cols.length);
  const bin = mod.binIndexAt(plot, freq, freqBins.value);
  hover.value = {
    x: point.x,
    y: point.y,
    px: point.px,
    py: point.py,
    time,
    freq,
    db: cols[columnIndex]![bin]!,
  };
  draw();
}

function onPointerLeave() {
  if (!hover.value) return;
  hover.value = null;
  draw();
}

function onCanvasClick(e: MouseEvent) {
  if (!ready.value) return;
  if (playing.value) {
    stopPlayback();
    return;
  }
  const point = pointerAt(e);
  if (!point) return;
  const time = ((point.x - GUTTER_LEFT) / plotWidth.value) * analyzedDuration.value;
  playFrom(time);
}

/* ---------------------------------------------------------------- */
/* lifecycle and reactions                                           */
/* ---------------------------------------------------------------- */

let observer: ResizeObserver | null = null;
let themeWatcher: MutationObserver | null = null;

onMounted(() => {
  renderScale.value = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const el = wrapper.value;
  if (el) {
    cssWidth.value = Math.max(260, Math.round(el.clientWidth));
    observer = new ResizeObserver((entries) => {
      const next = Math.max(260, Math.round(entries[0]?.contentRect.width ?? cssWidth.value));
      if (next === cssWidth.value) return;
      cssWidth.value = next;
    });
    observer.observe(el);
  }
  // Axis text, gutters, and the surface behind the plot are painted from the
  // theme tokens, which are resolved at draw time. Flipping the header toggle
  // changes a class on <html> and nothing else, so the canvas has to be told.
  themeWatcher = new MutationObserver(() => draw());
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  draw();
});

onUnmounted(() => {
  analysisToken += 1;
  stopPlayback();
  observer?.disconnect();
  observer = null;
  themeWatcher?.disconnect();
  themeWatcher = null;
  specImage = null;
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {
      // Closing a context the browser already tore down is not an error worth showing.
    });
  }
  audioCtx = null;
});

/** Width changes need new waveform buckets and a fresh bitmap, not new FFTs. */
watch(cssWidth, () => {
  if (!hasAudio.value) {
    draw();
    return;
  }
  rebuildPeaks();
  renderSpecImage();
  draw();
});

/** Colors and axis only change the mapping from decibels and bins to pixels. */
watch([colors, axisScale], () => {
  if (!ready.value) return;
  renderSpecImage();
  draw();
});

watch(showWaveform, () => {
  hover.value = null;
  draw();
});

/** A new FFT size is a real re-analysis, so the whole chunked loop runs again. */
watch(fftSize, () => {
  if (!hasAudio.value) return;
  stopPlayback();
  analyze();
});

/** The rate part of the file info line. The logic layer words all three cases. */
const rateSummary = computed(() => {
  const mod = logic.value;
  return mod ? mod.describeSampleRate(sourceRate.value, sampleRate.value) : "";
});

const summary = computed(() => {
  if (!hasAudio.value) return "";
  const channels = channelCount.value === 1 ? "mono" : `${channelCount.value} channels`;
  const mod = logic.value;
  const length = mod ? mod.secondsToLabel(fullDuration.value) : "";
  return `${length}, ${rateSummary.value}, ${channels}`;
});

/* ---------------------------------------------------------------- */
/* progress and prompt display                                       */
/* ---------------------------------------------------------------- */

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const busy = computed(
  () =>
    stage.value === "loading-engine" ||
    stage.value === "extracting" ||
    stage.value === "decoding" ||
    stage.value === "analyzing",
);

const downloadPercent = computed(() =>
  downloadTotal.value > 0 ? Math.min(100, (downloadBytes.value / downloadTotal.value) * 100) : 0,
);

const stageLabel = computed(() => {
  switch (stage.value) {
    case "loading-engine":
      return downloadTotal.value > 0
        ? `Downloading the audio extractor (${mb(downloadBytes.value)} of ${mb(downloadTotal.value)} MB)…`
        : "Downloading the audio extractor…";
    case "extracting":
      return "Extracting the audio track from the video…";
    case "decoding":
      return "Decoding audio…";
    case "analyzing":
      return "Running the FFT…";
    default:
      return "";
  }
});

const stagePercentText = computed(() => {
  if (stage.value === "analyzing") return `${progress.value}%`;
  if (stage.value === "loading-engine" && downloadTotal.value > 0) {
    return `${Math.round(downloadPercent.value)}%`;
  }
  if (stage.value === "extracting" && extractRatio.value !== null) {
    return `${Math.round(extractRatio.value * 100)}%`;
  }
  return "";
});

/** The known progress percentage for aria, or undefined for indeterminate stages. */
const stageValueNow = computed<number | undefined>(() => {
  if (stage.value === "analyzing") return progress.value;
  if (stage.value === "loading-engine") {
    return downloadTotal.value > 0 ? Math.round(downloadPercent.value) : undefined;
  }
  if (stage.value === "extracting") {
    return extractRatio.value !== null ? Math.round(extractRatio.value * 100) : undefined;
  }
  return undefined;
});

/** Size plus the decoded summary, shown beside the loaded file name. */
const loadedFileHint = computed(() =>
  summary.value ? `${formatBytes(fileSize.value)}, ${summary.value}` : formatBytes(fileSize.value),
);

/** True when this connection looks metered, for the one tap prompt copy. */
const connectionMetered = computed(() => isMetered());

const hoverChipStyle = computed(() => {
  const point = hover.value;
  if (!point) return {};
  const flip = point.x > GUTTER_LEFT + plotWidth.value - 190;
  return {
    left: `${flip ? point.px - 12 : point.px + 12}px`,
    top: `${point.py + 12}px`,
    transform: flip ? "translateX(-100%)" : "none",
  };
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Audio or video
      </span>
      <FileDrop
        v-if="fileName"
        compact
        accept="audio/*,video/*,.mkv,.ts,.m2ts,.avi,.flv,.wmv"
        :label="fileName"
        :hint="loadedFileHint"
        @files="onFiles"
      >
        <template #actions>
          <Button variant="ghost" size="icon-sm" aria-label="Remove audio file" @click="clearFile">
            <X class="size-3.5" />
          </Button>
        </template>
      </FileDrop>
      <FileDrop
        v-else
        accept="audio/*,video/*,.mkv,.ts,.m2ts,.avi,.flv,.wmv"
        label="Drop an audio or video file here or click to choose"
        hint="See its waveform and its frequency spectrogram. WAV, MP3, FLAC, OGG, and M4A all work, and a video's audio track is extracted locally first. Everything runs in this tab: your files and inputs never leave your device."
        @files="onFiles"
      />
    </div>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- Metered engine prompt -->
    <div
      v-if="stage === 'engine-prompt'"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Audio extractor
      </span>
      <p class="text-sm text-muted-foreground">
        Reading a video's audio needs a one time download of about 31 MB, an ffmpeg engine that runs
        inside this tab. {{ connectionMetered ? "Your connection looks metered, so it" : "It" }}
        will not start until you ask. Your browser keeps the engine afterwards, so later videos
        start straight from the cache. Your files and inputs never leave your device.
      </p>
      <Button class="self-start" size="sm" @click="startPendingVideo">
        Extract audio (about 31 MB)
      </Button>
    </div>

    <!-- Options -->
    <div
      v-if="hasAudio"
      class="flex flex-wrap items-end gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex w-40 flex-col gap-1.5">
        <Label for="spec-fft" class="text-xs text-muted-foreground">FFT size</Label>
        <SearchableSelect
          id="spec-fft"
          :spec="fftSpec"
          :model-value="fftSize"
          @update:model-value="(v) => (fftSize = String(v))"
        />
      </div>

      <div class="flex w-32 flex-col gap-1.5">
        <Label for="spec-colors" class="text-xs text-muted-foreground">Colors</Label>
        <SearchableSelect
          id="spec-colors"
          :spec="colorSpec"
          :model-value="colors"
          @update:model-value="(v) => (colors = String(v))"
        />
      </div>

      <div class="flex w-36 flex-col gap-1.5">
        <Label for="spec-scale" class="text-xs text-muted-foreground">Frequency axis</Label>
        <SearchableSelect
          id="spec-scale"
          :spec="axisSpec"
          :model-value="axisScale"
          @update:model-value="(v) => (axisScale = String(v))"
        />
      </div>

      <div class="flex items-center gap-2 pb-2">
        <Switch
          id="spec-wave"
          :model-value="showWaveform"
          @update:model-value="(v) => (showWaveform = Boolean(v))"
        />
        <Label for="spec-wave" class="text-xs text-muted-foreground">Show waveform</Label>
      </div>

      <div class="ml-auto flex items-center gap-2 pb-1">
        <Button variant="outline" size="sm" :disabled="!ready" @click="exportPng">
          Download PNG
        </Button>
        <Button v-if="playing" size="sm" @click="stopPlayback"> Stop </Button>
      </div>
    </div>

    <!-- Progress -->
    <div
      v-if="busy"
      class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <ProgressBar
        :value="stageValueNow"
        :label="stageLabel"
        :detail="stagePercentText"
        size="sm"
        track="card"
      />
    </div>

    <!-- Plot -->
    <div ref="wrapper" class="relative w-full">
      <canvas
        ref="canvasEl"
        class="w-full rounded-[10px] shadow-[var(--sh-inset)]"
        :class="ready ? 'cursor-crosshair' : ''"
        @pointermove="onPointerMove"
        @pointerleave="onPointerLeave"
        @click="onCanvasClick"
      />
      <div
        v-if="hover && logic"
        class="pointer-events-none absolute z-10 rounded-[8px] border bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap text-popover-foreground shadow-[var(--sh-md)] tabular-nums"
        :style="hoverChipStyle"
      >
        {{ logic.secondsToLabel(hover.time, 2) }} &middot;
        {{ logic.freqToLabel(hover.freq) }} &middot; {{ hover.db.toFixed(1) }} dB
      </div>
    </div>

    <!-- Notes -->
    <div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p v-if="!hasAudio">
        Time runs left to right, frequency runs bottom to top, and color is level in decibels
        against full scale.
      </p>
      <p v-if="ready">
        Hover the spectrogram for the exact time, frequency, and level under the pointer. Click to
        play from that moment, and click again to stop.
      </p>
      <p v-if="truncated && logic">
        This {{ isVideo ? "video" : "file" }} is {{ logic.secondsToLabel(fullDuration) }} long. Only
        the first {{ logic.secondsToLabel(analyzedDuration) }} are
        {{ isVideo ? "extracted, analyzed, and drawn" : "analyzed and drawn" }}, because a longer
        analysis would not fit in browser memory on most machines.
      </p>
      <p v-if="ready">
        {{ columns.length }} columns across {{ logic?.secondsToLabel(analyzedDuration) }}, with
        {{ freqBins }} frequency bins up to {{ logic?.freqToLabel(nyquist) }}. Levels are floored at
        -100 dB.
      </p>
    </div>
  </div>
</template>
