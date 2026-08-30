<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { Download, Pause, Play, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  fixed,
  formatDuration,
  layerStats,
  parseGcode,
  summarize,
  type ColorBy,
  type GcodeLayer,
  type GcodeModel,
  type GcodeSegment,
  type LayerStats,
} from "@/tools/gcode-viewer/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import OutputView from "../OutputView.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for the G-code Viewer.
 *
 * The generic ToolShell can print the summary rows, and the logic layer can
 * draw a fixed size SVG of one layer, but a toolpath is something you want to
 * scrub through, spin, and zoom into. So the panel owns a canvas and the
 * gestures on it, while every number it shows still comes from the pure logic
 * layer (PROJECT.md rule 27): parseGcode, summarize, layerStats, fixed and
 * formatDuration. Nothing here re-derives a statistic the logic already owns.
 *
 * What the panel had to add, and why, since none of it exists in the logic:
 *
 *  - Projection. fitTo and the SVG renderers are private and top down only, so
 *    the canvas carries its own projection: an identity map for the top down
 *    view and a 30 degree isometric one that lifts each layer by its own Z.
 *  - Palette. EXTRUSION_COLOR, TRAVEL_COLOR and SPEED_RAMP are private too, so
 *    the constants below mirror them. Keep them in step with
 *    src/tools/gcode-viewer/index.ts so the canvas and the API agree.
 *  - Stack shading. The coloring control is the one declared in meta, so the
 *    panel and the curl API offer exactly the same two modes, and it paints the
 *    layer you are on. Shading the stack underneath it by height is a rendering
 *    choice with no API meaning, so it is a separate control with its own id
 *    rather than an extra value bolted onto the meta option.
 *
 * Two things the logic cannot do, stated plainly rather than faked: parseGcode
 * is one synchronous pass with no incremental entry point, so the parse shows
 * an indeterminate status rather than a percentage, and GcodeSegment carries no
 * tool number, so there is no "color by tool" mode to offer.
 *
 * Responsiveness: every layer below the one you are on is drawn once into an
 * offscreen canvas, in chunks across animation frames, and the visible canvas
 * only blits that bitmap and strokes the current layer on top. Panning moves
 * the blit instead of rebuilding it, so a drag stays smooth on a tall print.
 *
 * Nothing touches the DOM until the panel is mounted, so it renders inert on
 * the server.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Matches the ceiling the logic layer enforces, so the message arrives sooner. */
const MAX_BYTES = 100 * 1024 * 1024;

const VIEW_HEIGHT = 440;
const MIN_WIDTH = 260;
/** Breathing room between the fitted drawing and the edge of the canvas. */
const VIEW_PAD = 18;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 60;

/** Segments drawn per animation frame while the stack is being built. */
const SEGMENT_BUDGET = 30000;

const ISO_ANGLE = Math.PI / 6;
const ISO_COS = Math.cos(ISO_ANGLE);
const ISO_SIN = Math.sin(ISO_ANGLE);

// These mirror the private palette in src/tools/gcode-viewer/index.ts so the
// canvas and the tool's own SVG output show the same print in the same colors.
const EXTRUSION_COLOR = "#2563eb";
const TRAVEL_COLOR = "#94a3b8";
/** Slow to fast, and low to high: blue through green and amber to red. */
const HEAT_RAMP = [
  "#1d4ed8",
  "#0284c7",
  "#0d9488",
  "#65a30d",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#b91c1c",
];

type ViewMode = "top" | "iso";
type StackShading = "fade" | "height";
type SpeedKey = "slow" | "normal" | "fast";

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "top", label: "Top down" },
  { value: "iso", label: "Isometric" },
];

const SHADING_OPTIONS: { value: StackShading; label: string }[] = [
  { value: "fade", label: "Fade" },
  { value: "height", label: "By height" },
];

/** Playback rates in layers per second. */
const SPEED_OPTIONS: { value: SpeedKey; label: string; rate: number }[] = [
  { value: "slow", label: "Slow", rate: 4 },
  { value: "normal", label: "Normal", rate: 12 },
  { value: "fast", label: "Fast", rate: 30 },
];

/** Used only if the tool's meta ever loses its coloring option. */
const FALLBACK_COLOR_BY: SelectOptionSpec = {
  kind: "select",
  id: "colorBy",
  label: "Color the strokes by",
  default: "type",
  options: [
    { value: "type", label: "Move type", synonyms: ["extrusion", "travel", "flat"] },
    { value: "speed", label: "Speed", synonyms: ["feed", "feed rate", "mm/s"] },
  ],
};

/* ------------------------------------------------------------------ *
 * options, read from the tool's own meta so both surfaces agree
 * ------------------------------------------------------------------ */

const colorBySpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find(
    (option): option is SelectOptionSpec => option.kind === "select" && option.id === "colorBy",
  );
  return found ?? FALLBACK_COLOR_BY;
});

const travelLabel = computed<string>(() => {
  const found = props.meta.options?.find((option) => option.id === "showTravel");
  return found?.label ?? "Show travel moves";
});

const colorBy = ref<string>(colorBySpec.value.default);
const activeColorBy = computed<ColorBy>(() => (colorBy.value === "speed" ? "speed" : "type"));
const showTravel = ref(false);
const view = ref<ViewMode>("top");
const stackShading = ref<StackShading>("fade");
const speed = ref<SpeedKey>("normal");

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const model = shallowRef<GcodeModel | null>(null);
const fileName = ref("");
const fileSize = ref(0);
const pasted = ref("");
const error = ref<{ message: string; fix?: string } | null>(null);
const stage = ref<"idle" | "reading" | "parsing">("idle");

const layerIndex = ref(0);
const playing = ref(false);

const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const panning = ref(false);
const boxWidth = ref(640);

/** Layers already painted into the offscreen stack, for the progress readout. */
const drawnCount = ref(0);
const buildingStack = ref(false);

const viewportRef = ref<HTMLElement>();
const canvasRef = ref<HTMLCanvasElement>();

/* ------------------------------------------------------------------ *
 * derived
 * ------------------------------------------------------------------ */

const layers = computed<GcodeLayer[]>(() => model.value?.layers ?? []);
const layerCount = computed(() => layers.value.length);
const lastLayer = computed(() => Math.max(0, layerCount.value - 1));
const hasDrawing = computed(() => layerCount.value > 0);

const stats = computed<Record<string, string> | null>(() =>
  model.value === null ? null : summarize(model.value),
);

const currentStats = computed<LayerStats | null>(() => {
  const loaded = model.value;
  if (loaded === null || loaded.layers.length === 0) return null;
  const index = Math.min(Math.max(layerIndex.value, 0), loaded.layers.length - 1);
  return layerStats(loaded, index);
});

/** Feed range across the whole print, so the speed ramp reads the same on every layer. */
const feedRange = computed<{ min: number; max: number }>(() => {
  let min = Infinity;
  let max = 0;
  for (const layer of layers.value) {
    for (const segment of layer.segments) {
      if (!segment.extruding) continue;
      if (segment.feed < min) min = segment.feed;
      if (segment.feed > max) max = segment.feed;
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max };
});

const speedRate = computed<number>(
  () => SPEED_OPTIONS.find((option) => option.value === speed.value)?.rate ?? 12,
);

const canvasLabel = computed(
  () =>
    `Toolpath preview, ${view.value === "top" ? "top down" : "isometric"} view, layer ${
      layerIndex.value + 1
    } of ${layerCount.value}`,
);

const statusText = computed<string>(() => {
  if (stage.value === "reading") return "Reading the file…";
  if (stage.value === "parsing") return "Parsing the program…";
  if (buildingStack.value) return `Drawing layer ${drawnCount.value} of ${layerIndex.value}`;
  return "";
});

const buildProgress = computed<number>(() => {
  const target = layerIndex.value;
  if (target <= 0) return 1;
  return Math.min(1, drawnCount.value / target);
});

const feedText = computed<string>(() => {
  const current = currentStats.value;
  if (current === null || current.maxFeed <= 0) return "Not set on this layer";
  const min = current.minFeed;
  const max = current.maxFeed;
  if (max - min < 1) return `${fixed(max, 0)} mm/min (${fixed(max / 60, 0)} mm/s)`;
  return `${fixed(min, 0)} to ${fixed(max, 0)} mm/min (${fixed(min / 60, 0)} to ${fixed(
    max / 60,
    0,
  )} mm/s)`;
});

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function tooLarge(size: number): ToolError {
  return new ToolError(
    "too-large",
    `That file is about ${formatBytes(size)}, larger than the ${formatBytes(MAX_BYTES)} limit.`,
    "Slice a smaller model, or split the program before loading it.",
  );
}

/**
 * Wait for the browser to paint. parseGcode blocks the main thread for as long
 * as it takes, so the status has to be on screen before the call starts.
 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

function resetView(): void {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
}

async function loadText(text: string, name: string, size: number): Promise<void> {
  stopPlayback();
  error.value = null;
  stage.value = "parsing";
  await nextTick();
  await afterPaint();
  try {
    if (size > MAX_BYTES) throw tooLarge(size);
    const parsed = parseGcode(text);
    model.value = parsed;
    fileName.value = name;
    fileSize.value = size;
    // Opening on the top layer shows the whole print, which is what a preview
    // is for. The chunked builder keeps that first paint from blocking.
    layerIndex.value = Math.max(0, parsed.layers.length - 1);
    resetView();
    invalidateStack();
  } catch (e) {
    model.value = null;
    error.value = toToolError(e);
  } finally {
    stage.value = "idle";
  }
}

async function readFile(file: File): Promise<void> {
  stopPlayback();
  error.value = null;
  stage.value = "reading";
  try {
    if (file.size > MAX_BYTES) throw tooLarge(file.size);
    const text = await file.text();
    await loadText(text, file.name, file.size);
  } catch (e) {
    stage.value = "idle";
    model.value = null;
    error.value = toToolError(e);
  }
}

function onFiles(files: File[]): void {
  const file = files[0];
  if (file) void readFile(file);
}

let pasteTimer: ReturnType<typeof setTimeout> | undefined;
function onPaste(value: unknown): void {
  pasted.value = String(value ?? "");
  clearTimeout(pasteTimer);
  const text = pasted.value;
  if (text.trim() === "") {
    error.value = null;
    return;
  }
  pasteTimer = setTimeout(() => {
    void loadText(text, "pasted.gcode", text.length);
  }, 300);
}

function clearFile(): void {
  stopPlayback();
  model.value = null;
  fileName.value = "";
  fileSize.value = 0;
  pasted.value = "";
  error.value = null;
  layerIndex.value = 0;
  resetView();
}

/* ------------------------------------------------------------------ *
 * projection
 * ------------------------------------------------------------------ */

interface Point2 {
  x: number;
  y: number;
}

/**
 * World millimeters to the drawing plane. Top down keeps X and flips Y, since
 * G-code Y grows towards the back of the bed and canvas Y grows downwards.
 * Isometric is the classic 30 degree pair with Z up, so a taller layer sits
 * higher on screen.
 */
function projectWith(mode: ViewMode, x: number, y: number, z: number): Point2 {
  if (mode === "top") return { x, y: -y };
  return { x: (x - y) * ISO_COS, y: (x + y) * ISO_SIN - z };
}

interface FitView {
  scale: number;
  cx: number;
  cy: number;
}

/** The scale and center that put the printed bounding box inside the canvas. */
const fit = computed<FitView>(() => {
  const loaded = model.value;
  if (loaded === null) return { scale: 1, cx: 0, cy: 0 };
  const b = loaded.bounds;
  const mode = view.value;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [b.minX, b.maxX]) {
    for (const y of [b.minY, b.maxY]) {
      for (const z of [b.minZ, b.maxZ]) {
        const p = projectWith(mode, x, y, z);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const width = Math.max(MIN_WIDTH, boxWidth.value);
  const scale = Math.min((width - 2 * VIEW_PAD) / spanX, (VIEW_HEIGHT - 2 * VIEW_PAD) / spanY);
  return { scale, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
});

interface Transform {
  mode: ViewMode;
  scale: number;
  cx: number;
  cy: number;
  ox: number;
  oy: number;
}

function currentTransform(): Transform {
  const f = fit.value;
  return {
    mode: view.value,
    scale: f.scale * zoom.value,
    cx: f.cx,
    cy: f.cy,
    ox: Math.max(MIN_WIDTH, boxWidth.value) / 2 + panX.value,
    oy: VIEW_HEIGHT / 2 + panY.value,
  };
}

/* ------------------------------------------------------------------ *
 * drawing
 * ------------------------------------------------------------------ */

function isExtruding(segment: GcodeSegment): boolean {
  return segment.extruding;
}

function isTravel(segment: GcodeSegment): boolean {
  return !segment.extruding;
}

function speedBucket(feed: number): number {
  const { min, max } = feedRange.value;
  if (!(max > min)) return 0;
  const t = (feed - min) / (max - min);
  return Math.max(0, Math.min(HEAT_RAMP.length - 1, Math.floor(t * HEAT_RAMP.length)));
}

/**
 * Strokes the segments of one layer that pass `keep`, joining consecutive
 * moves into one subpath the way the logic layer's SVG writer does.
 */
function strokePath(
  ctx: CanvasRenderingContext2D,
  t: Transform,
  layer: GcodeLayer,
  keep: (segment: GcodeSegment) => boolean,
): void {
  ctx.beginPath();
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let drew = false;
  for (const segment of layer.segments) {
    if (!keep(segment)) {
      lastX = Number.NaN;
      lastY = Number.NaN;
      continue;
    }
    if (segment.x1 !== lastX || segment.y1 !== lastY) {
      const a = projectWith(t.mode, segment.x1, segment.y1, layer.z);
      ctx.moveTo((a.x - t.cx) * t.scale + t.ox, (a.y - t.cy) * t.scale + t.oy);
    }
    const b = projectWith(t.mode, segment.x2, segment.y2, layer.z);
    ctx.lineTo((b.x - t.cx) * t.scale + t.ox, (b.y - t.cy) * t.scale + t.oy);
    lastX = segment.x2;
    lastY = segment.y2;
    drew = true;
  }
  if (drew) ctx.stroke();
}

/** One of the layers below the current one, painted by the stack shading control. */
function drawStackLayer(ctx: CanvasRenderingContext2D, t: Transform, index: number): void {
  const layer = layers.value[index];
  if (layer === undefined) return;
  const last = lastLayer.value;
  const ratio = last === 0 ? 1 : index / last;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  if (stackShading.value === "height") {
    const step = Math.min(HEAT_RAMP.length - 1, Math.floor(ratio * HEAT_RAMP.length));
    ctx.strokeStyle = HEAT_RAMP[step];
    ctx.globalAlpha = 0.85;
  } else {
    ctx.strokeStyle = EXTRUSION_COLOR;
    ctx.globalAlpha = 0.18 + 0.82 * ratio;
  }
  strokePath(ctx, t, layer, isExtruding);
}

/** The layer you are on, painted by the coloring mode declared in meta. */
function drawCurrentLayer(ctx: CanvasRenderingContext2D, t: Transform): void {
  const layer = layers.value[layerIndex.value];
  if (layer === undefined) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (showTravel.value) {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = TRAVEL_COLOR;
    ctx.globalAlpha = 0.75;
    strokePath(ctx, t, layer, isTravel);
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.8;
  if (activeColorBy.value === "speed") {
    for (let bucket = 0; bucket < HEAT_RAMP.length; bucket++) {
      ctx.strokeStyle = HEAT_RAMP[bucket];
      strokePath(
        ctx,
        t,
        layer,
        (segment) => segment.extruding && speedBucket(segment.feed) === bucket,
      );
    }
    return;
  }
  ctx.strokeStyle = EXTRUSION_COLOR;
  strokePath(ctx, t, layer, isExtruding);
}

/* ------------------------------------------------------------------ *
 * the offscreen stack and the paint loop
 * ------------------------------------------------------------------ */

let stackCanvas: HTMLCanvasElement | null = null;
/** Layers [0, stackDrawn) are already in the offscreen bitmap. */
let stackDrawn = 0;
let stackDirty = true;
/**
 * The transform the offscreen bitmap was drawn with. Panning only shifts where
 * that bitmap is blitted, so this is how far the blit has to move.
 */
let stackTransform: Transform | null = null;
let frameHandle: number | null = null;
let dprUsed = 1;

function requestDraw(): void {
  if (frameHandle !== null) return;
  frameHandle = requestAnimationFrame(step);
}

function invalidateStack(): void {
  stackDirty = true;
  requestDraw();
}

function resizeCanvases(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  stackCanvas ??= document.createElement("canvas");
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const cssWidth = Math.max(MIN_WIDTH, Math.round(boxWidth.value));
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(VIEW_HEIGHT * dpr);
  if (
    canvas.width === pixelWidth &&
    canvas.height === pixelHeight &&
    stackCanvas.width === pixelWidth &&
    stackCanvas.height === pixelHeight &&
    dprUsed === dpr
  ) {
    return;
  }
  dprUsed = dpr;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  stackCanvas.width = pixelWidth;
  stackCanvas.height = pixelHeight;
  // Resizing a canvas resets its transform, so both have to be rescaled again.
  canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  stackCanvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  stackDirty = true;
}

function paint(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext("2d") ?? null;
  if (ctx === null) return;
  const width = Math.max(MIN_WIDTH, boxWidth.value);
  ctx.clearRect(0, 0, width, VIEW_HEIGHT);
  const t = currentTransform();
  if (stackCanvas !== null && stackTransform !== null && stackDrawn > 0) {
    ctx.globalAlpha = 1;
    ctx.drawImage(
      stackCanvas,
      t.ox - stackTransform.ox,
      t.oy - stackTransform.oy,
      width,
      VIEW_HEIGHT,
    );
  }
  drawCurrentLayer(ctx, t);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

/**
 * One animation frame of work. A scrub backwards throws the bitmap away and
 * starts again, but because the rebuild is chunked the picture keeps updating
 * while the drag is in flight instead of freezing until it settles.
 */
function step(): void {
  frameHandle = null;
  resizeCanvases();
  const target = layerIndex.value;
  const ctx = stackCanvas?.getContext("2d") ?? null;
  if (ctx === null) {
    paint();
    return;
  }
  if (stackDirty || stackDrawn > target) {
    ctx.clearRect(0, 0, Math.max(MIN_WIDTH, boxWidth.value), VIEW_HEIGHT);
    stackDrawn = 0;
    stackDirty = false;
    stackTransform = currentTransform();
  }
  const t = stackTransform ?? currentTransform();
  let budget = SEGMENT_BUDGET;
  while (stackDrawn < target && budget > 0) {
    drawStackLayer(ctx, t, stackDrawn);
    budget -= layers.value[stackDrawn]?.segments.length ?? 1;
    stackDrawn += 1;
  }
  drawnCount.value = stackDrawn;
  buildingStack.value = stackDrawn < target;
  paint();
  if (stackDrawn < target) requestDraw();
}

/* ------------------------------------------------------------------ *
 * pan and zoom
 * ------------------------------------------------------------------ */

/** Zoom while holding the point under (sx, sy) on the same pixel. */
function applyZoom(next: number, sx: number, sy: number): void {
  const level = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  const base = fit.value.scale;
  const before = base * zoom.value;
  const after = base * level;
  if (before > 0) {
    const width = Math.max(MIN_WIDTH, boxWidth.value);
    const ux = (sx - width / 2 - panX.value) / before;
    const uy = (sy - VIEW_HEIGHT / 2 - panY.value) / before;
    panX.value += ux * (before - after);
    panY.value += uy * (before - after);
  }
  zoom.value = level;
}

function localPoint(clientX: number, clientY: number): Point2 | null {
  const el = viewportRef.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function onWheel(e: WheelEvent): void {
  if (!hasDrawing.value) return;
  const point = localPoint(e.clientX, e.clientY);
  if (point === null) return;
  applyZoom(zoom.value * Math.pow(1.0016, -e.deltaY), point.x, point.y);
}

function zoomBy(factor: number): void {
  const width = Math.max(MIN_WIDTH, boxWidth.value);
  applyZoom(zoom.value * factor, width / 2, VIEW_HEIGHT / 2);
}

const pointers = new Map<number, Point2>();
let pinchSpread = 0;
/** True once a drag has actually moved the picture, so a plain click on the
 * canvas does not throw the offscreen stack away and redraw it for nothing. */
let panMoved = false;

function spreadOf(points: Point2[]): number {
  const [a, b] = points;
  if (a === undefined || b === undefined) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(e: PointerEvent): void {
  if (!hasDrawing.value) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchSpread = pointers.size === 2 ? spreadOf([...pointers.values()]) : 0;
  panning.value = pointers.size === 1;
  panMoved = false;
}

function onPointerMove(e: PointerEvent): void {
  const previous = pointers.get(e.pointerId);
  if (previous === undefined) return;
  const next: Point2 = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, next);

  if (pointers.size === 1) {
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    if (dx !== 0 || dy !== 0) panMoved = true;
    panX.value += dx;
    panY.value += dy;
    return;
  }
  if (pointers.size !== 2) return;
  const values = [...pointers.values()];
  const spread = spreadOf(values);
  const [a, b] = values;
  if (pinchSpread > 0 && spread > 0 && a !== undefined && b !== undefined) {
    const mid = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (mid !== null) applyZoom(zoom.value * (spread / pinchSpread), mid.x, mid.y);
  }
  pinchSpread = spread;
}

function onPointerUp(e: PointerEvent): void {
  if (!pointers.has(e.pointerId)) return;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  pointers.delete(e.pointerId);
  pinchSpread = 0;
  panning.value = false;
  // The blit only shifts the bitmap, so redraw once the drag settles to fill
  // in whatever the pan brought into view. A click that moved nothing needs no
  // rebuild, and a pinch already rebuilt through the zoom watcher.
  if (panMoved) {
    panMoved = false;
    invalidateStack();
  }
}

/* ------------------------------------------------------------------ *
 * playback
 * ------------------------------------------------------------------ */

let playTimer: ReturnType<typeof setInterval> | null = null;

function stopPlayback(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  playing.value = false;
}

function startPlayback(): void {
  if (playTimer !== null) clearInterval(playTimer);
  playTimer = setInterval(() => {
    if (layerIndex.value >= lastLayer.value) {
      stopPlayback();
      return;
    }
    layerIndex.value += 1;
  }, 1000 / speedRate.value);
}

function togglePlay(): void {
  if (playing.value) {
    stopPlayback();
    return;
  }
  if (!hasDrawing.value) return;
  if (layerIndex.value >= lastLayer.value) layerIndex.value = 0;
  playing.value = true;
  startPlayback();
}

function onLayerSlider(value: number[] | undefined): void {
  stopPlayback();
  const next = Number(value?.[0] ?? layerIndex.value);
  layerIndex.value = Math.min(lastLayer.value, Math.max(0, Math.round(next)));
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

function baseName(): string {
  const name = fileName.value;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem === "" ? "gcode" : stem;
}

/** The pane color behind the canvas, so a PNG is not saved on transparency. */
function backdropColor(el: HTMLElement): string {
  const color = window.getComputedStyle(el).backgroundColor;
  if (color === "" || color === "transparent" || color.startsWith("rgba(0, 0, 0, 0")) {
    return "#ffffff";
  }
  return color;
}

function exportPng(): void {
  const canvas = canvasRef.value;
  const host = viewportRef.value;
  if (!canvas || !host) return;
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (ctx === null) {
    error.value = {
      message: "This browser did not give the page a 2D canvas, so the PNG could not be drawn.",
      fix: "Try another browser, or take a screenshot of the view instead.",
    };
    return;
  }
  ctx.fillStyle = backdropColor(host);
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  out.toBlob((blob) => {
    if (blob === null) {
      error.value = {
        message: "The PNG could not be encoded.",
        fix: "Try another browser, or take a screenshot of the view instead.",
      };
      return;
    }
    downloadBlob(blob, `${baseName()}-layer-${layerIndex.value + 1}.png`);
  }, "image/png");
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

let observer: ResizeObserver | null = null;

watch(
  canvasRef,
  (el) => {
    observer?.disconnect();
    observer = null;
    if (!el) return;
    const host = viewportRef.value;
    if (!host) return;
    boxWidth.value = Math.max(MIN_WIDTH, Math.round(host.clientWidth || boxWidth.value));
    observer = new ResizeObserver((entries) => {
      const next = Math.max(MIN_WIDTH, Math.round(entries[0]?.contentRect.width ?? boxWidth.value));
      if (next !== boxWidth.value) boxWidth.value = next;
    });
    observer.observe(host);
    invalidateStack();
  },
  { flush: "post" },
);

// A different projection, scale, shading or canvas size means the offscreen
// bitmap no longer matches; a different layer, coloring or travel setting only
// changes what is painted on top of it.
watch([view, stackShading, zoom, boxWidth], invalidateStack);
watch([layerIndex, colorBy, showTravel, panX, panY], requestDraw);
watch(speed, () => {
  if (playing.value) startPlayback();
});

onMounted(() => {
  // Playback is an explicit click, so it is never blocked, but a reader who
  // asked for less motion gets the gentlest step rate by default.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) speed.value = "slow";
});

onBeforeUnmount(() => {
  stopPlayback();
  clearTimeout(pasteTimer);
  observer?.disconnect();
  observer = null;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  stackCanvas = null;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      bare
      accept=".gcode,.gco,.g,.nc,.ngc,.tap,text/plain"
      label="Program"
      hint="Drop a .gcode, .gco or .nc file here, or click to choose one"
      @files="onFiles"
    >
      <template #default="{ open }">
        <div class="flex flex-wrap items-center justify-between gap-1 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Program
          </span>
          <Button variant="ghost" size="sm" @click="open"> Open a G-code file… </Button>
        </div>

        <div v-if="model" class="px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <button
              type="button"
              aria-label="Remove this program"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <div v-else class="flex flex-col gap-2 px-3 pt-1 pb-3">
          <p class="text-sm text-muted-foreground">
            Drop a .gcode, .gco or .nc file here, or paste a short program below. Everything is
            walked in this tab: your files and inputs never leave your device.
          </p>
          <Textarea
            :model-value="pasted"
            rows="4"
            spellcheck="false"
            placeholder="Paste G-code here, for example G28 then G1 X10 Y10 E1 F1200…"
            class="resize-y bg-card font-mono text-xs"
            @update:model-value="onPaste"
          />
        </div>
      </template>
    </FileDrop>

    <!-- Status -->
    <p v-if="stage !== 'idle'" role="status" class="text-sm text-muted-foreground">
      {{ statusText }}
    </p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="model">
      <template v-if="hasDrawing">
        <!-- Render controls -->
        <div
          class="flex flex-wrap items-end gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">View</span>
            <div
              role="group"
              aria-label="View"
              class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]"
            >
              <Button
                v-for="option in VIEW_OPTIONS"
                :key="option.value"
                variant="ghost"
                size="sm"
                :aria-pressed="view === option.value"
                :class="view === option.value ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                @click="view = option.value"
              >
                {{ option.label }}
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Layers below</span>
            <div
              role="group"
              aria-label="Layers below"
              class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]"
            >
              <Button
                v-for="option in SHADING_OPTIONS"
                :key="option.value"
                variant="ghost"
                size="sm"
                :aria-pressed="stackShading === option.value"
                :class="stackShading === option.value ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                @click="stackShading = option.value"
              >
                {{ option.label }}
              </Button>
            </div>
          </div>

          <div class="flex w-48 flex-col gap-1.5">
            <Label for="gcode-color-by" class="text-xs text-muted-foreground">
              {{ colorBySpec.label }}
            </Label>
            <SearchableSelect
              id="gcode-color-by"
              :spec="colorBySpec"
              :model-value="colorBy"
              @update:model-value="(v) => (colorBy = String(v))"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="gcode-travel" class="w-fit cursor-pointer text-xs text-muted-foreground">
              {{ travelLabel }}
            </Label>
            <Switch
              id="gcode-travel"
              :model-value="showTravel"
              @update:model-value="showTravel = Boolean($event)"
            />
          </div>
        </div>

        <!-- Canvas -->
        <div
          ref="viewportRef"
          class="relative touch-none overflow-hidden rounded-[10px] bg-card shadow-[var(--sh-inset)]"
          :class="panning ? 'cursor-grabbing' : 'cursor-grab'"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <canvas
            ref="canvasRef"
            role="img"
            :aria-label="canvasLabel"
            class="block w-full"
            :style="{ height: `${VIEW_HEIGHT}px` }"
          />

          <div
            v-if="buildingStack"
            class="pointer-events-none absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-[8px] border bg-popover/90 px-2 py-1.5 text-xs text-popover-foreground shadow-[var(--sh-md)]"
            aria-live="polite"
          >
            <span class="shrink-0 tabular-nums">{{ statusText }}</span>
            <ProgressBar class="flex-1" size="sm" :value="Math.round(buildProgress * 100)" />
          </div>
        </div>

        <!-- Transport. A one layer program has nothing to scrub, and a slider
             whose minimum equals its maximum has no position to sit at. -->
        <div v-if="lastLayer > 0" class="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="icon-sm"
            :aria-label="playing ? 'Pause the layer walkthrough' : 'Play the layer walkthrough'"
            @click="togglePlay"
          >
            <Pause v-if="playing" class="size-3.5" aria-hidden="true" />
            <Play v-else class="size-3.5" aria-hidden="true" />
          </Button>

          <Slider
            id="gcode-layer"
            :model-value="[layerIndex]"
            :min="0"
            :max="lastLayer"
            :step="1"
            aria-label="Layer"
            class="min-w-40 flex-1"
            @update:model-value="onLayerSlider"
          />

          <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            Layer {{ layerIndex + 1 }} of {{ layerCount }}
          </span>

          <div
            role="group"
            aria-label="Playback speed"
            class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          >
            <Button
              v-for="option in SPEED_OPTIONS"
              :key="option.value"
              variant="ghost"
              size="sm"
              :aria-pressed="speed === option.value"
              :class="speed === option.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="speed = option.value"
            >
              {{ option.label }}
            </Button>
          </div>
        </div>

        <p v-else class="font-mono text-xs tabular-nums text-muted-foreground">
          Layer 1 of 1, the only layer in this program.
        </p>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            Drag to pan, scroll or pinch to zoom. Travel moves are drawn on the current layer only,
            so the stack underneath stays readable.
          </p>
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="sm" @click="zoomBy(1 / 1.4)"> Zoom out </Button>
            <Button variant="ghost" size="sm" @click="zoomBy(1.4)"> Zoom in </Button>
            <Button variant="outline" size="sm" @click="resetView"> Fit view </Button>
            <Button variant="outline" size="sm" @click="exportPng">
              <Download class="size-3.5" aria-hidden="true" />
              Download PNG
            </Button>
          </div>
        </div>

        <!-- The layer you are on -->
        <div
          v-if="currentStats"
          class="grid gap-x-6 gap-y-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)] sm:grid-cols-2 lg:grid-cols-3"
        >
          <div>
            <div class="text-xs text-muted-foreground">Height</div>
            <div class="font-mono text-sm tabular-nums">
              Z {{ fixed(currentStats.z) }} mm, {{ fixed(currentStats.layerHeight) }} mm thick
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Moves</div>
            <div class="font-mono text-sm tabular-nums">
              {{ currentStats.extrudingSegments }} extruding,
              {{ currentStats.travelSegments }} travel
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Path length</div>
            <div class="font-mono text-sm tabular-nums">
              {{ fixed(currentStats.extrudingLength) }} mm extruding,
              {{ fixed(currentStats.travelLength) }} mm travel
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Filament</div>
            <div class="font-mono text-sm tabular-nums">
              {{ fixed(currentStats.filamentMm) }} mm
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Rough time</div>
            <div class="font-mono text-sm tabular-nums">
              {{ formatDuration(currentStats.estimatedTimeSec) }}
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Feed rate</div>
            <div class="font-mono text-sm tabular-nums">{{ feedText }}</div>
          </div>
        </div>
      </template>

      <p v-else class="rounded-lg bg-secondary/60 px-3 py-2 text-sm text-muted-foreground">
        This program has no moves that draw in the XY plane, so there is nothing to render. The
        totals below still cover every move in the file.
      </p>

      <OutputView v-if="stats" :output="stats" />
    </template>
  </div>
</template>
