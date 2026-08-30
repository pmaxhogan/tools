import { ToolError, type ToolLogic } from "../types";

/**
 * Meme Generator logic: the text layout, kept away from the canvas.
 *
 * Two layouts, both of which people call a meme and which behave completely
 * differently:
 *
 * - classic: heavy outlined text sitting on top of the picture, one block near
 *   the top and one near the bottom, either of which can be dragged anywhere.
 * - caption: a plain bar above the picture with the text inside it, the format
 *   that reads better on a phone because nothing covers the image.
 *
 * The interesting part is the fitting. A caption is written before anyone knows
 * how long it is, so a fixed font size either overflows the frame or wastes it.
 * `fitText` starts at the size you asked for and shrinks in small steps until
 * the wrapped block fits its box, which is what makes one setting work for both
 * "NO" and a three line story.
 *
 * Width is measured through an injected function: the panel passes the canvas
 * measurement, the tests pass a stub. That is what keeps this layer pure and
 * this math checkable without a browser.
 */

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface Size {
  width: number;
  height: number;
}

/** Measures one line of text at a font size, in pixels. */
export type MeasureText = (text: string, fontSize: number) => number;

export type MemeMode = "classic" | "caption";

/** One laid out run of text, ready for the panel to draw. */
export interface MemeBlock {
  /** "top", "bottom", or "caption". */
  id: string;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  /** Center of the block. */
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** Empty disables the outline. */
  outline: string;
  outlineWidth: number;
  /** True when this block can be dragged in the panel. */
  draggable: boolean;
}

export interface MemeLayout {
  /** The finished canvas, which is taller than the picture in caption mode. */
  canvas: Size;
  /** Where the picture goes on that canvas. */
  imageAt: { x: number; y: number; width: number; height: number };
  /** Height of the caption bar, zero in classic mode. */
  barHeight: number;
  /** Background of the caption bar. */
  barColor: string;
  blocks: MemeBlock[];
}

export interface MemeOpts {
  mode?: MemeMode;
  topText?: string;
  bottomText?: string;
  captionText?: string;
  /** Font size as a percentage of the picture height. */
  fontPercent?: number;
  color?: string;
  outline?: string;
  /** Outline thickness as a percentage of the font size. */
  outlinePercent?: number;
  /** Shout the text, which is what the classic format does. */
  uppercase?: boolean;
  /** Widest a text block may be, as a percentage of the canvas width. */
  maxWidthPercent?: number;
  /** Drag positions, as percentages of the canvas. */
  topX?: number;
  topY?: number;
  bottomX?: number;
  bottomY?: number;
  barColor?: string;
  /** Start from a blank colored canvas instead of a picture. */
  blank?: string;
  blankColor?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * The classic meme face. Impact is not licensed for redistribution and there is
 * no OFL font under public/fonts to bundle, so this is a stack rather than a
 * webfont: Impact where it is installed (every Windows and macOS machine),
 * Anton or Haettenschweiler where a designer has one, and the system sans as a
 * last resort. Nothing is fetched at runtime.
 */
export const MEME_FONT_STACK =
  'Impact, Anton, Haettenschweiler, "Arial Narrow Bold", ui-sans-serif, system-ui, sans-serif';

/** Line height for the stacked lines, as a multiple of the font size. */
export const LINE_HEIGHT = 1.1;

/** Smallest font the fitter will shrink to before it gives up and overflows. */
export const MIN_FONT_SIZE = 12;

/** Blank canvas presets, for a meme that starts from a color rather than a photo. */
export const BLANK_SIZES: Readonly<Record<string, Size>> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  landscape: { width: 1200, height: 630 },
  story: { width: 1080, height: 1920 },
};

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

function readText(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
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
      "The canvas size has to be two positive numbers.",
      'Drop a picture onto the panel above, pick a blank canvas, or write the size as "1080x1080".',
    );
  }
}

/* ------------------------------------------------------------------ */
/* wrapping and fitting                                                */
/* ------------------------------------------------------------------ */

/**
 * Break `text` into lines no wider than `maxWidth`, keeping any line break the
 * author typed. A word wider than the whole line is left on its own line rather
 * than hyphenated: meme text is short, and a broken word reads worse than one
 * that slightly overhangs.
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

export interface FittedText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
  /** True when even the smallest allowed size did not fit the box. */
  overflowed: boolean;
}

/**
 * The largest size at or below `startFontSize` whose wrapped text fits `box`.
 *
 * The step is 6 percent per pass, which converges in under 30 passes from any
 * sane starting size and never lands on a size a person would call "slightly
 * wrong". Shrinking stops at MIN_FONT_SIZE and reports `overflowed` instead of
 * continuing down to something unreadable.
 */
export function fitText(
  text: string,
  box: Size,
  startFontSize: number,
  measure: MeasureText,
): FittedText {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      lines: [],
      fontSize: startFontSize,
      lineHeight: 0,
      width: 0,
      height: 0,
      overflowed: false,
    };
  }

  let fontSize = Math.max(MIN_FONT_SIZE, Math.round(startFontSize));
  for (let pass = 0; pass < 40; pass++) {
    const lines = wrapText(trimmed, box.width, fontSize, measure);
    const lineHeight = fontSize * LINE_HEIGHT;
    const height = lineHeight * lines.length;
    const width = lines.reduce((w, line) => Math.max(w, measure(line, fontSize)), 0);
    if ((height <= box.height && width <= box.width) || fontSize <= MIN_FONT_SIZE) {
      return {
        lines,
        fontSize,
        lineHeight,
        width,
        height,
        overflowed: height > box.height || width > box.width,
      };
    }
    fontSize = Math.max(MIN_FONT_SIZE, Math.floor(fontSize * 0.94));
  }

  const lines = wrapText(trimmed, box.width, MIN_FONT_SIZE, measure);
  const lineHeight = MIN_FONT_SIZE * LINE_HEIGHT;
  return {
    lines,
    fontSize: MIN_FONT_SIZE,
    lineHeight,
    width: lines.reduce((w, line) => Math.max(w, measure(line, MIN_FONT_SIZE)), 0),
    height: lineHeight * lines.length,
    overflowed: true,
  };
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

function styleOf(
  opts: MemeOpts,
  fallbackColor: string,
): {
  color: string;
  outline: string;
  outlinePercent: number;
} {
  return {
    color: readText(opts.color) || fallbackColor,
    // An explicit empty string turns the outline off; an absent option does not.
    outline: typeof opts.outline === "string" ? opts.outline : "#000000",
    outlinePercent: clamp(readNumber(opts.outlinePercent, 8), 0, 30),
  };
}

function shout(text: string, uppercase: boolean): string {
  return uppercase ? text.toUpperCase() : text;
}

/**
 * The classic layout: two blocks over the picture, each anchored by a
 * percentage position so dragging one in the panel only changes a number.
 *
 * The default positions sit a little inside the frame rather than flush against
 * it, because an outlined capital clipped by the edge is the single most common
 * way a meme comes out looking broken.
 */
export function layoutClassic(canvas: Size, opts: MemeOpts, measure: MeasureText): MemeBlock[] {
  assertSize(canvas);
  const uppercase = opts.uppercase !== false;
  const style = styleOf(opts, "#ffffff");
  const maxWidth = (canvas.width * clamp(readNumber(opts.maxWidthPercent, 92), 20, 100)) / 100;
  const startSize = Math.max(
    MIN_FONT_SIZE,
    Math.round((canvas.height * clamp(readNumber(opts.fontPercent, 11), 2, 40)) / 100),
  );
  const box: Size = { width: maxWidth, height: canvas.height * 0.4 };

  const blocks: MemeBlock[] = [];
  const place = (id: string, raw: string, xPercent: number, yPercent: number): void => {
    const fitted = fitText(shout(raw, uppercase), box, startSize, measure);
    if (fitted.lines.length === 0) return;
    blocks.push({
      id,
      lines: fitted.lines,
      fontSize: fitted.fontSize,
      lineHeight: fitted.lineHeight,
      x: (canvas.width * clamp(xPercent, 0, 100)) / 100,
      y: (canvas.height * clamp(yPercent, 0, 100)) / 100,
      width: fitted.width,
      height: fitted.height,
      color: style.color,
      outline: style.outline,
      outlineWidth: (fitted.fontSize * style.outlinePercent) / 100,
      draggable: true,
    });
  };

  place("top", readText(opts.topText), readNumber(opts.topX, 50), readNumber(opts.topY, 12));
  place(
    "bottom",
    readText(opts.bottomText),
    readNumber(opts.bottomX, 50),
    readNumber(opts.bottomY, 88),
  );
  return blocks;
}

/** Padding inside the caption bar, as a fraction of the picture height. */
const BAR_PADDING = 0.03;

/**
 * The caption layout: a bar above the picture, sized to whatever the text
 * needed. The picture is never covered and never cropped; the canvas simply
 * gets taller, which is why this format survives being reposted.
 */
export function layoutCaption(
  image: Size,
  opts: MemeOpts,
  measure: MeasureText,
): { canvas: Size; barHeight: number; block: MemeBlock | null } {
  assertSize(image);
  const padding = Math.round(image.height * BAR_PADDING);
  const maxWidth = image.width - padding * 2;
  const startSize = Math.max(
    MIN_FONT_SIZE,
    Math.round((image.height * clamp(readNumber(opts.fontPercent, 7), 2, 40)) / 100),
  );
  const fitted = fitText(
    shout(readText(opts.captionText), opts.uppercase === true),
    { width: maxWidth, height: image.height * 0.6 },
    startSize,
    measure,
  );

  if (fitted.lines.length === 0) {
    return { canvas: { ...image }, barHeight: 0, block: null };
  }

  const barHeight = Math.round(fitted.height + padding * 2);
  const style = styleOf(opts, "#111111");
  return {
    canvas: { width: image.width, height: image.height + barHeight },
    barHeight,
    block: {
      id: "caption",
      lines: fitted.lines,
      fontSize: fitted.fontSize,
      lineHeight: fitted.lineHeight,
      x: image.width / 2,
      y: barHeight / 2,
      width: fitted.width,
      height: fitted.height,
      color: style.color,
      // A caption on a plain bar needs no outline, and one looks wrong there.
      outline: "",
      outlineWidth: 0,
      draggable: false,
    },
  };
}

/** Resolve a whole meme: the canvas, where the picture sits, and every block. */
export function layoutMeme(image: Size, opts: MemeOpts, measure: MeasureText): MemeLayout {
  assertSize(image);
  if (opts.mode === "caption") {
    const caption = layoutCaption(image, opts, measure);
    return {
      canvas: caption.canvas,
      imageAt: { x: 0, y: caption.barHeight, width: image.width, height: image.height },
      barHeight: caption.barHeight,
      barColor: readText(opts.barColor) || "#ffffff",
      blocks: caption.block ? [caption.block] : [],
    };
  }
  return {
    canvas: { ...image },
    imageAt: { x: 0, y: 0, width: image.width, height: image.height },
    barHeight: 0,
    barColor: readText(opts.barColor) || "#ffffff",
    blocks: layoutClassic(image, opts, measure),
  };
}

/** "photo.jpg" becomes "photo-meme.png". */
export function memeFilename(name: string): string {
  const trimmed = name.trim() || "meme";
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem}-meme.png`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A rough width measurement for the text surface, where there is no canvas.
 * Impact is a condensed face, so 0.48 em per character is closer than the 0.55
 * a normal sans would need. The panel never uses this; it measures for real.
 */
export const approximateMeasure: MeasureText = (text, fontSize) => text.length * fontSize * 0.48;

const SIZE_RE = /^\s*(\d{1,6})\s*[x*by\s]+\s*(\d{1,6})\s*$/i;

/** Read the picture size from "1080x1080", a JSON object, or a blank preset. */
export function readCanvasSize(input: string, opts: MemeOpts): Size {
  const preset = readText(opts.blank);
  if (preset && preset !== "none") {
    const size = BLANK_SIZES[preset];
    if (!size) {
      throw new ToolError(
        "unknown-preset",
        `"${preset}" is not a blank canvas preset.`,
        `Use one of: ${Object.keys(BLANK_SIZES).join(", ")}.`,
      );
    }
    return { ...size };
  }

  const text = input.trim();
  if (!text) {
    throw new ToolError(
      "empty-input",
      "No picture loaded yet.",
      'Drop an image onto the panel above, pick a blank canvas, or type a size like "1080x1080".',
    );
  }
  const match = SIZE_RE.exec(text);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };

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
    `Could not read "${text}" as a picture size.`,
    'Write it as "1080x1080", or drop the picture itself onto the panel above.',
  );
}

export function run(input: Uint8Array | string, opts: MemeOpts = {}): Record<string, string> {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const image = readCanvasSize(text, opts);
  const layout = layoutMeme(image, opts, approximateMeasure);

  if (layout.blocks.length === 0) {
    throw new ToolError(
      "no-text",
      "There is no caption to lay out yet.",
      opts.mode === "caption"
        ? "Type the caption that goes in the bar above the picture."
        : "Type the top line, the bottom line, or both.",
    );
  }

  const out: Record<string, string> = {
    Mode: opts.mode === "caption" ? "Caption bar above the picture" : "Classic top and bottom",
    "Picture size": `${image.width} by ${image.height} pixels`,
    "Canvas size": `${layout.canvas.width} by ${layout.canvas.height} pixels`,
    Font: MEME_FONT_STACK,
  };
  if (layout.barHeight > 0) out["Caption bar"] = `${layout.barHeight}px of ${layout.barColor}`;

  for (const block of layout.blocks) {
    out[`${block.id} text`] = block.lines.join(" / ");
    out[`${block.id} layout`] =
      `${block.lines.length} ${block.lines.length === 1 ? "line" : "lines"} at ${block.fontSize}px, centered on ${Math.round(block.x)}, ${Math.round(block.y)}`;
  }
  out["Drawing it"] =
    "This surface reports the layout only. Use the panel above to load a picture, drag the text where you want it, then copy the image or save it as a PNG.";
  return out;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, MemeOpts>;
