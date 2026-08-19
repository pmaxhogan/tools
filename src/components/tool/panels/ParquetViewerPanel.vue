<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { ChevronLeft, ChevronRight, Download, Sigma, X } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * Bespoke panel for the Parquet viewer. The generic ToolShell renders a
 * Record<string,string> of text blocks, which is the wrong shape for a columnar
 * file: this one wants a metadata card, a schema table, a column picker, and a
 * scrolling grid that keeps paging deeper into the file.
 *
 * Every rule lives in the logic layer (rule 27): the magic-byte check, the
 * decode, the schema flattening, cell formatting, CSV writing and the column
 * summaries are all imported from `@/tools/parquet-viewer/index`. The panel only
 * decides what to ask for and how to draw the answer. The module is imported
 * lazily so the Parquet reader stays out of every other page's bundle.
 *
 * One shape of the logic drives the paging design: `readParquet` decodes rows
 * from the start of the file up to a budget, with no row offset, so "more rows"
 * means re-reading with a larger budget rather than fetching a window. Paging
 * within what is already decoded is free; paging past it costs another decode.
 */
defineProps<{ meta: ToolMeta }>();

type ParquetLogic = typeof import("@/tools/parquet-viewer/index");
type ParquetFile = import("@/tools/parquet-viewer/index").ParquetFile;

/** Rows decoded on the first open. Enough for a real look, cheap on a big file. */
const INITIAL_ROWS = 100;
/** Rows added by one press of the load button. */
const LOAD_STEP = 500;
/** The reader clamps its row budget here, so the panel stops asking past it. */
const MAX_ROWS = 100000;
/** Characters kept per cell in the grid. Copying still yields the full value. */
const CELL_CAP = 300;
const PAGE_SIZES = [50, 100, 500];

let logicPromise: Promise<ParquetLogic> | null = null;
function loadLogic(): Promise<ParquetLogic> {
  logicPromise ??= import("@/tools/parquet-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<ParquetLogic | null>(null);
/** The file bytes, kept so a wider budget or a new column set can re-read. */
const bytes = shallowRef<Uint8Array | null>(null);
/**
 * The first read. Its metadata, schema, row count and full column list describe
 * the file itself, so they must not follow a later column-subset read.
 */
const info = shallowRef<ParquetFile | null>(null);
/** Rows from the most recent read. Replaced wholesale, never mutated. */
const rows = shallowRef<Record<string, unknown>[]>([]);
const allColumns = shallowRef<string[]>([]);
const picked = shallowRef<string[]>([]);

const fileName = ref("");
const fileSize = ref(0);
const budget = ref(INITIAL_ROWS);
const page = ref(0);
const pageSize = ref(100);

const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const busy = ref(false);
const fileInput = ref<HTMLInputElement>();

const statsColumn = ref<string | null>(null);
const copiedKey = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

/** Guards against an older, smaller read landing after a newer one. */
let readSeq = 0;

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "parquet";
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/* ---------------------------------------------------------------- */
/* reading                                                           */
/* ---------------------------------------------------------------- */

function reset() {
  info.value = null;
  bytes.value = null;
  rows.value = [];
  allColumns.value = [];
  picked.value = [];
  budget.value = INITIAL_ROWS;
  page.value = 0;
  statsColumn.value = null;
  copiedKey.value = null;
}

/**
 * Re-decode with a new row budget or column set. Both the budget and the
 * selection move first so the controls stay responsive, and roll back if the
 * read fails, because a column set the grid cannot fill would draw empty cells.
 */
async function readRows(nextBudget: number, nextColumns: string[]) {
  const mod = logic.value;
  const source = bytes.value;
  if (!mod || !source || nextColumns.length === 0) return;

  const prevColumns = picked.value;
  const prevBudget = budget.value;
  const seq = ++readSeq;

  busy.value = true;
  picked.value = nextColumns;
  budget.value = nextBudget;

  try {
    const parsed = await mod.readParquet(source, { rows: nextBudget, columns: nextColumns });
    if (seq !== readSeq) return;
    rows.value = parsed.rows;
    error.value = null;
  } catch (e) {
    if (seq !== readSeq) return;
    picked.value = prevColumns;
    budget.value = prevBudget;
    error.value = toToolError(e);
  } finally {
    if (seq === readSeq) busy.value = false;
  }
}

async function openFile(file: File) {
  const seq = ++readSeq;
  busy.value = true;
  error.value = null;

  try {
    const mod = await loadLogic();
    const buffer = await file.arrayBuffer();
    const source = new Uint8Array(buffer);
    const parsed = await mod.readParquet(source, { rows: INITIAL_ROWS });
    if (seq !== readSeq) return;

    reset();
    logic.value = mod;
    bytes.value = source;
    info.value = parsed;
    allColumns.value = parsed.columns;
    picked.value = [...parsed.columns];
    rows.value = parsed.rows;
    fileName.value = file.name;
    fileSize.value = file.size;
  } catch (e) {
    if (seq !== readSeq) return;
    reset();
    fileName.value = "";
    fileSize.value = 0;
    error.value = toToolError(e);
  } finally {
    if (seq === readSeq) busy.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  openFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearFile() {
  readSeq += 1;
  reset();
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  busy.value = false;
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* paging                                                            */
/* ---------------------------------------------------------------- */

const loadedCount = computed(() => rows.value.length);
const totalRows = computed(() => info.value?.rowCount ?? 0);

const canLoadMore = computed(
  () => loadedCount.value < totalRows.value && loadedCount.value < MAX_ROWS,
);
const atRowCap = computed(
  () => loadedCount.value >= MAX_ROWS && loadedCount.value < totalRows.value,
);
const nextStep = computed(() =>
  Math.min(LOAD_STEP, totalRows.value - loadedCount.value, MAX_ROWS - loadedCount.value),
);

const pageStart = computed(() => page.value * pageSize.value);
const pageRows = computed(() =>
  rows.value.slice(pageStart.value, pageStart.value + pageSize.value),
);
const pageCount = computed(() => Math.max(1, Math.ceil(loadedCount.value / pageSize.value)));

const canPrev = computed(() => page.value > 0 && !busy.value);
const canNext = computed(
  () => !busy.value && (pageStart.value + pageSize.value < loadedCount.value || canLoadMore.value),
);

function loadMore() {
  if (!canLoadMore.value || busy.value) return;
  readRows(Math.min(MAX_ROWS, totalRows.value, loadedCount.value + LOAD_STEP), picked.value);
}

function prevPage() {
  if (!canPrev.value) return;
  page.value -= 1;
}

async function nextPage() {
  if (!canNext.value) return;
  const target = page.value + 1;
  const needed = (target + 1) * pageSize.value;
  if (needed > loadedCount.value && canLoadMore.value) {
    await readRows(Math.min(MAX_ROWS, totalRows.value, needed), picked.value);
  }
  if (target * pageSize.value < rows.value.length) page.value = target;
}

/** Keep the first visible row roughly in place when the page size changes. */
function setPageSize(size: number) {
  const first = pageStart.value;
  pageSize.value = size;
  page.value = Math.floor(first / size);
}

/* ---------------------------------------------------------------- */
/* columns, cells and stats                                          */
/* ---------------------------------------------------------------- */

function isPicked(name: string): boolean {
  return picked.value.includes(name);
}

/** The last checked column cannot be unchecked: the reader reads no columns. */
function isLastPicked(name: string): boolean {
  return picked.value.length === 1 && picked.value[0] === name;
}

function toggleColumn(name: string, on: boolean) {
  const chosen = new Set(picked.value);
  if (on) chosen.add(name);
  else chosen.delete(name);
  if (chosen.size === 0) return;
  // Stats for a column that is no longer decoded would summarize nothing.
  if (!on && statsColumn.value === name) statsColumn.value = null;
  readRows(
    budget.value,
    allColumns.value.filter((column) => chosen.has(column)),
  );
}

function pickAllColumns() {
  if (picked.value.length === allColumns.value.length) return;
  readRows(budget.value, [...allColumns.value]);
}

function cellText(value: unknown): string {
  const mod = logic.value;
  const flat = (mod ? mod.formatValue(value) : String(value)).replace(/\r\n|\r|\n|\t/g, " ");
  return flat.length > CELL_CAP ? `${flat.slice(0, CELL_CAP)}…` : flat;
}

/** The visible page, formatted once per page rather than once per render. */
const pageCells = computed(() =>
  pageRows.value.map((row) => picked.value.map((name) => cellText(row[name]))),
);

/**
 * Copying is delegated from the body: a 500 row page can hold thousands of
 * cells, and one listener is cheaper than one per cell. The clipboard gets the
 * full value, not the truncated text the grid shows.
 */
async function onCellClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  const cell = target?.closest?.("td[data-r]") as HTMLElement | null;
  const mod = logic.value;
  if (!cell || !mod) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const row = pageRows.value[r];
  const column = picked.value[c];
  if (!row || column === undefined) return;

  try {
    await navigator.clipboard.writeText(mod.formatValue(row[column]));
  } catch {
    return;
  }
  copiedKey.value = `${r}:${c}`;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedKey.value = null), 1200);
}

function toggleStats(name: string) {
  statsColumn.value = statsColumn.value === name ? null : name;
}

/** Computed, so a column is only summarized when its button is pressed. */
const stats = computed(() => {
  const mod = logic.value;
  const name = statsColumn.value;
  if (!mod || !name) return null;
  return mod.summarizeColumn(rows.value.map((row) => row[name]));
});

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

function exportCsv() {
  const mod = logic.value;
  if (!mod || rows.value.length === 0) return;
  const csv = mod.toCsv(rows.value, picked.value);
  downloadBlob(new Blob([csv], { type: "text/csv" }), `${baseName(fileName.value)}.csv`);
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
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Parquet file
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()">
          Open a .parquet file…
        </Button>
        <input
          ref="fileInput"
          type="file"
          accept=".parquet,.parq,.pq"
          class="hidden"
          @change="onPickFile"
        />
      </div>

      <div v-if="info" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <button
            type="button"
            aria-label="Close this file"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <div v-else class="px-3 pt-1 pb-3">
        <p class="text-sm text-muted-foreground">
          Drop a .parquet file here, or use the button above. The reader is JavaScript running in
          this tab: your files and inputs never leave your device.
        </p>
        <p class="mt-2 text-xs text-muted-foreground">
          Only the rows you ask for are decoded, so a file with millions of rows still opens
          quickly. Files up to 200 MB are accepted.
        </p>
      </div>
    </div>

    <p v-if="busy && !info" class="text-xs text-muted-foreground">Reading the file…</p>
    <p v-else-if="busy" class="text-xs text-muted-foreground">Decoding rows…</p>

    <!-- Errors -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <template v-if="info">
      <!-- File header -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="truncate font-mono text-sm">{{ fileName }}</div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">File size</div>
            <div class="font-mono text-lg tabular-nums">{{ formatBytes(fileSize) }}</div>
            <div class="text-xs text-muted-foreground">
              format version {{ info.metadata.version }}
            </div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Rows</div>
            <div class="font-mono text-lg tabular-nums">{{ totalRows.toLocaleString() }}</div>
            <div class="text-xs text-muted-foreground tabular-nums">
              {{ loadedCount.toLocaleString() }} loaded here
            </div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Row groups</div>
            <div class="font-mono text-lg tabular-nums">{{ info.rowGroups.toLocaleString() }}</div>
            <div v-if="info.metadata.compressedSize > 0" class="text-xs text-muted-foreground">
              {{ formatBytes(info.metadata.compressedSize) }} of column data
            </div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Columns</div>
            <div class="font-mono text-lg tabular-nums">{{ allColumns.length }}</div>
            <div class="text-xs text-muted-foreground tabular-nums">
              {{ picked.length }} shown, {{ info.schema.length }} schema nodes
            </div>
          </div>
        </div>

        <dl class="grid gap-2 text-xs sm:grid-cols-2">
          <div class="flex gap-2">
            <dt class="shrink-0 text-muted-foreground">Compression codecs</dt>
            <dd class="min-w-0 font-mono break-words">
              {{
                info.metadata.codecs.length > 0 ? info.metadata.codecs.join(", ") : "none recorded"
              }}
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="shrink-0 text-muted-foreground">Created by</dt>
            <dd class="min-w-0 font-mono break-words">
              {{ info.metadata.createdBy ?? "not recorded in this file" }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- Schema -->
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Schema
        </div>
        <div class="max-h-72 overflow-auto rounded-[8px] bg-card">
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr class="text-left text-xs text-muted-foreground">
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Column</th>
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Type</th>
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">
                  Logical type
                </th>
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">
                  Repetition
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/60">
              <tr v-for="column in info.schema" :key="column.name" class="align-top">
                <td class="px-3 py-1.5 font-mono text-xs break-words">{{ column.name }}</td>
                <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{{ column.type }}</td>
                <td class="px-3 py-1.5 font-mono text-xs break-words">
                  <span v-if="column.logicalType">{{ column.logicalType }}</span>
                  <span v-else class="text-muted-foreground italic">none</span>
                </td>
                <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap">
                  {{ column.repetition }}
                </td>
              </tr>
              <tr v-if="info.schema.length === 0">
                <td colspan="4" class="px-3 py-6 text-center text-sm text-muted-foreground">
                  This file declares no columns.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Column picker -->
      <div
        v-if="allColumns.length > 0"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Columns to decode
          </span>
          <Button
            variant="ghost"
            size="sm"
            :disabled="busy || picked.length === allColumns.length"
            @click="pickAllColumns"
          >
            Select all
          </Button>
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-2">
          <!-- Ids are keyed by position: a column name may hold spaces or dots,
               which an id and its label's `for` cannot carry. -->
          <div
            v-for="(name, i) in allColumns"
            :key="`pick-${name}`"
            class="flex items-center gap-2"
          >
            <Checkbox
              :id="`parquet-col-${i}`"
              :model-value="isPicked(name)"
              :disabled="busy || isLastPicked(name)"
              @update:model-value="(v) => toggleColumn(name, Boolean(v))"
            />
            <Label :for="`parquet-col-${i}`" class="font-mono text-xs">{{ name }}</Label>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          Unchecking a column skips it in the decode, which is the whole point of a columnar file:
          reading three columns of a hundred costs about three columns of work.
        </p>
      </div>

      <!-- Grid toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm tabular-nums">
            <template v-if="loadedCount === 0"> No rows to show. </template>
            <template v-else>
              Rows {{ (pageStart + 1).toLocaleString() }} to
              {{ (pageStart + pageRows.length).toLocaleString() }} of
              {{ count(totalRows, "row", "rows") }}
            </template>
          </div>
          <div class="text-xs text-muted-foreground tabular-nums">
            Page {{ page + 1 }} of {{ pageCount }} loaded,
            {{ count(loadedCount, "row", "rows") }} decoded so far
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1 rounded-[10px] bg-secondary p-1">
            <span class="px-1 text-xs text-muted-foreground">Rows per page</span>
            <button
              v-for="size in PAGE_SIZES"
              :key="`size-${size}`"
              type="button"
              class="rounded-[8px] px-2 py-1 text-xs tabular-nums outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="pageSize === size ? 'bg-card shadow-[var(--sh-sm)] font-medium' : ''"
              :aria-pressed="pageSize === size"
              @click="setPageSize(size)"
            >
              {{ size }}
            </button>
          </div>

          <Button variant="outline" size="sm" :disabled="loadedCount === 0" @click="exportCsv">
            <Download class="size-3.5" />
            Download CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="!canPrev"
            aria-label="Previous page"
            @click="prevPage"
          >
            <ChevronLeft class="size-3.5" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="!canNext"
            aria-label="Next page"
            @click="nextPage"
          >
            Next
            <ChevronRight class="size-3.5" />
          </Button>
          <Button v-if="canLoadMore" size="sm" :disabled="busy" @click="loadMore">
            Load {{ nextStep.toLocaleString() }} more
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Click a cell to copy its full value. The CSV holds every row decoded so far, not just this
        page. Rows are always decoded from the start of the file, so paging deeper decodes
        everything before it.
      </p>
      <p v-if="atRowCap" class="text-xs text-muted-foreground">
        This page decodes at most {{ MAX_ROWS.toLocaleString() }} rows. The rest of the file stays
        unread; for the whole thing, DuckDB or pyarrow on your own machine is the right tool.
      </p>

      <!-- Column stats -->
      <div
        v-if="statsColumn && stats"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono text-sm">{{ statsColumn }}</span>
          <Button variant="ghost" size="sm" @click="statsColumn = null"> Hide stats </Button>
        </div>
        <dl class="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div class="rounded-[8px] bg-card px-3 py-2">
            <dt class="text-xs text-muted-foreground">Values</dt>
            <dd class="font-mono text-sm tabular-nums">{{ stats.total.toLocaleString() }}</dd>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <dt class="text-xs text-muted-foreground">Null</dt>
            <dd class="font-mono text-sm tabular-nums">{{ stats.nulls.toLocaleString() }}</dd>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <dt class="text-xs text-muted-foreground">Distinct</dt>
            <dd class="font-mono text-sm tabular-nums">
              {{ stats.distinctCapped ? "at least " : "" }}{{ stats.distinct.toLocaleString() }}
            </dd>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <dt class="text-xs text-muted-foreground">Min</dt>
            <dd class="font-mono text-sm break-words">
              <span v-if="stats.min !== undefined">{{ stats.min }}</span>
              <span v-else class="text-muted-foreground italic">no order</span>
            </dd>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <dt class="text-xs text-muted-foreground">Max</dt>
            <dd class="font-mono text-sm break-words">
              <span v-if="stats.max !== undefined">{{ stats.max }}</span>
              <span v-else class="text-muted-foreground italic">no order</span>
            </dd>
          </div>
        </dl>
        <p class="text-xs text-muted-foreground">
          Sampled from the {{ count(loadedCount, "row", "rows") }} decoded here, not from the whole
          file. Load more rows to widen the sample. Min and max only appear for values that have a
          real order: numbers, dates and text.
        </p>
      </div>

      <!-- Data grid -->
      <div class="max-h-[34rem] overflow-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="text-left text-xs text-muted-foreground">
              <th
                scope="col"
                class="sticky top-0 z-10 bg-secondary px-3 py-2 font-medium whitespace-nowrap"
              >
                #
              </th>
              <th
                v-for="name in picked"
                :key="`head-${name}`"
                scope="col"
                class="sticky top-0 z-10 bg-secondary px-3 py-2 font-medium whitespace-nowrap"
              >
                <span class="inline-flex items-center gap-1">
                  <span class="font-mono text-foreground">{{ name }}</span>
                  <button
                    type="button"
                    class="grid size-5 place-items-center rounded-[8px] outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
                    :class="statsColumn === name ? 'text-primary' : 'text-muted-foreground'"
                    :aria-pressed="statsColumn === name"
                    :title="`Stats for ${name}`"
                    @click="toggleStats(name)"
                  >
                    <Sigma class="size-3" />
                  </button>
                </span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60" @click="onCellClick">
            <tr
              v-for="(row, i) in pageCells"
              :key="`row-${pageStart + i}`"
              class="align-top hover:bg-card/70"
            >
              <td class="px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                {{ (pageStart + i + 1).toLocaleString() }}
              </td>
              <td
                v-for="(cell, j) in row"
                :key="j"
                :data-r="i"
                :data-c="j"
                class="max-w-[28rem] cursor-pointer px-3 py-1.5 font-mono text-xs break-words"
                :class="[
                  cell === 'NULL' ? 'text-muted-foreground italic' : '',
                  copiedKey === `${i}:${j}` ? 'text-[var(--positive)]' : '',
                ]"
              >
                {{ cell }}
              </td>
            </tr>
            <tr v-if="pageCells.length === 0">
              <td
                :colspan="picked.length + 1"
                class="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                {{ totalRows === 0 ? "This file has no rows." : "No rows on this page." }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
