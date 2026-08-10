import {
  BANDS,
  VISIBLE_MAX_NM,
  VISIBLE_MIN_NM,
  flattenBands,
  formatFrequency,
  frequencyToPosition,
  positionToFrequency,
  rgbToHex,
  wavelengthNmToRgb,
  type Band,
} from "./index";

/**
 * Electromagnetic Spectrum: the drawing geometry.
 *
 * Rule 27 splits a tool into a pure logic layer and a UI that executes it. This
 * module is the half of the renderer that is arithmetic rather than painting:
 * where each band sits, which labels survive at the current zoom, what color a
 * lane gets, and the scene description that the live canvas, the PNG export and
 * the SVG export all draw from. Nothing here touches a canvas context, an event
 * or a Vue ref, so every rule below is unit tested and the three surfaces cannot
 * drift apart.
 *
 * Coordinates: a normalized axis position (0 at the gamma end, 1 at the ELF end,
 * per frequencyToPosition) maps to a pixel along the long dimension of the map.
 * The short dimension is divided into equal lanes. Orientation decides only
 * which screen axis is which, so everything here works in "axis pixels" and the
 * caller swaps x for y.
 *
 * Imports run one way: data.ts, then index.ts, then this module.
 */

/** Which screen axis carries frequency. */
export type Orientation = "horizontal" | "vertical";

/* ------------------------------------------------------------------ */
/* Lane packing                                                        */
/* ------------------------------------------------------------------ */

/**
 * A band placed into a specific stacked sub-lane. Lanes are grouped by tree
 * depth (all depth 0 lanes first, then depth 1, and so on), so a child always
 * sits below its parent and nests visually under it.
 */
export interface PackedBand {
  band: Band;
  depth: number;
  lane: number;
}

/** The packing result: every band's row, and how many rows the map needs. */
export interface PackedBands {
  packed: PackedBand[];
  totalLanes: number;
}

/**
 * Greedy interval packing per depth level. Within a depth, bands are sorted by
 * their low frequency edge and each is placed in the first sub-lane whose last
 * placed band ends at or before this band starts; otherwise a new sub-lane
 * opens. Sibling bands that overlap in frequency (the 2.4 GHz ISM band, whose
 * Wi-Fi, Bluetooth, Zigbee and oven children all overlap) land in separate
 * stacked rows instead of colliding. Bands that only touch at an exact shared
 * edge (a clean partition, for example the color bands) still share one lane.
 *
 * Sorting by low edge is what makes the greedy pass optimal here: it is the
 * classic interval partitioning argument, so the lane count this returns is the
 * smallest possible for the ranges at that depth.
 *
 * The packing depends only on the static band ranges, never on the view, so a
 * caller computes it once. The result drives both the total lane count (which
 * grows automatically as the data gains depth) and each band's row.
 */
export function packBands(bands: Band[] = BANDS): PackedBands {
  const flat = flattenBands(bands);
  const byDepth = new Map<number, Band[]>();
  for (const { band, depth } of flat) {
    const arr = byDepth.get(depth);
    if (arr) arr.push(band);
    else byDepth.set(depth, [band]);
  }

  const packed: PackedBand[] = [];
  let laneCursor = 0;
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const level = byDepth
      .get(depth)!
      .slice()
      .sort((a, b) => a.fLow - b.fLow);

    // Depth 0 (Gamma, X-rays, Ultraviolet, Visible, Infrared, Microwave, Radio)
    // is conceptually a partition, so it always occupies a single lane. The tiny
    // UV / Visible overlap (the 380 to 400 nm sliver) double-draws an
    // imperceptible region rather than bumping Ultraviolet onto a second lane and
    // leaving a gap in the top row. Sub-lane packing applies only at depth >= 1.
    if (depth === 0) {
      for (const band of level) packed.push({ band, depth, lane: laneCursor });
      laneCursor += 1;
      continue;
    }

    // The highest fHigh placed so far in each sub-lane at this depth.
    const laneEnds: number[] = [];
    for (const band of level) {
      // A tiny relative slack so a band that starts exactly where another ends
      // (a shared partition edge) still counts as non overlapping.
      const startSlack = band.fLow * (1 + 1e-9);
      let slot = laneEnds.findIndex((end) => end <= startSlack);
      if (slot === -1) {
        slot = laneEnds.length;
        laneEnds.push(band.fHigh);
      } else {
        laneEnds[slot] = band.fHigh;
      }
      packed.push({ band, depth, lane: laneCursor + slot });
    }
    laneCursor += laneEnds.length;
  }
  return { packed, totalLanes: laneCursor };
}

/** Target lane thickness (CSS px) along the cross axis, for readable labels. */
export const LANE_TARGET_PX = 38;
/** Hard cap on the horizontal map height so a deep tree cannot overrun a page. */
export const MAP_HEIGHT_CAP = 660;
/** Floor on the horizontal map height, so a shallow tree still reads as a map. */
export const MAP_HEIGHT_FLOOR = 300;

/**
 * The horizontal map height in CSS px: tall enough to give every packed lane its
 * target thickness (plus the tick strip), floored and capped for sane page
 * layout. Driven by the lane count rather than a fixed number so adding depth to
 * the band tree grows the map instead of crushing every row.
 */
export function mapHeightPx(totalLanes: number): number {
  return Math.min(
    MAP_HEIGHT_CAP,
    Math.max(MAP_HEIGHT_FLOOR, totalLanes * LANE_TARGET_PX + TICK_MARGIN_H),
  );
}

/* ------------------------------------------------------------------ */
/* View window and axis coordinates                                    */
/* ------------------------------------------------------------------ */

/** Narrowest allowed view span, normalized. ~0.036 decade, below FM width. */
export const MIN_SPAN = 0.0015;

/** Which slice of the axis is on screen. */
export interface ViewWindow {
  /** Center of the window, a normalized axis position in 0..1. */
  center: number;
  /** Visible fraction of the whole axis, in MIN_SPAN..1. */
  span: number;
}

/** A view window projected onto a concrete pixel length. */
export interface AxisView extends ViewWindow {
  /** Axis length in CSS px: the width when horizontal, the height when vertical. */
  lengthPx: number;
}

/**
 * Hold the window inside the axis: clamp the span to the zoom limits first, then
 * pull the center in far enough that neither edge of the window falls off the
 * modeled range. Span is clamped first because the legal center range depends on
 * the final span, so doing it the other way round can still leave the window
 * hanging off an end.
 */
export function clampWindow(window: ViewWindow): ViewWindow {
  const span = Math.min(1, Math.max(MIN_SPAN, window.span));
  const half = span / 2;
  return { center: Math.min(1 - half, Math.max(half, window.center)), span };
}

/** Axis length in CSS px for a map of this size and orientation. */
export function axisLengthPx(width: number, height: number, orientation: Orientation): number {
  return orientation === "horizontal" ? width : height;
}

/** The normalized axis position at pixel 0, the leading edge of the window. */
export function viewStartPos(window: ViewWindow): number {
  return window.center - window.span / 2;
}

/** Normalized axis position (0..1 full range) to a pixel along the axis. */
export function posToAxisPx(pos: number, view: AxisView): number {
  return ((pos - viewStartPos(view)) / view.span) * view.lengthPx;
}

/** Inverse: an axis pixel to a normalized axis position. */
export function axisPxToPos(px: number, view: AxisView): number {
  return viewStartPos(view) + (px / view.lengthPx) * view.span;
}

/** The axis pixel for a given frequency, in the current view. */
export function freqToAxisPx(freqHz: number, view: AxisView): number {
  return posToAxisPx(frequencyToPosition(freqHz), view);
}

/** The frequency in hertz at an axis pixel, in the current view. */
export function axisPxToFreq(px: number, view: AxisView): number {
  return positionToFrequency(axisPxToPos(px, view));
}

/** Hold a pixel inside the drawn axis, so a readout never runs off the end. */
export function clampAxisPx(px: number, view: AxisView): number {
  return Math.max(0, Math.min(view.lengthPx, px));
}

/**
 * The center that keeps `anchorPos` sitting under pixel `px` at the view's
 * current span. This is what makes ctrl and scroll zoom and pinch zoom feel
 * anchored: the caller changes the span first, then recenters so the frequency
 * the user pointed at has not moved. The result still needs clampWindow.
 */
export function centerHoldingAnchor(anchorPos: number, px: number, view: AxisView): number {
  return anchorPos - (px / view.lengthPx) * view.span + view.span / 2;
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

/** The theme colors the renderer needs, read from CSS variables by the panel. */
export interface SceneColors {
  fg: string;
  muted: string;
  border: string;
  card: string;
  primary: string;
  positive: string;
}

/**
 * Parse "#rrggbb" (or shorthand) to an rgba() string with the given alpha.
 * Canvas and SVG both take rgba() but neither can resolve a CSS variable or a
 * Tailwind opacity modifier, so tinting has to happen numerically here.
 */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * The background fill for a band cell. Visible sub-bands keep their real color
 * swatch; every other cell gets a low-opacity violet-brand tint that deepens
 * with depth, so each cell (including the top-level row) reads as a discrete box
 * against the card surface, and label text keeps AA contrast in both themes.
 */
export function laneFill(depth: number, band: Band, brandHex: string): string {
  if (band.color) return band.color;
  const alpha = depth === 0 ? 0.1 : depth === 1 ? 0.16 : depth === 2 ? 0.22 : 0.28;
  return withAlpha(brandHex, alpha);
}

/** One stop of the visible-light gradient: 0..1 along the band, and its color. */
export interface SpectralStop {
  offset: number;
  color: string;
}

/**
 * Color stops across the visible band, violet at offset 0 (the high frequency
 * start of the axis) through red at offset 1. Sampling is what makes this work
 * at all: the wavelength to sRGB curve is piecewise and non linear, so two stops
 * would draw a flat violet-to-red ramp with no green in it. 24 steps is past the
 * point where more stops change what a viewer sees.
 */
export function spectralStops(steps = 24): SpectralStop[] {
  const out: SpectralStop[] = [];
  for (let i = 0; i <= steps; i++) {
    const nm = VISIBLE_MIN_NM + ((VISIBLE_MAX_NM - VISIBLE_MIN_NM) * i) / steps;
    const rgb = wavelengthNmToRgb(nm);
    if (rgb) out.push({ offset: i / steps, color: rgbToHex(rgb) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/**
 * Approximate whether a label fits a box `maxPx` wide, truncating with an
 * ellipsis if needed and returning null when even a truncation would be
 * meaningless. The width estimate is character count times an average advance
 * rather than a real text measurement, because the scene is built for three
 * surfaces (live canvas, PNG, SVG) and only one of them can measure text. The
 * factor 0.58 em is close for the UI sans stack at the sizes used here, and
 * erring narrow only costs an early ellipsis.
 */
export function fitLabel(text: string, maxPx: number, size: number): string | null {
  const charPx = size * 0.58;
  const maxChars = Math.floor((maxPx - 6) / charPx);
  if (maxChars >= text.length) return text;
  if (maxChars < 3) return null;
  return text.slice(0, maxChars - 1) + "…";
}

/* ------------------------------------------------------------------ */
/* Scene description (shared by canvas, PNG and SVG)                   */
/* ------------------------------------------------------------------ */

export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  /** Present for the visible band: a spectral gradient vector and stops. */
  spectral?: { x1: number; y1: number; x2: number; y2: number };
}
export interface SceneText {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  align: "center" | "start";
  plate?: { x: number; y: number; w: number; h: number };
}
export interface SceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dash: boolean;
  width: number;
}
export interface Scene {
  rects: SceneRect[];
  lines: SceneLine[];
  /** Tick labels, always painted on the live canvas. */
  texts: SceneText[];
  /** Band labels, painted on canvas only for export (live uses a DOM overlay). */
  bandTexts: SceneText[];
  w: number;
  h: number;
}

/** Cross-axis room reserved for the frequency tick strip, per orientation. */
export const TICK_MARGIN_H = 26;
export const TICK_MARGIN_V = 58;

/** Everything buildScene needs. All of it is plain data, none of it reactive. */
export interface SceneInput {
  width: number;
  height: number;
  orientation: Orientation;
  /** The view window; the axis length comes from width, height and orientation. */
  window: ViewWindow;
  packed: PackedBand[];
  totalLanes: number;
  colors: SceneColors;
  /** The locked readout frequency, drawn as a dashed marker. Null when unlocked. */
  pinnedFreqHz: number | null;
  /** The live cursor frequency, drawn solid. Null when the pointer is away. */
  cursorFreqHz: number | null;
}

/**
 * Describe the whole chart as flat lists of rectangles, lines and text at CSS
 * pixel coordinates. Nothing is painted here: the live canvas, the doubled
 * resolution PNG and the SVG serializer all consume this same description, which
 * is the only reason an export is guaranteed to match what is on screen.
 */
export function buildScene(input: SceneInput): Scene {
  const { width: w, height: h, orientation, packed, totalLanes, colors } = input;
  const horizontal = orientation === "horizontal";
  const L = axisLengthPx(w, h, orientation);
  const view: AxisView = { ...input.window, lengthPx: L };
  const tickMargin = horizontal ? TICK_MARGIN_H : TICK_MARGIN_V;
  const lanesExtent = (horizontal ? h : w) - tickMargin;
  const laneSize = lanesExtent / totalLanes;

  const rects: SceneRect[] = [];
  const texts: SceneText[] = [];
  const bandTexts: SceneText[] = [];
  const lines: SceneLine[] = [];

  // Lane origin along the cross axis. Ticks sit after the lanes.
  const laneBase = horizontal ? 0 : tickMargin;

  for (const { band, depth, lane } of packed) {
    const a0 = posToAxisPx(frequencyToPosition(band.fHigh), view); // start (high freq)
    const a1 = posToAxisPx(frequencyToPosition(band.fLow), view); // end (low freq)
    if (a1 < 0 || a0 > L) continue;
    const s0 = Math.max(0, a0);
    const s1 = Math.min(L, a1);
    const wpx = s1 - s0;
    if (wpx < 0.5) continue;

    const laneOff = laneBase + lane * laneSize;
    const rx = horizontal ? s0 : laneOff;
    const ry = horizontal ? laneOff : s0;
    const rw = horizontal ? wpx : laneSize;
    const rh = horizontal ? laneSize : wpx;

    const isVisible = band.id === "visible";
    const colored = !!band.color;
    const fill = laneFill(depth, band, colors.primary);

    const rect: SceneRect = { x: rx, y: ry, w: rw, h: rh, fill, stroke: colors.border };
    if (isVisible) {
      // Spectral gradient runs violet (start, high freq) to red (end, low freq).
      rect.spectral = horizontal
        ? { x1: a0, y1: 0, x2: a1, y2: 0 }
        : { x1: 0, y1: a0, x2: 0, y2: a1 };
    }
    rects.push(rect);

    // Band label for export only: centered, skipped when it cannot fit.
    const size = depth === 0 ? 13 : 11;
    const maxPx = horizontal ? wpx : laneSize;
    const label = fitLabel(band.name, maxPx, size);
    if (label && (horizontal ? wpx : rh) > size * 1.4) {
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      const needPlate = isVisible || colored;
      const textW = label.length * size * 0.58;
      bandTexts.push({
        x: cx,
        y: cy,
        text: label,
        color: colors.fg,
        size,
        align: "center",
        plate: needPlate
          ? { x: cx - textW / 2 - 4, y: cy - size / 2 - 2, w: textW + 8, h: size + 4 }
          : undefined,
      });
    }
  }

  // Frequency ticks: decade lines, plus 2 and 5 subticks when zoomed in.
  const lowFreq = axisPxToFreq(L, view);
  const highFreq = axisPxToFreq(0, view);
  const decadesInView = Math.log10(highFreq / lowFreq);
  const mantissas = decadesInView < 6 ? [1, 2, 5] : [1];
  const kMin = Math.floor(Math.log10(lowFreq));
  const kMax = Math.ceil(Math.log10(highFreq));
  const tickColor = colors.border;
  for (let k = kMin; k <= kMax; k++) {
    for (const mant of mantissas) {
      const f = mant * Math.pow(10, k);
      if (f < lowFreq * 0.999 || f > highFreq * 1.001) continue;
      const apx = posToAxisPx(frequencyToPosition(f), view);
      if (apx < 0 || apx > L) continue;
      if (horizontal) {
        lines.push({
          x1: apx,
          y1: 0,
          x2: apx,
          y2: lanesExtent,
          color: tickColor,
          dash: false,
          width: 1,
        });
        texts.push({
          x: apx + 3,
          y: lanesExtent + 15,
          text: formatFrequency(f),
          color: colors.muted,
          size: 10,
          align: "start",
        });
      } else {
        lines.push({
          x1: tickMargin,
          y1: apx,
          x2: w,
          y2: apx,
          color: tickColor,
          dash: false,
          width: 1,
        });
        texts.push({
          x: 4,
          y: apx + 12,
          text: formatFrequency(f),
          color: colors.muted,
          size: 10,
          align: "start",
        });
      }
    }
  }

  // Locked marker (dashed) and the live cursor (solid).
  const marker = (freq: number, color: string, dash: boolean) => {
    const apx = posToAxisPx(frequencyToPosition(freq), view);
    if (apx < -1 || apx > L + 1) return;
    if (horizontal) lines.push({ x1: apx, y1: 0, x2: apx, y2: lanesExtent, color, dash, width: 2 });
    else lines.push({ x1: tickMargin, y1: apx, x2: w, y2: apx, color, dash, width: 2 });
  };
  if (input.pinnedFreqHz != null) marker(input.pinnedFreqHz, colors.positive, true);
  const cur = input.cursorFreqHz;
  if (cur != null && cur !== input.pinnedFreqHz) marker(cur, colors.primary, false);

  return { rects, lines, texts, bandTexts, w, h };
}

/* ------------------------------------------------------------------ */
/* DOM band-label overlay geometry                                     */
/* ------------------------------------------------------------------ */

/** Minimum drawn extents (CSS px) before a band's full label is shown. */
export const MIN_LABEL_ALONG = 30;
export const MIN_LABEL_CROSS = 12;
/**
 * Narrower than a full label but wide enough for the icon glyph plus its
 * padding (14px glyph plus the cell's 8px horizontal padding), so a lone icon
 * never bleeds past its box into a neighboring cell.
 */
export const ICON_ONLY_ALONG = 22;

/** One label box for the overlay, in CSS px relative to the map. */
export interface BandLabel {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  icon?: string;
  showIcon: boolean;
  /** The box is too narrow for a label, so only the icon is drawn. */
  iconOnly: boolean;
  plate: boolean;
  max: number;
}

/** Everything buildBandLabels needs. Same geometry inputs as buildScene. */
export interface BandLabelInput {
  width: number;
  height: number;
  orientation: Orientation;
  window: ViewWindow;
  packed: PackedBand[];
  totalLanes: number;
}

/**
 * The band labels to overlay on the canvas, positioned in CSS px. The overlay
 * exists because auto-fitting text is a layout problem the DOM already solves
 * and canvas does not; the geometry of where each label goes is still arithmetic
 * and lives here. A band whose drawn extent is below the legibility threshold is
 * dropped entirely rather than shrunk to an unreadable size.
 */
export function buildBandLabels(input: BandLabelInput): BandLabel[] {
  const { width: w, height: h, orientation, packed, totalLanes } = input;
  const horizontal = orientation === "horizontal";
  const L = axisLengthPx(w, h, orientation);
  const view: AxisView = { ...input.window, lengthPx: L };
  const tickMargin = horizontal ? TICK_MARGIN_H : TICK_MARGIN_V;
  const lanesExtent = (horizontal ? h : w) - tickMargin;
  const laneSize = lanesExtent / totalLanes;
  const laneBase = horizontal ? 0 : tickMargin;
  if (laneSize < MIN_LABEL_CROSS) return [];

  const out: BandLabel[] = [];
  for (const { band, depth, lane } of packed) {
    const a0 = posToAxisPx(frequencyToPosition(band.fHigh), view);
    const a1 = posToAxisPx(frequencyToPosition(band.fLow), view);
    if (a1 < 0 || a0 > L) continue;
    // Clip to the visible portion so a half-scrolled band centers its label in
    // what is on screen, matching how the canvas draws the rect.
    const s0 = Math.max(0, a0);
    const s1 = Math.min(L, a1);
    const wpx = s1 - s0;

    // Full label when wide enough; otherwise the icon alone when there is one
    // and the lane is tall enough; otherwise nothing. Packing already guarantees
    // no two boxes in a lane overlap, so labels confined to their own box never
    // collide with a neighbor.
    const hasIcon = !!band.icon;
    const fullLabel = wpx >= MIN_LABEL_ALONG;
    const iconOnly = !fullLabel && hasIcon && wpx >= ICON_ONLY_ALONG && laneSize > 16;
    if (!fullLabel && !iconOnly) continue;

    const laneOff = laneBase + lane * laneSize;
    const along = wpx;
    out.push({
      key: band.id,
      x: horizontal ? s0 : laneOff,
      y: horizontal ? laneOff : s0,
      w: horizontal ? along : laneSize,
      h: horizontal ? laneSize : along,
      name: band.name,
      icon: band.icon,
      showIcon: hasIcon && (iconOnly || (along > 64 && laneSize > 16)),
      iconOnly,
      plate: !!band.color || band.id === "visible",
      max: depth === 0 ? 15 : 12,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SVG serialization                                                   */
/* ------------------------------------------------------------------ */

/** Escape the five characters that would otherwise open markup in SVG text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize a scene to a standalone SVG document.
 *
 * Vector export is worth the second renderer because the chart is mostly flat
 * rectangles and text: an SVG stays sharp in a slide deck or a print, where the
 * PNG does not. Coordinates are rounded to one decimal because the extra digits
 * are below a device pixel and roughly double the file size.
 */
export function sceneToSvg(scene: Scene, colors: SceneColors): string {
  const { w, h } = scene;
  const parts: string[] = [];
  const defs: string[] = [];
  let gid = 0;

  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${colors.card}"/>`);

  for (const r of scene.rects) {
    let fill = r.fill;
    if (r.spectral) {
      // Each gradient needs its own id: userSpaceOnUse ties the stops to this
      // rect's coordinates, so it cannot be shared even between identical bands.
      const id = `spec${gid++}`;
      const stops = spectralStops().map(
        (s) => `<stop offset="${(s.offset * 100).toFixed(1)}%" stop-color="${s.color}"/>`,
      );
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r.spectral.x1.toFixed(1)}" y1="${r.spectral.y1.toFixed(1)}" x2="${r.spectral.x2.toFixed(1)}" y2="${r.spectral.y2.toFixed(1)}">${stops.join("")}</linearGradient>`,
      );
      fill = `url(#${id})`;
    }
    parts.push(
      `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" fill="${fill}" stroke="${r.stroke}" stroke-width="1"/>`,
    );
  }

  for (const l of scene.lines) {
    parts.push(
      `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="${l.color}" stroke-width="${l.width}"${l.dash ? ' stroke-dasharray="4 3"' : ""}/>`,
    );
  }

  for (const t of [...scene.texts, ...scene.bandTexts]) {
    if (t.plate) {
      parts.push(
        `<rect x="${t.plate.x.toFixed(1)}" y="${t.plate.y.toFixed(1)}" width="${t.plate.w.toFixed(1)}" height="${t.plate.h.toFixed(1)}" fill="${withAlpha(colors.card, 0.72)}"/>`,
      );
    }
    const anchor = t.align === "center" ? "middle" : "start";
    parts.push(
      `<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" fill="${t.color}" font-family="system-ui, sans-serif" font-size="${t.size}" text-anchor="${anchor}" dominant-baseline="middle">${esc(t.text)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs.join("")}</defs>${parts.join("")}</svg>`;
}
