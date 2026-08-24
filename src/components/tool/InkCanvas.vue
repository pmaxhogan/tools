<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from "vue";
import type { InkPoint, Stroke, SvgOptions } from "@/tools/handwriting-pad/index";

/**
 * A reusable pressure aware ink surface.
 *
 * Two tools draw on the same surface: the Handwriting Pad, and the PDF
 * Toolbox's Sign tab. Rather than each growing its own canvas, both mount
 * this component and talk to it through the methods below.
 *
 * What lives here is the parts that genuinely need the DOM: pointer capture,
 * coalesced sample collection, the high DPI backing store, and painting.
 * The math a drawing needs when it leaves the screen (simplification, curve
 * resampling, bounds, SVG path building, the save format) lives in
 * src/tools/handwriting-pad/index.ts where it is pure and unit tested.
 *
 * That module is reached with a dynamic import inside `toSvg`, and nowhere
 * else, so a panel that only draws and exports a PNG never pulls a second
 * tool into its chunk (PROJECT.md rule 13). The one thing mirrored rather
 * than imported is the pressure to width curve, because live painting needs
 * it on every frame; the constants below are copied from that module, and its
 * tests are what lock them.
 *
 * Curves: the canvas is painted with the same midpoint quadratic scheme the
 * logic layer resamples for SVG. Here the browser evaluates the curve through
 * `quadraticCurveTo`, and each section is stroked as its own path so the width
 * can change along the line, which is the only way either canvas or SVG can
 * taper a stroke.
 */

const props = withDefaults(
  defineProps<{
    /** Any CSS length for the surface. Default fills its container. */
    width?: string;
    /** Any CSS length. Leave as "auto" and set `aspectRatio` to size by shape. */
    height?: string;
    /** CSS aspect-ratio, e.g. "4 / 3". Only used when height is "auto". */
    aspectRatio?: string;
    /** Ink color for new strokes. Existing strokes keep the color they were drawn in. */
    color?: string;
    /** Stroke width at neutral pressure, in CSS pixels. */
    baseWidth?: number;
    /** "transparent" leaves the exported PNG's background clear. */
    background?: string;
    /** Paper printed behind the ink. A guide only: it never lands in an export. */
    guides?: "none" | "lines" | "signature";
    /** Let pen pressure change the stroke width. Off draws a perfectly even line. */
    pressure?: boolean;
    /** Accessible name for the drawing surface. */
    label?: string;
    /** Sentence under the pad explaining what drawing needs. Empty hides it. */
    note?: string;
    disabled?: boolean;
  }>(),
  {
    width: "100%",
    height: "auto",
    aspectRatio: "4 / 3",
    color: "#1b1917",
    baseWidth: 3,
    background: "transparent",
    guides: "none",
    pressure: true,
    label: "Drawing surface",
    note: "Draw with a stylus, a finger, a trackpad, or a mouse. The pad itself needs a pointer, so the buttons around it do everything else: focus the pad and press Ctrl+Z to undo the last stroke, or Escape to abandon the stroke in progress.",
    disabled: false,
  },
);

const emit = defineEmits<{
  /** A new stroke has begun. */
  "stroke-start": [];
  /** A stroke finished, with the points as drawn. */
  stroke: [stroke: Stroke];
  /** The set of finished strokes changed, for any reason. */
  change: [strokes: Stroke[]];
}>();

/* ---------------------------------------------------------------- */
/* the pressure curve (mirrored from the logic layer)                */
/* ---------------------------------------------------------------- */

const MIN_PRESSURE_SCALE = 0.5;
const MAX_PRESSURE_SCALE = 1.8;
const NEUTRAL_PRESSURE = 0.5;

function pressureScale(pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : NEUTRAL_PRESSURE;
  if (p <= NEUTRAL_PRESSURE) {
    return MIN_PRESSURE_SCALE + ((1 - MIN_PRESSURE_SCALE) * p) / NEUTRAL_PRESSURE;
  }
  return 1 + ((MAX_PRESSURE_SCALE - 1) * (p - NEUTRAL_PRESSURE)) / (1 - NEUTRAL_PRESSURE);
}

function widthBetween(stroke: Stroke, a: InkPoint, b: InkPoint): number {
  const base = stroke.baseWidth > 0 ? stroke.baseWidth : 1;
  return props.pressure ? base * pressureScale((a.p + b.p) / 2) : base;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** Spacing of the ruled paper guide, in CSS pixels. */
const LINE_GAP = 32;
/** Samples closer together than this add nothing but file size. */
const MIN_SAMPLE_DISTANCE = 0.4;
/** More backing pixels than this buys nothing and costs a lot of memory. */
const MAX_DPR = 3;

const noteId = `ink-note-${useId()}`;
const frame = ref<HTMLDivElement>();
const canvasRef = ref<HTMLCanvasElement>();

// Shallow on purpose: a minute of writing is tens of thousands of points, and
// proxying every one of them so Vue can watch a number nobody reads would cost
// more than the drawing does. The array is always replaced, never mutated.
const finished = shallowRef<Stroke[]>([]);
/**
 * The stroke under the pointer. Deliberately not reactive: it grows by a
 * handful of points per frame, and re-rendering the component for each one
 * would cost more than the painting does.
 */
let live: Stroke | null = null;
let livePointer: number | null = null;
/** How many sections of the live stroke are already on the canvas. */
let liveDrawn = 0;

const cssWidth = ref(0);
const cssHeight = ref(0);
let dpr = 1;
let observer: ResizeObserver | null = null;

const frameStyle = computed(() => ({
  width: props.width,
  height: props.height,
  aspectRatio: props.height === "auto" ? props.aspectRatio : undefined,
  background: props.background === "transparent" ? undefined : props.background,
}));

const lineStyle = computed(() => ({
  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${LINE_GAP - 1}px, var(--border) ${LINE_GAP - 1}px, var(--border) ${LINE_GAP}px)`,
}));

function allStrokes(): Stroke[] {
  return live ? [...finished.value, live] : finished.value;
}

/* ---------------------------------------------------------------- */
/* painting                                                          */
/* ---------------------------------------------------------------- */

function mid(a: InkPoint, b: InkPoint): InkPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 };
}

function line(ctx: CanvasRenderingContext2D, a: InkPoint, b: InkPoint, w: number) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/**
 * Paint sections `from` onward of one stroke.
 *
 * A stroke of n points has n sections: a straight lead in from the first
 * sample to the first midpoint, one quadratic per interior sample, and a
 * straight lead out from the last midpoint to the final sample. Splitting it
 * this way means the sections before the newest sample never change, so live
 * drawing can paint only the new ones and a full redraw can paint all of them
 * through the same code and get identical pixels.
 */
function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, from = 0, to = Infinity) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (pts.length === 1) {
    if (from > 0) return;
    const only = pts[0]!;
    const radius = Math.max(widthBetween(stroke, only, only) / 2, 0.4);
    ctx.beginPath();
    ctx.arc(only.x, only.y, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const last = pts.length - 1;
  const stop = Math.min(to, last);
  let anchor = mid(pts[0]!, pts[1]!);
  for (let i = 0; i <= stop; i += 1) {
    if (i === 0) {
      if (i >= from) line(ctx, pts[0]!, anchor, widthBetween(stroke, pts[0]!, pts[1]!));
      continue;
    }
    if (i === last) {
      if (i >= from)
        line(ctx, anchor, pts[last]!, widthBetween(stroke, pts[last - 1]!, pts[last]!));
      continue;
    }
    const control = pts[i]!;
    const end = mid(control, pts[i + 1]!);
    if (i >= from) {
      ctx.lineWidth = widthBetween(stroke, control, pts[i + 1]!);
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      ctx.stroke();
    }
    anchor = end;
  }
}

function context(): CanvasRenderingContext2D | null {
  return canvasRef.value?.getContext("2d") ?? null;
}

function redraw() {
  const ctx = context();
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth.value, cssHeight.value);
  if (props.background && props.background !== "transparent") {
    ctx.fillStyle = props.background;
    ctx.fillRect(0, 0, cssWidth.value, cssHeight.value);
  }
  for (const stroke of finished.value) paintStroke(ctx, stroke);
  if (live) paintStroke(ctx, live);
  liveDrawn = live ? Math.max(live.points.length - 1, 0) : 0;
}

/** Paint only the sections of the live stroke that are not on the canvas yet. */
function paintLiveTail() {
  const ctx = context();
  if (!ctx || !live) return;
  const sections = live.points.length - 1;
  if (sections <= liveDrawn) return;
  paintStroke(ctx, live, liveDrawn, sections - 1);
  liveDrawn = sections;
}

/* ---------------------------------------------------------------- */
/* sizing                                                            */
/* ---------------------------------------------------------------- */

function resize() {
  const el = frame.value;
  const canvas = canvasRef.value;
  if (!el || !canvas) return;
  const rect = el.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
  cssWidth.value = w;
  cssHeight.value = h;
  const backingW = Math.round(w * dpr);
  const backingH = Math.round(h * dpr);
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  redraw();
}

/* ---------------------------------------------------------------- */
/* pointer input                                                     */
/* ---------------------------------------------------------------- */

/**
 * Every sample the browser has for this move.
 *
 * Browsers batch pointer moves to one per frame and hand the rest over
 * through `getCoalescedEvents`. Reading them is the difference between a
 * 120 Hz pen recording 120 points a second and 60. Safari has shipped
 * without the method, so it is feature detected rather than assumed.
 */
function samplesOf(e: PointerEvent): PointerEvent[] {
  if (typeof e.getCoalescedEvents === "function") {
    const list = e.getCoalescedEvents();
    if (list.length > 0) return list;
  }
  return [e];
}

/**
 * Pressure a device actually measured, or the neutral value.
 *
 * A mouse reports 0 while hovering and exactly 0.5 while a button is down,
 * and a trackpad without force sensing does the same, so neither carries
 * information. Recording those as neutral draws them at the width the user
 * picked instead of inventing a taper out of nothing.
 */
function pressureOf(e: PointerEvent): number {
  if (!props.pressure || e.pointerType === "mouse") return NEUTRAL_PRESSURE;
  const raw = e.pressure;
  if (!Number.isFinite(raw) || raw === 0 || raw === 0.5) return NEUTRAL_PRESSURE;
  return Math.min(1, Math.max(0, raw));
}

function pointOf(e: PointerEvent, rect: DOMRect): InkPoint {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: pressureOf(e) };
}

function appendPoint(p: InkPoint): boolean {
  if (!live) return false;
  const previous = live.points[live.points.length - 1];
  if (previous && Math.hypot(p.x - previous.x, p.y - previous.y) < MIN_SAMPLE_DISTANCE) {
    return false;
  }
  live.points.push(p);
  return true;
}

function onPointerDown(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (!canvas || props.disabled || live) return;
  // Primary button only: a right click belongs to the context menu.
  if (e.button !== 0) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  canvas.focus({ preventScroll: true });
  livePointer = e.pointerId;
  live = {
    points: [pointOf(e, canvas.getBoundingClientRect())],
    color: props.color,
    baseWidth: props.baseWidth,
  };
  liveDrawn = 0;
  const ctx = context();
  // A tap that never moves still leaves a dot, so paint it now.
  if (ctx) paintStroke(ctx, live);
  emit("stroke-start");
}

function onPointerMove(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (!canvas || !live || e.pointerId !== livePointer) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  let added = false;
  for (const sample of samplesOf(e)) {
    if (appendPoint(pointOf(sample, rect))) added = true;
  }
  if (!added) return;
  paintLiveTail();
}

function finishStroke() {
  if (!live) return;
  const stroke = live;
  live = null;
  livePointer = null;
  liveDrawn = 0;
  finished.value = [...finished.value, stroke];
  redraw();
  emit("stroke", stroke);
  emit("change", finished.value);
}

function onPointerUp(e: PointerEvent) {
  if (!live || e.pointerId !== livePointer) return;
  const canvas = canvasRef.value;
  if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  finishStroke();
}

function cancelStroke() {
  if (!live) return;
  live = null;
  livePointer = null;
  liveDrawn = 0;
  redraw();
}

function onPointerCancel(e: PointerEvent) {
  if (e.pointerId !== livePointer) return;
  cancelStroke();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && live) {
    e.preventDefault();
    cancelStroke();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
}

/* ---------------------------------------------------------------- */
/* the public surface                                                */
/* ---------------------------------------------------------------- */

function clear() {
  live = null;
  livePointer = null;
  liveDrawn = 0;
  finished.value = [];
  redraw();
  emit("change", finished.value);
}

function undo() {
  if (live) {
    cancelStroke();
    return;
  }
  if (finished.value.length === 0) return;
  finished.value = finished.value.slice(0, -1);
  redraw();
  emit("change", finished.value);
}

function isEmpty(): boolean {
  return allStrokes().every((stroke) => stroke.points.length === 0);
}

/**
 * The finished strokes, deep copied. A stroke still under the pointer is not
 * included, unlike `toSvg` and `toPngBlob`, which export what is on screen.
 */
function getStrokes(): Stroke[] {
  return finished.value.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((q) => ({ ...q })),
  }));
}

function setStrokes(strokes: Stroke[]) {
  live = null;
  livePointer = null;
  liveDrawn = 0;
  finished.value = (strokes ?? []).map((stroke) => ({
    ...stroke,
    points: (stroke.points ?? []).map((q) => ({ ...q })),
  }));
  redraw();
  emit("change", finished.value);
}

/**
 * Build a standalone SVG of the drawing.
 *
 * The only place this component reaches into a tool, and it does so at call
 * time so the module never lands in the chunk of a panel that does not export
 * vectors.
 */
async function toSvg(options: SvgOptions = {}): Promise<string> {
  const ink = await import("@/tools/handwriting-pad/index");
  return ink.strokesToSvg(allStrokes(), {
    background: props.background,
    pressure: props.pressure,
    ...options,
  });
}

/**
 * Render the ink to a PNG at `scale` times the surface's CSS size.
 *
 * Drawn fresh rather than copied off the visible canvas, so the export is
 * crisp at any scale, is unaffected by the display's pixel ratio, and never
 * picks up the paper guides, which are CSS behind the canvas rather than
 * pixels in it.
 */
async function toPngBlob(scale = 1): Promise<Blob | null> {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const w = Math.max(1, Math.round(cssWidth.value * factor));
  const h = Math.max(1, Math.round(cssHeight.value * factor));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  if (props.background && props.background !== "transparent") {
    ctx.fillStyle = props.background;
    ctx.fillRect(0, 0, cssWidth.value, cssHeight.value);
  }
  for (const stroke of allStrokes()) paintStroke(ctx, stroke);
  return new Promise<Blob | null>((resolve) => off.toBlob(resolve, "image/png"));
}

defineExpose({ clear, undo, isEmpty, toSvg, toPngBlob, getStrokes, setStrokes });

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

// Everything that reads the window is inside onMounted, so this component is
// safe to render on the server: the markup exists, the canvas stays blank
// until it is hydrated.
onMounted(() => {
  resize();
  if (typeof ResizeObserver !== "undefined" && frame.value) {
    observer = new ResizeObserver(() => resize());
    observer.observe(frame.value);
  }
  window.addEventListener("resize", resize);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  window.removeEventListener("resize", resize);
});

// Paper color and the pressure response change what is already on screen.
watch(() => [props.background, props.pressure], redraw);
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      ref="frame"
      class="relative overflow-hidden rounded-[10px] bg-secondary shadow-[var(--sh-inset)] focus-within:ring-3 focus-within:ring-ring/50"
      :style="frameStyle"
    >
      <!-- Paper. A guide only: it is CSS, so it never reaches an export. -->
      <div
        v-if="guides === 'lines'"
        class="pointer-events-none absolute inset-0"
        :style="lineStyle"
        aria-hidden="true"
      />
      <template v-else-if="guides === 'signature'">
        <div
          class="pointer-events-none absolute right-5 left-5 border-t border-dashed border-input"
          style="top: 72%"
          aria-hidden="true"
        />
        <span
          class="pointer-events-none absolute font-mono text-sm text-muted-foreground select-none"
          style="left: 1rem; top: 72%; transform: translateY(-115%)"
          aria-hidden="true"
        >
          x
        </span>
      </template>

      <canvas
        ref="canvasRef"
        tabindex="0"
        class="absolute inset-0 h-full w-full cursor-crosshair touch-none outline-none"
        :class="disabled ? 'cursor-not-allowed opacity-60' : ''"
        :aria-label="label"
        :aria-describedby="note ? noteId : undefined"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @lostpointercapture="onPointerUp"
        @keydown="onKeyDown"
      />
    </div>

    <p v-if="note" :id="noteId" class="text-xs text-muted-foreground">
      {{ note }}
    </p>
  </div>
</template>
