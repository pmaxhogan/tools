import { ToolError, type ToolLogic } from "../types";

/**
 * Image Color Palette Extractor logic.
 *
 * Two stages, in the order that gives the best answer for the least work.
 * Median cut first, because it splits the colors that are actually in the
 * picture rather than starting from arbitrary seeds, then a few rounds of
 * k-means to move each center to the true middle of its cluster. Median cut
 * alone gives boxes whose centers sit off the visual center of a gradient;
 * k-means alone, seeded at random, drops a center into an empty region and
 * returns a color the picture never contained.
 *
 * Both stages run in OKLab rather than in sRGB. Distance in sRGB is not
 * perceptual: two dark colors an equal number of byte steps apart look far
 * closer than two light ones, so an sRGB clustering spends most of its palette
 * on highlights and collapses the shadows into one muddy entry.
 *
 * Pure over an ImageData shaped object, so the panel hands in real canvas
 * pixels and the tests hand in a hand built array.
 */

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** An ImageData shaped object: RGBA, four bytes per pixel, row major. */
export interface ImageLike {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export type Vec3 = [number, number, number];

export interface Swatch {
  /** #rrggbb. */
  hex: string;
  /** `rgb(r g b)`. */
  rgb: string;
  /** `hsl(h s% l%)`. */
  hsl: string;
  /** `oklch(l c h)`. */
  oklch: string;
  /** 0..255 channels, for a panel that needs to paint the swatch. */
  channels: Vec3;
  /** How many sampled pixels landed in this cluster. */
  count: number;
  /** That count as a fraction of every sampled pixel, 0..1. */
  share: number;
  /** Black or white, whichever reads better on this swatch. */
  textColor: string;
  /** WCAG contrast ratio of `textColor` against the swatch. */
  textContrast: number;
}

export interface PaletteResult {
  swatches: Swatch[];
  /** The largest cluster. Always present when there is at least one swatch. */
  dominant: Swatch;
  /** How many pixels were actually clustered, after downsampling. */
  sampled: number;
  /** How many pixels the source held. */
  total: number;
  /** Pixels skipped because they were fully or nearly transparent. */
  skippedTransparent: number;
}

export interface PaletteOpts {
  /** How many colors to pull out, 2 to 16. */
  colors?: number;
  /** Order of the returned swatches. */
  sort?: "share" | "lightness" | "hue";
  /** Skip nearly transparent pixels rather than treating them as black. */
  ignoreTransparent?: boolean;
  /** Prefix for the generated CSS custom properties. */
  cssPrefix?: string;
  [key: string]: unknown;
}

/** Upper bound on pixels fed to the clustering. Beyond this the answer stops moving. */
export const MAX_SAMPLES = 24_000;

/** Alpha at or below this counts as transparent. */
const ALPHA_FLOOR = 8;

/* ------------------------------------------------------------------ */
/* color math                                                          */
/*                                                                     */
/* A deliberate copy of the same functions in the color picker tool.    */
/* PROJECT.md rule 13 keeps every tool independently deletable, so the  */
/* few conversions this one needs live here rather than being imported  */
/* across tool directories.                                             */
/* ------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeHue(h: number): number {
  const x = h % 360;
  return x < 0 ? x + 360 : x;
}

/** sRGB transfer function: one gamma encoded 0..1 channel to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function: linear light back to gamma encoded 0..1. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Gamma encoded sRGB (0..1) to OKLab, using Ottosson's published matrices. */
export function srgbToOklab(rgb: Vec3): Vec3 {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab back to gamma encoded sRGB (0..1), clamped into gamut. */
export function oklabToSrgb(lab: Vec3): Vec3 {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
  return [
    linearToSrgb(clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0, 1)),
    linearToSrgb(clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0, 1)),
    linearToSrgb(clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s, 0, 1)),
  ];
}

/** Gamma encoded sRGB (0..1) to HSL: hue in degrees, the rest as percentages. */
export function srgbToHsl(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [normalizeHue(h * 60), s * 100, l * 100];
}

/** WCAG 2.x relative luminance of a gamma encoded sRGB triple. */
export function relativeLuminance(rgb: Vec3): number {
  return (
    0.2126 * srgbToLinear(clamp(rgb[0], 0, 1)) +
    0.7152 * srgbToLinear(clamp(rgb[1], 0, 1)) +
    0.0722 * srgbToLinear(clamp(rgb[2], 0, 1))
  );
}

/** WCAG 2.x contrast ratio between two gamma encoded sRGB triples. */
export function contrastRatio(a: Vec3, b: Vec3): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Fixed decimals with trailing zeros trimmed, and no negative zero. */
function num(v: number, dp: number): string {
  if (!Number.isFinite(v)) return "0";
  let s = v.toFixed(dp);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** #rrggbb from 0..255 channels. */
export function toHex(channels: Vec3): string {
  const part = (v: number): string =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${part(channels[0])}${part(channels[1])}${part(channels[2])}`;
}

/**
 * Black or white, whichever has the higher WCAG contrast on this swatch. Only
 * two candidates, because a swatch label has to stay legible without inventing
 * a third color the palette does not contain.
 */
export function textColorFor(channels: Vec3): { color: string; contrast: number } {
  const rgb: Vec3 = [channels[0] / 255, channels[1] / 255, channels[2] / 255];
  const onBlack = contrastRatio(rgb, [0, 0, 0]);
  const onWhite = contrastRatio(rgb, [1, 1, 1]);
  return onBlack >= onWhite
    ? { color: "#000000", contrast: onBlack }
    : { color: "#ffffff", contrast: onWhite };
}

function makeSwatch(channels: Vec3, count: number, sampled: number): Swatch {
  const unit: Vec3 = [channels[0] / 255, channels[1] / 255, channels[2] / 255];
  const [h, s, l] = srgbToHsl(unit);
  const lab = srgbToOklab(unit);
  const chroma = Math.hypot(lab[1], lab[2]);
  const hue =
    chroma < 1e-4 ? "none" : num(normalizeHue((Math.atan2(lab[2], lab[1]) * 180) / Math.PI), 2);
  const text = textColorFor(channels);
  return {
    hex: toHex(channels),
    rgb: `rgb(${Math.round(channels[0])} ${Math.round(channels[1])} ${Math.round(channels[2])})`,
    hsl: `hsl(${num(h, 1)} ${num(s, 1)}% ${num(l, 1)}%)`,
    oklch: `oklch(${num(lab[0], 3)} ${num(chroma, 4)} ${hue})`,
    channels: [Math.round(channels[0]), Math.round(channels[1]), Math.round(channels[2])],
    count,
    share: sampled > 0 ? count / sampled : 0,
    textColor: text.color,
    textContrast: text.contrast,
  };
}

/* ------------------------------------------------------------------ */
/* sampling                                                            */
/* ------------------------------------------------------------------ */

export interface SampleSet {
  /** OKLab triples, three floats per sampled pixel. */
  lab: Float64Array;
  /** The same pixels as 0..255 sRGB, three bytes per pixel. */
  rgb: Uint8Array;
  count: number;
  total: number;
  skippedTransparent: number;
}

/**
 * Take an evenly spaced subset of the picture, at most `MAX_SAMPLES` pixels.
 *
 * The stride is computed rather than random so the same image always gives the
 * same palette: a tool that returns a different answer on a second click is
 * useless for picking brand colors. It also strides rather than cropping, so a
 * color that only appears in one corner still gets counted.
 */
export function samplePixels(image: ImageLike, ignoreTransparent = true): SampleSet {
  const total = image.width * image.height;
  if (!Number.isFinite(total) || total <= 0) {
    throw new ToolError(
      "empty-image",
      "That image has no pixels in it.",
      "Drop a PNG, JPEG, WebP, or GIF with actual content.",
    );
  }
  if (image.data.length < total * 4) {
    throw new ToolError(
      "short-buffer",
      `The pixel buffer holds ${image.data.length} bytes, but ${image.width} by ${image.height} pixels needs ${total * 4}.`,
      "Pass the full RGBA buffer, four bytes per pixel.",
    );
  }

  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  const capacity = Math.ceil(total / stride);
  const lab = new Float64Array(capacity * 3);
  const rgb = new Uint8Array(capacity * 3);
  let count = 0;
  let skipped = 0;

  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    const alpha = image.data[i + 3]!;
    if (ignoreTransparent && alpha <= ALPHA_FLOOR) {
      skipped++;
      continue;
    }
    const r = image.data[i]!;
    const g = image.data[i + 1]!;
    const b = image.data[i + 2]!;
    const at = count * 3;
    rgb[at] = r;
    rgb[at + 1] = g;
    rgb[at + 2] = b;
    const [l, la, lb] = srgbToOklab([r / 255, g / 255, b / 255]);
    lab[at] = l;
    lab[at + 1] = la;
    lab[at + 2] = lb;
    count++;
  }

  if (count === 0) {
    throw new ToolError(
      "all-transparent",
      "Every pixel in that image is transparent, so there are no colors to pull out.",
      'Turn off "Skip transparent pixels", or use an image with something visible in it.',
    );
  }

  return { lab, rgb, count, total, skippedTransparent: skipped };
}

/* ------------------------------------------------------------------ */
/* median cut                                                          */
/* ------------------------------------------------------------------ */

interface Box {
  start: number;
  end: number;
  /** Longest axis extent, which is what decides the next split. */
  spread: number;
  axis: number;
}

function measureBox(lab: Float64Array, order: Int32Array, start: number, end: number): Box {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = start; i < end; i++) {
    const at = order[i]! * 3;
    for (let c = 0; c < 3; c++) {
      const v = lab[at + c]!;
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  let axis = 0;
  let spread = -1;
  for (let c = 0; c < 3; c++) {
    const range = hi[c] - lo[c];
    if (range > spread) {
      spread = range;
      axis = c;
    }
  }
  return { start, end, spread, axis };
}

/**
 * Median cut in OKLab: repeatedly split the box with the widest axis at the
 * median of that axis, until there are `k` boxes or nothing worth splitting
 * remains. Returns one center per box, as OKLab triples.
 */
export function medianCut(samples: SampleSet, k: number): Float64Array {
  const order = new Int32Array(samples.count);
  for (let i = 0; i < samples.count; i++) order[i] = i;

  let boxes: Box[] = [measureBox(samples.lab, order, 0, samples.count)];

  while (boxes.length < k) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.end - box.start < 2) continue;
      if (box.spread > best) {
        best = box.spread;
        pick = i;
      }
    }
    if (pick < 0) break;

    const box = boxes[pick]!;
    const slice = Array.from(order.subarray(box.start, box.end));
    slice.sort((a, b) => samples.lab[a * 3 + box.axis]! - samples.lab[b * 3 + box.axis]!);
    order.set(slice, box.start);
    const mid = box.start + Math.floor((box.end - box.start) / 2);

    boxes = boxes.filter((_, i) => i !== pick);
    boxes.push(measureBox(samples.lab, order, box.start, mid));
    boxes.push(measureBox(samples.lab, order, mid, box.end));
  }

  const centers = new Float64Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let l = 0;
    let a = 0;
    let b = 0;
    const n = box.end - box.start;
    for (let j = box.start; j < box.end; j++) {
      const at = order[j]! * 3;
      l += samples.lab[at]!;
      a += samples.lab[at + 1]!;
      b += samples.lab[at + 2]!;
    }
    centers[i * 3] = l / n;
    centers[i * 3 + 1] = a / n;
    centers[i * 3 + 2] = b / n;
  });
  return centers;
}

/* ------------------------------------------------------------------ */
/* k-means refine                                                      */
/* ------------------------------------------------------------------ */

/** How many refinement passes run. Movement is negligible past this. */
export const REFINE_PASSES = 12;

export interface Clustering {
  /** Final centers, OKLab, three floats each. */
  centers: Float64Array;
  /** Pixels assigned to each center. */
  counts: Int32Array;
  /** Mean sRGB of each cluster's actual pixels, three bytes each. */
  means: Uint8Array;
}

/**
 * Lloyd's algorithm from the median cut seeds. It stops early once no pixel
 * changes cluster, which on a flat graphic is usually after two passes.
 *
 * The reported color is the mean of a cluster's real pixels in sRGB, not the
 * OKLab center converted back. On a photo the two are within a byte of each
 * other, and the mean is guaranteed to be a color the picture could plausibly
 * contain rather than the midpoint of a curved slice of the gamut.
 */
export function refine(samples: SampleSet, seeds: Float64Array): Clustering {
  const k = seeds.length / 3;
  const centers = Float64Array.from(seeds);
  const assign = new Int32Array(samples.count).fill(-1);
  const counts = new Int32Array(k);
  const sums = new Float64Array(k * 3);
  const rgbSums = new Float64Array(k * 3);

  for (let pass = 0; pass < REFINE_PASSES; pass++) {
    counts.fill(0);
    sums.fill(0);
    rgbSums.fill(0);
    let moved = 0;

    for (let i = 0; i < samples.count; i++) {
      const at = i * 3;
      const l = samples.lab[at]!;
      const a = samples.lab[at + 1]!;
      const b = samples.lab[at + 2]!;
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const ct = c * 3;
        const dl = l - centers[ct]!;
        const da = a - centers[ct + 1]!;
        const db = b - centers[ct + 2]!;
        const d = dl * dl + da * da + db * db;
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = c;
        }
      }
      if (assign[i] !== bestIndex) {
        assign[i] = bestIndex;
        moved++;
      }
      const ct = bestIndex * 3;
      counts[bestIndex]!++;
      sums[ct] += l;
      sums[ct + 1] += a;
      sums[ct + 2] += b;
      rgbSums[ct] += samples.rgb[at]!;
      rgbSums[ct + 1] += samples.rgb[at + 1]!;
      rgbSums[ct + 2] += samples.rgb[at + 2]!;
    }

    for (let c = 0; c < k; c++) {
      const n = counts[c]!;
      if (n === 0) continue;
      const ct = c * 3;
      centers[ct] = sums[ct]! / n;
      centers[ct + 1] = sums[ct + 1]! / n;
      centers[ct + 2] = sums[ct + 2]! / n;
    }

    if (moved === 0) break;
  }

  const means = new Uint8Array(k * 3);
  for (let c = 0; c < k; c++) {
    const n = counts[c]!;
    const ct = c * 3;
    if (n === 0) {
      // An emptied cluster still needs a color, so fall back to its center.
      const back = oklabToSrgb([centers[ct]!, centers[ct + 1]!, centers[ct + 2]!]);
      means[ct] = Math.round(clamp(back[0], 0, 1) * 255);
      means[ct + 1] = Math.round(clamp(back[1], 0, 1) * 255);
      means[ct + 2] = Math.round(clamp(back[2], 0, 1) * 255);
      continue;
    }
    means[ct] = Math.round(rgbSums[ct]! / n);
    means[ct + 1] = Math.round(rgbSums[ct + 1]! / n);
    means[ct + 2] = Math.round(rgbSums[ct + 2]! / n);
  }

  return { centers, counts, means };
}

/* ------------------------------------------------------------------ */
/* the palette                                                         */
/* ------------------------------------------------------------------ */

function readColorCount(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : 6;
  if (!Number.isFinite(n)) return 6;
  return Math.round(clamp(n, 2, 16));
}

/** Extract a palette. Deterministic: the same pixels always give the same colors. */
export function extractPalette(image: ImageLike, opts: PaletteOpts = {}): PaletteResult {
  const k = readColorCount(opts.colors);
  const samples = samplePixels(image, opts.ignoreTransparent !== false);
  const clustering = refine(samples, medianCut(samples, k));

  const swatches: Swatch[] = [];
  for (let c = 0; c < clustering.counts.length; c++) {
    const count = clustering.counts[c]!;
    // A cluster nothing landed in is not a color the picture contains.
    if (count === 0) continue;
    const ct = c * 3;
    swatches.push(
      makeSwatch(
        [clustering.means[ct]!, clustering.means[ct + 1]!, clustering.means[ct + 2]!],
        count,
        samples.count,
      ),
    );
  }

  swatches.sort((a, b) => b.count - a.count);
  const dominant = swatches[0]!;

  const sort = typeof opts.sort === "string" ? opts.sort : "share";
  if (sort === "lightness") {
    swatches.sort((a, b) => relativeLuminance(unit(b)) - relativeLuminance(unit(a)));
  } else if (sort === "hue") {
    swatches.sort((a, b) => srgbToHsl(unit(a))[0] - srgbToHsl(unit(b))[0]);
  }

  return {
    swatches,
    dominant,
    sampled: samples.count,
    total: samples.total,
    skippedTransparent: samples.skippedTransparent,
  };
}

function unit(swatch: Swatch): Vec3 {
  return [swatch.channels[0] / 255, swatch.channels[1] / 255, swatch.channels[2] / 255];
}

/* ------------------------------------------------------------------ */
/* exports                                                             */
/* ------------------------------------------------------------------ */

function safePrefix(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const cleaned = text.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "color";
}

/** CSS custom properties, one per swatch, ready to paste into `:root`. */
export function cssVariables(swatches: readonly Swatch[], prefix: unknown = "color"): string {
  const name = safePrefix(prefix);
  const lines = swatches.map((s, i) => `  --${name}-${(i + 1) * 100}: ${s.hex};`);
  return `:root {\n${lines.join("\n")}\n}`;
}

/** A Tailwind theme block, in the CSS first form Tailwind 4 uses. */
export function tailwindConfig(swatches: readonly Swatch[], prefix: unknown = "color"): string {
  const name = safePrefix(prefix);
  const lines = swatches.map((s, i) => `  --color-${name}-${(i + 1) * 100}: ${s.hex};`);
  return `@theme {\n${lines.join("\n")}\n}`;
}

/** The palette as JSON, with every syntax and the share of the picture. */
export function paletteJson(result: PaletteResult): string {
  return JSON.stringify(
    {
      dominant: result.dominant.hex,
      sampledPixels: result.sampled,
      colors: result.swatches.map((s) => ({
        hex: s.hex,
        rgb: s.rgb,
        hsl: s.hsl,
        oklch: s.oklch,
        share: Number(s.share.toFixed(4)),
        textColor: s.textColor,
      })),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function usePanel(reason: string): ToolError {
  return new ToolError(
    "needs-panel",
    `A palette is pulled from pixels, and ${reason}`,
    'Drop an image onto the panel above. The text surface takes a pixel payload: {"width":4,"height":4,"rgbaBase64":"..."}.',
  );
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B64.indexOf(clean[i]!);
    if (value < 0) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Text surface for the tool.
 *
 * The picture itself is decoded by the panel, because decoding a PNG needs a
 * canvas and this layer stays pure. What `run` accepts is the same small pixel
 * payload the other image tools use, which is what makes the whole pipeline
 * runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 4, "height": 4, "rgbaBase64": "<base64 RGBA>" }
 * ```
 */
export function run(input: Uint8Array | string, opts: PaletteOpts = {}): Record<string, string> {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
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

  const result = extractPalette({ width, height, data: bytes }, opts);
  const out: Record<string, string> = {
    "Dominant color": `${result.dominant.hex} (${Math.round(result.dominant.share * 100)}% of the sampled pixels)`,
    "Colors found": String(result.swatches.length),
    "Pixels sampled": `${result.sampled.toLocaleString("en-US")} of ${result.total.toLocaleString("en-US")}`,
  };
  if (result.skippedTransparent > 0) {
    out["Transparent pixels skipped"] = result.skippedTransparent.toLocaleString("en-US");
  }
  result.swatches.forEach((s, i) => {
    out[`Color ${i + 1}`] = `${s.hex} ${s.rgb} ${s.oklch}, ${Math.round(s.share * 100)}%`;
  });
  out["CSS custom properties"] = cssVariables(result.swatches, opts.cssPrefix);
  out["Tailwind theme"] = tailwindConfig(result.swatches, opts.cssPrefix);
  out["JSON"] = paletteJson(result);
  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  PaletteOpts
>;
