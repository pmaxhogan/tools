<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  generateCircleGrid,
  gridToAscii,
  gridToRunLengths,
  MAX_SIZE,
  MIN_SIZE,
  MIN_THICKNESS,
  type CircleGrid,
  type CircleMode,
} from "@/tools/pixel-circle-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import ErrorBanner from "../ErrorBanner.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Pixel Circle Generator.
 *
 * The pure layer (src/tools/pixel-circle-generator/index.ts) rasterizes the
 * grid, counts blocks, and derives per-row runs; this panel only draws it
 * and wires the controls. The grid is drawn as one SVG `<rect>` per
 * contiguous row run rather than one per block, so even a 256x256 grid
 * (65,536 cells) stays a few hundred shapes at most.
 */
defineProps<{ meta: ToolMeta }>();

interface PanelError {
  message: string;
  fix?: string;
}

function readError(e: unknown): PanelError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

const SHAPE_OPTIONS: SegmentedOption[] = [
  { value: "circle", label: "Circle" },
  { value: "ellipse", label: "Ellipse" },
];

const MODE_OPTIONS: SegmentedOption[] = [
  { value: "filled", label: "Filled" },
  { value: "outline", label: "Outline" },
];

const MIN_CELL = 3;
const MAX_CELL = 28;

const width = ref(16);
const height = ref(16);
const shape = ref<"circle" | "ellipse">("circle");
const mode = ref<CircleMode>("filled");
const thickness = ref(1);
const cellSize = ref(16);

function clampSize(n: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

function setShape(next: string): void {
  shape.value = next === "ellipse" ? "ellipse" : "circle";
  if (shape.value === "circle") height.value = width.value;
  schedule();
}

function setWidth(v: number): void {
  width.value = clampSize(v);
  if (shape.value === "circle") height.value = width.value;
  schedule();
}

function setHeight(v: number): void {
  height.value = clampSize(v);
  schedule();
}

function setMode(next: string): void {
  mode.value = next === "outline" ? "outline" : "filled";
  schedule();
}

function setThickness(v: number): void {
  thickness.value = Math.max(MIN_THICKNESS, Math.round(v));
  schedule();
}

interface Outcome {
  grid?: CircleGrid;
  error?: PanelError;
}

const outcome = computed<Outcome>(() => {
  try {
    const grid = generateCircleGrid({
      width: width.value,
      height: height.value,
      mode: mode.value,
      thickness: thickness.value,
    });
    return { grid };
  } catch (e) {
    return { error: readError(e) };
  }
});

const asciiText = computed(() => (outcome.value.grid ? gridToAscii(outcome.value.grid) : ""));
const runsText = computed(() => (outcome.value.grid ? gridToRunLengths(outcome.value.grid) : ""));

/** Row/column axis labels are only drawn every Nth line once the grid gets big, to stay legible. */
const labelStep = computed(() => {
  const m = Math.max(width.value, height.value);
  if (m <= 32) return 1;
  if (m <= 64) return 2;
  if (m <= 128) return 5;
  return 10;
});

const AXIS_GUTTER = 26;
const AXIS_HEADER = 20;

const svgDims = computed(() => {
  const grid = outcome.value.grid;
  const w = grid ? grid.width : 0;
  const h = grid ? grid.height : 0;
  const cell = cellSize.value;
  return {
    gridWidth: w * cell,
    gridHeight: h * cell,
    totalWidth: w * cell + AXIS_GUTTER,
    totalHeight: h * cell + AXIS_HEADER,
  };
});

/* ------------------------------------------------------------------ *
 * shareable state (rule 6: the fragment, never the query string)
 * ------------------------------------------------------------------ */

const ready = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(): void {
  writeFragment({
    opts: {
      w: String(width.value),
      h: String(height.value),
      shape: shape.value,
      mode: mode.value,
      thickness: String(thickness.value),
      zoom: String(cellSize.value),
    },
  });
}

function schedule(): void {
  if (!ready.value) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    persist();
  }, 200);
}

onMounted(() => {
  const frag = readFragment();
  const w = Number(frag.opts["w"]);
  const h = Number(frag.opts["h"]);
  if (Number.isFinite(w) && w >= MIN_SIZE && w <= MAX_SIZE) width.value = Math.round(w);
  if (Number.isFinite(h) && h >= MIN_SIZE && h <= MAX_SIZE) height.value = Math.round(h);
  if (frag.opts["shape"] === "ellipse" || frag.opts["shape"] === "circle") {
    shape.value = frag.opts["shape"];
  } else if (width.value !== height.value) {
    shape.value = "ellipse";
  }
  if (frag.opts["mode"] === "outline" || frag.opts["mode"] === "filled") {
    mode.value = frag.opts["mode"];
  }
  const t = Number(frag.opts["thickness"]);
  if (Number.isFinite(t) && t >= MIN_THICKNESS) thickness.value = Math.round(t);
  const z = Number(frag.opts["zoom"]);
  if (Number.isFinite(z) && z >= MIN_CELL && z <= MAX_CELL) cellSize.value = Math.round(z);

  ready.value = true;
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- shape and size -->
    <div class="flex flex-wrap items-end gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Shape</span>
        <Segmented
          :model-value="shape"
          :options="SHAPE_OPTIONS"
          label="Shape"
          @update:model-value="setShape"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="circle-width" class="text-xs text-muted-foreground">
          {{ shape === "circle" ? "Diameter" : "Width" }}
        </Label>
        <Input
          id="circle-width"
          type="number"
          :min="MIN_SIZE"
          :max="MAX_SIZE"
          step="1"
          :model-value="width"
          class="h-9 w-24 bg-secondary font-mono"
          @update:model-value="(v) => setWidth(Number(v))"
        />
      </div>

      <div v-if="shape === 'ellipse'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="circle-height" class="text-xs text-muted-foreground">Height</Label>
        <Input
          id="circle-height"
          type="number"
          :min="MIN_SIZE"
          :max="MAX_SIZE"
          step="1"
          :model-value="height"
          class="h-9 w-24 bg-secondary font-mono"
          @update:model-value="(v) => setHeight(Number(v))"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Fill</span>
        <Segmented
          :model-value="mode"
          :options="MODE_OPTIONS"
          label="Fill"
          @update:model-value="setMode"
        />
      </div>

      <div v-if="mode === 'outline'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="circle-thickness" class="text-xs text-muted-foreground">Thickness</Label>
        <Input
          id="circle-thickness"
          type="number"
          :min="MIN_THICKNESS"
          :max="128"
          step="1"
          :model-value="thickness"
          class="h-9 w-24 bg-secondary font-mono"
          @update:model-value="(v) => setThickness(Number(v))"
        />
      </div>
    </div>

    <ErrorBanner v-if="outcome.error" :message="outcome.error.message" :hint="outcome.error.fix" />

    <template v-else-if="outcome.grid">
      <!-- summary -->
      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-secondary px-3 py-2"
      >
        <div class="text-sm">
          <span class="font-mono text-lg tabular-nums">{{
            outcome.grid.blockCount.toLocaleString("en-US")
          }}</span>
          <span class="text-muted-foreground">
            blocks, {{ outcome.grid.width }} x {{ outcome.grid.height }} grid</span
          >
        </div>
        <div class="flex items-center gap-2">
          <CopyButton :get-text="() => asciiText" label="Copy ASCII" />
          <CopyButton :get-text="() => runsText" label="Copy row runs" />
        </div>
      </div>

      <!-- zoom -->
      <div class="flex items-center gap-3">
        <Label for="circle-zoom" class="shrink-0 text-xs text-muted-foreground">Zoom</Label>
        <Slider
          id="circle-zoom"
          :model-value="[cellSize]"
          :min="MIN_CELL"
          :max="MAX_CELL"
          :step="1"
          aria-label="Zoom"
          class="max-w-64"
          @update:model-value="
            (v) => {
              cellSize = v?.[0] ?? cellSize;
              schedule();
            }
          "
        />
        <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {{ cellSize }}px
        </span>
      </div>

      <!-- grid -->
      <div class="overflow-auto rounded-[10px] bg-secondary p-2" style="max-height: 32rem">
        <svg
          role="img"
          :aria-label="`${outcome.grid.width} by ${outcome.grid.height} pixel circle grid, ${outcome.grid.blockCount} blocks`"
          :width="svgDims.totalWidth"
          :height="svgDims.totalHeight"
          :viewBox="`0 0 ${svgDims.totalWidth} ${svgDims.totalHeight}`"
        >
          <g :transform="`translate(${AXIS_GUTTER}, ${AXIS_HEADER})`">
            <!-- column numbers -->
            <text
              v-for="col in outcome.grid.width"
              v-show="(col - 1) % labelStep === 0"
              :key="`c${col}`"
              :x="(col - 1) * cellSize + cellSize / 2"
              y="-6"
              text-anchor="middle"
              fill="var(--muted-foreground)"
              style="font-size: 9px; font-family: monospace"
            >
              {{ col - 1 }}
            </text>

            <!-- row numbers -->
            <text
              v-for="row in outcome.grid.height"
              v-show="(row - 1) % labelStep === 0"
              :key="`r${row}`"
              :x="-6"
              :y="(row - 1) * cellSize + cellSize / 2 + 3"
              text-anchor="end"
              fill="var(--muted-foreground)"
              style="font-size: 9px; font-family: monospace"
            >
              {{ row - 1 }}
            </text>

            <!-- bounding box -->
            <rect
              :width="svgDims.gridWidth"
              :height="svgDims.gridHeight"
              fill="none"
              stroke="currentColor"
              class="text-border"
              stroke-width="1"
            />

            <!-- one rect per contiguous row run, not per block -->
            <template v-for="(runs, rowIndex) in outcome.grid.rowRuns" :key="`row${rowIndex}`">
              <rect
                v-for="(run, runIndex) in runs"
                :key="`run${rowIndex}-${runIndex}`"
                :x="run.start * cellSize"
                :y="rowIndex * cellSize"
                :width="run.length * cellSize"
                :height="cellSize"
                fill="var(--primary)"
              />
            </template>
          </g>
        </svg>
      </div>
    </template>
  </div>
</template>
