<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { SelectGroup, ToolMeta } from "@/tools/types";
import {
  TESTS,
  describeTest,
  gammaFromMatch,
  renderPatternSvg,
  type MonitorTest,
} from "@/tools/monitor-test/index";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-vue-next";

/**
 * Bespoke panel for the Monitor Test Suite: a catalog of test cards plus the
 * fullscreen runner the pure layer deliberately cannot own (rule 27). The
 * logic layer still supplies everything it can: the test list, the per-test
 * instructions, the static pattern SVG, and the gamma formula. This file only
 * adds what needs a browser: the Fullscreen API, a canvas with a
 * requestAnimationFrame loop for the motion tests, timers, and key handling.
 * Nothing here reads window or document at setup time, so the server-rendered
 * shell stays inert.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * the catalog, grouped the same way the tool's select groups it
 * ------------------------------------------------------------------ */

interface TestGroup {
  label: string;
  tests: MonitorTest[];
}

const TEST_BY_ID = new Map(TESTS.map((t) => [t.id, t] as const));

function collectGroup(group: SelectGroup, out: TestGroup[]) {
  const tests = (group.options ?? [])
    .map((o) => TEST_BY_ID.get(o.value))
    .filter((t): t is MonitorTest => t !== undefined);
  if (tests.length) out.push({ label: group.label, tests });
  for (const child of group.groups ?? []) collectGroup(child, out);
}

/** Card sections, taken from the meta select so the two never drift apart. */
const groups = computed<TestGroup[]>(() => {
  const out: TestGroup[] = [];
  const spec = props.meta.options?.find((o) => o.kind === "select" && o.id === "test");
  if (spec && spec.kind === "select") {
    for (const group of spec.groups ?? []) collectGroup(group, out);
  }
  // Any test the select does not list still gets a home, so the catalog is
  // always complete even if the two ever fall out of step.
  const seen = new Set(out.flatMap((g) => g.tests.map((t) => t.id)));
  const rest = TESTS.filter((t) => !seen.has(t.id));
  if (rest.length) out.push({ label: out.length ? "Other tests" : "All tests", tests: rest });
  return out;
});

/** Flattened card order, which is also the fullscreen navigation order. */
const orderedTests = computed<MonitorTest[]>(() => groups.value.flatMap((g) => g.tests));

const total = computed(() => orderedTests.value.length);

/** Small preview for a card. Same renderer the fullscreen view uses. */
function thumbnail(test: MonitorTest): string {
  return renderPatternSvg(test.id, { width: 320, height: 180 });
}

/* ------------------------------------------------------------------ *
 * runner state
 * ------------------------------------------------------------------ */

const running = ref(false);
const index = ref(0);

const current = computed<MonitorTest | null>(() => orderedTests.value[index.value] ?? null);

const detail = computed<Record<string, string> | null>(() =>
  current.value ? describeTest(current.value.id) : null,
);

const instructions = computed(() => detail.value?.["Instructions"] ?? "");

/** Viewport size in CSS pixels, measured only while the runner is open. */
const viewW = ref(0);
const viewH = ref(0);

type ViewMode = "cycle" | "motion" | "gamma" | "text" | "svg";

/** Which renderer the current test needs. Driven by kind and params, not ids. */
const mode = computed<ViewMode>(() => {
  const test = current.value;
  if (!test) return "svg";
  if (test.kind === "motion") return "motion";
  if (test.kind === "text") return "text";
  if (test.kind === "pattern" && test.params.patternType === "gamma") return "gamma";
  if (test.kind === "solid" && Array.isArray(test.params.colors)) return "cycle";
  return "svg";
});

/** The static pattern, rendered by the tool's own logic layer at viewport size. */
const patternSvg = computed(() => {
  const test = current.value;
  if (!running.value || !test || viewW.value <= 0 || viewH.value <= 0) return "";
  return renderPatternSvg(test.id, { width: viewW.value, height: viewH.value });
});

/* ------------------------------------------------------------------ *
 * color helpers
 * ------------------------------------------------------------------ */

/** Turns a 0..100 gray percent into a CSS color. */
function grayCss(percent: number): string {
  const v = Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);
  return `rgb(${v}, ${v}, ${v})`;
}

/** Rough perceived lightness of a #rrggbb color, 0 to 1. */
function lightness(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/* ------------------------------------------------------------------ *
 * color cycle (dead and stuck pixel scan)
 * ------------------------------------------------------------------ */

const cycleColors = computed<string[]>(() => {
  const raw = current.value?.params.colors;
  return Array.isArray(raw) ? (raw as string[]) : [];
});

const cycleIndex = ref(0);
const cycleColor = computed(() => cycleColors.value[cycleIndex.value] ?? "#000000");

let cycleTimer: ReturnType<typeof setInterval> | null = null;

function stopCycle() {
  if (cycleTimer !== null) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
}

function startCycle() {
  stopCycle();
  cycleIndex.value = 0;
  const raw = Number(current.value?.params.intervalMs ?? 2000);
  const ms = Number.isFinite(raw) && raw >= 100 ? raw : 2000;
  cycleTimer = setInterval(() => {
    const count = cycleColors.value.length;
    if (count > 0) cycleIndex.value = (cycleIndex.value + 1) % count;
  }, ms);
}

/* ------------------------------------------------------------------ *
 * gamma check
 * ------------------------------------------------------------------ */

/** Gray percent of the solid patch. 73 percent is the match for gamma 2.2. */
const gammaPercent = ref(73);

const gammaReadout = computed(() => {
  try {
    return gammaFromMatch(gammaPercent.value / 100).toFixed(2);
  } catch {
    return "not measurable";
  }
});

function setGamma(percent: number) {
  gammaPercent.value = Math.min(99, Math.max(1, Math.round(percent)));
}

/* ------------------------------------------------------------------ *
 * motion tests (ghosting, motion blur)
 * ------------------------------------------------------------------ */

/** Three blocks at different speeds, the way the classic UFO test does it. */
const SPEED_MULTIPLIERS = [0.5, 1, 2];
const MIN_SPEED = 1;
const MAX_SPEED = 40;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const speed = ref(6);

let rafId = 0;
let offset = 0;

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 6;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value)));
}

function changeSpeed(delta: number) {
  speed.value = clampSpeed(speed.value + delta);
}

function drawMotionFrame() {
  const canvas = canvasRef.value;
  const test = current.value;
  if (!canvas || !test) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = viewW.value;
  const h = viewH.value;
  if (w <= 0 || h <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelW = Math.round(w * dpr);
  const pixelH = Math.round(h * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const background = String(test.params.background ?? "#000000");
  const blockColor = String(test.params.blockColor ?? "#ffffff");
  const size = Math.max(8, Number(test.params.blockSizePx ?? 60));
  const vertical = test.params.direction === "vertical";

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  const travel = (vertical ? h : w) + size;
  const across = vertical ? w : h;
  const label = lightness(background) > 0.5 ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.55)";

  SPEED_MULTIPLIERS.forEach((multiplier, row) => {
    const along = ((((offset * multiplier) % travel) + travel) % travel) - size;
    const lane = ((row + 1) * across) / (SPEED_MULTIPLIERS.length + 1) - size / 2;
    const x = vertical ? lane : along;
    const y = vertical ? along : lane;

    ctx.fillStyle = blockColor;
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = label;
    ctx.font = "12px sans-serif";
    ctx.fillText(`${multiplier}x`, vertical ? lane : 14, vertical ? 20 : Math.max(14, lane - 8));
  });

  offset += speed.value;
}

function stopMotion() {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function motionLoop() {
  drawMotionFrame();
  rafId = requestAnimationFrame(motionLoop);
}

function startMotion() {
  stopMotion();
  offset = 0;
  speed.value = clampSpeed(Number(current.value?.params.speedPxPerFrame ?? 6));
  rafId = requestAnimationFrame(motionLoop);
}

/* ------------------------------------------------------------------ *
 * text clarity
 * ------------------------------------------------------------------ */

const textLines = computed<string[]>(() => {
  const raw = current.value?.params.lines;
  return Array.isArray(raw) ? (raw as string[]) : [];
});

const textSizes = computed<number[]>(() => {
  const raw = current.value?.params.sizesPx;
  return Array.isArray(raw) ? (raw as number[]) : [12];
});

/** One sample row per size, cycling through the sample lines like the SVG does. */
const textRows = computed(() =>
  textSizes.value.map((size, i) => ({
    size,
    text: textLines.value[i % Math.max(1, textLines.value.length)] ?? "Sample text",
  })),
);

/* ------------------------------------------------------------------ *
 * overlay chrome: the hint, the controls, and the cursor
 * ------------------------------------------------------------------ */

const chromeVisible = ref(true);
const cursorHidden = ref(false);

let hintTimer: ReturnType<typeof setTimeout> | null = null;
let cursorTimer: ReturnType<typeof setTimeout> | null = null;

function clearChromeTimers() {
  if (hintTimer !== null) clearTimeout(hintTimer);
  if (cursorTimer !== null) clearTimeout(cursorTimer);
  hintTimer = null;
  cursorTimer = null;
}

/** Wake the overlay up, then start the fade and cursor-hide timers again. */
function poke() {
  clearChromeTimers();
  chromeVisible.value = true;
  cursorHidden.value = false;
  hintTimer = setTimeout(() => (chromeVisible.value = false), 3000);
  cursorTimer = setTimeout(() => (cursorHidden.value = true), 2000);
}

/* ------------------------------------------------------------------ *
 * fullscreen
 * ------------------------------------------------------------------ */

interface FsElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

const layerRef = ref<HTMLElement | null>(null);

/** The trigger gets focus back when the runner closes. */
const START_BUTTON_ID = "monitor-test-start";

/** True once we asked for real fullscreen, so we know to give it back. */
let requestedFullscreen = false;

function fullscreenElement(): Element | null {
  const doc = document as FsDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function enterFullscreen() {
  const el = layerRef.value as FsElement | null;
  if (!el) return;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) return;
  requestedFullscreen = true;
  // A browser can refuse this (an iframe without the permission, a policy, a
  // stale user gesture). The fixed layer already covers the viewport, so a
  // refusal costs nothing but the browser chrome staying on screen.
  Promise.resolve(request.call(el)).catch(() => {
    requestedFullscreen = false;
  });
}

function leaveFullscreen() {
  if (!requestedFullscreen) return;
  requestedFullscreen = false;
  const doc = document as FsDocument;
  if (fullscreenElement() === null) return;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (exit) Promise.resolve(exit.call(doc)).catch(() => {});
}

/** Escape inside real fullscreen never reaches keydown, so this is the exit. */
function onFullscreenChange() {
  if (!running.value || !requestedFullscreen) return;
  if (fullscreenElement() === null) {
    requestedFullscreen = false;
    stop();
  }
}

/* ------------------------------------------------------------------ *
 * navigation
 * ------------------------------------------------------------------ */

/** Restart whatever the newly shown test needs, once it is in the DOM. */
async function syncTest() {
  stopCycle();
  stopMotion();
  await nextTick();
  if (!running.value) return;
  if (mode.value === "cycle") startCycle();
  else if (mode.value === "motion") startMotion();
  poke();
}

function goTo(next: number) {
  if (total.value === 0) return;
  const wrapped = ((next % total.value) + total.value) % total.value;
  index.value = wrapped;
}

function nextTest() {
  goTo(index.value + 1);
}

function prevTest() {
  goTo(index.value - 1);
}

/* Typed digits accumulate briefly, so a two digit test number also works. */
let jumpBuffer = "";
let jumpTimer: ReturnType<typeof setTimeout> | null = null;

function clearJump() {
  if (jumpTimer !== null) clearTimeout(jumpTimer);
  jumpTimer = null;
  jumpBuffer = "";
}

function pushDigit(digit: string) {
  jumpBuffer += digit;
  const value = Number(jumpBuffer);
  if (value >= 1 && value <= total.value) goTo(value - 1);
  if (jumpTimer !== null) clearTimeout(jumpTimer);
  // No further digit could make a valid number, so commit right away.
  if (value * 10 > total.value) clearJump();
  else jumpTimer = setTimeout(clearJump, 800);
}

function measure() {
  viewW.value = window.innerWidth;
  viewH.value = window.innerHeight;
}

function onKeyDown(event: KeyboardEvent) {
  if (!running.value) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const key = event.key;

  if (key === "Escape") {
    event.preventDefault();
    stop();
    return;
  }
  // A focused control in the overlay owns its own keys: the gamma slider needs
  // the arrow keys, and it should not also step to the next test.
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("[data-runner-controls]")) return;

  if (key === "ArrowRight" || key === " " || key === "Spacebar" || key === "PageDown") {
    event.preventDefault();
    nextTest();
    return;
  }
  if (key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    prevTest();
    return;
  }
  if (key === "Home") {
    event.preventDefault();
    goTo(0);
    return;
  }
  if (key === "End") {
    event.preventDefault();
    goTo(total.value - 1);
    return;
  }
  if (key === "f" || key === "F") {
    event.preventDefault();
    if (fullscreenElement() === null) enterFullscreen();
    else leaveFullscreen();
    poke();
    return;
  }
  if (key === "+" || key === "=" || key === "-" || key === "_") {
    event.preventDefault();
    if (mode.value === "motion") changeSpeed(key === "+" || key === "=" ? 1 : -1);
    poke();
    return;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    event.preventDefault();
    if (mode.value === "gamma") setGamma(gammaPercent.value + (key === "ArrowUp" ? 1 : -1));
    poke();
    return;
  }
  if (/^[0-9]$/.test(key)) {
    event.preventDefault();
    pushDigit(key);
    poke();
  }
}

/* ------------------------------------------------------------------ *
 * start and stop
 * ------------------------------------------------------------------ */

function start(at = 0) {
  if (running.value) return;
  index.value = total.value ? Math.min(Math.max(0, at), total.value - 1) : 0;
  running.value = true;
  measure();
  // The page behind must not scroll while the test layer covers it.
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", measure);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  void nextTick(() => {
    layerRef.value?.focus();
    enterFullscreen();
  });
  void syncTest();
}

function stop() {
  if (!running.value) return;
  running.value = false;
  stopCycle();
  stopMotion();
  clearChromeTimers();
  clearJump();
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", measure);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  leaveFullscreen();
  document.body.style.overflow = "";
  void nextTick(() => document.getElementById(START_BUTTON_ID)?.focus());
}

watch(index, () => {
  void syncTest();
});

onUnmounted(() => {
  // Whatever state the runner was in, nothing may outlive the panel: no rAF,
  // no timers, no listeners, and no fullscreen left switched on.
  stopCycle();
  stopMotion();
  clearChromeTimers();
  clearJump();
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", measure);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    leaveFullscreen();
    document.body.style.overflow = "";
  }
  running.value = false;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-col gap-3">
      <p class="max-w-[68ch] text-sm text-muted-foreground">
        Every pattern runs full screen, so the whole display is under test with no browser chrome in
        the way. Start with the first test or jump straight to one, then step through them with the
        arrow keys. Your files and inputs never leave your device.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button :id="START_BUTTON_ID" :disabled="total === 0" @click="start(0)">
          <Maximize2 class="size-4" />
          Start fullscreen test
        </Button>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ total }} tests in the suite
        </span>
      </div>
      <p class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>In fullscreen:</span>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">Right</kbd>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">Space</kbd>
        <span>next,</span>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">Left</kbd>
        <span>previous,</span>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">1</kbd>
        <span>to</span>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">{{ total }}</kbd>
        <span>jump,</span>
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono">Esc</kbd>
        <span>exit.</span>
      </p>
    </div>

    <!-- The catalog -->
    <div v-for="group in groups" :key="group.label" class="flex flex-col gap-3">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{ group.label }}
      </span>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <button
          v-for="test in group.tests"
          :key="test.id"
          type="button"
          class="flex flex-col overflow-hidden rounded-[14px] border bg-card text-left shadow-[var(--sh-sm)] transition-[transform,box-shadow,border-color] duration-[160ms] ease-[cubic-bezier(.2,.7,.3,1)] hover:-translate-y-0.5 hover:border-[color:var(--brand-hairline)] hover:shadow-[var(--sh-md)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          @click="start(orderedTests.indexOf(test))"
        >
          <!-- The preview comes from this tool's own logic layer, which builds
               the markup itself and escapes every value it interpolates. -->
          <!-- eslint-disable-next-line vue/no-v-html -- the SVG is produced by src/tools/monitor-test, from its own constant catalog, with every interpolated label escaped there -->
          <span class="thumb block border-b bg-secondary" v-html="thumbnail(test)" />
          <span class="flex flex-col gap-1 p-4">
            <span class="text-[17px] leading-[1.35] font-semibold">{{ test.label }}</span>
            <span class="text-[13.5px] leading-[1.5] text-muted-foreground">
              {{ test.purpose }}
            </span>
          </span>
        </button>
      </div>
    </div>

    <!-- The fullscreen runner. Fixed layer first, real fullscreen on top of it
         when the browser allows it, so the test still fills the screen either way. -->
    <div
      v-if="running && current"
      ref="layerRef"
      role="dialog"
      aria-modal="true"
      aria-label="Monitor test"
      tabindex="-1"
      class="fixed inset-0 z-[100] overflow-hidden bg-black outline-none"
      :class="cursorHidden ? 'cursor-none' : 'cursor-default'"
      @click="nextTest"
      @mousemove="poke"
    >
      <!-- Static patterns: the logic layer renders the whole viewport. -->
      <!-- eslint-disable vue/no-v-html -- the SVG is produced by src/tools/monitor-test, from its own constant catalog, with every interpolated label escaped there -->
      <div
        v-if="mode === 'svg'"
        class="pattern-host h-full w-full"
        aria-hidden="true"
        v-html="patternSvg"
      ></div>
      <!-- eslint-enable vue/no-v-html -->

      <!-- Color cycle: a real full screen color that steps on the test's own interval. -->
      <div
        v-else-if="mode === 'cycle'"
        class="h-full w-full"
        aria-hidden="true"
        :style="{ backgroundColor: cycleColor }"
      ></div>

      <!-- Motion: the block positions are ours, drawn per animation frame. -->
      <canvas
        v-else-if="mode === 'motion'"
        ref="canvasRef"
        class="block h-full w-full"
        aria-hidden="true"
      ></canvas>

      <!-- Gamma: solid patch beside a one pixel black and white stripe field. -->
      <div v-else-if="mode === 'gamma'" class="flex h-full w-full" aria-hidden="true">
        <div class="h-full w-1/2" :style="{ backgroundColor: grayCss(gammaPercent) }"></div>
        <svg class="h-full w-1/2" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="monitor-gamma-stripes" width="2" height="2" patternUnits="userSpaceOnUse">
              <rect width="1" height="2" fill="#000000" />
              <rect x="1" width="1" height="2" fill="#ffffff" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#monitor-gamma-stripes)" />
        </svg>
      </div>

      <!-- Text clarity: real text, not an image, so subpixel rendering is honest. -->
      <div v-else-if="mode === 'text'" class="flex h-full w-full flex-col">
        <div class="flex flex-1 flex-col justify-center gap-3 bg-white px-8 text-black">
          <p
            v-for="row in textRows"
            :key="`light-${row.size}`"
            class="leading-snug"
            :style="{ fontSize: `${row.size}px` }"
          >
            {{ row.size }}px&nbsp;&nbsp;{{ row.text }}
          </p>
        </div>
        <div class="flex flex-1 flex-col justify-center gap-3 bg-black px-8 text-white">
          <p
            v-for="row in textRows"
            :key="`dark-${row.size}`"
            class="leading-snug"
            :style="{ fontSize: `${row.size}px` }"
          >
            {{ row.size }}px&nbsp;&nbsp;{{ row.text }}
          </p>
        </div>
      </div>

      <!-- The overlay: name, position, instructions, and per-test controls. -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 transition-opacity duration-200 ease-out motion-reduce:transition-none sm:p-6"
        :class="chromeVisible ? 'opacity-100' : 'opacity-0'"
      >
        <div
          data-runner-controls
          class="flex w-full max-w-[640px] flex-col gap-3 rounded-[14px] bg-black/75 p-4 text-white ring-1 ring-white/20 backdrop-blur-sm"
          :class="chromeVisible ? 'pointer-events-auto' : 'pointer-events-none'"
          @click.stop
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[15px] font-semibold">{{ current.label }}</span>
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-white/70 tabular-nums">
                {{ index + 1 }} / {{ total }}
              </span>
              <!-- Touch and pointer exits, for a browser that refuses real
                   fullscreen and leaves only the fixed layer and no Esc key. -->
              <button
                type="button"
                class="inline-flex size-7 items-center justify-center rounded-[8px] bg-white/15 hover:bg-white/25"
                aria-label="Previous test"
                @click="prevTest"
              >
                <ChevronLeft class="size-4" />
              </button>
              <button
                type="button"
                class="inline-flex size-7 items-center justify-center rounded-[8px] bg-white/15 hover:bg-white/25"
                aria-label="Next test"
                @click="nextTest"
              >
                <ChevronRight class="size-4" />
              </button>
              <button
                type="button"
                class="inline-flex h-7 items-center justify-center gap-1 rounded-[8px] bg-white/15 px-2 text-xs hover:bg-white/25"
                aria-label="Exit the test"
                @click="stop"
              >
                <X class="size-3.5" />
                Exit
              </button>
            </div>
          </div>

          <p class="max-h-28 overflow-y-auto text-[13.5px] leading-[1.5] text-white/80">
            {{ instructions }}
          </p>

          <!-- Gamma control: the solid patch level, plus the measured gamma. -->
          <div v-if="mode === 'gamma'" class="flex flex-col gap-2">
            <div class="flex items-baseline justify-between gap-3 text-xs">
              <span class="text-white/70">
                Solid patch gray level, matched against the stripes
              </span>
              <span class="font-mono tabular-nums">{{ gammaPercent }}%</span>
            </div>
            <Slider
              :model-value="[gammaPercent]"
              :min="1"
              :max="99"
              :step="1"
              aria-label="Solid patch gray level"
              class="py-1"
              @update:model-value="(v) => setGamma(Number(v?.[0] ?? gammaPercent))"
            />
            <p class="font-mono text-sm tabular-nums">Measured gamma: {{ gammaReadout }}</p>
            <p class="text-xs text-white/60">
              Step back until the two halves blend, adjust with the slider or the up and down arrow
              keys, then read the gamma above. A calibrated display matches near 73 percent.
            </p>
          </div>

          <!-- Motion control: the speed the blocks travel at. -->
          <div v-else-if="mode === 'motion'" class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs text-white/70">Speed</span>
              <div class="flex items-center gap-2">
                <span class="font-mono text-sm tabular-nums">{{ speed }} px per frame</span>
                <button
                  type="button"
                  class="size-7 rounded-[8px] bg-white/15 font-mono text-sm hover:bg-white/25"
                  aria-label="Slower"
                  @click="changeSpeed(-1)"
                >
                  -
                </button>
                <button
                  type="button"
                  class="size-7 rounded-[8px] bg-white/15 font-mono text-sm hover:bg-white/25"
                  aria-label="Faster"
                  @click="changeSpeed(1)"
                >
                  +
                </button>
              </div>
            </div>
            <p class="text-xs text-white/60">
              Three blocks run at half, normal, and double speed. Change the speed with the plus and
              minus keys.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-1.5 text-xs text-white/60">
            <kbd class="rounded-[8px] bg-white/15 px-1.5 py-0.5 font-mono text-white/80">Right</kbd>
            <span>next,</span>
            <kbd class="rounded-[8px] bg-white/15 px-1.5 py-0.5 font-mono text-white/80">Left</kbd>
            <span>previous,</span>
            <kbd class="rounded-[8px] bg-white/15 px-1.5 py-0.5 font-mono text-white/80">F</kbd>
            <span>fullscreen,</span>
            <kbd class="rounded-[8px] bg-white/15 px-1.5 py-0.5 font-mono text-white/80">Esc</kbd>
            <span>exit. Click anywhere for the next test.</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * v-html markup carries no scope attribute, so both the card thumbnails and
 * the fullscreen pattern are reached through :deep. The width and height baked
 * into each SVG are its intrinsic size; stretching it to the box is what makes
 * the pattern cover the viewport exactly.
 */
.thumb :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}

.pattern-host :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
