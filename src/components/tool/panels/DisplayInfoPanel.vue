<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { run, computeDisplayLayout, describeScreenDetail } from "@/tools/display-info/index";
import type {
  DisplayMediaFeatures,
  DisplaySnapshot,
  ScreenSummary,
} from "@/tools/display-info/index";
import { Button } from "@/components/ui/button";
import { Monitor, RefreshCw } from "lucide-vue-next";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for Display Info: the pure layer only knows how to describe
 * a snapshot, so this panel owns everything it cannot do, reading live
 * screen/window/navigator/matchMedia state and feeding it through the same
 * run() a JSON snapshot would use. Every browser read happens in onMounted
 * or an event handler, never at setup time, so the server-rendered shell
 * (client:load) never touches window/navigator/matchMedia.
 */
defineProps<{ meta: ToolMeta }>();

/** Chromium-only Network Information API, absent from the standard DOM lib. */
interface NavigatorConnection extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}
interface NavigatorWithExtras extends Navigator {
  deviceMemory?: number;
  connection?: NavigatorConnection;
}

/** Screen Details API (permission-gated multi-monitor layout), also absent from the DOM lib. */
interface ScreenDetailed extends EventTarget {
  width: number;
  height: number;
  left: number;
  top: number;
  availLeft?: number;
  availTop?: number;
  availWidth?: number;
  availHeight?: number;
  colorDepth?: number;
  pixelDepth?: number;
  devicePixelRatio?: number;
  isPrimary?: boolean;
  isInternal?: boolean;
  label?: string;
  orientation?: { type?: string; angle?: number } | null;
}
interface ScreenDetailsHandle extends EventTarget {
  screens: ScreenDetailed[];
  currentScreen: ScreenDetailed | null;
}
interface WindowWithScreenDetails extends Window {
  getScreenDetails?: () => Promise<ScreenDetailsHandle>;
}

/* ------------------------------------------------------------------ *
 * live state, all read only from onMounted / event handlers
 * ------------------------------------------------------------------ */

const screenWidth = ref(0);
const screenHeight = ref(0);
const availWidth = ref(0);
const availHeight = ref(0);
const colorDepth = ref(24);

const innerWidth = ref(0);
const innerHeight = ref(0);
const dpr = ref(1);

const orientationType = ref<string | null>(null);
const orientationAngle = ref<number | null>(null);

const colorGamut = ref<string | null>(null);
const dynamicRange = ref<string | null>(null);
const prefersColorScheme = ref<string | null>(null);
const prefersContrast = ref<string | null>(null);
const prefersReducedMotion = ref<boolean | null>(null);
const pointer = ref<string | null>(null);
const anyPointer = ref<string | null>(null);
const hover = ref<string | null>(null);
const anyHover = ref<string | null>(null);

const hardwareConcurrency = ref<number | null>(null);
const deviceMemory = ref<number | null>(null);

const networkEffectiveType = ref<string | null>(null);
const networkDownlink = ref<number | null>(null);
const networkRtt = ref<number | null>(null);
const networkSaveData = ref<boolean | null>(null);

const refreshRateHz = ref<number | null>(null);
const measuringRate = ref(false);

const screens = ref<ScreenSummary[] | null>(null);
const screensSupported = ref(false);
const screensGranted = ref(false);
const screensError = ref<string | null>(null);
/** True only when the browser reported an explicit permission denial, so the
 * template can show the re-grant instructions instead of a generic error. */
const screensDenied = ref(false);
const permissionState = ref<string | null>(null);
/** window.screen.isExtended: hints at more than one monitor without granting
 * per-display detail. Only meaningful in the unsupported fallback path. */
const screenIsExtended = ref<boolean | null>(null);

/** Index of the display whose full detail card is shown, or null for none. */
const selectedIndex = ref<number | null>(null);

let screenDetails: ScreenDetailsHandle | null = null;
let cleanupFns: Array<() => void> = [];
/** Per-screen "change" listeners. The screens array is replaced on every
 * screenschange, so these are torn down and reattached to the new ScreenDetailed
 * objects each time refreshScreens runs. */
let screenListenerDisposers: Array<() => void> = [];
/** Listeners on the ScreenDetails object itself (screenschange,
 * currentscreenchange). Separate from the per-screen set so a screenschange,
 * which rebuilds the per-screen set, does not remove itself in the process. */
let detailsListenerDisposers: Array<() => void> = [];

/* ------------------------------------------------------------------ *
 * reading helpers
 * ------------------------------------------------------------------ */

/** Returns the first value whose media query currently matches, or null. */
function matchMediaValue(feature: string, values: string[]): string | null {
  for (const v of values) {
    if (window.matchMedia(`(${feature}: ${v})`).matches) return v;
  }
  return null;
}

function readStaticFields() {
  screenWidth.value = window.screen.width;
  screenHeight.value = window.screen.height;
  availWidth.value = window.screen.availWidth;
  availHeight.value = window.screen.availHeight;
  colorDepth.value = window.screen.colorDepth;

  innerWidth.value = window.innerWidth;
  innerHeight.value = window.innerHeight;
  dpr.value = window.devicePixelRatio;

  const extended = (window.screen as Screen & { isExtended?: boolean }).isExtended;
  screenIsExtended.value = typeof extended === "boolean" ? extended : null;

  const orientation = window.screen.orientation;
  orientationType.value = orientation?.type ?? null;
  orientationAngle.value = typeof orientation?.angle === "number" ? orientation.angle : null;

  colorGamut.value = matchMediaValue("color-gamut", ["rec2020", "p3", "srgb"]);
  dynamicRange.value = matchMediaValue("dynamic-range", ["high", "standard"]);
  prefersColorScheme.value = matchMediaValue("prefers-color-scheme", ["dark", "light"]);
  prefersContrast.value = matchMediaValue("prefers-contrast", [
    "more",
    "less",
    "custom",
    "no-preference",
  ]);
  prefersReducedMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  pointer.value = matchMediaValue("pointer", ["none", "coarse", "fine"]);
  anyPointer.value = matchMediaValue("any-pointer", ["none", "coarse", "fine"]);
  hover.value = matchMediaValue("hover", ["none", "hover"]);
  anyHover.value = matchMediaValue("any-hover", ["none", "hover"]);

  hardwareConcurrency.value = navigator.hardwareConcurrency ?? null;

  const nav = navigator as NavigatorWithExtras;
  deviceMemory.value = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;

  const conn = nav.connection;
  if (conn) {
    networkEffectiveType.value = conn.effectiveType ?? null;
    networkDownlink.value = typeof conn.downlink === "number" ? conn.downlink : null;
    networkRtt.value = typeof conn.rtt === "number" ? conn.rtt : null;
    networkSaveData.value = typeof conn.saveData === "boolean" ? conn.saveData : null;
  }
}

/* ------------------------------------------------------------------ *
 * refresh rate: sample requestAnimationFrame deltas for about a second
 * ------------------------------------------------------------------ */

const MEASURE_FRAMES = 50;
const MEASURE_WARMUP = 5;
const MEASURE_TIMEOUT_MS = 2000;

function sampleRefreshRate(): Promise<number | null> {
  return new Promise((resolve) => {
    const samples: number[] = [];
    let last: number | null = null;
    let frame = 0;
    const start = performance.now();

    function step(t: number) {
      frame += 1;
      if (last !== null) samples.push(t - last);
      last = t;

      const enoughFrames = frame - MEASURE_WARMUP >= MEASURE_FRAMES;
      const timedOut = t - start > MEASURE_TIMEOUT_MS;
      if (enoughFrames || timedOut) {
        const usable = samples.slice(MEASURE_WARMUP);
        if (usable.length < 5) {
          resolve(null);
          return;
        }
        const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
        resolve(avg > 0 ? 1000 / avg : null);
        return;
      }
      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  });
}

async function measureRefreshRate() {
  measuringRate.value = true;
  refreshRateHz.value = await sampleRefreshRate();
  measuringRate.value = false;
}

/* ------------------------------------------------------------------ *
 * multi-monitor layout via the permission-gated Screen Details API
 * ------------------------------------------------------------------ */

/** Maps one live ScreenDetailed into the pure layer's ScreenSummary shape,
 * marking whether the window currently lives on it by reference equality. */
function toSummary(s: ScreenDetailed): ScreenSummary {
  return {
    width: s.width,
    height: s.height,
    left: s.left,
    top: s.top,
    availLeft: s.availLeft,
    availTop: s.availTop,
    availWidth: s.availWidth,
    availHeight: s.availHeight,
    colorDepth: s.colorDepth,
    pixelDepth: s.pixelDepth,
    devicePixelRatio: s.devicePixelRatio,
    isPrimary: s.isPrimary,
    isInternal: s.isInternal,
    isCurrent: screenDetails?.currentScreen === s,
    label: s.label,
    orientationType: s.orientation?.type ?? null,
    orientationAngle: typeof s.orientation?.angle === "number" ? s.orientation.angle : null,
  };
}

function disposeScreenListeners() {
  screenListenerDisposers.forEach((fn) => fn());
  screenListenerDisposers = [];
}

function disposeDetailsListeners() {
  detailsListenerDisposers.forEach((fn) => fn());
  detailsListenerDisposers = [];
}

/** Reads the current layout and (re)binds a change listener to each screen so a
 * per-monitor rotation or move updates the view. Called on grant and on every
 * screenschange, always after tearing the previous listeners down. */
function refreshScreens() {
  if (!screenDetails) return;
  disposeScreenListeners();
  const list = screenDetails.screens;
  screens.value = list.map(toSummary);

  const onScreenChange = () => {
    if (screenDetails) screens.value = screenDetails.screens.map(toSummary);
  };
  for (const s of list) {
    s.addEventListener("change", onScreenChange);
    screenListenerDisposers.push(() => s.removeEventListener("change", onScreenChange));
  }

  // Keep the selection valid if a monitor was unplugged.
  if (selectedIndex.value !== null && selectedIndex.value >= list.length) {
    selectedIndex.value = list.length > 0 ? 0 : null;
  }
}

async function detectDisplays() {
  screensError.value = null;
  screensDenied.value = false;
  const win = window as WindowWithScreenDetails;
  if (!win.getScreenDetails) {
    screensError.value = "The Screen Details API is not available in this browser.";
    return;
  }
  // Idempotent: a rescan must not stack a second set of listeners.
  disposeScreenListeners();
  disposeDetailsListeners();
  try {
    screenDetails = await win.getScreenDetails();
    screensGranted.value = true;
    refreshScreens();
    if (selectedIndex.value === null && (screens.value?.length ?? 0) > 0) {
      const cur = screens.value!.findIndex((s) => s.isCurrent);
      selectedIndex.value = cur >= 0 ? cur : 0;
    }

    const onScreensChange = () => refreshScreens();
    const onCurrentChange = () => {
      if (screenDetails) screens.value = screenDetails.screens.map(toSummary);
    };
    screenDetails.addEventListener("screenschange", onScreensChange);
    screenDetails.addEventListener("currentscreenchange", onCurrentChange);
    detailsListenerDisposers.push(() => {
      screenDetails?.removeEventListener("screenschange", onScreensChange);
      screenDetails?.removeEventListener("currentscreenchange", onCurrentChange);
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError") {
      screensDenied.value = true;
    } else {
      screensError.value = err instanceof Error ? err.message : "Could not access display details.";
    }
  }
}

/** Reflects the window-management permission state when the browser exposes it.
 * The name has two spellings across Chromium versions, and Permissions may not
 * know it at all, so every step is guarded. */
async function trackPermission() {
  const perms = navigator.permissions as
    (Permissions & { query: (d: { name: string }) => Promise<PermissionStatus> }) | undefined;
  if (!perms?.query) return;
  for (const name of ["window-management", "window-placement"]) {
    try {
      const status = await perms.query({ name });
      permissionState.value = status.state;
      const onChange = () => {
        permissionState.value = status.state;
        if (status.state === "granted") screensDenied.value = false;
      };
      status.addEventListener("change", onChange);
      cleanupFns.push(() => status.removeEventListener("change", onChange));
      return;
    } catch {
      // try the next spelling, then give up silently
    }
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle: initial read plus live-update listeners
 * ------------------------------------------------------------------ */

onMounted(() => {
  readStaticFields();
  measureRefreshRate();
  screensSupported.value = "getScreenDetails" in window;
  trackPermission();

  const onChange = () => readStaticFields();

  window.addEventListener("resize", onChange);
  cleanupFns.push(() => window.removeEventListener("resize", onChange));

  const orientation = window.screen.orientation;
  if (orientation) {
    orientation.addEventListener("change", onChange);
    cleanupFns.push(() => orientation.removeEventListener("change", onChange));
  }

  const MEDIA_WATCHES: [string, string[]][] = [
    ["prefers-color-scheme", ["light", "dark"]],
    ["prefers-contrast", ["no-preference", "more", "less", "custom"]],
    ["prefers-reduced-motion", ["no-preference", "reduce"]],
    ["pointer", ["none", "coarse", "fine"]],
    ["any-pointer", ["none", "coarse", "fine"]],
    ["hover", ["none", "hover"]],
    ["any-hover", ["none", "hover"]],
    ["color-gamut", ["srgb", "p3", "rec2020"]],
    ["dynamic-range", ["standard", "high"]],
  ];
  for (const [feature, values] of MEDIA_WATCHES) {
    for (const v of values) {
      const mql = window.matchMedia(`(${feature}: ${v})`);
      mql.addEventListener("change", onChange);
      cleanupFns.push(() => mql.removeEventListener("change", onChange));
    }
  }

  // devicePixelRatio has no single media query of its own: re-subscribe to a
  // query pinned to the current ratio each time it fires, the standard idiom
  // for detecting zoom or a move to a display with a different density.
  const trackDpr = () => {
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const handler = () => {
      onChange();
      trackDpr();
    };
    mql.addEventListener("change", handler, { once: true });
    cleanupFns.push(() => mql.removeEventListener("change", handler));
  };
  trackDpr();

  const nav = navigator as NavigatorWithExtras;
  if (nav.connection) {
    const conn = nav.connection;
    conn.addEventListener("change", onChange);
    cleanupFns.push(() => conn.removeEventListener("change", onChange));
  }
});

onUnmounted(() => {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  disposeScreenListeners();
  disposeDetailsListeners();
});

/* ------------------------------------------------------------------ *
 * assemble the snapshot and hand it to the pure logic layer
 * ------------------------------------------------------------------ */

const snapshot = computed<DisplaySnapshot>(() => ({
  screen: {
    width: screenWidth.value,
    height: screenHeight.value,
    availWidth: availWidth.value,
    availHeight: availHeight.value,
    colorDepth: colorDepth.value,
  },
  window: {
    innerWidth: innerWidth.value,
    innerHeight: innerHeight.value,
    devicePixelRatio: dpr.value,
  },
  orientation: { type: orientationType.value, angle: orientationAngle.value },
  media: {
    colorGamut: colorGamut.value as DisplayMediaFeatures["colorGamut"],
    dynamicRange: dynamicRange.value as DisplayMediaFeatures["dynamicRange"],
    prefersColorScheme: prefersColorScheme.value as DisplayMediaFeatures["prefersColorScheme"],
    prefersContrast: prefersContrast.value as DisplayMediaFeatures["prefersContrast"],
    prefersReducedMotion: prefersReducedMotion.value,
    pointer: pointer.value as DisplayMediaFeatures["pointer"],
    anyPointer: anyPointer.value as DisplayMediaFeatures["pointer"],
    hover: hover.value as DisplayMediaFeatures["hover"],
    anyHover: anyHover.value as DisplayMediaFeatures["hover"],
  },
  hardware: { hardwareConcurrency: hardwareConcurrency.value, deviceMemory: deviceMemory.value },
  network: {
    effectiveType: networkEffectiveType.value,
    downlinkMbps: networkDownlink.value,
    rttMs: networkRtt.value,
    saveData: networkSaveData.value,
  },
  refreshRateHz: refreshRateHz.value,
  screens: screens.value,
}));

const output = computed<Record<string, string> | null>(() => {
  try {
    return run(JSON.stringify(snapshot.value), {});
  } catch {
    return null;
  }
});

/** Groups the flat run() output into labeled sections for the panel. Keys
 * come straight from index.ts, so a row only ever appears in one place. */
const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "Screen",
    keys: [
      "Screen resolution",
      "Available screen area",
      "Window size",
      "Aspect ratio",
      "Color depth",
      "Orientation",
    ],
  },
  { title: "Pixel density", keys: ["Device pixel ratio", "Physical pixel resolution"] },
  { title: "Refresh rate", keys: ["Refresh rate"] },
  { title: "Color and HDR", keys: ["Color gamut", "Dynamic range (HDR)"] },
  {
    title: "Preferences",
    keys: ["Prefers color scheme", "Prefers contrast", "Prefers reduced motion"],
  },
  {
    title: "Input",
    keys: [
      "Pointer, primary input",
      "Pointer, any input",
      "Hover, primary input",
      "Hover, any input",
    ],
  },
  { title: "Hardware", keys: ["CPU logical cores", "Device memory"] },
  {
    title: "Network",
    keys: ["Network type", "Network downlink", "Network round trip time", "Data saver"],
  },
  { title: "Connected displays", keys: ["Connected displays"] },
];

const groupedOutput = computed(() => {
  const out = output.value;
  if (!out) return [];
  return GROUPS.map((group) => ({
    title: group.title,
    rows: Object.fromEntries(group.keys.filter((k) => k in out).map((k) => [k, out[k]!])) as Record<
      string,
      string
    >,
  })).filter((group) => Object.keys(group.rows).length > 0);
});

/* ------------------------------------------------------------------ *
 * the to-scale diagram and per-display detail
 * ------------------------------------------------------------------ */

// A nominal width in diagram pixels: the SVG viewBox is drawn at this size and
// scaled to the panel width by CSS, so the arrangement stays exactly to scale
// at any container width without a ResizeObserver.
const DIAGRAM_WIDTH = 1000;
const DIAGRAM_PADDING = 12;

const layout = computed(() => computeDisplayLayout(screens.value, DIAGRAM_WIDTH, DIAGRAM_PADDING));

const hasDisplays = computed(() => (screens.value?.length ?? 0) > 0);

function selectDisplay(index: number) {
  selectedIndex.value = index;
}

function onRectKey(event: KeyboardEvent, index: number) {
  if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    selectDisplay(index);
  }
}

const selectedDetail = computed<Record<string, string> | null>(() => {
  const list = screens.value;
  const idx = selectedIndex.value;
  if (!list || idx === null || idx < 0 || idx >= list.length) return null;
  return describeScreenDetail(list[idx]!, idx);
});

const selectedName = computed(() => selectedDetail.value?.["Label"] ?? null);
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <p class="text-xs text-muted-foreground">
      Read directly from this browser and updated live as you resize, rotate, or move the window:
      your files and inputs never leave your device.
    </p>

    <div v-for="group in groupedOutput" :key="group.title" class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">{{
          group.title
        }}</span>

        <Button
          v-if="group.title === 'Refresh rate'"
          variant="ghost"
          size="sm"
          :disabled="measuringRate"
          @click="measureRefreshRate"
        >
          <RefreshCw class="size-3.5" aria-hidden="true" />
          {{ measuringRate ? "Measuring…" : "Remeasure" }}
        </Button>

        <Button
          v-if="group.title === 'Connected displays' && screensSupported"
          variant="ghost"
          size="sm"
          @click="detectDisplays"
        >
          <Monitor class="size-3.5" aria-hidden="true" />
          {{ screensGranted ? "Rescan displays" : "Show all displays" }}
        </Button>
      </div>

      <template v-if="group.title === 'Connected displays'">
        <p v-if="!screensSupported" class="text-xs text-muted-foreground">
          Listing every monitor needs the Screen Details API, available in Chromium browsers such as
          Chrome and Edge on desktop. This browser only reports the current screen below.
          <span v-if="screenIsExtended === true">
            Your system does report more than one display connected (screen.isExtended), but full
            per-display detail is not available here.
          </span>
        </p>

        <div
          v-if="screensDenied"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-foreground">Permission was declined</span>
          <span class="text-muted-foreground">
            To see every display, allow the window management permission: click the icon at the left
            of the address bar (or open this site's settings), set "Window management" to Allow,
            then press "Show all displays" again. The single screen readout below stays available
            either way.
          </span>
        </div>

        <p v-if="screensError" role="alert" class="text-xs text-destructive">
          {{ screensError }}
        </p>
      </template>

      <OutputView :output="group.rows" />

      <!-- to-scale arrangement of every connected display -->
      <div v-if="group.title === 'Connected displays' && hasDisplays" class="flex flex-col gap-3">
        <svg
          class="w-full rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          :style="{ aspectRatio: `${layout.width} / ${Math.max(layout.height, 1)}` }"
          role="group"
          aria-label="Scale diagram of connected displays"
        >
          <g
            v-for="rect in layout.rects"
            :key="rect.index"
            class="display-rect"
            :class="{ selected: rect.index === selectedIndex }"
            role="button"
            tabindex="0"
            :aria-label="`${rect.label}, ${rect.resolution} pixels${rect.isPrimary ? ', primary' : ''}${rect.isCurrent ? ', current window' : ''}`"
            :aria-pressed="rect.index === selectedIndex"
            @click="selectDisplay(rect.index)"
            @focus="selectDisplay(rect.index)"
            @keydown="onRectKey($event, rect.index)"
          >
            <rect
              :x="rect.x"
              :y="rect.y"
              :width="rect.width"
              :height="rect.height"
              rx="6"
              class="rect-body"
              :class="{ primary: rect.isPrimary, current: rect.isCurrent }"
            />
            <text
              :x="rect.x + rect.width / 2"
              :y="rect.y + rect.height / 2 - 6"
              text-anchor="middle"
              class="rect-name"
            >
              {{ rect.label }}
            </text>
            <text
              :x="rect.x + rect.width / 2"
              :y="rect.y + rect.height / 2 + 16"
              text-anchor="middle"
              class="rect-res"
            >
              {{ rect.resolution }}
            </text>
          </g>
        </svg>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1.5">
            <span class="legend-swatch primary" aria-hidden="true"></span> Primary
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span class="legend-swatch current" aria-hidden="true"></span> Current window
          </span>
          <span>Select a display to see its full detail.</span>
        </div>

        <div v-if="selectedDetail" class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ selectedName }}
          </span>
          <OutputView :output="selectedDetail" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.display-rect {
  cursor: pointer;
  outline: none;
}

.rect-body {
  fill: var(--card);
  stroke: var(--input);
  stroke-width: 2;
  transition:
    fill 120ms ease-out,
    stroke 120ms ease-out;
}

/* Current display: a soft violet wash. Primary: a violet outline. A display can
 * be both, in which case it gets the wash and the stronger stroke. */
.rect-body.current {
  fill: color-mix(in srgb, var(--primary) 18%, var(--card));
}

.rect-body.primary {
  stroke: var(--primary);
  stroke-width: 3;
}

.display-rect:hover .rect-body {
  stroke: var(--primary);
}

/* Selection ring, also the focus-visible indicator (styled explicitly because
 * the UA focus ring on SVG elements is inconsistent). */
.display-rect.selected .rect-body,
.display-rect:focus-visible .rect-body {
  stroke: var(--ring);
  stroke-width: 3;
}

.rect-name {
  fill: var(--foreground);
  font-size: 15px;
  font-weight: 600;
}

.rect-res {
  fill: var(--muted-foreground);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.legend-swatch {
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.legend-swatch.primary {
  border-color: var(--primary);
  border-width: 2px;
}

.legend-swatch.current {
  background: color-mix(in srgb, var(--primary) 18%, var(--card));
}

@media (prefers-reduced-motion: reduce) {
  .rect-body {
    transition: none;
  }
}
</style>
