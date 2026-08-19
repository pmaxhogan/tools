import { ToolError, type ToolLogic } from "../types";

/**
 * Morse, DTMF and Audio Data: three ways to move characters through sound.
 *
 * Everything in this file is arithmetic on numbers and strings. Playing a
 * buffer, recording from a microphone, and saving a file all need the DOM, so
 * they live in the custom panel; this module owns the tables, the timing math,
 * the sample rendering, and the detectors the panel feeds live audio into.
 *
 * Three codecs share one module because they share one idea (a tone carries a
 * symbol) and one set of primitives (Goertzel energy detection, raised cosine
 * ramps, 16 bit WAV encoding).
 */

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

function requireSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 1000) {
    throw new ToolError(
      "bad-option",
      `Sample rate must be at least 1000 samples per second, but ${sampleRate} was given.`,
      "Use a sample rate like 44100 or 48000.",
    );
  }
  return sampleRate;
}

function requireRange(value: number, min: number, max: number, label: string, unit = ""): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    const suffix = unit ? ` ${unit}` : "";
    throw new ToolError(
      "bad-option",
      `${label} must be between ${min} and ${max}${suffix}, but ${value} was given.`,
      `Pick a value between ${min} and ${max}${suffix}.`,
    );
  }
  return value;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Two cluster k-means in the log domain, used to separate dits from dahs and
 * letter gaps from word gaps without knowing the sending speed in advance.
 * Works on ratios rather than differences, which is what Morse timing is
 * actually built from. Returns null when the values are all effectively equal.
 */
function clusterTwo(values: number[]): { low: number; high: number } | null {
  if (values.length < 2) return null;
  const logs = values.filter((v) => v > 0).map((v) => Math.log(v));
  if (logs.length < 2) return null;
  let low = logs[0];
  let high = logs[0];
  for (const value of logs) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (high - low < 1e-9) return null;
  for (let iteration = 0; iteration < 25; iteration++) {
    let sumLow = 0;
    let countLow = 0;
    let sumHigh = 0;
    let countHigh = 0;
    for (const value of logs) {
      if (Math.abs(value - low) <= Math.abs(value - high)) {
        sumLow += value;
        countLow++;
      } else {
        sumHigh += value;
        countHigh++;
      }
    }
    const nextLow = countLow > 0 ? sumLow / countLow : low;
    const nextHigh = countHigh > 0 ? sumHigh / countHigh : high;
    const settled = Math.abs(nextLow - low) < 1e-12 && Math.abs(nextHigh - high) < 1e-12;
    low = nextLow;
    high = nextHigh;
    if (settled) break;
  }
  return { low: Math.exp(low), high: Math.exp(high) };
}

/**
 * Goertzel energy at one frequency, returned as an estimated sine amplitude.
 *
 * The Goertzel recurrence is a single DFT bin computed with two multiplies per
 * sample, which is why every detector here uses it instead of an FFT. The
 * `2 * sqrt(power) / n` scaling turns the raw bin magnitude back into the peak
 * amplitude of a tone at that frequency, so thresholds can be written as
 * fractions of the signal level rather than in arbitrary units.
 */
export function goertzel(
  samples: ArrayLike<number>,
  sampleRate: number,
  freq: number,
  start = 0,
  length = samples.length - start,
): number {
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(samples.length, from + Math.floor(length));
  const count = to - from;
  if (count <= 0) return 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = (samples[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / count;
}

/** One key down or key up stretch of an on/off keyed signal. */
export interface EnvelopeSegment {
  on: boolean;
  ms: number;
}

/* ------------------------------------------------------------------ */
/* Morse tables                                                        */
/* ------------------------------------------------------------------ */

/**
 * ITU-R M.1677-1 Morse, plus the punctuation and prosigns amateur operators
 * actually send. Prosigns are written in angle brackets and are sent as one
 * run of elements with no letter gap inside them.
 */
export const MORSE_BY_CHAR: Record<string, string> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  ".": ".-.-.-",
  ",": "--..--",
  "?": "..--..",
  "'": ".----.",
  "!": "-.-.--",
  "/": "-..-.",
  "(": "-.--.",
  ")": "-.--.-",
  "&": ".-...",
  ":": "---...",
  ";": "-.-.-.",
  "=": "-...-",
  "+": ".-.-.",
  "-": "-....-",
  _: "..--.-",
  '"': ".-..-.",
  $: "...-..-",
  "@": ".--.-.",
  "<SOS>": "...---...",
  "<AR>": ".-.-.",
  "<SK>": "...-.-",
  "<VA>": "...-.-",
  "<BT>": "-...-",
  "<AS>": ".-...",
  "<KN>": "-.--.",
  "<CT>": "-.-.-",
  "<KA>": "-.-.-",
  "<BK>": "-...-.-",
  "<SN>": "...-.",
  "<VE>": "...-.",
  "<HH>": "........",
};

/**
 * Pattern to character. Several prosigns share a pattern with a punctuation
 * mark (`<AR>` with `+`, `<BT>` with `=`, `<AS>` with `&`, `<KN>` with `(` ),
 * so ordinary characters claim their pattern first and only the prosigns with
 * a pattern of their own decode back to angle bracket form.
 */
const CHAR_BY_MORSE: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  for (const [char, code] of Object.entries(MORSE_BY_CHAR)) {
    if (char.startsWith("<")) continue;
    if (!(code in table)) table[code] = char;
  }
  for (const [char, code] of Object.entries(MORSE_BY_CHAR)) {
    if (!char.startsWith("<")) continue;
    if (!(code in table)) table[code] = char;
  }
  return table;
})();

const KNOWN_PROSIGNS = Object.keys(MORSE_BY_CHAR).filter((key) => key.startsWith("<"));

/* ------------------------------------------------------------------ */
/* Morse: text to code and back                                        */
/* ------------------------------------------------------------------ */

/** Fold typographic quotes and dashes onto the ASCII forms Morse has codes for. */
function normalizeTextForMorse(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toUpperCase();
}

function encodeMorseWord(word: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < word.length) {
    if (word[i] === "<") {
      const close = word.indexOf(">", i);
      if (close > i) {
        const token = word.slice(i, close + 1);
        const code = MORSE_BY_CHAR[token];
        if (code) {
          parts.push(code);
          i = close + 1;
          continue;
        }
        throw new ToolError(
          "bad-morse",
          `"${token}" is not a prosign this tool knows.`,
          `Known prosigns are ${KNOWN_PROSIGNS.join(", ")}.`,
        );
      }
    }
    const char = word[i];
    const code = MORSE_BY_CHAR[char];
    if (!code) {
      throw new ToolError(
        "bad-morse",
        `"${char}" has no code in the ITU Morse table.`,
        "Morse covers A to Z, 0 to 9, and the punctuation . , ? ' ! / ( ) & : ; = + - _ \" $ @ only. Remove or replace anything else.",
      );
    }
    parts.push(code);
    i++;
  }
  return parts.join(" ");
}

/**
 * Encode text as Morse: elements separated by a space inside a character,
 * characters separated by a space, words separated by " / ".
 *
 * Case is ignored, runs of whitespace collapse into one word gap, and a
 * prosign written as `<SOS>` becomes one unbroken run of elements.
 */
export function textToMorse(text: string): string {
  const words = normalizeTextForMorse(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map(encodeMorseWord).join(" / ");
}

/**
 * Fold the many ways people write Morse onto dots, dashes, spaces and slashes:
 * middots and bullets become dots, every kind of hyphen, dash, underscore and
 * minus sign becomes a dash, vertical bars become slashes, and a line break
 * becomes a word gap.
 */
function normalizeMorse(code: string): string {
  return code
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00b7\u2022\u2027\u2219*]/g, ".")
    .replace(/[_\u2010-\u2015\u2212\u2043]/g, "-")
    .replace(/[|\uff5c\u2044]/g, "/")
    .replace(/\n+/g, " / ");
}

/** Split a Morse string into words of element tokens. */
function parseMorseWords(code: string): string[][] {
  const normalized = normalizeMorse(code ?? "").trim();
  if (!normalized) return [];
  const chunks = normalized.includes("/")
    ? normalized.split(/\s*\/+\s*/)
    : normalized.split(/ {3,}|\t+/);
  const words: string[][] = [];
  for (const chunk of chunks) {
    const tokens = chunk.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) words.push(tokens);
  }
  return words;
}

function requireElements(token: string): string {
  if (!/^[.-]+$/.test(token)) {
    throw new ToolError(
      "bad-morse",
      `"${token}" is not made of dots and dashes.`,
      "Write elements as . and -, one space between letters, and / between words.",
    );
  }
  return token;
}

/** Rewrite any accepted Morse spelling in the canonical dot, dash, slash form. */
export function normalizeMorseString(code: string): string {
  return parseMorseWords(code)
    .map((word) => word.map(requireElements).join(" "))
    .join(" / ");
}

/**
 * Decode Morse to text. Tolerant about how the input is written and strict
 * about what the patterns mean: an unknown pattern is an error rather than a
 * silent question mark, because a silent one hides a mistyped element.
 */
export function morseToText(code: string): string {
  const words = parseMorseWords(code);
  if (words.length === 0) return "";
  return words
    .map((word) =>
      word
        .map((token) => {
          requireElements(token);
          const char = CHAR_BY_MORSE[token];
          if (char === undefined) {
            throw new ToolError(
              "bad-morse",
              `"${token}" is not a pattern in the ITU Morse table.`,
              "Check the element count and the spacing: one space separates letters, three spaces or a / separate words.",
            );
          }
          return char;
        })
        .join(""),
    )
    .join(" ");
}

/** Same decode, but an unreadable pattern becomes "?" instead of throwing. */
function morseToTextTolerant(code: string): string {
  return parseMorseWords(code)
    .map((word) =>
      word.map((token) => (/^[.-]+$/.test(token) ? (CHAR_BY_MORSE[token] ?? "?") : "?")).join(""),
    )
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Morse timing                                                        */
/* ------------------------------------------------------------------ */

export interface MorseTiming {
  /** Character speed in words per minute. */
  wpm: number;
  /** Overall speed in words per minute, equal to `wpm` when Farnsworth is off. */
  farnsworthWpm: number;
  ditMs: number;
  dahMs: number;
  /** Gap between elements inside one character. */
  intraGapMs: number;
  /** Gap between characters inside one word. */
  charGapMs: number;
  /** Gap between words. */
  wordGapMs: number;
}

/**
 * PARIS standard Morse timing. The word PARIS plus its trailing word gap is
 * exactly 50 dit units long, so a dit at W words per minute is 1200 / W ms and
 * every other duration is a multiple of it: a dah is 3 dits, the gap inside a
 * character is 1, between characters 3, and between words 7.
 *
 * Farnsworth spacing keeps the characters crisp at `wpm` while stretching only
 * the 19 units of spacing so the whole message arrives at `farnsworthWpm`,
 * which is how beginners learn without picking up a slow rhythm inside each
 * letter. A Farnsworth speed at or above the character speed would compress
 * rather than stretch, so it falls back to standard timing.
 */
export function morseTiming(wpm: number, farnsworthWpm?: number): MorseTiming {
  if (!Number.isFinite(wpm) || wpm <= 0) {
    throw new ToolError(
      "bad-option",
      `Morse speed must be greater than 0 words per minute, but ${wpm} was given.`,
      "Pick a speed between 5 and 40 WPM.",
    );
  }
  const ditMs = 1200 / wpm;
  const overall = farnsworthWpm === undefined ? wpm : Number(farnsworthWpm);
  if (!Number.isFinite(overall) || overall <= 0) {
    throw new ToolError(
      "bad-option",
      `Farnsworth speed must be greater than 0 words per minute, but ${farnsworthWpm} was given.`,
      "Pick a Farnsworth speed between 5 WPM and the character speed.",
    );
  }
  const spacingUnitMs =
    overall < wpm ? ((60 * wpm - 37.2 * overall) / (19 * overall * wpm)) * 1000 : ditMs;
  return {
    wpm,
    farnsworthWpm: Math.min(overall, wpm),
    ditMs,
    dahMs: 3 * ditMs,
    intraGapMs: ditMs,
    charGapMs: 3 * spacingUnitMs,
    wordGapMs: 7 * spacingUnitMs,
  };
}

/** Expand a Morse string into the key down and key up stretches that send it. */
export function morseSegments(morse: string, timing: MorseTiming): EnvelopeSegment[] {
  const words = parseMorseWords(morse);
  const segments: EnvelopeSegment[] = [];
  words.forEach((word, wordIndex) => {
    if (wordIndex > 0) segments.push({ on: false, ms: timing.wordGapMs });
    word.forEach((token, tokenIndex) => {
      requireElements(token);
      if (tokenIndex > 0) segments.push({ on: false, ms: timing.charGapMs });
      for (let i = 0; i < token.length; i++) {
        if (i > 0) segments.push({ on: false, ms: timing.intraGapMs });
        segments.push({ on: true, ms: token[i] === "." ? timing.ditMs : timing.dahMs });
      }
    });
  });
  return segments;
}

/** How long a Morse string takes to send at a given timing, in milliseconds. */
export function morseDurationMs(morse: string, timing: MorseTiming): number {
  return morseSegments(morse, timing).reduce((total, segment) => total + segment.ms, 0);
}

/* ------------------------------------------------------------------ */
/* Morse rendering                                                     */
/* ------------------------------------------------------------------ */

export interface RenderMorseOpts {
  /** Character speed in words per minute. Defaults to 15. */
  wpm?: number;
  /** Overall speed for Farnsworth spacing. Omit for standard timing. */
  farnsworthWpm?: number;
  /** Sidetone frequency. Defaults to 600 Hz. */
  toneHz?: number;
  sampleRate: number;
  /** Peak amplitude, 0 to 1. Defaults to 0.6. */
  amplitude?: number;
  /** Rise and fall time of each element. Defaults to 5 ms. */
  rampMs?: number;
}

/**
 * Render Morse to a mono sample buffer.
 *
 * Each element gets a 5 ms raised cosine rise and fall. Hard edges would
 * splatter energy across the band (the key clicks that make a hand keyed
 * signal wide and ugly) and would also smear the Goertzel blocks the decoder
 * runs on. The sine is computed from the absolute sample index rather than
 * per element, so the carrier stays phase continuous across the whole message.
 */
export function renderMorseSamples(morse: string, opts: RenderMorseOpts): Float32Array {
  const sampleRate = requireSampleRate(opts.sampleRate);
  const toneHz = requireRange(opts.toneHz ?? 600, 20, sampleRate / 2, "Tone frequency", "Hz");
  const amplitude = requireRange(opts.amplitude ?? 0.6, 0, 1, "Amplitude", "");
  const timing = morseTiming(opts.wpm ?? 15, opts.farnsworthWpm);
  const segments = morseSegments(morse, timing);
  const totalMs = segments.reduce((total, segment) => total + segment.ms, 0);
  const totalSamples = Math.round((totalMs * sampleRate) / 1000);
  const out = new Float32Array(totalSamples);
  const rampMs = opts.rampMs ?? 5;

  let elapsedMs = 0;
  for (const segment of segments) {
    const start = Math.round((elapsedMs * sampleRate) / 1000);
    elapsedMs += segment.ms;
    const end = Math.min(totalSamples, Math.round((elapsedMs * sampleRate) / 1000));
    if (!segment.on) continue;
    const length = end - start;
    if (length <= 0) continue;
    const ramp = Math.max(
      1,
      Math.min(Math.round((rampMs * sampleRate) / 1000), Math.floor(length / 2)),
    );
    for (let i = 0; i < length; i++) {
      let envelope = 1;
      if (i < ramp) {
        envelope = 0.5 * (1 - Math.cos((Math.PI * (i + 0.5)) / ramp));
      } else if (i >= length - ramp) {
        envelope = 0.5 * (1 - Math.cos((Math.PI * (length - i - 0.5)) / ramp));
      }
      const t = (start + i) / sampleRate;
      out[start + i] = amplitude * envelope * Math.sin(2 * Math.PI * toneHz * t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Morse decoding                                                      */
/* ------------------------------------------------------------------ */

export interface EnvelopeOpts {
  /** Analysis block length. Defaults to 10 ms. */
  blockMs?: number;
  /** Fraction of the reference level at which the key counts as down. */
  onFraction?: number;
  /** Fraction of the reference level at which the key counts as up again. */
  offFraction?: number;
}

/**
 * Turn recorded audio into key down and key up stretches.
 *
 * Every block of 10 ms is scored by its Goertzel energy at the sidetone
 * frequency, then compared against a reference taken from the loud end of the
 * recording, so the detector adapts to how far away the speaker is instead of
 * needing a calibrated level. Two thresholds rather than one give the state
 * machine hysteresis, which stops a block sitting right on the edge from
 * chattering the key open and closed.
 */
export function envelopeFromSamples(
  samples: ArrayLike<number>,
  sampleRate: number,
  toneHz: number,
  opts: EnvelopeOpts = {},
): EnvelopeSegment[] {
  requireSampleRate(sampleRate);
  const blockMs = opts.blockMs ?? 10;
  const blockSize = Math.max(8, Math.round((sampleRate * blockMs) / 1000));
  const blockCount = Math.floor(samples.length / blockSize);
  if (blockCount === 0) return [];

  const levels = new Array<number>(blockCount);
  for (let b = 0; b < blockCount; b++) {
    levels[b] = goertzel(samples, sampleRate, toneHz, b * blockSize, blockSize);
  }

  const sorted = [...levels].sort((a, b) => a - b);
  const reference = sorted[Math.floor(0.95 * (sorted.length - 1))];
  if (!(reference > 1e-6)) return [];
  const onThreshold = reference * (opts.onFraction ?? 0.5);
  const offThreshold = reference * (opts.offFraction ?? 0.25);

  const states = new Array<boolean>(blockCount);
  let on = false;
  for (let b = 0; b < blockCount; b++) {
    if (on ? levels[b] < offThreshold : levels[b] > onThreshold) on = !on;
    states[b] = on;
  }

  const first = states.indexOf(true);
  if (first < 0) return [];
  const last = states.lastIndexOf(true);

  const actualBlockMs = (blockSize / sampleRate) * 1000;
  const segments: EnvelopeSegment[] = [];
  for (let b = first; b <= last; b++) {
    const previous = segments[segments.length - 1];
    if (previous && previous.on === states[b]) previous.ms += actualBlockMs;
    else segments.push({ on: states[b], ms: actualBlockMs });
  }
  return segments;
}

export interface MorseEnvelopeDecode {
  /** The recovered Morse, in canonical dot, dash, slash form. */
  morse: string;
  /** The recovered text. An unreadable pattern shows as "?". */
  text: string;
  /** The dit length the decoder measured, in milliseconds. */
  ditMs: number;
  /** The sending speed implied by that dit length. */
  wpm: number;
}

/**
 * Decode key down and key up stretches into Morse and text, with no idea of
 * the sending speed in advance.
 *
 * The dit length is estimated by clustering the key down durations in the log
 * domain: a hand keyed signal separates cleanly into a short group and a group
 * about three times longer. When every element happens to be the same (a
 * message of all dahs, say) the clusters collapse, and the shortest key up
 * stretch stands in as the unit instead, since the gap inside a character is
 * one dit by definition. The key up stretches are then split the same way into
 * letter gaps and word gaps.
 */
export function decodeMorseFromEnvelope(onOffSegments: EnvelopeSegment[]): MorseEnvelopeDecode {
  const segments = (onOffSegments ?? []).filter((segment) => segment && segment.ms > 0);
  const onDurations = segments.filter((segment) => segment.on).map((segment) => segment.ms);
  if (onDurations.length === 0) return { morse: "", text: "", ditMs: 0, wpm: 0 };

  const offDurations = segments
    .slice(1, Math.max(1, segments.length - 1))
    .filter((segment) => !segment.on)
    .map((segment) => segment.ms);

  let ditMs: number;
  let dahThreshold: number;
  const onClusters = clusterTwo(onDurations);
  if (onClusters && onClusters.high / onClusters.low >= 2) {
    ditMs = onClusters.low;
    dahThreshold = Math.sqrt(onClusters.low * onClusters.high);
  } else {
    const onCentre = median(onDurations);
    const shortestGap = offDurations.reduce(
      (shortest, gap) => (shortest === 0 ? gap : Math.min(shortest, gap)),
      0,
    );
    if (shortestGap > 0 && onCentre / shortestGap >= 2) {
      ditMs = shortestGap;
    } else {
      ditMs = onCentre;
    }
    dahThreshold = 2 * ditMs;
  }
  if (!(ditMs > 0)) return { morse: "", text: "", ditMs: 0, wpm: 0 };

  // Where the gap inside a character ends and the gap between characters
  // begins. The gaps say it better than the dit length does, because block
  // quantisation stretches key down stretches and shrinks key up ones by the
  // same amount, so a boundary taken from the gaps themselves moves with the
  // error. The cluster is only trusted when its short end really could be the
  // one unit gap inside a character; a message with no such gaps in it at all
  // would otherwise split its letter gaps in the wrong place.
  let intraThreshold = 2 * ditMs;
  const offClusters = clusterTwo(offDurations);
  if (offClusters && offClusters.high / offClusters.low >= 2 && offClusters.low <= 1.8 * ditMs) {
    intraThreshold = Math.sqrt(offClusters.low * offClusters.high);
  }

  const separatorGaps = offDurations.filter((gap) => gap > intraThreshold);
  let wordThreshold = Number.POSITIVE_INFINITY;
  const gapClusters = clusterTwo(separatorGaps);
  if (gapClusters && gapClusters.high / gapClusters.low >= 1.8) {
    wordThreshold = Math.sqrt(gapClusters.low * gapClusters.high);
  } else if (separatorGaps.length > 0 && median(separatorGaps) >= 5 * ditMs) {
    wordThreshold = 0;
  }

  let morse = "";
  for (const segment of segments) {
    if (segment.on) {
      morse += segment.ms < dahThreshold ? "." : "-";
    } else if (segment.ms > intraThreshold) {
      morse += segment.ms > wordThreshold ? " / " : " ";
    }
  }
  morse = morse.trim();

  return {
    morse: morse ? normalizeMorseString(morse) : "",
    text: morseToTextTolerant(morse),
    ditMs,
    wpm: 1200 / ditMs,
  };
}

/* ------------------------------------------------------------------ */
/* DTMF                                                                */
/* ------------------------------------------------------------------ */

/** The four low group tones of the telephone keypad, one per row. */
export const DTMF_LOW_FREQS = [697, 770, 852, 941];
/** The four high group tones of the telephone keypad, one per column. */
export const DTMF_HIGH_FREQS = [1209, 1336, 1477, 1633];
/** The keypad itself, row by row. The fourth column is the military A to D keys. */
export const DTMF_KEYPAD = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
];

export interface DtmfTonePair {
  low: number;
  high: number;
}

/**
 * Every DTMF key and the two tones that make it, per ITU-T Q.23. The pair is
 * always one tone from the low group and one from the high group, chosen so
 * that no key's tones are harmonics of another's and speech cannot fake one.
 */
export const DTMF_FREQS: Record<string, DtmfTonePair> = (() => {
  const table: Record<string, DtmfTonePair> = {};
  DTMF_KEYPAD.forEach((row, rowIndex) => {
    row.forEach((key, columnIndex) => {
      table[key] = { low: DTMF_LOW_FREQS[rowIndex], high: DTMF_HIGH_FREQS[columnIndex] };
    });
  });
  return table;
})();

/** Strip the punctuation people write phone numbers with and validate the rest. */
export function normalizeDtmfDigits(digits: string): string {
  const cleaned = (digits ?? "").toUpperCase().replace(/[\s\-().+,]/g, "");
  for (const char of cleaned) {
    if (!(char in DTMF_FREQS)) {
      throw new ToolError(
        "bad-dtmf",
        `"${char}" is not a key on a DTMF keypad.`,
        "Use 0 to 9, A to D, * and #. Spaces, dashes, brackets, commas and plus signs are ignored.",
      );
    }
  }
  return cleaned;
}

export interface RenderDtmfOpts {
  /** Length of each tone burst. Defaults to 100 ms. */
  toneMs?: number;
  /** Silence between bursts. Defaults to 100 ms. */
  gapMs?: number;
  sampleRate: number;
  /** Peak amplitude of the pair, 0 to 1. Defaults to 0.5. */
  amplitude?: number;
  /** Rise and fall time of each burst. Defaults to 3 ms. */
  rampMs?: number;
}

/**
 * Render a dial string as DTMF bursts. The two tones are summed at half the
 * requested amplitude each so the pair peaks at the amplitude asked for, and
 * every burst is ramped so the start and end do not click.
 */
export function renderDtmfSamples(digits: string, opts: RenderDtmfOpts): Float32Array {
  const sampleRate = requireSampleRate(opts.sampleRate);
  const cleaned = normalizeDtmfDigits(digits);
  const toneMs = requireRange(opts.toneMs ?? 100, 10, 5000, "Tone length", "ms");
  const gapMs = requireRange(opts.gapMs ?? 100, 0, 5000, "Gap length", "ms");
  const amplitude = requireRange(opts.amplitude ?? 0.5, 0, 1, "Amplitude", "");
  if (cleaned.length === 0) return new Float32Array(0);

  const totalMs = cleaned.length * toneMs + (cleaned.length - 1) * gapMs;
  const totalSamples = Math.round((totalMs * sampleRate) / 1000);
  const out = new Float32Array(totalSamples);
  const rampMs = opts.rampMs ?? 3;

  for (let d = 0; d < cleaned.length; d++) {
    const pair = DTMF_FREQS[cleaned[d]];
    const startMs = d * (toneMs + gapMs);
    const start = Math.round((startMs * sampleRate) / 1000);
    const end = Math.min(totalSamples, Math.round(((startMs + toneMs) * sampleRate) / 1000));
    const length = end - start;
    if (length <= 0) continue;
    const ramp = Math.max(
      1,
      Math.min(Math.round((rampMs * sampleRate) / 1000), Math.floor(length / 2)),
    );
    for (let i = 0; i < length; i++) {
      let envelope = 1;
      if (i < ramp) {
        envelope = 0.5 * (1 - Math.cos((Math.PI * (i + 0.5)) / ramp));
      } else if (i >= length - ramp) {
        envelope = 0.5 * (1 - Math.cos((Math.PI * (length - i - 0.5)) / ramp));
      }
      const t = i / sampleRate;
      const value = Math.sin(2 * Math.PI * pair.low * t) + Math.sin(2 * Math.PI * pair.high * t);
      out[start + i] = amplitude * 0.5 * envelope * value;
    }
  }
  return out;
}

export interface DecodeDtmfOpts {
  /** Analysis block length. Defaults to 20 ms. */
  blockMs?: number;
  /** How many blocks in a row must agree before a key counts. Defaults to 2. */
  minBlocks?: number;
}

/**
 * Detect DTMF keys in recorded audio.
 *
 * Each 20 ms block is measured at all eight keypad frequencies with Goertzel,
 * then put through the checks a real receiver applies: the strongest tone in
 * each group must stand well clear of the next strongest in that group, the
 * two groups must be within a sane twist of each other (the level difference
 * a phone line puts between the low and high tone), and the block has to be
 * loud enough relative to the recording to be a burst at all. Blocks that
 * agree collapse into a single key, so one 100 ms burst is one character.
 */
export function decodeDtmf(
  samples: ArrayLike<number>,
  sampleRate: number,
  opts: DecodeDtmfOpts = {},
): string {
  requireSampleRate(sampleRate);
  const blockMs = opts.blockMs ?? 20;
  const blockSize = Math.max(16, Math.round((sampleRate * blockMs) / 1000));
  const blockCount = Math.floor(samples.length / blockSize);
  if (blockCount === 0) return "";

  const rms = new Array<number>(blockCount);
  let loudest = 0;
  for (let b = 0; b < blockCount; b++) {
    let sum = 0;
    for (let i = b * blockSize; i < (b + 1) * blockSize; i++) {
      const value = samples[i] ?? 0;
      sum += value * value;
    }
    rms[b] = Math.sqrt(sum / blockSize);
    if (rms[b] > loudest) loudest = rms[b];
  }
  if (loudest < 1e-5) return "";

  const detected = new Array<string | null>(blockCount);
  for (let b = 0; b < blockCount; b++) {
    detected[b] = null;
    if (rms[b] < 0.25 * loudest) continue;
    const start = b * blockSize;
    const lows = DTMF_LOW_FREQS.map((f) => goertzel(samples, sampleRate, f, start, blockSize));
    const highs = DTMF_HIGH_FREQS.map((f) => goertzel(samples, sampleRate, f, start, blockSize));
    const low = bestOfTwo(lows);
    const high = bestOfTwo(highs);
    if (low.best <= 0 || high.best <= 0) continue;
    // The winning tone in each group must be clearly the only tone there.
    if (low.best < 2.5 * low.second || high.best < 2.5 * high.second) continue;
    // Twist: a generous plus or minus 10 dB between the two groups.
    const twist = high.best / low.best;
    if (twist < 0.316 || twist > 3.16) continue;
    // Both tones together have to account for most of what is in the block.
    const peak = Math.SQRT2 * rms[b];
    if (low.best < 0.25 * peak || high.best < 0.25 * peak) continue;
    detected[b] = DTMF_KEYPAD[low.index][high.index];
  }

  const minBlocks = opts.minBlocks ?? 2;
  let out = "";
  let current: string | null = null;
  let run = 0;
  for (const key of detected) {
    if (key !== null && key === current) {
      run++;
      continue;
    }
    if (current !== null && run >= minBlocks) out += current;
    current = key;
    run = key === null ? 0 : 1;
  }
  if (current !== null && run >= minBlocks) out += current;
  return out;
}

function bestOfTwo(values: number[]): { index: number; best: number; second: number } {
  let index = 0;
  let best = -Infinity;
  let second = -Infinity;
  values.forEach((value, i) => {
    if (value > best) {
      second = best;
      best = value;
      index = i;
    } else if (value > second) {
      second = value;
    }
  });
  return { index, best, second: Math.max(0, second) };
}

/* ------------------------------------------------------------------ */
/* Audio data modem: AFSK                                              */
/* ------------------------------------------------------------------ */

/** Alternating bits sent before the sync word so a receiver can find the clock. */
export const FSK_PREAMBLE_BITS = 48;
/** Sync word, sent most significant bit first, right before the length field. */
export const FSK_SYNC_WORD = 0x7e7e;
const FSK_SYNC_LENGTH = 16;
export const FSK_DEFAULT_BAUD = 100;
/** Tone for a 0 bit, the Bell 202 space frequency. */
export const FSK_DEFAULT_F0 = 1200;
/** Tone for a 1 bit, the Bell 202 mark frequency. */
export const FSK_DEFAULT_F1 = 2200;
/** Alignment steps the decoder tries inside each bit while hunting for the sync word. */
const FSK_SUBSTEPS = 8;

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
 * no final xor. The check value for the ASCII digits "123456789" is 0x29B1.
 */
export function crc16Ccitt(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= ((bytes[i] ?? 0) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export interface FskFrame {
  /** The whole frame as bits, preamble and sync word included. */
  bits: number[];
  /** Length field and payload, the bytes the checksum covers. */
  checked: Uint8Array;
  crc: number;
  /** Bytes that are sent inside a start and stop bit: length, payload, checksum. */
  framedByteCount: number;
}

/**
 * Build one frame: an alternating preamble, a sync word, a two byte payload
 * length, the payload, and a CRC-16 over the length and payload together.
 * Every byte after the sync word is wrapped in a start bit and a stop bit and
 * sent least significant bit first, the same shape a UART puts on a wire.
 */
export function buildFskFrame(payload: Uint8Array): FskFrame {
  if (payload.length > 0xffff) {
    throw new ToolError(
      "bad-option",
      `A frame carries at most 65535 bytes, but ${payload.length} were given.`,
      "Split the payload into smaller messages.",
    );
  }
  const checked = new Uint8Array(2 + payload.length);
  checked[0] = (payload.length >> 8) & 0xff;
  checked[1] = payload.length & 0xff;
  checked.set(payload, 2);
  const crc = crc16Ccitt(checked);

  const bits: number[] = [];
  for (let i = 0; i < FSK_PREAMBLE_BITS; i++) bits.push(i % 2);
  for (let i = FSK_SYNC_LENGTH - 1; i >= 0; i--) bits.push((FSK_SYNC_WORD >> i) & 1);
  const framed = new Uint8Array(checked.length + 2);
  framed.set(checked, 0);
  framed[checked.length] = (crc >> 8) & 0xff;
  framed[checked.length + 1] = crc & 0xff;
  for (const byte of framed) {
    bits.push(0);
    for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
    bits.push(1);
  }
  return { bits, checked, crc, framedByteCount: framed.length };
}

/** Total bits on the air for a payload of `payloadLength` bytes. */
export function fskFrameBitCount(payloadLength: number): number {
  return FSK_PREAMBLE_BITS + FSK_SYNC_LENGTH + (payloadLength + 4) * 10;
}

export interface FskOpts {
  sampleRate: number;
  /** Bits per second. Defaults to 100, which is slow enough to survive a room. */
  baud?: number;
  /** Tone for a 0 bit. Defaults to 1200 Hz. */
  f0?: number;
  /** Tone for a 1 bit. Defaults to 2200 Hz. */
  f1?: number;
  /** Peak amplitude, 0 to 1. Defaults to 0.6. */
  amplitude?: number;
}

function resolveFskOpts(opts: FskOpts): {
  sampleRate: number;
  baud: number;
  f0: number;
  f1: number;
  amplitude: number;
} {
  const sampleRate = requireSampleRate(opts.sampleRate);
  const baud = requireRange(opts.baud ?? FSK_DEFAULT_BAUD, 1, 2000, "Data speed", "baud");
  const f0 = requireRange(opts.f0 ?? FSK_DEFAULT_F0, 50, sampleRate / 3, "Tone for 0", "Hz");
  const f1 = requireRange(opts.f1 ?? FSK_DEFAULT_F1, 50, sampleRate / 3, "Tone for 1", "Hz");
  const amplitude = requireRange(opts.amplitude ?? 0.6, 0, 1, "Amplitude", "");
  return { sampleRate, baud, f0, f1, amplitude };
}

/**
 * Modulate a payload as audio frequency shift keying, one tone per bit.
 *
 * The phase carries over from one bit to the next instead of restarting, so
 * the waveform has no steps in it at all. That is what keeps the spectrum
 * narrow enough for a laptop speaker and a phone microphone to agree on it,
 * and it is the same trick Bell 202 and AX.25 packet radio use.
 */
export function encodeFsk(bytes: Uint8Array, opts: FskOpts): Float32Array {
  const { sampleRate, baud, f0, f1, amplitude } = resolveFskOpts(opts);
  const { bits } = buildFskFrame(bytes);
  const samplesPerBit = sampleRate / baud;
  const totalSamples = Math.round(bits.length * samplesPerBit);
  const out = new Float32Array(totalSamples);

  let phase = 0;
  for (let b = 0; b < bits.length; b++) {
    const start = Math.round(b * samplesPerBit);
    const end = Math.min(totalSamples, Math.round((b + 1) * samplesPerBit));
    const step = (2 * Math.PI * (bits[b] === 1 ? f1 : f0)) / sampleRate;
    for (let i = start; i < end; i++) {
      out[i] = amplitude * Math.sin(phase);
      phase += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/**
 * Score every candidate bit position by the difference between the energy at
 * the mark tone and the energy at the space tone. Positions are placed on a
 * grid of an eighth of a bit, so a bit `n` after any candidate start is always
 * exactly `n * 8` grid steps later and the sync hunt is plain array indexing.
 */
function fskDecisionTrack(
  samples: ArrayLike<number>,
  sampleRate: number,
  baud: number,
  f0: number,
  f1: number,
): { diff: Float64Array; steps: number } {
  const samplesPerBit = sampleRate / baud;
  const window = Math.max(8, Math.round(samplesPerBit));
  const stepSamples = samplesPerBit / FSK_SUBSTEPS;
  const steps = Math.max(0, Math.floor((samples.length - window) / stepSamples) + 1);
  const diff = new Float64Array(steps);
  for (let s = 0; s < steps; s++) {
    const start = Math.round(s * stepSamples);
    diff[s] =
      goertzel(samples, sampleRate, f1, start, window) -
      goertzel(samples, sampleRate, f0, start, window);
  }
  return { diff, steps };
}

function readFramedByte(diff: Float64Array, base: number, byteIndex: number): number | null {
  const start = base + byteIndex * 10 * FSK_SUBSTEPS;
  let value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const index = start + (1 + bit) * FSK_SUBSTEPS;
    if (index < 0 || index >= diff.length) return null;
    if (diff[index] > 0) value |= 1 << bit;
  }
  return value;
}

type FrameAttempt = { ok: true; bytes: Uint8Array } | { ok: false; reason: "short" | "crc" };

function tryFskFrame(diff: Float64Array, patternStart: number, patternBits: number): FrameAttempt {
  const base = patternStart + patternBits * FSK_SUBSTEPS;
  // How many framed bytes the track still reaches. Only the eight data bits of
  // a byte have to be in range, not its stop bit, so the last byte of a frame
  // is still readable when the recording stops the instant the tones do.
  const available =
    Math.floor((diff.length - 1 - base - 8 * FSK_SUBSTEPS) / (10 * FSK_SUBSTEPS)) + 1;
  if (available < 4) return { ok: false, reason: "short" };
  const high = readFramedByte(diff, base, 0);
  const low = readFramedByte(diff, base, 1);
  if (high === null || low === null) return { ok: false, reason: "short" };
  const length = (high << 8) | low;
  if (length + 4 > available) return { ok: false, reason: "short" };

  const checked = new Uint8Array(2 + length);
  checked[0] = high;
  checked[1] = low;
  for (let i = 0; i < length; i++) {
    const byte = readFramedByte(diff, base, 2 + i);
    if (byte === null) return { ok: false, reason: "short" };
    checked[2 + i] = byte;
  }
  const crcHigh = readFramedByte(diff, base, 2 + length);
  const crcLow = readFramedByte(diff, base, 3 + length);
  if (crcHigh === null || crcLow === null) return { ok: false, reason: "short" };
  if (crc16Ccitt(checked) !== ((crcHigh << 8) | crcLow)) return { ok: false, reason: "crc" };
  return { ok: true, bytes: checked.slice(2) };
}

/**
 * Demodulate a payload back out of recorded audio.
 *
 * Recovering the clock is the whole job: the receiver has no idea where the
 * sender started. The decoder slides a one bit window along the recording in
 * eighth of a bit steps, then looks for the last eight alternating preamble
 * bits followed by the sync word. Every position that matches well is tried as
 * a frame start, best match first, and the first one whose CRC agrees wins, so
 * a chance match in room noise costs nothing but a few microseconds.
 */
export function decodeFsk(
  samples: ArrayLike<number>,
  sampleRate: number,
  opts: Partial<FskOpts> = {},
): Uint8Array {
  const { baud, f0, f1 } = resolveFskOpts({ ...opts, sampleRate });
  const { diff, steps } = fskDecisionTrack(samples, sampleRate, baud, f0, f1);

  const pattern: number[] = [];
  for (let i = 0; i < 8; i++) pattern.push((FSK_PREAMBLE_BITS - 8 + i) % 2);
  for (let i = FSK_SYNC_LENGTH - 1; i >= 0; i--) pattern.push((FSK_SYNC_WORD >> i) & 1);

  const lastStart = steps - (pattern.length - 1) * FSK_SUBSTEPS - 1;
  if (lastStart < 0) {
    throw new ToolError(
      "no-signal",
      "The recording is too short to hold a complete frame.",
      "Record the whole transmission, including the tones before the data starts.",
    );
  }

  const scores = new Int32Array(lastStart + 1);
  let bestScore = 0;
  for (let s = 0; s <= lastStart; s++) {
    let score = 0;
    for (let i = 0; i < pattern.length; i++) {
      const bit = diff[s + i * FSK_SUBSTEPS] > 0 ? 1 : 0;
      if (bit === pattern[i]) score++;
    }
    scores[s] = score;
    if (score > bestScore) bestScore = score;
  }
  const threshold = Math.max(pattern.length - 2, bestScore - 1);
  if (bestScore < threshold) {
    throw new ToolError(
      "no-signal",
      "No preamble and sync word were found in the recording.",
      "Play the tones louder or closer to the microphone, and make sure the recording starts before the transmission does.",
    );
  }

  // Group the matching positions into runs and take the middle of each: the
  // true alignment sits at the centre of the stretch of positions that match.
  const candidates: { start: number; score: number }[] = [];
  let runStart = -1;
  let runScore = 0;
  for (let s = 0; s <= lastStart + 1; s++) {
    const matching = s <= lastStart && scores[s] >= threshold;
    if (matching) {
      if (runStart < 0) {
        runStart = s;
        runScore = scores[s];
      } else if (scores[s] > runScore) {
        runScore = scores[s];
      }
    } else if (runStart >= 0) {
      candidates.push({ start: Math.round((runStart + s - 1) / 2), score: runScore });
      runStart = -1;
      runScore = 0;
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);

  let sawCrcFailure = false;
  for (const candidate of candidates.slice(0, 48)) {
    const attempt = tryFskFrame(diff, candidate.start, pattern.length);
    if (attempt.ok) return attempt.bytes;
    if (attempt.reason === "crc") sawCrcFailure = true;
  }

  if (sawCrcFailure) {
    throw new ToolError(
      "bad-checksum",
      "A frame was found but its CRC-16 does not match, so the payload arrived corrupted.",
      "Reduce background noise, move the devices closer together, or send at a slower baud rate.",
    );
  }
  throw new ToolError(
    "no-signal",
    "No complete frame was found in the recording.",
    "Record the whole transmission and check that the tones are audible and not clipped.",
  );
}

/* ------------------------------------------------------------------ */
/* WAV encoding                                                        */
/* ------------------------------------------------------------------ */

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encode samples as a 16-bit PCM mono WAV file: the standard 44 byte header
 * (12 byte RIFF chunk, 24 byte fmt chunk, 8 byte data header) then two bytes
 * per sample, little endian.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  requireSampleRate(sampleRate);
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface AudioDataCodecOpts {
  mode: string;
  wpm: number;
  toneHz: number;
  baud: number;
  [key: string]: unknown;
}

export type AudioDataCodecResult = Record<string, string>;

const MODES: Record<string, string> = {
  "text-to-morse": "text-to-morse",
  "morse-to-text": "morse-to-text",
  dtmf: "dtmf",
  "fsk-info": "fsk-info",
  morse: "text-to-morse",
  encode: "text-to-morse",
  "encode-morse": "text-to-morse",
  "text-to-morse-code": "text-to-morse",
  decode: "morse-to-text",
  "decode-morse": "morse-to-text",
  "morse-code-to-text": "morse-to-text",
  "touch-tone": "dtmf",
  tones: "dtmf",
  fsk: "fsk-info",
  afsk: "fsk-info",
  modem: "fsk-info",
  "audio-data": "fsk-info",
  data: "fsk-info",
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
}

const DTMF_PANEL_TONE_MS = 100;
const DTMF_PANEL_GAP_MS = 100;

/**
 * Describe the requested encode or decode in words and numbers. Playing the
 * tones, listening to a microphone, and saving a WAV all need the browser, so
 * the panel drives those with the helpers above; the shared shell only ever
 * sees text.
 */
export function run(input: string, opts: AudioDataCodecOpts): AudioDataCodecResult {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const modeRaw = String(opts?.mode ?? "text-to-morse")
    .trim()
    .toLowerCase();
  const mode = MODES[modeRaw];
  if (!mode) {
    throw new ToolError(
      "bad-option",
      `"${opts?.mode}" is not a mode this tool supports.`,
      "Choose text-to-morse, morse-to-text, dtmf, or fsk-info.",
    );
  }

  const wpm = requireRange(
    opts?.wpm === undefined ? 15 : Number(opts.wpm),
    5,
    40,
    "Morse speed",
    "WPM",
  );
  const toneHz = requireRange(
    opts?.toneHz === undefined ? 600 : Number(opts.toneHz),
    300,
    1500,
    "Morse tone",
    "Hz",
  );
  const baud = requireRange(
    opts?.baud === undefined ? 100 : Number(opts.baud),
    50,
    300,
    "Data speed",
    "baud",
  );

  if (!raw.trim()) {
    throw new ToolError(
      "empty-input",
      "There is nothing to encode yet.",
      mode === "morse-to-text"
        ? "Paste Morse written with dots, dashes, spaces between letters and / between words."
        : mode === "dtmf"
          ? "Type a dial string such as 1-800-555-0100, or the keys 0 to 9, A to D, * and #."
          : "Type the text you want to send.",
    );
  }

  const timing = morseTiming(wpm);

  if (mode === "text-to-morse") {
    const morse = textToMorse(raw);
    const durationMs = morseDurationMs(morse, timing);
    const words = morse.split(" / ").length;
    const characters = morse.split(/\s+/).filter((token) => token !== "/").length;
    return {
      Morse: morse,
      Text: normalizeTextForMorse(raw).trim().replace(/\s+/g, " "),
      Counts: `${characters} characters in ${words} ${words === 1 ? "word" : "words"}`,
      Timing: `dit ${round(timing.ditMs, 1)} ms, dah ${round(timing.dahMs, 1)} ms, letter gap ${round(timing.charGapMs, 1)} ms, word gap ${round(timing.wordGapMs, 1)} ms`,
      Duration: `${formatMs(durationMs)} at ${wpm} WPM`,
      Tone: `${toneHz} Hz sidetone with 5 ms rise and fall`,
      Audio:
        "Press play in the panel to hear this, or save it as a 16-bit WAV. Nothing plays on its own.",
    };
  }

  if (mode === "morse-to-text") {
    const text = morseToText(raw);
    const morse = normalizeMorseString(raw);
    const durationMs = morseDurationMs(morse, timing);
    return {
      Text: text,
      Morse: morse,
      Counts: `${text.replace(/\s/g, "").length} characters in ${text.split(" ").filter(Boolean).length} words`,
      Duration: `${formatMs(durationMs)} at ${wpm} WPM`,
      Timing: `dit ${round(timing.ditMs, 1)} ms, dah ${round(timing.dahMs, 1)} ms at ${wpm} WPM`,
      Audio: "Press play in the panel to hear the same Morse read back at the speed set above.",
    };
  }

  if (mode === "dtmf") {
    const digits = normalizeDtmfDigits(raw);
    if (!digits) {
      throw new ToolError(
        "bad-dtmf",
        "That dial string has no keys in it once the separators are removed.",
        "Use 0 to 9, A to D, * and #.",
      );
    }
    const out: AudioDataCodecResult = {
      Keys: digits,
      Sequence: [...digits]
        .map((key) => `${key} ${DTMF_FREQS[key].low}/${DTMF_FREQS[key].high}`)
        .join(", "),
    };
    for (const key of new Set(digits)) {
      out[`Key ${key}`] =
        `${DTMF_FREQS[key].low} Hz low group + ${DTMF_FREQS[key].high} Hz high group`;
    }
    const durationMs = digits.length * DTMF_PANEL_TONE_MS + (digits.length - 1) * DTMF_PANEL_GAP_MS;
    out.Duration = `${formatMs(durationMs)} at ${DTMF_PANEL_TONE_MS} ms tones and ${DTMF_PANEL_GAP_MS} ms gaps`;
    out.Standard =
      "ITU-T Q.23 dual tone multi frequency: one tone from the 697, 770, 852, 941 Hz low group plus one from the 1209, 1336, 1477, 1633 Hz high group.";
    out.Audio =
      "Press play in the panel to dial this, or save it as a WAV. The panel can also listen and read tones back.";
    return out;
  }

  const payload = new TextEncoder().encode(raw);
  const frame = buildFskFrame(payload);
  const bitCount = frame.bits.length;
  const durationMs = (bitCount / baud) * 1000;
  return {
    Payload: `${payload.length} bytes of UTF-8 (${raw.length} characters)`,
    Frame: `${FSK_PREAMBLE_BITS} bit alternating preamble, ${FSK_SYNC_LENGTH} bit sync word 0x${FSK_SYNC_WORD.toString(16).toUpperCase()}, 2 byte length, ${payload.length} byte payload, 2 byte checksum`,
    Framing: "Every byte is sent least significant bit first inside a start bit and a stop bit.",
    "Total bits": `${bitCount} bits, including ${frame.framedByteCount} framed bytes`,
    Duration: `${formatMs(durationMs)} at ${baud} baud`,
    Tones: `${FSK_DEFAULT_F0} Hz for a 0 bit, ${FSK_DEFAULT_F1} Hz for a 1 bit, phase continuous`,
    Checksum: `CRC-16/CCITT-FALSE 0x${frame.crc.toString(16).toUpperCase().padStart(4, "0")}`,
    Audio:
      "Press send in the panel to play this through the speaker, and open the same page on the other device to listen. Works best in a quiet room within a few metres.",
  };
}

export default { run } satisfies ToolLogic<string, AudioDataCodecResult, AudioDataCodecOpts>;
