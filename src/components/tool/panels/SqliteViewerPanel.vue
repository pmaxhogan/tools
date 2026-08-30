<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { ChevronLeft, ChevronRight, Download, Play, X } from "lucide-vue-next";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";

/**
 * Bespoke panel for the SQLite browser. The generic ToolShell has no vocabulary
 * for any of this: a schema sidebar, a paged grid, a query box with results per
 * statement, and two downloads. It also owns the engine, because SQLite here is
 * a WebAssembly build that only exists in the browser.
 *
 * Everything that is not engine wiring lives in the logic layer: identifier
 * quoting, cell formatting, schema reading, CSV writing and the file header
 * check are all imported from `@/tools/sqlite-viewer/index`, so no rule is
 * reimplemented here (rule 27). The wasm binary is imported through Vite so it
 * is served from this origin, never from a CDN.
 */
defineProps<{ meta: ToolMeta }>();

type SqliteLogic = typeof import("@/tools/sqlite-viewer/index");
type Introspection = import("@/tools/sqlite-viewer/index").Introspection;
type SqlExecResult = import("@/tools/sqlite-viewer/index").SqlExecResult;
type SqlDatabase = import("sql.js").Database;

const PAGE_SIZE = 100;
/** Characters kept per cell in the grid. Long text stays readable, not endless. */
const CELL_CAP = 300;

/** The wasm module is a few hundred kilobytes, so it loads once per tab. */
let sqlPromise: Promise<import("sql.js").SqlJsStatic> | null = null;
function loadSql(): Promise<import("sql.js").SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

let logicPromise: Promise<SqliteLogic> | null = null;
function loadLogic(): Promise<SqliteLogic> {
  logicPromise ??= import("@/tools/sqlite-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

interface Pane {
  key: string;
  title: string;
  columns: { name: string; type: string; pk: boolean }[];
  rows: string[][];
  result: SqlExecResult;
}

const logic = shallowRef<SqliteLogic | null>(null);
const db = shallowRef<SqlDatabase | null>(null);
const info = shallowRef<Introspection | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const pageSize = ref<string | null>(null);
const encoding = ref<string | null>(null);

const error = ref<{ message: string; fix?: string } | null>(null);
const busy = ref(false);
const dirty = ref(false);

const selected = ref("");
const selectedIsView = ref(false);
const page = ref(0);
const browse = shallowRef<SqlExecResult | null>(null);

const sqlText = ref("");
const sqlPanes = shallowRef<Pane[]>([]);
const sqlNote = ref("");
const sqlError = ref("");
let runSeq = 0;

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function rowLabel(count: number): string {
  if (count < 0) return "rows unknown";
  return `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "database";
}

/* ---------------------------------------------------------------- */
/* loading a file                                                    */
/* ---------------------------------------------------------------- */

function closeDatabase() {
  const open = db.value;
  db.value = null;
  if (open) {
    try {
      open.close();
    } catch {
      // A database that refuses to close is already gone; nothing to do.
    }
  }
}

function resetView() {
  info.value = null;
  browse.value = null;
  selected.value = "";
  selectedIsView.value = false;
  page.value = 0;
  sqlPanes.value = [];
  sqlNote.value = "";
  sqlError.value = "";
  dirty.value = false;
  pageSize.value = null;
  encoding.value = null;
}

/**
 * Turn a failure to open into a message that names what was actually in the
 * file, because "could not open" on its own tells nobody anything.
 */
function openFailure(mod: SqliteLogic, bytes: Uint8Array, cause: unknown): ToolError {
  const head = mod.describeHeader(bytes);
  if (!head.looksLikeSqlite) {
    return new ToolError(
      "not-a-database",
      `This file does not start like a SQLite database. Its first bytes are ${head.found}, and every SQLite file begins with "SQLite format 3".`,
      "Check that you picked the database itself and not a dump, an archive or a journal file. A database encrypted with SQLCipher also fails here, because the header is encrypted along with the rest and this tool cannot decrypt it.",
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ToolError(
    "sqlite-error",
    `The header is right but SQLite could not read this file: ${detail}.`,
    "The file may be truncated, still being written, or paired with a write ahead log that was not copied alongside it.",
  );
}

async function openBytes(bytes: Uint8Array, name: string, size: number) {
  busy.value = true;
  try {
    const [SQL, mod] = await Promise.all([loadSql(), loadLogic()]);
    logic.value = mod;

    closeDatabase();
    resetView();

    let opened: SqlDatabase | null = null;
    let schema: Introspection;
    try {
      opened = new SQL.Database(bytes);
      schema = mod.introspect(opened);
    } catch (e) {
      if (opened) {
        try {
          opened.close();
        } catch {
          // ignore
        }
      }
      throw openFailure(mod, bytes, e);
    }

    db.value = opened;
    info.value = schema;
    pageSize.value = mod.scalar(opened, "PRAGMA page_size");
    encoding.value = mod.scalar(opened, "PRAGMA encoding");
    fileName.value = name;
    fileSize.value = size;
    error.value = null;

    const first = schema.tables[0]?.name ?? schema.views[0] ?? "";
    if (first) selectObject(first, schema.tables.length === 0);
  } catch (e) {
    closeDatabase();
    resetView();
    fileName.value = "";
    fileSize.value = 0;
    error.value = toToolError(e);
  } finally {
    busy.value = false;
  }
}

async function readFile(file: File) {
  const buffer = await file.arrayBuffer();
  await openBytes(new Uint8Array(buffer), file.name, file.size);
}

function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}

function clearFile() {
  closeDatabase();
  resetView();
  fileName.value = "";
  fileSize.value = 0;
  sqlText.value = "";
  error.value = null;
}

/* ---------------------------------------------------------------- */
/* browsing a table                                                  */
/* ---------------------------------------------------------------- */

const tables = computed(() => info.value?.tables ?? []);
const views = computed(() => info.value?.views ?? []);

const selectedTable = computed(
  () => tables.value.find((table) => table.name === selected.value) ?? null,
);

const selectedRowCount = computed(() => selectedTable.value?.rowCount ?? -1);

function buildPane(
  result: SqlExecResult,
  key: string,
  title: string,
  columnMeta?: { name: string; type: string; pk: boolean }[],
): Pane {
  const mod = logic.value;
  const columns = result.columns.map((name) => {
    const meta = columnMeta?.find((c) => c.name === name);
    return { name, type: meta?.type ?? "", pk: meta?.pk ?? false };
  });
  const rows = result.values.map((row) =>
    result.columns.map((_, i) => (mod ? mod.formatCell(row[i], CELL_CAP) : String(row[i]))),
  );
  return { key, title, columns, rows, result };
}

function loadPage() {
  const mod = logic.value;
  const database = db.value;
  if (!mod || !database || !selected.value) return;
  try {
    const sql = `SELECT * FROM ${mod.safeIdent(selected.value)} LIMIT ${PAGE_SIZE} OFFSET ${page.value * PAGE_SIZE}`;
    const results = database.exec(sql);
    // A SELECT that matches nothing comes back as an empty array, so the
    // headers are rebuilt from the schema rather than left blank.
    browse.value = results[0] ?? {
      columns: selectedTable.value?.columns.map((c) => c.name) ?? [],
      values: [],
    };
    error.value = null;
  } catch (e) {
    browse.value = null;
    error.value = toToolError(e);
  }
}

function selectObject(name: string, isView: boolean) {
  selected.value = name;
  selectedIsView.value = isView;
  page.value = 0;
  loadPage();
}

const browsePane = computed<Pane | null>(() => {
  const result = browse.value;
  if (!result || result.columns.length === 0) return null;
  return buildPane(
    result,
    `browse-${selected.value}-${page.value}`,
    selected.value,
    selectedTable.value?.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })),
  );
});

const firstRowIndex = computed(() => page.value * PAGE_SIZE + 1);
const lastRowIndex = computed(() => page.value * PAGE_SIZE + (browse.value?.values.length ?? 0));

const canPrev = computed(() => page.value > 0);
const canNext = computed(() => {
  const shown = browse.value?.values.length ?? 0;
  if (shown < PAGE_SIZE) return false;
  const total = selectedRowCount.value;
  return total < 0 || lastRowIndex.value < total;
});

function prevPage() {
  if (!canPrev.value) return;
  page.value -= 1;
  loadPage();
}

function nextPage() {
  if (!canNext.value) return;
  page.value += 1;
  loadPage();
}

/* ---------------------------------------------------------------- */
/* running SQL                                                       */
/* ---------------------------------------------------------------- */

/** Statements that can change the data or the schema, so the view needs a refresh. */
const MUTATING = /\b(insert|update|delete|replace|create|drop|alter|vacuum|reindex|pragma)\b/i;

function runSql() {
  const mod = logic.value;
  const database = db.value;
  if (!mod || !database) return;

  const sql = sqlText.value.trim();
  if (sql === "") {
    sqlError.value = "Type a statement first, for example: select * from sqlite_master;";
    return;
  }

  sqlError.value = "";
  sqlNote.value = "";
  runSeq += 1;

  try {
    const results = database.exec(sql);
    sqlPanes.value = results.map((result, i) =>
      buildPane(result, `sql-${runSeq}-${i}`, results.length > 1 ? `Statement ${i + 1}` : "Result"),
    );

    const changed = database.getRowsModified();
    if (results.length === 0) {
      sqlNote.value =
        changed > 0
          ? `No rows to show. ${changed.toLocaleString()} ${changed === 1 ? "row was" : "rows were"} changed in this tab's copy of the database.`
          : "The statement ran and returned no rows.";
    } else {
      const total = results.reduce((sum, r) => sum + r.values.length, 0);
      sqlNote.value = `${total.toLocaleString()} ${total === 1 ? "row" : "rows"} across ${results.length} ${results.length === 1 ? "result" : "results"}.`;
    }

    if (MUTATING.test(sql)) {
      dirty.value = true;
      try {
        info.value = mod.introspect(database);
      } catch {
        // Keep the previous schema rather than blanking the sidebar.
      }
      if (selected.value) loadPage();
    }
  } catch (e) {
    sqlPanes.value = [];
    sqlNote.value = "";
    sqlError.value = e instanceof Error ? e.message : String(e);
  }
}

/* ---------------------------------------------------------------- */
/* downloads                                                         */
/* ---------------------------------------------------------------- */

function exportDatabase() {
  const database = db.value;
  if (!database) return;
  try {
    const bytes = database.export();
    downloadBlob(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/vnd.sqlite3" }),
      `${baseName(fileName.value)}-modified.db`,
    );
    error.value = null;
  } catch (e) {
    error.value = toToolError(e);
  }
}

function exportCsv(pane: Pane) {
  const mod = logic.value;
  if (!mod) return;
  const csv = mod.toCsv(pane.result);
  const stem = pane.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "result";
  downloadBlob(new Blob([csv], { type: "text/csv" }), `${stem}.csv`);
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop @files="onFiles">
      <template #default="{ open }">
        <div class="flex items-center justify-between pb-1">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Database
          </span>
          <Button variant="ghost" size="sm" @click="open"> Open a database file… </Button>
        </div>

        <div v-if="db">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <button
              type="button"
              aria-label="Close this database"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <div v-else>
          <p class="text-sm text-muted-foreground">
            Drop a .db, .sqlite or .sqlite3 file here, or click to choose one. SQLite is compiled to
            WebAssembly and runs in this tab: your files and inputs never leave your device.
          </p>
          <p class="mt-2 text-xs text-muted-foreground">
            The whole file is held in memory, so a database of a few hundred megabytes or more will
            make this tab struggle. For those, a desktop client is the better tool.
          </p>
        </div>
      </template>
    </FileDrop>

    <p v-if="busy" class="text-xs text-muted-foreground">Opening the database…</p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="db && info">
      <!-- Header facts -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">File size</div>
          <div class="font-mono text-lg tabular-nums">
            {{ formatBytes(fileSize) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">SQLite version</div>
          <div class="font-mono text-lg tabular-nums">
            {{ info.sqliteVersion ?? "unknown" }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Page size</div>
          <div class="font-mono text-lg tabular-nums">
            {{ pageSize ? `${pageSize} B` : "unknown" }}
          </div>
          <div v-if="encoding" class="text-xs text-muted-foreground">
            {{ encoding }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Contents</div>
          <div class="font-mono text-lg tabular-nums">
            {{ tables.length }}
          </div>
          <div class="text-xs text-muted-foreground">
            {{ views.length }} views, {{ info.indexes.length }} indexes
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">
          <template v-if="dirty">
            You have changed this in memory copy. The file on your disk is untouched; download the
            modified copy to keep the changes.
          </template>
          <template v-else>
            Writes are allowed and apply to the copy held in this tab, never to the file on disk.
          </template>
        </p>
        <Button size="sm" :variant="dirty ? 'default' : 'outline'" @click="exportDatabase">
          <Download class="size-3.5" />
          Download database
        </Button>
      </div>

      <div class="grid gap-4 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
        <!-- Schema list -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Tables
          </div>
          <p v-if="tables.length === 0" class="text-xs text-muted-foreground">
            This database has no tables of its own.
          </p>
          <button
            v-for="table in tables"
            :key="`t-${table.name}`"
            type="button"
            class="flex w-full flex-col rounded-[8px] px-2 py-1.5 text-left outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
            :class="
              selected === table.name && !selectedIsView ? 'bg-card shadow-[var(--sh-sm)]' : ''
            "
            :aria-current="selected === table.name && !selectedIsView ? 'true' : undefined"
            @click="selectObject(table.name, false)"
          >
            <span class="truncate font-mono text-xs">{{ table.name }}</span>
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ rowLabel(table.rowCount) }}, {{ table.columns.length }} columns
            </span>
          </button>

          <template v-if="views.length">
            <div
              class="mt-1 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >
              Views
            </div>
            <button
              v-for="view in views"
              :key="`v-${view}`"
              type="button"
              class="flex w-full flex-col rounded-[8px] px-2 py-1.5 text-left outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="selected === view && selectedIsView ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="selectObject(view, true)"
            >
              <span class="truncate font-mono text-xs">{{ view }}</span>
            </button>
          </template>

          <template v-if="info.indexes.length">
            <div
              class="mt-1 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >
              Indexes
            </div>
            <p class="font-mono text-xs break-words text-muted-foreground">
              {{ info.indexes.join(", ") }}
            </p>
          </template>
        </div>

        <!-- Browser -->
        <div class="flex min-w-0 flex-col gap-3">
          <div v-if="browsePane" class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="truncate font-mono text-sm">
                {{ selected }}
              </div>
              <div class="text-xs text-muted-foreground tabular-nums">
                <template v-if="(browse?.values.length ?? 0) === 0">
                  No rows on this page.
                </template>
                <template v-else>
                  Rows {{ firstRowIndex }} to {{ lastRowIndex }}
                  <template v-if="selectedRowCount >= 0">
                    of {{ selectedRowCount.toLocaleString() }}
                  </template>
                </template>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" @click="exportCsv(browsePane)">
                Export CSV
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
            </div>
          </div>

          <div
            v-if="browsePane"
            class="overflow-x-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          >
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-left text-xs text-muted-foreground">
                  <th
                    v-for="column in browsePane.columns"
                    :key="column.name"
                    scope="col"
                    class="px-3 py-2 font-medium whitespace-nowrap"
                  >
                    <span class="font-mono text-foreground">{{ column.name }}</span>
                    <span v-if="column.pk" class="ml-1 text-[var(--positive)]" title="Primary key"
                      >key</span
                    >
                    <span v-if="column.type" class="ml-1">{{ column.type.toLowerCase() }}</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/60">
                <tr
                  v-for="(row, i) in browsePane.rows"
                  :key="`${browsePane.key}-${i}`"
                  class="align-top hover:bg-card/70"
                >
                  <td
                    v-for="(cell, j) in row"
                    :key="j"
                    class="max-w-[28rem] px-3 py-1.5 font-mono text-xs break-words"
                    :class="cell === 'NULL' ? 'text-muted-foreground italic' : ''"
                  >
                    {{ cell }}
                  </td>
                </tr>
                <tr v-if="browsePane.rows.length === 0">
                  <td
                    :colspan="Math.max(1, browsePane.columns.length)"
                    class="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    This page has no rows.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p v-else-if="selected" class="text-sm text-muted-foreground">
            {{ selected }} returned no columns.
          </p>
        </div>
      </div>

      <!-- SQL -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            SQL
          </span>
          <span class="text-xs text-muted-foreground"> Ctrl and Enter runs it </span>
        </div>
        <Textarea
          :model-value="sqlText"
          rows="4"
          spellcheck="false"
          placeholder="select * from sqlite_master;"
          class="resize-y bg-card font-mono text-xs"
          @update:model-value="(v) => (sqlText = String(v ?? ''))"
          @keydown.ctrl.enter.prevent="runSql"
          @keydown.meta.enter.prevent="runSql"
        />
        <div class="flex flex-wrap items-center gap-3">
          <Button size="sm" @click="runSql">
            <Play class="size-3.5" />
            Run
          </Button>
          <p v-if="sqlNote" class="text-xs text-muted-foreground tabular-nums">
            {{ sqlNote }}
          </p>
        </div>

        <ErrorBanner
          v-if="sqlError"
          mono
          :message="sqlError"
          hint="That is SQLite's own message, passed through unchanged."
        />

        <div v-for="pane in sqlPanes" :key="pane.key" class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ pane.title }}: {{ pane.rows.length }}
              {{ pane.rows.length === 1 ? "row" : "rows" }}
            </span>
            <Button variant="outline" size="sm" @click="exportCsv(pane)"> Export CSV </Button>
          </div>
          <div class="overflow-x-auto rounded-[10px] bg-card shadow-[var(--sh-inset)]">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-left text-xs text-muted-foreground">
                  <th
                    v-for="column in pane.columns"
                    :key="column.name"
                    scope="col"
                    class="px-3 py-2 font-mono font-medium whitespace-nowrap text-foreground"
                  >
                    {{ column.name }}
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/60">
                <tr v-for="(row, i) in pane.rows" :key="`${pane.key}-${i}`" class="align-top">
                  <td
                    v-for="(cell, j) in row"
                    :key="j"
                    class="max-w-[28rem] px-3 py-1.5 font-mono text-xs break-words"
                    :class="cell === 'NULL' ? 'text-muted-foreground italic' : ''"
                  >
                    {{ cell }}
                  </td>
                </tr>
                <tr v-if="pane.rows.length === 0">
                  <td
                    :colspan="Math.max(1, pane.columns.length)"
                    class="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    No rows matched.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
