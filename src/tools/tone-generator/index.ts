import { ToolError, type ToolLogic } from "../types";

/**
 * Signal Generator: pure tone math and DSP.
 *
 * Everything here is plain arithmetic. Actually playing a tone needs
 * WebAudio, and offering a WAV download needs the DOM, so both live in a
 * custom panel; this file only turns note names and frequencies into
 * numbers, describes a signal in words, renders sample buffers, and encodes
 * those buffers as a WAV file.
 */

/* ------------------------------------------------------------------ */
/* Notes and frequencies                                               */
/* ------------------------------------------------------------------ */

/** Lowest and highest frequency tone-generator will render or describe. */
export const MIN_HZ = 1;
export const MAX_HZ = 24000;

/** Speed of sound in air at room temperature, in meters per second. */
export const SPEED_OF_SOUND = 343;

/** Semitone index within an octave, C = 0 through B = 11. */
const NOTE_INDEX: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function validateFrequencyRange(hz: number, source: string): number {
  if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) {
    throw new ToolError(
      "bad-frequency",
      `"${source}" is ${Number.isFinite(hz) ? `${hz} Hz` : "not a usable frequency"}, outside the ${MIN_HZ} Hz to ${MAX_HZ} Hz range tone-generator supports.`,
      `Pick a frequency between ${MIN_HZ} Hz and ${MAX_HZ} Hz, or a note name in that range.`,
    );
  }
  return hz;
}

/**
 * Convert a note name like "A4", "C#3", or "Db3" to a frequency in hertz.
 *
 * Octave numbering follows scientific pitch notation, where A4 is the
 * standard tuning pitch (440 Hz by default, adjustable via `a4`) and C4 is
 * middle C. Accidentals are "#" or "♯" for sharp and "b" or "♭" for flat.
 */
export function noteToFrequency(note: string, a4 = 440): number {
  const s = (note ?? "").trim();
  const match = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(s);
  if (!match) {
    throw new ToolError(
      "bad-frequency",
      `"${note}" is not a note name tone-generator understands.`,
      "Use a note name like A4, C#3, or Db3, or a frequency like 440 or 1kHz.",
    );
  }
  const letter = match[1]!.toUpperCase();
  const accidental = match[2] ?? "";
  const octave = Number(match[3]);
  let index = NOTE_INDEX[letter]!;
  if (accidental === "#" || accidental === "♯") index += 1;
  if (accidental === "b" || accidental === "♭") index -= 1;
  const midi = 12 * (octave + 1) + index;
  const hz = a4 * Math.pow(2, (midi - 69) / 12);
  return validateFrequencyRange(hz, s);
}

export interface NoteAndCents {
  /** Nearest note name, e.g. "A4". */
  note: string;
  /** Signed cents from that note's exact pitch, rounded to the nearest cent. */
  cents: number;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Find the nearest note name and how many cents sharp or flat a frequency is. */
export function frequencyToNote(hz: number, a4 = 440): NoteAndCents {
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new ToolError(
      "bad-frequency",
      `${hz} Hz is not a frequency that has a nearest note.`,
      "Pass a positive frequency in hertz.",
    );
  }
  const midiExact = 69 + 12 * Math.log2(hz / a4);
  const midiRounded = Math.round(midiExact);
  const cents = Math.round((midiExact - midiRounded) * 100);
  const noteIndex = ((midiRounded % 12) + 12) % 12;
  const octave = Math.floor(midiRounded / 12) - 1;
  return { note: `${NOTE_NAMES[noteIndex]}${octave}`, cents };
}

/**
 * Parse a frequency out of free text: a plain number ("440"), a number with
 * a unit ("440hz", "1khz"), or a note name ("A4", "C#3", "Db3").
 */
export function parseFrequency(raw: string, a4 = 440): number {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new ToolError(
      "bad-frequency",
      "Enter a frequency or a note name.",
      "Try 440, 1kHz, or a note like A4.",
    );
  }
  const numeric = /^(-?[\d.]+)\s*(hz|khz)?$/i.exec(s);
  if (numeric) {
    const value = Number(numeric[1]);
    const multiplier = /^khz$/i.test(numeric[2] ?? "") ? 1000 : 1;
    return validateFrequencyRange(value * multiplier, s);
  }
  return noteToFrequency(s, a4);
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

export type SweepKind = "linear" | "log";

/**
 * Instantaneous frequency of a sweep at time `t`, `duration` seconds long,
 * running from `f0` to `f1`.
 *
 * A linear sweep moves in equal hertz per second; a logarithmic (exponential)
 * sweep moves in equal ratio per second, so its midpoint is the geometric
 * mean of the endpoints rather than the arithmetic mean.
 */
export function sweepFrequencyAt(
  t: number,
  duration: number,
  f0: number,
  f1: number,
  kind: SweepKind,
): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ToolError(
      "bad-option",
      `Sweep duration must be greater than 0 seconds, but ${duration} was given.`,
      "Pick a duration between 0.1 and 60 seconds.",
    );
  }
  const frac = Math.min(1, Math.max(0, t / duration));
  if (kind === "linear") {
    return f0 + (f1 - f0) * frac;
  }
  if (kind === "log") {
    if (!(f0 > 0) || !(f1 > 0)) {
      throw new ToolError(
        "bad-frequency",
        "A logarithmic sweep needs both the start and end frequency to be greater than 0 Hz.",
        "Use a linear sweep instead, or pick start and end frequencies above 0 Hz.",
      );
    }
    return f0 * Math.pow(f1 / f0, frac);
  }
  throw new ToolError(
    "bad-option",
    `"${kind}" is not a sweep type tone-generator supports.`,
    "Choose linear or log.",
  );
}

/**
 * Instantaneous phase of a sweep at time `t`: the integral of
 * `2 * pi * sweepFrequencyAt(t, ...)` from 0 to `t`.
 *
 * Sampling `sin` of this phase, rather than `sin(2 * pi * f(t) * t)`, is what
 * makes the sweep actually pass through every frequency along the way
 * instead of just landing on the right instantaneous rate.
 */
function sweepPhase(t: number, duration: number, f0: number, f1: number, kind: SweepKind): number {
  if (kind === "linear") {
    return 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * duration)) * t * t);
  }
  const k = Math.log(f1 / f0) / duration;
  return (2 * Math.PI * f0 * (Math.exp(k * t) - 1)) / k;
}

/* ------------------------------------------------------------------ */
/* Describe                                                            */
/* ------------------------------------------------------------------ */

export type WaveKind =
  | "sine"
  | "square"
  | "triangle"
  | "sawtooth"
  | "white-noise"
  | "pink-noise"
  | "sweep";

export interface DescribeSignalOpts {
  kind: WaveKind;
  /** Tone frequency, or the sweep's start frequency. Ignored for noise. */
  frequency: number;
  /** Sweep end frequency. Required when kind is "sweep". */
  f1?: number;
  /** Sweep shape. Defaults to "log". */
  sweepKind?: SweepKind;
  duration: number;
  a4?: number;
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${round(hz / 1000, 3)} kHz`;
  return `${round(hz, 2)} Hz`;
}

function formatPeriod(hz: number): string {
  const seconds = 1 / hz;
  if (seconds < 0.001) return `${round(seconds * 1e6, 1)} microseconds`;
  if (seconds < 1) return `${round(seconds * 1000, 3)} ms`;
  return `${round(seconds, 4)} s`;
}

function wavelengthMeters(hz: number): number {
  return SPEED_OF_SOUND / hz;
}

/** Where a frequency sits relative to the limits of human hearing. */
function hearingNote(hz: number): string {
  if (hz < 20) {
    return "Below 20 Hz: infrasound, felt as pressure or vibration more than heard.";
  }
  if (hz <= 60) {
    return "20 Hz to 60 Hz: the subwoofer range, useful for testing bass extension.";
  }
  if (hz > 17000) {
    return "Above 17 kHz: many adults cannot hear this, especially with age related hearing loss.";
  }
  return "Within the normal range of human hearing.";
}

function requirePositiveFrequency(hz: number, label: string): number {
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new ToolError(
      "bad-frequency",
      `${label} must be greater than 0 Hz, but ${hz} was given.`,
      `Pick a ${label.toLowerCase()} between ${MIN_HZ} Hz and ${MAX_HZ} Hz.`,
    );
  }
  return hz;
}

/**
 * Describe a signal in plain language: frequency, nearest note, wavelength
 * in air, period, and a note on where it sits relative to human hearing,
 * plus a volume safety reminder.
 */
export function describeSignal(opts: DescribeSignalOpts): Record<string, string> {
  const a4 = opts.a4 ?? 440;
  const out: Record<string, string> = {};

  if (opts.kind === "white-noise" || opts.kind === "pink-noise") {
    out.Frequency =
      opts.kind === "white-noise"
        ? "All audible frequencies at equal energy per hertz"
        : "All audible frequencies, energy falling about 3 dB per octave";
    out.Note = "Not applicable: noise has no single pitch";
    out["Wavelength in air"] = "Not applicable: noise contains every audible wavelength at once";
    out.Period = "Not applicable: noise does not repeat";
    out["Hearing note"] =
      "Spans the full audible range, so it does not sit in the infrasound, subwoofer, or ultrasonic bands the way a single tone does.";
  } else if (opts.kind === "sweep") {
    const f0 = requirePositiveFrequency(opts.frequency, "Sweep start frequency");
    const f1 = requirePositiveFrequency(opts.f1 ?? 20000, "Sweep end frequency");
    const sweepKind = opts.sweepKind ?? "log";
    out.Frequency = `${formatHz(f0)} to ${formatHz(f1)}, ${sweepKind} sweep over ${opts.duration} s`;
    out.Note =
      `${frequencyToNote(f0, a4).note} to ${frequencyToNote(f1, a4).note}, sweeping continuously ` +
      "through every note in between";
    out["Wavelength in air"] =
      `${round(wavelengthMeters(f0), 3)} m to ${round(wavelengthMeters(f1), 3)} m at ${SPEED_OF_SOUND} m/s`;
    out.Period = `${formatPeriod(f0)} to ${formatPeriod(f1)}`;
    const low = hearingNote(Math.min(f0, f1));
    const high = hearingNote(Math.max(f0, f1));
    out["Hearing note"] = low === high ? low : `Low end: ${low} High end: ${high}`;
  } else {
    const f = requirePositiveFrequency(opts.frequency, "Frequency");
    const nearest = frequencyToNote(f, a4);
    out.Frequency = formatHz(f);
    out.Note =
      nearest.cents === 0
        ? `${nearest.note}, exactly in tune`
        : `${nearest.note}, ${nearest.cents > 0 ? "+" : ""}${nearest.cents} cents`;
    out["Wavelength in air"] = `${round(wavelengthMeters(f), 3)} m at ${SPEED_OF_SOUND} m/s`;
    out.Period = formatPeriod(f);
    out["Hearing note"] = hearingNote(f);
  }

  out["Volume warning"] =
    "Start at a low volume, especially on headphones and at very low or very high frequencies: hearing damage can happen before a tone feels loud.";

  return out;
}

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

/** FNV-1a style string hash, used to turn a seed string into a 32 bit int. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (xorshift32) returning values in [0, 1). */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function randomSource(seed?: string): () => number {
  if (seed) return xorshift32(hashSeed(seed));
  return () => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! / 4294967296;
  };
}

/**
 * Paul Kellet's refined pink noise filter: shapes white noise into pink
 * noise (energy falling 3 dB per octave) with seven cascaded one-pole
 * stages. The 0.11 scale roughly normalizes the output back toward [-1, 1].
 */
function pinkNoiseSource(rand: () => number): () => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  return () => {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    return Math.max(-1, Math.min(1, pink * 0.11));
  };
}

/* ------------------------------------------------------------------ */
/* Render                                                               */
/* ------------------------------------------------------------------ */

export interface RenderSamplesOpts {
  kind: WaveKind;
  /** Tone frequency, or the sweep's start frequency. Ignored for noise. */
  frequency: number;
  /** Sweep end frequency. Defaults to 20000 when kind is "sweep". */
  f1?: number;
  /** Sweep shape. Defaults to "log". */
  sweepKind?: SweepKind;
  /** Seconds of audio to render. */
  duration: number;
  sampleRate: number;
  /** Peak amplitude, 0 to 1. */
  amplitude: number;
  /** Deterministic seed for the noise kinds. Omit for cryptographic randomness. */
  seed?: string;
}

/**
 * Render a signal to a mono Float32Array of samples in [-amplitude, amplitude].
 *
 * Square, triangle, and sawtooth are computed directly from the phase rather
 * than by summing harmonics, so they are exact (no Gibbs ringing) and cheap.
 * Pink and white noise are deterministic when `seed` is given, otherwise
 * seeded from `crypto.getRandomValues`.
 */
export function renderSamples(opts: RenderSamplesOpts): Float32Array {
  const { kind, duration, sampleRate, amplitude } = opts;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ToolError(
      "bad-option",
      `Duration must be greater than 0 seconds, but ${duration} was given.`,
      "Pick a duration between 0.1 and 60 seconds.",
    );
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 1) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be a positive number, but ${sampleRate} was given.`,
      "Use a sample rate like 44100 or 48000.",
    );
  }
  if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
    throw new ToolError(
      "bad-option",
      `Amplitude must be between 0 and 1, but ${amplitude} was given.`,
      "Pick an amplitude between 0 and 1.",
    );
  }

  const count = Math.max(1, Math.round(duration * sampleRate));
  const samples = new Float32Array(count);

  if (kind === "white-noise" || kind === "pink-noise") {
    const rand = randomSource(opts.seed);
    if (kind === "white-noise") {
      for (let i = 0; i < count; i++) samples[i] = (rand() * 2 - 1) * amplitude;
    } else {
      const pink = pinkNoiseSource(rand);
      for (let i = 0; i < count; i++) samples[i] = pink() * amplitude;
    }
    return samples;
  }

  if (kind === "sweep") {
    const f0 = opts.frequency;
    const f1 = opts.f1 ?? 20000;
    const sweepKind = opts.sweepKind ?? "log";
    if (sweepKind === "log" && (!(f0 > 0) || !(f1 > 0))) {
      throw new ToolError(
        "bad-frequency",
        "A logarithmic sweep needs both the start and end frequency to be greater than 0 Hz.",
        "Use a linear sweep instead, or pick start and end frequencies above 0 Hz.",
      );
    }
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      samples[i] = amplitude * Math.sin(sweepPhase(t, duration, f0, f1, sweepKind));
    }
    return samples;
  }

  const frequency = opts.frequency;
  if (!Number.isFinite(frequency) || frequency <= 0) {
    throw new ToolError(
      "bad-frequency",
      `Frequency must be greater than 0 Hz, but ${frequency} was given.`,
      `Pick a frequency between ${MIN_HZ} Hz and ${MAX_HZ} Hz.`,
    );
  }
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * frequency * t;
    let value: number;
    if (kind === "sine") {
      value = Math.sin(phase);
    } else if (kind === "square") {
      value = Math.sin(phase) >= 0 ? 1 : -1;
    } else if (kind === "triangle") {
      value = (2 / Math.PI) * Math.asin(Math.sin(phase));
    } else if (kind === "sawtooth") {
      const frac = frequency * t;
      value = 2 * (frac - Math.floor(frac + 0.5));
    } else {
      throw new ToolError(
        "bad-option",
        `"${kind}" is not a waveform tone-generator supports.`,
        "Choose sine, square, triangle, sawtooth, white-noise, pink-noise, or sweep.",
      );
    }
    samples[i] = value * amplitude;
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* WAV encoding                                                        */
/* ------------------------------------------------------------------ */

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encode samples as a 16-bit PCM mono WAV file.
 *
 * The header is the standard 44 bytes (12 byte RIFF chunk, 24 byte fmt
 * chunk, 8 byte data chunk header) followed by two bytes per sample.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 1) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be a positive number, but ${sampleRate} was given.`,
      "Use a sample rate like 44100 or 48000.",
    );
  }
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: sampleRate * blockAlign
  view.setUint16(32, 2, true); // block align: channels * bitsPerSample / 8
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(scaled), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/* ------------------------------------------------------------------ */
/* run                                                                  */
/* ------------------------------------------------------------------ */

export interface ToneGeneratorOpts {
  wave: string;
  duration: number;
  volume: number;
  endFrequency: number;
  sweepKind: string;
  [key: string]: unknown;
}

export type ToneGeneratorResult = Record<string, string>;

const WAVE_KINDS = new Set<string>([
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "white-noise",
  "pink-noise",
  "sweep",
]);
const SWEEP_KINDS = new Set<string>(["linear", "log"]);

/**
 * Describe the requested signal in words. Actually playing it or exporting a
 * WAV happens in the custom panel via renderSamples and encodeWav, since the
 * generic tool shell cannot play audio.
 */
export function run(input: string, opts: ToneGeneratorOpts): ToneGeneratorResult {
  const raw = (input ?? "").trim() || "440";
  const frequency = parseFrequency(raw);

  const wave = String(opts?.wave ?? "sine");
  if (!WAVE_KINDS.has(wave)) {
    throw new ToolError(
      "bad-option",
      `"${wave}" is not a waveform tone-generator supports.`,
      "Choose sine, square, triangle, sawtooth, white noise, pink noise, or sweep.",
    );
  }

  const duration = opts?.duration === undefined ? 3 : Number(opts.duration);
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 60) {
    throw new ToolError(
      "bad-option",
      `Duration must be between 0.1 and 60 seconds, but ${opts?.duration} was given.`,
      "Pick a duration between 0.1 and 60 seconds.",
    );
  }

  const volume = opts?.volume === undefined ? 50 : Number(opts.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new ToolError(
      "bad-option",
      `Volume must be between 0 and 100, but ${opts?.volume} was given.`,
      "Pick a volume between 0 and 100.",
    );
  }

  let f1: number | undefined;
  let sweepKind: SweepKind | undefined;
  if (wave === "sweep") {
    const endRaw = opts?.endFrequency === undefined ? 20000 : Number(opts.endFrequency);
    f1 = validateFrequencyRange(endRaw, String(opts?.endFrequency ?? "20000"));
    const sweepKindRaw = String(opts?.sweepKind ?? "log");
    if (!SWEEP_KINDS.has(sweepKindRaw)) {
      throw new ToolError(
        "bad-option",
        `"${opts?.sweepKind}" is not a sweep type tone-generator supports.`,
        "Choose linear or log.",
      );
    }
    sweepKind = sweepKindRaw as SweepKind;
  }

  const description = describeSignal({
    kind: wave as WaveKind,
    frequency,
    f1,
    sweepKind,
    duration,
  });

  return {
    ...description,
    Playback: "Press Play in the panel to hear this signal through your speakers or headphones. Audio never starts automatically.",
    WAV: "The panel can render this signal to a 16-bit WAV file and offer it as a download.",
  };
}

export default { run } satisfies ToolLogic<string, ToneGeneratorResult, ToneGeneratorOpts>;
