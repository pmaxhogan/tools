<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  X,
} from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { copyText } from "@/lib/clipboard";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";

/**
 * Bespoke panel for the XLSX viewer.
 *
 * A workbook is several sheets, and the generic ToolShell renders one block of
 * text, so it cannot express tabs, a sortable grid, or per sheet exports. This
 * panel draws those; every decision about what a cell says stays in the logic
 * layer (rule 27), including the unzip, the XML parse, the number formats, the
 * sort comparison, the search match, and all three exporters. The module is
 * imported lazily so the reader never lands in another page's bundle.
 *
 * Sorting and filtering are views over the loaded rows, never edits: the
 * spreadsheet row number travels with each row so a sorted grid still tells you
 * where a value lives in the file.
 */
defineProps<{ meta: ToolMeta }>();

type XlsxLogic = typeof import("@/tools/xlsx-viewer/index");
type Workbook = import("@/tools/xlsx-viewer/index").Workbook;
type WorkbookSheet = import("@/tools/xlsx-viewer/index").WorkbookSheet;

/** Rows loaded per sheet. The reader stops here and reports the real count. */
const MAX_ROWS = 5000;
/** Characters kept per cell in the grid. Copying still yields the full value. */
const CELL_CAP = 200;
const PAGE_SIZES = [50, 100, 500];
const PAGE_SIZE_OPTIONS: SegmentedOption[] = PAGE_SIZES.map((n) => ({
  value: String(n),
  label: String(n),
}));

let logicPromise: Promise<XlsxLogic> | null = null;
function loadLogic(): Promise<XlsxLogic> {
  logicPromise ??= import("@/tools/xlsx-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<XlsxLogic | null>(null);
const workbook = shallowRef<Workbook | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const sheetIndex = ref(0);
const search = ref("");
const useHeader = ref(true);
const sortColumn = ref<number | null>(null);
const sortDescending = ref(false);
const page = ref(0);
const pageSize = ref(100);

const error = ref<{ message: string; fix?: string } | null>(null);
const busy = ref(false);
const copiedKey = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

/** Guards against an older read landing after a newer one. */
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
  return stem || "sheet";
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/* ---------------------------------------------------------------- */
/* reading                                                           */
/* ---------------------------------------------------------------- */

function reset() {
  workbook.value = null;
  sheetIndex.value = 0;
  search.value = "";
  sortColumn.value = null;
  sortDescending.value = false;
  page.value = 0;
  copiedKey.value = null;
}

async function openFile(file: File) {
  const seq = ++readSeq;
  busy.value = true;
  error.value = null;

  try {
    const mod = await loadLogic();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = mod.readWorkbook(bytes, { maxRows: MAX_ROWS });
    if (seq !== readSeq) return;

    reset();
    logic.value = mod;
    workbook.value = parsed;
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

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
function onFiles(files: File[]) {
  const file = files[0];
  if (file) void openFile(file);
}

function clearFile() {
  readSeq += 1;
  reset();
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  busy.value = false;
}

/* ---------------------------------------------------------------- */
/* the active sheet                                                  */
/* ---------------------------------------------------------------- */

const sheets = computed<WorkbookSheet[]>(() => workbook.value?.sheets ?? []);

const sheet = computed<WorkbookSheet | null>(() => sheets.value[sheetIndex.value] ?? null);

const sheetOptions = computed<SegmentedOption[]>(() =>
  sheets.value.map((s, i) => ({
    value: String(i),
    label: s.state === "visible" ? s.name : `${s.name} (hidden)`,
  })),
);

/** Column letters for the active sheet, computed once per sheet. */
const columns = computed<string[]>(() => {
  const mod = logic.value;
  const active = sheet.value;
  if (!mod || !active) return [];
  return Array.from({ length: active.colCount }, (_, i) => mod.columnLetter(i));
});

/** The header row's text, when the first row is being read as column names. */
const headerCells = computed<string[]>(() => {
  const active = sheet.value;
  if (!useHeader.value || !active || active.rows.length === 0) return [];
  return active.rows[0] ?? [];
});

/**
 * The rows the grid works on, with the spreadsheet row number attached before
 * sorting so it survives it. The header row is held out when it is being used
 * as column names, so it never sorts into the middle of the data.
 */
const bodyRows = computed<{ n: number; cells: string[] }[]>(() => {
  const active = sheet.value;
  if (!active) return [];
  const offset = useHeader.value && active.rows.length > 0 ? 1 : 0;
  return active.rows.slice(offset).map((cells, i) => ({ n: i + offset + 1, cells }));
});

const filteredRows = computed(() => {
  const mod = logic.value;
  const query = search.value.trim();
  if (!mod || !query) return bodyRows.value;
  const kept = mod.filterRows(
    bodyRows.value.map((row) => row.cells),
    query,
  );
  const keptSet = new Set(kept);
  return bodyRows.value.filter((row) => keptSet.has(row.cells));
});

const sortedRows = computed(() => {
  const mod = logic.value;
  const column = sortColumn.value;
  if (!mod || column === null) return filteredRows.value;

  // Sort the cell arrays, then map each back to the row that owns it, so the
  // spreadsheet row numbers follow their values into the new order.
  const owner = new Map<string[], { n: number; cells: string[] }>();
  for (const row of filteredRows.value) owner.set(row.cells, row);
  return mod
    .sortRows(
      filteredRows.value.map((row) => row.cells),
      column,
      sortDescending.value,
    )
    .map((cells) => owner.get(cells) as { n: number; cells: string[] });
});

/* ---------------------------------------------------------------- */
/* paging                                                            */
/* ---------------------------------------------------------------- */

const rowTotal = computed(() => sortedRows.value.length);
const pageCount = computed(() => Math.max(1, Math.ceil(rowTotal.value / pageSize.value)));
const pageStart = computed(() => page.value * pageSize.value);
const pageRows = computed(() =>
  sortedRows.value.slice(pageStart.value, pageStart.value + pageSize.value),
);

const canPrev = computed(() => page.value > 0);
const canNext = computed(() => pageStart.value + pageSize.value < rowTotal.value);

function prevPage() {
  if (canPrev.value) page.value -= 1;
}

function nextPage() {
  if (canNext.value) page.value += 1;
}

/** Keep the first visible row roughly in place when the page size changes. */
function setPageSize(size: number) {
  const first = pageStart.value;
  pageSize.value = size;
  page.value = Math.floor(first / size);
}

// Switching sheets, searching, or re-sorting invalidates the current page.
watch([sheetIndex, search, sortColumn, sortDescending, useHeader], () => {
  page.value = 0;
});

/* ---------------------------------------------------------------- */
/* sorting and cells                                                 */
/* ---------------------------------------------------------------- */

/** Ascending, then descending, then back to the file's own order. */
function toggleSort(column: number) {
  if (sortColumn.value !== column) {
    sortColumn.value = column;
    sortDescending.value = false;
  } else if (!sortDescending.value) {
    sortDescending.value = true;
  } else {
    sortColumn.value = null;
    sortDescending.value = false;
  }
}

function headerLabel(index: number): string {
  const text = headerCells.value[index] ?? "";
  return text.trim() || (columns.value[index] ?? "");
}

function cellText(value: string): string {
  const flat = value.replace(/\r\n|\r|\n|\t/g, " ");
  return flat.length > CELL_CAP ? `${flat.slice(0, CELL_CAP)}…` : flat;
}

/**
 * Copying is delegated from the body: a 500 row page can hold thousands of
 * cells, and one listener is cheaper than one per cell. The clipboard gets the
 * full value, not the truncated text the grid shows.
 */
async function onCellClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  const cell = target?.closest?.("td[data-r]") as HTMLElement | null;
  if (!cell) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const row = pageRows.value[r];
  if (!row) return;

  // A table cell cannot become a CopyButton without rebuilding the table, so
  // it goes through the shared clipboard helper instead.
  if (!(await copyText(row.cells[c] ?? ""))) return;
  copiedKey.value = `${r}:${c}`;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedKey.value = null), 1200);
}

/* ---------------------------------------------------------------- */
/* export                                                            */
/* ---------------------------------------------------------------- */

/** What the exports cover: the rows currently visible, in the order shown. */
function exportGrid(): string[][] {
  const rows = sortedRows.value.map((row) => row.cells);
  return useHeader.value && headerCells.value.length > 0 ? [headerCells.value, ...rows] : rows;
}

function exportName(extension: string): string {
  const active = sheet.value;
  const suffix = active && sheets.value.length > 1 ? `-${active.name}` : "";
  return `${baseName(fileName.value)}${suffix}.${extension}`.replace(/[\\/:*?"<>|]/g, "_");
}

function exportCsv() {
  const mod = logic.value;
  if (!mod) return;
  downloadBlob(new Blob([mod.toCsv(exportGrid())], { type: "text/csv" }), exportName("csv"));
}

function exportJson() {
  const mod = logic.value;
  if (!mod) return;
  const json = mod.toJson(exportGrid(), useHeader.value);
  downloadBlob(new Blob([json], { type: "application/json" }), exportName("json"));
}

function markdownText(): string {
  const mod = logic.value;
  return mod ? mod.toMarkdown(exportGrid(), useHeader.value) : "";
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      accept=".xlsx,.xlsm,.csv,.tsv,text/csv"
      label="Drop an .xlsx, .xlsm or .csv file here or click to choose"
      hint="The reader is JavaScript running in this tab: your files and inputs never leave your device. Files up to 100 MB are accepted, and the first 5,000 rows of each sheet load into the grid."
      @files="onFiles"
    >
      <template v-if="workbook" #default>
        <div class="flex justify-center">
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
      </template>
    </FileDrop>

    <p v-if="busy" class="text-xs text-muted-foreground">Reading the workbook…</p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="workbook && sheet">
      <!-- File header -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="truncate font-mono text-sm">{{ fileName }}</div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">File size</div>
            <div class="font-mono text-lg tabular-nums">{{ formatBytes(fileSize) }}</div>
            <div class="text-xs text-muted-foreground">{{ workbook.format.toUpperCase() }}</div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Sheets</div>
            <div class="font-mono text-lg tabular-nums">{{ sheets.length }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ sheet.name }}</div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Rows</div>
            <div class="font-mono text-lg tabular-nums">
              {{ sheet.rowCount.toLocaleString() }}
            </div>
            <div class="text-xs text-muted-foreground tabular-nums">
              {{ sheet.rows.length.toLocaleString() }} loaded here
            </div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Columns</div>
            <div class="font-mono text-lg tabular-nums">{{ sheet.colCount }}</div>
            <div v-if="sheet.merges.length > 0" class="text-xs text-muted-foreground">
              {{ count(sheet.merges.length, "merged range", "merged ranges") }}
            </div>
          </div>
        </div>

        <p v-if="workbook.date1904" class="text-xs text-muted-foreground">
          This workbook counts days from January 1st 1904, the old Mac date system, and dates are
          converted accordingly.
        </p>
        <p v-if="sheet.merges.length > 0" class="font-mono text-xs text-muted-foreground">
          Merged:
          {{
            sheet.merges
              .slice(0, 8)
              .map((m) => m.ref)
              .join(", ")
          }}<span v-if="sheet.merges.length > 8"> and {{ sheet.merges.length - 8 }} more</span>
        </p>
      </div>

      <!-- Sheet tabs -->
      <div v-if="sheets.length > 1" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted-foreground">Sheet</span>
        <Segmented
          :model-value="String(sheetIndex)"
          :options="sheetOptions"
          label="Sheet"
          size="sm"
          @update:model-value="(v: string) => (sheetIndex = Number(v))"
        />
      </div>

      <!-- Toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="relative">
            <Search
              class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              v-model="search"
              type="search"
              placeholder="Search this sheet"
              aria-label="Search this sheet"
              class="h-8 w-56 pl-8 text-sm"
            />
          </div>
          <div class="flex items-center gap-2">
            <Checkbox
              id="xlsx-header"
              :model-value="useHeader"
              @update:model-value="(v) => (useHeader = Boolean(v))"
            />
            <Label for="xlsx-header" class="text-xs">First row is a header</Label>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-muted-foreground">Rows per page</span>
            <Segmented
              :model-value="String(pageSize)"
              :options="PAGE_SIZE_OPTIONS"
              label="Rows per page"
              size="sm"
              @update:model-value="(v: string) => setPageSize(Number(v))"
            />
          </div>
          <Button variant="outline" size="sm" :disabled="rowTotal === 0" @click="exportCsv">
            <Download class="size-3.5" />
            CSV
          </Button>
          <Button variant="outline" size="sm" :disabled="rowTotal === 0" @click="exportJson">
            <Download class="size-3.5" />
            JSON
          </Button>
          <CopyButton
            variant="outline"
            :disabled="rowTotal === 0"
            :get-text="markdownText"
            label="Copy as Markdown"
            toast-title="Markdown table copied"
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm tabular-nums">
            <template v-if="rowTotal === 0">No rows to show.</template>
            <template v-else>
              Rows {{ (pageStart + 1).toLocaleString() }} to
              {{ (pageStart + pageRows.length).toLocaleString() }} of
              {{ count(rowTotal, "row", "rows") }}
            </template>
          </div>
          <div class="text-xs text-muted-foreground tabular-nums">
            Page {{ page + 1 }} of {{ pageCount }}
            <span v-if="search.trim()"> after the search filter</span>
          </div>
        </div>

        <div class="flex items-center gap-2">
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
        </div>
      </div>

      <!-- Data grid -->
      <div
        v-if="sheet.rows.length > 0"
        class="max-h-[34rem] overflow-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      >
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
                v-for="(letter, i) in columns"
                :key="`head-${letter}`"
                scope="col"
                :aria-sort="sortColumn !== i ? 'none' : sortDescending ? 'descending' : 'ascending'"
                class="sticky top-0 z-10 bg-secondary px-3 py-2 font-medium whitespace-nowrap"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-[8px] px-1 py-0.5 outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
                  :title="`Sort by column ${letter}`"
                  @click="toggleSort(i)"
                >
                  <span class="font-mono text-muted-foreground">{{ letter }}</span>
                  <span v-if="useHeader" class="max-w-[14rem] truncate text-foreground">
                    {{ headerLabel(i) }}
                  </span>
                  <ArrowUp v-if="sortColumn === i && !sortDescending" class="size-3" />
                  <ArrowDown v-else-if="sortColumn === i" class="size-3" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60" @click="onCellClick">
            <tr
              v-for="(row, i) in pageRows"
              :key="`row-${row.n}`"
              class="align-top hover:bg-card/70"
            >
              <td class="px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                {{ row.n.toLocaleString() }}
              </td>
              <td
                v-for="(letter, j) in columns"
                :key="`cell-${row.n}-${letter}`"
                :data-r="i"
                :data-c="j"
                class="max-w-[28rem] cursor-pointer px-3 py-1.5 font-mono text-xs break-words"
                :class="copiedKey === `${i}:${j}` ? 'text-[var(--positive)]' : ''"
              >
                {{ cellText(row.cells[j] ?? "") }}
              </td>
            </tr>
            <tr v-if="pageRows.length === 0">
              <td
                :colspan="columns.length + 1"
                class="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                {{
                  search.trim()
                    ? "No rows on this sheet contain that text."
                    : "No rows on this page."
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else
        title="This sheet has no cells."
        :hint="`${sheet.name} is empty, or it is a chart sheet rather than a grid. Pick another sheet from the tabs above.`"
        icon="Table2"
      />

      <p class="text-xs text-muted-foreground">
        Click a cell to copy its full value. Click a column heading to sort by it, again to reverse
        it, and once more to return to the file's own order. The CSV, JSON and Markdown exports
        cover every row that passes the search filter, in the order shown, not just this page.
      </p>
      <p v-if="sheet.truncated" class="text-xs text-muted-foreground">
        This sheet holds {{ count(sheet.rowCount, "row", "rows") }} and the first
        {{ MAX_ROWS.toLocaleString() }} are loaded here. For the whole thing, a spreadsheet app or a
        script on your own machine is the right tool.
      </p>
    </template>
  </div>
</template>
