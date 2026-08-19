import { ToolError, type ToolLogic } from "../types";

/**
 * The document model behind the screenshot annotator.
 *
 * Everything here is a pure function over plain data: a list of annotations,
 * an SVG serializer for them, and two pixel operations for the regions that
 * have to be destroyed rather than covered. The panel owns the canvas, the
 * pointer, and the export; this module owns what an annotation *is* and what
 * it looks like when drawn.
 *
 * Two deliberate choices are worth stating up front:
 *
 * 1. Arrow heads are explicit polygons, not SVG `<marker>` elements. A marker
 *    is resolved by the renderer at paint time, and browsers disagree about
 *    marker scaling when an SVG is rasterized through an image, so the burned
 *    in export could differ from the on screen preview. A polygon whose
 *    vertices are computed here rasterizes to exactly the same pixels
 *    everywhere.
 * 2. A blur annotation renders as a hatched placeholder rectangle carrying
 *    `data-kind="blur"`. SVG cannot blur a raster it does not contain, so the
 *    overlay marks where the blur goes and the panel runs the real pixel work
 *    with `blurRegionRgba` (or `pixelateRegionRgba`) before it composites the
 *    overlay on top.
 */

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

/** Every annotation kind the tool can draw, in the order the panel lists them. */
export const ANNOTATION_KINDS = [
  "arrow",
  "rect",
  "ellipse",
  "line",
  "text",
  "callout",
  "blur",
  "highlight",
  "freehand",
] as const;

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** Kinds whose shape is a polyline rather than a box. */
const POINT_KINDS: readonly AnnotationKind[] = ["arrow", "line", "freehand"];

/** A point in image pixel space, top left origin. */
export interface Point {
  x: number;
  y: number;
}

/** One drawn thing. `x/y/w/h` is always the bounding box, even for polylines. */
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present for arrow, line, and freehand. The path the user drew. */
  points?: Point[];
  color: string;
  strokeWidth: number;
  /** Label content for a text annotation. */
  text?: string;
  /** Explicit badge number for a callout. Omit to let the renderer number it. */
  number?: number;
  /** Label size in pixels for text and callout annotations. */
  fontSize?: number;
}

/** A whole annotation session: the canvas it was drawn on plus the items. */
export interface AnnotationDoc {
  width: number;
  height: number;
  items: Annotation[];
}

/** A box, possibly drawn backwards. `normalizeRect` sorts it out. */
export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What `createAnnotation` accepts: a box, a polyline, or a box plus a polyline. */
export interface Geometry {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: Point[];
}

/** The non geometric fields. Everything is optional and falls back to a default. */
export interface AnnotationStyle {
  id?: string;
  color?: string;
  strokeWidth?: number;
  text?: string;
  number?: number;
  fontSize?: number;
}

/**
 * Six stroke colors that stay legible on a white app screenshot and on a dark
 * terminal capture alike. They sit in the middle of the luminance range on
 * purpose: a pure yellow vanishes on light backgrounds and a navy vanishes on
 * dark ones, so neither is here.
 */
export const DEFAULT_COLORS: readonly string[] = [
  "#e5484d",
  "#f76b15",
  "#30a46c",
  "#0091ff",
  "#8e4ec6",
  "#e93d82",
];

/** Marker yellow. The default fill for a highlight, translucent when drawn. */
export const HIGHLIGHT_COLOR = "#ffe14d";

export const DEFAULT_STROKE_WIDTH = 4;
export const DEFAULT_FONT_SIZE = 18;

/** Ink for the text pill and the blur hatch. Neutral so it never reads as a stroke color. */
const PILL_FILL = "#0b0d10";
const HATCH_INK = "#5b6470";
const HATCH_ID = "sa-hatch";

const FONT_STACK = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/* ------------------------------------------------------------------ */
/* numbers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Round a coordinate to two decimals. Pointer coordinates arrive as floats
 * with a long tail, and rounding once on the way in is what makes
 * `serializeDoc(parseDoc(json))` byte stable: the serializer never rounds, so
 * it can never disagree with what it was handed.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Format a number for an SVG attribute without floating point dust. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Escape for both element content and attribute values. */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Sort a box drawn in any direction into one with a non negative width and
 * height. Dragging up and to the left produces negative `w` and `h` on the way
 * in, and nothing downstream should have to care which corner the drag
 * started from. Non finite values collapse to zero rather than poisoning the
 * whole document.
 */
export function normalizeRect(rect: RectLike): RectLike {
  const x1 = isFiniteNumber(rect?.x) ? rect.x : 0;
  const y1 = isFiniteNumber(rect?.y) ? rect.y : 0;
  const w = isFiniteNumber(rect?.w) ? rect.w : 0;
  const h = isFiniteNumber(rect?.h) ? rect.h : 0;
  const x2 = x1 + w;
  const y2 = y1 + h;
  return {
    x: round2(Math.min(x1, x2)),
    y: round2(Math.min(y1, y2)),
    w: round2(Math.abs(w)),
    h: round2(Math.abs(h)),
  };
}

/** Bounding box of a polyline. */
function boundsOf(points: Point[]): RectLike {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: round2(minX),
    y: round2(minY),
    w: round2(maxX - minX),
    h: round2(maxY - minY),
  };
}

/** Squared distance from a point to a segment. Used by hit testing. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ------------------------------------------------------------------ */
/* creation                                                            */
/* ------------------------------------------------------------------ */

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function kindList(): string {
  return ANNOTATION_KINDS.join(", ");
}

function readPoints(kind: AnnotationKind, raw: unknown): Point[] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new ToolError(
      "invalid-geometry",
      `A ${kind} needs at least two points.`,
      "Pass points as [{ x, y }, { x, y }] in image pixel coordinates.",
    );
  }
  const points: Point[] = [];
  for (const entry of raw) {
    const p = entry as Point | null;
    if (!p || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
      throw new ToolError(
        "invalid-geometry",
        `A ${kind} point must have finite x and y numbers.`,
        "Check for NaN, Infinity, or a missing coordinate in the points list.",
      );
    }
    points.push({ x: round2(p.x), y: round2(p.y) });
  }
  return points;
}

/** Radius a callout badge wants when the caller gave it no size of its own. */
function calloutRadius(fontSize: number): number {
  return Math.max(12, round2(fontSize * 0.95));
}

/** Padding between a text label and the edge of the pill behind it. */
function textPadding(fontSize: number): number {
  return Math.max(4, Math.round(fontSize * 0.35));
}

/** Rough advance width of a label, used to size the pill behind text. */
function measureText(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

/**
 * Build one annotation, validating the parts a bad drag or a hand edited
 * document can get wrong: the kind has to be known, and every coordinate has
 * to be a finite number. Style fields are lenient by design, since a missing
 * color or stroke width is a preference the tool can fill in, not an error the
 * user needs to fix.
 *
 * Box kinds are normalized, so a backwards drag is stored the same way as a
 * forwards one. Polyline kinds keep their points and gain the bounding box for
 * free, which is what hit testing and the panel's selection handles read.
 */
export function createAnnotation(
  kind: AnnotationKind | string,
  geometry: Geometry = {},
  style: AnnotationStyle = {},
): Annotation {
  if (!ANNOTATION_KINDS.includes(kind as AnnotationKind)) {
    throw new ToolError(
      "unknown-kind",
      `"${String(kind)}" is not an annotation kind.`,
      `Use one of: ${kindList()}.`,
    );
  }
  const k = kind as AnnotationKind;

  const strokeWidth = isFiniteNumber(style.strokeWidth)
    ? Math.max(1, Math.min(64, round2(style.strokeWidth)))
    : DEFAULT_STROKE_WIDTH;
  const fontSize = isFiniteNumber(style.fontSize)
    ? Math.max(8, Math.min(200, Math.round(style.fontSize)))
    : DEFAULT_FONT_SIZE;
  const color =
    typeof style.color === "string" && style.color.trim()
      ? style.color.trim()
      : k === "highlight"
        ? HIGHLIGHT_COLOR
        : DEFAULT_COLORS[0]!;

  const item: Annotation = {
    id: typeof style.id === "string" && style.id.trim() ? style.id.trim() : randomId(),
    kind: k,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    color,
    strokeWidth,
  };

  if (POINT_KINDS.includes(k)) {
    const points = readPoints(k, geometry.points);
    item.points = points;
    const box = boundsOf(points);
    item.x = box.x;
    item.y = box.y;
    item.w = box.w;
    item.h = box.h;
  } else {
    for (const key of ["x", "y", "w", "h"] as const) {
      const value = geometry[key];
      if (value !== undefined && !isFiniteNumber(value)) {
        throw new ToolError(
          "invalid-geometry",
          `A ${k} needs a finite ${key}, got ${String(value)}.`,
          "Pass numbers for x, y, w, and h in image pixel coordinates.",
        );
      }
    }
    const box = normalizeRect({
      x: geometry.x ?? 0,
      y: geometry.y ?? 0,
      w: geometry.w ?? 0,
      h: geometry.h ?? 0,
    });
    item.x = box.x;
    item.y = box.y;
    item.w = box.w;
    item.h = box.h;
  }

  if (k === "text") {
    item.text = typeof style.text === "string" ? style.text : "";
    item.fontSize = fontSize;
    // A click placed label arrives as a bare point. Store the pill the
    // renderer would draw, so hit testing covers the whole visible label
    // instead of the one corner the pointer landed on.
    if (item.w <= 0 || item.h <= 0) {
      const pad = textPadding(fontSize);
      item.w = round2(measureText(item.text, fontSize) + pad * 2);
      item.h = round2(fontSize * 1.4 + pad * 2);
    }
  }

  if (k === "callout") {
    item.fontSize = fontSize;
    if (isFiniteNumber(style.number)) item.number = Math.max(1, Math.round(style.number));
    // A tapped callout arrives with no size at all. Give it one so the rest of
    // the pipeline can treat every box kind identically.
    if (item.w <= 0 || item.h <= 0) {
      const r = calloutRadius(fontSize);
      item.x = round2(item.x - r);
      item.y = round2(item.y - r);
      item.w = round2(r * 2);
      item.h = round2(r * 2);
    }
  }

  return item;
}

/**
 * Shift one annotation by a delta, returning a new object. The bounding box
 * and every point move together; width and height never change, so a drag of
 * a selected item cannot quietly resize it.
 */
export function moveAnnotation(item: Annotation, dx: number, dy: number): Annotation {
  const ddx = isFiniteNumber(dx) ? dx : 0;
  const ddy = isFiniteNumber(dy) ? dy : 0;
  const moved: Annotation = {
    ...item,
    x: round2(item.x + ddx),
    y: round2(item.y + ddy),
  };
  if (item.points) {
    moved.points = item.points.map((p) => ({ x: round2(p.x + ddx), y: round2(p.y + ddy) }));
  }
  return moved;
}

/**
 * The next free callout badge number.
 *
 * This runs the renderer's own counter rather than only looking at explicit
 * numbers, because an unnumbered callout still gets a visible badge. Counting
 * only the explicit ones would hand the panel a number the document already
 * shows on screen.
 */
export function nextCalloutNumber(doc: AnnotationDoc): number {
  let highest = 0;
  for (const item of doc?.items ?? []) {
    if (item?.kind !== "callout") continue;
    const badge = isFiniteNumber(item.number) ? Math.trunc(item.number) : highest + 1;
    highest = Math.max(highest, badge);
  }
  return Math.max(1, highest + 1);
}

/* ------------------------------------------------------------------ */
/* hit testing                                                         */
/* ------------------------------------------------------------------ */

/** How far outside its own outline a shape still counts as clicked. */
function hitTolerance(item: Annotation): number {
  return Math.max(item.strokeWidth / 2, 4);
}

function hitsItem(item: Annotation, x: number, y: number): boolean {
  const tol = hitTolerance(item);

  if (item.kind === "arrow" || item.kind === "line" || item.kind === "freehand") {
    const points = item.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= tol) return true;
    }
    return false;
  }

  if (item.kind === "ellipse") {
    const rx = item.w / 2 + tol;
    const ry = item.h / 2 + tol;
    if (rx <= 0 || ry <= 0) return false;
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  if (item.kind === "callout") {
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    const r = Math.min(item.w, item.h) / 2 + tol;
    return Math.hypot(x - cx, y - cy) <= r;
  }

  return (
    x >= item.x - tol &&
    x <= item.x + item.w + tol &&
    y >= item.y - tol &&
    y <= item.y + item.h + tol
  );
}

/**
 * Which annotation is under the pointer. Later items paint over earlier ones,
 * so the search runs backwards and returns the topmost match, which is the one
 * the user can actually see at that spot. The item itself is returned, not a
 * copy, so the panel can hold it as the selection by identity.
 */
export function hitTest(doc: AnnotationDoc, x: number, y: number): Annotation | null {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const items = doc?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && hitsItem(item, x, y)) return item;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* serialization                                                       */
/* ------------------------------------------------------------------ */

/** Strip an annotation down to the fields that are actually set, in a fixed key order. */
function compactItem(item: Annotation): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    kind: item.kind,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    color: item.color,
    strokeWidth: item.strokeWidth,
  };
  if (item.points) out.points = item.points.map((p) => ({ x: p.x, y: p.y }));
  if (item.text !== undefined) out.text = item.text;
  if (item.number !== undefined) out.number = item.number;
  if (item.fontSize !== undefined) out.fontSize = item.fontSize;
  return out;
}

/**
 * The document as compact JSON: no indentation, no undefined keys, a fixed key
 * order. This is what the panel keeps in the URL fragment, so every wasted
 * byte is a shorter shareable link.
 */
export function serializeDoc(doc: AnnotationDoc): string {
  return JSON.stringify({
    width: doc.width,
    height: doc.height,
    items: (doc.items ?? []).map(compactItem),
  });
}

function badDoc(message: string, fix: string): ToolError {
  return new ToolError("bad-doc", message, fix);
}

function coerceItem(raw: unknown, index: number, defaults: AnnotationStyle): Annotation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badDoc(
      `Item ${index + 1} is not an object.`,
      "Every entry of items must be an annotation object with a kind.",
    );
  }
  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (typeof kind !== "string" || !ANNOTATION_KINDS.includes(kind as AnnotationKind)) {
    throw badDoc(
      `Item ${index + 1} has the unknown kind ${JSON.stringify(kind ?? null)}.`,
      `Use one of: ${kindList()}.`,
    );
  }

  const style: AnnotationStyle = {
    id: typeof source.id === "string" ? source.id : undefined,
    color: typeof source.color === "string" ? source.color : defaults.color,
    strokeWidth: isFiniteNumber(source.strokeWidth) ? source.strokeWidth : defaults.strokeWidth,
    fontSize: isFiniteNumber(source.fontSize) ? source.fontSize : defaults.fontSize,
    text: typeof source.text === "string" ? source.text : undefined,
    number: isFiniteNumber(source.number) ? source.number : undefined,
  };

  const geometry: Geometry = {
    x: source.x as number | undefined,
    y: source.y as number | undefined,
    w: source.w as number | undefined,
    h: source.h as number | undefined,
    points: source.points as Point[] | undefined,
  };

  return createAnnotation(kind as AnnotationKind, geometry, style);
}

/**
 * Read a serialized document back, rejecting anything the renderer could not
 * draw. Every failure carries the code "bad-doc" so a caller can branch once,
 * while the message says which part of the document is wrong.
 *
 * `defaults` fills in a missing color, stroke width, or font size, which is
 * how the panel's current style applies to a document written before that
 * option existed.
 */
export function parseDoc(json: string, defaults: AnnotationStyle = {}): AnnotationDoc {
  if (typeof json !== "string" || !json.trim()) {
    throw badDoc(
      "There is no document to read.",
      "Paste the annotation JSON, or draw something in the panel to generate it.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw badDoc(
      `That is not valid JSON: ${(error as Error).message}`,
      "Check for a trailing comma, a missing bracket, or smart quotes.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badDoc(
      "An annotation document must be a JSON object.",
      'It looks like { "width": 1280, "height": 720, "items": [] }.',
    );
  }

  const source = parsed as Record<string, unknown>;
  const width = source.width;
  const height = source.height;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw badDoc(
      "The document needs a positive width and height.",
      "Set width and height to the pixel size of the screenshot being annotated.",
    );
  }

  const rawItems = source.items;
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
    throw badDoc(
      "The items field must be an array of annotations.",
      "Use an empty array when nothing has been drawn yet.",
    );
  }

  const list = Array.isArray(rawItems) ? rawItems : [];
  return {
    width: Math.round(width),
    height: Math.round(height),
    items: list.map((raw, index) => coerceItem(raw, index, defaults)),
  };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/** Where a polyline kind starts and ends, falling back to the bounding box. */
function endpoints(item: Annotation): [Point, Point] {
  const points = item.points ?? [];
  const first = points[0] ?? { x: item.x, y: item.y };
  const last = points[points.length - 1] ?? { x: item.x + item.w, y: item.y + item.h };
  return [first, last];
}

/**
 * The three vertices of an arrow head plus the point where the shaft should
 * stop. Computing the head here rather than leaving it to an SVG `<marker>`
 * is what makes the rasterized export match the preview exactly.
 */
export function arrowHeadPolygon(
  from: Point,
  to: Point,
  strokeWidth: number,
): { head: Point[]; shaftEnd: Point } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 0.01) return null;

  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.min(length, Math.max(8, strokeWidth * 3.2));
  const halfWidth = headLength * 0.55;

  const baseX = to.x - ux * headLength;
  const baseY = to.y - uy * headLength;
  // Perpendicular of the direction vector.
  const px = -uy;
  const py = ux;

  return {
    head: [
      { x: to.x, y: to.y },
      { x: baseX + px * halfWidth, y: baseY + py * halfWidth },
      { x: baseX - px * halfWidth, y: baseY - py * halfWidth },
    ],
    // Stop the shaft at the head's base so a thick line never poked past the tip.
    shaftEnd: { x: baseX, y: baseY },
  };
}

/**
 * Turn a hand drawn point list into a smooth path using Catmull-Rom tangents
 * converted to cubic beziers. Duplicating the first and last point gives the
 * curve well defined tangents at the ends, so the stroke starts and stops
 * exactly where the pointer did instead of overshooting.
 */
export function freehandPath(points: Point[]): string {
  if (!points || points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0]!;
    return `M ${n(only.x)} ${n(only.y)}`;
  }
  if (points.length === 2) {
    return `M ${n(points[0]!.x)} ${n(points[0]!.y)} L ${n(points[1]!.x)} ${n(points[1]!.y)}`;
  }

  const parts = [`M ${n(points[0]!.x)} ${n(points[0]!.y)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    parts.push(`C ${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(p2.x)} ${n(p2.y)}`);
  }
  return parts.join(" ");
}

function renderText(item: Annotation): string {
  const fontSize = item.fontSize ?? DEFAULT_FONT_SIZE;
  const label = (item.text ?? "").replace(/[\r\n]+/g, " ");
  const pad = textPadding(fontSize);
  const pillW = item.w > 0 ? item.w : round2(measureText(label, fontSize) + pad * 2);
  const pillH = item.h > 0 ? item.h : round2(fontSize * 1.4 + pad * 2);
  const baseline = item.y + pad + fontSize;
  return (
    `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(pillW)}" height="${n(pillH)}" rx="${n(pad)}" ` +
    `fill="${esc(PILL_FILL)}" fill-opacity="0.72" data-kind="text-pill"/>` +
    `<text x="${n(item.x + pad)}" y="${n(baseline)}" font-family="${esc(FONT_STACK)}" ` +
    `font-size="${n(fontSize)}" font-weight="600" fill="${esc(item.color)}" ` +
    `data-kind="text">${esc(label)}</text>`
  );
}

function renderCallout(item: Annotation, badge: number): string {
  const fontSize = item.fontSize ?? DEFAULT_FONT_SIZE;
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const r = item.w > 0 && item.h > 0 ? Math.min(item.w, item.h) / 2 : calloutRadius(fontSize);
  const labelSize = Math.max(10, Math.min(fontSize, r * 1.2));
  return (
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${esc(item.color)}" ` +
    `stroke="#ffffff" stroke-width="${n(Math.max(1, item.strokeWidth / 2))}" data-kind="callout"/>` +
    `<text x="${n(cx)}" y="${n(cy + labelSize * 0.35)}" text-anchor="middle" ` +
    `font-family="${esc(FONT_STACK)}" font-size="${n(labelSize)}" font-weight="700" ` +
    `fill="#ffffff" data-kind="callout-number">${badge}</text>`
  );
}

function renderItem(item: Annotation, badge: number): string {
  const stroke = `stroke="${esc(item.color)}" stroke-width="${n(item.strokeWidth)}"`;

  switch (item.kind) {
    case "arrow": {
      const [from, to] = endpoints(item);
      const geometry = arrowHeadPolygon(from, to, item.strokeWidth);
      if (!geometry) {
        return (
          `<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" ` +
          `${stroke} stroke-linecap="round" fill="none" data-kind="arrow"/>`
        );
      }
      const head = geometry.head.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");
      return (
        `<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(geometry.shaftEnd.x)}" ` +
        `y2="${n(geometry.shaftEnd.y)}" ${stroke} stroke-linecap="round" fill="none" ` +
        `data-kind="arrow"/>` +
        `<polygon points="${head}" fill="${esc(item.color)}" data-kind="arrow-head"/>`
      );
    }

    case "line": {
      const [from, to] = endpoints(item);
      return (
        `<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" ` +
        `${stroke} stroke-linecap="round" fill="none" data-kind="line"/>`
      );
    }

    case "rect":
      return (
        `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" ` +
        `rx="${n(Math.min(6, item.strokeWidth))}" fill="none" ${stroke} data-kind="rect"/>`
      );

    case "ellipse":
      return (
        `<ellipse cx="${n(item.x + item.w / 2)}" cy="${n(item.y + item.h / 2)}" ` +
        `rx="${n(item.w / 2)}" ry="${n(item.h / 2)}" fill="none" ${stroke} data-kind="ellipse"/>`
      );

    case "highlight":
      return (
        `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" ` +
        `fill="${esc(item.color)}" fill-opacity="0.35" stroke="none" data-kind="highlight"/>`
      );

    case "blur":
      // A placeholder, not the effect. SVG has no access to the raster under
      // it, so the panel destroys these pixels with blurRegionRgba before it
      // paints the overlay, and this rectangle only says where.
      return (
        `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" ` +
        `fill="url(#${HATCH_ID})" stroke="${esc(HATCH_INK)}" stroke-width="1" ` +
        `data-kind="blur" data-placeholder="true"/>`
      );

    case "freehand":
      return (
        `<path d="${freehandPath(item.points ?? [])}" fill="none" ${stroke} ` +
        `stroke-linecap="round" stroke-linejoin="round" data-kind="freehand"/>`
      );

    case "text":
      return renderText(item);

    case "callout":
      return renderCallout(item, badge);

    default:
      return "";
  }
}

/**
 * Serialize the annotations, and only the annotations, as an SVG with a
 * transparent background. Composited over the screenshot it is the finished
 * markup; on its own it is a clean overlay that can be saved, diffed, or
 * re-rendered at any scale.
 *
 * Callouts number themselves in document order when they carry no explicit
 * number, and an explicit number pushes the running counter past it, so a
 * mixed document never repeats a badge.
 */
export function renderSvgOverlay(doc: AnnotationDoc): string {
  const width = Math.max(1, Math.round(isFiniteNumber(doc?.width) ? doc.width : 1));
  const height = Math.max(1, Math.round(isFiniteNumber(doc?.height) ? doc.height : 1));
  const items = doc?.items ?? [];

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" data-annotations="${items.length}">`,
  ];

  if (items.some((item) => item?.kind === "blur")) {
    parts.push(
      `<defs><pattern id="${HATCH_ID}" width="8" height="8" patternUnits="userSpaceOnUse" ` +
        `patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" ` +
        `stroke="${esc(HATCH_INK)}" stroke-width="3" stroke-opacity="0.55"/></pattern></defs>`,
    );
  }

  let badge = 0;
  for (const item of items) {
    if (!item) continue;
    let current = 0;
    if (item.kind === "callout") {
      current = isFiniteNumber(item.number) ? Math.trunc(item.number) : badge + 1;
      badge = Math.max(badge, current);
    }
    parts.push(renderItem(item, current));
  }

  parts.push("</svg>");
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* pixel operations                                                    */
/* ------------------------------------------------------------------ */

function clampRegion(rect: RectLike, width: number, height: number): RectLike | null {
  if (!(width > 0) || !(height > 0)) return null;
  const box = normalizeRect(rect);
  const left = Math.max(0, Math.min(width, Math.round(box.x)));
  const top = Math.max(0, Math.min(height, Math.round(box.y)));
  const right = Math.max(0, Math.min(width, Math.round(box.x + box.w)));
  const bottom = Math.max(0, Math.min(height, Math.round(box.y + box.h)));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  return { x: left, y: top, w, h };
}

/**
 * Box blur a rectangle of an RGBA buffer, returning a new buffer. The source
 * is never mutated, so the panel can keep one pristine copy of the decoded
 * screenshot and replay the whole region list from it on every redraw.
 *
 * Sampling is clamped to the rectangle rather than to the whole image, which
 * means the blur is self contained: no color from outside the selection bleeds
 * in, and every pixel outside it is byte identical to the input. Two separable
 * passes (horizontal then vertical) give a tent shaped kernel that looks much
 * softer than a single box pass at the same radius.
 *
 * A blur is not redaction. Enough of the original signal survives that text can
 * sometimes be reconstructed, so use it to de-emphasize, and use a solid fill
 * when the content must be unrecoverable.
 */
export function blurRegionRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  rect: RectLike,
  radius: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const box = clampRegion(rect, width, height);
  if (!box) return out;

  const r = Math.max(1, Math.round(isFiniteNumber(radius) ? radius : 1));
  const { x: bx, y: by, w: bw, h: bh } = box;
  const temp = new Float64Array(bw * bh * 4);

  // Horizontal pass: read the copy, write the scratch buffer.
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;
      const from = Math.max(0, x - r);
      const to = Math.min(bw - 1, x + r);
      for (let k = from; k <= to; k++) {
        const i = ((by + y) * width + (bx + k)) * 4;
        sr += out[i]!;
        sg += out[i + 1]!;
        sb += out[i + 2]!;
        sa += out[i + 3]!;
        count++;
      }
      const t = (y * bw + x) * 4;
      temp[t] = sr / count;
      temp[t + 1] = sg / count;
      temp[t + 2] = sb / count;
      temp[t + 3] = sa / count;
    }
  }

  // Vertical pass: read the scratch buffer, write the output.
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;
      const from = Math.max(0, y - r);
      const to = Math.min(bh - 1, y + r);
      for (let k = from; k <= to; k++) {
        const t = (k * bw + x) * 4;
        sr += temp[t]!;
        sg += temp[t + 1]!;
        sb += temp[t + 2]!;
        sa += temp[t + 3]!;
        count++;
      }
      const i = ((by + y) * width + (bx + x)) * 4;
      out[i] = Math.round(sr / count);
      out[i + 1] = Math.round(sg / count);
      out[i + 2] = Math.round(sb / count);
      out[i + 3] = Math.round(sa / count);
    }
  }

  return out;
}

/**
 * Replace a rectangle with the average color of each block, returning a new
 * buffer. Blocks are anchored at the rectangle's top left corner and clipped
 * to it, so an edge block never averages pixels the user did not select and
 * nothing outside the rectangle is touched.
 */
export function pixelateRegionRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  rect: RectLike,
  block: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const box = clampRegion(rect, width, height);
  if (!box) return out;

  const size = Math.max(1, Math.round(isFiniteNumber(block) ? block : 1));

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
          sr += out[i]!;
          sg += out[i + 1]!;
          sb += out[i + 2]!;
          sa += out[i + 3]!;
          i += 4;
        }
      }

      const count = bw * bh;
      const ar = Math.round(sr / count);
      const ag = Math.round(sg / count);
      const ab = Math.round(sb / count);
      const aa = Math.round(sa / count);

      for (let y = by; y < by + bh; y++) {
        let i = (y * width + bx) * 4;
        for (let x = 0; x < bw; x++) {
          out[i] = ar;
          out[i + 1] = ag;
          out[i + 2] = ab;
          out[i + 3] = aa;
          i += 4;
        }
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface AnnotatorOpts {
  /** Stroke color applied to items in the document that carry none. */
  color?: string;
  /** Stroke width applied to items that carry none. */
  strokeWidth?: number;
  /** Label size applied to text and callout items that carry none. */
  fontSize?: number;
  /** Whether the panel burns blur regions in as a blur or as pixel blocks. */
  blurStyle?: "blur" | "pixelate";
  /** Blur radius in pixels. */
  blurRadius?: number;
  /** Pixelate block edge in pixels. */
  pixelBlock?: number;
  /** Export container for the burned in image. */
  format?: "png" | "jpeg";
  [key: string]: unknown;
}

export type AnnotatorResult = Record<string, string>;

const SHORTCUTS =
  "A arrow, R rect, E ellipse, T text, C callout, B blur, H highlight, F freehand, Delete removes selection, Ctrl+Z undo.";

const PANEL_NOTE =
  "Annotating happens in the panel above: drop or paste a screenshot, pick a tool, and draw on it. This box holds the document that describes those annotations, so paste one here to inspect or re-render it.";

/** Count the items of each kind, in the tool's own kind order for a stable string. */
function countByKind(items: Annotation[]): string {
  const counts = new Map<AnnotationKind, number>();
  for (const item of items) {
    if (!item) continue;
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const kind of ANNOTATION_KINDS) {
    const count = counts.get(kind);
    if (count) parts.push(`${kind} ${count}`);
  }
  return parts.length ? parts.join(", ") : "nothing drawn yet";
}

export function run(input: string, opts: AnnotatorOpts = {}): AnnotatorResult {
  const text = typeof input === "string" ? input.trim() : "";

  if (!text) {
    return {
      Note: PANEL_NOTE,
      Shortcuts: SHORTCUTS,
    };
  }

  const defaults: AnnotationStyle = {
    color: typeof opts.color === "string" && opts.color.trim() ? opts.color.trim() : undefined,
    strokeWidth: isFiniteNumber(opts.strokeWidth) ? opts.strokeWidth : undefined,
    fontSize: isFiniteNumber(opts.fontSize) ? opts.fontSize : undefined,
  };

  const doc = parseDoc(text, defaults);

  return {
    Canvas: `${doc.width} x ${doc.height} px`,
    Annotations: String(doc.items.length),
    "By kind": countByKind(doc.items),
    "Next callout number": String(nextCalloutNumber(doc)),
    "SVG overlay": renderSvgOverlay(doc),
  };
}

export default { run } satisfies ToolLogic<string, AnnotatorResult, AnnotatorOpts>;
