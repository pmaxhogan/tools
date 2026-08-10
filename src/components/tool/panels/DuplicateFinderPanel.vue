<script setup lang="ts">
/**
 * Bespoke panel for the duplicate finder.
 *
 * It sits inside FsShell, which owns the folder picker, the one scan, the
 * privacy line, and the whole write flow (plan, undo manifest, confirm,
 * execute, rescan). Everything below is the part that is specific to finding
 * duplicates:
 *
 *   - the plan line, which is the honest version of "this will take a while":
 *     how many files actually need reading out of how many the folder holds
 *   - the hashing pass, one candidate at a time through fs-access, with
 *     progress and a stop button, and files past the 256 MB ceiling reported
 *     as a size match that was never verified rather than silently dropped
 *   - the groups, each with a keeper you can change and an explicit tick
 *     before any of its files join a deletion
 *   - the deletion, which cannot be undone and says so in as many words
 *
 * No grouping rule lives here. Sizing, planning, hashing groups, keep
 * strategies and the suggested deletions all come from the pure logic layer in
 * src/tools/duplicate-finder/index.ts; this file renders what it returns.
 */
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { Search, Trash2, TriangleAlert } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import FsShell from "../FsShell.vue";
import {
  hashFile,
  readFileBytes,
  type DirectoryHandleWrapper,
  type ExecuteResult,
  type FsFileEntry,
  type FsScan,
  type WriteOp,
} from "@/lib/fs-access";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";

defineProps<{ meta: ToolMeta }>();

type DupeLogic = typeof import("@/tools/duplicate-finder/index");
type DuplicateGroup = import("@/tools/duplicate-finder/index").DuplicateGroup;
type HashPlan = import("@/tools/duplicate-finder/index").HashPlan;
type KeepStrategy = import("@/tools/duplicate-finder/index").KeepStrategy;

/** The slot props FsShell hands its controls slot. */
interface FsSlot {
  scan: FsScan | null;
  handle: DirectoryHandleWrapper;
  scanning: boolean;
  busy: boolean;
  rescan: () => Promise<void>;
  applyWrites: (ops: WriteOp[]) => Promise<ExecuteResult | null>;
}

/** Loaded on the first scan rather than on page load, then cached. */
let logicPromise: Promise<DupeLogic> | null = null;
function loadLogic(): Promise<DupeLogic> {
  logicPromise ??= import("@/tools/duplicate-finder/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<DupeLogic | null>(null);
const scan = shallowRef<FsScan | null>(null);
const plan = shallowRef<HashPlan | null>(null);

const hashing = ref(false);
const hashDone = ref(0);
const hashTotal = ref(0);
let hashAbort: { aborted: boolean } | null = null;

/** Content matched groups, then the zero byte group when there is one. */
const groups = shallowRef<DuplicateGroup[]>([]);
const hasSearched = ref(false);

/** Candidates whose hash failed, usually a file that moved mid run. */
const failedHashes = ref<{ path: string; reason: string }[]>([]);

const keepStrategy = ref<KeepStrategy>("shallowest");
/** Keeper paths a person chose by hand, keyed by group hash. */
const keeperOverrides = ref<Record<string, string>>({});
/** Group hashes ticked for deletion. Nothing is ticked by default. */
const chosen = ref<Set<string>>(new Set());
const acknowledged = ref(false);

const showPreviews = ref(false);
const thumbs = ref<Map<string, string>>(new Map());

const showAllGroups = ref(false);
const GROUP_CAP = 60;

const reclaimed = ref<{ files: number; bytes: number; failed: number } | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const keepSpec: SelectOptionSpec = {
  kind: "select",
  id: "dupe-keep",
  label: "Keep which copy",
  default: "shallowest",
  options: [
    {
      value: "shallowest",
      label: "Closest to the top folder",
      synonyms: ["nearest root", "top level", "least nested", "closest to root", "highest up"],
    },
    {
      value: "first-alpha",
      label: "First by path (A to Z)",
      synonyms: ["alphabetical", "a to z", "first alphabetically", "name order", "sorted by name"],
    },
    {
      value: "shortest-path",
      label: "Shortest path",
      synonyms: ["shortest", "fewest characters", "short name", "least depth"],
    },
    {
      value: "newest",
      label: "Newest file",
      synonyms: ["most recent", "latest", "newest modified", "recently changed"],
    },
    {
      value: "oldest",
      label: "Oldest file",
      synonyms: ["earliest", "least recent", "oldest modified", "first created"],
    },
  ],
};

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function modifiedOn(entry: FsFileEntry): string {
  if (!entry.lastModified) return "date unknown";
  return new Date(entry.lastModified).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash;
}

function setError(e: unknown) {
  if (e instanceof ToolError) error.value = { message: e.message, fix: e.fix };
  else error.value = { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* previews                                                          */
/* ---------------------------------------------------------------- */

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const THUMB_MAX_BYTES = 8 * 1024 * 1024;
const THUMB_LIMIT = 60;

function imageType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

function revokeThumbs() {
  for (const url of thumbs.value.values()) URL.revokeObjectURL(url);
  thumbs.value = new Map();
}

/**
 * Previews are off until asked for, because they mean reading file bytes again
 * and the whole design of this tool is about not reading files it does not have
 * to. Only images, only small ones, only the groups on screen.
 */
async function loadThumbs(handle: DirectoryHandleWrapper) {
  const wanted: FsFileEntry[] = [];
  for (const group of visibleGroups.value) {
    for (const entry of group.files) {
      if (wanted.length >= THUMB_LIMIT) break;
      if (!imageType(entry.path)) continue;
      if (entry.size > THUMB_MAX_BYTES || entry.size === 0) continue;
      if (thumbs.value.has(entry.path)) continue;
      wanted.push(entry);
    }
  }

  for (const entry of wanted) {
    if (!showPreviews.value) return;
    try {
      const bytes = await readFileBytes(handle, entry.path);
      // readFileBytes's return type only promises ArrayBufferLike; Blob wants a
      // concrete ArrayBuffer, so this copies rather than asserting it is one.
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: imageType(entry.path) as string }),
      );
      const next = new Map(thumbs.value);
      next.set(entry.path, url);
      thumbs.value = next;
    } catch {
      // A missing preview is a nicety, not a failure worth a message.
    }
  }
}

function togglePreviews(handle: DirectoryHandleWrapper) {
  showPreviews.value = !showPreviews.value;
  if (showPreviews.value) loadThumbs(handle);
  else revokeThumbs();
}

/* ---------------------------------------------------------------- */
/* scanning and planning                                             */
/* ---------------------------------------------------------------- */

function resetResults() {
  stopHashing();
  groups.value = [];
  hasSearched.value = false;
  failedHashes.value = [];
  keeperOverrides.value = {};
  chosen.value = new Set();
  acknowledged.value = false;
  showAllGroups.value = false;
  showPreviews.value = false;
  revokeThumbs();
  hashDone.value = 0;
  hashTotal.value = 0;
}

async function onScan(next: FsScan) {
  scan.value = next;
  resetResults();
  reclaimed.value = null;
  error.value = null;
  try {
    const mod = await loadLogic();
    logic.value = mod;
    plan.value = mod.planHashing(next);
  } catch (e) {
    plan.value = null;
    setError(e);
  }
}

const planLine = computed(() => {
  const mod = logic.value;
  const current = plan.value;
  if (!mod || !current) return "";
  return mod.describePlan(current);
});

/* ---------------------------------------------------------------- */
/* hashing                                                           */
/* ---------------------------------------------------------------- */

function stopHashing() {
  if (hashAbort) hashAbort.aborted = true;
}

async function findDuplicates(handle: DirectoryHandleWrapper) {
  const current = plan.value;
  const currentScan = scan.value;
  if (!current || !currentScan || hashing.value) return;

  error.value = null;
  reclaimed.value = null;
  failedHashes.value = [];
  keeperOverrides.value = {};
  chosen.value = new Set();
  acknowledged.value = false;
  showAllGroups.value = false;
  revokeThumbs();

  const abort = { aborted: false };
  hashAbort = abort;
  hashing.value = true;
  hashDone.value = 0;
  hashTotal.value = current.files.length;

  const hashed: { entry: FsFileEntry; hash: string }[] = [];
  const failures: { path: string; reason: string }[] = [];

  try {
    const mod = logic.value ?? (await loadLogic());
    logic.value = mod;

    for (const entry of current.files) {
      if (abort.aborted) break;
      try {
        hashed.push({ entry, hash: await hashFile(handle, entry.path) });
      } catch (e) {
        failures.push({
          path: entry.path,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      hashDone.value += 1;
      // Hand the frame back now and then so the progress line actually moves
      // on a folder where every candidate is small and reads instantly.
      if (hashDone.value % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const found = mod.groupByHash(hashed);
    const empties = mod.emptyFileGroup(currentScan);
    groups.value = empties ? [...found, empties] : found;
    failedHashes.value = failures;
    hasSearched.value = true;
  } catch (e) {
    setError(e);
  } finally {
    hashing.value = false;
    hashAbort = null;
  }
}

/* ---------------------------------------------------------------- */
/* groups, keepers, selection                                        */
/* ---------------------------------------------------------------- */

/** Groups a deletion can come from: the zero byte group is never one of them. */
const realGroups = computed(() =>
  groups.value.filter((group) => group.hash !== logic.value?.EMPTY_FILE_HASH),
);

const emptyGroup = computed(
  () => groups.value.find((group) => group.hash === logic.value?.EMPTY_FILE_HASH) ?? null,
);

const visibleGroups = computed(() =>
  showAllGroups.value ? realGroups.value : realGroups.value.slice(0, GROUP_CAP),
);

const summary = computed(() => (logic.value ? logic.value.summarize(realGroups.value) : null));

/** Which file in a group survives: the hand pick when there is one, else the rule. */
function keeperPath(group: DuplicateGroup): string {
  const override = keeperOverrides.value[group.hash];
  if (override && group.files.some((file) => file.path === override)) return override;
  const mod = logic.value;
  if (!mod) return group.files[0]?.path ?? "";
  try {
    return mod.chooseKeeper(group, keepStrategy.value).path;
  } catch {
    return group.files[0]?.path ?? "";
  }
}

function setKeeper(group: DuplicateGroup, path: string) {
  keeperOverrides.value = { ...keeperOverrides.value, [group.hash]: path };
}

function isChosen(group: DuplicateGroup): boolean {
  return chosen.value.has(group.hash);
}

function toggleGroup(group: DuplicateGroup, on: boolean) {
  const next = new Set(chosen.value);
  if (on) next.add(group.hash);
  else next.delete(group.hash);
  chosen.value = next;
  acknowledged.value = false;
}

function chooseAll() {
  chosen.value = new Set(realGroups.value.map((group) => group.hash));
  acknowledged.value = false;
}

function chooseNone() {
  chosen.value = new Set();
  acknowledged.value = false;
}

function onStrategyChange(value: unknown) {
  keepStrategy.value = String(value) as KeepStrategy;
  // A different rule means a different keeper, so hand picks would silently
  // fight the new rule. Clear them and say nothing: the radios move visibly.
  keeperOverrides.value = {};
  acknowledged.value = false;
}

/* ---------------------------------------------------------------- */
/* deletion                                                          */
/* ---------------------------------------------------------------- */

const deletionOps = computed<WriteOp[]>(() => {
  const mod = logic.value;
  if (!mod) return [];
  const ops: WriteOp[] = [];
  for (const group of realGroups.value) {
    if (!chosen.value.has(group.hash)) continue;
    const override = keeperOverrides.value[group.hash];
    if (override && group.files.some((file) => file.path === override)) {
      for (const file of group.files) {
        if (file.path !== override) ops.push({ op: "delete", path: file.path });
      }
    } else {
      try {
        ops.push(...mod.chooseDeletions(group, keepStrategy.value));
      } catch {
        // A group that cannot suggest a keeper contributes nothing.
      }
    }
  }
  return ops;
});

const deletionBytes = computed(() => {
  const sizes = new Map<string, number>();
  for (const group of realGroups.value) {
    for (const file of group.files) sizes.set(file.path, file.size);
  }
  let total = 0;
  for (const op of deletionOps.value) {
    if (op.op === "delete") total += sizes.get(op.path) ?? 0;
  }
  return total;
});

async function deleteChosen(slot: FsSlot) {
  const ops = deletionOps.value;
  if (!ops.length || !acknowledged.value) return;

  // The rescan that follows a write wipes every group, so the sizes needed to
  // report what was reclaimed have to be captured before the call, not after.
  const sizes = new Map<string, number>();
  for (const group of realGroups.value) {
    for (const file of group.files) sizes.set(file.path, file.size);
  }

  error.value = null;
  const result = await slot.applyWrites(ops);
  // null is a cancelled confirmation, which needs no message of its own.
  if (!result) return;

  let bytes = 0;
  let files = 0;
  for (const op of result.done) {
    if (op.op !== "delete") continue;
    files += 1;
    bytes += sizes.get(op.path) ?? 0;
  }
  reclaimed.value = { files, bytes, failed: result.failed.length };
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onBeforeUnmount(() => {
  stopHashing();
  revokeThumbs();
});
</script>

<template>
  <FsShell :meta="meta" mode="readwrite" @scan="onScan">
    <template #empty>
      <p class="text-sm text-muted-foreground">
        Pick a folder and this looks for files that hold exactly the same bytes anywhere inside it,
        whatever they are called. It reads names and sizes first, then hashes only the files that
        share a size with another file, because two files cannot hold the same contents unless they
        hold the same number of bytes. Nothing is deleted until you choose which copy to keep and
        confirm.
      </p>
    </template>

    <template #controls="fs">
      <!-- The plan: the honest version of how much work this will be -->
      <div
        v-if="plan"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <p class="text-sm">
          {{ planLine }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            :disabled="
              hashing || fs.busy || (plan.candidateCount === 0 && plan.emptyFiles.length < 2)
            "
            @click="findDuplicates(fs.handle)"
          >
            <Search class="size-3.5" />
            Find duplicates
          </Button>
          <Button v-if="hashing" variant="outline" size="sm" @click="stopHashing"> Stop </Button>
        </div>

        <div v-if="hashing" class="flex flex-col gap-2">
          <div
            class="h-2 overflow-hidden rounded-full bg-card"
            role="progressbar"
            :aria-valuenow="hashTotal ? Math.round((hashDone / hashTotal) * 100) : 0"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Hashing candidate files"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              :style="{ width: `${hashTotal ? (hashDone / hashTotal) * 100 : 0}%` }"
            />
          </div>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            Hashing {{ hashDone.toLocaleString() }} of {{ hashTotal.toLocaleString() }}
          </p>
        </div>

        <p v-if="plan.unreadable.length" class="text-xs text-muted-foreground">
          {{ plural(plan.unreadable.length, "file", "files") }} could not be opened during the scan,
          so nothing is known about their contents. They are left out of every group rather than
          treated as empty.
        </p>
      </div>

      <!-- Results -->
      <template v-if="hasSearched">
        <div
          v-if="summary && summary.groupCount > 0"
          class="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        >
          <span class="text-sm font-medium">
            {{ plural(summary.groupCount, "set of duplicates", "sets of duplicates") }}
          </span>
          <span class="text-sm text-muted-foreground tabular-nums">
            {{ plural(summary.duplicateFiles, "extra copy", "extra copies") }}
          </span>
          <span class="text-sm text-muted-foreground tabular-nums">
            {{ summary.reclaimableHuman }} reclaimable
          </span>
        </div>

        <p
          v-else
          role="status"
          class="rounded-[10px] bg-secondary px-3 py-2 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
        >
          No two files in this folder hold the same bytes. Every candidate that shared a size turned
          out to have different contents, which is exactly what a size collision usually is.
        </p>

        <!-- Keep rule and view options -->
        <div
          v-if="summary && summary.groupCount > 0"
          class="flex flex-wrap items-end gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex w-56 flex-col gap-1.5">
            <Label for="dupe-keep" class="text-xs text-muted-foreground">Keep which copy</Label>
            <SearchableSelect
              id="dupe-keep"
              :spec="keepSpec"
              :model-value="keepStrategy"
              @update:model-value="onStrategyChange"
            />
          </div>
          <div class="flex flex-wrap items-center gap-2 pb-0.5">
            <Button variant="outline" size="sm" @click="chooseAll"> Tick every set </Button>
            <Button variant="ghost" size="sm" @click="chooseNone"> Clear ticks </Button>
            <Button variant="ghost" size="sm" @click="togglePreviews(fs.handle)">
              {{ showPreviews ? "Hide previews" : "Show image previews" }}
            </Button>
          </div>
        </div>

        <!-- One card per set -->
        <div
          v-for="group in visibleGroups"
          :key="group.hash"
          class="flex flex-col gap-2 rounded-[10px] border bg-card p-3"
          :class="isChosen(group) ? 'border-destructive/50' : ''"
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium tabular-nums">
                {{ plural(group.files.length, "copy", "copies") }} ·
                {{ formatBytes(group.size) }} each · {{ formatBytes(group.wastedBytes) }} wasted
              </p>
              <p class="truncate font-mono text-xs text-muted-foreground">
                sha256 {{ shortHash(group.hash) }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Checkbox
                :id="`dupe-pick-${group.hash}`"
                :model-value="isChosen(group)"
                @update:model-value="(v) => toggleGroup(group, Boolean(v))"
              />
              <Label :for="`dupe-pick-${group.hash}`" class="text-xs text-muted-foreground">
                Delete the other {{ group.files.length - 1 }} in this set
              </Label>
            </div>
          </div>

          <ul class="flex flex-col gap-1">
            <li
              v-for="file in group.files"
              :key="file.path"
              class="flex items-center gap-2 rounded-[6px] px-1 py-1"
              :class="isChosen(group) && file.path !== keeperPath(group) ? 'bg-destructive/5' : ''"
            >
              <input
                :id="`keep-${group.hash}-${file.path}`"
                type="radio"
                class="size-4 shrink-0 accent-[var(--primary)]"
                :name="`keep-${group.hash}`"
                :value="file.path"
                :checked="keeperPath(group) === file.path"
                @change="setKeeper(group, file.path)"
              />
              <img
                v-if="showPreviews && thumbs.get(file.path)"
                :src="thumbs.get(file.path)"
                :alt="`Preview of ${file.path}`"
                class="size-8 shrink-0 rounded-[4px] border object-cover"
                loading="lazy"
              />
              <label
                :for="`keep-${group.hash}-${file.path}`"
                class="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs"
                :title="file.path"
              >
                {{ file.path }}
              </label>
              <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                {{ modifiedOn(file) }}
              </span>
              <span
                class="w-14 shrink-0 text-right text-xs tabular-nums"
                :class="
                  keeperPath(group) === file.path
                    ? 'text-[var(--positive)]'
                    : 'text-muted-foreground'
                "
              >
                {{ keeperPath(group) === file.path ? "keep" : "delete" }}
              </span>
            </li>
          </ul>
        </div>

        <div
          v-if="!showAllGroups && realGroups.length > visibleGroups.length"
          class="flex justify-center"
        >
          <Button variant="outline" size="sm" @click="showAllGroups = true">
            Show all {{ realGroups.length.toLocaleString() }} sets
          </Button>
        </div>

        <!-- Zero byte files -->
        <div
          v-if="emptyGroup"
          class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        >
          <p class="text-sm font-medium">
            {{ plural(emptyGroup.files.length, "empty file", "empty files") }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ emptyGroup.note }}
          </p>
          <ul class="mt-2 flex flex-col gap-0.5">
            <li
              v-for="file in emptyGroup.files.slice(0, 20)"
              :key="file.path"
              class="truncate font-mono text-xs text-muted-foreground"
            >
              {{ file.path }}
            </li>
          </ul>
          <p v-if="emptyGroup.files.length > 20" class="mt-1 text-xs text-muted-foreground">
            and {{ plural(emptyGroup.files.length - 20, "more", "more") }}.
          </p>
        </div>

        <!-- Matched by size only -->
        <div
          v-if="plan && plan.sizeOnlyGroups.length"
          class="rounded-[10px] border border-[var(--input)] bg-secondary px-3 py-2"
        >
          <p class="text-sm font-medium">
            {{ plural(plan.sizeOnlyGroups.length, "set matched", "sets matched") }} by size only
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            These files are past the 256 MB hashing limit, so their contents were never compared.
            Hashing in a browser has to hold a whole file in memory at once. Matching sizes are a
            hint, not proof, so nothing here is offered for deletion: check these by hand.
          </p>
          <ul class="mt-2 flex flex-col gap-0.5">
            <li
              v-for="(sizeGroup, i) in plan.sizeOnlyGroups.slice(0, 10)"
              :key="i"
              class="font-mono text-xs text-muted-foreground"
            >
              {{ formatBytes(sizeGroup[0]?.size ?? 0) }}:
              {{ sizeGroup.map((f) => f.path).join(", ") }}
            </li>
          </ul>
        </div>

        <!-- Hashes that failed -->
        <div v-if="failedHashes.length" class="rounded-[10px] bg-secondary px-3 py-2">
          <p class="text-sm font-medium">
            {{ plural(failedHashes.length, "file", "files") }} could not be read
          </p>
          <ul class="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            <li v-for="failure in failedHashes.slice(0, 8)" :key="failure.path">
              {{ failure.path }}: {{ failure.reason }}
            </li>
          </ul>
        </div>

        <!-- Deletion -->
        <div
          v-if="deletionOps.length"
          class="flex flex-col gap-3 rounded-[10px] border border-destructive/50 bg-destructive/5 p-3"
        >
          <div class="flex gap-2">
            <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
            <div class="text-sm">
              <p class="font-medium text-destructive">Deleting cannot be undone.</p>
              <p class="mt-1 text-muted-foreground">
                This removes {{ plural(deletionOps.length, "file", "files") }} and frees about
                {{ formatBytes(deletionBytes) }}. The bytes are gone at that point: the undo file
                you can download on the next screen only records which paths were deleted, it does
                not hold their contents and cannot bring them back. Files removed this way do not go
                to the recycle bin or trash. Read the list on the confirm screen before you accept
                it.
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Checkbox
              id="dupe-ack"
              :model-value="acknowledged"
              @update:model-value="(v) => (acknowledged = Boolean(v))"
            />
            <Label for="dupe-ack" class="text-sm">
              I understand these files cannot be recovered.
            </Label>
          </div>

          <Button
            class="self-start"
            variant="destructive"
            size="sm"
            :disabled="!acknowledged || fs.busy || hashing"
            @click="deleteChosen(fs as unknown as FsSlot)"
          >
            <Trash2 class="size-3.5" />
            Delete {{ plural(deletionOps.length, "duplicate", "duplicates") }}
          </Button>
        </div>
      </template>

      <!-- What was reclaimed -->
      <div
        v-if="reclaimed"
        role="status"
        class="rounded-[10px] bg-secondary px-3 py-2 text-sm shadow-[var(--sh-inset)]"
      >
        <p class="font-medium">
          {{ plural(reclaimed.files, "file deleted", "files deleted") }},
          {{ formatBytes(reclaimed.bytes) }} reclaimed.
        </p>
        <p v-if="reclaimed.failed" class="mt-1 text-xs text-muted-foreground">
          {{ plural(reclaimed.failed, "file", "files") }} could not be deleted and were left alone.
          The folder has been scanned again, so run the search once more to see what is left.
        </p>
        <p v-else class="mt-1 text-xs text-muted-foreground">
          The folder has been scanned again. Run the search once more if you want to check what is
          left.
        </p>
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
  </FsShell>
</template>
