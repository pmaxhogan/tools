import { ToolError, type ToolLogic } from "../types";

/**
 * Pixel maths for the background remover.
 *
 * The matting model itself runs in the panel, because it needs a canvas to
 * decode and rescale the photo and an ONNX session to run MODNet. What lives
 * here is everything that is pure arithmetic on raw arrays: turning a predicted
 * matte into an alpha channel, softening that alpha, compositing the cutout
 * onto a solid color, and rescaling a matte back to the size of the photo.
 *
 * Every function works on plain typed arrays so it can be tested in Node with
 * hand computed expectations, and so the panel can reuse the exact same code
 * paths it ships to visitors.
 */

export type OutputMode = "transparent" | "white" | "color";

export interface BackgroundRemoverOpts {
  /** What to put behind the cutout: nothing, white, or a color you pick. */
  output: OutputMode;
  /** Hex fill used when `output` is "color". */
  bgColor: string;
  /** Softens the alpha edge with a small blur so the cutout stops looking cut. */
  featherEdges: boolean;
  [key: string]: unknown;
}

export type BackgroundRemoverResult = Record<string, string>;

/** A matte as the model or a canvas hands it over: 0..1 floats or 0..255 bytes. */
export type Matte = Float32Array | Uint8ClampedArray | Uint8Array;

const HEX_FIX =
  "Use a hex color such as #ffffff, #1b1b1b, or the short form #fff. Named colors and rgb() are not accepted.";

/* ------------------------------------------------------------------ *
 * color
 * ------------------------------------------------------------------ */

/**
 * Parses a hex color into 8 bit channels. Accepts `#rgb`, `#rrggbb`, and both
 * of those without the leading hash, in either case.
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const raw = typeof hex === "string" ? hex.trim().replace(/^#/, "") : "";
  if (!/^[0-9a-fA-F]+$/.test(raw) || (raw.length !== 3 && raw.length !== 6)) {
    throw new ToolError("invalid-color", `"${String(hex)}" is not a hex color.`, HEX_FIX);
  }
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/* ------------------------------------------------------------------ *
 * matte handling
 * ------------------------------------------------------------------ */

function assertSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new ToolError(
      "invalid-size",
      `A width and height of ${w} by ${h} is not a usable image size.`,
      "Pass the pixel width and height of the image as positive whole numbers.",
    );
  }
}

/**
 * Rescales a matte to the 0..1 range.
 *
 * The rule is deterministic so the same matte always converts the same way:
 * an integer typed array is always byte scaled and divided by 255, and a
 * Float32Array is treated as 0..1 when nothing in it exceeds 1, otherwise it
 * is treated as byte scaled too. MODNet emits 0..1 floats; a matte read back
 * out of a canvas comes in as 0..255 bytes.
 */
export function normalizeMatte(matte: Matte): Float32Array {
  const out = new Float32Array(matte.length);
  let byteScaled = !(matte instanceof Float32Array);
  if (!byteScaled) {
    for (let i = 0; i < matte.length; i += 1) {
      if (matte[i]! > 1) {
        byteScaled = true;
        break;
      }
    }
  }
  const divisor = byteScaled ? 255 : 1;
  for (let i = 0; i < matte.length; i += 1) {
    const v = matte[i]! / divisor;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/**
 * Writes a matte into the alpha channel of an RGBA buffer, leaving the color
 * channels untouched. The buffer is modified in place and returned so calls
 * can be chained.
 */
export function applyMatte(
  rgba: Uint8ClampedArray,
  matte: Matte,
  w: number,
  h: number,
): Uint8ClampedArray {
  assertSize(w, h);
  if (rgba.length !== w * h * 4) {
    throw new ToolError(
      "size-mismatch",
      `The pixel buffer holds ${rgba.length} bytes, but ${w} by ${h} pixels needs ${w * h * 4}.`,
      "Pass the RGBA data and the dimensions that came from the same canvas.",
    );
  }
  if (matte.length !== w * h) {
    throw new ToolError(
      "size-mismatch",
      `The matte holds ${matte.length} values, but ${w} by ${h} pixels needs ${w * h}.`,
      "Rescale the matte to the size of the image before applying it, for example with resizeMatteNearest.",
    );
  }
  const alpha = normalizeMatte(matte);
  for (let i = 0; i < alpha.length; i += 1) {
    rgba[i * 4 + 3] = Math.round(alpha[i]! * 255);
  }
  return rgba;
}

/**
 * Nearest neighbour rescale of a matte, using centre sampling so the result
 * stays aligned with the image rather than drifting half a pixel.
 *
 * The panel usually rescales the matte through a canvas, which interpolates
 * and gives a smoother edge. This is the fallback for when no canvas context
 * is available, and it is the version the tests pin down.
 */
export function resizeMatteNearest(
  matte: Matte,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): Float32Array {
  assertSize(fromW, fromH);
  assertSize(toW, toH);
  if (matte.length !== fromW * fromH) {
    throw new ToolError(
      "size-mismatch",
      `The matte holds ${matte.length} values, but ${fromW} by ${fromH} needs ${fromW * fromH}.`,
      "Pass the dimensions the matte was produced at.",
    );
  }
  const out = new Float32Array(toW * toH);
  for (let y = 0; y < toH; y += 1) {
    const sy = Math.min(fromH - 1, Math.floor(((y + 0.5) * fromH) / toH));
    for (let x = 0; x < toW; x += 1) {
      const sx = Math.min(fromW - 1, Math.floor(((x + 0.5) * fromW) / toW));
      out[y * toW + x] = matte[sy * fromW + sx]!;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * edge softening
 * ------------------------------------------------------------------ */

/**
 * Separable two pass box blur applied to the alpha channel only.
 *
 * A matting model produces a confident but slightly ragged edge, and a one or
 * two pixel blur on alpha is what stops the cutout reading as a sticker. Edge
 * pixels sample the nearest in bounds value, so a flat region keeps its exact
 * value and a hard edge softens symmetrically. Radius 0 is a no-op. The buffer
 * is modified in place and returned.
 */
export function boxBlurAlpha(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): Uint8ClampedArray {
  assertSize(w, h);
  if (rgba.length !== w * h * 4) {
    throw new ToolError(
      "size-mismatch",
      `The pixel buffer holds ${rgba.length} bytes, but ${w} by ${h} pixels needs ${w * h * 4}.`,
      "Pass the RGBA data and the dimensions that came from the same canvas.",
    );
  }
  if (!Number.isFinite(radius) || radius < 0) {
    throw new ToolError(
      "invalid-radius",
      `A blur radius of ${radius} is not usable.`,
      "Use 0 to leave the edge alone, or a small whole number such as 1 or 2.",
    );
  }
  const r = Math.floor(radius);
  if (r === 0) return rgba;

  const width = 2 * r + 1;
  const source = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) source[i] = rgba[i * 4 + 3]!;

  // Horizontal pass.
  const middle = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) {
        const sx = Math.min(w - 1, Math.max(0, x + k));
        sum += source[row + sx]!;
      }
      middle[row + x] = sum / width;
    }
  }

  // Vertical pass, written straight back into the alpha channel.
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        sum += middle[sy * w + x]!;
      }
      rgba[(y * w + x) * 4 + 3] = Math.round(sum / width);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * compositing
 * ------------------------------------------------------------------ */

/**
 * Alpha composites an RGBA buffer over a solid color and returns a new, fully
 * opaque buffer. Straight (non premultiplied) alpha, so each channel is
 * `src * a + background * (1 - a)`, which is what a canvas would do when it
 * draws the cutout onto a filled rectangle.
 */
export function compositeOnColor(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  hex: string,
): Uint8ClampedArray {
  assertSize(w, h);
  if (rgba.length !== w * h * 4) {
    throw new ToolError(
      "size-mismatch",
      `The pixel buffer holds ${rgba.length} bytes, but ${w} by ${h} pixels needs ${w * h * 4}.`,
      "Pass the RGBA data and the dimensions that came from the same canvas.",
    );
  }
  const { r, g, b } = parseHexColor(hex);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    const a = rgba[o + 3]! / 255;
    const inv = 1 - a;
    out[o] = Math.round(rgba[o]! * a + r * inv);
    out[o + 1] = Math.round(rgba[o + 1]! * a + g * inv);
    out[o + 2] = Math.round(rgba[o + 2]! * a + b * inv);
    out[o + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const OUTPUT_MODES: OutputMode[] = ["transparent", "white", "color"];

function readOutputMode(value: unknown): OutputMode {
  if (value === undefined || value === null || value === "") return "transparent";
  if (typeof value === "string" && (OUTPUT_MODES as string[]).includes(value)) {
    return value as OutputMode;
  }
  throw new ToolError(
    "invalid-output",
    `"${String(value)}" is not a background option.`,
    "Choose one of: transparent, white, color.",
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Text surface for the tool.
 *
 * Cutting a person out of a photo needs a canvas and a neural network session,
 * so the work itself happens in the panel on this page. What `run` does is
 * validate the settings and describe exactly what the panel will do with them,
 * which is also what makes the option values checkable from a test.
 */
export function run(
  input: Uint8Array | string,
  opts: BackgroundRemoverOpts,
): BackgroundRemoverResult {
  const mode = readOutputMode(opts?.output);
  const feather = opts?.featherEdges !== false;
  const bgColor =
    typeof opts?.bgColor === "string" && opts.bgColor !== "" ? opts.bgColor : "#ffffff";

  let background: string;
  if (mode === "transparent") {
    background = "None. The cutout keeps a transparent alpha channel and saves as a PNG.";
  } else if (mode === "white") {
    background = "Solid white, saved as a JPEG.";
  } else {
    const { r, g, b } = parseHexColor(bgColor);
    const normalized = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    background = `Solid ${normalized}, saved as a JPEG.`;
  }

  const rows: BackgroundRemoverResult = {
    Model:
      "MODNet portrait matting, quantized to about 6.3 MB of ONNX weights, served from this site.",
    "Best on": "Photos of people. Products, pets, and busy objects often come out worse.",
    Background: background,
    "Feather edges": feather
      ? "On. A small blur is applied to the alpha edge so the cutout does not read as a sticker."
      : "Off. The alpha edge stays exactly as the model predicted it.",
    "Where it runs":
      "In this browser tab, so your files and inputs never leave your device. The model is downloaded once and then kept in the browser cache.",
    "Next step":
      "Drop a photo into the panel above, press Load model, then press Remove background.",
  };

  if (input instanceof Uint8Array && input.length > 0) {
    rows.Image = `${humanBytes(input.length)} of image data ready for the panel.`;
  } else if (typeof input === "string" && input.trim() !== "") {
    rows.Note =
      "This tool works on image files rather than text. Drop or pick a photo in the panel above.";
  }

  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  BackgroundRemoverResult,
  BackgroundRemoverOpts
>;
