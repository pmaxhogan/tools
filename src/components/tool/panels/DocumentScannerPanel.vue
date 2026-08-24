<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { ArrowLeft, ArrowRight, Camera, Download, RefreshCw, Trash2, X } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import {
  buildScanPdf,
  detectCorners,
  enhance,
  fallbackQuad,
  outputSize,
  warpImage,
  type EnhanceMode,
  type Point,
  type Quad,
  type ScanImage,
} from "@/tools/document-scanner/index";

/**
 * Bespoke panel for the document scanner.
 *
 * The generic ToolShell has nowhere to put a photo with four draggable corners
 * over it, so this tool gets its own island. Everything that is math lives in
 * the pure logic module and is unit tested there: detection, the perspective
 * warp, the enhancement passes, and the PDF assembly. This component owns the
 * camera, the canvas, the pointer handling, and the downloads.
 *
 * Three things worth knowing about the shape of it:
 *
 *   1. The full resolution ImageData is kept once and never mutated. The
 *      preview warps a small copy so dragging a corner stays responsive, and
 *      only Add page runs the warp at the output size.
 *   2. A corner drag is rejected rather than clamped when it would collapse or
 *      fold the quad, so the homography solver never sees a degenerate input.
 *   3. The camera is started by a click and stopped the moment a frame is
 *      captured, and again on unmount, so it cannot survive a navigation.
 */
const props = defineProps<{ meta: ToolMeta }>();

interface ScannedPage {
  id: number;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** A small JPEG data URL for the strip. Data URLs need no revoking. */
  thumb: string;
  mode: EnhanceMode;
}

/** Tallest the working canvas gets, in CSS pixels. */
const MAX_VIEW_HEIGHT = 460;
/** Widest the working canvas gets before the container takes over. */
const MAX_VIEW_WIDTH = 720;
/** Grab radius for a corner handle, in CSS pixels of the working canvas. */
const GRAB_RADIUS = 18;
/** Corners closer than this many image pixels are refused, so the quad stays solvable. */
const MIN_CORNER_GAP = 24;
/** Longest edge of the live preview. Small enough to redraw on every drag. */
const PREVIEW_EDGE = 360;
/** Loupe radius in CSS pixels, and how much it magnifies the working canvas. */
const LOUPE_RADIUS = 52;
const LOUPE_ZOOM = 4;
/** Quality for the JPEG copies embedded in the PDF. */
const PDF_JPEG_QUALITY = 0.85;
/** Assumed density when a PDF sheet is sized to its scan. */
const PDF_DENSITY = 150;

const MODE_FALLBACK: SegmentedOption[] = [
  { value: "none", label: "Original" },
  { value: "grayscale", label: "Grayscale" },
  { value: "color", label: "Color" },
  { value: "bw", label: "Black and white" },
];

const CORNER_NAMES = ["Top left", "Top right", "Bottom right", "Bottom left"] as const;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileName = ref("");
const fileSize = ref(0);
const dragging = ref(false);
const busy = ref(false);
const busyLabel = ref("");
const problem = ref<{ message: string; fix?: string } | null>(null);

/** The decoded photo. Never mutated: every warp reads from it. */
const source = shallowRef<ScanImage | null>(null);
/** The same photo as a canvas, so the working view can draw it cheaply. */
const sourceCanvas = shallowRef<HTMLCanvasElement | null>(null);

const corners = ref<Quad>(fallbackQuad(1, 1));
const confidence = ref(0);
const detectionFailed = ref(true);
const activeCorner = ref<number | null>(null);
const selectedCorner = ref(0);
/** True once a handle has been dragged or nudged, so the badge stops quoting a stale score. */
const cornersEdited = ref(false);

const mode = ref<EnhanceMode>("grayscale");
const scale = ref("1");
const singleFormat = ref<"png" | "jpeg">("png");
const pdfPage = ref<"image" | "letter" | "a4">("image");

const pages = ref<ScannedPage[]>([]);
let nextPageId = 1;
const savedNote = ref("");

const cameraOn = ref(false);
const cameraStarting = ref(false);
let stream: MediaStream | null = null;

const canvasEl = ref<HTMLCanvasElement>();
const previewEl = ref<HTMLCanvasElement>();
const videoEl = ref<HTMLVideoElement>();
const fileInput = ref<HTMLInputElement>();
const stageEl = ref<HTMLDivElement>();

const viewWidth = ref(0);
const viewHeight = ref(0);
const containerWidth = ref(MAX_VIEW_WIDTH);

let resizeObserver: ResizeObserver | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const hasImage = computed(() => source.value !== null);
const viewScale = computed(() => {
  const image = source.value;
  if (!image || viewWidth.value === 0) return 1;
  return viewWidth.value / image.width;
});

const scaleNumber = computed(() => {
  const value = Number(scale.value);
  return Number.isFinite(value) && value > 0 ? value : 1;
});

const targetSize = computed(() => {
  if (!source.value) return null;
  return outputSize(corners.value, 96 * scaleNumber.value);
});

const confidenceLabel = computed(() => {
  if (cornersEdited.value) return "Corners set by hand";
  if (detectionFailed.value) return "No page found";
  const percent = Math.round(confidence.value * 100);
  if (percent >= 75) return `Corners found, ${percent}% confidence`;
  return `Corners are a rough guess, ${percent}% confidence`;
});

/** Every segmented group is the meta's own option list, so the two cannot drift. */
function choicesFor(id: string): SegmentedOption[] {
  const spec = props.meta.options?.find((option) => option.id === id);
  if (!spec || spec.kind !== "select") return [];
  return (spec.options ?? []).map((option) => ({ value: option.value, label: option.label }));
}

const modeChoices = computed<SegmentedOption[]>(() => {
  const listed = choicesFor("mode").filter((option) =>
    MODE_FALLBACK.some((choice) => choice.value === option.value),
  );
  return listed.length > 0 ? listed : MODE_FALLBACK;
});

/** The label a page's enhancement mode carries in the strip. */
function modeLabel(value: EnhanceMode): string {
  return (
    modeChoices.value.find((choice) => choice.value === value)?.label ??
    MODE_FALLBACK.find((choice) => choice.value === value)?.label ??
    value
  );
}

const scaleChoices = computed<SegmentedOption[]>(() => choicesFor("scale"));
const formatChoices = computed<SegmentedOption[]>(() => choicesFor("format"));
const pdfPageChoices = computed<SegmentedOption[]>(() => choicesFor("pdfPage"));

/* ---------------------------------------------------------------- */
/* loading a photo                                                   */
/* ---------------------------------------------------------------- */

function describeProblem(e: unknown): { message: string; fix?: string } {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

function imageDataFrom(canvas: HTMLCanvasElement): ScanImage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new ToolError(
      "no-canvas",
      "This browser did not give the page a 2D canvas to work with.",
      "Try another browser, or a window that is not running with canvas disabled.",
    );
  }
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: data.data, width: data.width, height: data.height };
}

function decodeFile(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      URL.revokeObjectURL(url);
      if (width === 0 || height === 0) {
        reject(
          new ToolError(
            "decode-failed",
            "That file could not be decoded as an image.",
            "Try a PNG, JPEG, WebP, GIF, or BMP photo.",
          ),
        );
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        reject(new ToolError("no-canvas", "This browser did not give the page a 2D canvas."));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new ToolError(
          "decode-failed",
          "That file could not be decoded as an image.",
          "Try a PNG, JPEG, WebP, GIF, or BMP photo.",
        ),
      );
    };
    img.src = url;
  });
}

/** Hand the page a fresh photo: measure the view, detect, draw. */
function setSource(canvas: HTMLCanvasElement, name: string, size: number): void {
  sourceCanvas.value = canvas;
  source.value = imageDataFrom(canvas);
  fileName.value = name;
  fileSize.value = size;
  savedNote.value = "";
  measureView();
  redetect();
}

async function readFile(file: File): Promise<void> {
  busy.value = true;
  busyLabel.value = "Reading the photo";
  problem.value = null;
  try {
    const canvas = await decodeFile(file);
    setSource(canvas, file.name, file.size);
  } catch (e) {
    problem.value = describeProblem(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event): void {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  void readFile(file).then(() => {
    picker.value = "";
  });
}

function onPaste(e: ClipboardEvent): void {
  const item = Array.from(e.clipboardData?.items ?? []).find((entry) =>
    entry.type.startsWith("image/"),
  );
  const file = item?.getAsFile();
  if (file) {
    e.preventDefault();
    void readFile(file);
  }
}

function clearSource(): void {
  source.value = null;
  sourceCanvas.value = null;
  fileName.value = "";
  fileSize.value = 0;
  detectionFailed.value = true;
  confidence.value = 0;
  cornersEdited.value = false;
  problem.value = null;
}

/* ---------------------------------------------------------------- */
/* camera                                                            */
/* ---------------------------------------------------------------- */

function describeCameraError(e: unknown): { message: string; fix?: string } {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message: "The camera permission was declined, so no frame could be captured.",
      fix: "Allow the camera for this page in your browser, or drop a photo instead.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      message: "No camera was found on this device.",
      fix: "Drop a photo of the document or pick one from your files instead.",
    };
  }
  return {
    message: `The camera could not be started: ${e instanceof Error ? e.message : String(e)}`,
    fix: "Drop a photo of the document or pick one from your files instead.",
  };
}

async function startCamera(): Promise<void> {
  problem.value = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    problem.value = describeCameraError(new DOMException("", "NotFoundError"));
    return;
  }
  cameraStarting.value = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    cameraOn.value = true;
    // The element only exists once cameraOn flips, so wait a frame for it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const video = videoEl.value;
    if (!video) {
      stopCamera();
      return;
    }
    video.srcObject = stream;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    });
    await video.play();
  } catch (e) {
    problem.value = describeCameraError(e);
    stopCamera();
  } finally {
    cameraStarting.value = false;
  }
}

function stopCamera(): void {
  if (videoEl.value) videoEl.value.srcObject = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  cameraOn.value = false;
}

function captureFrame(): void {
  const video = videoEl.value;
  if (!video) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    problem.value = {
      message: "The camera has not produced a frame yet.",
      fix: "Give it a moment and press Capture again.",
    };
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, width, height);
  // Stop first: the frame is already copied, and holding the camera open past
  // the capture is the classic way one of these tools leaves a light on.
  stopCamera();
  try {
    setSource(canvas, "camera-capture.png", 0);
  } catch (e) {
    problem.value = describeProblem(e);
  }
}

/* ---------------------------------------------------------------- */
/* detection and the working view                                    */
/* ---------------------------------------------------------------- */

function redetect(): void {
  const image = source.value;
  if (!image) return;
  try {
    const result = detectCorners(image);
    corners.value = result.corners;
    confidence.value = result.confidence;
    detectionFailed.value = result.fallback;
    cornersEdited.value = false;
    selectedCorner.value = 0;
    schedulePreview();
    redraw();
  } catch (e) {
    problem.value = describeProblem(e);
  }
}

function resetCorners(): void {
  const image = source.value;
  if (!image) return;
  corners.value = fallbackQuad(image.width, image.height);
  confidence.value = 0;
  detectionFailed.value = true;
  cornersEdited.value = false;
  schedulePreview();
  redraw();
}

function measureView(): void {
  const image = source.value;
  if (!image) return;
  const available = Math.min(containerWidth.value || MAX_VIEW_WIDTH, MAX_VIEW_WIDTH);
  const byWidth = available / image.width;
  const byHeight = MAX_VIEW_HEIGHT / image.height;
  const factor = Math.min(byWidth, byHeight, 1);
  viewWidth.value = Math.max(1, Math.round(image.width * factor));
  viewHeight.value = Math.max(1, Math.round(image.height * factor));
  redraw();
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function toView(point: Point): Point {
  return { x: point.x * viewScale.value, y: point.y * viewScale.value };
}

function redraw(): void {
  const canvas = canvasEl.value;
  const image = sourceCanvas.value;
  if (!canvas || !image || viewWidth.value === 0) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const backingWidth = Math.round(viewWidth.value * ratio);
  const backingHeight = Math.round(viewHeight.value * ratio);
  // Only resize when it really changed: assigning width reallocates the backing
  // store, and a drag redraws on every pointer move.
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${viewWidth.value}px`;
    canvas.style.height = `${viewHeight.value}px`;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, viewWidth.value, viewHeight.value);
  ctx.drawImage(image, 0, 0, viewWidth.value, viewHeight.value);

  const primary = cssVar("--primary", "#5b4bd6");
  const card = cssVar("--card", "#ffffff");
  const view = corners.value.map(toView);

  // Everything outside the quad reads as trimmed away.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewWidth.value, viewHeight.value);
  ctx.moveTo(view[0]!.x, view[0]!.y);
  for (let i = 1; i < 4; i += 1) ctx.lineTo(view[i]!.x, view[i]!.y);
  ctx.closePath();
  ctx.fillStyle = "rgba(12, 10, 9, 0.45)";
  ctx.fill("evenodd");
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(view[0]!.x, view[0]!.y);
  for (let i = 1; i < 4; i += 1) ctx.lineTo(view[i]!.x, view[i]!.y);
  ctx.closePath();
  ctx.strokeStyle = primary;
  ctx.lineWidth = 2;
  ctx.stroke();

  for (let i = 0; i < 4; i += 1) {
    const point = view[i]!;
    const active = activeCorner.value === i || selectedCorner.value === i;
    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 10 : 7, 0, Math.PI * 2);
    ctx.fillStyle = card;
    ctx.fill();
    ctx.strokeStyle = primary;
    ctx.lineWidth = active ? 3 : 2;
    ctx.stroke();
  }

  if (activeCorner.value !== null) drawLoupe(ctx, corners.value[activeCorner.value]!);
}

/** A magnified crop around the handle being dragged, so a thumb can be precise. */
function drawLoupe(ctx: CanvasRenderingContext2D, corner: Point): void {
  const image = sourceCanvas.value;
  if (!image) return;
  const at = toView(corner);

  let cx = at.x + LOUPE_RADIUS + 28;
  let cy = at.y - LOUPE_RADIUS - 28;
  if (cx + LOUPE_RADIUS > viewWidth.value) cx = at.x - LOUPE_RADIUS - 28;
  if (cy - LOUPE_RADIUS < 0) cy = at.y + LOUPE_RADIUS + 28;
  cx = Math.min(Math.max(cx, LOUPE_RADIUS + 2), viewWidth.value - LOUPE_RADIUS - 2);
  cy = Math.min(Math.max(cy, LOUPE_RADIUS + 2), viewHeight.value - LOUPE_RADIUS - 2);

  const span = (LOUPE_RADIUS * 2) / (viewScale.value * LOUPE_ZOOM);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = cssVar("--card", "#ffffff");
  ctx.fill();
  ctx.clip();
  ctx.drawImage(
    image,
    corner.x - span / 2,
    corner.y - span / 2,
    span,
    span,
    cx - LOUPE_RADIUS,
    cy - LOUPE_RADIUS,
    LOUPE_RADIUS * 2,
    LOUPE_RADIUS * 2,
  );
  const primary = cssVar("--primary", "#5b4bd6");
  ctx.strokeStyle = primary;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - LOUPE_RADIUS, cy);
  ctx.lineTo(cx + LOUPE_RADIUS, cy);
  ctx.moveTo(cx, cy - LOUPE_RADIUS);
  ctx.lineTo(cx, cy + LOUPE_RADIUS);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = cssVar("--primary", "#5b4bd6");
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ---------------------------------------------------------------- */
/* dragging the corners                                              */
/* ---------------------------------------------------------------- */

/**
 * A candidate quad is accepted only when it stays a real quadrilateral: no two
 * corners within `MIN_CORNER_GAP` image pixels, and the outline still convex in
 * its current order. Refusing the move is friendlier than letting the drag fold
 * the page and then failing at export time.
 */
function isUsableQuad(quad: Quad): boolean {
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      if (Math.hypot(quad[i]!.x - quad[j]!.x, quad[i]!.y - quad[j]!.y) < MIN_CORNER_GAP) {
        return false;
      }
    }
  }
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

function moveCorner(index: number, x: number, y: number): void {
  const image = source.value;
  if (!image) return;
  const candidate = corners.value.map((point, i) =>
    i === index
      ? {
          x: Math.min(Math.max(x, 0), image.width),
          y: Math.min(Math.max(y, 0), image.height),
        }
      : point,
  ) as Quad;
  if (!isUsableQuad(candidate)) return;
  corners.value = candidate;
  cornersEdited.value = true;
  schedulePreview();
  redraw();
}

function pointerToImage(e: PointerEvent): Point | null {
  const canvas = canvasEl.value;
  if (!canvas || !source.value) return null;
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const scaleX = source.value.width / box.width;
  const scaleY = source.value.height / box.height;
  return { x: (e.clientX - box.left) * scaleX, y: (e.clientY - box.top) * scaleY };
}

function onPointerDown(e: PointerEvent): void {
  const canvas = canvasEl.value;
  const point = pointerToImage(e);
  if (!canvas || !point) return;

  // Hit testing happens in screen pixels: the canvas is drawn scaled down, so a
  // radius in image pixels would be unreachable on a large photo.
  const box = canvas.getBoundingClientRect();
  const perImagePixel = box.width / (source.value?.width ?? 1);
  const radius = GRAB_RADIUS / Math.max(perImagePixel, 0.0001);

  let nearest = -1;
  let best = radius;
  corners.value.forEach((corner, index) => {
    const away = Math.hypot(corner.x - point.x, corner.y - point.y);
    if (away <= best) {
      best = away;
      nearest = index;
    }
  });
  if (nearest === -1) return;

  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
  activeCorner.value = nearest;
  selectedCorner.value = nearest;
  redraw();
}

function onPointerMove(e: PointerEvent): void {
  if (activeCorner.value === null) return;
  const point = pointerToImage(e);
  if (!point) return;
  e.preventDefault();
  moveCorner(activeCorner.value, point.x, point.y);
}

function onPointerUp(e: PointerEvent): void {
  if (activeCorner.value === null) return;
  canvasEl.value?.releasePointerCapture(e.pointerId);
  activeCorner.value = null;
  redraw();
}

function onCanvasKeydown(e: KeyboardEvent): void {
  if (!source.value) return;
  const step = e.shiftKey ? 10 : 1;
  const index = selectedCorner.value;
  const corner = corners.value[index]!;
  const keys: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (e.key in keys) {
    e.preventDefault();
    const [dx, dy] = keys[e.key]!;
    moveCorner(index, corner.x + dx, corner.y + dy);
    return;
  }
  if (["1", "2", "3", "4"].includes(e.key)) {
    e.preventDefault();
    selectedCorner.value = Number(e.key) - 1;
    redraw();
  }
}

/* ---------------------------------------------------------------- */
/* preview and pages                                                 */
/* ---------------------------------------------------------------- */

function putOnCanvas(image: ScanImage, canvas: HTMLCanvasElement): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // The copy is what keeps the types honest: ImageData wants an ArrayBuffer
  // backed array, and it is also what canvas would do internally anyway.
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
}

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => drawPreview(), 90);
}

function drawPreview(): void {
  const image = source.value;
  const canvas = previewEl.value;
  if (!image || !canvas) return;
  try {
    const full = outputSize(corners.value, 96 * scaleNumber.value);
    const shrink = Math.min(1, PREVIEW_EDGE / Math.max(full.width, full.height));
    const width = Math.max(16, Math.round(full.width * shrink));
    const height = Math.max(16, Math.round(full.height * shrink));
    const flattened = warpImage(image, corners.value, width, height);
    putOnCanvas(enhance(flattened, mode.value), canvas);
  } catch (e) {
    problem.value = describeProblem(e);
  }
}

/** Let the browser paint the busy state before a long synchronous warp. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function thumbnailOf(canvas: HTMLCanvasElement): string {
  const thumb = document.createElement("canvas");
  const width = 120;
  thumb.width = width;
  thumb.height = Math.max(1, Math.round((canvas.height / canvas.width) * width));
  const ctx = thumb.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/jpeg", 0.7);
}

async function addPage(): Promise<void> {
  const image = source.value;
  if (!image || busy.value) return;
  busy.value = true;
  busyLabel.value = "Flattening the page";
  problem.value = null;
  await yieldToPaint();
  try {
    const size = outputSize(corners.value, 96 * scaleNumber.value);
    const flattened = warpImage(image, corners.value, size.width, size.height);
    const cleaned = enhance(flattened, mode.value);
    const canvas = document.createElement("canvas");
    putOnCanvas(cleaned, canvas);
    pages.value = [
      ...pages.value,
      {
        id: nextPageId,
        canvas,
        width: cleaned.width,
        height: cleaned.height,
        thumb: thumbnailOf(canvas),
        mode: mode.value,
      },
    ];
    nextPageId += 1;
    savedNote.value = `Page ${pages.value.length} added, ${cleaned.width} x ${cleaned.height} px.`;
  } catch (e) {
    problem.value = describeProblem(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

function movePage(index: number, delta: number): void {
  const next = index + delta;
  if (next < 0 || next >= pages.value.length) return;
  const list = [...pages.value];
  const [moved] = list.splice(index, 1);
  if (moved) list.splice(next, 0, moved);
  pages.value = list;
}

function removePage(id: number): void {
  pages.value = pages.value.filter((page) => page.id !== id);
}

function clearPages(): void {
  pages.value = [];
  savedNote.value = "";
}

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function baseName(): string {
  const raw = fileName.value.replace(/\.[^./\\]+$/, "").trim();
  return raw || "scan";
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(
              new ToolError(
                "encode-failed",
                "This browser could not encode the scanned page.",
                "Try a smaller output size, or another browser.",
              ),
            ),
      type,
      quality,
    );
  });
}

async function downloadPage(page: ScannedPage, index: number): Promise<void> {
  busy.value = true;
  busyLabel.value = "Encoding the page";
  try {
    const jpeg = singleFormat.value === "jpeg";
    const blob = await canvasToBlob(
      page.canvas,
      jpeg ? "image/jpeg" : "image/png",
      jpeg ? 0.9 : undefined,
    );
    const name = `${baseName()}-page-${index + 1}.${jpeg ? "jpg" : "png"}`;
    downloadBlob(blob, name);
    savedNote.value = `Saved ${name}, ${formatBytes(blob.size)}.`;
  } catch (e) {
    problem.value = describeProblem(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

async function downloadPdf(): Promise<void> {
  if (pages.value.length === 0 || busy.value) return;
  busy.value = true;
  problem.value = null;
  try {
    const encoded: Array<{ bytes: Uint8Array; width: number; height: number }> = [];
    for (let i = 0; i < pages.value.length; i += 1) {
      const page = pages.value[i]!;
      busyLabel.value = `Encoding page ${i + 1} of ${pages.value.length}`;
      // One page at a time, with a yield in between, so a ten page stack does
      // not freeze the tab while it encodes.
      await yieldToPaint();
      const blob = await canvasToBlob(page.canvas, "image/jpeg", PDF_JPEG_QUALITY);
      encoded.push({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: page.width,
        height: page.height,
      });
    }
    busyLabel.value = "Building the PDF";
    const bytes = await buildScanPdf(encoded, {
      fit: pdfPage.value,
      pixelsPerInch: PDF_DENSITY,
    });
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
    const name = `${baseName()}.pdf`;
    downloadBlob(blob, name);
    savedNote.value = `Saved ${name}, ${pages.value.length} page${
      pages.value.length === 1 ? "" : "s"
    }, ${formatBytes(blob.size)}.`;
  } catch (e) {
    problem.value = describeProblem(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

watch([mode, scale], () => schedulePreview());

onMounted(() => {
  window.addEventListener("paste", onPaste);
  const stage = stageEl.value;
  if (stage) {
    containerWidth.value = stage.clientWidth || MAX_VIEW_WIDTH;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width > 0) {
          containerWidth.value = width;
          measureView();
        }
      });
      resizeObserver.observe(stage);
    }
  }
});

onUnmounted(() => {
  window.removeEventListener("paste", onPaste);
  clearTimeout(previewTimer);
  resizeObserver?.disconnect();
  resizeObserver = null;
  // A camera that survives a navigation is the bug this tool must never ship.
  stopCamera();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Source -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Photo of the page
        </span>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="fileInput?.click()">Open file…</Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="cameraStarting || cameraOn"
            @click="startCamera"
          >
            <Camera class="size-3.5" />
            {{ cameraStarting ? "Starting…" : "Use camera" }}
          </Button>
          <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
        </div>
      </div>

      <div v-if="hasImage" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span v-if="fileSize" class="shrink-0 text-muted-foreground">
            {{ formatBytes(fileSize) }}
          </span>
          <button
            type="button"
            aria-label="Remove photo"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearSource"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
        Drop a photo of a document here, paste one from the clipboard, or start the camera and
        capture a frame. The tool finds the page, straightens it, and stacks the results into a PDF.
        Everything runs in this tab: your files and inputs never leave your device.
      </p>
    </div>

    <!-- Camera -->
    <div
      v-if="cameraOn"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Camera
      </span>
      <video
        ref="videoEl"
        class="max-h-[360px] w-full rounded-[8px] bg-background object-contain"
        playsinline
        muted
      />
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" @click="captureFrame">Capture frame</Button>
        <Button variant="ghost" size="sm" @click="stopCamera">Stop camera</Button>
        <span class="text-xs text-muted-foreground">
          The camera stops as soon as a frame is captured. Nothing is recorded.
        </span>
      </div>
    </div>

    <p
      v-if="problem"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <span class="font-medium text-destructive">{{ problem.message }}</span>
      <span v-if="problem.fix" class="mt-1 block text-muted-foreground">{{ problem.fix }}</span>
    </p>

    <!-- Working view -->
    <div v-show="hasImage" class="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div ref="stageEl" class="flex min-w-0 flex-col gap-2">
        <canvas
          ref="canvasEl"
          tabindex="0"
          class="block max-w-full touch-none rounded-[10px] shadow-[var(--sh-inset)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :class="activeCorner !== null ? 'cursor-grabbing' : 'cursor-grab'"
          aria-label="Page corners. Drag a handle, or press 1 to 4 to pick a corner and use the arrow keys."
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @keydown="onCanvasKeydown"
        />

        <div class="flex flex-wrap items-center gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-xs font-medium"
            :class="
              detectionFailed
                ? 'bg-secondary text-muted-foreground'
                : 'bg-[var(--accent-soft)] text-foreground'
            "
          >
            {{ confidenceLabel }}
          </span>
          <Button variant="outline" size="sm" @click="redetect">
            <RefreshCw class="size-3.5" />
            Re-detect
          </Button>
          <Button variant="ghost" size="sm" @click="resetCorners">Reset corners</Button>
        </div>

        <p class="text-xs text-muted-foreground">
          <template v-if="detectionFailed && !cornersEdited">
            No page stood out from the background, so these corners are a starting guess, not a
            detection. Drag each handle onto a corner of the document.
          </template>
          <template v-else>
            Drag any handle that landed in the wrong place. A magnifier follows the handle you are
            holding.
          </template>
          Keyboard: focus the image, press 1 to 4 to pick
          {{ CORNER_NAMES.join(", ").toLowerCase() }}, then use the arrow keys, or hold Shift to
          move ten pixels at a time.
        </p>
      </div>

      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Flattened page
          </span>
          <div class="grid place-items-center rounded-[8px] bg-background p-2">
            <canvas
              ref="previewEl"
              class="max-h-[300px] max-w-full rounded-[6px] shadow-[var(--sh-sm)]"
              aria-label="Preview of the flattened page"
            />
          </div>
          <p v-if="targetSize" class="font-mono text-xs text-muted-foreground tabular-nums">
            Output {{ targetSize.width }} x {{ targetSize.height }} px. The preview is a smaller
            copy of the same math.
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-xs text-muted-foreground">Enhancement</span>
          <Segmented
            :model-value="mode"
            :options="modeChoices"
            label="Enhancement mode"
            size="sm"
            @update:model-value="(value) => (mode = value as EnhanceMode)"
          />
        </div>

        <div v-if="scaleChoices.length" class="flex flex-col gap-2">
          <span class="text-xs text-muted-foreground">Output size</span>
          <Segmented
            :model-value="scale"
            :options="scaleChoices"
            label="Output size"
            size="sm"
            @update:model-value="(value) => (scale = value)"
          />
        </div>

        <Button class="self-start" :disabled="busy" @click="addPage">
          {{ busy ? "Working…" : "Add page" }}
        </Button>
      </div>
    </div>

    <!-- Pages -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Pages ({{ pages.length }})
        </span>
        <Button variant="ghost" size="sm" :disabled="pages.length === 0" @click="clearPages">
          Clear all
        </Button>
      </div>

      <ul v-if="pages.length" class="flex flex-wrap gap-3">
        <li
          v-for="(page, index) in pages"
          :key="page.id"
          class="flex w-32 flex-col gap-1.5 rounded-[10px] border bg-card p-2 shadow-[var(--sh-sm)]"
        >
          <img
            :src="page.thumb"
            :alt="`Page ${index + 1}`"
            class="w-full rounded-[6px] bg-background object-contain"
          />
          <span class="font-mono text-[11px] text-muted-foreground tabular-nums">
            {{ index + 1 }}. {{ page.width }} x {{ page.height }}
          </span>
          <span class="text-[11px] text-muted-foreground">{{ modeLabel(page.mode) }}</span>
          <div class="flex items-center gap-0.5">
            <button
              type="button"
              :aria-label="`Move page ${index + 1} earlier`"
              :disabled="index === 0"
              class="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40"
              @click="movePage(index, -1)"
            >
              <ArrowLeft class="size-3.5" />
            </button>
            <button
              type="button"
              :aria-label="`Move page ${index + 1} later`"
              :disabled="index === pages.length - 1"
              class="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40"
              @click="movePage(index, 1)"
            >
              <ArrowRight class="size-3.5" />
            </button>
            <button
              type="button"
              :aria-label="`Download page ${index + 1}`"
              class="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="downloadPage(page, index)"
            >
              <Download class="size-3.5" />
            </button>
            <button
              type="button"
              :aria-label="`Remove page ${index + 1}`"
              class="ml-auto grid size-6 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="removePage(page.id)"
            >
              <Trash2 class="size-3.5" />
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="text-xs text-muted-foreground">
        No pages yet. Line up the corners on a photo and press Add page. Load the next photo and add
        it the same way to build a multi-page document.
      </p>
    </div>

    <!-- Export -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Export
      </span>

      <div class="flex flex-wrap items-end gap-4">
        <div v-if="formatChoices.length" class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Single page format</span>
          <Segmented
            :model-value="singleFormat"
            :options="formatChoices"
            label="Single page format"
            size="sm"
            @update:model-value="(value) => (singleFormat = value === 'jpeg' ? 'jpeg' : 'png')"
          />
        </div>

        <div v-if="pdfPageChoices.length" class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">PDF page size</span>
          <Segmented
            :model-value="pdfPage"
            :options="pdfPageChoices"
            label="PDF page size"
            size="sm"
            @update:model-value="
              (value) => (pdfPage = value === 'letter' || value === 'a4' ? value : 'image')
            "
          />
        </div>

        <Button :disabled="pages.length === 0 || busy" class="mb-0.5" @click="downloadPdf">
          <Download class="size-3.5" />
          Save PDF ({{ pages.length }} {{ pages.length === 1 ? "page" : "pages" }})
        </Button>
      </div>

      <p v-if="busy && busyLabel" class="font-mono text-xs text-muted-foreground tabular-nums">
        {{ busyLabel }}…
      </p>
      <p v-else-if="savedNote" class="font-mono text-xs text-muted-foreground tabular-nums">
        {{ savedNote }}
      </p>

      <p class="text-xs text-muted-foreground">
        Each PDF page holds a JPEG copy of the flattened scan. Detection, the perspective warp, the
        cleanup, and the PDF assembly all run in this tab: your files and inputs never leave your
        device. The pages live in memory only, so closing the tab discards them.
      </p>
    </div>
  </div>
</template>
