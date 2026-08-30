<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, Mic, MicOff, Play, Square } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  buildFskFrame,
  decodeDtmf,
  decodeFsk,
  decodeMorseFromEnvelope,
  DTMF_FREQS,
  DTMF_HIGH_FREQS,
  DTMF_KEYPAD,
  DTMF_LOW_FREQS,
  encodeFsk,
  encodeWav,
  envelopeFromSamples,
  FSK_DEFAULT_F0,
  FSK_DEFAULT_F1,
  goertzel,
  morseDurationMs,
  morseTiming,
  morseToText,
  normalizeDtmfDigits,
  normalizeMorseString,
  renderDtmfSamples,
  renderMorseSamples,
  textToMorse,
} from "@/tools/audio-data-codec/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import OutputView from "../OutputView.vue";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

/**
 * Bespoke panel for Morse, DTMF and Audio Data.
 *
 * The generic ToolShell can only print what the logic layer says about a
 * signal. This tool has to make the sound and listen to it come back, so the
 * panel owns the WebAudio graph, the microphone capture, the file decode and
 * the WAV download, while every symbol, sample and decoded character still
 * comes from the pure logic layer (PROJECT.md rule 27): textToMorse,
 * morseToText, normalizeMorseString, morseTiming, morseDurationMs,
 * renderMorseSamples, envelopeFromSamples, decodeMorseFromEnvelope,
 * normalizeDtmfDigits, renderDtmfSamples, decodeDtmf, buildFskFrame,
 * encodeFsk, decodeFsk, goertzel and encodeWav.
 *
 * Two things are worth knowing about the shape of this file.
 *
 * First, capture uses a ScriptProcessorNode rather than an AnalyserNode. An
 * analyser hands out whatever happens to be in its ring buffer at the moment
 * you ask, so consecutive animation frames overlap and drop samples. Morse
 * decoding is entirely a measurement of how long each tone lasted, and a
 * timeline stitched from overlapping reads measures nothing. The processor
 * hands over every block exactly once, in order, which is what the decoders
 * need. It is deprecated in favour of an AudioWorklet, and a worklet needs a
 * second file to load from a URL, which this panel does not add.
 *
 * Second, the decoders in the logic layer all take a whole recording: each
 * picks its own reference level, its own dit length and its own frame
 * alignment from what it is given, and none of them can be fed a block at a
 * time. So "live" here means a rolling window of the last 30 seconds held in
 * one preallocated buffer, decoded again a few times a second. That keeps the
 * memory flat and the decode honest, at the cost of a message longer than the
 * window scrolling off the front.
 *
 * Nothing touches AudioContext, the microphone or the DOM until a click, so
 * the server rendered shell is silent and inert.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * modes
 * ------------------------------------------------------------------ */

type Mode = "text-to-morse" | "morse-to-text" | "dtmf" | "fsk-info";
type Codec = "morse" | "dtmf" | "fsk";

interface ModeChoice {
  value: Mode;
  label: string;
}

const MODE_FALLBACK: ModeChoice[] = [
  { value: "text-to-morse", label: "Text to Morse" },
  { value: "morse-to-text", label: "Morse to text" },
  { value: "dtmf", label: "DTMF keypad tones" },
  { value: "fsk-info", label: "Data over sound" },
];

function isMode(value: string): value is Mode {
  return MODE_FALLBACK.some((choice) => choice.value === value);
}

/** The segmented group is the meta's own mode list, so the two cannot drift. */
const modeChoices = computed<ModeChoice[]>(() => {
  const spec = props.meta.options?.find((option) => option.id === "mode");
  const listed = spec && spec.kind === "select" ? (spec.options ?? []) : [];
  const fromMeta: ModeChoice[] = [];
  for (const option of listed) {
    if (isMode(option.value)) fromMeta.push({ value: option.value, label: option.label });
  }
  return fromMeta.length > 0 ? fromMeta : MODE_FALLBACK;
});

/* ------------------------------------------------------------------ *
 * numeric options, read from the meta so the bounds stay in sync
 * ------------------------------------------------------------------ */

interface NumberBounds {
  value: number;
  min: number;
  max: number;
  step: number;
}

function numberBounds(id: string, fallback: NumberBounds): NumberBounds {
  const spec = props.meta.options?.find((option) => option.id === id);
  if (!spec || spec.kind !== "number") return fallback;
  return {
    value: spec.default,
    min: spec.min ?? fallback.min,
    max: spec.max ?? fallback.max,
    step: spec.step ?? fallback.step,
  };
}

const WPM = numberBounds("wpm", { value: 15, min: 5, max: 40, step: 1 });
const TONE = numberBounds("toneHz", { value: 600, min: 300, max: 1500, step: 10 });
const BAUD = numberBounds("baud", { value: 100, min: 50, max: 300, step: 10 });

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** The tone and gap lengths the logic layer's own DTMF summary assumes. */
const DTMF_TONE_MS = 100;
const DTMF_GAP_MS = 100;
/** Peak amplitude of every rendered buffer, about 6 dB below full scale. */
const RENDER_PEAK = 0.5;
/**
 * Hard output ceiling. The volume slider at 100 lands here, never at full
 * scale, so the panel cannot drive speakers or headphones as hard as the
 * format allows.
 */
const MAX_GAIN = 0.5;
/** Time constant for a smooth volume change while a buffer is playing. */
const GLIDE = 0.02;
/** Release in seconds: long enough to kill the click, short enough to feel instant. */
const RELEASE = 0.005;

/**
 * Capture rate. Every tone the three codecs use sits below 2.5 kHz, so 16 kHz
 * is comfortably above twice the highest of them, and it cuts the work in all
 * three detectors to about a third of what 48 kHz would cost.
 */
const CAPTURE_RATE = 16000;
/** How much recent audio the rolling window holds. */
const CAPTURE_SECONDS = 30;
/** Only the start of a dropped file is decoded, so a long recording cannot hang the tab. */
const FILE_SECONDS = 120;
/** Block handed over by each processor callback: about 43 ms at 48 kHz. */
const PROCESSOR_SIZE = 2048;
/** How often the rolling window is decoded again, per codec. */
const DECODE_INTERVAL_MS: Record<Codec, number> = { morse: 300, dtmf: 400, fsk: 700 };
/** Samples the live tone readout measures, taken from the end of the window. */
const TONE_BLOCK = 512;
/** Below this Goertzel amplitude the readout calls it silence. */
const TONE_FLOOR = 0.008;
/** Meter floor, and how fast the peak hold falls back toward it. */
const METER_FLOOR_DB = -60;
const PEAK_DECAY = 0.86;

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

interface PanelError {
  message: string;
  fix?: string;
}

function toPanelError(err: unknown, fallback: string): PanelError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

/**
 * Turns a getUserMedia rejection into the message plus the fix hint the design
 * rules require. The names below are the ones a visitor can act on; anything
 * else falls through to the raw message.
 */
function describeMicError(err: unknown): PanelError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message: "Permission to use the microphone was denied, so this page cannot listen.",
      fix: "Click the lock or microphone icon at the left of your browser address bar, set the microphone to Allow, reload the page, then press Listen again.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      message: "No microphone was found on this device.",
      fix: "Plug one in (a headset counts as a microphone), then press Listen again.",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      message: "The microphone is already in use by another app, so this page cannot open it.",
      fix: "Close any call, recording, or audio app that is holding the microphone, then press Listen again.",
    };
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      message: "The microphone could not be opened with the settings this page asked for.",
      fix: "Pick a different input in your system sound settings, then press Listen again.",
    };
  }
  return {
    message: `The microphone could not be started: ${err instanceof Error ? err.message : String(err)}`,
    fix: "Check that no other app is using the microphone, then press Listen again.",
  };
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const mode = ref<Mode>("text-to-morse");
const text = ref("");
const wpm = ref(WPM.value);
const toneHz = ref(TONE.value);
const baud = ref(BAUD.value);
/** The panel opens quiet. Anything that makes a tone should never come up loud. */
const volume = ref(30);

const playing = ref(false);
const actionError = ref<PanelError | null>(null);

const codec = computed<Codec>(() => {
  if (mode.value === "dtmf") return "dtmf";
  if (mode.value === "fsk-info") return "fsk";
  return "morse";
});

const inputLabel = computed(() => {
  if (mode.value === "morse-to-text") return "Morse";
  if (mode.value === "dtmf") return "Dial string";
  return "Text";
});

const inputPlaceholder = computed(() => {
  if (mode.value === "morse-to-text") return ".... . .-.. .-.. --- / .-- --- .-. .-.. -..";
  if (mode.value === "dtmf") return "1-800-555-0100";
  if (mode.value === "fsk-info") return "Text to carry to the device listening next to this one";
  return "HELLO WORLD";
});

const playLabel = computed(() => (codec.value === "fsk" ? "Send" : "Play"));

/* ------------------------------------------------------------------ *
 * small formatters
 * ------------------------------------------------------------------ */

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function groupBits(bits: number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < bits.length; i += 8) groups.push(bits.slice(i, i + 8).join(""));
  return groups.join(" ");
}

function dtmfSequence(keys: string): string {
  return [...keys].map((key) => `${key} ${DTMF_FREQS[key].low}/${DTMF_FREQS[key].high}`).join(", ");
}

/* ------------------------------------------------------------------ *
 * option validation
 * ------------------------------------------------------------------ */

function boundsError(
  value: number,
  bounds: NumberBounds,
  label: string,
  unit: string,
): PanelError | null {
  if (Number.isFinite(value) && value >= bounds.min && value <= bounds.max) return null;
  return {
    message: `${label} must be between ${bounds.min} and ${bounds.max} ${unit}.`,
    fix: `Pick a value between ${bounds.min} and ${bounds.max} ${unit}.`,
  };
}

const optionError = computed<PanelError | null>(() => {
  if (codec.value === "morse") {
    return (
      boundsError(wpm.value, WPM, "Morse speed", "WPM") ??
      boundsError(toneHz.value, TONE, "Morse tone", "Hz")
    );
  }
  if (codec.value === "fsk") return boundsError(baud.value, BAUD, "Data speed", "baud");
  return null;
});

/* ------------------------------------------------------------------ *
 * the symbolic representation, straight from the logic layer
 * ------------------------------------------------------------------ */

interface EncodeState {
  rows: Record<string, string> | null;
  error: PanelError | null;
  /** True when there is something the panel could render to samples. */
  ready: boolean;
}

const encodeState = computed<EncodeState>(() => {
  const raw = text.value;
  if (!raw.trim() || optionError.value) return { rows: null, error: null, ready: false };
  try {
    if (codec.value === "morse") {
      const timing = morseTiming(wpm.value);
      const morse = mode.value === "text-to-morse" ? textToMorse(raw) : normalizeMorseString(raw);
      const decoded = mode.value === "text-to-morse" ? null : morseToText(raw);
      // Reading the Morse back is the honest way to show the text: it is what
      // a receiver would write down, with the same folding of curly quotes and
      // typographic dashes the encoder applied on the way in.
      const characters = morse ? morse.split(/\s+/).filter((token) => token !== "/").length : 0;
      const words = morse ? morse.split(" / ").length : 0;
      const rows: Record<string, string> = {
        Morse: morse || "(nothing)",
        Text: decoded ?? morseToText(morse),
        Counts: `${characters} characters in ${words} ${words === 1 ? "word" : "words"}`,
        Timing: `dit ${round(timing.ditMs, 1)} ms, dah ${round(timing.dahMs, 1)} ms, letter gap ${round(timing.charGapMs, 1)} ms, word gap ${round(timing.wordGapMs, 1)} ms`,
        Duration: `${formatMs(morseDurationMs(morse, timing))} at ${wpm.value} WPM`,
        Tone: `${toneHz.value} Hz sidetone with a 5 ms rise and fall`,
      };
      return { rows, error: null, ready: morse.length > 0 };
    }

    if (codec.value === "dtmf") {
      const keys = normalizeDtmfDigits(raw);
      if (!keys) {
        return {
          rows: null,
          error: {
            message: "That dial string has no keys in it once the separators are removed.",
            fix: "Use 0 to 9, A to D, * and #.",
          },
          ready: false,
        };
      }
      const totalMs = keys.length * DTMF_TONE_MS + (keys.length - 1) * DTMF_GAP_MS;
      const rows: Record<string, string> = {
        Keys: keys,
        "Tone pairs": dtmfSequence(keys),
        Duration: `${formatMs(totalMs)} at ${DTMF_TONE_MS} ms tones and ${DTMF_GAP_MS} ms gaps`,
        Standard:
          "ITU-T Q.23: one tone from the 697, 770, 852, 941 Hz low group plus one from the 1209, 1336, 1477, 1633 Hz high group.",
      };
      return { rows, error: null, ready: true };
    }

    const payload = new TextEncoder().encode(raw);
    const frame = buildFskFrame(payload);
    const rows: Record<string, string> = {
      Payload: `${payload.length} bytes of UTF-8 (${raw.length} characters)`,
      "Bit stream": groupBits(frame.bits),
      "Total bits": `${frame.bits.length} bits, including ${frame.framedByteCount} framed bytes`,
      Checksum: `CRC-16/CCITT-FALSE 0x${frame.crc.toString(16).toUpperCase().padStart(4, "0")}`,
      Duration: `${formatMs((frame.bits.length / baud.value) * 1000)} at ${baud.value} baud`,
      Tones: `${FSK_DEFAULT_F0} Hz for a 0 bit, ${FSK_DEFAULT_F1} Hz for a 1 bit, phase continuous`,
    };
    return { rows, error: null, ready: true };
  } catch (err) {
    return {
      rows: null,
      error: toPanelError(err, "That input could not be encoded."),
      ready: false,
    };
  }
});

const encodeRows = computed(() => encodeState.value.rows);
const canPlay = computed(() => encodeState.value.ready && !optionError.value);

/* ------------------------------------------------------------------ *
 * rendering samples
 * ------------------------------------------------------------------ */

function renderSamples(sampleRate: number): Float32Array {
  if (codec.value === "morse") {
    const morse =
      mode.value === "text-to-morse" ? textToMorse(text.value) : normalizeMorseString(text.value);
    return renderMorseSamples(morse, {
      wpm: wpm.value,
      toneHz: toneHz.value,
      sampleRate,
      amplitude: RENDER_PEAK,
    });
  }
  if (codec.value === "dtmf") {
    return renderDtmfSamples(text.value, {
      toneMs: DTMF_TONE_MS,
      gapMs: DTMF_GAP_MS,
      sampleRate,
      amplitude: RENDER_PEAK,
    });
  }
  return encodeFsk(new TextEncoder().encode(text.value), {
    sampleRate,
    baud: baud.value,
    f0: FSK_DEFAULT_F0,
    f1: FSK_DEFAULT_F1,
    amplitude: RENDER_PEAK,
  });
}

/* ------------------------------------------------------------------ *
 * playback
 *
 * buffer source -> gain -> destination. The buffer is rendered fresh on every
 * press, so a change to the speed or the tone is heard the next time with no
 * cached state to keep in step.
 * ------------------------------------------------------------------ */

let playCtx: AudioContext | null = null;
let playGain: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
/** Bumped on every start and stop so a stale onended cannot clear a newer run. */
let playRun = 0;

/** Volume as gain: squared for a perceptual curve, capped well below full scale. */
function targetGain(): number {
  const level = Math.min(100, Math.max(0, volume.value)) / 100;
  return MAX_GAIN * level * level;
}

async function ensurePlayContext(): Promise<AudioContext> {
  // Created inside the click so the autoplay policy does not suspend it.
  playCtx ??= new AudioContext();
  if (playCtx.state === "suspended") await playCtx.resume();
  if (!playGain) {
    playGain = playCtx.createGain();
    playGain.gain.value = targetGain();
    playGain.connect(playCtx.destination);
  }
  return playCtx;
}

/**
 * Stop whatever is sounding on a 5 ms release rather than dead in its tracks.
 * A buffer cut mid cycle steps straight from half scale to zero, which is a
 * click, and a Morse element or a DTMF burst is exactly the kind of sustained
 * tone that makes one audible.
 */
function stopPlayback() {
  playRun += 1;
  playing.value = false;
  const node = source;
  source = null;
  if (!node) return;
  node.onended = null;

  const ctx = playCtx;
  const gain = playGain;
  if (ctx && gain && ctx.state === "running") {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + RELEASE);
    node.onended = () => node.disconnect();
    try {
      // Stop after the release, so the ramp and not the node ends the sound.
      node.stop(now + RELEASE + 0.01);
      return;
    } catch {
      // Already stopped, which is exactly the state it needs to be in.
    }
  }
  try {
    node.stop();
  } catch {
    // Same.
  }
  node.disconnect();
}

async function play() {
  if (playing.value || !canPlay.value) return;
  actionError.value = null;

  let ctx: AudioContext;
  try {
    ctx = await ensurePlayContext();
  } catch (err) {
    actionError.value = toPanelError(err, "This browser would not start audio playback.");
    return;
  }
  const gain = playGain;
  if (!gain) return;

  let samples: Float32Array;
  try {
    samples = renderSamples(ctx.sampleRate);
  } catch (err) {
    actionError.value = toPanelError(err, "That input could not be rendered to audio.");
    return;
  }
  if (samples.length === 0) {
    actionError.value = {
      message: "There is nothing to play yet.",
      fix: "Type something in the box above first.",
    };
    return;
  }

  stopPlayback();
  const id = ++playRun;
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(gain);
  // Cancel first: the release ramp the previous stop scheduled is still in the
  // future for a few milliseconds, and it would pull this run straight to zero.
  const startAt = ctx.currentTime;
  gain.gain.cancelScheduledValues(startAt);
  gain.gain.setValueAtTime(targetGain(), startAt);
  node.onended = () => {
    if (id !== playRun) return;
    playing.value = false;
    source = null;
  };
  source = node;
  node.start();
  playing.value = true;
}

function togglePlay() {
  if (playing.value) stopPlayback();
  else void play();
}

watch(volume, () => {
  if (!playCtx || !playGain) return;
  playGain.gain.setTargetAtTime(targetGain(), playCtx.currentTime, GLIDE);
});

/* ------------------------------------------------------------------ *
 * WAV download
 * ------------------------------------------------------------------ */

function wavName(): string {
  if (codec.value === "dtmf") {
    const keys = text.value.replace(/[^0-9A-Da-d]/g, "").slice(0, 24) || "tones";
    return `dtmf-${keys.toLowerCase()}.wav`;
  }
  if (codec.value === "fsk") return `data-over-sound-${baud.value}baud.wav`;
  return `morse-${wpm.value}wpm-${toneHz.value}hz.wav`;
}

function downloadWav() {
  actionError.value = null;
  if (!canPlay.value) return;
  // The live context's rate when there is one, so the file matches what plays.
  const sampleRate = playCtx?.sampleRate ?? 44100;
  try {
    const samples = renderSamples(sampleRate);
    if (samples.length === 0) {
      actionError.value = {
        message: "There is nothing to save yet.",
        fix: "Type something in the box above first.",
      };
      return;
    }
    const bytes = encodeWav(samples, sampleRate);
    downloadBlob(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "audio/wav" }), wavName());
  } catch (err) {
    actionError.value = toPanelError(err, "That input could not be rendered to a WAV file.");
  }
}

/* ------------------------------------------------------------------ *
 * the rolling capture window
 *
 * One preallocated buffer that never grows. New blocks land at the end, and
 * once it is full the oldest audio is shifted off the front, so a long listen
 * costs the same memory as a short one and every decode still sees one
 * contiguous run of samples in order.
 * ------------------------------------------------------------------ */

let capture: Float32Array | null = null;
let captureLength = 0;
let captureRate = CAPTURE_RATE;
let pendingSamples = 0;

function resetCapture(rate: number, seconds: number) {
  capture = new Float32Array(Math.max(1, Math.round(rate * seconds)));
  captureLength = 0;
  pendingSamples = 0;
}

function pushSamples(frame: Float32Array) {
  const buffer = capture;
  if (!buffer) return;
  if (frame.length >= buffer.length) {
    buffer.set(frame.subarray(frame.length - buffer.length));
    captureLength = buffer.length;
    return;
  }
  const room = buffer.length - captureLength;
  if (frame.length > room) {
    const drop = frame.length - room;
    buffer.copyWithin(0, drop, captureLength);
    captureLength -= drop;
  }
  buffer.set(frame, captureLength);
  captureLength += frame.length;
}

/* ------------------------------------------------------------------ *
 * decoding what was captured
 * ------------------------------------------------------------------ */

const decodedText = ref("");
const decodedDetail = ref<Record<string, string> | null>(null);
const decodeStatus = ref("");
const decodeError = ref<PanelError | null>(null);
const toneReadout = ref("");
const sourceLabel = ref("");
const meterPeak = ref(0);

const meterDb = computed(() =>
  meterPeak.value > 1e-6 ? 20 * Math.log10(meterPeak.value) : METER_FLOOR_DB,
);
const meterPercent = computed(() => {
  const db = Math.max(METER_FLOOR_DB, Math.min(0, meterDb.value));
  return Math.round(((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100);
});
const meterLabel = computed(() =>
  meterPeak.value > 1e-6 ? `${meterDb.value.toFixed(1)} dBFS` : "silent",
);

function strongestIndex(values: number[]): number {
  let index = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) > (values[index] ?? 0)) index = i;
  }
  return index;
}

/** What the very end of the window sounds like right now, in the codec's own terms. */
function updateToneReadout(view: Float32Array) {
  const block = Math.min(TONE_BLOCK, view.length);
  if (block < 64) {
    toneReadout.value = "";
    return;
  }
  const start = view.length - block;

  if (codec.value === "morse") {
    const amp = goertzel(view, captureRate, toneHz.value, start, block);
    toneReadout.value =
      amp > TONE_FLOOR ? `Key down at ${toneHz.value} Hz` : `Key up, no ${toneHz.value} Hz tone`;
    return;
  }

  if (codec.value === "dtmf") {
    const lows = DTMF_LOW_FREQS.map((hz) => goertzel(view, captureRate, hz, start, block));
    const highs = DTMF_HIGH_FREQS.map((hz) => goertzel(view, captureRate, hz, start, block));
    const lowIndex = strongestIndex(lows);
    const highIndex = strongestIndex(highs);
    if ((lows[lowIndex] ?? 0) > TONE_FLOOR && (highs[highIndex] ?? 0) > TONE_FLOOR) {
      const key = DTMF_KEYPAD[lowIndex]?.[highIndex] ?? "unknown";
      toneReadout.value = `${key} at ${DTMF_LOW_FREQS[lowIndex]} Hz and ${DTMF_HIGH_FREQS[highIndex]} Hz`;
    } else {
      toneReadout.value = "No tone pair right now";
    }
    return;
  }

  const space = goertzel(view, captureRate, FSK_DEFAULT_F0, start, block);
  const mark = goertzel(view, captureRate, FSK_DEFAULT_F1, start, block);
  if (Math.max(space, mark) <= TONE_FLOOR) {
    toneReadout.value = "No carrier right now";
  } else if (mark > space) {
    toneReadout.value = `Mark, ${FSK_DEFAULT_F1} Hz, a 1 bit`;
  } else {
    toneReadout.value = `Space, ${FSK_DEFAULT_F0} Hz, a 0 bit`;
  }
}

/**
 * Decode the whole window again.
 *
 * `live` separates the two ways a failure reads. While the microphone is open,
 * a data frame that has not finished arriving is the normal state rather than
 * a problem to shout about, so those go to the status line and whatever
 * decoded last stays on screen. A dropped file gets one attempt, so its
 * failures are real errors with a fix hint.
 */
function decodeCaptured(live: boolean) {
  const buffer = capture;
  if (!buffer || captureLength === 0) return;
  const view = buffer.subarray(0, captureLength);
  updateToneReadout(view);

  try {
    if (codec.value === "morse") {
      const decoded = decodeMorseFromEnvelope(envelopeFromSamples(view, captureRate, toneHz.value));
      decodedText.value = decoded.text;
      decodedDetail.value = decoded.morse
        ? {
            Morse: decoded.morse,
            Speed: `${Math.round(decoded.wpm)} WPM, dit ${round(decoded.ditMs, 1)} ms`,
          }
        : null;
      decodeStatus.value = decoded.text ? "" : "No Morse in what has been heard so far.";
    } else if (codec.value === "dtmf") {
      const keys = decodeDtmf(view, captureRate);
      decodedText.value = keys;
      decodedDetail.value = keys ? { Keys: keys, "Tone pairs": dtmfSequence(keys) } : null;
      decodeStatus.value = keys ? "" : "No keypad tones in what has been heard so far.";
    } else {
      const bytes = decodeFsk(view, captureRate, {
        baud: baud.value,
        f0: FSK_DEFAULT_F0,
        f1: FSK_DEFAULT_F1,
      });
      decodedText.value = new TextDecoder().decode(bytes);
      decodedDetail.value = {
        Payload: `${bytes.length} bytes of UTF-8`,
        Checksum: "CRC-16 matched, so the payload arrived intact",
      };
      decodeStatus.value = "";
    }
    decodeError.value = null;
  } catch (err) {
    if (live) {
      decodeStatus.value =
        err instanceof ToolError && err.code === "bad-checksum"
          ? "A frame arrived corrupted. Move the devices closer, quiet the room, or drop the baud rate."
          : "Listening for a complete frame.";
      decodeError.value = null;
    } else {
      decodeError.value = toPanelError(err, "That audio could not be decoded.");
    }
  }
}

function clearDecode() {
  decodedText.value = "";
  decodedDetail.value = null;
  decodeStatus.value = "";
  decodeError.value = null;
  toneReadout.value = "";
  meterPeak.value = 0;
}

/* ------------------------------------------------------------------ *
 * the microphone
 * ------------------------------------------------------------------ */

let micStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let micSink: GainNode | null = null;
let decodeTimer: ReturnType<typeof setInterval> | null = null;

const listening = ref(false);
const startingMic = ref(false);
const micError = ref<PanelError | null>(null);

function createCaptureContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: CAPTURE_RATE });
  } catch {
    // A browser that will not run a graph at this rate gets its own default,
    // which only costs a little more work per decode.
    return new AudioContext();
  }
}

function onAudioProcess(event: AudioProcessingEvent) {
  const input = event.inputBuffer.getChannelData(0);
  pushSamples(input);
  pendingSamples += input.length;

  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  const rms = Math.sqrt(sum / Math.max(1, input.length));
  meterPeak.value = Math.max(rms, meterPeak.value * PEAK_DECAY);
}

function onDecodeTick() {
  if (pendingSamples === 0) return;
  pendingSamples = 0;
  decodeCaptured(true);
}

async function startListening() {
  if (listening.value || startingMic.value) return;
  micError.value = null;
  stopPlayback();

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    micError.value = {
      message: "This browser will not hand out microphone access on this page.",
      fix: "Open the page over https in a recent version of Chrome, Edge, Firefox, or Safari, then press Listen again.",
    };
    return;
  }

  startingMic.value = true;
  try {
    // Every browser cleanup stage is switched off. Echo cancellation, noise
    // suppression and automatic gain all reshape the waveform, and all three
    // detectors here measure the waveform rather than listen to it.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });

    const ctx = createCaptureContext();
    micCtx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    captureRate = ctx.sampleRate;
    resetCapture(captureRate, CAPTURE_SECONDS);
    clearDecode();

    micSource = ctx.createMediaStreamSource(micStream);
    processor = ctx.createScriptProcessor(PROCESSOR_SIZE, 1, 1);
    processor.onaudioprocess = onAudioProcess;
    // A silent sink. Some browsers only run a processor whose output reaches
    // the destination, and routing a live microphone to the speakers at any
    // audible gain is an instant feedback loop.
    micSink = ctx.createGain();
    micSink.gain.value = 0;
    micSource.connect(processor);
    processor.connect(micSink);
    micSink.connect(ctx.destination);

    for (const track of micStream.getTracks()) {
      track.addEventListener("ended", () => stopListening());
    }

    sourceLabel.value = "Microphone";
    listening.value = true;
    decodeTimer = setInterval(onDecodeTick, DECODE_INTERVAL_MS[codec.value]);
  } catch (err) {
    micError.value = describeMicError(err);
    stopListening();
  } finally {
    startingMic.value = false;
  }
}

function stopListening() {
  if (decodeTimer !== null) {
    clearInterval(decodeTimer);
    decodeTimer = null;
  }
  listening.value = false;
  meterPeak.value = 0;

  if (processor) {
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
    } catch {
      // The graph is already torn down, which is the state it needs to be in.
    }
  }
  processor = null;
  try {
    micSource?.disconnect();
    micSink?.disconnect();
  } catch {
    // Same: disconnecting twice is not a problem worth reporting.
  }
  micSource = null;
  micSink = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  if (micCtx && micCtx.state !== "closed") void micCtx.close().catch(() => {});
  micCtx = null;
}

function toggleListening() {
  if (listening.value) stopListening();
  else void startListening();
}

/* ------------------------------------------------------------------ *
 * offline decode of a dropped file
 * ------------------------------------------------------------------ */

const decodingFile = ref(false);

/** Average the channels, since every detector here works on one mono track. */
function toMono(buffer: AudioBuffer, maxSamples: number): Float32Array {
  const length = Math.min(buffer.length, maxSamples);
  const out = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  if (buffer.numberOfChannels > 1) {
    for (let i = 0; i < length; i++) out[i] /= buffer.numberOfChannels;
  }
  return out;
}

async function readFile(file: File) {
  stopListening();
  stopPlayback();
  clearDecode();
  decodingFile.value = true;
  sourceLabel.value = file.name;
  try {
    const ctx = await ensurePlayContext();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // decodeAudioData detaches the buffer it is handed, so it gets a copy.
    const decoded = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    captureRate = decoded.sampleRate;
    const mono = toMono(decoded, Math.round(decoded.sampleRate * FILE_SECONDS));
    capture = mono;
    captureLength = mono.length;
    pendingSamples = 0;
    decodeCaptured(false);
    if (decoded.length > mono.length) {
      decodeStatus.value = `Only the first ${FILE_SECONDS / 60} minutes of this file were decoded.`;
    }
  } catch (err) {
    decodeError.value = {
      message: `That file could not be decoded as audio: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Try a WAV, MP3, FLAC, OGG or M4A file that this browser can play.",
    };
  } finally {
    decodingFile.value = false;
  }
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

/* ------------------------------------------------------------------ *
 * mode changes, fragment state, and teardown
 * ------------------------------------------------------------------ */

function setMode(next: Mode) {
  if (mode.value === next) return;
  mode.value = next;
  stopPlayback();
  stopListening();
  clearDecode();
  actionError.value = null;
}

let ready = false;

watch([text, mode], () => {
  if (!ready) return;
  writeFragment({ input: text.value, opts: { mode: mode.value } });
});

function onVisibilityChange() {
  if (!document.hidden) return;
  stopPlayback();
  stopListening();
}

onMounted(() => {
  const state = readFragment();
  if (state.input) text.value = state.input;
  const fromHash = state.opts["mode"];
  if (fromHash && isMode(fromHash)) mode.value = fromHash;
  ready = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopPlayback();
  stopListening();
  if (playCtx && playCtx.state !== "closed") void playCtx.close().catch(() => {});
  playCtx = null;
  playGain = null;
  capture = null;
  captureLength = 0;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- mode -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Mode
      </span>
      <div
        class="inline-flex flex-wrap gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
      >
        <Button
          v-for="choice in modeChoices"
          :key="choice.value"
          variant="ghost"
          size="sm"
          :aria-pressed="mode === choice.value"
          :class="mode === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setMode(choice.value)"
        >
          {{ choice.label }}
        </Button>
      </div>
    </div>

    <!-- encode: the input, the options, and the transport -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-col gap-1.5">
        <Label for="audio-data-input" class="text-xs text-muted-foreground">
          {{ inputLabel }}
        </Label>
        <Textarea
          id="audio-data-input"
          v-model="text"
          :placeholder="inputPlaceholder"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="min-h-20 bg-card font-mono"
        />
      </div>

      <div class="flex flex-wrap items-end gap-4">
        <template v-if="codec === 'morse'">
          <div class="flex w-28 flex-col gap-1.5">
            <Label for="audio-data-wpm" class="text-xs text-muted-foreground">Speed (WPM)</Label>
            <Input
              id="audio-data-wpm"
              type="number"
              :min="WPM.min"
              :max="WPM.max"
              :step="WPM.step"
              :model-value="wpm"
              class="h-9 bg-card tabular-nums"
              :aria-invalid="optionError ? 'true' : undefined"
              @update:model-value="(v) => (wpm = Number(v))"
            />
          </div>
          <div class="flex w-28 flex-col gap-1.5">
            <Label for="audio-data-tone" class="text-xs text-muted-foreground">Tone (Hz)</Label>
            <Input
              id="audio-data-tone"
              type="number"
              :min="TONE.min"
              :max="TONE.max"
              :step="TONE.step"
              :model-value="toneHz"
              class="h-9 bg-card tabular-nums"
              @update:model-value="(v) => (toneHz = Number(v))"
            />
          </div>
        </template>

        <div v-else-if="codec === 'fsk'" class="flex w-32 flex-col gap-1.5">
          <Label for="audio-data-baud" class="text-xs text-muted-foreground">Speed (baud)</Label>
          <Input
            id="audio-data-baud"
            type="number"
            :min="BAUD.min"
            :max="BAUD.max"
            :step="BAUD.step"
            :model-value="baud"
            class="h-9 bg-card tabular-nums"
            :aria-invalid="optionError ? 'true' : undefined"
            @update:model-value="(v) => (baud = Number(v))"
          />
        </div>

        <div class="flex min-w-44 flex-1 flex-col gap-1.5">
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
          <Button type="button" :disabled="!canPlay" @click="togglePlay">
            <Square v-if="playing" class="size-3.5" aria-hidden="true" />
            <Play v-else class="size-3.5" aria-hidden="true" />
            {{ playing ? "Stop" : playLabel }}
          </Button>
          <Button type="button" variant="outline" :disabled="!canPlay" @click="downloadWav">
            <Download class="size-3.5" aria-hidden="true" />
            WAV
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Start quiet and raise the volume slowly, especially on headphones. This slider tops out at
        half of full scale, and nothing plays until you press {{ playLabel }}.
      </p>
    </div>

    <!-- errors from the input, the options, or the transport -->
    <template v-for="err in [optionError, encodeState.error, actionError]" :key="err?.message">
      <ErrorBanner v-if="err" :message="err.message" :hint="err.fix" />
    </template>

    <!-- the symbolic representation -->
    <OutputView v-if="encodeRows" :output="encodeRows" />

    <p v-else class="text-sm text-muted-foreground">
      {{
        codec === "dtmf"
          ? "Type a dial string to see the tone pair behind every key."
          : codec === "fsk"
            ? "Type something to see the frame, the bit stream and the checksum that carry it."
            : "Type something to see the dots and dashes, the timing, and how long it takes to send."
      }}
    </p>

    <!-- decode: microphone or a dropped file -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Listen and decode
        </span>
        <div class="flex items-center gap-2">
          <Button
            type="button"
            :variant="listening ? 'default' : 'outline'"
            size="sm"
            :disabled="startingMic"
            @click="toggleListening"
          >
            <MicOff v-if="listening" class="size-3.5" aria-hidden="true" />
            <Mic v-else class="size-3.5" aria-hidden="true" />
            {{ listening ? "Stop listening" : startingMic ? "Starting" : "Listen" }}
          </Button>
        </div>
      </div>

      <FileDrop
        compact
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
        label="Drop a recording here or click to choose"
        hint="WAV, MP3, FLAC, OGG or M4A"
        @files="onFiles"
      />

      <!-- signal level -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
          <span>Signal level</span>
          <span>{{ listening ? meterLabel : "not listening" }}</span>
        </div>
        <div
          class="h-2 w-full overflow-hidden rounded-full bg-[var(--accent-soft)] shadow-[var(--sh-inset)]"
        >
          <div
            class="h-full rounded-full bg-[image:var(--grad-brand)] transition-[width] duration-[120ms] ease-out"
            :style="{ width: `${listening ? meterPercent : 0}%` }"
          />
        </div>
      </div>

      <dl class="grid gap-1 text-xs sm:grid-cols-2">
        <div class="flex gap-2">
          <dt class="text-muted-foreground">Detected tone</dt>
          <dd class="font-mono">{{ toneReadout || "waiting" }}</dd>
        </div>
        <div class="flex min-w-0 gap-2">
          <dt class="text-muted-foreground">Source</dt>
          <dd class="truncate font-mono">{{ sourceLabel || "none yet" }}</dd>
        </div>
      </dl>

      <div class="rounded-[8px] bg-card p-3 shadow-[var(--sh-sm)]">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">Decoded</span>
          <CopyButton v-if="decodedText" :text="decodedText" label="Copy" />
        </div>
        <p
          class="mt-1 max-h-40 overflow-y-auto font-mono text-sm break-words whitespace-pre-wrap"
          aria-live="polite"
        >
          {{ decodedText || (decodingFile ? "Decoding the file" : "Nothing decoded yet") }}
        </p>
      </div>

      <OutputView v-if="decodedDetail" :output="decodedDetail" />

      <p v-if="decodeStatus" class="text-xs text-muted-foreground">{{ decodeStatus }}</p>

      <template v-for="err in [micError, decodeError]" :key="err?.message">
        <ErrorBanner v-if="err" :message="err.message" :hint="err.fix" />
      </template>

      <p class="text-xs text-muted-foreground">
        Press Listen to decode through the microphone, or drop a WAV or other audio file here to
        decode a recording. Listening keeps the last {{ CAPTURE_SECONDS }} seconds and reads them
        again several times a second, so anything older than that scrolls off the front. The
        microphone stops when you leave this tab.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      Every translation, every tone and every decode runs in this tab: your files and inputs never
      leave your device. Sound is the one exception, and it is the point, since tones played out
      loud can be heard by anyone in the room.
    </p>
  </div>
</template>
