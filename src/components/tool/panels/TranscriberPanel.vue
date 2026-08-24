<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Check, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { shouldAutoDownload, isMetered, onConnectionChange } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { downloadText } from "@/lib/download";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for Transcriber.
 *
 * The generic ToolShell cannot render this tool. Whisper needs a model
 * download (automatic on an unmetered connection, one-tap on a metered one), a
 * 16 kHz mono decode of the dropped file, live partial text while it works, and
 * four different export formats. What
 * the shell would show is a single text box, which is the wrong shape for all
 * four of those. The formatters still live in the pure logic layer; this file
 * only decodes audio, drives the pipeline, and paints the result.
 *
 * How the model is wired, all verified against the installed
 * @huggingface/transformers 4.2.0 rather than from memory:
 *
 *  - `env.allowRemoteModels = false` plus `env.localModelPath = '/models/'`
 *    makes every weight resolve to this origin. `scripts/prepare-models.mjs`
 *    stages `whisper-tiny` and `whisper-base` in the transformers.js repo
 *    layout, and the worker stitches the chunked decoder back together, so the
 *    browser sees one ordinary file at one ordinary URL.
 *  - `dtype: 'q8'` is the default for the wasm device, and its file suffix is
 *    `_quantized`, which is exactly what is staged
 *    (`onnx/encoder_model_quantized.onnx`,
 *    `onnx/decoder_model_merged_quantized.onnx`). It is passed explicitly so a
 *    future default change cannot silently ask for a file that is not there.
 *  - `wasmPaths` is the directory prefix `/models/ort/`. transformers imports
 *    `onnxruntime-web/webgpu`, which resolves to the bundled build with the
 *    loader inlined, so the only file fetched from that prefix is
 *    `ort-wasm-simd-threaded.asyncify.wasm`, and that is the one staged.
 *  - onnxruntime-web is held at 1.27.0 by a `overrides` entry in package.json
 *    rather than the 1.26.0-dev build transformers 4.2.0 asks for. From 1.25
 *    onward the graph optimizer rewrote quantized MatMul into MatMulNBits, and
 *    on Whisper it walked into its own tied decoder embedding twice: the first
 *    rewrite consumed the shared scale initializer and the second died on
 *    "Missing required scale", so no q8 Whisper decoder could open a session at
 *    all. onnxruntime PR 28326 (in 1.27.0) declines the rewrite when the weight
 *    or scale is shared. The staged model files were never the problem, and the
 *    engine binaries under /models/ort/ are copied from whatever version is
 *    installed, so the two can never drift apart.
 *  - This site sends no COOP or COEP headers, so `crossOriginIsolated` is
 *    false, and onnxruntime sets `numThreads` to 1 by itself in that case.
 *    Forcing it here would be a no op, so it is left alone.
 *  - A cold load asks for each weight file two or three times. That is inside
 *    transformers.js, not here: `pipeline()` is called once, and stack traces
 *    taken at `fetch` show only the first request coming from this panel while
 *    the rest start within about 60ms from separate paths in the library, too
 *    close together for any of them to see another's cache write. The repeats
 *    come back from the browser HTTP cache with `transferSize` 0, so a visitor
 *    downloads the model once. Left alone deliberately: the only fix here would
 *    be patching global fetch, which is a lot of blast radius for no bytes.
 *  - Model download progress comes from `progress_callback`. Version 4 reports
 *    an aggregated `progress_total` across every file, with a per file
 *    `progress` fallback for older shapes.
 *  - There is no `chunk_callback` in this version. Live text during a run comes
 *    from a `WhisperTextStreamer` passed as the `streamer` generation option,
 *    which `_call_whisper` forwards into `model.generate`.
 *
 * Nothing runs at import time and nothing touches audio or WebAssembly until a
 * visitor asks for it, so the component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

type TranscriberLogic = typeof import("@/tools/audio-transcriber/index");
type Transformers = typeof import("@huggingface/transformers");

/** The pipeline surface this panel actually touches. */
interface AsrPipeline {
  (
    audio: Float32Array,
    options: Record<string, unknown>,
  ): Promise<{ text?: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
  tokenizer: unknown;
  processor?: { feature_extractor?: { config?: { chunk_length?: number } } };
  model?: { config?: { max_source_positions?: number } };
  dispose?: () => Promise<void>;
}

/** The progress shapes `progress_callback` emits that this panel cares about. */
interface ModelProgress {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Whisper is trained on 16 kHz mono, so everything is resampled to it. */
const TARGET_RATE = 16000;
/** One inference window. Whisper's receptive field is exactly 30 seconds. */
const CHUNK_SECONDS = 30;
/** Overlap between windows, so a word on a seam is not cut in half. */
const STRIDE_SECONDS = 5;
/** Past this length the panel warns before the visitor commits an afternoon. */
const LONG_FILE_SECONDS = 30 * 60;

const MODELS = [
  { id: "whisper-tiny", label: "Tiny, 43 MB, fastest", size: "about 43 MB" },
  { id: "whisper-base", label: "Base, 78 MB, more accurate", size: "about 78 MB" },
];

const LANGUAGES = [
  { value: "auto", label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "ru", label: "Russian" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
];

const MIME_FOR_FORMAT: Record<string, string> = {
  text: "text/plain",
  srt: "text/plain",
  vtt: "text/vtt",
  json: "application/json",
};

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<TranscriberLogic | null>(null);
let logicPromise: Promise<TranscriberLogic> | null = null;
function loadLogic(): Promise<TranscriberLogic> {
  logicPromise ??= import("@/tools/audio-transcriber/index");
  return logicPromise;
}

/** Module handles live outside the reactive system: they are large and opaque. */
let transformers: Transformers | null = null;
let asr: AsrPipeline | null = null;
let loadedModel = "";
let envConfigured = false;

const model = ref("whisper-tiny");
const format = ref("text");
const language = ref("auto");
const timestamps = ref(true);

/* ---------------------------------------------------------------- */
/* select specs                                                     */
/* ---------------------------------------------------------------- */

const MODEL_SYNONYMS: Record<string, string[]> = {
  "whisper-tiny": ["tiny", "fast", "fastest", "small", "43 mb"],
  "whisper-base": ["base", "accurate", "more accurate", "78 mb"],
};

const modelSpec: SelectOptionSpec = {
  kind: "select",
  id: "asr-model",
  label: "Model",
  default: "whisper-tiny",
  options: MODELS.map((m) => ({
    value: m.id,
    label: m.label,
    synonyms: MODEL_SYNONYMS[m.id] ?? [],
  })),
};

/** Native names plus ISO codes, so a search in the user's own language lands. */
const LANGUAGE_SYNONYMS: Record<string, string[]> = {
  auto: ["automatic", "detect", "any language"],
  en: ["en"],
  es: ["español", "es"],
  fr: ["français", "fr"],
  de: ["deutsch", "de"],
  it: ["italiano", "it"],
  pt: ["português", "pt"],
  nl: ["nederlands", "nl"],
  ja: ["日本語", "ja", "nihongo"],
  ko: ["한국어", "ko", "hangugeo"],
  zh: ["中文", "zh", "mandarin"],
  ru: ["русский", "ru"],
  pl: ["polski", "pl"],
  tr: ["türkçe", "tr"],
  ar: ["العربية", "ar"],
  hi: ["हिन्दी", "hi"],
};

const languageSpec: SelectOptionSpec = {
  kind: "select",
  id: "asr-language",
  label: "Language",
  default: "auto",
  options: LANGUAGES.map((l) => ({
    value: l.value,
    label: l.label,
    synonyms: LANGUAGE_SYNONYMS[l.value] ?? [],
  })),
};

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "asr-format",
  label: "Output format",
  default: "text",
  options: [
    { value: "text", label: "Plain text", synonyms: ["txt", "plain"] },
    { value: "srt", label: "SRT subtitles", synonyms: ["subrip", "subtitles"] },
    { value: "vtt", label: "WebVTT subtitles", synonyms: ["webvtt", "captions"] },
    { value: "json", label: "JSON with timings", synonyms: ["timestamps", "structured"] },
  ],
};

type EngineStage = "idle" | "downloading" | "starting" | "ready";
const engineStage = ref<EngineStage>("idle");
const downloadedBytes = ref(0);
const downloadTotal = ref(0);

/** True when a metered or Save-Data connection is holding the auto-start back. */
const metered = ref(false);
/** Consumed once by the connection listener if a metered link turns unmetered. */
let pendingAutoStart = false;
let stopConnectionWatch: () => void = () => {};

const fileName = ref("");
const fileSize = ref(0);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();
const decoding = ref(false);
const audio = shallowRef<Float32Array | null>(null);
const duration = ref(0);

const running = ref(false);
const progress = ref(0);
const elapsed = ref(0);
const live = ref("");

// The running transcript stays pinned to the newest words unless the reader
// scrolls up.
const { el: liveEl, onScroll: onLiveScroll } = useStickToBottom(live);
const chunks = shallowRef<TranscriptRow[]>([]);
const copied = ref(false);

type TranscriptRow = { text: string; start: number | null; end: number | null };

const error = ref<{ message: string; fix?: string } | null>(null);

let elapsedTimer = 0;
let copiedTimer = 0;

/* ---------------------------------------------------------------- */
/* small helpers                                                     */
/* ---------------------------------------------------------------- */

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  return hours > 0
    ? `${hours}:${mm}:${String(secs).padStart(2, "0")}`
    : `${mm}:${String(secs).padStart(2, "0")}`;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "transcript";
}

const currentModel = computed(() => MODELS.find((m) => m.id === model.value) ?? MODELS[0]!);

const supported = computed(() => typeof WebAssembly !== "undefined");

const downloadPercent = computed(() =>
  downloadTotal.value > 0 ? Math.min(100, (downloadedBytes.value / downloadTotal.value) * 100) : 0,
);

const downloadLabel = computed(() => {
  if (engineStage.value === "starting") return "Starting the speech engine";
  // A model already in Cache Storage reports no byte progress at all, so the
  // neutral wording covers both a warm cache and the first moments of a cold one.
  if (downloadTotal.value === 0) return "Preparing the speech model";
  return `Downloading the speech model (${megabytes(downloadedBytes.value)} of ${megabytes(downloadTotal.value)} MB)`;
});

/** Width of the load bar. A run with no byte counts shows a stub rather than nothing. */
const engineBarWidth = computed(() => {
  if (engineStage.value === "starting") return 100;
  return downloadTotal.value > 0 ? downloadPercent.value : 8;
});

/** The size is always on the button: switching model means a fresh download. */
const engineButtonLabel = computed(() => `Load speech model (${currentModel.value.size})`);

const transcript = computed(() => {
  const mod = logic.value;
  if (!mod || chunks.value.length === 0) return "";
  return mod.formatTranscript(chunks.value, {
    format: format.value,
    timestamps: timestamps.value,
  });
});

const downloadName = computed(() => {
  const mod = logic.value;
  const ext = mod ? mod.extensionFor(format.value) : "txt";
  return `${baseName(fileName.value)}.${ext}`;
});

const canTranscribe = computed(
  () => engineStage.value === "ready" && audio.value !== null && !running.value && !decoding.value,
);

const tooLong = computed(() => duration.value > LONG_FILE_SECONDS);

/* ---------------------------------------------------------------- */
/* errors                                                            */
/* ---------------------------------------------------------------- */

function describe(e: unknown, fallback: { message: string; fix?: string }) {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (/memory|allocat|Aborted|RangeError|array buffer/i.test(text)) {
    return {
      message: "The browser ran out of memory partway through the transcription.",
      fix: "Split the recording into shorter pieces with the Audio Trimmer, close other tabs, and use the tiny model rather than base.",
    };
  }
  if (text) return { message: `${fallback.message} ${text}`, fix: fallback.fix };
  return fallback;
}

/* ---------------------------------------------------------------- */
/* the model                                                         */
/* ---------------------------------------------------------------- */

function configureEnvironment(t: Transformers) {
  if (envConfigured) return;
  const env = t.env;
  // Every weight comes from this origin. Nothing is fetched from a third party.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = "/models/";
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = "/models/ort/";
  envConfigured = true;
}

async function disposePipeline() {
  const previous = asr;
  asr = null;
  loadedModel = "";
  try {
    await previous?.dispose?.();
  } catch {
    // A session the runtime already tore down is not worth an error box.
  }
}

async function loadModel() {
  if (engineStage.value === "downloading" || engineStage.value === "starting") return;
  // A manual press means the visitor chose to start it, so drop any hold.
  pendingAutoStart = false;
  const wanted = model.value;
  error.value = null;
  engineStage.value = "downloading";
  downloadedBytes.value = 0;
  downloadTotal.value = 0;

  try {
    transformers ??= await import("@huggingface/transformers");
    const t = transformers;
    configureEnvironment(t);

    if (asr && loadedModel !== wanted) await disposePipeline();

    if (!asr) {
      const perFile = new Map<string, { loaded: number; total: number }>();
      let sawAggregate = false;

      const onProgress = (raw: unknown) => {
        const info = (raw ?? {}) as ModelProgress;
        if (info.status === "progress_total") {
          sawAggregate = true;
          downloadedBytes.value = info.loaded ?? 0;
          downloadTotal.value = info.total ?? 0;
        } else if (info.status === "progress" && !sawAggregate) {
          if (!info.file || typeof info.total !== "number") return;
          perFile.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
          let loaded = 0;
          let total = 0;
          for (const entry of perFile.values()) {
            loaded += entry.loaded;
            total += entry.total;
          }
          downloadedBytes.value = loaded;
          downloadTotal.value = total;
        }
        // The onnxruntime wasm and the session build happen after the last file
        // arrives and report nothing, so the bar would sit at 100 percent
        // looking frozen. Name that phase instead.
        if (downloadTotal.value > 0 && downloadedBytes.value >= downloadTotal.value) {
          engineStage.value = "starting";
        }
      };

      const created = await t.pipeline("automatic-speech-recognition", wanted, {
        device: "wasm",
        dtype: "q8",
        progress_callback: onProgress,
      });
      // Downloads take tens of seconds, which is long enough for someone to
      // change their mind about the model. Without this check the finished
      // pipeline would be adopted under the newly selected name, and Transcribe
      // would quietly run the model that is no longer on screen.
      if (model.value !== wanted) {
        await (created as unknown as AsrPipeline).dispose?.();
        engineStage.value = "idle";
        return;
      }
      asr = created as unknown as AsrPipeline;
      loadedModel = wanted;
    }

    engineStage.value = "ready";
  } catch (e) {
    engineStage.value = "idle";
    await disposePipeline();
    error.value = describe(e, {
      message: "The speech model could not be loaded.",
      fix: "Check your connection and press the button again. The model is a one time download of tens of megabytes, so a flaky link can interrupt it.",
    });
  }
}

/**
 * Starts the default model download without a click on first visit, unless the
 * connection is metered or Save-Data. When it is, the panel keeps a one-tap
 * start and remembers to auto-start later if the link turns unmetered.
 */
function autoStartModel() {
  if (engineStage.value !== "idle") return;
  if (shouldAutoDownload()) {
    void loadModel();
  } else {
    metered.value = true;
    pendingAutoStart = true;
  }
}

/** A different model is a different pipeline, so the loaded one is thrown away. */
watch(model, () => {
  if (running.value) return;
  engineStage.value = "idle";
  downloadedBytes.value = 0;
  downloadTotal.value = 0;
  void disposePipeline();
});

/* ---------------------------------------------------------------- */
/* audio                                                             */
/* ---------------------------------------------------------------- */

let audioCtx: AudioContext | null = null;

function ensureAudioContext(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

/** Average every channel into one track: Whisper takes a single mono stream. */
function downmix(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const length = buffer.length;
  const out = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] = out[i]! + data[i]!;
  }
  for (let i = 0; i < length; i++) out[i] = out[i]! / buffer.numberOfChannels;
  return out;
}

/** Resample through an offline graph, which is the only resampler a browser exposes. */
async function renderTo16k(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));
  const offline = new OfflineAudioContext({
    numberOfChannels: 1,
    length,
    sampleRate: TARGET_RATE,
  });
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Decode a file to 16 kHz mono samples.
 *
 * The fast path decodes straight into a 16 kHz context, which skips ever
 * holding a 48 kHz copy of a long recording: an hour of stereo at 48 kHz is
 * about 1.4 GB of floats, and the same hour at 16 kHz mono is 230 MB. Not every
 * browser accepts an arbitrary offline rate or implements decodeAudioData on an
 * offline context, so the ordinary decoder plus a resample is kept as a
 * fallback. decodeAudioData detaches the buffer it is handed, so each attempt
 * gets its own copy.
 */
async function decodeTo16kMono(bytes: Uint8Array): Promise<Float32Array> {
  try {
    const offline = new OfflineAudioContext({
      numberOfChannels: 1,
      length: 1,
      sampleRate: TARGET_RATE,
    });
    const decoded = await offline.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    return Math.round(decoded.sampleRate) === TARGET_RATE
      ? downmix(decoded)
      : await renderTo16k(decoded);
  } catch {
    // Fall through to the shared context below.
  }
  const decoded = await ensureAudioContext().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  return decoded.sampleRate === TARGET_RATE ? downmix(decoded) : await renderTo16k(decoded);
}

function resetResult() {
  chunks.value = [];
  live.value = "";
  progress.value = 0;
  elapsed.value = 0;
}

async function readFile(file: File) {
  // A run cannot be canceled, so swapping the file underneath one would leave
  // the old recording's transcript sitting under the new file's name.
  if (running.value) return;
  resetResult();
  error.value = null;
  audio.value = null;
  duration.value = 0;
  fileName.value = file.name;
  fileSize.value = file.size;
  decoding.value = true;

  try {
    logic.value ??= await loadLogic();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const samples = await decodeTo16kMono(bytes);
    audio.value = samples;
    duration.value = samples.length / TARGET_RATE;
  } catch (e) {
    audio.value = null;
    error.value = describe(e, {
      message: "This browser could not decode that file as audio.",
      fix: "Whisper reads the audio track, so a video file works as long as the browser can decode it. Try WAV, MP3, M4A, FLAC, OGG, or MP4, or convert the file with the Video Converter first.",
    });
  } finally {
    decoding.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  void readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearFile() {
  audio.value = null;
  duration.value = 0;
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  resetResult();
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* transcription                                                     */
/* ---------------------------------------------------------------- */

/**
 * How many 30 second windows the pipeline will run, mirroring the offset loop
 * inside `_call_whisper`. The streamer signals the end of each one, which is
 * the only honest progress signal the API offers.
 */
function windowCount(sampleCount: number): number {
  const windowSamples = CHUNK_SECONDS * TARGET_RATE;
  const jump = windowSamples - 2 * STRIDE_SECONDS * TARGET_RATE;
  if (sampleCount <= windowSamples) return 1;
  return Math.ceil((sampleCount - windowSamples) / jump) + 1;
}

/** Seconds per timestamp token, read off the loaded model rather than assumed. */
function timePrecision(pipe: AsrPipeline): number {
  const chunkLength = pipe.processor?.feature_extractor?.config?.chunk_length;
  const positions = pipe.model?.config?.max_source_positions;
  if (typeof chunkLength === "number" && typeof positions === "number" && positions > 0) {
    return chunkLength / positions;
  }
  return 0.02;
}

async function transcribe() {
  const samples = audio.value;
  const pipe = asr;
  const t = transformers;
  if (!samples || !pipe || !t || !canTranscribe.value) return;

  resetResult();
  error.value = null;
  running.value = true;

  const total = windowCount(samples.length);
  let finished = 0;
  const startedAt = Date.now();
  elapsedTimer = window.setInterval(() => {
    elapsed.value = (Date.now() - startedAt) / 1000;
  }, 500);

  // There is no chunk callback in transformers.js 4. The streamer is the
  // documented way to see tokens as they are produced: `_call_whisper` spreads
  // its options into `model.generate`, which calls `streamer.put` per token and
  // `streamer.end` once per window.
  const streamer = new t.WhisperTextStreamer(pipe.tokenizer as never, {
    skip_prompt: true,
    time_precision: timePrecision(pipe),
    callback_function: (text: string) => {
      live.value += text;
    },
    on_finalize: () => {
      finished += 1;
      progress.value = Math.min(99, Math.round((finished / total) * 100));
    },
  });

  try {
    const result = await pipe(samples, {
      chunk_length_s: CHUNK_SECONDS,
      stride_length_s: STRIDE_SECONDS,
      return_timestamps: true,
      task: "transcribe",
      // Omitted rather than set to null when automatic: the pipeline treats a
      // missing language as "detect it".
      ...(language.value === "auto" ? {} : { language: language.value }),
      streamer,
    });

    const mod = logic.value ?? (await loadLogic());
    logic.value = mod;
    let rows = mod.normalizeChunks(result.chunks ?? []);
    // A very short clip can come back as one block of text with no chunk list.
    if (rows.length === 0 && result.text && result.text.trim()) {
      rows = [{ text: result.text.trim(), start: 0, end: null }];
    }
    chunks.value = rows;
    progress.value = 100;
  } catch (e) {
    error.value = describe(e, {
      message: "The transcription stopped before it finished.",
      fix: "Try the tiny model, a shorter file, or reload the page and load the model again.",
    });
  } finally {
    running.value = false;
    window.clearInterval(elapsedTimer);
    elapsedTimer = 0;
  }
}

/* ---------------------------------------------------------------- */
/* output                                                            */
/* ---------------------------------------------------------------- */

async function copyTranscript() {
  if (!transcript.value) return;
  try {
    await navigator.clipboard.writeText(transcript.value);
    copied.value = true;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 1500);
  } catch (e) {
    error.value = describe(e, {
      message: "This browser refused clipboard access.",
      fix: "Select the transcript and copy it by hand, or use the download button.",
    });
  }
}

function downloadTranscript() {
  if (!transcript.value) return;
  const type = MIME_FOR_FORMAT[format.value] ?? "text/plain";
  downloadText(transcript.value, downloadName.value, type);
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  if (!supported.value) return;
  metered.value = isMetered();
  autoStartModel();
  stopConnectionWatch = onConnectionChange(() => {
    metered.value = isMetered();
    if (pendingAutoStart && shouldAutoDownload()) {
      pendingAutoStart = false;
      autoStartModel();
    }
  });
});

onUnmounted(() => {
  stopConnectionWatch();
  window.clearInterval(elapsedTimer);
  window.clearTimeout(copiedTimer);
  void disposePipeline();
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close().catch(() => {
      // Closing a context the browser already tore down is not an error worth showing.
    });
  }
  audioCtx = null;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Capability gate -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">This browser cannot run the speech model.</p>
      <p class="mt-1 text-muted-foreground">
        Transcriber runs Whisper inside this tab, which needs WebAssembly. Use a current version of
        Chrome, Edge, Firefox, or Safari.
      </p>
    </div>

    <template v-else>
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
            Audio or video
          </span>
          <Button variant="ghost" size="sm" :disabled="running" @click="fileInput?.click()">
            Open file…
          </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept="audio/*,video/*"
            @change="onPickFile"
          />
        </div>

        <div v-if="fileName" class="px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {{ formatBytes(fileSize) }}
            </span>
            <span v-if="decoding" class="shrink-0 text-muted-foreground">decoding…</span>
            <span v-else-if="duration > 0" class="shrink-0 text-muted-foreground tabular-nums">{{
              clockLabel(duration)
            }}</span>
            <button
              v-if="!running"
              type="button"
              aria-label="Remove file"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
          Drop an audio or video file here to turn its speech into text. Whisper reads the audio
          track, so a screen recording works as well as a voice memo. Everything runs in this tab:
          your files and inputs never leave your device.
        </p>
      </div>

      <!-- Speech model -->
      <div
        v-if="engineStage !== 'ready'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Speech model
        </span>

        <p class="text-sm text-muted-foreground">
          The model is downloaded once, {{ currentModel.size }} for the
          {{ model === "whisper-tiny" ? "tiny" : "base" }} version, and your browser keeps it
          afterwards, so later visits start it from the cache and work offline. It downloads
          automatically the first time, except on a metered connection.
        </p>

        <p v-if="metered && engineStage === 'idle'" class="text-xs text-muted-foreground">
          Your connection looks metered, so the model waits for you to start it.
        </p>

        <div v-if="engineStage !== 'idle'" class="flex flex-col gap-2">
          <div
            class="h-2 overflow-hidden rounded-full bg-background"
            role="progressbar"
            :aria-valuenow="Math.round(downloadPercent)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="downloadLabel"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              :style="{ width: `${engineBarWidth}%` }"
            />
          </div>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ downloadLabel }}
          </p>
        </div>

        <Button v-else class="self-start" size="sm" @click="loadModel">
          {{ engineButtonLabel }}
        </Button>
      </div>

      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check class="size-3.5 text-[var(--positive)]" />
        Speech model ready. It stays loaded for as long as this page is open.
      </p>

      <!-- Options -->
      <div
        class="flex flex-wrap items-end gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex w-52 flex-col gap-1.5">
          <Label for="asr-model" class="text-xs text-muted-foreground">Model</Label>
          <fieldset :disabled="running" class="m-0 min-w-0 border-0 p-0">
            <SearchableSelect
              id="asr-model"
              :spec="modelSpec"
              :model-value="model"
              @update:model-value="(v) => (model = String(v))"
            />
          </fieldset>
        </div>

        <div class="flex w-44 flex-col gap-1.5">
          <Label for="asr-language" class="text-xs text-muted-foreground">Language</Label>
          <fieldset :disabled="running" class="m-0 min-w-0 border-0 p-0">
            <SearchableSelect
              id="asr-language"
              :spec="languageSpec"
              :model-value="language"
              @update:model-value="(v) => (language = String(v))"
            />
          </fieldset>
        </div>

        <div class="flex w-40 flex-col gap-1.5">
          <Label for="asr-format" class="text-xs text-muted-foreground">Output format</Label>
          <SearchableSelect
            id="asr-format"
            :spec="formatSpec"
            :model-value="format"
            @update:model-value="(v) => (format = String(v))"
          />
        </div>

        <div class="flex items-center gap-2 pb-2">
          <Switch
            id="asr-timestamps"
            :model-value="timestamps"
            :disabled="format !== 'text'"
            @update:model-value="(v) => (timestamps = Boolean(v))"
          />
          <Label for="asr-timestamps" class="text-xs text-muted-foreground"
            >Timestamps in plain text</Label
          >
        </div>
      </div>

      <!-- Run controls -->
      <div class="flex flex-wrap items-center gap-3">
        <Button :disabled="!canTranscribe" @click="transcribe">
          {{ running ? "Transcribing…" : "Transcribe" }}
        </Button>
        <span v-if="running" class="font-mono text-xs text-muted-foreground tabular-nums">
          {{ progress }}% · {{ clockLabel(elapsed) }} elapsed
        </span>
        <span v-else-if="engineStage !== 'ready'" class="text-xs text-muted-foreground">
          Load the speech model first.
        </span>
        <span v-else-if="!audio" class="text-xs text-muted-foreground">
          Add a file to transcribe.
        </span>
      </div>

      <div
        v-if="running"
        class="h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="Transcription progress"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          :style="{ width: `${progress}%` }"
        />
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

      <!-- Live text while the model works -->
      <div v-if="running" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Coming through now
          </span>
        </div>
        <pre
          ref="liveEl"
          class="max-h-56 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
          @scroll.passive="onLiveScroll"
          >{{ live || "Listening to the first window…" }}</pre>
      </div>

      <!-- Output -->
      <div v-if="transcript" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-2 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Transcript
          </span>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" @click="copyTranscript">
              {{ copied ? "Copied" : "Copy" }}
            </Button>
            <Button variant="outline" size="sm" @click="downloadTranscript">
              Download {{ downloadName }}
            </Button>
          </div>
        </div>
        <pre class="max-h-[420px] overflow-auto px-3 py-2 font-mono text-sm whitespace-pre-wrap">{{
          transcript
        }}</pre>
      </div>

      <div
        v-else-if="!running && !decoding && audio && progress === 100"
        role="status"
        class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm text-muted-foreground"
      >
        The model finished without finding any speech in this file. Check that the recording has an
        audible voice track, and try picking the language explicitly.
      </div>

      <!-- Notes -->
      <div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <p v-if="tooLong">
          This file is {{ clockLabel(duration) }} long. Whisper runs one 30 second window at a time,
          so expect this to take longer than the recording itself, and expect the tab to hold the
          whole thing in memory while it works. Trimming it into shorter pieces first is usually
          faster and safer.
        </p>
        <p>
          Audio is resampled to 16 kHz mono, which is what Whisper was trained on, then read in 30
          second windows with a 5 second overlap so words on a seam survive. Timings are accurate to
          about a second.
        </p>
        <p>
          Inference runs in WebAssembly, which is roughly real time with the tiny model on a laptop
          and slower with base. The model files come from this site and the transcription happens in
          your tab: your files and inputs never leave your device.
        </p>
      </div>
    </template>
  </div>
</template>
