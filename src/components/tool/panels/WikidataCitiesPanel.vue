<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { Download, Play } from "lucide-vue-next";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { ToolMeta } from "@/tools/types";
import {
  CURATED_QUERIES,
  DB_META,
  DB_PATH,
  run,
  type CuratedQuery,
} from "@/tools/wikidata-cities-database/index";
import { formatCell, toCsv, type SqlExecResult } from "@/tools/sqlite-viewer/index";
import { formatBytes } from "@/lib/format";
import { downloadText } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import ProgressBar from "../ProgressBar.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Wikidata cities database: a click-to-load SQLite
 * file preloaded with curated starting queries, plus a free-form SQL box.
 *
 * The database is a deliberate ~1.2 MB fetch, so it never loads on mount:
 * the visitor asks for it once, the browser's own HTTP cache covers every
 * visit after that. Once loaded, every query runs against the in-memory
 * copy in this tab; nothing is ever sent anywhere.
 *
 * sql.js is wired up exactly like SqliteViewerPanel.vue: the wasm binary is
 * served through Vite's `?url` import so it comes from this origin, and
 * cell formatting plus CSV writing are imported straight from
 * `@/tools/sqlite-viewer/index` rather than reimplemented, so a NULL, a
 * blob, or a comma inside a string are handled identically in both tools.
 */
defineProps<{ meta: ToolMeta }>();

type SqlJsStatic = import("sql.js").SqlJsStatic;
type SqlDatabase = import("sql.js").Database;

/** Cell text is capped the same as the general SQLite viewer. */
const CELL_CAP = 300;

/** The wasm module loads once per tab, the same singleton pattern SqliteViewerPanel uses. */
let sqlPromise: Promise<SqlJsStatic> | null = null;
function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

/** The tool's own stateless description of the bundled database (rows, license, size). */
const summary = run(undefined);

/* ---------------------------------------------------------------- */
/* SQL editor and bind parameters                                    */
/* ---------------------------------------------------------------- */

const sqlText = ref("");
const bindValues = ref<Record<string, string>>({});

/**
 * Every `:name` token in the current SQL, first-seen order, deduplicated.
 * This is a plain scan, not a real SQL tokenizer, so a colon inside a quoted
 * string literal would be misread as a bind name; the curated queries and
 * everyday hand-written SQL never hit that edge, so the simple regex is
 * worth the readability it buys.
 */
const BIND_NAME_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
const bindNames = computed<string[]>(() => {
  const names: string[] = [];
  for (const match of sqlText.value.matchAll(BIND_NAME_RE)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
});

/** Starting values for the two bind parameters the curated queries use. */
function bindDefault(name: string): string {
  if (name === "iso2") return "US";
  if (name === "lat") return "38.63";
  if (name === "lon") return "-90.20";
  return "";
}

/** Fills in a default for any bind name that has no value yet; never overwrites one. */
function ensureBindDefaults(names: string[]) {
  for (const name of names) {
    if (!(name in bindValues.value)) bindValues.value[name] = bindDefault(name);
  }
}

watch(bindNames, ensureBindDefaults);

/** A field binds as a number when it parses as one (:lat, :lon), else as text (:iso2). */
function coerceBindValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return raw;
}

/** The curated query that exactly matches the current SQL, for highlighting its card. */
const activeQuery = computed(() => CURATED_QUERIES.find((q) => q.sql === sqlText.value) ?? null);

/* ---------------------------------------------------------------- */
/* running SQL                                                       */
/* ---------------------------------------------------------------- */

/** Rows rendered into the table. The CSV (built once, from the full result) always has all of them. */
const MAX_DISPLAY_ROWS = 500;

interface Pane {
  key: string;
  title: string;
  columns: string[];
  rows: string[][];
  result: SqlExecResult;
  /** Built once here rather than in the template, so typing in the SQL box never re-walks every row. */
  csv: string;
  /** True when `rows` was cut short of the full result set. */
  truncated: boolean;
}

function buildPane(result: SqlExecResult, key: string, title: string): Pane {
  const shown = result.values.slice(0, MAX_DISPLAY_ROWS);
  const rows = shown.map((row) => result.columns.map((_, i) => formatCell(row[i], CELL_CAP)));
  return {
    key,
    title,
    columns: result.columns,
    rows,
    result,
    csv: toCsv(result),
    truncated: result.values.length > MAX_DISPLAY_ROWS,
  };
}

const panes = shallowRef<Pane[]>([]);
const resultNote = ref("");
const sqlError = ref("");
let runSeq = 0;

function runQuery() {
  const database = db.value;
  if (!database) return;

  const text = sqlText.value.trim();
  if (text === "") {
    sqlError.value = "Type a query first, or pick one of the curated queries above.";
    panes.value = [];
    resultNote.value = "";
    return;
  }

  const names = bindNames.value;
  const params = names.length
    ? Object.fromEntries(
        names.map((name) => [`:${name}`, coerceBindValue(bindValues.value[name] ?? "")]),
      )
    : undefined;

  sqlError.value = "";
  runSeq += 1;
  const started = performance.now();
  try {
    const results = database.exec(text, params);
    const elapsed = Math.round(performance.now() - started);
    panes.value = results.map((result, i) =>
      buildPane(result, `q-${runSeq}-${i}`, results.length > 1 ? `Result ${i + 1}` : "Result"),
    );
    if (results.length === 0) {
      resultNote.value = `Ran in ${elapsed} ms; no result set to show.`;
    } else {
      const totalRows = results.reduce((sum, r) => sum + r.values.length, 0);
      resultNote.value = `${totalRows.toLocaleString("en-US")} ${totalRows === 1 ? "row" : "rows"} in ${elapsed} ms.`;
    }
  } catch (e) {
    panes.value = [];
    resultNote.value = "";
    // That is SQLite's own message, passed through unchanged: no stack, just the text.
    sqlError.value = e instanceof Error ? e.message : String(e);
  }
}

function selectCurated(query: CuratedQuery) {
  sqlText.value = query.sql;
  ensureBindDefaults(bindNames.value);
  runQuery();
}

/* ---------------------------------------------------------------- */
/* loading the database                                              */
/* ---------------------------------------------------------------- */

const db = shallowRef<SqlDatabase | null>(null);
const loading = ref(false);
const loadedBytes = ref(0);
/** Content-Length when the server sends one; the load bar falls back to the known snapshot size. */
const totalBytes = ref<number | null>(null);
const loadError = ref("");

const loadPercent = computed(() => {
  const total = totalBytes.value ?? DB_META.sizeBytes;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((loadedBytes.value / total) * 100));
});

/** Byte counter beside the load bar, e.g. "12.4 MB of 30.1 MB". */
const loadDetail = computed(() =>
  totalBytes.value
    ? `${formatBytes(loadedBytes.value)} of ${formatBytes(totalBytes.value)}`
    : formatBytes(loadedBytes.value),
);

/**
 * Fetches the database with a byte-progress callback via the response's
 * readable stream. Falls back to a plain `arrayBuffer()` read when the
 * runtime has no readable stream on the response, which just skips the
 * incremental updates rather than failing.
 */
async function fetchWithProgress(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The database file did not load (HTTP ${response.status}).`);
  }
  const header = response.headers.get("content-length");
  totalBytes.value = header ? Number(header) : null;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    loadedBytes.value = buffer.byteLength;
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      loadedBytes.value = received;
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function loadDatabase() {
  if (loading.value || db.value) return;
  loading.value = true;
  loadError.value = "";
  loadedBytes.value = 0;
  totalBytes.value = null;
  try {
    const [SQL, bytes] = await Promise.all([loadSql(), fetchWithProgress(DB_PATH)]);
    db.value = new SQL.Database(bytes);
    // A shared link's query is worth reproducing the moment the database is
    // ready; an empty box just waits for a curated query or typed SQL.
    if (sqlText.value.trim()) {
      ensureBindDefaults(bindNames.value);
      runQuery();
    }
  } catch (e) {
    db.value = null;
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* downloads                                                         */
/* ---------------------------------------------------------------- */

function exportCsv(pane: Pane) {
  const stem = pane.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "result";
  downloadText(pane.csv, `wikidata-cities-${stem}.csv`, "text/csv");
}

/* ---------------------------------------------------------------- */
/* fragment: the SQL and its bind values are the shareable state     */
/* ---------------------------------------------------------------- */

let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    writeFragment({
      input: sqlText.value,
      opts: Object.fromEntries(bindNames.value.map((name) => [name, bindValues.value[name] ?? ""])),
    });
  }, 150);
}

watch(sqlText, scheduleSync);
watch(bindValues, scheduleSync, { deep: true });

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) sqlText.value = frag.input;
  for (const [key, value] of Object.entries(frag.opts)) bindValues.value[key] = value;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Load button, shown until the database is opened -->
    <div
      v-if="!db"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <div>
        <p class="text-sm font-medium">Wikidata cities database</p>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ DB_META.counts.cities.toLocaleString("en-US") }} cities and
          {{ DB_META.counts.countries.toLocaleString("en-US") }} countries in one
          {{ formatBytes(DB_META.sizeBytes) }} SQLite file, fetched from this site's own origin and
          never a third party. Your browser keeps the file afterward, so later visits start it
          straight from the cache, and nothing you query here leaves this tab.
        </p>
        <p v-if="sqlText.trim()" class="mt-2 text-xs text-muted-foreground">
          This link includes a query. It runs as soon as the database loads.
        </p>
      </div>

      <Button class="self-start" :disabled="loading" @click="loadDatabase">
        {{ loading ? "Loading the database…" : "Load the database" }}
      </Button>

      <ProgressBar
        v-if="loading"
        :value="loadPercent"
        label="Database download progress"
        :detail="loadDetail"
        track="card"
      />

      <ErrorBanner
        v-if="loadError"
        :message="loadError"
        hint="Check your connection and try again."
      />
    </div>

    <template v-else>
      <!-- Database summary -->
      <KeyValueGrid :record="summary" />

      <!-- Curated queries -->
      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Curated queries
        </span>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="query in CURATED_QUERIES"
            :key="query.label"
            type="button"
            class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-left shadow-[var(--sh-inset)] outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
            :class="activeQuery?.label === query.label ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            :aria-current="activeQuery?.label === query.label ? 'true' : undefined"
            @click="selectCurated(query)"
          >
            <span class="flex items-center gap-1.5 text-sm font-medium">
              <Play class="size-3.5 shrink-0 text-muted-foreground" />
              {{ query.label }}
            </span>
            <span class="text-xs text-muted-foreground">{{ query.description }}</span>
          </button>
        </div>
      </div>

      <!-- Bind parameters for the current query, when it has any -->
      <div v-if="bindNames.length" class="flex flex-wrap items-end gap-3">
        <div v-for="name in bindNames" :key="name" class="flex flex-col gap-1.5">
          <Label :for="`wcp-bind-${name}`" class="text-xs text-muted-foreground">
            :{{ name }}
          </Label>
          <Input
            :id="`wcp-bind-${name}`"
            :model-value="bindValues[name]"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="h-9 w-32 bg-secondary font-mono text-xs"
            @update:model-value="(v) => (bindValues[name] = String(v ?? ''))"
          />
        </div>
      </div>

      <!-- SQL editor -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            SQL
          </span>
          <span class="text-xs text-muted-foreground">Ctrl and Enter runs it</span>
        </div>
        <Textarea
          :model-value="sqlText"
          rows="5"
          spellcheck="false"
          placeholder="select name, country, population from cities order by population desc limit 25;"
          class="resize-y bg-card font-mono text-xs"
          @update:model-value="(v) => (sqlText = String(v ?? ''))"
          @keydown.ctrl.enter.prevent="runQuery"
          @keydown.meta.enter.prevent="runQuery"
        />
        <div class="flex flex-wrap items-center gap-3">
          <Button size="sm" @click="runQuery">
            <Play class="size-3.5" />
            Run
          </Button>
          <p v-if="resultNote" class="text-xs text-muted-foreground tabular-nums">
            {{ resultNote }}
          </p>
        </div>

        <ErrorBanner
          v-if="sqlError"
          :message="sqlError"
          hint="That is SQLite's own message, passed through unchanged."
        />

        <div v-for="pane in panes" :key="pane.key" class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ pane.title }}: {{ pane.result.values.length.toLocaleString("en-US") }}
              {{ pane.result.values.length === 1 ? "row" : "rows" }}
            </span>
            <div class="flex items-center gap-1">
              <CopyButton :text="pane.csv" label="Copy CSV" />
              <Button variant="outline" size="sm" @click="exportCsv(pane)">
                <Download class="size-3.5" />
                Download CSV
              </Button>
            </div>
          </div>
          <p v-if="pane.truncated" class="text-xs text-muted-foreground">
            Showing the first {{ MAX_DISPLAY_ROWS.toLocaleString("en-US") }} rows here; the CSV has
            all {{ pane.result.values.length.toLocaleString("en-US") }}.
          </p>
          <div class="overflow-x-auto rounded-[10px] bg-card shadow-[var(--sh-inset)]">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-left text-xs text-muted-foreground">
                  <th
                    v-for="column in pane.columns"
                    :key="column"
                    scope="col"
                    class="px-3 py-2 font-mono font-medium whitespace-nowrap text-foreground"
                  >
                    {{ column }}
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
