<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { X } from "lucide-vue-next";
import { ToolError, type SelectOption, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  bpmFromTaps,
  camelotFor,
  camelotNeighbours,
  chromagram,
  describeTempo,
  detectBpm,
  detectKey,
  keyFromCode,
  openKeyFor,
  parallelKey,
  relativeKey,
  scaleNotes,
  type BpmKeyResult,
  type BpmResult,
  type ChromagramOptions,
  type KeyMode,
  type KeyResult,
  type Notation,
  type TapTempoResult,
} from "@/tools/bpm-key-detector/index";
import { formatBytes } from "@/lib/format";
import { readFragment, writeFragment } from "@/lib/fragment";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import OutputView from "../OutputView.vue";
import ProgressBar from "../ProgressBar.vue";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";

/**
 * Bespoke panel for the BPM and Key Detector.
 *
 * The generic ToolShell cannot run this tool: reading the tempo and the key of
 * a track needs the browser's audio decoder, which a pure function is not
 * allowed to reach. So this file owns exactly three things the logic layer
 * cannot: the file drop, the decode to mono PCM, and the tap clock. Every
 * number it shows still comes from the pure layer (PROJECT.md rule 27):
 * detectBpm, chromagram, detectKey, bpmFromTaps, describeTempo, camelotFor,
 * openKeyFor, camelotNeighbours, keyFromCode, relativeKey, parallelKey, and
 * scaleNotes.
 *
 * Nothing touches AudioContext, the DOM, or the URL until a file arrives or a
 * button is pressed, so the server rendered shell is inert.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/**
 * Ten minutes of audio, the same ceiling the spectrogram panel uses. Longer
 * files still analyze, they are just measured over their first ten minutes,
 * and the panel says so rather than pretending it read the whole thing.
 */
const MAX_ANALYSIS_SECONDS = 600;

/** The tempo range the page copy promises. Also the logic layer's default. */
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Chroma frames of 8192 samples, laid end to end rather than overlapped. The
 * overlap buys very little over minutes of audio and costs twice the FFTs,
 * which is the difference between a short pause and a long one on a full
 * length track. The hop is only passed when the buffer is long enough to hold
 * a whole frame, because the logic layer shrinks the frame to fit a short
 * buffer and then rejects a hop wider than it.
 */
const CHROMA_FRAME = 8192;

/** Only the last 16 taps count in the logic, so there is no point keeping more. */
const MAX_TAPS = 16;

/** Files longer than this get a warning that the page will sit still for a moment. */
const SLOW_ANALYSIS_SECONDS = 60;

/**
 * Containers that carry video. The MIME type is the first signal, but Windows
 * often hands dropped .mkv and .ts files an empty type, so the extension list
 * is what keeps the accept attribute useful for them.
 */
const VIDEO_EXTENSIONS = ".mkv,.ts,.m2ts,.avi,.flv,.wmv";

type Stage = "idle" | "decoding" | "tempo" | "key" | "ready";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  decoding: "Decoding the audio",
  tempo: "Measuring the tempo",
  key: "Reading the key",
  ready: "",
};

/**
 * The bar jumps at stage boundaries rather than sweeping. The logic layer has
 * no progress callback inside a measurement, so an animated percentage would
 * be an invention; a label that names the stage is the honest version.
 */
const STAGE_PERCENT: Record<Stage, number> = {
  idle: 0,
  decoding: 15,
  tempo: 45,
  key: 80,
  ready: 100,
};

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const fileName = ref("");
const fileSize = ref(0);
const stage = ref<Stage>("idle");

const fileError = ref<{ message: string; fix?: string } | null>(null);
const tempoError = ref<{ message: string; fix?: string } | null>(null);
const keyError = ref<{ message: string; fix?: string } | null>(null);

/** Results are plain data, so a shallow ref is enough and skips the proxy. */
const tempo = shallowRef<BpmResult | null>(null);
const keyInfo = shallowRef<KeyResult | null>(null);

const fullDuration = ref(0);
const analyzedDuration = ref(0);
const analysisRate = ref(0);

/** Shallow: `tap` replaces the whole list, and the logic reads a plain array. */
const taps = shallowRef<number[]>([]);
const notation = ref<Notation>("both");

/** Bumped on every new file so a stale run abandons quietly. */
let analysisToken = 0;
let audioCtx: AudioContext | null = null;

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function toNotation(value: string): Notation | null {
  return value === "camelot" || value === "open-key" || value === "both" ? value : null;
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/**
 * A duration as a clock reading. src/lib/format.ts owns byte sizes but has no
 * duration formatter, so this matches the local helper the other media panels
 * already carry.
 */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
  return `${minutes}:${secs}`;
}

function percentText(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return `${Math.round(clamped * 100)} percent`;
}

function percentNumber(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

function oneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function hertzText(rate: number): string {
  return `${Math.round(rate).toLocaleString("en-US")} Hz`;
}

/** Both wheel codes for a key, filtered to whatever notation is selected. */
function codesFor(tonic: string, mode: KeyMode): string {
  const codes: string[] = [];
  if (notation.value !== "open-key") codes.push(camelotFor(tonic, mode));
  if (notation.value !== "camelot") codes.push(openKeyFor(tonic, mode));
  return codes.join(", ");
}

/* ------------------------------------------------------------------ *
 * notation control, read from the tool's own option schema
 * ------------------------------------------------------------------ */

const notationSpec = computed<SelectOptionSpec | null>(() => {
  const found = props.meta.options?.find(
    (option) => option.kind === "select" && option.id === "notation",
  );
  return found && found.kind === "select" ? found : null;
});

const notationOptions = computed<SelectOption[]>(() => notationSpec.value?.options ?? []);

notation.value = toNotation(notationSpec.value?.default ?? "") ?? "both";

function setNotation(value: string) {
  const next = toNotation(value);
  if (next) notation.value = next;
}

/* ------------------------------------------------------------------ *
 * derived readouts
 * ------------------------------------------------------------------ */

const busy = computed(() => stage.value !== "idle" && stage.value !== "ready");
const hasResult = computed(() => tempo.value !== null || keyInfo.value !== null);
const truncated = computed(() => fullDuration.value > analyzedDuration.value + 0.01);
const slowFile = computed(() => analyzedDuration.value > SLOW_ANALYSIS_SECONDS);

const marking = computed(() => (tempo.value ? describeTempo(tempo.value.bpm) : null));

/** The half and double time partners, with a score when the search found them. */
const octavePartners = computed<{ label: string; bpm: number; score: number | null }[]>(() => {
  const result = tempo.value;
  if (!result) return [];
  const candidates = result.candidates;
  const scoreNear = (target: number): number | null => {
    const hit = candidates.find((candidate) => Math.abs(candidate.bpm - target) <= target * 0.02);
    return hit ? hit.score : null;
  };
  const half = oneDecimal(result.bpm / 2);
  const double = oneDecimal(result.bpm * 2);
  return [
    { label: "Half time", bpm: half, score: scoreNear(half) },
    { label: "Double time", bpm: double, score: scoreNear(double) },
  ];
});

/** The three codes that mix cleanly with the detected key. */
const mixesWith = computed<{ code: string; name: string }[]>(() => {
  const result = keyInfo.value;
  if (!result) return [];
  return camelotNeighbours(result.camelot).map((code) => {
    const found = keyFromCode(code);
    return {
      code: found ? codesFor(found.tonic, found.mode) : code,
      name: found ? found.key : "",
    };
  });
});

const tapResult = computed<TapTempoResult | null>(() =>
  taps.value.length >= 2 ? bpmFromTaps(taps.value) : null,
);

const tapMarking = computed(() => (tapResult.value ? describeTempo(tapResult.value.bpm) : null));

/* ------------------------------------------------------------------ *
 * output rows
 * ------------------------------------------------------------------ */

const PRIVACY_ROW =
  "The file is decoded and analyzed in this tab. Your files and inputs never leave your device.";

function analysisRows(): BpmKeyResult {
  const rows: BpmKeyResult = {};
  if (fileName.value) rows["File"] = `${fileName.value} (${formatBytes(fileSize.value)})`;
  if (fullDuration.value > 0) rows["Duration"] = clock(fullDuration.value);
  if (analysisRate.value > 0) rows["Analysis sample rate"] = hertzText(analysisRate.value);
  if (truncated.value) {
    rows["Analyzed window"] =
      `The first ${clock(analyzedDuration.value)} of ${clock(fullDuration.value)}`;
  }

  const result = tempo.value;
  if (result) {
    rows["Tempo"] = `${result.bpm} bpm`;
    rows["Tempo confidence"] = percentText(result.confidence);
    const band = describeTempo(result.bpm);
    rows["Marking"] = `${band.marking} (${band.range})`;
    rows["Feel"] = band.feel;
    rows["Half time"] = `${oneDecimal(result.bpm / 2)} bpm`;
    rows["Double time"] = `${oneDecimal(result.bpm * 2)} bpm`;
    rows["Tempo candidates"] = result.candidates
      .map((candidate) => `${candidate.bpm} bpm (score ${candidate.score})`)
      .join(", ");
  }

  const key = keyInfo.value;
  if (key) {
    rows["Key"] = key.key;
    rows["Key confidence"] = percentText(key.confidence);
    if (notation.value !== "open-key") rows["Camelot"] = key.camelot;
    if (notation.value !== "camelot") rows["Open Key"] = key.openKey;
    const relative = relativeKey(key.tonic, key.mode);
    const parallel = parallelKey(key.tonic, key.mode);
    rows["Relative key"] = `${relative.key} (${codesFor(relative.tonic, relative.mode)})`;
    rows["Parallel key"] = `${parallel.key} (${codesFor(parallel.tonic, parallel.mode)})`;
    rows["Scale notes"] = scaleNotes(key.tonic, key.mode).join(" ");
    rows["Mixes with"] = mixesWith.value
      .map((chip) => (chip.name ? `${chip.code} (${chip.name})` : chip.code))
      .join(", ");
    rows["Other key candidates"] = key.alternates
      .map((alternate) => `${alternate.key} (correlation ${alternate.score})`)
      .join(", ");
  }

  const tapped = tapResult.value;
  if (tapped) rows["Tap tempo"] = `${tapped.bpm} bpm from ${tapped.taps} taps`;
  rows["Privacy"] = PRIVACY_ROW;
  return rows;
}

function tapRows(result: TapTempoResult): BpmKeyResult {
  const band = describeTempo(result.bpm);
  return {
    "Tap tempo": `${result.bpm} bpm`,
    Confidence: percentText(result.confidence),
    "Taps read": String(result.taps),
    "Gaps used": String(result.intervals),
    "Average gap": `${result.averageIntervalMs} ms`,
    "Gap spread": `${result.spreadMs} ms`,
    Marking: `${band.marking} (${band.range})`,
    Feel: band.feel,
    "Half time": `${oneDecimal(result.bpm / 2)} bpm`,
    "Double time": `${oneDecimal(result.bpm * 2)} bpm`,
    Privacy: PRIVACY_ROW,
  };
}

/**
 * The empty state is written here rather than taken from the logic layer's
 * `run("")` rows, because those describe the generic shell's paste box, which
 * this panel does not have. The wheel examples are the same either way.
 */
function emptyRows(): BpmKeyResult {
  const rows: BpmKeyResult = {
    Tempo: "Drop a track above and the browser decodes it here, then measures its tempo.",
    Key: "A second pass folds the spectrum into twelve pitch classes and names the key.",
    "Tap tempo": "No file to hand? Tap the button below in time with the music instead.",
  };
  if (notation.value !== "open-key") rows["Camelot"] = "C major is 8B and A minor is 8A.";
  if (notation.value !== "camelot") rows["Open Key"] = "C major is 1d and A minor is 1m.";
  rows["Privacy"] = PRIVACY_ROW;
  return rows;
}

const output = computed<BpmKeyResult>(() => {
  if (hasResult.value) return analysisRows();
  const tapped = tapResult.value;
  if (tapped) return tapRows(tapped);
  return emptyRows();
});

const jsonText = computed(() =>
  JSON.stringify(
    {
      file: fileName.value || null,
      durationSeconds: fullDuration.value > 0 ? Number(fullDuration.value.toFixed(3)) : null,
      analyzedSeconds:
        analyzedDuration.value > 0 ? Number(analyzedDuration.value.toFixed(3)) : null,
      sampleRate: analysisRate.value > 0 ? analysisRate.value : null,
      notation: notation.value,
      tempo: tempo.value,
      key: keyInfo.value,
      mixesWith: mixesWith.value,
      tapTempo: tapResult.value,
    },
    null,
    2,
  ),
);

/* ------------------------------------------------------------------ *
 * decode and analyze
 * ------------------------------------------------------------------ */

function ensureAudioContext(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

/** Average every channel into one track: both measurements read mono PCM. */
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

/** Let Vue flush and the browser paint before a measurement blocks the thread. */
async function yieldToPaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => setTimeout(resolve, 16));
}

function resetResults() {
  tempo.value = null;
  keyInfo.value = null;
  fileError.value = null;
  tempoError.value = null;
  keyError.value = null;
  fullDuration.value = 0;
  analyzedDuration.value = 0;
  analysisRate.value = 0;
  stage.value = "idle";
}

async function readFile(file: File) {
  const token = ++analysisToken;
  resetResults();
  fileName.value = file.name;
  fileSize.value = file.size;
  stage.value = "decoding";

  // Left unassigned on purpose: the guard below is what proves the decode ran.
  let buffer: AudioBuffer | undefined;
  try {
    const bytes = await file.arrayBuffer();
    if (token !== analysisToken) return;
    buffer = await ensureAudioContext().decodeAudioData(bytes);
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = "idle";
    fileError.value =
      e instanceof ToolError
        ? toToolError(e)
        : {
            message: "This browser could not decode that file as audio.",
            fix: "Try a WAV, MP3, FLAC, OGG, or M4A file, or a video with an audio track in it.",
          };
    return;
  }
  if (token !== analysisToken || !buffer) return;

  fullDuration.value = buffer.duration;
  analysisRate.value = buffer.sampleRate;
  const samples = toMono(buffer, Math.floor(MAX_ANALYSIS_SECONDS * buffer.sampleRate));
  analyzedDuration.value = samples.length / buffer.sampleRate;
  await analyze(samples, buffer.sampleRate, token);
}

/**
 * The two measurements run one after the other with a paint between them, so
 * the stage label is on screen before the thread goes quiet. They are caught
 * separately: a silent passage can defeat the key while the tempo still stands.
 */
async function analyze(samples: Float32Array, rate: number, token: number) {
  stage.value = "tempo";
  await yieldToPaint();
  if (token !== analysisToken) return;

  try {
    tempo.value = detectBpm(samples, rate, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
  } catch (e) {
    if (token !== analysisToken) return;
    tempoError.value = toToolError(e);
  }
  if (token !== analysisToken) return;

  stage.value = "key";
  await yieldToPaint();
  if (token !== analysisToken) return;

  try {
    const options: ChromagramOptions =
      samples.length >= CHROMA_FRAME ? { frameSize: CHROMA_FRAME, hop: CHROMA_FRAME } : {};
    keyInfo.value = detectKey(chromagram(samples, rate, options));
  } catch (e) {
    if (token !== analysisToken) return;
    keyError.value = toToolError(e);
  }
  if (token !== analysisToken) return;
  stage.value = "ready";
}

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

function clearFile() {
  analysisToken += 1;
  resetResults();
  fileName.value = "";
  fileSize.value = 0;
}

/* ------------------------------------------------------------------ *
 * tap tempo
 * ------------------------------------------------------------------ */

function tap() {
  const next = [...taps.value, performance.now()];
  taps.value = next.length > MAX_TAPS ? next.slice(next.length - MAX_TAPS) : next;
}

/**
 * A button already taps on Space and Enter, since both fire a click. Only T
 * needs wiring, and a held key must not machine gun the clock.
 */
function onTapKey(e: KeyboardEvent) {
  if (e.repeat) return;
  if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    tap();
  }
}

function resetTaps() {
  taps.value = [];
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

watch(notation, (value) => {
  writeFragment({ opts: { notation: value } });
});

onMounted(() => {
  const fromHash = toNotation(readFragment().opts["notation"] ?? "");
  if (fromHash) notation.value = fromHash;
});

onUnmounted(() => {
  analysisToken += 1;
  if (audioCtx) {
    void audioCtx.close();
    audioCtx = null;
  }
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      :accept="`audio/*,video/*,${VIDEO_EXTENSIONS}`"
      label="Drop an audio or video file here or click to choose"
      hint="It measures the tempo and the musical key. WAV, MP3, FLAC, OGG, and M4A all work, and so does any video your browser can decode. Everything runs in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template v-if="fileName" #default>
        <div class="flex justify-center">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <span v-if="fullDuration > 0" class="shrink-0 text-muted-foreground tabular-nums">
              {{ clock(fullDuration) }}
            </span>
            <button
              type="button"
              aria-label="Remove audio file"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>
      </template>
    </FileDrop>

    <!-- File level errors -->
    <ErrorBanner v-if="fileError" :message="fileError.message" :hint="fileError.fix" />

    <!-- Progress -->
    <div
      v-if="busy"
      class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <ProgressBar
        size="sm"
        track="card"
        :value="STAGE_PERCENT[stage]"
        :label="STAGE_LABEL[stage]"
        :detail="`${STAGE_PERCENT[stage]}%`"
      />
      <p v-if="slowFile" class="text-xs text-muted-foreground">
        The measurement runs on this tab, so the page can sit still for a few seconds on a long
        track. Nothing is being uploaded while it works.
      </p>
    </div>

    <!-- Notation -->
    <div
      v-if="notationOptions.length > 0"
      class="flex flex-wrap items-center justify-between gap-3"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{ notationSpec?.label ?? "Key notation" }}
      </span>
      <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <Button
          v-for="option in notationOptions"
          :key="option.value"
          variant="ghost"
          size="sm"
          :aria-pressed="notation === option.value"
          :class="notation === option.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setNotation(option.value)"
        >
          {{ option.label }}
        </Button>
      </div>
    </div>

    <!-- Results -->
    <div v-if="hasResult || tempoError || keyError" class="grid gap-4 sm:grid-cols-2">
      <!-- Tempo -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Tempo
        </span>

        <template v-if="tempo">
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-4xl leading-none font-semibold tabular-nums">
              {{ tempo.bpm }}
            </span>
            <span class="text-sm text-muted-foreground">bpm</span>
          </div>

          <ProgressBar
            size="sm"
            track="card"
            label="Confidence"
            :detail="percentText(tempo.confidence)"
            :value="percentNumber(tempo.confidence)"
          />

          <p v-if="marking" class="text-sm">
            <span class="font-medium">{{ marking.marking }}</span>
            <span class="text-muted-foreground"> ({{ marking.range }}), {{ marking.feel }}</span>
          </p>

          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="partner in octavePartners"
              :key="partner.label"
              class="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-[var(--sh-sm)]"
            >
              <span class="font-mono font-medium tabular-nums">{{ partner.bpm }} bpm</span>
              <span class="text-muted-foreground">{{ partner.label }}</span>
              <span v-if="partner.score !== null" class="text-muted-foreground tabular-nums">
                score {{ partner.score }}
              </span>
            </span>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Candidates</span>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(candidate, index) in tempo.candidates"
                :key="index"
                class="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-[var(--sh-sm)]"
              >
                <span class="font-mono font-medium tabular-nums">{{ candidate.bpm }}</span>
                <span class="text-muted-foreground tabular-nums">score {{ candidate.score }}</span>
              </span>
            </div>
          </div>
        </template>

        <div v-else-if="tempoError" role="alert" class="flex flex-col gap-1 text-xs">
          <span class="font-semibold text-destructive">{{ tempoError.message }}</span>
          <span v-if="tempoError.fix" class="text-muted-foreground">{{ tempoError.fix }}</span>
        </div>
      </div>

      <!-- Key -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Key
        </span>

        <template v-if="keyInfo">
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-4xl leading-none font-semibold">{{ keyInfo.key }}</span>
            <span class="font-mono text-sm text-muted-foreground">
              {{ codesFor(keyInfo.tonic, keyInfo.mode) }}
            </span>
          </div>

          <ProgressBar
            size="sm"
            track="card"
            label="Confidence"
            :detail="percentText(keyInfo.confidence)"
            :value="percentNumber(keyInfo.confidence)"
          />

          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Mixes with</span>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="chip in mixesWith"
                :key="chip.code"
                class="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-[var(--sh-sm)]"
              >
                <span class="font-mono font-medium">{{ chip.code }}</span>
                <span v-if="chip.name" class="text-muted-foreground">{{ chip.name }}</span>
              </span>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Next best</span>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="alternate in keyInfo.alternates"
                :key="alternate.key"
                class="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs shadow-[var(--sh-sm)]"
              >
                <span class="font-medium">{{ alternate.key }}</span>
                <span class="text-muted-foreground tabular-nums">
                  correlation {{ alternate.score }}
                </span>
              </span>
            </div>
          </div>
        </template>

        <div v-else-if="keyError" role="alert" class="flex flex-col gap-1 text-xs">
          <span class="font-semibold text-destructive">{{ keyError.message }}</span>
          <span v-if="keyError.fix" class="text-muted-foreground">{{ keyError.fix }}</span>
        </div>
      </div>
    </div>

    <!-- Track facts -->
    <div
      v-if="hasResult"
      class="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground"
    >
      <span
        >Duration <span class="font-mono tabular-nums">{{ clock(fullDuration) }}</span></span
      >
      <span>
        Analysis rate <span class="font-mono tabular-nums">{{ hertzText(analysisRate) }}</span>
      </span>
      <span v-if="truncated">
        Measured over the first
        <span class="font-mono tabular-nums">{{ clock(analyzedDuration) }}</span>
      </span>
    </div>

    <!-- Tap tempo -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Tap tempo
        </span>
        <Button v-if="taps.length > 0" variant="ghost" size="sm" @click="resetTaps"> Reset </Button>
      </div>

      <div class="flex flex-wrap items-center gap-4">
        <!-- The listener sits on the wrapper so the key event is a typed DOM event. -->
        <div class="w-full sm:w-48" @keydown="onTapKey">
          <Button class="h-16 w-full" @click="tap"> Tap the beat </Button>
        </div>

        <div v-if="tapResult" class="flex flex-col gap-1">
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-3xl leading-none font-semibold tabular-nums">
              {{ tapResult.bpm }}
            </span>
            <span class="text-sm text-muted-foreground">bpm</span>
          </div>
          <span class="text-xs text-muted-foreground tabular-nums">
            {{ percentText(tapResult.confidence) }} steady, {{ tapResult.taps }} taps,
            {{ tapResult.intervals }} gaps, {{ tapResult.averageIntervalMs }} ms apart
          </span>
          <span v-if="tapMarking" class="text-xs text-muted-foreground">
            {{ tapMarking.marking }} ({{ tapMarking.range }})
          </span>
        </div>

        <p v-else class="max-w-[40ch] text-xs text-muted-foreground">
          Tap at least five times in a row to get a steady reading. Only the last
          {{ MAX_TAPS }} taps count, so an early stumble drops off on its own.
        </p>
      </div>

      <p class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>With the button focused, press</span>
        <kbd class="rounded-[8px] border bg-card px-1.5 py-0.5 font-mono text-[11px]">T</kbd>
        <span>or</span>
        <kbd class="rounded-[8px] border bg-card px-1.5 py-0.5 font-mono text-[11px]">Space</kbd>
        <span>to tap.</span>
      </p>
    </div>

    <!-- Output -->
    <div class="flex flex-col gap-2">
      <div v-if="hasResult || tapResult" class="flex justify-end">
        <CopyButton :text="jsonText" label="Copy JSON" />
      </div>
      <OutputView :output="output" />
    </div>
  </div>
</template>
