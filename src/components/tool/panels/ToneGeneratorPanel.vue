<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, Play, Square } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  describeSignal,
  encodeWav,
  frequencyToNote,
  parseFrequency,
  renderSamples,
  type SweepKind,
  type WaveKind,
} from "@/tools/tone-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import OutputView from "../OutputView.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the Signal Generator.
 *
 * The generic ToolShell can only describe a signal in text. This tool has to
 * make a sound, so the panel owns the WebAudio graph, the oscilloscope canvas,
 * and the WAV download, while every number it plays or writes still comes from
 * the pure logic layer (PROJECT.md rule 27): parseFrequency, frequencyToNote,
 * describeSignal, renderSamples, and encodeWav.
 *
 * Nothing touches AudioContext until a click, so the server rendered shell is
 * silent and inert. Audio never starts on its own, the volume slider tops out
 * well below full scale, and leaving the tab stops playback.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const WAVE_VALUES = new Set<string>([
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "white-noise",
  "pink-noise",
  "sweep",
]);
/** Waveforms an OscillatorNode plays directly, so they can be swapped live. */
const OSCILLATOR_WAVES = new Set<string>(["sine", "square", "triangle", "sawtooth"]);
/** The subset of OscillatorType this panel ever assigns, named locally so the
 * lint rules do not have to know about ambient DOM type globals. */
type OscWave = "sine" | "square" | "triangle" | "sawtooth";

/** The slider spans the audible band on a log scale, so every octave is equally wide. */
const SLIDER_MIN_HZ = 20;
const SLIDER_MAX_HZ = 20000;
const SLIDER_STEPS = 1000;
const SLIDER_SPAN = Math.log(SLIDER_MAX_HZ / SLIDER_MIN_HZ);

/**
 * Hard output ceiling. The volume slider at 100 lands here, never at full
 * scale, so the panel cannot drive speakers or headphones as hard as the
 * format allows.
 */
const MAX_GAIN = 0.5;
/** Attack and release in seconds: long enough to kill the click, short enough to feel instant. */
const RAMP = 0.005;
/** Peak amplitude of the rendered WAV, about 6 dB below full scale. */
const WAV_PEAK = 0.5;
/** Seconds of noise rendered into the looping buffer. */
const NOISE_SECONDS = 4;
/** Time constant for smooth live retunes and volume changes. */
const GLIDE = 0.02;

const PRESETS = [20, 40, 60, 100, 440, 1000, 4000, 8000, 12000, 15000, 17000];

function presetLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

/* ------------------------------------------------------------------ *
 * option specs, read from the tool meta so the dropdowns stay in sync
 * ------------------------------------------------------------------ */

const WAVE_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "wave",
  label: "Waveform",
  default: "sine",
  options: [
    { value: "sine", label: "Sine", synonyms: ["pure tone", "sinusoid"] },
    { value: "square", label: "Square", synonyms: ["square wave", "buzzy tone"] },
    { value: "triangle", label: "Triangle", synonyms: ["triangle wave"] },
    { value: "sawtooth", label: "Sawtooth", synonyms: ["saw wave", "ramp wave"] },
    { value: "white-noise", label: "White noise", synonyms: ["static", "hiss"] },
    { value: "pink-noise", label: "Pink noise", synonyms: ["1/f noise"] },
    { value: "sweep", label: "Sweep", synonyms: ["chirp", "frequency sweep"] },
  ],
};

const SWEEP_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "sweepKind",
  label: "Sweep shape",
  default: "log",
  options: [
    { value: "linear", label: "Linear", synonyms: ["equal hertz per second"] },
    { value: "log", label: "Logarithmic", synonyms: ["exponential", "musical sweep"] },
  ],
};

function selectSpec(id: string, fallback: SelectOptionSpec): SelectOptionSpec {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && found.kind === "select" ? found : fallback;
}

function numberDefault(id: string, fallback: number): number {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && found.kind === "number" ? found.default : fallback;
}

const waveSpec = computed(() => selectSpec("wave", WAVE_FALLBACK));
const sweepSpec = computed(() => selectSpec("sweepKind", SWEEP_FALLBACK));

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface FieldError {
  message: string;
  fix?: string;
}

function toFieldError(err: unknown, fallback: string): FieldError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

const freqText = ref("440");
const frequency = ref(440);
const freqError = ref<FieldError | null>(null);

const wave = ref<WaveKind>("sine");

const endText = ref(String(numberDefault("endFrequency", 20000)));
const endFrequency = ref(numberDefault("endFrequency", 20000));
const endError = ref<FieldError | null>(null);

const sweepKind = ref<SweepKind>("log");
const duration = ref(numberDefault("duration", 3));

/**
 * The panel opens at 30 percent rather than the meta default of 50: a tone
 * generator should never come up loud, and the slider is easy to raise.
 */
const volume = ref(30);

/** Errors from playback or the WAV render, kept apart from the field errors. */
const actionError = ref<FieldError | null>(null);
const playing = ref(false);

const isNoise = computed(() => wave.value === "white-noise" || wave.value === "pink-noise");
const isSweep = computed(() => wave.value === "sweep");

const durationError = computed<FieldError | null>(() => {
  const d = duration.value;
  if (!Number.isFinite(d) || d < 0.1 || d > 60) {
    return {
      message: `Duration must be between 0.1 and 60 seconds, but ${d} was given.`,
      fix: "Pick a duration between 0.1 and 60 seconds.",
    };
  }
  return null;
});

const canPlay = computed(() => {
  if (durationError.value) return false;
  if (isNoise.value) return true;
  if (freqError.value) return false;
  return !(isSweep.value && endError.value);
});

/* ------------------------------------------------------------------ *
 * frequency parsing, the log slider, and the presets
 * ------------------------------------------------------------------ */

function formatHz(hz: number): string {
  return String(hz >= 1000 ? Math.round(hz) : Math.round(hz * 10) / 10);
}

function sliderToHz(pos: number): number {
  return SLIDER_MIN_HZ * Math.exp((SLIDER_SPAN * pos) / SLIDER_STEPS);
}

function hzToSlider(hz: number): number {
  const clamped = Math.min(SLIDER_MAX_HZ, Math.max(SLIDER_MIN_HZ, hz));
  return Math.round((SLIDER_STEPS * Math.log(clamped / SLIDER_MIN_HZ)) / SLIDER_SPAN);
}

const sliderPos = computed(() => hzToSlider(frequency.value));

function onSliderChange(value?: number[]) {
  const pos = value?.[0];
  if (pos === undefined) return;
  freqText.value = formatHz(sliderToHz(pos));
}

function usePreset(hz: number) {
  freqText.value = String(hz);
}

watch(freqText, (text) => {
  try {
    frequency.value = parseFrequency(text);
    freqError.value = null;
  } catch (err) {
    freqError.value = toFieldError(err, "That is not a frequency this tool can use.");
  }
});

watch(endText, (text) => {
  try {
    endFrequency.value = parseFrequency(text);
    endError.value = null;
  } catch (err) {
    endError.value = toFieldError(err, "That is not a frequency this tool can use.");
  }
});

const noteLabel = computed(() => {
  if (isNoise.value || freqError.value) return null;
  try {
    const nearest = frequencyToNote(frequency.value);
    if (nearest.cents === 0) return `${nearest.note}, exactly in tune`;
    return `${nearest.note}, ${nearest.cents > 0 ? "+" : ""}${nearest.cents} cents`;
  } catch {
    return null;
  }
});

const description = computed<Record<string, string> | null>(() => {
  if (!canPlay.value) return null;
  try {
    return describeSignal({
      kind: wave.value,
      frequency: frequency.value,
      f1: endFrequency.value,
      sweepKind: sweepKind.value,
      duration: duration.value,
    });
  } catch {
    return null;
  }
});

/* ------------------------------------------------------------------ *
 * the audio graph
 *
 * source -> envelope gain -> master gain -> analyser -> destination
 *
 * The envelope gain carries the 5 ms attack and release plus the scheduled
 * release at the end of a sweep; the master gain carries the volume. Keeping
 * the two apart means a volume change mid sweep cannot wipe the release ramp
 * that stops the sweep from clicking.
 * ------------------------------------------------------------------ */

let ctx: AudioContext | null = null;
let envGain: GainNode | null = null;
let masterGain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let osc: OscillatorNode | null = null;
let noise: AudioBufferSourceNode | null = null;
let frame: number | null = null;
/** Bumped on every start and stop so a stale onended cannot clear a newer run. */
let runId = 0;

const canvasEl = ref<HTMLCanvasElement>();

/** Volume as gain: squared for a perceptual curve, capped well below full scale. */
function targetGain(): number {
  const v = Math.min(100, Math.max(0, volume.value)) / 100;
  return MAX_GAIN * v * v;
}

async function ensureContext(): Promise<AudioContext> {
  // Created inside the click so the autoplay policy does not suspend it.
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  if (!envGain || !masterGain || !analyser) {
    envGain = ctx.createGain();
    envGain.gain.value = 0;
    masterGain = ctx.createGain();
    masterGain.gain.value = targetGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    envGain.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(ctx.destination);
  }
  return ctx;
}

function makeNoiseSource(audio: AudioContext): AudioBufferSourceNode {
  const samples = renderSamples({
    kind: wave.value,
    frequency: frequency.value,
    duration: NOISE_SECONDS,
    sampleRate: audio.sampleRate,
    amplitude: 1,
  });
  const buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/** Stop and forget whatever is making sound, taking effect at `when`. */
function releaseSources(when: number) {
  for (const node of [osc, noise]) {
    if (!node) continue;
    node.onended = null;
    try {
      node.stop(when);
    } catch {
      // Already stopped, which is exactly the state it needs to be in.
    }
  }
  osc = null;
  noise = null;
}

async function play() {
  if (playing.value || !canPlay.value) return;
  actionError.value = null;

  let audio: AudioContext;
  try {
    audio = await ensureContext();
  } catch (err) {
    actionError.value = toFieldError(err, "This browser would not start audio playback.");
    return;
  }

  const env = envGain;
  const master = masterGain;
  if (!env || !master) return;

  const id = ++runId;
  const now = audio.currentTime;

  try {
    if (isNoise.value) {
      noise = makeNoiseSource(audio);
      noise.connect(env);
      noise.start(now);
    } else {
      osc = audio.createOscillator();
      osc.type = isSweep.value ? "sine" : (wave.value as OscWave);
      osc.frequency.setValueAtTime(frequency.value, now);
      osc.connect(env);
      osc.start(now);
    }
  } catch (err) {
    actionError.value = toFieldError(err, "That signal could not be started.");
    releaseSources(now);
    return;
  }

  master.gain.setValueAtTime(targetGain(), now);
  env.gain.cancelScheduledValues(now);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(1, now + RAMP);

  if (isSweep.value && osc) {
    const end = now + duration.value;
    if (sweepKind.value === "log") {
      osc.frequency.exponentialRampToValueAtTime(endFrequency.value, end);
    } else {
      osc.frequency.linearRampToValueAtTime(endFrequency.value, end);
    }
    // Release inside the sweep's own lifetime, so the last sample is silence.
    env.gain.setValueAtTime(1, Math.max(now + RAMP, end - RAMP));
    env.gain.linearRampToValueAtTime(0, end);
    osc.stop(end + 0.01);
    osc.onended = () => {
      if (id !== runId) return;
      playing.value = false;
      osc = null;
      stopScope();
    };
  }

  playing.value = true;
  startScope();
}

function stop() {
  runId += 1;
  playing.value = false;
  stopScope();
  const audio = ctx;
  if (!audio || !envGain) {
    releaseSources(0);
    return;
  }
  const now = audio.currentTime;
  envGain.gain.cancelScheduledValues(now);
  envGain.gain.setValueAtTime(envGain.gain.value, now);
  envGain.gain.linearRampToValueAtTime(0, now + RAMP);
  // Stop after the release so the ramp, not the node, ends the sound.
  releaseSources(now + RAMP + 0.01);
}

function toggle() {
  if (playing.value) stop();
  else void play();
}

/* live updates while a signal is sounding -------------------------- */

watch(volume, () => {
  if (!ctx || !masterGain) return;
  masterGain.gain.setTargetAtTime(targetGain(), ctx.currentTime, GLIDE);
});

watch(frequency, (hz) => {
  if (!playing.value || !ctx || !osc || isSweep.value || isNoise.value) return;
  osc.frequency.setTargetAtTime(hz, ctx.currentTime, GLIDE);
});

watch(wave, (next, previous) => {
  if (!playing.value) return;
  if (osc && OSCILLATOR_WAVES.has(next) && OSCILLATOR_WAVES.has(previous)) {
    osc.type = next as OscWave;
    return;
  }
  // Any other change swaps the source node, which means a restart.
  stop();
  void play();
});

/* ------------------------------------------------------------------ *
 * oscilloscope
 * ------------------------------------------------------------------ */

function sizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext("2d");
}

/** The resting trace: one flat line down the middle. */
function drawFlat() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const g = sizeCanvas(canvas);
  if (!g) return;
  const { width, height } = canvas;
  g.clearRect(0, 0, width, height);
  g.strokeStyle = getComputedStyle(canvas).color;
  g.globalAlpha = 0.25;
  g.lineWidth = window.devicePixelRatio || 1;
  g.beginPath();
  g.moveTo(0, height / 2);
  g.lineTo(width, height / 2);
  g.stroke();
  g.globalAlpha = 1;
}

function drawScope() {
  frame = requestAnimationFrame(drawScope);
  const canvas = canvasEl.value;
  const node = analyser;
  if (!canvas || !node) return;
  const g = sizeCanvas(canvas);
  if (!g) return;

  const data = new Float32Array(node.fftSize);
  node.getFloatTimeDomainData(data);

  const { width, height } = canvas;
  const dpr = window.devicePixelRatio || 1;
  const color = getComputedStyle(canvas).color;
  // The tap sits after the volume gain, so undo that gain to keep the trace
  // full height however quiet the output is.
  const scale = 1 / Math.max(targetGain(), 0.01);
  const mid = height / 2;
  const amp = mid - 2 * dpr;

  g.clearRect(0, 0, width, height);
  g.strokeStyle = color;
  g.globalAlpha = 0.25;
  g.lineWidth = dpr;
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(width, mid);
  g.stroke();

  g.globalAlpha = 1;
  g.lineWidth = 1.5 * dpr;
  g.beginPath();
  for (let i = 0; i < data.length; i++) {
    const value = Math.max(-1, Math.min(1, (data[i] ?? 0) * scale));
    const x = (i / (data.length - 1)) * width;
    const y = mid - value * amp;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

function startScope() {
  if (frame === null) frame = requestAnimationFrame(drawScope);
}

function stopScope() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  drawFlat();
}

/* ------------------------------------------------------------------ *
 * WAV download
 * ------------------------------------------------------------------ */

function wavName(): string {
  if (isNoise.value) return `${wave.value}.wav`;
  if (isSweep.value) {
    return `sweep-${Math.round(frequency.value)}hz-${Math.round(endFrequency.value)}hz.wav`;
  }
  return `${wave.value}-${Math.round(frequency.value)}hz.wav`;
}

function downloadWav() {
  actionError.value = null;
  if (!canPlay.value) return;
  // The live context's rate when there is one, so the file matches what plays.
  const sampleRate = ctx?.sampleRate ?? 44100;
  try {
    const samples = renderSamples({
      kind: wave.value,
      frequency: frequency.value,
      f1: endFrequency.value,
      sweepKind: sweepKind.value,
      duration: duration.value,
      sampleRate,
      amplitude: WAV_PEAK,
    });
    const bytes = encodeWav(samples, sampleRate);
    downloadBlob(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "audio/wav" }), wavName());
  } catch (err) {
    actionError.value = toFieldError(err, "That signal could not be rendered to a WAV file.");
  }
}

/* ------------------------------------------------------------------ *
 * fragment state: frequency and waveform only
 * ------------------------------------------------------------------ */

let ready = false;

watch([freqText, wave], () => {
  if (!ready || freqError.value) return;
  writeFragment({ input: freqText.value.trim(), opts: { wave: wave.value } });
});

function onVisibilityChange() {
  if (document.hidden) stop();
}

onMounted(() => {
  const state = readFragment();
  if (state.input) freqText.value = state.input;
  const fromHash = state.opts["wave"];
  if (fromHash && WAVE_VALUES.has(fromHash)) wave.value = fromHash as WaveKind;
  ready = true;
  drawFlat();
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stop();
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  if (ctx) void ctx.close();
  ctx = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- frequency, waveform, and the log slider -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex w-full flex-col gap-1.5 sm:w-44">
          <Label for="tone-frequency" class="text-xs text-muted-foreground">
            Frequency or note
          </Label>
          <Input
            id="tone-frequency"
            v-model="freqText"
            type="text"
            inputmode="decimal"
            placeholder="440, 1kHz, A4"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="bg-card font-mono tabular-nums"
            :aria-invalid="freqError ? 'true' : undefined"
          />
        </div>

        <div class="flex w-full flex-col gap-1.5 sm:w-56">
          <Label for="tone-wave" class="text-xs text-muted-foreground">Waveform</Label>
          <SearchableSelect
            id="tone-wave"
            :spec="waveSpec"
            :model-value="wave"
            @update:model-value="(v: string) => (wave = v as WaveKind)"
          />
        </div>

        <p v-if="noteLabel" class="pb-2 text-sm text-muted-foreground tabular-nums">
          Nearest note: {{ noteLabel }}
        </p>
      </div>

      <div class="flex flex-col gap-1.5">
        <Slider
          aria-label="Frequency"
          :model-value="[sliderPos]"
          :min="0"
          :max="SLIDER_STEPS"
          :step="1"
          class="py-2"
          @update:model-value="onSliderChange"
        />
        <div class="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>20 Hz</span>
          <span>20 kHz</span>
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="preset in PRESETS"
          :key="preset"
          type="button"
          class="rounded-[8px] border bg-card px-2.5 py-1 text-xs tabular-nums transition-colors duration-[120ms] hover:bg-accent"
          :class="
            Math.round(frequency) === preset
              ? 'border-primary text-primary'
              : 'border-border text-muted-foreground'
          "
          @click="usePreset(preset)"
        >
          {{ presetLabel(preset) }}
        </button>
      </div>

      <p v-if="isNoise" class="text-xs text-muted-foreground">
        Noise fills the whole audible band, so the frequency setting does not apply while a noise
        waveform is selected.
      </p>
    </div>

    <!-- sweep controls -->
    <div
      v-if="isSweep"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Sweep
      </span>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="tone-end" class="text-xs text-muted-foreground">End frequency</Label>
          <Input
            id="tone-end"
            v-model="endText"
            type="text"
            inputmode="decimal"
            placeholder="20000"
            autocomplete="off"
            spellcheck="false"
            class="h-9 bg-card font-mono tabular-nums"
            :aria-invalid="endError ? 'true' : undefined"
          />
        </div>
        <div class="flex w-44 flex-col gap-1.5">
          <Label for="tone-sweep-kind" class="text-xs text-muted-foreground">Shape</Label>
          <SearchableSelect
            id="tone-sweep-kind"
            :spec="sweepSpec"
            :model-value="sweepKind"
            @update:model-value="(v: string) => (sweepKind = v as SweepKind)"
          />
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        The sweep runs for the duration below and stops on its own. Changing these values while it
        is playing takes effect the next time you press Play.
      </p>
    </div>

    <!-- duration, volume, transport -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex w-32 flex-col gap-1.5">
          <Label for="tone-duration" class="text-xs text-muted-foreground">Duration (sec)</Label>
          <Input
            id="tone-duration"
            type="number"
            min="0.1"
            max="60"
            step="0.1"
            :model-value="duration"
            class="h-9 bg-card tabular-nums"
            :aria-invalid="durationError ? 'true' : undefined"
            @update:model-value="(v) => (duration = Number(v))"
          />
        </div>

        <div class="flex min-w-48 flex-1 flex-col gap-1.5">
          <span class="text-xs text-muted-foreground tabular-nums">Volume: {{ volume }}%</span>
          <Slider
            aria-label="Volume"
            :model-value="[volume]"
            :min="0"
            :max="100"
            :step="1"
            class="py-2"
            @update:model-value="(v) => (volume = v?.[0] ?? volume)"
          />
        </div>

        <div class="flex items-center gap-2">
          <Button type="button" :disabled="!canPlay" @click="toggle">
            <Square v-if="playing" class="size-3.5" aria-hidden="true" />
            <Play v-else class="size-3.5" aria-hidden="true" />
            {{ playing ? "Stop" : "Play" }}
          </Button>
          <Button type="button" variant="outline" :disabled="!canPlay" @click="downloadWav">
            <Download class="size-3.5" aria-hidden="true" />
            WAV
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Start quiet and raise the volume slowly, especially on headphones. A tone can damage hearing
        before it feels loud, and very low or very high frequencies sound quiet at levels that are
        not. This slider tops out at half of full scale, and audio only ever starts when you press
        Play.
      </p>
    </div>

    <!-- errors -->
    <div
      v-if="freqError || endError || durationError || actionError"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <template
        v-for="err in [freqError, endError, durationError, actionError]"
        :key="err?.message"
      >
        <template v-if="err">
          <span class="font-semibold text-destructive">{{ err.message }}</span>
          <span v-if="err.fix" class="text-muted-foreground">{{ err.fix }}</span>
        </template>
      </template>
    </div>

    <!-- oscilloscope -->
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Oscilloscope
      </span>
      <canvas
        ref="canvasEl"
        class="h-24 w-full rounded-[10px] bg-secondary text-primary shadow-[var(--sh-inset)]"
        aria-hidden="true"
      />
      <p class="text-xs text-muted-foreground">
        {{
          playing
            ? "Live trace of the signal leaving this page, drawn at full height whatever the volume."
            : "The trace runs while a signal is playing."
        }}
      </p>
    </div>

    <!-- description -->
    <OutputView v-if="description" :output="description" />

    <p class="text-xs text-muted-foreground">
      The WAV renders the same signal at half of full scale, about 6 dB of headroom, so it opens at
      a sensible level in any player no matter where the volume slider sits here. Everything runs in
      this tab: your files and inputs never leave your device.
    </p>
  </div>
</template>
