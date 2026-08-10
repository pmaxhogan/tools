<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { ArrowDown, ArrowUp, Eye, EyeOff, TriangleAlert, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the HAR viewer. The generic ToolShell can print the ASCII
 * report, but a capture is a table with a timeline in it: proportional bars,
 * sortable columns, and rows that open to show headers. It also needs the two
 * things the shell has no vocabulary for, a risk warning card and a sanitized
 * file download, so it gets its own island.
 *
 * The logic layer stays pure. Everything below reads its exports; nothing here
 * reimplements a rule the logic already owns, in particular which headers count
 * as sensitive.
 */
defineProps<{ meta: ToolMeta }>();

type HarLogic = typeof import("@/tools/har-viewer/index");
type HarModel = import("@/tools/har-viewer/index").HarModel;
type HarEntry = import("@/tools/har-viewer/index").HarEntry;
type HarSummary = import("@/tools/har-viewer/index").HarSummary;
type SensitiveReport = import("@/tools/har-viewer/index").SensitiveReport;

/** Loaded on the first file rather than on page load, then cached. */
let logicPromise: Promise<HarLogic> | null = null;
function loadLogic(): Promise<HarLogic> {
  logicPromise ??= import("@/tools/har-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<HarLogic | null>(null);
const model = shallowRef<HarModel | null>(null);
const summary = shallowRef<HarSummary | null>(null);
const sensitive = shallowRef<SensitiveReport | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const pasted = ref("");
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const busy = ref(false);
const fileInput = ref<HTMLInputElement>();

const search = ref("");
const statusFilter = ref("all");
const minMs = ref(0);

const statusSpec: SelectOptionSpec = {
  kind: "select",
  id: "har-status",
  label: "Status",
  default: "all",
  options: [
    { value: "all", label: "All", synonyms: ["everything", "any", "no filter", "all statuses"] },
    { value: "2xx", label: "2xx success", synonyms: ["200", "ok", "success", "successful"] },
    { value: "3xx", label: "3xx redirect", synonyms: ["301", "302", "redirect", "moved"] },
    {
      value: "4xx",
      label: "4xx client error",
      synonyms: ["404", "403", "400", "client error", "not found", "forbidden"],
    },
    {
      value: "5xx",
      label: "5xx server error",
      synonyms: ["500", "502", "503", "server error", "internal error"],
    },
  ],
};

const sortKey = ref<"start" | "duration" | "size">("start");
const sortDir = ref<"asc" | "desc">("asc");

const expanded = ref<number | null>(null);
const redactOnDisplay = ref(true);
/** Header rows the reader has explicitly chosen to reveal, keyed row:side:index. */
const revealed = ref<Set<string>>(new Set());

/**
 * Position in the capture, assigned once per load. Sorting and filtering both
 * reorder the rows, so an open row and a revealed header have to be keyed to
 * the request itself rather than to its place in the current view.
 */
let rowIds = new WeakMap<HarEntry, number>();
function rowId(entry: HarEntry): number {
  return rowIds.get(entry) ?? -1;
}

const showAll = ref(false);
const ROW_CAP = 500;

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function humanTime(ms: number): string {
  const n = Math.max(0, ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)} s`;
  const minutes = Math.floor(n / 60_000);
  return `${minutes} min ${((n % 60_000) / 1000).toFixed(1)} s`;
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function statusTone(status: number): string {
  if (status >= 500) return "text-destructive";
  if (status >= 400) return "text-destructive";
  if (status >= 300) return "text-muted-foreground";
  if (status >= 200) return "text-[var(--positive)]";
  return "text-muted-foreground";
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem || "capture";
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* loading                                                           */
/* ---------------------------------------------------------------- */

function resetView() {
  expanded.value = null;
  revealed.value = new Set();
  showAll.value = false;
}

async function parseText(text: string, name: string, size: number) {
  busy.value = true;
  try {
    const mod = await loadLogic();
    logic.value = mod;
    const parsed = mod.parseHar(text);
    rowIds = new WeakMap();
    parsed.entries.forEach((entry, i) => rowIds.set(entry, i));
    model.value = parsed;
    summary.value = mod.summarize(parsed.entries);
    sensitive.value = mod.listSensitive(parsed);
    fileName.value = name;
    fileSize.value = size;
    error.value = null;
    resetView();
  } catch (e) {
    model.value = null;
    summary.value = null;
    sensitive.value = null;
    error.value = toToolError(e);
  } finally {
    busy.value = false;
  }
}

async function readFile(file: File) {
  const text = await file.text();
  await parseText(text, file.name, file.size);
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

let pasteTimer: ReturnType<typeof setTimeout> | undefined;
function onPaste(value: unknown) {
  pasted.value = String(value ?? "");
  clearTimeout(pasteTimer);
  const text = pasted.value;
  if (text.trim() === "") {
    error.value = null;
    return;
  }
  pasteTimer = setTimeout(() => {
    parseText(text, "pasted-capture.har", text.length);
  }, 250);
}

function clearFile() {
  model.value = null;
  summary.value = null;
  sensitive.value = null;
  fileName.value = "";
  fileSize.value = 0;
  pasted.value = "";
  error.value = null;
  resetView();
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* filtering, sorting                                                */
/* ---------------------------------------------------------------- */

const entries = computed<HarEntry[]>(() => model.value?.entries ?? []);

/** The whole capture's length, so filtering never shifts the bars. */
const span = computed(() => {
  let end = 1;
  for (const entry of entries.value) end = Math.max(end, entry.startMs + entry.time);
  return end;
});

const filtered = computed<HarEntry[]>(() => {
  const mod = logic.value;
  if (!mod) return [];
  const list = mod.filterEntries(entries.value, {
    filter: search.value,
    status: statusFilter.value,
    minMs: minMs.value,
  });
  const dir = sortDir.value === "asc" ? 1 : -1;
  const key = sortKey.value;
  return [...list].sort((a, b) => {
    if (key === "duration") return dir * (a.time - b.time);
    if (key === "size") return dir * (a.bytes - b.bytes);
    return dir * (a.startMs - b.startMs);
  });
});

const visible = computed(() => (showAll.value ? filtered.value : filtered.value.slice(0, ROW_CAP)));

const filteredSummary = computed(() =>
  logic.value ? logic.value.summarize(filtered.value) : null,
);

function sortBy(key: "start" | "duration" | "size") {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = key === "start" ? "asc" : "desc";
  }
}

function sortLabel(key: "start" | "duration" | "size"): string {
  if (sortKey.value !== key) return "not sorted";
  return sortDir.value === "asc" ? "sorted ascending" : "sorted descending";
}

/* ---------------------------------------------------------------- */
/* waterfall geometry                                                */
/* ---------------------------------------------------------------- */

const PHASES = [
  { id: "dns", label: "dns", color: "var(--chart-3)" },
  { id: "connect", label: "connect", color: "var(--chart-2)" },
  { id: "wait", label: "wait", color: "var(--chart-1)" },
  { id: "receive", label: "receive", color: "var(--chart-4)" },
] as const;

function barStyle(entry: HarEntry) {
  const left = (entry.startMs / span.value) * 100;
  const width = (entry.time / span.value) * 100;
  return {
    left: `${Math.min(99, Math.max(0, left))}%`,
    width: `${Math.max(0.6, Math.min(100 - left, width))}%`,
  };
}

/**
 * Phase segments as flex weights. `ssl` is contained in `connect` per the HAR
 * spec, so it is never added on top, and `blocked` folds into the lookup
 * segment because both are stalls before any byte moves.
 */
function phaseParts(entry: HarEntry) {
  const t = entry.timings;
  const weights = [t.blocked + t.dns, t.connect, t.send + t.wait, t.receive];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return [{ id: "wait", color: "var(--chart-1)", flex: 1, label: "no phase detail" }];
  }
  return PHASES.map((phase, i) => ({
    id: phase.id,
    color: phase.color,
    flex: weights[i] ?? 0,
    label: `${phase.label} ${Math.round(weights[i] ?? 0)} ms`,
  })).filter((part) => part.flex > 0);
}

function phaseTitle(entry: HarEntry): string {
  return phaseParts(entry)
    .map((part) => part.label)
    .join(", ");
}

/* ---------------------------------------------------------------- */
/* row expansion and header redaction                                */
/* ---------------------------------------------------------------- */

function toggleRow(index: number) {
  expanded.value = expanded.value === index ? null : index;
}

function isSensitiveHeader(name: string): boolean {
  return logic.value ? logic.value.isSensitiveHeader(name) : false;
}

function isSecretParam(name: string): boolean {
  return logic.value ? logic.value.isSecretParam(name) : false;
}

function revealKey(index: number, side: string, i: number): string {
  return `${index}:${side}:${i}`;
}

function isRevealed(index: number, side: string, i: number): boolean {
  return revealed.value.has(revealKey(index, side, i));
}

function toggleReveal(index: number, side: string, i: number) {
  const next = new Set(revealed.value);
  const key = revealKey(index, side, i);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  revealed.value = next;
}

function hidden(index: number, side: string, i: number, name: string): boolean {
  return redactOnDisplay.value && isSensitiveHeader(name) && !isRevealed(index, side, i);
}

function displayValue(
  index: number,
  side: string,
  i: number,
  header: { name: string; value: string },
): string {
  return hidden(index, side, i, header.name) ? "[redacted]" : header.value;
}

/* ---------------------------------------------------------------- */
/* sanitized download                                                */
/* ---------------------------------------------------------------- */

const sensitiveLine = computed(() => {
  const r = sensitive.value;
  if (!r) return "";
  const parts = [
    `${r.cookies} ${r.cookies === 1 ? "cookie" : "cookies"}`,
    `${r.cookieHeaders + r.authHeaders} credential ${r.cookieHeaders + r.authHeaders === 1 ? "header" : "headers"}`,
    `${r.requestBodies} request ${r.requestBodies === 1 ? "body" : "bodies"}`,
  ];
  if (r.queryParams > 0) {
    parts.push(`${r.queryParams} secret ${r.queryParams === 1 ? "parameter" : "parameters"}`);
  }
  if (r.responseBodies > 0) {
    parts.push(`${r.responseBodies} saved response ${r.responseBodies === 1 ? "body" : "bodies"}`);
  }
  return `This capture contains ${parts.join(", ")}. Treat it like a password.`;
});

function downloadSanitized() {
  const mod = logic.value;
  const current = model.value;
  if (!mod || !current) return;
  try {
    const clean = mod.sanitizeHar(current);
    const blob = new Blob([JSON.stringify(clean)], { type: "application/json" });
    downloadBlob(blob, `${baseName(fileName.value)}-sanitized.har`);
    error.value = null;
  } catch (e) {
    error.value = toToolError(e);
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
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Capture
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open .har file… </Button>
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          accept="application/json,.har"
          @change="onPickFile"
        />
      </div>

      <div v-if="model" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <button
            type="button"
            aria-label="Remove capture"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <div v-else class="flex flex-col gap-2 px-3 pt-1 pb-3">
        <p class="text-sm text-muted-foreground">
          Drop a .har file here, or paste one below. It is read in this tab: your files and inputs
          never leave your device.
        </p>
        <Textarea
          :model-value="pasted"
          rows="4"
          spellcheck="false"
          placeholder="Paste the contents of a .har file here…"
          class="resize-y bg-card font-mono text-xs"
          @update:model-value="onPaste"
        />
      </div>
    </div>

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

    <template v-if="model && summary">
      <!-- Summary cards -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Requests</div>
          <div class="font-mono text-lg tabular-nums">
            {{ summary.requests }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Transferred</div>
          <div class="font-mono text-lg tabular-nums">
            {{ formatBytes(summary.transferred) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Time span</div>
          <div class="font-mono text-lg tabular-nums">
            {{ humanTime(summary.spanMs) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Domains</div>
          <div class="font-mono text-lg tabular-nums">
            {{ summary.domains.length }}
          </div>
          <div v-if="summary.primaryHost" class="text-xs text-muted-foreground">
            {{ Math.round(summary.thirdPartyShare * 100) }}% third party
          </div>
        </div>
      </div>

      <!-- Risk card -->
      <div
        v-if="sensitive && sensitive.total > 0"
        class="flex flex-col gap-3 rounded-[10px] border border-destructive/50 bg-destructive/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex items-start gap-2">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
          <div class="text-sm">
            <p class="font-medium text-destructive">
              {{ sensitiveLine }}
            </p>
            <p class="mt-1 text-muted-foreground">
              {{ sensitive.entries }} of {{ summary.requests }} requests carry something a stranger
              could replay. The sanitized copy empties the cookie arrays, redacts the Cookie,
              Set-Cookie, Authorization and Proxy-Authorization headers, replaces request bodies
              with their size, redacts credential shaped query parameters, and drops saved response
              bodies.
            </p>
          </div>
        </div>
        <Button size="sm" class="shrink-0" @click="downloadSanitized">
          Download sanitized copy
        </Button>
      </div>

      <div
        v-else-if="sensitive"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary px-3 py-3 text-sm shadow-[var(--sh-inset)] sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="text-muted-foreground">
          No cookies, credential headers or saved bodies were found in this capture. Read it over
          before sharing it anyway, because a session id can hide in any field.
        </p>
        <Button variant="outline" size="sm" class="shrink-0" @click="downloadSanitized">
          Download sanitized copy
        </Button>
      </div>

      <!-- Filters -->
      <div
        class="flex flex-wrap items-end gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label for="har-search" class="text-xs text-muted-foreground">URL contains</Label>
          <Input
            id="har-search"
            :model-value="search"
            placeholder="e.g. /api/ or analytics"
            class="h-9 bg-card"
            @update:model-value="(v) => (search = String(v ?? ''))"
          />
        </div>
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="har-status" class="text-xs text-muted-foreground">Status</Label>
          <SearchableSelect
            id="har-status"
            :spec="statusSpec"
            :model-value="statusFilter"
            @update:model-value="(v) => (statusFilter = String(v))"
          />
        </div>
        <div class="flex w-36 flex-col gap-1.5">
          <Label for="har-min" class="text-xs text-muted-foreground">Slower than (ms)</Label>
          <Input
            id="har-min"
            type="number"
            min="0"
            :model-value="minMs"
            class="h-9 bg-card"
            @update:model-value="(v) => (minMs = Math.max(0, Number(v) || 0))"
          />
        </div>
        <div class="flex items-center gap-2 pb-2.5">
          <Switch
            id="har-redact"
            :model-value="redactOnDisplay"
            @update:model-value="(v) => (redactOnDisplay = Boolean(v))"
          />
          <Label for="har-redact" class="text-xs text-muted-foreground"
            >Hide secrets on screen</Label
          >
        </div>
      </div>

      <p v-if="filteredSummary" class="text-xs text-muted-foreground tabular-nums">
        Showing {{ filtered.length }} of {{ summary.requests }} requests,
        {{ formatBytes(filteredSummary.transferred) }} transferred.
      </p>

      <!-- Legend -->
      <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span v-for="phase in PHASES" :key="phase.id" class="inline-flex items-center gap-1.5">
          <span class="inline-block size-2.5 rounded-[2px]" :style="{ background: phase.color }" />
          {{ phase.label }}
        </span>
        <span>timeline 0 to {{ humanTime(span) }}</span>
      </div>

      <!-- Waterfall table -->
      <div class="overflow-x-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <table class="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr class="text-left text-xs text-muted-foreground">
              <th scope="col" class="px-3 py-2 font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-[4px] px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  :aria-label="`Sort by start time, currently ${sortLabel('start')}`"
                  @click="sortBy('start')"
                >
                  Start
                  <ArrowUp v-if="sortKey === 'start' && sortDir === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="sortKey === 'start'" class="size-3" />
                </button>
              </th>
              <th scope="col" class="w-full px-3 py-2 font-medium">Request</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-[4px] px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  :aria-label="`Sort by size, currently ${sortLabel('size')}`"
                  @click="sortBy('size')"
                >
                  Size
                  <ArrowUp v-if="sortKey === 'size' && sortDir === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="sortKey === 'size'" class="size-3" />
                </button>
              </th>
              <th scope="col" class="px-3 py-2 text-right font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-[4px] px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  :aria-label="`Sort by duration, currently ${sortLabel('duration')}`"
                  @click="sortBy('duration')"
                >
                  Time
                  <ArrowUp v-if="sortKey === 'duration' && sortDir === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="sortKey === 'duration'" class="size-3" />
                </button>
              </th>
              <th scope="col" class="w-[320px] min-w-[320px] px-3 py-2 font-medium">Waterfall</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60">
            <template v-for="entry in visible" :key="rowId(entry)">
              <tr
                class="cursor-pointer align-top hover:bg-card/70"
                :class="expanded === rowId(entry) ? 'bg-card' : ''"
                tabindex="0"
                :aria-expanded="expanded === rowId(entry)"
                @click="toggleRow(rowId(entry))"
                @keydown.enter.prevent="toggleRow(rowId(entry))"
                @keydown.space.prevent="toggleRow(rowId(entry))"
              >
                <td class="px-3 py-2 font-mono text-xs whitespace-nowrap tabular-nums">
                  {{ Math.round(entry.startMs) }} ms
                </td>
                <td class="w-full max-w-[1px] px-3 py-2">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-xs text-muted-foreground">
                      {{ entry.request.method }}
                    </span>
                    <span
                      class="font-mono text-xs tabular-nums"
                      :class="statusTone(entry.response.status)"
                    >
                      {{ entry.response.status || "-" }}
                    </span>
                    <span class="truncate font-mono text-xs">
                      {{ shortPath(entry.request.url) }}
                    </span>
                  </div>
                  <div class="truncate text-xs text-muted-foreground">
                    {{ hostOf(entry.request.url) }}
                    <span v-if="entry.response.content.mimeType">
                      · {{ entry.response.content.mimeType.split(";")[0] }}
                    </span>
                  </div>
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {{ formatBytes(entry.bytes) }}
                </td>
                <td class="px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {{ Math.round(entry.time) }} ms
                </td>
                <td class="px-3 py-2">
                  <div class="relative h-4 w-full rounded-[3px] bg-card">
                    <div
                      class="absolute top-0 flex h-4 overflow-hidden rounded-[3px]"
                      :style="barStyle(entry)"
                      :title="phaseTitle(entry)"
                    >
                      <span
                        v-for="part in phaseParts(entry)"
                        :key="part.id"
                        class="h-full"
                        :style="{ background: part.color, flexGrow: part.flex, flexBasis: '0%' }"
                      />
                    </div>
                  </div>
                </td>
              </tr>

              <tr v-if="expanded === rowId(entry)">
                <td colspan="5" class="bg-card px-3 py-3">
                  <div class="flex flex-col gap-3 text-xs">
                    <div class="font-mono break-all">
                      {{ entry.request.method }} {{ entry.request.url }}
                    </div>
                    <div class="text-muted-foreground">
                      {{ entry.response.status }} {{ entry.response.statusText }} ·
                      {{ formatBytes(entry.bytes) }} transferred ·
                      {{
                        formatBytes(
                          entry.response.content.size > 0 ? entry.response.content.size : 0,
                        )
                      }}
                      uncompressed · {{ humanTime(entry.time) }}
                    </div>

                    <div class="grid gap-3 sm:grid-cols-2">
                      <div>
                        <div
                          class="mb-1 font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                        >
                          Request headers
                        </div>
                        <div
                          v-for="(header, i) in entry.request.headers"
                          :key="`req-${i}-${header.name}`"
                          class="flex items-start gap-2 border-b border-border/40 py-1 last:border-0"
                        >
                          <span class="w-40 shrink-0 truncate font-mono text-muted-foreground">
                            {{ header.name }}
                          </span>
                          <span
                            class="min-w-0 flex-1 font-mono break-all"
                            :class="
                              hidden(rowId(entry), 'req', i, header.name)
                                ? 'text-muted-foreground'
                                : ''
                            "
                          >
                            {{ displayValue(rowId(entry), "req", i, header) }}
                          </span>
                          <button
                            v-if="isSensitiveHeader(header.name) && redactOnDisplay"
                            type="button"
                            class="grid size-5 shrink-0 place-items-center rounded-[4px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                            :aria-label="
                              isRevealed(rowId(entry), 'req', i)
                                ? `Hide the ${header.name} header again`
                                : `Reveal the ${header.name} header`
                            "
                            @click.stop="toggleReveal(rowId(entry), 'req', i)"
                          >
                            <EyeOff v-if="isRevealed(rowId(entry), 'req', i)" class="size-3.5" />
                            <Eye v-else class="size-3.5" />
                          </button>
                        </div>
                        <p v-if="entry.request.headers.length === 0" class="text-muted-foreground">
                          None recorded.
                        </p>
                      </div>

                      <div>
                        <div
                          class="mb-1 font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                        >
                          Response headers
                        </div>
                        <div
                          v-for="(header, i) in entry.response.headers"
                          :key="`res-${i}-${header.name}`"
                          class="flex items-start gap-2 border-b border-border/40 py-1 last:border-0"
                        >
                          <span class="w-40 shrink-0 truncate font-mono text-muted-foreground">
                            {{ header.name }}
                          </span>
                          <span
                            class="min-w-0 flex-1 font-mono break-all"
                            :class="
                              hidden(rowId(entry), 'res', i, header.name)
                                ? 'text-muted-foreground'
                                : ''
                            "
                          >
                            {{ displayValue(rowId(entry), "res", i, header) }}
                          </span>
                          <button
                            v-if="isSensitiveHeader(header.name) && redactOnDisplay"
                            type="button"
                            class="grid size-5 shrink-0 place-items-center rounded-[4px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                            :aria-label="
                              isRevealed(rowId(entry), 'res', i)
                                ? `Hide the ${header.name} header again`
                                : `Reveal the ${header.name} header`
                            "
                            @click.stop="toggleReveal(rowId(entry), 'res', i)"
                          >
                            <EyeOff v-if="isRevealed(rowId(entry), 'res', i)" class="size-3.5" />
                            <Eye v-else class="size-3.5" />
                          </button>
                        </div>
                        <p v-if="entry.response.headers.length === 0" class="text-muted-foreground">
                          None recorded.
                        </p>
                      </div>
                    </div>

                    <div v-if="entry.request.queryString.length" class="text-muted-foreground">
                      Query:
                      <span
                        v-for="(param, i) in entry.request.queryString"
                        :key="`q-${i}-${param.name}`"
                        class="font-mono"
                      >
                        {{ param.name }}={{
                          redactOnDisplay && isSecretParam(param.name) ? "[redacted]" : param.value
                        }}<span v-if="i < entry.request.queryString.length - 1">&amp;</span>
                      </span>
                    </div>

                    <div v-if="entry.request.postData" class="text-muted-foreground">
                      Request body: {{ entry.request.postData.mimeType || "unknown type" }}, hidden
                      here and redacted in the sanitized copy.
                    </div>

                    <div class="flex flex-wrap gap-3 text-muted-foreground tabular-nums">
                      <span v-for="part in phaseParts(entry)" :key="`t-${part.id}`">
                        {{ part.label }}
                      </span>
                    </div>
                  </div>
                </td>
              </tr>
            </template>

            <tr v-if="filtered.length === 0">
              <td colspan="5" class="px-3 py-6 text-center text-sm text-muted-foreground">
                No requests match these filters.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="!showAll && filtered.length > visible.length"
        class="flex items-center justify-center"
      >
        <Button variant="outline" size="sm" @click="showAll = true">
          Show all {{ filtered.length }} requests
        </Button>
      </div>

      <p v-if="busy" class="text-xs text-muted-foreground">Reading the capture…</p>
    </template>
  </div>
</template>
