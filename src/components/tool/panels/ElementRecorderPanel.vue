<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { CSSProperties } from "vue";
import { Crop, Download, MousePointerClick, Video, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import {
  DEFAULT_MIME_CANDIDATES,
  clampRegion,
  describeRecording,
  estimateBitrate,
  extForMime,
  fileName,
  patchWebmDuration,
  pickMimeType,
  qualityMultiplier,
  regionFromPoints,
  snapToElementRect,
  type CssRect,
  type Region,
} from "@/tools/element-recorder/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import OptionControl from "../OptionControl.vue";
import OutputView from "../OutputView.vue";
import ErrorBanner from "../ErrorBanner.vue";
import { Button } from "@/components/ui/button";

/**
 * Bespoke panel for the Element Recorder.
 *
 * The generic shell has no way to express "point at a thing on this page and
 * record only that", so this panel owns the two selection surfaces (a pick
 * overlay that highlights whatever the pointer is over, and a drag overlay for
 * a hand drawn rectangle) plus the whole capture pipeline: getDisplayMedia
 * with preferCurrentTab, Region Capture through CropTarget.fromElement when
 * the browser has it, a canvas crop fallback when it does not, MediaRecorder,
 * and the preview blob.
 *
 * Every number it computes comes from the pure layer (PROJECT.md rule 27):
 * regionFromPoints, clampRegion, snapToElementRect, pickMimeType, extForMime,
 * estimateBitrate, qualityMultiplier, fileName, patchWebmDuration, and
 * describeRecording. This file owns only the DOM and the browser APIs.
 *
 * Nothing reads window, document, or navigator until onMounted or a click
 * handler runs, so the server rendered island is inert. Every capture track is
 * stopped on unmount, which is what makes the browser's sharing bar go away.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

const quality = computed(() => String(opts.value.quality ?? "medium"));

const fps = computed(() => {
  const raw = Number(opts.value.fps);
  return Number.isFinite(raw) && raw > 0 ? Math.min(60, Math.max(5, Math.round(raw))) : 30;
});

const preferMp4 = computed(() => opts.value.format === "mp4-if-supported");

/* ------------------------------------------------------------------ *
 * browser APIs that are not in lib.dom yet
 * ------------------------------------------------------------------ */

/** Opaque handle returned by CropTarget.fromElement and handed back to cropTo. */
type CropTargetHandle = object;

interface CropTargetApi {
  fromElement(element: Element): Promise<CropTargetHandle>;
}

interface CroppableVideoTrack extends MediaStreamTrack {
  cropTo(target: CropTargetHandle | null): Promise<void>;
}

/** getDisplayMedia options for "this tab, please", none of which lib.dom types. */
interface CurrentTabDisplayOptions {
  video: { displaySurface: string; frameRate?: number };
  audio: boolean;
  preferCurrentTab: boolean;
  selfBrowserSurface: string;
}

/**
 * The argument type getDisplayMedia actually declares, reached through the
 * method rather than named directly: the type-only global that names it is not
 * a runtime binding, so referring to it by name trips the lint's no-undef.
 */
type DisplayMediaRequest = Parameters<MediaDevices["getDisplayMedia"]>[0];

function cropTargetApi(): CropTargetApi | null {
  const api = (globalThis as unknown as { CropTarget?: CropTargetApi }).CropTarget;
  return api && typeof api.fromElement === "function" ? api : null;
}

function canCropTracks(): boolean {
  if (typeof MediaStreamTrack === "undefined") return false;
  const proto = MediaStreamTrack.prototype as unknown as { cropTo?: unknown };
  return typeof proto.cropTo === "function";
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

type Mode = "idle" | "picking" | "drawing";
type Stage = "idle" | "starting" | "recording" | "recorded";

interface Selection {
  kind: "element" | "region";
  label: string;
  /** Document coordinates, so the crop follows the page as it scrolls. */
  doc: Region;
}

const panelRoot = ref<HTMLElement>();
const overlayTarget = ref<HTMLElement | null>(null);

const mode = ref<Mode>("idle");
const stage = ref<Stage>("idle");
const error = ref<{ message: string; fix?: string } | null>(null);
const note = ref<string | null>(null);

const selection = ref<Selection | null>(null);
const dpr = ref(1);

const hoverRect = ref<CssRect | null>(null);
const hoverLabel = ref("");

const dragFrom = ref<{ x: number; y: number } | null>(null);
const dragTo = ref<{ x: number; y: number } | null>(null);
const viewportWidth = ref(0);
const viewportHeight = ref(0);

const elapsedMs = ref(0);
const recordedBytes = ref(0);
const recordedMime = ref("");
const recordedBlob = shallowRef<Blob | null>(null);
const previewUrl = ref<string | null>(null);
const frameWidth = ref(0);
const frameHeight = ref(0);
const usedRegionCapture = ref(false);
const supportsRegionCapture = ref(false);

/* Non reactive capture plumbing: none of this belongs in the render graph. */
let selectedElement: Element | null = null;
let chunks: Blob[] = [];
let recorder: MediaRecorder | null = null;
let displayStream: MediaStream | null = null;
let canvasStream: MediaStream | null = null;
let sourceVideo: HTMLVideoElement | null = null;
let cropCanvas: HTMLCanvasElement | null = null;
let cropContext: CanvasRenderingContext2D | null = null;
let frameHandle: number | null = null;
let timer: number | null = null;
let startedAt = 0;
let lastDrawAt = 0;
let sourceRatio = 1;

/* ------------------------------------------------------------------ *
 * teardown helpers
 * ------------------------------------------------------------------ */

function clearTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function stopDrawing() {
  if (frameHandle !== null) {
    window.cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  if (sourceVideo) {
    sourceVideo.pause();
    sourceVideo.srcObject = null;
    sourceVideo = null;
  }
  cropContext = null;
  cropCanvas = null;
}

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that is already dead is not worth reporting.
    }
  }
}

function stopStreams() {
  stopStream(canvasStream);
  stopStream(displayStream);
  canvasStream = null;
  displayStream = null;
}

function releasePreview() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = null;
  }
}

/* ------------------------------------------------------------------ *
 * selection
 * ------------------------------------------------------------------ */

/** A short CSS-ish name for an element, for the chip and the summary line. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
  return `${tag}${id}${classes}`;
}

function documentRegion(rect: CssRect): Region {
  return {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * The crop rect in live viewport CSS pixels. An element is measured again
 * every frame, so scrolling and layout changes both follow; a drawn region is
 * stored in document coordinates and converted back the same way.
 */
function liveRect(): CssRect | null {
  const sel = selection.value;
  if (!sel) return null;
  if (sel.kind === "element") {
    if (!selectedElement || !selectedElement.isConnected) return null;
    const r = selectedElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return {
    x: sel.doc.x - window.scrollX,
    y: sel.doc.y - window.scrollY,
    width: sel.doc.width,
    height: sel.doc.height,
  };
}

function clearSelection() {
  selection.value = null;
  selectedElement = null;
}

function readViewport() {
  viewportWidth.value = window.innerWidth;
  viewportHeight.value = window.innerHeight;
  dpr.value = window.devicePixelRatio || 1;
}

/* ------------------------------------------------------------------ *
 * pick mode
 *
 * The overlay itself is pointer-events-none, so document.elementFromPoint
 * still reports the real page element under the cursor. The listeners sit on
 * window in the capture phase instead, which is also what lets the click that
 * selects an element be swallowed before the page can act on it.
 * ------------------------------------------------------------------ */

function isChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-er-chrome]") !== null;
}

function startPicking() {
  if (stage.value === "starting" || stage.value === "recording") return;
  stopDrawMode();
  readViewport();
  overlayTarget.value = panelRoot.value?.ownerDocument.body ?? document.body;
  hoverRect.value = null;
  hoverLabel.value = "";
  mode.value = "picking";
  window.addEventListener("pointermove", onPickMove, true);
  window.addEventListener("pointerdown", onPickDown, true);
  window.addEventListener("click", onPickClick, true);
  window.addEventListener("keydown", onOverlayKey, true);
}

function stopPicking() {
  if (mode.value !== "picking") return;
  mode.value = "idle";
  hoverRect.value = null;
  hoverLabel.value = "";
  window.removeEventListener("pointermove", onPickMove, true);
  window.removeEventListener("pointerdown", onPickDown, true);
  window.removeEventListener("click", onPickClick, true);
  window.removeEventListener("keydown", onOverlayKey, true);
}

function onPickMove(e: PointerEvent) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || isChrome(el)) {
    hoverRect.value = null;
    hoverLabel.value = "";
    return;
  }
  const r = el.getBoundingClientRect();
  hoverRect.value = { x: r.x, y: r.y, width: r.width, height: r.height };
  hoverLabel.value = `${describeElement(el)} · ${Math.round(r.width)} x ${Math.round(r.height)}`;
}

function onPickDown(e: PointerEvent) {
  if (isChrome(e.target)) return;
  // Keeps the page underneath from starting a drag or a text selection.
  e.preventDefault();
  e.stopPropagation();
}

function onPickClick(e: MouseEvent) {
  if (isChrome(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    note.value = "That element has no size on screen, so there is nothing to record. Pick another.";
    return;
  }
  selectedElement = el;
  selection.value = {
    kind: "element",
    label: describeElement(el),
    doc: documentRegion({ x: r.x, y: r.y, width: r.width, height: r.height }),
  };
  note.value = null;
  error.value = null;
  readViewport();
  stopPicking();
}

/* ------------------------------------------------------------------ *
 * draw mode
 * ------------------------------------------------------------------ */

function startDrawing() {
  if (stage.value === "starting" || stage.value === "recording") return;
  stopPicking();
  readViewport();
  overlayTarget.value = panelRoot.value?.ownerDocument.body ?? document.body;
  dragFrom.value = null;
  dragTo.value = null;
  mode.value = "drawing";
  window.addEventListener("keydown", onOverlayKey, true);
}

function stopDrawMode() {
  if (mode.value !== "drawing") return;
  mode.value = "idle";
  dragFrom.value = null;
  dragTo.value = null;
  window.removeEventListener("keydown", onOverlayKey, true);
}

function onOverlayKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  stopPicking();
  stopDrawMode();
}

/** The live drag rectangle in viewport CSS pixels, straight from the pure layer. */
const dragRegion = computed<Region | null>(() => {
  const a = dragFrom.value;
  const b = dragTo.value;
  if (!a || !b) return null;
  return clampRegion(regionFromPoints(a.x, a.y, b.x, b.y), {
    width: viewportWidth.value,
    height: viewportHeight.value,
  });
});

const dragStyle = computed<CSSProperties>(() => {
  const r = dragRegion.value;
  if (!r) return { display: "none" };
  return {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
});

function onDrawDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
  readViewport();
  dragFrom.value = { x: e.clientX, y: e.clientY };
  dragTo.value = { x: e.clientX, y: e.clientY };
}

function onDrawMove(e: PointerEvent) {
  if (!dragFrom.value) return;
  dragTo.value = { x: e.clientX, y: e.clientY };
}

function onDrawUp(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  const region = dragRegion.value;
  dragFrom.value = null;
  dragTo.value = null;
  if (!region || region.width < 8 || region.height < 8) {
    note.value = "That rectangle was too small to record. Drag a larger one, at least 8 px a side.";
    return;
  }
  selectedElement = null;
  selection.value = {
    kind: "region",
    label: `${Math.round(region.width)} x ${Math.round(region.height)} CSS px`,
    doc: documentRegion(region),
  };
  note.value = null;
  error.value = null;
  stopDrawMode();
}

function onDrawCancel(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  dragFrom.value = null;
  dragTo.value = null;
}

/* ------------------------------------------------------------------ *
 * cropping math
 * ------------------------------------------------------------------ */

/** Even dimensions keep every video encoder happy, VP9 and H.264 alike. */
function evenSize(value: number): number {
  const n = Math.max(2, Math.round(value));
  return n % 2 === 0 ? n : n - 1;
}

/**
 * The crop rect inside one captured frame, in that frame's own pixels.
 * `sourceRatio` is captured pixels per CSS pixel, measured from the real track
 * rather than assumed, so browser zoom and a scaled capture both land right.
 */
function cropRegion(frameW: number, frameH: number): Region | null {
  const rect = liveRect();
  if (!rect) return null;
  const visible = clampRegion(rect, { width: window.innerWidth, height: window.innerHeight });
  const snapped = snapToElementRect(visible, sourceRatio);
  return clampRegion(snapped, { width: frameW, height: frameH });
}

/* ------------------------------------------------------------------ *
 * starting a recording
 * ------------------------------------------------------------------ */

/** The two rejections that mean "the visitor closed the picker". */
function isCancellation(e: unknown): boolean {
  const name = e instanceof DOMException ? e.name : "";
  return name === "NotAllowedError" || name === "AbortError";
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function fail(message: string, fix?: string) {
  stopDrawing();
  stopStreams();
  stage.value = "idle";
  error.value = { message, fix };
}

/**
 * Prompts for the capture, asking for this tab. Not every browser ignores
 * hints it does not know: some reject the whole call, so a plain request is
 * the second attempt, and the surface check afterwards catches it when the
 * visitor then shares something other than this tab. Returns null once the
 * visitor has either been told what went wrong or has closed the picker.
 */
async function requestTabStream(devices: MediaDevices): Promise<MediaStream | null> {
  const request: CurrentTabDisplayOptions = {
    video: { displaySurface: "browser", frameRate: fps.value },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  };

  try {
    return await devices.getDisplayMedia(request as unknown as DisplayMediaRequest);
  } catch (e) {
    if (isCancellation(e)) return null;
  }

  try {
    const stream = await devices.getDisplayMedia({ video: true, audio: false });
    note.value =
      "This browser did not accept the request for the current tab, so its picker offered every surface. Cropping only works when you choose this tab.";
    return stream;
  } catch (e) {
    if (!isCancellation(e)) {
      error.value = {
        message: messageOf(e, "The tab could not be captured."),
        fix: "Allow screen capture for this site, then start again and choose this tab in the picker.",
      };
    }
    return null;
  }
}

async function startRecording() {
  if (stage.value === "starting" || stage.value === "recording") return;
  stopPicking();
  stopDrawMode();
  error.value = null;
  note.value = null;

  const sel = selection.value;
  if (!sel) {
    error.value = {
      message: "Nothing is selected yet.",
      fix: "Choose Pick element and click something on this page, or choose Draw region and drag a rectangle.",
    };
    return;
  }

  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (
    !devices ||
    typeof devices.getDisplayMedia !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    error.value = {
      message: "This browser cannot capture the screen.",
      fix: "Recording needs getDisplayMedia and MediaRecorder, which desktop Chrome, Edge, Firefox, and Safari all have. Mobile browsers generally do not offer screen capture at all.",
    };
    return;
  }

  readViewport();
  stage.value = "starting";

  const shared = await requestTabStream(devices);
  if (!shared) {
    displayStream = null;
    stage.value = "idle";
    return;
  }
  displayStream = shared;

  const videoTrack = shared.getVideoTracks()[0];
  if (!videoTrack) {
    fail(
      "The browser shared no video track.",
      "Start again and choose this tab in the picker rather than closing it.",
    );
    return;
  }

  const surface = videoTrack.getSettings().displaySurface;
  if (surface && surface !== "browser") {
    fail(
      `You shared ${surface === "monitor" ? "a whole screen" : "a window"}, not this tab.`,
      "The region and the element you picked only exist inside this tab, so there is nothing to crop to on another surface. Start again and choose this tab in the picker.",
    );
    return;
  }

  usedRegionCapture.value = false;
  const api = cropTargetApi();
  if (sel.kind === "element" && selectedElement && api && canCropTracks()) {
    try {
      const target = await api.fromElement(selectedElement);
      await (videoTrack as CroppableVideoTrack).cropTo(target);
      usedRegionCapture.value = true;
    } catch {
      // Region Capture refused this element, so the canvas path takes over.
      usedRegionCapture.value = false;
    }
  }

  // Until a real frame arrives, device pixels are the best guess at the ratio
  // between the captured surface and this page's CSS pixels.
  sourceRatio = dpr.value;
  const initial = cropRegion(
    Math.max(1, Math.round(window.innerWidth * dpr.value)),
    Math.max(1, Math.round(window.innerHeight * dpr.value)),
  );
  if (!initial || initial.width < 2 || initial.height < 2) {
    fail(
      "The selected region is no longer on screen.",
      "Scroll it back into view, or pick it again, then start the recording.",
    );
    return;
  }

  let captureStream: MediaStream;
  if (usedRegionCapture.value) {
    frameWidth.value = initial.width;
    frameHeight.value = initial.height;
    captureStream = new MediaStream([videoTrack]);
  } else {
    const built = await buildCanvasStream(initial);
    if (!built) return;
    captureStream = built;
  }

  const candidates = preferMp4.value
    ? ["video/mp4", ...DEFAULT_MIME_CANDIDATES]
    : DEFAULT_MIME_CANDIDATES.filter((m) => !m.startsWith("video/mp4"));
  const mime = pickMimeType(candidates, (m) => MediaRecorder.isTypeSupported(m));
  const bitrate = Math.round(
    estimateBitrate(frameWidth.value, frameHeight.value, fps.value) *
      qualityMultiplier(quality.value),
  );

  try {
    recorder = createRecorder(captureStream, mime, bitrate);
  } catch (e) {
    fail(
      messageOf(e, "The recorder could not be started."),
      "This browser rejected every recording format offered. Try a current version of Chrome, Edge, or Firefox.",
    );
    return;
  }

  if (preferMp4.value && extForMime(mime) !== "mp4") {
    note.value =
      "This browser's recorder does not write MP4, so the recording is saved as WebM. Every current browser and VLC play it.";
  }

  chunks = [];
  recordedBytes.value = 0;
  recordedBlob.value = null;
  releasePreview();
  recordedMime.value = recorder.mimeType || mime;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
      recordedBytes.value += event.data.size;
    }
  };
  recorder.onstop = () => {
    void finalize();
  };
  recorder.onerror = () => {
    error.value = {
      message: "The recording stopped because of a recorder error.",
      fix: "Whatever was captured before the error is still offered below when it is long enough to keep.",
    };
    stopRecording();
  };

  // Ending the share from the browser's own bar kills the track instead of
  // calling anything here, so that path has to lead back to the same stop.
  videoTrack.addEventListener("ended", () => {
    if (stage.value === "recording") stopRecording();
  });

  // A one second timeslice keeps chunks flowing, so a crashed tab still leaves
  // most of the recording behind rather than one unwritten buffer.
  recorder.start(1000);
  startedAt = Date.now();
  elapsedMs.value = 0;
  stage.value = "recording";
  timer = window.setInterval(() => {
    elapsedMs.value = Date.now() - startedAt;
  }, 250);
}

/** Constructs the recorder, degrading gracefully when options are rejected. */
function createRecorder(stream: MediaStream, mime: string, bitrate: number): MediaRecorder {
  try {
    return new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  } catch {
    try {
      return new MediaRecorder(stream, { mimeType: mime });
    } catch {
      return new MediaRecorder(stream);
    }
  }
}

/* ------------------------------------------------------------------ *
 * canvas crop fallback
 *
 * Without Region Capture the whole tab arrives as one stream, so the panel
 * plays it into a detached video element and copies just the selected part
 * into a canvas every frame. The canvas keeps a fixed size for the whole
 * recording, since resizing it mid stream confuses the encoder.
 * ------------------------------------------------------------------ */

async function buildCanvasStream(initial: Region): Promise<MediaStream | null> {
  const video = document.createElement("video");
  video.srcObject = displayStream;
  video.muted = true;
  video.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("The captured tab could not be decoded."));
    });
    await video.play();
  } catch (e) {
    video.srcObject = null;
    fail(
      messageOf(e, "The captured tab could not be played back for cropping."),
      "Start again, and leave this tab in the foreground while the recording runs.",
    );
    return null;
  }

  sourceVideo = video;
  sourceRatio =
    video.videoWidth > 0 && window.innerWidth > 0
      ? video.videoWidth / window.innerWidth
      : dpr.value;

  const first = cropRegion(video.videoWidth, video.videoHeight) ?? initial;
  const canvas = document.createElement("canvas");
  canvas.width = evenSize(first.width);
  canvas.height = evenSize(first.height);
  const context = canvas.getContext("2d");
  if (!context) {
    fail(
      "This browser could not open a 2D canvas for cropping.",
      "Canvas cropping is the fallback for browsers without Region Capture. A current Chromium browser crops the stream directly and skips this step.",
    );
    return null;
  }

  cropCanvas = canvas;
  cropContext = context;
  frameWidth.value = canvas.width;
  frameHeight.value = canvas.height;
  lastDrawAt = 0;

  const stream = canvas.captureStream(fps.value);
  canvasStream = stream;
  frameHandle = window.requestAnimationFrame(drawFrame);
  return stream;
}

function drawFrame(now: number) {
  frameHandle = window.requestAnimationFrame(drawFrame);
  const video = sourceVideo;
  const canvas = cropCanvas;
  const context = cropContext;
  if (!video || !canvas || !context) return;

  const minInterval = 1000 / fps.value;
  if (lastDrawAt > 0 && now - lastDrawAt < minInterval - 1) return;
  lastDrawAt = now;

  if (video.videoWidth < 1 || video.videoHeight < 1) return;
  sourceRatio = window.innerWidth > 0 ? video.videoWidth / window.innerWidth : sourceRatio;

  const region = cropRegion(video.videoWidth, video.videoHeight);
  if (!region || region.width < 1 || region.height < 1) return;

  context.drawImage(
    video,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

/* ------------------------------------------------------------------ *
 * stopping and the result
 * ------------------------------------------------------------------ */

function stopRecording() {
  clearTimer();
  if (startedAt > 0) elapsedMs.value = Math.max(0, Date.now() - startedAt);
  if (recorder && recorder.state !== "inactive") {
    // finalize() runs from onstop once the last chunk has been flushed.
    recorder.stop();
    return;
  }
  void finalize();
}

/**
 * MediaRecorder writes WebM with no Duration in the header, since it does not
 * know the length until it is done. The pure layer writes the real one in, so
 * the preview below and any player the file lands in show a seek bar straight
 * away instead of a stream of unknown length.
 */
async function finalize() {
  clearTimer();
  stopDrawing();
  const type = recordedMime.value || "video/webm";
  const parts = chunks.slice();
  const durationMs = elapsedMs.value;
  chunks = [];
  recorder = null;
  stopStreams();

  if (parts.length === 0) {
    stage.value = "idle";
    if (!error.value) {
      error.value = {
        message: "Nothing was recorded.",
        fix: "The share ended before any video arrived. Start again and let it run for a second or two.",
      };
    }
    return;
  }

  let blob = new Blob(parts, { type });
  if (extForMime(type) === "webm") {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const patched = patchWebmDuration(bytes, durationMs);
      blob = new Blob([patched.buffer as ArrayBuffer], { type });
    } catch {
      // A duration header that cannot be written is cosmetic: keep the video.
    }
  }

  if (blob.size === 0) {
    stage.value = "idle";
    error.value = {
      message: "The recording came back empty.",
      fix: "Start again and let the recording run for a second or two before stopping it.",
    };
    return;
  }

  releasePreview();
  recordedBlob.value = blob;
  recordedBytes.value = blob.size;
  previewUrl.value = URL.createObjectURL(blob);
  stage.value = "recorded";
}

/** The finished file knows its own frame size, so trust it over the estimate. */
function onPreviewLoaded(e: Event) {
  const el = e.target as HTMLVideoElement | null;
  if (!el || el.videoWidth < 1) return;
  frameWidth.value = el.videoWidth;
  frameHeight.value = el.videoHeight;
}

function downloadRecording() {
  const blob = recordedBlob.value;
  if (!blob) return;
  downloadBlob(blob, fileName("element-recording", recordedMime.value));
}

function recordAgain() {
  releasePreview();
  recordedBlob.value = null;
  recordedBytes.value = 0;
  elapsedMs.value = 0;
  error.value = null;
  note.value = null;
  stage.value = "idle";
}

/* ------------------------------------------------------------------ *
 * derived view state
 * ------------------------------------------------------------------ */

const elapsedText = computed(() => {
  const total = Math.floor(elapsedMs.value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
});

const liveSizeText = computed(() => formatBytes(recordedBytes.value));

const selectionSizeText = computed(() => {
  const sel = selection.value;
  if (!sel) return "";
  const width = Math.round(sel.doc.width * dpr.value);
  const height = Math.round(sel.doc.height * dpr.value);
  return `${Math.round(sel.doc.width)} x ${Math.round(sel.doc.height)} CSS px, ${width} x ${height} device px`;
});

const estimatedBitrateText = computed(() => {
  const sel = selection.value;
  if (!sel) return "";
  const bps = Math.round(
    estimateBitrate(sel.doc.width * dpr.value, sel.doc.height * dpr.value, fps.value) *
      qualityMultiplier(quality.value),
  );
  return `about ${Math.round(bps / 1000)} kbps`;
});

const methodText = computed(() => {
  if (selection.value?.kind === "element" && supportsRegionCapture.value) {
    return "Region Capture crops the stream itself, before anything is encoded.";
  }
  if (selection.value?.kind === "region" && supportsRegionCapture.value) {
    return "A hand drawn region is cropped frame by frame into a canvas on this device, since Region Capture can only crop to an element.";
  }
  return "This browser has no Region Capture, so the whole tab is captured and every frame is cropped into a canvas on this device before recording.";
});

const hoverStyle = computed<CSSProperties>(() => {
  const r = hoverRect.value;
  if (!r) return { display: "none" };
  return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` };
});

const hoverChipStyle = computed<CSSProperties>(() => {
  const r = hoverRect.value;
  if (!r) return { display: "none" };
  const left = Math.min(Math.max(r.x, 8), Math.max(8, viewportWidth.value - 280));
  const top = r.y > 32 ? r.y - 28 : Math.min(r.y + r.height + 8, viewportHeight.value - 32);
  return { left: `${left}px`, top: `${Math.max(8, top)}px` };
});

const summary = computed<Record<string, string> | null>(() => {
  const blob = recordedBlob.value;
  if (stage.value !== "recorded" || !blob) return null;
  return describeRecording({
    bytes: blob.size,
    durationMs: elapsedMs.value,
    width: frameWidth.value,
    height: frameHeight.value,
    mimeType: recordedMime.value,
    fps: fps.value,
  });
});

const recordedFormat = computed(() => extForMime(recordedMime.value).toUpperCase());

const busy = computed(() => stage.value === "starting" || stage.value === "recording");

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  readViewport();
  supportsRegionCapture.value = cropTargetApi() !== null && canCropTracks();
});

onUnmounted(() => {
  stopPicking();
  stopDrawMode();
  clearTimer();
  stopDrawing();
  if (recorder && recorder.state !== "inactive") {
    recorder.onstop = null;
    recorder.ondataavailable = null;
    try {
      recorder.stop();
    } catch {
      // Already gone.
    }
  }
  recorder = null;
  chunks = [];
  stopStreams();
  releasePreview();
});
</script>

<template>
  <div
    ref="panelRoot"
    class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
    <!-- Target -->
    <div
      v-if="stage !== 'recording'"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          What to record
        </span>
        <div class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]">
          <Button
            variant="ghost"
            size="sm"
            :disabled="busy"
            :aria-pressed="mode === 'picking'"
            :class="mode === 'picking' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
            @click="startPicking"
          >
            <MousePointerClick class="size-4" aria-hidden="true" />
            Pick element
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :disabled="busy"
            :aria-pressed="mode === 'drawing'"
            :class="mode === 'drawing' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
            @click="startDrawing"
          >
            <Crop class="size-4" aria-hidden="true" />
            Draw region
          </Button>
        </div>
      </div>

      <div v-if="selection" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="font-mono text-sm break-all">{{ selection.label }}</span>
        <span class="text-xs text-muted-foreground tabular-nums">{{ selectionSizeText }}</span>
        <Button class="ml-auto" variant="ghost" size="sm" :disabled="busy" @click="clearSelection">
          <X class="size-4" aria-hidden="true" />
          Clear
        </Button>
      </div>

      <p v-else class="text-sm text-muted-foreground">
        Nothing is selected yet. Choose Pick element and click any part of this page, or choose Draw
        region and drag a rectangle over it. Press
        <kbd class="rounded-[8px] bg-card px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd> to leave
        either mode.
      </p>

      <p v-if="selection" class="text-xs text-muted-foreground">{{ methodText }}</p>
    </div>

    <!-- Options -->
    <div
      v-if="meta.options?.length && stage !== 'recording'"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <!-- Start -->
    <div v-if="stage === 'idle' || stage === 'starting'" class="flex flex-wrap items-center gap-3">
      <Button size="lg" :disabled="stage === 'starting' || !selection" @click="startRecording">
        <Video class="size-4" aria-hidden="true" />
        {{ stage === "starting" ? "Waiting for the picker…" : "Start recording" }}
      </Button>
      <span v-if="selection" class="text-xs text-muted-foreground">
        Your browser asks you to confirm sharing this tab, then records {{ estimatedBitrateText }}.
      </span>
      <span v-else class="text-xs text-muted-foreground">
        Select an element or a region first.
      </span>
    </div>

    <!-- Recording -->
    <div
      v-if="stage === 'recording'"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="inline-flex items-center gap-2 text-sm font-semibold text-destructive">
          <span class="rec-dot" aria-hidden="true"></span>
          REC
        </span>
        <span class="text-2xl font-semibold tabular-nums" role="timer" aria-live="off">
          {{ elapsedText }}
        </span>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ liveSizeText }} · {{ frameWidth }} x {{ frameHeight }} px
        </span>
        <Button class="ml-auto" size="sm" variant="destructive" @click="stopRecording">
          <span class="stop-square" aria-hidden="true"></span>
          Stop recording
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        {{
          usedRegionCapture
            ? "The stream is cropped to your element, so the rest of the tab is never encoded."
            : "Frames are cropped to your selection on this device before they reach the recorder."
        }}
        You can also stop from your browser's own sharing bar.
      </p>
    </div>

    <!-- Result -->
    <div v-if="stage === 'recorded' && previewUrl" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Recording
        </span>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ elapsedText }} · {{ liveSizeText }} · {{ recordedFormat }}
        </span>
      </div>

      <video
        :src="previewUrl"
        controls
        playsinline
        class="w-full rounded-[10px] bg-black shadow-[var(--sh-inset)]"
        @loadedmetadata="onPreviewLoaded"
      ></video>

      <div class="flex flex-wrap items-center gap-3">
        <Button @click="downloadRecording">
          <Download class="size-4" aria-hidden="true" />
          Download {{ recordedFormat }}
        </Button>
        <Button variant="ghost" @click="recordAgain">Record again</Button>
      </div>

      <OutputView v-if="summary" :output="summary" />
    </div>

    <!-- Errors and notes -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <p v-if="note" class="text-xs text-muted-foreground">{{ note }}</p>

    <p class="text-xs text-muted-foreground">
      Cropping, recording, and the duration fix all run in this tab: your files and inputs never
      leave your device.
    </p>
  </div>

  <!-- ------------------------------------------------------- pick mode ---- -->
  <Teleport v-if="mode === 'picking' && overlayTarget" :to="overlayTarget">
    <div class="pointer-events-none fixed inset-0 z-[9999]">
      <div
        class="absolute border border-primary bg-primary/15 shadow-[var(--sh-md)]"
        :style="hoverStyle"
      />
      <div
        class="absolute rounded-[8px] border bg-popover px-2 py-1 font-mono text-xs whitespace-nowrap shadow-[var(--sh-lg)]"
        :style="hoverChipStyle"
      >
        {{ hoverLabel }}
      </div>

      <div
        data-er-chrome
        class="pointer-events-auto absolute top-4 right-4 flex items-center gap-2"
      >
        <span
          class="rounded-[10px] border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--sh-lg)]"
        >
          Click an element to record just that.
          <kbd class="rounded-[8px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd>
          cancels.
        </span>
        <Button size="sm" @click="stopPicking">
          <X class="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  </Teleport>

  <!-- ------------------------------------------------------- draw mode ---- -->
  <Teleport v-if="mode === 'drawing' && overlayTarget" :to="overlayTarget">
    <div
      class="fixed inset-0 z-[9999] cursor-crosshair bg-foreground/10 touch-none select-none"
      role="application"
      aria-label="Draw the region to record"
      @pointerdown="onDrawDown"
      @pointermove="onDrawMove"
      @pointerup="onDrawUp"
      @pointercancel="onDrawCancel"
    >
      <div
        class="pointer-events-none absolute border border-primary bg-primary/10"
        :style="dragStyle"
      />

      <div
        class="absolute top-4 right-4 flex items-center gap-2"
        @pointerdown.stop
        @pointermove.stop
        @pointerup.stop
      >
        <span
          class="rounded-[10px] border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--sh-lg)]"
        >
          Drag a rectangle over the part of the page to record.
          <kbd class="rounded-[8px] bg-secondary px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd>
          cancels.
        </span>
        <Button size="sm" @click="stopDrawMode">
          <X class="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rec-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 999px;
  background: var(--destructive);
  animation: rec-blink 1.4s ease-in-out infinite;
}

.stop-square {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  background: currentColor;
}

@keyframes rec-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rec-dot {
    animation: none;
  }
}
</style>
