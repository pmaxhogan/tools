<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Crosshair, Gauge, MousePointerClick, RotateCcw } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  accelerationCheck,
  clickStats,
  describeButtons,
  dpiFromTravel,
  pollingRateFromTimestamps,
  scrollStats,
  summarize,
  type AccelerationResult,
  type AccelerationSample,
  type ButtonClickStats,
  type ClickEvent,
  type ClickStatsResult,
  type DpiResult,
  type MouseReport,
  type MouseTesterOpts,
  type PollingRateResult,
  type ScrollEvent,
  type ScrollStatsResult,
} from "@/tools/mouse-tester/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the Mouse Polling Rate and DPI Tester.
 *
 * The generic ToolShell can only print a JSON report that somebody else
 * produced. Every number this tool reports has to be measured live from real
 * pointer hardware, so the panel owns the capture surfaces: a pointermove
 * area that reads getCoalescedEvents when the browser exposes it, a canvas
 * line chart of the instantaneous rate, a pointer lock run for DPI and for
 * the acceleration comparison, a click pad, and a wheel pad.
 *
 * Every reading still comes out of the pure logic layer (PROJECT.md rule 27):
 * pollingRateFromTimestamps, dpiFromTravel, accelerationCheck, clickStats,
 * scrollStats, describeButtons, and summarize. This file only collects raw
 * events, draws them, and lays the results out.
 *
 * Nothing touches the DOM before onMounted, so the server rendered shell is
 * inert. Pointer lock is always released on unmount.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const CM_PER_INCH = 2.54;
/** Cap on retained pointermove timestamps: about 12 seconds at 1000 Hz. */
const MAX_MOVE_SAMPLES = 12000;
/** Slack above the cap before the oldest samples are trimmed, so trimming is rare. */
const TRIM_SLACK = 1024;
/** Window the live "current" reading is measured over. */
const CURRENT_WINDOW_MS = 300;
/** Minimum samples inside that window before a current reading is meaningful. */
const MIN_WINDOW_SAMPLES = 5;
/** How often the current reading and a new graph point are computed. */
const SAMPLE_INTERVAL_MS = 50;
/** How often the whole capture is re-read for the average and the summary. */
const SNAPSHOT_INTERVAL_MS = 250;
/** Seconds of history the graph shows. */
const GRAPH_SPAN_MS = 5000;
/** The draw loop parks itself after this long with no pointer activity. */
const IDLE_STOP_MS = 2500;
/** A finish gesture this soon after the lock is the click that started the run. */
const LOCK_SETTLE_MS = 250;
/** Retained click events, plenty for bounce and double click detection. */
const MAX_CLICK_EVENTS = 400;
/** Retained wheel events. */
const MAX_SCROLL_EVENTS = 400;
/** Wheel events shown in the visible log. */
const SCROLL_LOG_LIMIT = 8;
/** Vertical scale steps for the graph, in Hz. */
const GRAPH_SCALE_STEPS = [250, 500, 1000, 2000, 4000, 8000, 16000];
/** The three buttons every mouse has, by MouseEvent.button index. */
const CORE_BUTTONS = [0, 1, 2];

type LockMode = "dpi" | "accel-slow" | "accel-fast";

interface RatePoint {
  t: number;
  hz: number;
}

interface ScrollLogEntry extends ScrollEvent {
  id: number;
}

interface ButtonCell {
  button: number;
  name: string;
  downs: number;
  ups: number;
  avgHeldMs: number | null;
  active: boolean;
}

interface SummaryState {
  rows: Record<string, string> | null;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Element refs and non-reactive capture buffers
 *
 * A fast mouse delivers thousands of samples per second, so the raw move
 * timestamps live in a plain array rather than a reactive one: the draw loop
 * copies a snapshot into a shallowRef a few times a second, and every
 * reactive readout is derived from that snapshot instead.
 * ------------------------------------------------------------------ */

const surfaceEl = ref<HTMLDivElement>();
const canvasEl = ref<HTMLCanvasElement>();

let moveTimestamps: number[] = [];
let rateHistory: RatePoint[] = [];
let lastMoveAt = 0;
let lastSampleAt = 0;
let lastSnapshotAt = 0;
let frame = 0;
let running = false;

/* ------------------------------------------------------------------ *
 * Reactive state
 * ------------------------------------------------------------------ */

const currentHz = ref(0);
const maxHz = ref(0);
const graphMax = ref(GRAPH_SCALE_STEPS[2]);
const coalescedSupported = ref<boolean | null>(null);
const moveSnapshot = shallowRef<number[]>([]);

/** The raw field value: the Input control hands back either a string or a number. */
const distanceText = ref<string | number>("10");
const units = ref<"cm" | "in">("cm");
const travelCounts = ref<number | null>(null);
const liveCounts = ref(0);
const dpiResult = shallowRef<DpiResult | null>(null);
const dpiError = ref<string | null>(null);

const slowSamples = shallowRef<AccelerationSample[]>([]);
const fastSamples = shallowRef<AccelerationSample[]>([]);
const accelResult = shallowRef<AccelerationResult | null>(null);
const accelError = ref<string | null>(null);

const lockMode = ref<LockMode | null>(null);
const lockError = ref<string | null>(null);
let pendingMode: LockMode | null = null;
let lockStartedAt = 0;
let lockLastAt = 0;
let lockCounts = 0;
let lockSamples: AccelerationSample[] = [];

const clickEvents = ref<ClickEvent[]>([]);
const downButtons = ref<number[]>([]);

const scrollEntries = ref<ScrollLogEntry[]>([]);
let scrollSeq = 0;

/* ------------------------------------------------------------------ *
 * Derived readings, all of them straight out of the logic layer
 * ------------------------------------------------------------------ */

const pollingResult = computed<PollingRateResult>(() =>
  pollingRateFromTimestamps(moveSnapshot.value),
);

const distance = computed<number>(() => {
  const raw = distanceText.value;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
});

const distanceInches = computed<number>(() =>
  units.value === "in" ? distance.value : distance.value / CM_PER_INCH,
);

const clickResult = computed<ClickStatsResult>(() => clickStats(clickEvents.value));

const buttonCells = computed<ButtonCell[]>(() =>
  CORE_BUTTONS.map((button) => {
    const name = describeButtons(button);
    const stats: ButtonClickStats | undefined = clickResult.value.perButton[name];
    return {
      button,
      name,
      downs: stats ? stats.downs : 0,
      ups: stats ? stats.ups : 0,
      avgHeldMs: stats ? stats.avgHeldMs : null,
      active: downButtons.value.includes(button),
    };
  }),
);

const coreNames = CORE_BUTTONS.map((b) => describeButtons(b));

const extraButtons = computed(() =>
  Object.entries(clickResult.value.perButton)
    .filter(([name]) => !coreNames.includes(name))
    .map(([name, stats]) => ({ name, downs: stats.downs, ups: stats.ups })),
);

const scrollResult = computed<ScrollStatsResult>(() => scrollStats(scrollEntries.value));

const scrollLog = computed<ScrollLogEntry[]>(() =>
  scrollEntries.value.slice(-SCROLL_LOG_LIMIT).reverse(),
);

/** Only a line or page delta mode expresses a notch in lines or pages. */
const notchDescription = computed<string | null>(() => {
  const s = scrollResult.value;
  if (s.notchSizeY === null) return null;
  if (s.deltaModeLabel === "line") return `${s.notchSizeY} lines per notch`;
  if (s.deltaModeLabel === "page") return `${s.notchSizeY} pages per notch`;
  return `${s.notchSizeY} pixels per notch`;
});

const accelExplanation = computed<string | null>(() => {
  const a = accelResult.value;
  if (!a) return null;
  if (a.verdict === "linear") {
    return `Both runs reported about the same number of counts (${a.slowCounts} slow, ${a.fastCounts} fast, a ratio of ${a.ratio}). Movement tracks physical distance, not speed, so pointer acceleration is off.`;
  }
  return `The fast run reported ${a.ratio} times the counts of the slow run (${a.slowCounts} slow, ${a.fastCounts} fast) for the same physical distance. Something between the sensor and the browser is scaling movement with speed, usually the operating system setting called pointer acceleration or enhance pointer precision.`;
});

/* ------------------------------------------------------------------ *
 * The combined report, and the summary rows the logic builds from it
 * ------------------------------------------------------------------ */

const report = computed<MouseReport | null>(() => {
  const next: MouseReport = {};
  let any = false;

  if (moveSnapshot.value.length > 0) {
    next.moveTimestamps = moveSnapshot.value;
    any = true;
  }
  if (travelCounts.value !== null && travelCounts.value !== 0 && distanceInches.value > 0) {
    next.travel = { counts: travelCounts.value, physicalDistanceInches: distanceInches.value };
    any = true;
  }
  if (slowSamples.value.length > 0 && fastSamples.value.length > 0) {
    next.acceleration = { slow: slowSamples.value, fast: fastSamples.value };
    any = true;
  }
  if (clickEvents.value.length > 0) {
    next.clicks = clickEvents.value;
    any = true;
  }
  if (scrollEntries.value.length > 0) {
    next.scrolls = scrollEntries.value;
    any = true;
  }

  return any ? next : null;
});

const summaryOpts = computed<MouseTesterOpts>(() => ({
  physicalDistanceCm: distance.value > 0 ? distance.value : 10,
  units: units.value,
}));

const summaryState = computed<SummaryState>(() => {
  const current = report.value;
  if (!current) return { rows: null, error: null };
  try {
    return { rows: summarize(current, summaryOpts.value), error: null };
  } catch (e) {
    return {
      rows: null,
      error: e instanceof ToolError ? e.message : "That report could not be summarized.",
    };
  }
});

const summaryRows = computed<Record<string, string> | null>(() => summaryState.value.rows);
const summaryError = computed<string | null>(() => summaryState.value.error);

/** The same report as JSON, rounded so a long capture stays a sane clipboard payload. */
const reportJson = computed<string>(() => {
  const current = report.value;
  if (!current) return "";
  const compact: MouseReport = { ...current };
  if (Array.isArray(current.moveTimestamps)) {
    compact.moveTimestamps = (current.moveTimestamps as number[]).map(
      (t) => Math.round(t * 1000) / 1000,
    );
  }
  return JSON.stringify(compact);
});

/* ------------------------------------------------------------------ *
 * Polling capture
 * ------------------------------------------------------------------ */

function pushTimestamp(t: number) {
  if (!Number.isFinite(t)) return;
  moveTimestamps.push(t);
  if (moveTimestamps.length > MAX_MOVE_SAMPLES + TRIM_SLACK) {
    moveTimestamps = moveTimestamps.slice(moveTimestamps.length - MAX_MOVE_SAMPLES);
  }
}

function onSurfaceMove(e: PointerEvent) {
  // While the pointer is locked the document level handler owns the samples,
  // so this surface stays out of the way.
  if (lockMode.value !== null) return;

  const coalesced =
    typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : ([] as PointerEvent[]);

  if (coalesced.length > 0) {
    coalescedSupported.value = true;
    for (const sample of coalesced) pushTimestamp(sample.timeStamp);
  } else {
    if (coalescedSupported.value === null) coalescedSupported.value = false;
    pushTimestamp(e.timeStamp);
  }

  lastMoveAt = performance.now();
  ensureLoop();
}

/** The tail of the capture inside the given window, used for the live reading. */
function tailWithin(windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = moveTimestamps.length;
  while (i > 0 && moveTimestamps[i - 1] >= cutoff) i--;
  return moveTimestamps.slice(i);
}

function niceScale(peak: number): number {
  for (const step of GRAPH_SCALE_STEPS) {
    if (peak * 1.15 <= step) return step;
  }
  return GRAPH_SCALE_STEPS[GRAPH_SCALE_STEPS.length - 1];
}

function sizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext("2d");
}

function drawGraph() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const g = sizeCanvas(canvas);
  if (!g) return;

  const { width, height } = canvas;
  const dpr = window.devicePixelRatio || 1;
  const color = getComputedStyle(canvas).color;

  g.clearRect(0, 0, width, height);

  g.strokeStyle = color;
  g.lineWidth = dpr;
  g.globalAlpha = 0.16;
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = Math.round(height * fraction) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke();
  }
  g.globalAlpha = 1;

  if (rateHistory.length < 2) return;

  const now = performance.now();
  const scale = graphMax.value;
  const usable = height - 2 * dpr;

  g.lineWidth = 1.5 * dpr;
  g.beginPath();
  let started = false;
  for (const point of rateHistory) {
    const x = width - ((now - point.t) / GRAPH_SPAN_MS) * width;
    const y = height - dpr - Math.min(1, point.hz / scale) * usable;
    if (started) g.lineTo(x, y);
    else {
      g.moveTo(x, y);
      started = true;
    }
  }
  g.stroke();
}

function tick() {
  frame = requestAnimationFrame(tick);
  const now = performance.now();

  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    const recent = tailWithin(CURRENT_WINDOW_MS, now);
    const hz = recent.length >= MIN_WINDOW_SAMPLES ? pollingRateFromTimestamps(recent).hz : 0;
    currentHz.value = hz;
    if (hz > maxHz.value) maxHz.value = hz;

    rateHistory.push({ t: now, hz });
    const cutoff = now - GRAPH_SPAN_MS;
    while (rateHistory.length > 0 && rateHistory[0].t < cutoff) rateHistory.shift();

    let peak = 0;
    for (const point of rateHistory) if (point.hz > peak) peak = point.hz;
    graphMax.value = niceScale(peak);
  }

  if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
    lastSnapshotAt = now;
    moveSnapshot.value = moveTimestamps.slice();
  }

  drawGraph();

  if (now - lastMoveAt > IDLE_STOP_MS && rateHistory.every((point) => point.hz === 0)) {
    stopLoop();
  }
}

function ensureLoop() {
  if (running) return;
  running = true;
  lastSampleAt = 0;
  lastSnapshotAt = 0;
  frame = requestAnimationFrame(tick);
}

function stopLoop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  running = false;
  currentHz.value = 0;
  // One last snapshot so the average and the summary keep the whole capture
  // after the loop parks itself.
  moveSnapshot.value = moveTimestamps.slice();
  rateHistory = [];
  drawGraph();
}

function resetPolling() {
  moveTimestamps = [];
  rateHistory = [];
  moveSnapshot.value = [];
  currentHz.value = 0;
  maxHz.value = 0;
  graphMax.value = GRAPH_SCALE_STEPS[2];
  drawGraph();
}

/* ------------------------------------------------------------------ *
 * Pointer lock runs: DPI and acceleration
 * ------------------------------------------------------------------ */

const lockPrompt = computed<string | null>(() => {
  if (lockMode.value === "dpi") {
    return `Move the mouse in one straight line, exactly ${distanceText.value} ${units.value === "in" ? "inches" : "centimeters"}, then click or press any key to finish.`;
  }
  if (lockMode.value === "accel-slow") {
    return "Move the mouse slowly across your chosen distance, then click or press any key to finish.";
  }
  if (lockMode.value === "accel-fast") {
    return "Now move the mouse quickly across the same distance, then click or press any key to finish.";
  }
  return null;
});

function startLockRun(mode: LockMode) {
  const el = surfaceEl.value;
  if (!el) return;

  lockError.value = null;
  pendingMode = mode;
  lockCounts = 0;
  lockSamples = [];
  liveCounts.value = 0;
  lockStartedAt = performance.now();
  lockLastAt = lockStartedAt;

  const request = el.requestPointerLock() as unknown;
  if (request instanceof Promise) {
    request.catch(() => {
      pendingMode = null;
      lockError.value =
        "This browser did not grant pointer lock. Click inside the capture area, then start the run again.";
    });
  }
}

function finishLockRun() {
  const mode = lockMode.value;
  lockMode.value = null;
  if (mode === null) return;

  if (mode === "dpi") {
    travelCounts.value = lockCounts;
    computeDpi();
  } else if (mode === "accel-slow") {
    slowSamples.value = lockSamples;
    computeAcceleration();
  } else {
    fastSamples.value = lockSamples;
    computeAcceleration();
  }

  lockSamples = [];
}

function onLockChange() {
  const locked =
    document.pointerLockElement !== null && document.pointerLockElement === surfaceEl.value;
  if (locked) {
    lockMode.value = pendingMode;
    pendingMode = null;
    lockError.value = null;
    lockStartedAt = performance.now();
    lockLastAt = lockStartedAt;
  } else if (lockMode.value !== null) {
    finishLockRun();
  }
}

function onLockMove(e: PointerEvent) {
  if (lockMode.value === null) return;
  const now = performance.now();
  const dt = now - lockLastAt;
  lockLastAt = now;
  lockCounts += e.movementX;
  liveCounts.value = Math.round(Math.abs(lockCounts));
  if (lockMode.value !== "dpi") lockSamples.push({ dt, dx: e.movementX });
}

function onLockPointerDown(e: PointerEvent) {
  if (lockMode.value === null) return;
  e.preventDefault();
  if (performance.now() - lockStartedAt < LOCK_SETTLE_MS) return;
  document.exitPointerLock();
}

function onLockKeyDown(e: KeyboardEvent) {
  if (lockMode.value === null) return;
  // Escape already releases the lock on its own, so leave it to the browser.
  if (e.key === "Escape") return;
  e.preventDefault();
  document.exitPointerLock();
}

function computeDpi() {
  dpiError.value = null;
  dpiResult.value = null;
  const counts = travelCounts.value;
  if (counts === null) return;
  try {
    dpiResult.value = dpiFromTravel({ counts, physicalDistanceInches: distanceInches.value });
  } catch (e) {
    dpiError.value =
      e instanceof ToolError
        ? [e.message, e.fix].filter(Boolean).join(" ")
        : "That run could not be measured.";
  }
}

function computeAcceleration() {
  accelError.value = null;
  accelResult.value = null;
  if (slowSamples.value.length === 0 || fastSamples.value.length === 0) return;
  try {
    accelResult.value = accelerationCheck(slowSamples.value, fastSamples.value);
  } catch (e) {
    accelError.value =
      e instanceof ToolError
        ? [e.message, e.fix].filter(Boolean).join(" ")
        : "Those two runs could not be compared.";
  }
}

function resetDpi() {
  travelCounts.value = null;
  liveCounts.value = 0;
  dpiResult.value = null;
  dpiError.value = null;
}

function resetAcceleration() {
  slowSamples.value = [];
  fastSamples.value = [];
  accelResult.value = null;
  accelError.value = null;
}

watch([distanceText, units], () => {
  if (travelCounts.value !== null) computeDpi();
});

/* ------------------------------------------------------------------ *
 * Click pad
 * ------------------------------------------------------------------ */

function recordClick(type: "down" | "up", button: number, t: number) {
  const next = [...clickEvents.value, { type, button, t }];
  clickEvents.value =
    next.length > MAX_CLICK_EVENTS ? next.slice(next.length - MAX_CLICK_EVENTS) : next;
}

function onPadPointerDown(e: PointerEvent) {
  e.preventDefault();
  recordClick("down", e.button, e.timeStamp);
  if (!downButtons.value.includes(e.button)) {
    downButtons.value = [...downButtons.value, e.button];
  }
}

function onWindowPointerUp(e: PointerEvent) {
  if (!downButtons.value.includes(e.button)) return;
  recordClick("up", e.button, e.timeStamp);
  downButtons.value = downButtons.value.filter((b) => b !== e.button);
}

function resetClicks() {
  clickEvents.value = [];
  downButtons.value = [];
}

/* ------------------------------------------------------------------ *
 * Wheel pad
 * ------------------------------------------------------------------ */

function onWheel(e: WheelEvent) {
  scrollSeq += 1;
  const next = [
    ...scrollEntries.value,
    { id: scrollSeq, deltaY: e.deltaY, deltaMode: e.deltaMode },
  ];
  scrollEntries.value =
    next.length > MAX_SCROLL_EVENTS ? next.slice(next.length - MAX_SCROLL_EVENTS) : next;
}

function resetScroll() {
  scrollEntries.value = [];
  scrollSeq = 0;
}

/* ------------------------------------------------------------------ *
 * Whole panel
 * ------------------------------------------------------------------ */

function resetAll() {
  resetPolling();
  resetDpi();
  resetAcceleration();
  resetClicks();
  resetScroll();
  lockError.value = null;
}

function setUnits(value: "cm" | "in") {
  units.value = value;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function onResize() {
  drawGraph();
}

onMounted(() => {
  const spec = props.meta.options?.find(
    (o) => o.kind === "number" && o.id === "physicalDistanceCm",
  );
  if (spec && spec.kind === "number") distanceText.value = String(spec.default);

  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("pointermove", onLockMove);
  document.addEventListener("pointerdown", onLockPointerDown);
  document.addEventListener("keydown", onLockKeyDown);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("resize", onResize);

  drawGraph();
});

onUnmounted(() => {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  running = false;

  document.removeEventListener("pointerlockchange", onLockChange);
  document.removeEventListener("pointermove", onLockMove);
  document.removeEventListener("pointerdown", onLockPointerDown);
  document.removeEventListener("keydown", onLockKeyDown);
  window.removeEventListener("pointerup", onWindowPointerUp);
  window.removeEventListener("resize", onResize);

  if (document.pointerLockElement) document.exitPointerLock();
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="max-w-[68ch] text-xs text-muted-foreground">
        Every reading here is measured from real pointer events in this tab: your files and inputs
        never leave your device.
      </p>
      <Button variant="ghost" size="sm" @click="resetAll">
        <RotateCcw class="size-3.5" aria-hidden="true" />
        Reset everything
      </Button>
    </div>

    <!-- Capture surface, polling rate, and the pointer lock runs -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Capture surface
        </span>
        <Button variant="ghost" size="sm" @click="resetPolling">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset polling
        </Button>
      </div>

      <div
        ref="surfaceEl"
        class="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-[10px] bg-secondary p-6 text-center shadow-[var(--sh-inset)]"
        :class="lockMode !== null ? 'ring-2 ring-ring' : ''"
        @pointermove="onSurfaceMove"
        @contextmenu.prevent
      >
        <Crosshair v-if="lockPrompt" class="size-5 text-primary" aria-hidden="true" />
        <Gauge v-else class="size-5 text-muted-foreground" aria-hidden="true" />

        <!-- Only this line changes on a state transition, so it is the live region.
             The counts readout updates on every pointer sample, which would flood a
             screen reader, so it stays out of it. -->
        <p class="max-w-[52ch] text-sm" aria-live="polite">
          {{ lockPrompt ?? "Move the mouse across this area for about five seconds." }}
        </p>

        <template v-if="lockPrompt">
          <p class="font-mono text-3xl tabular-nums" aria-hidden="true">{{ liveCounts }}</p>
          <p class="text-xs text-muted-foreground" aria-hidden="true">counts so far</p>
        </template>
        <p v-else class="max-w-[52ch] text-xs text-muted-foreground">
          Keep moving steadily, without lifting the mouse. The DPI and acceleration runs below lock
          the pointer to this same area.
        </p>
      </div>

      <ErrorBanner v-if="lockError" :message="lockError" />

      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Live rate
          </span>
          <span class="font-mono text-xs text-muted-foreground tabular-nums">
            0 to {{ graphMax }} Hz, last {{ GRAPH_SPAN_MS / 1000 }} seconds
          </span>
        </div>
        <canvas
          ref="canvasEl"
          class="h-28 w-full rounded-[10px] bg-secondary text-primary shadow-[var(--sh-inset)]"
          aria-hidden="true"
        />
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Current</div>
          <div class="font-mono text-lg tabular-nums">{{ Math.round(currentHz) }} Hz</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Average</div>
          <div class="font-mono text-lg tabular-nums">{{ Math.round(pollingResult.hz) }} Hz</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Peak</div>
          <div class="font-mono text-lg tabular-nums">{{ Math.round(maxHz) }} Hz</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Reads as</div>
          <div class="font-mono text-lg">{{ pollingResult.classification }}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Median interval</div>
          <div class="font-mono text-sm tabular-nums">{{ pollingResult.median }} ms</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">95th percentile</div>
          <div class="font-mono text-sm tabular-nums">{{ pollingResult.p95intervalMs }} ms</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Jitter</div>
          <div class="font-mono text-sm tabular-nums">{{ pollingResult.jitterMs }} ms</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Samples</div>
          <div class="font-mono text-sm tabular-nums">{{ pollingResult.samples }}</div>
        </div>
      </div>

      <p v-if="coalescedSupported === false" class="text-xs text-muted-foreground">
        This browser does not expose getCoalescedEvents on pointer events, so the reading is capped
        at the rate the browser delivers pointermove, often the display refresh rate. A Chromium
        browser will recover the individual hardware samples.
      </p>
    </section>

    <!-- DPI -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          DPI test
        </span>
        <Button variant="ghost" size="sm" @click="resetDpi">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset DPI
        </Button>
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <div class="flex w-32 flex-col gap-1.5">
          <Label for="mt-distance" class="text-xs text-muted-foreground">Distance</Label>
          <Input
            id="mt-distance"
            v-model="distanceText"
            type="number"
            min="0.5"
            max="60"
            step="0.1"
            class="bg-card"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Units</span>
          <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="units === 'cm'"
              :class="units === 'cm' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="setUnits('cm')"
            >
              Centimeters
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="units === 'in'"
              :class="units === 'in' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="setUnits('in')"
            >
              Inches
            </Button>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          :disabled="lockMode !== null || distance <= 0"
          @click="startLockRun('dpi')"
        >
          <Crosshair class="size-3.5" aria-hidden="true" />
          Lock pointer and start DPI run
        </Button>
      </div>

      <p class="max-w-[68ch] text-xs text-muted-foreground">
        Measure the distance on your desk or mousepad with a ruler first. Starting the run locks the
        pointer to the capture area, which is what makes the browser report raw sensor counts
        instead of scaled screen pixels. Click or press any key when you have finished the move.
      </p>

      <p v-if="distance <= 0" class="text-xs text-destructive">
        Enter a positive distance before starting the run.
      </p>

      <ErrorBanner v-if="dpiError" :message="dpiError" />

      <div v-else-if="dpiResult" class="flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Measured DPI</div>
            <div class="font-mono text-lg tabular-nums">{{ dpiResult.dpi }}</div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Nearest common DPI</div>
            <div class="font-mono text-lg tabular-nums">{{ dpiResult.nearestCommonDpi }}</div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Counts recorded</div>
            <div class="font-mono text-lg tabular-nums">
              {{ travelCounts === null ? 0 : Math.abs(Math.round(travelCounts)) }}
            </div>
          </div>
        </div>
        <p class="max-w-[68ch] text-xs text-muted-foreground">{{ dpiResult.note }}</p>
      </div>
    </section>

    <!-- Acceleration -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Acceleration check
        </span>
        <Button variant="ghost" size="sm" @click="resetAcceleration">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset runs
        </Button>
      </div>

      <p class="max-w-[68ch] text-xs text-muted-foreground">
        Move the mouse across the same physical distance twice, once slowly and once quickly.
        Without acceleration both runs report about the same number of counts, because counts track
        distance rather than speed.
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="lockMode !== null"
          @click="startLockRun('accel-slow')"
        >
          {{ slowSamples.length > 0 ? "Redo slow sweep" : "Record slow sweep" }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="lockMode !== null"
          @click="startLockRun('accel-fast')"
        >
          {{ fastSamples.length > 0 ? "Redo fast sweep" : "Record fast sweep" }}
        </Button>
        <span class="font-mono text-xs text-muted-foreground tabular-nums">
          slow {{ slowSamples.length }} samples, fast {{ fastSamples.length }} samples
        </span>
      </div>

      <ErrorBanner v-if="accelError" :message="accelError" />

      <div v-else-if="accelResult" class="flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Verdict</div>
            <div class="font-mono text-lg capitalize">{{ accelResult.verdict }}</div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Slow counts</div>
            <div class="font-mono text-lg tabular-nums">{{ accelResult.slowCounts }}</div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Fast counts</div>
            <div class="font-mono text-lg tabular-nums">{{ accelResult.fastCounts }}</div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Fast over slow</div>
            <div class="font-mono text-lg tabular-nums">{{ accelResult.ratio }}</div>
          </div>
        </div>
        <p class="max-w-[68ch] text-xs text-muted-foreground">{{ accelExplanation }}</p>
      </div>
    </section>

    <!-- Clicks -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Click test
        </span>
        <Button variant="ghost" size="sm" @click="resetClicks">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset clicks
        </Button>
      </div>

      <div
        class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        role="group"
        aria-label="Click test pad"
        @pointerdown="onPadPointerDown"
        @auxclick.prevent
        @contextmenu.prevent
      >
        <div class="grid grid-cols-3 gap-2">
          <div
            v-for="cell in buttonCells"
            :key="cell.button"
            class="flex min-h-[92px] flex-col items-center justify-center gap-1 rounded-[8px] border p-3 text-center transition-colors"
            :class="
              cell.active
                ? 'border-ring bg-[image:var(--grad-brand-soft)]'
                : 'bg-card hover:border-[color:var(--brand-hairline)]'
            "
          >
            <MousePointerClick class="size-4 text-muted-foreground" aria-hidden="true" />
            <span class="text-sm font-medium">{{ cell.name }}</span>
            <span class="font-mono text-xs text-muted-foreground tabular-nums">
              {{ cell.downs }} down / {{ cell.ups }} up
            </span>
            <span
              v-if="cell.avgHeldMs !== null"
              class="font-mono text-xs text-muted-foreground tabular-nums"
            >
              held ~{{ cell.avgHeldMs }} ms
            </span>
          </div>
        </div>
        <p class="mt-2 text-center text-xs text-muted-foreground">
          Click anywhere in this pad with each button. The right button menu is suppressed here.
        </p>
      </div>

      <div v-if="extraButtons.length" class="flex flex-wrap gap-2">
        <span
          v-for="extra in extraButtons"
          :key="extra.name"
          class="rounded-[8px] border bg-secondary px-3 py-1.5 font-mono text-xs tabular-nums"
        >
          {{ extra.name }}: {{ extra.downs }} down / {{ extra.ups }} up
        </span>
      </div>

      <div class="grid gap-2 sm:grid-cols-2">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Double clicks</div>
          <div class="font-mono text-sm break-words">
            {{
              clickResult.doubleClicks.length
                ? clickResult.doubleClicks.map((d) => `${d.button} (${d.intervalMs} ms)`).join(", ")
                : "none detected"
            }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Switch bounce</div>
          <div
            class="font-mono text-sm break-words"
            :class="clickResult.bounces.length ? 'text-destructive' : ''"
          >
            {{
              clickResult.bounces.length
                ? clickResult.bounces.map((b) => `${b.button} (${b.intervalMs} ms)`).join(", ")
                : "none detected"
            }}
          </div>
        </div>
      </div>

      <p v-if="clickResult.bounces.length" class="max-w-[68ch] text-xs text-muted-foreground">
        Two presses landed closer together than a person can click on purpose. That is the signature
        of a worn switch registering one physical press twice, often called chatter or double
        clicking.
      </p>
    </section>

    <!-- Scroll -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Scroll test
        </span>
        <Button variant="ghost" size="sm" @click="resetScroll">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset scroll
        </Button>
      </div>

      <div
        class="flex min-h-[120px] flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        role="group"
        aria-label="Scroll test pad"
        @wheel.prevent="onWheel"
        @contextmenu.prevent
      >
        <p v-if="scrollLog.length === 0" class="my-auto text-center text-sm text-muted-foreground">
          Roll the wheel over this area. The page will not scroll while you do.
        </p>
        <div
          v-for="entry in scrollLog"
          :key="entry.id"
          class="flex items-center justify-between gap-3 rounded-[8px] bg-card px-3 py-1.5 font-mono text-xs tabular-nums"
        >
          <span>deltaY {{ entry.deltaY }}</span>
          <span class="text-muted-foreground">deltaMode {{ entry.deltaMode }}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Wheel events</div>
          <div class="font-mono text-sm tabular-nums">{{ scrollResult.events }}</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Delta mode</div>
          <div class="font-mono text-sm">
            {{
              scrollResult.deltaModeConsistent
                ? scrollResult.deltaModeLabel
                : `mixed (not consistently ${scrollResult.deltaModeLabel})`
            }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Notch size</div>
          <div class="font-mono text-sm">{{ notchDescription ?? "no notches detected" }}</div>
        </div>
      </div>

      <p
        v-if="scrollResult.events > 0 && scrollResult.deltaModeLabel === 'pixel'"
        class="max-w-[68ch] text-xs text-muted-foreground"
      >
        This browser reports wheel deltas in pixels, so one notch cannot be expressed as a count of
        lines. Browsers that report in lines show the line count here instead.
      </p>
    </section>

    <!-- Summary -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Summary
        </span>
        <CopyButton v-if="reportJson" :text="reportJson" label="Copy report JSON" />
      </div>

      <ErrorBanner v-if="summaryError" :message="summaryError" />

      <OutputView v-else-if="summaryRows" :output="summaryRows" />

      <p v-else class="text-xs text-muted-foreground">
        Run any of the tests above and the full breakdown appears here, ready to copy.
      </p>
    </section>
  </div>
</template>
