<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RotateCcw } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  EASING_PRESETS,
  curveExtent,
  easingAt,
  formatCubicBezier,
  linearApproximation,
  nearestPreset,
  parseCubicBezier,
  presetControls,
  trimNumber,
  type BezierControls,
} from "@/tools/cubic-bezier-easing-editor/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";

/**
 * Bespoke panel for the Cubic Bezier Easing Editor.
 *
 * All of the math lives in `src/tools/cubic-bezier-easing-editor/`
 * (PROJECT.md rule 27): this file maps pointer and key events onto control
 * points, draws the curve, and runs the preview. Nothing here evaluates a
 * bezier itself.
 *
 * The plot is 240 by 240 user units for the unit square, inside a viewBox with
 * room above and below for a curve that overshoots. The SVG keeps overflow
 * visible so a control point past that padding still draws instead of being
 * clipped away.
 *
 * The handles are HTML buttons layered over the SVG rather than SVG circles,
 * because a button gets focus, a focus ring, and key handling for free, which
 * is what makes the editor usable without a mouse.
 */
defineProps<{ meta: ToolMeta }>();

/** Plot geometry, shared by the SVG and the handle positions. */
const PLOT = 240;
const PAD_X = 20;
const PAD_Y = 120;
const VIEW_W = PLOT + PAD_X * 2;
const VIEW_H = PLOT + PAD_Y * 2;

interface PanelError {
  message: string;
  fix?: string;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const controls = ref<BezierControls>(presetControls("ease"));
const duration = ref(600);
const stops = ref(16);
const pasted = ref("");
const error = ref<PanelError | null>(null);

/** Flips on every replay so the preview element transitions to the other end. */
const previewAtEnd = ref(false);
const reducedMotion = ref(false);

const value = computed(() => formatCubicBezier(controls.value));
const declaration = computed(() => `transition-timing-function: ${value.value};`);
const shorthand = computed(() => `transition: all ${duration.value}ms ${value.value};`);
const linearValue = computed(() => {
  try {
    return linearApproximation(controls.value, stops.value);
  } catch {
    return linearApproximation(controls.value, 16);
  }
});
const match = computed(() => nearestPreset(controls.value));
const extent = computed(() => curveExtent(controls.value));

const facts = computed<Record<string, string>>(() => {
  const rows: Record<string, string> = {
    "CSS value": value.value,
    "Closest named curve": match.value.exact
      ? `${match.value.preset.label} (exact)`
      : `${match.value.preset.label} (average difference ${trimNumber(match.value.distance, 4)})`,
  };
  for (const percent of [25, 50, 75]) {
    rows[`Progress at ${percent}% of the duration`] =
      `${trimNumber(easingAt(controls.value, percent / 100) * 100, 2)}%`;
  }
  if (extent.value.max > 1.0001 || extent.value.min < -0.0001) {
    rows["Range"] =
      `${trimNumber(extent.value.min * 100, 1)}% to ${trimNumber(extent.value.max * 100, 1)}%, so this curve overshoots`;
  }
  return rows;
});

/** The exact cubic path, rather than a sampled polyline. */
const curvePath = computed(() => {
  const c = controls.value;
  return `M 0 ${PLOT} C ${c.x1 * PLOT} ${(1 - c.y1) * PLOT}, ${c.x2 * PLOT} ${(1 - c.y2) * PLOT}, ${PLOT} 0`;
});

function handleStyle(x: number, y: number): Record<string, string> {
  return {
    left: `${((x * PLOT + PAD_X) / VIEW_W) * 100}%`,
    top: `${(((1 - y) * PLOT + PAD_Y) / VIEW_H) * 100}%`,
  };
}

/* ------------------------------------------------------------------ *
 * fragment
 * ------------------------------------------------------------------ */

let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function syncFragment(): void {
  if (!ready) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    writeFragment({
      input: value.value,
      opts: { duration: String(duration.value), stops: String(stops.value) },
    });
  }, 200);
}

function setControls(next: BezierControls): void {
  controls.value = next;
  syncFragment();
}

function toPanelError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * dragging and nudging
 * ------------------------------------------------------------------ */

const plotRef = ref<HTMLElement | null>(null);
let dragHandle: 1 | 2 | null = null;

/** Drag range for y. Wider than the padding so a handle can be pushed further. */
const Y_MIN = -0.9;
const Y_MAX = 1.9;

function clampX(n: number): number {
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

function clampY(n: number): number {
  return Math.min(Y_MAX, Math.max(Y_MIN, Math.round(n * 1000) / 1000));
}

function setHandle(which: 1 | 2, x: number, y: number): void {
  const c = controls.value;
  setControls(
    which === 1 ? { ...c, x1: clampX(x), y1: clampY(y) } : { ...c, x2: clampX(x), y2: clampY(y) },
  );
}

function pointFromEvent(event: PointerEvent): { x: number; y: number } | null {
  const rect = plotRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return null;
  const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_W - PAD_X;
  const viewY = ((event.clientY - rect.top) / rect.height) * VIEW_H - PAD_Y;
  return { x: viewX / PLOT, y: 1 - viewY / PLOT };
}

function onHandleDown(which: 1 | 2, event: PointerEvent): void {
  dragHandle = which;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onHandleMove(event: PointerEvent): void {
  if (!dragHandle) return;
  event.preventDefault();
  const point = pointFromEvent(event);
  if (point) setHandle(dragHandle, point.x, point.y);
}

function onHandleUp(event: PointerEvent): void {
  if (!dragHandle) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragHandle = null;
}

function onHandleKey(which: 1 | 2, event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.1 : 0.01;
  const c = controls.value;
  const x = which === 1 ? c.x1 : c.x2;
  const y = which === 1 ? c.y1 : c.y2;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  setHandle(which, x + move[0], y + move[1]);
}

/* ------------------------------------------------------------------ *
 * presets, pasting, preview
 * ------------------------------------------------------------------ */

function applyPreset(name: string): void {
  try {
    error.value = null;
    setControls(presetControls(name));
    replay();
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function applyPasted(): void {
  const text = pasted.value.trim();
  if (!text) {
    error.value = {
      message: "There is nothing to read yet.",
      fix: "Paste a value such as cubic-bezier(0.25, 0.1, 0.25, 1), or an ease keyword.",
    };
    return;
  }
  try {
    setControls(parseCubicBezier(text));
    error.value = null;
    replay();
  } catch (e) {
    error.value = toPanelError(e);
  }
}

let replayTimer: ReturnType<typeof setTimeout> | undefined;

/** Sends the preview back to the start, then to the end on the next frame. */
function replay(): void {
  if (replayTimer) clearTimeout(replayTimer);
  previewAtEnd.value = false;
  replayTimer = setTimeout(() => {
    replayTimer = undefined;
    previewAtEnd.value = true;
  }, 60);
}

const previewStyle = computed(() => ({
  transition: reducedMotion.value
    ? "none"
    : `transform ${duration.value}ms ${value.value}, opacity ${duration.value}ms ${value.value}`,
  transform: previewAtEnd.value
    ? "translateX(calc(100% * 3)) scale(1)"
    : "translateX(0) scale(0.7)",
  opacity: previewAtEnd.value ? "1" : "0.35",
}));

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  reducedMotion.value =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const frag = readFragment();
  if (frag.input) {
    try {
      controls.value = parseCubicBezier(frag.input);
    } catch {
      // A stale or hand-edited link should never break the page.
    }
  }
  const d = Number(frag.opts["duration"]);
  if (Number.isFinite(d) && d >= 1 && d <= 60000) duration.value = Math.round(d);
  const s = Number(frag.opts["stops"]);
  if (Number.isFinite(s) && s >= 2 && s <= 100) stops.value = Math.round(s);

  ready = true;
  // Motion is opt-in when the visitor asked for less of it: the Replay button
  // is then the only thing that moves the preview.
  if (!reducedMotion.value) replay();
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  if (replayTimer) clearTimeout(replayTimer);
  timer = undefined;
  replayTimer = undefined;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- presets -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Presets
      </span>
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="preset in EASING_PRESETS"
          :key="preset.value"
          type="button"
          variant="outline"
          size="sm"
          :title="preset.note"
          @click="applyPreset(preset.value)"
        >
          {{ preset.label }}
        </Button>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- the curve editor -->
      <div class="flex min-w-0 flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Curve
        </span>
        <div
          ref="plotRef"
          class="relative w-full rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          :style="{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }"
        >
          <svg
            class="absolute inset-0 h-full w-full overflow-visible"
            :viewBox="`${-PAD_X} ${-PAD_Y} ${VIEW_W} ${VIEW_H}`"
            aria-hidden="true"
          >
            <!-- the unit square: the whole duration by the whole change -->
            <rect
              :width="PLOT"
              :height="PLOT"
              x="0"
              y="0"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              class="text-border"
            />
            <line
              x1="0"
              :y1="PLOT"
              :x2="PLOT"
              y2="0"
              stroke="currentColor"
              stroke-width="1"
              stroke-dasharray="4 4"
              class="text-muted-foreground/40"
            />
            <!-- control point arms -->
            <line
              x1="0"
              :y1="PLOT"
              :x2="controls.x1 * PLOT"
              :y2="(1 - controls.y1) * PLOT"
              stroke="currentColor"
              stroke-width="1.5"
              class="text-muted-foreground/70"
            />
            <line
              :x1="PLOT"
              y1="0"
              :x2="controls.x2 * PLOT"
              :y2="(1 - controls.y2) * PLOT"
              stroke="currentColor"
              stroke-width="1.5"
              class="text-muted-foreground/70"
            />
            <path
              :d="curvePath"
              fill="none"
              stroke="var(--primary)"
              stroke-width="3"
              stroke-linecap="round"
            />
          </svg>

          <button
            v-for="handle in [
              { which: 1 as const, x: controls.x1, y: controls.y1 },
              { which: 2 as const, x: controls.x2, y: controls.y2 },
            ]"
            :key="handle.which"
            type="button"
            role="slider"
            :aria-label="`Control point ${handle.which}`"
            :aria-valuemin="0"
            :aria-valuemax="1"
            :aria-valuenow="handle.x"
            :aria-valuetext="`x ${trimNumber(handle.x, 3)}, y ${trimNumber(handle.y, 3)}`"
            class="absolute size-5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-background bg-primary shadow-[var(--sh-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
            :style="handleStyle(handle.x, handle.y)"
            @pointerdown="onHandleDown(handle.which, $event)"
            @pointermove="onHandleMove"
            @pointerup="onHandleUp"
            @pointercancel="onHandleUp"
            @keydown="onHandleKey(handle.which, $event)"
          ></button>
        </div>
        <p class="text-xs text-muted-foreground">
          Drag either handle, or focus one and use the arrow keys. Shift with an arrow moves ten
          times as far. The x axis is time, so it stops at the edges of the box; the y axis is free,
          which is what lets a curve overshoot.
        </p>
      </div>

      <!-- preview and numbers -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Preview
          </span>
          <Button type="button" variant="outline" size="sm" @click="replay">
            <RotateCcw class="size-3.5" aria-hidden="true" />
            Replay
          </Button>
        </div>
        <div class="rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <div class="w-1/4">
            <div
              class="grid h-12 w-full place-items-center rounded-[10px] bg-[image:var(--grad-brand)] text-xs font-medium text-primary-foreground"
              :style="previewStyle"
            >
              {{ duration }}ms
            </div>
          </div>
        </div>
        <p v-if="reducedMotion" class="text-xs text-muted-foreground">
          Your system asks for reduced motion, so the preview only moves when you press Replay.
        </p>

        <div class="flex items-center gap-3">
          <Label for="bezier-duration" class="w-24 shrink-0 text-xs text-muted-foreground">
            Duration
          </Label>
          <Slider
            id="bezier-duration"
            :model-value="[duration]"
            :min="50"
            :max="3000"
            :step="50"
            aria-label="Preview duration in milliseconds"
            class="min-w-0 flex-1"
            @update:model-value="
              (v) => {
                duration = Number(v?.[0] ?? 600);
                syncFragment();
                replay();
              }
            "
          />
          <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
            {{ duration }}ms
          </span>
        </div>

        <div class="flex items-center gap-3">
          <Label for="bezier-stops" class="w-24 shrink-0 text-xs text-muted-foreground">
            linear() stops
          </Label>
          <Slider
            id="bezier-stops"
            :model-value="[stops]"
            :min="2"
            :max="50"
            :step="1"
            aria-label="Number of samples in the linear() approximation"
            class="min-w-0 flex-1"
            @update:model-value="
              (v) => {
                stops = Number(v?.[0] ?? 16);
                syncFragment();
              }
            "
          />
          <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums">{{ stops }}</span>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="bezier-paste" class="text-xs text-muted-foreground">
            Read an existing easing function
          </Label>
          <div class="flex flex-wrap gap-2">
            <Input
              id="bezier-paste"
              v-model="pasted"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="cubic-bezier(0.25, 0.1, 0.25, 1)"
              class="h-8 min-w-0 flex-1 font-mono"
              @keydown.enter.prevent="applyPasted"
            />
            <Button type="button" variant="outline" size="sm" @click="applyPasted">Load</Button>
          </div>
        </div>
      </div>
    </div>

    <KeyValueGrid :record="facts" :columns="2" surface="card" />

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            CSS
          </span>
          <CopyButton :text="`${declaration}\n${shorthand}`" label="Copy" />
        </div>
        <pre
          class="max-h-40 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
          >{{ declaration }}
{{ shorthand }}</pre>
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            linear() approximation
          </span>
          <CopyButton :text="linearValue" label="Copy" />
        </div>
        <pre
          class="max-h-40 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
          >{{ linearValue }}</pre>
      </div>
    </div>

    <ErrorBanner
      v-if="error"
      :message="error.message"
      :hint="error.fix"
      dismissible
      @dismiss="error = null"
    />
  </div>
</template>
