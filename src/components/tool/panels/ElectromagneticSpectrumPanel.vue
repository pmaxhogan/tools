<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import {
  AXIS_DECADES,
  BANDS,
  VISIBLE_MAX_NM,
  VISIBLE_MIN_NM,
  describeFrequency,
  flattenBands,
  formatEnergyEv,
  formatFrequency,
  formatKelvin,
  formatWavelength,
  frequencyToPosition,
  maxDepth,
  parseJump,
  positionToFrequency,
  rgbToHex,
  wavelengthNmToRgb,
  type Readout,
} from "@/tools/electromagnetic-spectrum/index";
import { Button } from "@/components/ui/button";
import CopyButton from "../CopyButton.vue";
import { Download, Link as LinkIcon, Check, Search, Maximize2, Minimize2 } from "lucide-vue-next";

/**
 * Bespoke panel for the Electromagnetic Spectrum explorer.
 *
 * All physics, the log10 position mapping, the band lookup and the jump parser
 * live in the pure logic layer. This panel owns only presentation: the canvas
 * renderer, pointer and keyboard interaction (zoom, pan, scrub), the floating
 * readout tooltip, PNG and SVG export, and the shareable URL fragment.
 *
 * Fragment schema: f = center frequency in hertz, d = decades visible,
 * q = optional pinned/scrubbed frequency in hertz.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ */
/* Constants and refs                                                  */
/* ------------------------------------------------------------------ */

const ROWS = maxDepth(BANDS) + 1;
const FLAT = flattenBands(BANDS);
/** Narrowest allowed view span, normalized. ~0.036 decade, below FM width. */
const MIN_SPAN = 0.0015;

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const readoutCardRef = ref<HTMLDivElement | null>(null);

const isFullscreen = ref(false);

const orientation = ref<"horizontal" | "vertical">("horizontal");
const cssW = ref(800);
const cssH = ref(320);

// View: center (0..1 along the axis) and span (fraction of the full axis).
const center = ref(0.5);
const span = ref(1);

const hoverFreq = ref<number | null>(null);
const pinnedFreq = ref<number | null>(null);
const pointerPx = ref<{ x: number; y: number } | null>(null);

const jumpText = ref("");
const jumpError = ref("");
const linkCopied = ref(false);

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

/** Parse "#rrggbb" (or shorthand) to an rgba() string with the given alpha. */
function withAlpha(hex: string, a: number): string {
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

/* ------------------------------------------------------------------ */
/* View math                                                           */
/* ------------------------------------------------------------------ */

function clampView() {
  span.value = Math.min(1, Math.max(MIN_SPAN, span.value));
  const half = span.value / 2;
  center.value = Math.min(1 - half, Math.max(half, center.value));
}

const v0 = () => center.value - span.value / 2;

/** Axis length in CSS pixels (the long dimension). */
function axisLength(): number {
  return orientation.value === "horizontal" ? cssW.value : cssH.value;
}

/** Normalized axis position (0..1 full range) to a pixel along the axis. */
function posToAxisPx(pos: number): number {
  return ((pos - v0()) / span.value) * axisLength();
}

/** Inverse: an axis pixel to a frequency in hertz. */
function axisPxToFreq(px: number): number {
  const pos = v0() + (px / axisLength()) * span.value;
  return positionToFrequency(pos);
}

/** The axis pixel for a given frequency, in the current view. */
function freqToAxisPx(freqHz: number): number {
  return posToAxisPx(frequencyToPosition(freqHz));
}

/** Pointer event offset to the axis coordinate for the current orientation. */
function eventAxisPx(e: PointerEvent): number {
  const rect = canvasRef.value!.getBoundingClientRect();
  return orientation.value === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top;
}

/* ------------------------------------------------------------------ */
/* Scene building (shared by canvas, PNG and SVG)                      */
/* ------------------------------------------------------------------ */

interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  /** Present for the visible band: a spectral gradient vector and stops. */
  spectral?: { x1: number; y1: number; x2: number; y2: number };
}
interface SceneText {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  align: "center" | "start";
  plate?: { x: number; y: number; w: number; h: number };
}
interface SceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dash: boolean;
  width: number;
}
interface Scene {
  rects: SceneRect[];
  lines: SceneLine[];
  texts: SceneText[];
  w: number;
  h: number;
}

const TICK_MARGIN_H = 26;
const TICK_MARGIN_V = 58;

/** Approximate whether a label fits, truncating with an ellipsis if needed. */
function fitLabel(text: string, maxPx: number, size: number): string | null {
  const charPx = size * 0.58;
  const maxChars = Math.floor((maxPx - 6) / charPx);
  if (maxChars >= text.length) return text;
  if (maxChars < 3) return null;
  return text.slice(0, maxChars - 1) + "…";
}

function buildScene(w: number, h: number): Scene {
  const horizontal = orientation.value === "horizontal";
  const L = horizontal ? w : h;
  const tickMargin = horizontal ? TICK_MARGIN_H : TICK_MARGIN_V;
  const lanesExtent = (horizontal ? h : w) - tickMargin;
  const laneSize = lanesExtent / ROWS;

  const rects: SceneRect[] = [];
  const texts: SceneText[] = [];
  const lines: SceneLine[] = [];

  // Lane origin along the cross axis. Ticks sit after the lanes.
  const laneBase = horizontal ? 0 : tickMargin;

  for (const { band, depth } of FLAT) {
    const a0 = posToAxisPx(frequencyToPosition(band.fHigh)); // start (high freq)
    const a1 = posToAxisPx(frequencyToPosition(band.fLow)); // end (low freq)
    if (a1 < 0 || a0 > L) continue;
    const s0 = Math.max(0, a0);
    const s1 = Math.min(L, a1);
    const wpx = s1 - s0;
    if (wpx < 0.5) continue;

    const laneOff = laneBase + depth * laneSize;
    const rx = horizontal ? s0 : laneOff;
    const ry = horizontal ? laneOff : s0;
    const rw = horizontal ? wpx : laneSize;
    const rh = horizontal ? laneSize : wpx;

    const isVisible = band.id === "visible";
    let fill: string;
    let colored = false;
    if (band.color) {
      fill = band.color;
      colored = true;
    } else if (depth === 0) fill = colors.card;
    else if (depth === 1) fill = colors.surface;
    else fill = colors.accentSoft;

    const rect: SceneRect = { x: rx, y: ry, w: rw, h: rh, fill, stroke: colors.border };
    if (isVisible) {
      // Spectral gradient runs violet (start, high freq) to red (end, low freq).
      rect.spectral = horizontal
        ? { x1: a0, y1: 0, x2: a1, y2: 0 }
        : { x1: 0, y1: a0, x2: 0, y2: a1 };
    }
    rects.push(rect);

    // Label, centered, skipped when it cannot fit.
    const size = depth === 0 ? 13 : 11;
    const maxPx = horizontal ? wpx : laneSize;
    const label = fitLabel(band.name, maxPx, size);
    if (label && (horizontal ? wpx : rh) > size * 1.4) {
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      const needPlate = isVisible || colored;
      const textW = label.length * size * 0.58;
      texts.push({
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
  const lowFreq = axisPxToFreq(L);
  const highFreq = axisPxToFreq(0);
  const decadesInView = Math.log10(highFreq / lowFreq);
  const mantissas = decadesInView < 6 ? [1, 2, 5] : [1];
  const kMin = Math.floor(Math.log10(lowFreq));
  const kMax = Math.ceil(Math.log10(highFreq));
  const tickColor = colors.border;
  for (let k = kMin; k <= kMax; k++) {
    for (const mant of mantissas) {
      const f = mant * Math.pow(10, k);
      if (f < lowFreq * 0.999 || f > highFreq * 1.001) continue;
      const apx = posToAxisPx(frequencyToPosition(f));
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

  // Pinned marker (dashed) and the live cursor (solid).
  const marker = (freq: number, color: string, dash: boolean) => {
    const apx = posToAxisPx(frequencyToPosition(freq));
    if (apx < -1 || apx > L + 1) return;
    if (horizontal) lines.push({ x1: apx, y1: 0, x2: apx, y2: lanesExtent, color, dash, width: 2 });
    else lines.push({ x1: tickMargin, y1: apx, x2: w, y2: apx, color, dash, width: 2 });
  };
  if (pinnedFreq.value != null) marker(pinnedFreq.value, colors.positive, true);
  const cur = activeFreq.value;
  if (cur != null) marker(cur, colors.primary, false);

  return { rects, lines, texts, w, h };
}

/* ------------------------------------------------------------------ */
/* Canvas painting                                                     */
/* ------------------------------------------------------------------ */

function spectralGradient(
  make: (x1: number, y1: number, x2: number, y2: number) => CanvasGradient,
  s: NonNullable<SceneRect["spectral"]>,
): CanvasGradient {
  const grad = make(s.x1, s.y1, s.x2, s.y2);
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const nm = VISIBLE_MIN_NM + ((VISIBLE_MAX_NM - VISIBLE_MIN_NM) * i) / steps;
    const rgb = wavelengthNmToRgb(nm);
    if (rgb) grad.addColorStop(i / steps, rgbToHex(rgb));
  }
  return grad;
}

function paintCanvas(ctx: CanvasRenderingContext2D, scene: Scene, scale: number) {
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

  for (const t of scene.texts) {
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
  const scene = buildScene(w, h);
  paintCanvas(ctx, scene, dpr);
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

const copyableText = computed(() => {
  const lines = readoutRows.value.map((r) => `${r.label}: ${r.value}`);
  const uses = activeReadout.value?.uses ?? [];
  if (uses.length) lines.push(`Common uses: ${uses.join(", ")}`);
  return lines.join("\n");
});

/** Tooltip position, flipped away from the near edges. */
const tooltipStyle = computed(() => {
  const p = pointerPx.value;
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
/* Pointer interaction                                                 */
/* ------------------------------------------------------------------ */

const activePointers = new Map<number, { x: number; y: number }>();
let dragging = false;
let dragMoved = false;
let dragStartAxis = 0;
let dragStartCenter = 0;
let pinchStartDist = 0;
let pinchStartSpan = 1;
let pinchAnchorPos = 0;

function setPointerPxFromClient(clientX: number, clientY: number) {
  const rect = canvasRef.value!.getBoundingClientRect();
  pointerPx.value = { x: clientX - rect.left, y: clientY - rect.top };
}

function readAt(e: PointerEvent, pin: boolean) {
  const apx = eventAxisPx(e);
  const freq = axisPxToFreq(Math.max(0, Math.min(axisLength(), apx)));
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
    pinchAnchorPos = v0() + (midClient / axisLength()) * span.value;
    dragging = false;
    return;
  }

  if (e.pointerType === "mouse") {
    // Mouse drags to pan; a click without movement pins.
    dragging = true;
    dragMoved = false;
    dragStartAxis = eventAxisPx(e);
    dragStartCenter = center.value;
  } else {
    // Touch and pen scrub the readout directly.
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
      center.value = pinchAnchorPos - (midPx / axisLength()) * span.value + span.value / 2;
      clampView();
      scheduleDraw();
      scheduleFragmentWrite();
    }
    return;
  }

  if (dragging && e.pointerType === "mouse") {
    const apx = eventAxisPx(e);
    const delta = apx - dragStartAxis;
    if (Math.abs(delta) > 3) dragMoved = true;
    center.value = dragStartCenter - (delta / axisLength()) * span.value;
    clampView();
    setPointerPxFromClient(e.clientX, e.clientY);
    scheduleDraw();
    scheduleFragmentWrite();
    return;
  }

  if (e.pointerType === "mouse") {
    readAt(e, false);
  } else if (activePointers.has(e.pointerId)) {
    readAt(e, true);
  }
}

function onPointerUp(e: PointerEvent) {
  if (dragging && e.pointerType === "mouse" && !dragMoved) {
    // A click that did not pan pins the readout.
    readAt(e, true);
  }
  dragging = false;
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  canvasRef.value?.releasePointerCapture?.(e.pointerId);
}

function onPointerLeave(e: PointerEvent) {
  if (e.pointerType === "mouse" && !dragging) {
    hoverFreq.value = null;
    if (pinnedFreq.value == null) pointerPx.value = null;
    scheduleDraw();
  }
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = canvasRef.value!.getBoundingClientRect();
  const apx = orientation.value === "horizontal" ? e.clientX - rect.left : e.clientY - rect.top;
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on the pointer.
    const anchorPos = v0() + (apx / axisLength()) * span.value;
    const factor = Math.exp(e.deltaY * 0.0016);
    span.value = span.value * factor;
    clampView();
    center.value = anchorPos - (apx / axisLength()) * span.value + span.value / 2;
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
/* Jump                                                                */
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

function doJump() {
  jumpError.value = "";
  try {
    const freq = parseJump(jumpText.value);
    pinnedFreq.value = freq;
    hoverFreq.value = null;
    // Center the target and zoom to a comfortable window around it.
    const rawSpan = Math.max(MIN_SPAN, Math.min(span.value, 4 / AXIS_DECADES));
    // Mirror animateTo's clamping so we can anchor the tooltip at the true
    // final position without waiting for the animation to finish.
    const finalSpan = Math.min(1, Math.max(MIN_SPAN, rawSpan));
    const half = finalSpan / 2;
    const finalCenter = Math.min(1 - half, Math.max(half, frequencyToPosition(freq)));
    animateTo(frequencyToPosition(freq), rawSpan);
    const finalAxisPx =
      ((frequencyToPosition(freq) - (finalCenter - finalSpan / 2)) / finalSpan) * axisLength();
    pointerPx.value =
      orientation.value === "horizontal"
        ? { x: finalAxisPx, y: cssH.value * 0.4 }
        : { x: cssW.value * 0.5, y: finalAxisPx };
  } catch (err) {
    jumpError.value =
      err instanceof ToolError
        ? `${err.message}${err.fix ? " " + err.fix : ""}`
        : "Could not read that value.";
  }
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
  writeFragment({ opts });
}

function restoreFromFragment() {
  const { opts } = readFragment();
  const f = Number(opts.f);
  const d = Number(opts.d);
  if (Number.isFinite(f) && f > 0) center.value = frequencyToPosition(f);
  if (Number.isFinite(d) && d > 0) span.value = Math.min(1, Math.max(MIN_SPAN, d / AXIS_DECADES));
  clampView();
  const q = Number(opts.q);
  if (Number.isFinite(q) && q > 0) {
    pinnedFreq.value = q;
    const apx = freqToAxisPx(q);
    pointerPx.value =
      orientation.value === "horizontal"
        ? { x: apx, y: cssH.value * 0.4 }
        : { x: cssW.value * 0.5, y: apx };
  }
}

async function copyLink() {
  writeFragmentNow();
  await navigator.clipboard.writeText(window.location.href);
  linkCopied.value = true;
  setTimeout(() => (linkCopied.value = false), 1500);
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

/** Clicking or tapping outside the spectrum and its readout clears the pin. */
function onDocumentPointerDown(e: PointerEvent) {
  if (pinnedFreq.value == null) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (containerRef.value?.contains(target)) return;
  if (readoutCardRef.value?.contains(target)) return;
  pinnedFreq.value = null;
  if (hoverFreq.value == null) pointerPx.value = null;
  scheduleFragmentWrite();
  scheduleDraw();
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportPng() {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = cssW.value * scale;
  canvas.height = cssH.value * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  paintCanvas(ctx, buildScene(cssW.value, cssH.value), scale);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "electromagnetic-spectrum.png");
    URL.revokeObjectURL(url);
  }, "image/png");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function exportSvg() {
  const w = cssW.value;
  const h = cssH.value;
  const scene = buildScene(w, h);
  const parts: string[] = [];
  const defs: string[] = [];
  let gid = 0;

  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${colors.card}"/>`);

  for (const r of scene.rects) {
    let fill = r.fill;
    if (r.spectral) {
      const id = `spec${gid++}`;
      const stops: string[] = [];
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const nm = VISIBLE_MIN_NM + ((VISIBLE_MAX_NM - VISIBLE_MIN_NM) * i) / steps;
        const rgb = wavelengthNmToRgb(nm);
        if (rgb)
          stops.push(
            `<stop offset="${((i / steps) * 100).toFixed(1)}%" stop-color="${rgbToHex(rgb)}"/>`,
          );
      }
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

  for (const t of scene.texts) {
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs.join("")}</defs>${parts.join("")}</svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, "electromagnetic-spectrum.svg");
  URL.revokeObjectURL(url);
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
  // Orientation follows the viewport (landscape to horizontal, portrait to
  // vertical), not the container box, per the brief.
  orientation.value = window.innerWidth >= window.innerHeight ? "horizontal" : "vertical";
  // Keep a pinned readout's tooltip anchored after a resize or orientation flip.
  if (pinnedFreq.value != null && hoverFreq.value == null) {
    const apx = freqToAxisPx(pinnedFreq.value);
    pointerPx.value =
      orientation.value === "horizontal"
        ? { x: apx, y: cssH.value * 0.4 }
        : { x: cssW.value * 0.5, y: apx };
  }
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
      <div class="flex min-w-[220px] flex-1 items-center gap-2">
        <div class="relative flex-1">
          <Search
            class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            v-model="jumpText"
            type="text"
            inputmode="text"
            placeholder="Jump to 2.45 GHz, 550 nm, 10 keV"
            aria-label="Jump to a frequency, wavelength, or energy"
            class="h-9 w-full rounded-[10px] border bg-secondary pr-3 pl-8 font-mono text-sm shadow-[var(--sh-inset)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            @keydown.enter="doJump"
          />
        </div>
        <Button size="sm" @click="doJump"> Jump </Button>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" aria-label="Export as PNG" @click="exportPng">
          <Download class="size-4" />
          PNG
        </Button>
        <Button variant="outline" size="sm" aria-label="Export as SVG" @click="exportSvg">
          <Download class="size-4" />
          SVG
        </Button>
        <Button variant="outline" size="sm" aria-label="Copy shareable link" @click="copyLink">
          <Check v-if="linkCopied" class="size-4 text-[color:var(--positive)]" />
          <LinkIcon v-else class="size-4" />
          {{ linkCopied ? "Copied" : "Link" }}
        </Button>
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

    <p
      v-if="jumpError"
      class="rounded-[10px] border border-[color:var(--border)] bg-secondary px-3 py-2 text-sm text-muted-foreground"
      role="alert"
    >
      {{ jumpError }}
    </p>

    <!-- Spectrum canvas -->
    <div
      ref="containerRef"
      class="relative h-[clamp(280px,52vh,560px)] w-full touch-none overflow-hidden rounded-[14px] border bg-card shadow-[var(--sh-inset)]"
    >
      <canvas
        ref="canvasRef"
        tabindex="0"
        role="img"
        :aria-label="`Electromagnetic spectrum, log frequency axis, ${(span * AXIS_DECADES).toFixed(1)} decades in view. Arrow keys pan, plus and minus zoom.`"
        class="block h-full w-full cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @keydown="onKeydown"
      />

      <!-- Minimal controls shown only in fullscreen (toolbar is hidden there) -->
      <div
        v-if="isFullscreen"
        class="absolute top-2 right-2 left-2 z-20 flex flex-wrap items-center gap-2"
      >
        <div class="relative min-w-[180px] flex-1">
          <Search
            class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            v-model="jumpText"
            type="text"
            inputmode="text"
            placeholder="Jump to 2.45 GHz, 550 nm, 10 keV"
            aria-label="Jump to a frequency, wavelength, or energy"
            class="h-9 w-full rounded-[10px] border bg-popover pr-3 pl-8 font-mono text-sm shadow-[var(--sh-md)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            @keydown.enter="doJump"
          />
        </div>
        <Button size="sm" @click="doJump"> Jump </Button>
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
        class="pointer-events-none absolute top-0 left-0 z-10 w-[236px] max-w-[80%] rounded-[12px] border bg-popover p-3 text-sm shadow-[var(--sh-lg)]"
        :style="tooltipStyle"
        aria-hidden="true"
      >
        <div class="mb-1.5 flex items-center gap-2">
          <span
            v-if="activeReadout.colorHex"
            class="inline-block size-4 shrink-0 rounded-[4px] border"
            :style="{ background: activeReadout.colorHex }"
          />
          <span class="truncate font-semibold">{{ activeReadout.pathLabel }}</span>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
          <dt class="text-muted-foreground">Frequency</dt>
          <dd class="text-right">
            {{ formatFrequency(activeReadout.frequencyHz) }}
          </dd>
          <dt class="text-muted-foreground">Wavelength</dt>
          <dd class="text-right">
            {{ formatWavelength(activeReadout.wavelengthM) }}
          </dd>
          <dt class="text-muted-foreground">Energy</dt>
          <dd class="text-right">
            {{ formatEnergyEv(activeReadout.energyEv) }}
          </dd>
          <dt class="text-muted-foreground">Black-body</dt>
          <dd class="text-right">
            {{ formatKelvin(activeReadout.blackbodyKelvin) }}
          </dd>
        </dl>
        <div class="mt-1.5 flex items-center gap-1.5 text-xs">
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
          class="mt-1.5 line-clamp-3 text-xs text-muted-foreground"
        >
          {{ activeReadout.uses.join(", ") }}
        </p>
      </div>

      <!-- Empty-state hint -->
      <div
        v-if="!activeReadout"
        class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
      >
        <span
          class="rounded-full bg-popover/90 px-3 py-1 text-xs text-muted-foreground shadow-[var(--sh-sm)]"
        >
          Hover or tap the spectrum to read values. Ctrl and scroll or pinch to zoom.
        </span>
      </div>
    </div>

    <!-- Persistent, copyable readout -->
    <div
      v-if="activeReadout"
      ref="readoutCardRef"
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Readout at {{ formatFrequency(activeReadout.frequencyHz) }}
        </span>
        <CopyButton :text="copyableText" label="Copy all" />
      </div>
      <div class="divide-y divide-border/60">
        <div
          v-for="row in readoutRows"
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
              class="rounded-[6px] bg-card px-2 py-0.5 text-xs shadow-[var(--sh-sm)]"
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
