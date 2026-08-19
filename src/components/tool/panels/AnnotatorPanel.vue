<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Copy, Download, Redo2, Trash2, Undo2, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  ANNOTATION_KINDS,
  DEFAULT_COLORS,
  DEFAULT_FONT_SIZE,
  HIGHLIGHT_COLOR,
  blurRegionRgba,
  createAnnotation,
  hitTest,
  moveAnnotation,
  nextCalloutNumber,
  normalizeRect,
  parseDoc,
  pixelateRegionRgba,
  renderSvgOverlay,
  serializeDoc,
  type Annotation,
  type AnnotationDoc,
  type AnnotationKind,
  type Point,
} from "@/tools/screenshot-annotator/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";

/**
 * Bespoke panel for the screenshot annotator. The generic ToolShell has no way
 * to express "draw an arrow on this picture", so the tool gets its own island.
 *
 * The split follows the rest of the codebase: the pure module owns what an
 * annotation is, how it is drawn as SVG, and how a blur region is burned into a
 * pixel buffer. This component owns the decoded image, the pointer, the
 * keyboard, and the export.
 *
 * Three invariants keep the preview and the export identical:
 *   1. The decoded ImageData is never mutated. Every repaint starts from it and
 *      replays the blur regions in document order, so overlapping blurs compose
 *      the same way they will in the file.
 *   2. The overlay on screen and the overlay in the export come from the same
 *      renderSvgOverlay call, minus the committed blur items, whose hatched
 *      placeholders would otherwise be burned in on top of the real blur.
 *   3. The export is rebuilt on a fresh canvas rather than copied off the
 *      preview, so the selection outline can never reach the file.
 *
 * Nothing is written to the URL or to storage: the document only means anything
 * next to the image it was drawn on, and the image stays in this tab.
 */
defineProps<{ meta: ToolMeta }>();

type ToolChoice = "select" | AnnotationKind;

/** Snapshots kept for undo. Fifty is far past what anyone walks back by hand. */
const HISTORY_CAP = 50;
/** Image pixels a drag must cover before it counts as a shape and not a stray click. */
const MIN_DRAG = 3;
const STROKE_WIDTHS = [2, 4, 6] as const;
const JPEG_QUALITY = 0.92;

const TOOL_CHOICES: ToolChoice[] = ["select", ...ANNOTATION_KINDS];

const TOOL_LABELS: Record<ToolChoice, string> = {
  select: "Select",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  text: "Text",
  callout: "Callout",
  blur: "Blur",
  highlight: "Highlight",
  freehand: "Freehand",
};

/** The shortcut row the logic layer advertises, and nothing beyond it. */
const TOOL_KEYS: Partial<Record<ToolChoice, string>> = {
  arrow: "A",
  rect: "R",
  ellipse: "E",
  text: "T",
  callout: "C",
  blur: "B",
  highlight: "H",
  freehand: "F",
};

const KEY_TO_TOOL: Record<string, AnnotationKind> = {
  a: "arrow",
  r: "rect",
  e: "ellipse",
  t: "text",
  c: "callout",
  b: "blur",
  h: "highlight",
  f: "freehand",
};

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileName = ref("");
const fileSize = ref(0);
const decodeFailed = ref(false);
const busy = ref(false);
const dragging = ref(false);

const canvas = ref<HTMLCanvasElement>();
const fileInput = ref<HTMLInputElement>();
const textInput = ref<HTMLInputElement>();

/** The decoded screenshot, never mutated. Every repaint starts from a copy. */
const pristine = shallowRef<ImageData | null>(null);
const imgWidth = ref(0);
const imgHeight = ref(0);

const doc = ref<AnnotationDoc>({ width: 0, height: 0, items: [] });
const selectedId = ref<string | null>(null);

const tool = ref<ToolChoice>("arrow");
const color = ref<string>(DEFAULT_COLORS[0] ?? "#e5484d");
const strokeWidth = ref<number>(4);
const fontSize = ref<number>(DEFAULT_FONT_SIZE);

const blurStyle = ref<"blur" | "pixelate">("blur");
const blurRadius = ref(10);
const pixelBlock = ref(12);
const format = ref<"png" | "jpeg">("png");

/** The shape being dragged right now. Rendered, never in the document. */
const pending = ref<Annotation | null>(null);
const drawing = ref(false);
const moving = ref(false);

/** Where a text label is about to go, and what has been typed into it so far. */
const textDraft = ref<Point | null>(null);
const textValue = ref("");

const exportedName = ref("");
const exportedSize = ref<number | null>(null);
const copyNote = ref("");
const clipboardSupported = ref(false);

/* Drag bookkeeping that Vue has no reason to track. */
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;
let strokePoints: Point[] = [];
let moveSnapshot: Annotation | null = null;
let moveStart: Point | null = null;
let movedDuringDrag = false;

const history = ref<string[]>([]);
const historyIndex = ref(-1);

const hasImage = computed(() => pristine.value !== null);
const itemCount = computed(() => doc.value.items.length);
const canUndo = computed(() => historyIndex.value > 0);
const canRedo = computed(() => historyIndex.value < history.value.length - 1);
const selectedItem = computed(
  () => doc.value.items.find((item) => item.id === selectedId.value) ?? null,
);

/* ---------------------------------------------------------------- */
/* overlay                                                           */
/* ---------------------------------------------------------------- */

/**
 * The overlay skips committed blur regions: their pixels are already destroyed
 * on the base canvas, and the hatched rectangle the renderer draws for them is
 * a "the blur goes here" placeholder, not the effect. A blur still being
 * dragged keeps its hatch, which is the only preview of where it will land.
 */
function overlayItems(includePending: boolean): Annotation[] {
  const items = doc.value.items.filter((item) => item.kind !== "blur");
  const preview = includePending ? pending.value : null;
  return preview ? [...items, preview] : items;
}

const overlaySvg = computed(() => {
  if (!hasImage.value) return "";
  return renderSvgOverlay({
    width: doc.value.width,
    height: doc.value.height,
    items: overlayItems(true),
  });
});

/** Percent geometry, so the boxes track the canvas at whatever size CSS gives it. */
const selectionStyle = computed(() => {
  const item = selectedItem.value;
  const w = doc.value.width;
  const h = doc.value.height;
  if (!item || w <= 0 || h <= 0) return undefined;
  return {
    left: `${(item.x / w) * 100}%`,
    top: `${(item.y / h) * 100}%`,
    width: `${(Math.max(item.w, 2) / w) * 100}%`,
    height: `${(Math.max(item.h, 2) / h) * 100}%`,
  };
});

const textStyle = computed(() => {
  const draft = textDraft.value;
  const w = doc.value.width;
  const h = doc.value.height;
  if (!draft || w <= 0 || h <= 0) return undefined;
  return { left: `${(draft.x / w) * 100}%`, top: `${(draft.y / h) * 100}%` };
});

/* ---------------------------------------------------------------- */
/* base canvas                                                       */
/* ---------------------------------------------------------------- */

/**
 * The pristine pixels with every blur region applied, in document order. Each
 * pixel operation returns a fresh buffer and leaves its input alone, so the
 * chain never touches the decoded image.
 */
function baseImageData(): ImageData | null {
  const image = pristine.value;
  if (!image) return null;
  const regions = doc.value.items.filter((item) => item.kind === "blur");
  if (regions.length === 0) return image;

  let data: Uint8ClampedArray = image.data;
  for (const region of regions) {
    const rect = { x: region.x, y: region.y, w: region.w, h: region.h };
    data =
      blurStyle.value === "pixelate"
        ? pixelateRegionRgba(data, image.width, image.height, rect, pixelBlock.value)
        : blurRegionRgba(data, image.width, image.height, rect, blurRadius.value);
  }
  // Copied into a buffer of its own: ImageData will not take a view that might
  // be backed by a SharedArrayBuffer.
  return new ImageData(new Uint8ClampedArray(data), image.width, image.height);
}

function redrawBase() {
  const el = canvas.value;
  const image = pristine.value;
  if (!el || !image) return;
  // Assigning width or height clears the canvas, so only do it for a new image.
  if (el.width !== image.width) el.width = image.width;
  if (el.height !== image.height) el.height = image.height;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  const composed = baseImageData();
  if (composed) ctx.putImageData(composed, 0, 0);
}

/**
 * Repaint only when something a blur depends on changes. Watching the whole
 * document would re-run the two pass blur on every freehand pointer move.
 */
const blurSignature = computed(() =>
  JSON.stringify({
    style: blurStyle.value,
    radius: blurRadius.value,
    block: pixelBlock.value,
    regions: doc.value.items
      .filter((item) => item.kind === "blur")
      .map((item) => [item.x, item.y, item.w, item.h]),
  }),
);

watch(blurSignature, () => redrawBase());

/* ---------------------------------------------------------------- */
/* history                                                           */
/* ---------------------------------------------------------------- */

function pushHistory() {
  const snapshot = serializeDoc(doc.value);
  if (history.value[historyIndex.value] === snapshot) return;
  const trimmed = history.value.slice(0, historyIndex.value + 1);
  trimmed.push(snapshot);
  while (trimmed.length > HISTORY_CAP) trimmed.shift();
  history.value = trimmed;
  historyIndex.value = trimmed.length - 1;
}

function restore(index: number) {
  const snapshot = history.value[index];
  if (snapshot === undefined) return;
  try {
    doc.value = parseDoc(snapshot);
  } catch {
    // A snapshot this panel wrote always parses. If one ever did not, dropping
    // the step is better than tearing the editor down around the user.
    return;
  }
  historyIndex.value = index;
  if (selectedId.value && !doc.value.items.some((item) => item.id === selectedId.value)) {
    selectedId.value = null;
  }
  clearExportNote();
}

function undo() {
  if (canUndo.value) restore(historyIndex.value - 1);
}

function redo() {
  if (canRedo.value) restore(historyIndex.value + 1);
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function clearExportNote() {
  exportedName.value = "";
  exportedSize.value = null;
  copyNote.value = "";
}

function resetDoc(width: number, height: number) {
  doc.value = { width, height, items: [] };
  selectedId.value = null;
  pending.value = null;
  history.value = width > 0 && height > 0 ? [serializeDoc(doc.value)] : [];
  historyIndex.value = history.value.length - 1;
}

/** Decode through an object URL and read the pixels once. */
function decode(file: File): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx || w === 0 || h === 0) {
        decodeFailed.value = true;
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      ctx.drawImage(img, 0, 0);
      pristine.value = ctx.getImageData(0, 0, w, h);
      imgWidth.value = w;
      imgHeight.value = h;
      decodeFailed.value = false;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      pristine.value = null;
      imgWidth.value = 0;
      imgHeight.value = 0;
      decodeFailed.value = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

async function readFile(file: File) {
  busy.value = true;
  try {
    fileName.value = file.name;
    fileSize.value = file.size;
    cancelText();
    clearExportNote();
    await decode(file);
    resetDoc(imgWidth.value, imgHeight.value);
    await nextTick();
    redrawBase();
  } finally {
    busy.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  void readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearImage() {
  pristine.value = null;
  imgWidth.value = 0;
  imgHeight.value = 0;
  fileName.value = "";
  fileSize.value = 0;
  decodeFailed.value = false;
  cancelText();
  resetDoc(0, 0);
  clearExportNote();
  if (fileInput.value) fileInput.value.value = "";
}

/**
 * A screenshot is usually on the clipboard before anything on this page has
 * been clicked, so the listener sits on the window rather than on the panel
 * root, where focus would have to be inside it already. Typing targets are
 * skipped so pasting into the label box cannot swap the image out.
 */
function onPaste(e: ClipboardEvent) {
  if (isTypingTarget(e.target)) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const pasted = item.getAsFile();
      if (pasted) {
        e.preventDefault();
        void readFile(pasted);
        return;
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

/**
 * The canvas holds real image pixels and is scaled down by CSS to fit, so
 * pointer coordinates need the ratio between the two. Reading it per event
 * keeps it right across resizes and zoom without a resize observer.
 */
function pointIn(e: PointerEvent, el: HTMLCanvasElement): Point {
  const box = el.getBoundingClientRect();
  const scaleX = box.width > 0 ? imgWidth.value / box.width : 1;
  const scaleY = box.height > 0 ? imgHeight.value / box.height : 1;
  return { x: (e.clientX - box.left) * scaleX, y: (e.clientY - box.top) * scaleY };
}

/** Highlight always draws in marker yellow, which is what makes it read as a highlighter. */
function styleFor(kind: AnnotationKind) {
  return {
    color: kind === "highlight" ? HIGHLIGHT_COLOR : color.value,
    strokeWidth: strokeWidth.value,
    fontSize: fontSize.value,
  };
}

function buildPending(): Annotation | null {
  const kind = tool.value;
  const start = dragStart;
  if (kind === "select" || kind === "text" || !start) return null;
  const current = dragCurrent ?? start;

  try {
    if (kind === "freehand") {
      return createAnnotation("freehand", { points: strokePoints }, styleFor(kind));
    }
    if (kind === "arrow" || kind === "line") {
      return createAnnotation(kind, { points: [start, current] }, styleFor(kind));
    }

    const geometry = {
      x: start.x,
      y: start.y,
      w: current.x - start.x,
      h: current.y - start.y,
    };
    if (kind === "callout") {
      const box = normalizeRect(geometry);
      // A tapped callout has no box at all, so hand the renderer a bare point
      // and let it size the badge from the font size.
      const placed =
        box.w >= MIN_DRAG && box.h >= MIN_DRAG ? geometry : { x: start.x, y: start.y, w: 0, h: 0 };
      return createAnnotation("callout", placed, {
        ...styleFor(kind),
        number: nextCalloutNumber(doc.value),
      });
    }
    return createAnnotation(kind, geometry, styleFor(kind));
  } catch {
    // A degenerate drag is not worth an error state: there is simply nothing
    // to preview yet.
    return null;
  }
}

function tooSmall(item: Annotation): boolean {
  if (item.kind === "callout") return false;
  if (item.kind === "arrow" || item.kind === "line" || item.kind === "freehand") {
    // A straight horizontal line has no height, so either axis is enough.
    return item.w < MIN_DRAG && item.h < MIN_DRAG;
  }
  return item.w < MIN_DRAG || item.h < MIN_DRAG;
}

function addItem(item: Annotation) {
  doc.value = { ...doc.value, items: [...doc.value.items, item] };
  selectedId.value = item.id;
  pushHistory();
  clearExportNote();
}

function cancelDrag() {
  if (!drawing.value && !moving.value && !pending.value) return;
  drawing.value = false;
  moving.value = false;
  pending.value = null;
  dragStart = null;
  dragCurrent = null;
  strokePoints = [];
  // Put a half moved item back where it started.
  if (moveSnapshot) {
    const snapshot = moveSnapshot;
    doc.value = {
      ...doc.value,
      items: doc.value.items.map((item) => (item.id === snapshot.id ? snapshot : item)),
    };
  }
  moveSnapshot = null;
  moveStart = null;
  movedDuringDrag = false;
}

function onPointerDown(e: PointerEvent) {
  const el = canvas.value;
  if (!el || !hasImage.value) return;
  // A label box open over the canvas owns this click: commit it and stop.
  if (textDraft.value) {
    commitText();
    return;
  }
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  const p = pointIn(e, el);

  if (tool.value === "select") {
    const hit = hitTest(doc.value, p.x, p.y);
    selectedId.value = hit?.id ?? null;
    if (hit) {
      moving.value = true;
      moveSnapshot = hit;
      moveStart = p;
      movedDuringDrag = false;
    }
    return;
  }

  if (tool.value === "text") {
    void placeText(p);
    return;
  }

  drawing.value = true;
  dragStart = p;
  dragCurrent = p;
  // Seeded with two points because a polyline kind needs at least two to exist.
  strokePoints = [{ x: p.x, y: p.y }, p];
  pending.value = buildPending();
}

function onPointerMove(e: PointerEvent) {
  const el = canvas.value;
  if (!el) return;

  if (moving.value && moveSnapshot && moveStart) {
    const p = pointIn(e, el);
    const dx = p.x - moveStart.x;
    const dy = p.y - moveStart.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) movedDuringDrag = true;
    const next = moveAnnotation(moveSnapshot, dx, dy);
    doc.value = {
      ...doc.value,
      items: doc.value.items.map((item) => (item.id === next.id ? next : item)),
    };
    return;
  }

  if (!drawing.value || !dragStart) return;
  const p = pointIn(e, el);
  dragCurrent = p;
  if (tool.value === "freehand") {
    const last = strokePoints[strokePoints.length - 1];
    // Drop samples the pointer barely moved through, so a long stroke stays a
    // reasonable number of points instead of one per frame.
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 1.5) strokePoints.push(p);
  }
  pending.value = buildPending();
}

function onPointerUp(e: PointerEvent) {
  const el = canvas.value;
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

  if (moving.value) {
    moving.value = false;
    moveSnapshot = null;
    moveStart = null;
    if (movedDuringDrag) {
      pushHistory();
      clearExportNote();
    }
    movedDuringDrag = false;
    return;
  }

  if (!drawing.value) return;
  drawing.value = false;
  const item = pending.value;
  pending.value = null;
  dragStart = null;
  dragCurrent = null;
  strokePoints = [];
  if (item && !tooSmall(item)) addItem(item);
}

function onPointerCancel(e: PointerEvent) {
  const el = canvas.value;
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  cancelDrag();
}

/* ---------------------------------------------------------------- */
/* text labels                                                       */
/* ---------------------------------------------------------------- */

async function placeText(p: Point) {
  textDraft.value = { x: p.x, y: p.y };
  textValue.value = "";
  await nextTick();
  textInput.value?.focus();
}

function commitText() {
  const draft = textDraft.value;
  textDraft.value = null;
  const label = textValue.value.trim();
  textValue.value = "";
  if (!draft || !label) return;
  try {
    addItem(
      createAnnotation(
        "text",
        { x: draft.x, y: draft.y },
        {
          color: color.value,
          strokeWidth: strokeWidth.value,
          fontSize: fontSize.value,
          text: label,
        },
      ),
    );
  } catch {
    // createAnnotation only rejects geometry, which a click cannot get wrong.
  }
}

function cancelText() {
  textDraft.value = null;
  textValue.value = "";
}

/* ---------------------------------------------------------------- */
/* editing                                                           */
/* ---------------------------------------------------------------- */

function deleteSelected() {
  const id = selectedId.value;
  if (!id) return;
  const remaining = doc.value.items.filter((item) => item.id !== id);
  if (remaining.length === doc.value.items.length) return;
  doc.value = { ...doc.value, items: remaining };
  selectedId.value = null;
  pushHistory();
  clearExportNote();
}

function clearAll() {
  if (doc.value.items.length === 0) return;
  doc.value = { ...doc.value, items: [] };
  selectedId.value = null;
  pushHistory();
  clearExportNote();
}

function chooseTool(choice: ToolChoice) {
  if (textDraft.value) commitText();
  cancelDrag();
  tool.value = choice;
}

/* ---------------------------------------------------------------- */
/* keyboard                                                          */
/* ---------------------------------------------------------------- */

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function onKeydown(e: KeyboardEvent) {
  if (!hasImage.value) return;
  if (isTypingTarget(e.target)) return;

  const key = e.key.toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (key === "y") {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (e.altKey) return;

  if (e.key === "Escape") {
    cancelDrag();
    return;
  }

  if (e.key === "Delete" || e.key === "Backspace") {
    if (!selectedId.value) return;
    e.preventDefault();
    deleteSelected();
    return;
  }

  const kind = KEY_TO_TOOL[key];
  if (kind) {
    e.preventDefault();
    chooseTool(kind);
  }
}

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function canvasToBlob(el: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => el.toBlob(resolve, type, quality));
}

/** Rasterize the overlay through an object URL, the only way a canvas takes SVG. */
function rasterizeSvg(svg: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Build the flattened image on a canvas of its own: blurred base pixels first,
 * then the rasterized overlay on top. Nothing is copied off the preview, so the
 * selection outline and the in progress shape can never reach the file.
 */
async function buildExport(target: "png" | "jpeg"): Promise<HTMLCanvasElement | null> {
  const base = baseImageData();
  if (!base) return null;

  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  // putImageData ignores compositing, so the pixels go through a staging canvas
  // whenever something has to sit underneath them.
  const stage = document.createElement("canvas");
  stage.width = base.width;
  stage.height = base.height;
  const stageCtx = stage.getContext("2d");
  if (!stageCtx) return null;
  stageCtx.putImageData(base, 0, 0);

  if (target === "jpeg") {
    // JPEG has no alpha channel, so transparent areas would come out black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(stage, 0, 0);

  const items = overlayItems(false);
  if (items.length > 0) {
    const svg = renderSvgOverlay({ width: base.width, height: base.height, items });
    const raster = await rasterizeSvg(svg);
    if (raster) ctx.drawImage(raster, 0, 0, base.width, base.height);
  }

  return out;
}

function exportName(extension: string): string {
  const base =
    (fileName.value || "screenshot")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 60) || "screenshot";
  return `${base}-annotated.${extension}`;
}

async function downloadExport() {
  if (!hasImage.value) return;
  if (textDraft.value) commitText();
  busy.value = true;
  copyNote.value = "";
  try {
    const target = format.value;
    const out = await buildExport(target);
    if (!out) return;
    const blob = await canvasToBlob(
      out,
      target === "jpeg" ? "image/jpeg" : "image/png",
      target === "jpeg" ? JPEG_QUALITY : undefined,
    );
    if (!blob) return;
    const name = exportName(target === "jpeg" ? "jpg" : "png");
    downloadBlob(blob, name);
    exportedName.value = name;
    exportedSize.value = blob.size;
  } finally {
    busy.value = false;
  }
}

/**
 * The ClipboardItem has to be constructed with a promise inside the click
 * handler itself. Awaiting the blob first breaks the user gesture and Safari
 * rejects the write. PNG is the only image type browsers reliably accept.
 */
function copyToClipboard() {
  if (!hasImage.value || !clipboardSupported.value) return;
  if (textDraft.value) commitText();
  copyNote.value = "";
  const blobPromise = (async () => {
    const out = await buildExport("png");
    const blob = out ? await canvasToBlob(out, "image/png") : null;
    if (!blob) throw new Error("The browser could not encode the image.");
    return blob;
  })();

  navigator.clipboard
    .write([new ClipboardItem({ "image/png": blobPromise })])
    .then(() => {
      copyNote.value = "Copied the annotated image to the clipboard.";
    })
    .catch(() => {
      copyNote.value = "The browser blocked the clipboard write, so download the image instead.";
    });
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("paste", onPaste);
  clipboardSupported.value =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("paste", onPaste);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Screenshot
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()">Open file…</Button>
        <input ref="fileInput" type="file" class="hidden" accept="image/*" @change="onPickFile" />
      </div>

      <div v-if="hasImage || decodeFailed" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <button
            type="button"
            aria-label="Remove screenshot"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearImage"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <template v-else>
        <p class="px-3 pt-1 pb-2 text-sm text-muted-foreground">
          Drop a screenshot here, pick a file, or paste one from the clipboard, then draw on it.
          Everything runs in this tab: your files and inputs never leave your device.
        </p>
        <p class="px-3 pb-4 text-xs text-muted-foreground">
          Paste a screenshot with
          <kbd class="rounded-[8px] border bg-card px-1.5 py-0.5 font-mono text-[11px]">Ctrl+V</kbd>
          (Cmd+V on a Mac).
        </p>
      </template>
    </div>

    <p
      v-if="decodeFailed"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <span class="font-medium text-destructive"
        >This browser could not decode that file as an image.</span
      >
      <span class="mt-1 block text-muted-foreground">
        Try a PNG, JPEG, WebP, GIF, or BMP screenshot.
      </span>
    </p>

    <template v-if="hasImage">
      <!-- Toolbar -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Tools
        </span>
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Annotation tool">
          <Button
            v-for="choice in TOOL_CHOICES"
            :key="choice"
            type="button"
            size="sm"
            :variant="tool === choice ? 'default' : 'outline'"
            :aria-pressed="tool === choice"
            @click="chooseTool(choice)"
          >
            {{ TOOL_LABELS[choice] }}
            <span v-if="TOOL_KEYS[choice]" class="ml-1 font-mono text-[11px] opacity-70">
              {{ TOOL_KEYS[choice] }}
            </span>
          </Button>
        </div>

        <div class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-2" role="group" aria-label="Stroke color">
            <span class="text-xs text-muted-foreground">Color</span>
            <button
              v-for="swatch in DEFAULT_COLORS"
              :key="swatch"
              type="button"
              :aria-label="`Stroke color ${swatch}`"
              :aria-pressed="color === swatch"
              class="size-6 rounded-full border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="color === swatch ? 'ring-2 ring-ring ring-offset-1' : ''"
              :style="{ backgroundColor: swatch }"
              @click="color = swatch"
            />
          </div>

          <div class="flex items-center gap-2" role="group" aria-label="Stroke width">
            <span class="text-xs text-muted-foreground">Stroke</span>
            <Button
              v-for="width in STROKE_WIDTHS"
              :key="width"
              type="button"
              size="sm"
              :variant="strokeWidth === width ? 'default' : 'outline'"
              :aria-pressed="strokeWidth === width"
              @click="strokeWidth = width"
            >
              {{ width }} px
            </Button>
          </div>

          <div class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Label size: {{ fontSize }} px
            </span>
            <Slider
              aria-label="Label size in pixels"
              :model-value="[fontSize]"
              :min="8"
              :max="96"
              :step="1"
              class="py-2"
              @update:model-value="(v) => (fontSize = v?.[0] ?? fontSize)"
            />
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          Shortcuts: A arrow, R rect, E ellipse, T text, C callout, B blur, H highlight, F freehand,
          Delete removes the selection, Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo. Highlight always
          draws in marker yellow.
        </p>
      </div>

      <!-- Canvas -->
      <div class="flex flex-col items-center gap-2">
        <div class="relative inline-block max-w-full">
          <canvas
            ref="canvas"
            class="checker block h-auto max-h-[520px] w-auto max-w-full touch-none rounded-[10px] shadow-[var(--sh-inset)]"
            :class="tool === 'select' ? 'cursor-default' : 'cursor-crosshair'"
            aria-label="Annotation canvas. Pick a tool, then drag on the screenshot to draw."
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerCancel"
          />

          <!-- eslint-disable-next-line vue/no-v-html -- generated by our own logic layer from numeric annotation data, never user markup: renderSvgOverlay escapes every label it writes -->
          <div class="overlay" aria-hidden="true" v-html="overlaySvg" />

          <div
            v-if="selectionStyle"
            class="pointer-events-none absolute rounded-[4px] border border-dashed border-[var(--ring)]"
            :style="selectionStyle"
          />

          <input
            v-if="textDraft"
            ref="textInput"
            v-model="textValue"
            type="text"
            class="absolute z-10 w-44 rounded-[8px] border bg-card px-2 py-1 text-sm shadow-[var(--sh-md)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :style="textStyle"
            placeholder="Label text"
            aria-label="Label text"
            @keydown.enter.prevent="commitText"
            @keydown.esc.prevent="cancelText"
            @blur="commitText"
          />
        </div>

        <p class="text-xs text-muted-foreground tabular-nums">
          {{ imgWidth }} x {{ imgHeight }} px, {{ itemCount }} annotation{{
            itemCount === 1 ? "" : "s"
          }}. Escape cancels a drag. Enter commits a label, Escape discards it.
        </p>
      </div>

      <!-- Editing -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Edit
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" :disabled="!canUndo" @click="undo">
            <Undo2 class="size-3.5" />
            Undo
          </Button>
          <Button variant="outline" size="sm" :disabled="!canRedo" @click="redo">
            <Redo2 class="size-3.5" />
            Redo
          </Button>
          <Button variant="outline" size="sm" :disabled="!selectedItem" @click="deleteSelected">
            <Trash2 class="size-3.5" />
            Delete selected
          </Button>
          <Button variant="ghost" size="sm" :disabled="itemCount === 0" @click="clearAll">
            Clear all
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Pick Select, click a shape to select it, then drag to move it or press Delete to remove
          it. Callout badges number themselves in the order you place them.
        </p>
      </div>

      <!-- Blur -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Blur regions
        </span>
        <div class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-2" role="group" aria-label="Blur style">
            <span class="text-xs text-muted-foreground">Style</span>
            <Button
              type="button"
              size="sm"
              :variant="blurStyle === 'blur' ? 'default' : 'outline'"
              :aria-pressed="blurStyle === 'blur'"
              @click="blurStyle = 'blur'"
            >
              Blur
            </Button>
            <Button
              type="button"
              size="sm"
              :variant="blurStyle === 'pixelate' ? 'default' : 'outline'"
              :aria-pressed="blurStyle === 'pixelate'"
              @click="blurStyle = 'pixelate'"
            >
              Pixelate
            </Button>
          </div>

          <div v-if="blurStyle === 'blur'" class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Blur radius: {{ blurRadius }} px
            </span>
            <Slider
              aria-label="Blur radius in pixels"
              :model-value="[blurRadius]"
              :min="2"
              :max="40"
              :step="1"
              class="py-2"
              @update:model-value="(v) => (blurRadius = v?.[0] ?? blurRadius)"
            />
          </div>

          <div v-else class="flex min-w-48 flex-1 flex-col gap-1.5">
            <span class="text-xs text-muted-foreground tabular-nums">
              Block size: {{ pixelBlock }} px
            </span>
            <Slider
              aria-label="Pixelate block size in pixels"
              :model-value="[pixelBlock]"
              :min="4"
              :max="64"
              :step="1"
              class="py-2"
              @update:model-value="(v) => (pixelBlock = v?.[0] ?? pixelBlock)"
            />
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Blur and pixelate rewrite the pixels on the canvas, so the export carries the softened
          version and nothing else. Neither is true redaction: a trace of the original survives
          both. For a password or an account number, use the redaction tool and its solid fill.
        </p>
      </div>

      <!-- Export -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Export
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-2" role="group" aria-label="Export format">
            <Button
              type="button"
              size="sm"
              :variant="format === 'png' ? 'default' : 'outline'"
              :aria-pressed="format === 'png'"
              @click="format = 'png'"
            >
              PNG
            </Button>
            <Button
              type="button"
              size="sm"
              :variant="format === 'jpeg' ? 'default' : 'outline'"
              :aria-pressed="format === 'jpeg'"
              @click="format = 'jpeg'"
            >
              JPEG
            </Button>
          </div>
          <Button size="sm" :disabled="busy" @click="downloadExport">
            <Download class="size-3.5" />
            Download {{ format === "jpeg" ? "JPEG" : "PNG" }}
          </Button>
          <Button
            v-if="clipboardSupported"
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="copyToClipboard"
          >
            <Copy class="size-3.5" />
            Copy to clipboard
          </Button>
        </div>

        <p v-if="exportedName" class="font-mono text-xs text-muted-foreground tabular-nums">
          Saved {{ exportedName }}, {{ formatBytes(exportedSize ?? 0) }}.
        </p>
        <p v-if="copyNote" class="text-xs text-muted-foreground">{{ copyNote }}</p>

        <p class="text-xs text-muted-foreground">
          The export is rebuilt on a fresh canvas from the blurred pixels plus the annotation
          overlay, so the selection outline never reaches the file and no metadata from the original
          comes along with it. JPEG is written at quality 0.92 on a white background.
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The overlay lies exactly over the canvas and never takes the pointer. */
.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* The generated SVG carries its size in image pixels, so let it fill the box
   the canvas defines and let its own viewBox handle the scaling. */
.overlay :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

/* Checkerboard so transparent screenshots read as transparent, not as the surface. */
.checker {
  background-color: var(--card);
  background-image:
    linear-gradient(
      45deg,
      var(--secondary) 25%,
      transparent 25%,
      transparent 75%,
      var(--secondary) 75%
    ),
    linear-gradient(
      45deg,
      var(--secondary) 25%,
      transparent 25%,
      transparent 75%,
      var(--secondary) 75%
    );
  background-size: 16px 16px;
  background-position:
    0 0,
    8px 8px;
}
</style>
