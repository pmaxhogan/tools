import { ToolError, type ToolLogic } from "../types";

/**
 * Tuner and Metronome: pure pitch detection, music theory, and click math.
 *
 * Nothing here touches the microphone, WebAudio, or the DOM. The panel owns
 * the live parts: it feeds time domain sample blocks from an AnalyserNode
 * into `detectPitch`, and it schedules AudioBufferSource clicks from
 * `clickSchedule` and `renderClickSamples`. This file is the math.
 *
 * Pitch detection uses the McLeod Pitch Method (MPM), described in "A Smarter
 * Way to Find Pitch" by Philip McLeod and Geoff Wyvill. MPM builds the
 * Normalized Square Difference Function (NSDF)
 *
 *     n(tau) = 2 * sum(x[j] * x[j + tau]) / sum(x[j]^2 + x[j + tau]^2)
 *
 * which is bounded to [-1, 1] and largely immune to amplitude drift. It then
 * picks the key maxima (the highest peak inside each positive region of the
 * NSDF), takes the first key maximum at least `peakPickRatio` times the
 * largest one, and refines that lag with parabolic interpolation. Choosing the
 * first qualifying peak rather than the tallest is what keeps a harmonic rich
 * signal, like a plucked guitar string, from reporting an octave too high.
 * The interpolated peak height doubles as the clarity score: near 1 for a
 * clean periodic tone, near 0 for noise.
 */

/* ------------------------------------------------------------------ */
/* Signal helpers                                                      */
/* ------------------------------------------------------------------ */

/** Root mean square amplitude of a sample block, 0 for an empty block. */
export function rms(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

export interface PitchResult {
  /** Detected fundamental in hertz, or null when nothing pitched was found. */
  frequency: number | null;
  /** Periodicity confidence from 0 to 1 (the interpolated NSDF peak height). */
  clarity: number;
}

export interface DetectPitchOptions {
  /** Minimum clarity before a frequency is reported at all. Default 0.8. */
  clarityThreshold?: number;
  /** MPM peak picking constant k: first key max at least k times the tallest. Default 0.9. */
  peakPickRatio?: number;
  /** Minimum RMS before the block counts as sound rather than silence. Default 0.001. */
  rmsFloor?: number;
  /** Lowest fundamental to accept, in hertz. Default 20. */
  minHz?: number;
  /** Highest fundamental to accept, in hertz. Default 5000. */
  maxHz?: number;
}

const SILENT: PitchResult = { frequency: null, clarity: 0 };

/**
 * Estimate the fundamental frequency of a mono block of samples.
 *
 * Returns `{ frequency: null }` when the block is silent (RMS below the
 * floor), too short to hold a period, not periodic enough (clarity below the
 * threshold), or resolves outside the accepted frequency range. `clarity` is
 * still reported in those cases so a panel can show a meter that moves before
 * a note locks in.
 *
 * Cost is O(samples * maxLag), so a 2048 sample window is a good balance for a
 * live meter. Analyzing every animation frame is wasteful; 20 to 30 times a
 * second is plenty for a needle.
 */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  options: DetectPitchOptions = {},
): PitchResult {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be a positive number, but ${sampleRate} was given.`,
      "Pass the AudioContext sample rate, usually 44100 or 48000.",
    );
  }
  if (!samples || samples.length < 64) return SILENT;

  const clarityThreshold = options.clarityThreshold ?? 0.8;
  const peakPickRatio = options.peakPickRatio ?? 0.9;
  const rmsFloor = options.rmsFloor ?? 0.001;
  const minHz = options.minHz ?? 20;
  const maxHz = options.maxHz ?? 5000;

  if (rms(samples) < rmsFloor) return SILENT;

  // Remove any DC offset: microphone captures often ride on a small bias, and
  // the NSDF treats that bias as signal energy.
  const n = samples.length;
  const x = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i] ?? 0;
  mean /= n;
  for (let i = 0; i < n; i++) x[i] = (samples[i] ?? 0) - mean;

  const maxLag = Math.floor(n / 2);
  const nsdf = new Float64Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0;
    let divisor = 0;
    for (let j = 0; j + tau < n; j++) {
      const a = x[j] ?? 0;
      const b = x[j + tau] ?? 0;
      acf += a * b;
      divisor += a * a + b * b;
    }
    nsdf[tau] = divisor > 0 ? (2 * acf) / divisor : 0;
  }

  // Walk past the tau = 0 lobe, then collect the highest point inside each
  // positive region: those are the key maxima MPM picks from.
  let tau = 0;
  while (tau <= maxLag && (nsdf[tau] ?? 0) > 0) tau++;

  const peaks: number[] = [];
  let best = -Infinity;
  let bestLag = -1;
  for (; tau <= maxLag; tau++) {
    const value = nsdf[tau] ?? 0;
    if (value > 0) {
      if (value > best) {
        best = value;
        bestLag = tau;
      }
    } else if (bestLag >= 0) {
      peaks.push(bestLag);
      best = -Infinity;
      bestLag = -1;
    }
  }
  if (bestLag >= 0) peaks.push(bestLag);
  if (peaks.length === 0) return SILENT;

  let tallest = 0;
  for (const lag of peaks) tallest = Math.max(tallest, nsdf[lag] ?? 0);
  if (tallest <= 0) return SILENT;

  const cutoff = tallest * peakPickRatio;
  let chosen = peaks[peaks.length - 1] ?? 0;
  for (const lag of peaks) {
    if ((nsdf[lag] ?? 0) >= cutoff) {
      chosen = lag;
      break;
    }
  }

  // Parabolic interpolation through the peak and its two neighbors turns the
  // integer lag into a fractional one, which is where most of the accuracy
  // comes from: a whole sample of error at 440 Hz is already about 4 Hz.
  let lag = chosen;
  let peakValue = nsdf[chosen] ?? 0;
  if (chosen > 0 && chosen < maxLag) {
    const y0 = nsdf[chosen - 1] ?? 0;
    const y1 = nsdf[chosen] ?? 0;
    const y2 = nsdf[chosen + 1] ?? 0;
    const denominator = y0 - 2 * y1 + y2;
    if (denominator !== 0) {
      const delta = (0.5 * (y0 - y2)) / denominator;
      if (Math.abs(delta) <= 1) {
        lag = chosen + delta;
        peakValue = y1 - 0.25 * (y0 - y2) * delta;
      }
    }
  }

  const clarity = Math.max(0, Math.min(1, peakValue));
  if (lag <= 0) return { frequency: null, clarity };
  const frequency = sampleRate / lag;
  if (clarity < clarityThreshold) return { frequency: null, clarity };
  if (frequency < minHz || frequency > maxHz) return { frequency: null, clarity };
  return { frequency, clarity };
}

/* ------------------------------------------------------------------ */
/* Notes, cents, tunings                                               */
/* ------------------------------------------------------------------ */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Lowest and highest pitch this tool will talk about, in hertz. */
export const MIN_HZ = 16;
export const MAX_HZ = 8000;

/** Allowed concert A range. Historic and orchestral references live in here. */
export const MIN_A4 = 415;
export const MAX_A4 = 466;

function assertA4(a4: number): number {
  if (!Number.isFinite(a4) || a4 < MIN_A4 || a4 > MAX_A4) {
    throw new ToolError(
      "bad-option",
      `The A4 reference must be between ${MIN_A4} Hz and ${MAX_A4} Hz, but ${a4} was given.`,
      `Use 440 for concert pitch, 442 for many orchestras, or 415 for baroque tuning.`,
    );
  }
  return a4;
}

/** Frequency of a MIDI note number, where 69 is A4. */
export function midiToFrequency(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export interface NoteInfo {
  /** Pitch class with any accidental, such as "A" or "C#". */
  name: string;
  /** Scientific pitch notation octave, where middle C is C4. */
  octave: number;
  /** MIDI note number, 69 for A4. */
  midi: number;
  /** Signed distance from that note in cents, unrounded. */
  cents: number;
  /** The exact frequency of that note at the current A4 reference. */
  targetHz: number;
}

/** Nearest note to a frequency, plus how far off it is in cents. */
export function frequencyToNote(hz: number, a4 = 440): NoteInfo {
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new ToolError(
      "bad-input",
      `${hz} Hz has no nearest note.`,
      "Pass a positive frequency in hertz, such as 440.",
    );
  }
  const reference = Number.isFinite(a4) && a4 > 0 ? a4 : 440;
  const exact = 69 + 12 * Math.log2(hz / reference);
  const midi = Math.round(exact);
  const cents = (exact - midi) * 100;
  const pitchClass = ((midi % 12) + 12) % 12;
  return {
    name: NOTE_NAMES[pitchClass] ?? "C",
    octave: Math.floor(midi / 12) - 1,
    midi,
    cents,
    targetHz: midiToFrequency(midi, reference),
  };
}

/**
 * Frequency of a note name in scientific pitch notation, such as "A4", "C#3",
 * or "Db3". Sharps are written "#" and flats "b"; the typographic sharp and
 * flat signs are accepted too.
 */
export function noteToFrequency(note: string, a4 = 440): number {
  const text = (note ?? "").trim();
  const match = /^([A-Ga-g])([#b♯♭]?)(-?\d{1,2})$/.exec(text);
  if (!match) {
    throw new ToolError(
      "bad-input",
      `"${note}" is not a note name this tool understands.`,
      "Use scientific pitch notation such as A4, C#3, or Db3.",
    );
  }
  const letter = match[1]!.toUpperCase();
  const accidental = match[2] ?? "";
  const octave = Number(match[3]);
  let semitone = NOTE_INDEX[letter]!;
  if (accidental === "#" || accidental === "♯") semitone += 1;
  if (accidental === "b" || accidental === "♭") semitone -= 1;
  const midi = 12 * (octave + 1) + semitone;
  const reference = Number.isFinite(a4) && a4 > 0 ? a4 : 440;
  return midiToFrequency(midi, reference);
}

/** Signed interval between two frequencies in cents, positive when hz is sharp. */
export function centsBetween(hz: number, referenceHz: number): number {
  if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(referenceHz) || referenceHz <= 0) {
    throw new ToolError(
      "bad-input",
      "Both frequencies must be greater than 0 Hz to measure an interval in cents.",
      "Pass two positive frequencies, such as 442 and 440.",
    );
  }
  return 1200 * Math.log2(hz / referenceHz);
}

export interface TuningString {
  /** Note name in scientific pitch notation, such as "E2". */
  note: string;
  /** How a player refers to the string, such as "6th (low E)". */
  label: string;
}

export interface Tuning {
  id: string;
  name: string;
  instrument: string;
  /** Open string pitches, lowest first. Empty for chromatic. */
  strings: TuningString[];
}

/**
 * Open string pitches for the instruments this tuner covers. Chromatic comes
 * first and carries no strings: it snaps to whatever note is nearest.
 */
export const TUNINGS: Tuning[] = [
  { id: "chromatic", name: "Chromatic", instrument: "Any instrument", strings: [] },
  {
    id: "guitar-standard",
    name: "Guitar standard (EADGBE)",
    instrument: "Guitar",
    strings: [
      { note: "E2", label: "6th (low E)" },
      { note: "A2", label: "5th (A)" },
      { note: "D3", label: "4th (D)" },
      { note: "G3", label: "3rd (G)" },
      { note: "B3", label: "2nd (B)" },
      { note: "E4", label: "1st (high E)" },
    ],
  },
  {
    id: "guitar-drop-d",
    name: "Guitar drop D (DADGBE)",
    instrument: "Guitar",
    strings: [
      { note: "D2", label: "6th (dropped D)" },
      { note: "A2", label: "5th (A)" },
      { note: "D3", label: "4th (D)" },
      { note: "G3", label: "3rd (G)" },
      { note: "B3", label: "2nd (B)" },
      { note: "E4", label: "1st (high E)" },
    ],
  },
  {
    id: "guitar-7-string",
    name: "7 string guitar (BEADGBE)",
    instrument: "Guitar",
    strings: [
      { note: "B1", label: "7th (low B)" },
      { note: "E2", label: "6th (E)" },
      { note: "A2", label: "5th (A)" },
      { note: "D3", label: "4th (D)" },
      { note: "G3", label: "3rd (G)" },
      { note: "B3", label: "2nd (B)" },
      { note: "E4", label: "1st (high E)" },
    ],
  },
  {
    id: "bass-4",
    name: "Bass guitar, 4 string (EADG)",
    instrument: "Bass",
    strings: [
      { note: "E1", label: "4th (low E)" },
      { note: "A1", label: "3rd (A)" },
      { note: "D2", label: "2nd (D)" },
      { note: "G2", label: "1st (G)" },
    ],
  },
  {
    id: "ukulele",
    name: "Ukulele, re-entrant (gCEA)",
    instrument: "Ukulele",
    strings: [
      { note: "G4", label: "4th (g, re-entrant)" },
      { note: "C4", label: "3rd (C)" },
      { note: "E4", label: "2nd (E)" },
      { note: "A4", label: "1st (A)" },
    ],
  },
  {
    id: "violin",
    name: "Violin (GDAE)",
    instrument: "Bowed strings",
    strings: [
      { note: "G3", label: "4th (G)" },
      { note: "D4", label: "3rd (D)" },
      { note: "A4", label: "2nd (A)" },
      { note: "E5", label: "1st (E)" },
    ],
  },
  {
    id: "cello",
    name: "Cello (CGDA)",
    instrument: "Bowed strings",
    strings: [
      { note: "C2", label: "4th (C)" },
      { note: "G2", label: "3rd (G)" },
      { note: "D3", label: "2nd (D)" },
      { note: "A3", label: "1st (A)" },
    ],
  },
  {
    id: "mandolin",
    name: "Mandolin (GDAE)",
    instrument: "Folk",
    strings: [
      { note: "G3", label: "4th course (G)" },
      { note: "D4", label: "3rd course (D)" },
      { note: "A4", label: "2nd course (A)" },
      { note: "E5", label: "1st course (E)" },
    ],
  },
  {
    id: "banjo-open-g",
    name: "Banjo, 5 string open G (gDGBD)",
    instrument: "Folk",
    strings: [
      { note: "D3", label: "4th (D)" },
      { note: "G3", label: "3rd (G)" },
      { note: "B3", label: "2nd (B)" },
      { note: "D4", label: "1st (D)" },
      { note: "G4", label: "5th (g, drone)" },
    ],
  },
];

/** Look up a tuning by id, or throw a bad-option error listing the choices. */
export function getTuning(id: string): Tuning {
  const found = TUNINGS.find((t) => t.id === id);
  if (!found) {
    throw new ToolError(
      "bad-option",
      `"${id}" is not a tuning this tool knows.`,
      `Choose one of: ${TUNINGS.map((t) => t.id).join(", ")}.`,
    );
  }
  return found;
}

export interface NearestStringResult {
  tuningId: string;
  tuningName: string;
  /** Position in the tuning's string list, or -1 for chromatic. */
  index: number;
  /** Player facing name of the string, or "Nearest note" for chromatic. */
  label: string;
  /** Target note in scientific pitch notation. */
  note: string;
  /** Exact frequency of the target at the current A4 reference. */
  targetHz: number;
  /** Signed distance from the target in cents, unrounded. */
  cents: number;
  /** Plain language tuning instruction. */
  advice: string;
}

/**
 * Snap a detected frequency to the closest string of a tuning and report how
 * far off it is. Closest is measured in cents rather than hertz, because a
 * fixed number of hertz is a much bigger musical error down at E1 than up at
 * E5. Chromatic tuning has no strings, so it snaps to the nearest note.
 */
export function nearestString(hz: number, tuningId: string, a4 = 440): NearestStringResult {
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new ToolError(
      "bad-input",
      `${hz} Hz cannot be matched to a string.`,
      "Pass a positive frequency in hertz, such as 82.4.",
    );
  }
  const tuning = getTuning(tuningId);
  const reference = Number.isFinite(a4) && a4 > 0 ? a4 : 440;

  if (tuning.strings.length === 0) {
    const note = frequencyToNote(hz, reference);
    return {
      tuningId: tuning.id,
      tuningName: tuning.name,
      index: -1,
      label: "Nearest note",
      note: `${note.name}${note.octave}`,
      targetHz: note.targetHz,
      cents: note.cents,
      advice: tuningAdvice(note.cents),
    };
  }

  let bestIndex = 0;
  let bestCents = Infinity;
  let bestTarget = 0;
  tuning.strings.forEach((string, index) => {
    const target = noteToFrequency(string.note, reference);
    const cents = centsBetween(hz, target);
    if (Math.abs(cents) < Math.abs(bestCents)) {
      bestIndex = index;
      bestCents = cents;
      bestTarget = target;
    }
  });

  const match = tuning.strings[bestIndex]!;
  return {
    tuningId: tuning.id,
    tuningName: tuning.name,
    index: bestIndex,
    label: match.label,
    note: match.note,
    targetHz: bestTarget,
    cents: bestCents,
    advice: tuningAdvice(bestCents),
  };
}

/**
 * Turn a cents offset into an instruction. Five cents is the usual "close
 * enough" window: it is under the just noticeable difference for most players
 * on a sustained note, and tighter than a guitar will hold anyway.
 */
export function tuningAdvice(cents: number): string {
  if (!Number.isFinite(cents)) return "No pitch detected yet.";
  const magnitude = Math.abs(cents);
  if (magnitude <= 5) return "In tune";
  if (magnitude > 50) {
    return cents > 0
      ? "More than a semitone sharp: check you are on the right string."
      : "More than a semitone flat: check you are on the right string.";
  }
  if (magnitude <= 15) return cents > 0 ? "Slightly sharp" : "Slightly flat";
  return cents > 0 ? "Sharp: loosen the string" : "Flat: tighten the string";
}

/* ------------------------------------------------------------------ */
/* Metronome                                                           */
/* ------------------------------------------------------------------ */

export const MIN_BPM = 20;
export const MAX_BPM = 400;

export interface TimeSignature {
  id: string;
  label: string;
  beatsPerBar: number;
  /** Note value that gets the beat: 4 for a quarter note, 8 for an eighth. */
  beatUnit: number;
  /** Beats that carry a stress, 1 based. The first is the downbeat. */
  accentBeats: number[];
}

/** The time signatures the metronome offers, keyed by the usual notation. */
export const TIME_SIGNATURES: TimeSignature[] = [
  { id: "4/4", label: "4/4 common time", beatsPerBar: 4, beatUnit: 4, accentBeats: [1, 3] },
  { id: "3/4", label: "3/4 waltz", beatsPerBar: 3, beatUnit: 4, accentBeats: [1] },
  { id: "2/4", label: "2/4 march", beatsPerBar: 2, beatUnit: 4, accentBeats: [1] },
  { id: "6/8", label: "6/8 compound duple", beatsPerBar: 6, beatUnit: 8, accentBeats: [1, 4] },
  { id: "5/4", label: "5/4", beatsPerBar: 5, beatUnit: 4, accentBeats: [1, 4] },
  { id: "7/8", label: "7/8 grouped 2+2+3", beatsPerBar: 7, beatUnit: 8, accentBeats: [1, 3, 5] },
];

/** Look up a time signature by id, or throw a bad-option error. */
export function getTimeSignature(id: string): TimeSignature {
  const found = TIME_SIGNATURES.find((t) => t.id === id);
  if (!found) {
    throw new ToolError(
      "bad-option",
      `"${id}" is not a time signature this metronome offers.`,
      `Choose one of: ${TIME_SIGNATURES.map((t) => t.id).join(", ")}.`,
    );
  }
  return found;
}

export interface ClickEvent {
  /** Absolute time of the click, in the same units as startTime. */
  time: number;
  /** Beat number inside the bar, 1 based. */
  beat: number;
  /** True on beat 1 of a bar, and only on the beat itself. */
  isDownbeat: boolean;
  /** True for a click that falls between beats. */
  isSubdivision: boolean;
}

/**
 * Build the exact times of the next `count` clicks.
 *
 * `startTime` and the returned times are plain numbers in seconds, so a panel
 * passes `audioContext.currentTime` and schedules each event with
 * `source.start(event.time)`. That is what makes the click sample accurate:
 * the times come from the audio clock, not from a timer that drifts whenever
 * the main thread is busy.
 *
 * `subdivision` is the number of clicks per beat, so 1 is beats only, 2 is
 * eighth notes, 3 is triplets and 4 is sixteenths. `count` is the total number
 * of events including subdivisions, not the number of beats.
 */
export function clickSchedule(
  bpm: number,
  beatsPerBar: number,
  subdivision: number,
  startTime: number,
  count: number,
): ClickEvent[] {
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new ToolError(
      "bad-option",
      `Tempo must be between ${MIN_BPM} and ${MAX_BPM} bpm, but ${bpm} was given.`,
      `Pick a tempo between ${MIN_BPM} and ${MAX_BPM} bpm.`,
    );
  }
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 32) {
    throw new ToolError(
      "bad-option",
      `Beats per bar must be a whole number from 1 to 32, but ${beatsPerBar} was given.`,
      "Pick a time signature, or pass a beat count from 1 to 32.",
    );
  }
  if (!Number.isInteger(subdivision) || subdivision < 1 || subdivision > 8) {
    throw new ToolError(
      "bad-option",
      `Subdivision must be a whole number from 1 to 8, but ${subdivision} was given.`,
      "Use 1 for beats only, 2 for eighth notes, 3 for triplets, or 4 for sixteenths.",
    );
  }
  if (!Number.isFinite(startTime) || startTime < 0) {
    throw new ToolError(
      "bad-option",
      `Start time must be a number of seconds that is 0 or more, but ${startTime} was given.`,
      "Pass the current audio clock time, or 0 to start the schedule at zero.",
    );
  }
  if (!Number.isInteger(count) || count < 0 || count > 4096) {
    throw new ToolError(
      "bad-option",
      `Click count must be a whole number from 0 to 4096, but ${count} was given.`,
      "Ask for one lookahead window at a time, usually a few dozen clicks.",
    );
  }

  const secondsPerBeat = 60 / bpm;
  const events: ClickEvent[] = [];
  for (let i = 0; i < count; i++) {
    const beatIndex = Math.floor(i / subdivision);
    const subIndex = i % subdivision;
    const beat = (beatIndex % beatsPerBar) + 1;
    events.push({
      time: startTime + beatIndex * secondsPerBeat + (subIndex / subdivision) * secondsPerBeat,
      beat,
      isDownbeat: subIndex === 0 && beat === 1,
      isSubdivision: subIndex !== 0,
    });
  }
  return events;
}

/**
 * Average a run of tap times into a tempo.
 *
 * Timestamps are milliseconds on any monotonic clock, which is what
 * `performance.now()` and a DOM event's `timeStamp` both give you. Intervals
 * outside the tempo range are dropped first (a pause between phrases is not a
 * beat), then intervals more than 40 percent away from the median are trimmed,
 * so one late tap does not drag the whole estimate. Returns null when there is
 * not enough usable data.
 */
export function bpmFromTaps(timestamps: number[]): number | null {
  if (!Array.isArray(timestamps)) return null;
  const clean = timestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (clean.length < 2) return null;

  const minInterval = 60000 / MAX_BPM;
  const maxInterval = 60000 / MIN_BPM;
  const intervals: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    const gap = (clean[i] ?? 0) - (clean[i - 1] ?? 0);
    if (gap >= minInterval && gap <= maxInterval) intervals.push(gap);
  }
  if (intervals.length === 0) return null;

  const sorted = [...intervals].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);

  const kept = intervals.filter((gap) => Math.abs(gap - median) <= median * 0.4);
  const used = kept.length > 0 ? kept : intervals;
  const average = used.reduce((sum, gap) => sum + gap, 0) / used.length;
  if (!(average > 0)) return null;
  return 60000 / average;
}

export interface TempoDescription {
  /** Italian tempo marking, such as "Allegro". */
  marking: string;
  /** The marking's range in words, such as "120 to 168 bpm". */
  range: string;
  /** Plain language sense of the marking. */
  feel: string;
}

const TEMPO_MARKINGS: { marking: string; min: number; max: number; feel: string }[] = [
  { marking: "Larghissimo", min: 0, max: 20, feel: "extremely slow, almost static" },
  { marking: "Grave", min: 20, max: 40, feel: "slow and solemn" },
  { marking: "Largo", min: 40, max: 60, feel: "broad and unhurried" },
  { marking: "Larghetto", min: 60, max: 66, feel: "broad, a little quicker than largo" },
  { marking: "Adagio", min: 66, max: 76, feel: "slow and stately" },
  { marking: "Andante", min: 76, max: 108, feel: "walking pace" },
  { marking: "Moderato", min: 108, max: 120, feel: "moderate, neither fast nor slow" },
  { marking: "Allegro", min: 120, max: 168, feel: "fast, bright and cheerful" },
  { marking: "Vivace", min: 168, max: 176, feel: "lively and quick" },
  { marking: "Presto", min: 176, max: 200, feel: "very fast" },
  { marking: "Prestissimo", min: 200, max: Infinity, feel: "as fast as it can be played" },
];

/**
 * Name a tempo with its Italian marking. The boundaries are half open, so
 * every tempo lands in exactly one band and 120 bpm is Allegro rather than
 * the top of Moderato. Marking ranges vary between editions, so treat this as
 * the common convention rather than a rule.
 */
export function describeTempo(bpm: number): TempoDescription {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new ToolError(
      "bad-input",
      `${bpm} is not a tempo that has a marking.`,
      "Pass a tempo in beats per minute, such as 120.",
    );
  }
  const band = TEMPO_MARKINGS.find((m) => bpm >= m.min && bpm < m.max) ?? TEMPO_MARKINGS[0]!;
  let range: string;
  if (band.max === Infinity) range = `${band.min} bpm and above`;
  else if (band.min === 0) range = `under ${band.max} bpm`;
  else range = `${band.min} to ${band.max} bpm`;
  return { marking: band.marking, range, feel: band.feel };
}

export interface ClickSampleOptions {
  /** Sine frequency of the click. Defaults to 1500 Hz accented, 1000 Hz plain. */
  frequency?: number;
  /** Length of the burst in milliseconds. Default 40. */
  durationMs?: number;
  /** Accented clicks are higher and louder, for the downbeat. Default false. */
  accent?: boolean;
}

/**
 * Render one metronome click into a mono buffer.
 *
 * The click is a short sine burst under a steep exponential decay. Starting
 * the sine at phase zero means the buffer opens and closes at silence, so
 * there is no edge discontinuity of its own, and the decay is fast enough that
 * consecutive clicks never overlap into a drone.
 */
export function renderClickSamples(
  sampleRate: number,
  options: ClickSampleOptions = {},
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be a positive number, but ${sampleRate} was given.`,
      "Pass the AudioContext sample rate, usually 44100 or 48000.",
    );
  }
  const accent = options.accent === true;
  const durationMs = options.durationMs ?? 40;
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 1000) {
    throw new ToolError(
      "bad-option",
      `Click length must be between 1 ms and 1000 ms, but ${durationMs} was given.`,
      "A click of 20 ms to 60 ms sounds crisp at any tempo.",
    );
  }
  const frequency = options.frequency ?? (accent ? 1500 : 1000);
  if (!Number.isFinite(frequency) || frequency < 20 || frequency > 20000) {
    throw new ToolError(
      "bad-option",
      `Click frequency must be between 20 Hz and 20000 Hz, but ${frequency} was given.`,
      "Try 1000 Hz for the beat and 1500 Hz for the downbeat.",
    );
  }

  const length = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const amplitude = accent ? 1 : 0.7;
  const samples = new Float32Array(length);
  // exp(-12) is about 6 parts per million, so the tail is silent by the end.
  const decay = 12;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp((-decay * i) / length);
    samples[i] = amplitude * envelope * Math.sin(2 * Math.PI * frequency * t);
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface TunerMetronomeOpts {
  a4?: number | string;
  tuning?: string;
  timeSignature?: string;
  [key: string]: unknown;
}

export type TunerMetronomeResult = Record<string, string>;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function signed(value: number, decimals: number): string {
  const rounded = round(value, decimals);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(decimals)}`;
}

function readA4(opts: TunerMetronomeOpts): number {
  const raw = opts?.a4;
  const value = raw === undefined || raw === "" ? 440 : Number(raw);
  return assertA4(value);
}

function noteLabel(info: NoteInfo): string {
  return `${info.name}${info.octave}`;
}

function tuningSummary(tuning: Tuning): string {
  if (tuning.strings.length === 0) return `${tuning.name}, snaps to the nearest note`;
  return `${tuning.name}: ${tuning.strings.map((s) => s.note).join(" ")}`;
}

function describeFrequency(
  hz: number,
  a4: number,
  tuning: Tuning,
  signature: TimeSignature,
): TunerMetronomeResult {
  const note = frequencyToNote(hz, a4);
  const match = nearestString(hz, tuning.id, a4);
  const out: TunerMetronomeResult = {
    Frequency: `${round(hz, 3)} Hz`,
    "Nearest note": `${noteLabel(note)} at ${round(note.targetHz, 3)} Hz`,
    "Cents off": `${signed(note.cents, 2)} cents`,
    "MIDI note": String(note.midi),
    "A4 reference": `${round(a4, 2)} Hz`,
    Tuning: tuningSummary(tuning),
  };
  if (tuning.strings.length === 0) {
    out["Tuning check"] = `${match.advice} against ${match.note}`;
  } else {
    out["Nearest string"] =
      `${match.label}, ${match.note} at ${round(match.targetHz, 3)} Hz, ${signed(match.cents, 2)} cents`;
    out["Tuning check"] = match.advice;
  }
  out["Time signature"] = `${signature.label}, ${signature.beatsPerBar} beats per bar`;
  out["Live tuning"] =
    "Open the panel and click Start listening to tune from your microphone. The audio is analyzed on your device and never leaves your browser.";
  return out;
}

function describeBpm(bpm: number, signature: TimeSignature, a4: number): TunerMetronomeResult {
  const tempo = describeTempo(bpm);
  const msPerBeat = 60000 / bpm;
  const beatsPerBar = signature.beatsPerBar;
  const beatName = signature.beatUnit === 8 ? "eighth note" : "quarter note";
  return {
    Tempo: `${round(bpm, 3)} bpm`,
    Marking: `${tempo.marking} (${tempo.range})`,
    Feel: tempo.feel,
    "Beat value": `The ${beatName} gets the beat in ${signature.id}`,
    "Milliseconds per beat": `${round(msPerBeat, 3)} ms`,
    "Time signature": `${signature.label}, ${beatsPerBar} beats per bar`,
    "Seconds per bar": `${round((msPerBeat * beatsPerBar) / 1000, 4)} s`,
    "Bars per minute": String(round(bpm / beatsPerBar, 3)),
    "Eighth note": `${round(msPerBeat / 2, 3)} ms`,
    "Dotted eighth": `${round(msPerBeat * 0.75, 3)} ms`,
    "Sixteenth note": `${round(msPerBeat / 4, 3)} ms`,
    "Accented beats": signature.accentBeats.join(", "),
    "A4 reference": `${round(a4, 2)} Hz`,
    Metronome:
      "Open the panel and press Start to hear this tempo. Clicks are scheduled against the audio clock, so they stay steady while the page is busy.",
  };
}

function describePanel(
  a4: number,
  tuning: Tuning,
  signature: TimeSignature,
): TunerMetronomeResult {
  return {
    Tuner:
      "Click Start listening in the panel to tune with your microphone. Pitch detection runs on your device using the McLeod Pitch Method, and the audio never leaves your browser.",
    Metronome:
      "Set a tempo, pick a time signature, then press Start. Every click is scheduled ahead of time against the audio clock, so the beat stays steady even when the page is busy.",
    "A4 reference": `${round(a4, 2)} Hz`,
    Tuning: tuningSummary(tuning),
    "Time signature": `${signature.label}, ${signature.beatsPerBar} beats per bar`,
    "Tap tempo": "Tap in time with the music and the panel averages your taps into a tempo.",
    "Try typing":
      "Type a frequency like 440.5 to see the nearest note and how many cents off it is, or a tempo like 120 bpm to see its marking and beat timing.",
  };
}

const NOTE_NAME_PATTERN = /^[A-Ga-g][#b♯♭]?-?\d{1,2}$/;

/**
 * Turn a typed frequency, note name, or tempo into readable rows. Live tuning
 * and the click itself belong to the panel; this is the text surface, and the
 * curl and pipeline surface, of the same math.
 */
export function run(input: string, opts: TunerMetronomeOpts): TunerMetronomeResult {
  const a4 = readA4(opts);
  const tuning = getTuning(String(opts?.tuning ?? "chromatic"));
  const signature = getTimeSignature(String(opts?.timeSignature ?? "4/4"));

  const raw = (input ?? "").trim();
  if (!raw) return describePanel(a4, tuning, signature);

  const lower = raw.toLowerCase();
  if (/\bbpm\b/.test(lower) || lower.includes("beats per minute")) {
    const numeric = lower.replace(/beats\s*per\s*minute/g, " ").replace(/\bbpm\b/g, " ").trim();
    const bpm = Number(numeric);
    if (!numeric || !Number.isFinite(bpm)) {
      throw new ToolError(
        "bad-input",
        `"${raw}" looks like a tempo but has no readable number in it.`,
        "Write the tempo as a number followed by bpm, such as 120 bpm.",
      );
    }
    if (bpm < MIN_BPM || bpm > MAX_BPM) {
      throw new ToolError(
        "bad-input",
        `${bpm} bpm is outside the ${MIN_BPM} to ${MAX_BPM} bpm range this metronome covers.`,
        `Pick a tempo between ${MIN_BPM} and ${MAX_BPM} bpm.`,
      );
    }
    return describeBpm(bpm, signature, a4);
  }

  if (NOTE_NAME_PATTERN.test(raw)) {
    const hz = noteToFrequency(raw, a4);
    if (hz < MIN_HZ || hz > MAX_HZ) {
      throw new ToolError(
        "bad-input",
        `${raw} is ${round(hz, 3)} Hz, outside the ${MIN_HZ} Hz to ${MAX_HZ} Hz range this tuner covers.`,
        `Use a note between ${MIN_HZ} Hz and ${MAX_HZ} Hz, such as A4.`,
      );
    }
    return describeFrequency(hz, a4, tuning, signature);
  }

  const frequencyMatch = /^(\d+(?:\.\d+)?)\s*(hz|khz)?$/i.exec(raw);
  if (frequencyMatch) {
    const multiplier = /^khz$/i.test(frequencyMatch[2] ?? "") ? 1000 : 1;
    const hz = Number(frequencyMatch[1]) * multiplier;
    if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) {
      throw new ToolError(
        "bad-input",
        `${raw} is outside the ${MIN_HZ} Hz to ${MAX_HZ} Hz range this tuner covers.`,
        `Enter a frequency between ${MIN_HZ} Hz and ${MAX_HZ} Hz, such as 440.`,
      );
    }
    return describeFrequency(hz, a4, tuning, signature);
  }

  throw new ToolError(
    "bad-input",
    `"${raw}" is neither a frequency nor a tempo.`,
    "Enter a frequency like 440.5, a note name like E2, or a tempo like 120 bpm. Leave the box empty to use the live tuner and metronome.",
  );
}

export default { run } satisfies ToolLogic<string, TunerMetronomeResult, TunerMetronomeOpts>;
