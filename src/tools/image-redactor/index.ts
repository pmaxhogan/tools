import { formatBytes as formatByteSize } from "@/lib/format";
import { ToolError, type ToolLogic } from "../types";

/**
 * Redaction that destroys pixels instead of covering them.
 *
 * The pixel operations live here, away from the canvas, so they can be tested
 * in Node against plain RGBA arrays. The panel decodes an image once, keeps
 * the pristine ImageData, and replays the region list through these functions
 * on every redraw. Nothing in this module touches the DOM.
 *
 * There is deliberately no blur operation. A blur is a reversible transform in
 * the information sense: enough of the original signal survives that text can
 * often be recovered. Solid fill is the only operation here that provably
 * removes the underlying values, and it is the default everywhere.
 */

/** A rectangle in image pixel space. Integer coordinates, top left origin. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pointer drag in image pixel space, in the order the user drew it. */
export interface Drag {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A single point in image pixel space. Where the user tapped. */
export interface Point {
  x: number;
  y: number;
}

/** Red, green, blue. Alpha is always forced opaque by a redaction. */
export type Rgb = [number, number, number];

export type RedactMode = "solid" | "pixelate";

export interface RedactorOpts {
  /** Redaction style used when a region is drawn. Solid destroys, pixelate averages. */
  mode?: RedactMode;
  /** Fill color for solid regions. Only black and white are offered. */
  color?: "black" | "white";
  /** Pixelate block edge in pixels. Larger blocks discard more detail. */
  blockSize?: number;
  /**
   * Pixelate randomness strength, 0 to 100. Moderate by default so pixelate
   * is never a plain, fully deterministic block average.
   */
  randomness?: number;
  /** Seed for the pixelate perturbation PRNG. The panel generates a fresh one per region. */
  seed?: number;
  /** Export container. Both re-encode from the canvas, so neither keeps metadata. */
  format?: "png" | "jpeg";
  [key: string]: unknown;
}

export type RedactorResult = Record<string, string>;

export const SOLID_COLORS: Record<"black" | "white", Rgb> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
};

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

function toInt(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * Clamp a rectangle to the image, returning null when nothing of it lands
 * inside. Every pixel operation runs this first, so an out of bounds region is
 * a no-op rather than a buffer overrun.
 */
export function clampRect(rect: Rect, width: number, height: number): Rect | null {
  if (width <= 0 || height <= 0) return null;
  const x1 = Math.max(0, Math.min(width, toInt(rect.x)));
  const y1 = Math.max(0, Math.min(height, toInt(rect.y)));
  const x2 = Math.max(0, Math.min(width, toInt(rect.x) + toInt(rect.w)));
  const y2 = Math.max(0, Math.min(height, toInt(rect.y) + toInt(rect.h)));
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (w <= 0 || h <= 0) return null;
  return { x: left, y: top, w, h };
}

/**
 * Turn a raw drag into a sorted, integer rectangle. Dragging up and to the
 * left produces negative width and height on the way in; callers should never
 * have to care which corner the user started from. Passing the image size
 * clamps the result so the rectangle can never leave the canvas.
 */
export function normalizeRect(drag: Drag, width?: number, height?: number): Rect {
  const x1 = toInt(drag.x1);
  const y1 = toInt(drag.y1);
  const x2 = toInt(drag.x2);
  const y2 = toInt(drag.y2);

  let left = Math.min(x1, x2);
  let top = Math.min(y1, y2);
  let right = Math.max(x1, x2);
  let bottom = Math.max(y1, y2);

  if (typeof width === "number" && Number.isFinite(width)) {
    const max = Math.max(0, Math.round(width));
    left = Math.max(0, Math.min(max, left));
    right = Math.max(0, Math.min(max, right));
  }
  if (typeof height === "number" && Number.isFinite(height)) {
    const max = Math.max(0, Math.round(height));
    top = Math.max(0, Math.min(max, top));
    bottom = Math.max(0, Math.min(max, bottom));
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/* ------------------------------------------------------------------ */
/* smart tap selection                                                 */
/* ------------------------------------------------------------------ */

/**
 * The minimum an image needs to expose for the blob selector: a flat RGBA
 * buffer and its dimensions. `ImageData` satisfies this directly, so the panel
 * hands its pristine pixels straight in, and a test can build a tiny literal.
 */
export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

/**
 * The "blob under the tap" selector for anything that is not text.
 *
 * Starting from the tapped pixel, this grows a 4-connected region of pixels
 * whose color is within `threshold` of the tapped pixel's color, then returns
 * the bounding rectangle of that region. Similarity is the sum of the absolute
 * per channel differences across red, green, blue, and alpha, so a flat colored
 * chip, badge, or panel is selected whole while a differently colored
 * background stops the fill at its edge.
 *
 * It is deterministic: the same image, point, and threshold always return the
 * same rectangle. Returns null when the point falls outside the image, so the
 * caller can treat an off image tap as a no-op.
 *
 * @param threshold color tolerance, 0 selects only exactly matching pixels.
 */
export function floodFillBounds(image: ImageLike, point: Point, threshold: number): Rect | null {
  const width = Math.max(0, Math.trunc(image.width));
  const height = Math.max(0, Math.trunc(image.height));
  if (width <= 0 || height <= 0) return null;

  const startX = toInt(point.x);
  const startY = toInt(point.y);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return null;

  const data = image.data;
  const tol = Math.max(0, Number.isFinite(threshold) ? threshold : 0);

  const at = (x: number, y: number): number => (y * width + x) * 4;
  const seed = at(startX, startY);
  const sr = data[seed] ?? 0;
  const sg = data[seed + 1] ?? 0;
  const sb = data[seed + 2] ?? 0;
  const sa = data[seed + 3] ?? 0;

  const similar = (i: number): boolean =>
    Math.abs((data[i] ?? 0) - sr) +
      Math.abs((data[i + 1] ?? 0) - sg) +
      Math.abs((data[i + 2] ?? 0) - sb) +
      Math.abs((data[i + 3] ?? 0) - sa) <=
    tol;

  const visited = new Uint8Array(width * height);
  const stack: number[] = [startX, startY];
  visited[startY * width + startX] = 1;

  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    // 4-connected neighbors.
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx! < 0 || ny! < 0 || nx! >= width || ny! >= height) continue;
      const flat = ny! * width + nx!;
      if (visited[flat]) continue;
      if (!similar(at(nx!, ny!))) continue;
      visited[flat] = 1;
      stack.push(nx!, ny!);
    }
  }

  // Pixel coordinates are inclusive, so a single pixel is width and height 1.
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * One OCR word paired with the line it sits on. The panel builds these from a
 * recognition result; `boxAtPoint` reads them. Keeping both rectangles means a
 * single tap can redact either the tapped word or its whole line without
 * re-deriving anything.
 */
export interface TextBox {
  /** The tight rectangle around the single word. */
  word: Rect;
  /** The rectangle around the line the word belongs to. */
  line: Rect;
}

/** The subset of a tesseract page this module reads to build TextBoxes. */
interface OcrTapBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrTapWord {
  bbox?: OcrTapBbox;
}
interface OcrTapLine {
  bbox?: OcrTapBbox;
  words?: (OcrTapWord | null | undefined)[];
}
interface OcrTapParagraph {
  lines?: (OcrTapLine | null | undefined)[];
}
interface OcrTapBlock {
  paragraphs?: (OcrTapParagraph | null | undefined)[];
}
export interface OcrTapPage {
  blocks?: (OcrTapBlock | null | undefined)[] | null;
}

function bboxToRect(bbox: OcrTapBbox | undefined): Rect | null {
  if (!bbox) return null;
  const x = toInt(bbox.x0);
  const y = toInt(bbox.y0);
  const w = toInt(bbox.x1) - x;
  const h = toInt(bbox.y1) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Flatten a recognition result into a flat list of word boxes, each carrying
 * the rectangle of its own line. Words or lines with a degenerate box are
 * skipped so the tap picker never has to consider a zero size rectangle. This
 * redeclares the page shape rather than importing the OCR tool, so the
 * redaction tool stays independently deletable (rule 13).
 */
export function collectTextBoxes(page: OcrTapPage | null | undefined): TextBox[] {
  const boxes: TextBox[] = [];
  for (const block of page?.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const lineRect = bboxToRect(line?.bbox);
        if (!lineRect) continue;
        for (const word of line?.words ?? []) {
          const wordRect = bboxToRect(word?.bbox);
          if (!wordRect) continue;
          boxes.push({ word: wordRect, line: lineRect });
        }
      }
    }
  }
  return boxes;
}

/** How far a point sits from a rectangle, zero when the point is inside it. */
function pointRectDistance(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/** How a tap resolves to a rectangle: the single word or its whole line. */
export type TapTarget = "word" | "line";

/**
 * The text selector for a tap. Given the word boxes from OCR and a point, it
 * returns the rectangle a tap should redact: the word (or its line, per mode)
 * that contains the point, or failing that the nearest one within
 * `maxDistance`. A box that contains the point scores distance zero, so it
 * always wins over a merely nearby one.
 *
 * Returns null when there are no boxes, or when the nearest box is further than
 * `maxDistance`, which is the panel's signal to fall back to the blob selector.
 */
export function boxAtPoint(
  boxes: TextBox[],
  point: Point,
  mode: TapTarget = "word",
  maxDistance: number = Number.POSITIVE_INFINITY,
): Rect | null {
  let best: Rect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const box of boxes) {
    const rect = mode === "line" ? box.line : box.word;
    if (!rect) continue;
    const distance = pointRectDistance(point, rect);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rect;
    }
  }

  if (!best || bestDistance > maxDistance) return null;
  return { ...best };
}

/* ------------------------------------------------------------------ */
/* pixel operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Overwrite every pixel in the rectangle with a flat color. This is the real
 * redaction: the original samples are gone from the buffer, not hidden behind
 * a shape that some later step could remove.
 *
 * Alpha is forced to 255 as well. A transparent region that kept alpha 0 would
 * look redacted on a dark page and reveal whatever sat behind it elsewhere.
 *
 * Mutates `data` in place and returns the clamped rectangle it wrote, or null
 * when the rectangle missed the image entirely.
 */
export function applySolidRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: Rect,
  color: Rgb = SOLID_COLORS.black,
): Rect | null {
  const box = clampRect(rect, width, height);
  if (!box) return null;
  const [r, g, b] = color;
  for (let y = box.y; y < box.y + box.h; y++) {
    let i = (y * width + box.x) * 4;
    for (let x = 0; x < box.w; x++) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
      i += 4;
    }
  }
  return box;
}

/**
 * Deterministic PRNG seeded from a single 32 bit integer (mulberry32). This is
 * the only source of randomness allowed in this module: it never touches
 * `Math.random` or any other non-deterministic source, so the same seed
 * always produces the same sequence and a test can assert exact output. A
 * different seed diverges from the first call.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export interface PixelatePerturbation {
  /** Seed for the perturbation PRNG. The same seed and inputs always produce the same output. */
  seed?: number;
  /**
   * How hard to perturb each block's averaged color, from 0 (off, identical to
   * a plain block average) to 1 (heaviest). Values outside 0..1 are clamped.
   */
  strength?: number;
}

/**
 * Replace the rectangle with the average color of each block, then perturb
 * that average with seeded random noise. Blocks are anchored at the
 * rectangle's top left corner and clipped to it, so an edge block never
 * averages pixels the user did not select.
 *
 * The plain block average is a deterministic function of the source pixels:
 * researchers defeat it by rendering candidate text through the same block
 * grid until the averaged output matches. Mixing in noise from a seeded PRNG
 * breaks that, since the output now also depends on a seed that never left
 * this device rather than on the source pixels alone. At strength 0, or with
 * no perturbation passed at all, this is byte identical to a plain average.
 *
 * This is offered because people expect pixelation, not because it is safe.
 * The perturbed average still carries a rough trace of the original
 * brightness, so solid fill remains the only option that leaves nothing to
 * analyze.
 */
export function applyPixelateRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: Rect,
  blockSize: number,
  perturbation: PixelatePerturbation = {},
): Rect | null {
  const box = clampRect(rect, width, height);
  if (!box) return null;
  const size = Math.max(1, Math.round(Number.isFinite(blockSize) ? blockSize : 1));
  const strength = Math.max(
    0,
    Math.min(1, Number.isFinite(perturbation.strength) ? (perturbation.strength as number) : 0),
  );
  const seed = Number.isFinite(perturbation.seed) ? Math.trunc(perturbation.seed as number) : 0;
  const rand = strength > 0 ? mulberry32(seed) : null;
  // Largest per channel offset at strength 1. Tuned so the perturbation is
  // large enough to change which candidate string a block matching attack
  // would settle on, without needing to touch alpha or block boundaries.
  const MAX_DELTA = 90;

  for (let by = box.y; by < box.y + box.h; by += size) {
    const bh = Math.min(size, box.y + box.h - by);
    for (let bx = box.x; bx < box.x + box.w; bx += size) {
      const bw = Math.min(size, box.x + box.w - bx);

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let y = by; y < by + bh; y++) {
        let i = (y * width + bx) * 4;
        for (let x = 0; x < bw; x++) {
          sr += data[i]!;
          sg += data[i + 1]!;
          sb += data[i + 2]!;
          sa += data[i + 3]!;
          i += 4;
        }
      }

      const count = bw * bh;
      let ar = Math.round(sr / count);
      let ag = Math.round(sg / count);
      let ab = Math.round(sb / count);
      const aa = Math.round(sa / count);

      if (rand) {
        const delta = strength * MAX_DELTA;
        ar = clampByte(ar + (rand() * 2 - 1) * delta);
        ag = clampByte(ag + (rand() * 2 - 1) * delta);
        ab = clampByte(ab + (rand() * 2 - 1) * delta);
      }

      for (let y = by; y < by + bh; y++) {
        let i = (y * width + bx) * 4;
        for (let x = 0; x < bw; x++) {
          data[i] = ar;
          data[i + 1] = ag;
          data[i + 2] = ab;
          data[i + 3] = aa;
          i += 4;
        }
      }
    }
  }
  return box;
}

/* ------------------------------------------------------------------ */
/* naming                                                              */
/* ------------------------------------------------------------------ */

const EXPORT_EXTENSIONS: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
};

/**
 * Name the export after the source so a redacted copy is never mistaken for
 * the original: "shot.png" becomes "shot-redacted.png". The suffix is added
 * once, so re-running the tool on its own output does not stack it.
 */
export function suggestExportName(inputName: string, format: string = "png"): string {
  const ext = EXPORT_EXTENSIONS[String(format).toLowerCase()] ?? "png";
  const raw = String(inputName ?? "")
    .split(/[\\/]/)
    .pop();
  const trimmed = (raw ?? "").trim();
  const dot = trimmed.lastIndexOf(".");
  let stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  if (!stem) stem = "image";
  if (!stem.toLowerCase().endsWith("-redacted")) stem += "-redacted";
  return `${stem}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  return formatByteSize(bytes, { maxUnit: "GB" });
}

/** Enough magic bytes to name the container without decoding anything. */
export function sniffImageFormat(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "PNG";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "JPEG";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "GIF";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "WebP";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
  return "unknown";
}

const USAGE =
  "Drop a screenshot on the panel above, then drag a rectangle over anything sensitive. Each rectangle overwrites those pixels immediately. Download when the preview looks right.";

const SAFETY =
  "Solid fill is the default because it replaces the pixels with one flat color and leaves nothing to recover. Pixelate now mixes seeded random noise into each block average, which stops the simplest attack of rendering candidate text through the same grid until it matches. That makes reconstruction much harder, not impossible: the perturbed average still carries a rough trace of the original, so solid fill remains the only option that leaves nothing to analyze.";

const EXPORT_NOTE =
  "The download is re-encoded from the canvas, so it carries none of the original EXIF, XMP, or IPTC metadata and none of the original compressed data.";

/**
 * This tool is panel first: the redaction itself needs a canvas and a pointer,
 * so run() reports what was loaded and how to drive the panel rather than
 * inventing regions nobody drew.
 */
export function run(input: Uint8Array | string, opts: RedactorOpts = {}): RedactorResult {
  const mode: RedactMode = opts.mode === "pixelate" ? "pixelate" : "solid";
  const color = opts.color === "white" ? "white" : "black";
  const blockSize = Math.max(2, Math.round(Number(opts.blockSize ?? 12) || 12));
  const randomness = Math.max(0, Math.min(100, Math.round(Number(opts.randomness ?? 35) || 0)));
  const format = opts.format === "jpeg" ? "jpeg" : "png";

  const rows: RedactorResult = {};

  if (typeof input === "string") {
    rows.Input = input.trim()
      ? "Text was pasted. This tool redacts images, so drop or pick a screenshot instead."
      : "No image loaded yet.";
    rows["How to use"] = USAGE;
    rows["Why solid"] = SAFETY;
    rows.Export = `${EXPORT_NOTE} The file will be named ${suggestExportName("screenshot.png", format)}.`;
    return rows;
  }

  if (input.length === 0) {
    throw new ToolError(
      "empty-file",
      "That file is empty, so there is nothing to redact.",
      "Pick a PNG, JPEG, WebP, GIF, or BMP screenshot and try again.",
    );
  }

  const kind = sniffImageFormat(input);
  rows.Loaded = `${kind} image, ${formatBytes(input.length)}.`;
  rows["How to use"] = USAGE;
  rows.Mode =
    mode === "solid"
      ? `Solid fill, ${color}. Every pixel under the rectangle is replaced.`
      : `Pixelate, ${blockSize} px blocks with ${randomness}% seeded randomness. Averaged and perturbed, not destroyed: solid fill is the safer choice.`;
  rows["Why solid"] = SAFETY;
  rows.Export = `${EXPORT_NOTE} Suggested filename: ${suggestExportName(`screenshot.${kind === "JPEG" ? "jpg" : "png"}`, format)}.`;
  rows.Privacy = "Redaction runs in this tab: your files and inputs never leave your device.";
  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, RedactorResult, RedactorOpts>;
