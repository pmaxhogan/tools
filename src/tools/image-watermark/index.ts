import { ToolError, type ToolLogic } from "../types";

/**
 * Image Watermark logic: the layout math, kept away from the canvas.
 *
 * Everything a watermark needs to be decided before a single pixel is drawn is
 * here: how big the text should be for this picture, where the box sits for a
 * given corner, how far in the margin should be, and, for a tiled mark, every
 * center the pattern has to cover so the tiling still reaches the corners after
 * it has been rotated. The panel then does one thing per placement: translate,
 * rotate, draw.
 *
 * Sizes are relative rather than absolute on purpose. A 24 pixel caption is
 * unreadable on a 6000 pixel photo and enormous on a 400 pixel thumbnail, so
 * the font size is a percentage of the image height and the margin is a
 * percentage of the shorter edge. The same settings then look the same across a
 * batch of mixed sizes, which is the only way a batch watermark is useful.
 *
 * Text width is measured by an injected function. The panel passes the canvas
 * measurement, and the tests pass a stub, which is what keeps this layer pure
 * and this math testable without a browser.
 */

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** The nine positions of a 3 by 3 placement grid. */
export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const ANCHORS: readonly Anchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export interface Size {
  width: number;
  height: number;
}

/** Where one copy of the watermark goes, as the center of its box. */
export interface Placement {
  x: number;
  y: number;
}

export interface WatermarkLayout {
  /** Every copy to draw, in reading order. */
  placements: Placement[];
  /** The watermark's own box, before rotation. */
  box: Size;
  /** Margin in pixels, resolved from the percentage. */
  margin: number;
  /** Rotation in degrees, clockwise, applied around each placement. */
  rotation: number;
  /** True when the layout tiles rather than placing one copy. */
  tiled: boolean;
}

/** Measures the width of one line of text at a given size, in pixels. */
export type MeasureText = (text: string, fontSize: number) => number;

export interface TextBox extends Size {
  lines: string[];
  fontSize: number;
  lineHeight: number;
}

export interface WatermarkOpts {
  /** "text" or "image". */
  kind?: "text" | "image";
  text?: string;
  /** Font size as a percentage of the image height. */
  fontPercent?: number;
  /** Logo width as a percentage of the image width. */
  scalePercent?: number;
  /** 0 to 100. */
  opacity?: number;
  color?: string;
  /** Outline color drawn behind the fill. Empty disables the outline. */
  outline?: string;
  rotation?: number;
  mode?: "single" | "tile";
  anchor?: Anchor;
  /** Margin as a percentage of the image's shorter edge. */
  marginPercent?: number;
  /** Gap between tiles as a percentage of the watermark's own size. */
  tileGapPercent?: number;
  /** Export format and quality, used by the panel. */
  format?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* numbers                                                             */
/* ------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function readNumber(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function assertSize(size: Size): void {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new ToolError(
      "bad-size",
      "The image size has to be two positive numbers.",
      'Drop a picture onto the panel above, or write the size as "1920x1080".',
    );
  }
}

/* ------------------------------------------------------------------ */
/* text layout                                                         */
/* ------------------------------------------------------------------ */

/** The line height this tool uses, as a multiple of the font size. */
export const LINE_HEIGHT = 1.25;

/**
 * A rough width measurement for when there is no canvas: 0.55 em per character
 * is close to the average for a condensed sans face. It is only used by the
 * text surface, never by the panel, which measures for real.
 */
export const approximateMeasure: MeasureText = (text, fontSize) => text.length * fontSize * 0.55;

/** Font size in pixels for a percentage of the image height, at least 8px. */
export function fontSizeFor(imageHeight: number, percent: number): number {
  return Math.max(8, Math.round((imageHeight * clamp(percent, 0.5, 40)) / 100));
}

/**
 * Break `text` into lines that fit `maxWidth`, keeping any line break the
 * author typed. A single word longer than the line is left alone rather than
 * split mid word: a watermark is short, and a hyphenated brand name reads worse
 * than one that overhangs slightly.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: MeasureText,
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = words[0]!;
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]!}`;
      if (measure(candidate, fontSize) <= maxWidth) line = candidate;
      else {
        out.push(line);
        line = words[i]!;
      }
    }
    out.push(line);
  }
  return out;
}

/** The box a wrapped watermark caption occupies, before rotation. */
export function textBox(
  text: string,
  image: Size,
  opts: { fontPercent?: number; maxWidthPercent?: number },
  measure: MeasureText,
): TextBox {
  assertSize(image);
  const fontSize = fontSizeFor(image.height, readNumber(opts.fontPercent, 6));
  const maxWidth = (image.width * clamp(readNumber(opts.maxWidthPercent, 80), 10, 100)) / 100;
  const lines = wrapText(text, maxWidth, fontSize, measure);
  const lineHeight = fontSize * LINE_HEIGHT;
  const width = lines.reduce((w, line) => Math.max(w, measure(line, fontSize)), 0);
  return { lines, fontSize, lineHeight, width, height: lineHeight * lines.length };
}

/* ------------------------------------------------------------------ */
/* placement                                                           */
/* ------------------------------------------------------------------ */

/** Margin in pixels from a percentage of the image's shorter edge. */
export function marginFor(image: Size, percent: number): number {
  assertSize(image);
  return Math.round((Math.min(image.width, image.height) * clamp(percent, 0, 25)) / 100);
}

/**
 * The center of the watermark box for one anchor.
 *
 * A box larger than the space left by the margins is centered on that axis
 * rather than pushed off the edge, so an oversized caption stays visible
 * instead of half disappearing at the corner the anchor named.
 */
export function anchorCenter(anchor: Anchor, image: Size, box: Size, margin: number): Placement {
  assertSize(image);
  const axis = (
    imageLength: number,
    boxLength: number,
    side: "start" | "middle" | "end",
  ): number => {
    const half = boxLength / 2;
    if (boxLength + margin * 2 >= imageLength) return imageLength / 2;
    if (side === "start") return margin + half;
    if (side === "end") return imageLength - margin - half;
    return imageLength / 2;
  };

  const [vertical, horizontal] = anchor.split("-") as [string, string];
  const vSide = vertical === "top" ? "start" : vertical === "bottom" ? "end" : "middle";
  const hSide = horizontal === "left" ? "start" : horizontal === "right" ? "end" : "middle";
  return {
    x: axis(image.width, box.width, hSide),
    y: axis(image.height, box.height, vSide),
  };
}

/** The axis aligned bounding box of a rotated rectangle. */
export function rotatedBounds(box: Size, degrees: number): Size {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: box.width * cos + box.height * sin,
    height: box.width * sin + box.height * cos,
  };
}

/** Upper bound on tile placements, so a tiny box on a huge canvas cannot hang. */
export const MAX_TILES = 2000;

/**
 * Every center a tiled watermark needs.
 *
 * The grid is laid out over the rotated bounding box of one tile, not over the
 * tile itself, so the spacing stays even at any angle. It then starts one full
 * step outside the picture on each side: a rotated mark near the edge still has
 * a corner inside the frame, and a grid that starts at the first visible center
 * leaves a bare triangle in every corner.
 */
export function tileCenters(
  image: Size,
  box: Size,
  gapPercent: number,
  rotation: number,
): Placement[] {
  assertSize(image);
  const bounds = rotatedBounds(box, rotation);
  const gap = clamp(readNumber(gapPercent, 40), 0, 400) / 100;
  const stepX = Math.max(8, bounds.width * (1 + gap));
  const stepY = Math.max(8, bounds.height * (1 + gap));

  const columns = Math.ceil(image.width / stepX) + 2;
  const rows = Math.ceil(image.height / stepY) + 2;
  if (columns * rows > MAX_TILES) {
    throw new ToolError(
      "too-many-tiles",
      `Tiling this watermark would need ${(columns * rows).toLocaleString("en-US")} copies, which is more than the ${MAX_TILES.toLocaleString("en-US")} this tool draws.`,
      "Make the watermark larger, raise the tile gap, or switch to a single placement.",
    );
  }

  // Center the whole grid on the picture, so the pattern is symmetric.
  const originX = image.width / 2 - ((columns - 1) * stepX) / 2;
  const originY = image.height / 2 - ((rows - 1) * stepY) / 2;

  const out: Placement[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      out.push({
        x: Math.round(originX + column * stepX),
        y: Math.round(originY + row * stepY),
      });
    }
  }
  return out;
}

/** Logo box scaled to a percentage of the image width, keeping its ratio. */
export function scaleLogo(logo: Size, image: Size, percent: number): Size {
  assertSize(image);
  assertSize(logo);
  const width = (image.width * clamp(readNumber(percent, 20), 1, 100)) / 100;
  return { width: Math.round(width), height: Math.round((width * logo.height) / logo.width) };
}

/**
 * Resolve a whole watermark into the list of copies to draw. `box` is the
 * measured size of one copy, which the panel gets from the canvas and a test
 * supplies directly.
 */
export function planWatermark(image: Size, box: Size, opts: WatermarkOpts = {}): WatermarkLayout {
  assertSize(image);
  const rotation = clamp(readNumber(opts.rotation, 0), -180, 180);
  const margin = marginFor(image, readNumber(opts.marginPercent, 4));
  const tiled = opts.mode === "tile";
  const anchor = (ANCHORS.includes(opts.anchor as Anchor) ? opts.anchor : "bottom-right") as Anchor;
  return {
    placements: tiled
      ? tileCenters(image, box, readNumber(opts.tileGapPercent, 40), rotation)
      : [anchorCenter(anchor, image, box, margin)],
    box,
    margin,
    rotation,
    tiled,
  };
}

/** "photo.jpg" plus the chosen format becomes "photo-watermarked.jpg". */
export function watermarkFilename(name: string, format: string): string {
  const extension =
    format === "image/png"
      ? "png"
      : format === "image/webp"
        ? "webp"
        : format === "image/jpeg"
          ? "jpg"
          : "png";
  const trimmed = name.trim() || "image";
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem}-watermarked.${extension}`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const SIZE_RE = /^\s*(\d{1,6})\s*[x*by\s]+\s*(\d{1,6})\s*$/i;

/**
 * The text surface takes the picture's size rather than the picture: the
 * layout is the part that is worth checking without a browser, and drawing
 * needs a canvas the pure layer must not touch.
 *
 * Accepts "1920x1080" or a JSON object with `width` and `height`.
 */
export function readImageSize(input: string): Size {
  const text = input.trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "No picture loaded yet.",
      'Drop an image onto the panel above, or type its size here as "1920x1080".',
    );
  }
  const match = SIZE_RE.exec(text);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };

  // Parsing and validating are separate steps so that a well formed object with
  // a nonsense size reports what is wrong with the size, rather than being
  // swallowed by the catch and reported as unreadable text.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>;
    const size = { width: readNumber(object.width, NaN), height: readNumber(object.height, NaN) };
    assertSize(size);
    return size;
  }
  throw new ToolError(
    "bad-size",
    `Could not read "${text}" as an image size.`,
    'Write it as "1920x1080", or drop the picture itself onto the panel above.',
  );
}

export function run(input: Uint8Array | string, opts: WatermarkOpts = {}): Record<string, string> {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const image = readImageSize(text);
  const kind = opts.kind === "image" ? "image" : "text";

  let box: Size;
  let extra: Record<string, string>;
  if (kind === "image") {
    // Without the real logo, a square stands in: the placement math only needs
    // a box, and the panel measures the real one.
    const scaled = scaleLogo({ width: 100, height: 100 }, image, readNumber(opts.scalePercent, 20));
    box = scaled;
    extra = { "Logo box": `${scaled.width} by ${scaled.height} pixels, from a square logo` };
  } else {
    const caption = typeof opts.text === "string" && opts.text.trim() ? opts.text : "Watermark";
    const measured = textBox(
      caption,
      image,
      { fontPercent: readNumber(opts.fontPercent, 6) },
      approximateMeasure,
    );
    box = { width: measured.width, height: measured.height };
    extra = {
      Text: caption,
      "Font size": `${measured.fontSize}px, ${readNumber(opts.fontPercent, 6)}% of the image height`,
      Lines: measured.lines.join(" / "),
    };
  }

  const layout = planWatermark(image, box, opts);
  const first = layout.placements[0]!;

  const out: Record<string, string> = {
    "Image size": `${image.width} by ${image.height} pixels`,
    Kind: kind === "image" ? "Logo watermark" : "Text watermark",
    ...extra,
    "Watermark box": `${Math.round(box.width)} by ${Math.round(box.height)} pixels`,
    Placement: layout.tiled
      ? `Tiled, ${layout.placements.length} copies`
      : `Single, anchored ${String(opts.anchor ?? "bottom-right").replace("-", " ")}`,
    Margin: `${layout.margin}px`,
    Rotation: `${layout.rotation} degrees`,
    Opacity: `${clamp(readNumber(opts.opacity, 60), 0, 100)}%`,
    "First center": `${Math.round(first.x)}, ${Math.round(first.y)}`,
  };
  if (layout.placements.length > 1) {
    const last = layout.placements[layout.placements.length - 1]!;
    out["Last center"] = `${Math.round(last.x)}, ${Math.round(last.y)}`;
  }
  out["Drawing it"] =
    "This surface reports the layout only. Use the panel above to load a picture, see the watermark on it, and export a PNG, JPEG, or WebP.";
  return out;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  Record<string, string>,
  WatermarkOpts
>;
