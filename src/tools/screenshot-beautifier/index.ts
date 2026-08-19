import { ToolError, type ToolLogic } from "../types";

/**
 * The document model behind the screenshot beautifier.
 *
 * The panel owns the canvas and the actual screenshot pixels; this module
 * owns three things: the geometry of where the frame, the title bar, and the
 * image slot land on the canvas (`computeLayout`), the decorative SVG built
 * from that geometry (`renderFrameSvg`), and the small color helpers the live
 * preview and the title text need (`gradientCss`, `contrastingInk`).
 *
 * Three deliberate choices are worth stating up front:
 *
 * 1. Rounding happens with one clipPath, not per shape. The title bar and the
 *    image slot sit in a single `<g clip-path>` cut by one rounded rect the
 *    size of the whole frame. That rounds the title bar's top corners and the
 *    image's bottom corners for free, with a flat seam where they meet, and
 *    it means a frameless image (title bar height zero) rounds on all four
 *    corners with the exact same code path.
 * 2. Forcing a canvas to an aspect ratio uses integer multiples of the
 *    reduced ratio (`k * rw`, `k * rh`) rather than growing one axis to a
 *    floating point target. That keeps the output ratio exactly equal to the
 *    requested one, not merely close to it, and the extra room always lands
 *    as padding split evenly around the frame.
 * 3. The 4096px clamp scales every geometric field by the same factor after
 *    the export scale is applied, so a canvas that would exceed the limit
 *    shrinks uniformly instead of distorting.
 */

/* ------------------------------------------------------------------ */
/* numbers                                                             */
/* ------------------------------------------------------------------ */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Format a number for an SVG attribute without floating point dust. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
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
/* backgrounds                                                         */
/* ------------------------------------------------------------------ */

export type BackgroundKind = "gradient" | "solid" | "mesh";

export interface Background {
  id: string;
  label: string;
  kind: BackgroundKind;
  /** One color for a solid, two or more for a gradient or a mesh. */
  stops: string[];
  /** Direction in degrees for a gradient or a mesh's base wash. Unused by solid. */
  angle?: number;
}

/**
 * Twelve presets, tasteful on purpose: enough range to frame a terminal
 * capture or a marketing screenshot without turning into a color picker.
 * "custom" seeds the panel's own color pickers, and "transparent" renders no
 * background rect at all so the export keeps an alpha channel.
 */
export const BACKGROUNDS: Background[] = [
  { id: "sunset", label: "Sunset", kind: "gradient", stops: ["#ff9a56", "#ff6a88", "#ff99ac"], angle: 135 },
  { id: "ocean", label: "Ocean", kind: "gradient", stops: ["#0093e9", "#80d0c7"], angle: 135 },
  { id: "aurora", label: "Aurora", kind: "mesh", stops: ["#00c9ff", "#92fe9d", "#8e2de2"], angle: 120 },
  { id: "peach", label: "Peach", kind: "gradient", stops: ["#ffecd2", "#fcb69f"], angle: 135 },
  { id: "midnight", label: "Midnight", kind: "gradient", stops: ["#0f2027", "#203a43", "#2c5364"], angle: 135 },
  { id: "slate", label: "Slate", kind: "solid", stops: ["#2b3440"] },
  { id: "lime", label: "Lime", kind: "gradient", stops: ["#a8e063", "#56ab2f"], angle: 135 },
  { id: "candy", label: "Candy", kind: "mesh", stops: ["#ff6ec4", "#7873f5", "#4adede"], angle: 120 },
  { id: "mono-light", label: "Mono light", kind: "solid", stops: ["#f5f5f7"] },
  { id: "mono-dark", label: "Mono dark", kind: "solid", stops: ["#111114"] },
  { id: "transparent", label: "Transparent", kind: "solid", stops: ["transparent"] },
  { id: "custom", label: "Custom", kind: "solid", stops: ["#5b6470"] },
];

function findBackground(id: string): Background {
  return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0]!;
}

/* ------------------------------------------------------------------ */
/* frames                                                              */
/* ------------------------------------------------------------------ */

export const FRAME_KINDS = ["none", "mac", "windows", "browser-light", "browser-dark"] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

export interface FrameSpec {
  id: FrameKind;
  label: string;
  /** Pixels of title bar above the image, at 1x. Zero means no chrome at all. */
  titleBarHeight: number;
  trafficLights: boolean;
  windowsControls: boolean;
  urlBar: boolean;
  titleBarBg: string;
  titleBarInk: string;
}

/** Traffic light red, amber, green, in the order macOS draws them left to right. */
export const TRAFFIC_LIGHT_COLORS: readonly string[] = ["#ff5f57", "#ffbd2e", "#28c840"];

export const FRAMES: Record<FrameKind, FrameSpec> = {
  none: {
    id: "none",
    label: "No frame",
    titleBarHeight: 0,
    trafficLights: false,
    windowsControls: false,
    urlBar: false,
    titleBarBg: "",
    titleBarInk: "",
  },
  mac: {
    id: "mac",
    label: "macOS window",
    titleBarHeight: 28,
    trafficLights: true,
    windowsControls: false,
    urlBar: false,
    titleBarBg: "#e7e7ea",
    titleBarInk: "#3a3a3f",
  },
  windows: {
    id: "windows",
    label: "Windows window",
    titleBarHeight: 32,
    trafficLights: false,
    windowsControls: true,
    urlBar: false,
    titleBarBg: "#e6e6e6",
    titleBarInk: "#2b2b2b",
  },
  "browser-light": {
    id: "browser-light",
    label: "Browser (light)",
    titleBarHeight: 40,
    trafficLights: true,
    windowsControls: false,
    urlBar: true,
    titleBarBg: "#f1f3f4",
    titleBarInk: "#202124",
  },
  "browser-dark": {
    id: "browser-dark",
    label: "Browser (dark)",
    titleBarHeight: 40,
    trafficLights: true,
    windowsControls: false,
    urlBar: true,
    titleBarBg: "#2b2b2f",
    titleBarInk: "#e8eaed",
  },
};

function findFrame(id: string): FrameSpec | undefined {
  return (FRAMES as Record<string, FrameSpec>)[id];
}

/* ------------------------------------------------------------------ */
/* aspect ratios                                                       */
/* ------------------------------------------------------------------ */

export type AspectId = "auto" | "1:1" | "4:3" | "16:9" | "twitter(16:9)" | "og(1.91:1)";

interface AspectSpec {
  id: AspectId;
  label: string;
  /** Reduced width:height ratio, or null for "fit the frame with no forcing". */
  ratio: [number, number] | null;
}

/**
 * Ratios are stored pre reduced so the canvas can be forced to an exact
 * integer multiple of them (see `computeLayout`). The Open Graph ratio
 * 1200x630 reduces to 40:21, which is the same 1.91:1 sites like Facebook and
 * LinkedIn expect.
 */
export const ASPECTS: AspectSpec[] = [
  { id: "auto", label: "Auto (fit the frame)", ratio: null },
  { id: "1:1", label: "Square (1:1)", ratio: [1, 1] },
  { id: "4:3", label: "Classic (4:3)", ratio: [4, 3] },
  { id: "16:9", label: "Widescreen (16:9)", ratio: [16, 9] },
  { id: "twitter(16:9)", label: "Twitter or X card (16:9)", ratio: [16, 9] },
  { id: "og(1.91:1)", label: "Open Graph image (1.91:1)", ratio: [40, 21] },
];

function findAspect(id: string): AspectSpec {
  return ASPECTS.find((a) => a.id === id) ?? ASPECTS[0]!;
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

/** The canvas never grows past this on its longest edge, before or after export scale. */
export const MAX_CANVAS = 4096;

export interface LayoutInput {
  imageWidth: number;
  imageHeight: number;
  /** Space between the frame and the canvas edge, at 1x. */
  padding?: number;
  frame?: FrameKind | string;
  cornerRadius?: number;
  /** Whether the panel will draw a drop shadow. Carried through for the renderer. */
  shadow?: boolean;
  aspect?: AspectId | string;
  /** Export multiplier such as 1 or 2. Applied before the 4096px clamp. */
  scale?: number;
}

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  canvasWidth: number;
  canvasHeight: number;
  /** Top left corner of the screenshot itself, below any title bar. */
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
  /** The window: title bar plus image, before rounding is applied by the clip. */
  frameRect: FrameRect;
  titleBarHeight: number;
  cornerRadius: number;
  padding: number;
  frame: FrameKind;
  aspect: AspectId;
  shadow: boolean;
  /** The `scale` that was requested. */
  scale: number;
  /** Extra factor applied on top of `scale` to stay under `MAX_CANVAS`. 1 when no clamp fired. */
  clampScale: number;
  /** `scale * clampScale`: the true ratio between these pixels and the 1x layout. */
  appliedScale: number;
  clamped: boolean;
}

/**
 * Lay out the canvas, the frame, and the image slot for one screenshot.
 *
 * The frame is the image plus a title bar of `titleBarHeight` above it
 * (zero for the "none" frame, so the frame equals the image exactly). The
 * canvas starts as the frame plus `padding` on every side; if `aspect`
 * requests a ratio, the canvas grows to the smallest integer multiple of
 * that reduced ratio that still contains the padded frame, which keeps the
 * final `canvasWidth / canvasHeight` exactly equal to the requested ratio
 * and spreads the extra room evenly since the frame stays centered. The
 * whole result is then multiplied by `scale`, and if that pushes either
 * edge past `MAX_CANVAS` the entire layout is scaled back down together so
 * nothing distorts; `clamped` and `clampScale` report when that happened.
 */
export function computeLayout(input: LayoutInput): Layout {
  const imageWidth = Math.max(1, Math.round(isFiniteNumber(input.imageWidth) ? input.imageWidth : 1));
  const imageHeight = Math.max(1, Math.round(isFiniteNumber(input.imageHeight) ? input.imageHeight : 1));
  const padding = Math.max(0, Math.round(isFiniteNumber(input.padding) ? input.padding! : 64));
  const cornerRadius = Math.max(0, Math.round(isFiniteNumber(input.cornerRadius) ? input.cornerRadius! : 12));
  const shadow = input.shadow !== false;
  const frameSpec = findFrame(typeof input.frame === "string" ? input.frame : "none") ?? FRAMES.none;
  const aspectSpec = findAspect(typeof input.aspect === "string" ? input.aspect : "auto");
  const scale = isFiniteNumber(input.scale) && input.scale! > 0 ? input.scale! : 1;

  const titleBarHeight = frameSpec.titleBarHeight;
  const frameW = imageWidth;
  const frameH = imageHeight + titleBarHeight;

  let canvasW = frameW + padding * 2;
  let canvasH = frameH + padding * 2;

  if (aspectSpec.ratio) {
    const [rw, rh] = aspectSpec.ratio;
    const k = Math.ceil(Math.max(canvasW / rw, canvasH / rh));
    canvasW = k * rw;
    canvasH = k * rh;
  }

  const frameX = Math.round((canvasW - frameW) / 2);
  const frameY = Math.round((canvasH - frameH) / 2);

  // Apply the requested export scale (1x, 2x, ...).
  let sCanvasW = Math.round(canvasW * scale);
  let sCanvasH = Math.round(canvasH * scale);
  let sFrameX = Math.round(frameX * scale);
  let sFrameY = Math.round(frameY * scale);
  let sFrameW = Math.round(frameW * scale);
  let sFrameH = Math.round(frameH * scale);
  let sTitleBarHeight = Math.round(titleBarHeight * scale);
  let sPadding = Math.round(padding * scale);
  let sCornerRadius = Math.round(cornerRadius * scale);

  // Clamp the longest edge to MAX_CANVAS, scaling every field together so the
  // layout only ever shrinks uniformly, never distorts.
  const largest = Math.max(sCanvasW, sCanvasH);
  let clampScale = 1;
  let clamped = false;
  if (largest > MAX_CANVAS) {
    clampScale = MAX_CANVAS / largest;
    clamped = true;
    sCanvasW = Math.round(sCanvasW * clampScale);
    sCanvasH = Math.round(sCanvasH * clampScale);
    sFrameX = Math.round(sFrameX * clampScale);
    sFrameY = Math.round(sFrameY * clampScale);
    sFrameW = Math.round(sFrameW * clampScale);
    sFrameH = Math.round(sFrameH * clampScale);
    sTitleBarHeight = Math.round(sTitleBarHeight * clampScale);
    sPadding = Math.round(sPadding * clampScale);
    sCornerRadius = Math.round(sCornerRadius * clampScale);
  }

  return {
    canvasWidth: sCanvasW,
    canvasHeight: sCanvasH,
    imageX: sFrameX,
    imageY: sFrameY + sTitleBarHeight,
    imageWidth: sFrameW,
    imageHeight: sFrameH - sTitleBarHeight,
    frameRect: { x: sFrameX, y: sFrameY, w: sFrameW, h: sFrameH },
    titleBarHeight: sTitleBarHeight,
    cornerRadius: sCornerRadius,
    padding: sPadding,
    frame: frameSpec.id,
    aspect: aspectSpec.id,
    shadow,
    scale,
    clampScale,
    appliedScale: scale * clampScale,
    clamped,
  };
}

/* ------------------------------------------------------------------ */
/* color                                                               */
/* ------------------------------------------------------------------ */

function parseColor(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim();
  if (!c || c === "transparent") return null;
  let hex = c.startsWith("#") ? c.slice(1) : c;
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Fixed relative positions for a mesh's radial blobs, reused by the SVG and the CSS preview. */
const MESH_BLOB_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [25, 30],
  [75, 25],
  [50, 82],
  [15, 78],
];

/**
 * A CSS `background` value that mirrors what `renderFrameSvg` draws, for the
 * panel's live preview before an image is even loaded. A mesh approximates
 * its SVG radial blobs with layered `radial-gradient()`s over the same
 * linear wash; CSS has no native mesh gradient, and this keeps the same
 * fixed, deterministic blob positions the SVG uses.
 */
export function gradientCss(background: Background): string {
  if (background.kind === "solid") {
    const color = background.stops[0];
    return !color || color === "transparent" ? "transparent" : color;
  }
  if (background.kind === "gradient") {
    return `linear-gradient(${background.angle ?? 135}deg, ${background.stops.join(", ")})`;
  }
  const base =
    background.stops.length > 1
      ? [background.stops[0]!, background.stops[background.stops.length - 1]!]
      : [background.stops[0] ?? "#888888"];
  const layers = background.stops.map((color, i) => {
    const [px, py] = MESH_BLOB_POSITIONS[i % MESH_BLOB_POSITIONS.length]!;
    return `radial-gradient(circle at ${px}% ${py}%, ${color}, transparent 65%)`;
  });
  layers.push(`linear-gradient(${background.angle ?? 120}deg, ${base.join(", ")})`);
  return layers.join(", ");
}

/**
 * Whether white or near black ink stays legible on this background, by the
 * perceived brightness (YIQ) of its stops averaged together. Transparent
 * stops are skipped since they contribute no color; a background of nothing
 * but transparent falls back to dark ink, which reads fine on the light page
 * chrome around the canvas.
 */
export function contrastingInk(background: Background): "#fff" | "#111" {
  const colors = background.stops
    .map(parseColor)
    .filter((c): c is { r: number; g: number; b: number } => c !== null);
  if (!colors.length) return "#111";
  const sum = colors.reduce(
    (acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }),
    { r: 0, g: 0, b: 0 },
  );
  const count = colors.length;
  const yiq = ((sum.r / count) * 299 + (sum.g / count) * 587 + (sum.b / count) * 114) / 1000;
  return yiq >= 150 ? "#111" : "#fff";
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const FONT_STACK = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const GRADIENT_ID = "sb-bg";
const SHADOW_FILTER_ID = "sb-shadow";
const CLIP_ID = "sb-frame-clip";

function angleToCoords(angleDeg: number): { x1: string; y1: string; x2: string; y2: string } {
  const rad = ((angleDeg % 360) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  return {
    x1: `${n(50 - dx * 50)}%`,
    y1: `${n(50 - dy * 50)}%`,
    x2: `${n(50 + dx * 50)}%`,
    y2: `${n(50 + dy * 50)}%`,
  };
}

function stopList(stops: string[]): string {
  if (stops.length === 1) {
    const color = esc(stops[0]!);
    return `<stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${color}"/>`;
  }
  return stops
    .map((color, i) => `<stop offset="${n((i / (stops.length - 1)) * 100)}%" stop-color="${esc(color)}"/>`)
    .join("");
}

/** Background defs (gradients) and the rects that paint them, in draw order. */
function renderBackground(width: number, height: number, bg: Background): { defs: string; rects: string } {
  if (bg.kind === "solid") {
    const color = bg.stops[0];
    if (!color || color === "transparent") return { defs: "", rects: "" };
    return {
      defs: "",
      rects: `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="${esc(color)}" data-kind="background"/>`,
    };
  }

  if (bg.kind === "gradient") {
    const { x1, y1, x2, y2 } = angleToCoords(bg.angle ?? 135);
    return {
      defs: `<linearGradient id="${GRADIENT_ID}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopList(bg.stops)}</linearGradient>`,
      rects: `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="url(#${GRADIENT_ID})" data-kind="background"/>`,
    };
  }

  // mesh: a two color diagonal wash, plus a soft radial blob per stop layered
  // on top at fixed positions. Deterministic: no randomness, no layout input.
  const { x1, y1, x2, y2 } = angleToCoords(bg.angle ?? 120);
  const base = bg.stops.length > 1 ? [bg.stops[0]!, bg.stops[bg.stops.length - 1]!] : [bg.stops[0] ?? "#888888"];
  const defsParts = [
    `<linearGradient id="${GRADIENT_ID}-base" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopList(base)}</linearGradient>`,
  ];
  const rectsParts = [
    `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="url(#${GRADIENT_ID}-base)" data-kind="background"/>`,
  ];
  bg.stops.forEach((color, i) => {
    const [px, py] = MESH_BLOB_POSITIONS[i % MESH_BLOB_POSITIONS.length]!;
    const id = `${GRADIENT_ID}-blob-${i}`;
    defsParts.push(
      `<radialGradient id="${id}" cx="${n(px)}%" cy="${n(py)}%" r="65%">` +
        `<stop offset="0%" stop-color="${esc(color)}" stop-opacity="0.9"/>` +
        `<stop offset="100%" stop-color="${esc(color)}" stop-opacity="0"/></radialGradient>`,
    );
    rectsParts.push(
      `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="url(#${id})" data-kind="background-blob"/>`,
    );
  });
  return { defs: defsParts.join(""), rects: rectsParts.join("") };
}

export interface ShadowSpec {
  /** Gaussian blur std deviation in pixels. */
  blur: number;
  /** Vertical offset in pixels; positive drops the shadow down. */
  offsetY: number;
  /** 0 to 1. */
  opacity: number;
}

/**
 * An offset-blur-recolor drop shadow built from primitives rather than
 * `feDropShadow`, so the blur step is an explicit `<feGaussianBlur>` that
 * shows up in the markup and rasterizes identically everywhere. The filter's
 * output is the tinted blur alone, not the shadow merged with SourceGraphic:
 * the caster rect this filter is applied to is exactly the same rounded
 * rect as the frame clip drawn on top of it, and merging SourceGraphic back
 * in would let a solid black edge show through the antialiasing seam between
 * two coincident rounded rects. Leaving the caster unmerged means only the
 * blurred halo can ever be visible past the frame's own edge.
 */
function renderShadowFilter(shadow: ShadowSpec): string {
  const blur = Math.max(0, shadow.blur);
  const opacity = Math.min(1, Math.max(0, shadow.opacity));
  return (
    `<filter id="${SHADOW_FILTER_ID}" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feOffset dx="0" dy="${n(shadow.offsetY)}" in="SourceAlpha" result="sb-off"/>` +
    `<feGaussianBlur in="sb-off" stdDeviation="${n(blur)}" result="sb-blur"/>` +
    `<feColorMatrix in="sb-blur" type="matrix" ` +
    `values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${n(opacity)} 0"/>` +
    `</filter>`
  );
}

function pillFillFor(spec: FrameSpec): string {
  return spec.id === "browser-dark" ? "#3c3c41" : "#ffffff";
}

function renderTitleBar(frameRect: FrameRect, titleBarHeight: number, spec: FrameSpec, title?: string): string {
  const parts: string[] = [
    `<rect x="${n(frameRect.x)}" y="${n(frameRect.y)}" width="${n(frameRect.w)}" height="${n(titleBarHeight)}" ` +
      `fill="${esc(spec.titleBarBg)}" data-kind="title-bar"/>`,
  ];

  const cy = frameRect.y + titleBarHeight / 2;

  if (spec.trafficLights) {
    const r = Math.max(3, titleBarHeight * 0.16);
    const gap = r * 2.8;
    const startX = frameRect.x + titleBarHeight * 0.55;
    TRAFFIC_LIGHT_COLORS.forEach((color, i) => {
      parts.push(
        `<circle cx="${n(startX + gap * i)}" cy="${n(cy)}" r="${n(r)}" fill="${esc(color)}" ` +
          `data-kind="traffic-light" data-index="${i}"/>`,
      );
    });
  }

  if (spec.windowsControls) {
    const size = titleBarHeight * 0.32;
    const gap = titleBarHeight * 0.9;
    const baseX = frameRect.x + frameRect.w - gap * 3;
    const ink = esc(spec.titleBarInk);
    parts.push(
      `<line x1="${n(baseX)}" y1="${n(cy)}" x2="${n(baseX + size)}" y2="${n(cy)}" stroke="${ink}" ` +
        `stroke-width="1.4" data-kind="win-minimize"/>`,
    );
    const mx = baseX + gap;
    parts.push(
      `<rect x="${n(mx)}" y="${n(cy - size / 2)}" width="${n(size)}" height="${n(size)}" fill="none" ` +
        `stroke="${ink}" stroke-width="1.4" data-kind="win-maximize"/>`,
    );
    const cx0 = baseX + gap * 2;
    parts.push(
      `<line x1="${n(cx0)}" y1="${n(cy - size / 2)}" x2="${n(cx0 + size)}" y2="${n(cy + size / 2)}" ` +
        `stroke="${ink}" stroke-width="1.4" data-kind="win-close"/>` +
        `<line x1="${n(cx0)}" y1="${n(cy + size / 2)}" x2="${n(cx0 + size)}" y2="${n(cy - size / 2)}" ` +
        `stroke="${ink}" stroke-width="1.4" data-kind="win-close"/>`,
    );
  }

  if (spec.urlBar) {
    const barH = titleBarHeight * 0.52;
    const leftMargin = spec.trafficLights ? frameRect.x + titleBarHeight * 1.9 : frameRect.x + titleBarHeight * 0.5;
    const rightMargin = frameRect.x + frameRect.w - titleBarHeight * 0.5;
    const barW = Math.max(20, rightMargin - leftMargin);
    const barY = cy - barH / 2;
    const label = title && title.trim() ? title.trim() : "https://example.com";
    parts.push(
      `<rect x="${n(leftMargin)}" y="${n(barY)}" width="${n(barW)}" height="${n(barH)}" rx="${n(barH / 2)}" ` +
        `fill="${esc(pillFillFor(spec))}" data-kind="url-pill"/>` +
        `<text x="${n(leftMargin + barH * 0.4)}" y="${n(cy + barH * 0.18)}" font-family="${esc(FONT_STACK)}" ` +
        `font-size="${n(Math.max(9, barH * 0.42))}" fill="${esc(spec.titleBarInk)}" ` +
        `data-kind="url-pill-text">${esc(label)}</text>`,
    );
  } else if (title && title.trim()) {
    parts.push(
      `<text x="${n(frameRect.x + frameRect.w / 2)}" y="${n(cy + titleBarHeight * 0.12)}" text-anchor="middle" ` +
        `font-family="${esc(FONT_STACK)}" font-size="${n(Math.max(10, titleBarHeight * 0.42))}" ` +
        `fill="${esc(spec.titleBarInk)}" data-kind="window-title">${esc(title.trim())}</text>`,
    );
  }

  return parts.join("");
}

export interface RenderOptions {
  /**
   * A `BACKGROUNDS` id, or a `Background` object supplied directly. The
   * object form is the escape hatch for the panel's "custom" preset, where
   * the actual colors come from the user's own pickers and never get added
   * to the static preset list.
   */
  background: string | Background;
  frame: FrameKind | string;
  /** Window title text (mac and windows frames) or the fake URL (browser frames). */
  title?: string;
  /** Present enables the drop shadow; absent skips it entirely. */
  shadow?: ShadowSpec;
  cornerRadius?: number;
  /** Small text in the bottom right corner of the canvas. */
  watermark?: string;
}

/**
 * Render the decoration only: background, drop shadow, window chrome, and a
 * `<image href="#screenshot">` placeholder the panel swaps for a real data
 * URL before rasterizing. Deterministic: the same layout and options always
 * produce byte identical markup.
 */
export function renderFrameSvg(layout: Layout, options: RenderOptions): string {
  const bg = typeof options.background === "string" ? findBackground(options.background) : options.background;
  const frameSpec = findFrame(typeof options.frame === "string" ? options.frame : layout.frame) ?? FRAMES.none;
  const cornerRadius = isFiniteNumber(options.cornerRadius) ? options.cornerRadius! : layout.cornerRadius;
  const { canvasWidth, canvasHeight, frameRect, titleBarHeight, imageX, imageY, imageWidth, imageHeight } = layout;

  const defsParts: string[] = [];
  const { defs: bgDefs, rects: bgRects } = renderBackground(canvasWidth, canvasHeight, bg);
  if (bgDefs) defsParts.push(bgDefs);
  if (options.shadow) defsParts.push(renderShadowFilter(options.shadow));
  defsParts.push(
    `<clipPath id="${CLIP_ID}"><rect x="${n(frameRect.x)}" y="${n(frameRect.y)}" width="${n(frameRect.w)}" ` +
      `height="${n(frameRect.h)}" rx="${n(cornerRadius)}"/></clipPath>`,
  );

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" ` +
      `viewBox="0 0 ${canvasWidth} ${canvasHeight}" data-frame="${esc(frameSpec.id)}" ` +
      `data-background="${esc(bg.id)}">`,
    `<defs>${defsParts.join("")}</defs>`,
  ];

  if (bgRects) parts.push(bgRects);

  if (options.shadow) {
    parts.push(
      `<rect x="${n(frameRect.x)}" y="${n(frameRect.y)}" width="${n(frameRect.w)}" height="${n(frameRect.h)}" ` +
        `rx="${n(cornerRadius)}" fill="#000000" filter="url(#${SHADOW_FILTER_ID})" data-kind="shadow"/>`,
    );
  }

  parts.push(`<g clip-path="url(#${CLIP_ID})">`);
  if (titleBarHeight > 0) {
    parts.push(renderTitleBar(frameRect, titleBarHeight, frameSpec, options.title));
  }
  parts.push(
    `<image href="#screenshot" x="${n(imageX)}" y="${n(imageY)}" width="${n(imageWidth)}" height="${n(imageHeight)}" ` +
      `preserveAspectRatio="xMidYMid slice" data-screenshot-slot="true"/>`,
  );
  parts.push("</g>");

  if (options.watermark && options.watermark.trim()) {
    const ink = contrastingInk(bg);
    parts.push(
      `<text x="${n(canvasWidth - 12)}" y="${n(canvasHeight - 12)}" text-anchor="end" ` +
        `font-family="${esc(FONT_STACK)}" font-size="12" fill="${ink}" fill-opacity="0.65" ` +
        `data-kind="watermark">${esc(options.watermark.trim())}</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export interface BeautifierOpts {
  background?: string;
  frame?: string;
  padding?: number;
  cornerRadius?: number;
  aspect?: string;
  shadow?: boolean;
  title?: string;
  [key: string]: unknown;
}

export type BeautifierResult = Record<string, string>;

function badOption(message: string, fix: string): ToolError {
  return new ToolError("bad-option", message, fix);
}

function resolveBackgroundId(value: unknown): string {
  const id = typeof value === "string" && value.trim() ? value.trim() : "sunset";
  if (!BACKGROUNDS.some((b) => b.id === id)) {
    throw badOption(`"${id}" is not a background.`, `Use one of: ${BACKGROUNDS.map((b) => b.id).join(", ")}.`);
  }
  return id;
}

function resolveFrameId(value: unknown): FrameKind {
  const id = typeof value === "string" && value.trim() ? value.trim() : "mac";
  if (!FRAME_KINDS.includes(id as FrameKind)) {
    throw badOption(`"${id}" is not a frame.`, `Use one of: ${FRAME_KINDS.join(", ")}.`);
  }
  return id as FrameKind;
}

function resolveAspectId(value: unknown): AspectId {
  const id = typeof value === "string" && value.trim() ? value.trim() : "auto";
  if (!ASPECTS.some((a) => a.id === id)) {
    throw badOption(`"${id}" is not an aspect ratio.`, `Use one of: ${ASPECTS.map((a) => a.id).join(", ")}.`);
  }
  return id as AspectId;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = isFiniteNumber(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

const SAMPLE_NOTE =
  "This is the layout math for a sample 1280 x 800 screenshot. Drop or paste your own screenshot in the panel above to compose the real image.";

/**
 * The generic shell cannot hand this tool a real image, so `run` accepts an
 * optional JSON `{ "width": number, "height": number }` describing one and
 * returns the computed layout as labeled rows plus the decoration SVG, so
 * there is something to see even outside the custom panel. Empty input lays
 * out a sample 1280x800 screenshot instead of failing.
 */
export function run(input: string, opts: BeautifierOpts = {}): BeautifierResult {
  const backgroundId = resolveBackgroundId(opts.background);
  const frame = resolveFrameId(opts.frame);
  const aspect = resolveAspectId(opts.aspect);
  const padding = clampNumber(opts.padding, 64, 0, 400);
  const cornerRadius = clampNumber(opts.cornerRadius, 12, 0, 48);
  const shadow = opts.shadow !== false;
  const title = typeof opts.title === "string" ? opts.title : "";

  const text = typeof input === "string" ? input.trim() : "";
  let width = 1280;
  let height = 800;
  let sample = true;

  if (text) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ToolError(
        "bad-json",
        `That is not valid JSON: ${(error as Error).message}`,
        'Pass {"width":1280,"height":800}, or leave the input empty for a sample layout.',
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ToolError(
        "bad-json",
        "The input must be a JSON object with width and height.",
        'Pass {"width":1280,"height":800}.',
      );
    }
    const source = parsed as Record<string, unknown>;
    if (source.width !== undefined || source.height !== undefined) {
      const w = source.width;
      const h = source.height;
      if (!isFiniteNumber(w) || !isFiniteNumber(h) || w <= 0 || h <= 0) {
        throw new ToolError(
          "bad-json",
          "width and height must both be positive numbers.",
          'Pass whole pixel dimensions, e.g. {"width":1280,"height":800}.',
        );
      }
      width = Math.round(w);
      height = Math.round(h);
      sample = false;
    }
  }

  const layout = computeLayout({
    imageWidth: width,
    imageHeight: height,
    padding,
    frame,
    cornerRadius,
    shadow,
    aspect,
    scale: 1,
  });

  const svg = renderFrameSvg(layout, {
    background: backgroundId,
    frame,
    title: title || undefined,
    shadow: shadow ? { blur: 32, offsetY: 18, opacity: 0.32 } : undefined,
    cornerRadius: layout.cornerRadius,
  });

  const background = findBackground(backgroundId);
  const frameSpec = findFrame(frame) ?? FRAMES.none;

  const rows: BeautifierResult = {};
  if (sample) rows.Note = SAMPLE_NOTE;
  rows.Canvas = `${layout.canvasWidth} x ${layout.canvasHeight} px`;
  rows["Image position"] = `${layout.imageX}, ${layout.imageY}`;
  rows["Image size"] = `${layout.imageWidth} x ${layout.imageHeight} px`;
  rows.Frame = frameSpec.label;
  rows["Title bar height"] = `${layout.titleBarHeight} px`;
  rows.Background = background.label;
  rows.Padding = `${layout.padding} px`;
  rows["Corner radius"] = `${layout.cornerRadius} px`;
  if (layout.clamped) {
    rows.Clamped = `Canvas scaled to ${(layout.clampScale * 100).toFixed(1)}% of its layout size to stay under ${MAX_CANVAS} px.`;
  }
  rows["Decoration SVG"] = svg;

  return rows;
}

export default { run } satisfies ToolLogic<string, BeautifierResult, BeautifierOpts>;
