<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Trash2 } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  CLIP_PRESETS,
  formatClipPath,
  insertPointNear,
  parseClipPath,
  presetShape,
  toSvgPath,
  trimNumber,
  type ClipShape,
  type ClipShapeKind,
} from "@/tools/clip-path-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for the Clip Path Generator.
 *
 * The shape model, the parser, the formatter, and the SVG conversion all live
 * in `src/tools/clip-path-generator/` (PROJECT.md rule 27). This file owns the
 * editor surface: pointer and key handling for the vertices, the optional
 * background image, and the URL fragment.
 *
 * Because every coordinate is already a percentage of the element's own box,
 * a handle's position is just a CSS percentage, so the editor needs no
 * coordinate transform and stays correct at any preview size.
 *
 * A dropped image is read into an object URL and drawn locally. It is never
 * uploaded: your files and inputs never leave your device.
 */
defineProps<{ meta: ToolMeta }>();

const KINDS = [
  { value: "polygon", label: "Polygon" },
  { value: "circle", label: "Circle" },
  { value: "ellipse", label: "Ellipse" },
  { value: "inset", label: "Inset" },
] as const;

interface PanelError {
  message: string;
  fix?: string;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const shape = ref<ClipShape>(presetShape("triangle"));
const activePoint = ref(0);
const showOutline = ref(true);
const svgWidth = ref(200);
const svgHeight = ref(200);
const pasted = ref("");
const error = ref<PanelError | null>(null);
const imageUrl = ref<string | null>(null);
const imageName = ref("");

const clipValue = computed(() => {
  try {
    return formatClipPath(shape.value);
  } catch {
    return "none";
  }
});
const cssDeclaration = computed(() => `clip-path: ${clipValue.value};`);
const svgPath = computed(() => {
  try {
    return toSvgPath(shape.value, svgWidth.value, svgHeight.value);
  } catch {
    return "";
  }
});
const svgElement = computed(
  () =>
    `<svg viewBox="0 0 ${trimNumber(svgWidth.value, 3)} ${trimNumber(svgHeight.value, 3)}" xmlns="http://www.w3.org/2000/svg">\n  <path d="${svgPath.value}" fill="currentColor"${
      shape.value.kind === "polygon" && shape.value.fillRule === "evenodd"
        ? ' fill-rule="evenodd"'
        : ""
    } />\n</svg>`,
);

/** The outline drawn over the preview, in the preview's own 0 to 100 space. */
const outlinePath = computed(() => {
  try {
    return toSvgPath(shape.value, 100, 100);
  } catch {
    return "";
  }
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
    writeFragment({
      input: clipValue.value,
      opts: { w: String(svgWidth.value), h: String(svgHeight.value) },
    });
  }, 200);
}

function setShape(next: ClipShape): void {
  shape.value = next;
  if (activePoint.value >= next.points.length) {
    activePoint.value = Math.max(0, next.points.length - 1);
  }
  syncFragment();
}

function patch(part: Partial<ClipShape>): void {
  setShape({ ...shape.value, ...part });
}

function toPanelError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * vertices
 * ------------------------------------------------------------------ */

const stageRef = ref<HTMLElement | null>(null);
let dragIndex = -1;

function clampCoord(n: number): number {
  return Math.min(125, Math.max(-25, Math.round(n * 10) / 10));
}

function percentFromEvent(event: PointerEvent | MouseEvent): { x: number; y: number } | null {
  const rect = stageRef.value?.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * 100,
    y: ((event.clientY - rect.top) / rect.height) * 100,
  };
}

function movePoint(index: number, x: number, y: number): void {
  patch({
    points: shape.value.points.map((p, i) =>
      i === index ? { x: clampCoord(x), y: clampCoord(y) } : p,
    ),
  });
}

function removePoint(index: number): void {
  if (shape.value.points.length <= 3) {
    error.value = {
      message: "A polygon needs at least three points.",
      fix: "Add a point by clicking an edge before removing this one.",
    };
    return;
  }
  error.value = null;
  patch({ points: shape.value.points.filter((_, i) => i !== index) });
}

function onPointDown(index: number, event: PointerEvent): void {
  activePoint.value = index;
  dragIndex = index;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointMove(event: PointerEvent): void {
  if (dragIndex === -1) return;
  event.preventDefault();
  const point = percentFromEvent(event);
  if (point) movePoint(dragIndex, point.x, point.y);
}

function onPointUp(event: PointerEvent): void {
  if (dragIndex === -1) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragIndex = -1;
}

function onPointKey(index: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 1;
  const point = shape.value.points[index];
  if (!point) return;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removePoint(index);
    return;
  }
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  movePoint(index, point.x + move[0], point.y + move[1]);
}

function onStageClick(event: MouseEvent): void {
  if (shape.value.kind !== "polygon") return;
  if (event.target !== stageRef.value) return;
  const point = percentFromEvent(event);
  if (!point) return;
  setShape(insertPointNear(shape.value, clampCoord(point.x), clampCoord(point.y)));
}

/* ------------------------------------------------------------------ *
 * presets, pasting, image
 * ------------------------------------------------------------------ */

function applyPreset(value: string): void {
  try {
    error.value = null;
    setShape(presetShape(value));
    activePoint.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function applyPasted(): void {
  const text = pasted.value.trim();
  if (!text) {
    error.value = {
      message: "There is nothing to read yet.",
      fix: "Paste a value such as polygon(50% 0%, 100% 100%, 0% 100%).",
    };
    return;
  }
  try {
    setShape(parseClipPath(text));
    error.value = null;
    activePoint.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function onFiles(files: File[]): void {
  const file = files[0];
  if (!file) return;
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = URL.createObjectURL(file);
  imageName.value = file.name;
}

function clearImage(): void {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = null;
  imageName.value = "";
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const frag = readFragment();
  if (frag.input) {
    try {
      shape.value = parseClipPath(frag.input);
    } catch {
      // A stale or hand-edited link should never break the page.
    }
  }
  const w = Number(frag.opts["w"]);
  if (Number.isFinite(w) && w > 0 && w <= 10000) svgWidth.value = Math.round(w);
  const h = Number(frag.opts["h"]);
  if (Number.isFinite(h) && h > 0 && h <= 10000) svgHeight.value = Math.round(h);
  ready = true;
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
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
          v-for="preset in CLIP_PRESETS"
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
      <!-- the editor stage -->
      <div class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Shape
          </span>
          <Segmented
            :model-value="shape.kind"
            :options="[...KINDS]"
            label="Shape type"
            size="sm"
            @update:model-value="(v) => patch({ kind: v as ClipShapeKind })"
          />
        </div>

        <div
          ref="stageRef"
          class="relative aspect-square w-full overflow-hidden rounded-[10px] border bg-secondary shadow-[var(--sh-inset)]"
          :class="shape.kind === 'polygon' ? 'cursor-copy' : ''"
          @click="onStageClick"
        >
          <!-- what actually gets clipped -->
          <div
            class="pointer-events-none absolute inset-0 bg-[image:var(--grad-brand)] bg-cover bg-center"
            :style="{
              clipPath: clipValue,
              backgroundImage: imageUrl ? `url(${imageUrl})` : undefined,
            }"
          ></div>

          <!-- the outline, so the cut is readable over a busy image -->
          <svg
            v-if="showOutline"
            class="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              :d="outlinePath"
              fill="none"
              stroke="var(--ring)"
              stroke-width="0.6"
              vector-effect="non-scaling-stroke"
            />
          </svg>

          <!-- vertex handles -->
          <button
            v-for="(point, index) in shape.kind === 'polygon' ? shape.points : []"
            :key="index"
            type="button"
            role="slider"
            :aria-label="`Point ${index + 1} of ${shape.points.length}`"
            :aria-valuemin="-25"
            :aria-valuemax="125"
            :aria-valuenow="point.x"
            :aria-valuetext="`${trimNumber(point.x, 1)} percent across, ${trimNumber(point.y, 1)} percent down`"
            class="absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white bg-[var(--primary)] shadow-[var(--sh-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
            :class="index === activePoint ? 'ring-2 ring-white' : ''"
            :style="{ left: `${point.x}%`, top: `${point.y}%` }"
            @pointerdown="onPointDown(index, $event)"
            @pointermove="onPointMove"
            @pointerup="onPointUp"
            @pointercancel="onPointUp"
            @keydown="onPointKey(index, $event)"
            @focus="activePoint = index"
          ></button>
        </div>

        <p v-if="shape.kind === 'polygon'" class="text-xs text-muted-foreground">
          Drag a point to move it, or click an edge of the box to add one. With a point focused the
          arrow keys nudge by one percent, Shift and an arrow by ten, and Delete removes it.
        </p>
        <p v-else class="text-xs text-muted-foreground">
          Use the sliders below to size and place the shape. Switch to Polygon for draggable points.
        </p>

        <div class="flex flex-wrap items-center gap-3">
          <Switch id="clip-outline" v-model="showOutline" />
          <Label for="clip-outline" class="text-xs text-muted-foreground">Show the outline</Label>
          <Button v-if="imageUrl" type="button" variant="ghost" size="sm" @click="clearImage">
            <Trash2 class="size-3.5" aria-hidden="true" />
            Remove {{ imageName }}
          </Button>
        </div>

        <FileDrop
          accept="image/*"
          compact
          label="Drop an image to clip, or click to choose"
          hint="It is drawn locally and never uploaded."
          @files="onFiles"
        />
      </div>

      <!-- numeric controls and output -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-col gap-2.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Geometry
          </span>

          <template v-if="shape.kind === 'circle' || shape.kind === 'ellipse'">
            <div
              v-for="field in (shape.kind === 'circle'
                ? [{ key: 'radius', label: 'Radius' }]
                : [
                    { key: 'radiusX', label: 'Radius X' },
                    { key: 'radiusY', label: 'Radius Y' },
                  ]
              ).concat([
                { key: 'centerX', label: 'Center X' },
                { key: 'centerY', label: 'Center Y' },
              ]) as {
                key: 'radius' | 'radiusX' | 'radiusY' | 'centerX' | 'centerY';
                label: string;
              }[]"
              :key="field.key"
              class="flex items-center gap-3"
            >
              <Label :for="`clip-${field.key}`" class="w-20 shrink-0 text-xs text-muted-foreground">
                {{ field.label }}
              </Label>
              <Slider
                :id="`clip-${field.key}`"
                :model-value="[shape[field.key]]"
                :min="0"
                :max="100"
                :step="1"
                :aria-label="`${field.label} in percent`"
                class="min-w-0 flex-1"
                @update:model-value="
                  (v) => patch({ [field.key]: Number(v?.[0] ?? 0) } as Partial<ClipShape>)
                "
              />
              <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                {{ Math.round(shape[field.key]) }}%
              </span>
            </div>
          </template>

          <template v-else-if="shape.kind === 'inset'">
            <div
              v-for="field in [
                { key: 'top', label: 'Top' },
                { key: 'right', label: 'Right' },
                { key: 'bottom', label: 'Bottom' },
                { key: 'left', label: 'Left' },
                { key: 'round', label: 'Corners' },
              ] as { key: 'top' | 'right' | 'bottom' | 'left' | 'round'; label: string }[]"
              :key="field.key"
              class="flex items-center gap-3"
            >
              <Label :for="`clip-${field.key}`" class="w-20 shrink-0 text-xs text-muted-foreground">
                {{ field.label }}
              </Label>
              <Slider
                :id="`clip-${field.key}`"
                :model-value="[shape[field.key]]"
                :min="0"
                :max="50"
                :step="1"
                :aria-label="`${field.label} inset in percent`"
                class="min-w-0 flex-1"
                @update:model-value="
                  (v) => patch({ [field.key]: Number(v?.[0] ?? 0) } as Partial<ClipShape>)
                "
              />
              <span class="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                {{ Math.round(shape[field.key]) }}%
              </span>
            </div>
          </template>

          <template v-else>
            <div class="flex flex-wrap items-center gap-3">
              <Label class="w-20 shrink-0 text-xs text-muted-foreground">Fill rule</Label>
              <Segmented
                :model-value="shape.fillRule"
                :options="[
                  { value: 'nonzero', label: 'nonzero' },
                  { value: 'evenodd', label: 'evenodd' },
                ]"
                label="Polygon fill rule"
                size="sm"
                @update:model-value="(v) => patch({ fillRule: v as 'nonzero' | 'evenodd' })"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              {{ shape.points.length }} points. evenodd only changes the result when the outline
              crosses itself.
            </p>
          </template>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Label for="clip-w" class="text-xs text-muted-foreground">SVG box</Label>
          <Input
            id="clip-w"
            :model-value="svgWidth"
            type="number"
            min="1"
            max="10000"
            aria-label="SVG export width"
            class="h-8 w-24"
            @update:model-value="
              (v) => {
                svgWidth = Math.max(1, Math.min(10000, Number(v) || 1));
                syncFragment();
              }
            "
          />
          <span class="text-xs text-muted-foreground">by</span>
          <Input
            id="clip-h"
            :model-value="svgHeight"
            type="number"
            min="1"
            max="10000"
            aria-label="SVG export height"
            class="h-8 w-24"
            @update:model-value="
              (v) => {
                svgHeight = Math.max(1, Math.min(10000, Number(v) || 1));
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
            class="max-h-40 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
            >{{ cssDeclaration }}</pre>
        </div>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              SVG
            </span>
            <CopyButton :text="svgElement" label="Copy" />
          </div>
          <pre
            class="max-h-40 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
            >{{ svgElement }}</pre>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="clip-paste" class="text-xs text-muted-foreground">
            Read an existing clip-path
          </Label>
          <div class="flex flex-wrap gap-2">
            <Input
              id="clip-paste"
              v-model="pasted"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="polygon(50% 0%, 100% 100%, 0% 100%)"
              class="h-8 min-w-0 flex-1 font-mono"
              @keydown.enter.prevent="applyPasted"
            />
            <Button type="button" variant="outline" size="sm" @click="applyPasted">Load</Button>
          </div>
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
