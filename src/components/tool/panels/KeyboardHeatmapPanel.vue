<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  DEFAULT_TEXT,
  MAX_CHARACTERS,
  analyzeText,
  compareLayouts,
  renderHeatmapSvg,
  run,
  type Analysis,
  type ComparisonRow,
} from "@/tools/keyboard-heatmap/index";
import { FINGER_LABELS, LAYOUTS, LAYOUT_IDS, ROW_LABELS } from "@/tools/keyboard-heatmap/layouts";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download } from "lucide-vue-next";
import CopyButton from "../CopyButton.vue";
import OutputView from "../OutputView.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for the Keyboard Layout Heatmap.
 *
 * The generic ToolShell only knows how to print run()'s Record<string,string>
 * rows, which is fine for the plain report but says nothing about where the
 * load actually falls. This panel adds the three things a heatmap tool needs
 * that the shell has no vocabulary for: the inline keyboard diagram (this
 * tool's own renderHeatmapSvg), a couple of plain-div bar charts for finger
 * and row load, and, in compare mode, a ranked table across every layout with
 * small heatmaps alongside it.
 *
 * All of the arithmetic lives in src/tools/keyboard-heatmap (rule 27): this
 * file only collects the text, drives analyzeText / compareLayouts /
 * renderHeatmapSvg with it, and lays the results out. run() itself is still
 * the source of the plain report rows (rendered the standard way via
 * OutputView) and the single place that enforces the character limit, so a
 * too-long paste surfaces the same friendly message here as it would from the
 * generic shell.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Layout select, sourced from meta.options so labels and synonyms never
 * drift from the searchable-select shown on every other tool. Falls back to
 * the raw layout ids if meta.ts ever loses the spec, so the panel never hard
 * fails on a shape change elsewhere.
 * ------------------------------------------------------------------ */

const layoutSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "layout");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "layout",
    label: "Layout",
    default: "qwerty",
    options: LAYOUT_IDS.map((id) => ({ value: id, label: LAYOUTS[id].name, synonyms: [id] })),
  };
});

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const text = ref("");
const layout = ref("qwerty");
const mode = ref<"analyze" | "compare">("analyze");

/** Which layout's heatmap the compare view is currently showing full size. */
const heatmapLayoutId = ref("qwerty");

const report = shallowRef<Record<string, string> | null>(null);
const analysis = shallowRef<Analysis | null>(null);
const compareRows = shallowRef<ComparisonRow[]>([]);
/** The text compare mode last ran on (with the empty-input default applied), so the
 * heatmap viewer and the top-3 thumbnails can re-derive a layout's hit counts
 * without re-running the ten-layout comparison. */
const compareRawText = ref("");

const error = ref<{ message: string; fix?: string } | null>(null);

/* ------------------------------------------------------------------ *
 * Input: paste, drop, file picker, sample
 * ------------------------------------------------------------------ */

async function readFile(file: File) {
  text.value = await file.text();
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

function loadSample() {
  text.value = DEFAULT_TEXT;
}

/* ------------------------------------------------------------------ *
 * Compute
 * ------------------------------------------------------------------ */

function persistFragment() {
  writeFragment({ input: text.value, opts: { layout: layout.value, mode: mode.value } });
}

function recompute() {
  persistFragment();

  let rows: Record<string, string>;
  try {
    rows = run(text.value, { layout: layout.value, mode: mode.value });
  } catch (e) {
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : "That text could not be analyzed." };
    report.value = null;
    analysis.value = null;
    compareRows.value = [];
    compareRawText.value = "";
    return;
  }

  error.value = null;
  report.value = rows;

  // Mirrors run()'s own empty-input fallback so the heatmap and bar charts
  // describe exactly the text the report above is describing.
  const effective = text.value.trim() === "" ? DEFAULT_TEXT : text.value;

  if (mode.value === "analyze") {
    analysis.value = analyzeText(effective, layout.value);
    compareRows.value = [];
    compareRawText.value = "";
  } else {
    analysis.value = null;
    compareRawText.value = effective;
    compareRows.value = Object.values(compareLayouts(effective, LAYOUT_IDS));
  }
}

/** Layout and mode are discrete choices, so they recompute immediately.
 * Typing debounces instead, so a long paste is not re-analyzed on every
 * keystroke. */
watch([layout, mode], recompute);

const DEBOUNCE_MS = 220;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(text, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(recompute, DEBOUNCE_MS);
});

// The heatmap viewer in compare mode defaults to whichever layout the top
// select is on, so switching it there updates the viewer too.
watch(layout, (v) => {
  heatmapLayoutId.value = v;
});

/* ------------------------------------------------------------------ *
 * Derived: heatmap SVGs and bar charts
 * ------------------------------------------------------------------ */

const heatmapSvg = computed(() =>
  analysis.value ? renderHeatmapSvg(analysis.value.layoutId, analysis.value.hitCounts) : "",
);

const fingerBars = computed(() => {
  const a = analysis.value;
  if (!a) return [];
  return FINGER_LABELS.map((label, i) => ({ label, percent: a.fingerPercents[i] }));
});

const rowBars = computed(() => {
  const a = analysis.value;
  if (!a) return [];
  return ROW_LABELS.map((label, i) => ({ label, percent: a.rowPercents[i] }));
});

interface HeatmapThumb {
  row: ComparisonRow;
  svg: string;
}

/** Top 3 ranked layouts, each with its own heatmap for the same text. */
const top3 = computed<HeatmapThumb[]>(() => {
  if (!compareRawText.value || compareRows.value.length === 0) return [];
  return compareRows.value.slice(0, 3).map((row) => ({
    row,
    svg: renderHeatmapSvg(row.layoutId, analyzeText(compareRawText.value, row.layoutId).hitCounts),
  }));
});

interface SelectedHeatmap {
  layoutId: string;
  name: string;
  svg: string;
}

/** The heatmap for whichever layout is picked in the compare view's own select. */
const selectedHeatmap = computed<SelectedHeatmap | null>(() => {
  if (!compareRawText.value) return null;
  const id = heatmapLayoutId.value;
  const hitCounts = analyzeText(compareRawText.value, id).hitCounts;
  return { layoutId: id, name: LAYOUTS[id]?.name ?? id, svg: renderHeatmapSvg(id, hitCounts) };
});

const activeHeatmap = computed(() => {
  if (mode.value === "analyze") {
    return analysis.value ? { id: analysis.value.layoutId, svg: heatmapSvg.value } : null;
  }
  return selectedHeatmap.value
    ? { id: selectedHeatmap.value.layoutId, svg: selectedHeatmap.value.svg }
    : null;
});

const reportText = computed(() =>
  report.value
    ? Object.entries(report.value)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "",
);

function downloadHeatmap() {
  const active = activeHeatmap.value;
  if (!active) return;
  downloadBlob(
    new Blob([active.svg], { type: "image/svg+xml" }),
    `keyboard-heatmap-${active.id}.svg`,
  );
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) text.value = frag.input;
  if (frag.opts.layout && LAYOUT_IDS.includes(frag.opts.layout)) layout.value = frag.opts.layout;
  if (frag.opts.mode === "analyze" || frag.opts.mode === "compare") mode.value = frag.opts.mode;
  heatmapLayoutId.value = layout.value;
  recompute();
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop accept=".txt,text/plain" @files="onFiles">
      <template #default="{ open }">
        <div class="flex flex-wrap items-center justify-between gap-1 pb-1">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Text
          </span>
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="sm" @click="loadSample"> Load sample paragraph </Button>
            <Button variant="ghost" size="sm" @click="open"> Open file… </Button>
          </div>
        </div>

        <Textarea
          v-model="text"
          placeholder="Paste your writing, code, or a chat log here, or drop a .txt file…"
          class="max-h-80 min-h-32 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <p
          class="pt-2 text-xs"
          :class="text.length > MAX_CHARACTERS ? 'text-destructive' : 'text-muted-foreground'"
        >
          {{ text.length.toLocaleString() }} / {{ MAX_CHARACTERS.toLocaleString() }} characters
        </p>
      </template>
    </FileDrop>

    <Tabs v-model="mode" class="flex flex-col gap-4">
      <!-- Controls -->
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex w-full flex-col gap-1.5 sm:w-64">
          <Label for="kh-layout" class="text-xs text-muted-foreground">Layout</Label>
          <SearchableSelect
            id="kh-layout"
            :spec="layoutSpec"
            :model-value="layout"
            class="w-full bg-card"
            @update:model-value="(v: string) => (layout = v)"
          />
        </div>

        <TabsList class="flex w-full flex-wrap sm:w-fit">
          <TabsTrigger value="analyze"> Analyze one layout </TabsTrigger>
          <TabsTrigger value="compare"> Compare every layout </TabsTrigger>
        </TabsList>
      </div>

      <!-- Error -->
      <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

      <!-- Export -->
      <div v-if="report && !error" class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :disabled="!activeHeatmap" @click="downloadHeatmap">
          <Download class="size-3.5" aria-hidden="true" />
          Download heatmap SVG
        </Button>
        <CopyButton :text="reportText" label="Copy report" />
      </div>

      <!-- Analyze -->
      <TabsContent v-if="!error" value="analyze" class="flex flex-col gap-4">
        <template v-if="analysis">
          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Heatmap
            </span>
            <div class="overflow-x-auto rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
              <!-- eslint-disable-next-line vue/no-v-html -- the SVG markup is built entirely by this tool's own renderHeatmapSvg, from the fixed layout data and numeric counts, with every interpolated value escaped there -->
              <div class="min-w-[560px]" v-html="heatmapSvg"></div>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Finger load
              </span>
              <div
                class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              >
                <div
                  v-for="bar in fingerBars"
                  :key="bar.label"
                  class="flex items-center gap-2 text-xs"
                >
                  <span class="w-20 shrink-0 text-muted-foreground">{{ bar.label }}</span>
                  <div class="h-2 flex-1 overflow-hidden rounded-full bg-card">
                    <div
                      class="h-full rounded-full bg-[image:var(--grad-brand)]"
                      :style="{ width: `${Math.min(100, bar.percent)}%` }"
                    ></div>
                  </div>
                  <span class="w-12 shrink-0 text-right font-mono tabular-nums"
                    >{{ bar.percent.toFixed(1) }}%</span
                  >
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Row distribution
              </span>
              <div
                class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              >
                <div
                  v-for="bar in rowBars"
                  :key="bar.label"
                  class="flex items-center gap-2 text-xs"
                >
                  <span class="w-24 shrink-0 text-muted-foreground capitalize">{{
                    bar.label
                  }}</span>
                  <div class="h-2 flex-1 overflow-hidden rounded-full bg-card">
                    <div
                      class="h-full rounded-full bg-[image:var(--grad-brand)]"
                      :style="{ width: `${Math.min(100, bar.percent)}%` }"
                    ></div>
                  </div>
                  <span class="w-12 shrink-0 text-right font-mono tabular-nums"
                    >{{ bar.percent.toFixed(1) }}%</span
                  >
                </div>
              </div>
            </div>
          </div>

          <OutputView v-if="report" :output="report" />
        </template>
        <p v-else class="text-xs text-muted-foreground">Add some text above to see its heatmap.</p>
      </TabsContent>

      <!-- Compare -->
      <TabsContent v-if="!error" value="compare" class="flex flex-col gap-4">
        <template v-if="compareRows.length">
          <div class="overflow-x-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
            <table class="w-full min-w-[640px] text-sm">
              <thead>
                <tr class="text-left text-xs font-semibold text-muted-foreground">
                  <th scope="col" class="px-3 py-1.5">Rank</th>
                  <th scope="col" class="px-3 py-1.5">Layout</th>
                  <th scope="col" class="px-3 py-1.5">Effort / 100</th>
                  <th scope="col" class="px-3 py-1.5">Same finger</th>
                  <th scope="col" class="px-3 py-1.5">Home row</th>
                  <th scope="col" class="px-3 py-1.5">Alternation</th>
                  <th scope="col" class="px-3 py-1.5">Rolls</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in compareRows"
                  :key="row.layoutId"
                  :class="
                    row.layoutId === layout
                      ? 'bg-[color:var(--accent-soft)] font-semibold text-[color:var(--primary)]'
                      : ''
                  "
                >
                  <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.rank }}</td>
                  <td class="px-3 py-1.5">
                    {{ row.layoutName }}
                    <span
                      v-if="row.layoutId === layout"
                      class="ml-1 text-xs font-normal text-muted-foreground"
                      >(yours)</span
                    >
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ row.effortPer100.toFixed(1) }}
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ row.sameFingerPercent.toFixed(1) }}%
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ row.homeRowPercent.toFixed(1) }}%
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ row.alternationPercent.toFixed(1) }}%
                  </td>
                  <td class="px-3 py-1.5 font-mono tabular-nums">
                    {{ row.rollPercent.toFixed(1) }}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Top 3 heatmaps
            </span>
            <div class="grid gap-3 sm:grid-cols-3">
              <div
                v-for="entry in top3"
                :key="entry.row.layoutId"
                class="flex flex-col gap-1.5 overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
              >
                <span class="px-1 text-xs font-medium"
                  >{{ entry.row.rank }}. {{ entry.row.layoutName }}</span
                >
                <!-- eslint-disable-next-line vue/no-v-html -- the SVG markup is built entirely by this tool's own renderHeatmapSvg, from the fixed layout data and numeric counts, with every interpolated value escaped there -->
                <div class="min-w-[420px]" v-html="entry.svg"></div>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <Label
                for="kh-heatmap-layout"
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                View any layout's heatmap
              </Label>
              <div class="w-full sm:w-56">
                <SearchableSelect
                  id="kh-heatmap-layout"
                  :spec="layoutSpec"
                  :model-value="heatmapLayoutId"
                  class="w-full bg-card"
                  @update:model-value="(v: string) => (heatmapLayoutId = v)"
                />
              </div>
            </div>
            <div
              v-if="selectedHeatmap"
              class="overflow-x-auto rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
            >
              <!-- eslint-disable-next-line vue/no-v-html -- the SVG markup is built entirely by this tool's own renderHeatmapSvg, from the fixed layout data and numeric counts, with every interpolated value escaped there -->
              <div class="min-w-[560px]" v-html="selectedHeatmap.svg"></div>
            </div>
          </div>
        </template>
        <p v-else class="text-xs text-muted-foreground">
          Add some text above to compare every layout.
        </p>
      </TabsContent>
    </Tabs>
  </div>
</template>
