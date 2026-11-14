import { ToolError, type ToolLogic } from "../types";
import { formatBytes } from "@/lib/format";

/**
 * Dial-up loading GIF maker: an animated GIF of a picture arriving a few rows
 * at a time, the way images used to paint over a 56k modem.
 *
 * Everything here is arithmetic on pixel buffers, so it stays pure and runs in
 * Node. Decoding a JPEG, a PNG or the frames of an animated image needs a
 * canvas, so the panel does that part and hands these functions raw RGBA.
 *
 * The pipeline has four stages, each exported so the panel can stream frames
 * through them without holding every decoded frame in memory:
 *
 * 1. `buildSchedule` turns a duration, a randomness amount and a stall plan
 *    into a list of steps, each saying how many rows have arrived and how long
 *    the step stays on screen. It is seeded, so one seed is one exact GIF.
 * 2. `addToHistogram` and `buildPalette` pick one global palette of up to 256
 *    colors by median cut. Index 0 is always the "nothing here yet" color:
 *    transparent, or the chosen background.
 * 3. `quantizeFrame` maps a frame onto that palette, with optional Floyd
 *    Steinberg dithering.
 * 4. `encodeLoadingGif` composes each step and writes the GIF. Only the band
 *    of rows that changed since the previous step is encoded, so a still
 *    image costs about as much as one ordinary GIF of it, not one copy per
 *    step.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

export type RevealStyle = "top" | "bottom" | "interlaced";
export type Background = "transparent" | "white" | "black" | "gray";
export type Rgb = readonly [number, number, number];

export interface DialUpOpts {
  style?: string;
  duration?: number;
  randomness?: number;
  stalls?: number;
  stallLength?: number;
  hold?: number;
  fps?: number;
  width?: number;
  background?: string;
  dither?: boolean;
  loop?: boolean;
  seed?: string;
}

/** Validated settings, every field present and in range. */
export interface DialUpSettings {
  style: RevealStyle;
  /** Seconds the picture takes to arrive. */
  duration: number;
  /** 0 to 100: how unevenly the rows arrive. */
  randomness: number;
  /** How many times the connection stops dead during one load. */
  stalls: number;
  /** Seconds each stall lasts. */
  stallLength: number;
  /** Seconds the finished picture stays up before the GIF restarts. */
  hold: number;
  fps: number;
  background: Background;
  dither: boolean;
  loop: boolean;
  seed: string;
}

export interface ScheduleStep {
  /** Rows that have arrived by the time this step is shown. */
  revealed: number;
  /** How long the step stays on screen, in hundredths of a second. */
  delayCs: number;
}

export interface Palette {
  /** RGB triples. Index 0 is the blank color. */
  rgb: Uint8Array;
  count: number;
  /** True when index 0 means "transparent" rather than a background color. */
  transparent: boolean;
}

export type ColorMapper = (r: number, g: number, b: number) => number;

export interface LoadingGifInput {
  width: number;
  height: number;
  /** Palette indices, one byte per pixel, one buffer per source frame. */
  frames: Uint8Array[];
  /** How long each source frame lasts, in milliseconds. Unused for a still. */
  frameDelaysMs: number[];
  palette: Palette;
  settings: DialUpSettings;
}

export interface LoadingGifResult {
  bytes: Uint8Array;
  /** Frames actually written (steps with nothing new are merged). */
  frameCount: number;
  /** Full length of one loop, in milliseconds. */
  totalMs: number;
  /** True when every frame had to be written whole (moving transparency). */
  fullFrames: boolean;
}

export type Tick = (done: number, total: number) => void | Promise<void>;

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export const STYLES: readonly RevealStyle[] = ["top", "bottom", "interlaced"];
export const BACKGROUNDS: readonly Background[] = ["transparent", "white", "black", "gray"];

const BACKGROUND_RGB: Record<Exclude<Background, "transparent">, Rgb> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  // The default page color of mid nineties browsers.
  gray: [192, 192, 192],
};

/** The color unloaded rows are painted with, or null for transparent. */
export function backgroundColor(background: Background): Rgb | null {
  return background === "transparent" ? null : BACKGROUND_RGB[background];
}

function readNumber(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ToolError(
      "invalid-option",
      `${name} of ${String(value)} is out of range.`,
      `Use a number from ${min} to ${max}.`,
    );
  }
  return n;
}

export function readSettings(opts: DialUpOpts = {}): DialUpSettings {
  const style = opts.style === undefined || opts.style === "" ? "top" : opts.style;
  if (!STYLES.includes(style as RevealStyle)) {
    throw new ToolError(
      "invalid-option",
      `"${style}" is not a loading style.`,
      "Use top, bottom or interlaced.",
    );
  }
  const background =
    opts.background === undefined || opts.background === "" ? "transparent" : opts.background;
  if (!BACKGROUNDS.includes(background as Background)) {
    throw new ToolError(
      "invalid-option",
      `"${background}" is not a background.`,
      "Use transparent, white, black or gray.",
    );
  }
  return {
    style: style as RevealStyle,
    duration: readNumber(opts.duration, "A load time", 0.5, 60, 4),
    randomness: readNumber(opts.randomness, "A randomness", 0, 100, 60),
    stalls: readNumber(opts.stalls, "A stall count", 0, 20, 2),
    stallLength: readNumber(opts.stallLength, "A stall length", 0.1, 10, 0.6),
    hold: readNumber(opts.hold, "A hold time", 0, 30, 2),
    fps: readNumber(opts.fps, "A frame rate", 2, 25, 12),
    background: background as Background,
    dither: opts.dither !== false,
    loop: opts.loop !== false,
    seed: typeof opts.seed === "string" && opts.seed !== "" ? opts.seed : randomSeed(),
  };
}

/* ------------------------------------------------------------------ *
 * randomness
 * ------------------------------------------------------------------ */

/** A short random seed, for when the caller did not supply one. */
export function randomSeed(): string {
  const words = new Uint32Array(1);
  crypto.getRandomValues(words);
  return words[0]!.toString(36);
}

/** Deterministic PRNG (mulberry32) seeded from a string by FNV-1a. */
export function makeRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * schedule
 * ------------------------------------------------------------------ */

export interface ScheduleInput {
  /** Rows to deliver in total. */
  units: number;
  duration: number;
  fps: number;
  randomness: number;
  /** Stalls per load. */
  stalls: number;
  /** Seconds per stall. */
  stallLength: number;
  seed: string;
}

/**
 * How the rows arrive over time.
 *
 * Time is cut into steps of one frame each. The connection speed is piecewise
 * constant: it holds one value for a random stretch of up to about 0.8 seconds,
 * then jumps. Each stretch draws its speed from a log normal distribution whose
 * spread is the randomness setting.
 *
 * Stalls are then laid over that: exactly `stalls` of them, each `stallLength`
 * seconds long (varied by up to 40 percent either way as randomness rises),
 * dropped at random moments that never overlap and never cover the first or
 * the last step. Nothing arrives during a stall. Stalls live inside the load
 * time rather than extending it, so the rows around them come faster, and
 * together they are capped at 80 percent of the load time.
 *
 * The speeds are finally normalized so the last row always lands exactly at
 * the requested load time.
 *
 * With randomness and stalls both at zero every step delivers the same number
 * of rows, which is a plain linear wipe.
 */
export function buildSchedule(input: ScheduleInput): ScheduleStep[] {
  const units = Math.max(1, Math.floor(input.units));
  const totalCs = Math.max(2, Math.round(input.duration * 100));
  const steps = Math.max(1, Math.min(Math.round(input.duration * input.fps), totalCs >> 1));
  const spread = Math.max(0, Math.min(100, input.randomness)) / 100;
  const rng = makeRng(input.seed);

  const gauss = () => {
    const u = Math.max(rng(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  const weights = new Float64Array(steps);
  const maxStretch = Math.max(1, Math.round(input.fps * 0.8));
  let total = 0;
  for (let i = 0; i < steps;) {
    const length = 1 + Math.floor(rng() * maxStretch);
    const speed = Math.exp(gauss() * 1.1 * spread);
    for (let j = 0; j < length && i < steps; j += 1, i += 1) {
      const jitter = 1 + (rng() - 0.5) * spread;
      weights[i] = speed * jitter;
    }
  }

  // Stalls: fixed count and length, at random non overlapping moments.
  const wanted = Math.max(0, Math.round(input.stalls));
  const room = Math.floor((steps - 2) * 0.8);
  if (wanted > 0 && room > 0) {
    const lengths: number[] = [];
    let stalled = 0;
    for (let n = 0; n < wanted; n += 1) {
      const vary = 1 + (rng() - 0.5) * 0.8 * spread;
      const length = Math.max(1, Math.round(input.stallLength * input.fps * vary));
      lengths.push(length);
      stalled += length;
    }
    if (stalled > room) {
      // Too much stall for this load time: shrink them all, then drop extras.
      const scale = room / stalled;
      stalled = 0;
      for (let n = 0; n < lengths.length; n += 1) {
        lengths[n] = Math.max(1, Math.floor(lengths[n]! * scale));
        stalled += lengths[n]!;
      }
      while (stalled > room) stalled -= lengths.pop()!;
    }
    // The moving steps left over are cut at random points; a stall sits at each cut.
    const moving = steps - stalled;
    const cuts = lengths.map(() => 1 + Math.floor(rng() * Math.max(1, moving - 1)));
    cuts.sort((a, b) => a - b);
    let shift = 0;
    for (let n = 0; n < lengths.length; n += 1) {
      const start = cuts[n]! + shift;
      weights.fill(0, start, Math.min(steps - 1, start + lengths[n]!));
      shift += lengths[n]!;
    }
  }
  for (let i = 0; i < steps; i += 1) total += weights[i]!;
  if (!(total > 0)) {
    weights.fill(1);
    total = steps;
  }

  const out: ScheduleStep[] = [];
  let running = 0;
  let elapsedCs = 0;
  for (let i = 0; i < steps; i += 1) {
    running += weights[i]!;
    const revealed = i === steps - 1 ? units : Math.round((units * running) / total);
    // Rounding error is carried forward so the delays sum to the load time.
    const endCs = Math.round(((i + 1) * totalCs) / steps);
    out.push({ revealed: Math.min(units, revealed), delayCs: endCs - elapsedCs });
    elapsedCs = endCs;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * which source row each output row shows
 * ------------------------------------------------------------------ */

/** GIF interlace passes: first row, row step, and rows each one fills. */
const PASSES = [
  [0, 8, 8],
  [4, 8, 4],
  [2, 4, 2],
  [1, 2, 1],
] as const;

/** Rows in the order an interlaced image delivers them. */
export function interlaceOrder(height: number): Int32Array {
  const order = new Int32Array(height);
  let n = 0;
  for (const [start, step] of PASSES) {
    for (let y = start; y < height; y += step) order[n++] = y;
  }
  return order;
}

/**
 * For each output row, the source row it shows once `revealed` rows have
 * arrived, or -1 when nothing has arrived for it yet.
 *
 * In the interlaced style a row that has arrived is stretched over the rows
 * beneath it that are still missing, which is what gives the blocky picture
 * that sharpens in four passes.
 */
export function rowMap(height: number, revealed: number, style: RevealStyle): Int32Array {
  const map = new Int32Array(height).fill(-1);
  const count = Math.max(0, Math.min(height, Math.floor(revealed)));
  if (style === "top") {
    for (let y = 0; y < count; y += 1) map[y] = y;
  } else if (style === "bottom") {
    for (let y = height - count; y < height; y += 1) map[y] = y;
  } else {
    let n = 0;
    for (const [start, step, fill] of PASSES) {
      for (let y = start; y < height && n < count; y += step, n += 1) {
        const end = Math.min(height, y + fill);
        for (let k = y; k < end; k += 1) map[k] = y;
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * palette
 * ------------------------------------------------------------------ */

/** Colors are binned to 6 bits a channel while counting. */
const HIST_SIZE = 1 << 18;
const ALPHA_CUTOFF = 128;

export function createHistogram(): Uint32Array {
  return new Uint32Array(HIST_SIZE);
}

/**
 * Flatten a frame for a GIF, in place. With a background color every pixel is
 * blended onto it and made opaque. With none (transparent output) pixels stay
 * as they are, and anything under half opacity counts as fully clear later.
 */
export function prepareFrame(rgba: Uint8Array | Uint8ClampedArray, background: Rgb | null): void {
  if (!background) return;
  const [br, bg, bb] = background;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 255) continue;
    const t = a / 255;
    rgba[i] = Math.round(rgba[i]! * t + br * (1 - t));
    rgba[i + 1] = Math.round(rgba[i + 1]! * t + bg * (1 - t));
    rgba[i + 2] = Math.round(rgba[i + 2]! * t + bb * (1 - t));
    rgba[i + 3] = 255;
  }
}

/** Count a frame's opaque pixels. `stride` samples every nth pixel. */
export function addToHistogram(
  hist: Uint32Array,
  rgba: Uint8Array | Uint8ClampedArray,
  stride = 1,
): void {
  const step = Math.max(1, Math.floor(stride)) * 4;
  for (let i = 0; i + 3 < rgba.length; i += step) {
    if (rgba[i + 3]! < ALPHA_CUTOFF) continue;
    const bin = ((rgba[i]! >> 2) << 12) | ((rgba[i + 1]! >> 2) << 6) | (rgba[i + 2]! >> 2);
    hist[bin] = hist[bin]! + 1;
  }
}

interface Box {
  start: number;
  end: number;
  count: number;
  axis: number;
  score: number;
}

const SHIFTS = [12, 6, 0] as const;

function measureBox(bins: Uint32Array, hist: Uint32Array, start: number, end: number): Box {
  const lo = [63, 63, 63];
  const hi = [0, 0, 0];
  let count = 0;
  for (let i = start; i < end; i += 1) {
    const bin = bins[i]!;
    count += hist[bin]!;
    for (let ch = 0; ch < 3; ch += 1) {
      const v = (bin >> SHIFTS[ch]!) & 63;
      if (v < lo[ch]!) lo[ch] = v;
      if (v > hi[ch]!) hi[ch] = v;
    }
  }
  let axis = 0;
  let range = 0;
  for (let ch = 0; ch < 3; ch += 1) {
    const r = hi[ch]! - lo[ch]!;
    if (r > range) {
      range = r;
      axis = ch;
    }
  }
  return { start, end, count, axis, score: end - start > 1 ? range * Math.sqrt(count) : 0 };
}

/**
 * Median cut over the color histogram. Index 0 is reserved for the blank
 * color, so at most 255 entries describe the picture itself.
 */
export function buildPalette(
  hist: Uint32Array,
  options: { background: Rgb | null; maxColors?: number },
): Palette {
  const limit = Math.max(1, Math.min(255, (options.maxColors ?? 256) - 1));

  let used = 0;
  for (let i = 0; i < HIST_SIZE; i += 1) if (hist[i]! > 0) used += 1;
  const bins = new Uint32Array(used);
  for (let i = 0, n = 0; i < HIST_SIZE; i += 1) if (hist[i]! > 0) bins[n++] = i;

  const boxes: Box[] = used > 0 ? [measureBox(bins, hist, 0, used)] : [];
  while (boxes.length > 0 && boxes.length < limit) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i]!.score > bestScore) {
        bestScore = boxes[i]!.score;
        best = i;
      }
    }
    if (best < 0) break;
    const box = boxes[best]!;
    const shift = SHIFTS[box.axis]!;
    bins.subarray(box.start, box.end).sort((a, b) => ((a >> shift) & 63) - ((b >> shift) & 63));
    // Split where half the pixels fall on each side, keeping both halves non empty.
    let split = box.start + 1;
    let seen = hist[bins[box.start]!]!;
    while (split < box.end - 1 && seen < box.count / 2) {
      seen += hist[bins[split]!]!;
      split += 1;
    }
    boxes[best] = measureBox(bins, hist, box.start, split);
    boxes.push(measureBox(bins, hist, split, box.end));
  }

  const count = boxes.length + 1;
  const rgb = new Uint8Array(count * 3);
  if (options.background) rgb.set(options.background, 0);
  boxes.forEach((box, n) => {
    const sum = [0, 0, 0];
    for (let i = box.start; i < box.end; i += 1) {
      const bin = bins[i]!;
      const weight = hist[bin]!;
      for (let ch = 0; ch < 3; ch += 1) sum[ch] = sum[ch]! + ((bin >> SHIFTS[ch]!) & 63) * weight;
    }
    for (let ch = 0; ch < 3; ch += 1) {
      rgb[(n + 1) * 3 + ch] = Math.round(((sum[ch]! / box.count) * 255) / 63);
    }
  });
  return { rgb, count, transparent: options.background === null };
}

/** Nearest palette color for an RGB value, memoized per 6 bit color bin. */
export function createMapper(palette: Palette): ColorMapper {
  const cache = new Int16Array(HIST_SIZE).fill(-1);
  const { rgb, count } = palette;
  // A transparent slot is never a color match. A background slot is fair game.
  const first = palette.transparent ? 1 : 0;
  return (r, g, b) => {
    const bin = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache[bin]!;
    if (hit >= 0) return hit;
    let best = first < count ? first : 0;
    let bestDistance = Infinity;
    for (let i = first; i < count; i += 1) {
      const dr = r - rgb[i * 3]!;
      const dg = g - rgb[i * 3 + 1]!;
      const db = b - rgb[i * 3 + 2]!;
      // Green carries most of the perceived brightness, blue the least.
      const distance = 2 * dr * dr + 4 * dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache[bin] = best;
    return best;
  };
}

/**
 * Map a prepared RGBA frame onto the palette. Pixels under half opacity become
 * index 0 when the palette is transparent. Dithering is Floyd Steinberg.
 */
export function quantizeFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  palette: Palette,
  mapper: ColorMapper,
  dither: boolean,
): Uint8Array {
  assertBuffer(rgba, width, height);
  const out = new Uint8Array(width * height);
  const { rgb, transparent } = palette;
  const rowLength = (width + 2) * 3;
  let current = new Float32Array(rowLength);
  let next = new Float32Array(rowLength);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      if (transparent && rgba[p + 3]! < ALPHA_CUTOFF) continue;
      const e = (x + 1) * 3;
      let r = rgba[p]!;
      let g = rgba[p + 1]!;
      let b = rgba[p + 2]!;
      if (dither) {
        r = Math.max(0, Math.min(255, Math.round(r + current[e]!)));
        g = Math.max(0, Math.min(255, Math.round(g + current[e + 1]!)));
        b = Math.max(0, Math.min(255, Math.round(b + current[e + 2]!)));
      }
      const index = mapper(r, g, b);
      out[y * width + x] = index;
      if (!dither) continue;
      const er = r - rgb[index * 3]!;
      const eg = g - rgb[index * 3 + 1]!;
      const eb = b - rgb[index * 3 + 2]!;
      spread(current, e + 3, er, eg, eb, 7 / 16);
      spread(next, e - 3, er, eg, eb, 3 / 16);
      spread(next, e, er, eg, eb, 5 / 16);
      spread(next, e + 3, er, eg, eb, 1 / 16);
    }
    const swap = current;
    current = next;
    next = swap;
    next.fill(0);
  }
  return out;
}

function spread(row: Float32Array, at: number, r: number, g: number, b: number, k: number): void {
  row[at] = row[at]! + r * k;
  row[at + 1] = row[at + 1]! + g * k;
  row[at + 2] = row[at + 2]! + b * k;
}

function assertBuffer(rgba: ArrayLike<number>, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ToolError(
      "invalid-size",
      `A picture of ${width} by ${height} pixels cannot be encoded.`,
      "Width and height must be whole numbers of at least 1.",
    );
  }
  if (width > 65535 || height > 65535) {
    throw new ToolError(
      "invalid-size",
      `A GIF cannot be larger than 65535 pixels on a side, and this is ${width} by ${height}.`,
      "Lower the output width.",
    );
  }
  if (rgba.length !== width * height * 4) {
    throw new ToolError(
      "invalid-size",
      `The pixel buffer holds ${rgba.length} bytes, but ${width} by ${height} pixels need ${width * height * 4}.`,
      "Pass raw RGBA, four bytes per pixel, with the matching width and height.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * GIF writing
 * ------------------------------------------------------------------ */

class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  length = 0;

  private grow(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.buffer.subarray(0, this.length));
    this.buffer = bigger;
  }

  byte(value: number): void {
    this.grow(1);
    this.buffer[this.length++] = value;
  }

  word(value: number): void {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }

  bytes(values: ArrayLike<number>): void {
    this.grow(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i += 1) this.byte(text.charCodeAt(i));
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

const LZW_HASH_SIZE = 1 << 14;
const LZW_HASH_MASK = LZW_HASH_SIZE - 1;

/**
 * GIF flavored LZW: variable width codes packed least significant bit first
 * into sub blocks of at most 255 bytes, ending with a zero length block.
 */
export function lzwEncode(pixels: Uint8Array, minCodeSize: number, sink: ByteSink): void {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const block = new Uint8Array(255);
  let blockLength = 0;
  let bits = 0;
  let bitCount = 0;

  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLength++] = bits & 0xff;
      bits >>>= 8;
      bitCount -= 8;
      if (blockLength === 255) {
        sink.byte(255);
        sink.bytes(block);
        blockLength = 0;
      }
    }
  };

  // Open addressed table from (prefix code, next byte) to code.
  const keys = new Int32Array(LZW_HASH_SIZE);
  const values = new Int16Array(LZW_HASH_SIZE);

  sink.byte(minCodeSize);
  emit(clearCode);

  if (pixels.length > 0) {
    let prefix = pixels[0]!;
    for (let i = 1; i < pixels.length; i += 1) {
      const byte = pixels[i]!;
      const key = ((prefix << 8) | byte) + 1;
      let slot = ((prefix << 4) ^ (byte * 0x9e5)) & LZW_HASH_MASK;
      let found = -1;
      while (keys[slot] !== 0) {
        if (keys[slot] === key) {
          found = values[slot]!;
          break;
        }
        slot = (slot + 1) & LZW_HASH_MASK;
      }
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode === 4096) {
        emit(clearCode);
        keys.fill(0);
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      } else {
        if (nextCode >= 1 << codeSize) codeSize += 1;
        keys[slot] = key;
        values[slot] = nextCode;
        nextCode += 1;
      }
      prefix = byte;
    }
    emit(prefix);
  }
  emit(endCode);
  if (bitCount > 0) {
    block[blockLength++] = bits & 0xff;
  }
  if (blockLength > 0) {
    sink.byte(blockLength);
    sink.bytes(block.subarray(0, blockLength));
  }
  sink.byte(0);
}

interface PendingFrame {
  y: number;
  height: number;
  pixels: Uint8Array;
  delayCs: number;
}

/** Thrown inside the encoder when band updates cannot express a frame. */
class NeedsFullFrames extends Error {}

const MAX_DELAY_CS = 65535;
/** Browsers play a GIF frame shorter than this as a tenth of a second. */
const MIN_DELAY_CS = 2;

/**
 * Write the loading animation.
 *
 * Each step shows the source rows that have arrived so far and the blank color
 * everywhere else. For an animated source the picture keeps playing while it
 * arrives, then plays on for the hold time. A still simply sits finished for
 * the hold time.
 *
 * Frames are band updates on top of what is already on the canvas. That cannot
 * express a pixel going from a color back to transparent, which only happens
 * when an animated source has moving transparency (or an interlaced reveal
 * crosses a clear area). In that case the whole GIF is rewritten with full
 * frames that clear the canvas each time.
 */
export async function encodeLoadingGif(
  input: LoadingGifInput,
  tick?: Tick,
): Promise<LoadingGifResult> {
  try {
    return await encode(input, false, tick);
  } catch (err) {
    if (!(err instanceof NeedsFullFrames)) throw err;
    return encode(input, true, tick);
  }
}

async function encode(
  input: LoadingGifInput,
  fullFrames: boolean,
  tick?: Tick,
): Promise<LoadingGifResult> {
  const { width, height, frames, palette, settings } = input;
  if (frames.length === 0) {
    throw new ToolError("no-frames", "There is no picture to encode.", "Add an image first.");
  }
  for (const frame of frames) {
    if (frame.length !== width * height) {
      throw new ToolError(
        "invalid-size",
        `A frame holds ${frame.length} pixels, but ${width} by ${height} needs ${width * height}.`,
        "Every frame must be one palette index per pixel at the same size.",
      );
    }
  }

  const animated = frames.length > 1;
  const sourceDelays = frames.map((_, i) => {
    const ms = input.frameDelaysMs[i];
    // A missing or near zero delay plays as a tenth of a second in browsers.
    return typeof ms === "number" && ms > 10 ? ms : 100;
  });
  const sourceTotal = sourceDelays.reduce((a, b) => a + b, 0);
  const sourceFrameAt = (ms: number): Uint8Array => {
    if (!animated) return frames[0]!;
    let t = ms % sourceTotal;
    for (let i = 0; i < frames.length; i += 1) {
      t -= sourceDelays[i]!;
      if (t < 0) return frames[i]!;
    }
    return frames[frames.length - 1]!;
  };

  const steps = buildSchedule({
    units: height,
    duration: settings.duration,
    fps: settings.fps,
    randomness: settings.randomness,
    stalls: settings.stalls,
    stallLength: settings.stallLength,
    seed: settings.seed,
  });
  const holdCs = Math.round(settings.hold * 100);
  if (animated && holdCs > 0) {
    const frameCs = Math.max(MIN_DELAY_CS, Math.round(100 / settings.fps));
    const extra = Math.max(1, Math.round(holdCs / frameCs));
    for (let i = 0; i < extra; i += 1) {
      const endCs = Math.round(((i + 1) * holdCs) / extra);
      const startCs = Math.round((i * holdCs) / extra);
      steps.push({ revealed: height, delayCs: endCs - startCs });
    }
  }

  // Color table: a power of two entries, at least four so LZW has room.
  let tableBits = 2;
  while (1 << tableBits < palette.count) tableBits += 1;

  const sink = new ByteSink();
  sink.ascii("GIF89a");
  sink.word(width);
  sink.word(height);
  sink.byte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1));
  sink.byte(0);
  sink.byte(0);
  const table = new Uint8Array(3 << tableBits);
  table.set(palette.rgb.subarray(0, palette.count * 3));
  sink.bytes(table);
  if (settings.loop) {
    sink.bytes([0x21, 0xff, 0x0b]);
    sink.ascii("NETSCAPE2.0");
    sink.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  let frameCount = 0;
  let totalCs = 0;
  const disposal = fullFrames ? 2 : 1;
  const flush = (frame: PendingFrame) => {
    let delay = frame.delayCs;
    totalCs += delay;
    // One frame cannot hold more than 655 seconds, so a longer wait repeats it.
    for (;;) {
      const part = Math.min(delay, MAX_DELAY_CS);
      delay -= part;
      sink.bytes([0x21, 0xf9, 0x04, (disposal << 2) | (palette.transparent ? 1 : 0)]);
      sink.word(Math.max(MIN_DELAY_CS, part));
      sink.bytes([0, 0, 0x2c]);
      sink.word(0);
      sink.word(frame.y);
      sink.word(width);
      sink.word(frame.height);
      sink.byte(0);
      lzwEncode(frame.pixels, tableBits, sink);
      frameCount += 1;
      if (delay <= 0) break;
    }
  };

  const canvas = new Uint8Array(width * height);
  let pending: PendingFrame | null = null;
  let elapsedMs = 0;

  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s]!;
    const source = sourceFrameAt(elapsedMs);
    const map = rowMap(height, step.revealed, settings.style);

    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      const from = map[y]!;
      const rowStart = y * width;
      let changed = false;
      for (let x = 0; x < width; x += 1) {
        const value = from < 0 ? 0 : source[from * width + x]!;
        const before = canvas[rowStart + x]!;
        if (value === before) continue;
        if (!fullFrames && palette.transparent && value === 0) throw new NeedsFullFrames();
        canvas[rowStart + x] = value;
        changed = true;
      }
      if (changed) {
        if (top < 0) top = y;
        bottom = y;
      }
    }

    if (pending && top < 0) {
      // Nothing new arrived: the previous frame just stays up longer.
      pending.delayCs += step.delayCs;
    } else {
      if (pending) flush(pending);
      // The first frame, and every frame in full frame mode, covers the canvas.
      const whole: boolean = pending === null || fullFrames || top < 0;
      const y: number = whole ? 0 : top;
      const bandHeight: number = whole ? height : bottom - top + 1;
      pending = {
        y,
        height: bandHeight,
        pixels: canvas.slice(y * width, (y + bandHeight) * width),
        delayCs: step.delayCs,
      };
    }
    elapsedMs += step.delayCs * 10;
    if (tick) await tick(s + 1, steps.length);
  }

  if (pending) {
    if (!animated) pending.delayCs += holdCs;
    flush(pending);
  }
  sink.byte(0x3b);

  return { bytes: sink.finish(), frameCount, totalMs: totalCs * 10, fullFrames };
}

/* ------------------------------------------------------------------ *
 * whole pipeline, for callers that hold every frame in memory
 * ------------------------------------------------------------------ */

export interface RgbaSource {
  width: number;
  height: number;
  /** Raw RGBA frames. They are modified in place. */
  frames: (Uint8Array | Uint8ClampedArray)[];
  frameDelaysMs?: number[];
}

export async function makeLoadingGif(
  source: RgbaSource,
  settings: DialUpSettings,
  tick?: Tick,
): Promise<LoadingGifResult> {
  if (source.frames.length === 0) {
    throw new ToolError("no-frames", "There is no picture to encode.", "Add an image first.");
  }
  const background = backgroundColor(settings.background);
  const hist = createHistogram();
  for (const frame of source.frames) {
    assertBuffer(frame, source.width, source.height);
    prepareFrame(frame, background);
    addToHistogram(hist, frame);
  }
  const palette = buildPalette(hist, { background });
  const mapper = createMapper(palette);
  const frames = source.frames.map((frame) =>
    quantizeFrame(frame, source.width, source.height, palette, mapper, settings.dither),
  );
  return encodeLoadingGif(
    {
      width: source.width,
      height: source.height,
      frames,
      frameDelaysMs: source.frameDelaysMs ?? [],
      palette,
      settings,
    },
    tick,
  );
}

/* ------------------------------------------------------------------ *
 * text surface
 * ------------------------------------------------------------------ */

const USE_PANEL_FIX =
  'Drop a picture on the panel on this page. From code, pass JSON like {"width": 2, "height": 2, "rgbaBase64": "..."} holding raw RGBA pixels.';

/** Largest raw payload `run` accepts: about four megapixels. */
const MAX_RUN_PIXELS = 4_000_000;

function usePanel(detail: string): ToolError {
  return new ToolError("use-panel", `This tool works on pixels; ${detail}`, USE_PANEL_FIX);
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/\s+/g, ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** "4.0 s" style duration. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export type DialUpResult = Record<string, string>;

/**
 * Text surface for the tool.
 *
 * A loading GIF is a picture in and a picture out, and the generic shell only
 * renders text, so the real work happens in the panel on this page. What `run`
 * accepts is a small JSON payload of raw pixels, which makes the whole pipeline
 * runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 4, "height": 4, "rgbaBase64": "<base64 RGBA>" }
 * ```
 */
export async function run(
  input: Uint8Array | string,
  opts: DialUpOpts = {},
): Promise<DialUpResult> {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    text = new TextDecoder().decode(input);
  } else {
    throw usePanel("no image was given.");
  }
  if (text.trim() === "") throw usePanel("no image was given.");

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    throw usePanel("the input is not a pixel payload.");
  }

  const raw = payload.rgbaBase64;
  if (typeof raw !== "string") {
    throw usePanel("the payload needs an `rgbaBase64` string of raw RGBA pixels.");
  }
  const width = payload.width;
  const height = payload.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw usePanel("the payload needs a positive whole `width` and `height`.");
  }
  if (width * height > MAX_RUN_PIXELS) {
    throw new ToolError(
      "too-large",
      `${width} by ${height} pixels is more than this text surface accepts.`,
      "Use the panel on this page for large pictures, or shrink the picture first.",
    );
  }
  const bytes = base64ToBytes(raw);
  if (bytes === null) throw usePanel("`rgbaBase64` must be base64 encoded raw RGBA pixels.");

  const settings = readSettings(opts);
  const result = await makeLoadingGif({ width, height, frames: [bytes] }, settings);

  return {
    "Output size": `${width} by ${height} pixels`,
    Frames: String(result.frameCount),
    "Loop length": formatSeconds(result.totalMs),
    "File size": formatBytes(result.bytes.length),
    Seed: settings.seed,
    "GIF data URL": `data:image/gif;base64,${bytesToBase64(result.bytes)}`,
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, DialUpResult, DialUpOpts>;
