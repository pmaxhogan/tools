import { ToolError, type ToolLogic } from "../types";

/**
 * Spectrogram Viewer: the pure DSP layer.
 *
 * Everything here is plain arithmetic on typed arrays. Decoding audio and
 * painting pixels belong to the panel; this file only turns samples into
 * decibel columns, waveform envelopes, colors, and axis labels.
 */

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

/** True for 1, 2, 4, 8, ... and false for zero, negatives, and everything else. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 *
 * `re` and `im` hold the real and imaginary parts of the input and are
 * overwritten with the transform. The length must be a power of two. The
 * transform is unnormalized, so a constant signal of value 1 and length N
 * produces N in bin 0, and the inverse would divide by N.
 *
 * The butterflies run in double precision (JavaScript numbers) even though
 * the arrays are Float32Array, so the only rounding is the store back into
 * each array slot.
 */
export function fft(re: Float32Array, im: Float32Array): void {
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
      "Pad or trim the buffer to 256, 512, 1024, 2048, or another power of two.",
    );
  }
  if (n === 1) return;

  // Bit-reversal permutation: reorder the input so the butterflies can run
  // over contiguous pairs without any extra scratch space.
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
    // Stride into the full length twiddle table for this stage.
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

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const hannCache = new Map<number, Float32Array>();

/**
 * Symmetric Hann window of length n: 0.5 * (1 - cos(2*pi*i / (n - 1))).
 *
 * Both endpoints are exactly zero and the center is exactly one, which is
 * what tapers the frame edges and keeps a steady tone from smearing across
 * neighbouring bins. The result is cached and shared, so treat it as read
 * only: multiply it into a separate frame buffer rather than in place.
 */
export function hannWindow(n: number): Float32Array {
  if (!Number.isInteger(n) || n < 2) {
    throw new ToolError(
      "bad-window-length",
      `A Hann window needs at least 2 points, but ${n} was requested.`,
      "Pass a whole number of samples, normally the FFT size.",
    );
  }
  const cached = hannCache.get(n);
  if (cached) return cached;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  hannCache.set(n, w);
  return w;
}

/* ------------------------------------------------------------------ */
/* Spectrogram                                                         */
/* ------------------------------------------------------------------ */

export type FftSize = 1024 | 2048 | 4096;

export interface SpectrogramOptions {
  /** Samples per analysis frame. Bigger means finer frequency, coarser time. */
  fftSize: FftSize;
  /** Samples advanced between frames. fftSize / 4 gives 75 percent overlap. */
  hop: number;
  /**
   * Upper bound on returned columns. Long recordings produce far more frames
   * than a screen has pixels, so frames are max-pooled into this many columns.
   */
  maxColumns?: number;
}

export interface SpectrogramPlan {
  fftSize: number;
  hop: number;
  /** Total analysis frames before pooling. */
  frameCount: number;
  /** Frames folded into one output column. 1 when no pooling is needed. */
  group: number;
  /** Columns actually produced. */
  columnCount: number;
  /** Values per column: bin 0 is DC, bin freqBins would be Nyquist. */
  freqBins: number;
}

/** The quietest value any column can hold. Silence lands exactly here. */
export const DB_FLOOR = -100;

/** Default column budget: roughly two screens wide, which is plenty to draw. */
export const DEFAULT_MAX_COLUMNS = 2000;

function checkOptions(o: SpectrogramOptions): { fftSize: number; hop: number; maxColumns: number } {
  const fftSize = Number(o?.fftSize);
  if (!isPowerOfTwo(fftSize) || fftSize < 2) {
    throw new ToolError(
      "bad-fft-size",
      `The FFT size must be a power of two, but ${o?.fftSize} was given.`,
      "Use 1024, 2048, or 4096.",
    );
  }
  const hop = Number(o?.hop);
  if (!Number.isInteger(hop) || hop < 1) {
    throw new ToolError(
      "bad-hop",
      `The hop size must be a whole number of samples of at least 1, but ${o?.hop} was given.`,
      "A quarter of the FFT size is a good default, for example 512 with a 2048 point FFT.",
    );
  }
  const raw = o?.maxColumns === undefined ? DEFAULT_MAX_COLUMNS : Number(o.maxColumns);
  if (!Number.isFinite(raw) || raw < 1) {
    throw new ToolError(
      "bad-max-columns",
      `maxColumns must be a positive number, but ${o?.maxColumns} was given.`,
      "Leave it out to use the default of 2000 columns, or pass the pixel width you plan to draw.",
    );
  }
  return { fftSize, hop, maxColumns: Math.floor(raw) };
}

/**
 * Work out the frame and column layout for a clip without touching a sample.
 *
 * The panel uses this to size its progress bar and to compute one slice of
 * columns at a time, so a ten minute file does not block the main thread.
 */
export function planSpectrogram(sampleCount: number, o: SpectrogramOptions): SpectrogramPlan {
  const { fftSize, hop, maxColumns } = checkOptions(o);
  if (!Number.isFinite(sampleCount) || sampleCount < 1) {
    throw new ToolError(
      "empty-audio",
      "There are no audio samples to analyze.",
      "Load a file that contains at least one sample of audio.",
    );
  }
  // Clips shorter than one frame still get a single zero-padded frame, so a
  // very short blip is drawn rather than silently dropped.
  const frameCount = sampleCount < fftSize ? 1 : 1 + Math.floor((sampleCount - fftSize) / hop);
  const group = Math.max(1, Math.ceil(frameCount / maxColumns));
  const columnCount = Math.ceil(frameCount / group);
  return { fftSize, hop, frameCount, group, columnCount, freqBins: fftSize / 2 };
}

/**
 * Analyze one frame into decibels, writing freqBins values into `out`.
 *
 * The magnitude is scaled by 2 / sum(window) so a full scale sine reads about
 * 0 dB whatever the FFT size, then clamped to DB_FLOOR so silence has a
 * definite value instead of negative infinity.
 */
function analyzeFrame(
  samples: Float32Array,
  start: number,
  window: Float32Array,
  scale: number,
  re: Float32Array,
  im: Float32Array,
  out: Float32Array,
): void {
  const fftSize = re.length;
  const total = samples.length;
  for (let i = 0; i < fftSize; i++) {
    const at = start + i;
    re[i] = at < total ? samples[at]! * window[i]! : 0;
    im[i] = 0;
  }
  fft(re, im);
  const bins = out.length;
  for (let k = 0; k < bins; k++) {
    const rr = re[k]!;
    const ii = im[k]!;
    const mag = Math.sqrt(rr * rr + ii * ii) * scale;
    out[k] = mag > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(mag)) : DB_FLOOR;
  }
}

/**
 * Compute a contiguous slice of spectrogram columns.
 *
 * Columns are numbered against the plan from `planSpectrogram`, so the panel
 * can walk the clip in chunks and yield to the browser between them without
 * the pooling drifting out of alignment.
 */
export function computeSpectrogramColumns(
  samples: Float32Array,
  o: SpectrogramOptions,
  fromColumn: number,
  columnCount: number,
): Float32Array[] {
  const plan = planSpectrogram(samples.length, o);
  if (!Number.isInteger(fromColumn) || fromColumn < 0) {
    throw new ToolError(
      "bad-column-range",
      `The first column index must be a whole number of at least 0, but ${fromColumn} was given.`,
      "Start at 0 and advance by the number of columns you already have.",
    );
  }
  const wanted = Math.max(0, Math.min(columnCount, plan.columnCount - fromColumn));
  if (wanted === 0) return [];

  const window = hannWindow(plan.fftSize);
  let sum = 0;
  for (let i = 0; i < window.length; i++) sum += window[i]!;
  const scale = 2 / sum;

  const re = new Float32Array(plan.fftSize);
  const im = new Float32Array(plan.fftSize);
  const scratch = new Float32Array(plan.freqBins);
  const columns: Float32Array[] = [];

  for (let c = fromColumn; c < fromColumn + wanted; c++) {
    const column = new Float32Array(plan.freqBins).fill(DB_FLOOR);
    for (let g = 0; g < plan.group; g++) {
      const frame = c * plan.group + g;
      if (frame >= plan.frameCount) break;
      analyzeFrame(samples, frame * plan.hop, window, scale, re, im, scratch);
      // Max pooling: a transient inside a pooled group stays visible instead
      // of being averaged away by the quiet frames around it.
      for (let k = 0; k < plan.freqBins; k++) {
        if (scratch[k]! > column[k]!) column[k] = scratch[k]!;
      }
    }
    columns.push(column);
  }
  return columns;
}

/**
 * Full spectrogram for a clip: one Float32Array of decibel values per column,
 * ordered from bin 0 (DC) upward.
 *
 * Frames are Hann windowed and overlapped by `hop` samples. When the clip
 * produces more frames than `maxColumns` (default 2000), consecutive frames
 * are max-pooled into a single column so the returned array stays a sensible
 * size for drawing without hiding short loud events.
 */
export function computeSpectrogram(
  samples: Float32Array,
  o: SpectrogramOptions,
): { columns: Float32Array[]; freqBins: number } {
  const plan = planSpectrogram(samples.length, o);
  return {
    columns: computeSpectrogramColumns(samples, o, 0, plan.columnCount),
    freqBins: plan.freqBins,
  };
}

/* ------------------------------------------------------------------ */
/* Waveform                                                            */
/* ------------------------------------------------------------------ */

/**
 * Reduce samples to a per-bucket minimum and maximum envelope.
 *
 * Drawing a vertical line between min and max for each bucket is what makes a
 * waveform strip look right at any zoom level: averaging would flatten the
 * peaks, and plain decimation would miss them entirely.
 */
export function computeWaveformPeaks(
  samples: Float32Array,
  buckets: number,
): { min: Float32Array; max: Float32Array } {
  if (samples.length === 0) {
    throw new ToolError(
      "empty-audio",
      "There are no audio samples to build a waveform from.",
      "Load a file that contains at least one sample of audio.",
    );
  }
  if (!Number.isInteger(buckets) || buckets < 1) {
    throw new ToolError(
      "bad-bucket-count",
      `The bucket count must be a whole number of at least 1, but ${buckets} was given.`,
      "Pass the pixel width of the waveform strip you are about to draw.",
    );
  }
  const n = samples.length;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let start = Math.floor((b * n) / buckets);
    let end = Math.floor(((b + 1) * n) / buckets);
    // More buckets than samples: every bucket still reads one real sample.
    if (start >= n) start = n - 1;
    if (end <= start) end = start + 1;
    if (end > n) end = n;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/* ------------------------------------------------------------------ */
/* Color                                                               */
/* ------------------------------------------------------------------ */

export type ColorScheme = "viridis" | "magma" | "gray";

export type Rgb = [number, number, number];

/**
 * Sixteen evenly spaced stops of the viridis colormap, sampled from the
 * published table. Perceptually uniform and colorblind safe, which is why it
 * is the default here.
 */
export const VIRIDIS_STOPS: Rgb[] = [
  [68, 1, 84],
  [71, 27, 108],
  [69, 51, 126],
  [62, 74, 137],
  [53, 94, 140],
  [45, 113, 142],
  [38, 130, 142],
  [33, 149, 139],
  [38, 166, 132],
  [53, 183, 121],
  [91, 198, 99],
  [134, 211, 73],
  [181, 222, 43],
  [204, 225, 31],
  [228, 228, 29],
  [253, 231, 37],
];

/** Sixteen evenly spaced stops of the magma colormap: black to cream. */
export const MAGMA_STOPS: Rgb[] = [
  [0, 0, 4],
  [13, 9, 37],
  [33, 14, 73],
  [59, 15, 112],
  [86, 22, 123],
  [113, 31, 128],
  [140, 41, 129],
  [169, 50, 124],
  [196, 61, 115],
  [222, 73, 104],
  [239, 99, 96],
  [249, 128, 98],
  [254, 159, 109],
  [254, 192, 138],
  [253, 224, 166],
  [252, 253, 191],
];

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return value < low ? low : value > high ? high : value;
}

function sample(table: Rgb[], t: number): Rgb {
  const pos = t * (table.length - 1);
  const i = Math.min(table.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = table[i]!;
  const b = table[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * Map a decibel value in [DB_FLOOR, 0] to an RGB triple.
 *
 * Values outside that range are clamped, so a column that never reaches full
 * scale still paints and a rogue positive value does not wrap around.
 */
export function dbToColor(db: number, scheme: ColorScheme): Rgb {
  const t = clamp((db - DB_FLOOR) / -DB_FLOOR, 0, 1);
  if (scheme === "gray") {
    const v = Math.round(t * 255);
    return [v, v, v];
  }
  if (scheme === "viridis") return sample(VIRIDIS_STOPS, t);
  if (scheme === "magma") return sample(MAGMA_STOPS, t);
  throw new ToolError(
    "unknown-color-scheme",
    `There is no color scheme called "${scheme}".`,
    "Choose viridis, magma, or gray.",
  );
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/**
 * Format a time offset for the time axis: "1:23", or "1:02:03" past an hour.
 *
 * Pass `decimals` to keep fractions of a second on short clips, which is what
 * the panel does when the whole file is under ten seconds.
 */
export function secondsToLabel(sec: number, decimals = 0): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const places = clamp(Math.round(decimals), 0, 3);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  let tail = places > 0 ? (safe - whole).toFixed(places).slice(1) : "";
  // toFixed can round up to "1.000", which would print ":09.0" for 9.9999.
  if (tail.startsWith("1")) tail = `.${"0".repeat(places)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}${tail}`;
  return `${minutes}:${pad(seconds)}${tail}`;
}

/** Format a frequency for the frequency axis: "440 Hz" below 1 kHz, "4.4 kHz" above. */
export function freqToLabel(hz: number): string {
  const safe = Number.isFinite(hz) && hz > 0 ? hz : 0;
  const rounded = Math.round(safe);
  if (rounded < 1000) return `${rounded} Hz`;
  const k = safe / 1000;
  const text = k < 100 ? k.toFixed(1) : k.toFixed(0);
  return `${text.replace(/\.0$/, "")} kHz`;
}

/* ------------------------------------------------------------------ */
/* Container headers                                                   */
/* ------------------------------------------------------------------ */

function tag(bytes: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > bytes.length) return "";
  let out = "";
  for (let i = at; i < at + length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function u32le(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 4 > bytes.length) return null;
  return (
    bytes[at]! + bytes[at + 1]! * 0x100 + bytes[at + 2]! * 0x10000 + bytes[at + 3]! * 0x1000000
  );
}

function u32be(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 4 > bytes.length) return null;
  return (
    bytes[at]! * 0x1000000 + bytes[at + 1]! * 0x10000 + bytes[at + 2]! * 0x100 + bytes[at + 3]!
  );
}

/** A sample rate is only believable when it is a positive whole number. */
function positive(rate: number | null): number | null {
  return rate !== null && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * WAV: walk the RIFF chunk list and read the rate out of the fmt chunk.
 *
 * The fmt chunk is conventionally first but nothing requires it, and writers
 * routinely put JUNK, bext, or LIST ahead of it, so the chunks are walked
 * rather than assumed to start at offset 12. RIFF pads odd sized chunks to an
 * even boundary, and skipping that pad byte is what keeps the walk aligned.
 */
function sniffWav(bytes: Uint8Array): number | null {
  if (tag(bytes, 0, 4) !== "RIFF" || tag(bytes, 8, 4) !== "WAVE") return null;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(bytes, p, 4);
    const size = u32le(bytes, p + 4);
    if (size === null) return null;
    if (id === "fmt " && size >= 16) {
      // Field order in fmt: format tag (2), channels (2), sample rate (4).
      return positive(u32le(bytes, p + 12));
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

/**
 * FLAC: the rate is a 20 bit field inside the mandatory STREAMINFO block.
 *
 * STREAMINFO is required to be the first metadata block, so its 4 byte header
 * sits at offset 4 and its payload at offset 8. Inside that payload the rate
 * starts 10 bytes in and is not byte aligned: 8 bits, then 8 bits, then the
 * top 4 bits of the next byte.
 */
function sniffFlac(bytes: Uint8Array): number | null {
  if (tag(bytes, 0, 4) !== "fLaC") return null;
  if (bytes.length < 21) return null;
  if ((bytes[4]! & 0x7f) !== 0) return null;
  const rate = (bytes[18]! << 12) | (bytes[19]! << 4) | (bytes[20]! >> 4);
  return positive(rate);
}

/**
 * Ogg: read the rate from a Vorbis identification header in the first page.
 *
 * Opus and other Ogg payloads return null on purpose. Opus always decodes at
 * 48 kHz whatever the original rate was, so claiming a source rate for it
 * would be a guess rather than a fact from the header.
 */
function sniffOgg(bytes: Uint8Array): number | null {
  if (tag(bytes, 0, 4) !== "OggS") return null;
  if (bytes.length < 27) return null;
  const segments = bytes[26]!;
  const payload = 27 + segments;
  if (payload + 16 > bytes.length) return null;
  if (bytes[payload] !== 0x01 || tag(bytes, payload + 1, 6) !== "vorbis") return null;
  return positive(u32le(bytes, payload + 12));
}

/**
 * Decode the IEEE 754 80 bit extended float that AIFF stores its rate in.
 *
 * The layout is a sign bit, a 15 bit exponent biased by 16383, and a 64 bit
 * mantissa with an explicit leading one. The mantissa is split into two 32 bit
 * halves here because a JavaScript number cannot hold all 64 bits exactly, and
 * the 2**-63 in the exponent is what turns the integer mantissa into a
 * fraction. 44100 Hz encodes as exponent 0x400E, mantissa 0xAC440000_00000000.
 */
function extended80(bytes: Uint8Array, at: number): number | null {
  if (at + 10 > bytes.length) return null;
  const first = bytes[at]!;
  if ((first & 0x80) !== 0) return null;
  const exponent = ((first & 0x7f) << 8) | bytes[at + 1]!;
  // Zero is a zero or denormal rate, and all ones is an infinity or a NaN.
  if (exponent === 0 || exponent === 0x7fff) return null;
  const high = u32be(bytes, at + 2);
  const low = u32be(bytes, at + 6);
  if (high === null || low === null) return null;
  const mantissa = high * 4294967296 + low;
  const value = mantissa * Math.pow(2, exponent - 16383 - 63);
  return positive(value);
}

/**
 * AIFF and AIFC: walk the IFF chunk list to the COMM chunk.
 *
 * IFF is RIFF with big endian sizes, including the same even boundary padding,
 * so the walk mirrors the WAV one with the byte order flipped.
 */
function sniffAiff(bytes: Uint8Array): number | null {
  if (tag(bytes, 0, 4) !== "FORM") return null;
  const form = tag(bytes, 8, 4);
  if (form !== "AIFF" && form !== "AIFC") return null;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(bytes, p, 4);
    const size = u32be(bytes, p + 4);
    if (size === null) return null;
    if (id === "COMM" && size >= 18) {
      // Field order in COMM: channels (2), frames (4), bits (2), rate (10).
      const rate = extended80(bytes, p + 16);
      return rate === null ? null : Math.round(rate);
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

/** Sample rates by MPEG version bits, then by the 2 bit rate index. */
const MPEG_RATES: Record<number, number[]> = {
  // MPEG 1
  3: [44100, 48000, 32000],
  // MPEG 2
  2: [22050, 24000, 16000],
  // MPEG 2.5
  0: [11025, 12000, 8000],
};

/** How far past any ID3 tag to keep looking for a valid frame header. */
const MP3_SCAN_LIMIT = 65536;

/**
 * MP3: read the rate out of the first valid frame header.
 *
 * An ID3v2 tag is skipped first, using its synchsafe length (seven usable bits
 * per byte, because a set high bit could otherwise look like a frame sync).
 * The scan then walks forward because tags, padding, and garbage can sit
 * between the tag and the first real frame.
 */
function sniffMp3(bytes: Uint8Array): number | null {
  let start = 0;
  const hasId3 = tag(bytes, 0, 3) === "ID3";
  if (hasId3) {
    if (bytes.length < 10) return null;
    const size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    start = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  } else if (!(bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
    // Neither an ID3 tag nor a frame sync at the very start: not an MP3.
    return null;
  }

  const end = Math.min(bytes.length - 3, start + MP3_SCAN_LIMIT);
  for (let p = Math.max(0, start); p < end; p++) {
    if (bytes[p] !== 0xff) continue;
    const b1 = bytes[p + 1]!;
    if ((b1 & 0xe0) !== 0xe0) continue;
    const version = (b1 >> 3) & 3;
    // Version 1 and layer 0 are both reserved, so a header using them is noise.
    if (version === 1) continue;
    if (((b1 >> 1) & 3) === 0) continue;
    const b2 = bytes[p + 2]!;
    if (((b2 >> 4) & 0x0f) === 0x0f) continue;
    const index = (b2 >> 2) & 3;
    if (index === 3) continue;
    const table = MPEG_RATES[version];
    if (!table) continue;
    return positive(table[index] ?? null);
  }
  return null;
}

/**
 * Read the true sample rate straight out of a file's container header.
 *
 * This exists because `decodeAudioData` resamples to whatever rate the
 * AudioContext runs at, so the decoded buffer reports 48000 Hz for an 8000 Hz
 * recording and the frequency axis then runs to a Nyquist the file never had.
 * Sniffing the header first lets the caller decode at the file's own rate.
 *
 * WAV, FLAC, Ogg Vorbis, AIFF, and MP3 are covered. Anything else, including
 * MP4 and M4A, WebM, and Ogg Opus, returns null: the caller should decode
 * normally and label the result as resampled rather than guess.
 *
 * The value is returned exactly as the header states it, with no range check,
 * so an absurd rate stays visible to the caller instead of being silently
 * turned into something plausible.
 */
export function sniffSampleRate(bytes: Uint8Array): number | null {
  if (!bytes || bytes.length < 4) return null;
  return (
    sniffWav(bytes) ?? sniffFlac(bytes) ?? sniffOgg(bytes) ?? sniffAiff(bytes) ?? sniffMp3(bytes)
  );
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface SpectrogramToolOpts {
  fftSize: string;
  colors: string;
  scale: string;
  showWaveform: boolean;
  [key: string]: unknown;
}

export type SpectrogramResult = Record<string, string>;

function formatBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Textual fallback for pipelines and for anything that cannot run the canvas
 * panel. Decoding compressed audio needs the browser's audio decoder, which
 * is not available to a pure function, so this reports the analysis settings
 * and what the viewer on this page will show instead of inventing numbers.
 */
export function run(input: Uint8Array | string, opts: SpectrogramToolOpts): SpectrogramResult {
  if (input === null || input === undefined || input.length === 0) {
    throw new ToolError(
      "empty-input",
      "No audio was provided.",
      "Drop an audio file onto the viewer or pick one with the file button.",
    );
  }
  if (typeof input === "string") {
    throw new ToolError(
      "not-audio",
      "This tool needs audio bytes, but it received text.",
      "Drop a WAV, MP3, FLAC, OGG, or M4A file onto the viewer instead of pasting text.",
    );
  }

  const fftSize = Number(opts?.fftSize ?? 2048);
  const safeFft = isPowerOfTwo(fftSize) ? fftSize : 2048;
  const hop = safeFft / 4;
  const colors = String(opts?.colors ?? "viridis");
  const scale = String(opts?.scale ?? "linear");
  const showWaveform = opts?.showWaveform !== false;

  // 44.1 kHz is the safe worked example: the real rate comes from the file
  // once the browser decodes it, and the viewer prints the actual number.
  const exampleRate = 44100;
  const binWidth = exampleRate / safeFft;
  const frameMs = (safeFft / exampleRate) * 1000;
  const hopMs = (hop / exampleRate) * 1000;

  return {
    Status:
      "Spectrogram Viewer runs in the canvas panel on this page. Decoding compressed audio needs the browser audio decoder, so the picture is drawn there rather than returned as text.",
    File: `${formatBytes(input.length)} of audio data`,
    "FFT size": `${safeFft} samples per frame, hop ${hop} samples (75 percent overlap)`,
    "Frequency resolution": `${safeFft / 2} bins, about ${binWidth.toFixed(1)} Hz apart at a 44.1 kHz sample rate`,
    "Time resolution": `each frame covers about ${frameMs.toFixed(1)} ms and starts about ${hopMs.toFixed(1)} ms after the last one`,
    "Color scheme": colors,
    "Frequency axis": scale === "log" ? "logarithmic, 20 Hz to Nyquist" : "linear, 0 Hz to Nyquist",
    Waveform: showWaveform ? "shown above the spectrogram" : "hidden",
    "Level scale": `magnitude in decibels, 0 dB is full scale and anything below ${DB_FLOOR} dB is floored`,
  };
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  SpectrogramResult,
  SpectrogramToolOpts
>;
