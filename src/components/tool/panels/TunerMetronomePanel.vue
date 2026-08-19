<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { CircleAlert, Mic, Play, Square } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  TIME_SIGNATURES,
  TUNINGS,
  bpmFromTaps,
  clickSchedule,
  describeTempo,
  detectPitch,
  frequencyToNote,
  getTimeSignature,
  getTuning,
  nearestString,
  renderClickSamples,
  rms,
  type ClickEvent,
  type NearestStringResult,
  type NoteInfo,
  type TimeSignature,
} from "@/tools/tuner-metronome/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Bespoke panel for the Tuner & Metronome.
 *
 * The generic ToolShell reads a textarea, and neither half of this tool fits
 * that shape: one listens to a microphone and one has to make a sound at an
 * exact time. So this file owns the two live audio graphs, and nothing else.
 * Every number it shows or plays still comes from the pure layer at
 * `src/tools/tuner-metronome/` (PROJECT.md rule 27): detectPitch, rms,
 * frequencyToNote, nearestString, clickSchedule, bpmFromTaps, describeTempo,
 * and renderClickSamples.
 *
 * Two deliberate choices worth knowing about:
 *
 * - Pitch detection runs on a 40 ms timer, not on every animation frame. The
 *   NSDF is O(window * window / 2), so analysing 60 times a second would burn
 *   a core for a needle that cannot move that fast anyway. Silence is cheap:
 *   detectPitch bails on its own RMS check before the expensive loop.
 * - The metronome never fires a click from a timer. A 25 ms interval books the
 *   next 100 ms of clicks onto the audio clock with `source.start(time)`, one
 *   bar of `clickSchedule` at a time so beat numbering stays continuous across
 *   refills. The timer can be late by a whole frame and the beat still lands
 *   on the sample it was booked for.
 *
 * Nothing starts on its own: the microphone opens only on the Start tuner
 * click, audio only sounds after Start, and both stop on unmount and whenever
 * the tab is hidden.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Analyser window. 4096 samples reaches down past a 4 string bass low E. */
const FFT_SIZE = 4096;
/** Detection cadence, about 25 readings a second. */
const DETECT_INTERVAL_MS = 40;
/** How many detections the median is taken over, so the needle stops jittering. */
const HOLD_SIZE = 5;
/** Consecutive empty readings tolerated before the display clears. */
const MAX_MISSES = 3;
/** Clarity a reading needs before it counts. A little looser than the default. */
const CLARITY_THRESHOLD = 0.78;
/** Widest cents offset the needle track shows, either side of centre. */
const CENTS_RANGE = 50;
/** The needle track's gridlines, in cents. */
const CENTS_TICKS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];
/** Quietest RMS the input meter draws as anything at all. */
const LEVEL_FLOOR = 0.0015;

/** Tempo range the panel offers. Narrower than the logic layer's 20 to 400. */
const BPM_MIN = 30;
const BPM_MAX = 300;
/** Taps kept for the running estimate. */
const MAX_TAPS = 8;
/** A gap this long ends a tap run and starts a new one. */
const TAP_RESET_MS = 3000;

/** Scheduler cadence and how far ahead of the audio clock clicks are booked. */
const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_SECONDS = 0.1;
/** Head start on the first bar, so the opening click is never already late. */
const START_OFFSET_SECONDS = 0.12;
/** Hard output ceiling. The volume slider at 100 lands here, never at full scale. */
const MAX_GAIN = 0.9;
/** Secondary accents sit under the downbeat; subdivisions sit under the beat. */
const SECONDARY_ACCENT_GAIN = 0.7;
const SUBDIVISION_GAIN = 0.45;
/** Time constant for a smooth volume change while the click is running. */
const GLIDE = 0.02;

/* ------------------------------------------------------------------ *
 * option specs, read from the tool meta so the dropdowns stay in sync
 * ------------------------------------------------------------------ */

const TUNING_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "tuning",
  label: "Tuning",
  default: "chromatic",
  options: TUNINGS.map((t) => ({ value: t.id, label: t.name, synonyms: [t.instrument] })),
};

const TIME_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "timeSignature",
  label: "Time signature",
  default: "4/4",
  options: TIME_SIGNATURES.map((t) => ({ value: t.id, label: t.label, synonyms: [t.id] })),
};

/** Subdivisions are a panel only control, so this spec is local. */
const SUBDIVISION_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "tm-subdivision",
  label: "Subdivision",
  default: "1",
  options: [
    {
      value: "1",
      label: "Beats only",
      synonyms: ["quarter notes", "plain beat", "no subdivision", "one per beat"],
    },
    {
      value: "2",
      label: "Eighth notes, 2 per beat",
      synonyms: ["eighths", "quavers", "duple", "two per beat"],
    },
    {
      value: "3",
      label: "Triplets, 3 per beat",
      synonyms: ["triplet", "swing", "shuffle", "three per beat"],
    },
    {
      value: "4",
      label: "Sixteenth notes, 4 per beat",
      synonyms: ["sixteenths", "semiquavers", "four per beat"],
    },
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

const tuningSpec = computed(() => selectSpec("tuning", TUNING_FALLBACK));
const timeSpec = computed(() => selectSpec("timeSignature", TIME_FALLBACK));

/* ------------------------------------------------------------------ *
 * shared state
 * ------------------------------------------------------------------ */

interface PanelError {
  message: string;
  fix: string;
}

const tab = ref<"tuner" | "metronome">("tuner");

/* ------------------------------------------------------------------ *
 * tuner: live objects
 *
 * Kept in plain lets, never in refs: Vue must not wrap a live MediaStreamTrack
 * or AudioNode in a reactive proxy.
 * ------------------------------------------------------------------ */

let micStream: MediaStream | null = null;
let tunerCtx: AudioContext | null = null;
let tunerSource: MediaStreamAudioSourceNode | null = null;
let tunerAnalyser: AnalyserNode | null = null;
/** Explicitly backed by a plain ArrayBuffer: getFloatTimeDomainData rejects the
 * default ArrayBufferLike widening, which would allow a SharedArrayBuffer. */
let tunerBuffer: Float32Array<ArrayBuffer> | null = null;
let tunerTimer: ReturnType<typeof setInterval> | null = null;
/** The last few accepted frequencies, oldest first. The needle shows the median. */
let holdWindow: number[] = [];
let misses = 0;

/* ------------------------------------------------------------------ *
 * tuner: reactive state
 * ------------------------------------------------------------------ */

const listening = ref(false);
const startingMic = ref(false);
const micError = ref<PanelError | null>(null);
const detectedHz = ref<number | null>(null);
const clarity = ref(0);
const inputLevel = ref(0);

const a4Text = ref(String(numberDefault("a4", 440)));
const tuningId = ref(TUNING_FALLBACK.default);

const a4 = computed(() => {
  const value = Number(a4Text.value);
  if (!Number.isFinite(value) || value < 415 || value > 466) return 440;
  return value;
});

const a4Error = computed<PanelError | null>(() => {
  const value = Number(a4Text.value);
  if (a4Text.value.trim() === "" || !Number.isFinite(value) || value < 415 || value > 466) {
    return {
      message: `The A4 reference must be between 415 Hz and 466 Hz, and "${a4Text.value}" is not.`,
      fix: "Use 440 for concert pitch, 442 for many orchestras, or 415 for baroque tuning. The tuner is using 440 until this is fixed.",
    };
  }
  return null;
});

const tuning = computed(() => {
  try {
    return getTuning(tuningId.value);
  } catch {
    return getTuning("chromatic");
  }
});

/* ------------------------------------------------------------------ *
 * tuner: microphone
 * ------------------------------------------------------------------ */

/**
 * Turns a getUserMedia rejection into the message plus the fix hint the design
 * rules require. The names below are the ones a visitor can act on; anything
 * else falls through to the raw message.
 */
function describeMicError(err: unknown): PanelError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message: "Permission to use the microphone was denied, so the tuner cannot listen.",
      fix: "Click the lock or microphone icon at the left of your browser address bar, set the microphone to Allow, reload the page, then press Start tuner again.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      message: "No microphone was found on this device.",
      fix: "Plug one in (a headset counts as a microphone), then press Start tuner again.",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      message: "The microphone is already in use by another app, so this page cannot open it.",
      fix: "Close any call, recording, or audio app that is holding the microphone, then press Start tuner again.",
    };
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return {
      message: "The microphone could not be opened with the settings the tuner asked for.",
      fix: "Try a different microphone in your system sound settings, then press Start tuner again.",
    };
  }
  return {
    message: `The microphone could not be started: ${err instanceof Error ? err.message : String(err)}`,
    fix: "Check that no other app is using the microphone, then press Start tuner again.",
  };
}

async function startTuner() {
  if (listening.value || startingMic.value) return;
  micError.value = null;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    micError.value = {
      message: "This browser will not hand out microphone access on this page.",
      fix: "Open the page over https in a recent version of Chrome, Edge, Firefox, or Safari, then press Start tuner again.",
    };
    return;
  }

  startingMic.value = true;
  try {
    // Every browser cleanup stage is switched off: echo cancellation, noise
    // suppression, and automatic gain all reshape the waveform, and a tuner
    // needs the raw period, not a tidied one.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });

    tunerCtx = new AudioContext();
    if (tunerCtx.state === "suspended") await tunerCtx.resume();
    tunerSource = tunerCtx.createMediaStreamSource(micStream);
    tunerAnalyser = tunerCtx.createAnalyser();
    tunerAnalyser.fftSize = FFT_SIZE;
    tunerAnalyser.smoothingTimeConstant = 0;
    // Deliberately not connected to the destination: routing a live microphone
    // to the speakers is an instant feedback loop.
    tunerSource.connect(tunerAnalyser);
    tunerBuffer = new Float32Array(tunerAnalyser.fftSize);

    holdWindow = [];
    misses = 0;
    detectedHz.value = null;
    clarity.value = 0;
    inputLevel.value = 0;

    for (const track of micStream.getTracks()) {
      track.addEventListener("ended", () => stopTuner());
    }

    listening.value = true;
    tunerTimer = setInterval(readPitch, DETECT_INTERVAL_MS);
  } catch (err) {
    micError.value = describeMicError(err);
    stopTuner();
  } finally {
    startingMic.value = false;
  }
}

function stopTuner() {
  if (tunerTimer !== null) {
    clearInterval(tunerTimer);
    tunerTimer = null;
  }
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  try {
    tunerSource?.disconnect();
  } catch {
    // The graph is already torn down, which is the state it needs to be in.
  }
  tunerSource = null;
  tunerAnalyser = null;
  tunerBuffer = null;
  if (tunerCtx && tunerCtx.state !== "closed") void tunerCtx.close().catch(() => {});
  tunerCtx = null;
  holdWindow = [];
  misses = 0;
  listening.value = false;
  detectedHz.value = null;
  clarity.value = 0;
  inputLevel.value = 0;
}

function toggleTuner() {
  if (listening.value) stopTuner();
  else void startTuner();
}

/** Middle value of a short run, which ignores one wild reading entirely. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function readPitch() {
  const analyser = tunerAnalyser;
  const buffer = tunerBuffer;
  const ctx = tunerCtx;
  if (!analyser || !buffer || !ctx) return;

  analyser.getFloatTimeDomainData(buffer);
  inputLevel.value = rms(buffer);

  let frequency: number | null;
  try {
    const result = detectPitch(buffer, ctx.sampleRate, { clarityThreshold: CLARITY_THRESHOLD });
    frequency = result.frequency;
    clarity.value = result.clarity;
  } catch {
    // detectPitch only throws on a bad sample rate, which cannot happen from a
    // live context. Skipping the frame is still better than breaking the loop.
    return;
  }

  if (frequency === null) {
    misses += 1;
    // One dropped reading in the tail of a note should not blank the display,
    // so the hold only clears after a few in a row.
    if (misses > MAX_MISSES) {
      holdWindow = [];
      detectedHz.value = null;
    }
    return;
  }

  misses = 0;
  holdWindow.push(frequency);
  if (holdWindow.length > HOLD_SIZE) holdWindow.shift();
  detectedHz.value = median(holdWindow);
}

/* ------------------------------------------------------------------ *
 * tuner: presentation
 * ------------------------------------------------------------------ */

interface Reading {
  hz: number;
  note: NoteInfo;
  match: NearestStringResult;
}

const reading = computed<Reading | null>(() => {
  const hz = detectedHz.value;
  if (hz === null || !Number.isFinite(hz) || hz <= 0) return null;
  try {
    return {
      hz,
      note: frequencyToNote(hz, a4.value),
      match: nearestString(hz, tuning.value.id, a4.value),
    };
  } catch {
    return null;
  }
});

/** The needle follows the string the chips point at, so the two never disagree. */
const cents = computed(() => reading.value?.match.cents ?? 0);

const needlePercent = computed(() => {
  const clamped = Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, cents.value));
  return 50 + clamped;
});

function toneClass(value: number, kind: "bg" | "text"): string {
  const magnitude = Math.abs(value);
  if (magnitude <= 5) return kind === "bg" ? "bg-positive" : "text-positive";
  if (magnitude <= 15) {
    return kind === "bg" ? "bg-amber-500 dark:bg-amber-400" : "text-amber-700 dark:text-amber-400";
  }
  return kind === "bg" ? "bg-destructive" : "text-destructive";
}

const needleClass = computed(() => toneClass(cents.value, "bg"));
const centsTextClass = computed(() => toneClass(cents.value, "text"));

const centsLabel = computed(() => {
  const value = Math.round(cents.value * 10) / 10;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} cents`;
});

const noteLabel = computed(() => (reading.value ? reading.value.note.name : "--"));
const octaveLabel = computed(() => (reading.value ? String(reading.value.note.octave) : ""));

const frequencyLabel = computed(() =>
  reading.value ? `${(Math.round(reading.value.hz * 100) / 100).toFixed(2)} Hz` : null,
);

const targetLabel = computed(() =>
  reading.value
    ? `${reading.value.match.note} at ${(Math.round(reading.value.match.targetHz * 100) / 100).toFixed(2)} Hz`
    : null,
);

const adviceLabel = computed(() => reading.value?.match.advice ?? null);

const clarityPercent = computed(() => Math.round(clarity.value * 100));

/** Input level as a 0 to 100 bar, on a rough decibel curve so quiet is visible. */
const levelPercent = computed(() => {
  const value = inputLevel.value;
  if (!(value > LEVEL_FLOOR)) return 0;
  const db = 20 * Math.log10(value);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
});

const tunerStatus = computed(() => {
  if (!listening.value) return "The microphone is off. Nothing is captured until you press Start.";
  if (reading.value) return "Holding the median of the last five readings.";
  return "Play a note. One string at a time, and let it ring.";
});

/* ------------------------------------------------------------------ *
 * metronome: live objects
 * ------------------------------------------------------------------ */

let metroCtx: AudioContext | null = null;
let metroGain: GainNode | null = null;
let clickBuffers: { accent: AudioBuffer; normal: AudioBuffer } | null = null;
let scheduleTimer: ReturnType<typeof setInterval> | null = null;
/** Clicks generated but not yet booked onto the audio clock. */
let clickQueue: ClickEvent[] = [];
/** Audio time the next bar of the schedule starts at. */
let barStart = 0;
/** Every booked source, so a stop can silence what is already scheduled. */
const bookedSources = new Set<AudioBufferSourceNode>();
/** Pending beat indicator timers, cleared on stop so the dots do not keep moving. */
const visualTimers = new Set<ReturnType<typeof setTimeout>>();
/** Tap timestamps on the monotonic clock, oldest first. */
let taps: number[] = [];

/* ------------------------------------------------------------------ *
 * metronome: reactive state
 * ------------------------------------------------------------------ */

const running = ref(false);
const metroError = ref<PanelError | null>(null);
const bpmText = ref("120");
const timeSignatureId = ref(TIME_FALLBACK.default);
const subdivisionText = ref("1");
const volume = ref(50);
const currentBeat = ref(0);
const tapCount = ref(0);

const bpm = computed(() => {
  const value = Math.round(Number(bpmText.value));
  if (!Number.isFinite(value)) return 120;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, value));
});

const bpmError = computed<PanelError | null>(() => {
  const value = Number(bpmText.value);
  if (
    bpmText.value.trim() === "" ||
    !Number.isFinite(value) ||
    value < BPM_MIN ||
    value > BPM_MAX
  ) {
    return {
      message: `The tempo must be between ${BPM_MIN} and ${BPM_MAX} bpm, and "${bpmText.value}" is not.`,
      fix: `Type a tempo between ${BPM_MIN} and ${BPM_MAX}, drag the slider, or tap it in. The metronome is using ${bpm.value} bpm until this is fixed.`,
    };
  }
  return null;
});

const signature = computed<TimeSignature>(() => {
  try {
    return getTimeSignature(timeSignatureId.value);
  } catch {
    return getTimeSignature("4/4");
  }
});

const subdivision = computed(() => {
  const value = Math.round(Number(subdivisionText.value));
  if (!Number.isFinite(value) || value < 1 || value > 4) return 1;
  return value;
});

const tempo = computed(() => {
  try {
    return describeTempo(bpm.value);
  } catch {
    return null;
  }
});

const msPerBeat = computed(() => Math.round((60000 / bpm.value) * 10) / 10);

const beats = computed(() => Array.from({ length: signature.value.beatsPerBar }, (_, i) => i + 1));

function isAccentBeat(beat: number): boolean {
  return signature.value.accentBeats.includes(beat);
}

/* ------------------------------------------------------------------ *
 * metronome: the audio graph and the lookahead scheduler
 * ------------------------------------------------------------------ */

/** Volume as gain: squared for a perceptual curve, capped below full scale. */
function targetGain(): number {
  const v = Math.min(100, Math.max(0, volume.value)) / 100;
  return MAX_GAIN * v * v;
}

async function ensureMetroContext(): Promise<AudioContext> {
  // Created inside the click so the autoplay policy does not suspend it.
  if (!metroCtx || metroCtx.state === "closed") {
    metroCtx = new AudioContext();
    metroGain = null;
    clickBuffers = null;
  }
  if (metroCtx.state === "suspended") await metroCtx.resume();
  if (!metroGain) {
    metroGain = metroCtx.createGain();
    metroGain.gain.value = targetGain();
    metroGain.connect(metroCtx.destination);
  }
  if (!clickBuffers) clickBuffers = makeClickBuffers(metroCtx);
  return metroCtx;
}

/**
 * Both click sounds, rendered once per context. A new context can come up at a
 * different sample rate, so these are rebuilt with it rather than cached
 * globally.
 */
function makeClickBuffers(ctx: AudioContext): { accent: AudioBuffer; normal: AudioBuffer } {
  function toBuffer(accent: boolean): AudioBuffer {
    const samples = renderClickSamples(ctx.sampleRate, { accent });
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }
  return { accent: toBuffer(true), normal: toBuffer(false) };
}

/**
 * Append exactly one bar to the queue.
 *
 * One bar at a time is what keeps the beat numbers right: clickSchedule always
 * starts its count at beat 1, so asking for an arbitrary window every tick
 * would move the accents around. A bar is also small enough that the count
 * never approaches the 4096 event ceiling.
 */
function fillBar(): boolean {
  const sig = signature.value;
  const count = sig.beatsPerBar * subdivision.value;
  try {
    clickQueue.push(
      ...clickSchedule(bpm.value, sig.beatsPerBar, subdivision.value, barStart, count),
    );
  } catch (err) {
    metroError.value = {
      message: `The click schedule could not be built: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Pick a tempo, time signature, and subdivision from the controls above, then press Start again.",
    };
    stopMetronome();
    return false;
  }
  barStart += (sig.beatsPerBar * 60) / bpm.value;
  return true;
}

function bookClick(ev: ClickEvent) {
  const ctx = metroCtx;
  const out = metroGain;
  const buffers = clickBuffers;
  if (!ctx || !out || !buffers) return;

  const accented = !ev.isSubdivision && isAccentBeat(ev.beat);
  const source = ctx.createBufferSource();
  source.buffer = accented ? buffers.accent : buffers.normal;

  // The downbeat plays the accent click at full level, secondary accents play
  // it softer, and subdivisions sit well under the beat, so the bar has a
  // shape rather than a row of identical ticks.
  let level = 1;
  if (ev.isSubdivision) level = SUBDIVISION_GAIN;
  else if (accented && !ev.isDownbeat) level = SECONDARY_ACCENT_GAIN;

  if (level === 1) {
    source.connect(out);
  } else {
    const trim = ctx.createGain();
    trim.gain.value = level;
    source.connect(trim);
    trim.connect(out);
  }

  source.onended = () => {
    source.onended = null;
    bookedSources.delete(source);
  };
  bookedSources.add(source);
  source.start(ev.time);

  // The dots follow the same booked time, converted back to a wall clock delay.
  if (!ev.isSubdivision) {
    const delay = Math.max(0, (ev.time - ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      visualTimers.delete(timer);
      currentBeat.value = ev.beat;
    }, delay);
    visualTimers.add(timer);
  }
}

function scheduleTick() {
  const ctx = metroCtx;
  if (!ctx || !running.value) return;
  const horizon = ctx.currentTime + LOOKAHEAD_SECONDS;

  // Refill until the queue reaches past the horizon. The guard only matters if
  // a tab wakes from a long freeze with a stale barStart far in the past.
  let guard = 0;
  while (clickQueue.length === 0 || (clickQueue[clickQueue.length - 1]?.time ?? 0) < horizon) {
    if (!fillBar()) return;
    if (++guard > 16) break;
  }

  while (clickQueue.length > 0 && (clickQueue[0]?.time ?? 0) < horizon) {
    const ev = clickQueue.shift();
    if (!ev) break;
    // A click whose moment has already passed (a frozen tab, a suspended
    // context) is dropped rather than fired late and out of time.
    if (ev.time >= ctx.currentTime) bookClick(ev);
  }
}

/** Silence and forget everything already booked, keeping the context alive. */
function clearScheduled() {
  for (const timer of visualTimers) clearTimeout(timer);
  visualTimers.clear();
  for (const source of bookedSources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped, which is exactly the state it needs to be in.
    }
  }
  bookedSources.clear();
  clickQueue = [];
}

async function startMetronome() {
  if (running.value) return;
  metroError.value = null;

  let ctx: AudioContext;
  try {
    ctx = await ensureMetroContext();
  } catch (err) {
    metroError.value = {
      message: `This browser would not start audio playback: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check that the tab is not muted in your browser, then press Start again.",
    };
    return;
  }

  clearScheduled();
  metroGain?.gain.setValueAtTime(targetGain(), ctx.currentTime);
  barStart = ctx.currentTime + START_OFFSET_SECONDS;
  currentBeat.value = 0;
  running.value = true;
  scheduleTick();
  // Two fast Start presses can both clear the running guard while the context
  // is still resuming, so the older interval is cleared before it is orphaned.
  if (scheduleTimer !== null) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(scheduleTick, SCHEDULE_INTERVAL_MS);
}

function stopMetronome() {
  if (scheduleTimer !== null) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
  clearScheduled();
  running.value = false;
  currentBeat.value = 0;
}

function toggleMetronome() {
  if (running.value) stopMetronome();
  else void startMetronome();
}

/** A tempo or meter change restarts the schedule from the next moment. */
function reschedule() {
  const ctx = metroCtx;
  if (!ctx || !running.value) return;
  clearScheduled();
  barStart = ctx.currentTime + START_OFFSET_SECONDS;
  currentBeat.value = 0;
  scheduleTick();
}

watch([bpm, timeSignatureId, subdivision], () => reschedule());

watch(volume, () => {
  if (!metroCtx || !metroGain) return;
  metroGain.gain.setTargetAtTime(targetGain(), metroCtx.currentTime, GLIDE);
});

/* ------------------------------------------------------------------ *
 * metronome: tempo controls
 * ------------------------------------------------------------------ */

function setBpm(value: number) {
  bpmText.value = String(Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(value))));
}

function nudgeBpm(delta: number) {
  setBpm(bpm.value + delta);
}

function onBpmSlider(value?: number[]) {
  const next = value?.[0];
  if (next === undefined) return;
  setBpm(next);
}

/**
 * Tap tempo. A long gap ends the run rather than averaging across a pause, and
 * only the last eight taps count, so the estimate follows you if you drift.
 */
function tapTempo() {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const last = taps[taps.length - 1];
  if (last !== undefined && now - last > TAP_RESET_MS) taps = [];
  taps.push(now);
  if (taps.length > MAX_TAPS) taps = taps.slice(-MAX_TAPS);
  tapCount.value = taps.length;
  const estimate = bpmFromTaps(taps);
  if (estimate !== null) setBpm(estimate);
}

function resetTaps() {
  taps = [];
  tapCount.value = 0;
}

/* ------------------------------------------------------------------ *
 * keyboard shortcuts, metronome tab only
 * ------------------------------------------------------------------ */

/** A shortcut must never steal a key from a field the visitor is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}

function onKeydown(event: KeyboardEvent) {
  if (tab.value !== "metronome") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;

  if (event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    toggleMetronome();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    nudgeBpm(event.shiftKey ? 5 : 1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    nudgeBpm(event.shiftKey ? -5 : -1);
    return;
  }
  if (event.key === "t" || event.key === "T") {
    event.preventDefault();
    tapTempo();
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function stopEverything() {
  stopTuner();
  stopMetronome();
}

function onVisibilityChange() {
  if (document.hidden) stopEverything();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopEverything();
  if (metroCtx && metroCtx.state !== "closed") void metroCtx.close().catch(() => {});
  metroCtx = null;
  metroGain = null;
  clickBuffers = null;
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="tuner">Tuner</TabsTrigger>
        <TabsTrigger value="metronome">Metronome</TabsTrigger>
      </TabsList>

      <!-- ====================== tuner ====================== -->
      <TabsContent value="tuner" class="flex flex-col gap-4 pt-4">
        <div
          class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
        >
          <!-- transport -->
          <div class="flex flex-wrap items-center gap-3">
            <Button type="button" size="lg" :disabled="startingMic" @click="toggleTuner">
              <Square v-if="listening" class="size-4" aria-hidden="true" />
              <Mic v-else class="size-4" aria-hidden="true" />
              {{ listening ? "Stop tuner" : "Start tuner" }}
            </Button>
            <p class="text-sm text-muted-foreground">{{ tunerStatus }}</p>
          </div>

          <!-- errors -->
          <div
            v-if="micError"
            role="alert"
            class="flex items-start gap-2 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
          >
            <CircleAlert class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <span class="flex flex-col gap-1">
              <span class="font-semibold text-destructive">{{ micError.message }}</span>
              <span class="text-muted-foreground">{{ micError.fix }}</span>
            </span>
          </div>

          <!-- readout -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
            <div class="flex flex-wrap items-end justify-between gap-4">
              <div class="flex items-baseline gap-1">
                <span
                  class="text-[56px] leading-none font-semibold tracking-[-0.02em] tabular-nums"
                  :class="reading ? centsTextClass : 'text-muted-foreground/50'"
                >
                  {{ noteLabel }}
                </span>
                <span class="text-2xl leading-none text-muted-foreground tabular-nums">
                  {{ octaveLabel }}
                </span>
              </div>
              <div class="flex flex-col items-end gap-0.5 text-right">
                <span
                  class="font-mono text-lg tabular-nums"
                  :class="reading ? centsTextClass : 'text-muted-foreground/50'"
                >
                  {{ reading ? centsLabel : "" }}
                </span>
                <span v-if="frequencyLabel" class="font-mono text-sm text-muted-foreground">
                  {{ frequencyLabel }}
                </span>
                <span v-if="targetLabel" class="text-xs text-muted-foreground">
                  Target {{ targetLabel }}
                </span>
              </div>
            </div>

            <!-- needle -->
            <div
              class="relative h-16 overflow-hidden rounded-[10px] bg-card shadow-[var(--sh-inset)]"
              role="img"
              :aria-label="
                reading
                  ? `${noteLabel}${octaveLabel}, ${centsLabel}, ${adviceLabel}`
                  : 'No pitch detected yet'
              "
            >
              <!-- the in tune window, plus or minus five cents -->
              <div class="absolute inset-y-0 left-[45%] right-[45%] bg-positive/15" />
              <div
                v-for="tick in CENTS_TICKS"
                :key="tick"
                class="absolute top-0 bottom-0 w-px"
                :class="tick === 0 ? 'bg-foreground/40' : 'bg-border'"
                :style="{ left: `${50 + tick}%` }"
              />
              <div
                v-if="reading"
                class="absolute inset-y-2 w-1.5 rounded-full transition-[left] duration-[120ms] ease-out"
                :class="needleClass"
                :style="{ left: `calc(${needlePercent}% - 3px)` }"
              />
              <span
                v-else
                class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
              >
                {{ listening ? "Play a note" : "Press Start tuner to listen" }}
              </span>
            </div>
            <div class="flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>-50 cents, flat</span>
              <span>in tune</span>
              <span>+50 cents, sharp</span>
            </div>

            <p v-if="adviceLabel" class="text-sm font-medium" :class="centsTextClass">
              {{ adviceLabel }}
            </p>
            <p v-else class="text-sm text-muted-foreground">
              Play one string and let it ring. The needle holds the median of the last five
              readings, so it settles instead of twitching.
            </p>
          </div>

          <!-- settings -->
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-full flex-col gap-1.5 sm:w-64">
              <Label for="tm-tuning" class="text-xs text-muted-foreground">Tuning</Label>
              <SearchableSelect
                id="tm-tuning"
                :spec="tuningSpec"
                :model-value="tuningId"
                @update:model-value="(v: string) => (tuningId = v)"
              />
            </div>
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="tm-a4" class="text-xs text-muted-foreground">A4 reference (Hz)</Label>
              <Input
                id="tm-a4"
                v-model="a4Text"
                type="number"
                min="415"
                max="466"
                step="1"
                inputmode="decimal"
                class="bg-card font-mono tabular-nums"
                :aria-invalid="a4Error ? 'true' : undefined"
              />
            </div>
            <p class="pb-2 text-xs text-muted-foreground">
              440 is concert pitch. 442 suits many orchestras, 415 is baroque.
            </p>
          </div>

          <div
            v-if="a4Error"
            role="alert"
            class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
          >
            <span class="font-semibold text-destructive">{{ a4Error.message }}</span>
            <span class="text-muted-foreground">{{ a4Error.fix }}</span>
          </div>

          <!-- strings -->
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              {{ tuning.strings.length ? "Open strings" : "Chromatic" }}
            </span>
            <div v-if="tuning.strings.length" class="flex flex-wrap gap-1.5">
              <span
                v-for="(string, index) in tuning.strings"
                :key="string.note + index"
                class="rounded-[8px] border px-2.5 py-1 font-mono text-xs tabular-nums transition-colors duration-[120ms]"
                :class="
                  reading && reading.match.index === index
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-secondary text-muted-foreground'
                "
                :title="string.label"
              >
                {{ string.note }}
              </span>
            </div>
            <p v-else class="text-xs text-muted-foreground">
              Chromatic mode snaps to whichever of the twelve notes is nearest, so it works for
              voice, brass, woodwind, keys, and any tuning that is not in the list.
            </p>
          </div>

          <!-- input level -->
          <div class="flex flex-col gap-1.5">
            <div class="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>Input level</span>
              <span>{{ listening ? `clarity ${clarityPercent}%` : "off" }}</span>
            </div>
            <div
              class="h-2 w-full overflow-hidden rounded-full bg-secondary shadow-[var(--sh-inset)]"
            >
              <div
                class="h-full rounded-full bg-primary transition-[width] duration-[120ms] ease-out"
                :style="{ width: `${levelPercent}%` }"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              Clarity is how periodic the sound is. Above roughly 80 percent the reading is a note
              rather than noise, so a low number usually means room noise or a note that has already
              died away.
            </p>
          </div>
        </div>
      </TabsContent>

      <!-- ====================== metronome ====================== -->
      <TabsContent value="metronome" class="flex flex-col gap-4 pt-4">
        <div
          class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
        >
          <!-- tempo -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex w-28 flex-col gap-1.5">
                <Label for="tm-bpm" class="text-xs text-muted-foreground">Tempo (bpm)</Label>
                <Input
                  id="tm-bpm"
                  v-model="bpmText"
                  type="number"
                  :min="BPM_MIN"
                  :max="BPM_MAX"
                  step="1"
                  inputmode="numeric"
                  class="bg-card font-mono text-lg tabular-nums"
                  :aria-invalid="bpmError ? 'true' : undefined"
                />
              </div>
              <Button type="button" variant="outline" class="h-9" @click="tapTempo">
                Tap tempo
              </Button>
              <Button
                v-if="tapCount > 0"
                type="button"
                variant="ghost"
                class="h-9"
                @click="resetTaps"
              >
                Reset taps
              </Button>
              <p v-if="tempo" class="pb-2 text-sm text-muted-foreground">
                {{ tempo.marking }}, {{ tempo.feel }} ({{ tempo.range }})
              </p>
            </div>

            <div class="flex flex-col gap-1.5">
              <Slider
                aria-label="Tempo in beats per minute"
                :model-value="[bpm]"
                :min="BPM_MIN"
                :max="BPM_MAX"
                :step="1"
                class="py-2"
                @update:model-value="onBpmSlider"
              />
              <div class="flex justify-between text-xs text-muted-foreground tabular-nums">
                <span>{{ BPM_MIN }} bpm</span>
                <span>{{ msPerBeat }} ms per beat</span>
                <span>{{ BPM_MAX }} bpm</span>
              </div>
            </div>

            <p class="text-xs text-muted-foreground">
              {{
                tapCount > 1
                  ? `Averaging your last ${tapCount} taps. Keep tapping to refine it.`
                  : "Tap the button in time with the music, at least twice, and the tempo follows your taps."
              }}
            </p>
          </div>

          <!-- meter, subdivision, volume -->
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-full flex-col gap-1.5 sm:w-52">
              <Label for="tm-signature" class="text-xs text-muted-foreground">Time signature</Label>
              <SearchableSelect
                id="tm-signature"
                :spec="timeSpec"
                :model-value="timeSignatureId"
                @update:model-value="(v: string) => (timeSignatureId = v)"
              />
            </div>
            <div class="flex w-full flex-col gap-1.5 sm:w-56">
              <Label for="tm-subdivision" class="text-xs text-muted-foreground">Subdivision</Label>
              <SearchableSelect
                id="tm-subdivision"
                :spec="SUBDIVISION_SPEC"
                :model-value="subdivisionText"
                @update:model-value="(v: string) => (subdivisionText = v)"
              />
            </div>
            <div class="flex min-w-44 flex-1 flex-col gap-1.5">
              <span class="text-xs text-muted-foreground tabular-nums">Volume: {{ volume }}%</span>
              <Slider
                aria-label="Click volume"
                :model-value="[volume]"
                :min="0"
                :max="100"
                :step="1"
                class="py-2"
                @update:model-value="(v) => (volume = v?.[0] ?? volume)"
              />
            </div>
            <Button type="button" size="lg" @click="toggleMetronome">
              <Square v-if="running" class="size-4" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ running ? "Stop" : "Start" }}
            </Button>
          </div>

          <!-- errors -->
          <div
            v-if="bpmError || metroError"
            role="alert"
            class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
          >
            <template v-for="err in [bpmError, metroError]" :key="err?.message">
              <template v-if="err">
                <span class="font-semibold text-destructive">{{ err.message }}</span>
                <span class="text-muted-foreground">{{ err.fix }}</span>
              </template>
            </template>
          </div>

          <!-- beat indicator -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
            <div class="flex min-h-14 flex-wrap items-center gap-3">
              <span
                v-for="beat in beats"
                :key="beat"
                class="rounded-full transition-[background-color,transform] duration-[120ms] ease-out"
                :class="[
                  beat === 1 ? 'size-6' : isAccentBeat(beat) ? 'size-5' : 'size-4',
                  currentBeat === beat
                    ? beat === 1
                      ? 'scale-110 bg-primary'
                      : 'scale-110 bg-primary/70'
                    : 'bg-muted-foreground/25',
                ]"
                aria-hidden="true"
              />
              <span class="ml-2 text-sm text-muted-foreground tabular-nums">
                {{ signature.label }}, beat {{ currentBeat || "-" }} of
                {{ signature.beatsPerBar }}
              </span>
            </div>
            <p class="text-xs text-muted-foreground">
              The downbeat is the large dot and plays the higher click. Every click is booked onto
              the audio clock about 100 milliseconds ahead, so the beat holds steady even while the
              page is busy with something else.
            </p>
          </div>

          <!-- shortcuts -->
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
              Space
            </kbd>
            start or stop,
            <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
              Up
            </kbd>
            <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
              Down
            </kbd>
            change the tempo (hold Shift for 5 bpm),
            <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
              T
            </kbd>
            taps it in. Shortcuts pause while you are typing in a field.
          </p>
        </div>
      </TabsContent>
    </Tabs>

    <p class="text-xs text-muted-foreground">
      The microphone opens only when you press Start tuner, the audio is analysed in this tab, and
      nothing is recorded or uploaded: your files and inputs never leave your device. The metronome
      keeps running while you tune, so stop it if the clicks reach the microphone.
    </p>
    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
