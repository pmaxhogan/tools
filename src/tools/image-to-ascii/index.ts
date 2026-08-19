import { ToolError, type ToolLogic } from "../types";

/**
 * Image to ASCII / ANSI art: turns raw RGBA pixels into text art.
 *
 * Decoding a PNG or a JPEG needs a canvas, so the panel does that part and
 * hands this module the raw pixels it read back (see `run` below for the
 * exact payload shape). Everything past that point is pure arithmetic on a
 * pixel buffer, so it stays testable in Node.
 *
 * ## Luma
 *
 * Brightness per cell uses Rec. 601 luma computed directly on the gamma
 * encoded (sRGB) bytes: `0.299R + 0.587G + 0.114B`. This is deliberately not
 * linearized. Photometric correctness (as used by the dithering tool) matters
 * when the goal is preserving how much light a region emits; ASCII art is a
 * stylised line drawing, and the perceptual, gamma encoded weighting is what
 * every well known ASCII art renderer already uses, so output here matches
 * what people expect from the genre.
 *
 * ## Charset ramp and invert
 *
 * A charset is a string ordered from least visually dense (index 0, usually
 * a space) to most dense (the last character). With `invert` off, brighter
 * cells get denser characters: on the terminal's usual light-on-dark scheme
 * this reads as a bright subject "glowing" with more ink, matching how a
 * photo negative of light and dark would look in text. Turning `invert` on
 * flips the mapping for use against a light background (a printed page, a
 * light mode `<pre>` block), where a dark subject should carry the ink.
 *
 * ## Color
 *
 * `color: "none"` renders bare characters. The other modes wrap each cell's
 * character in the color of that cell's averaged pixel: `ansi16` and
 * `ansi256` use the closest color in a fixed palette, `truecolor` uses the
 * literal 24 bit RGB, and `html` wraps runs of same colored characters in
 * `<span style="color:#rrggbb">`. All four run length compress: a color
 * escape (or span) is only emitted when the color actually changes from the
 * previous cell, so a flat region of the image costs one escape code, not
 * one per cell.
 *
 * ## Braille
 *
 * `toBraille` packs a 2 (wide) by 4 (tall) block of dots into one Unicode
 * braille character (U+2800 to U+28FF), which gives roughly 8x the spatial
 * resolution of a plain ASCII cell for the same number of terminal columns.
 * A pixel becomes a dot when it is at or below `threshold`, so dark subject
 * matter against a light background turns into visible dots, like a pen and
 * ink line drawing. `dither: true` runs Floyd Steinberg error diffusion over
 * the full dot resolution grayscale grid before thresholding, which spreads
 * quantization error into neighbouring dots and reproduces soft gradients
 * far better than a hard cutoff.
 *
 * ## Alpha
 *
 * Semi transparent pixels are composited onto white before luma or color is
 * computed, since text art has no way to express partial coverage.
 */

/* ------------------------------------------------------------------ *
 * charsets
 * ------------------------------------------------------------------ */

/** Built in charset ramps, ordered from least dense (space) to most dense. */
export const CHARSETS: Readonly<Record<string, string>> = {
  standard: " .:-=+*#%@",
  blocks: " ░▒▓█",
  simple: " .oO@",
};

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

export type AsciiCharset = "standard" | "blocks" | "simple" | "custom";
export type AsciiColorMode = "none" | "ansi16" | "ansi256" | "truecolor" | "html";

export interface AsciiOptions {
  /** Character columns in the output. 20 to 200, default 80. */
  columns?: number;
  /** Ramp used to map luma to a character. Default "standard". */
  charset?: AsciiCharset;
  /** Ramp string used when charset is "custom", least dense first. */
  customChars?: string;
  /** Flip which end of the ramp bright pixels map to. Default false. */
  invert?: boolean;
  /** Character cell height / width ratio, used to pick the row count. Default 0.5. */
  aspect?: number;
  /** How to color the characters. Default "none". */
  color?: AsciiColorMode;
}

export interface BrailleOptions {
  /** Braille character columns in the output. 20 to 200, default 80. */
  columns?: number;
  /** Luma at or below this becomes a dot, 0 to 255. Default 128. */
  threshold?: number;
  /** Floyd Steinberg dither the dot grid before thresholding. Default false. */
  dither?: boolean;
}

export interface ImageToAsciiOpts {
  /** "ascii" (default) or "braille". */
  style?: string;
  columns?: number;
  charset?: string;
  customChars?: string;
  invert?: boolean;
  aspect?: number;
  color?: string;
  threshold?: number;
  brailleDither?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * validation helpers
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

function assertResize(newW: number, newH: number): void {
  if (!Number.isInteger(newW) || !Number.isInteger(newH) || newW < 1 || newH < 1) {
    throw new ToolError(
      "invalid-size",
      `A target size of ${newW} by ${newH} is not usable.`,
      "Use positive whole numbers for the new width and height.",
    );
  }
}

function clampColumns(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 20 || n > 200) {
    throw new ToolError(
      "invalid-columns",
      `A column count of ${String(value)} is not usable.`,
      "Use a whole number from 20 to 200.",
    );
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * color space
 * ------------------------------------------------------------------ */

/** Rec. 601 luma on gamma encoded (sRGB) bytes. See module docs for why. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/* ------------------------------------------------------------------ *
 * resampling
 * ------------------------------------------------------------------ */

/**
 * Area averaged (box filter) resampling. Every destination pixel is the mean
 * of the source rectangle it covers, weighted by how much of each source
 * pixel falls inside it. This is what gives a shrunk image clean, unbiased
 * cells instead of the aliasing a nearest neighbour pick would leave behind.
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
 * ansi color quantization
 * ------------------------------------------------------------------ */

/** The 16 standard ANSI colors, indices 0-7 normal, 8-15 bright. */
const ANSI16_COLORS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** Nearest of the 16 standard ANSI colors, by squared Euclidean distance. */
export function ansi16Index(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ANSI16_COLORS.length; i += 1) {
    const c = ANSI16_COLORS[i]!;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** SGR foreground code for an `ansi16Index` result: 30-37 or 90-97. */
function ansi16Code(index: number): number {
  return index < 8 ? 30 + index : 90 + (index - 8);
}

/**
 * Index into the standard 256 color palette's 6x6x6 color cube (16-231),
 * by quantizing each channel to one of 6 evenly spaced levels.
 */
export function ansi256Index(r: number, g: number, b: number): number {
  const level = (c: number): number => Math.round((Math.min(255, Math.max(0, c)) / 255) * 5);
  const rl = level(r);
  const gl = level(g);
  const bl = level(b);
  return 16 + 36 * rl + 6 * gl + bl;
}

/* ------------------------------------------------------------------ *
 * ascii art
 * ------------------------------------------------------------------ */

function resolveCharset(charset: string, customChars: string): string {
  if (charset === "custom") {
    if (customChars.length < 2) {
      throw new ToolError(
        "invalid-charset",
        `A custom charset needs at least 2 characters; ${customChars.length} was given.`,
        'Provide a ramp of 2 or more characters from least to most visually dense, for example " .:-=+*#%@".',
      );
    }
    return customChars;
  }
  const ramp = CHARSETS[charset];
  if (!ramp) {
    throw new ToolError(
      "invalid-charset",
      `"${charset}" is not a charset.`,
      `Choose one of: ${Object.keys(CHARSETS).join(", ")}, custom.`,
    );
  }
  return ramp;
}

function byteHex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorKey(mode: AsciiColorMode, r: number, g: number, b: number): string {
  if (mode === "ansi16") return String(ansi16Index(r, g, b));
  if (mode === "ansi256") return String(ansi256Index(r, g, b));
  return `${Math.round(r)},${Math.round(g)},${Math.round(b)}`;
}

function ansiEscape(mode: "ansi16" | "ansi256" | "truecolor", r: number, g: number, b: number): string {
  if (mode === "ansi16") return `\x1b[${ansi16Code(ansi16Index(r, g, b))}m`;
  if (mode === "ansi256") return `\x1b[38;5;${ansi256Index(r, g, b)}m`;
  return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
}

function renderPlain(chars: string[], columns: number, rows: number): string {
  const lines: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    lines.push(chars.slice(y * columns, y * columns + columns).join(""));
  }
  return lines.join("\n");
}

function renderAnsi(
  chars: string[],
  colors: (readonly [number, number, number])[],
  columns: number,
  rows: number,
  mode: "ansi16" | "ansi256" | "truecolor",
): string {
  let out = "";
  let lastKey: string | null = null;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const i = y * columns + x;
      const [r, g, b] = colors[i]!;
      const key = colorKey(mode, r, g, b);
      if (key !== lastKey) {
        out += ansiEscape(mode, r, g, b);
        lastKey = key;
      }
      out += chars[i];
    }
    if (y < rows - 1) out += "\n";
  }
  out += "\x1b[0m";
  return out;
}

function renderHtml(
  chars: string[],
  colors: (readonly [number, number, number])[],
  columns: number,
  rows: number,
): string {
  let body = "";
  let lastKey: string | null = null;
  let open = false;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const i = y * columns + x;
      const [r, g, b] = colors[i]!;
      const key = colorKey("truecolor", r, g, b);
      if (key !== lastKey) {
        if (open) body += "</span>";
        body += `<span style="color:${rgbToHex(r, g, b)}">`;
        open = true;
        lastKey = key;
      }
      body += escapeHtml(chars[i]!);
    }
    if (y < rows - 1) body += "\n";
  }
  if (open) body += "</span>";
  return `<pre>${body}</pre>`;
}

/**
 * Renders an RGBA buffer as ASCII (or ANSI, or HTML) text art. See the
 * module docs for the luma formula, the ramp direction, and how color runs
 * are compressed.
 */
export function toAscii(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: AsciiOptions = {},
): string {
  assertBuffer(rgba, width, height);

  const columns = clampColumns(opts.columns ?? 80);

  const aspect = opts.aspect ?? 0.5;
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect > 2) {
    throw new ToolError(
      "invalid-aspect",
      `An aspect ratio of ${String(opts.aspect)} is not usable.`,
      "Use a number greater than 0, typically between 0.2 and 1. A common terminal font is about 0.5.",
    );
  }
  const rows = Math.max(1, Math.round((columns * height * aspect) / width));

  const ramp = resolveCharset(opts.charset ?? "standard", opts.customChars ?? "");
  const invert = opts.invert === true;
  const color: AsciiColorMode = opts.color ?? "none";

  const small = resizeBox(rgba, width, height, columns, rows);

  const chars: string[] = new Array(columns * rows);
  const colors: (readonly [number, number, number])[] = new Array(columns * rows);

  for (let i = 0; i < columns * rows; i += 1) {
    const p = i * 4;
    const alpha = small[p + 3]! / 255;
    const r = small[p]! * alpha + 255 * (1 - alpha);
    const g = small[p + 1]! * alpha + 255 * (1 - alpha);
    const b = small[p + 2]! * alpha + 255 * (1 - alpha);

    let t = luma(r, g, b) / 255;
    if (invert) t = 1 - t;
    const idx = Math.round(t * (ramp.length - 1));

    chars[i] = ramp[idx]!;
    colors[i] = [r, g, b];
  }

  if (color === "none") return renderPlain(chars, columns, rows);
  if (color === "html") return renderHtml(chars, colors, columns, rows);
  return renderAnsi(chars, colors, columns, rows, color);
}

/* ------------------------------------------------------------------ *
 * braille art
 * ------------------------------------------------------------------ */

/** Bit for each dot in a braille cell, indexed [row 0-3][col 0-1]. */
const DOT_BITS: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/**
 * Renders an RGBA buffer as Unicode braille dot art (U+2800 to U+28FF). Each
 * character packs a 2 wide by 4 tall block of dots, so this carries roughly
 * 8x the detail of `toAscii` for the same number of terminal columns. See
 * the module docs for the threshold and dither behaviour.
 */
export function toBraille(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: BrailleOptions = {},
): string {
  assertBuffer(rgba, width, height);

  const columns = clampColumns(opts.columns ?? 80);

  const threshold = opts.threshold ?? 128;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new ToolError(
      "invalid-threshold",
      `A threshold of ${String(opts.threshold)} is outside the 0 to 255 range.`,
      "Use a whole number from 0 (almost nothing becomes a dot) to 255 (almost everything does). The default is 128.",
    );
  }
  const useDither = opts.dither === true;

  const rows = Math.max(1, Math.round((columns * height * 0.5) / width));
  const dotW = columns * 2;
  const dotH = rows * 4;

  const small = resizeBox(rgba, width, height, dotW, dotH);

  const gray = new Float64Array(dotW * dotH);
  for (let i = 0; i < dotW * dotH; i += 1) {
    const p = i * 4;
    const alpha = small[p + 3]! / 255;
    const r = small[p]! * alpha + 255 * (1 - alpha);
    const g = small[p + 1]! * alpha + 255 * (1 - alpha);
    const b = small[p + 2]! * alpha + 255 * (1 - alpha);
    gray[i] = luma(r, g, b);
  }

  if (useDither) {
    for (let y = 0; y < dotH; y += 1) {
      for (let x = 0; x < dotW; x += 1) {
        const i = y * dotW + x;
        const old = gray[i]!;
        const quantized = old <= threshold ? 0 : 255;
        const err = old - quantized;
        gray[i] = quantized;
        if (x + 1 < dotW) gray[i + 1] += err * (7 / 16);
        if (x - 1 >= 0 && y + 1 < dotH) gray[i - 1 + dotW] += err * (3 / 16);
        if (y + 1 < dotH) gray[i + dotW] += err * (5 / 16);
        if (x + 1 < dotW && y + 1 < dotH) gray[i + 1 + dotW] += err * (1 / 16);
      }
    }
  }

  const lines: string[] = [];
  for (let cy = 0; cy < rows; cy += 1) {
    let line = "";
    for (let cx = 0; cx < columns; cx += 1) {
      let bits = 0;
      for (let ry = 0; ry < 4; ry += 1) {
        for (let rx = 0; rx < 2; rx += 1) {
          const px = cx * 2 + rx;
          const py = cy * 4 + ry;
          const v = gray[py * dotW + px]!;
          const on = useDither ? v === 0 : v <= threshold;
          if (on) bits |= DOT_BITS[ry]![rx]!;
        }
      }
      line += String.fromCodePoint(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const USE_PANEL_FIX =
  "Drop or pick an image in the panel above. To call this tool directly, send " +
  '{"width":4,"height":4,"rgbaBase64":"..."} with four bytes per pixel in red, green, blue, alpha order.';

function usePanel(detail: string): ToolError {
  return new ToolError("use-panel", `This tool works on pixels; ${detail}`, USE_PANEL_FIX);
}

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

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const CHARSET_IDS = new Set(["standard", "blocks", "simple", "custom"]);
const COLOR_MODE_IDS = new Set(["none", "ansi16", "ansi256", "truecolor", "html"]);

/**
 * Text surface for the tool.
 *
 * A picture goes in and text comes out, but the generic shell only speaks
 * text, so decoding the image happens in the panel. What `run` accepts is a
 * small JSON payload of raw pixels, which is what makes the pipeline
 * runnable from a test and from the pipeline builder:
 *
 * ```json
 * { "width": 4, "height": 4, "rgbaBase64": "<base64 RGBA>" }
 * ```
 */
export function run(input: Uint8Array | string, opts: ImageToAsciiOpts = {}): string {
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

  const style = String(opts.style ?? "ascii");
  if (style !== "ascii" && style !== "braille") {
    throw new ToolError("invalid-style", `"${style}" is not a style.`, "Choose ascii or braille.");
  }

  const columns = opts.columns ?? 80;

  if (style === "braille") {
    const threshold = opts.threshold ?? 128;
    return toBraille(bytes, width, height, {
      columns,
      threshold,
      dither: opts.brailleDither === true,
    });
  }

  const charset = String(opts.charset ?? "standard");
  if (!CHARSET_IDS.has(charset)) {
    throw new ToolError(
      "invalid-charset",
      `"${charset}" is not a charset.`,
      `Choose one of: ${[...CHARSET_IDS].join(", ")}.`,
    );
  }
  const color = String(opts.color ?? "none");
  if (!COLOR_MODE_IDS.has(color)) {
    throw new ToolError(
      "invalid-color",
      `"${color}" is not a color mode.`,
      `Choose one of: ${[...COLOR_MODE_IDS].join(", ")}.`,
    );
  }

  return toAscii(bytes, width, height, {
    columns,
    charset: charset as AsciiCharset,
    customChars: String(opts.customChars ?? ""),
    invert: opts.invert === true,
    aspect: opts.aspect ?? 0.5,
    color: color as AsciiColorMode,
  });
}

export default { run } satisfies ToolLogic<Uint8Array | string, string, ImageToAsciiOpts>;
