<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileWarning,
  FolderArchive,
  Search,
  X,
} from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import ErrorBanner from "../ErrorBanner.vue";
import EmptyState from "../EmptyState.vue";
import FileDrop from "../FileDrop.vue";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Bespoke panel for the Archive viewer. The generic ToolShell renders a
 * Record<string,string> of text blocks, which cannot express what an archive is
 * for: a tree you expand, an entry you click to preview, and a single file you
 * pull out of a thousand.
 *
 * Every rule lives in the logic layer (rule 27): format detection, the zip
 * central directory walk, the tar parser, path sanitization, the preview
 * decode, the text/image classification and the repack are all imported from
 * `@/tools/archive-viewer/index`. The panel only decides what to ask for and
 * how to draw the answer. The module is imported lazily so fflate stays out of
 * every other page's bundle.
 *
 * One shape of the logic drives the design: a gzipped tar has to be inflated in
 * full before any entry can be read, so the payload is inflated once when the
 * file opens and every later preview and extract slices that buffer through
 * `readEntryFrom`, rather than paying the inflate again per click.
 */
defineProps<{ meta: ToolMeta }>();

type ArchiveLogic = typeof import("@/tools/archive-viewer/index");
type Archive = import("@/tools/archive-viewer/index").Archive;
type ArchiveEntry = import("@/tools/archive-viewer/index").ArchiveEntry;
type ArchiveNode = import("@/tools/archive-viewer/index").ArchiveNode;

/** Entries rendered before the tree asks the user to filter instead. */
const MAX_VISIBLE_ROWS = 4000;
/** Directories below this count start expanded, so a small archive opens open. */
const AUTO_EXPAND_LIMIT = 40;

let logicPromise: Promise<ArchiveLogic> | null = null;
function loadLogic(): Promise<ArchiveLogic> {
  logicPromise ??= import("@/tools/archive-viewer/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<ArchiveLogic | null>(null);
const archive = shallowRef<Archive | null>(null);
/**
 * The bytes entries are sliced out of: the file itself for zip and tar, the
 * inflated stream for anything gzipped. Held so a preview costs a slice.
 */
const payload = shallowRef<Uint8Array | null>(null);

const fileName = ref("");
const fileSize = ref(0);
const filter = ref("");
const expanded = ref<Set<string>>(new Set());
const selected = shallowRef<ArchiveEntry | null>(null);

const error = ref<{ message: string; fix?: string } | null>(null);
const busy = ref(false);

/** The current preview. Only one is alive at a time; the blob URL is revoked. */
const preview = shallowRef<{
  kind: "text" | "image" | "binary";
  text?: string;
  truncated?: boolean;
  url?: string;
  size: number;
} | null>(null);
let previewUrl: string | null = null;

/** Guards against a slow open landing after the user picked another file. */
let openSeq = 0;

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.replace(/\.tar$/i, "") || "archive";
}

function releasePreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.value = null;
}

onUnmounted(releasePreview);

/* ---------------------------------------------------------------- */
/* opening                                                           */
/* ---------------------------------------------------------------- */

function reset() {
  archive.value = null;
  payload.value = null;
  selected.value = null;
  filter.value = "";
  expanded.value = new Set();
  releasePreview();
}

async function openFile(file: File) {
  const seq = ++openSeq;
  busy.value = true;
  error.value = null;

  try {
    const mod = await loadLogic();
    const source = new Uint8Array(await file.arrayBuffer());
    const opened = mod.listArchive(source, file.name);
    // Inflating up front means every later preview and extract is a slice.
    const buffer = mod.archivePayload(source, opened.format);
    if (seq !== openSeq) return;

    reset();
    logic.value = mod;
    archive.value = opened;
    payload.value = buffer;
    fileName.value = file.name;
    fileSize.value = file.size;

    // A small archive is more useful open than closed; a large one is not.
    const directories = opened.entries.filter((entry) => entry.isDirectory).length;
    if (opened.tree.length <= AUTO_EXPAND_LIMIT && directories <= AUTO_EXPAND_LIMIT) {
      expanded.value = new Set(collectDirectoryPaths(opened.tree));
    }
  } catch (e) {
    if (seq !== openSeq) return;
    reset();
    fileName.value = "";
    fileSize.value = 0;
    error.value = toToolError(e);
  } finally {
    if (seq === openSeq) busy.value = false;
  }
}

function collectDirectoryPaths(nodes: ArchiveNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ArchiveNode[]) => {
    for (const node of list) {
      if (!node.isDirectory) continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
function onFiles(files: File[]) {
  const file = files[0];
  if (file) void openFile(file);
}

function clearFile() {
  openSeq += 1;
  reset();
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  busy.value = false;
}

/* ---------------------------------------------------------------- */
/* tree and filtering                                                */
/* ---------------------------------------------------------------- */

/**
 * The tree flattened into the rows actually drawn, honoring both the expanded
 * set and the filter. Filtering matches on the full path, and a directory
 * survives when anything beneath it matches, so a hit deep in a tree still
 * shows the folders that lead to it.
 */
interface Row {
  node: ArchiveNode;
  depth: number;
}

const query = computed(() => filter.value.trim().toLowerCase());

function matches(node: ArchiveNode): boolean {
  const q = query.value;
  if (!q) return true;
  if (node.path.toLowerCase().includes(q)) return true;
  return node.children.some(matches);
}

const rows = computed<Row[]>(() => {
  const tree = archive.value?.tree;
  if (!tree) return [];
  const q = query.value;
  const out: Row[] = [];

  const walk = (nodes: ArchiveNode[], depth: number) => {
    for (const node of nodes) {
      if (!matches(node)) continue;
      out.push({ node, depth });
      if (!node.isDirectory) continue;
      // A filter expands the path to every hit; otherwise the user decides.
      if (q || expanded.value.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out.slice(0, MAX_VISIBLE_ROWS);
});

const hiddenRows = computed(() => {
  const tree = archive.value?.tree;
  if (!tree) return 0;
  return Math.max(0, countMatching(tree) - rows.value.length);
});

function countMatching(nodes: ArchiveNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (!matches(node)) continue;
    total += 1;
    if (node.isDirectory && (query.value || expanded.value.has(node.path))) {
      total += countMatching(node.children);
    }
  }
  return total;
}

function toggle(node: ArchiveNode) {
  if (!node.isDirectory) return;
  const next = new Set(expanded.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  expanded.value = next;
}

function expandAll() {
  const tree = archive.value?.tree;
  if (tree) expanded.value = new Set(collectDirectoryPaths(tree));
}

function collapseAll() {
  expanded.value = new Set();
}

function isOpen(node: ArchiveNode): boolean {
  return Boolean(query.value) || expanded.value.has(node.path);
}

/* ---------------------------------------------------------------- */
/* preview                                                           */
/* ---------------------------------------------------------------- */

function select(node: ArchiveNode) {
  if (node.isDirectory) {
    toggle(node);
    return;
  }
  const entry = node.entry;
  const mod = logic.value;
  const buffer = payload.value;
  if (!entry || !mod || !buffer) return;

  releasePreview();
  selected.value = entry;
  error.value = null;

  try {
    const data = mod.readEntryFrom(buffer, entry);
    const imageType = mod.imageTypeFor(entry.path);

    if (imageType) {
      previewUrl = URL.createObjectURL(
        new Blob([data.slice().buffer as ArrayBuffer], { type: imageType }),
      );
      preview.value = { kind: "image", url: previewUrl, size: data.length };
      return;
    }
    if (mod.looksBinary(data) && !mod.isTextPath(entry.path)) {
      preview.value = { kind: "binary", size: data.length };
      return;
    }
    const decoded = mod.decodeTextPreview(data);
    preview.value = {
      kind: "text",
      text: decoded.text,
      truncated: decoded.truncated,
      size: data.length,
    };
  } catch (e) {
    preview.value = null;
    error.value = toToolError(e);
  }
}

/* ---------------------------------------------------------------- */
/* extracting                                                        */
/* ---------------------------------------------------------------- */

function extractOne(entry: ArchiveEntry) {
  const mod = logic.value;
  const buffer = payload.value;
  if (!mod || !buffer) return;
  try {
    const data = mod.readEntryFrom(buffer, entry);
    // The sanitized path's last segment, never the one the archive claimed.
    downloadBlob(new Blob([data.slice().buffer as ArrayBuffer]), entry.name);
  } catch (e) {
    error.value = toToolError(e);
  }
}

function extractAll() {
  const mod = logic.value;
  const buffer = payload.value;
  const opened = archive.value;
  if (!mod || !buffer || !opened) return;

  busy.value = true;
  error.value = null;
  try {
    const files = [];
    for (const entry of opened.entries) {
      if (entry.isDirectory || entry.encrypted) continue;
      try {
        files.push({ path: entry.path, data: mod.readEntryFrom(buffer, entry) });
      } catch {
        // One unreadable entry must not cost the user the other thousand.
        continue;
      }
    }
    if (files.length === 0) {
      error.value = {
        message: "Nothing in this archive could be extracted.",
        fix: "Every entry is either a directory or password protected.",
      };
      return;
    }
    downloadBlob(
      new Blob([mod.packEntries(files).slice().buffer as ArrayBuffer], { type: "application/zip" }),
      `${baseName(fileName.value)}-extracted.zip`,
    );
  } catch (e) {
    error.value = toToolError(e);
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* summary rows                                                      */
/* ---------------------------------------------------------------- */

const savedLabel = computed(() => {
  const opened = archive.value;
  if (!opened || opened.totalSize === 0) return "nothing to compress";
  const saved = 1 - opened.totalCompressedSize / opened.totalSize;
  return saved <= 0.005 ? "stored, not compressed" : `${Math.round(saved * 100)}% smaller`;
});

const pathList = computed(() =>
  (archive.value?.entries ?? [])
    .map((entry) => entry.path + (entry.isDirectory ? "/" : ""))
    .join("\n"),
);

function ratioLabel(entry: ArchiveEntry): string {
  return logic.value ? logic.value.formatRatio(entry) : "";
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      accept=".zip,.tar,.gz,.tgz,.jar,.apk,.epub,.whl"
      label="Drop an archive here or click to choose"
      hint="Reads .zip, .tar, .tar.gz, .tgz and .gz. The reader is JavaScript running in this tab: your files and inputs never leave your device. Archives up to 500 MB are accepted."
      @files="onFiles"
    >
      <template v-if="archive" #default>
        <div class="flex justify-center">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <button
              type="button"
              aria-label="Close this archive"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>
      </template>
    </FileDrop>

    <p v-if="busy && !archive" class="text-xs text-muted-foreground">Reading the archive…</p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="archive">
      <!-- Archive header -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="truncate font-mono text-sm">{{ fileName }}</div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Archive size</div>
            <div class="font-mono text-lg tabular-nums">{{ formatBytes(fileSize) }}</div>
            <div class="text-xs text-muted-foreground">{{ archive.formatLabel }}</div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Files</div>
            <div class="font-mono text-lg tabular-nums">
              {{ archive.fileCount.toLocaleString() }}
            </div>
            <div class="text-xs text-muted-foreground tabular-nums">
              {{ count(archive.directoryCount, "directory", "directories") }}
            </div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Uncompressed</div>
            <div class="font-mono text-lg tabular-nums">{{ formatBytes(archive.totalSize) }}</div>
            <div class="text-xs text-muted-foreground">{{ savedLabel }}</div>
          </div>
          <div class="rounded-[8px] bg-card px-3 py-2">
            <div class="text-xs text-muted-foreground">Packed</div>
            <div class="font-mono text-lg tabular-nums">
              {{ formatBytes(archive.totalCompressedSize) }}
            </div>
            <div class="text-xs text-muted-foreground">inside the archive</div>
          </div>
        </div>

        <p v-if="archive.comment" class="text-xs break-words text-muted-foreground">
          Comment: {{ archive.comment }}
        </p>
      </div>

      <!-- Warnings from the reader, including any zip slip attempt -->
      <ErrorBanner
        v-for="warning in archive.warnings"
        :key="warning"
        variant="warning"
        :message="warning"
      />

      <!-- Toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="relative min-w-0 grow sm:max-w-xs">
          <Search
            class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="filter"
            type="search"
            class="pl-8"
            placeholder="Filter by path"
            aria-label="Filter entries by path"
          />
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" :disabled="Boolean(query)" @click="expandAll">
            Expand all
          </Button>
          <Button variant="ghost" size="sm" :disabled="Boolean(query)" @click="collapseAll">
            Collapse all
          </Button>
          <CopyButton :text="pathList" label="Copy paths" variant="outline" />
          <Button
            variant="outline"
            size="sm"
            :disabled="busy || archive.fileCount === 0"
            @click="extractAll"
          >
            <Download class="size-3.5" />
            Extract all as zip
          </Button>
        </div>
      </div>

      <!-- Tree -->
      <div class="max-h-[30rem] overflow-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="text-left text-xs text-muted-foreground">
              <th scope="col" class="sticky top-0 z-10 bg-secondary px-3 py-2 font-medium">Name</th>
              <th
                scope="col"
                class="sticky top-0 z-10 bg-secondary px-3 py-2 text-right font-medium whitespace-nowrap"
              >
                Size
              </th>
              <th
                scope="col"
                class="sticky top-0 z-10 hidden bg-secondary px-3 py-2 font-medium whitespace-nowrap sm:table-cell"
              >
                Packed
              </th>
              <th
                scope="col"
                class="sticky top-0 z-10 hidden bg-secondary px-3 py-2 font-medium whitespace-nowrap md:table-cell"
              >
                Modified
              </th>
              <th scope="col" class="sticky top-0 z-10 bg-secondary px-3 py-2 font-medium">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60">
            <tr
              v-for="row in rows"
              :key="row.node.path"
              class="align-middle hover:bg-card/70"
              :class="selected && selected.path === row.node.path ? 'bg-card' : ''"
            >
              <td class="px-3 py-1.5">
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-[8px] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  :style="{ paddingLeft: `${row.depth * 14}px` }"
                  :aria-expanded="row.node.isDirectory ? isOpen(row.node) : undefined"
                  @click="select(row.node)"
                >
                  <component
                    :is="isOpen(row.node) ? ChevronDown : ChevronRight"
                    v-if="row.node.isDirectory"
                    class="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <FolderArchive
                    v-else-if="row.node.entry && row.node.entry.unsafe"
                    class="size-3.5 shrink-0 text-[var(--warning,orange)]"
                  />
                  <span v-else class="size-3.5 shrink-0" />
                  <span class="truncate font-mono text-xs">
                    {{ row.node.name }}{{ row.node.isDirectory ? "/" : "" }}
                  </span>
                  <span
                    v-if="row.node.entry && row.node.entry.kind === 'symlink'"
                    class="shrink-0 font-mono text-[10px] text-muted-foreground"
                  >
                    link to {{ row.node.entry.linkTarget }}
                  </span>
                  <span
                    v-if="row.node.entry && row.node.entry.encrypted"
                    class="shrink-0 text-[10px] text-muted-foreground"
                  >
                    encrypted
                  </span>
                </button>
              </td>
              <td class="px-3 py-1.5 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                {{ formatBytes(row.node.size) }}
              </td>
              <td
                class="hidden px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
              >
                <span v-if="row.node.isDirectory">
                  {{ count(row.node.fileCount, "file", "files") }}
                </span>
                <span v-else-if="row.node.entry">{{ ratioLabel(row.node.entry) }}</span>
              </td>
              <td
                class="hidden px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground md:table-cell"
              >
                {{ row.node.entry?.modified ?? "" }}
              </td>
              <td class="px-3 py-1.5 text-right">
                <Button
                  v-if="row.node.entry && !row.node.isDirectory && !row.node.entry.encrypted"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Download ${row.node.path}`"
                  @click="extractOne(row.node.entry)"
                >
                  <Download class="size-3.5" />
                </Button>
              </td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="5" class="px-3 py-6 text-center text-sm text-muted-foreground">
                {{ query ? "No entry matches that filter." : "This archive holds no entries." }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="hiddenRows > 0" class="text-xs text-muted-foreground">
        Showing the first {{ MAX_VISIBLE_ROWS.toLocaleString() }} rows.
        {{ count(hiddenRows, "more row is", "more rows are") }} hidden; narrow the filter to reach
        them.
      </p>

      <!-- Preview -->
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="min-w-0 truncate font-mono text-sm">
            {{ selected ? selected.path : "Preview" }}
          </span>
          <div v-if="selected" class="flex shrink-0 items-center gap-2">
            <CopyButton
              v-if="preview && preview.kind === 'text'"
              :text="preview.text ?? ''"
              label="Copy text"
              variant="outline"
            />
            <Button
              v-if="!selected.encrypted"
              variant="outline"
              size="sm"
              @click="extractOne(selected)"
            >
              <Download class="size-3.5" />
              Download
            </Button>
          </div>
        </div>

        <p
          v-if="selected && selected.unsafe"
          class="flex items-start gap-2 text-xs text-muted-foreground"
        >
          <FileWarning class="mt-0.5 size-3.5 shrink-0" />
          <span>
            This entry asked to be written to
            <code class="font-mono">{{ selected.rawPath }}</code
            >, outside the archive root. It is shown and saved as
            <code class="font-mono">{{ selected.path }}</code
            >.
          </span>
        </p>

        <EmptyState
          v-if="!selected"
          title="No entry selected"
          hint="Click a file in the tree to read it here. Text files show their first 64 KB and images render in place."
          icon="FileSearch"
        />
        <div v-else-if="preview && preview.kind === 'image'" class="flex justify-center">
          <img
            :src="preview.url"
            :alt="selected.path"
            class="max-h-96 max-w-full rounded-[8px] bg-card object-contain"
          />
        </div>
        <div v-else-if="preview && preview.kind === 'text'" class="flex flex-col gap-1">
          <pre
            class="max-h-96 overflow-auto rounded-[8px] bg-card p-3 font-mono text-xs whitespace-pre-wrap"
            >{{ preview.text }}</pre>
          <p v-if="preview.truncated" class="text-xs text-muted-foreground">
            Showing the first 64 KB of {{ formatBytes(preview.size) }}. Download the entry for the
            rest.
          </p>
        </div>
        <EmptyState
          v-else-if="preview && preview.kind === 'binary'"
          title="This entry is not text"
          :hint="`It holds ${formatBytes(preview.size)} of binary data. Download it to open it in the right application.`"
          icon="Binary"
        />
      </div>
    </template>
  </div>
</template>
