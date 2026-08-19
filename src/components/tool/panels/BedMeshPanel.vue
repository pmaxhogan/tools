<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import bedMesh, {
  analyzeMesh,
  fixed,
  interpolateMesh,
  parseMesh,
  renderHeatmapSvg,
  renderIsometricSvg,
  type BedMeshOpts,
  type Mesh,
  type MeshGrade,
  type PaletteCenter,
} from "@/tools/bed-mesh-visualizer/index";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import OutputView from "../OutputView.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Bed Mesh Visualizer.
 *
 * The generic ToolShell can only print `run()`'s Record<string,string> as a
 * flat list, but a mesh is worth more as a picture than as a wall of numbers.
 * This island still calls the tool's own `run()` for the stats block (so the
 * wording matches the API and curl output exactly), and pulls the Verdict and
 * Advice rows out of that record to headline them above the rest. Everything
 * about parsing and analysis stays in src/tools/bed-mesh-visualizer (rule 27);
 * this file owns the textarea, the sample and drop handling, the render
 * controls (colour centre, smoothing, height exaggeration), the two inline
 * SVG previews, a heat map hover readout computed from pointer position, and
 * the SVG and PNG exports.
 *
 * renderIsometricSvg's options are width, height, zScale and palette only, no
 * rotation angle, so there is no rotate control here (noted under the 3D view
 * instead of pretending one exists).
 *
 * Hover geometry: renderHeatmapSvg's cells carry no data attributes, so the
 * hover readout re-derives the cell under the pointer from the same padding
 * and cell-size arithmetic the renderer uses internally (HEATMAP_PAD_* below
 * mirror its private layout constants). If that layout ever changes, update
 * the constants here to match.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* -------------------------------------------------------------------------- */
/* Sample and input                                                          */
/* -------------------------------------------------------------------------- */

const SAMPLE_MESH = [
  "// Mesh Leveling Probed Z positions:",
  "// -0.085000, -0.035000, -0.010000, -0.030000, -0.075000",
  "// -0.030000, 0.020000, 0.045000, 0.025000, -0.020000",
  "// 0.025000, 0.075000, 0.100000, 0.080000, 0.035000",
  "// 0.080000, 0.130000, 0.155000, 0.135000, 0.090000",
  "// 0.135000, 0.185000, 0.210000, 0.190000, 0.145000",
].join("\n");

const meshText = ref("");
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

async function readFile(file: File): Promise<void> {
  meshText.value = await file.text();
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) void readFile(file);
}

function onPickFile(e: Event): void {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function loadSample(): void {
  meshText.value = SAMPLE_MESH;
}

/* -------------------------------------------------------------------------- */
/* Render controls                                                            */
/* -------------------------------------------------------------------------- */

/** Reads a number option's default and bounds from the tool's own meta. */
function numberOption(
  id: string,
  fallback: { default: number; min: number; max: number },
): { default: number; min: number; max: number } {
  const spec = props.meta.options?.find((o) => o.id === id);
  if (spec && spec.kind === "number") {
    return { default: spec.default, min: spec.min ?? fallback.min, max: spec.max ?? fallback.max };
  }
  return fallback;
}

const zScaleMeta = numberOption("zScale", { default: 10, min: 1, max: 50 });
const zScale = ref(zScaleMeta.default);

const CENTER_OPTIONS: { value: PaletteCenter; label: string }[] = [
  { value: "zero", label: "Zero" },
  { value: "mean", label: "Mean" },
];
const centerOn = ref<PaletteCenter>("zero");

const INTERPOLATION_OPTIONS = [1, 2, 4] as const;
const interpolation = ref<(typeof INTERPOLATION_OPTIONS)[number]>(1);

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const HEATMAP_WIDTH = 560;
const HEATMAP_HEIGHT = 420;
const ISO_WIDTH = 560;
const ISO_HEIGHT = 420;

const rows = ref<Record<string, string> | null>(null);
const verdict = ref("");
const advice = ref("");
const grade = ref<MeshGrade | null>(null);
const heatmapSvg = ref<string | null>(null);
const isoSvg = ref<string | null>(null);
/** The exact mesh (post interpolation) the two SVGs above were drawn from. */
const renderMesh = shallowRef<Mesh | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

/** An empty textarea is the tool waiting, not failing, same call as ToolShell. */
const isHint = computed(() => meshText.value.trim() === "");

function performRun(): void {
  hover.value = null;
  try {
    const opts: BedMeshOpts = { centerOn: centerOn.value, zScale: zScale.value };
    const result = bedMesh.run(meshText.value, opts);
    const { Verdict, Advice, ...rest } = result;
    rows.value = rest;
    verdict.value = Verdict;
    advice.value = Advice;

    const mesh = parseMesh(meshText.value);
    grade.value = analyzeMesh(mesh).grade;
    const rendered = interpolateMesh(mesh, interpolation.value);
    renderMesh.value = rendered;
    heatmapSvg.value = renderHeatmapSvg(rendered, {
      width: HEATMAP_WIDTH,
      height: HEATMAP_HEIGHT,
      palette: centerOn.value,
    });
    isoSvg.value = renderIsometricSvg(rendered, {
      width: ISO_WIDTH,
      height: ISO_HEIGHT,
      zScale: zScale.value,
      palette: centerOn.value,
    });
    error.value = null;
  } catch (e) {
    rows.value = null;
    verdict.value = "";
    advice.value = "";
    grade.value = null;
    heatmapSvg.value = null;
    isoSvg.value = null;
    renderMesh.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

let debounceHandle: ReturnType<typeof setTimeout> | undefined;
function scheduleRun(): void {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(performRun, 200);
}

watch([meshText, centerOn, zScale, interpolation], scheduleRun);

onMounted(() => {
  performRun();
});

/* -------------------------------------------------------------------------- */
/* Verdict emphasis                                                          */
/* -------------------------------------------------------------------------- */

const verdictBoxClass = computed(() => {
  if (grade.value === "excellent" || grade.value === "good") {
    return "border-[color:var(--positive)]/30 bg-[var(--positive-soft)]";
  }
  if (grade.value === "needs-tramming") return "border-destructive/40 bg-destructive/5";
  return "bg-secondary/60";
});

const verdictTextClass = computed(() => {
  if (grade.value === "excellent" || grade.value === "good") return "text-[color:var(--positive)]";
  if (grade.value === "needs-tramming") return "text-destructive";
  return "text-foreground";
});

/* -------------------------------------------------------------------------- */
/* Heat map hover readout                                                     */
/* -------------------------------------------------------------------------- */

// Mirrors the private padding constants in renderHeatmapSvg (src/tools/bed-mesh-visualizer/index.ts).
const HEATMAP_PAD_LEFT = 58;
const HEATMAP_PAD_RIGHT = 22;
const HEATMAP_PAD_TOP = 34;
const HEATMAP_PAD_BOTTOM = 84;

interface HoverInfo {
  x: number;
  y: number;
  valueText: string;
  posText: string;
}
const hover = ref<HoverInfo | null>(null);
const heatmapWrapRef = ref<HTMLElement>();

function onHeatmapPointerMove(e: MouseEvent): void {
  const wrap = heatmapWrapRef.value;
  const mesh = renderMesh.value;
  if (!wrap || !mesh) {
    hover.value = null;
    return;
  }
  const svgEl = wrap.querySelector("svg");
  if (!svgEl) {
    hover.value = null;
    return;
  }
  const svgRect = svgEl.getBoundingClientRect();
  if (svgRect.width === 0 || svgRect.height === 0) {
    hover.value = null;
    return;
  }

  // The rendered SVG scales to fill its box (CSS width 100%), so pointer
  // pixels are converted back into the fixed viewBox space before hit testing.
  const scaleX = HEATMAP_WIDTH / svgRect.width;
  const scaleY = HEATMAP_HEIGHT / svgRect.height;
  const vx = (e.clientX - svgRect.left) * scaleX;
  const vy = (e.clientY - svgRect.top) * scaleY;

  const plotW = HEATMAP_WIDTH - HEATMAP_PAD_LEFT - HEATMAP_PAD_RIGHT;
  const plotH = HEATMAP_HEIGHT - HEATMAP_PAD_TOP - HEATMAP_PAD_BOTTOM;
  if (
    vx < HEATMAP_PAD_LEFT ||
    vx > HEATMAP_PAD_LEFT + plotW ||
    vy < HEATMAP_PAD_TOP ||
    vy > HEATMAP_PAD_TOP + plotH
  ) {
    hover.value = null;
    return;
  }

  const cellW = plotW / mesh.xCount;
  const cellH = plotH / mesh.yCount;
  const col = Math.min(mesh.xCount - 1, Math.max(0, Math.floor((vx - HEATMAP_PAD_LEFT) / cellW)));
  // Row 0 is drawn at the bottom (front of the bed), so the pointer's
  // top-to-bottom cell must be flipped back to the mesh's row index.
  const rowFromTop = Math.min(
    mesh.yCount - 1,
    Math.max(0, Math.floor((vy - HEATMAP_PAD_TOP) / cellH)),
  );
  const row = mesh.yCount - 1 - rowFromTop;
  const value = mesh.rows[row]![col]!;

  const hasCoords =
    mesh.minX !== undefined &&
    mesh.maxX !== undefined &&
    mesh.minY !== undefined &&
    mesh.maxY !== undefined;
  const posText = hasCoords
    ? `column ${col}, row ${row} (X ${fixed(mesh.minX! + ((mesh.maxX! - mesh.minX!) * col) / (mesh.xCount - 1), 1)} mm, Y ${fixed(mesh.minY! + ((mesh.maxY! - mesh.minY!) * row) / (mesh.yCount - 1), 1)} mm)`
    : `column ${col}, row ${row}`;

  const wrapRect = wrap.getBoundingClientRect();
  hover.value = {
    x: Math.min(e.clientX - wrapRect.left + 12, Math.max(0, wrap.clientWidth - 172)),
    y: Math.min(e.clientY - wrapRect.top + 12, Math.max(0, wrap.clientHeight - 52)),
    valueText: `${fixed(value, 4)} mm`,
    posText,
  };
}

function clearHover(): void {
  hover.value = null;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

function downloadHeatmapSvg(): void {
  if (!heatmapSvg.value) return;
  downloadBlob(new Blob([heatmapSvg.value], { type: "image/svg+xml" }), "bed-mesh-heatmap.svg");
}

function downloadIsoSvg(): void {
  if (!isoSvg.value) return;
  downloadBlob(new Blob([isoSvg.value], { type: "image/svg+xml" }), "bed-mesh-3d.svg");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The 3D view could not be decoded as an image."));
    img.src = src;
  });
}

const exportingPng = ref(false);

async function downloadIsoPng(): Promise<void> {
  if (!isoSvg.value || exportingPng.value) return;
  exportingPng.value = true;
  try {
    const scale = 2;
    const width = ISO_WIDTH * scale;
    const height = ISO_HEIGHT * scale;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new ToolError(
        "no-canvas",
        "This browser did not give the page a 2D canvas, so the PNG could not be drawn.",
        "Download the SVG instead. It opens in any browser, editor or design tool.",
      );
    }

    // The SVG background is transparent; a PNG needs a real one behind it.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const image = await loadImage(`data:image/svg+xml,${encodeURIComponent(isoSvg.value)}`);
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new ToolError(
        "png-failed",
        "The PNG could not be encoded.",
        "Download the SVG instead. It opens in any browser, editor or design tool.",
      );
    }
    downloadBlob(blob, "bed-mesh-3d.png");
  } catch (e) {
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : {
            message: e instanceof Error ? e.message : "The PNG could not be composed.",
            fix: "Download the SVG instead. It opens in any browser, editor or design tool.",
          };
  } finally {
    exportingPng.value = false;
  }
}
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
      <div class="flex flex-wrap items-center justify-between gap-1 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Mesh data
        </span>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="loadSample"> Load sample </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept=".txt,.cfg,text/plain"
            @change="onPickFile"
          />
        </div>
      </div>

      <Textarea
        v-model="meshText"
        spellcheck="false"
        rows="8"
        placeholder="Paste BED_MESH_OUTPUT console text, a saved [bed_mesh default] block, a Marlin G29 or M420 V grid, or a plain grid of numbers, or drop a .txt or .cfg file…"
        class="max-h-72 min-h-32 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
    </div>

    <!-- Errors and the empty-input hint -->
    <div
      v-if="error"
      :role="isHint ? 'status' : 'alert'"
      class="rounded-lg border px-3 py-2 text-sm"
      :class="isHint ? 'bg-secondary/60' : 'border-destructive/50 bg-destructive/5'"
    >
      <p :class="isHint ? 'font-medium text-muted-foreground' : 'font-medium text-destructive'">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <template v-if="rows">
      <!-- Verdict and advice, emphasized above the plain stats -->
      <div class="rounded-[14px] border p-4 shadow-[var(--sh-inset)]" :class="verdictBoxClass">
        <p class="text-sm font-semibold" :class="verdictTextClass">
          {{ verdict }}
        </p>
        <p class="mt-1.5 text-sm text-muted-foreground">
          {{ advice }}
        </p>
      </div>

      <!-- Stats, rendered the same way every other tool renders them -->
      <OutputView :output="rows" />

      <!-- Render controls -->
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Colour centre</span>
          <div
            role="group"
            aria-label="Colour centre"
            class="inline-flex gap-0.5 rounded-[10px] bg-secondary p-0.5 shadow-[var(--sh-inset)]"
          >
            <Button
              v-for="opt in CENTER_OPTIONS"
              :key="opt.value"
              size="sm"
              :variant="centerOn === opt.value ? 'default' : 'ghost'"
              :aria-pressed="centerOn === opt.value"
              @click="centerOn = opt.value"
            >
              {{ opt.label }}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Smoothing</span>
          <div
            role="group"
            aria-label="Interpolation"
            class="inline-flex gap-0.5 rounded-[10px] bg-secondary p-0.5 shadow-[var(--sh-inset)]"
          >
            <Button
              v-for="opt in INTERPOLATION_OPTIONS"
              :key="opt"
              size="sm"
              :variant="interpolation === opt ? 'default' : 'ghost'"
              :aria-pressed="interpolation === opt"
              @click="interpolation = opt"
            >
              {{ opt }}x
            </Button>
          </div>
        </div>

        <div class="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label for="bed-mesh-zscale" class="text-xs text-muted-foreground">
            Height exaggeration ({{ zScale }}x)
          </Label>
          <Slider
            id="bed-mesh-zscale"
            :model-value="[zScale]"
            :min="zScaleMeta.min"
            :max="zScaleMeta.max"
            :step="1"
            aria-label="Height exaggeration"
            class="min-w-0 flex-1"
            @update:model-value="zScale = Number($event?.[0] ?? zScale)"
          />
        </div>
      </div>

      <!-- SVG renders, side by side on wide screens -->
      <div class="grid gap-4 md:grid-cols-2">
        <div v-if="heatmapSvg" class="flex flex-col gap-1.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Heat map
            </span>
            <div class="flex items-center gap-1">
              <CopyButton :text="heatmapSvg" label="Copy SVG" />
              <Button variant="outline" size="sm" @click="downloadHeatmapSvg">
                Download SVG
              </Button>
            </div>
          </div>

          <div
            ref="heatmapWrapRef"
            class="bed-mesh-svg relative overflow-hidden rounded-[10px] bg-card p-2 shadow-[var(--sh-inset)]"
            @mousemove="onHeatmapPointerMove"
            @mouseleave="clearHover"
          >
            <!-- eslint-disable-next-line vue/no-v-html -- generated by this tool's own SVG renderer from parsed numbers, never from raw input text -->
            <div v-html="heatmapSvg" />

            <div
              v-if="hover"
              class="pointer-events-none absolute z-10 max-w-48 rounded-[8px] border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-[var(--sh-md)]"
              :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
            >
              <p class="font-mono tabular-nums">{{ hover.valueText }}</p>
              <p class="text-muted-foreground">{{ hover.posText }}</p>
            </div>
          </div>
        </div>

        <div v-if="isoSvg" class="flex flex-col gap-1.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              3D surface
            </span>
            <div class="flex items-center gap-1">
              <CopyButton :text="isoSvg" label="Copy SVG" />
              <Button variant="outline" size="sm" @click="downloadIsoSvg"> Download SVG </Button>
              <Button variant="outline" size="sm" :disabled="exportingPng" @click="downloadIsoPng">
                {{ exportingPng ? "Rendering…" : "Download PNG" }}
              </Button>
            </div>
          </div>

          <div class="bed-mesh-svg rounded-[10px] bg-card p-2 shadow-[var(--sh-inset)]">
            <!-- eslint-disable-next-line vue/no-v-html -- generated by this tool's own SVG renderer from parsed numbers, never from raw input text -->
            <div v-html="isoSvg" />
          </div>

          <p class="text-xs text-muted-foreground">
            This is a fixed isometric angle. The renderer takes a height exaggeration and a colour
            centre, but no rotation, so there is no rotate control here.
          </p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * v-html content carries no scope attribute, so the rendered SVG is reached
 * through :deep. The width and height baked into the SVG are its intrinsic
 * size; this lets a wide render shrink to the pane instead of overflowing it.
 */
.bed-mesh-svg :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
