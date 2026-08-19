import { formatBytes } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * BPM and Key Detector: the pure DSP layer.
 *
 * Everything here is arithmetic on typed arrays. Decoding an audio file,
 * downmixing it to mono, and painting confidence bars belong to the panel;
 * this file turns mono PCM into a tempo and a key, and turns a typed tempo,
 * tap list, or key name into readable rows.
 *
 * The three measurements are independent and each is exported on its own so
 * the panel can run them separately and report progress between them:
 *
 * - `bpmFromTaps` averages a run of tap times.
 * - `detectBpm` builds an onset strength envelope, autocorrelates it, and
 *   picks the beat period.
 * - `chromagram` plus `detectKey` fold the spectrum into twelve pitch classes
 *   and correlate that against the Krumhansl-Schmuckler key profiles.
 */

/** Mono PCM in any of the shapes a caller is likely to hold. */
export type Samples = Float32Array | Float64Array | number[];

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** True for 1, 2, 4, 8, ... and false for zero, negatives, and everything else. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function largestPowerOfTwoAtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/* ------------------------------------------------------------------ */
/* FFT                                                                 */
/* ------------------------------------------------------------------ */

/** Cached twiddle factors per transform length: cos/sin of -2*pi*k/n. */
const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  const cached = twiddleCache.get(n);
  if (cached) return cached;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  const table = { cos, sin };
  twiddleCache.set(n, table);
  return table;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 *
 * `re` and `im` hold the real and imaginary parts and are overwritten with the
 * transform. The length must be a power of two. The transform is unnormalized,
 * so a constant signal of value 1 and length N produces N in bin 0.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) {
    throw new ToolError(
      "fft-length-mismatch",
      `The real and imaginary buffers have different lengths (${n} and ${im.length}).`,
      "Allocate both arrays with the same power of two length before calling fft.",
    );
  }
  if (!isPowerOfTwo(n)) {
    throw new ToolError(
      "fft-not-power-of-two",
      `A radix-2 FFT needs a power of two length, but the buffer holds ${n} samples.`,
      "Pad or trim the buffer to 512, 1024, 2048, 4096, or another power of two.",
    );
  }
  if (n === 1) return;

  // Bit-reversal permutation, so the butterflies run over contiguous pairs.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  const { cos, sin } = twiddles(n);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const t = k * step;
        const wr = cos[t]!;
        const wi = sin[t]!;
        const a = start + k;
        const b = a + half;
        const br = re[b]!;
        const bi = im[b]!;
        const vr = br * wr - bi * wi;
        const vi = br * wi + bi * wr;
        const ar = re[a]!;
        const ai = im[a]!;
        re[a] = ar + vr;
        im[a] = ai + vi;
        re[b] = ar - vr;
        im[b] = ai - vi;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();

/**
 * Symmetric Hann window of length n. The result is cached and shared, so treat
 * it as read only: multiply it into a separate frame buffer, never in place.
 */
export function hannWindow(n: number): Float64Array {
  if (!Number.isInteger(n) || n < 2) {
    throw new ToolError(
      "bad-window-length",
      `A Hann window needs at least 2 points, but ${n} was requested.`,
      "Pass a whole number of samples, normally the FFT size.",
    );
  }
  const cached = hannCache.get(n);
  if (cached) return cached;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  hannCache.set(n, w);
  return w;
}

function assertSamples(samples: Samples, sampleRate: number): void {
  if (!samples || typeof samples.length !== "number" || samples.length === 0) {
    throw new ToolError(
      "empty-audio",
      "No audio samples were provided.",
      "Decode an audio file to mono PCM first, then pass the sample array.",
    );
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ToolError(
      "bad-sample-rate",
      `The sample rate must be a positive number, but ${sampleRate} was given.`,
      "Pass the AudioContext sample rate, usually 44100 or 48000.",
    );
  }
}

function peakAmplitude(samples: Samples): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
  }
  return peak;
}

/* ------------------------------------------------------------------ */
/* Onset strength envelope                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_ONSET_FRAME = 1024;
export const DEFAULT_ONSET_HOP = 512;

export interface OnsetEnvelopeOptions {
  /** FFT size per frame, a power of two. Default 1024. */
  frameSize?: number;
  /** Frames start this many samples apart. Default 512. */
  hop?: number;
  /**
   * Width in frames of the Gaussian that broadens each onset peak. Default 1.5.
   *
   * Broadening matters more than it looks: a beat period is almost never a
   * whole number of frames, so the onsets land on alternating neighbouring
   * frames. A peak one frame wide would make the autocorrelation choose one of
   * those whole numbers; a peak a few frames wide merges them into a single
   * smooth bump whose centre is the real period.
   */
  smoothing?: number;
}

export interface OnsetEnvelope {
  /** Onset strength, one value per frame, zero or greater. */
  values: Float64Array;
  /** Frames per second, that is sampleRate / hop. */
  rate: number;
  frameSize: number;
  hop: number;
}

/** How hard the log compression squashes the spectrum before differencing. */
const SPECTRAL_COMPRESSION = 100;

/**
 * Spectral flux onset strength.
 *
 * Each frame is windowed and transformed, the magnitudes are log compressed so
 * a quiet passage still registers, and the frame is compared with the previous
 * one: only the bins that grew count, which is what makes a note start read as
 * a peak and a note ending read as nothing. A local mean is then subtracted and
 * the result is half wave rectified, so a steady loud texture flattens out and
 * only the attacks survive. Finally the peaks are broadened with a small
 * Gaussian, which is what lets the autocorrelation resolve a fractional period.
 */
export function onsetEnvelope(
  samples: Samples,
  sampleRate: number,
  options: OnsetEnvelopeOptions = {},
): OnsetEnvelope {
  assertSamples(samples, sampleRate);

  const frameSize = options.frameSize ?? DEFAULT_ONSET_FRAME;
  const hop = options.hop ?? DEFAULT_ONSET_HOP;
  if (!isPowerOfTwo(frameSize)) {
    throw new ToolError(
      "bad-frame-size",
      `The onset frame size must be a power of two, but ${frameSize} was given.`,
      "Use 512, 1024, or 2048 samples per frame.",
    );
  }
  if (!Number.isInteger(hop) || hop < 1 || hop > frameSize) {
    throw new ToolError(
      "bad-hop",
      `The hop must be a whole number between 1 and the frame size, but ${hop} was given.`,
      `Use a hop of ${frameSize / 2} samples or fewer.`,
    );
  }

  const n = samples.length;
  const frames = Math.max(1, Math.floor((n - frameSize) / hop) + 1);
  const bins = frameSize / 2 + 1;
  const window = hannWindow(frameSize);
  const peak = peakAmplitude(samples);
  const gain = peak > 0 ? 1 / peak : 1;

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);
  const flux = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i;
      const v = idx < n ? (samples[idx] as number) : 0;
      re[i] = v * gain * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const magnitude = Math.sqrt(re[b]! * re[b]! + im[b]! * im[b]!);
      current[b] = Math.log1p(SPECTRAL_COMPRESSION * magnitude);
    }
    if (f > 0) {
      let sum = 0;
      for (let b = 0; b < bins; b++) {
        const rise = current[b]! - previous[b]!;
        if (rise > 0) sum += rise;
      }
      flux[f] = sum;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  // Subtract a local mean over roughly 100 ms, then keep only what is above it.
  const rate = sampleRate / hop;
  const radius = Math.max(1, Math.round(0.1 * rate));
  const rectified = new Float64Array(frames);
  let runningSum = 0;
  for (let f = 0; f < Math.min(frames, radius + 1); f++) runningSum += flux[f]!;
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - radius);
    const hi = Math.min(frames - 1, f + radius);
    if (f > 0) {
      const entering = f + radius;
      const leaving = f - radius - 1;
      if (entering < frames) runningSum += flux[entering]!;
      if (leaving >= 0) runningSum -= flux[leaving]!;
    }
    const mean = runningSum / (hi - lo + 1);
    const value = flux[f]! - mean;
    rectified[f] = value > 0 ? value : 0;
  }

  const sigma = options.smoothing ?? 1.5;
  if (!(sigma >= 0)) {
    throw new ToolError(
      "bad-smoothing",
      `The onset smoothing width must be zero or greater, but ${sigma} was given.`,
      "Leave it at the default of 1.5 frames unless you know you need a different one.",
    );
  }
  const values = sigma > 0 ? gaussianSmooth(rectified, sigma) : rectified;
  return { values, rate, frameSize, hop };
}

/** Convolve with a normalized Gaussian truncated at three standard deviations. */
function gaussianSmooth(input: Float64Array, sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    total += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] = kernel[k]! / total;

  const n = input.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += input[j]! * kernel[k + radius]!;
    }
    out[i] = sum;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tempo from autocorrelation                                          */
/* ------------------------------------------------------------------ */

export const MIN_DETECT_BPM = 40;
export const MAX_DETECT_BPM = 300;

/** The tempo the octave preference leans towards, in beats per minute. */
export const PREFERRED_BPM = 120;
/** Width of that preference in octaves. One octave out costs about half. */
const PREFERENCE_WIDTH = 0.9;

export interface DetectBpmOptions extends OnsetEnvelopeOptions {
  /** Slowest tempo to consider. Default 60. */
  minBpm?: number;
  /** Fastest tempo to consider. Default 200. */
  maxBpm?: number;
}

export interface BpmCandidate {
  /** Tempo in beats per minute, one decimal. */
  bpm: number;
  /** Relative strength, 1 for the winner and less for the rest. */
  score: number;
}

export interface BpmResult {
  /** The chosen tempo in beats per minute, one decimal. */
  bpm: number;
  /** How trustworthy the answer is, 0 to 1. */
  confidence: number;
  /** The strongest periods found, best first, at most five. */
  candidates: BpmCandidate[];
  /** Frames per second of the onset envelope the answer came from. */
  envelopeRate: number;
}

/**
 * Preference for tempos near 120 bpm, on a log scale so it is symmetric in
 * octaves. This is what breaks the octave tie: a track at 120 bpm correlates
 * just as well at 60 bpm, and only a prior can say which one a listener would
 * count. The width is deliberately gentle, so a genuine 75 bpm ballad still
 * wins against its own 150 bpm double when the evidence says so.
 */
function tempoPreference(bpm: number): number {
  const octaves = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_WIDTH;
  return Math.exp(-0.5 * octaves * octaves);
}

/**
 * Detect the tempo of mono PCM.
 *
 * The onset envelope is mean removed and autocorrelated at every whole frame
 * lag, using a normalized correlation so a long lag is not punished for having
 * fewer overlapping frames. Every local maximum inside the tempo range becomes
 * a candidate, refined to a fractional lag by fitting a parabola through the
 * peak and its two neighbours. Each candidate is scored by its own correlation
 * plus a smaller share of the correlation at twice and three times its period,
 * since a real beat period repeats at its multiples, and the whole score is
 * weighted by the preference for tempos near 120 bpm.
 */
export function detectBpm(
  samples: Samples,
  sampleRate: number,
  options: DetectBpmOptions = {},
): BpmResult {
  assertSamples(samples, sampleRate);
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;
  if (!Number.isFinite(minBpm) || !Number.isFinite(maxBpm) || minBpm >= maxBpm) {
    throw new ToolError(
      "bad-tempo-range",
      `The tempo range ${minBpm} to ${maxBpm} bpm is not usable.`,
      "Give a minimum below the maximum, for example 60 and 200.",
    );
  }
  if (minBpm < MIN_DETECT_BPM || maxBpm > MAX_DETECT_BPM) {
    throw new ToolError(
      "bad-tempo-range",
      `The tempo range must sit inside ${MIN_DETECT_BPM} to ${MAX_DETECT_BPM} bpm, but ${minBpm} to ${maxBpm} was given.`,
      `Narrow the range, for example 60 to 200 bpm.`,
    );
  }

  const envelope = onsetEnvelope(samples, sampleRate, options);
  const values = envelope.values;
  const frames = values.length;

  const shortestLag = Math.max(1, Math.floor((60 * envelope.rate) / maxBpm));
  const longestLag = Math.ceil((60 * envelope.rate) / minBpm);
  if (frames < longestLag * 2 + 2) {
    const needed = round((longestLag * 2 + 2) / envelope.rate, 1);
    throw new ToolError(
      "audio-too-short",
      `Measuring a tempo down to ${minBpm} bpm needs about ${needed} seconds of audio, but only ${round(samples.length / sampleRate, 2)} seconds were given.`,
      "Analyse a longer stretch of the track, or raise the minimum tempo.",
    );
  }

  let mean = 0;
  for (let i = 0; i < frames; i++) mean += values[i]!;
  mean /= frames;
  const x = new Float64Array(frames);
  for (let i = 0; i < frames; i++) x[i] = values[i]! - mean;

  // Correlate out to three times the longest beat period so the harmonic
  // check below has something to read at twice and three times each period.
  const maxLag = Math.min(frames - 2, longestLag * 3);
  const acf = new Float64Array(maxLag + 1);
  acf[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let dot = 0;
    let left = 0;
    let right = 0;
    const last = frames - lag;
    for (let i = 0; i < last; i++) {
      const a = x[i]!;
      const b = x[i + lag]!;
      dot += a * b;
      left += a * a;
      right += b * b;
    }
    const den = Math.sqrt(left * right);
    acf[lag] = den > 0 ? dot / den : 0;
  }

  /** Read the correlation at a fractional lag, zero outside the computed range. */
  const acfAt = (lag: number): number => {
    if (!(lag >= 1) || lag > maxLag) return 0;
    const lo = Math.floor(lag);
    const hi = Math.min(maxLag, lo + 1);
    const t = lag - lo;
    return acf[lo]! * (1 - t) + acf[hi]! * t;
  };

  // Search one frame past each edge of the range. A peak that sits exactly on
  // the boundary, which is what the half tempo of a 120 bpm track does at a
  // 60 bpm minimum, would otherwise be refined a hair outside and thrown away.
  const searchHigh = Math.min(longestLag + 1, maxLag - 1);
  const searchLow = Math.max(1, Math.min(shortestLag - 1, searchHigh));
  const found: { lag: number; bpm: number; score: number; strength: number }[] = [];
  for (let lag = searchLow; lag <= searchHigh; lag++) {
    const here = acf[lag]!;
    const before = lag > 1 ? acf[lag - 1]! : -Infinity;
    const after = acf[lag + 1] ?? -Infinity;
    if (!(here >= before && here >= after)) continue;
    if (here <= 0) continue;

    // Fit a parabola through the peak and its neighbours. With the middle point
    // the largest of the three the vertex always lands within half a frame.
    let refined = lag;
    if (Number.isFinite(before) && Number.isFinite(after)) {
      const denominator = before - 2 * here + after;
      if (denominator !== 0) refined = lag + (0.5 * (before - after)) / denominator;
    }
    const raw = (60 * envelope.rate) / refined;
    if (raw < minBpm * 0.99 || raw > maxBpm * 1.01) continue;
    const bpm = Math.min(maxBpm, Math.max(minBpm, raw));
    const strength = acfAt(refined);
    const harmonics =
      Math.max(0, strength) +
      0.5 * Math.max(0, acfAt(refined * 2)) +
      0.25 * Math.max(0, acfAt(refined * 3));
    found.push({ lag: refined, bpm, score: tempoPreference(bpm) * harmonics, strength });
  }

  if (found.length === 0) {
    throw new ToolError(
      "no-beat",
      `No repeating beat was found between ${minBpm} and ${maxBpm} bpm.`,
      "Try a longer or more rhythmic section of the track, or widen the tempo range.",
    );
  }

  found.sort((a, b) => b.score - a.score);
  const best = found[0]!;
  const runnerUp = found.find((c) => Math.abs(c.bpm - best.bpm) > best.bpm * 0.02);
  const margin = runnerUp && best.score > 0 ? (best.score - runnerUp.score) / best.score : 1;
  const confidence = clamp01(best.strength) * (0.5 + 0.5 * clamp01(margin * 3));

  const candidates = found.slice(0, 5).map((c) => ({
    bpm: round(c.bpm, 1),
    score: round(best.score > 0 ? c.score / best.score : 0, 4),
  }));

  return {
    bpm: round(best.bpm, 1),
    confidence: round(confidence, 3),
    candidates,
    envelopeRate: envelope.rate,
  };
}

/* ------------------------------------------------------------------ */
/* Tap tempo                                                           */
/* ------------------------------------------------------------------ */

export const MIN_TAP_BPM = 20;
export const MAX_TAP_BPM = 400;

export interface TapTempoOptions {
  /** Only the most recent taps count. Default 16. */
  maxTaps?: number;
}

export interface TapTempoResult {
  /** Tempo in beats per minute, one decimal. */
  bpm: number;
  /** How even the taps were, 0 to 1. */
  confidence: number;
  /** Taps that fell inside the tempo range and were considered. */
  taps: number;
  /** Gaps kept after trimming the outliers. */
  intervals: number;
  /** Mean of the kept gaps, in milliseconds. */
  averageIntervalMs: number;
  /** Standard deviation of the kept gaps, in milliseconds. */
  spreadMs: number;
}

/**
 * Average a run of tap times into a tempo.
 *
 * Timestamps are milliseconds on any monotonic clock, which is what
 * `performance.now()` and a DOM event's `timeStamp` both give you. Only the
 * last `maxTaps` are read, gaps outside the tempo range are dropped first (a
 * pause between phrases is not a beat), then gaps more than 40 percent away
 * from the median are trimmed so one late tap cannot drag the estimate.
 * Confidence falls as the surviving gaps disagree with each other, and is held
 * back until there are enough of them to mean anything. Returns null when
 * there is not enough usable data.
 */
export function bpmFromTaps(
  timestampsMs: number[],
  options: TapTempoOptions = {},
): TapTempoResult | null {
  if (!Array.isArray(timestampsMs)) return null;
  const maxTaps = options.maxTaps ?? 16;
  if (!Number.isFinite(maxTaps) || maxTaps < 2) {
    throw new ToolError(
      "bad-max-taps",
      `maxTaps must be 2 or more, but ${maxTaps} was given.`,
      "Leave it at the default of 16, or pass a larger whole number.",
    );
  }

  const clean = timestampsMs.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const recent = clean.slice(Math.max(0, clean.length - Math.floor(maxTaps)));
  if (recent.length < 2) return null;

  const shortest = 60000 / MAX_TAP_BPM;
  const longest = 60000 / MIN_TAP_BPM;
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i]! - recent[i - 1]!;
    if (gap >= shortest && gap <= longest) gaps.push(gap);
  }
  if (gaps.length === 0) return null;

  const sorted = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const kept = gaps.filter((gap) => Math.abs(gap - median) <= median * 0.4);
  const used = kept.length > 0 ? kept : gaps;

  const average = used.reduce((sum, gap) => sum + gap, 0) / used.length;
  if (!(average > 0)) return null;
  const variance = used.reduce((sum, gap) => sum + (gap - average) ** 2, 0) / used.length;
  const spread = Math.sqrt(variance);

  // Coefficient of variation: 5 percent jitter still reads as a solid tap,
  // 20 percent reads as guessing. Two or three gaps cannot prove much either
  // way, so the score is held back until there are four of them.
  const evenness = clamp01(1 - (spread / average) * 5);
  const enough = 0.55 + 0.45 * Math.min(1, used.length / 4);

  return {
    bpm: round(60000 / average, 1),
    confidence: round(evenness * enough, 3),
    taps: recent.length,
    intervals: used.length,
    averageIntervalMs: round(average, 3),
    spreadMs: round(spread, 3),
  };
}

/* ------------------------------------------------------------------ */
/* Chromagram                                                          */
/* ------------------------------------------------------------------ */

/** C2, the lowest pitch the chromagram reads. */
export const CHROMA_MIN_HZ = 65.40639;
/** C7, the highest pitch the chromagram reads. */
export const CHROMA_MAX_HZ = 2093.0045;

export const DEFAULT_CHROMA_FRAME = 8192;

export interface ChromagramOptions {
  /** FFT size per frame, a power of two. Default 8192. */
  frameSize?: number;
  /** Frames start this many samples apart. Default half the frame size. */
  hop?: number;
}

/**
 * Fold the spectrum into twelve pitch classes.
 *
 * Each frame is windowed and transformed, then every bin between C2 and C7 is
 * placed on a log frequency axis where one step is one semitone. A bin lands in
 * the pitch class it is nearest to, weighted by a raised cosine over how far it
 * sits from that semitone centre, so a bin exactly on the note counts fully and
 * a bin halfway between two notes counts for neither. Each frame is length
 * normalized before it is added in, so a loud chorus does not outvote a quiet
 * verse, and frames below the silence floor are skipped entirely.
 *
 * The result is twelve values starting at C, scaled so the strongest is 1.
 */
export function chromagram(
  samples: Samples,
  sampleRate: number,
  options: ChromagramOptions = {},
): Float64Array {
  assertSamples(samples, sampleRate);
  const n = samples.length;
  const requested = options.frameSize ?? DEFAULT_CHROMA_FRAME;
  if (!isPowerOfTwo(requested)) {
    throw new ToolError(
      "bad-frame-size",
      `The chroma frame size must be a power of two, but ${requested} was given.`,
      "Use 4096, 8192, or 16384 samples per frame.",
    );
  }
  const frameSize = Math.max(1024, Math.min(requested, largestPowerOfTwoAtMost(n)));
  const hop = options.hop ?? frameSize / 2;
  if (!Number.isInteger(hop) || hop < 1 || hop > frameSize) {
    throw new ToolError(
      "bad-hop",
      `The hop must be a whole number between 1 and the frame size, but ${hop} was given.`,
      `Use a hop of ${frameSize / 2} samples or fewer.`,
    );
  }

  const bins = frameSize / 2 + 1;
  const binHz = sampleRate / frameSize;
  const pitchClassOf = new Int8Array(bins).fill(-1);
  const weightOf = new Float64Array(bins);
  for (let b = 1; b < bins; b++) {
    const hz = b * binHz;
    if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const nearest = Math.round(midi);
    const deviation = midi - nearest;
    pitchClassOf[b] = (((nearest % 12) + 12) % 12) as number;
    weightOf[b] = 0.5 * (1 + Math.cos(2 * Math.PI * deviation));
  }

  const window = hannWindow(frameSize);
  const peak = peakAmplitude(samples);
  const silenceFloor = peak * 0.005;
  const frames = Math.max(1, Math.floor((n - frameSize) / hop) + 1);

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const total = new Float64Array(12);
  const frameChroma = new Float64Array(12);
  let used = 0;

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i;
      const v = idx < n ? (samples[idx] as number) : 0;
      energy += v * v;
      re[i] = v * window[i]!;
      im[i] = 0;
    }
    if (Math.sqrt(energy / frameSize) < silenceFloor) continue;

    fft(re, im);
    frameChroma.fill(0);
    for (let b = 1; b < bins; b++) {
      const pc = pitchClassOf[b]!;
      if (pc < 0) continue;
      const magnitude = Math.sqrt(re[b]! * re[b]! + im[b]! * im[b]!);
      frameChroma[pc] = frameChroma[pc]! + magnitude * weightOf[b]!;
    }
    let norm = 0;
    for (let p = 0; p < 12; p++) norm += frameChroma[p]! * frameChroma[p]!;
    norm = Math.sqrt(norm);
    if (norm <= 0) continue;
    for (let p = 0; p < 12; p++) total[p] = total[p]! + frameChroma[p]! / norm;
    used++;
  }

  if (used === 0) {
    throw new ToolError(
      "silent-audio",
      "The audio is silent, so there is no pitch content to read a key from.",
      "Analyse a section of the track that actually plays, or check that the file decoded correctly.",
    );
  }

  let max = 0;
  for (let p = 0; p < 12; p++) if (total[p]! > max) max = total[p]!;
  if (max > 0) for (let p = 0; p < 12; p++) total[p] = total[p]! / max;
  return total;
}

/* ------------------------------------------------------------------ */
/* Key names, Camelot, Open Key                                        */
/* ------------------------------------------------------------------ */

export type KeyMode = "major" | "minor";

/** Display spellings for major keys, starting at C. */
export const MAJOR_KEY_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

/** Display spellings for minor keys, starting at C. */
export const MINOR_KEY_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "Bb",
  "B",
] as const;

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

const NATURAL_PITCH_CLASS: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

function assertMode(mode: string): KeyMode {
  if (mode === "major" || mode === "minor") return mode;
  throw new ToolError(
    "bad-mode",
    `"${mode}" is not a mode this tool knows.`,
    'Use "major" or "minor".',
  );
}

/** Pitch class 0 to 11 for a tonic spelling such as "C", "F#", or "Bb". */
export function pitchClassOfTonic(tonic: string): number {
  const text = String(tonic ?? "")
    .trim()
    .replace(/[♯]/g, "#")
    .replace(/[♭]/g, "b");
  const match = /^([A-Ga-g])([#b]{0,2})$/.exec(text);
  if (!match) {
    throw new ToolError(
      "bad-tonic",
      `"${tonic}" is not a note name.`,
      "Use a letter from A to G with an optional sharp or flat, such as C, F#, or Bb.",
    );
  }
  let pc = NATURAL_PITCH_CLASS[match[1]!.toLowerCase()]!;
  for (const accidental of match[2]!) pc += accidental === "#" ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

/** Canonical display spelling for a key, such as "C" major or "C#" minor. */
export function tonicName(pitchClass: number, mode: KeyMode): string {
  const pc = ((Math.round(pitchClass) % 12) + 12) % 12;
  return mode === "minor" ? MINOR_KEY_NAMES[pc]! : MAJOR_KEY_NAMES[pc]!;
}

/** "A minor", "C major". The tonic is respelled the way the key is normally written. */
export function formatKey(tonic: string | number, mode: string): string {
  const safeMode = assertMode(mode);
  const pc = typeof tonic === "number" ? tonic : pitchClassOfTonic(tonic);
  return `${tonicName(pc, safeMode)} ${safeMode}`;
}

/**
 * Camelot wheel code, for example "8B" for C major and "8A" for A minor.
 *
 * The wheel is the circle of fifths with C major parked at 8 o'clock: every
 * step clockwise adds a fifth, B is the major ring and A is the minor ring, and
 * a minor key sits on the same number as its relative major.
 */
export function camelotFor(tonic: string | number, mode: string): string {
  const safeMode = assertMode(mode);
  const pc =
    typeof tonic === "number" ? ((Math.round(tonic) % 12) + 12) % 12 : pitchClassOfTonic(tonic);
  const relativeMajor = safeMode === "minor" ? (pc + 3) % 12 : pc;
  const fifths = (relativeMajor * 7) % 12;
  const number = ((fifths + 7) % 12) + 1;
  return `${number}${safeMode === "minor" ? "A" : "B"}`;
}

/**
 * Open Key code, for example "1d" for C major and "1m" for A minor. Open Key is
 * the same wheel rotated so C major sits at 1, with d for major and m for minor.
 */
export function openKeyFor(tonic: string | number, mode: string): string {
  const camelot = camelotFor(tonic, mode);
  const number = Number.parseInt(camelot, 10);
  const letter = camelot.endsWith("A") ? "m" : "d";
  return `${((number + 4) % 12) + 1}${letter}`;
}

export interface KeyName {
  tonic: string;
  mode: KeyMode;
  /** "A minor". */
  key: string;
}

/** The relative key: the major and minor that share a key signature. */
export function relativeKey(tonic: string | number, mode: string): KeyName {
  const safeMode = assertMode(mode);
  const pc =
    typeof tonic === "number" ? ((Math.round(tonic) % 12) + 12) % 12 : pitchClassOfTonic(tonic);
  const otherMode: KeyMode = safeMode === "major" ? "minor" : "major";
  const otherPc = safeMode === "major" ? (pc + 9) % 12 : (pc + 3) % 12;
  return {
    tonic: tonicName(otherPc, otherMode),
    mode: otherMode,
    key: formatKey(otherPc, otherMode),
  };
}

/** The parallel key: the same tonic in the other mode. */
export function parallelKey(tonic: string | number, mode: string): KeyName {
  const safeMode = assertMode(mode);
  const pc =
    typeof tonic === "number" ? ((Math.round(tonic) % 12) + 12) % 12 : pitchClassOfTonic(tonic);
  const otherMode: KeyMode = safeMode === "major" ? "minor" : "major";
  return { tonic: tonicName(pc, otherMode), mode: otherMode, key: formatKey(pc, otherMode) };
}

/**
 * The seven notes of the key, spelled with sharps or flats to match the key
 * signature. Sharp keys and flat keys get their own table, which keeps E major
 * reading as E F# G# A B C# D# rather than a mixture of the two.
 */
export function scaleNotes(tonic: string | number, mode: string): string[] {
  const safeMode = assertMode(mode);
  const pc =
    typeof tonic === "number" ? ((Math.round(tonic) % 12) + 12) % 12 : pitchClassOfTonic(tonic);
  const relativeMajor = safeMode === "minor" ? (pc + 3) % 12 : pc;
  const fifths = (relativeMajor * 7) % 12;
  const names = fifths >= 1 && fifths <= 6 ? SHARP_NAMES : FLAT_NAMES;
  const steps = safeMode === "minor" ? MINOR_STEPS : MAJOR_STEPS;
  return steps.map((step) => names[(pc + step) % 12]!);
}

/** Every Camelot and Open Key code mapped back to a key. */
const CODE_TO_KEY = new Map<string, KeyName>();
for (let pc = 0; pc < 12; pc++) {
  for (const mode of ["major", "minor"] as KeyMode[]) {
    const name: KeyName = { tonic: tonicName(pc, mode), mode, key: formatKey(pc, mode) };
    CODE_TO_KEY.set(camelotFor(pc, mode).toLowerCase(), name);
    CODE_TO_KEY.set(openKeyFor(pc, mode).toLowerCase(), name);
  }
}

/** Look up the key behind a Camelot or Open Key code, or null when there is none. */
export function keyFromCode(code: string): KeyName | null {
  const match = /^(\d{1,2})\s*([abdm])$/i.exec(String(code ?? "").trim());
  if (!match) return null;
  const number = Number.parseInt(match[1]!, 10);
  if (number < 1 || number > 12) return null;
  return CODE_TO_KEY.get(`${number}${match[2]!.toLowerCase()}`) ?? null;
}

const MAJOR_WORDS = new Set(["", "major", "maj", "ionian", "dur"]);
const MINOR_WORDS = new Set(["m", "minor", "min", "aeolian", "moll", "natural minor"]);

/**
 * Read a typed key. Accepts note names with or without a mode word ("C",
 * "A minor", "Bbm", "F sharp major", "E-flat minor") and Camelot or Open Key
 * codes ("8A", "1d").
 */
export function parseKey(text: string): KeyName {
  const raw = String(text ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-key",
      "No key was given.",
      'Type a key such as "A minor", or a Camelot code such as 8A.',
    );
  }
  const code = keyFromCode(raw);
  if (code) return code;

  const normalized = raw
    .replace(/[♯]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/[\s_-]*sharps?\b/gi, "#")
    .replace(/[\s_-]*flats?\b/gi, "b")
    .trim();
  const match = /^([A-Ga-g])\s*([#b]{0,2})\s*(.*)$/.exec(normalized);
  if (!match) {
    throw new ToolError(
      "bad-key",
      `"${raw}" is not a key this tool recognises.`,
      'Type a key such as "A minor" or "F# major", or a Camelot code such as 8A.',
    );
  }
  const word = match[3]!.trim().toLowerCase().replace(/\s+/g, " ");
  let mode: KeyMode;
  if (MAJOR_WORDS.has(word)) mode = "major";
  else if (MINOR_WORDS.has(word)) mode = "minor";
  else {
    throw new ToolError(
      "bad-mode",
      `"${match[3]!.trim()}" is not a mode this tool knows.`,
      'Write the key as a note plus "major" or "minor", such as "A minor" or "Bb major".',
    );
  }
  const pc = pitchClassOfTonic(`${match[1]}${match[2]}`);
  return { tonic: tonicName(pc, mode), mode, key: formatKey(pc, mode) };
}

/** The three Camelot codes that mix cleanly with a code, plus the energy jump. */
export function camelotNeighbours(camelot: string): string[] {
  const match = /^(\d{1,2})([AB])$/i.exec(String(camelot ?? "").trim());
  if (!match) {
    throw new ToolError(
      "bad-camelot",
      `"${camelot}" is not a Camelot code.`,
      "Use a number from 1 to 12 followed by A or B, such as 8A.",
    );
  }
  const number = Number.parseInt(match[1]!, 10);
  const letter = match[2]!.toUpperCase();
  const other = letter === "A" ? "B" : "A";
  const step = (delta: number) => ((number - 1 + delta + 12) % 12) + 1;
  return [`${step(-1)}${letter}`, `${step(1)}${letter}`, `${number}${other}`];
}

/* ------------------------------------------------------------------ */
/* Key detection                                                       */
/* ------------------------------------------------------------------ */

/**
 * Krumhansl-Kessler key profiles: how strongly listeners rated each of the
 * twelve pitch classes as fitting a major or a minor key, with the tonic first.
 */
export const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
] as const;

export const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
] as const;

export interface KeyCandidate {
  /** "A minor". */
  key: string;
  tonic: string;
  mode: KeyMode;
  camelot: string;
  openKey: string;
  /** Pearson correlation with the key profile, minus one to one. */
  score: number;
}

export interface KeyResult extends KeyCandidate {
  /** How trustworthy the answer is, 0 to 1. */
  confidence: number;
  /** The next three best keys, best first. */
  alternates: KeyCandidate[];
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;
  let dot = 0;
  let sqA = 0;
  let sqB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    dot += da * db;
    sqA += da * da;
    sqB += db * db;
  }
  const den = Math.sqrt(sqA * sqB);
  return den > 0 ? dot / den : 0;
}

/**
 * Name the key behind a chromagram.
 *
 * The twelve pitch class strengths are correlated against all 24 rotations of
 * the Krumhansl-Kessler major and minor profiles, and the rotation that
 * correlates best names the key. Correlation is used rather than a plain dot
 * product so an overall loud or quiet chromagram scores the same, and so a key
 * is chosen by the shape of the pitch distribution rather than its size.
 */
export function detectKey(chroma: Samples): KeyResult {
  if (!chroma || chroma.length !== 12) {
    throw new ToolError(
      "bad-chroma",
      `A chromagram has 12 values, one per pitch class, but ${chroma ? chroma.length : 0} were given.`,
      "Pass the array returned by chromagram().",
    );
  }
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < 12; p++) {
    const v = chroma[p] as number;
    if (!Number.isFinite(v)) {
      throw new ToolError(
        "bad-chroma",
        `The chromagram holds ${v} at pitch class ${p}.`,
        "Every value must be a finite number. Recompute the chromagram from the samples.",
      );
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) {
    throw new ToolError(
      "flat-chroma",
      "Every pitch class is equally strong, so no key stands out.",
      "This usually means the audio was silence or noise. Analyse a section with music in it.",
    );
  }

  const rotated = new Float64Array(12);
  const scored: KeyCandidate[] = [];
  for (const mode of ["major", "minor"] as KeyMode[]) {
    const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (let p = 0; p < 12; p++) rotated[p] = profile[(p - tonic + 12) % 12]!;
      scored.push({
        key: formatKey(tonic, mode),
        tonic: tonicName(tonic, mode),
        mode,
        camelot: camelotFor(tonic, mode),
        openKey: openKeyFor(tonic, mode),
        score: round(pearson(chroma, rotated), 4),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const second = scored[1]!;
  const confidence = clamp01(best.score) * clamp01(0.5 + 2.5 * (best.score - second.score));

  return { ...best, confidence: round(confidence, 3), alternates: scored.slice(1, 4) };
}

/* ------------------------------------------------------------------ */
/* Tempo markings                                                      */
/* ------------------------------------------------------------------ */

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
 * Name a tempo with its Italian marking. The boundaries are half open, so every
 * tempo lands in exactly one band and 120 bpm is Allegro rather than the top of
 * Moderato. Marking ranges vary between editions, so treat this as the common
 * convention rather than a rule.
 */
export function describeTempo(bpm: number): TempoDescription {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new ToolError(
      "bad-tempo",
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

/* ------------------------------------------------------------------ */
/* Whole track analysis                                                */
/* ------------------------------------------------------------------ */

export interface TrackAnalysis {
  tempo: BpmResult;
  key: KeyResult;
  chroma: number[];
  durationSeconds: number;
}

/**
 * Run both measurements over one buffer. The panel calls the two halves apart
 * so it can show progress between them; this is the convenience wrapper for
 * anything that just wants the answer.
 */
export function analyzeTrack(
  samples: Samples,
  sampleRate: number,
  options: DetectBpmOptions & ChromagramOptions = {},
): TrackAnalysis {
  const tempo = detectBpm(samples, sampleRate, options);
  const chroma = chromagram(samples, sampleRate, options);
  return {
    tempo,
    key: detectKey(chroma),
    chroma: Array.from(chroma, (v) => round(v, 4)),
    durationSeconds: round(samples.length / sampleRate, 3),
  };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export type Notation = "camelot" | "open-key" | "both";

export interface BpmKeyOpts {
  notation?: string;
  [key: string]: unknown;
}

export type BpmKeyResult = Record<string, string>;

function readNotation(opts: BpmKeyOpts): Notation {
  const raw = String(opts?.notation ?? "both").toLowerCase();
  if (raw === "camelot" || raw === "open-key" || raw === "both") return raw;
  throw new ToolError(
    "bad-option",
    `"${opts?.notation}" is not a notation this tool knows.`,
    'Choose "camelot", "open-key", or "both".',
  );
}

function percent(value: number): string {
  return `${Math.round(clamp01(value) * 100)} percent`;
}

function panelRows(notation: Notation): BpmKeyResult {
  const rows: BpmKeyResult = {
    Analysis:
      "Drop an audio file onto the panel on this page and the browser decodes it, then measures the tempo and the musical key here on your device.",
    "Tap tempo":
      "Tap along with the music in the panel, or paste your tap times in milliseconds here, such as 0, 500, 1000, 1500.",
    "Type a tempo":
      "Enter a number such as 128 to see its tempo marking, its beat and bar lengths, and its half time and double time partners.",
    "Type a key":
      "Enter a key such as A minor, or a code such as 8A, to see its wheel position, relative key, and mixing neighbours.",
  };
  if (notation !== "open-key") rows["Camelot"] = "C major is 8B and A minor is 8A.";
  if (notation !== "camelot") rows["Open Key"] = "C major is 1d and A minor is 1m.";
  rows["Privacy"] =
    "The file is decoded and analysed in this tab. Your files and inputs never leave your device.";
  return rows;
}

function tempoRows(bpm: number): BpmKeyResult {
  const tempo = describeTempo(bpm);
  const beatMs = 60000 / bpm;
  return {
    Tempo: `${round(bpm, 2)} bpm`,
    Marking: `${tempo.marking} (${tempo.range})`,
    Feel: tempo.feel,
    "Beat length": `${round(beatMs, 3)} ms`,
    "Bar length in 4/4": `${round((beatMs * 4) / 1000, 4)} s`,
    "Eighth note": `${round(beatMs / 2, 3)} ms`,
    "Dotted eighth": `${round(beatMs * 0.75, 3)} ms`,
    "Sixteenth note": `${round(beatMs / 4, 3)} ms`,
    "Half time": `${round(bpm / 2, 2)} bpm`,
    "Double time": `${round(bpm * 2, 2)} bpm`,
    "Three quarter time": `${round(bpm * 0.75, 2)} bpm`,
    "Pitch fader, plus or minus 6 percent": `${round(bpm * 0.94, 2)} to ${round(bpm * 1.06, 2)} bpm`,
    "Pitch fader, plus or minus 8 percent": `${round(bpm * 0.92, 2)} to ${round(bpm * 1.08, 2)} bpm`,
    "Bars per minute in 4/4": String(round(bpm / 4, 3)),
    "Octave note":
      "A detector can hear this tempo as half or double it. Both are listed above, so pick the one that matches how you count the track.",
  };
}

function tapRows(result: TapTempoResult): BpmKeyResult {
  const rows: BpmKeyResult = {
    "Tap tempo": `${round(result.bpm, 1)} bpm`,
    Confidence: percent(result.confidence),
    "Taps read": String(result.taps),
    "Gaps used": String(result.intervals),
    "Average gap": `${result.averageIntervalMs} ms`,
    "Gap spread": `${result.spreadMs} ms`,
  };
  const tempo = describeTempo(result.bpm);
  rows["Marking"] = `${tempo.marking} (${tempo.range})`;
  rows["Feel"] = tempo.feel;
  rows["Half time"] = `${round(result.bpm / 2, 1)} bpm`;
  rows["Double time"] = `${round(result.bpm * 2, 1)} bpm`;
  rows["Tip"] =
    result.intervals >= 4
      ? "Keep tapping to tighten the estimate. Only the last 16 taps count, so an early stumble drops off on its own."
      : "Tap at least five times in a row for a steady reading. Two or three taps can only ever be a rough guess.";
  return rows;
}

function keyRows(name: KeyName, notation: Notation): BpmKeyResult {
  const camelot = camelotFor(name.tonic, name.mode);
  const openKey = openKeyFor(name.tonic, name.mode);
  const relative = relativeKey(name.tonic, name.mode);
  const parallel = parallelKey(name.tonic, name.mode);
  const neighbours = camelotNeighbours(camelot);

  const rows: BpmKeyResult = { Key: name.key };
  if (notation !== "open-key") rows["Camelot"] = camelot;
  if (notation !== "camelot") rows["Open Key"] = openKey;
  rows["Relative key"] = describeKeyRef(relative, notation);
  rows["Parallel key"] = describeKeyRef(parallel, notation);
  rows["Scale notes"] = scaleNotes(name.tonic, name.mode).join(" ");
  rows["Mixes with"] = neighbours
    .map((code) => describeKeyRef(CODE_TO_KEY.get(code.toLowerCase())!, notation))
    .join(", ");

  const match = /^(\d{1,2})([AB])$/.exec(camelot)!;
  const boostCode = `${((Number.parseInt(match[1]!, 10) - 1 + 2) % 12) + 1}${match[2]}`;
  rows["Energy boost"] =
    `${describeKeyRef(CODE_TO_KEY.get(boostCode.toLowerCase())!, notation)}, two steps up the wheel, lifts the energy without losing the key`;
  rows["Why it matters"] =
    "Two tracks a step apart on the wheel, or on the same number in the other ring, share enough notes to blend without clashing.";
  return rows;
}

function describeKeyRef(name: KeyName, notation: Notation): string {
  const codes: string[] = [];
  if (notation !== "open-key") codes.push(camelotFor(name.tonic, name.mode));
  if (notation !== "camelot") codes.push(openKeyFor(name.tonic, name.mode));
  return `${name.key} (${codes.join(", ")})`;
}

function droppedFileRows(byteLength: number, notation: Notation): BpmKeyResult {
  const rows: BpmKeyResult = {
    Status:
      "Reading the tempo and key of a file needs the browser audio decoder, which a pure function cannot reach, so the measurement runs in the panel on this page instead.",
    File: `${formatBytes(byteLength)} of audio data`,
    Tempo:
      "The panel builds an onset strength envelope, autocorrelates it, and reports the beat period with the half time and double time candidates beside it.",
    Key: "The panel folds the spectrum into twelve pitch classes and correlates that against the 24 Krumhansl-Schmuckler key profiles.",
  };
  if (notation !== "open-key")
    rows["Camelot"] = "Reported on the Camelot wheel, where C major is 8B.";
  if (notation !== "camelot")
    rows["Open Key"] = "Reported in Open Key notation, where C major is 1d.";
  rows["Privacy"] =
    "The file is decoded and analysed in this tab. Your files and inputs never leave your device.";
  return rows;
}

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Turn a typed tempo, tap list, or key into readable rows.
 *
 * Detecting the tempo and key of an actual track needs the browser's audio
 * decoder, which a pure function cannot reach, so that half runs in the panel
 * on this page. What this function covers is everything around it: the tap
 * tempo maths, what a tempo means, and where a key sits on the mixing wheel.
 */
export function run(input: string | Uint8Array, opts: BpmKeyOpts): BpmKeyResult {
  const notation = readNotation(opts);
  if (input && typeof input !== "string") {
    return input.length === 0 ? panelRows(notation) : droppedFileRows(input.length, notation);
  }
  const raw = String(input ?? "").trim();
  if (!raw) return panelRows(notation);

  // A list of numbers is a run of tap times.
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => NUMBER_PATTERN.test(part))) {
    const stamps = parts.map(Number);
    const taps = bpmFromTaps(stamps);
    if (!taps) {
      throw new ToolError(
        "bad-taps",
        `Those ${parts.length} tap times do not contain a usable beat between ${MIN_TAP_BPM} and ${MAX_TAP_BPM} bpm.`,
        "Give at least two tap times in milliseconds, spaced the way you would tap along, such as 0, 500, 1000, 1500.",
      );
    }
    return tapRows(taps);
  }

  // A bare number, or a number with bpm after it, is a tempo.
  const tempoMatch = /^(\d+(?:\.\d+)?)\s*(?:bpm|beats\s*per\s*minute)?$/i.exec(raw);
  if (tempoMatch) {
    const bpm = Number(tempoMatch[1]);
    if (!Number.isFinite(bpm) || bpm < MIN_TAP_BPM || bpm > MAX_TAP_BPM) {
      throw new ToolError(
        "bad-tempo",
        `${bpm} bpm is outside the ${MIN_TAP_BPM} to ${MAX_TAP_BPM} bpm range this tool covers.`,
        `Enter a tempo between ${MIN_TAP_BPM} and ${MAX_TAP_BPM}, such as 128.`,
      );
    }
    return tempoRows(bpm);
  }

  return keyRows(parseKey(raw), notation);
}

export default { run } satisfies ToolLogic<string | Uint8Array, BpmKeyResult, BpmKeyOpts>;
