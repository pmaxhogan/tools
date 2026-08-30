<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, type Component } from "vue";
import type { ToolMeta } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob, downloadText } from "@/lib/download";
import type { KeyValueRow } from "@/lib/key-value";
import {
  AXIS_DECADES,
  describeFrequency,
  formatEnergyEv,
  formatFrequency,
  formatKelvin,
  formatWavelength,
  frequencyToPosition,
  parseJump,
  positionToFrequency,
  type Interpretation,
  type Readout,
} from "@/tools/electromagnetic-spectrum/index";
import { NAMED_CHANNELS, WIFI_CHANNELS } from "@/tools/electromagnetic-spectrum/data";
import {
  ALLOCATIONS,
  ALLOCATION_META,
  CHANNEL_TABLES,
  allocationsAt,
  licenseNeededAt,
  type Allocation,
  type AllocationRegion,
  type AllocationService,
  type AllocationStatus,
  type MpeEnvironment,
} from "@/tools/electromagnetic-spectrum/allocations";
import {
  REGION_HELP,
  STATUS_HELP,
  STATUS_LABELS,
  STATUS_ORDER,
  allocationsForRegion,
  allocationsToCsv,
  allocationsToJson,
  describeAllocation,
  formatRange,
  packAllocations,
  serviceLabel,
  sourceLinkFor,
  visibleAllocations,
  REGION_LABELS,
} from "@/tools/electromagnetic-spectrum/allocation-view";
import { unifiedSearch } from "@/tools/electromagnetic-spectrum/lookup";
import {
  estimateExposure,
  formatMeters,
  formatPowerDensity,
  formatWatts,
  type PowerKind,
} from "@/tools/electromagnetic-spectrum/exposure";
import { BAND_EDUCATION, educationAt } from "@/tools/electromagnetic-spectrum/education";
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
  posToAxisPx,
  sceneToSvg,
  spectralStops,
  viewStartPos,
  withAlpha,
  type AxisView,
  type Orientation,
  type Scene,
  type SceneRect,
} from "@/tools/electromagnetic-spectrum/layout";
import { Button } from "@/components/ui/button";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { SelectOptionSpec } from "@/tools/types";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FitText from "../FitText.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import {
  Crosshair,
  Download,
  ExternalLink,
  Link as LinkIcon,
  Search,
  Maximize2,
  Minimize2,
  Printer,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
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
const results = computed<Interpretation[]>(() => unifiedSearch(jumpText.value, region.value));
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
  if (it.allocationId) {
    selectedAllocId.value = it.allocationId;
    tab.value = "allocations";
  }
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
  if (tab.value !== "allocations") opts.t = tab.value;
  if (region.value !== "US") opts.r = region.value;
  if (selectedAllocId.value) opts.a = selectedAllocId.value;
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
  if (opts.t && TAB_IDS.includes(opts.t as RefTab)) tab.value = opts.t as RefTab;
  if (opts.r && REGION_IDS.includes(opts.r as AllocationRegion)) {
    region.value = opts.r as AllocationRegion;
  }
  if (opts.a && ALLOCATIONS.some((a) => a.id === opts.a)) selectedAllocId.value = opts.a;
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
/* Allocation reference: shared state                                  */
/* ------------------------------------------------------------------ */

type RefTab = "allocations" | "rules" | "channels" | "exposure" | "learn";
const TAB_IDS: RefTab[] = ["allocations", "rules", "channels", "exposure", "learn"];
const REGION_IDS: AllocationRegion[] = ["US", "ITU2", "ITU1", "ITU3", "global"];

const tab = ref<RefTab>("allocations");
const region = ref<AllocationRegion>("US");
const selectedAllocId = ref<string | null>(null);

const REGION_OPTIONS: SegmentedOption[] = REGION_IDS.map((r) => ({
  value: r,
  label: r === "global" ? "Worldwide" : r === "US" ? "US" : r.replace("ITU", "Region "),
}));

const statusFilter = ref<"all" | AllocationStatus>("all");
const STATUS_OPTIONS: SegmentedOption[] = [
  { value: "all", label: "All" },
  ...STATUS_ORDER.map((st) => ({ value: st, label: STATUS_LABELS[st] })),
];

const serviceFilter = ref<string>("all");
const serviceSpec = computed<SelectOptionSpec>(() => {
  const present = [...new Set(allocationsForRegion(region.value).map((a) => a.service))].sort(
    (a, b) => serviceLabel(a).localeCompare(serviceLabel(b)),
  );
  return {
    kind: "select",
    id: "service",
    label: "Service",
    default: "all",
    ui: "select",
    options: [
      { value: "all", label: "All services", synonyms: ["any", "everything"] },
      ...present.map((sv) => ({ value: sv, label: serviceLabel(sv), synonyms: [sv] })),
    ],
  };
});

// A region switch can drop the chosen service from the table; fall back to all.
watch(region, () => {
  if (
    serviceFilter.value !== "all" &&
    !serviceSpec.value.options?.some((o) => o.value === serviceFilter.value)
  ) {
    serviceFilter.value = "all";
  }
  scheduleFragmentWrite();
});

watch(tab, scheduleFragmentWrite);

const selectedAlloc = computed<Allocation | null>(
  () => ALLOCATIONS.find((a) => a.id === selectedAllocId.value) ?? null,
);

/** Geometric center of an allocation, where the log axis draws its middle. */
function allocCenter(a: Allocation): number {
  return Math.sqrt(a.lowHz * a.highHz);
}

/** The frequency the Rules, Exposure and Learn tabs describe. */
const focusFreq = computed<number | null>(() => {
  if (pinnedFreq.value != null) return pinnedFreq.value;
  if (selectedAlloc.value) return allocCenter(selectedAlloc.value);
  return hoverFreq.value;
});

/* ------------------------------------------------------------------ */
/* Allocation chart                                                    */
/* ------------------------------------------------------------------ */

const LANE_H = 20;
const LANE_GAP = 3;
const STRIP_TOP = 22;

const filteredAllocs = computed<Allocation[]>(() =>
  allocationsForRegion(region.value).filter(
    (a) =>
      (statusFilter.value === "all" || a.status === statusFilter.value) &&
      (serviceFilter.value === "all" || a.service === serviceFilter.value),
  ),
);

const lanes = computed(() => packAllocations(filteredAllocs.value));
const stripHeight = computed(
  () => STRIP_TOP + Math.max(1, lanes.value.laneCount) * (LANE_H + LANE_GAP) + 6,
);

/** The strip is always horizontal and full width, whatever the map orientation. */
const stripView = computed<AxisView>(() => ({
  center: center.value,
  span: span.value,
  lengthPx: cssW.value,
}));

interface Bar {
  id: string;
  x: number;
  w: number;
  y: number;
  label: string;
  status: AllocationStatus;
  service: AllocationService;
  alloc: Allocation;
  text: string | null;
}

const bars = computed<Bar[]>(() => {
  const view = stripView.value;
  const start = viewStartPos(view);
  return visibleAllocations(lanes.value, start, start + view.span).map((p) => {
    const x1 = Math.max(0, posToAxisPx(p.posLow, view));
    const x2 = Math.min(view.lengthPx, posToAxisPx(p.posHigh, view));
    const w = Math.max(1.5, x2 - x1);
    const maxChars = Math.floor((w - 8) / 5.6);
    const label = p.allocation.label;
    const text =
      maxChars >= 4
        ? label.length <= maxChars
          ? label
          : `${label.slice(0, Math.max(1, maxChars - 1))}…`
        : null;
    return {
      id: p.allocation.id,
      x: x1,
      w,
      y: STRIP_TOP + p.lane * (LANE_H + LANE_GAP),
      label,
      status: p.allocation.status,
      service: p.allocation.service,
      alloc: p.allocation,
      text,
    };
  });
});

/** Decade ticks along the top of the strip, thinned so labels never collide. */
const stripTicks = computed<{ x: number; label: string }[]>(() => {
  const view = stripView.value;
  if (view.lengthPx <= 0) return [];
  const fHigh = axisPxToFreq(0, view);
  const fLow = axisPxToFreq(view.lengthPx, view);
  const kLo = Math.ceil(Math.log10(Math.max(fLow, 1e-3)));
  const kHi = Math.floor(Math.log10(fHigh));
  const stepK = Math.max(
    1,
    Math.ceil((kHi - kLo + 1) / Math.max(2, Math.floor(view.lengthPx / 90))),
  );
  const out: { x: number; label: string }[] = [];
  for (let k = kLo; k <= kHi; k += stepK) {
    const f = Math.pow(10, k);
    out.push({ x: freqToAxisPx(f, view), label: formatFrequency(f) });
  }
  return out;
});

const markerX = computed<number | null>(() => {
  const f = activeFreq.value;
  if (f == null) return null;
  const x = freqToAxisPx(f, stripView.value);
  return x >= 0 && x <= cssW.value ? x : null;
});

function barFill(status: AllocationStatus): string {
  switch (status) {
    case "primary":
      return withAlpha(colors.primary, 0.82);
    case "secondary":
      return withAlpha(colors.primary, 0.38);
    case "unlicensed":
      return withAlpha(colors.positive, 0.78);
    case "restricted":
      return withAlpha(colors.muted, 0.45);
  }
}

function barText(status: AllocationStatus): string {
  return status === "primary" || status === "unlicensed" ? colors.card : colors.fg;
}

// Drag to pan on the strip; a click that does not move selects a bar.
let stripDown: { x: number; center: number; moved: boolean } | null = null;

function onStripPointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  stripDown = { x: e.clientX, center: center.value, moved: false };
}

function onStripPointerMove(e: PointerEvent) {
  if (!stripDown) return;
  const dx = e.clientX - stripDown.x;
  if (!stripDown.moved && Math.abs(dx) > DRAG_THRESHOLD) stripDown.moved = true;
  if (!stripDown.moved) return;
  center.value = stripDown.center - (dx / Math.max(1, cssW.value)) * span.value;
  clampView();
  scheduleDraw();
  scheduleFragmentWrite();
}

function onStripPointerUp(e: PointerEvent) {
  (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  stripDown = null;
}

function onStripWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = (e.currentTarget as Element).getBoundingClientRect();
  const apx = e.clientX - rect.left;
  const view = stripView.value;
  if (e.ctrlKey || e.metaKey) {
    const anchorPos = axisPxToPos(apx, view);
    span.value = span.value * Math.exp(e.deltaY * 0.0016);
    clampView();
    center.value = centerHoldingAnchor(anchorPos, apx, stripView.value);
    clampView();
  } else {
    center.value += ((e.deltaX || e.deltaY) / view.lengthPx) * span.value;
    clampView();
  }
  scheduleDraw();
  scheduleFragmentWrite();
}

/** A bar click: select it, pin the readout at its center, and describe it. */
function selectBar(bar: Bar) {
  if (stripDown?.moved) return;
  selectedAllocId.value = bar.id;
  pinnedFreq.value = allocCenter(bar.alloc);
  hoverFreq.value = null;
  locked.value = true;
  scheduleDraw();
  scheduleFragmentWrite();
}

function zoomToAlloc(a: Allocation) {
  const pLow = frequencyToPosition(a.lowHz);
  const pHigh = frequencyToPosition(a.highHz);
  const lo = Math.min(pLow, pHigh);
  const hi = Math.max(pLow, pHigh);
  animateTo((lo + hi) / 2, (hi - lo) * 1.6 || MIN_SPAN);
}

function zoomBy(factor: number) {
  span.value *= factor;
  clampView();
  scheduleDraw();
  scheduleFragmentWrite();
}

/** Fit the view to the allocation table's range, 9 kHz to 275 GHz. */
function fitRf() {
  const pLow = frequencyToPosition(ALLOCATION_META.lowHz);
  const pHigh = frequencyToPosition(ALLOCATION_META.highHz);
  const lo = Math.min(pLow, pHigh);
  const hi = Math.max(pLow, pHigh);
  animateTo((lo + hi) / 2, (hi - lo) * 1.02);
}

function clearSelection() {
  selectedAllocId.value = null;
  scheduleFragmentWrite();
}

/** The rows currently in view, in frequency order, for the exports. */
const visibleRows = computed<Allocation[]>(() => {
  const ids = new Set(bars.value.map((b) => b.id));
  return filteredAllocs.value.filter((a) => ids.has(a.id));
});

function exportCsv() {
  downloadText(allocationsToCsv(visibleRows.value), "spectrum-allocations.csv", "text/csv");
}

function exportJson() {
  downloadText(
    allocationsToJson(visibleRows.value),
    "spectrum-allocations.json",
    "application/json",
  );
}

const selectedLicense = computed(() =>
  selectedAlloc.value ? licenseNeededAt(allocCenter(selectedAlloc.value)) : null,
);

const selectedSource = computed(() =>
  selectedAlloc.value ? sourceLinkFor(selectedAlloc.value.source) : null,
);

/* ------------------------------------------------------------------ */
/* Rules tab                                                           */
/* ------------------------------------------------------------------ */

const license = computed(() => (focusFreq.value != null ? licenseNeededAt(focusFreq.value) : null));
const rulesAllocs = computed<Allocation[]>(() =>
  focusFreq.value != null ? allocationsAt(focusFreq.value, region.value) : [],
);

const licenseFlags = computed<{ label: string; tone: "good" | "warn" | "muted" }[]>(() => {
  const l = license.value;
  if (!l) return [];
  const flags: { label: string; tone: "good" | "warn" | "muted" }[] = [];
  if (l.unlicensed) flags.push({ label: "Unlicensed use allowed", tone: "good" });
  if (l.amateur) flags.push({ label: "Amateur allocation", tone: "good" });
  if (l.restricted) flags.push({ label: "Restricted band", tone: "warn" });
  if (l.federalOnly) flags.push({ label: "Federal only", tone: "warn" });
  if (!flags.length) flags.push({ label: "Licensed services only", tone: "muted" });
  return flags;
});

function selectFromRules(a: Allocation) {
  selectedAllocId.value = a.id;
  tab.value = "allocations";
  zoomToAlloc(a);
  scheduleFragmentWrite();
}

/* ------------------------------------------------------------------ */
/* Channels tab                                                        */
/* ------------------------------------------------------------------ */

interface PlanRow {
  id: string;
  centerHz: number;
  widthHz?: number;
  label?: string;
  note?: string;
}
interface Plan {
  id: string;
  name: string;
  source: string;
  rows: PlanRow[];
}

const NAMED_PLAN_NAMES: Record<string, string> = {
  marine: "Marine VHF channels",
  cb: "Citizens Band channels 1 to 40",
  noaa: "NOAA Weather Radio channels",
  fm: "FM broadcast channels 201 to 300",
  tv: "Television channels",
};

const PLANS: Plan[] = [
  ...(["2.4", "5", "6"] as const).map((band) => ({
    id: `wifi-${band}`,
    name: `Wi-Fi ${band} GHz channels`,
    source: "47 CFR Part 15 and IEEE 802.11",
    rows: WIFI_CHANNELS.filter((c) => c.band === band).map((c) => ({
      id: String(c.channel),
      centerHz: c.centerHz,
      widthHz: c.width * 1e6,
      label: `${c.width} MHz wide`,
    })),
  })),
  ...Object.keys(NAMED_PLAN_NAMES).map((service) => ({
    id: `named-${service}`,
    name: NAMED_PLAN_NAMES[service]!,
    source: "47 CFR Parts 73, 80 and 95; NOAA NWS",
    rows: NAMED_CHANNELS.filter((c) => c.service === service).map((c) => ({
      id: c.channel,
      centerHz: c.centerHz,
      widthHz: c.upperHz - c.lowerHz,
      label: c.name,
      note: c.notes,
    })),
  })),
  ...CHANNEL_TABLES.map((t) => ({
    id: t.id,
    name: t.name,
    source: t.source,
    rows: t.channels.map((c) => ({
      id: c.id,
      centerHz: c.centerHz,
      widthHz: c.widthHz,
      label: c.label,
      note: c.note,
    })),
  })),
];

const planId = ref<string>(PLANS[0]!.id);
const planSearch = ref("");
const PLAN_ROW_CAP = 200;

const planSpec: SelectOptionSpec = {
  kind: "select",
  id: "plan",
  label: "Channel plan",
  default: PLANS[0]!.id,
  ui: "select",
  options: PLANS.map((p) => ({ value: p.id, label: p.name, synonyms: [p.id] })),
};

const plan = computed<Plan>(() => PLANS.find((p) => p.id === planId.value) ?? PLANS[0]!);

const planRows = computed<PlanRow[]>(() => {
  const q = planSearch.value.trim().toLowerCase();
  const rows = plan.value.rows;
  if (!q) return rows.slice(0, PLAN_ROW_CAP);
  return rows
    .filter((r) =>
      [r.id, r.label ?? "", r.note ?? "", formatFrequency(r.centerHz)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
    .slice(0, PLAN_ROW_CAP);
});

function showChannel(row: PlanRow) {
  pinnedFreq.value = row.centerHz;
  hoverFreq.value = null;
  locked.value = true;
  if (row.widthHz) {
    const lo = row.centerHz - row.widthHz / 2;
    const hi = row.centerHz + row.widthHz / 2;
    const pA = frequencyToPosition(lo);
    const pB = frequencyToPosition(hi);
    animateTo((pA + pB) / 2, Math.abs(pA - pB) * 6 || MIN_SPAN);
  } else {
    animateTo(frequencyToPosition(row.centerHz), Math.min(span.value, 1 / AXIS_DECADES));
  }
  scheduleFragmentWrite();
}

/* ------------------------------------------------------------------ */
/* Exposure tab                                                        */
/* ------------------------------------------------------------------ */

const expFreqText = ref("146 MHz");
const expPower = ref("50");
const expKind = ref<PowerKind>("erp");
const expGain = ref("2.15");
const expDistance = ref("10");
const expEnv = ref<MpeEnvironment>("uncontrolled");
const expDuty = ref("100");

const POWER_KIND_OPTIONS: SegmentedOption[] = [
  { value: "erp", label: "ERP" },
  { value: "eirp", label: "EIRP" },
  { value: "tx", label: "TX power + gain" },
];
const ENV_OPTIONS: SegmentedOption[] = [
  { value: "uncontrolled", label: "General public" },
  { value: "controlled", label: "Occupational" },
];

const expFreqHz = computed<number | null>(() => {
  try {
    return parseJump(expFreqText.value);
  } catch {
    return null;
  }
});

const expError = computed<string | null>(() => {
  if (expFreqHz.value == null) return "Enter a frequency such as 146 MHz, 2.4 GHz or 7.1 MHz.";
  if (!(Number(expPower.value) > 0)) return "Power must be a positive number of watts.";
  if (!(Number(expDistance.value) > 0)) return "Distance must be a positive number of meters.";
  return null;
});

const exposure = computed(() => {
  if (expError.value || expFreqHz.value == null) return null;
  return estimateExposure({
    freqHz: expFreqHz.value,
    powerW: Number(expPower.value),
    powerKind: expKind.value,
    gainDbi: Number(expGain.value) || 0,
    distanceM: Number(expDistance.value),
    environment: expEnv.value,
    dutyCycle: Math.min(100, Math.max(0, Number(expDuty.value) || 100)) / 100,
  });
});

const exposureRows = computed<KeyValueRow[]>(() => {
  const e = exposure.value;
  if (!e) return [];
  const rows: KeyValueRow[] = [
    { key: "EIRP", value: formatWatts(e.eirpW) },
    { key: "ERP", value: formatWatts(e.erpW) },
    { key: "Estimated power density", value: formatPowerDensity(e.powerDensityMwCm2) },
    {
      key: "FCC limit",
      value: e.limit
        ? `${formatPowerDensity(e.limit.powerDensityMwCm2)} (${e.limit.formula}, ${e.limit.averagingMinutes} min average)`
        : "No FCC limit is defined below 300 kHz or above 100 GHz",
    },
    {
      key: "Share of limit",
      value: e.percentOfLimit == null ? "n/a" : `${Number(e.percentOfLimit.toPrecision(3))}%`,
    },
    {
      key: "Distance to meet the limit",
      value: e.complianceDistanceM == null ? "n/a" : formatMeters(e.complianceDistanceM),
    },
    { key: "Wavelength", value: formatWavelength(e.wavelengthM) },
    {
      key: "Routine evaluation",
      value: e.exempt
        ? `Exempt: at or under the single source threshold${e.exemption ? ` of ${formatWatts(e.exemption.thresholdErpWatts)} ERP at ${formatMeters(e.exemption.separationM)}` : ""}`
        : e.exemption
          ? `Not exempt: threshold is ${formatWatts(e.exemption.thresholdErpWatts)} ERP at ${formatMeters(e.exemption.separationM)}${e.exemption.clampedToMinimum ? " (distance raised to the lambda over 2 pi floor)" : ""}`
          : "No exemption threshold is defined at this frequency",
    },
  ];
  if (e.limit?.electricFieldVm) {
    rows.push({
      key: "Electric field limit",
      value: `${Number(e.limit.electricFieldVm.toPrecision(3))} V/m`,
    });
  }
  return rows;
});

const exposureCopy = computed(() =>
  exposureRows.value.map((r) => `${r.key}: ${r.value}`).join("\n"),
);

function useFocusFrequency() {
  if (focusFreq.value != null) expFreqText.value = formatFrequency(focusFreq.value);
}

/* ------------------------------------------------------------------ */
/* Learn tab                                                           */
/* ------------------------------------------------------------------ */

const learnNote = computed(() =>
  focusFreq.value != null ? educationAt(focusFreq.value) : undefined,
);

function printPage() {
  window.print();
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
    <div class="flex flex-wrap items-center gap-2 print:hidden">
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

    <!-- Allocation reference -->
    <div class="flex flex-col gap-3 print:hidden">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">Spectrum allocations</h2>
          <p class="text-xs text-muted-foreground">
            Who is allocated what from 9 kHz to 275 GHz. The chart shares the axis above, so panning
            or zooming either one moves both.
          </p>
        </div>
        <Segmented v-model="region" :options="REGION_OPTIONS" label="Region" size="sm" wrap />
      </div>
      <p class="text-xs text-muted-foreground">{{ REGION_HELP[region] }}</p>

      <Tabs v-model="tab" class="w-full">
        <TabsList class="flex w-full flex-wrap">
          <TabsTrigger value="allocations">Chart</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="exposure">Exposure</TabsTrigger>
          <TabsTrigger value="learn">Learn</TabsTrigger>
        </TabsList>

        <!-- Chart -->
        <TabsContent value="allocations" class="flex flex-col gap-3 pt-4">
          <div class="flex flex-wrap items-center gap-2">
            <Segmented
              v-model="statusFilter"
              :options="STATUS_OPTIONS"
              label="Status filter"
              size="sm"
              wrap
            />
            <div class="min-w-[200px]">
              <SearchableSelect v-model="serviceFilter" :spec="serviceSpec" />
            </div>
            <div class="ml-auto flex flex-wrap items-center gap-1">
              <Button variant="outline" size="sm" aria-label="Zoom in" @click="zoomBy(1 / 1.5)">
                <ZoomIn class="size-4" />
              </Button>
              <Button variant="outline" size="sm" aria-label="Zoom out" @click="zoomBy(1.5)">
                <ZoomOut class="size-4" />
              </Button>
              <Button variant="outline" size="sm" @click="fitRf">Fit RF</Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="Export visible rows as CSV"
                @click="exportCsv"
              >
                <Download class="size-4" />
                CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="Export visible rows as JSON"
                @click="exportJson"
              >
                <Download class="size-4" />
                JSON
              </Button>
            </div>
          </div>

          <div class="overflow-hidden rounded-[14px] border bg-card shadow-[var(--sh-inset)]">
            <svg
              tabindex="0"
              role="img"
              :aria-label="`Spectrum allocation chart, ${bars.length} of ${filteredAllocs.length} bands in view. Arrow keys pan, plus and minus zoom, drag to pan, click a band to select it.`"
              :width="cssW"
              :height="stripHeight"
              :viewBox="`0 0 ${cssW} ${stripHeight}`"
              class="block w-full cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] active:cursor-grabbing"
              @pointerdown="onStripPointerDown"
              @pointermove="onStripPointerMove"
              @pointerup="onStripPointerUp"
              @pointercancel="onStripPointerUp"
              @wheel="onStripWheel"
              @keydown="onKeydown"
            >
              <g v-for="t in stripTicks" :key="t.x">
                <line
                  :x1="t.x"
                  :x2="t.x"
                  :y1="STRIP_TOP - 6"
                  :y2="stripHeight"
                  :stroke="colors.border"
                  stroke-width="1"
                />
                <text :x="t.x + 3" y="12" font-size="10" :fill="colors.muted">{{ t.label }}</text>
              </g>
              <g
                v-for="bar in bars"
                :key="bar.id"
                :transform="`translate(${bar.x}, ${bar.y})`"
                class="cursor-pointer"
                @click="selectBar(bar)"
              >
                <title>{{ bar.label }}: {{ formatRange(bar.alloc.lowHz, bar.alloc.highHz) }}</title>
                <rect
                  :width="bar.w"
                  :height="LANE_H"
                  rx="3"
                  :fill="barFill(bar.status)"
                  :stroke="bar.id === selectedAllocId ? colors.fg : 'none'"
                  stroke-width="1.5"
                  :stroke-dasharray="bar.status === 'secondary' ? '3 2' : undefined"
                />
                <text
                  v-if="bar.text"
                  x="5"
                  :y="LANE_H / 2 + 3.5"
                  font-size="10"
                  :fill="barText(bar.status)"
                  style="pointer-events: none"
                >
                  {{ bar.text }}
                </text>
              </g>
              <line
                v-if="markerX != null"
                :x1="markerX"
                :x2="markerX"
                y1="0"
                :y2="stripHeight"
                :stroke="colors.primary"
                stroke-width="1.5"
                stroke-dasharray="4 3"
              />
            </svg>
          </div>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              v-for="st in STATUS_ORDER"
              :key="st"
              class="inline-flex items-center gap-1.5"
              :title="STATUS_HELP[st]"
            >
              <span
                class="inline-block size-3 rounded-[3px]"
                :style="{
                  background: barFill(st),
                  outline: st === 'secondary' ? `1px dashed ${colors.primary}` : 'none',
                }"
              />
              {{ STATUS_LABELS[st] }}
            </span>
            <span class="ml-auto"
              >{{ bars.length }} of {{ filteredAllocs.length }} rows in view</span
            >
          </div>

          <div
            v-if="selectedAlloc"
            class="overflow-hidden rounded-[14px] border bg-card shadow-[var(--sh-sm)]"
          >
            <div
              class="flex items-center justify-between gap-3 border-b bg-[image:var(--grad-brand-soft)] px-4 py-2.5"
            >
              <div class="min-w-0">
                <div
                  class="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                >
                  {{ serviceLabel(selectedAlloc.service) }}
                </div>
                <div class="truncate text-sm font-semibold">{{ selectedAlloc.label }}</div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Zoom to this band"
                  @click="zoomToAlloc(selectedAlloc)"
                >
                  <Crosshair class="size-4" />
                </Button>
                <CopyButton :text="describeAllocation(selectedAlloc)" label="Copy" />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Clear selection"
                  @click="clearSelection"
                >
                  <X class="size-4" />
                </Button>
              </div>
            </div>
            <div class="flex flex-col gap-3 px-4 py-3 text-sm">
              <div class="flex flex-wrap items-center gap-1.5 text-xs">
                <span class="rounded-[6px] border bg-secondary px-2 py-0.5 font-mono">
                  {{ formatRange(selectedAlloc.lowHz, selectedAlloc.highHz) }}
                </span>
                <span
                  class="rounded-[6px] px-2 py-0.5 font-medium"
                  :style="{
                    background: barFill(selectedAlloc.status),
                    color: barText(selectedAlloc.status),
                  }"
                  :title="STATUS_HELP[selectedAlloc.status]"
                >
                  {{ STATUS_LABELS[selectedAlloc.status] }}
                </span>
                <span class="rounded-[6px] bg-secondary px-2 py-0.5">{{
                  REGION_LABELS[selectedAlloc.region]
                }}</span>
                <span
                  v-if="selectedAlloc.users?.length"
                  class="rounded-[6px] bg-secondary px-2 py-0.5"
                >
                  {{ selectedAlloc.users.join(" and ") }}
                </span>
              </div>
              <p class="leading-relaxed">{{ selectedAlloc.summary }}</p>
              <div v-if="selectedAlloc.rules?.length">
                <div
                  class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                >
                  Rules
                </div>
                <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  <li v-for="rule in selectedAlloc.rules" :key="rule">{{ rule }}</li>
                </ul>
              </div>
              <p v-if="selectedAlloc.notes" class="text-sm leading-relaxed text-muted-foreground">
                {{ selectedAlloc.notes }}
              </p>
              <p
                v-if="selectedLicense"
                class="rounded-[10px] bg-secondary px-3 py-2 text-sm leading-relaxed"
              >
                {{ selectedLicense.summary }}
              </p>
              <p class="text-xs text-muted-foreground">
                Source: {{ selectedAlloc.source }}.
                <a
                  v-if="selectedSource"
                  :href="selectedSource.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-[color:var(--primary)] underline-offset-2 hover:underline"
                >
                  {{ selectedSource.title }}
                  <ExternalLink class="size-3" />
                </a>
              </p>
            </div>
          </div>
          <EmptyState
            v-else
            title="No band selected"
            hint="Click a bar on the chart, or search above for a band such as 2m, GMRS, radio astronomy, or 5 GHz Wi-Fi."
            icon="Radio"
          />
        </TabsContent>

        <!-- Rules -->
        <TabsContent value="rules" class="flex flex-col gap-3 pt-4">
          <template v-if="license && focusFreq != null">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm">{{ formatFrequency(focusFreq) }}</span>
              <span
                v-for="flag in licenseFlags"
                :key="flag.label"
                class="rounded-[6px] px-2 py-0.5 text-xs font-medium"
                :class="
                  flag.tone === 'good'
                    ? 'bg-[color:var(--positive-soft)] text-[color:var(--positive)]'
                    : flag.tone === 'warn'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-secondary text-muted-foreground'
                "
              >
                {{ flag.label }}
              </span>
              <CopyButton
                :text="[license.summary, ...license.rules].join('\n')"
                label="Copy"
                class="ml-auto"
              />
            </div>
            <p class="rounded-[10px] bg-secondary px-3 py-2 text-sm leading-relaxed">
              {{ license.summary }}
            </p>
            <div v-if="license.rules.length">
              <div
                class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
              >
                What the rules say
              </div>
              <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                <li v-for="rule in license.rules" :key="rule">{{ rule }}</li>
              </ul>
            </div>
            <div v-if="rulesAllocs.length">
              <div
                class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
              >
                Allocations here ({{ REGION_LABELS[region] }})
              </div>
              <ul class="divide-y divide-border/60 rounded-[10px] border">
                <li
                  v-for="a in rulesAllocs"
                  :key="a.id"
                  class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  <span
                    class="rounded-[6px] px-1.5 py-0.5 text-xs font-medium"
                    :style="{ background: barFill(a.status), color: barText(a.status) }"
                  >
                    {{ STATUS_LABELS[a.status] }}
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    <span class="font-medium">{{ a.label }}</span>
                    <span class="text-muted-foreground"> {{ formatRange(a.lowHz, a.highHz) }}</span>
                  </span>
                  <Button variant="ghost" size="sm" @click="selectFromRules(a)">Show</Button>
                </li>
              </ul>
            </div>
            <ErrorBanner
              variant="info"
              message="Educational summary only. The FCC Table of Frequency Allocations and the service rules govern; footnotes, coordination zones and geographic limits are not modeled."
            />
          </template>
          <EmptyState
            v-else
            title="Pick a frequency first"
            hint="Click the spectrum, select a band on the chart, or search for one, and this tab answers whether you may transmit there and under which license."
            icon="Radio"
          />
        </TabsContent>

        <!-- Channels -->
        <TabsContent value="channels" class="flex flex-col gap-3 pt-4">
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-[260px] flex-1">
              <SearchableSelect v-model="planId" :spec="planSpec" />
            </div>
            <div
              class="flex min-w-[200px] flex-1 items-center rounded-[10px] border bg-secondary shadow-[var(--sh-inset)] focus-within:ring-2 focus-within:ring-[color:var(--ring)]"
            >
              <Search class="ml-2.5 size-4 shrink-0 text-muted-foreground" />
              <input
                v-model="planSearch"
                type="text"
                placeholder="Filter channels"
                aria-label="Filter channels"
                class="h-9 w-full bg-transparent px-2 text-sm outline-none"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ plan.rows.length }} channels. Source: {{ plan.source }}.
          </p>
          <div class="overflow-x-auto rounded-[10px] border">
            <table class="w-full text-sm">
              <thead class="bg-secondary text-left text-xs text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">Channel</th>
                  <th class="px-3 py-2 font-medium">Center</th>
                  <th class="px-3 py-2 font-medium">Width</th>
                  <th class="px-3 py-2 font-medium">Notes</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/60">
                <tr
                  v-for="row in planRows"
                  :key="row.id + row.centerHz"
                  class="hover:bg-secondary/60"
                >
                  <td class="px-3 py-1.5 font-mono">{{ row.id }}</td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ formatFrequency(row.centerHz) }}
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums text-muted-foreground">
                    {{ row.widthHz ? formatFrequency(row.widthHz) : "" }}
                  </td>
                  <td class="px-3 py-1.5 text-muted-foreground">
                    {{ [row.label, row.note].filter(Boolean).join(". ") }}
                  </td>
                  <td class="px-2 py-1 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      :aria-label="`Show channel ${row.id} on the spectrum`"
                      @click="showChannel(row)"
                    >
                      <Crosshair class="size-4" />
                      <span class="hidden sm:inline">Show</span>
                    </Button>
                  </td>
                </tr>
                <tr v-if="!planRows.length">
                  <td colspan="5" class="px-3 py-4 text-center text-muted-foreground">
                    No channel matches that filter.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </TabsContent>

        <!-- Exposure -->
        <TabsContent value="exposure" class="flex flex-col gap-3 pt-4">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span class="flex items-center justify-between">
                Frequency
                <button
                  v-if="focusFreq != null"
                  type="button"
                  class="text-[color:var(--primary)] hover:underline"
                  @click="useFocusFrequency"
                >
                  use {{ formatFrequency(focusFreq) }}
                </button>
              </span>
              <input
                v-model="expFreqText"
                type="text"
                class="h-9 rounded-[10px] border bg-secondary px-2.5 font-mono text-sm text-foreground shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
                placeholder="146 MHz"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              Power (watts)
              <input
                v-model="expPower"
                type="number"
                min="0"
                step="any"
                inputmode="decimal"
                class="h-9 rounded-[10px] border bg-secondary px-2.5 font-mono text-sm text-foreground shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
              />
            </label>
            <div class="flex flex-col gap-1 text-xs text-muted-foreground">
              Power is
              <Segmented
                v-model="expKind"
                :options="POWER_KIND_OPTIONS"
                label="Power kind"
                size="sm"
                wrap
              />
            </div>
            <label
              v-if="expKind === 'tx'"
              class="flex flex-col gap-1 text-xs text-muted-foreground"
            >
              Antenna gain (dBi)
              <input
                v-model="expGain"
                type="number"
                step="any"
                inputmode="decimal"
                class="h-9 rounded-[10px] border bg-secondary px-2.5 font-mono text-sm text-foreground shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              Distance to people (meters)
              <input
                v-model="expDistance"
                type="number"
                min="0"
                step="any"
                inputmode="decimal"
                class="h-9 rounded-[10px] border bg-secondary px-2.5 font-mono text-sm text-foreground shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
              Duty cycle (%)
              <input
                v-model="expDuty"
                type="number"
                min="0"
                max="100"
                step="any"
                inputmode="decimal"
                class="h-9 rounded-[10px] border bg-secondary px-2.5 font-mono text-sm text-foreground shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
              />
            </label>
            <div class="flex flex-col gap-1 text-xs text-muted-foreground">
              Environment
              <Segmented
                v-model="expEnv"
                :options="ENV_OPTIONS"
                label="Exposure environment"
                size="sm"
                wrap
              />
            </div>
          </div>

          <ErrorBanner v-if="expError" :message="expError" variant="warning" />
          <template v-else-if="exposure">
            <div
              class="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-sm font-medium"
              :class="
                exposure.pass === null
                  ? 'bg-secondary text-muted-foreground'
                  : exposure.pass
                    ? 'bg-[color:var(--positive-soft)] text-[color:var(--positive)]'
                    : 'bg-destructive/10 text-destructive'
              "
              role="status"
            >
              <span>
                {{
                  exposure.pass === null
                    ? "No FCC power density limit applies at this frequency"
                    : exposure.pass
                      ? `Under the ${expEnv === "controlled" ? "occupational" : "general public"} limit`
                      : `Over the ${expEnv === "controlled" ? "occupational" : "general public"} limit`
                }}
                <span v-if="exposure.percentOfLimit != null" class="font-mono">
                  ({{ Number(exposure.percentOfLimit.toPrecision(3)) }}% of the limit)
                </span>
              </span>
              <CopyButton :text="exposureCopy" label="Copy" />
            </div>
            <ErrorBanner
              v-if="exposure.nearField"
              variant="warning"
              message="That distance is inside the reactive near field, where the far field formula does not apply."
              hint="The rule limits field strength there rather than power density. Treat this result as a rough upper bound only."
            />
            <KeyValueGrid :rows="exposureRows" :columns="2" />
            <details class="rounded-[10px] border px-3 py-2 text-sm">
              <summary class="cursor-pointer font-medium">Assumptions behind this number</summary>
              <ul class="mt-2 list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
                <li v-for="a in exposure.assumptions" :key="a">{{ a }}</li>
              </ul>
            </details>
          </template>
          <ErrorBanner
            variant="info"
            title="Educational estimate, not a compliance evaluation"
            message="The formulas are the ones in 47 CFR 1.1310 and 1.1307(b), but a real evaluation accounts for antenna patterns, ground reflection, the near field, feedline loss and every other source at the site. Use this to see whether a station is nowhere near the limit or worth evaluating properly."
          />
        </TabsContent>

        <!-- Learn -->
        <TabsContent value="learn" class="flex flex-col gap-3 pt-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs text-muted-foreground">
              What each part of the spectrum is, how it travels, what it passes through, and what it
              does to people.
            </p>
            <Button
              variant="outline"
              size="sm"
              aria-label="Print the allocation list"
              @click="printPage"
            >
              <Printer class="size-4" />
              Print
            </Button>
          </div>
          <div
            v-if="learnNote"
            class="rounded-[14px] border bg-[image:var(--grad-brand-soft)] p-4 text-sm"
          >
            <div
              class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
            >
              At {{ focusFreq != null ? formatFrequency(focusFreq) : "" }}
            </div>
            <p class="leading-relaxed">{{ learnNote.what }}</p>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <article
              v-for="note in BAND_EDUCATION"
              :key="note.bandId"
              class="flex flex-col gap-2 rounded-[14px] border bg-card p-4 text-sm shadow-[var(--sh-sm)]"
              :class="learnNote?.bandId === note.bandId ? 'ring-2 ring-[color:var(--ring)]' : ''"
            >
              <h3 class="font-semibold">{{ note.what.split(/[,.]/)[0] }}</h3>
              <p class="leading-relaxed">{{ note.what }}</p>
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs leading-relaxed">
                <dt class="font-medium text-muted-foreground">Travels</dt>
                <dd>{{ note.propagation }}</dd>
                <dt class="font-medium text-muted-foreground">Penetrates</dt>
                <dd>{{ note.penetration }}</dd>
                <dt class="font-medium text-muted-foreground">Health</dt>
                <dd>{{ note.health }}</dd>
              </dl>
            </article>
          </div>
          <div class="rounded-[10px] border px-3 py-2 text-xs text-muted-foreground">
            <div class="mb-1 font-semibold">
              Sources (retrieved {{ ALLOCATION_META.retrieved }})
            </div>
            <ul class="flex flex-col gap-0.5">
              <li v-for="src in ALLOCATION_META.sources" :key="src.id">
                <a
                  :href="src.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-[color:var(--primary)] underline-offset-2 hover:underline"
                >
                  {{ src.title }}
                  <ExternalLink class="size-3" />
                </a>
              </li>
            </ul>
            <p class="mt-2 leading-relaxed">{{ ALLOCATION_META.disclaimer }}</p>
          </div>
        </TabsContent>
      </Tabs>
    </div>

    <!-- Print view: the band list for the chosen region, with no controls -->
    <div class="hidden print:block">
      <h2 class="text-base font-semibold">Spectrum allocations, {{ REGION_LABELS[region] }}</h2>
      <p class="text-xs">{{ ALLOCATION_META.disclaimer }}</p>
      <table class="mt-2 w-full text-xs">
        <thead>
          <tr class="text-left">
            <th class="py-1 pr-2">Band</th>
            <th class="py-1 pr-2">Range</th>
            <th class="py-1 pr-2">Service</th>
            <th class="py-1 pr-2">Status</th>
            <th class="py-1">Summary</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in filteredAllocs" :key="a.id" class="border-t align-top">
            <td class="py-1 pr-2 font-medium">{{ a.label }}</td>
            <td class="py-1 pr-2 whitespace-nowrap">{{ formatRange(a.lowHz, a.highHz) }}</td>
            <td class="py-1 pr-2">{{ serviceLabel(a.service) }}</td>
            <td class="py-1 pr-2">{{ STATUS_LABELS[a.status] }}</td>
            <td class="py-1">{{ a.summary }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="text-xs text-muted-foreground print:hidden">
      Gamma rays are at the start of the axis and ELF radio at the end. Band boundaries follow
      common conventions and broadcast allocations are United States allocations. The ionizing flag
      uses an approximate 10 eV threshold. Everything runs in your browser: your files and inputs
      never leave your device.
    </p>
  </div>
</template>
