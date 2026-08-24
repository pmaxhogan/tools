import { ToolError, type ToolLogic } from "../types";

/**
 * Dithering playground: retro and e-ink dithering on raw RGBA buffers.
 *
 * Everything here is arithmetic on pixels, so it stays pure and testable in
 * Node. Decoding a PNG or a JPEG into pixels needs a canvas, so the panel does
 * that part and hands these functions the bytes it read back.
 *
 * Three families of algorithm share one quantizer:
 *
 * 1. Error diffusion (Floyd Steinberg, Atkinson, Jarvis Judice Ninke, Stucki,
 *    Burkes, Sierra, Sierra Lite). Each pixel is snapped to the nearest palette
 *    color and the leftover error is pushed into pixels that have not been
 *    visited yet, using the published kernel for that algorithm. Serpentine
 *    scanning reverses every other row, which breaks up the diagonal worming
 *    artifacts a pure left to right raster produces.
 * 2. Ordered dithering (Bayer 2x2, 4x4, 8x8, and a 64x64 blue noise tile). A
 *    per position threshold offset is added to the pixel before it is snapped,
 *    so the result is position dependent but completely local: no error travels
 *    between pixels, which is what makes ordered output tile cleanly and
 *    animate without crawling.
 * 3. Plain quantization: `threshold` adds nothing at all, `random` adds a
 *    deterministic hash of the pixel coordinates.
 *
 * ## Color space
 *
 * With `gamma` on (the default) every pixel and every palette color is
 * converted from sRGB to linear light before the math, and the palette color
 * that wins is written back out in sRGB. This is the photometrically correct
 * way to dither: averaging half black and half white pixels gives linear 0.5,
 * which displays as sRGB 188, not sRGB 128. Tools that dither straight in sRGB
 * therefore come out visibly too bright. Turning `gamma` off reproduces that
 * older, brighter look on purpose.
 *
 * ## Distance metric
 *
 * The nearest palette color is chosen by squared Euclidean distance in the
 * working space (linear RGB when gamma is on, sRGB otherwise). A perceptual
 * space such as OKLab would pick slightly friendlier colors on the 16 color
 * palettes, but linear RGB is the space the error diffusion arithmetic already
 * lives in, so using the same metric keeps the diffused error and the color
 * choice consistent, and keeps the inner loop cheap enough for a live preview.
 *
 * ## Alpha
 *
 * Semi transparent pixels are composited onto white in the working space before
 * quantization, and every output pixel is fully opaque. Dithering to a fixed
 * palette has no way to express partial coverage, so guessing a background once
 * and saying so beats writing alpha nobody can honor.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

/** One color, sRGB, 0 to 255. */
export type Rgb = readonly [number, number, number];

/** A named output palette. */
export interface PaletteDef {
  id: string;
  label: string;
  colors: readonly Rgb[];
}

/** How an algorithm decides which palette color a pixel becomes. */
export type AlgorithmKind = "diffusion" | "ordered" | "threshold" | "random";

/** A named dithering algorithm. */
export interface AlgorithmDef {
  id: string;
  label: string;
  kind: AlgorithmKind;
}

export interface DitherSettings {
  /** Algorithm id from `ALGORITHMS`. Default "floyd-steinberg". */
  algorithm?: string;
  /** Palette id from `PALETTES`. Default "bw". */
  palette?: string;
  /** Comma or space separated hex colors, used when palette is "custom". */
  customPalette?: string;
  /** Reverse every other row on error diffusion algorithms. Default true. */
  serpentine?: boolean;
  /** Scales the diffused error and the ordered threshold, 0 to 1. Default 1. */
  strength?: number;
  /** Do the math in linear light instead of sRGB. Default true. */
  gamma?: boolean;
}

export interface ImageDitheringOpts extends DitherSettings {
  /** Downscale factor applied before dithering, 1 to 8. Default 1. */
  scale?: number;
  [key: string]: unknown;
}

export type ImageDitheringResult = Record<string, string>;

const USE_PANEL_FIX =
  "Drop or pick an image in the panel above. To call this tool directly, send " +
  '{"width":4,"height":4,"rgbaBase64":"..."} with four bytes per pixel in red, green, blue, alpha order.';

/* ------------------------------------------------------------------ *
 * palettes
 * ------------------------------------------------------------------ */

function hex(value: string): Rgb {
  const n = Number.parseInt(value, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function grayRamp(levels: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < levels; i += 1) {
    const v = Math.round((i * 255) / (levels - 1));
    out.push([v, v, v]);
  }
  return out;
}

/**
 * The built in palettes.
 *
 * The retro entries are the values these machines are normally reproduced with
 * rather than measurements off real hardware, because no single canonical set
 * exists: the Game Boy greens are the widely used DMG four tone set, CGA is the
 * standard RGBI table including the corrected 0xAA5500 brown, the C64 entry is
 * the Pepto palette, and PICO-8 is the fixed palette from its documentation.
 * The e-ink entries are the nominal primaries an ACeP panel advertises, which
 * are more saturated than what the panel actually prints.
 */
export const PALETTES: readonly PaletteDef[] = [
  { id: "bw", label: "Black and white (1 bit)", colors: [hex("000000"), hex("ffffff")] },
  { id: "gray-4", label: "Grayscale, 4 levels", colors: grayRamp(4) },
  { id: "gray-16", label: "Grayscale, 16 levels", colors: grayRamp(16) },
  {
    id: "gameboy",
    label: "Game Boy (4 greens)",
    colors: [hex("0f380f"), hex("306230"), hex("8bac0f"), hex("9bbc0f")],
  },
  {
    id: "cga",
    label: "CGA (16 colors)",
    colors: [
      hex("000000"),
      hex("0000aa"),
      hex("00aa00"),
      hex("00aaaa"),
      hex("aa0000"),
      hex("aa00aa"),
      hex("aa5500"),
      hex("aaaaaa"),
      hex("555555"),
      hex("5555ff"),
      hex("55ff55"),
      hex("55ffff"),
      hex("ff5555"),
      hex("ff55ff"),
      hex("ffff55"),
      hex("ffffff"),
    ],
  },
  {
    id: "c64",
    label: "Commodore 64 (16 colors)",
    colors: [
      hex("000000"),
      hex("ffffff"),
      hex("880000"),
      hex("aaffee"),
      hex("cc44cc"),
      hex("00cc55"),
      hex("0000aa"),
      hex("eeee77"),
      hex("dd8855"),
      hex("664400"),
      hex("ff7777"),
      hex("333333"),
      hex("777777"),
      hex("aaff66"),
      hex("0088ff"),
      hex("bbbbbb"),
    ],
  },
  {
    id: "pico-8",
    label: "PICO-8 (16 colors)",
    colors: [
      hex("000000"),
      hex("1d2b53"),
      hex("7e2553"),
      hex("008751"),
      hex("ab5236"),
      hex("5f574f"),
      hex("c2c3c7"),
      hex("fff1e8"),
      hex("ff004d"),
      hex("ffa300"),
      hex("ffec27"),
      hex("00e436"),
      hex("29adff"),
      hex("83769c"),
      hex("ff77a8"),
      hex("ffccaa"),
    ],
  },
  {
    id: "e-ink-3",
    label: "E ink, black white red",
    colors: [hex("000000"), hex("ffffff"), hex("ff0000")],
  },
  {
    id: "e-ink-7",
    label: "E ink ACeP, 7 colors",
    colors: [
      hex("000000"),
      hex("ffffff"),
      hex("ff0000"),
      hex("00ff00"),
      hex("0000ff"),
      hex("ffff00"),
      hex("ff8000"),
    ],
  },
  { id: "custom", label: "Custom hex list", colors: [] },
];

const PALETTE_BY_ID = new Map(PALETTES.map((p) => [p.id, p]));

const HEX_COLOR = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses a comma, space, or newline separated list of hex colors. */
export function parseCustomPalette(text: string): Rgb[] {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const colors: Rgb[] = [];
  for (const token of tokens) {
    if (!HEX_COLOR.test(token)) {
      throw new ToolError(
        "invalid-palette",
        `"${token}" is not a hex color.`,
        "List colors as #rrggbb or #rgb, separated by commas or spaces, for example #000000, #ff0000, #ffffff.",
      );
    }
    const body = token.replace("#", "").toLowerCase();
    colors.push(
      hex(
        body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body,
      ),
    );
  }

  if (colors.length < 2) {
    throw new ToolError(
      "invalid-palette",
      `A custom palette needs at least 2 colors; ${colors.length} was given.`,
      "List two or more hex colors, for example #1a1c2c, #f4f4f4.",
    );
  }
  return colors;
}

/** Colors for a palette id. `custom` reads the hex list from `customPalette`. */
export function paletteColors(id: string, customPalette = ""): readonly Rgb[] {
  const def = PALETTE_BY_ID.get(id);
  if (!def) {
    throw new ToolError(
      "invalid-palette",
      `"${id}" is not a palette.`,
      `Choose one of: ${PALETTES.map((p) => p.id).join(", ")}.`,
    );
  }
  if (id === "custom") return parseCustomPalette(customPalette);
  return def.colors;
}

/* ------------------------------------------------------------------ *
 * algorithms
 * ------------------------------------------------------------------ */

/** One tap of an error diffusion kernel: `w`/`div` of the error goes to dx,dy. */
interface Tap {
  dx: number;
  dy: number;
  w: number;
}

interface Kernel {
  div: number;
  taps: readonly Tap[];
}

function taps(div: number, list: readonly (readonly [number, number, number])[]): Kernel {
  return { div, taps: list.map(([dx, dy, w]) => ({ dx, dy, w })) };
}

/**
 * The published diffusion kernels. The current pixel sits at 0,0 and every tap
 * points at a pixel the scan has not reached yet. Atkinson is the odd one out:
 * its weights sum to 6 while its divisor is 8, so a quarter of every error is
 * simply dropped, which is exactly why Atkinson output has more contrast and
 * loses detail in the deepest shadows and brightest highlights.
 */
const KERNELS: Readonly<Record<string, Kernel>> = {
  "floyd-steinberg": taps(16, [
    [1, 0, 7],
    [-1, 1, 3],
    [0, 1, 5],
    [1, 1, 1],
  ]),
  atkinson: taps(8, [
    [1, 0, 1],
    [2, 0, 1],
    [-1, 1, 1],
    [0, 1, 1],
    [1, 1, 1],
    [0, 2, 1],
  ]),
  "jarvis-judice-ninke": taps(48, [
    [1, 0, 7],
    [2, 0, 5],
    [-2, 1, 3],
    [-1, 1, 5],
    [0, 1, 7],
    [1, 1, 5],
    [2, 1, 3],
    [-2, 2, 1],
    [-1, 2, 3],
    [0, 2, 5],
    [1, 2, 3],
    [2, 2, 1],
  ]),
  stucki: taps(42, [
    [1, 0, 8],
    [2, 0, 4],
    [-2, 1, 2],
    [-1, 1, 4],
    [0, 1, 8],
    [1, 1, 4],
    [2, 1, 2],
    [-2, 2, 1],
    [-1, 2, 2],
    [0, 2, 4],
    [1, 2, 2],
    [2, 2, 1],
  ]),
  burkes: taps(32, [
    [1, 0, 8],
    [2, 0, 4],
    [-2, 1, 2],
    [-1, 1, 4],
    [0, 1, 8],
    [1, 1, 4],
    [2, 1, 2],
  ]),
  sierra: taps(32, [
    [1, 0, 5],
    [2, 0, 3],
    [-2, 1, 2],
    [-1, 1, 4],
    [0, 1, 5],
    [1, 1, 4],
    [2, 1, 2],
    [-1, 2, 2],
    [0, 2, 3],
    [1, 2, 2],
  ]),
  "sierra-lite": taps(4, [
    [1, 0, 2],
    [-1, 1, 1],
    [0, 1, 1],
  ]),
};

export const ALGORITHMS: readonly AlgorithmDef[] = [
  { id: "floyd-steinberg", label: "Floyd Steinberg", kind: "diffusion" },
  { id: "atkinson", label: "Atkinson", kind: "diffusion" },
  { id: "jarvis-judice-ninke", label: "Jarvis Judice Ninke", kind: "diffusion" },
  { id: "stucki", label: "Stucki", kind: "diffusion" },
  { id: "burkes", label: "Burkes", kind: "diffusion" },
  { id: "sierra", label: "Sierra", kind: "diffusion" },
  { id: "sierra-lite", label: "Sierra Lite", kind: "diffusion" },
  { id: "bayer-2", label: "Bayer 2x2 (ordered)", kind: "ordered" },
  { id: "bayer-4", label: "Bayer 4x4 (ordered)", kind: "ordered" },
  { id: "bayer-8", label: "Bayer 8x8 (ordered)", kind: "ordered" },
  { id: "blue-noise", label: "Blue noise 64x64 (ordered)", kind: "ordered" },
  { id: "threshold", label: "Threshold (no dithering)", kind: "threshold" },
  { id: "random", label: "Random noise", kind: "random" },
];

const ALGORITHM_BY_ID = new Map(ALGORITHMS.map((a) => [a.id, a]));

function algorithmDef(id: string): AlgorithmDef {
  const def = ALGORITHM_BY_ID.get(id);
  if (!def) {
    throw new ToolError(
      "invalid-algorithm",
      `"${id}" is not a dithering algorithm.`,
      `Choose one of: ${ALGORITHMS.map((a) => a.id).join(", ")}.`,
    );
  }
  return def;
}

/* ------------------------------------------------------------------ *
 * threshold maps
 * ------------------------------------------------------------------ */

/** A tiled threshold map. `values` holds `size * size` numbers in [0, 1). */
export interface ThresholdMap {
  size: number;
  values: Float64Array;
}

/**
 * The recursive Bayer construction: M1 = [[0]] and
 * M2n = [[4M, 4M+2], [4M+3, 4M+1]]. Values are normalized to
 * `(rank + 0.5) / size^2` so the map is centered on 0.5.
 */
export function bayerMatrix(size: number): ThresholdMap {
  let m: number[][] = [[0]];
  let n = 1;
  while (n < size) {
    const next: number[][] = [];
    for (let y = 0; y < n * 2; y += 1) next.push(new Array<number>(n * 2).fill(0));
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const v = m[y]![x]! * 4;
        next[y]![x] = v;
        next[y]![x + n] = v + 2;
        next[y + n]![x] = v + 3;
        next[y + n]![x + n] = v + 1;
      }
    }
    m = next;
    n *= 2;
  }
  const total = size * size;
  const values = new Float64Array(total);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      values[y * size + x] = (m[y]![x]! + 0.5) / total;
    }
  }
  return { size, values };
}

/* ------------------------------------------------------------------ *
 * blue noise
 * ------------------------------------------------------------------ */

const BLUE_NOISE_SIZE = 64;
/** Fixed seed for the initial pattern, so the tile is byte stable forever. */
const BLUE_NOISE_SEED = 0x5eed1e55;

/** xorshift32, seeded from a constant. Deterministic across runtimes. */
function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Builds a 64x64 blue noise threshold tile with Ulichney's void and cluster
 * method (1993).
 *
 * A gaussian energy field (sigma 1.5, truncated at radius 4, wrapped at the
 * tile edges) scores how clustered the current pattern is. Phase 1 walks the
 * initial pattern apart by repeatedly removing its tightest cluster, phase 2
 * fills the largest void until the tile is half full, and phase 3 does the same
 * on the complement. The result ranks every one of the 4096 cells, and the
 * ranks become thresholds. Blue noise beats Bayer on photographs because it has
 * no periodic structure, so it never lays a visible grid over smooth gradients.
 *
 * Generating this costs a few tens of milliseconds, so it is built on first use
 * and cached rather than at import time.
 */
function buildBlueNoise(): ThresholdMap {
  const size = BLUE_NOISE_SIZE;
  const total = size * size;
  const radius = 4;
  const sigma = 1.5;

  const kernel: number[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      kernel.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
    }
  }

  const pattern = new Uint8Array(total);
  const energy = new Float64Array(total);

  const stamp = (index: number, sign: number): void => {
    const px = index % size;
    const py = (index / size) | 0;
    let k = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const y = (py + dy + size) % size;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = (px + dx + size) % size;
        energy[y * size + x] += sign * kernel[k]!;
        k += 1;
      }
    }
  };

  const addOne = (index: number): void => {
    pattern[index] = 1;
    stamp(index, 1);
  };
  const removeOne = (index: number): void => {
    pattern[index] = 0;
    stamp(index, -1);
  };

  /** Position of the one with the most neighbors: the tightest cluster. */
  const tightestCluster = (): number => {
    let best = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < total; i += 1) {
      if (pattern[i] === 1 && energy[i]! > bestValue) {
        bestValue = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  /** Position of the zero with the fewest neighbors: the largest void. */
  const largestVoid = (): number => {
    let best = -1;
    let bestValue = Infinity;
    for (let i = 0; i < total; i += 1) {
      if (pattern[i] === 0 && energy[i]! < bestValue) {
        bestValue = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  // Initial pattern: about a tenth of the cells, placed with a fixed seed.
  const rand = xorshift32(BLUE_NOISE_SEED);
  const initialOnes = Math.round(total * 0.1);
  let placed = 0;
  while (placed < initialOnes) {
    const i = Math.floor(rand() * total) % total;
    if (pattern[i] === 0) {
      addOne(i);
      placed += 1;
    }
  }

  // Walk the pattern apart until removing the tightest cluster would only put
  // it straight back into the same hole.
  for (let guard = 0; guard < total * 4; guard += 1) {
    const cluster = tightestCluster();
    removeOne(cluster);
    const voidPos = largestVoid();
    if (voidPos === cluster) {
      addOne(cluster);
      break;
    }
    addOne(voidPos);
  }

  const initial = pattern.slice();
  const ranks = new Int32Array(total).fill(-1);

  // Phase 1: rank the initial ones downward, tightest cluster first.
  for (let rank = initialOnes - 1; rank >= 0; rank -= 1) {
    const cluster = tightestCluster();
    removeOne(cluster);
    ranks[cluster] = rank;
  }

  // Phase 2: restore, then fill the largest void until the tile is half full.
  pattern.set(initial);
  energy.fill(0);
  for (let i = 0; i < total; i += 1) if (pattern[i] === 1) stamp(i, 1);
  const half = total / 2;
  for (let rank = initialOnes; rank < half; rank += 1) {
    const voidPos = largestVoid();
    addOne(voidPos);
    ranks[voidPos] = rank;
  }

  // Phase 3: swap the roles of ones and zeros and keep going.
  for (let i = 0; i < total; i += 1) pattern[i] = pattern[i] === 1 ? 0 : 1;
  energy.fill(0);
  for (let i = 0; i < total; i += 1) if (pattern[i] === 1) stamp(i, 1);
  for (let rank = half; rank < total; rank += 1) {
    const cluster = tightestCluster();
    removeOne(cluster);
    ranks[cluster] = rank;
  }

  const values = new Float64Array(total);
  for (let i = 0; i < total; i += 1) values[i] = (ranks[i]! + 0.5) / total;
  return { size, values };
}

let blueNoiseCache: ThresholdMap | null = null;

/** The 64x64 blue noise threshold tile, built once and reused. */
export function blueNoiseMap(): ThresholdMap {
  blueNoiseCache ??= buildBlueNoise();
  return blueNoiseCache;
}

const bayerCache = new Map<number, ThresholdMap>();

function thresholdMap(algorithm: string): ThresholdMap | null {
  if (algorithm === "blue-noise") return blueNoiseMap();
  const match = /^bayer-(\d+)$/.exec(algorithm);
  if (!match) return null;
  const size = Number(match[1]);
  let map = bayerCache.get(size);
  if (!map) {
    map = bayerMatrix(size);
    bayerCache.set(size, map);
  }
  return map;
}

/** Fixed seed for the `random` algorithm, so a re-run never flickers. */
const RANDOM_SEED = 0x9e3779b9;

/** Deterministic hash of a pixel position to a number in [0, 1). */
function positionNoise(x: number, y: number): number {
  let h = (Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x27220a95) ^ RANDOM_SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/* ------------------------------------------------------------------ *
 * color space
 * ------------------------------------------------------------------ */

/** sRGB byte to linear light, the IEC 61966-2-1 transfer function. */
function srgbToLinearValue(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const LINEAR_LUT = new Float64Array(256);
const PLAIN_LUT = new Float64Array(256);
for (let i = 0; i < 256; i += 1) {
  LINEAR_LUT[i] = srgbToLinearValue(i);
  PLAIN_LUT[i] = i / 255;
}

/* ------------------------------------------------------------------ *
 * quantization
 * ------------------------------------------------------------------ */

function assertSize(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 20000 ||
    height > 20000
  ) {
    throw new ToolError(
      "invalid-size",
      `A width and height of ${width} by ${height} is not a usable image size.`,
      "Pass the pixel width and height as positive whole numbers under 20000.",
    );
  }
}

function assertBuffer(rgba: Uint8ClampedArray, width: number, height: number): void {
  assertSize(width, height);
  const need = width * height * 4;
  if (rgba.length !== need) {
    throw new ToolError(
      "size-mismatch",
      `The buffer holds ${rgba.length} bytes, but ${width} by ${height} pixels needs ${need}.`,
      "Send four bytes per pixel, in red, green, blue, alpha order, with no header.",
    );
  }
}

/**
 * The typical spacing between neighboring palette colors, used as the
 * amplitude of the ordered and random threshold offsets.
 *
 * It is the mean distance from each palette color to its nearest other palette
 * color, divided by the square root of 3 to turn a three channel Euclidean
 * distance back into a per channel step. For an evenly spaced gray ramp this is
 * exact: 1 for black and white, 1/3 for four grays, 1/15 for sixteen. For a
 * color palette it is a heuristic that keeps the noise large enough to break
 * up banding and small enough not to wash the image out.
 */
function paletteStep(work: Float64Array, count: number): number {
  if (count < 2) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    let nearest = Infinity;
    for (let j = 0; j < count; j += 1) {
      if (i === j) continue;
      const dr = work[i * 3]! - work[j * 3]!;
      const dg = work[i * 3 + 1]! - work[j * 3 + 1]!;
      const db = work[i * 3 + 2]! - work[j * 3 + 2]!;
      const d = dr * dr + dg * dg + db * db;
      if (d < nearest) nearest = d;
    }
    sum += Math.sqrt(nearest);
  }
  return sum / count / Math.sqrt(3);
}

/* ------------------------------------------------------------------ *
 * the dither
 * ------------------------------------------------------------------ */

function readSettings(settings: DitherSettings): {
  def: AlgorithmDef;
  colors: readonly Rgb[];
  paletteId: string;
  serpentine: boolean;
  strength: number;
  gamma: boolean;
} {
  const def = algorithmDef(String(settings.algorithm ?? "floyd-steinberg"));
  const paletteId = String(settings.palette ?? "bw");
  const colors = paletteColors(paletteId, String(settings.customPalette ?? ""));

  const strength = settings.strength ?? 1;
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new ToolError(
      "invalid-strength",
      `A strength of ${strength} is outside the 0 to 1 range.`,
      "Use a value between 0 and 1. The default is 1, and lower values dither less.",
    );
  }

  return {
    def,
    colors,
    paletteId,
    serpentine: settings.serpentine !== false,
    strength,
    gamma: settings.gamma !== false,
  };
}

/**
 * Dithers an RGBA buffer down to a fixed palette and returns a new RGBA buffer
 * of the same size. Output pixels are always exact palette colors and always
 * fully opaque.
 */
export function dither(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  settings: DitherSettings = {},
): Uint8ClampedArray {
  assertBuffer(rgba, width, height);
  const { def, colors, serpentine, strength, gamma } = readSettings(settings);

  const lut = gamma ? LINEAR_LUT : PLAIN_LUT;
  const count = colors.length;

  // Palette in the working space, plus the sRGB bytes written back out.
  const work = new Float64Array(count * 3);
  const out8 = new Uint8Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const c = colors[i]!;
    for (let ch = 0; ch < 3; ch += 1) {
      work[i * 3 + ch] = lut[c[ch]!]!;
      out8[i * 3 + ch] = c[ch]!;
    }
  }

  const map = def.kind === "ordered" ? thresholdMap(def.id) : null;
  const step = def.kind === "diffusion" || def.kind === "threshold" ? 0 : paletteStep(work, count);
  const kernel = def.kind === "diffusion" ? KERNELS[def.id]! : null;
  const useSerpentine = kernel !== null && serpentine;

  const out = new Uint8ClampedArray(width * height * 4);

  // Rolling error rows, one per kernel row the taps can reach.
  let maxDy = 0;
  if (kernel) for (const tap of kernel.taps) if (tap.dy > maxDy) maxDy = tap.dy;
  const rowCount = maxDy + 1;
  const errorRows: Float64Array[] = [];
  for (let i = 0; i < rowCount; i += 1) errorRows.push(new Float64Array(width * 3));

  const nearest = (r: number, g: number, b: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i += 1) {
      const dr = r - work[i * 3]!;
      const dg = g - work[i * 3 + 1]!;
      const db = b - work[i * 3 + 2]!;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  };

  for (let y = 0; y < height; y += 1) {
    const reverse = useSerpentine && y % 2 === 1;
    const current = errorRows[0]!;

    for (let i = 0; i < width; i += 1) {
      const x = reverse ? width - 1 - i : i;
      const p = (y * width + x) * 4;

      const alpha = rgba[p + 3]! / 255;
      // Composite onto white in the working space; white is 1 in both spaces.
      let r = lut[rgba[p]!]! * alpha + (1 - alpha);
      let g = lut[rgba[p + 1]!]! * alpha + (1 - alpha);
      let b = lut[rgba[p + 2]!]! * alpha + (1 - alpha);

      if (kernel) {
        r += current[x * 3]!;
        g += current[x * 3 + 1]!;
        b += current[x * 3 + 2]!;
      } else if (map) {
        const m = map.values[(y % map.size) * map.size + (x % map.size)]!;
        const offset = strength * step * (m - 0.5);
        r += offset;
        g += offset;
        b += offset;
      } else if (def.kind === "random") {
        const offset = strength * step * (positionNoise(x, y) - 0.5);
        r += offset;
        g += offset;
        b += offset;
      }

      const index = nearest(r, g, b);
      out[p] = out8[index * 3]!;
      out[p + 1] = out8[index * 3 + 1]!;
      out[p + 2] = out8[index * 3 + 2]!;
      out[p + 3] = 255;

      if (kernel) {
        // The error is never clamped: clamping would quietly destroy the
        // average brightness that error diffusion exists to preserve.
        const er = (r - work[index * 3]!) * strength;
        const eg = (g - work[index * 3 + 1]!) * strength;
        const eb = (b - work[index * 3 + 2]!) * strength;
        for (const tap of kernel.taps) {
          // On a right to left row the kernel is mirrored, not just walked
          // backwards, or the error would land on pixels already visited.
          const tx = x + (reverse ? -tap.dx : tap.dx);
          if (tx < 0 || tx >= width) continue;
          if (y + tap.dy >= height) continue;
          const row = errorRows[tap.dy]!;
          const weight = tap.w / kernel.div;
          row[tx * 3] += er * weight;
          row[tx * 3 + 1] += eg * weight;
          row[tx * 3 + 2] += eb * weight;
        }
      }
    }

    if (kernel) {
      const recycled = errorRows.shift()!;
      recycled.fill(0);
      errorRows.push(recycled);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * resampling
 * ------------------------------------------------------------------ */

function assertResize(newW: number, newH: number): void {
  if (!Number.isInteger(newW) || !Number.isInteger(newH) || newW < 1 || newH < 1) {
    throw new ToolError(
      "invalid-size",
      `A target size of ${newW} by ${newH} is not usable.`,
      "Use positive whole numbers for the new width and height.",
    );
  }
}

/**
 * Nearest neighbor resampling. This is what you want when scaling pixel art
 * back up, because it keeps every hard edge exactly where the dither put it.
 */
export function resizeNearest(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  newW: number,
  newH: number,
): Uint8ClampedArray {
  assertBuffer(rgba, width, height);
  assertResize(newW, newH);
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < newH; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / newH));
    for (let x = 0; x < newW; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / newW));
      const from = (sy * width + sx) * 4;
      const to = (y * newW + x) * 4;
      out[to] = rgba[from]!;
      out[to + 1] = rgba[from + 1]!;
      out[to + 2] = rgba[from + 2]!;
      out[to + 3] = rgba[from + 3]!;
    }
  }
  return out;
}

/**
 * Area averaged (box filter) resampling. Every destination pixel is the mean of
 * the source rectangle it covers, weighted by how much of each source pixel
 * falls inside it. Downscaling with a box filter before dithering is what gives
 * clean chunky pixel art: dithering first and shrinking afterwards averages the
 * dither pattern itself back into gray mush.
 */
export function resizeBox(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  newW: number,
  newH: number,
): Uint8ClampedArray {
  assertBuffer(rgba, width, height);
  assertResize(newW, newH);
  const out = new Uint8ClampedArray(newW * newH * 4);
  const scaleX = width / newW;
  const scaleY = height / newH;

  for (let y = 0; y < newH; y += 1) {
    const y0 = y * scaleY;
    const y1 = (y + 1) * scaleY;
    const sy0 = Math.floor(y0);
    const sy1 = Math.min(height, Math.ceil(y1));

    for (let x = 0; x < newW; x += 1) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      const sx0 = Math.floor(x0);
      const sx1 = Math.min(width, Math.ceil(x1));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let total = 0;

      for (let sy = sy0; sy < sy1; sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const p = (sy * width + sx) * 4;
          r += rgba[p]! * weight;
          g += rgba[p + 1]! * weight;
          b += rgba[p + 2]! * weight;
          a += rgba[p + 3]! * weight;
          total += weight;
        }
      }

      const to = (y * newW + x) * 4;
      if (total === 0) total = 1;
      out[to] = r / total;
      out[to + 1] = g / total;
      out[to + 2] = b / total;
      out[to + 3] = a / total;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * reporting helpers
 * ------------------------------------------------------------------ */

const ASCII_RAMP = " .:-=+*#%@";

/** A rough text picture of a buffer, one character per pixel, for sanity checks. */
export function toAsciiPreview(rgba: Uint8ClampedArray, width: number, height: number): string {
  assertBuffer(rgba, width, height);
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    let row = "";
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const luma = 0.2126 * rgba[p]! + 0.7152 * rgba[p + 1]! + 0.0722 * rgba[p + 2]!;
      const i = Math.min(
        ASCII_RAMP.length - 1,
        Math.floor((luma / 255) * (ASCII_RAMP.length - 1) + 0.5),
      );
      row += ASCII_RAMP[i];
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Distinct RGB triples present in a buffer, ignoring alpha. */
export function uniqueColors(rgba: Uint8ClampedArray): number {
  const seen = new Set<number>();
  for (let p = 0; p < rgba.length; p += 4) {
    seen.add((rgba[p]! << 16) | (rgba[p + 1]! << 8) | rgba[p + 2]!);
  }
  return seen.size;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_LOOKUP[B64_ALPHABET[i] as string] = i;
B64_LOOKUP["-"] = 62;
B64_LOOKUP["_"] = 63;

/** Standard or URL safe base64 to bytes. Returns null on anything invalid. */
function base64ToBytes(raw: string): Uint8ClampedArray | null {
  const core = raw.replace(/\s+/g, "").replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  const out = new Uint8ClampedArray(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const ch of core) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[i] = (acc >> bits) & 0xff;
      i += 1;
    }
  }
  return i === out.length ? out : out.slice(0, i);
}

function usePanel(detail: string): ToolError {
  return new ToolError("use-panel", `This tool works on pixels; ${detail}`, USE_PANEL_FIX);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readScale(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new ToolError(
      "invalid-scale",
      `A pixel scale of ${String(value)} is not usable.`,
      "Use a whole number from 1 to 8. Higher numbers shrink the image further before dithering.",
    );
  }
  return n;
}

/**
 * Text surface for the tool.
 *
 * Dithering is a picture in and a picture out, and the generic shell only
 * renders text, so the real work happens in the panel on this page. What `run`
 * accepts is a small JSON payload of raw pixels, which is what makes the whole
 * pipeline runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 4, "height": 4, "rgbaBase64": "<base64 RGBA>" }
 * ```
 */
export function run(
  input: Uint8Array | string,
  opts: ImageDitheringOpts = {},
): ImageDitheringResult {
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
      throw usePanel("the input is not a pixel payload.");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    throw usePanel("the input is not a pixel payload.");
  }

  const raw = payload.rgbaBase64 ?? payload.rgba;
  if (typeof raw !== "string") {
    throw usePanel("the payload needs an `rgbaBase64` string of raw RGBA pixels.");
  }

  const width = positiveInt(payload.width);
  const height = positiveInt(payload.height);
  if (width === null || height === null) {
    throw usePanel("the payload needs a positive whole `width` and `height`.");
  }

  const bytes = base64ToBytes(raw);
  if (bytes === null) throw usePanel("`rgbaBase64` must be base64 encoded raw RGBA pixels.");
  assertBuffer(bytes, width, height);

  const scale = readScale(opts.scale);
  const outW = Math.max(1, Math.floor(width / scale));
  const outH = Math.max(1, Math.floor(height / scale));
  const source = scale === 1 ? bytes : resizeBox(bytes, width, height, outW, outH);

  const { def, colors, paletteId, serpentine, strength, gamma } = readSettings(opts);
  const result = dither(source, outW, outH, opts);
  const used = uniqueColors(result);

  const paletteLabel = PALETTES.find((p) => p.id === paletteId)?.label ?? paletteId;

  const rows: ImageDitheringResult = {
    Algorithm: `${def.label} (${def.kind === "diffusion" ? "error diffusion" : def.kind})`,
    Palette: `${paletteLabel}, ${colors.length} ${colors.length === 1 ? "color" : "colors"}`,
    "Output size":
      scale === 1
        ? `${outW} by ${outH} pixels`
        : `${outW} by ${outH} pixels, downscaled ${scale} times from ${width} by ${height}`,
    "Unique colors in output": `${used} of ${colors.length} palette ${
      colors.length === 1 ? "color" : "colors"
    } used`,
    Settings: `strength ${strength}, ${gamma ? "linear light" : "sRGB"} math, serpentine ${
      def.kind === "diffusion" ? (serpentine ? "on" : "off") : "not used by this algorithm"
    }`,
  };

  if (outW <= 96 && outH <= 96) {
    rows.Preview = toAsciiPreview(result, outW, outH);
  }

  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  ImageDitheringResult,
  ImageDitheringOpts
>;
