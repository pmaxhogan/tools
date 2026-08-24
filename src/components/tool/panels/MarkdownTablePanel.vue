<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronLeft,
  ChevronRight,
  Download,
  GripVertical,
  Minus,
  Plus,
  X,
} from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  addColumn,
  addRow,
  formatMarkdownTable,
  moveColumn,
  parseTableDetailed,
  removeColumn,
  removeRow,
  setAlign,
  setCell,
  tableWidth,
  toAsciiTable,
  toCsv,
  toHtml,
  toJson,
  toLatex,
  toTsv,
  transpose,
  type Align,
  type ParseResult,
  type Table,
  type TableFormat,
} from "@/tools/markdown-table-editor/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Markdown Table Editor.
 *
 * The generic ToolShell gives this tool one text box, which means editing a
 * table by hand-counting pipes. This island puts a real grid on screen: cells
 * are inputs, columns carry their own alignment and reorder by drag or by
 * button, and the Markdown comes out live beside it.
 *
 * The logic layer stays pure (PROJECT.md rule 27). Every parse, every edit and
 * every string in the output pane comes from src/tools/markdown-table-editor:
 * parseTableDetailed reads a paste, addRow, removeRow, addColumn,
 * removeColumn, moveColumn, setCell, setAlign and transpose make the edits,
 * and formatMarkdownTable plus the exporters render them. This file owns only
 * the DOM: state, pointer drags, the URL fragment, and saving a file.
 *
 * Nothing here reads window or the document before onMounted, so the server
 * rendered shell is inert.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/**
 * Mirrors MAX_FRAGMENT_INPUT in src/lib/fragment.ts, which silently drops a
 * longer input rather than writing a link nothing can open. It is not
 * exported, so the number is repeated here only to explain the note the panel
 * shows when a table stops fitting in a link.
 */
const FRAGMENT_INPUT_MAX = 2000;

const BLANK_COLUMNS = 3;
const BLANK_ROWS = 3;

const SAMPLE = [
  "| Field | Type | Required |",
  "| :--- | :--- | :-: |",
  "| id | string | yes |",
  "| email | string | yes |",
  "| nickname | string | no |",
].join("\n");

const FORMAT_LABELS: Record<TableFormat, string> = {
  markdown: "a Markdown table",
  tsv: "tab separated text from a spreadsheet",
  csv: "CSV text",
  html: "an HTML table",
  whitespace: "columns separated by runs of spaces",
};

const ALIGN_CHOICES: ReadonlyArray<{ value: Align; label: string; icon: Component }> = [
  { value: "none", label: "No alignment", icon: Minus },
  { value: "left", label: "Align left", icon: AlignLeft },
  { value: "center", label: "Align center", icon: AlignCenter },
  { value: "right", label: "Align right", icon: AlignRight },
];

const ALIGN_CLASS: Record<Align, string> = {
  none: "text-left",
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

interface OutputShape {
  extension: string;
  mime: string;
}

const MARKDOWN_SHAPE: OutputShape = { extension: "md", mime: "text/markdown" };

const OUTPUT_SHAPES: Record<string, OutputShape> = {
  markdown: MARKDOWN_SHAPE,
  csv: { extension: "csv", mime: "text/csv" },
  tsv: { extension: "tsv", mime: "text/tab-separated-values" },
  html: { extension: "html", mime: "text/html" },
  json: { extension: "json", mime: "application/json" },
  ascii: { extension: "txt", mime: "text/plain" },
  latex: { extension: "tex", mime: "text/plain" },
};

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

/**
 * The logic layer has no blank-table constructor, and its parser refuses
 * anything under two columns, so the starting grid is written out here as
 * plain data. Every change to it after this point goes through the logic.
 */
function blankTable(): Table {
  return {
    header: Array.from({ length: BLANK_COLUMNS }, () => ""),
    align: Array.from({ length: BLANK_COLUMNS }, (): Align => "none"),
    rows: Array.from({ length: BLANK_ROWS }, () => Array.from({ length: BLANK_COLUMNS }, () => "")),
  };
}

const table = ref<Table>(blankTable());
const importText = ref("");
const outputFormat = ref("markdown");
const compact = ref(false);

const error = ref<{ message: string; fix?: string } | null>(null);
const notice = ref<string | null>(null);
const warnings = ref<string[]>([]);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);

/** The tool's own output select, reused so the choices match the curl API. */
const outputSpec = computed<SelectOptionSpec | undefined>(() => {
  const spec = props.meta.options?.find((option) => option.id === "output");
  return spec?.kind === "select" ? spec : undefined;
});

const shape = computed<OutputShape>(() => OUTPUT_SHAPES[outputFormat.value] ?? MARKDOWN_SHAPE);
const isMarkdown = computed(() => outputFormat.value === "markdown");

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

function describeError(e: unknown): { message: string; fix?: string } {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

/**
 * Every grid edit runs through here, so one bad index cannot break the page.
 * An edit also retires the message from the last import: its row and column
 * counts, and any note about cells that were filled in, describe a table that
 * no longer exists.
 */
function mutate(change: (source: Table) => Table): void {
  try {
    table.value = change(table.value);
    error.value = null;
    notice.value = null;
    warnings.value = [];
  } catch (e) {
    error.value = describeError(e);
  }
}

/* ------------------------------------------------------------------ *
 * reading a table in
 * ------------------------------------------------------------------ */

function applyParsed(result: ParseResult): void {
  const columns = result.table.header.length;
  const rows = result.table.rows.length;
  table.value = result.table;
  warnings.value = result.warnings;
  error.value = null;
  notice.value =
    `Read ${columns} columns and ${rows} ${rows === 1 ? "row" : "rows"} ` +
    `as ${FORMAT_LABELS[result.format]}.`;
}

function loadText(text: string): boolean {
  try {
    applyParsed(parseTableDetailed(text));
    return true;
  } catch (e) {
    error.value = describeError(e);
    notice.value = null;
    warnings.value = [];
    return false;
  }
}

function importIntoGrid(): void {
  if (loadText(importText.value)) importText.value = "";
}

function loadSample(): void {
  importText.value = "";
  loadText(SAMPLE);
}

function clearGrid(): void {
  table.value = blankTable();
  importText.value = "";
  warnings.value = [];
  notice.value = null;
  error.value = null;
}

/** Anything with a tab or a line break is more than one cell. */
const MULTI_CELL = /[\t\n]/;

/**
 * A spreadsheet paste lands in whichever cell has focus, which is never what
 * the person meant. When the clipboard holds something that parses as a table,
 * it fills the whole grid instead; when it does not, the browser pastes it
 * into the one cell as usual.
 */
function onCellPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData("text") ?? "";
  if (!MULTI_CELL.test(text)) return;
  let result: ParseResult;
  try {
    result = parseTableDetailed(text);
  } catch {
    return;
  }
  event.preventDefault();
  applyParsed(result);
}

/* ------------------------------------------------------------------ *
 * grid edits
 * ------------------------------------------------------------------ */

/** Row -1 is the header row, which is what setCell expects. */
function onCellInput(row: number, col: number, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  mutate((source) => setCell(source, row, col, value));
}

function addRowAt(): void {
  mutate((source) => addRow(source));
}

function removeRowAt(index: number): void {
  mutate((source) => removeRow(source, index));
}

function addColumnAt(): void {
  mutate((source) => addColumn(source));
}

function removeColumnAt(index: number): void {
  mutate((source) => removeColumn(source, index));
}

function shiftColumn(from: number, to: number): void {
  if (to < 0 || to >= table.value.header.length) return;
  mutate((source) => moveColumn(source, from, to));
}

function setColumnAlign(index: number, align: Align): void {
  mutate((source) => setAlign(source, index, align));
}

function flip(): void {
  mutate((source) => transpose(source));
}

function alignOf(col: number): Align {
  return table.value.align[col] ?? "none";
}

/* ------------------------------------------------------------------ *
 * column drag
 *
 * Pointer events only, so a mouse, a pen and a finger all work the same way.
 * The grip is out of the tab order because dragging has no keyboard meaning;
 * the move left and move right buttons beside it are the keyboard path, and
 * they call the same moveColumn.
 * ------------------------------------------------------------------ */

const gridEl = ref<HTMLElement | null>(null);
const dragFrom = ref<number | null>(null);
const dragTo = ref<number | null>(null);

/**
 * Header centers are measured once, at the moment the drag starts. Reading
 * them per move would fight the highlight that the move itself paints.
 */
let columnCenters: number[] = [];

function onDragStart(event: PointerEvent, index: number): void {
  const host = gridEl.value;
  if (!host) return;
  columnCenters = Array.from(host.querySelectorAll<HTMLElement>("th[data-col]")).map((cell) => {
    const box = cell.getBoundingClientRect();
    return box.left + box.width / 2;
  });
  dragFrom.value = index;
  dragTo.value = index;
  const handle = event.currentTarget as HTMLElement | null;
  handle?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onDragMove(event: PointerEvent): void {
  if (dragFrom.value === null || columnCenters.length === 0) return;
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  columnCenters.forEach((center, index) => {
    const distance = Math.abs(center - event.clientX);
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  });
  dragTo.value = nearest;
}

function onDragEnd(): void {
  const from = dragFrom.value;
  const to = dragTo.value;
  cancelDrag();
  if (from !== null && to !== null && from !== to) {
    mutate((source) => moveColumn(source, from, to));
  }
}

/** A canceled or interrupted drag must not leave a stale highlight behind. */
function cancelDrag(): void {
  dragFrom.value = null;
  dragTo.value = null;
  columnCenters = [];
}

function columnClass(index: number): string {
  if (dragFrom.value === null) return "";
  if (dragTo.value === index) return "ring-2 ring-ring";
  if (dragFrom.value === index) return "opacity-60";
  return "";
}

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */

function render(source: Table): string {
  switch (outputFormat.value) {
    case "csv":
      return toCsv(source);
    case "tsv":
      return toTsv(source);
    case "html":
      return toHtml(source);
    case "json":
      return toJson(source);
    case "ascii":
      return toAsciiTable(source);
    case "latex":
      return toLatex(source);
    default:
      return formatMarkdownTable(source, { compact: compact.value, pad: !compact.value });
  }
}

const output = computed(() => render(table.value));

function save(): void {
  downloadText(output.value, `table.${shape.value.extension}`, shape.value.mime);
}

/* ------------------------------------------------------------------ *
 * fragment state
 * ------------------------------------------------------------------ */

/** A table under two columns cannot be parsed back out of a link. */
const shareable = computed(() => tableWidth(table.value) >= 2);

/**
 * The link carries the table as unpadded Markdown: it keeps the alignment
 * colons and every empty cell (each one is written as a space, so the parser
 * still counts it), while spending none of the link budget on padding.
 */
const shareSource = computed(() =>
  shareable.value ? formatMarkdownTable(table.value, { pad: false }) : "",
);

const tooLongForLink = computed(() => shareSource.value.length > FRAGMENT_INPUT_MAX);

function persist(): void {
  if (!mounted.value) return;
  writeFragment({
    // writeFragment drops an input past its own size cap, which is the
    // behavior wanted here: the settings still travel, the table stops.
    input: shareSource.value || undefined,
    opts: { output: outputFormat.value, compact: String(compact.value) },
  });
}

let debounceHandle: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(): void {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(persist, 200);
}

watch([table, outputFormat, compact], schedulePersist);

onMounted(() => {
  const frag = readFragment();
  const rawOutput = frag.opts.output;
  if (rawOutput !== undefined && rawOutput in OUTPUT_SHAPES) outputFormat.value = rawOutput;
  const rawCompact = frag.opts.compact;
  if (rawCompact !== undefined) compact.value = rawCompact === "true";
  if (frag.input) loadText(frag.input);
  mounted.value = true;
});

// View transitions keep the page alive across navigation, so a debounce left
// running would write this table into the next page's address bar.
onUnmounted(() => clearTimeout(debounceHandle));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Grid -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Table
        </span>
        <div class="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" @click="loadSample">Load sample</Button>
          <Button variant="ghost" size="sm" @click="flip">Transpose</Button>
          <Button variant="ghost" size="sm" @click="clearGrid">Clear</Button>
        </div>
      </div>

      <div
        ref="gridEl"
        class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
      >
        <table class="w-full border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th scope="col" class="w-14">
                <span class="sr-only">Row</span>
              </th>
              <th
                v-for="(cell, c) in table.header"
                :key="c"
                :data-col="c"
                scope="col"
                class="min-w-52 p-0 align-top"
              >
                <div class="flex flex-col gap-1 rounded-[8px] p-1" :class="columnClass(c)">
                  <div class="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="cursor-grab touch-none"
                      tabindex="-1"
                      :aria-label="`Drag to reorder column ${c + 1}`"
                      @pointerdown="onDragStart($event, c)"
                      @pointermove="onDragMove"
                      @pointerup="onDragEnd"
                      @pointercancel="cancelDrag"
                      @lostpointercapture="cancelDrag"
                    >
                      <GripVertical class="size-3" aria-hidden="true" />
                    </Button>

                    <input
                      :value="cell"
                      type="text"
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                      :placeholder="`Column ${c + 1}`"
                      :aria-label="`Heading for column ${c + 1}`"
                      class="min-w-0 flex-1 rounded-[8px] bg-card px-2 py-1.5 font-medium placeholder:font-normal placeholder:text-muted-foreground"
                      :class="ALIGN_CLASS[alignOf(c)]"
                      @input="onCellInput(-1, c, $event)"
                      @paste="onCellPaste"
                    />

                    <Button
                      variant="ghost"
                      size="icon-xs"
                      :disabled="table.header.length <= 1"
                      :aria-label="`Remove column ${c + 1}`"
                      @click="removeColumnAt(c)"
                    >
                      <X class="size-3" aria-hidden="true" />
                    </Button>
                  </div>

                  <div class="flex items-center justify-between gap-1">
                    <div class="inline-flex gap-1 rounded-[8px] bg-background/70 p-0.5">
                      <Button
                        v-for="choice in ALIGN_CHOICES"
                        :key="choice.value"
                        variant="ghost"
                        size="icon-xs"
                        :aria-pressed="alignOf(c) === choice.value"
                        :aria-label="`${choice.label} for column ${c + 1}`"
                        :class="alignOf(c) === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
                        @click="setColumnAlign(c, choice.value)"
                      >
                        <component :is="choice.icon" class="size-3" aria-hidden="true" />
                      </Button>
                    </div>

                    <div class="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        :disabled="c === 0"
                        :aria-label="`Move column ${c + 1} left`"
                        @click="shiftColumn(c, c - 1)"
                      >
                        <ChevronLeft class="size-3" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        :disabled="c === table.header.length - 1"
                        :aria-label="`Move column ${c + 1} right`"
                        @click="shiftColumn(c, c + 1)"
                      >
                        <ChevronRight class="size-3" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              </th>
              <th scope="col" class="w-10 align-top">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add column"
                  @click="addColumnAt()"
                >
                  <Plus class="size-3.5" aria-hidden="true" />
                </Button>
              </th>
            </tr>
          </thead>

          <tbody>
            <tr v-for="(row, r) in table.rows" :key="r">
              <th scope="row" class="p-0">
                <div class="flex items-center justify-end gap-1 pr-1">
                  <span class="font-mono text-xs font-normal text-muted-foreground tabular-nums">
                    {{ r + 1 }}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    :aria-label="`Remove row ${r + 1}`"
                    @click="removeRowAt(r)"
                  >
                    <X class="size-3" aria-hidden="true" />
                  </Button>
                </div>
              </th>
              <td v-for="(cell, c) in row" :key="c" class="p-0">
                <input
                  :value="cell"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  :aria-label="`Row ${r + 1}, column ${c + 1}`"
                  class="w-full rounded-[8px] bg-card px-2 py-1.5"
                  :class="[ALIGN_CLASS[alignOf(c)], columnClass(c)]"
                  @input="onCellInput(r, c, $event)"
                  @paste="onCellPaste"
                />
              </td>
              <td class="w-10"></td>
            </tr>

            <tr v-if="table.rows.length === 0">
              <td
                :colspan="table.header.length + 2"
                class="px-2 py-4 text-center text-sm text-muted-foreground"
              >
                No rows yet. Add one below, or paste a table into the box under the grid.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" @click="addRowAt()">
          <Plus class="size-3.5" aria-hidden="true" />
          Add row
        </Button>
        <Button variant="outline" size="sm" @click="addColumnAt()">
          <Plus class="size-3.5" aria-hidden="true" />
          Add column
        </Button>
        <p class="text-xs text-muted-foreground tabular-nums">
          {{ table.header.length }} columns, {{ table.rows.length }} rows
        </p>
      </div>
    </div>

    <!-- Messages -->
    <div
      v-if="error"
      role="alert"
      class="rounded-[10px] border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>
    <div
      v-else-if="notice || warnings.length"
      role="status"
      aria-live="polite"
      class="rounded-[10px] bg-secondary/60 px-3 py-2 text-sm text-muted-foreground"
    >
      <p v-if="notice">{{ notice }}</p>
      <p v-for="warning in warnings" :key="warning" class="mt-1">{{ warning }}</p>
    </div>

    <!-- Paste a table in -->
    <div class="flex flex-col gap-2">
      <Label
        for="md-table-import"
        class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
      >
        Paste a table
      </Label>
      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <Textarea
          id="md-table-import"
          v-model="importText"
          placeholder="Paste rows copied from Excel or Google Sheets, CSV text, an HTML table, or a Markdown table you already have."
          class="max-h-48 min-h-20 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="importText.trim() === ''"
          @click="importIntoGrid"
        >
          Load into grid
        </Button>
        <p class="text-xs text-muted-foreground">
          Pasting more than one cell into any cell of the grid fills the whole table too.
        </p>
      </div>
    </div>

    <!-- Output -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="flex min-w-52 flex-col gap-1.5">
          <Label for="md-table-output" class="text-xs text-muted-foreground">Output format</Label>
          <SearchableSelect
            v-if="outputSpec"
            id="md-table-output"
            :spec="outputSpec"
            :model-value="outputFormat"
            @update:model-value="(value) => (outputFormat = value)"
          />
        </div>

        <div v-if="isMarkdown" class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Spacing</span>
          <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="!compact"
              :class="!compact ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="compact = false"
            >
              Padded
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="compact"
              :class="compact ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="compact = true"
            >
              Compact
            </Button>
          </div>
        </div>
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Output
          </span>
          <div class="flex items-center gap-1">
            <CopyButton :text="output" label="Copy" />
            <Button variant="ghost" size="sm" @click="save">
              <Download class="size-3.5" aria-hidden="true" />
              Download .{{ shape.extension }}
            </Button>
          </div>
        </div>
        <pre class="max-h-96 overflow-auto px-3 py-2 font-mono text-sm whitespace-pre">{{
          output
        }}</pre>
      </div>

      <p v-if="!shareable" class="text-xs text-muted-foreground">
        A shared link needs a table with two or more columns, so the address bar keeps the output
        settings only.
      </p>
      <p v-else-if="tooLongForLink" class="text-xs text-muted-foreground">
        This table is too long to fit in a shareable link, so the address bar keeps the output
        settings only.
      </p>
    </div>
  </div>
</template>
