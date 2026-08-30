<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Plus, Trash2 } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  GRADIENT_PRESETS,
  INTERPOLATION_SPACES,
  RADIAL_SIZES,
  formatBackground,
  formatGradientLayer,
  formatStopColor,
  formatTailwind,
  parseBackgroundImage,
  presetLayers,
  resolveStopPositions,
  type ColorStop,
  type GradientLayer,
  type GradientType,
} from "@/tools/css-gradient-generator/index";
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
 * Bespoke panel for the CSS Gradient Generator.
 *
 * The gradient model, every parser, and every formatter live in
 * `src/tools/css-gradient-generator/` (PROJECT.md rule 27). This file owns
 * only the DOM: the draggable stop bar, the layer list, the URL fragment, and
 * the preview swatch. The preview is an inline background-image, so nothing
 * this panel generates can leak into the site's own stylesheet.
 *
 * The stop handles are real buttons with slider semantics, so the bar is fully
 * keyboard operable: arrows nudge, Shift plus arrow jumps ten percent, Home and
 * End snap to the ends, and Delete removes the stop.
 */
defineProps<{ meta: ToolMeta }>();

const TYPES = [
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "conic", label: "Conic" },
] as const;

const COLOR_SYNTAXES = [
  { value: "rgba", label: "rgba()" },
  { value: "hex", label: "hex" },
  { value: "modern", label: "rgb() /" },
] as const;

type ColorSyntax = (typeof COLOR_SYNTAXES)[number]["value"];

/**
 * The searchable select needs a non-empty value for every option, so "none"
 * stands in for the layer model's empty interpolation string.
 */
const INTERPOLATION_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "grad-interpolation",
  label: "Interpolation color space",
  default: "none",
  options: INTERPOLATION_SPACES.map((space) => ({
    value: space || "none",
    label: space ? `in ${space}` : "None: let the browser decide",
    synonyms: space
      ? [space.replace(/\s+/g, ""), "color space", "interpolation", "mix"]
      : ["omit", "plain", "default", "browser default"],
  })),
};

const SIZE_OPTIONS = RADIAL_SIZES.map((size) => ({ value: size, label: size }));

interface PanelError {
  message: string;
  fix?: string;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const layers = ref<GradientLayer[]>(presetLayers("sunset"));
const activeLayer = ref(0);
const activeStop = ref(0);
const colorSyntax = ref<ColorSyntax>("rgba");
const pasted = ref("");
const error = ref<PanelError | null>(null);

const layer = computed<GradientLayer>(() => layers.value[activeLayer.value] ?? layers.value[0]);
const stops = computed<ColorStop[]>(() => layer.value?.stops ?? []);
/** Every stop's position as a real number, including the ones left to the browser. */
const positions = computed(() => resolveStopPositions(stops.value));

const backgroundValue = computed(() => formatBackground(layers.value, colorSyntax.value));
const cssDeclaration = computed(() => `background-image: ${backgroundValue.value};`);
const tailwindValue = computed(() => formatTailwind(layers.value, colorSyntax.value));

/** A flat left-to-right ramp of the active layer's stops, for the stop bar. */
const stopBarBackground = computed(() => {
  const l = layer.value;
  if (!l) return "none";
  return formatGradientLayer(
    {
      ...l,
      type: "linear",
      angle: 90,
      repeating: false,
      stops: l.stops.map((s, i) => ({ ...s, position: positions.value[i] })),
    },
    colorSyntax.value,
  );
});

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
    writeFragment({ input: backgroundValue.value, opts: { syntax: colorSyntax.value } });
  }, 200);
}

function toPanelError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * editing
 * ------------------------------------------------------------------ */

function commit(next: GradientLayer[]): void {
  layers.value = next;
  if (activeLayer.value >= next.length) activeLayer.value = Math.max(0, next.length - 1);
  const count = next[activeLayer.value]?.stops.length ?? 0;
  if (activeStop.value >= count) activeStop.value = Math.max(0, count - 1);
  syncFragment();
}

function patchLayer(patch: Partial<GradientLayer>): void {
  commit(layers.value.map((l, i) => (i === activeLayer.value ? { ...l, ...patch } : l)));
}

function patchStop(index: number, patch: Partial<ColorStop>): void {
  patchLayer({ stops: stops.value.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
}

function setType(value: string): void {
  patchLayer({ type: value as GradientType });
}

function addStopAt(position: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(position)));
  const next = stops.value.map((s, i) => ({ ...s, position: positions.value[i] }));
  const insertAt = next.findIndex((s) => (s.position ?? 0) > clamped);
  const at = insertAt === -1 ? next.length : insertAt;
  const neighbor = next[Math.max(0, at - 1)] ?? next[0];
  next.splice(at, 0, {
    color: neighbor?.color ?? "#ffffff",
    opacity: neighbor?.opacity ?? 1,
    position: clamped,
  });
  patchLayer({ stops: next });
  activeStop.value = at;
}

function removeStop(index: number): void {
  if (stops.value.length <= 2) {
    error.value = {
      message: "A gradient needs at least two color stops.",
      fix: "Change this stop's color instead of removing it, or add another stop first.",
    };
    return;
  }
  error.value = null;
  patchLayer({ stops: stops.value.filter((_, i) => i !== index) });
}

function moveStop(index: number, position: number): void {
  patchStop(index, { position: Math.min(100, Math.max(0, Math.round(position * 10) / 10)) });
}

function addLayer(): void {
  const next = [...layers.value, presetLayers("ocean")[0]];
  commit(next);
  activeLayer.value = next.length - 1;
  activeStop.value = 0;
}

function removeLayer(index: number): void {
  if (layers.value.length <= 1) {
    error.value = {
      message: "The background needs at least one gradient layer.",
      fix: "Pick a different preset instead of removing the only layer.",
    };
    return;
  }
  error.value = null;
  commit(layers.value.filter((_, i) => i !== index));
}

function applyPreset(value: string): void {
  try {
    error.value = null;
    commit(presetLayers(value));
    activeLayer.value = 0;
    activeStop.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function applyPasted(): void {
  const text = pasted.value.trim();
  if (!text) {
    error.value = {
      message: "There is nothing to read yet.",
      fix: "Paste a gradient such as linear-gradient(45deg, #ff0000, #0000ff).",
    };
    return;
  }
  try {
    commit(parseBackgroundImage(text));
    error.value = null;
    activeLayer.value = 0;
    activeStop.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function setHex(index: number, raw: string): void {
  const text = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) patchStop(index, { color: text.toLowerCase() });
  else if (/^[0-9a-f]{6}$/i.test(text)) patchStop(index, { color: `#${text.toLowerCase()}` });
}

/* ------------------------------------------------------------------ *
 * the stop bar
 * ------------------------------------------------------------------ */

const barRef = ref<HTMLElement | null>(null);
let dragIndex = -1;

function percentFromEvent(event: PointerEvent | MouseEvent): number {
  const rect = barRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0) return 0;
  return ((event.clientX - rect.left) / rect.width) * 100;
}

function onHandleDown(index: number, event: PointerEvent): void {
  activeStop.value = index;
  dragIndex = index;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onHandleMove(event: PointerEvent): void {
  if (dragIndex === -1) return;
  event.preventDefault();
  moveStop(dragIndex, percentFromEvent(event));
}

function onHandleUp(event: PointerEvent): void {
  if (dragIndex === -1) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragIndex = -1;
}

function onHandleKey(index: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 1;
  const current = positions.value[index] ?? 0;
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

function onBarClick(event: MouseEvent): void {
  if (event.target !== barRef.value) return;
  addStopAt(percentFromEvent(event));
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const frag = readFragment();
  const syntax = frag.opts["syntax"];
  if (syntax && COLOR_SYNTAXES.some((s) => s.value === syntax)) {
    colorSyntax.value = syntax as ColorSyntax;
  }
  if (frag.input) {
    try {
      layers.value = parseBackgroundImage(frag.input);
    } catch {
      // A stale or hand-edited link should never break the page.
    }
  }
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
          v-for="preset in GRADIENT_PRESETS"
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

    <!-- preview -->
    <div
      class="h-40 w-full rounded-[14px] border shadow-[var(--sh-inset)]"
      :style="{ backgroundImage: backgroundValue }"
      role="img"
      :aria-label="`Preview of ${cssDeclaration}`"
    ></div>

    <!-- layers -->
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Layers
      </span>
      <div class="flex flex-wrap items-center gap-1">
        <div v-for="(l, index) in layers" :key="index" class="flex items-center">
          <Button
            type="button"
            :variant="index === activeLayer ? 'default' : 'outline'"
            size="sm"
            :aria-pressed="index === activeLayer"
            @click="
              activeLayer = index;
              activeStop = 0;
            "
          >
            {{ index + 1 }}. {{ l.type }}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            :aria-label="`Remove layer ${index + 1}`"
            @click="removeLayer(index)"
          >
            <Trash2 class="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" @click="addLayer">
        <Plus class="size-3.5" aria-hidden="true" />
        Add layer
      </Button>
    </div>

    <!-- stop bar -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Color stops
      </span>
      <div
        ref="barRef"
        class="relative h-10 w-full cursor-copy rounded-[10px] border shadow-[var(--sh-inset)]"
        :style="{ backgroundImage: stopBarBackground }"
        @click="onBarClick"
      >
        <button
          v-for="(s, index) in stops"
          :key="index"
          type="button"
          role="slider"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="Math.round(positions[index] ?? 0)"
          :aria-valuetext="`${Math.round(positions[index] ?? 0)} percent, ${s.color}`"
          :aria-label="`Color stop ${index + 1} of ${stops.length}`"
          class="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white shadow-[var(--sh-sm)] ring-1 ring-black/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
          :class="index === activeStop ? 'ring-2 ring-[color:var(--ring)]' : ''"
          :style="{
            left: `${positions[index] ?? 0}%`,
            background: formatStopColor(s.color, s.opacity, 'rgba'),
          }"
          @pointerdown="onHandleDown(index, $event)"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          @keydown="onHandleKey(index, $event)"
          @focus="activeStop = index"
        ></button>
      </div>
      <p class="text-xs text-muted-foreground">
        Drag a handle to move a stop, or click the empty bar to add one. With a handle focused, the
        arrow keys nudge by one percent, Shift and an arrow by ten, Home and End snap to the ends,
        and Delete removes the stop.
      </p>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- the selected stop and the layer shape -->
      <div class="flex min-w-0 flex-col gap-3">
        <div
          v-if="stops[activeStop]"
          class="flex flex-col gap-2.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Stop {{ activeStop + 1 }}
          </span>
          <div class="flex flex-wrap items-center gap-3">
            <Label for="grad-stop-color" class="w-20 shrink-0 text-xs text-muted-foreground">
              Color
            </Label>
            <input
              id="grad-stop-color"
              type="color"
              :value="stops[activeStop].color"
              class="h-8 w-12 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
              @input="patchStop(activeStop, { color: ($event.target as HTMLInputElement).value })"
            />
            <Input
              :model-value="stops[activeStop].color"
              type="text"
              spellcheck="false"
              autocomplete="off"
              aria-label="Hex color of the selected stop"
              class="h-8 w-28 font-mono"
              @update:model-value="(v) => setHex(activeStop, String(v))"
            />
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

          <div class="flex items-center gap-3">
            <Label for="grad-stop-pos" class="w-20 shrink-0 text-xs text-muted-foreground">
              Position
            </Label>
            <Slider
              id="grad-stop-pos"
              :model-value="[positions[activeStop] ?? 0]"
              :min="0"
              :max="100"
              :step="0.5"
              aria-label="Position of the selected stop, in percent"
              class="min-w-0 flex-1"
              @update:model-value="(v) => moveStop(activeStop, Number(v?.[0] ?? 0))"
            />
            <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ Math.round(positions[activeStop] ?? 0) }}%
            </span>
          </div>

          <div class="flex items-center gap-3">
            <Label for="grad-stop-alpha" class="w-20 shrink-0 text-xs text-muted-foreground">
              Opacity
            </Label>
            <Slider
              id="grad-stop-alpha"
              :model-value="[stops[activeStop].opacity]"
              :min="0"
              :max="1"
              :step="0.01"
              aria-label="Opacity of the selected stop"
              class="min-w-0 flex-1"
              @update:model-value="(v) => patchStop(activeStop, { opacity: Number(v?.[0] ?? 0) })"
            />
            <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ Math.round(stops[activeStop].opacity * 100) }}%
            </span>
          </div>
        </div>

        <div class="flex flex-col gap-2.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Layer {{ activeLayer + 1 }}
          </span>

          <div class="flex flex-wrap items-center gap-3">
            <Label class="w-20 shrink-0 text-xs text-muted-foreground">Type</Label>
            <Segmented
              :model-value="layer.type"
              :options="[...TYPES]"
              label="Gradient type"
              size="sm"
              @update:model-value="setType"
            />
          </div>

          <div v-if="layer.type !== 'radial'" class="flex items-center gap-3">
            <Label for="grad-angle" class="w-20 shrink-0 text-xs text-muted-foreground">
              {{ layer.type === "conic" ? "Start angle" : "Angle" }}
            </Label>
            <Slider
              id="grad-angle"
              :model-value="[layer.angle]"
              :min="0"
              :max="360"
              :step="1"
              aria-label="Gradient angle in degrees"
              class="min-w-0 flex-1"
              @update:model-value="(v) => patchLayer({ angle: Number(v?.[0] ?? 0) })"
            />
            <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ Math.round(layer.angle) }}deg
            </span>
          </div>

          <template v-if="layer.type !== 'linear'">
            <div
              v-for="axis in [
                { key: 'centerX', label: 'Center X' },
                { key: 'centerY', label: 'Center Y' },
              ] as const"
              :key="axis.key"
              class="flex items-center gap-3"
            >
              <Label
                :for="`grad-${axis.key}`"
                class="w-20 shrink-0 text-xs text-muted-foreground"
                >{{ axis.label }}</Label
              >
              <Slider
                :id="`grad-${axis.key}`"
                :model-value="[layer[axis.key]]"
                :min="0"
                :max="100"
                :step="1"
                :aria-label="`${axis.label} of the gradient center, in percent`"
                class="min-w-0 flex-1"
                @update:model-value="
                  (v) => patchLayer({ [axis.key]: Number(v?.[0] ?? 50) } as Partial<GradientLayer>)
                "
              />
              <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                {{ Math.round(layer[axis.key]) }}%
              </span>
            </div>
          </template>

          <div v-if="layer.type === 'radial'" class="flex flex-wrap items-center gap-3">
            <Label class="w-20 shrink-0 text-xs text-muted-foreground">Shape</Label>
            <Segmented
              :model-value="layer.shape"
              :options="[
                { value: 'circle', label: 'Circle' },
                { value: 'ellipse', label: 'Ellipse' },
              ]"
              label="Radial shape"
              size="sm"
              @update:model-value="(v) => patchLayer({ shape: v as 'circle' | 'ellipse' })"
            />
          </div>

          <div v-if="layer.type === 'radial'" class="flex flex-wrap items-center gap-3">
            <Label class="w-20 shrink-0 text-xs text-muted-foreground">Extent</Label>
            <Segmented
              :model-value="layer.size"
              :options="SIZE_OPTIONS"
              label="Radial extent"
              size="sm"
              @update:model-value="(v) => patchLayer({ size: v })"
            />
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Label for="grad-interpolation" class="w-20 shrink-0 text-xs text-muted-foreground">
              Color space
            </Label>
            <div class="min-w-0 flex-1">
              <SearchableSelect
                id="grad-interpolation"
                :spec="INTERPOLATION_SPEC"
                :model-value="layer.interpolation || 'none'"
                @update:model-value="
                  (v) => patchLayer({ interpolation: v === 'none' ? '' : String(v) })
                "
              />
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Switch
              id="grad-repeating"
              :model-value="layer.repeating"
              @update:model-value="(v) => patchLayer({ repeating: Boolean(v) })"
            />
            <Label for="grad-repeating" class="text-xs text-muted-foreground">
              Repeating: tile the stops instead of stretching them
            </Label>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="grad-paste" class="text-xs text-muted-foreground">
            Read an existing gradient
          </Label>
          <div class="flex flex-wrap gap-2">
            <Input
              id="grad-paste"
              v-model="pasted"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="linear-gradient(45deg, #ff0000, #0000ff)"
              class="h-8 min-w-0 flex-1 font-mono"
              @keydown.enter.prevent="applyPasted"
            />
            <Button type="button" variant="outline" size="sm" @click="applyPasted">
              Load stops
            </Button>
          </div>
        </div>
      </div>

      <!-- output -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label class="text-xs text-muted-foreground">Color syntax</Label>
          <Segmented
            :model-value="colorSyntax"
            :options="[...COLOR_SYNTAXES]"
            label="Color syntax"
            size="sm"
            @update:model-value="
              (v) => {
                colorSyntax = v as ColorSyntax;
                syncFragment();
              }
            "
          />
        </div>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              CSS
            </span>
            <CopyButton :text="cssDeclaration" label="Copy" />
          </div>
          <pre
            class="max-h-64 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
            >{{ cssDeclaration }}</pre>
        </div>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Tailwind
            </span>
            <CopyButton :text="tailwindValue" label="Copy" />
          </div>
          <pre
            class="max-h-48 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
            >{{ tailwindValue }}</pre>
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
