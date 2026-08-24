import { ToolError, type ToolLogic } from "../types";

/**
 * Sprite sheet packer: rectangle packing, pixel helpers, and atlas exporters.
 *
 * Three separable pieces live here, all pure arithmetic so they run the same in
 * a test as they do in the browser panel.
 *
 * 1. `packRects` solves the bin packing part. Three algorithms are available:
 *
 *    - `maxrects` is Jukka Jylanki's MaxRects with the best short side fit
 *      heuristic ("A Thousand Ways to Pack the Bin", 2010). It keeps a list of
 *      maximal free rectangles, places each sprite in the free rectangle that
 *      leaves the smallest leftover on its shorter axis, then re splits and
 *      prunes the free list. It is the slowest of the three and packs tightest.
 *    - `guillotine` is the same paper's guillotine packer: best short side fit
 *      for the choice, shorter leftover axis for the split, no free rectangle
 *      merging. Every cut runs edge to edge, which is what a cutting machine or
 *      a very old tile pipeline needs.
 *    - `shelf` is next fit decreasing height. Sprites are laid in rows whose
 *      height is set by the tallest sprite in the row. It is the fastest, it
 *      wastes the most space, and it is the layout people expect when every
 *      sprite is a similar height.
 *
 *    Input order is normalized before packing so the same input always gives
 *    the same atlas: sprites sort by their longest side descending, then by id.
 *    The shelf packer sorts by placed height descending instead, because next
 *    fit decreasing height is defined by that order.
 *
 * 2. `trimTransparent`, `blitInto`, and `extrudeEdges` are the pixel helpers.
 *    Decoding a PNG needs a canvas, so the panel decodes and hands these
 *    functions raw RGBA. The panel may instead composite with `drawImage`; both
 *    paths produce the same atlas, and the pure path is the one under test.
 *
 * 3. `toJsonHash`, `toJsonArray`, `toCss`, `toXml`, and `toCsv` turn a pack
 *    result into the metadata formats engines actually read.
 *
 * ## Rotation, defined once
 *
 * `Placement.w` and `Placement.h` are always the sprite's own unrotated width
 * and height. When `rotated` is true the sprite was turned 90 degrees clockwise
 * before being placed, so the region it occupies in the atlas is `h` wide and
 * `w` tall, starting at `(x, y)`. Source pixel `(sx, sy)` lands at atlas pixel
 * `(x + h - 1 - sy, y + sx)`. This is the TexturePacker convention, which is
 * why `frame.w` and `frame.h` in the JSON exporters stay unrotated too, and it
 * is what Phaser 3 expects when it sees `rotated: true`. Use `occupiedBox` any
 * time you need the region rather than the sprite size.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

export type PackAlgorithm = "maxrects" | "shelf" | "guillotine";

export type ExportFormat = "json-hash" | "json-array" | "css" | "xml" | "csv";

/** One sprite to place, measured in pixels. */
export interface PackItem {
  id: string;
  w: number;
  h: number;
}

/** Where one sprite ended up. `w` and `h` are the unrotated sprite size. */
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackOpts {
  /** Hard ceiling on atlas width in pixels. Default 2048. */
  maxWidth?: number;
  /** Hard ceiling on atlas height in pixels. Default 2048. */
  maxHeight?: number;
  /** Gap kept between neighboring sprites in pixels. Default 2. */
  padding?: number;
  /** Round the finished atlas up to power of two sides. Default false. */
  powerOfTwo?: boolean;
  /** Let the packer turn a sprite 90 degrees clockwise. Default false. */
  allowRotate?: boolean;
  /** Which packer to run. Default "maxrects". */
  algorithm?: PackAlgorithm;
}

export interface PackResult {
  width: number;
  height: number;
  placements: Placement[];
  /** Ids that did not fit inside the maximum atlas size. */
  unplaced: string[];
  /** Sprite pixels divided by atlas pixels, from 0 to 1. */
  efficiency: number;
  algorithm: PackAlgorithm;
  padding: number;
}

/** What a sprite looked like before its transparent edges were trimmed off. */
export interface FrameTrim {
  /** Width of the original image, before trimming. */
  sourceW: number;
  /** Height of the original image, before trimming. */
  sourceH: number;
  /** Left offset of the kept content inside the original image. */
  offsetX: number;
  /** Top offset of the kept content inside the original image. */
  offsetY: number;
}

export interface ExportOpts {
  /** File name of the atlas image the metadata points at. */
  imageName?: string;
  /** Scale string written into the meta block. Default "1". */
  scale?: string;
  /** Class name stem for the CSS exporter. Default "sprite". */
  classPrefix?: string;
  /** Per sprite trim info, keyed by placement id. Missing means untrimmed. */
  frames?: Record<string, FrameTrim>;
}

export interface SpritePackerOpts {
  maxSize?: number;
  padding?: number;
  powerOfTwo?: boolean;
  allowRotate?: boolean;
  trim?: boolean;
  algorithm?: string;
  format?: string;
  imageName?: string;
  [key: string]: unknown;
}

export type SpritePackerResult = Record<string, string>;

const DEFAULT_IMAGE_NAME = "spritesheet.png";
const APP_URL = "https://tools.maxhogan.dev/sprite-sheet-packer";
const PANEL_FIX =
  "Drop your PNG or JPEG sprites on the panel above, or paste one line per sprite in the form name 32x32.";

/* ------------------------------------------------------------------ *
 * small numeric helpers
 * ------------------------------------------------------------------ */

function nextPow2(n: number): number {
  if (n <= 0) return 0;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function prevPow2(n: number): number {
  if (n < 1) return 1;
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/* ------------------------------------------------------------------ *
 * validation
 * ------------------------------------------------------------------ */

function readAlgorithm(value: unknown): PackAlgorithm {
  if (value === undefined || value === null || value === "") return "maxrects";
  const key = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (key === "maxrects" || key === "maxrect" || key === "bssf") return "maxrects";
  if (key === "shelf" || key === "nfdh" || key === "rows") return "shelf";
  if (key === "guillotine" || key === "guillotene" || key === "cut") return "guillotine";
  throw new ToolError(
    "invalid-algorithm",
    `"${String(value)}" is not a packing algorithm.`,
    "Choose one of: maxrects, shelf, guillotine.",
  );
}

function readFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === "") return "json-hash";
  const key = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (
    key === "jsonhash" ||
    key === "json" ||
    key === "hash" ||
    key === "texturepacker" ||
    key === "phaser" ||
    key === "phaser3"
  ) {
    return "json-hash";
  }
  if (key === "jsonarray" || key === "array" || key === "pixijs" || key === "pixi")
    return "json-array";
  if (key === "css" || key === "stylesheet" || key === "csssprite") return "css";
  if (key === "xml" || key === "starling" || key === "sparrow" || key === "subtexture")
    return "xml";
  if (key === "csv" || key === "spreadsheet" || key === "tsv") return "csv";
  throw new ToolError(
    "invalid-format",
    `"${String(value)}" is not an export format.`,
    "Choose one of: json-hash, json-array, css, xml, csv.",
  );
}

function validateItems(items: unknown): PackItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ToolError("no-items", "There are no sprites to pack.", PANEL_FIX);
  }
  const seen = new Set<string>();
  const out: PackItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i] as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ToolError(
        "invalid-item",
        `Sprite ${i + 1} is not an object with an id, a width, and a height.`,
        'Each sprite looks like {"id": "hero", "w": 32, "h": 32}.',
      );
    }
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === "") {
      throw new ToolError(
        "invalid-item",
        `Sprite ${i + 1} has no id.`,
        "Give every sprite a non empty id, usually its file name.",
      );
    }
    if (!isPositiveInt(item.w) || !isPositiveInt(item.h)) {
      throw new ToolError(
        "invalid-size",
        `Sprite "${id}" is ${String(item.w)} by ${String(item.h)}, which is not a usable pixel size.`,
        "Widths and heights must be whole numbers of pixels, 1 or larger.",
      );
    }
    if (item.w > 65536 || item.h > 65536) {
      throw new ToolError(
        "invalid-size",
        `Sprite "${id}" is ${item.w} by ${item.h}, which is larger than any atlas this tool builds.`,
        "Scale the source image down to 65536 pixels per side or less first.",
      );
    }
    if (seen.has(id)) {
      throw new ToolError(
        "duplicate-id",
        `Two sprites share the id "${id}".`,
        "Ids become frame names, so they have to be unique. Rename one of the files.",
      );
    }
    seen.add(id);
    out.push({ id, w: item.w, h: item.h });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ordering
 * ------------------------------------------------------------------ */

interface WorkItem {
  id: string;
  w: number;
  h: number;
  /** Padded width, the footprint the packer reserves. */
  pw: number;
  /** Padded height. */
  ph: number;
}

/** Deterministic order: longest side descending, then area, then id. */
function sortForPacking(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const am = Math.max(a.pw, a.ph);
    const bm = Math.max(b.pw, b.ph);
    if (am !== bm) return bm - am;
    const an = Math.min(a.pw, a.ph);
    const bn = Math.min(b.pw, b.ph);
    if (an !== bn) return bn - an;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 * free rectangle plumbing shared by maxrects and guillotine
 * ------------------------------------------------------------------ */

interface Fit {
  x: number;
  y: number;
  rotated: boolean;
  index: number;
}

/** Best short side fit: smallest leftover on the shorter axis wins. */
function findBestShortSideFit(free: Box[], w: number, h: number, allowRotate: boolean): Fit | null {
  let best: Fit | null = null;
  let bestShort = Infinity;
  let bestLong = Infinity;

  for (let i = 0; i < free.length; i += 1) {
    const f = free[i]!;
    if (f.w >= w && f.h >= h) {
      const dx = f.w - w;
      const dy = f.h - h;
      const short = Math.min(dx, dy);
      const long = Math.max(dx, dy);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = { x: f.x, y: f.y, rotated: false, index: i };
        bestShort = short;
        bestLong = long;
      }
    }
    if (allowRotate && f.w >= h && f.h >= w) {
      const dx = f.w - h;
      const dy = f.h - w;
      const short = Math.min(dx, dy);
      const long = Math.max(dx, dy);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = { x: f.x, y: f.y, rotated: true, index: i };
        bestShort = short;
        bestLong = long;
      }
    }
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * MaxRects
 * ------------------------------------------------------------------ */

/**
 * Splits one free rectangle around a newly used rectangle, pushing every
 * surviving fragment into `out`. Returns false when the two do not overlap, in
 * which case the caller keeps the original.
 */
function splitFreeNode(out: Box[], f: Box, u: Box): boolean {
  if (u.x >= f.x + f.w || u.x + u.w <= f.x || u.y >= f.y + f.h || u.y + u.h <= f.y) {
    return false;
  }

  if (u.x < f.x + f.w && u.x + u.w > f.x) {
    if (u.y > f.y && u.y < f.y + f.h) {
      out.push({ x: f.x, y: f.y, w: f.w, h: u.y - f.y });
    }
    if (u.y + u.h < f.y + f.h) {
      out.push({ x: f.x, y: u.y + u.h, w: f.w, h: f.y + f.h - (u.y + u.h) });
    }
  }

  if (u.y < f.y + f.h && u.y + u.h > f.y) {
    if (u.x > f.x && u.x < f.x + f.w) {
      out.push({ x: f.x, y: f.y, w: u.x - f.x, h: f.h });
    }
    if (u.x + u.w < f.x + f.w) {
      out.push({ x: u.x + u.w, y: f.y, w: f.x + f.w - (u.x + u.w), h: f.h });
    }
  }

  return true;
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Drops degenerate rectangles and any rectangle fully inside another. */
function pruneFreeList(rects: Box[]): Box[] {
  const kept: Box[] = rects.filter((r) => r.w > 0 && r.h > 0);
  const out: Box[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    let redundant = false;
    for (let j = 0; j < kept.length && !redundant; j += 1) {
      if (i === j) continue;
      if (contains(kept[j]!, kept[i]!)) {
        // Identical rectangles contain each other; keep only the earlier one.
        redundant = !contains(kept[i]!, kept[j]!) || j < i;
      }
    }
    if (!redundant) out.push(kept[i]!);
  }
  return out;
}

function packMaxRects(
  items: WorkItem[],
  binW: number,
  binH: number,
  allowRotate: boolean,
): { placements: Placement[]; unplaced: string[] } {
  let free: Box[] = [{ x: 0, y: 0, w: binW, h: binH }];
  const placements: Placement[] = [];
  const unplaced: string[] = [];

  for (const item of items) {
    const fit = findBestShortSideFit(free, item.pw, item.ph, allowRotate);
    if (!fit) {
      unplaced.push(item.id);
      continue;
    }
    const used: Box = {
      x: fit.x,
      y: fit.y,
      w: fit.rotated ? item.ph : item.pw,
      h: fit.rotated ? item.pw : item.ph,
    };
    placements.push({
      id: item.id,
      x: fit.x,
      y: fit.y,
      w: item.w,
      h: item.h,
      rotated: fit.rotated,
    });

    const next: Box[] = [];
    for (const f of free) {
      if (!splitFreeNode(next, f, used)) next.push(f);
    }
    free = pruneFreeList(next);
  }

  return { placements, unplaced };
}

/* ------------------------------------------------------------------ *
 * Guillotine
 * ------------------------------------------------------------------ */

function packGuillotine(
  items: WorkItem[],
  binW: number,
  binH: number,
  allowRotate: boolean,
): { placements: Placement[]; unplaced: string[] } {
  const free: Box[] = [{ x: 0, y: 0, w: binW, h: binH }];
  const placements: Placement[] = [];
  const unplaced: string[] = [];

  for (const item of items) {
    const fit = findBestShortSideFit(free, item.pw, item.ph, allowRotate);
    if (!fit) {
      unplaced.push(item.id);
      continue;
    }
    const node = free[fit.index]!;
    const usedW = fit.rotated ? item.ph : item.pw;
    const usedH = fit.rotated ? item.pw : item.ph;
    placements.push({
      id: item.id,
      x: fit.x,
      y: fit.y,
      w: item.w,
      h: item.h,
      rotated: fit.rotated,
    });

    // Shorter leftover axis split: the smaller remainder decides which cut runs
    // the full width of the node, so the bigger remainder stays in one piece.
    const leftoverW = node.w - usedW;
    const leftoverH = node.h - usedH;
    const splitHorizontal = leftoverW <= leftoverH;

    const bottom: Box = {
      x: node.x,
      y: node.y + usedH,
      w: splitHorizontal ? node.w : usedW,
      h: leftoverH,
    };
    const right: Box = {
      x: node.x + usedW,
      y: node.y,
      w: leftoverW,
      h: splitHorizontal ? usedH : node.h,
    };

    free.splice(fit.index, 1);
    if (bottom.w > 0 && bottom.h > 0) free.push(bottom);
    if (right.w > 0 && right.h > 0) free.push(right);
  }

  return { placements, unplaced };
}

/* ------------------------------------------------------------------ *
 * Shelf (next fit decreasing height)
 * ------------------------------------------------------------------ */

function packShelf(
  items: WorkItem[],
  binW: number,
  binH: number,
  allowRotate: boolean,
): { placements: Placement[]; unplaced: string[] } {
  // Orientation is decided before the sort, because the sort key is the height
  // the sprite will actually occupy. Rotating tall sprites flat keeps rows
  // short, which is the whole point of a shelf packer.
  const oriented = items.map((item) => {
    const rotated = allowRotate && item.ph > item.pw;
    return {
      item,
      rotated,
      occW: rotated ? item.ph : item.pw,
      occH: rotated ? item.pw : item.ph,
    };
  });
  oriented.sort((a, b) => {
    if (a.occH !== b.occH) return b.occH - a.occH;
    if (a.occW !== b.occW) return b.occW - a.occW;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

  const placements: Placement[] = [];
  const unplaced: string[] = [];
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;

  for (const entry of oriented) {
    if (entry.occW > binW || entry.occH > binH) {
      unplaced.push(entry.item.id);
      continue;
    }
    if (cursorX + entry.occW > binW) {
      shelfY += shelfH;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + entry.occH > binH) {
      unplaced.push(entry.item.id);
      continue;
    }
    placements.push({
      id: entry.item.id,
      x: cursorX,
      y: shelfY,
      w: entry.item.w,
      h: entry.item.h,
      rotated: entry.rotated,
    });
    cursorX += entry.occW;
    if (entry.occH > shelfH) shelfH = entry.occH;
  }

  return { placements, unplaced };
}

/* ------------------------------------------------------------------ *
 * packRects
 * ------------------------------------------------------------------ */

/** The atlas region a placement occupies, accounting for rotation. */
export function occupiedBox(p: Placement): Box {
  return p.rotated ? { x: p.x, y: p.y, w: p.h, h: p.w } : { x: p.x, y: p.y, w: p.w, h: p.h };
}

function runAlgorithm(
  algorithm: PackAlgorithm,
  items: WorkItem[],
  binW: number,
  binH: number,
  allowRotate: boolean,
): { placements: Placement[]; unplaced: string[] } {
  if (algorithm === "shelf") return packShelf(items, binW, binH, allowRotate);
  if (algorithm === "guillotine") return packGuillotine(items, binW, binH, allowRotate);
  return packMaxRects(items, binW, binH, allowRotate);
}

/** Grows a candidate side. Always strictly larger than `n` until it hits `max`. */
function growDim(n: number, max: number, powerOfTwo: boolean): number {
  if (n >= max) return max;
  const grown = powerOfTwo ? nextPow2(n + 1) : Math.max(n + 8, Math.ceil((n * 1.25) / 8) * 8);
  return Math.min(grown, max);
}

/**
 * Packs sprites into the smallest atlas that holds them, up to the maximum.
 *
 * The search starts from a square roughly the size of the total padded sprite
 * area, then grows the shorter side until everything fits or the maximum is
 * reached. Once a layout succeeds the atlas is trimmed back to the bounding box
 * of what was actually placed, rounded up to power of two sides when asked, so
 * the reported size is the size you would export rather than the size the
 * search happened to try.
 *
 * `padding` is reserved on the right and the bottom of every sprite, so the gap
 * between any two neighbors is at least `padding` pixels while the outer edge
 * of the atlas stays flush.
 */
export function packRects(items: PackItem[], opts: PackOpts = {}): PackResult {
  const clean = validateItems(items);

  const padding = opts.padding ?? 2;
  if (!Number.isInteger(padding) || padding < 0 || padding > 1024) {
    throw new ToolError(
      "invalid-padding",
      `A padding of ${String(padding)} pixels is not usable.`,
      "Use a whole number of pixels from 0 to 1024. The default is 2.",
    );
  }

  const maxWidth = opts.maxWidth ?? 2048;
  const maxHeight = opts.maxHeight ?? 2048;
  if (
    !isPositiveInt(maxWidth) ||
    !isPositiveInt(maxHeight) ||
    maxWidth > 65536 ||
    maxHeight > 65536
  ) {
    throw new ToolError(
      "invalid-max-size",
      `A maximum atlas of ${String(maxWidth)} by ${String(maxHeight)} is not usable.`,
      "Use whole numbers of pixels from 1 to 65536. The default is 2048 by 2048.",
    );
  }

  const algorithm = readAlgorithm(opts.algorithm);
  const powerOfTwo = opts.powerOfTwo === true;
  const allowRotate = opts.allowRotate === true;

  // A power of two atlas can never exceed the largest power of two that fits
  // inside the ceiling, so the ceiling is lowered up front rather than being
  // blown through by the final rounding.
  const capW = powerOfTwo ? prevPow2(maxWidth) : maxWidth;
  const capH = powerOfTwo ? prevPow2(maxHeight) : maxHeight;

  const work: WorkItem[] = clean.map((it) => ({
    id: it.id,
    w: it.w,
    h: it.h,
    pw: it.w + padding,
    ph: it.h + padding,
  }));
  const ordered = sortForPacking(work);

  let area = 0;
  let minW = 1;
  let minH = 1;
  for (const it of ordered) {
    area += it.pw * it.ph;
    const needW = allowRotate ? Math.min(it.pw, it.ph) : it.pw;
    const needH = allowRotate ? Math.min(it.pw, it.ph) : it.ph;
    if (needW > minW) minW = needW;
    if (needH > minH) minH = needH;
  }

  const square = Math.ceil(Math.sqrt(area));
  let binW = clamp(Math.max(minW, square), 1, capW);
  let binH = clamp(Math.max(minH, square), 1, capH);
  if (powerOfTwo) {
    binW = clamp(nextPow2(binW), 1, capW);
    binH = clamp(nextPow2(binH), 1, capH);
  }

  let attempt = runAlgorithm(algorithm, ordered, binW, binH, allowRotate);
  let guard = 0;
  while (attempt.unplaced.length > 0 && (binW < capW || binH < capH) && guard < 256) {
    guard += 1;
    if (binW <= binH && binW < capW) {
      binW = growDim(binW, capW, powerOfTwo);
    } else if (binH < capH) {
      binH = growDim(binH, capH, powerOfTwo);
    } else {
      binW = growDim(binW, capW, powerOfTwo);
    }
    attempt = runAlgorithm(algorithm, ordered, binW, binH, allowRotate);
  }

  let width = 0;
  let height = 0;
  let placedArea = 0;
  for (const p of attempt.placements) {
    const box = occupiedBox(p);
    if (box.x + box.w > width) width = box.x + box.w;
    if (box.y + box.h > height) height = box.y + box.h;
    placedArea += p.w * p.h;
  }
  if (powerOfTwo) {
    width = nextPow2(width);
    height = nextPow2(height);
  }

  const total = width * height;
  return {
    width,
    height,
    placements: attempt.placements,
    unplaced: attempt.unplaced,
    efficiency: total > 0 ? placedArea / total : 0,
    algorithm,
    padding,
  };
}

/* ------------------------------------------------------------------ *
 * pixel helpers
 * ------------------------------------------------------------------ */

export interface TrimBounds extends Box {
  /** True when every pixel was transparent, in which case the box is empty. */
  empty: boolean;
}

function assertBuffer(rgba: ArrayLike<number>, w: number, h: number, what: string): void {
  if (!isPositiveInt(w) || !isPositiveInt(h)) {
    throw new ToolError(
      "invalid-size",
      `A ${what} of ${String(w)} by ${String(h)} pixels is not a usable size.`,
      "Pass the pixel width and height as positive whole numbers.",
    );
  }
  if (rgba.length !== w * h * 4) {
    throw new ToolError(
      "size-mismatch",
      `The ${what} buffer holds ${rgba.length} bytes, but ${w} by ${h} pixels needs ${w * h * 4}.`,
      "Pass raw RGBA pixels, four bytes each, together with the size they were read at.",
    );
  }
}

/**
 * Smallest rectangle containing every pixel whose alpha is above `threshold`.
 *
 * This is the measurement behind the trim option: most sprite exports carry a
 * transparent margin, and packing the margin wastes atlas space in every single
 * frame. The panel trims each sprite to these bounds, packs the trimmed size,
 * and records the original size and offset so the exporters can write
 * `spriteSourceSize` and `sourceSize`, which is what lets an engine draw the
 * trimmed frame back in its original position.
 *
 * Trimming and padding solve different problems and are usually used together.
 * Padding keeps a gap so that bilinear filtering cannot sample a neighboring
 * sprite. `extrudeEdges` goes one step further and bleeds the sprite's own
 * border pixels into that gap, which is what removes the last hairline seam on
 * a scaled or rotated quad. Trim removes empty space, and then padding and
 * extrusion protect the tight edge that trimming just created.
 *
 * A fully transparent image has no bounds, so the result is an empty box at the
 * origin with `empty` set.
 */
export function trimTransparent(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  threshold = 0,
): TrimBounds {
  assertBuffer(rgba, w, h, "sprite");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new ToolError(
      "invalid-threshold",
      `An alpha threshold of ${String(threshold)} is outside the 0 to 255 range.`,
      "Use 0 to keep any pixel that is not fully transparent, or a higher value to also drop faint edges.",
    );
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, empty: true };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false };
}

/**
 * Copies one sprite into an atlas buffer at `(x, y)`, rotating it 90 degrees
 * clockwise when asked. Writes straight into `atlasRgba` and returns it.
 *
 * The panel can build the same atlas with a canvas and `drawImage`; this exists
 * so the composite step is reachable without a canvas, which is what makes it
 * testable and what lets a worker build an atlas off the main thread.
 */
export function blitInto(
  atlasRgba: Uint8ClampedArray,
  atlasW: number,
  srcRgba: ArrayLike<number>,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
  rotated = false,
): Uint8ClampedArray {
  if (!isPositiveInt(atlasW) || atlasRgba.length % (atlasW * 4) !== 0) {
    throw new ToolError(
      "size-mismatch",
      `An atlas of ${atlasRgba.length} bytes is not a whole number of ${String(atlasW)} pixel rows.`,
      "Allocate the atlas as width times height times four bytes before blitting into it.",
    );
  }
  const atlasH = atlasRgba.length / (atlasW * 4);
  assertBuffer(srcRgba, srcW, srcH, "sprite");
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new ToolError(
      "invalid-position",
      `A destination of ${String(x)}, ${String(y)} is not a whole pixel.`,
      "Pass the placement x and y straight from packRects.",
    );
  }

  const destW = rotated ? srcH : srcW;
  const destH = rotated ? srcW : srcH;
  if (x < 0 || y < 0 || x + destW > atlasW || y + destH > atlasH) {
    throw new ToolError(
      "out-of-bounds",
      `A ${destW} by ${destH} sprite at ${x}, ${y} does not fit inside a ${atlasW} by ${atlasH} atlas.`,
      "Allocate the atlas at the width and height packRects reported before blitting.",
    );
  }

  for (let sy = 0; sy < srcH; sy += 1) {
    for (let sx = 0; sx < srcW; sx += 1) {
      const from = (sy * srcW + sx) * 4;
      const dx = rotated ? x + srcH - 1 - sy : x + sx;
      const dy = rotated ? y + sx : y + sy;
      const to = (dy * atlasW + dx) * 4;
      atlasRgba[to] = srcRgba[from]!;
      atlasRgba[to + 1] = srcRgba[from + 1]!;
      atlasRgba[to + 2] = srcRgba[from + 2]!;
      atlasRgba[to + 3] = srcRgba[from + 3]!;
    }
  }

  return atlasRgba;
}

/**
 * Bleeds the border pixels of an already placed region outward by `amount`
 * pixels, clipped to the atlas. Run it after `blitInto` to fill the padding
 * gutter with the sprite's own edge color, which is what stops a hairline of
 * transparency showing up when the quad is scaled or rotated at draw time.
 */
export function extrudeEdges(
  atlasRgba: Uint8ClampedArray,
  atlasW: number,
  box: Box,
  amount: number,
): Uint8ClampedArray {
  if (!isPositiveInt(atlasW) || atlasRgba.length % (atlasW * 4) !== 0) {
    throw new ToolError(
      "size-mismatch",
      `An atlas of ${atlasRgba.length} bytes is not a whole number of ${String(atlasW)} pixel rows.`,
      "Allocate the atlas as width times height times four bytes first.",
    );
  }
  if (!Number.isInteger(amount) || amount < 0) {
    throw new ToolError(
      "invalid-extrude",
      `An extrude of ${String(amount)} pixels is not usable.`,
      "Use a whole number of pixels, normally the same as the padding.",
    );
  }
  const atlasH = atlasRgba.length / (atlasW * 4);
  if (box.w <= 0 || box.h <= 0 || amount === 0) return atlasRgba;

  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.w - 1;
  const y1 = box.y + box.h - 1;

  for (let y = y0 - amount; y <= y1 + amount; y += 1) {
    if (y < 0 || y >= atlasH) continue;
    for (let x = x0 - amount; x <= x1 + amount; x += 1) {
      if (x < 0 || x >= atlasW) continue;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const from = (clamp(y, y0, y1) * atlasW + clamp(x, x0, x1)) * 4;
      const to = (y * atlasW + x) * 4;
      atlasRgba[to] = atlasRgba[from]!;
      atlasRgba[to + 1] = atlasRgba[from + 1]!;
      atlasRgba[to + 2] = atlasRgba[from + 2]!;
      atlasRgba[to + 3] = atlasRgba[from + 3]!;
    }
  }

  return atlasRgba;
}

/* ------------------------------------------------------------------ *
 * exporters
 * ------------------------------------------------------------------ */

interface FrameBody {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot: { x: number; y: number };
}

function frameBody(p: Placement, trim: FrameTrim | undefined): FrameBody {
  const source: FrameTrim = trim ?? { sourceW: p.w, sourceH: p.h, offsetX: 0, offsetY: 0 };
  const trimmed =
    source.sourceW !== p.w ||
    source.sourceH !== p.h ||
    source.offsetX !== 0 ||
    source.offsetY !== 0;
  return {
    frame: { x: p.x, y: p.y, w: p.w, h: p.h },
    rotated: p.rotated,
    trimmed,
    spriteSourceSize: { x: source.offsetX, y: source.offsetY, w: p.w, h: p.h },
    sourceSize: { w: source.sourceW, h: source.sourceH },
    pivot: { x: 0.5, y: 0.5 },
  };
}

function metaBlock(pack: PackResult, opts: ExportOpts): Record<string, unknown> {
  return {
    app: APP_URL,
    version: "1.0",
    image: opts.imageName ?? DEFAULT_IMAGE_NAME,
    format: "RGBA8888",
    size: { w: pack.width, h: pack.height },
    scale: opts.scale ?? "1",
  };
}

/**
 * TexturePacker JSON (Hash): frames keyed by name. This is the format Phaser 3,
 * Pixi, and most engine loaders read out of the box.
 */
export function toJsonHash(pack: PackResult, opts: ExportOpts = {}): string {
  const frames: Record<string, FrameBody> = {};
  for (const p of pack.placements) {
    frames[p.id] = frameBody(p, opts.frames?.[p.id]);
  }
  return `${JSON.stringify({ frames, meta: metaBlock(pack, opts) }, null, 2)}\n`;
}

/**
 * TexturePacker JSON (Array): the same frame bodies in an ordered array with a
 * `filename` on each. Preferred when frame order drives animation playback.
 */
export function toJsonArray(pack: PackResult, opts: ExportOpts = {}): string {
  const frames = pack.placements.map((p) => ({
    filename: p.id,
    ...frameBody(p, opts.frames?.[p.id]),
  }));
  return `${JSON.stringify({ frames, meta: metaBlock(pack, opts) }, null, 2)}\n`;
}

/** Phaser 3 reads the JSON Hash format verbatim, so this is the same output. */
export function toPhaser3(pack: PackResult, opts: ExportOpts = {}): string {
  return toJsonHash(pack, opts);
}

function cssName(id: string): string {
  const withoutExt = id.replace(/\.[a-z0-9]{1,5}$/i, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "sprite" : slug;
}

/**
 * CSS background sprites: one shared rule that carries the image, then one rule
 * per sprite that sets its size and background position.
 *
 * A rotated frame cannot be expressed with `background-position` alone, so a
 * rotated entry gets its atlas footprint as the box and a comment saying so.
 * Turn rotation off when the atlas is destined for CSS.
 */
export function toCss(pack: PackResult, opts: ExportOpts = {}): string {
  const prefix = opts.classPrefix ?? "sprite";
  const image = opts.imageName ?? DEFAULT_IMAGE_NAME;
  const lines: string[] = [
    `/* Sprite sheet built with ${APP_URL} */`,
    `.${prefix} {`,
    `  background-image: url("${image}");`,
    "  background-repeat: no-repeat;",
    "  display: inline-block;",
    "}",
  ];

  const used = new Set<string>();
  for (const p of pack.placements) {
    let name = cssName(p.id);
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    }
    used.add(name);
    const box = occupiedBox(p);
    lines.push("");
    if (p.rotated) {
      lines.push(`/* ${p.id} is rotated 90 degrees clockwise in the atlas */`);
    }
    lines.push(`.${prefix}-${name} {`);
    lines.push(`  width: ${box.w}px;`);
    lines.push(`  height: ${box.h}px;`);
    lines.push(`  background-position: -${box.x}px -${box.y}px;`);
    lines.push("}");
  }

  return `${lines.join("\n")}\n`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Starling and Sparrow XML. Trimmed frames carry the negative offset in
 * `frameX` and `frameY` plus the untrimmed size in `frameWidth` and
 * `frameHeight`, which is how those runtimes restore the original bounds.
 */
export function toXml(pack: PackResult, opts: ExportOpts = {}): string {
  const image = opts.imageName ?? DEFAULT_IMAGE_NAME;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<TextureAtlas imagePath="${xmlEscape(image)}" width="${pack.width}" height="${pack.height}">`,
  ];

  for (const p of pack.placements) {
    const box = occupiedBox(p);
    const trim = opts.frames?.[p.id];
    const attrs = [
      `name="${xmlEscape(p.id)}"`,
      `x="${box.x}"`,
      `y="${box.y}"`,
      `width="${p.w}"`,
      `height="${p.h}"`,
    ];
    if (trim) {
      const trimmed =
        trim.sourceW !== p.w || trim.sourceH !== p.h || trim.offsetX !== 0 || trim.offsetY !== 0;
      if (trimmed) {
        attrs.push(`frameX="${-trim.offsetX}"`);
        attrs.push(`frameY="${-trim.offsetY}"`);
        attrs.push(`frameWidth="${trim.sourceW}"`);
        attrs.push(`frameHeight="${trim.sourceH}"`);
      }
    }
    if (p.rotated) attrs.push('rotated="true"');
    lines.push(`  <SubTexture ${attrs.join(" ")}/>`);
  }

  lines.push("</TextureAtlas>");
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per frame, for a spreadsheet or a hand rolled loader. */
export function toCsv(pack: PackResult, opts: ExportOpts = {}): string {
  const header = "name,x,y,w,h,rotated,trimmed,sourceW,sourceH,offsetX,offsetY";
  const rows = pack.placements.map((p) => {
    const trim = opts.frames?.[p.id] ?? {
      sourceW: p.w,
      sourceH: p.h,
      offsetX: 0,
      offsetY: 0,
    };
    const trimmed =
      trim.sourceW !== p.w || trim.sourceH !== p.h || trim.offsetX !== 0 || trim.offsetY !== 0;
    return [
      csvCell(p.id),
      p.x,
      p.y,
      p.w,
      p.h,
      p.rotated,
      trimmed,
      trim.sourceW,
      trim.sourceH,
      trim.offsetX,
      trim.offsetY,
    ].join(",");
  });
  return `${[header, ...rows].join("\n")}\n`;
}

const EXPORTERS: Record<ExportFormat, (pack: PackResult, opts: ExportOpts) => string> = {
  "json-hash": toJsonHash,
  "json-array": toJsonArray,
  css: toCss,
  xml: toXml,
  csv: toCsv,
};

const FORMAT_LABEL: Record<ExportFormat, string> = {
  "json-hash": "JSON hash",
  "json-array": "JSON array",
  css: "CSS",
  xml: "XML",
  csv: "CSV",
};

const ALGORITHM_LABEL: Record<PackAlgorithm, string> = {
  maxrects: "MaxRects, best short side fit",
  guillotine: "Guillotine, best short side fit with a shorter axis split",
  shelf: "Shelf, next fit decreasing height",
};

/** Renders a pack result as one sprite per line, for the report row. */
export function formatPlacements(pack: PackResult, limit = 200): string {
  const lines = pack.placements.slice(0, limit).map((p) => {
    const box = occupiedBox(p);
    return `${p.id}  x ${box.x}, y ${box.y}, ${box.w} by ${box.h}${p.rotated ? " (rotated)" : ""}`;
  });
  if (pack.placements.length > limit) {
    lines.push(`and ${pack.placements.length - limit} more`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const IMAGE_MAGIC: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], name: "PNG" },
  { bytes: [0xff, 0xd8, 0xff], name: "JPEG" },
  { bytes: [0x47, 0x49, 0x46, 0x38], name: "GIF" },
  { bytes: [0x52, 0x49, 0x46, 0x46], name: "WebP" },
  { bytes: [0x42, 0x4d], name: "BMP" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: "ZIP" },
];

function sniffImage(bytes: Uint8Array): string | null {
  for (const sig of IMAGE_MAGIC) {
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (bytes[i] !== sig.bytes[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return sig.name;
  }
  return null;
}

function usePanel(detail: string): ToolError {
  return new ToolError("use-panel", detail, PANEL_FIX);
}

/**
 * Parses "name 32x32" lines. Blank lines and lines starting with # or // are
 * skipped. A line that is only a size gets an automatic name.
 */
export function parseSizeLines(text: string): PackItem[] {
  const items: PackItem[] = [];
  const bad: string[] = [];
  let auto = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;
    const match = /^(.*?)[\s,:=]*(\d+)\s*[x*×]\s*(\d+)\s*$/i.exec(line);
    if (!match) {
      bad.push(line);
      continue;
    }
    const name = match[1]!.replace(/[\s,:=]+$/, "").trim();
    auto += 1;
    items.push({
      id: name === "" ? `sprite-${auto}` : name,
      w: Number.parseInt(match[2]!, 10),
      h: Number.parseInt(match[3]!, 10),
    });
  }

  // Nothing readable at all means the input was never a size list, so point at
  // the panel. A single unreadable line inside an otherwise good list is a typo,
  // and silently dropping a sprite there would be worse than stopping.
  if (items.length === 0) {
    throw usePanel("This does not look like a list of sprite sizes.");
  }
  if (bad.length > 0) {
    throw new ToolError(
      "bad-line",
      `Cannot read a sprite size from "${bad[0]!}".`,
      "Every line looks like name 32x32. Use # to start a comment line.",
    );
  }
  return items;
}

function readItemsPayload(parsed: unknown): PackItem[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(list)) {
    throw usePanel('The JSON needs an "items" array of {"id","w","h"} objects.');
  }
  return list as PackItem[];
}

function readNumberOpt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function percent(v: number): string {
  return `${(v * 100).toFixed(1)} percent`;
}

/**
 * Text surface for the tool.
 *
 * The generic shell hands a tool exactly one input, and packing needs many
 * images at once, so the real work happens in the panel on this page. What
 * `run` accepts is the layout half of the problem, which is the half that does
 * not need pixels: a list of sprite names and sizes, either as JSON
 *
 * ```json
 * { "items": [{ "id": "hero", "w": 32, "h": 48 }] }
 * ```
 *
 * or as one `name 32x32` line per sprite. It returns the atlas size, the
 * efficiency, every placement, and the metadata file in the chosen format, so
 * a build script can compute an atlas layout without ever decoding an image.
 */
export function run(input: Uint8Array | string, opts: SpritePackerOpts = {}): SpritePackerResult {
  const algorithm = readAlgorithm(opts.algorithm);
  const format = readFormat(opts.format);

  const maxSize = readNumberOpt(opts.maxSize, 2048);
  if (!Number.isFinite(maxSize) || maxSize < 16 || maxSize > 16384) {
    throw new ToolError(
      "invalid-max-size",
      `A maximum atlas side of ${String(opts.maxSize)} pixels is not usable.`,
      "Use a whole number of pixels, at least 16 and no more than 16384. The panel offers 256 to 8192, and the default is 2048.",
    );
  }
  const padding = readNumberOpt(opts.padding, 2);

  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    const kind = sniffImage(input);
    if (kind) {
      throw usePanel(
        `This looks like a ${kind} file, and one image on its own is not a sprite sheet.`,
      );
    }
    text = new TextDecoder().decode(input);
  } else {
    throw usePanel("This input is not a list of sprite sizes.");
  }

  if (text.trim() === "") {
    throw new ToolError("empty-input", "There is nothing to pack.", PANEL_FIX);
  }

  const trimmed = text.trim();
  let items: PackItem[];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ToolError(
        "invalid-json",
        `That is not valid JSON: ${(err as Error).message}`,
        'Send {"items": [{"id": "hero", "w": 32, "h": 32}]} or one name 32x32 line per sprite.',
      );
    }
    items = readItemsPayload(parsed);
  } else {
    items = parseSizeLines(trimmed);
  }

  const pack = packRects(items, {
    maxWidth: maxSize,
    maxHeight: maxSize,
    padding,
    powerOfTwo: opts.powerOfTwo === true,
    allowRotate: opts.allowRotate === true,
    algorithm,
  });

  const imageName =
    typeof opts.imageName === "string" && opts.imageName.trim() !== ""
      ? opts.imageName.trim()
      : DEFAULT_IMAGE_NAME;
  const exported = EXPORTERS[format](pack, { imageName });

  const rows: SpritePackerResult = {
    "Atlas size": `${pack.width} by ${pack.height} pixels`,
    Algorithm: ALGORITHM_LABEL[pack.algorithm],
    Packed: `${pack.placements.length} of ${items.length} sprites`,
    Efficiency: `${percent(pack.efficiency)} of the atlas is sprite pixels`,
    Padding: `${pack.padding} pixel${pack.padding === 1 ? "" : "s"} between sprites`,
    Unplaced:
      pack.unplaced.length === 0
        ? "None. Every sprite fits."
        : `${pack.unplaced.length} did not fit: ${pack.unplaced.join(", ")}`,
    "Trim transparent edges":
      opts.trim === false
        ? "Off. Sprites are packed at their full size."
        : "On. The panel measures each image and packs only its opaque bounds, so sizes here assume already trimmed input.",
    Placements: formatPlacements(pack),
  };
  rows[`${FORMAT_LABEL[format]} output`] = exported;
  return rows;
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  SpritePackerResult,
  SpritePackerOpts
>;
