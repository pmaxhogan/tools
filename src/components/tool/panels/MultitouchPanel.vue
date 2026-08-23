<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Maximize2, Minimize2, RotateCcw } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  coverageGrid,
  describePointerType,
  maxSimultaneous,
  pressureStats,
  run,
  type CoverageResult,
  type PointerType,
  type PressureStats,
  type TouchHistory,
  type TouchPoint,
} from "@/tools/multitouch-tester/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import CopyButton from "../CopyButton.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the Multitouch Tester.
 *
 * The generic ToolShell has a paste box and a text output, which is the wrong
 * shape entirely for a tool whose input is ten fingers on glass. This panel
 * owns the one thing the shell cannot express: a capture surface that takes
 * raw pointer events, captures each pointer, and paints a labeled disc,
 * pressure ring, contact ellipse, tilt vector, and fading trail per contact.
 *
 * Every number it shows still comes from src/tools/multitouch-tester (rule 27):
 * `maxSimultaneous` tracks the running peak, `coverageGrid` buckets the sweep
 * into the dead zone map, `pressureStats` decides whether a stylus reports real
 * pressure, `describePointerType` names each pointer, and `run` builds the
 * copyable report rows (including the per-point summary from
 * `summarizeTouches`). This file owns only the DOM: pointer capture, canvas
 * painting, the Fullscreen API, and layout.
 *
 * Nothing here touches the network and nothing is stored: your files and inputs
 * never leave your device. Only the view choice and the grid width go in the
 * URL fragment, never the touch data itself.
 *
 * Every browser read happens in onMounted or an event handler, so the server
 * rendered shell never touches window, document, or navigator.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const VIEW_VALUES = ["live", "coverage", "pressure"] as const;
type ViewId = (typeof VIEW_VALUES)[number];

/**
 * The logic layer buckets coverage into `gridCols` columns by its own
 * DEFAULT_GRID_ROWS rows, and that constant is not exported. Mirroring it here
 * keeps the grid drawn on the canvas identical to the "Grid size" row the
 * report prints, which is the whole point of showing both.
 */
const GRID_ROWS = 16;
const GRID_COLS_MIN = 5;
const GRID_COLS_MAX = 20;
const DEFAULT_GRID_COLS = 10;

/** Recorded samples are capped so a long sweep cannot grow without bound. */
const MAX_SNAPSHOTS = 1200;
/** Pressure readings kept per pointer type, also capped. */
const MAX_PRESSURE_SAMPLES = 2000;
/**
 * A coverage sweep only describes the surface it was drawn on. Once the shape
 * of the surface changes by more than this fraction (fullscreen, a rotated
 * phone, a resized window), the old map would claim cells nobody has touched,
 * so it is thrown away instead.
 */
const ASPECT_EPSILON = 0.05;
/** A point has to travel this far, in CSS pixels, before a new sample is kept. */
const MOVE_EPSILON_PX = 4;
/** Or change pressure by this much, so a stylus held still is still sampled. */
const PRESSURE_EPSILON = 0.02;
/** How long a trail dot stays on screen. */
const TRAIL_MS = 700;
/** How often the reactive readouts and the report are rebuilt from raw state. */
const UI_TICK_MS = 100;
const REPORT_TICK_MS = 250;

/** Distinct hues, one per simultaneous contact, readable on both themes. */
const POINTER_HUES = [265, 14, 190, 42, 320, 152, 218, 92, 348, 62, 280, 172];

function pointerColor(index: number, alpha = 1): string {
  const hue = POINTER_HUES[index % POINTER_HUES.length];
  return `hsla(${hue}, 72%, 56%, ${alpha})`;
}

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

interface TrailDot {
  nx: number;
  ny: number;
  t: number;
}

/**
 * One pointer that is currently down. Coordinates are kept surface relative
 * (0 to 1) so entering fullscreen, rotating the phone, or resizing the window
 * does not smear the recorded map across the wrong geometry. Tilt has no home
 * in the pure layer's TouchPoint, so it lives here and is drawn only.
 */
interface LivePointer {
  id: number;
  rawType: string;
  pointerType: PointerType | undefined;
  nx: number;
  ny: number;
  pressure: number;
  radiusX: number | undefined;
  radiusY: number | undefined;
  rotationAngle: number | undefined;
  tiltX: number;
  tiltY: number;
  colorIndex: number;
  trail: TrailDot[];
}

/** A recorded sample, stored surface relative for the same reason. */
interface RecordedPoint {
  id: number;
  nx: number;
  ny: number;
  pressure: number;
  pointerType: PointerType | undefined;
}

type RecordedSnapshot = RecordedPoint[];

/** The JSON shape the tool's run() parses. */
interface TouchReport {
  points: TouchPoint[];
  history?: TouchHistory;
  maxSeen: number;
  viewport: { width: number; height: number };
}

/** Pressure readings for one kind of device, kept apart so a constant 0.5 from
 * a mouse next to a constant 1.0 from a finger is never read as "it varies". */
interface PressureGroup {
  type: string;
  label: string;
  count: number;
  stats: PressureStats;
}

interface PointerRow {
  id: number;
  color: string;
  typeLabel: string;
  coords: string;
  pressure: number;
  pressureLabel: string;
  detail: string;
}

interface CanvasTheme {
  grid: string;
  covered: string;
  text: string;
  muted: string;
}

const FALLBACK_THEME: CanvasTheme = {
  grid: "#e7e2da",
  covered: "#5b4bd6",
  text: "#1b1917",
  muted: "#79726b",
};

/* ------------------------------------------------------------------ *
 * state
 *
 * The pointer map, the recorded history, and the canvas metrics are plain
 * values, not refs: they change on every pointer event and are read by the
 * animation loop, so making them reactive would only cost render churn. The
 * refs below are the DOM facing summary, refreshed on a fixed tick.
 * ------------------------------------------------------------------ */

const surfaceRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const livePointers = new Map<number, LivePointer>();
const usedColors = new Set<number>();
let history: RecordedSnapshot[] = [];
let lastRecorded: RecordedSnapshot = [];
/**
 * Pressure readings keyed by pointer type. Kept apart from the coverage
 * history because that history is dropped whenever the surface changes shape,
 * and a stylus pressure test has no reason to lose its samples over a resize.
 */
const pressureLog = new Map<string, number[]>();
/** The snapshot taken when the newest contact landed, so pinch and rotation
 * are measured from the start of the gesture rather than the session. */
let gestureStart: RecordedSnapshot | null = null;

let cssWidth = 0;
let cssHeight = 0;
let surfaceAspect = 0;
let frame = 0;
let lastUiAt = 0;
let lastReportAt = 0;
let uiDirty = true;
let reportDirty = true;
let theme: CanvasTheme = FALLBACK_THEME;
let themeObserver: MutationObserver | null = null;
let reducedMotion = false;
let requestedFullscreen = false;
let frameCoverage: CoverageResult | null = null;
let coverageDirty = true;

const view = ref<ViewId>("live");
const gridCols = ref(DEFAULT_GRID_COLS);
const activeCount = ref(0);
const maxSeen = ref(0);
const totalTouches = ref(0);
const isFullscreen = ref(false);
const pointerRows = ref<PointerRow[]>([]);
const coveragePercent = ref(0);
const coveredCells = ref(0);
const totalCells = ref(0);
const pressureGroups = ref<PressureGroup[]>([]);
const pressureFocus = ref<PressureGroup | null>(null);
const pressureSampleCount = ref(0);
const supportsPressure = ref(false);
const reportRows = ref<Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const showHint = computed(() => totalTouches.value === 0);
const reportJson = computed(() =>
  reportRows.value ? JSON.stringify(reportRows.value, null, 2) : "",
);

/* ------------------------------------------------------------------ *
 * view control, sourced from meta so the segmented labels never drift from
 * the select the generic shell would render
 * ------------------------------------------------------------------ */

function isViewId(value: string): value is ViewId {
  return (VIEW_VALUES as readonly string[]).includes(value);
}

const FALLBACK_VIEW_LABELS: Record<ViewId, string> = {
  live: "Live points",
  coverage: "Coverage grid",
  pressure: "Pressure stats",
};

const viewOptions = computed<{ value: ViewId; label: string }[]>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "view");
  const spec: SelectOptionSpec | undefined = found && found.kind === "select" ? found : undefined;
  const labels = new Map<ViewId, string>();
  for (const option of spec?.options ?? []) {
    if (isViewId(option.value)) labels.set(option.value, option.label);
  }
  return VIEW_VALUES.map((value) => ({
    value,
    label: labels.get(value) ?? FALLBACK_VIEW_LABELS[value],
  }));
});

const gridColsSpec = computed(() => {
  const found = props.meta.options?.find((o) => o.kind === "number" && o.id === "gridCols");
  if (found && found.kind === "number") {
    return {
      label: found.label,
      min: found.min ?? GRID_COLS_MIN,
      max: found.max ?? GRID_COLS_MAX,
      step: found.step ?? 1,
      fallback: found.default,
    };
  }
  return {
    label: "Coverage grid columns",
    min: GRID_COLS_MIN,
    max: GRID_COLS_MAX,
    step: 1,
    fallback: DEFAULT_GRID_COLS,
  };
});

function persistFragment() {
  writeFragment({ opts: { view: view.value, gridCols: String(gridCols.value) } });
}

function setView(next: ViewId) {
  if (view.value === next) return;
  view.value = next;
  persistFragment();
  uiDirty = true;
  reportDirty = true;
}

function onGridColsSlider(value?: number[]) {
  const next = value?.[0];
  if (next !== undefined) setGridCols(next);
}

function setGridCols(raw: string | number) {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.min(gridColsSpec.value.max, Math.max(gridColsSpec.value.min, parsed));
  if (clamped === gridCols.value) return;
  gridCols.value = clamped;
  persistFragment();
  uiDirty = true;
  reportDirty = true;
  coverageDirty = true;
}

/* ------------------------------------------------------------------ *
 * translating between the panel's surface relative samples and the pure
 * layer's TouchPoint, which wants real pixels against a stated viewport
 * ------------------------------------------------------------------ */

function toTouchPoint(p: RecordedPoint, width: number, height: number): TouchPoint {
  return {
    id: p.id,
    x: p.nx * width,
    y: p.ny * height,
    pressure: p.pressure,
    pointerType: p.pointerType,
  };
}

function recordedHistory(width: number, height: number): TouchHistory {
  return history.map((snapshot) => snapshot.map((p) => toTouchPoint(p, width, height)));
}

function orderedPointers(): LivePointer[] {
  return Array.from(livePointers.values()).sort((a, b) => a.id - b.id);
}

function snapshotOf(pointers: LivePointer[]): RecordedSnapshot {
  return pointers.map((p) => ({
    id: p.id,
    nx: p.nx,
    ny: p.ny,
    pressure: p.pressure,
    pointerType: p.pointerType,
  }));
}

function livePoints(width: number, height: number): TouchPoint[] {
  return orderedPointers().map((p) => ({
    id: p.id,
    x: p.nx * width,
    y: p.ny * height,
    pressure: p.pressure,
    radiusX: p.radiusX,
    radiusY: p.radiusY,
    rotationAngle: p.rotationAngle,
    pointerType: p.pointerType,
  }));
}

/**
 * Pressure per device, widest reading range first. Samples are logged only
 * from press and move events: a release reports 0 on hardware with no sensor,
 * and mixing that with the held reading would make a plain finger look like it
 * supports pressure.
 */
function pressureGroupList(): PressureGroup[] {
  const groups: PressureGroup[] = [];
  for (const [type, samples] of pressureLog) {
    if (samples.length === 0) continue;
    groups.push({
      type,
      label: describePointerType(type),
      count: samples.length,
      stats: pressureStats(samples),
    });
  }
  groups.sort((a, b) => {
    const rangeA = a.stats.max - a.stats.min;
    const rangeB = b.stats.max - b.stats.min;
    if (rangeB !== rangeA) return rangeB - rangeA;
    return b.count - a.count;
  });
  return groups;
}

/* ------------------------------------------------------------------ *
 * pointer capture
 * ------------------------------------------------------------------ */

function normalizePointerType(raw: string): PointerType | undefined {
  if (raw === "touch" || raw === "pen" || raw === "mouse") return raw;
  return undefined;
}

function claimColor(): number {
  for (let i = 0; i < POINTER_HUES.length; i++) {
    if (!usedColors.has(i)) {
      usedColors.add(i);
      return i;
    }
  }
  return usedColors.size % POINTER_HUES.length;
}

function surfacePosition(e: PointerEvent, el: HTMLElement): { nx: number; ny: number } {
  const box = el.getBoundingClientRect();
  const nx = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
  const ny = box.height > 0 ? (e.clientY - box.top) / box.height : 0;
  return { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
}

/**
 * A mouse reports width and height of 1 and a twist of 0 whether or not the
 * hardware has anything to say, and the pure summary prints any radius or
 * angle it is handed. Only pass values a real digitizer produced.
 */
function contactRadius(extent: number): number | undefined {
  return extent > 1 ? extent / 2 : undefined;
}

function applyEvent(p: LivePointer, e: PointerEvent, el: HTMLElement, now: number) {
  const { nx, ny } = surfacePosition(e, el);
  p.nx = nx;
  p.ny = ny;
  p.pressure = e.pressure;
  p.radiusX = contactRadius(e.width);
  p.radiusY = contactRadius(e.height);
  p.rotationAngle = e.twist === 0 ? undefined : e.twist;
  p.tiltX = e.tiltX;
  p.tiltY = e.tiltY;
  p.trail.push({ nx, ny, t: now });

  const samples = pressureLog.get(p.rawType) ?? [];
  samples.push(e.pressure);
  if (samples.length > MAX_PRESSURE_SAMPLES)
    samples.splice(0, samples.length - MAX_PRESSURE_SAMPLES);
  pressureLog.set(p.rawType, samples);
}

/** Running peak, folded in per snapshot so a capped history cannot lose it. */
function noteConcurrency(width: number, height: number) {
  const snapshot = livePoints(width, height);
  maxSeen.value = Math.max(maxSeen.value, maxSimultaneous([snapshot]));
}

/**
 * Whether this snapshot is worth keeping. Distance is the usual test, but
 * pressure counts too: leaning harder on a stylus without moving it is exactly
 * the gesture the pressure view exists to measure.
 */
function changedEnough(next: RecordedSnapshot): boolean {
  if (next.length !== lastRecorded.length) return true;
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  for (let i = 0; i < next.length; i++) {
    const before = lastRecorded[i];
    const after = next[i];
    if (before.id !== after.id) return true;
    if (Math.abs(after.pressure - before.pressure) >= PRESSURE_EPSILON) return true;
    const dx = (after.nx - before.nx) * width;
    const dy = (after.ny - before.ny) * height;
    if (Math.hypot(dx, dy) >= MOVE_EPSILON_PX) return true;
  }
  return false;
}

function recordSample(force: boolean) {
  const snapshot = snapshotOf(orderedPointers());
  if (snapshot.length === 0) return;
  if (!force && !changedEnough(snapshot)) return;
  history.push(snapshot);
  lastRecorded = snapshot;
  if (history.length > MAX_SNAPSHOTS) history = history.slice(history.length - MAX_SNAPSHOTS);
  coverageDirty = true;
}

function onPointerDown(e: PointerEvent) {
  const el = surfaceRef.value;
  if (!el) return;
  e.preventDefault();
  // A pointer can vanish between the browser queuing the event and this call,
  // and setPointerCapture throws rather than shrugging when that happens.
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // Capture is an optimization here; the surface still tracks the pointer.
  }

  const now = performance.now();
  const point: LivePointer = {
    id: e.pointerId,
    rawType: e.pointerType,
    pointerType: normalizePointerType(e.pointerType),
    nx: 0,
    ny: 0,
    pressure: e.pressure,
    radiusX: undefined,
    radiusY: undefined,
    rotationAngle: undefined,
    tiltX: 0,
    tiltY: 0,
    colorIndex: claimColor(),
    trail: [],
  };
  applyEvent(point, e, el, now);
  livePointers.set(e.pointerId, point);

  totalTouches.value += 1;
  noteConcurrency(Math.max(1, cssWidth), Math.max(1, cssHeight));
  recordSample(true);
  gestureStart = snapshotOf(orderedPointers());
  uiDirty = true;
  reportDirty = true;
}

function onPointerMove(e: PointerEvent) {
  const el = surfaceRef.value;
  const point = livePointers.get(e.pointerId);
  if (!el || !point) return;
  e.preventDefault();
  applyEvent(point, e, el, performance.now());
  noteConcurrency(Math.max(1, cssWidth), Math.max(1, cssHeight));
  recordSample(false);
  uiDirty = true;
  reportDirty = true;
}

/** Only up and cancel remove a pointer. Capturing a pointer fires leave and
 * out immediately, so removing on those would delete every live contact. */
function onPointerEnd(e: PointerEvent) {
  const el = surfaceRef.value;
  const point = livePointers.get(e.pointerId);
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  if (!point) return;
  usedColors.delete(point.colorIndex);
  livePointers.delete(e.pointerId);
  // Pinch and rotation compare the first and last snapshots by position, so a
  // lifted finger has to re-baseline the gesture or the two readings would be
  // taken between different fingers.
  gestureStart = livePointers.size === 0 ? null : snapshotOf(orderedPointers());
  uiDirty = true;
  reportDirty = true;
}

/** Drops the sweep only. Called when the surface changes shape, where the old
 * map describes geometry that is no longer on screen. */
function clearCoverage() {
  history = [];
  lastRecorded = [];
  frameCoverage = null;
  coveragePercent.value = 0;
  coveredCells.value = 0;
  totalCells.value = 0;
  coverageDirty = true;
  uiDirty = true;
  reportDirty = true;
}

function reset() {
  livePointers.clear();
  usedColors.clear();
  pressureLog.clear();
  gestureStart = null;
  maxSeen.value = 0;
  totalTouches.value = 0;
  activeCount.value = 0;
  pointerRows.value = [];
  pressureGroups.value = [];
  pressureFocus.value = null;
  pressureSampleCount.value = 0;
  supportsPressure.value = false;
  clearCoverage();
  refreshReport();
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

function buildReportInput(): string {
  if (totalTouches.value === 0) return "";
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const report: TouchReport = {
    points: livePoints(width, height),
    maxSeen: maxSeen.value,
    viewport: { width, height },
  };

  if (view.value === "live") {
    // Two snapshots are all the live report needs: pinch and rotation are read
    // from the first and the last, and a whole sweep would only slow it down.
    const start = gestureStart;
    if (start && start.length >= 2 && report.points.length >= 2) {
      report.history = [start.map((p) => toTouchPoint(p, width, height)), report.points];
    }
  } else if (view.value === "pressure") {
    // run() pools every sample it is handed into one verdict, so it is handed
    // one device: the one with the widest reading range, which is the one the
    // panel puts at the top of the pressure view.
    const focus = pressureGroupList()[0];
    const samples = focus ? (pressureLog.get(focus.type) ?? []) : [];
    if (samples.length > 0) {
      const pointerType = normalizePointerType(focus.type);
      report.history = [
        samples.map((value, index) => ({ id: index, x: 0, y: 0, pressure: value, pointerType })),
      ];
    }
  } else {
    report.history = recordedHistory(width, height);
  }

  return JSON.stringify(report);
}

function refreshReport() {
  try {
    const rows = run(buildReportInput(), { view: view.value, gridCols: gridCols.value });
    if (totalTouches.value > 0) rows["Total touches"] = String(totalTouches.value);
    reportRows.value = rows;
    error.value = null;
  } catch (e) {
    reportRows.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : "That touch report could not be read." };
  }
}

/* ------------------------------------------------------------------ *
 * reactive readouts
 * ------------------------------------------------------------------ */

function syncUi() {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const pointers = orderedPointers();

  activeCount.value = pointers.length;
  pointerRows.value = pointers.map((p) => {
    const details: string[] = [];
    if (p.radiusX !== undefined || p.radiusY !== undefined) {
      details.push(`radius ${(p.radiusX ?? 0).toFixed(1)} by ${(p.radiusY ?? 0).toFixed(1)} px`);
    }
    if (p.tiltX !== 0 || p.tiltY !== 0) details.push(`tilt ${p.tiltX} deg, ${p.tiltY} deg`);
    if (p.rotationAngle !== undefined) details.push(`twist ${p.rotationAngle} deg`);
    return {
      id: p.id,
      color: pointerColor(p.colorIndex),
      typeLabel: describePointerType(p.rawType),
      coords: `${Math.round(p.nx * width)}, ${Math.round(p.ny * height)}`,
      pressure: p.pressure,
      pressureLabel: p.pressure.toFixed(2),
      detail: details.join(" | "),
    };
  });

  if (view.value === "coverage") {
    const cov = frameCoverage;
    if (cov) {
      coveragePercent.value = cov.coveragePercent;
      coveredCells.value = cov.grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
      totalCells.value = cov.cols * cov.rows;
    }
  } else if (view.value === "pressure") {
    const groups = pressureGroupList();
    pressureGroups.value = groups;
    pressureFocus.value = groups[0] ?? null;
    pressureSampleCount.value = groups.reduce((sum, group) => sum + group.count, 0);
    // The verdict is per device on purpose. Pooling a constant 0.5 from a mouse
    // with a constant 1.0 from a finger would spread across half the scale and
    // read as real pressure support when neither device has any.
    supportsPressure.value = groups.some((group) => group.stats.supportsPressure);
  }
}

/* ------------------------------------------------------------------ *
 * canvas
 * ------------------------------------------------------------------ */

function readTheme(el: HTMLElement): CanvasTheme {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    grid: pick("--border", FALLBACK_THEME.grid),
    covered: pick("--primary", FALLBACK_THEME.covered),
    text: pick("--foreground", FALLBACK_THEME.text),
    muted: pick("--muted-foreground", FALLBACK_THEME.muted),
  };
}

function sizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  cssWidth = canvas.clientWidth;
  cssHeight = canvas.clientHeight;

  // One place catches fullscreen, a rotated phone, and a resized window: a
  // sweep recorded on one shape of surface cannot vouch for another.
  const aspect = cssHeight > 0 ? cssWidth / cssHeight : 0;
  if (aspect > 0) {
    if (surfaceAspect > 0 && Math.abs(aspect - surfaceAspect) / surfaceAspect > ASPECT_EPSILON) {
      clearCoverage();
    }
    surfaceAspect = aspect;
  }

  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawCoverage(ctx: CanvasRenderingContext2D, width: number, height: number) {
  // Rebuilding the grid from the whole sweep on every frame would allocate a
  // copy of the history 60 times a second, so it is recomputed only when a new
  // sample lands or the column count changes.
  let cov = frameCoverage;
  if (coverageDirty || !cov) {
    cov = coverageGrid(recordedHistory(width, height), width, height, gridCols.value, GRID_ROWS);
    frameCoverage = cov;
    coverageDirty = false;
  }

  const cellW = width / cov.cols;
  const cellH = height / cov.rows;

  ctx.save();
  for (let row = 0; row < cov.rows; row++) {
    for (let col = 0; col < cov.cols; col++) {
      const x = col * cellW;
      const y = row * cellH;
      if (cov.grid[row][col]) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = theme.covered;
        ctx.fillRect(x, y, cellW, cellH);
      }
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, cellW - 1, cellH - 1);
    }
  }
  ctx.restore();
}

function drawTrail(ctx: CanvasRenderingContext2D, p: LivePointer, width: number, height: number) {
  if (p.trail.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < p.trail.length; i++) {
    const from = p.trail[i - 1];
    const to = p.trail[i];
    const fade = i / p.trail.length;
    ctx.strokeStyle = pointerColor(p.colorIndex, 0.1 + fade * 0.5);
    ctx.lineWidth = 2 + fade * 4;
    ctx.beginPath();
    ctx.moveTo(from.nx * width, from.ny * height);
    ctx.lineTo(to.nx * width, to.ny * height);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPointer(ctx: CanvasRenderingContext2D, p: LivePointer, width: number, height: number) {
  const x = p.nx * width;
  const y = p.ny * height;
  const color = pointerColor(p.colorIndex);
  const discRadius = 22;
  const ringRadius = 33;

  ctx.save();

  // Crosshair, so a coordinate is readable without doing arithmetic by eye.
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Reported contact patch, drawn only when the digitizer sizes it.
  if (p.radiusX !== undefined || p.radiusY !== undefined) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      Math.max(2, p.radiusX ?? 2),
      Math.max(2, p.radiusY ?? 2),
      ((p.rotationAngle ?? 0) * Math.PI) / 180,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Pressure ring: a full turn is a pressure of 1.
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(
    x,
    y,
    ringRadius,
    -Math.PI / 2,
    -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0, p.pressure)),
  );
  ctx.stroke();
  ctx.lineCap = "butt";

  // Tilt vector, which the pure TouchPoint has no field for.
  if (p.tiltX !== 0 || p.tiltY !== 0) {
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (p.tiltX / 90) * 46, y + (p.tiltY / 90) * 46);
    ctx.stroke();
  }

  // Twist tick on the ring.
  if (p.rotationAngle !== undefined) {
    const twist = ((p.rotationAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.moveTo(x + Math.cos(twist) * (ringRadius - 8), y + Math.sin(twist) * (ringRadius - 8));
    ctx.lineTo(x + Math.cos(twist) * (ringRadius + 8), y + Math.sin(twist) * (ringRadius + 8));
    ctx.stroke();
  }

  // Disc and label.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, discRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = '600 15px "Geist", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(p.id), x, y + 1);

  // Near the bottom edge the caption would be clipped, so flip it above.
  const below = y + ringRadius + 36 <= height;
  const firstLine = below ? y + ringRadius + 16 : y - ringRadius - 32;
  const secondLine = below ? y + ringRadius + 32 : y - ringRadius - 16;

  ctx.fillStyle = theme.text;
  ctx.font = '600 12px "Geist", ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(describePointerType(p.rawType), x, firstLine);
  ctx.fillStyle = theme.muted;
  ctx.font = '12px "Geist Mono", ui-monospace, monospace';
  ctx.fillText(`${Math.round(x)}, ${Math.round(y)}  p ${p.pressure.toFixed(2)}`, x, secondLine);

  ctx.restore();
}

function pruneTrails(now: number) {
  const cutoff = now - (reducedMotion ? 0 : TRAIL_MS);
  for (const p of livePointers.values()) {
    let start = 0;
    while (start < p.trail.length && p.trail[start].t < cutoff) start++;
    if (start > 0) p.trail = p.trail.slice(start);
  }
}

function tick(now: number) {
  frame = requestAnimationFrame(tick);

  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = sizeCanvas(canvas);
  if (!ctx) return;

  const width = cssWidth;
  const height = cssHeight;
  if (width <= 0 || height <= 0) return;

  pruneTrails(now);
  ctx.clearRect(0, 0, width, height);
  if (view.value === "coverage") drawCoverage(ctx, width, height);
  for (const p of orderedPointers()) {
    drawTrail(ctx, p, width, height);
    drawPointer(ctx, p, width, height);
  }

  if (now - lastUiAt >= UI_TICK_MS && (uiDirty || livePointers.size > 0)) {
    lastUiAt = now;
    uiDirty = false;
    syncUi();
  }
  if (reportDirty && now - lastReportAt >= REPORT_TICK_MS) {
    lastReportAt = now;
    reportDirty = false;
    refreshReport();
  }
}

function startLoop() {
  if (frame) return;
  frame = requestAnimationFrame(tick);
}

function stopLoop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

function onVisibilityChange() {
  if (document.hidden) stopLoop();
  else startLoop();
}

/* ------------------------------------------------------------------ *
 * fullscreen
 * ------------------------------------------------------------------ */

interface FsElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function currentFullscreenElement(): Element | null {
  const doc = document as FsDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function toggleFullscreen() {
  if (isFullscreen.value) {
    requestedFullscreen = false;
    const doc = document as FsDocument;
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (exit && currentFullscreenElement()) Promise.resolve(exit.call(doc)).catch(() => {});
    return;
  }
  const el = surfaceRef.value as FsElement | null;
  if (!el) return;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return;
  requestedFullscreen = true;
  // A browser can refuse this (an iframe without the permission, a policy, a
  // stale gesture). The panel keeps working inline, so a refusal costs nothing.
  Promise.resolve(request.call(el)).catch(() => {
    requestedFullscreen = false;
  });
}

function onFullscreenChange() {
  const el = surfaceRef.value;
  isFullscreen.value = Boolean(el) && currentFullscreenElement() === el;
  if (!isFullscreen.value) requestedFullscreen = false;
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  gridCols.value = gridColsSpec.value.fallback;
  const frag = readFragment();
  if (frag.opts.view && isViewId(frag.opts.view)) view.value = frag.opts.view;
  if (frag.opts.gridCols) setGridCols(frag.opts.gridCols);

  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = surfaceRef.value;
  if (el) theme = readTheme(el);
  // The header toggle swaps the .dark class, so re-read the tokens then rather
  // than calling getComputedStyle from inside the animation loop.
  themeObserver = new MutationObserver(() => {
    const surface = surfaceRef.value;
    if (surface) theme = readTheme(surface);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  // If a browser drops the capture, the release lands somewhere else and the
  // contact would stay on screen forever, inflating the peak count. Watching
  // the window as well means a release anywhere always clears it.
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);

  refreshReport();
  startLoop();
});

onUnmounted(() => {
  stopLoop();
  themeObserver?.disconnect();
  themeObserver = null;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pointerup", onPointerEnd);
  window.removeEventListener("pointercancel", onPointerEnd);
  if (requestedFullscreen) {
    requestedFullscreen = false;
    const doc = document as FsDocument;
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (exit && currentFullscreenElement()) Promise.resolve(exit.call(doc)).catch(() => {});
  }
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-[52ch] text-xs text-muted-foreground">
        Read straight from this browser's pointer events: your files and inputs never leave your
        device.
      </p>
      <div class="flex items-center gap-1">
        <Button variant="ghost" size="sm" @click="toggleFullscreen">
          <Minimize2 v-if="isFullscreen" class="size-3.5" aria-hidden="true" />
          <Maximize2 v-else class="size-3.5" aria-hidden="true" />
          {{ isFullscreen ? "Exit fullscreen" : "Fullscreen" }}
        </Button>
        <Button variant="ghost" size="sm" @click="reset">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>
      </div>
    </div>

    <!-- View -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >View</span
      >
      <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <Button
          v-for="option in viewOptions"
          :key="option.value"
          variant="ghost"
          size="sm"
          :aria-pressed="view === option.value"
          :class="view === option.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="setView(option.value)"
        >
          {{ option.label }}
        </Button>
      </div>
    </div>

    <!-- Readouts -->
    <div class="grid grid-cols-3 gap-3">
      <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs text-muted-foreground">Active now</div>
        <div class="font-mono text-2xl tabular-nums">{{ activeCount }}</div>
      </div>
      <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs text-muted-foreground">Max at once</div>
        <div class="font-mono text-2xl tabular-nums">{{ maxSeen }}</div>
      </div>
      <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs text-muted-foreground">Total touches</div>
        <div class="font-mono text-2xl tabular-nums">{{ totalTouches }}</div>
      </div>
    </div>

    <!-- Capture surface -->
    <div
      ref="surfaceRef"
      role="group"
      aria-label="Touch capture surface"
      class="capture-surface relative touch-none overflow-hidden overscroll-contain bg-secondary select-none shadow-[var(--sh-inset)]"
      :class="isFullscreen ? 'h-full w-full rounded-none' : 'h-[min(58vh,460px)] rounded-[10px]'"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerEnd"
      @pointercancel="onPointerEnd"
      @contextmenu.prevent
      @dragstart.prevent
    >
      <canvas ref="canvasRef" class="block size-full" aria-hidden="true"></canvas>

      <div
        v-if="showHint"
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p class="text-sm font-medium">Press here with as many fingers as you can at once</p>
        <p class="max-w-[42ch] text-xs text-muted-foreground">
          A pen or a mouse works too. Sweep a finger across the whole surface to check the coverage
          grid for dead zones.
        </p>
      </div>

      <div v-if="isFullscreen" class="absolute top-3 right-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          class="pointer-events-auto bg-card shadow-[var(--sh-sm)]"
          @pointerdown.stop
          @click="reset"
        >
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="pointer-events-auto bg-card shadow-[var(--sh-sm)]"
          @pointerdown.stop
          @click="toggleFullscreen"
        >
          <Minimize2 class="size-3.5" aria-hidden="true" />
          Exit
        </Button>
      </div>
    </div>

    <!-- Live view: one row per active pointer -->
    <div v-if="view === 'live'" class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Active pointers
      </span>
      <div class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div
          v-for="row in pointerRows"
          :key="row.id"
          class="flex flex-wrap items-center gap-2 text-xs"
        >
          <span
            class="size-3 shrink-0 rounded-full"
            :style="{ backgroundColor: row.color }"
            aria-hidden="true"
          ></span>
          <span class="w-16 shrink-0 font-mono tabular-nums">#{{ row.id }}</span>
          <span class="w-32 shrink-0 text-muted-foreground">{{ row.typeLabel }}</span>
          <span class="font-mono tabular-nums">{{ row.coords }}</span>
          <span class="font-mono tabular-nums text-muted-foreground"
            >pressure {{ row.pressureLabel }}</span
          >
          <span v-if="row.detail" class="text-muted-foreground">{{ row.detail }}</span>
        </div>
        <p v-if="pointerRows.length === 0" class="text-xs text-muted-foreground">
          Nothing is touching the surface right now.
        </p>
      </div>
    </div>

    <!-- Coverage view -->
    <div v-else-if="view === 'coverage'" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="flex w-full flex-col gap-1.5 sm:w-56">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground">{{ gridColsSpec.label }}</span>
            <span class="font-mono text-xs tabular-nums">{{ gridCols }} x {{ GRID_ROWS }}</span>
          </div>
          <Slider
            :aria-label="gridColsSpec.label"
            :model-value="[gridCols]"
            :min="gridColsSpec.min"
            :max="gridColsSpec.max"
            :step="gridColsSpec.step"
            class="py-2"
            @update:model-value="onGridColsSlider"
          />
        </div>
        <p class="max-w-[46ch] text-xs text-muted-foreground">
          Drag one finger over every part of the surface. A cell that stays empty is a spot the
          digitizer never reported. Resizing the window or going fullscreen starts the sweep over,
          since the old map describes a surface that is no longer on screen.
        </p>
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Coverage</div>
          <div class="font-mono text-xl tabular-nums">{{ coveragePercent.toFixed(1) }}%</div>
        </div>
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Cells touched</div>
          <div class="font-mono text-xl tabular-nums">{{ coveredCells }} / {{ totalCells }}</div>
        </div>
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Untouched cells</div>
          <div class="font-mono text-xl tabular-nums">
            {{ Math.max(0, totalCells - coveredCells) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Pressure view -->
    <div v-else class="flex flex-col gap-3">
      <p v-if="pressureFocus" class="text-xs text-muted-foreground">
        Showing {{ pressureFocus.label }}, the device with the widest reading range.
        {{ pressureSampleCount }} samples across every device so far.
      </p>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Min</div>
          <div class="font-mono text-xl tabular-nums">
            {{ (pressureFocus?.stats.min ?? 0).toFixed(2) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Max</div>
          <div class="font-mono text-xl tabular-nums">
            {{ (pressureFocus?.stats.max ?? 0).toFixed(2) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Average</div>
          <div class="font-mono text-xl tabular-nums">
            {{ (pressureFocus?.stats.avg ?? 0).toFixed(2) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Samples</div>
          <div class="font-mono text-xl tabular-nums">{{ pressureFocus?.count ?? 0 }}</div>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        {{
          supportsPressure
            ? "Pressure varies as you press, so at least one of these devices reports real pressure."
            : "Pressure has not changed for any device yet. A finger or a passive stylus reports a constant value, which counts as no pressure support."
        }}
      </p>

      <div v-if="pressureGroups.length > 1" class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          By device
        </span>
        <div class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div
            v-for="group in pressureGroups"
            :key="group.type"
            class="flex flex-wrap items-center gap-2 text-xs"
          >
            <span class="w-32 shrink-0">{{ group.label }}</span>
            <span class="font-mono tabular-nums"
              >{{ group.stats.min.toFixed(2) }} to {{ group.stats.max.toFixed(2) }}</span
            >
            <span class="font-mono tabular-nums text-muted-foreground"
              >{{ group.count }} samples</span
            >
            <span :class="group.stats.supportsPressure ? 'text-[color:var(--positive)]' : ''">
              {{ group.stats.supportsPressure ? "varies" : "constant" }}
            </span>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Pressure per pointer
        </span>
        <div class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div v-for="row in pointerRows" :key="row.id" class="flex items-center gap-2 text-xs">
            <span class="w-16 shrink-0 font-mono tabular-nums">#{{ row.id }}</span>
            <div class="h-2 flex-1 overflow-hidden rounded-full bg-card">
              <div
                class="h-full rounded-full"
                :style="{
                  width: `${Math.min(100, Math.max(0, row.pressure * 100))}%`,
                  backgroundColor: row.color,
                }"
              ></div>
            </div>
            <span class="w-12 shrink-0 text-right font-mono tabular-nums">{{
              row.pressureLabel
            }}</span>
          </div>
          <p v-if="pointerRows.length === 0" class="text-xs text-muted-foreground">
            Press and hold on the surface with a stylus or a finger to sample pressure.
          </p>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      role="alert"
      class="rounded-[10px] border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <!-- Report -->
    <template v-if="reportRows && !error">
      <div class="flex flex-wrap items-center gap-2">
        <CopyButton :text="reportJson" label="Copy JSON" />
      </div>
      <OutputView :output="reportRows" />
    </template>
  </div>
</template>

<style scoped>
/* touch-action and user-select come from utilities; this is the long press
   callout that iOS shows over a held element, which has no utility. */
.capture-surface {
  -webkit-touch-callout: none;
}
</style>
