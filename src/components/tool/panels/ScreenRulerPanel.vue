<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import type { CSSProperties } from "vue";
import { Check, Crosshair, Pipette, Ruler, Trash2, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  angle,
  aspectRatio,
  calibrate,
  contrastRatio,
  describeDisplay,
  distance,
  formatMeasurement,
  nearestCssColorName,
  pxToUnits,
  rectFromPoints,
  rgbaToHex,
  unitsToPx,
  type LengthUnit,
  type PxToUnitsOpts,
  type RulerPoint,
} from "@/tools/screen-ruler/index";
import { formatBytes } from "@/lib/format";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for Screen Ruler.
 *
 * The generic shell has no way to express "drag a line across the viewport",
 * so this panel owns three things the pure layer cannot: a full viewport
 * overlay that turns the live page into a measuring surface, a canvas that
 * measures and samples a dropped screenshot in image pixels, and a resizable
 * calibration bar the user matches against a real object.
 *
 * Every number on screen comes from `src/tools/screen-ruler/` (rule 27):
 * `distance`, `angle`, `rectFromPoints`, `aspectRatio`, `pxToUnits`,
 * `unitsToPx`, `formatMeasurement`, `calibrate`, `describeDisplay`,
 * `rgbaToHex`, `contrastRatio`, and `nearestCssColorName`. This file owns only
 * the DOM: pointer handling, the overlay lifecycle, and the canvas reads.
 *
 * Every browser read happens in onMounted or an event handler, so the server
 * rendered shell never touches window, screen, or localStorage.
 *
 * Nothing here touches the network: your files and inputs never leave your
 * device. The EyeDropper button is the one control that can sample a pixel
 * from outside this tab, and even then the color it returns stays here.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * shared state
 * ------------------------------------------------------------------ */

type PanelTab = "overlay" | "screenshot" | "calibrate";
type Shape = "line" | "rect";
const SHAPE_OPTIONS: SegmentedOption[] = [
  { value: "line", label: "Line" },
  { value: "rect", label: "Rectangle" },
];
/** Which coordinate space a measurement was taken in. */
type Space = "viewport" | "image";

interface Measurement {
  id: number;
  space: Space;
  shape: Shape;
  a: RulerPoint;
  b: RulerPoint;
}

const tab = ref<PanelTab>("overlay");
const units = ref<LengthUnit>("px");
const shape = ref<Shape>("line");

/** Live device pixel ratio, re-read per pointer event so browser zoom stays right. */
const dpr = ref(1);
/** Pixels per millimeter from the calibration tab, or null when uncalibrated. */
const pxPerMm = ref<number | null>(null);

const measurements = ref<Measurement[]>([]);
let nextMeasurementId = 1;

const unitsSpec: SelectOptionSpec = {
  kind: "select",
  id: "screen-ruler-units",
  label: "Units",
  default: "px",
  options: [
    { value: "px", label: "Pixels", synonyms: ["px", "pixel", "pixels", "screen pixels"] },
    {
      value: "mm",
      label: "Millimeters",
      synonyms: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
    },
    {
      value: "cm",
      label: "Centimeters",
      synonyms: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
    },
    { value: "in", label: "Inches", synonyms: ["in", "inch", "inches"] },
  ],
};

const gridSpec: SelectOptionSpec = {
  kind: "select",
  id: "screen-ruler-grid",
  label: "Grid",
  default: "off",
  options: [
    { value: "off", label: "No grid", synonyms: ["none", "hidden", "off"] },
    { value: "8", label: "8 px grid", synonyms: ["eight", "8px", "fine"] },
    { value: "10", label: "10 px grid", synonyms: ["ten", "10px", "decimal"] },
  ],
};

const zoomSpec: SelectOptionSpec = {
  kind: "select",
  id: "screen-ruler-zoom",
  label: "Zoom",
  default: "fit",
  options: [
    { value: "fit", label: "Fit to panel", synonyms: ["fit", "shrink", "contain"] },
    { value: "50", label: "50 percent", synonyms: ["half", "50", "50%"] },
    { value: "100", label: "100 percent (actual pixels)", synonyms: ["actual", "100", "1:1"] },
    { value: "200", label: "200 percent", synonyms: ["double", "200", "2x"] },
    { value: "400", label: "400 percent", synonyms: ["quadruple", "400", "4x"] },
  ],
};

function toUnit(value: string): LengthUnit {
  return value === "mm" || value === "cm" || value === "in" ? value : "px";
}

/** The single conversion path, so no two readouts in this panel can disagree. */
function lengthOpts(): PxToUnitsOpts {
  return {
    dpr: dpr.value,
    calibrationPxPerMm: pxPerMm.value ?? undefined,
  };
}

function formatLength(px: number): string {
  return formatMeasurement(pxToUnits(px, lengthOpts()), units.value);
}

function devicePx(px: number): number {
  return Math.round(pxToUnits(px, lengthOpts()).devicePx);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * measurement rows
 * ------------------------------------------------------------------ */

interface Row {
  label: string;
  value: string;
}

function measurementRows(m: Measurement): Row[] {
  const rect = rectFromPoints(m.a, m.b);
  const diagonal = distance(m.a, m.b);
  if (m.shape === "line") {
    return [
      { label: "Length", value: formatLength(diagonal) },
      { label: "Angle", value: `${round2(angle(m.a, m.b))} deg` },
      { label: "Run and rise", value: `${Math.round(rect.width)} x ${Math.round(rect.height)} px` },
    ];
  }
  return [
    { label: "Size", value: `${Math.round(rect.width)} x ${Math.round(rect.height)} px` },
    { label: "Width", value: formatLength(rect.width) },
    { label: "Height", value: formatLength(rect.height) },
    {
      label: "Aspect ratio",
      value:
        rect.width > 0 && rect.height > 0
          ? aspectRatio(rect.width, rect.height)
          : "Not available, zero width or height",
    },
    { label: "Diagonal", value: formatLength(diagonal) },
  ];
}

function measurementTitle(m: Measurement): string {
  const rect = rectFromPoints(m.a, m.b);
  const space = m.space === "image" ? "image px" : "CSS px";
  if (m.shape === "line") {
    return `Line, ${Math.round(distance(m.a, m.b))} ${space}`;
  }
  return `Rectangle, ${Math.round(rect.width)} x ${Math.round(rect.height)} ${space}`;
}

function measurementText(m: Measurement): string {
  const header = `${measurementTitle(m)} (${Math.round(m.a.x)},${Math.round(m.a.y)} to ${Math.round(m.b.x)},${Math.round(m.b.y)})`;
  return [header, ...measurementRows(m).map((r) => `${r.label}: ${r.value}`)].join("\n");
}

const viewportMeasurements = computed(() =>
  measurements.value.filter((m) => m.space === "viewport"),
);
const imageMeasurements = computed(() => measurements.value.filter((m) => m.space === "image"));

function commit(space: Space, a: RulerPoint, b: RulerPoint) {
  // A stray click should not leave a zero length measurement in the list.
  if (distance(a, b) < 2) return;
  measurements.value = [
    ...measurements.value,
    { id: nextMeasurementId++, space, shape: shape.value, a, b },
  ];
}

function removeMeasurement(id: number) {
  measurements.value = measurements.value.filter((m) => m.id !== id);
}

function clearSpace(space: Space) {
  measurements.value = measurements.value.filter((m) => m.space !== space);
}

/* ------------------------------------------------------------------ *
 * overlay ruler
 * ------------------------------------------------------------------ */

const measuring = ref(false);
const panelRoot = ref<HTMLElement>();
/**
 * The overlay teleports to a body so no transformed ancestor can break its
 * fixed positioning. PopoutButton can move this whole panel into a Document
 * Picture-in-Picture window, so the target is resolved from the panel's own
 * ownerDocument each time the overlay opens, not hardcoded to the main page.
 */
const overlayTarget = ref<HTMLElement | null>(null);
const gridChoice = ref<"off" | "8" | "10">("off");
const cursor = ref<RulerPoint | null>(null);
const dragA = ref<RulerPoint | null>(null);
const dragB = ref<RulerPoint | null>(null);
const viewportW = ref(0);
const viewportH = ref(0);

const gridStyle = computed(() => {
  const step = gridChoice.value === "8" ? 8 : 10;
  const line = "var(--primary)";
  return {
    backgroundImage:
      `repeating-linear-gradient(to right, ${line} 0 1px, transparent 1px ${step}px), ` +
      `repeating-linear-gradient(to bottom, ${line} 0 1px, transparent 1px ${step}px)`,
  };
});

const dragRect = computed(() => {
  const a = dragA.value;
  const b = dragB.value;
  return a && b ? rectFromPoints(a, b) : null;
});

const cursorReadout = computed(() => {
  const c = cursor.value;
  if (!c) return null;
  return {
    css: `x ${Math.round(c.x)}, y ${Math.round(c.y)} CSS px`,
    device: `x ${devicePx(c.x)}, y ${devicePx(c.y)} device px at ${dpr.value}x`,
  };
});

const dragReadout = computed<Row[] | null>(() => {
  const a = dragA.value;
  const b = dragB.value;
  if (!a || !b) return null;
  return measurementRows({ id: 0, space: "viewport", shape: shape.value, a, b });
});

/** Keeps the floating readout inside the viewport instead of under the edge. */
const chipStyle = computed(() => {
  const c = cursor.value;
  if (!c) return { left: "16px", top: "16px" };
  const left = Math.min(Math.max(c.x + 18, 8), Math.max(8, viewportW.value - 280));
  const top = Math.min(Math.max(c.y + 18, 8), Math.max(8, viewportH.value - 160));
  return { left: `${left}px`, top: `${top}px` };
});

function readViewport() {
  viewportW.value = window.innerWidth;
  viewportH.value = window.innerHeight;
  dpr.value = window.devicePixelRatio || 1;
}

function startMeasuring() {
  readViewport();
  overlayTarget.value = panelRoot.value?.ownerDocument.body ?? document.body;
  measuring.value = true;
  cursor.value = null;
  dragA.value = null;
  dragB.value = null;
  window.addEventListener("keydown", onOverlayKey);
}

function stopMeasuring() {
  measuring.value = false;
  cursor.value = null;
  dragA.value = null;
  dragB.value = null;
  window.removeEventListener("keydown", onOverlayKey);
}

function onOverlayKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    stopMeasuring();
  }
}

function overlayPoint(e: PointerEvent): RulerPoint {
  return { x: e.clientX, y: e.clientY };
}

function onOverlayDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  dpr.value = window.devicePixelRatio || 1;
  const p = overlayPoint(e);
  dragA.value = p;
  dragB.value = p;
  cursor.value = p;
}

function onOverlayMove(e: PointerEvent) {
  dpr.value = window.devicePixelRatio || 1;
  const p = overlayPoint(e);
  cursor.value = p;
  if (dragA.value) dragB.value = p;
}

function onOverlayUp(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  const a = dragA.value;
  const b = dragB.value;
  dragA.value = null;
  dragB.value = null;
  if (a && b) commit("viewport", a, b);
}

function onOverlayCancel(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  dragA.value = null;
  dragB.value = null;
}

/* ------------------------------------------------------------------ *
 * screenshot
 * ------------------------------------------------------------------ */

const canvas = ref<HTMLCanvasElement>();
const fileName = ref("");
const fileSize = ref(0);
const decodeFailed = ref(false);
const imgWidth = ref(0);
const imgHeight = ref(0);
const zoom = ref<"fit" | "50" | "100" | "200" | "400">("fit");
const imageMode = ref<"measure" | "pick">("measure");
const IMAGE_MODE_OPTIONS: SegmentedOption[] = [
  { value: "measure", label: "Measure" },
  { value: "pick", label: "Pick color" },
];

/** Kept out of the reactive graph: a large pixel buffer must not be proxied. */
const pixels = shallowRef<ImageData | null>(null);

const imageDragA = ref<RulerPoint | null>(null);
const imageDragB = ref<RulerPoint | null>(null);
const hasImage = computed(() => imgWidth.value > 0 && imgHeight.value > 0);

const canvasStyle = computed<CSSProperties>(() => {
  if (zoom.value === "fit") {
    return { width: "auto", height: "auto", maxWidth: "100%", imageRendering: "auto" };
  }
  const factor = Number(zoom.value) / 100;
  return {
    width: `${Math.max(1, Math.round(imgWidth.value * factor))}px`,
    height: `${Math.max(1, Math.round(imgHeight.value * factor))}px`,
    maxWidth: "none",
    imageRendering: factor > 1 ? "pixelated" : "auto",
  };
});

const imageDragReadout = computed<Row[] | null>(() => {
  const a = imageDragA.value;
  const b = imageDragB.value;
  if (!a || !b) return null;
  return measurementRows({ id: 0, space: "image", shape: shape.value, a, b });
});

/**
 * Decodes into an offscreen canvas, never the visible one: the visible canvas
 * only exists once an image has loaded, so it is not there for the first drop.
 * The pixels are kept so the color picker can sample without reading back
 * from a canvas on every click.
 */
function decode(file: File): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) {
        decodeFailed.value = true;
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        decodeFailed.value = true;
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      ctx.drawImage(img, 0, 0);
      pixels.value = ctx.getImageData(0, 0, w, h);
      imgWidth.value = w;
      imgHeight.value = h;
      decodeFailed.value = false;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      pixels.value = null;
      imgWidth.value = 0;
      imgHeight.value = 0;
      decodeFailed.value = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

/** Paints the decoded pixels onto the visible canvas once Vue has rendered it. */
function paintCanvas() {
  const el = canvas.value;
  const image = pixels.value;
  if (!el || !image) return;
  if (el.width !== image.width) el.width = image.width;
  if (el.height !== image.height) el.height = image.height;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(image, 0, 0);
}

async function readFile(file: File) {
  fileName.value = file.name;
  fileSize.value = file.size;
  clearSpace("image");
  imageDragA.value = null;
  imageDragB.value = null;
  sample.value = null;
  await decode(file);
  // The canvas is behind a v-if on hasImage, so it only exists after this tick.
  await nextTick();
  paintCanvas();
}

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

function clearImage() {
  pixels.value = null;
  imgWidth.value = 0;
  imgHeight.value = 0;
  fileName.value = "";
  fileSize.value = 0;
  decodeFailed.value = false;
  imageDragA.value = null;
  imageDragB.value = null;
  sample.value = null;
  clearSpace("image");
}

/**
 * The canvas is sized in real image pixels and scaled by CSS, so pointer
 * coordinates need the ratio between the two. Reading it per event keeps it
 * correct at every zoom step, including Fit, without a resize observer.
 */
function imagePoint(e: PointerEvent, el: HTMLCanvasElement): RulerPoint {
  const box = el.getBoundingClientRect();
  const scaleX = box.width > 0 ? imgWidth.value / box.width : 1;
  const scaleY = box.height > 0 ? imgHeight.value / box.height : 1;
  return {
    x: Math.min(Math.max((e.clientX - box.left) * scaleX, 0), imgWidth.value),
    y: Math.min(Math.max((e.clientY - box.top) * scaleY, 0), imgHeight.value),
  };
}

function onImageDown(e: PointerEvent) {
  const el = canvas.value;
  if (!el || !hasImage.value) return;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  const p = imagePoint(e, el);
  if (imageMode.value === "pick") {
    pickAt(p);
    return;
  }
  imageDragA.value = p;
  imageDragB.value = p;
}

function onImageMove(e: PointerEvent) {
  const el = canvas.value;
  if (!el || !imageDragA.value) return;
  imageDragB.value = imagePoint(e, el);
}

function onImageUp(e: PointerEvent) {
  const el = canvas.value;
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  const a = imageDragA.value;
  const b = imageDragB.value;
  imageDragA.value = null;
  imageDragB.value = null;
  if (a && b) commit("image", a, b);
}

function onImageCancel(e: PointerEvent) {
  const el = canvas.value;
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  imageDragA.value = null;
  imageDragB.value = null;
}

/* ------------------------------------------------------------------ *
 * color sampling
 * ------------------------------------------------------------------ */

interface Sample {
  /** Full hex, with an alpha pair only when the pixel is not fully opaque. */
  hex: string;
  /** Opaque hex, the form the contrast and naming helpers accept. */
  opaque: string;
  rgb: string | null;
  name: string;
  onWhite: number;
  onBlack: number;
  source: "canvas" | "screen";
  point: RulerPoint | null;
}

const sample = ref<Sample | null>(null);
const eyeDropperSupported = ref(false);
const eyeDropperError = ref<string | null>(null);

/** The EyeDropper API is Chromium only and absent from the standard DOM lib. */
interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperInstance {
  open(): Promise<EyeDropperResult>;
}
interface EyeDropperConstructor {
  new (): EyeDropperInstance;
}
interface WindowWithEyeDropper extends Window {
  EyeDropper?: EyeDropperConstructor;
}

/**
 * `hex` is what the user sees, carrying an alpha pair when the pixel is not
 * opaque. `opaque` is the same color without alpha, the only form the
 * contrast and naming helpers accept. Both come from rgbaToHex, so the panel
 * never assembles a hex string of its own.
 */
function buildSample(
  hex: string,
  opaque: string,
  rgb: string | null,
  source: "canvas" | "screen",
  point: RulerPoint | null,
): Sample {
  return {
    hex,
    opaque,
    rgb,
    name: nearestCssColorName(opaque),
    onWhite: contrastRatio(opaque, "#ffffff"),
    onBlack: contrastRatio(opaque, "#000000"),
    source,
    point,
  };
}

/** Samples the decoded buffer directly, so no canvas read happens per click. */
function pickAt(p: RulerPoint) {
  const image = pixels.value;
  if (!image) return;
  const x = Math.min(Math.max(Math.floor(p.x), 0), image.width - 1);
  const y = Math.min(Math.max(Math.floor(p.y), 0), image.height - 1);
  const at = (y * image.width + x) * 4;
  const data = image.data;
  const r = data[at] ?? 0;
  const g = data[at + 1] ?? 0;
  const b = data[at + 2] ?? 0;
  const a = (data[at + 3] ?? 255) / 255;
  sample.value = buildSample(
    rgbaToHex(r, g, b, a),
    rgbaToHex(r, g, b),
    `rgb(${r}, ${g}, ${b})`,
    "canvas",
    { x, y },
  );
}

async function openEyeDropper() {
  eyeDropperError.value = null;
  const ctor = (window as WindowWithEyeDropper).EyeDropper;
  if (!ctor) return;
  try {
    const result = await new ctor().open();
    const hex = result.sRGBHex.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) {
      eyeDropperError.value = "The browser returned a color this tool could not read.";
      return;
    }
    // The EyeDropper API always returns an opaque color, so both forms match.
    sample.value = buildSample(hex, hex, null, "screen", null);
  } catch {
    // Closing the eyedropper without picking rejects. That is not an error.
  }
}

const contrastNote = computed(() => {
  const s = sample.value;
  if (!s) return "";
  const best = s.onWhite >= s.onBlack ? "white" : "black";
  return `Reads best against ${best} text.`;
});

/* ------------------------------------------------------------------ *
 * calibration
 * ------------------------------------------------------------------ */

const CALIBRATION_KEY = "screen-ruler.pxPerMm";
const CARD_MM = 85.6;
const MIN_BAR_PX = 20;
const MAX_BAR_PX = 4000;

const knownMm = ref(CARD_MM);
const barPx = ref(320);
const barTrack = ref<HTMLDivElement>();
const barDragging = ref(false);
const calibrationError = ref<string | null>(null);
const calibrationSaved = ref(false);
const storageBlocked = ref(false);

const barPreview = computed<number | null>(() => {
  if (!Number.isFinite(knownMm.value) || knownMm.value <= 0) return null;
  if (!Number.isFinite(barPx.value) || barPx.value <= 0) return null;
  try {
    return calibrate(knownMm.value, barPx.value);
  } catch {
    return null;
  }
});

const previewDpi = computed(() => {
  const value = barPreview.value;
  return value === null ? null : Math.round(value * 25.4);
});

/** A one centimeter tick spacing under the current preview, for the bar ruler. */
const previewCmPx = computed(() => {
  const value = barPreview.value;
  if (value === null) return null;
  return unitsToPx(1, "cm", { calibrationPxPerMm: value });
});

function setPreset(mm: number) {
  knownMm.value = mm;
  calibrationSaved.value = false;
}

function onKnownInput(raw: string | number) {
  const value = Number(raw);
  knownMm.value = Number.isFinite(value) ? value : 0;
  calibrationSaved.value = false;
}

function clampBar(px: number): number {
  return Math.min(Math.max(Math.round(px), MIN_BAR_PX), MAX_BAR_PX);
}

function onBarDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  barDragging.value = true;
  calibrationSaved.value = false;
}

function onBarMove(e: PointerEvent) {
  if (!barDragging.value) return;
  const track = barTrack.value;
  if (!track) return;
  const box = track.getBoundingClientRect();
  // The track scrolls once the bar is wider than the panel, so the scroll
  // offset has to be added back or the bar would snap when it overflows.
  barPx.value = clampBar(e.clientX - box.left + track.scrollLeft);
}

function onBarUp(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  barDragging.value = false;
}

function onBarKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 1;
  let next = barPx.value;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") next -= step;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") next += step;
  else if (e.key === "Home") next = MIN_BAR_PX;
  else if (e.key === "End") next = Math.min(MAX_BAR_PX, Math.round(viewportW.value || 800));
  else return;
  e.preventDefault();
  calibrationSaved.value = false;
  barPx.value = clampBar(next);
}

function applyCalibration() {
  calibrationError.value = null;
  try {
    const value = calibrate(knownMm.value, barPx.value);
    pxPerMm.value = value;
    calibrationSaved.value = true;
    try {
      window.localStorage.setItem(CALIBRATION_KEY, String(value));
      storageBlocked.value = false;
    } catch {
      storageBlocked.value = true;
    }
  } catch (err) {
    calibrationError.value =
      err instanceof Error
        ? err.message
        : "Enter a positive real world length and drag the bar to match it.";
  }
}

function clearCalibration() {
  pxPerMm.value = null;
  calibrationSaved.value = false;
  calibrationError.value = null;
  try {
    window.localStorage.removeItem(CALIBRATION_KEY);
    storageBlocked.value = false;
  } catch {
    storageBlocked.value = true;
  }
}

const calibrationSummary = computed(() => {
  const value = pxPerMm.value;
  if (value === null) {
    return "Not calibrated. Real world units assume the CSS standard of 96 pixels per inch.";
  }
  return `${Math.round(value * 1000) / 1000} px per mm, about ${Math.round(value * 25.4)} DPI.`;
});

/* ------------------------------------------------------------------ *
 * display rows
 * ------------------------------------------------------------------ */

const displayRows = ref<Record<string, string>>({});

function refreshDisplay() {
  dpr.value = window.devicePixelRatio || 1;
  displayRows.value = describeDisplay({
    width: window.screen.width,
    height: window.screen.height,
    dpr: dpr.value,
    availWidth: window.screen.availWidth,
    availHeight: window.screen.availHeight,
  });
}

const displayEntries = computed(() => Object.entries(displayRows.value));

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function onResize() {
  readViewport();
  refreshDisplay();
}

/**
 * Leaving the overlay tab tears the overlay down so it can never outlive it.
 * The tab strip unmounts whichever panel is not showing, so coming back to
 * Screenshot rebuilds an empty canvas that has to be repainted.
 */
watch(tab, async (value) => {
  if (value !== "overlay" && measuring.value) stopMeasuring();
  if (value === "screenshot") {
    await nextTick();
    paintCanvas();
  }
});

onMounted(() => {
  readViewport();
  refreshDisplay();
  eyeDropperSupported.value = "EyeDropper" in window;
  try {
    const stored = window.localStorage.getItem(CALIBRATION_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed > 0) pxPerMm.value = parsed;
  } catch {
    storageBlocked.value = true;
  }
  window.addEventListener("resize", onResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onOverlayKey);
  pixels.value = null;
});
</script>

<template>
  <div
    ref="panelRoot"
    class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
    <!-- shared controls -->
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex w-44 flex-col gap-1.5">
        <Label for="screen-ruler-units" class="text-xs text-muted-foreground">Units</Label>
        <SearchableSelect
          id="screen-ruler-units"
          :spec="unitsSpec"
          :model-value="units"
          @update:model-value="(v: string) => (units = toUnit(v))"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Tool</span>
        <Segmented
          :model-value="shape"
          :options="SHAPE_OPTIONS"
          label="Tool"
          @update:model-value="(v: string) => (shape = v as Shape)"
        />
      </div>

      <p class="min-w-[16rem] flex-1 text-xs text-muted-foreground">
        {{ calibrationSummary }}
      </p>
    </div>

    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="overlay"> Overlay ruler </TabsTrigger>
        <TabsTrigger value="screenshot"> Screenshot </TabsTrigger>
        <TabsTrigger value="calibrate"> Calibrate </TabsTrigger>
      </TabsList>

      <!-- ------------------------------------------------ overlay ---- -->
      <TabsContent value="overlay" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-wrap items-end gap-3">
          <Button @click="startMeasuring">
            <Crosshair class="size-4" aria-hidden="true" />
            Start measuring
          </Button>

          <div class="flex w-44 flex-col gap-1.5">
            <Label for="screen-ruler-grid" class="text-xs text-muted-foreground">Grid</Label>
            <SearchableSelect
              id="screen-ruler-grid"
              :spec="gridSpec"
              :model-value="gridChoice"
              @update:model-value="
                (v: string) => (gridChoice = v === '8' ? '8' : v === '10' ? '10' : 'off')
              "
            />
          </div>
        </div>

        <p class="max-w-[68ch] text-sm text-muted-foreground">
          The overlay covers this whole tab. Move the pointer for a live x and y readout in CSS
          pixels and device pixels, then drag to measure a line or a rectangle. Press
          <kbd
            class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[0.75rem] leading-none"
            >Esc</kbd
          >
          or the Done button to leave it.
        </p>

        <p class="max-w-[68ch] text-xs text-muted-foreground">
          This measures anything rendered in this tab: this page, or a screenshot you drop into the
          Screenshot tab. A web page cannot see outside its own tab, so to measure another site use
          the Pixel ruler bookmarklet from the
          <a
            href="/bookmarklets/"
            class="font-medium text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >Bookmarklet Shelf</a
          >, or screenshot that page and drop the screenshot here.
        </p>

        <!-- measurement list -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Page measurements
            </span>
            <Button
              v-if="viewportMeasurements.length"
              variant="ghost"
              size="sm"
              @click="clearSpace('viewport')"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
              Clear all
            </Button>
          </div>

          <p v-if="!viewportMeasurements.length" class="text-sm text-muted-foreground">
            Nothing measured yet. Start the overlay and drag between two points: each measurement
            lands here and stays until you clear it.
          </p>

          <div
            v-for="m in viewportMeasurements"
            :key="m.id"
            class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ measurementTitle(m) }}</span>
              <div class="flex shrink-0 items-center gap-1">
                <CopyButton :text="measurementText(m)" />
                <button
                  type="button"
                  aria-label="Remove measurement"
                  class="grid size-7 place-items-center rounded-[8px] text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="removeMeasurement(m.id)"
                >
                  <X class="size-3.5" />
                </button>
              </div>
            </div>
            <div
              v-for="row in measurementRows(m)"
              :key="row.label"
              class="flex flex-wrap justify-between gap-2 text-xs"
            >
              <span class="text-muted-foreground">{{ row.label }}</span>
              <span class="font-mono tabular-nums">{{ row.value }}</span>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- --------------------------------------------- screenshot ---- -->
      <TabsContent value="screenshot" class="flex flex-col gap-4 pt-4">
        <FileDrop
          accept="image/*"
          :paste="tab === 'screenshot'"
          label="Drop a screenshot here or click to choose"
          hint="You can also paste one with Ctrl or Cmd and V. Measurements and colors are read in image pixels. Everything runs in this tab: your files and inputs never leave your device."
          @files="onFiles"
        >
          <template v-if="hasImage || decodeFailed" #default>
            <div class="flex justify-center">
              <span
                class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
              >
                <span class="truncate font-medium">{{ fileName }}</span>
                <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
                <span v-if="hasImage" class="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {{ imgWidth }} x {{ imgHeight }} px
                </span>
                <button
                  type="button"
                  aria-label="Remove image"
                  class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="clearImage"
                >
                  <X class="size-3.5" />
                </button>
              </span>
            </div>
          </template>
        </FileDrop>

        <ErrorBanner
          v-if="decodeFailed"
          message="This browser could not decode that file as an image."
          hint="Try a PNG, JPEG, WebP, GIF, or BMP screenshot."
        />

        <template v-if="hasImage">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-56 flex-col gap-1.5">
              <Label for="screen-ruler-zoom" class="text-xs text-muted-foreground">Zoom</Label>
              <SearchableSelect
                id="screen-ruler-zoom"
                :spec="zoomSpec"
                :model-value="zoom"
                @update:model-value="
                  (v: string) =>
                    (zoom = v === '50' || v === '100' || v === '200' || v === '400' ? v : 'fit')
                "
              />
            </div>

            <div class="flex flex-col gap-1.5">
              <span class="text-xs text-muted-foreground">Click does</span>
              <Segmented
                :model-value="imageMode"
                :options="IMAGE_MODE_OPTIONS"
                label="Click does"
                @update:model-value="(v: string) => (imageMode = v === 'pick' ? 'pick' : 'measure')"
              >
                <template #default="{ option }">
                  <Ruler v-if="option.value === 'measure'" class="size-3.5" aria-hidden="true" />
                  <Pipette v-else class="size-3.5" aria-hidden="true" />
                  {{ option.label }}
                </template>
              </Segmented>
            </div>
          </div>

          <!-- canvas well -->
          <div
            class="max-h-[560px] overflow-auto rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <div class="relative inline-block max-w-full align-top">
              <canvas
                ref="canvas"
                class="block cursor-crosshair touch-none rounded-[6px]"
                :style="canvasStyle"
                :aria-label="
                  imageMode === 'pick'
                    ? 'Screenshot. Click a pixel to read its color.'
                    : 'Screenshot. Drag between two points to measure.'
                "
                @pointerdown="onImageDown"
                @pointermove="onImageMove"
                @pointerup="onImageUp"
                @pointercancel="onImageCancel"
              />

              <svg
                class="pointer-events-none absolute inset-0 h-full w-full"
                :viewBox="`0 0 ${imgWidth} ${imgHeight}`"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <template v-for="m in imageMeasurements" :key="m.id">
                  <line
                    v-if="m.shape === 'line'"
                    :x1="m.a.x"
                    :y1="m.a.y"
                    :x2="m.b.x"
                    :y2="m.b.y"
                    stroke="var(--primary)"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                  <rect
                    v-else
                    :x="rectFromPoints(m.a, m.b).x"
                    :y="rectFromPoints(m.a, m.b).y"
                    :width="rectFromPoints(m.a, m.b).width"
                    :height="rectFromPoints(m.a, m.b).height"
                    fill="var(--primary)"
                    fill-opacity="0.12"
                    stroke="var(--primary)"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                </template>

                <template v-if="imageDragA && imageDragB">
                  <line
                    v-if="shape === 'line'"
                    :x1="imageDragA.x"
                    :y1="imageDragA.y"
                    :x2="imageDragB.x"
                    :y2="imageDragB.y"
                    stroke="var(--primary)"
                    stroke-width="2"
                    stroke-dasharray="6 4"
                    vector-effect="non-scaling-stroke"
                  />
                  <rect
                    v-else
                    :x="rectFromPoints(imageDragA, imageDragB).x"
                    :y="rectFromPoints(imageDragA, imageDragB).y"
                    :width="rectFromPoints(imageDragA, imageDragB).width"
                    :height="rectFromPoints(imageDragA, imageDragB).height"
                    fill="var(--primary)"
                    fill-opacity="0.12"
                    stroke="var(--primary)"
                    stroke-width="2"
                    stroke-dasharray="6 4"
                    vector-effect="non-scaling-stroke"
                  />
                </template>
              </svg>
            </div>
          </div>

          <div
            v-if="imageDragReadout"
            class="flex flex-wrap gap-x-5 gap-y-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
          >
            <span v-for="row in imageDragReadout" :key="row.label" class="flex gap-1.5">
              <span class="text-muted-foreground">{{ row.label }}</span>
              <span class="font-mono tabular-nums">{{ row.value }}</span>
            </span>
          </div>

          <p class="max-w-[68ch] text-xs text-muted-foreground">
            Millimeters, centimeters, and inches on a screenshot only mean something when the
            screenshot was captured at the same scale as the screen you calibrated.
          </p>
        </template>

        <!-- color picker -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Color picker
            </span>
            <Button v-if="eyeDropperSupported" variant="outline" size="sm" @click="openEyeDropper">
              <Pipette class="size-3.5" aria-hidden="true" />
              EyeDropper
            </Button>
          </div>

          <p class="max-w-[68ch] text-xs text-muted-foreground">
            <template v-if="eyeDropperSupported">
              Switch the click mode to Pick color and click a pixel in the screenshot, or use
              EyeDropper. EyeDropper is the one control here that can reach past this tab: the
              browser takes over the pointer and hands back a single color from anywhere on your
              screen. The color still stays on this device.
            </template>
            <template v-else>
              Switch the click mode to Pick color and click a pixel in the screenshot. This browser
              has no EyeDropper API, which is the only way a page can sample a color from outside
              its own tab, so screen wide sampling is unavailable here. Chromium browsers such as
              Chrome and Edge support it.
            </template>
          </p>

          <p v-if="eyeDropperError" role="alert" class="text-xs text-destructive">
            {{ eyeDropperError }}
          </p>

          <div v-if="sample" class="flex flex-wrap items-center gap-3">
            <div
              class="size-14 shrink-0 rounded-[10px] border"
              :style="{ backgroundColor: sample.hex }"
              aria-hidden="true"
            />
            <div class="flex min-w-0 flex-col gap-1 text-xs">
              <div class="flex items-center gap-2">
                <span class="font-mono text-sm">{{ sample.hex }}</span>
                <CopyButton :text="sample.hex" />
              </div>
              <span class="text-muted-foreground">
                Nearest named color: {{ sample.name }}
                <template v-if="sample.rgb"> · {{ sample.rgb }}</template>
                <template v-if="sample.point">
                  · sampled at {{ sample.point.x }}, {{ sample.point.y }} in the image
                </template>
                <template v-else> · sampled from the screen</template>
              </span>
              <span class="font-mono text-muted-foreground tabular-nums">
                Contrast {{ sample.onWhite.toFixed(2) }}:1 on white,
                {{ sample.onBlack.toFixed(2) }}:1 on black
              </span>
              <span class="text-muted-foreground">{{ contrastNote }}</span>
            </div>
          </div>

          <p v-else class="text-sm text-muted-foreground">No pixel sampled yet.</p>
        </div>

        <!-- image measurement list -->
        <div v-if="imageMeasurements.length" class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Screenshot measurements
            </span>
            <Button variant="ghost" size="sm" @click="clearSpace('image')">
              <Trash2 class="size-3.5" aria-hidden="true" />
              Clear all
            </Button>
          </div>

          <div
            v-for="m in imageMeasurements"
            :key="m.id"
            class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ measurementTitle(m) }}</span>
              <div class="flex shrink-0 items-center gap-1">
                <CopyButton :text="measurementText(m)" />
                <button
                  type="button"
                  aria-label="Remove measurement"
                  class="grid size-7 place-items-center rounded-[8px] text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="removeMeasurement(m.id)"
                >
                  <X class="size-3.5" />
                </button>
              </div>
            </div>
            <div
              v-for="row in measurementRows(m)"
              :key="row.label"
              class="flex flex-wrap justify-between gap-2 text-xs"
            >
              <span class="text-muted-foreground">{{ row.label }}</span>
              <span class="font-mono tabular-nums">{{ row.value }}</span>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- ---------------------------------------------- calibrate ---- -->
      <TabsContent value="calibrate" class="flex flex-col gap-4 pt-4">
        <p class="max-w-[68ch] text-sm text-muted-foreground">
          Hold a real object of known width flat against the screen, then drag the handle until the
          bar below matches its edges exactly. A standard credit card is 85.60 mm wide, and a
          printed ruler works just as well. Everything measured afterwards converts to real
          millimeters, centimeters, and inches using that scale.
        </p>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="screen-ruler-known" class="text-xs text-muted-foreground">
              Object width in mm
            </Label>
            <Input
              id="screen-ruler-known"
              type="number"
              min="1"
              step="0.1"
              class="bg-card"
              :model-value="knownMm"
              @update:model-value="onKnownInput"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" @click="setPreset(CARD_MM)">
              Credit card, 85.60 mm
            </Button>
            <Button variant="outline" size="sm" @click="setPreset(100)"> Ruler, 100 mm </Button>
            <Button variant="outline" size="sm" @click="setPreset(210)"> A4 width, 210 mm </Button>
          </div>
        </div>

        <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div ref="barTrack" class="relative w-full overflow-x-auto">
            <div
              class="relative flex h-16 items-center rounded-[8px] bg-[image:var(--grad-brand-soft)] ring-1 ring-[color:var(--brand-hairline)]"
              :style="{ width: `${barPx}px` }"
            >
              <div
                v-if="previewCmPx"
                class="pointer-events-none absolute inset-0 opacity-60"
                :style="{
                  backgroundImage: `repeating-linear-gradient(to right, var(--primary) 0 1px, transparent 1px ${previewCmPx}px)`,
                }"
              />
              <span class="pointer-events-none px-3 font-mono text-xs tabular-nums">
                {{ barPx }} px
              </span>
              <button
                type="button"
                role="slider"
                :aria-valuenow="barPx"
                :aria-valuemin="MIN_BAR_PX"
                :aria-valuemax="MAX_BAR_PX"
                aria-label="Calibration bar width in pixels"
                class="absolute top-0 -right-2 h-full w-4 cursor-ew-resize touch-none rounded-[6px] bg-primary bg-[image:var(--grad-brand)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                @pointerdown="onBarDown"
                @pointermove="onBarMove"
                @pointerup="onBarUp"
                @pointercancel="onBarUp"
                @keydown="onBarKey"
              />
            </div>
          </div>

          <p class="text-xs text-muted-foreground">
            Drag the violet handle, or focus it and use the arrow keys. Hold Shift for 10 pixel
            steps.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Button :disabled="barPreview === null" @click="applyCalibration">
            <Check v-if="calibrationSaved" class="size-4" aria-hidden="true" />
            {{ calibrationSaved ? "Calibration saved" : "Use this calibration" }}
          </Button>
          <Button v-if="pxPerMm !== null" variant="ghost" size="sm" @click="clearCalibration">
            <Trash2 class="size-3.5" aria-hidden="true" />
            Clear calibration
          </Button>
          <span
            v-if="barPreview !== null"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            Preview: {{ (Math.round(barPreview * 1000) / 1000).toFixed(3) }} px per mm, about
            {{ previewDpi }} DPI
          </span>
        </div>

        <p v-if="calibrationError" role="alert" class="text-xs text-destructive">
          {{ calibrationError }}
        </p>

        <p class="max-w-[68ch] text-xs text-muted-foreground">
          The calibration is saved on this device under the key "screen-ruler.pxPerMm" so you do not
          have to redo it on every visit. It is a preference, a single number describing your
          screen, and nothing you measure or drop in is ever stored. Clear calibration removes it.
        </p>

        <p v-if="storageBlocked" class="max-w-[68ch] text-xs text-muted-foreground">
          This browser blocked local storage, likely a private window or a site setting, so the
          calibration lasts only until you close the tab.
        </p>

        <div class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            This display
          </span>
          <div
            class="divide-y divide-border/60 rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          >
            <div
              v-for="[key, value] in displayEntries"
              :key="key"
              class="flex flex-wrap justify-between gap-2 px-3 py-2"
            >
              <span class="text-xs text-muted-foreground">{{ key }}</span>
              <span class="font-mono text-xs tabular-nums">{{ value }}</span>
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  </div>

  <!-- ------------------------------------------------------ overlay ---- -->
  <Teleport v-if="measuring && overlayTarget" :to="overlayTarget">
    <div
      class="fixed inset-0 z-[9999] cursor-crosshair touch-none select-none"
      role="application"
      aria-label="Screen ruler overlay"
      @pointerdown="onOverlayDown"
      @pointermove="onOverlayMove"
      @pointerup="onOverlayUp"
      @pointercancel="onOverlayCancel"
    >
      <div
        v-if="gridChoice !== 'off'"
        class="pointer-events-none absolute inset-0 opacity-20"
        :style="gridStyle"
      />

      <div class="pointer-events-none absolute inset-0 border border-primary/40" />

      <template v-if="cursor">
        <div
          class="pointer-events-none absolute inset-y-0 w-px bg-primary"
          :style="{ left: `${cursor.x}px` }"
        />
        <div
          class="pointer-events-none absolute inset-x-0 h-px bg-primary"
          :style="{ top: `${cursor.y}px` }"
        />
      </template>

      <svg class="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        <template v-for="m in viewportMeasurements" :key="m.id">
          <line
            v-if="m.shape === 'line'"
            :x1="m.a.x"
            :y1="m.a.y"
            :x2="m.b.x"
            :y2="m.b.y"
            stroke="var(--primary)"
            stroke-width="2"
          />
          <rect
            v-else
            :x="rectFromPoints(m.a, m.b).x"
            :y="rectFromPoints(m.a, m.b).y"
            :width="rectFromPoints(m.a, m.b).width"
            :height="rectFromPoints(m.a, m.b).height"
            fill="var(--primary)"
            fill-opacity="0.12"
            stroke="var(--primary)"
            stroke-width="2"
          />
        </template>

        <template v-if="dragA && dragB">
          <line
            v-if="shape === 'line'"
            :x1="dragA.x"
            :y1="dragA.y"
            :x2="dragB.x"
            :y2="dragB.y"
            stroke="var(--primary)"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
          <rect
            v-else-if="dragRect"
            :x="dragRect.x"
            :y="dragRect.y"
            :width="dragRect.width"
            :height="dragRect.height"
            fill="var(--primary)"
            fill-opacity="0.12"
            stroke="var(--primary)"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
        </template>
      </svg>

      <div
        class="pointer-events-none absolute flex max-w-[17rem] flex-col gap-1 rounded-[10px] border bg-popover px-3 py-2 text-xs shadow-[var(--sh-lg)]"
        :style="chipStyle"
      >
        <template v-if="cursorReadout">
          <span class="font-mono tabular-nums">{{ cursorReadout.css }}</span>
          <span class="font-mono text-muted-foreground tabular-nums">
            {{ cursorReadout.device }}
          </span>
        </template>
        <span v-else class="text-muted-foreground">Move the pointer to read a position.</span>

        <template v-if="dragReadout">
          <span
            v-for="row in dragReadout"
            :key="row.label"
            class="flex justify-between gap-3 border-t pt-1 font-mono tabular-nums"
          >
            <span class="font-sans text-muted-foreground">{{ row.label }}</span>
            <span>{{ row.value }}</span>
          </span>
        </template>
      </div>

      <!-- The Done control sits inside the overlay, so its pointer events must
           not also start a measurement drag underneath it. -->
      <div
        class="absolute top-4 right-4 flex items-center gap-2"
        @pointerdown.stop
        @pointermove.stop
        @pointerup.stop
      >
        <span
          class="rounded-[10px] border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--sh-lg)]"
        >
          Drag to measure a {{ shape === "line" ? "line" : "rectangle" }}
        </span>
        <Button size="sm" @click="stopMeasuring">
          <X class="size-4" aria-hidden="true" />
          Done
        </Button>
      </div>
    </div>
  </Teleport>
</template>
