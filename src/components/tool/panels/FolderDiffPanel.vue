<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, FolderOpen, RotateCw } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  hashFile,
  isFsAccessSupported,
  pickDirectory,
  readFileBytes,
  scanDirectory,
  type DirectoryHandleWrapper,
  type FsScan,
} from "@/lib/fs-access";
import {
  MAX_TEXT_DIFF_BYTES,
  diffScans,
  diffTextPair,
  formatReport,
  looksBinary,
  planHashCompare,
  reportRows,
  summarize,
  type CommonPair,
  type FolderDiff,
  type ReportRow,
} from "@/tools/folder-diff/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for Folder Diff.
 *
 * FsShell owns one folder and the whole write flow. This tool needs two folders
 * and writes nothing, so it manages both roots itself and calls the library
 * directly: `pickDirectory` inside each click handler, `scanDirectory` per side,
 * then `hashFile` and `readFileBytes` for the short lists the pure layer asks
 * for. It never renames, writes or deletes, so there is no plan, no confirm step
 * and no undo manifest anywhere in here.
 *
 * Nothing in this file decides what "changed" means. The panel holds the two
 * scans and a growing pair of hash records, and re-runs `diffScans` whenever one
 * of them changes; every status shown comes back from the logic layer.
 */
const props = defineProps<{ meta: ToolMeta }>();

type Side = "a" | "b";

/** The two roots, in the order they are drawn. */
const SIDES: readonly Side[] = ["a", "b"];

/** Rows drawn at once before the list asks to be expanded. */
const ROW_CAP = 800;
/** Hashes written back into the diff this often, so progress stays smooth. */
const HASH_FLUSH_EVERY = 25;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps the capability check off the server. */
const supported = ref(false);

const dirA = shallowRef<DirectoryHandleWrapper | null>(null);
const dirB = shallowRef<DirectoryHandleWrapper | null>(null);
const scanA = shallowRef<FsScan | null>(null);
const scanB = shallowRef<FsScan | null>(null);

const scanningA = ref(false);
const scanningB = ref(false);
const countA = ref(0);
const countB = ref(0);

const ignoreInput = ref("node_modules, .git, *.log");
const ignoreApplied = ref(ignoreInput.value);
const caseInsensitive = ref(false);
const ignoreLineEndings = ref(false);
const showIdentical = ref(false);
const showAllRows = ref(false);

const hashesA = ref<Record<string, string>>({});
const hashesB = ref<Record<string, string>>({});

const resolving = ref(false);
const resolveDone = ref(0);
const resolveTotal = ref(0);
const resolveNotes = ref<string[]>([]);
let resolveAbort = false;

const selectedPath = ref<string | null>(null);
const textDiff = ref<string | null>(null);
const textNote = ref<string | null>(null);
const textBusy = ref(false);

const format = ref("tree");

const formatSpec: SelectOptionSpec = {
  kind: "select",
  id: "folder-diff-format",
  label: "Report format",
  default: "tree",
  options: [
    {
      value: "tree",
      label: "Tree",
      synonyms: ["tree view", "nested", "hierarchy", "indented", "folder tree"],
    },
    {
      value: "flat",
      label: "Flat list",
      synonyms: ["flat", "list", "one per line", "plain paths"],
    },
    { value: "csv", label: "CSV", synonyms: ["comma separated values", "spreadsheet", "excel"] },
  ],
};

const error = ref<{ message: string; fix?: string } | null>(null);

let ignoreTimer: ReturnType<typeof setTimeout> | null = null;

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function humanSize(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function fileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "folder"
  );
}

function setError(e: unknown) {
  if (e instanceof ToolError) error.value = { message: e.message, fix: e.fix };
  else error.value = { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* picking and scanning                                              */
/* ---------------------------------------------------------------- */

/**
 * Both roots are opened for reading only. The picker has to run inside the
 * click handler, which is why each side has its own small function rather than
 * something clever shared with a timer in it.
 */
async function pick(side: Side) {
  if (!supported.value || resolving.value) return;
  error.value = null;
  try {
    const picked = await pickDirectory("read");
    // null is the visitor closing the dialog, which is not worth a message.
    if (!picked) return;
    if (side === "a") {
      dirA.value = picked;
      scanA.value = null;
    } else {
      dirB.value = picked;
      scanB.value = null;
    }
    resetComparison();
    await rescan(side);
  } catch (e) {
    setError(e);
  }
}

async function rescan(side: Side) {
  const dir = side === "a" ? dirA.value : dirB.value;
  if (!dir) return;
  const scanning = side === "a" ? scanningA : scanningB;
  const count = side === "a" ? countA : countB;
  if (scanning.value) return;

  scanning.value = true;
  count.value = 0;
  error.value = null;
  try {
    const result = await scanDirectory(dir, {
      onProgress: (seen) => {
        count.value = seen;
      },
    });
    if (side === "a") scanA.value = result;
    else scanB.value = result;
  } catch (e) {
    setError(e);
  } finally {
    scanning.value = false;
  }
}

async function rescanBoth() {
  resetComparison();
  await rescan("a");
  await rescan("b");
}

/** Everything derived from file contents is stale the moment a root changes. */
function resetComparison() {
  hashesA.value = {};
  hashesB.value = {};
  resolveNotes.value = [];
  resolveDone.value = 0;
  resolveTotal.value = 0;
  closePair();
  showAllRows.value = false;
}

/* ---------------------------------------------------------------- */
/* the diff                                                          */
/* ---------------------------------------------------------------- */

const bothScanned = computed(() => scanA.value !== null && scanB.value !== null);

const diff = computed<FolderDiff | null>(() => {
  const a = scanA.value;
  const b = scanB.value;
  if (!a || !b) return null;
  try {
    return diffScans(a, b, {
      ignore: ignoreApplied.value,
      caseInsensitive: caseInsensitive.value,
      ignoreLineEndings: ignoreLineEndings.value,
      hashesA: hashesA.value,
      hashesB: hashesB.value,
    });
  } catch (e) {
    setError(e);
    return null;
  }
});

const counts = computed(() => (diff.value ? summarize(diff.value) : null));

const allRows = computed<ReportRow[]>(() =>
  diff.value ? reportRows(diff.value, { includeIdentical: showIdentical.value }) : [],
);

const visibleRows = computed(() =>
  showAllRows.value ? allRows.value : allRows.value.slice(0, ROW_CAP),
);

const hiddenRowCount = computed(() => Math.max(0, allRows.value.length - visibleRows.value.length));

const pairByPath = computed(() => {
  const map = new Map<string, CommonPair>();
  for (const pair of diff.value?.common ?? []) map.set(pair.path, pair);
  return map;
});

const candidates = computed(() => (diff.value ? planHashCompare(diff.value) : []));

const scanNotes = computed(() => {
  const notes: string[] = [];
  for (const [label, scan] of [
    ["Folder A", scanA.value],
    ["Folder B", scanB.value],
  ] as const) {
    if (scan?.truncated) {
      notes.push(
        `${label} holds more than the scan limit, so only the first ${scan.entries.length.toLocaleString()} files were read. The comparison covers those files only.`,
      );
    }
    if (scan?.depthCapped) {
      notes.push(`${label} has folders nested deeper than 64 levels, which were left alone.`);
    }
  }
  return notes;
});

/** Tailwind classes per status, so the list reads at a glance. */
function rowTone(row: ReportRow): string {
  switch (row.status) {
    case "added":
    case "dir-added":
      return "text-[var(--positive)]";
    case "removed":
    case "dir-removed":
      return "text-destructive";
    case "different":
      return "text-amber-700 dark:text-amber-400";
    case "maybe-different":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground/70";
  }
}

const STATUS_LABEL: Record<ReportRow["status"], string> = {
  added: "only in B",
  removed: "only in A",
  different: "different",
  "maybe-different": "same size, not read yet",
  identical: "identical",
  "dir-added": "folder only in B",
  "dir-removed": "folder only in A",
};

function sizeLabel(row: ReportRow): string {
  if (row.kind === "directory") return "";
  if (row.sizeA !== null && row.sizeB !== null) {
    return row.sizeA === row.sizeB
      ? humanSize(row.sizeA)
      : `${humanSize(row.sizeA)} to ${humanSize(row.sizeB)}`;
  }
  if (row.sizeA !== null) return humanSize(row.sizeA);
  if (row.sizeB !== null) return humanSize(row.sizeB);
  return "";
}

/** A row is openable when both sides exist and they are not known to match. */
function canOpen(row: ReportRow): boolean {
  return row.kind === "file" && (row.status === "different" || row.status === "maybe-different");
}

/* ---------------------------------------------------------------- */
/* resolving same-size pairs                                         */
/* ---------------------------------------------------------------- */

/**
 * Hash both sides of every same-size pair and feed the results back through
 * `diffScans`. This is the only place bytes are read for a comparison, and the
 * pure layer decided which files are worth reading.
 */
async function resolveSameSize() {
  const dA = dirA.value;
  const dB = dirB.value;
  const list = candidates.value;
  if (!dA || !dB || resolving.value || list.length === 0) return;

  resolving.value = true;
  resolveAbort = false;
  resolveDone.value = 0;
  resolveTotal.value = list.length;
  resolveNotes.value = [];
  error.value = null;

  const nextA: Record<string, string> = { ...hashesA.value };
  const nextB: Record<string, string> = { ...hashesB.value };
  const notes: string[] = [];

  const flush = () => {
    hashesA.value = { ...nextA };
    hashesB.value = { ...nextB };
  };

  try {
    for (const candidate of list) {
      if (resolveAbort) break;
      try {
        nextA[candidate.pathA] = await hashFile(dA, candidate.pathA);
        nextB[candidate.pathB] = await hashFile(dB, candidate.pathB);
      } catch (e) {
        // One unreadable or oversized file is one unresolved pair, not a failed
        // batch, so it keeps its "same size, not read yet" status and says why.
        delete nextA[candidate.pathA];
        delete nextB[candidate.pathB];
        notes.push(`${candidate.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      resolveDone.value += 1;
      if (resolveDone.value % HASH_FLUSH_EVERY === 0) flush();
    }
  } finally {
    flush();
    resolveNotes.value = notes;
    resolving.value = false;
  }
}

function stopResolving() {
  resolveAbort = true;
}

/* ---------------------------------------------------------------- */
/* the inline text diff                                              */
/* ---------------------------------------------------------------- */

function closePair() {
  selectedPath.value = null;
  textDiff.value = null;
  textNote.value = null;
}

/**
 * Read both sides of one pair and show a line diff. Binary files are detected
 * from their bytes and reported instead, since a diff of them would be noise.
 */
async function openPair(row: ReportRow) {
  if (!canOpen(row)) return;
  if (selectedPath.value === row.path) {
    closePair();
    return;
  }

  const pair = pairByPath.value.get(row.path);
  const dA = dirA.value;
  const dB = dirB.value;
  if (!pair || !dA || !dB) return;

  selectedPath.value = row.path;
  textDiff.value = null;
  textNote.value = null;
  textBusy.value = true;
  error.value = null;

  try {
    if (pair.a.size > MAX_TEXT_DIFF_BYTES || pair.b.size > MAX_TEXT_DIFF_BYTES) {
      textNote.value = `This file is over ${humanSize(MAX_TEXT_DIFF_BYTES)}, which is past the inline diff limit. Use Resolve same-size files to confirm whether it changed.`;
      return;
    }

    const bytesA = await readFileBytes(dA, pair.a.path);
    const bytesB = await readFileBytes(dB, pair.b.path);

    if (looksBinary(bytesA) || looksBinary(bytesB)) {
      textNote.value =
        "This looks like a binary file, so there are no lines to show. The comparison above still tells you whether the two copies differ.";
      return;
    }

    const decoder = new TextDecoder();
    textDiff.value = diffTextPair(decoder.decode(bytesA), decoder.decode(bytesB), {
      ignoreLineEndings: ignoreLineEndings.value,
    });
  } catch (e) {
    setError(e);
    closePair();
  } finally {
    textBusy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* download                                                          */
/* ---------------------------------------------------------------- */

function downloadReport() {
  const current = diff.value;
  if (!current) return;
  try {
    const text = formatReport(current, format.value, { includeIdentical: showIdentical.value });
    const csv = format.value === "csv";
    const blob = new Blob([csv ? text : `${text}\n`], {
      type: csv ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `folder-diff-${fileSlug(current.rootA)}-${fileSlug(current.rootB)}.${csv ? "csv" : "txt"}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    setError(e);
  }
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

// The ignore list re-filters as it is typed, but a keystroke should not
// re-diff 40,000 paths, so it settles first.
watch(ignoreInput, (value) => {
  if (ignoreTimer !== null) clearTimeout(ignoreTimer);
  ignoreTimer = setTimeout(() => {
    ignoreApplied.value = value;
    showAllRows.value = false;
    closePair();
  }, 250);
});

// An open text diff was computed under the old settings, so it closes rather
// than sitting there contradicting the switch that is now on.
watch([caseInsensitive, showIdentical, ignoreLineEndings], () => {
  showAllRows.value = false;
  closePair();
});

onMounted(() => {
  supported.value = isFsAccessSupported();
});

onUnmounted(() => {
  resolveAbort = true;
  if (ignoreTimer !== null) clearTimeout(ignoreTimer);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Unsupported: PanelHost gates this first, so this is a quiet fallback. -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">Checking folder access.</p>
      <p class="mt-1 text-muted-foreground">
        {{ props.meta.name }} opens two folders in place, which needs the File System Access API. It
        is available in Chromium browsers such as Chrome, Edge, Brave and Opera on desktop.
      </p>
    </div>

    <template v-else>
      <!-- The two roots -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div
          v-for="side in SIDES"
          :key="side"
          class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Folder {{ side.toUpperCase() }}
            </span>
            <Button
              variant="ghost"
              size="sm"
              :disabled="scanningA || scanningB || resolving"
              @click="pick(side)"
            >
              <FolderOpen class="size-3.5" />
              {{ (side === "a" ? dirA : dirB) ? "Change" : "Choose folder" }}
            </Button>
          </div>

          <div
            v-if="side === 'a' ? dirA : dirB"
            class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span class="font-mono text-sm font-medium">{{
              (side === "a" ? dirA : dirB)?.name
            }}</span>
            <span
              v-if="side === 'a' ? scanningA : scanningB"
              role="status"
              class="font-mono text-xs text-muted-foreground tabular-nums"
            >
              reading… {{ (side === "a" ? countA : countB).toLocaleString() }} items
            </span>
            <span
              v-else-if="side === 'a' ? scanA : scanB"
              class="text-xs text-muted-foreground tabular-nums"
            >
              {{ plural((side === "a" ? scanA : scanB)?.fileCount ?? 0, "file", "files") }} ·
              {{ humanSize((side === "a" ? scanA : scanB)?.totalBytes ?? 0) }}
            </span>
          </div>
          <p v-else class="mt-2 text-sm text-muted-foreground">
            {{
              side === "a"
                ? "The folder to compare from, such as last week's copy."
                : "The folder to compare against, such as today's."
            }}
          </p>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Both folders are opened in place and only ever read: your files and inputs never leave your
        device. Nothing here renames, writes or deletes anything.
      </p>

      <p v-for="note in scanNotes" :key="note" role="status" class="text-xs text-muted-foreground">
        {{ note }}
      </p>

      <!-- Options -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <Label
            for="folder-diff-ignore"
            class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            Ignore (comma separated globs)
          </Label>
          <Input
            id="folder-diff-ignore"
            :model-value="ignoreInput"
            placeholder="node_modules, .git, *.log"
            class="h-9 bg-card font-mono text-sm"
            @update:model-value="(v) => (ignoreInput = String(v ?? ''))"
          />
        </div>

        <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div class="flex items-center gap-2">
            <Switch
              id="folder-diff-case"
              :model-value="caseInsensitive"
              @update:model-value="(v) => (caseInsensitive = Boolean(v))"
            />
            <Label for="folder-diff-case" class="text-sm font-normal"> Ignore case in paths </Label>
          </div>
          <div class="flex items-center gap-2">
            <Switch
              id="folder-diff-eol"
              :model-value="ignoreLineEndings"
              @update:model-value="(v) => (ignoreLineEndings = Boolean(v))"
            />
            <Label for="folder-diff-eol" class="text-sm font-normal">
              Ignore line endings in the text diff
            </Label>
          </div>
          <div class="flex items-center gap-2">
            <Switch
              id="folder-diff-identical"
              :model-value="showIdentical"
              @update:model-value="(v) => (showIdentical = Boolean(v))"
            />
            <Label for="folder-diff-identical" class="text-sm font-normal">
              Show identical files
            </Label>
          </div>
        </div>
      </div>

      <!-- Summary -->
      <div v-if="counts" class="flex flex-wrap items-center gap-2">
        <span
          class="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-[var(--positive)] tabular-nums"
        >
          {{ counts.added }} added
        </span>
        <span
          class="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-destructive tabular-nums"
        >
          {{ counts.removed }} removed
        </span>
        <span
          class="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-amber-700 tabular-nums dark:text-amber-400"
        >
          {{ counts.changed }} changed
        </span>
        <span
          class="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground tabular-nums"
        >
          {{ counts.identical }} identical
        </span>
        <span
          v-if="counts.unresolved"
          class="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground tabular-nums"
        >
          {{ counts.unresolved }} same size, not read yet
        </span>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ humanSize(counts.bytesAdded) }} added, {{ humanSize(counts.bytesRemoved) }} removed
        </span>
      </div>

      <!-- Actions -->
      <div v-if="bothScanned" class="flex flex-wrap items-center gap-2">
        <Button size="sm" :disabled="resolving || candidates.length === 0" @click="resolveSameSize">
          Resolve same-size files
          <span v-if="candidates.length" class="tabular-nums">({{ candidates.length }})</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="scanningA || scanningB || resolving"
          @click="rescanBoth"
        >
          <RotateCw class="size-3.5" />
          Rescan both
        </Button>
        <div class="ml-auto flex items-center gap-2">
          <Label for="folder-diff-format" class="sr-only">Report format</Label>
          <div class="w-[130px]">
            <SearchableSelect
              id="folder-diff-format"
              :spec="formatSpec"
              :model-value="format"
              @update:model-value="(v) => (format = String(v))"
            />
          </div>
          <Button variant="ghost" size="sm" @click="downloadReport">
            <Download class="size-3.5" />
            Download report
          </Button>
        </div>
      </div>

      <!-- Hashing progress -->
      <div v-if="resolving" class="flex flex-col gap-2">
        <div
          class="h-2 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          :aria-valuenow="resolveTotal ? Math.round((resolveDone / resolveTotal) * 100) : 0"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="Comparing same-size files"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
            :style="{ width: `${resolveTotal ? (resolveDone / resolveTotal) * 100 : 0}%` }"
          />
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <span class="font-mono text-xs text-muted-foreground tabular-nums">
            Comparing {{ resolveDone }} of {{ resolveTotal }}
          </span>
          <Button variant="outline" size="sm" @click="stopResolving"> Stop </Button>
        </div>
      </div>

      <div
        v-if="resolveNotes.length && !resolving"
        role="status"
        class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
      >
        <p class="font-medium">
          {{ plural(resolveNotes.length, "file", "files") }} could not be read, so those pairs are
          still unresolved.
        </p>
        <ul class="mt-1 list-disc pl-4 text-xs text-muted-foreground">
          <li v-for="note in resolveNotes.slice(0, 8)" :key="note">
            {{ note }}
          </li>
        </ul>
      </div>

      <!-- The comparison -->
      <div v-if="bothScanned" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <p v-if="allRows.length === 0" class="px-3 py-4 text-sm text-muted-foreground">
          {{
            showIdentical
              ? "These two folders hold the same files."
              : "No differences. Switch on Show identical files to list what matched."
          }}
        </p>
        <ul v-else class="max-h-[28rem] overflow-auto py-1">
          <li v-for="row in visibleRows" :key="`${row.kind}:${row.path}`">
            <component
              :is="canOpen(row) ? 'button' : 'div'"
              :type="canOpen(row) ? 'button' : undefined"
              class="flex w-full items-baseline gap-2 px-3 py-1 text-left font-mono text-xs"
              :class="[
                canOpen(row) ? 'cursor-pointer hover:bg-background/60' : '',
                selectedPath === row.path ? 'bg-background/80' : '',
              ]"
              :title="STATUS_LABEL[row.status]"
              @click="canOpen(row) ? openPair(row) : undefined"
            >
              <span class="w-3 shrink-0 font-semibold" :class="rowTone(row)" aria-hidden="true">{{
                row.marker
              }}</span>
              <span class="min-w-0 flex-1 break-all" :class="rowTone(row)">
                {{ row.path }}{{ row.kind === "directory" ? "/" : "" }}
                <span class="sr-only">{{ STATUS_LABEL[row.status] }}</span>
              </span>
              <span class="shrink-0 text-muted-foreground tabular-nums">{{ sizeLabel(row) }}</span>
            </component>

            <!-- Inline diff for the selected pair -->
            <div v-if="selectedPath === row.path" class="px-3 pt-1 pb-3">
              <p v-if="textBusy" role="status" class="text-xs text-muted-foreground">
                Reading both copies…
              </p>
              <p v-else-if="textNote" class="text-xs text-muted-foreground">
                {{ textNote }}
              </p>
              <pre
                v-else-if="textDiff"
                class="max-h-72 overflow-auto rounded-[8px] bg-background p-2 font-mono text-xs whitespace-pre text-muted-foreground"
                >{{ textDiff }}</pre>
            </div>
          </li>
        </ul>

        <div v-if="hiddenRowCount" class="px-3 pb-3">
          <Button variant="ghost" size="sm" @click="showAllRows = true">
            Show all {{ allRows.length.toLocaleString() }} rows
          </Button>
        </div>
      </div>

      <p v-if="bothScanned && counts?.unresolved" class="text-xs text-muted-foreground">
        {{ plural(counts.unresolved, "pair shares", "pairs share") }} a path and a size, so nothing
        has been read for them yet. Resolve same-size files hashes both copies and settles each one.
      </p>

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
    </template>
  </div>
</template>
