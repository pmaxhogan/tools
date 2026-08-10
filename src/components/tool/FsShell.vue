<script setup lang="ts">
/**
 * FsShell: the island every folder tool renders inside (Phase 5).
 *
 * It owns the parts that are identical for bulk rename, the duplicate finder,
 * folder diff and the batch processor, so a tool panel only has to render its
 * own controls and hand back a list of changes:
 *
 *   - picking a folder, inside a real click handler, which is the only place a
 *     browser will open the picker
 *   - one scan into plain data (`FsScan`), with a live count while it runs,
 *     plus rescan and clear
 *   - the folder summary line: name, file count, total size
 *   - the standing privacy line, and for a writing tool the warning strip
 *   - the whole write safety flow: plan, summary, undo manifest download,
 *     explicit confirm, execution with progress, then a fresh scan
 *
 * Contract for a tool panel:
 *
 *   <FsShell
 *     :meta="meta"
 *     mode="readwrite"
 *     @scan="onScan"
 *   >
 *     <template #empty> ...what to say before a folder is chosen... </template>
 *     <template #controls="{ scan, handle, rescan, applyWrites }">
 *       ...your controls, and a button that calls applyWrites(ops)...
 *     </template>
 *   </FsShell>
 *
 * Props
 *   meta        ToolMeta            the tool's metadata, used for copy
 *   mode        'read'|'readwrite'  what the folder is opened for. 'readwrite'
 *                                   adds the warning strip and is required
 *                                   before any write flow will run.
 *   scanOnPick  boolean             scan as soon as a folder is chosen
 *                                   (default true). Set false for a tool that
 *                                   wants to configure the scan first.
 *
 * Slots
 *   empty     rendered before a folder is chosen
 *   controls  rendered once a folder is chosen, with slot props:
 *     scan          FsScan | null            the current scan
 *     handle        DirectoryHandleWrapper   pass to readFileBytes, hashFile…
 *     scanning      boolean                  a walk is in progress
 *     busy          boolean                  a write batch is in progress
 *     rescan        () => Promise<void>      walk the folder again
 *     confirmWrites (ops) => Promise<boolean>
 *     applyWrites   (ops, opts?) => Promise<ExecuteResult | null>
 *
 * Events
 *   scan    FsScan                  a walk finished
 *   picked  DirectoryHandleWrapper  a folder was chosen
 *
 * The write path deliberately has one door. `applyWrites` is what a tool
 * should call: it plans the ops against the current scan, shows the confirm
 * panel (op counts, the first 20 changes, conflicts, an undo manifest to
 * download), waits for an explicit confirm, executes, and rescans. A tool that
 * wants to run execution itself can call `confirmWrites` and then
 * `executeWriteOps` from `@/lib/fs-access` with the plan it builds. Neither
 * path can write without a manifest existing first.
 *
 * Rendering is inert on the server: the capability check runs on mount, and
 * PanelHost gates unsupported browsers through CapabilityGate first (the tool
 * declares `requires: ['fs-access']`).
 */
import { computed, onMounted, ref, shallowRef } from "vue";
import { Download, FolderOpen, RotateCw, TriangleAlert } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  executeWriteOps,
  isFsAccessSupported,
  pickDirectory,
  planWrites,
  scanDirectory,
  undoManifestFileName,
  undoManifestToJson,
  type DirectoryHandleWrapper,
  type ExecuteOptions,
  type ExecuteResult,
  type FsScan,
  type WriteOp,
  type WritePlan,
} from "@/lib/fs-access";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    meta: ToolMeta;
    mode: "read" | "readwrite";
    scanOnPick?: boolean;
  }>(),
  { scanOnPick: true },
);

const emit = defineEmits<{
  scan: [scan: FsScan];
  picked: [handle: DirectoryHandleWrapper];
}>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps the capability check off the server. */
const supported = ref(false);

const dir = shallowRef<DirectoryHandleWrapper | null>(null);
const scan = shallowRef<FsScan | null>(null);

const scanning = ref(false);
const scanCount = ref(0);
const scanAbort = shallowRef<{ aborted: boolean } | null>(null);

const busy = ref(false);
const writeDone = ref(0);
const writeTotal = ref(0);

/** The plan being reviewed. Non null exactly while the confirm panel is up. */
const pending = shallowRef<WritePlan | null>(null);
/** The plan the visitor confirmed, held while it executes. */
const approved = shallowRef<WritePlan | null>(null);
const lastResult = shallowRef<ExecuteResult | null>(null);

const error = ref<{ message: string; fix?: string } | null>(null);

let resolveConfirm: ((ok: boolean) => void) | null = null;

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const summary = computed(() => {
  const current = scan.value;
  if (!current) return "";
  const parts = [plural(current.fileCount, "file", "files"), formatBytes(current.totalBytes)];
  if (current.directories.length) {
    parts.splice(1, 0, plural(current.directories.length, "folder", "folders"));
  }
  return parts.join(" · ");
});

/** One change, in a line a person can check. */
function describeOp(op: WriteOp): string {
  if (op.op === "rename") return `Rename  ${op.from}  ->  ${op.to}`;
  if (op.op === "writeFile") {
    const size = typeof op.data === "string" ? op.data.length : op.data.byteLength;
    return `Write   ${op.path}  (${formatBytes(size)})`;
  }
  return `Delete  ${op.path}`;
}

const pendingCounts = computed(() => {
  const plan = pending.value;
  if (!plan) return [] as string[];
  const counts = { rename: 0, writeFile: 0, delete: 0 };
  for (const op of plan.ops) counts[op.op] += 1;
  const out: string[] = [];
  if (counts.rename) out.push(plural(counts.rename, "rename", "renames"));
  if (counts.writeFile) out.push(plural(counts.writeFile, "file written", "files written"));
  if (counts.delete) out.push(plural(counts.delete, "deletion", "deletions"));
  return out;
});

const pendingPreview = computed(() => pending.value?.ops.slice(0, 20).map(describeOp) ?? []);

const pendingExtra = computed(() => Math.max(0, (pending.value?.ops.length ?? 0) - 20));

const resultLine = computed(() => {
  const result = lastResult.value;
  if (!result) return "";
  const applied = result.dryRun
    ? `${plural(result.done.length, "change", "changes")} checked, nothing written`
    : `${plural(result.done.length, "change", "changes")} applied`;
  const skipped = result.failed.length
    ? `, ${plural(result.failed.length, "change", "changes")} skipped`
    : "";
  const stopped = result.stopped ? ", stopped early" : "";
  return `${applied}${skipped}${stopped}.`;
});

/* ---------------------------------------------------------------- */
/* errors                                                            */
/* ---------------------------------------------------------------- */

function setError(e: unknown) {
  if (e instanceof ToolError) error.value = { message: e.message, fix: e.fix };
  else error.value = { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* pick and scan                                                     */
/* ---------------------------------------------------------------- */

async function pick() {
  if (!supported.value || scanning.value || busy.value) return;
  error.value = null;
  try {
    const picked = await pickDirectory(props.mode);
    // null is the visitor closing the dialog, which is not worth a message.
    if (!picked) return;
    dir.value = picked;
    scan.value = null;
    lastResult.value = null;
    emit("picked", picked);
    if (props.scanOnPick) await rescan();
  } catch (e) {
    setError(e);
  }
}

async function rescan() {
  const current = dir.value;
  if (!current || scanning.value) return;
  scanning.value = true;
  scanCount.value = 0;
  error.value = null;
  const abort = { aborted: false };
  scanAbort.value = abort;
  try {
    const result = await scanDirectory(current, {
      signal: abort,
      onProgress: (count) => {
        scanCount.value = count;
      },
    });
    scan.value = result;
    emit("scan", result);
  } catch (e) {
    setError(e);
  } finally {
    scanning.value = false;
    scanAbort.value = null;
  }
}

function stopScan() {
  if (scanAbort.value) scanAbort.value.aborted = true;
}

function clear() {
  stopScan();
  dir.value = null;
  scan.value = null;
  lastResult.value = null;
  pending.value = null;
  approved.value = null;
  error.value = null;
  resolveConfirm?.(false);
  resolveConfirm = null;
}

/* ---------------------------------------------------------------- */
/* writes                                                            */
/* ---------------------------------------------------------------- */

/**
 * Plan a batch and ask for a confirmation, returning true only when the
 * visitor pressed Confirm. The plan stays around afterwards so `applyWrites`
 * executes exactly what was shown, rather than planning a second time.
 */
function confirmWrites(ops: WriteOp[]): Promise<boolean> {
  if (props.mode !== "readwrite") {
    setError(
      new ToolError(
        "fs-read-only",
        "This tool opened the folder for reading only, so it cannot change it.",
        "Reload the page and choose the folder again.",
      ),
    );
    return Promise.resolve(false);
  }
  if (!dir.value) return Promise.resolve(false);
  if (!ops.length) return Promise.resolve(false);

  error.value = null;
  approved.value = null;
  try {
    pending.value = planWrites(ops, {
      scan: scan.value ?? undefined,
      root: dir.value.name,
      tool: props.meta.slug,
    });
  } catch (e) {
    setError(e);
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    resolveConfirm = resolve;
  });
}

function cancelWrites() {
  pending.value = null;
  approved.value = null;
  resolveConfirm?.(false);
  resolveConfirm = null;
}

/**
 * Move the plan from "under review" to "approved". The review panel closes on
 * `pending` going null, so a tool that runs execution itself still gets the
 * panel dismissed the moment it is confirmed.
 */
function acceptWrites() {
  approved.value = pending.value;
  pending.value = null;
  resolveConfirm?.(true);
  resolveConfirm = null;
}

/**
 * The path a tool should use: confirm, execute, rescan. Returns null when the
 * visitor cancelled or when something stopped the batch before it started.
 */
async function applyWrites(
  ops: WriteOp[],
  opts: ExecuteOptions = {},
): Promise<ExecuteResult | null> {
  const ok = await confirmWrites(ops);
  const plan = approved.value;
  if (!ok || !plan || !dir.value) {
    approved.value = null;
    return null;
  }

  busy.value = true;
  writeDone.value = 0;
  writeTotal.value = plan.ops.length;
  try {
    const result = await executeWriteOps(dir.value, plan, {
      ...opts,
      onProgress: (done, total, op) => {
        writeDone.value = done;
        writeTotal.value = total;
        opts.onProgress?.(done, total, op);
      },
    });
    lastResult.value = result;
    return result;
  } catch (e) {
    setError(e);
    return null;
  } finally {
    busy.value = false;
    approved.value = null;
    // The folder is not what it was, so every path a tool is holding is stale.
    if (!opts.dryRun) await rescan();
  }
}

/**
 * Save the undo file. Offered before a batch runs, from the confirm panel, and
 * again afterwards from the result box for anyone who skipped it the first time.
 */
function downloadManifest() {
  const manifest =
    pending.value?.undoManifest ?? approved.value?.undoManifest ?? lastResult.value?.undoManifest;
  if (!manifest) return;
  const blob = new Blob([undoManifestToJson(manifest)], { type: "application/json" });
  downloadBlob(blob, undoManifestFileName(manifest));
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  supported.value = isFsAccessSupported();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Unsupported: PanelHost normally catches this first, so this is a
         quiet fallback rather than the real message. -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">Checking folder access.</p>
      <p class="mt-1 text-muted-foreground">
        {{ meta.name }} opens a folder in place, which needs the File System Access API. It is
        available in Chromium browsers such as Chrome, Edge, Brave and Opera on desktop.
      </p>
    </div>

    <template v-else>
      <!-- Write warning -->
      <div
        v-if="mode === 'readwrite'"
        class="flex gap-2 rounded-lg border border-[var(--input)] bg-secondary px-3 py-2 text-sm"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
        <p class="text-muted-foreground">
          This tool can change the folder you pick: it renames, writes and deletes files in place.
          Nothing happens until you review the exact list of changes and confirm, and you can
          download an undo file first.
        </p>
      </div>

      <!-- Folder -->
      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Folder
          </span>
          <div class="flex flex-wrap items-center gap-1">
            <Button
              v-if="dir"
              variant="ghost"
              size="sm"
              :disabled="scanning || busy"
              @click="rescan"
            >
              <RotateCw class="size-3.5" />
              Rescan
            </Button>
            <Button v-if="dir" variant="ghost" size="sm" :disabled="busy" @click="clear">
              Clear
            </Button>
            <Button variant="ghost" size="sm" :disabled="scanning || busy" @click="pick">
              <FolderOpen class="size-3.5" />
              {{ dir ? "Choose another folder" : "Choose a folder" }}
            </Button>
          </div>
        </div>

        <div v-if="dir" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-2 pb-3">
          <span class="font-mono text-sm font-medium">{{ dir.name }}</span>
          <span v-if="summary" class="text-xs text-muted-foreground tabular-nums">{{
            summary
          }}</span>
          <span v-else-if="!scanning" class="text-xs text-muted-foreground">not scanned yet</span>
        </div>

        <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
          Pick a folder to get started. Nothing is uploaded and nothing is copied anywhere: the
          folder is opened in place, in this tab.
        </p>
      </div>

      <!-- Standing privacy line: stays put once a folder is chosen, which is
           exactly when someone wonders where their files are going. -->
      <p class="text-xs text-muted-foreground">
        The folder is read in this tab only: your files and inputs never leave your device.
      </p>

      <!-- Scan progress -->
      <div v-if="scanning" class="flex flex-wrap items-center gap-3">
        <span role="status" class="font-mono text-xs text-muted-foreground tabular-nums">
          Reading folder… {{ scanCount.toLocaleString() }} items
        </span>
        <Button variant="outline" size="sm" @click="stopScan"> Stop </Button>
      </div>

      <!-- Truncation notes -->
      <p v-if="scan?.truncated" role="status" class="text-xs text-muted-foreground">
        This folder holds more than the scan limit, so only the first
        {{ scan.entries.length.toLocaleString() }} files were read. Work on a smaller folder for a
        complete result.
      </p>
      <p v-if="scan?.depthCapped" role="status" class="text-xs text-muted-foreground">
        Some folders were nested deeper than 64 levels and were left alone.
      </p>

      <!-- Tool controls -->
      <slot
        v-if="dir && !scanning"
        name="controls"
        :scan="scan"
        :handle="dir"
        :scanning="scanning"
        :busy="busy"
        :rescan="rescan"
        :confirm-writes="confirmWrites"
        :apply-writes="applyWrites"
      />
      <slot v-else-if="!dir" name="empty" />

      <!-- Confirm panel: the one door every write goes through -->
      <div
        v-if="pending"
        role="group"
        aria-label="Review changes"
        class="flex flex-col gap-3 rounded-[10px] border border-[var(--input)] bg-secondary p-3"
      >
        <div>
          <p class="text-sm font-medium">
            Review {{ plural(pending.ops.length, "change", "changes") }} to {{ dir?.name }}
          </p>
          <p v-if="pendingCounts.length" class="mt-1 text-xs text-muted-foreground">
            {{ pendingCounts.join(", ") }}.
          </p>
        </div>

        <div
          v-if="pending.conflicts.length"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">
            {{ plural(pending.conflicts.length, "change", "changes") }} will be skipped.
          </p>
          <ul class="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            <li v-for="issue in pending.conflicts.slice(0, 5)" :key="issue.index">
              {{ issue.reason }}
            </li>
          </ul>
        </div>

        <div v-if="pending.irreversible.length" class="text-xs text-muted-foreground">
          <p v-for="note in pending.undoManifest.notes" :key="note">
            {{ note }}
          </p>
        </div>

        <pre
          class="max-h-56 overflow-auto rounded-[8px] bg-background p-2 font-mono text-xs whitespace-pre text-muted-foreground"
          >{{ pendingPreview.join("\n") }}</pre>
        <p v-if="pendingExtra" class="text-xs text-muted-foreground">
          and {{ plural(pendingExtra, "more change", "more changes") }}.
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" @click="acceptWrites"> Confirm and apply </Button>
          <Button variant="outline" size="sm" @click="cancelWrites"> Cancel </Button>
          <Button variant="ghost" size="sm" @click="downloadManifest">
            <Download class="size-3.5" />
            Download undo file
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          The undo file lists the changes that put this folder back the way it was. Download it
          before you apply anything: it is the only record, and it stays on your device.
        </p>
      </div>

      <!-- Write progress -->
      <div v-if="busy" class="flex flex-col gap-2">
        <div
          class="h-2 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          :aria-valuenow="writeTotal ? Math.round((writeDone / writeTotal) * 100) : 0"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="Applying changes"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
            :style="{ width: `${writeTotal ? (writeDone / writeTotal) * 100 : 0}%` }"
          />
        </div>
        <p class="font-mono text-xs text-muted-foreground tabular-nums">
          Applying {{ writeDone }} of {{ writeTotal }}
        </p>
      </div>

      <!-- Result -->
      <div
        v-if="lastResult && !busy"
        role="status"
        class="flex flex-col gap-2 rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
      >
        <p class="font-medium">
          {{ resultLine }}
        </p>
        <ul v-if="lastResult.failed.length" class="list-disc pl-4 text-xs text-muted-foreground">
          <li v-for="(failure, i) in lastResult.failed.slice(0, 10)" :key="i">
            {{ describeOp(failure.op) }}: {{ failure.error }}
          </li>
        </ul>
        <Button class="self-start" variant="ghost" size="sm" @click="downloadManifest">
          <Download class="size-3.5" />
          Download undo file
        </Button>
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
    </template>
  </div>
</template>
