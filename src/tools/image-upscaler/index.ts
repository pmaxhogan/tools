import { ToolError, type ToolLogic } from "../types";

/**
 * Tiled 4x super resolution, the pure half.
 *
 * The panel owns the canvas, the ONNX session, and the download; everything
 * that decides *what* pixels go where lives here so it can be tested in Node
 * against plain typed arrays. Nothing in this module touches the DOM, the
 * network, or WebGPU.
 *
 * The tiling contract, which is the part most likely to go wrong:
 *
 *  - Tiles are a fixed size. When the image does not divide evenly the last
 *    tile in a row or column is SHIFTED BACK to sit flush with the edge rather
 *    than shrunk. One input shape means one shader compile on the WebGPU
 *    execution provider instead of a fresh one per odd-sized edge tile, and it
 *    keeps every tile's context window the same width.
 *  - Neighbors therefore overlap by at least `overlap` source pixels, and the
 *    shifted edge tiles overlap by more. Blending copes with both because it
 *    accumulates `sum += weight * value` and divides by the total weight at
 *    the end, so the weights normalize to exactly 1 wherever they land. A
 *    scheme that instead assumes a fixed ramp shape is what produces the
 *    classic darkened 8 pixel border around the outside of the result.
 *  - The total weight is separable. Tiles form a full grid of columns times
 *    rows, so the weight at an output pixel is (sum over columns) times (sum
 *    over rows), which collapses the normalizer from a full frame buffer down
 *    to two one dimensional arrays.
 *  - Every coordinate scales by `scale` on the way out: an overlap of 16
 *    source pixels is a 64 pixel feather in the upscaled result.
 */

/** Both staged models are 4x. Kept as a constant so the math never hardcodes 4. */
export const SCALE = 4;

/** Source pixels per tile edge. Small enough that one tile fits WASM comfortably. */
export const TILE = 128;

/** Source pixels shared with each neighbor. The feather is this times SCALE. */
export const OVERLAP = 16;

/** Refused outright above this, per side. A 4x model turns 4096 into 16384. */
export const MAX_SOURCE_EDGE = 4096;

/** Widest result a canvas can be relied on to hold in every browser. */
export const MAX_OUTPUT_EDGE = 8192;

/** Area ceiling for the result: 4096 by 4096. Past this the buffers stop fitting. */
export const MAX_OUTPUT_PIXELS = 16_777_216;

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

/** One staged ONNX model, as the panel needs to describe and fetch it. */
export interface UpscalerModel {
  /** Stable id, also the value of the `model` option. */
  id: string;
  /** Menu label. Carries the download size because the size is the tradeoff. */
  label: string;
  /** Same origin path staged by scripts/prepare-models.mjs. */
  file: string;
  /** Exact staged byte count, for the progress bar before the headers arrive. */
  bytes: number;
  /** Upscale factor of the graph. Both models are 4x today. */
  scale: number;
  /** Where the weights came from, shown in the panel. */
  source: string;
  /** License of the weights. */
  license: string;
  /** One line on what the model is good at. */
  note: string;
}

/**
 * The two staged models. Both take `input` as NCHW float32 RGB in 0 to 1 and
 * return `output` at 4x, unclipped, so the caller clamps.
 */
export const MODELS: readonly UpscalerModel[] = [
  {
    id: "general",
    label: "General (fast, 4.9 MB)",
    file: "/models/upscaler/realesr-general-x4v3.onnx",
    bytes: 4_866_417,
    scale: 4,
    source: "CoderViking/realesr-general-x4v3-onnx",
    license: "BSD 3-Clause, from Real-ESRGAN by Xintao Wang",
    note: "A compact 1.2 million parameter network. Quick everywhere, and the sane default for screenshots, logos, and web graphics.",
  },
  {
    id: "photo",
    label: "Photo x4plus (66 MB)",
    file: "/models/upscaler/real-esrgan-x4plus.onnx",
    bytes: 69_539_503,
    scale: 4,
    source: "wide-video/real-esrgan-v1.0.0",
    license: "BSD 3-Clause, from Real-ESRGAN by Xintao Wang",
    note: "The full 16.7 million parameter RealESRGAN_x4plus. Much better on photographs and much slower, with a far larger download.",
  },
];

/** The model a first visit gets: small download, runs on any machine. */
export const DEFAULT_MODEL_ID = "general";

/** Looks a model up by id, falling back to the default rather than throwing. */
export function modelById(id: string | undefined): UpscalerModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

/** One tile of the source image. Integer coordinates, top left origin. */
export interface TileRect {
  /** Column index, left to right. */
  col: number;
  /** Row index, top to bottom. */
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A complete tiling of one image, plus the numbers derived from it. */
export interface TilePlan {
  width: number;
  height: number;
  /** Tile edge actually used. Smaller than the request on a tiny image. */
  tileWidth: number;
  tileHeight: number;
  /** Source pixels shared with a neighbor. Zero when a side holds one tile. */
  overlap: number;
  scale: number;
  cols: number;
  rows: number;
  outputWidth: number;
  outputHeight: number;
  tiles: TileRect[];
}

function positiveInt(value: number, name: string): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new ToolError(
      "bad-size",
      `${name} must be a positive whole number of pixels, not ${value}.`,
      "Pass the pixel dimensions of the decoded image.",
    );
  }
  return n;
}

/** Result size for a given source size. The one place the 4x lives. */
export function outputDims(
  width: number,
  height: number,
  scale: number = SCALE,
): { width: number; height: number } {
  return {
    width: positiveInt(width, "Width") * scale,
    height: positiveInt(height, "Height") * scale,
  };
}

/**
 * Refuses a job that the browser cannot finish, before any weights download.
 *
 * Three separate ceilings, because they fail in three different ways: an
 * enormous source is slow past the point of usefulness, an over wide result
 * silently truncates on a canvas, and an over large result runs the tab out of
 * memory partway through.
 */
export function checkSourceSize(width: number, height: number, scale: number = SCALE): void {
  const w = positiveInt(width, "Width");
  const h = positiveInt(height, "Height");

  if (w > MAX_SOURCE_EDGE || h > MAX_SOURCE_EDGE) {
    throw new ToolError(
      "source-too-large",
      `This image is ${w} by ${h} pixels, and this tool stops at ${MAX_SOURCE_EDGE} pixels on a side.`,
      "Crop to the part you actually want enlarged, or scale the image down first. Upscaling is for small images.",
    );
  }

  const out = outputDims(w, h, scale);
  if (out.width > MAX_OUTPUT_EDGE || out.height > MAX_OUTPUT_EDGE) {
    throw new ToolError(
      "output-too-wide",
      `A ${scale}x result would be ${out.width} by ${out.height} pixels, and browsers cannot hold a canvas wider than ${MAX_OUTPUT_EDGE} pixels.`,
      `Crop or scale the image so neither side is over ${Math.floor(MAX_OUTPUT_EDGE / scale)} pixels, then run it again.`,
    );
  }

  if (out.width * out.height > MAX_OUTPUT_PIXELS) {
    throw new ToolError(
      "output-too-large",
      `A ${scale}x result would be ${out.width} by ${out.height} pixels, about ${Math.round((out.width * out.height) / 1_000_000)} megapixels, which is more than a browser tab can hold.`,
      "Crop to the region you want enlarged, or scale the image down first. The limit works out to roughly 1024 by 1024 going in.",
    );
  }
}

/**
 * Lays out fixed size tiles over the image, shifting the last one in each
 * direction back to the edge instead of shrinking it.
 */
export function planTiles(
  width: number,
  height: number,
  tile: number = TILE,
  overlap: number = OVERLAP,
  scale: number = SCALE,
): TilePlan {
  const w = positiveInt(width, "Width");
  const h = positiveInt(height, "Height");
  const requested = positiveInt(tile, "Tile size");

  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new ToolError(
      "bad-overlap",
      `Overlap must be zero or more source pixels, not ${overlap}.`,
      "Leave it at the default of 16 unless a seam shows.",
    );
  }
  if (overlap >= requested) {
    throw new ToolError(
      "bad-overlap",
      `Overlap of ${overlap} pixels does not fit inside a ${requested} pixel tile.`,
      "Use an overlap smaller than the tile, for example 16 inside 128.",
    );
  }

  const tileWidth = Math.min(requested, w);
  const tileHeight = Math.min(requested, h);
  // A side that holds exactly one tile has nothing to share, so its feather is
  // switched off rather than left to ramp against an edge that has no partner.
  const ov = Math.floor(Math.min(overlap, Math.min(tileWidth, tileHeight) - 1));
  const stepX = Math.max(1, tileWidth - ov);
  const stepY = Math.max(1, tileHeight - ov);
  const cols = 1 + Math.ceil((w - tileWidth) / stepX);
  const rows = 1 + Math.ceil((h - tileHeight) / stepY);

  const tiles: TileRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(row * stepY, h - tileHeight);
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(col * stepX, w - tileWidth);
      tiles.push({ col, row, x, y, w: tileWidth, h: tileHeight });
    }
  }

  return {
    width: w,
    height: h,
    tileWidth,
    tileHeight,
    overlap: cols > 1 || rows > 1 ? ov : 0,
    scale,
    cols,
    rows,
    outputWidth: w * scale,
    outputHeight: h * scale,
    tiles,
  };
}

/* ------------------------------------------------------------------ */
/* pixels in, pixels out                                               */
/* ------------------------------------------------------------------ */

function expectPixels(length: number, width: number, height: number): void {
  if (length < width * height * 4) {
    throw new ToolError(
      "short-buffer",
      `The pixel buffer holds ${length} values, which is short of the ${width * height * 4} an image of ${width} by ${height} needs.`,
      "Pass the full RGBA data for the image, four values per pixel.",
    );
  }
}

/**
 * One tile of an RGBA buffer as the planar float the models expect: three
 * channels of height by width, red first, values in 0 to 1. Alpha is dropped,
 * because neither network has anything to say about it.
 */
export function preprocessTile(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  rect: TileRect,
): Float32Array {
  const w = positiveInt(width, "Width");
  const h = positiveInt(height, "Height");
  expectPixels(rgba.length, w, h);

  const { x, y, w: tw, h: th } = rect;
  if (x < 0 || y < 0 || tw < 1 || th < 1 || x + tw > w || y + th > h) {
    throw new ToolError(
      "tile-out-of-bounds",
      `Tile at ${x}, ${y} sized ${tw} by ${th} does not fit inside a ${w} by ${h} image.`,
      "Build tiles with planTiles so they always land inside the image.",
    );
  }

  const area = tw * th;
  const out = new Float32Array(area * 3);
  for (let row = 0; row < th; row += 1) {
    let src = ((y + row) * w + x) * 4;
    let dst = row * tw;
    for (let col = 0; col < tw; col += 1) {
      out[dst] = (rgba[src] ?? 0) / 255;
      out[area + dst] = (rgba[src + 1] ?? 0) / 255;
      out[area * 2 + dst] = (rgba[src + 2] ?? 0) / 255;
      src += 4;
      dst += 1;
    }
  }
  return out;
}

/** The whole image as planar float, for a job small enough to run in one pass. */
export function preprocess(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const w = positiveInt(width, "Width");
  const h = positiveInt(height, "Height");
  return preprocessTile(rgba, w, h, { col: 0, row: 0, x: 0, y: 0, w, h });
}

/**
 * Planar float back to RGBA bytes, opaque. Values outside 0 to 1 are clamped:
 * neither graph clips its output, so a sharpened edge routinely overshoots.
 */
export function postprocess(
  chw: ArrayLike<number>,
  width: number,
  height: number,
): Uint8ClampedArray {
  const w = positiveInt(width, "Width");
  const h = positiveInt(height, "Height");
  const area = w * h;
  if (chw.length < area * 3) {
    throw new ToolError(
      "short-buffer",
      `The model result holds ${chw.length} values, short of the ${area * 3} an image of ${w} by ${h} needs.`,
      "Check that the tile size handed to the model matches the size read back from it.",
    );
  }

  const out = new Uint8ClampedArray(area * 4);
  for (let i = 0; i < area; i += 1) {
    const p = i * 4;
    // Uint8ClampedArray rounds and clamps on assignment, which is exactly the
    // conversion wanted here, so no Math.round or Math.min is needed.
    out[p] = (chw[i] ?? 0) * 255;
    out[p + 1] = (chw[area + i] ?? 0) * 255;
    out[p + 2] = (chw[area * 2 + i] ?? 0) * 255;
    out[p + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* blending                                                            */
/* ------------------------------------------------------------------ */

/**
 * Linear ramp across a feather band at each end of a tile, flat in the middle.
 * Never returns zero inside the tile, so a pixel covered by exactly one tile
 * still normalizes cleanly.
 */
export function featherWeight(offset: number, length: number, feather: number): number {
  if (feather <= 0) return 1;
  const rising = (offset + 0.5) / feather;
  const falling = (length - offset - 0.5) / feather;
  const w = Math.min(1, rising, falling);
  return w > 0 ? w : 0;
}

/** Running state for merging upscaled tiles into one image. */
export interface Blender {
  plan: TilePlan;
  /** Weighted sums, plane major: channel, then row, then column. */
  sum: Float32Array;
  /** Column weights. Separable, so this is a line rather than a frame. */
  weightX: Float32Array;
  /** Row weights. */
  weightY: Float32Array;
  /** How many tiles have been merged so far. */
  added: number;
}

/** Per column and per row feather profiles, summed over the whole grid. */
function axisWeights(
  count: number,
  starts: number[],
  span: number,
  total: number,
  feather: number,
): Float32Array {
  const weights = new Float32Array(total);
  for (let i = 0; i < count; i += 1) {
    const start = starts[i]!;
    for (let u = 0; u < span; u += 1) {
      weights[start + u] += featherWeight(u, span, feather);
    }
  }
  return weights;
}

/** Allocates the accumulators for one plan. Nothing is read from the image yet. */
export function createBlender(plan: TilePlan): Blender {
  const { outputWidth, outputHeight, scale } = plan;
  const feather = plan.overlap * scale;

  const colStarts: number[] = [];
  for (let col = 0; col < plan.cols; col += 1) {
    colStarts.push(plan.tiles[col]!.x * scale);
  }
  const rowStarts: number[] = [];
  for (let row = 0; row < plan.rows; row += 1) {
    rowStarts.push(plan.tiles[row * plan.cols]!.y * scale);
  }

  return {
    plan,
    sum: new Float32Array(outputWidth * outputHeight * 3),
    weightX: axisWeights(plan.cols, colStarts, plan.tileWidth * scale, outputWidth, feather),
    weightY: axisWeights(plan.rows, rowStarts, plan.tileHeight * scale, outputHeight, feather),
    added: 0,
  };
}

/**
 * Merges one upscaled tile. `chw` is the model output for `plan.tiles[index]`:
 * three planes of tileHeight*scale by tileWidth*scale.
 */
export function addTile(blender: Blender, index: number, chw: ArrayLike<number>): void {
  const { plan, sum } = blender;
  const rect = plan.tiles[index];
  if (!rect) {
    throw new ToolError(
      "no-such-tile",
      `Tile ${index} is not in a plan that holds ${plan.tiles.length} tiles.`,
      "Merge tiles by their index in plan.tiles.",
    );
  }

  const scale = plan.scale;
  const tw = rect.w * scale;
  const th = rect.h * scale;
  const area = tw * th;
  if (chw.length < area * 3) {
    throw new ToolError(
      "short-tile",
      `Tile ${index} came back with ${chw.length} values, short of the ${area * 3} expected for ${tw} by ${th}.`,
      "Check that the model ran at the tile size the plan asked for.",
    );
  }

  const feather = plan.overlap * scale;
  const rampX = new Float32Array(tw);
  for (let u = 0; u < tw; u += 1) rampX[u] = featherWeight(u, tw, feather);
  const rampY = new Float32Array(th);
  for (let v = 0; v < th; v += 1) rampY[v] = featherWeight(v, th, feather);

  const outW = plan.outputWidth;
  const plane = outW * plan.outputHeight;
  const originX = rect.x * scale;
  const originY = rect.y * scale;

  for (let c = 0; c < 3; c += 1) {
    const srcPlane = c * area;
    const dstPlane = c * plane;
    for (let v = 0; v < th; v += 1) {
      const wy = rampY[v]!;
      const srcRow = srcPlane + v * tw;
      const dstRow = dstPlane + (originY + v) * outW + originX;
      for (let u = 0; u < tw; u += 1) {
        sum[dstRow + u] += wy * rampX[u]! * (chw[srcRow + u] ?? 0);
      }
    }
  }
  blender.added += 1;
}

/** Divides out the accumulated weight and hands back opaque RGBA bytes. */
export function finishBlend(blender: Blender): Uint8ClampedArray {
  const { plan, sum, weightX, weightY } = blender;
  const w = plan.outputWidth;
  const h = plan.outputHeight;
  const plane = w * h;
  const out = new Uint8ClampedArray(plane * 4);

  for (let y = 0; y < h; y += 1) {
    const wy = weightY[y]!;
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      const norm = 1 / (wy * weightX[x]!);
      const i = row + x;
      const p = i * 4;
      out[p] = sum[i]! * norm * 255;
      out[p + 1] = sum[plane + i]! * norm * 255;
      out[p + 2] = sum[plane * 2 + i]! * norm * 255;
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * The whole merge in one call: every tile in plan order, feathered and
 * normalized, as RGBA bytes. The panel adds tiles one at a time instead so it
 * can paint progress, but the result is identical.
 */
export function blendTiles(tiles: ArrayLike<number>[], plan: TilePlan): Uint8ClampedArray {
  if (tiles.length !== plan.tiles.length) {
    throw new ToolError(
      "tile-count-mismatch",
      `Got ${tiles.length} upscaled tiles for a plan of ${plan.tiles.length}.`,
      "Run every tile in plan.tiles, in order, before merging.",
    );
  }
  const blender = createBlender(plan);
  for (let i = 0; i < tiles.length; i += 1) addTile(blender, i, tiles[i]!);
  return finishBlend(blender);
}

/** Alias kept because "stitch" is what the seam problem is usually called. */
export const stitch = blendTiles;

/* ------------------------------------------------------------------ */
/* runtime choice                                                      */
/* ------------------------------------------------------------------ */

/** Execution provider name for onnxruntime-web, given what the browser has. */
export function pickProvider(hasWebGpu: boolean): "webgpu" | "wasm" {
  return hasWebGpu ? "webgpu" : "wasm";
}

/** Honest one liner about what the chosen provider means for the wait. */
export function providerNote(provider: "webgpu" | "wasm"): string {
  return provider === "webgpu"
    ? "WebGPU: the graphics card runs the network, so a tile takes a fraction of a second."
    : "WebAssembly: your processor runs the network. It works everywhere and is several times slower, so large images take a while.";
}

/* ------------------------------------------------------------------ */
/* header sniffing, so run() can say something true                    */
/* ------------------------------------------------------------------ */

function be16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function be32(b: Uint8Array, at: number): number {
  // Unsigned: the PNG signature's leading 0x89 would otherwise shift into the
  // sign bit and compare as a negative number.
  return (
    (((b[at] ?? 0) << 24) |
      ((b[at + 1] ?? 0) << 16) |
      ((b[at + 2] ?? 0) << 8) |
      (b[at + 3] ?? 0)) >>>
    0
  );
}
function le16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function le32(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) |
      ((b[at + 1] ?? 0) << 8) |
      ((b[at + 2] ?? 0) << 16) |
      ((b[at + 3] ?? 0) << 24)) >>>
    0
  );
}
function ascii(b: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** What an image file says it is, and how big, without decoding it. */
export interface ImageHeader {
  format: string;
  width: number;
  height: number;
}

/**
 * Reads format and pixel size out of the first bytes of a file. Returns null
 * for anything not recognized, which is not an error: the panel decodes the
 * file for real, and this only exists so run() can describe a job.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 24 && be32(bytes, 0) === 0x89504e47 && be32(bytes, 4) === 0x0d0a1a0a) {
    return { format: "PNG", width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 10 && ascii(bytes, 0, "GIF8")) {
    return { format: "GIF", width: le16(bytes, 6), height: le16(bytes, 8) };
  }
  if (bytes.length >= 26 && ascii(bytes, 0, "BM")) {
    return { format: "BMP", width: le32(bytes, 18), height: Math.abs(le32(bytes, 22) | 0) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    if (ascii(bytes, 12, "VP8X")) {
      const w = ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1;
      const h = ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1;
      return { format: "WebP", width: w, height: h };
    }
    if (ascii(bytes, 12, "VP8L")) {
      const bits = le32(bytes, 21);
      return {
        format: "WebP",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (ascii(bytes, 12, "VP8 ")) {
      return {
        format: "WebP",
        width: le16(bytes, 26) & 0x3fff,
        height: le16(bytes, 28) & 0x3fff,
      };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1] ?? 0;
      // Start of frame markers carry the size. C4, C8 and CC are tables, not frames.
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { format: "JPEG", width: be16(bytes, at + 7), height: be16(bytes, at + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      at += 2 + be16(bytes, at + 2);
    }
    return { format: "JPEG", width: 0, height: 0 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface UpscalerOpts {
  /** Which staged model to run. See MODELS. */
  model?: string;
  [key: string]: unknown;
}

export type UpscalerResult = Record<string, string>;

const USAGE =
  "Drop an image on the panel above and press Upscale. The model downloads once, then the image is cut into overlapping tiles, each tile is enlarged four times, and the tiles are feathered back together. Drag the divider on the result to compare it against the original.";

const HONESTY =
  "Real-ESRGAN invents the detail it adds. It is guessing what a sharper version of your image would look like, so faces, small text, and fine patterns can come back confidently wrong. Read the result before trusting it, especially for anything that has to stay faithful to the original.";

const PRIVACY =
  "The model runs inside this tab: your files and inputs never leave your device. The weights themselves are served from this site and your browser keeps them for next time.";

/**
 * Panel first, like the other Local AI tools: the upscale itself needs a
 * canvas and a GPU, so run() describes the job that the panel would do rather
 * than pretending to do it in a pure function.
 */
export function run(input: Uint8Array | string, opts: UpscalerOpts = {}): UpscalerResult {
  const model = modelById(typeof opts.model === "string" ? opts.model : DEFAULT_MODEL_ID);
  const rows: UpscalerResult = {};

  if (typeof input === "string") {
    rows.Input = input.trim()
      ? "Text was pasted. This tool enlarges images, so drop or pick a picture instead."
      : "No image loaded yet.";
    rows["How to use"] = USAGE;
    rows.Model = `${model.label}. ${model.note}`;
    rows.Limits = `Up to ${MAX_SOURCE_EDGE} pixels on a side, and the ${model.scale}x result has to stay under ${MAX_OUTPUT_EDGE} pixels wide and about ${MAX_OUTPUT_PIXELS / 1_000_000} megapixels.`;
    rows["What to expect"] = HONESTY;
    rows.Privacy = PRIVACY;
    return rows;
  }

  if (input.length === 0) {
    throw new ToolError(
      "empty-file",
      "That file is empty, so there is nothing to enlarge.",
      "Pick a PNG, JPEG, WebP, GIF, or BMP image and try again.",
    );
  }

  const header = readImageHeader(input);
  rows.Loaded = header
    ? `${header.format} image${header.width > 0 ? `, ${header.width} by ${header.height} pixels` : ""}.`
    : "The file was read, but its header is not one this tool recognizes. The panel will try to decode it anyway.";
  rows.Model = `${model.label}. ${model.note}`;

  if (header && header.width > 0 && header.height > 0) {
    checkSourceSize(header.width, header.height, model.scale);
    const out = outputDims(header.width, header.height, model.scale);
    const plan = planTiles(header.width, header.height, TILE, OVERLAP, model.scale);
    rows.Result = `${out.width} by ${out.height} pixels, ${model.scale}x on each side.`;
    rows.Tiles = `${plan.tiles.length} tiles of ${plan.tileWidth} by ${plan.tileHeight} pixels, overlapping by ${plan.overlap}, blended with a ${plan.overlap * model.scale} pixel feather.`;
  }

  rows["How to use"] = USAGE;
  rows["What to expect"] = HONESTY;
  rows.Privacy = PRIVACY;
  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, UpscalerResult, UpscalerOpts>;
