<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from "vue";
import { X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the GPX Track Viewer.
 *
 * The generic ToolShell can print the statistics rows, but a recorded track is
 * a shape: it wants a drawing you can zoom into, an elevation profile you can
 * point at, and trim handles that move the numbers as you drag them. So it
 * gets its own island.
 *
 * Every projection, statistic and export string still comes from the pure
 * logic layer. Nothing here re-derives a rule the logic already owns: the map
 * marker reads its coordinates back out of the path the logic drew, and the
 * elevation crosshair is placed from the very same `elevationProfile` samples
 * `renderElevationSvg` used, so the overlay cannot drift from the picture
 * underneath it.
 *
 * There is no basemap on purpose. Map tiles come from a third party server, so
 * the track is drawn on a plain canvas instead. Nothing here touches the DOM
 * until a file arrives, so the panel renders inert on the server.
 */
const props = defineProps<{ meta: ToolMeta }>();

type GpxLogic = typeof import("@/tools/gpx-viewer/index");
type Track = import("@/tools/gpx-viewer/index").Track;
type TrackStats = import("@/tools/gpx-viewer/index").TrackStats;
type ElevationSample = import("@/tools/gpx-viewer/index").ElevationSample;

/** Loaded on the first track rather than on page load, then cached. */
let logicPromise: Promise<GpxLogic> | null = null;
function loadLogic(): Promise<GpxLogic> {
  logicPromise ??= import("@/tools/gpx-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Matches the ceiling the logic layer enforces, so the message arrives sooner. */
const MAX_BYTES = 50 * 1024 * 1024;
const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

const TRACK_HEIGHT = 420;
const ELEV_HEIGHT = 200;
/** Passed to renderElevationSvg, so the crosshair maths uses the same inset. */
const ELEV_PAD = 24;
const MIN_WIDTH = 260;
/** The ceiling renderTrackSvg clamps to. Staying under it keeps the overlay
 * maths and the drawing on the same width. */
const MAX_WIDTH = 4000;
const MAX_ZOOM = 40;

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

const FALLBACK_UNITS: SelectOptionSpec = {
  kind: "select",
  id: "units",
  label: "Units",
  default: "metric",
  options: [
    { value: "metric", label: "Metric (km, m)", synonyms: ["metric", "km", "meters", "metres"] },
    { value: "imperial", label: "Imperial (miles, feet)", synonyms: ["imperial", "miles", "feet"] },
  ],
};

/** The units dropdown is the one declared in meta, so both surfaces agree. */
const unitsSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find(
    (option): option is SelectOptionSpec => option.kind === "select" && option.id === "units",
  );
  return found ?? FALLBACK_UNITS;
});

const DOWNSAMPLE_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "gpx-downsample",
  label: "Points drawn",
  default: "all",
  options: [
    { value: "all", label: "All points", synonyms: ["all", "every", "full", "no thinning"] },
    { value: "1000", label: "At most 1000", synonyms: ["1000", "thin", "reduce", "simplify"] },
    { value: "500", label: "At most 500", synonyms: ["500", "thin", "reduce", "smallest"] },
  ],
};

const units = ref(unitsSpec.value.default);
const smoothing = ref(3);
const maxPoints = ref("all");

const imperial = computed(() => units.value === "imperial");
const unitKey = computed(() => (imperial.value ? "imperial" : "metric"));

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<GpxLogic | null>(null);
const fullTrack = shallowRef<Track | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const pasted = ref("");
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const busy = ref(false);
const fileInput = ref<HTMLInputElement>();

const trimStart = ref(0);
const trimEnd = ref(0);

const trackBox = ref<HTMLElement>();
const trackFigure = ref<HTMLElement>();
const elevBox = ref<HTMLElement>();
const boxWidth = ref(640);

const zoom = ref(1);
const centerX = ref(0.5);
const centerY = ref(0.5);
const panning = ref(false);

const hoverIndex = ref<number | null>(null);
const hoverLeft = ref(0);
const hoverTop = ref(0);

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, "0");
}

function fmtDistance(meters: number): string {
  if (imperial.value) {
    const miles = meters / METERS_PER_MILE;
    return miles < 0.1 ? `${(meters / METERS_PER_FOOT).toFixed(0)} ft` : `${miles.toFixed(2)} mi`;
  }
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function fmtElevation(meters: number, decimals = 0): string {
  return imperial.value
    ? `${(meters / METERS_PER_FOOT).toFixed(decimals)} ft`
    : `${meters.toFixed(decimals)} m`;
}

function fmtSpeed(mps: number): string {
  return imperial.value
    ? `${((mps * 3600) / METERS_PER_MILE).toFixed(2)} mph`
    : `${(mps * 3.6).toFixed(2)} km/h`;
}

function fmtPace(mps: number): string {
  if (!Number.isFinite(mps) || mps <= 0) return "n/a";
  const secondsPerUnit = (imperial.value ? METERS_PER_MILE : 1000) / mps;
  const minutes = Math.floor(secondsPerUnit / 60);
  const seconds = Math.round(secondsPerUnit - minutes * 60);
  const carry = seconds === 60;
  const label = imperial.value ? "/mi" : "/km";
  return `${carry ? minutes + 1 : minutes}:${pad2(carry ? 0 : seconds)} ${label}`;
}

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(secs)}s`;
  if (minutes > 0) return `${minutes}m ${pad2(secs)}s`;
  return `${secs}s`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function fmtGrade(percent: number | undefined): string {
  return percent === undefined ? "n/a" : `${percent.toFixed(1)}%`;
}

function baseName(): string {
  const name = fileName.value;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "track";
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function resetView() {
  zoom.value = 1;
  centerX.value = 0.5;
  centerY.value = 0.5;
  hoverIndex.value = null;
}

async function parseText(text: string, name: string, size: number) {
  busy.value = true;
  try {
    if (size > MAX_BYTES) {
      throw new ToolError(
        "too-large",
        `That input is about ${formatBytes(size)}, larger than the ${formatBytes(MAX_BYTES)} limit.`,
        "Split the file or reduce the recording rate, then try again.",
      );
    }
    const mod = await loadLogic();
    logic.value = mod;
    const parsed = mod.parseTrack(text);
    if (parsed.points.length === 0 && parsed.waypoints.length === 0) {
      throw new ToolError(
        "no-points",
        "That file parsed cleanly but holds no coordinates.",
        "Check that it contains a track, a route, or at least one waypoint.",
      );
    }
    fullTrack.value = parsed;
    trimStart.value = 0;
    trimEnd.value = Math.max(0, parsed.points.length - 1);
    maxPoints.value = "all";
    fileName.value = name;
    fileSize.value = size;
    error.value = null;
    resetView();
  } catch (e) {
    fullTrack.value = null;
    error.value = toToolError(e);
  } finally {
    busy.value = false;
  }
}

async function readFile(file: File) {
  const text = await file.text();
  await parseText(text, file.name, file.size);
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

let pasteTimer: ReturnType<typeof setTimeout> | undefined;
function onPaste(value: unknown) {
  pasted.value = String(value ?? "");
  clearTimeout(pasteTimer);
  const text = pasted.value;
  if (text.trim() === "") {
    error.value = null;
    return;
  }
  pasteTimer = setTimeout(() => {
    parseText(text, "pasted-track.gpx", text.length);
  }, 250);
}

function clearTrack() {
  fullTrack.value = null;
  fileName.value = "";
  fileSize.value = 0;
  pasted.value = "";
  error.value = null;
  trimStart.value = 0;
  trimEnd.value = 0;
  resetView();
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* the visible track                                                 */
/* ---------------------------------------------------------------- */

const lastIndex = computed(() => Math.max(0, (fullTrack.value?.points.length ?? 0) - 1));
const canTrim = computed(() => lastIndex.value > 0);

/** Trim first, then thin: thinning first would let a cut drop kept points twice. */
const viewTrack = computed<Track | null>(() => {
  const mod = logic.value;
  const full = fullTrack.value;
  if (!mod || !full) return null;
  const trimmed = mod.trimTrack(full, trimStart.value, trimEnd.value);
  const limit = Number(maxPoints.value);
  return Number.isFinite(limit) && limit > 0 ? mod.downsample(trimmed, limit) : trimmed;
});

const stats = computed<TrackStats | null>(() => {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return null;
  return mod.trackStats(track, { smoothing: smoothing.value });
});

const distances = computed<number[]>(() => {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return [];
  return mod.cumulativeDistances(track.points);
});

const trackTitle = computed(() => fullTrack.value?.name ?? "");
const loadedPointCount = computed(() => fullTrack.value?.points.length ?? 0);

const sourceLabel = computed(() => {
  const source = fullTrack.value?.source;
  if (source === "gpx") return "GPX";
  if (source === "kml") return "KML";
  if (source === "geojson") return "GeoJSON";
  return "";
});

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

const baseW = computed(() => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(boxWidth.value))));

const trackSvg = computed(() => {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return "";
  return mod.renderTrackSvg(track, {
    width: baseW.value,
    height: TRACK_HEIGHT,
    units: unitKey.value,
  });
});

const elevationSvg = computed(() => {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return "";
  return mod.renderElevationSvg(track, {
    width: baseW.value,
    height: ELEV_HEIGHT,
    padding: ELEV_PAD,
    units: unitKey.value,
  });
});

/**
 * The same samples renderElevationSvg drew, asked for with the sample count it
 * derives from the width. Reading them here rather than inventing a second
 * profile is what welds the crosshair to the line under it.
 */
const profile = computed<ElevationSample[]>(() => {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return [];
  return mod.elevationProfile(track, Math.min(600, Math.max(2, Math.floor(baseW.value))));
});

const hasProfile = computed(() => profile.value.length >= 2);

const profileRange = computed(() => {
  const samples = profile.value;
  if (samples.length < 2) return null;
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const sample of samples) {
    if (sample.elevationMeters < minEle) minEle = sample.elevationMeters;
    if (sample.elevationMeters > maxEle) maxEle = sample.elevationMeters;
  }
  const startDistance = samples[0].distanceMeters;
  const endDistance = samples[samples.length - 1].distanceMeters;
  return {
    startDistance,
    endDistance,
    totalDistance: Math.max(endDistance - startDistance, 1e-6),
    minEle,
    eleSpan: Math.max(maxEle - minEle, 1e-6),
  };
});

/**
 * The drawn position of every track point, read back out of the path the logic
 * layer produced. One M or L command is emitted per point, in order, so
 * command i belongs to point i and the marker lands exactly on the line.
 */
const trackPoints2d = computed<{ x: number; y: number }[]>(() => {
  const svg = trackSvg.value;
  if (svg === "") return [];
  const path = /class="track-line" d="([^"]*)"/.exec(svg);
  if (!path) return [];
  const out: { x: number; y: number }[] = [];
  const re = /[ML](-?[\d.]+)\s+(-?[\d.]+)/g;
  let m = re.exec(path[1]);
  while (m !== null) {
    out.push({ x: Number(m[1]), y: Number(m[2]) });
    m = re.exec(path[1]);
  }
  return out;
});

/* ---------------------------------------------------------------- */
/* pan and zoom                                                      */
/* ---------------------------------------------------------------- */

/** Keep the window inside the picture: the center can never leave the middle. */
function clampCenter(value: number, level: number): number {
  const half = 0.5 / level;
  return Math.min(Math.max(value, half), 1 - half);
}

const viewBox = computed(() => {
  const w = baseW.value / zoom.value;
  const h = TRACK_HEIGHT / zoom.value;
  const x = (clampCenter(centerX.value, zoom.value) - 0.5 / zoom.value) * baseW.value;
  const y = (clampCenter(centerY.value, zoom.value) - 0.5 / zoom.value) * TRACK_HEIGHT;
  return `${x} ${y} ${w} ${h}`;
});

/**
 * Panning writes the window straight onto the rendered element instead of
 * rebuilding the markup. A long ride is a path with tens of thousands of
 * commands in it, and re-parsing that string on every pointer move would drop
 * frames for the sake of one attribute.
 */
watchEffect(
  () => {
    const attr = viewBox.value;
    // Read the markup too, so a re-render re-applies the current window.
    void trackSvg.value;
    const svg = trackFigure.value?.querySelector("svg");
    if (svg) svg.setAttribute("viewBox", attr);
  },
  { flush: "post" },
);

/** Zoom while holding the fraction (fx, fy) of the box on the same spot. */
function applyZoom(next: number, fx: number, fy: number) {
  const level = Math.min(Math.max(next, 1), MAX_ZOOM);
  const before = zoom.value;
  const anchorX = clampCenter(centerX.value, before) - 0.5 / before + fx / before;
  const anchorY = clampCenter(centerY.value, before) - 0.5 / before + fy / before;
  zoom.value = level;
  centerX.value = clampCenter(anchorX - fx / level + 0.5 / level, level);
  centerY.value = clampCenter(anchorY - fy / level + 0.5 / level, level);
}

function onWheel(e: WheelEvent) {
  if (trackSvg.value === "") return;
  e.preventDefault();
  const el = trackBox.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const fx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  const fy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
  applyZoom(zoom.value * Math.pow(1.0016, -e.deltaY), fx, fy);
}

function zoomButton(factor: number) {
  applyZoom(zoom.value * factor, 0.5, 0.5);
}

let drag: { id: number; x: number; y: number } | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || trackSvg.value === "") return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  panning.value = true;
}

function onPointerMove(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dx = (e.clientX - drag.x) / rect.width / zoom.value;
  const dy = (e.clientY - drag.y) / rect.height / zoom.value;
  drag.x = e.clientX;
  drag.y = e.clientY;
  centerX.value = clampCenter(centerX.value - dx, zoom.value);
  centerY.value = clampCenter(centerY.value - dy, zoom.value);
}

function onPointerUp(e: PointerEvent) {
  if (!drag || drag.id !== e.pointerId) return;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  drag = null;
  panning.value = false;
}

/* ---------------------------------------------------------------- */
/* the elevation crosshair                                           */
/* ---------------------------------------------------------------- */

/** Nearest sample by running distance. The array is sorted, so bisect it. */
function nearestIndex(values: number[], target: number): number {
  if (values.length === 0) return -1;
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(values[lo - 1] - target) <= Math.abs(values[lo] - target)) return lo - 1;
  return lo;
}

function elevX(distance: number): number {
  const range = profileRange.value;
  if (!range) return ELEV_PAD;
  const innerW = Math.max(baseW.value - ELEV_PAD * 2, 1);
  return ELEV_PAD + ((distance - range.startDistance) / range.totalDistance) * innerW;
}

function elevY(elevation: number): number {
  const range = profileRange.value;
  if (!range) return ELEV_PAD;
  const innerH = Math.max(ELEV_HEIGHT - ELEV_PAD * 2, 1);
  return ELEV_PAD + (1 - (elevation - range.minEle) / range.eleSpan) * innerH;
}

const hoverPoint = computed(() => {
  const track = viewTrack.value;
  const index = hoverIndex.value;
  if (!track || index === null || index < 0 || index >= track.points.length) return null;
  return track.points[index];
});

/** The elevation to read out: the point's own when it has one, else the line's. */
const hoverElevation = computed<number | null>(() => {
  const point = hoverPoint.value;
  if (point?.ele !== undefined) return point.ele;
  const samples = profile.value;
  const index = hoverIndex.value;
  if (samples.length === 0 || index === null) return null;
  const distance = distances.value[index] ?? 0;
  const nearest = nearestIndex(
    samples.map((sample) => sample.distanceMeters),
    distance,
  );
  return nearest === -1 ? null : samples[nearest].elevationMeters;
});

const crosshair = computed(() => {
  const point = hoverPoint.value;
  const index = hoverIndex.value;
  const elevation = hoverElevation.value;
  if (!point || index === null || elevation === null || !profileRange.value) return null;
  const distance = distances.value[index] ?? 0;
  return { x: elevX(distance), y: elevY(elevation), distance, elevation };
});

const hoverTimeLabel = computed(() => {
  const point = hoverPoint.value;
  return point === null || point.time === undefined ? "" : fmtTime(point.time);
});

/** The same point on the drawing, in the picture's own coordinate space. */
const trackMarker = computed(() => {
  const index = hoverIndex.value;
  if (index === null) return null;
  return trackPoints2d.value[index] ?? null;
});

function onElevMove(e: MouseEvent) {
  const range = profileRange.value;
  const el = elevBox.value;
  if (!range || !el || distances.value.length === 0) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ux = ((e.clientX - rect.left) / rect.width) * baseW.value;
  const innerW = Math.max(baseW.value - ELEV_PAD * 2, 1);
  const raw = range.startDistance + ((ux - ELEV_PAD) / innerW) * range.totalDistance;
  const target = Math.min(Math.max(raw, range.startDistance), range.endDistance);
  const index = nearestIndex(distances.value, target);
  if (index === -1) return;
  hoverIndex.value = index;
  const spot = crosshair.value;
  const scale = rect.width / baseW.value;
  hoverLeft.value = (spot ? spot.x : ux) * scale;
  hoverTop.value = (spot ? spot.y : ELEV_PAD) * scale;
}

function onElevLeave() {
  hoverIndex.value = null;
}

/* ---------------------------------------------------------------- */
/* trimming and exports                                              */
/* ---------------------------------------------------------------- */

function setTrimStart(value: number) {
  const next = Math.min(Math.max(Math.round(value), 0), lastIndex.value);
  trimStart.value = Math.min(next, trimEnd.value);
}

function setTrimEnd(value: number) {
  const next = Math.min(Math.max(Math.round(value), 0), lastIndex.value);
  trimEnd.value = Math.max(next, trimStart.value);
}

function resetTrim() {
  trimStart.value = 0;
  trimEnd.value = lastIndex.value;
  maxPoints.value = "all";
  resetView();
}

function save(text: string, extension: string, type: string) {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), `${baseName()}.${extension}`);
}

function exportGpx() {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return;
  save(mod.toGpx(track), "gpx", "application/gpx+xml");
}

function exportGeoJson() {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return;
  save(mod.toGeoJson(track), "geojson", "application/geo+json");
}

function exportCsv() {
  const mod = logic.value;
  const track = viewTrack.value;
  if (!mod || !track) return;
  save(mod.toCsv(track), "csv", "text/csv");
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

let observer: ResizeObserver | null = null;

onMounted(() => {
  const el = trackBox.value;
  if (!el) return;
  boxWidth.value = Math.max(MIN_WIDTH, Math.round(el.clientWidth || boxWidth.value));
  observer = new ResizeObserver((entries) => {
    const next = Math.max(MIN_WIDTH, Math.round(entries[0]?.contentRect.width ?? boxWidth.value));
    if (next !== boxWidth.value) boxWidth.value = next;
  });
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  clearTimeout(pasteTimer);
});

/** A different set of points means a held hover index would point elsewhere. */
watch([viewTrack, boxWidth], () => {
  hoverIndex.value = null;
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
          Track
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open a track file… </Button>
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          accept=".gpx,.kml,.geojson,.json,application/gpx+xml,application/geo+json,application/json"
          @change="onPickFile"
        />
      </div>

      <div v-if="fullTrack" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <span v-if="sourceLabel" class="shrink-0 text-muted-foreground">{{ sourceLabel }}</span>
          <button
            type="button"
            aria-label="Remove track"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearTrack"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <div v-else class="flex flex-col gap-2 px-3 pt-1 pb-3">
        <p class="text-sm text-muted-foreground">
          Drop a .gpx, .kml or .geojson file here, or paste its text below. TCX is not supported, so
          export a Garmin activity as GPX first. Everything is read in this tab: your files and
          inputs never leave your device.
        </p>
        <Textarea
          :model-value="pasted"
          rows="4"
          spellcheck="false"
          placeholder="Paste the contents of a .gpx, .kml or .geojson file here…"
          class="resize-y bg-card font-mono text-xs"
          @update:model-value="onPaste"
        />
      </div>
    </div>

    <!-- Errors -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <p v-if="busy" role="status" class="text-sm text-muted-foreground">Reading the track…</p>

    <template v-if="viewTrack && stats">
      <!-- Options -->
      <div
        class="flex flex-wrap items-end gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex w-52 flex-col gap-1.5">
          <Label for="gpx-units" class="text-xs text-muted-foreground">Units</Label>
          <SearchableSelect
            id="gpx-units"
            :spec="unitsSpec"
            :model-value="units"
            @update:model-value="(v) => (units = String(v))"
          />
        </div>
        <div class="flex w-44 flex-col gap-1.5">
          <Label for="gpx-points" class="text-xs text-muted-foreground">Points drawn</Label>
          <SearchableSelect
            id="gpx-points"
            :spec="DOWNSAMPLE_SPEC"
            :model-value="maxPoints"
            @update:model-value="(v) => (maxPoints = String(v))"
          />
        </div>
        <div class="flex w-44 flex-col gap-1.5">
          <Label for="gpx-smoothing" class="text-xs text-muted-foreground">
            Elevation smoothing (m)
          </Label>
          <Input
            id="gpx-smoothing"
            type="number"
            min="0"
            max="20"
            step="1"
            :model-value="smoothing"
            class="h-9 bg-card"
            @update:model-value="(v) => (smoothing = Math.min(20, Math.max(0, Number(v) || 0)))"
          />
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Distance</div>
          <div class="font-mono text-lg tabular-nums">{{ fmtDistance(stats.distanceMeters) }}</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Elevation gain</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.hasElevation ? fmtElevation(stats.gainMeters) : "n/a" }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Elevation loss</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.hasElevation ? fmtElevation(stats.lossMeters) : "n/a" }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Max grade</div>
          <div class="font-mono text-lg tabular-nums">
            {{ fmtGrade(stats.maxGradePercent) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Duration</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.durationSeconds === undefined ? "n/a" : fmtDuration(stats.durationSeconds) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Moving time</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.movingSeconds === undefined ? "n/a" : fmtDuration(stats.movingSeconds) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Average speed</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.avgSpeedMps === undefined ? "n/a" : fmtSpeed(stats.avgSpeedMps) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Average pace</div>
          <div class="font-mono text-lg tabular-nums">
            {{ stats.avgSpeedMps === undefined ? "n/a" : fmtPace(stats.avgSpeedMps) }}
          </div>
        </div>
      </div>

      <p class="text-xs text-muted-foreground tabular-nums">
        {{ stats.pointCount }} of {{ loadedPointCount }} points drawn, {{ stats.segmentCount }}
        {{ stats.segmentCount === 1 ? "segment" : "segments" }}, {{ stats.waypointCount }}
        {{ stats.waypointCount === 1 ? "waypoint" : "waypoints" }}
        <span v-if="trackTitle">, from "{{ trackTitle }}"</span>
      </p>

      <!-- Track drawing -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Track
        </span>
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ zoom.toFixed(1) }}x
          </span>
          <Button variant="outline" size="sm" @click="zoomButton(1 / 1.6)"> Zoom out </Button>
          <Button variant="outline" size="sm" @click="zoomButton(1.6)"> Zoom in </Button>
          <Button variant="ghost" size="sm" @click="resetView"> Reset view </Button>
        </div>
      </div>

      <div
        ref="trackBox"
        class="track-canvas relative overflow-hidden rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="panning ? 'cursor-grabbing' : 'cursor-grab'"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- the markup is built by this tool's own pure logic layer from parsed coordinates, with every interpolated value escaped there -->
        <div ref="trackFigure" class="track-figure" v-html="trackSvg" />
        <svg
          v-if="trackMarker"
          class="pointer-events-none absolute inset-0 h-full w-full text-primary"
          :viewBox="viewBox"
          aria-hidden="true"
        >
          <circle
            :cx="trackMarker.x"
            :cy="trackMarker.y"
            :r="7 / zoom"
            fill="none"
            stroke="currentColor"
            :stroke-width="2 / zoom"
          />
          <circle :cx="trackMarker.x" :cy="trackMarker.y" :r="2.5 / zoom" fill="currentColor" />
        </svg>
      </div>

      <p class="text-xs text-muted-foreground">
        There is no map background behind the track, by design: tiles would have to come from a
        third party server, which would tell that server where you have been. The scale bar and the
        north arrow carry the orientation instead. Scroll to zoom, drag to pan.
      </p>

      <!-- Elevation profile -->
      <template v-if="hasProfile">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Elevation profile
        </span>
        <div
          ref="elevBox"
          class="track-canvas relative rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          @mousemove="onElevMove"
          @mouseleave="onElevLeave"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- the markup is built by this tool's own pure logic layer from parsed elevations, with every interpolated value escaped there -->
          <div class="track-figure" v-html="elevationSvg" />
          <svg
            v-if="crosshair"
            class="pointer-events-none absolute inset-0 h-full w-full text-primary"
            :viewBox="`0 0 ${baseW} ${ELEV_HEIGHT}`"
            aria-hidden="true"
          >
            <line
              :x1="crosshair.x"
              :y1="ELEV_PAD"
              :x2="crosshair.x"
              :y2="ELEV_HEIGHT - ELEV_PAD"
              stroke="currentColor"
              stroke-width="1"
              stroke-dasharray="3 3"
            />
            <circle :cx="crosshair.x" :cy="crosshair.y" r="4" fill="currentColor" />
          </svg>
          <div
            v-if="crosshair"
            class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-[8px] border bg-popover px-2 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-[var(--sh-md)]"
            :style="{ left: `${hoverLeft}px`, top: `${hoverTop - 10}px` }"
          >
            <p class="font-mono tabular-nums">{{ fmtDistance(crosshair.distance) }}</p>
            <p class="font-mono tabular-nums">{{ fmtElevation(crosshair.elevation, 1) }}</p>
            <p v-if="hoverTimeLabel" class="text-muted-foreground">
              {{ hoverTimeLabel }}
            </p>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Point at the profile to read the distance, the elevation and the time at that sample. The
          matching spot is ringed on the track above.
        </p>
      </template>

      <p v-else class="text-xs text-muted-foreground">
        This track carries no elevation data, so there is no profile to draw.
      </p>

      <!-- Trim -->
      <div
        v-if="canTrim"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Trim
          </span>
          <Button variant="ghost" size="sm" @click="resetTrim"> Reset </Button>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground tabular-nums">
            Start point {{ trimStart }}
          </Label>
          <Slider
            aria-label="First point to keep"
            :model-value="[trimStart]"
            :min="0"
            :max="lastIndex"
            :step="1"
            class="py-2"
            @update:model-value="(v) => setTrimStart(v?.[0] ?? 0)"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground tabular-nums">
            End point {{ trimEnd }}
          </Label>
          <Slider
            aria-label="Last point to keep"
            :model-value="[trimEnd]"
            :min="0"
            :max="lastIndex"
            :step="1"
            class="py-2"
            @update:model-value="(v) => setTrimEnd(v?.[0] ?? lastIndex)"
          />
        </div>
        <p class="text-xs text-muted-foreground">
          Trimming cuts the ends off the track before the statistics, the drawing and every export.
        </p>
      </div>

      <!-- Exports -->
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" @click="exportGpx"> Download GPX </Button>
        <Button variant="outline" size="sm" @click="exportGeoJson"> Download GeoJSON </Button>
        <Button variant="outline" size="sm" @click="exportCsv"> Download CSV </Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * v-html content carries no scope attribute, so the drawing is reached through
 * :deep. The width and height baked into the SVG are its intrinsic size; this
 * lets it track the pane instead of overflowing it, and keeps the absolutely
 * positioned overlay, which is a normal scoped element, exactly on top of it.
 */
.track-figure :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
