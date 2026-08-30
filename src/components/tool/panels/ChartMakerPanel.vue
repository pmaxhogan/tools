<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import type { ChartData, ChartOpts } from "@/tools/chart-maker/index";
import { formatNumber, parseChartData, renderChart } from "@/tools/chart-maker/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for Chart Maker.
 *
 * The generic ToolShell would print the SVG source into a text block, which is
 * the one thing nobody wants from a chart tool. This island paints the chart
 * instead, and adds the three things the shell has no vocabulary for: hover
 * readouts driven by the data attributes the renderer stamps on every mark, a
 * light and dark preview so the same chart can be checked against both
 * surfaces before it is exported, and a PNG raster.
 *
 * The logic layer stays pure (rule 27). Parsing, layout, palettes, tick
 * choice and every string of markup come from src/tools/chart-maker; this file
 * only collects input, positions a tooltip, and saves files.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

const SAMPLE = [
  "# Monthly revenue by channel",
  "Month,Direct,Partner,Online",
  "Jan,120,86,42",
  "Feb,138,92,55",
  "Mar,131,104,68",
  "Apr,152,99,74",
  "May,168,112,91",
  "Jun,181,126,103",
].join("\n");

const input = ref("");

async function onFiles(files: File[]) {
  const file = files[0];
  if (file) input.value = await file.text();
}

function loadSample() {
  input.value = SAMPLE;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Schema-driven, so the controls match every generic tool page exactly. */
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

const chartOpts = computed<ChartOpts>(() => ({
  type: String(opts.value.type ?? "bar"),
  width: Number(opts.value.width ?? 800),
  height: Number(opts.value.height ?? 450),
  legend: Boolean(opts.value.legend),
  gridlines: Boolean(opts.value.gridlines),
  valueLabels: Boolean(opts.value.valueLabels),
  palette: String(opts.value.palette ?? "site"),
}));

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

const svgOutput = ref<string | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

/**
 * An empty input is the tool waiting, not the tool failing, so its message
 * renders as a neutral hint rather than a red error (the same call ToolShell
 * makes).
 */
const isHint = computed(() => input.value.trim() === "");

/**
 * Parsing is cached on the exact input text, so dragging the width control
 * re-runs the layout without re-parsing the CSV behind it.
 */
let parsedFrom: string | null = null;
let parsed: ChartData | null = null;

function performRun() {
  try {
    if (parsedFrom !== input.value || !parsed) {
      parsed = parseChartData(input.value);
      parsedFrom = input.value;
    }
    const svg = renderChart(parsed, chartOpts.value);
    // Belt and braces: the markup below is built by our own logic layer from
    // parsed numbers, never passed through from the input, and every value it
    // interpolates is escaped there. This check exists so that stops being an
    // assumption the panel makes silently.
    if (/<script/i.test(svg)) {
      throw new ToolError(
        "unsafe-output",
        "The chart could not be shown because the generated image failed its safety check.",
        "Reload the page and try again. If it keeps happening, download the SVG and open it in an editor to inspect it.",
      );
    }
    svgOutput.value = svg;
    error.value = null;
  } catch (e) {
    parsedFrom = null;
    parsed = null;
    svgOutput.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------------------------------------------- */
/* Fragment state                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors MAX_FRAGMENT_INPUT in src/lib/fragment.ts, which drops a longer
 * input rather than writing a link nothing can open. It is not exported, and
 * this panel is the only file in this change, so the number is repeated here
 * purely to tell the reader that the data was left out on purpose.
 */
const FRAGMENT_INPUT_MAX = 2000;

const dataTooLargeForLink = computed(
  () => input.value.length > FRAGMENT_INPUT_MAX && svgOutput.value !== null,
);

function persistFragment() {
  writeFragment({
    // Same rule as the generic shell: pasted data round trips in the link so a
    // shared chart opens as the chart, and writeFragment drops anything over
    // its own size cap.
    input: input.value,
    opts: Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
  });
}

/* -------------------------------------------------------------------------- */
/* Debounce and lifecycle                                                     */
/* -------------------------------------------------------------------------- */

let debounceHandle: ReturnType<typeof setTimeout> | undefined;

function scheduleRun() {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    performRun();
    persistFragment();
  }, 180);
}

watch(input, scheduleRun);
watch(opts, scheduleRun, { deep: true });

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) input.value = frag.input;
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw === undefined) continue;
    if (spec.kind === "number" || spec.kind === "slider") opts.value[spec.id] = Number(raw);
    else if (spec.kind === "boolean") opts.value[spec.id] = raw === "true";
    else opts.value[spec.id] = raw;
  }

  // The preview opens on whichever theme the page is wearing, so the first
  // thing a visitor sees is the chart on the surface they are already reading.
  darkPreview.value = document.documentElement.classList.contains("dark");

  performRun();
});

/* -------------------------------------------------------------------------- */
/* Preview surface                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The two card surfaces from DESIGN.md, written out as hex because the panel
 * needs both at once: CSS tokens only ever resolve to the theme the page is
 * currently in, and the export needs a literal color to paint onto a canvas.
 * The chart palettes are contrast verified against exactly these two surfaces
 * (see the palette note in src/tools/chart-maker/index.ts).
 */
const LIGHT_SURFACE = { ink: "#1B1917", background: "#FFFFFF" };
const DARK_SURFACE = { ink: "#F4F1EC", background: "#1D1B18" };

const darkPreview = ref(false);
const surface = computed(() => (darkPreview.value ? DARK_SURFACE : LIGHT_SURFACE));

/* -------------------------------------------------------------------------- */
/* Hover readout                                                              */
/* -------------------------------------------------------------------------- */

interface Readout {
  x: number;
  y: number;
  label: string;
  series: string;
  value: string;
}

const previewBox = ref<HTMLElement>();
const readout = ref<Readout | null>(null);

/** Marks carry data-label; lines, areas and axis furniture deliberately do not. */
function onPointerMove(e: MouseEvent) {
  const host = previewBox.value;
  const target = e.target as Element | null;
  const mark = target?.closest?.("[data-label]") ?? null;
  if (!host || !mark) {
    readout.value = null;
    return;
  }
  const raw = mark.getAttribute("data-value") ?? "";
  const asNumber = Number(raw);
  const rect = host.getBoundingClientRect();
  readout.value = {
    // Clamped so a mark near the right or bottom edge still shows its readout
    // inside the well instead of pushing the panel wider.
    x: Math.min(e.clientX - rect.left + 14, Math.max(0, host.clientWidth - 172)),
    y: Math.min(e.clientY - rect.top + 14, Math.max(0, host.clientHeight - 60)),
    label: mark.getAttribute("data-label") ?? "",
    series: mark.getAttribute("data-series") ?? "",
    value: Number.isFinite(asNumber) && raw !== "" ? formatNumber(asNumber) : raw,
  };
}

function clearReadout() {
  readout.value = null;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

function downloadSvg() {
  if (!svgOutput.value) return;
  downloadBlob(new Blob([svgOutput.value], { type: "image/svg+xml" }), "chart.svg");
}

/**
 * A chart inlined in the page inherits its ink through currentColor. A
 * standalone raster has no page to inherit from, so the root gets an explicit
 * color before it is handed to the decoder. The renderer marks the root with
 * data-chart-ink="currentColor" for exactly this step; the attribute rewrite
 * after it covers decoders that resolve presentation attributes before the
 * inline style.
 */
function svgForExport(svg: string, ink: string): string {
  return svg
    .replace(/^<svg\b/, `<svg style="color:${ink}"`)
    .replaceAll('"currentColor"', `"${ink}"`);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The chart could not be decoded as an image."));
    img.src = src;
  });
}

const exporting = ref(false);

async function downloadPng() {
  if (!svgOutput.value || exporting.value) return;
  exporting.value = true;
  try {
    // Twice the chart size, so the raster still looks sharp on a high density
    // display and survives being scaled down into a slide.
    const scale = 2;
    const width = chartOpts.value.width * scale;
    const height = chartOpts.value.height * scale;

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

    // The SVG itself stays transparent; a PNG needs a real background or it
    // lands as pale text on whatever the viewer puts behind it.
    ctx.fillStyle = surface.value.background;
    ctx.fillRect(0, 0, width, height);

    const source = svgForExport(svgOutput.value, surface.value.ink);
    const image = await loadImage(`data:image/svg+xml,${encodeURIComponent(source)}`);
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new ToolError(
        "png-failed",
        "The PNG could not be encoded.",
        "Download the SVG instead, or try a smaller width and height.",
      );
    }
    downloadBlob(blob, "chart.png");
  } catch (e) {
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : {
            message: e instanceof Error ? e.message : "The PNG could not be composed.",
            fix: "Download the SVG instead. It opens in any browser, editor or design tool.",
          };
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      bare
      accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
      label="Data"
      hint="Drop a CSV or TSV file here, or click to choose one"
      @files="onFiles"
    >
      <template #default="{ open }">
        <div class="flex flex-wrap items-center justify-between gap-1 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Data
          </span>
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="sm" @click="loadSample"> Load sample </Button>
            <Button variant="ghost" size="sm" @click="open"> Open file… </Button>
          </div>
        </div>

        <Textarea
          v-model="input"
          placeholder="Paste CSV or TSV here, or drop a .csv file. Labels in the first column, numbers after them."
          class="max-h-80 min-h-28 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </template>
    </FileDrop>

    <!-- Options -->
    <div v-if="meta.options?.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <!-- Errors and the empty-input hint -->
    <ErrorBanner
      v-if="error"
      :message="error.message"
      :hint="error.fix"
      :variant="isHint ? 'info' : 'error'"
    />

    <!-- Preview -->
    <template v-if="svgOutput">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Preview
        </span>
        <div class="flex items-center gap-2">
          <Label for="chart-dark-preview" class="cursor-pointer text-xs text-muted-foreground">
            Dark preview
          </Label>
          <Switch id="chart-dark-preview" v-model="darkPreview" />
        </div>
      </div>

      <div
        ref="previewBox"
        class="chart-preview relative overflow-x-auto rounded-[10px] p-4 shadow-[var(--sh-inset)]"
        :style="{ backgroundColor: surface.background, color: surface.ink }"
        @mousemove="onPointerMove"
        @mouseleave="clearReadout"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- the markup is built by this tool's own logic layer from parsed numbers, with every interpolated value escaped there, and is checked for a script tag before it reaches this binding -->
        <div v-html="svgOutput" />

        <div
          v-if="readout"
          class="pointer-events-none absolute z-10 max-w-40 rounded-[8px] border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-[var(--sh-md)]"
          :style="{ left: `${readout.x}px`, top: `${readout.y}px` }"
        >
          <p class="truncate font-medium">{{ readout.label }}</p>
          <p v-if="readout.series" class="truncate text-muted-foreground">{{ readout.series }}</p>
          <p class="font-mono tabular-nums">{{ readout.value }}</p>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        The SVG has a transparent background and takes its ink from the page around it, so it reads
        on both themes. The PNG is flat, so it is exported on the preview surface you picked above.
      </p>

      <p v-if="dataTooLargeForLink" class="text-xs text-muted-foreground">
        This data is too long to fit in a shareable link, so the address bar keeps the chart
        settings only.
      </p>

      <!-- Exports -->
      <div class="flex flex-wrap items-center gap-2">
        <CopyButton :text="svgOutput" label="Copy SVG" />
        <Button variant="outline" size="sm" @click="downloadSvg"> Download SVG </Button>
        <Button variant="outline" size="sm" :disabled="exporting" @click="downloadPng">
          {{ exporting ? "Rendering PNG…" : "Download PNG" }}
        </Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * v-html content carries no scope attribute, so the chart is reached through
 * :deep. The width and height baked into the SVG are its intrinsic size; this
 * lets a wide chart shrink to the pane instead of overflowing it.
 */
.chart-preview :deep(svg) {
  display: block;
  max-width: 100%;
  height: auto;
}
</style>
