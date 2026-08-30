<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Plus, RotateCcw, Trash2 } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  DEFAULT_SETTINGS,
  DIRECTIONS,
  FILL_MODES,
  IDENTITY_STOP,
  KEYFRAME_PRESETS,
  decodeStops,
  encodeStops,
  formatAnimationCss,
  formatKeyframes,
  formatShorthand,
  normalizeAnimationName,
  presetStops,
  readIteration,
  trimNumber,
  type AnimationSettings,
  type KeyframeStop,
} from "@/tools/css-keyframes-builder/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the CSS Keyframes Builder.
 *
 * The timeline model, the CSS generation, the name validation, and the link
 * serialization all live in `src/tools/css-keyframes-builder/` (PROJECT.md
 * rule 27). This file owns the timeline handles, the settings controls, and
 * the preview.
 *
 * The preview is a fully sandboxed iframe driven by srcdoc, the same shape the
 * anchor positioning builder uses, because a generated @keyframes name is
 * global: injecting it into this page would let a visitor's animation name
 * collide with the site's own. sandbox="" means no script, no form submission,
 * no same origin access, and no network request of any kind.
 */
defineProps<{ meta: ToolMeta }>();

interface PanelError {
  message: string;
  fix?: string;
}

const TIMING_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "kf-timing",
  label: "Timing function",
  default: "ease",
  options: [
    { value: "ease", label: "ease", synonyms: ["default", "css default"] },
    { value: "linear", label: "linear", synonyms: ["constant", "spinner", "loop safe"] },
    { value: "ease-in", label: "ease-in", synonyms: ["accelerate", "exit"] },
    { value: "ease-out", label: "ease-out", synonyms: ["decelerate", "enter"] },
    { value: "ease-in-out", label: "ease-in-out", synonyms: ["symmetric", "smooth"] },
    {
      value: "cubic-bezier(0.4, 0, 0.2, 1)",
      label: "Material standard",
      synonyms: ["emphasized", "google", "md3"],
    },
    {
      value: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      label: "Spring overshoot",
      synonyms: ["bouncy", "back out", "pop"],
    },
    {
      value: "steps(6, end)",
      label: "steps(6, end)",
      synonyms: ["sprite", "stop motion", "typewriter"],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const initial = presetStops("fade-in");
const stops = ref<KeyframeStop[]>(initial.stops);
const activeStop = ref(0);
const nameText = ref(initial.name);
const settings = ref<AnimationSettings>({
  ...DEFAULT_SETTINGS,
  ...initial.settings,
  name: initial.name,
});
const iterationText = ref(settings.value.iteration);
const error = ref<PanelError | null>(null);
const reducedMotion = ref(false);
const previewArmed = ref(true);
const replayNonce = ref(0);

const resolvedName = computed(() => {
  try {
    return normalizeAnimationName(nameText.value);
  } catch {
    return settings.value.name;
  }
});

const effectiveSettings = computed<AnimationSettings>(() => ({
  ...settings.value,
  name: resolvedName.value,
}));

const cssOutput = computed(() => {
  try {
    return formatAnimationCss(stops.value, effectiveSettings.value);
  } catch (e) {
    return `/* ${e instanceof Error ? e.message : "The timeline is not valid yet."} */`;
  }
});

const keyframesOnly = computed(() => {
  try {
    return formatKeyframes(stops.value, resolvedName.value);
  } catch {
    return "";
  }
});

const shorthand = computed(() => formatShorthand(effectiveSettings.value));

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
      input: nameText.value.trim() || undefined,
      opts: {
        t: encodeStops(stops.value),
        d: String(settings.value.duration),
        dl: String(settings.value.delay),
        tf: settings.value.timing,
        it: settings.value.iteration,
        dir: settings.value.direction,
        fill: settings.value.fill,
        rm: String(settings.value.reducedMotion),
      },
    });
  }, 250);
}

function toPanelError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

function checkName(): void {
  try {
    normalizeAnimationName(nameText.value);
    error.value = null;
  } catch (e) {
    error.value = toPanelError(e);
  }
  syncFragment();
}

/* ------------------------------------------------------------------ *
 * timeline editing
 * ------------------------------------------------------------------ */

function setStops(next: KeyframeStop[]): void {
  stops.value = next;
  if (activeStop.value >= next.length) activeStop.value = Math.max(0, next.length - 1);
  syncFragment();
}

function patchStop(index: number, part: Partial<KeyframeStop>): void {
  setStops(stops.value.map((s, i) => (i === index ? { ...s, ...part } : s)));
}

function sortedIndexFor(at: number): number {
  const index = stops.value.findIndex((s) => s.at > at);
  return index === -1 ? stops.value.length : index;
}

function addStopAt(at: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(at)));
  if (stops.value.some((s) => Math.abs(s.at - clamped) < 0.5)) {
    error.value = {
      message: `There is already a keyframe stop at ${clamped}%.`,
      fix: "Click somewhere else on the timeline, or drag the existing stop first.",
    };
    return;
  }
  error.value = null;
  const at2 = sortedIndexFor(clamped);
  const neighbor = stops.value[Math.max(0, at2 - 1)] ?? IDENTITY_STOP;
  const next = stops.value.slice();
  next.splice(at2, 0, { ...neighbor, at: clamped });
  setStops(next);
  activeStop.value = at2;
}

function removeStop(index: number): void {
  if (stops.value.length <= 2) {
    error.value = {
      message: "An animation needs at least two keyframe stops.",
      fix: "Add a stop before removing this one.",
    };
    return;
  }
  error.value = null;
  setStops(stops.value.filter((_, i) => i !== index));
}

function moveStop(index: number, at: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(at)));
  if (stops.value.some((s, i) => i !== index && Math.abs(s.at - clamped) < 0.5)) return;
  patchStop(index, { at: clamped });
}

const timelineRef = ref<HTMLElement | null>(null);
let dragIndex = -1;

function percentFromEvent(event: PointerEvent | MouseEvent): number {
  const rect = timelineRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0) return 0;
  return ((event.clientX - rect.left) / rect.width) * 100;
}

function onStopDown(index: number, event: PointerEvent): void {
  activeStop.value = index;
  dragIndex = index;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onStopMove(event: PointerEvent): void {
  if (dragIndex === -1) return;
  event.preventDefault();
  moveStop(dragIndex, percentFromEvent(event));
}

function onStopUp(event: PointerEvent): void {
  if (dragIndex === -1) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragIndex = -1;
}

function onStopKey(index: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 1;
  const current = stops.value[index]?.at ?? 0;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    event.preventDefault();
    moveStop(index, current - step);
  } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    event.preventDefault();
    moveStop(index, current + step);
  } else if (event.key === "Home") {
    event.preventDefault();
    moveStop(index, 0);
  } else if (event.key === "End") {
    event.preventDefault();
    moveStop(index, 100);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeStop(index);
  }
}

function onTimelineClick(event: MouseEvent): void {
  if (event.target !== timelineRef.value) return;
  addStopAt(percentFromEvent(event));
}

/* ------------------------------------------------------------------ *
 * presets and settings
 * ------------------------------------------------------------------ */

function applyPreset(value: string): void {
  try {
    error.value = null;
    const preset = presetStops(value);
    stops.value = preset.stops;
    nameText.value = preset.name;
    settings.value = { ...DEFAULT_SETTINGS, ...preset.settings, name: preset.name };
    iterationText.value = settings.value.iteration;
    activeStop.value = 0;
    syncFragment();
    replay();
  } catch (e) {
    error.value = toPanelError(e);
  }
}

/**
 * The repeat field takes free text, because "infinite" is a word and every
 * other value is a number. Anything else has to be caught here, or it would be
 * pasted straight into the shorthand and quietly break the whole declaration.
 */
function setIteration(raw: string): void {
  iterationText.value = raw;
  try {
    patchSettings({ iteration: readIteration(raw.trim() || "1") });
    error.value = null;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function patchSettings(part: Partial<AnimationSettings>): void {
  settings.value = { ...settings.value, ...part };
  syncFragment();
}

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

const previewDoc = computed(() => {
  const s = effectiveSettings.value;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<style>",
    "*, *::before, *::after { box-sizing: border-box; }",
    "html, body { margin: 0; height: 100%; }",
    "body { display: grid; place-items: center; background: transparent; }",
    ".stage { display: grid; place-items: center; width: 100%; height: 100%; }",
    ".box {",
    "  width: 84px;",
    "  height: 84px;",
    "  border-radius: 14px;",
    "  background: linear-gradient(140deg, #8a79f5, #5b4bd6);",
    '  font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;',
    "  color: #fff;",
    "  display: grid;",
    "  place-items: center;",
    "}",
    keyframesOnly.value,
    `.box { ${formatShorthand(s)} }`,
    "</style>",
    "</head>",
    "<body>",
    `<div class="stage"><div class="box">${s.name}</div></div>`,
    "</body>",
    "</html>",
  ].join("\n");
});

function replay(): void {
  previewArmed.value = true;
  replayNonce.value += 1;
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  reducedMotion.value =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  previewArmed.value = !reducedMotion.value;

  const frag = readFragment();
  if (frag.input) nameText.value = frag.input;
  if (frag.opts["t"]) {
    try {
      stops.value = decodeStops(frag.opts["t"]);
    } catch {
      // A stale or hand-edited link should never break the page.
    }
  }
  const next: Partial<AnimationSettings> = {};
  const d = Number(frag.opts["d"]);
  if (Number.isFinite(d) && d >= 1 && d <= 600000) next.duration = Math.round(d);
  const dl = Number(frag.opts["dl"]);
  if (Number.isFinite(dl) && dl >= 0 && dl <= 600000) next.delay = Math.round(dl);
  if (frag.opts["tf"]) next.timing = frag.opts["tf"];
  if (frag.opts["it"]) next.iteration = frag.opts["it"];
  if (DIRECTIONS.includes(frag.opts["dir"] ?? "")) next.direction = frag.opts["dir"];
  if (FILL_MODES.includes(frag.opts["fill"] ?? "")) next.fill = frag.opts["fill"];
  if (frag.opts["rm"]) next.reducedMotion = frag.opts["rm"] === "true";
  settings.value = { ...settings.value, ...next };
  iterationText.value = settings.value.iteration;

  ready = true;
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
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
          v-for="preset in KEYFRAME_PRESETS"
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

    <!-- timeline -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Timeline
        </span>
        <Button type="button" variant="outline" size="sm" @click="addStopAt(50)">
          <Plus class="size-3.5" aria-hidden="true" />
          Add a stop
        </Button>
      </div>
      <div
        ref="timelineRef"
        class="relative h-12 w-full cursor-copy rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        @click="onTimelineClick"
      >
        <button
          v-for="(s, index) in stops"
          :key="index"
          type="button"
          role="slider"
          :aria-label="`Keyframe stop ${index + 1} of ${stops.length}`"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="s.at"
          :aria-valuetext="`${trimNumber(s.at, 1)} percent`"
          class="absolute top-1/2 flex h-8 min-w-8 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-[8px] border bg-card px-1 font-mono text-[10px] tabular-nums shadow-[var(--sh-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
          :class="index === activeStop ? 'ring-2 ring-[color:var(--ring)]' : ''"
          :style="{ left: `${s.at}%` }"
          @pointerdown="onStopDown(index, $event)"
          @pointermove="onStopMove"
          @pointerup="onStopUp"
          @pointercancel="onStopUp"
          @keydown="onStopKey(index, $event)"
          @focus="activeStop = index"
        >
          {{ Math.round(s.at) }}
        </button>
      </div>
      <p class="text-xs text-muted-foreground">
        Click the empty timeline to add a stop. Drag a stop to move it, or focus one and use the
        arrow keys, Shift and an arrow for ten percent, Home and End for the ends, and Delete to
        remove it.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- the selected stop -->
      <div class="flex min-w-0 flex-col gap-3">
        <div
          v-if="stops[activeStop]"
          class="flex flex-col gap-2.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Stop at {{ Math.round(stops[activeStop].at) }}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove the selected stop"
              @click="removeStop(activeStop)"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
              Remove
            </Button>
          </div>

          <div
            v-for="field in [
              { key: 'translateX', label: 'Move X', min: -300, max: 300, step: 1, unit: 'px' },
              { key: 'translateY', label: 'Move Y', min: -300, max: 300, step: 1, unit: 'px' },
              { key: 'rotate', label: 'Rotate', min: -720, max: 720, step: 5, unit: 'deg' },
              { key: 'scale', label: 'Scale', min: 0, max: 3, step: 0.01, unit: '' },
              { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, unit: '' },
            ] as const"
            :key="field.key"
            class="flex items-center gap-3"
          >
            <Label :for="`kf-${field.key}`" class="w-20 shrink-0 text-xs text-muted-foreground">{{
              field.label
            }}</Label>
            <Slider
              :id="`kf-${field.key}`"
              :model-value="[stops[activeStop][field.key]]"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :aria-label="`${field.label} at this keyframe stop`"
              class="min-w-0 flex-1"
              @update:model-value="
                (v) =>
                  patchStop(activeStop, {
                    [field.key]: Number(v?.[0] ?? 0),
                  } as Partial<KeyframeStop>)
              "
            />
            <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ trimNumber(stops[activeStop][field.key], 2) }}{{ field.unit }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Switch
              id="kf-bg-on"
              :model-value="stops[activeStop].background !== ''"
              @update:model-value="(v) => patchStop(activeStop, { background: v ? '#5b4bd6' : '' })"
            />
            <Label for="kf-bg-on" class="text-xs text-muted-foreground">Background color</Label>
            <input
              v-if="stops[activeStop].background"
              type="color"
              :value="stops[activeStop].background"
              aria-label="Background color at this keyframe stop"
              class="h-8 w-12 cursor-pointer rounded-[8px] border bg-card p-1"
              @input="
                patchStop(activeStop, { background: ($event.target as HTMLInputElement).value })
              "
            />
          </div>
        </div>

        <!-- animation settings -->
        <div class="flex flex-col gap-2.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Animation
          </span>

          <div class="flex flex-wrap items-center gap-3">
            <Label for="kf-name" class="w-20 shrink-0 text-xs text-muted-foreground">Name</Label>
            <Input
              id="kf-name"
              v-model="nameText"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="fade-in"
              class="h-8 min-w-0 flex-1 font-mono"
              :aria-invalid="error ? 'true' : undefined"
              @update:model-value="checkName"
            />
          </div>

          <div
            v-for="field in [
              { key: 'duration', label: 'Duration', min: 50, max: 5000, step: 50 },
              { key: 'delay', label: 'Delay', min: 0, max: 3000, step: 50 },
            ] as const"
            :key="field.key"
            class="flex items-center gap-3"
          >
            <Label :for="`kf-${field.key}`" class="w-20 shrink-0 text-xs text-muted-foreground">{{
              field.label
            }}</Label>
            <Slider
              :id="`kf-${field.key}`"
              :model-value="[settings[field.key]]"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :aria-label="`${field.label} in milliseconds`"
              class="min-w-0 flex-1"
              @update:model-value="
                (v) => {
                  patchSettings({ [field.key]: Number(v?.[0] ?? 0) } as Partial<AnimationSettings>);
                  replay();
                }
              "
            />
            <span class="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ settings[field.key] }}ms
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Label for="kf-timing" class="w-20 shrink-0 text-xs text-muted-foreground">
              Easing
            </Label>
            <div class="min-w-0 flex-1">
              <SearchableSelect
                id="kf-timing"
                :spec="TIMING_SPEC"
                :model-value="settings.timing"
                @update:model-value="
                  (v) => {
                    patchSettings({ timing: String(v) });
                    replay();
                  }
                "
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Label for="kf-iteration" class="w-20 shrink-0 text-xs text-muted-foreground">
              Repeat
            </Label>
            <Input
              id="kf-iteration"
              :model-value="iterationText"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="1 or infinite"
              class="h-8 w-32 font-mono"
              @update:model-value="(v) => setIteration(String(v))"
            />
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Label class="w-20 shrink-0 text-xs text-muted-foreground">Direction</Label>
            <Segmented
              :model-value="settings.direction"
              :options="DIRECTIONS.map((d) => ({ value: d, label: d }))"
              label="Animation direction"
              size="sm"
              @update:model-value="
                (v) => {
                  patchSettings({ direction: v });
                  replay();
                }
              "
            />
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Label class="w-20 shrink-0 text-xs text-muted-foreground">Fill mode</Label>
            <Segmented
              :model-value="settings.fill"
              :options="FILL_MODES.map((f) => ({ value: f, label: f }))"
              label="Animation fill mode"
              size="sm"
              @update:model-value="
                (v) => {
                  patchSettings({ fill: v });
                  replay();
                }
              "
            />
          </div>

          <div class="flex items-center gap-2">
            <Switch
              id="kf-reduced"
              :model-value="settings.reducedMotion"
              @update:model-value="(v) => patchSettings({ reducedMotion: Boolean(v) })"
            />
            <Label for="kf-reduced" class="text-xs text-muted-foreground">
              Wrap the rule in a prefers-reduced-motion guard
            </Label>
          </div>
        </div>
      </div>

      <!-- preview and output -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Live preview
          </span>
          <Button type="button" variant="outline" size="sm" @click="replay">
            <RotateCcw class="size-3.5" aria-hidden="true" />
            Replay
          </Button>
        </div>
        <div class="overflow-hidden rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <iframe
            v-if="previewArmed"
            :key="replayNonce"
            title="Live preview of the generated animation"
            sandbox=""
            :srcdoc="previewDoc"
            class="block h-56 w-full border-0 bg-transparent"
          ></iframe>
          <p
            v-else
            class="grid h-56 place-items-center px-4 text-center text-sm text-muted-foreground"
          >
            Your system asks for reduced motion, so the preview waits for you to press Replay.
          </p>
        </div>
        <p class="text-xs text-muted-foreground">
          The preview runs in a fully sandboxed frame: it loads no script and makes no request. The
          frame is used so a generated @keyframes name cannot collide with this site's own.
        </p>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              CSS
            </span>
            <div class="flex items-center gap-1">
              <CopyButton :text="shorthand" label="Copy shorthand" />
              <CopyButton :text="cssOutput" label="Copy all" />
            </div>
          </div>
          <pre class="max-h-96 overflow-auto px-3 pb-2 font-mono text-sm whitespace-pre">{{
            cssOutput
          }}</pre>
        </div>
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
