import { ToolError, type ToolLogic } from "../types";

/**
 * Handwriting Pad: the ink math behind a pressure aware drawing surface.
 *
 * This module is the tool (rule 27). It holds every calculation the canvas
 * needs but should not own: curve smoothing, point reduction, bounding boxes,
 * SVG path building, and the save format. The component draws; this file
 * decides what a stroke actually looks like.
 *
 * There is deliberately no handwriting recognition here. Turning ink into
 * text needs a trained model, and no small one runs honestly in a browser
 * tab, so this tool draws and exports rather than pretending to read.
 *
 * Coordinates are plain numbers in whatever space the caller drew in, which
 * for the panel is CSS pixels of the canvas element. Pressure is 0 to 1.
 */

/** One sampled pointer position. `p` is pressure, 0 to 1. */
export interface InkPoint {
  x: number;
  y: number;
  p: number;
}

/** One continuous mark, from pointer down to pointer up. */
export interface Stroke {
  points: InkPoint[];
  /** Any CSS color. The panel resolves design tokens to hex before storing. */
  color: string;
  /** Width in user units at pressure 0.5, before the pressure multiplier. */
  baseWidth: number;
}

/** Axis aligned box around some ink. */
export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** The narrowest and widest a stroke gets, as a multiple of its base width. */
export const MIN_PRESSURE_SCALE = 0.5;
export const MAX_PRESSURE_SCALE = 1.8;
/**
 * The pressure a device that reports none is recorded at. It has to land on a
 * multiplier of exactly 1 so a mouse draws at the width the user picked, which
 * is why the curve below is two straight pieces hinged at this value rather
 * than one line from 0.5 to 1.8.
 */
export const NEUTRAL_PRESSURE = 0.5;

/**
 * Pressure to width multiplier. A pen reporting 0 draws at half the base
 * width, one reporting 1 draws at 1.8 times it, and the resting 0.5 that
 * pressureless devices report draws at exactly the base width.
 *
 * InkCanvas.vue mirrors this curve for live canvas rendering rather than
 * importing it, so that a panel using the shared ink surface does not pull in
 * this tool (PROJECT.md rule 13). This module stays the source of truth: the
 * numbers here are locked by the tests next door.
 */
export function pressureScale(pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : NEUTRAL_PRESSURE;
  if (p <= NEUTRAL_PRESSURE) {
    return MIN_PRESSURE_SCALE + ((1 - MIN_PRESSURE_SCALE) * p) / NEUTRAL_PRESSURE;
  }
  return 1 + ((MAX_PRESSURE_SCALE - 1) * (p - NEUTRAL_PRESSURE)) / (1 - NEUTRAL_PRESSURE);
}

/** Width of one segment of a stroke, given the pressure at both ends. */
export function segmentWidth(stroke: Stroke, a: InkPoint, b: InkPoint, pressure = true): number {
  const base = Number.isFinite(stroke.baseWidth) && stroke.baseWidth > 0 ? stroke.baseWidth : 1;
  if (!pressure) return base;
  return base * pressureScale((a.p + b.p) / 2);
}

/* ------------------------------------------------------------------ */
/* smoothing                                                           */
/* ------------------------------------------------------------------ */

function point(x: number, y: number, p: number): InkPoint {
  return { x, y, p };
}

function midpoint(a: InkPoint, b: InkPoint): InkPoint {
  return point((a.x + b.x) / 2, (a.y + b.y) / 2, (a.p + b.p) / 2);
}

function quadratic(a: number, control: number, b: number, t: number): number {
  const inv = 1 - t;
  return inv * inv * a + 2 * inv * t * control + t * t * b;
}

/** How many samples each quadratic section is cut into by default. */
export const SMOOTH_STEPS = 6;

/**
 * Round a raw stroke off with the midpoint quadratic scheme every ink
 * renderer uses: the curve runs through the midpoint of each pair of samples
 * and bends around the sample between them. Raw pointer samples are a jagged
 * polyline; this turns them into something that reads as handwriting.
 *
 * The result is another point list rather than a path string, because a
 * variable width stroke has to be drawn as many short segments (neither
 * canvas nor SVG can taper a single path), and those segments need real
 * points. Pressure is carried along the same curve so width tapers too.
 *
 * Strokes of fewer than three points have no interior sample to bend around,
 * so they come back unchanged.
 */
export function smoothStroke(stroke: Stroke, steps: number = SMOOTH_STEPS): Stroke {
  const points = stroke.points ?? [];
  if (!Number.isFinite(steps) || steps < 1) {
    throw new ToolError(
      "invalid-steps",
      `A smoothing step count of ${String(steps)} cannot be sampled.`,
      "Use a whole number of steps, 1 or more. Around 6 is smooth without producing a huge file.",
    );
  }
  const cuts = Math.floor(steps);
  if (points.length < 3) return { ...stroke, points: points.map((q) => ({ ...q })) };

  const out: InkPoint[] = [{ ...points[0]! }];
  let start = midpoint(points[0]!, points[1]!);
  out.push({ ...start });

  for (let i = 1; i < points.length - 1; i += 1) {
    const control = points[i]!;
    const end = midpoint(control, points[i + 1]!);
    for (let step = 1; step <= cuts; step += 1) {
      const t = step / cuts;
      out.push(
        point(
          quadratic(start.x, control.x, end.x, t),
          quadratic(start.y, control.y, end.y, t),
          quadratic(start.p, control.p, end.p, t),
        ),
      );
    }
    start = end;
  }

  out.push({ ...points[points.length - 1]! });
  return { ...stroke, points: out };
}

/* ------------------------------------------------------------------ */
/* simplification                                                      */
/* ------------------------------------------------------------------ */

/** Perpendicular distance from `p` to the line through `a` and `b`. */
function lineDistance(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const area = Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y));
  return area / Math.hypot(dx, dy);
}

function rdp(points: InkPoint[], first: number, last: number, tolerance: number, keep: boolean[]) {
  let worst = -1;
  let worstIndex = -1;
  for (let i = first + 1; i < last; i += 1) {
    const d = lineDistance(points[i]!, points[first]!, points[last]!);
    if (d > worst) {
      worst = d;
      worstIndex = i;
    }
  }
  if (worstIndex === -1 || worst <= tolerance) return;
  keep[worstIndex] = true;
  rdp(points, first, worstIndex, tolerance, keep);
  rdp(points, worstIndex, last, tolerance, keep);
}

/**
 * Ramer Douglas Peucker: drop samples that sit within `tolerance` of the line
 * their neighbors already describe. A one second stroke arrives as a few
 * hundred coalesced samples, most of them redundant, and an SVG that keeps all
 * of them is large for no visible gain.
 *
 * A tolerance of 0 keeps every point. Endpoints are always kept, so a
 * simplified stroke starts and ends exactly where the pen did.
 */
export function simplifyStroke(stroke: Stroke, tolerance = 0.6): Stroke {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ToolError(
      "invalid-tolerance",
      `A simplify tolerance of ${String(tolerance)} is not a distance.`,
      "Use 0 or a positive number. Around 0.6 drops pointer jitter without visibly changing the line.",
    );
  }
  const points = stroke.points ?? [];
  if (points.length < 3 || tolerance === 0) {
    return { ...stroke, points: points.map((q) => ({ ...q })) };
  }
  const keep = points.map((_, i) => i === 0 || i === points.length - 1);
  rdp(points, 0, points.length - 1, tolerance, keep);
  return { ...stroke, points: points.filter((_, i) => keep[i]).map((q) => ({ ...q })) };
}

/* ------------------------------------------------------------------ */
/* bounds                                                              */
/* ------------------------------------------------------------------ */

function emptyBounds(): InkBounds {
  return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
}

function boundsOf(minX: number, minY: number, maxX: number, maxY: number): InkBounds {
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Box around one stroke, or null when it has no points. */
export function strokeBounds(stroke: Stroke): InkBounds | null {
  const points = stroke.points ?? [];
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of points) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return boundsOf(minX, minY, maxX, maxY);
}

/**
 * Box around every stroke. An empty drawing reports a zero sized box at the
 * origin rather than throwing, because callers ask for bounds to decide
 * whether there is anything to export.
 */
export function strokesBounds(strokes: Stroke[]): InkBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const stroke of strokes ?? []) {
    const box = strokeBounds(stroke);
    if (!box) continue;
    seen = true;
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  return seen ? boundsOf(minX, minY, maxX, maxY) : emptyBounds();
}

/** True when nothing has been drawn: no strokes, or strokes with no points. */
export function isEmptyInk(strokes: Stroke[]): boolean {
  for (const stroke of strokes ?? []) {
    if ((stroke.points?.length ?? 0) > 0) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

export interface SvgOptions {
  /** Blank space in user units around the ink. Default 8. */
  padding?: number;
  /** A CSS color painted behind the ink, or "transparent" for none. */
  background?: string;
  /** Vary the width of each segment by pressure. Default true. */
  pressure?: boolean;
  /** Round the raw samples off first. Default true. */
  smooth?: boolean;
  /** Ramer Douglas Peucker tolerance applied before smoothing. Default 0.6. */
  simplify?: number;
  /** Decimal places kept on every coordinate. Default 2. */
  decimals?: number;
}

function trim(n: number, decimals: number): string {
  const fixed = n.toFixed(decimals);
  // 12.50 and 12.00 are noise in a file with thousands of coordinates.
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a standalone SVG of the whole drawing.
 *
 * Width is carried per segment rather than per path, because SVG has no way
 * to taper one stroke: a pressure sensitive line is many short round capped
 * segments that happen to line up. Segments of a stroke share one group so
 * the color and cap style are written once.
 *
 * The viewBox comes from the ink itself plus `padding` plus half the widest
 * segment, so the round caps at the edge of the drawing are not clipped.
 */
export function strokesToSvg(strokes: Stroke[], opts: SvgOptions = {}): string {
  const list = (strokes ?? []).filter((s) => (s.points?.length ?? 0) > 0);
  if (list.length === 0) {
    throw new ToolError(
      "no-ink",
      "There is nothing drawn yet, so there is no SVG to build.",
      "Draw something on the pad first, then export it.",
    );
  }

  const decimals = Math.max(0, Math.min(6, Math.floor(opts.decimals ?? 2)));
  const usePressure = opts.pressure ?? true;
  const padding = Number.isFinite(opts.padding) ? Math.max(0, opts.padding!) : 8;
  const tolerance = opts.simplify ?? 0.6;

  const prepared = list.map((stroke) => {
    const reduced = simplifyStroke(stroke, tolerance);
    return (opts.smooth ?? true) ? smoothStroke(reduced) : reduced;
  });

  let widest = 0;
  const groups: string[] = [];
  for (const stroke of prepared) {
    const points = stroke.points;
    const parts: string[] = [];
    if (points.length === 1) {
      // A tap is a dot. A zero length path with round caps does not render
      // reliably, so it becomes an explicit circle instead.
      const only = points[0]!;
      const w = segmentWidth(stroke, only, only, usePressure);
      widest = Math.max(widest, w);
      parts.push(
        `<circle cx="${trim(only.x, decimals)}" cy="${trim(only.y, decimals)}" r="${trim(w / 2, decimals)}" fill="${escapeAttribute(stroke.color)}" stroke="none" />`,
      );
    } else {
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i]!;
        const b = points[i + 1]!;
        if (a.x === b.x && a.y === b.y) continue;
        const w = segmentWidth(stroke, a, b, usePressure);
        widest = Math.max(widest, w);
        parts.push(
          `<path d="M${trim(a.x, decimals)} ${trim(a.y, decimals)}L${trim(b.x, decimals)} ${trim(b.y, decimals)}" stroke-width="${trim(w, decimals)}" />`,
        );
      }
    }
    if (parts.length === 0) continue;
    groups.push(
      `<g fill="none" stroke="${escapeAttribute(stroke.color)}" stroke-linecap="round" stroke-linejoin="round">\n    ${parts.join("\n    ")}\n  </g>`,
    );
  }

  const box = strokesBounds(list);
  const inset = padding + widest / 2;
  const minX = box.minX - inset;
  const minY = box.minY - inset;
  const width = Math.max(box.width + inset * 2, widest);
  const height = Math.max(box.height + inset * 2, widest);

  const background =
    opts.background && opts.background !== "transparent"
      ? `\n  <rect x="${trim(minX, decimals)}" y="${trim(minY, decimals)}" width="${trim(width, decimals)}" height="${trim(height, decimals)}" fill="${escapeAttribute(opts.background)}" />`
      : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${trim(minX, decimals)} ${trim(minY, decimals)} ${trim(width, decimals)} ${trim(height, decimals)}" width="${trim(width, decimals)}" height="${trim(height, decimals)}">`,
    background,
    "\n  ",
    groups.join("\n  "),
    "\n</svg>\n",
  ].join("");
}

/* ------------------------------------------------------------------ */
/* save format                                                         */
/* ------------------------------------------------------------------ */

/** Bumped only when the shape below changes in a way older files cannot read. */
export const INK_DOCUMENT_VERSION = 1;

export interface InkDocument {
  version: number;
  strokes: Stroke[];
}

/**
 * Serialize a drawing so it can be saved and loaded back later. Versioned
 * from the start: an unversioned blob is indistinguishable from any other
 * JSON, and a reader that guesses is a reader that corrupts.
 */
export function strokesToJson(strokes: Stroke[], opts: { pretty?: boolean } = {}): string {
  const doc: InkDocument = {
    version: INK_DOCUMENT_VERSION,
    strokes: (strokes ?? []).map((stroke) => ({
      color: stroke.color,
      baseWidth: stroke.baseWidth,
      points: (stroke.points ?? []).map((q) => ({ x: q.x, y: q.y, p: q.p })),
    })),
  };
  return opts.pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
}

function readStroke(raw: unknown, index: number): Stroke {
  const bad = (detail: string): never => {
    throw new ToolError(
      "invalid-stroke",
      `Stroke ${index + 1} in that file ${detail}.`,
      "Load a file this pad saved. Editing one by hand is easy to get wrong.",
    );
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("is not an object");
  const stroke = raw as Partial<Stroke>;
  if (!Array.isArray(stroke.points)) return bad("has no list of points");
  const points: InkPoint[] = [];
  for (const item of stroke.points) {
    if (typeof item !== "object" || item === null) return bad("has a point that is not an object");
    const q = item as Partial<InkPoint>;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) {
      return bad("has a point whose x or y is not a number");
    }
    points.push({ x: q.x!, y: q.y!, p: Number.isFinite(q.p) ? q.p! : 0.5 });
  }
  return {
    points,
    color: typeof stroke.color === "string" && stroke.color ? stroke.color : "#000000",
    baseWidth:
      Number.isFinite(stroke.baseWidth) && (stroke.baseWidth as number) > 0
        ? (stroke.baseWidth as number)
        : 3,
  };
}

/** Read a saved drawing back, rejecting anything that is not one. */
export function strokesFromJson(json: string): Stroke[] {
  const text = (json ?? "").trim();
  if (text === "") {
    throw new ToolError(
      "empty-input",
      "That file is empty, so there is no drawing in it.",
      "Pick a JSON file this pad saved.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ToolError(
      "invalid-json",
      `That file is not valid JSON. ${e instanceof Error ? e.message : String(e)}`,
      "Pick a JSON file this pad saved, not an SVG or a PNG.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(
      "not-ink-document",
      "That JSON is not a saved drawing: the top level is not an object.",
      'A saved drawing looks like {"version":1,"strokes":[...]}.',
    );
  }
  const doc = parsed as Partial<InkDocument>;
  if (doc.version !== INK_DOCUMENT_VERSION) {
    throw new ToolError(
      "unsupported-version",
      `That drawing says it is version ${String(doc.version)}, and this pad reads version ${INK_DOCUMENT_VERSION}.`,
      "Open it in the version of this tool that wrote it, or export it again from there.",
    );
  }
  if (!Array.isArray(doc.strokes)) {
    throw new ToolError(
      "not-ink-document",
      "That drawing has no list of strokes.",
      'A saved drawing looks like {"version":1,"strokes":[...]}.',
    );
  }
  return doc.strokes.map(readStroke);
}

/* ------------------------------------------------------------------ */
/* generic shell fallback                                              */
/* ------------------------------------------------------------------ */

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The pad itself is a canvas, so the honest text answer is a description of
 * what the panel on this page does, plus a report on a saved drawing when one
 * is pasted in. Nothing here recognizes handwriting, and the copy says so
 * rather than leaving a reader to discover it.
 */
export function run(
  input: string = "",
  _opts: Record<string, unknown> = {},
): Record<string, string> {
  const text = (input ?? "").trim();
  if (text === "") {
    return {
      "Handwriting Pad":
        "A pressure aware drawing surface. Write or sketch with a stylus, a finger, or a mouse, and the line thickens and thins with how hard you press.",
      "Text recognition":
        "Not included. Turning ink into text needs a trained model, and no small one runs honestly in a browser tab, so this pad draws and exports instead of guessing at your words.",
      Exports:
        "SVG for a resolution independent line you can scale or edit, PNG at 1x or 2x for pasting into anything, and a JSON file that loads back into the pad.",
      Privacy: "Everything is drawn in this tab: your files and inputs never leave your device.",
    };
  }

  const strokes = strokesFromJson(text);
  const box = strokesBounds(strokes);
  const points = strokes.reduce((sum, s) => sum + s.points.length, 0);
  const colors = new Set(strokes.map((s) => s.color));
  return {
    Strokes: String(strokes.length),
    Points: String(points),
    Size: `${round(box.width)} x ${round(box.height)} units`,
    "Top left": `${round(box.minX)}, ${round(box.minY)}`,
    Colors: [...colors].join(", ") || "none",
  };
}

export default { run } satisfies ToolLogic<string, Record<string, string>>;
