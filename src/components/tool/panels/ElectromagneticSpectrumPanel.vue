<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, type Component } from "vue";
import type { ToolMeta } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import {
  AXIS_DECADES,
  describeFrequency,
  formatEnergyEv,
  formatFrequency,
  formatKelvin,
  formatWavelength,
  frequencyToPosition,
  interpretQuery,
  positionToFrequency,
  type Interpretation,
  type Readout,
} from "@/tools/electromagnetic-spectrum/index";
import {
  MIN_SPAN,
  axisLengthPx,
  axisPxToFreq,
  axisPxToPos,
  buildBandLabels,
  buildScene,
  centerHoldingAnchor,
  clampAxisPx,
  clampWindow,
  freqToAxisPx,
  mapHeightPx,
  packBands,
  sceneToSvg,
  spectralStops,
  withAlpha,
  type AxisView,
  type Orientation,
  type Scene,
  type SceneRect,
} from "@/tools/electromagnetic-spectrum/layout";
import { Button } from "@/components/ui/button";
import CopyButton from "../CopyButton.vue";
import FitText from "../FitText.vue";
import {
  Download,
  Link as LinkIcon,
  Search,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
  // Band icons: exactly the names in ICON_NAMES from the data module, so the
  // bundle only pulls the glyphs the tree actually references.
  Anchor,
  Antenna,
  Atom,
  Bluetooth,
  Clock,
  CloudRain,
  Eye,
  Microwave,
  Plane,
  Radar,
  Radiation,
  RadioReceiver,
  RadioTower,
  Router,
  Satellite,
  SatelliteDish,
  ScanLine,
  Ship,
  SignalHigh,
  Smartphone,
  Sun,
  Thermometer,
  Tv,
  Wifi,
} from "lucide-vue-next";

/**
 * Bespoke panel for the Electromagnetic Spectrum explorer.
 *
 * All physics, the log10 position mapping, the band lookup and the search brain
 * (interpretQuery) live in the pure logic layer; the lane packing, the axis
 * coordinate transforms and the scene description live beside them in
 * layout.ts. This panel owns only what needs a browser: the canvas painter, the
 * DOM band-label overlay (auto-fit via FitText), pointer and keyboard
 * interaction (drag-select to zoom, scroll pan, ctrl and scroll zoom, touch
 * scrub and pinch), the lockable readout tooltip, the combined number and search
 * bar, the export downloads, and the shareable URL fragment.
 *
 * Fragment schema: f = center frequency in hertz, d = decades visible,
 * q = optional locked frequency in hertz, o = manual orientation override
 * ("h" or "v", absent means auto).
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ */
/* Icon name to component map (only the names ICON_NAMES declares)     */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, Component> = {
  Anchor,
  Antenna,
  Atom,
  Bluetooth,
  Clock,
  CloudRain,
  Eye,
  Microwave,
  Plane,
  Radar,
  Radiation,
  RadioReceiver,
  RadioTower,
  Router,
  Satellite,
  SatelliteDish,
  ScanLine,
  Ship,
  SignalHigh,
  Smartphone,
  Sun,
  Thermometer,
  Tv,
  Wifi,
};

/** Resolve a band or interpretation icon name to a component, or null. */
function iconFor(name?: string): Component | null {
  return name && name in ICON_MAP ? ICON_MAP[name]! : null;
}

/* ------------------------------------------------------------------ */
/* Constants and refs                                                  */
/* ------------------------------------------------------------------ */

/**
 * The lane assignment for every band. It depends only on the static band ranges,
 * never on the view, so it is computed once at module load and reused for every
 * frame, every label pass and every export.
 */
const { packed: PACKED, totalLanes: TOTAL_LANES } = packBands();

/**
 * The horizontal map height, driven by the lane count so a deeper band tree
 * grows the map instead of crushing rows. Static, since the lane count is. In
 * fullscreen the browser's own `:fullscreen` rule overrides it to fill the
 * screen.
 */
const HORIZONTAL_MAP_PX = mapHeightPx(TOTAL_LANES);

/** The visible-light gradient stops, identical on every frame and every export. */
const SPECTRAL_STOPS = spectralStops();

/** Mouse move past this many CSS px turns a press into a drag-select zoom. */
const DRAG_THRESHOLD = 5;

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const readoutCardRef = ref<HTMLDivElement | null>(null);

const isFullscreen = ref(false);

// Orientation: an auto choice from the viewport, plus an optional manual
// override that a shared link can carry. The effective orientation is derived.
const autoOrientation = ref<Orientation>("horizontal");
const orientationOverride = ref<Orientation | null>(null);
const orientation = computed<Orientation>(() => orientationOverride.value ?? autoOrientation.value);

/**
 * The map container size. Horizontal height is driven by the packed lane count
 * (so a deeper tree grows the map taller instead of crushing rows); vertical
 * keeps a tall, viewport-relative window for the frequency axis. In fullscreen
 * the browser's `:fullscreen` rule fills the screen and overrides this.
 */
// The return type is annotated on the getter, not on computed<T>: without it TS
// infers the union of the two literal shapes, normalizes the empty branch to
// `{ height?: undefined }`, and that optional-undefined property is not
// assignable to Record<string, string>.
const containerStyle = computed((): Record<string, string> => {
  // In fullscreen the element fills the screen; leave the height to the browser.
  if (isFullscreen.value) return {};
  return orientation.value === "vertical"
    ? { height: "clamp(360px, 74vh, 820px)" }
    : { height: `${HORIZONTAL_MAP_PX}px` };
});

const cssW = ref(800);
const cssH = ref(320);

// View: center (0..1 along the axis) and span (fraction of the full axis).
const center = ref(0.5);
const span = ref(1);

const hoverFreq = ref<number | null>(null);
const pinnedFreq = ref<number | null>(null);
/** True once a click locks the tooltip so hover no longer moves it. */
const locked = ref(false);
const pointerPx = ref<{ x: number; y: number } | null>(null);
/** Which breadcrumb segment is hovered, so it can bold. */
const hoveredSegment = ref<number | null>(null);

const reducedMotion = ref(false);

/* ------------------------------------------------------------------ */
/* Theme color cache (canvas cannot read CSS variables)                */
/* ------------------------------------------------------------------ */

const colors = reactive({
  fg: "#1b1917",
  muted: "#57514a",
  border: "#e7e2da",
  surface: "#f0ede8",
  card: "#ffffff",
  accentSoft: "#efebfe",
  primary: "#5b4bd6",
  positive: "#2f7d5b",
});

function refreshColors() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  colors.fg = read("--foreground", colors.fg);
  colors.muted = read("--muted-foreground", colors.muted);
  colors.border = read("--border", colors.border);
  colors.surface = read("--secondary", colors.surface);
  colors.card = read("--card", colors.card);
  colors.accentSoft = read("--accent-soft", colors.accentSoft);
  colors.primary = read("--primary", colors.primary);
  colors.positive = read("--positive", colors.positive);
  scheduleDraw();
}

/* ------------------------------------------------------------------ */
/* View math                                                           */
/* ------------------------------------------------------------------ */

/** Apply the zoom and pan limits to the live view. */
function clampView() {
  const held = clampWindow({ center: center.value, span: span.value });
  center.value = held.center;
  span.value = held.span;
}

/** Axis length in CSS pixels (the long dimension). */
function axisLength(): number {
  return axisLengthPx(cssW.value, cssH.value, orientation.value);
}

/** The live view as the plain value the layout transforms take. */
function currentView(): AxisView {
  return { center: center.value, span: span.value, lengthPx: axisLength() };
}

/** Pointer event offset to the axis coordinate for the current orientation. */
function eventAxisPx(e: PointerEvent): number {
  const rect = canvasRef.value!.getBoundingClientRect();
  return orientation.value === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top;
}

/** The frequency under an axis pixel, held inside the drawn axis. */
function freqAtAxisPx(px: number): number {
  const view = currentView();
  return axisPxToFreq(clampAxisPx(px, view), view);
}

/* ------------------------------------------------------------------ */
/* Scene building (shared by canvas, PNG and SVG)                      */
/* ------------------------------------------------------------------ */

/**
 * Describe the current view as a scene. The geometry lives in the logic layer;
 * this only gathers the reactive state it reads from.
 */
function sceneFor(w: number, h: number): Scene {
  return buildScene({
    width: w,
    height: h,
    orientation: orientation.value,
    window: { center: center.value, span: span.value },
    packed: PACKED,
    totalLanes: TOTAL_LANES,
    colors,
    pinnedFreqHz: pinnedFreq.value,
    cursorFreqHz: activeFreq.value,
  });
}

/* ------------------------------------------------------------------ */
/* DOM band-label overlay (auto-fit via FitText)                       */
/* ------------------------------------------------------------------ */

/**
 * The band labels to overlay on the canvas, positioned in CSS px. Reactive on
 * the view and orientation, so labels reflow as the user pans and zooms; the
 * decision of which labels survive at this zoom, and where their boxes go, is
 * layout arithmetic and lives in the logic layer. FitText scales the survivors
 * to fill their box.
 */
const bandLabels = computed(() =>
  buildBandLabels({
    width: cssW.value,
    height: cssH.value,
    orientation: orientation.value,
    window: { center: center.value, span: span.value },
    packed: PACKED,
    totalLanes: TOTAL_LANES,
  }),
);

/* ------------------------------------------------------------------ */
/* Canvas painting                                                     */
/* ------------------------------------------------------------------ */

function spectralGradient(
  make: (x1: number, y1: number, x2: number, y2: number) => CanvasGradient,
  s: NonNullable<SceneRect["spectral"]>,
): CanvasGradient {
  const grad = make(s.x1, s.y1, s.x2, s.y2);
  for (const stop of SPECTRAL_STOPS) grad.addColorStop(stop.offset, stop.color);
  return grad;
}

function paintCanvas(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  scale: number,
  includeBandLabels = false,
) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, scene.w, scene.h);
  ctx.fillStyle = colors.card;
  ctx.fillRect(0, 0, scene.w, scene.h);

  for (const r of scene.rects) {
    ctx.fillStyle = r.spectral
      ? spectralGradient((x1, y1, x2, y2) => ctx.createLinearGradient(x1, y1, x2, y2), r.spectral)
      : r.fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = r.stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }

  for (const l of scene.lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.setLineDash(l.dash ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const allTexts = includeBandLabels ? [...scene.texts, ...scene.bandTexts] : scene.texts;
  for (const t of allTexts) {
    if (t.plate) {
      ctx.fillStyle = withAlpha(colors.card, 0.72);
      ctx.fillRect(t.plate.x, t.plate.y, t.plate.w, t.plate.h);
    }
    ctx.fillStyle = t.color;
    ctx.font = `${t.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = t.align === "center" ? "center" : "left";
    ctx.textBaseline = "middle";
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.restore();
}

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cssW.value;
  const h = cssH.value;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const scene = sceneFor(w, h);
  paintCanvas(ctx, scene, dpr, false);
}

/* ------------------------------------------------------------------ */
/* Readout                                                             */
/* ------------------------------------------------------------------ */

const activeFreq = computed<number | null>(() => hoverFreq.value ?? pinnedFreq.value);
const activeReadout = computed<Readout | null>(() =>
  activeFreq.value != null ? describeFrequency(activeFreq.value) : null,
);

interface Row {
  label: string;
  value: string;
  swatch?: string;
}
const readoutRows = computed<Row[]>(() => {
  const r = activeReadout.value;
  if (!r) return [];
  const rows: Row[] = [
    { label: "Frequency", value: formatFrequency(r.frequencyHz) },
    { label: "Wavelength", value: formatWavelength(r.wavelengthM) },
    { label: "Photon energy", value: formatEnergyEv(r.energyEv) },
    { label: "Black-body peak", value: formatKelvin(r.blackbodyKelvin) },
    { label: "Band", value: r.pathLabel },
    { label: "Ionizing", value: r.ionizing ? "Yes (approximate, at or above 10 eV)" : "No" },
  ];
  if (r.colorHex) rows.push({ label: "Color", value: r.colorHex, swatch: r.colorHex });
  return rows;
});

/** The value rows shown in the card body: the band path is drawn as chips. */
const valueRows = computed<Row[]>(() => readoutRows.value.filter((r) => r.label !== "Band"));

const copyableText = computed(() => {
  const lines = readoutRows.value.map((r) => `${r.label}: ${r.value}`);
  const uses = activeReadout.value?.uses ?? [];
  if (uses.length) lines.push(`Common uses: ${uses.join(", ")}`);
  return lines.join("\n");
});

/**
 * The tooltip anchor. When there is a pinned frequency and no live hover (a
 * locked tooltip, or a touch scrub), derive the pixel from the frequency so the
 * tooltip tracks the marker through pans, zooms and orientation flips. In hover
 * mode it follows the raw pointer pixel.
 */
const tooltipAnchor = computed<{ x: number; y: number } | null>(() => {
  if (hoverFreq.value == null && pinnedFreq.value != null) {
    const apx = freqToAxisPx(pinnedFreq.value, currentView());
    return orientation.value === "horizontal"
      ? { x: apx, y: cssH.value * 0.4 }
      : { x: cssW.value * 0.5, y: apx };
  }
  return pointerPx.value;
});

/** Tooltip position, flipped away from the near edges. */
const tooltipStyle = computed(() => {
  const p = tooltipAnchor.value;
  if (!p) return { display: "none" };
  const flipX = p.x > cssW.value * 0.62;
  const flipY = p.y > cssH.value * 0.6;
  return {
    left: `${p.x}px`,
    top: `${p.y}px`,
    transform: `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% - 14px)" : "14px"})`,
    transition: reducedMotion.value ? "none" : "left 60ms linear, top 60ms linear",
  } as Record<string, string>;
});

/* ------------------------------------------------------------------ */
/* Combined number and search bar (interpretQuery)                     */
/* ------------------------------------------------------------------ */

const jumpText = ref("");
const results = computed<Interpretation[]>(() => interpretQuery(jumpText.value));
const activeIndex = ref(0);
const searchOpen = ref(false);
const searchField = ref<"main" | "fullscreen">("main");

/** The dropdown is open, focused, and has query text to interpret. */
function dropdownVisible(field: "main" | "fullscreen"): boolean {
  return searchOpen.value && searchField.value === field && jumpText.value.trim().length > 0;
}

watch(jumpText, () => {
  activeIndex.value = 0;
  searchOpen.value = true;
});

function onSearchFocus(field: "main" | "fullscreen") {
  searchField.value = field;
  searchOpen.value = true;
}

function onSearchBlur() {
  // A short delay lets a row's pointerdown pick fire before the list hides.
  setTimeout(() => (searchOpen.value = false), 120);
}

function moveActive(delta: number) {
  const n = results.value.length;
  if (!n) return;
  searchOpen.value = true;
  activeIndex.value = Math.max(0, Math.min(n - 1, activeIndex.value + delta));
}

function confirmActive() {
  const r = results.value;
  if (!r.length) return;
  pickInterpretation(r[Math.min(activeIndex.value, r.length - 1)]!);
}

/** Navigate the view to a chosen interpretation and lock the readout there. */
function pickInterpretation(it: Interpretation) {
  pinnedFreq.value = it.frequencyHz;
  hoverFreq.value = null;
  locked.value = true;
  searchOpen.value = false;
  if (it.rangeHz) {
    // Zoom to fit the band or channel span with a little padding.
    const pLow = frequencyToPosition(it.rangeHz[0]);
    const pHigh = frequencyToPosition(it.rangeHz[1]);
    const lo = Math.min(pLow, pHigh);
    const hi = Math.max(pLow, pHigh);
    animateTo((lo + hi) / 2, (hi - lo) * 1.35 || MIN_SPAN);
  } else {
    // Center the point at a comfortable window (about four decades).
    const rawSpan = Math.max(MIN_SPAN, Math.min(span.value, 4 / AXIS_DECADES));
    animateTo(frequencyToPosition(it.frequencyHz), rawSpan);
  }
  scheduleFragmentWrite();
}

/* ------------------------------------------------------------------ */
/* Pointer interaction                                                 */
/* ------------------------------------------------------------------ */

const activePointers = new Map<number, { x: number; y: number }>();

// Mouse press bookkeeping: a small move keeps it a click (tooltip lock), a
// larger move becomes a drag-select zoom.
let mouseDown = false;
let downAxisPx = 0;
let downMoved = false;
let lastClickAt = 0;

// The live drag-select rectangle, in axis px (reactive so the overlay redraws).
const selecting = ref(false);
const selStart = ref(0);
const selEnd = ref(0);

// Pinch (touch) bookkeeping.
let pinchStartDist = 0;
let pinchStartSpan = 1;
let pinchAnchorPos = 0;

const selectionStyle = computed(() => {
  if (!selecting.value) return { display: "none" } as Record<string, string>;
  const a = Math.min(selStart.value, selEnd.value);
  const b = Math.max(selStart.value, selEnd.value);
  return orientation.value === "horizontal"
    ? { left: `${a}px`, top: "0px", width: `${b - a}px`, height: "100%" }
    : { top: `${a}px`, left: "0px", height: `${b - a}px`, width: "100%" };
});

function setPointerPxFromClient(clientX: number, clientY: number) {
  const rect = canvasRef.value!.getBoundingClientRect();
  pointerPx.value = { x: clientX - rect.left, y: clientY - rect.top };
}

function readAt(e: PointerEvent, pin: boolean) {
  const freq = freqAtAxisPx(eventAxisPx(e));
  if (pin) pinnedFreq.value = freq;
  else hoverFreq.value = freq;
  setPointerPxFromClient(e.clientX, e.clientY);
  scheduleDraw();
  scheduleFragmentWrite();
}

function onPointerDown(e: PointerEvent) {
  canvasRef.value?.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2) {
    // Begin pinch: record distance, span and the anchor frequency at midpoint.
    const pts = [...activePointers.values()];
    pinchStartDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
    pinchStartSpan = span.value;
    const rect = canvasRef.value!.getBoundingClientRect();
    const midClient =
      orientation.value === "horizontal"
        ? (pts[0]!.x + pts[1]!.x) / 2 - rect.left
        : (pts[0]!.y + pts[1]!.y) / 2 - rect.top;
    pinchAnchorPos = axisPxToPos(midClient, currentView());
    mouseDown = false;
    selecting.value = false;
    return;
  }

  if (e.pointerType === "mouse") {
    // Mouse: press starts a potential drag-select; a click (tiny move) toggles
    // the tooltip lock on release.
    mouseDown = true;
    downMoved = false;
    downAxisPx = eventAxisPx(e);
  } else {
    // Touch and pen scrub the readout directly (unchanged behavior).
    readAt(e, true);
  }
}

function onPointerMove(e: PointerEvent) {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  if (activePointers.size === 2 && pinchStartDist > 0) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
    if (dist > 0) {
      span.value = pinchStartSpan * (pinchStartDist / dist);
      clampView();
      const rect = canvasRef.value!.getBoundingClientRect();
      const midPx =
        orientation.value === "horizontal"
          ? (pts[0]!.x + pts[1]!.x) / 2 - rect.left
          : (pts[0]!.y + pts[1]!.y) / 2 - rect.top;
      // Keep the anchor frequency under the midpoint.
      center.value = centerHoldingAnchor(pinchAnchorPos, midPx, currentView());
      clampView();
      scheduleDraw();
      scheduleFragmentWrite();
    }
    return;
  }

  if (mouseDown && e.pointerType === "mouse") {
    const apx = eventAxisPx(e);
    if (!downMoved && Math.abs(apx - downAxisPx) > DRAG_THRESHOLD) {
      downMoved = true;
      selecting.value = true;
      selStart.value = downAxisPx;
    }
    if (downMoved) selEnd.value = apx;
    return;
  }

  if (e.pointerType === "mouse") {
    // A locked tooltip does not move on hover.
    if (!locked.value) readAt(e, false);
  } else if (activePointers.has(e.pointerId)) {
    readAt(e, true);
  }
}

function onPointerUp(e: PointerEvent) {
  if (mouseDown && e.pointerType === "mouse") {
    if (downMoved && selecting.value) {
      zoomToAxisPx(selStart.value, selEnd.value);
    } else {
      toggleLockAt(downAxisPx, e);
    }
    mouseDown = false;
    selecting.value = false;
  }
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  canvasRef.value?.releasePointerCapture?.(e.pointerId);
}

function onPointerLeave(e: PointerEvent) {
  if (e.pointerType === "mouse" && !mouseDown) {
    hoverFreq.value = null;
    if (pinnedFreq.value == null) pointerPx.value = null;
    scheduleDraw();
  }
}

/** Zoom the view so it fits the axis-pixel span the user swept. */
function zoomToAxisPx(a: number, b: number) {
  const view = currentView();
  const posA = axisPxToPos(clampAxisPx(a, view), view);
  const posB = axisPxToPos(clampAxisPx(b, view), view);
  const lo = Math.min(posA, posB);
  const hi = Math.max(posA, posB);
  animateTo((lo + hi) / 2, hi - lo);
  scheduleFragmentWrite();
}

/** A click (not a drag) toggles the readout lock at that point. */
function toggleLockAt(apx: number, e: PointerEvent) {
  const now = performance.now();
  const isDouble = now - lastClickAt < 280;
  lastClickAt = now;
  if (isDouble) return; // the dblclick handler resets the view instead

  const freq = freqAtAxisPx(apx);
  if (locked.value) {
    // Unlock and return to hover-follow from this point.
    locked.value = false;
    hoverFreq.value = freq;
    setPointerPxFromClient(e.clientX, e.clientY);
  } else {
    locked.value = true;
    pinnedFreq.value = freq;
    hoverFreq.value = null;
  }
  scheduleDraw();
  scheduleFragmentWrite();
}

/** The X button, or a click off the tooltip: unlock and clear the readout. */
function unlock() {
  locked.value = false;
  pinnedFreq.value = null;
  hoverFreq.value = null;
  pointerPx.value = null;
  scheduleDraw();
  scheduleFragmentWrite();
}

/** Double-click resets the zoom to the full modeled axis and clears the pin. */
function resetView() {
  locked.value = false;
  pinnedFreq.value = null;
  hoverFreq.value = null;
  pointerPx.value = null;
  animateTo(0.5, 1);
  scheduleFragmentWrite();
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = canvasRef.value!.getBoundingClientRect();
  const apx = orientation.value === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top;
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on the pointer.
    const anchorPos = axisPxToPos(apx, currentView());
    const factor = Math.exp(e.deltaY * 0.0016);
    span.value = span.value * factor;
    clampView();
    center.value = centerHoldingAnchor(anchorPos, apx, currentView());
    clampView();
  } else {
    // Pan along the axis.
    const primary =
      orientation.value === "horizontal" ? e.deltaX || e.deltaY : e.deltaY || e.deltaX;
    center.value += (primary / axisLength()) * span.value;
    clampView();
  }
  scheduleDraw();
  scheduleFragmentWrite();
}

function onKeydown(e: KeyboardEvent) {
  const panStep = span.value * 0.12;
  const zoomStep = 1.2;
  let handled = true;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowUp":
      center.value -= panStep;
      break;
    case "ArrowRight":
    case "ArrowDown":
      center.value += panStep;
      break;
    case "+":
    case "=":
      span.value /= zoomStep;
      break;
    case "-":
    case "_":
      span.value *= zoomStep;
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    clampView();
    scheduleDraw();
    scheduleFragmentWrite();
  }
}

/* ------------------------------------------------------------------ */
/* Orientation toggle                                                  */
/* ------------------------------------------------------------------ */

function toggleOrientation() {
  orientationOverride.value = orientation.value === "horizontal" ? "vertical" : "horizontal";
  requestAnimationFrame(measure);
  scheduleFragmentWrite();
}

/* ------------------------------------------------------------------ */
/* Animation                                                           */
/* ------------------------------------------------------------------ */

function animateTo(rawCenter: number, rawSpan: number) {
  const targetSpan = Math.min(1, Math.max(MIN_SPAN, rawSpan));
  const half = targetSpan / 2;
  const targetCenter = Math.min(1 - half, Math.max(half, rawCenter));
  if (reducedMotion.value) {
    center.value = targetCenter;
    span.value = targetSpan;
    clampView();
    scheduleDraw();
    scheduleFragmentWrite();
    return;
  }
  const startCenter = center.value;
  const startSpan = span.value;
  const t0 = performance.now();
  const dur = 420;
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur);
    const k = ease(t);
    center.value = startCenter + (targetCenter - startCenter) * k;
    span.value = startSpan + (targetSpan - startSpan) * k;
    draw();
    if (t < 1) requestAnimationFrame(step);
    else scheduleFragmentWrite();
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ */
/* Fragment persistence                                                */
/* ------------------------------------------------------------------ */

let fragTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFragmentWrite() {
  if (fragTimer) clearTimeout(fragTimer);
  fragTimer = setTimeout(writeFragmentNow, 300);
}

function writeFragmentNow() {
  const opts: Record<string, string> = {
    f: positionToFrequency(center.value).toExponential(4),
    d: (span.value * AXIS_DECADES).toFixed(3),
  };
  if (pinnedFreq.value != null) opts.q = pinnedFreq.value.toExponential(4);
  if (orientationOverride.value) opts.o = orientationOverride.value === "horizontal" ? "h" : "v";
  writeFragment({ opts });
}

function restoreFromFragment() {
  const { opts } = readFragment();
  const f = Number(opts.f);
  const d = Number(opts.d);
  if (Number.isFinite(f) && f > 0) center.value = frequencyToPosition(f);
  if (Number.isFinite(d) && d > 0) span.value = Math.min(1, Math.max(MIN_SPAN, d / AXIS_DECADES));
  clampView();
  if (opts.o === "h") orientationOverride.value = "horizontal";
  else if (opts.o === "v") orientationOverride.value = "vertical";
  const q = Number(opts.q);
  if (Number.isFinite(q) && q > 0) {
    // A shared link lands in the locked, selectable state.
    pinnedFreq.value = q;
    locked.value = true;
  }
}

/** CopyButton asks for the link at click time, after the fragment is flushed. */
function shareLink(): string {
  writeFragmentNow();
  return window.location.href;
}

/* ------------------------------------------------------------------ */
/* Fullscreen and outside-tap dismiss                                  */
/* ------------------------------------------------------------------ */

interface FsElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/**
 * Toggle fullscreen on the spectrum container only, so the visualization fills
 * the screen while the readout card and page chrome (which live outside the
 * container) stay hidden behind it. The tooltip and a minimal control overlay
 * live inside the container, so both remain usable in fullscreen.
 */
function toggleFullscreen() {
  const el = containerRef.value as FsElement | null;
  const doc = document as FsDocument;
  if (!el) return;
  const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  if (!current) {
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(el)).catch(() => {});
  } else {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(doc)).catch(() => {});
  }
}

function onFullscreenChange() {
  const doc = document as FsDocument;
  const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  isFullscreen.value = current === containerRef.value;
  // The viewport size changed, so relayout and re-evaluate orientation.
  requestAnimationFrame(measure);
}

/** Clicking or tapping outside the spectrum and its readout clears the lock. */
function onDocumentPointerDown(e: PointerEvent) {
  if (pinnedFreq.value == null && !locked.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (containerRef.value?.contains(target)) return;
  if (readoutCardRef.value?.contains(target)) return;
  locked.value = false;
  pinnedFreq.value = null;
  if (hoverFreq.value == null) pointerPx.value = null;
  scheduleFragmentWrite();
  scheduleDraw();
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function exportPng() {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = cssW.value * scale;
  canvas.height = cssH.value * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Bake the band labels into the exported raster (FitText cannot run here).
  paintCanvas(ctx, sceneFor(cssW.value, cssH.value), scale, true);
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, "electromagnetic-spectrum.png");
  }, "image/png");
}

function exportSvg() {
  const svg = sceneToSvg(sceneFor(cssW.value, cssH.value), colors);
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "electromagnetic-spectrum.svg");
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let motionMql: MediaQueryList | null = null;
let schemeMql: MediaQueryList | null = null;

function measure() {
  const el = containerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  cssW.value = Math.max(160, Math.round(rect.width));
  cssH.value = Math.max(160, Math.round(rect.height));
  // Auto orientation follows the viewport (landscape to horizontal, portrait to
  // vertical); a manual override, when set, wins via the `orientation` computed.
  autoOrientation.value = window.innerWidth >= window.innerHeight ? "horizontal" : "vertical";
  scheduleDraw();
}

const onMotionChange = () => (reducedMotion.value = !!motionMql?.matches);

onMounted(() => {
  motionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.value = motionMql.matches;
  motionMql.addEventListener("change", onMotionChange);

  schemeMql = window.matchMedia("(prefers-color-scheme: dark)");
  schemeMql.addEventListener("change", refreshColors);

  refreshColors();
  restoreFromFragment();
  measure();

  resizeObserver = new ResizeObserver(measure);
  if (containerRef.value) resizeObserver.observe(containerRef.value);

  themeObserver = new MutationObserver(refreshColors);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  canvasRef.value?.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  scheduleDraw();
});

onUnmounted(() => {
  motionMql?.removeEventListener("change", onMotionChange);
  schemeMql?.removeEventListener("change", refreshColors);
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  canvasRef.value?.removeEventListener("wheel", onWheel);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  if (fragTimer) clearTimeout(fragTimer);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-4 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-[220px] flex-1">
        <div
          class="flex items-center rounded-[10px] border bg-secondary shadow-[var(--sh-inset)] focus-within:ring-2 focus-within:ring-[color:var(--ring)]"
        >
          <Search class="ml-2.5 size-4 shrink-0 text-muted-foreground" />
          <input
            v-model="jumpText"
            type="text"
            inputmode="text"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="dropdownVisible('main')"
            placeholder="Search: 2.45 GHz, 550 nm, 10 keV, VHF, wifi channel 6"
            aria-label="Search by frequency, wavelength, energy, band name, or Wi-Fi channel"
            class="h-9 w-full bg-transparent px-2 font-mono text-sm outline-none"
            @focus="onSearchFocus('main')"
            @blur="onSearchBlur"
            @keydown.down.prevent="moveActive(1)"
            @keydown.up.prevent="moveActive(-1)"
            @keydown.enter.prevent="confirmActive"
            @keydown.esc="searchOpen = false"
          />
        </div>

        <!-- Suggestions dropdown -->
        <ul
          v-if="dropdownVisible('main')"
          role="listbox"
          aria-label="Search results"
          class="absolute top-[calc(100%+4px)] right-0 left-0 z-30 max-h-72 overflow-auto rounded-[12px] border bg-popover p-1 shadow-[var(--sh-lg)]"
        >
          <li v-if="!results.length" class="px-2.5 py-2 text-sm text-muted-foreground">
            No matches. Try 2.45 GHz, 550 nm, 10 keV, VHF, or wifi channel 6.
          </li>
          <li
            v-for="(it, i) in results"
            :key="it.id"
            role="option"
            :aria-selected="i === activeIndex"
            class="flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-1.5"
            :class="
              i === activeIndex
                ? 'bg-[color:var(--accent-soft)] text-[color:var(--primary)]'
                : 'hover:bg-secondary'
            "
            @mousedown.prevent="pickInterpretation(it)"
            @mouseenter="activeIndex = i"
          >
            <component :is="iconFor(it.icon) || Search" class="size-4 shrink-0 opacity-80" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ it.label }}</span>
              <span v-if="it.detail" class="block truncate text-xs text-muted-foreground">{{
                it.detail
              }}</span>
            </span>
            <span
              class="shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase"
              >{{ it.kind }}</span
            >
          </li>
        </ul>
      </div>

      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :aria-label="
            orientation === 'horizontal'
              ? 'Switch to vertical layout'
              : 'Switch to horizontal layout'
          "
          @click="toggleOrientation"
        >
          <RotateCw class="size-4" />
          <span class="hidden sm:inline">Rotate</span>
        </Button>
        <Button variant="outline" size="sm" aria-label="Export as PNG" @click="exportPng">
          <Download class="size-4" />
          PNG
        </Button>
        <Button variant="outline" size="sm" aria-label="Export as SVG" @click="exportSvg">
          <Download class="size-4" />
          SVG
        </Button>
        <CopyButton
          :get-text="shareLink"
          :icon="LinkIcon"
          label="Link"
          variant="outline"
          size="sm"
          aria-label="Copy shareable link"
        />
        <Button
          variant="outline"
          size="sm"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'View fullscreen'"
          :aria-pressed="isFullscreen"
          @click="toggleFullscreen"
        >
          <Minimize2 v-if="isFullscreen" class="size-4" />
          <Maximize2 v-else class="size-4" />
          Full
        </Button>
      </div>
    </div>

    <!-- Spectrum canvas -->
    <div
      ref="containerRef"
      class="relative w-full touch-none overflow-hidden rounded-[14px] border bg-card shadow-[var(--sh-inset)]"
      :style="containerStyle"
    >
      <canvas
        ref="canvasRef"
        tabindex="0"
        role="img"
        :aria-label="`Electromagnetic spectrum, log frequency axis, ${(span * AXIS_DECADES).toFixed(1)} decades in view. Arrow keys pan, plus and minus zoom, drag across to zoom to a range, double click to reset.`"
        class="block h-full w-full cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @dblclick="resetView"
        @keydown="onKeydown"
      />

      <!-- Band-label overlay: FitText scales each label to its band box -->
      <div class="pointer-events-none absolute inset-0 z-[5] select-none">
        <div
          v-for="l in bandLabels"
          :key="l.key"
          class="absolute flex items-center justify-center gap-1 px-1"
          :style="{ left: `${l.x}px`, top: `${l.y}px`, width: `${l.w}px`, height: `${l.h}px` }"
        >
          <div v-if="l.plate" class="absolute inset-0.5 rounded-[4px] bg-card/70"></div>
          <component
            :is="iconFor(l.icon)"
            v-if="l.showIcon && iconFor(l.icon)"
            class="relative z-[1] size-3.5 shrink-0 text-foreground/80"
          />
          <div v-if="!l.iconOnly" class="relative z-[1] h-full min-w-0 flex-1">
            <FitText :text="l.name" :min="7" :max="l.max" />
          </div>
        </div>
      </div>

      <!-- Drag-select zoom rectangle -->
      <div
        class="pointer-events-none absolute z-[6] rounded-[3px] border border-[color:var(--primary)] bg-[color:var(--brand-hairline)]"
        :style="selectionStyle"
      ></div>

      <!-- Minimal controls shown only in fullscreen (toolbar is hidden there) -->
      <div
        v-if="isFullscreen"
        class="absolute top-2 right-2 left-2 z-20 flex flex-wrap items-center gap-2"
      >
        <div class="relative min-w-[180px] flex-1">
          <div
            class="flex items-center rounded-[10px] border bg-popover shadow-[var(--sh-md)] focus-within:ring-2 focus-within:ring-[color:var(--ring)]"
          >
            <Search class="ml-2.5 size-4 shrink-0 text-muted-foreground" />
            <input
              v-model="jumpText"
              type="text"
              inputmode="text"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="dropdownVisible('fullscreen')"
              placeholder="Search: 2.45 GHz, 550 nm, VHF, wifi channel 6"
              aria-label="Search by frequency, wavelength, energy, band name, or Wi-Fi channel"
              class="h-9 w-full bg-transparent px-2 font-mono text-sm outline-none"
              @focus="onSearchFocus('fullscreen')"
              @blur="onSearchBlur"
              @keydown.down.prevent="moveActive(1)"
              @keydown.up.prevent="moveActive(-1)"
              @keydown.enter.prevent="confirmActive"
              @keydown.esc="searchOpen = false"
            />
          </div>
          <ul
            v-if="dropdownVisible('fullscreen')"
            role="listbox"
            aria-label="Search results"
            class="absolute top-[calc(100%+4px)] right-0 left-0 z-30 max-h-72 overflow-auto rounded-[12px] border bg-popover p-1 shadow-[var(--sh-lg)]"
          >
            <li v-if="!results.length" class="px-2.5 py-2 text-sm text-muted-foreground">
              No matches. Try 2.45 GHz, 550 nm, 10 keV, VHF, or wifi channel 6.
            </li>
            <li
              v-for="(it, i) in results"
              :key="it.id"
              role="option"
              :aria-selected="i === activeIndex"
              class="flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-1.5"
              :class="
                i === activeIndex
                  ? 'bg-[color:var(--accent-soft)] text-[color:var(--primary)]'
                  : 'hover:bg-secondary'
              "
              @mousedown.prevent="pickInterpretation(it)"
              @mouseenter="activeIndex = i"
            >
              <component :is="iconFor(it.icon) || Search" class="size-4 shrink-0 opacity-80" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ it.label }}</span>
                <span v-if="it.detail" class="block truncate text-xs text-muted-foreground">{{
                  it.detail
                }}</span>
              </span>
            </li>
          </ul>
        </div>
        <Button
          variant="outline"
          size="sm"
          :aria-label="
            orientation === 'horizontal'
              ? 'Switch to vertical layout'
              : 'Switch to horizontal layout'
          "
          class="bg-popover"
          @click="toggleOrientation"
        >
          <RotateCw class="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Exit fullscreen"
          :aria-pressed="isFullscreen"
          class="bg-popover"
          @click="toggleFullscreen"
        >
          <Minimize2 class="size-4" />
          Exit
        </Button>
      </div>

      <!-- Floating readout tooltip -->
      <div
        v-if="activeReadout"
        class="absolute top-0 left-0 z-10 w-max max-w-[min(300px,82%)] rounded-[12px] border bg-popover p-3 text-sm shadow-[var(--sh-lg)]"
        :class="locked ? 'pointer-events-auto select-text' : 'pointer-events-none select-none'"
        :style="tooltipStyle"
        :aria-hidden="!locked"
      >
        <button
          v-if="locked"
          type="button"
          class="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] focus-visible:outline-none"
          aria-label="Close readout"
          @click="unlock"
        >
          <X class="size-3.5" />
        </button>

        <!-- Breadcrumb chips: one per path segment, bold on hover -->
        <div class="mb-2 flex flex-wrap items-center gap-1" :class="locked ? 'pr-6' : ''">
          <template v-for="(seg, i) in activeReadout.path" :key="seg.id">
            <span
              class="inline-flex items-center gap-1 rounded-[6px] border bg-secondary px-1.5 py-0.5 text-xs transition-colors"
              :class="hoveredSegment === i ? 'font-semibold text-foreground' : ''"
              @mouseenter="hoveredSegment = i"
              @mouseleave="hoveredSegment = null"
            >
              <component
                :is="iconFor(seg.icon)"
                v-if="iconFor(seg.icon)"
                class="size-3.5 shrink-0 text-[color:var(--primary)]"
              />
              {{ seg.name }}
            </span>
            <span
              v-if="i < activeReadout.path.length - 1"
              class="text-muted-foreground/70"
              aria-hidden="true"
              >&rsaquo;</span
            >
          </template>
        </div>

        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
          <dt class="text-muted-foreground">Frequency</dt>
          <dd class="text-right whitespace-nowrap">
            {{ formatFrequency(activeReadout.frequencyHz) }}
          </dd>
          <dt class="text-muted-foreground">Wavelength</dt>
          <dd class="text-right whitespace-nowrap">
            {{ formatWavelength(activeReadout.wavelengthM) }}
          </dd>
          <dt class="text-muted-foreground">Energy</dt>
          <dd class="text-right whitespace-nowrap">
            {{ formatEnergyEv(activeReadout.energyEv) }}
          </dd>
          <dt class="text-muted-foreground">Black-body</dt>
          <dd class="text-right whitespace-nowrap">
            {{ formatKelvin(activeReadout.blackbodyKelvin) }}
          </dd>
        </dl>
        <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span
            v-if="activeReadout.colorHex"
            class="inline-flex items-center gap-1 rounded-[6px] border px-1.5 py-0.5 font-mono"
          >
            <span
              class="inline-block size-3 shrink-0 rounded-[3px] border"
              :style="{ background: activeReadout.colorHex }"
            />
            {{ activeReadout.colorHex }}
          </span>
          <span
            class="rounded-[6px] px-1.5 py-0.5 font-medium"
            :class="
              activeReadout.ionizing
                ? 'bg-[color:var(--accent-soft)] text-[color:var(--primary)]'
                : 'bg-secondary text-muted-foreground'
            "
            >{{ activeReadout.ionizing ? "Ionizing" : "Non-ionizing" }}</span
          >
        </div>
        <p
          v-if="activeReadout.uses.length"
          class="mt-2 text-xs leading-relaxed text-muted-foreground"
        >
          {{ activeReadout.uses.join(", ") }}
        </p>
      </div>

      <!-- Empty-state hint -->
      <div
        v-if="!activeReadout"
        class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-3"
      >
        <span
          class="rounded-full bg-popover/90 px-3 py-1 text-center text-xs text-muted-foreground shadow-[var(--sh-sm)]"
        >
          Hover to read values, click to lock the readout. Drag across to zoom in, double click to
          reset.
        </span>
      </div>
    </div>

    <!-- Persistent, copyable readout -->
    <div
      v-if="activeReadout"
      ref="readoutCardRef"
      class="overflow-hidden rounded-[14px] border bg-card shadow-[var(--sh-sm)]"
    >
      <div
        class="flex items-center justify-between gap-3 border-b bg-[image:var(--grad-brand-soft)] px-4 py-2.5"
      >
        <div class="min-w-0">
          <div class="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            Readout
          </div>
          <div class="truncate font-mono text-sm">
            {{ formatFrequency(activeReadout.frequencyHz) }}
          </div>
        </div>
        <CopyButton :text="copyableText" label="Copy all" />
      </div>

      <!-- Breadcrumb chips -->
      <div v-if="activeReadout.path.length" class="flex flex-wrap items-center gap-1 px-4 pt-3">
        <template v-for="(seg, i) in activeReadout.path" :key="seg.id">
          <span
            class="inline-flex items-center gap-1 rounded-[6px] border bg-secondary px-2 py-0.5 text-xs transition-colors"
            :class="hoveredSegment === i ? 'font-semibold text-foreground' : ''"
            @mouseenter="hoveredSegment = i"
            @mouseleave="hoveredSegment = null"
          >
            <component
              :is="iconFor(seg.icon)"
              v-if="iconFor(seg.icon)"
              class="size-3.5 shrink-0 text-[color:var(--primary)]"
            />
            {{ seg.name }}
          </span>
          <span
            v-if="i < activeReadout.path.length - 1"
            class="text-muted-foreground/70"
            aria-hidden="true"
            >&rsaquo;</span
          >
        </template>
      </div>

      <div class="divide-y divide-border/60 px-1 pt-2 pb-1">
        <div
          v-for="row in valueRows"
          :key="row.label"
          class="flex items-center justify-between gap-3 px-3 py-1.5"
        >
          <div class="text-xs text-muted-foreground">
            {{ row.label }}
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <span
              v-if="row.swatch"
              class="inline-block size-4 shrink-0 rounded-[4px] border"
              :style="{ background: row.swatch }"
            />
            <span class="truncate font-mono text-sm tabular-nums">{{ row.value }}</span>
            <CopyButton :text="row.value" />
          </div>
        </div>
        <div
          v-if="activeReadout.uses.length"
          class="flex items-start justify-between gap-3 px-3 py-2"
        >
          <div class="shrink-0 pt-0.5 text-xs text-muted-foreground">Common uses</div>
          <div class="flex min-w-0 flex-1 flex-wrap justify-end gap-1.5">
            <span
              v-for="use in activeReadout.uses"
              :key="use"
              class="rounded-[6px] bg-secondary px-2 py-0.5 text-xs shadow-[var(--sh-sm)]"
            >
              {{ use }}
            </span>
            <CopyButton :text="activeReadout.uses.join(', ')" />
          </div>
        </div>
      </div>
    </div>

    <p class="text-xs text-muted-foreground">
      Gamma rays are at the start of the axis and ELF radio at the end. Band boundaries follow
      common conventions and broadcast allocations are United States allocations. The ionizing flag
      uses an approximate 10 eV threshold. Everything runs in your browser: your files and inputs
      never leave your device.
    </p>
  </div>
</template>
