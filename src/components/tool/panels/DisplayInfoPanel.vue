<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ToolMeta } from '@/tools/types';
import { run } from '@/tools/display-info/index';
import type { DisplayMediaFeatures, DisplaySnapshot, ScreenSummary } from '@/tools/display-info/index';
import { Button } from '@/components/ui/button';
import { Monitor, RefreshCw } from 'lucide-vue-next';
import OutputView from '../OutputView.vue';

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
interface ScreenDetailed {
  width: number;
  height: number;
  left: number;
  top: number;
  isPrimary?: boolean;
  isInternal?: boolean;
  label?: string;
}
interface ScreenDetailsHandle extends EventTarget {
  screens: ScreenDetailed[];
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

let screenDetails: ScreenDetailsHandle | null = null;
let cleanupFns: Array<() => void> = [];

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

  const orientation = window.screen.orientation;
  orientationType.value = orientation?.type ?? null;
  orientationAngle.value = typeof orientation?.angle === 'number' ? orientation.angle : null;

  colorGamut.value = matchMediaValue('color-gamut', ['rec2020', 'p3', 'srgb']);
  dynamicRange.value = matchMediaValue('dynamic-range', ['high', 'standard']);
  prefersColorScheme.value = matchMediaValue('prefers-color-scheme', ['dark', 'light']);
  prefersContrast.value = matchMediaValue('prefers-contrast', [
    'more',
    'less',
    'custom',
    'no-preference',
  ]);
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  pointer.value = matchMediaValue('pointer', ['none', 'coarse', 'fine']);
  anyPointer.value = matchMediaValue('any-pointer', ['none', 'coarse', 'fine']);
  hover.value = matchMediaValue('hover', ['none', 'hover']);
  anyHover.value = matchMediaValue('any-hover', ['none', 'hover']);

  hardwareConcurrency.value = navigator.hardwareConcurrency ?? null;

  const nav = navigator as NavigatorWithExtras;
  deviceMemory.value = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;

  const conn = nav.connection;
  if (conn) {
    networkEffectiveType.value = conn.effectiveType ?? null;
    networkDownlink.value = typeof conn.downlink === 'number' ? conn.downlink : null;
    networkRtt.value = typeof conn.rtt === 'number' ? conn.rtt : null;
    networkSaveData.value = typeof conn.saveData === 'boolean' ? conn.saveData : null;
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

function updateScreensFromDetails() {
  if (!screenDetails) return;
  screens.value = screenDetails.screens.map((s) => ({
    width: s.width,
    height: s.height,
    left: s.left,
    top: s.top,
    isPrimary: s.isPrimary,
    isInternal: s.isInternal,
    label: s.label,
  }));
}

async function detectDisplays() {
  screensError.value = null;
  const win = window as WindowWithScreenDetails;
  if (!win.getScreenDetails) {
    screensError.value = 'The Screen Details API is not available in this browser.';
    return;
  }
  try {
    screenDetails = await win.getScreenDetails();
    screensGranted.value = true;
    updateScreensFromDetails();
    const onChange = () => updateScreensFromDetails();
    screenDetails.addEventListener('screenschange', onChange);
    screenDetails.addEventListener('currentscreenchange', onChange);
    cleanupFns.push(() => {
      screenDetails?.removeEventListener('screenschange', onChange);
      screenDetails?.removeEventListener('currentscreenchange', onChange);
    });
  } catch (err) {
    screensError.value =
      err instanceof Error ? err.message : 'Could not access display details.';
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle: initial read plus live-update listeners
 * ------------------------------------------------------------------ */

onMounted(() => {
  readStaticFields();
  measureRefreshRate();
  screensSupported.value = 'getScreenDetails' in window;

  const onChange = () => readStaticFields();

  window.addEventListener('resize', onChange);
  cleanupFns.push(() => window.removeEventListener('resize', onChange));

  const orientation = window.screen.orientation;
  if (orientation) {
    orientation.addEventListener('change', onChange);
    cleanupFns.push(() => orientation.removeEventListener('change', onChange));
  }

  const MEDIA_WATCHES: [string, string[]][] = [
    ['prefers-color-scheme', ['light', 'dark']],
    ['prefers-contrast', ['no-preference', 'more', 'less', 'custom']],
    ['prefers-reduced-motion', ['no-preference', 'reduce']],
    ['pointer', ['none', 'coarse', 'fine']],
    ['any-pointer', ['none', 'coarse', 'fine']],
    ['hover', ['none', 'hover']],
    ['any-hover', ['none', 'hover']],
    ['color-gamut', ['srgb', 'p3', 'rec2020']],
    ['dynamic-range', ['standard', 'high']],
  ];
  for (const [feature, values] of MEDIA_WATCHES) {
    for (const v of values) {
      const mql = window.matchMedia(`(${feature}: ${v})`);
      mql.addEventListener('change', onChange);
      cleanupFns.push(() => mql.removeEventListener('change', onChange));
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
    mql.addEventListener('change', handler, { once: true });
    cleanupFns.push(() => mql.removeEventListener('change', handler));
  };
  trackDpr();

  const nav = navigator as NavigatorWithExtras;
  if (nav.connection) {
    const conn = nav.connection;
    conn.addEventListener('change', onChange);
    cleanupFns.push(() => conn.removeEventListener('change', onChange));
  }
});

onUnmounted(() => {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
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
    colorGamut: colorGamut.value as DisplayMediaFeatures['colorGamut'],
    dynamicRange: dynamicRange.value as DisplayMediaFeatures['dynamicRange'],
    prefersColorScheme: prefersColorScheme.value as DisplayMediaFeatures['prefersColorScheme'],
    prefersContrast: prefersContrast.value as DisplayMediaFeatures['prefersContrast'],
    prefersReducedMotion: prefersReducedMotion.value,
    pointer: pointer.value as DisplayMediaFeatures['pointer'],
    anyPointer: anyPointer.value as DisplayMediaFeatures['pointer'],
    hover: hover.value as DisplayMediaFeatures['hover'],
    anyHover: anyHover.value as DisplayMediaFeatures['hover'],
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
    title: 'Screen',
    keys: [
      'Screen resolution',
      'Available screen area',
      'Window size',
      'Aspect ratio',
      'Color depth',
      'Orientation',
    ],
  },
  { title: 'Pixel density', keys: ['Device pixel ratio', 'Physical pixel resolution'] },
  { title: 'Refresh rate', keys: ['Refresh rate'] },
  { title: 'Color and HDR', keys: ['Color gamut', 'Dynamic range (HDR)'] },
  {
    title: 'Preferences',
    keys: ['Prefers color scheme', 'Prefers contrast', 'Prefers reduced motion'],
  },
  {
    title: 'Input',
    keys: [
      'Pointer, primary input',
      'Pointer, any input',
      'Hover, primary input',
      'Hover, any input',
    ],
  },
  { title: 'Hardware', keys: ['CPU logical cores', 'Device memory'] },
  {
    title: 'Network',
    keys: ['Network type', 'Network downlink', 'Network round trip time', 'Data saver'],
  },
  { title: 'Connected displays', keys: ['Connected displays'] },
];

const groupedOutput = computed(() => {
  const out = output.value;
  if (!out) return [];
  return GROUPS.map((group) => ({
    title: group.title,
    rows: Object.fromEntries(
      group.keys.filter((k) => k in out).map((k) => [k, out[k]!]),
    ) as Record<string, string>,
  })).filter((group) => Object.keys(group.rows).length > 0);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <p class="text-xs text-muted-foreground">
      Read directly from this browser and updated live as you resize, rotate, or move the
      window: your files and inputs never leave your device.
    </p>

    <div
      v-for="group in groupedOutput"
      :key="group.title"
      class="flex flex-col gap-2"
    >
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
          <RefreshCw
            class="size-3.5"
            aria-hidden="true"
          />
          {{ measuringRate ? 'Measuring…' : 'Remeasure' }}
        </Button>

        <Button
          v-if="group.title === 'Connected displays' && screensSupported"
          variant="ghost"
          size="sm"
          @click="detectDisplays"
        >
          <Monitor
            class="size-3.5"
            aria-hidden="true"
          />
          {{ screensGranted ? 'Rescan displays' : 'Show all displays' }}
        </Button>
      </div>

      <p
        v-if="group.title === 'Connected displays' && !screensSupported"
        class="text-xs text-muted-foreground"
      >
        Listing every monitor needs the Screen Details API, available in Chromium browsers such
        as Chrome and Edge on desktop. This browser only reports the current screen below.
      </p>
      <p
        v-if="group.title === 'Connected displays' && screensError"
        role="alert"
        class="text-xs text-destructive"
      >
        {{ screensError }}
      </p>

      <OutputView :output="group.rows" />
    </div>
  </div>
</template>
