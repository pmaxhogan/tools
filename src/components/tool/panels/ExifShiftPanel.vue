<script setup lang="ts">
/**
 * Bespoke panel for the EXIF Time Shifter.
 *
 * The generic ToolShell handles one file at a time, but a wrong camera clock is
 * never a one photo problem: the whole shoot is off by the same amount. So this
 * panel takes a pile of JPEGs (and bare TIFFs, which the logic also walks),
 * applies the same shift to every one of them, and reports each file on its own
 * row so a rejected screenshot in the middle of a card dump does not stop the
 * other two hundred photos from being patched.
 *
 * Rule 27 holds: nothing here knows what an Exif tag is. `shiftExifBytes` in
 * src/tools/exif-time-shifter/index.ts does the parsing and the patching and
 * throws a ToolError with a message and a fix hint when a file cannot be
 * handled. This file owns only the parts that need a browser: reading the
 * dropped files, holding the patched copies, and saving them one at a time or
 * together in a zip.
 *
 * Nothing touches window, document, or a File until a handler runs, so the
 * component renders inert on the server.
 */
import { computed, ref, shallowRef } from "vue";
import { Download, FileArchive, Play, TriangleAlert, X } from "lucide-vue-next";
import { zipSync } from "fflate";
import { ToolError, type OptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const props = defineProps<{ meta: ToolMeta }>();

type ExifLogic = typeof import("@/tools/exif-time-shifter/index");
type ShiftedTag = import("@/tools/exif-time-shifter/index").ShiftedTag;

/** Loaded on the first run rather than on page load, then cached. */
let logicPromise: Promise<ExifLogic> | null = null;
function loadLogic(): Promise<ExifLogic> {
  logicPromise ??= import("@/tools/exif-time-shifter/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* shift controls                                                    */
/* ---------------------------------------------------------------- */

type NumberSpec = Extract<OptionSpec, { kind: "number" }>;

const FIELD_IDS = ["days", "hours", "minutes", "seconds"] as const;
type FieldId = (typeof FIELD_IDS)[number];

/** Used only if the meta ever drops one of the four fields. */
const FALLBACK_LABEL: Record<FieldId, string> = {
  days: "Days",
  hours: "Hours",
  minutes: "Minutes",
  seconds: "Seconds",
};

/** The four inputs, mirroring meta.options so labels and bounds stay in step. */
const fields = computed<NumberSpec[]>(() =>
  FIELD_IDS.map((id) => {
    const found = props.meta.options?.find((o) => o.kind === "number" && o.id === id);
    if (found && found.kind === "number") return found;
    return { kind: "number", id, label: FALLBACK_LABEL[id], default: 0 };
  }),
);

const shift = ref<Record<FieldId, number>>({ days: 0, hours: 0, minutes: 0, seconds: 0 });

/** Matches the logic layer's own coercion: a blank or nonsense box counts as 0. */
function whole(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function setField(id: string, value: string | number): void {
  if (!isFieldId(id)) return;
  shift.value = { ...shift.value, [id]: whole(Number(value)) };
}

function isFieldId(id: string): id is FieldId {
  return (FIELD_IDS as readonly string[]).includes(id);
}

const deltaSeconds = computed(
  () =>
    whole(shift.value.days) * 86400 +
    whole(shift.value.hours) * 3600 +
    whole(shift.value.minutes) * 60 +
    whole(shift.value.seconds),
);

/**
 * The shift in words, matching what the logic layer reports for a single file.
 * Its formatter is internal, so this is a local copy of the same shape.
 */
function humanShift(total: number): string {
  const sign = total < 0 ? "-" : "+";
  let rest = Math.abs(total);
  const units: [string, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    }
  }
  return sign + parts.join(" ");
}

const shiftPreview = computed(() =>
  deltaSeconds.value === 0 ? "No shift set" : humanShift(deltaSeconds.value),
);

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

const files = shallowRef<File[]>([]);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const totalBytes = computed(() => files.value.reduce((sum, f) => sum + f.size, 0));

/** Name, size and modified time together are close enough to identity here. */
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function addFiles(incoming: File[]): void {
  if (incoming.length === 0) return;
  const seen = new Set(files.value.map(fileKey));
  const next = files.value.slice();
  for (const file of incoming) {
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  files.value = next;
  results.value = [];
  runError.value = null;
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  addFiles(Array.from(e.dataTransfer?.files ?? []));
}

function onPickFiles(e: Event): void {
  const input = e.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  // Cleared so picking the same file twice in a row still fires a change.
  input.value = "";
  addFiles(picked);
}

function removeFile(index: number): void {
  files.value = files.value.filter((_, i) => i !== index);
  results.value = [];
  runError.value = null;
}

function clearAll(): void {
  files.value = [];
  results.value = [];
  runError.value = null;
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

interface ShiftRow {
  name: string;
  size: number;
  ok: boolean;
  /** Present when ok: the fields that were rewritten, oldest value first. */
  changed: ShiftedTag[];
  /** Present when ok: the patched copy, held until it is saved. */
  bytes: Uint8Array | null;
  type: string;
  message: string;
  fix?: string;
}

const results = shallowRef<ShiftRow[]>([]);
const busy = ref(false);
const runError = ref<{ message: string; fix?: string } | null>(null);
/**
 * The shift the rows on screen were actually patched with, frozen at run time.
 * The controls stay editable afterwards, so reading the live preview here would
 * relabel a finished table with a shift that was never applied to it.
 */
const appliedShift = ref("");

const canRun = computed(() => !busy.value && files.value.length > 0 && deltaSeconds.value !== 0);
const patchedRows = computed(() => results.value.filter((r) => r.ok && r.bytes));
const failedCount = computed(() => results.value.length - patchedRows.value.length);

/** A bare TIFF starts with its own byte order mark rather than the JPEG SOI. */
function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  return little || big;
}

async function run(): Promise<void> {
  if (!canRun.value) return;
  busy.value = true;
  runError.value = null;
  results.value = [];

  try {
    const { shiftExifBytes } = await loadLogic();
    const delta = deltaSeconds.value;
    appliedShift.value = humanShift(delta);
    const rows: ShiftRow[] = [];

    for (const file of files.value) {
      const row: ShiftRow = {
        name: file.name,
        size: file.size,
        ok: false,
        changed: [],
        bytes: null,
        type: "image/jpeg",
        message: "",
      };
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const patched = shiftExifBytes(bytes, delta);
        row.ok = true;
        row.changed = patched.changed;
        row.bytes = patched.bytes;
        row.type = isTiff(bytes) ? "image/tiff" : "image/jpeg";
      } catch (err) {
        if (err instanceof ToolError) {
          row.message = err.message;
          row.fix = err.fix;
        } else {
          row.message = err instanceof Error ? err.message : "This file could not be read.";
        }
      }
      rows.push(row);
      // Replaced wholesale so the table fills in as the pile is worked through.
      results.value = rows.slice();
    }

    results.value = rows;
  } catch (err) {
    runError.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : {
            message: err instanceof Error ? err.message : "The shift could not be run.",
            fix: "Reload the page and try again.",
          };
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* saving                                                            */
/* ---------------------------------------------------------------- */

function saveOne(row: ShiftRow): void {
  if (!row.bytes) return;
  downloadBlob(new Blob([row.bytes.slice().buffer as ArrayBuffer], { type: row.type }), row.name);
}

/** "IMG_0001.jpg" from two cards would otherwise clobber inside the zip. */
function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function saveZip(): void {
  const entries: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  for (const row of patchedRows.value) {
    if (!row.bytes) continue;
    const name = uniqueName(taken, row.name);
    taken.add(name);
    entries[name] = row.bytes;
  }
  if (taken.size === 0) return;
  // Level 0 stores the entries: a JPEG is already compressed, so deflating it
  // costs seconds of CPU to save nothing.
  const zipped = zipSync(entries, { level: 0 });
  downloadBlob(
    new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" }),
    "shifted-photos.zip",
  );
}
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Photos
        </span>
        <div class="flex items-center gap-1">
          <Button
            v-if="files.length > 0"
            variant="ghost"
            size="sm"
            :disabled="busy"
            @click="clearAll"
          >
            Clear
          </Button>
          <Button variant="ghost" size="sm" :disabled="busy" @click="fileInput?.click()">
            Choose files…
          </Button>
        </div>
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          multiple
          accept="image/jpeg,.jpg,.jpeg,.tif,.tiff"
          @change="onPickFiles"
        />
      </div>

      <div class="px-3 pt-1 pb-4">
        <p v-if="files.length === 0" class="text-sm text-muted-foreground">
          Drop a whole shoot here, or pick the files. JPEG and raw TIFF both work, and the shift is
          applied to every file at once.
        </p>
        <template v-else>
          <p class="text-sm text-muted-foreground">
            {{ files.length === 1 ? "1 file" : `${files.length} files` }},
            {{ formatBytes(totalBytes) }} in total.
          </p>
          <ul class="mt-2 flex flex-wrap gap-2">
            <li v-for="(file, i) in files" :key="`${file.name}-${i}`" class="min-w-0">
              <span
                class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
              >
                <span class="truncate">{{ file.name }}</span>
                <span class="shrink-0 text-muted-foreground tabular-nums">
                  {{ formatBytes(file.size) }}
                </span>
                <button
                  type="button"
                  class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  :aria-label="`Remove ${file.name}`"
                  :disabled="busy"
                  @click="removeFile(i)"
                >
                  <X class="size-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </div>

    <!-- shift controls -->
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-end gap-3">
        <div v-for="field in fields" :key="field.id" class="flex w-24 flex-col gap-1.5">
          <Label :for="`exif-${field.id}`" class="text-xs text-muted-foreground">
            {{ field.label }}
          </Label>
          <Input
            :id="`exif-${field.id}`"
            type="number"
            :min="field.min"
            :max="field.max"
            :step="field.step ?? 1"
            :model-value="shift[field.id as FieldId]"
            class="h-9 bg-card tabular-nums"
            @update:model-value="(v: string | number) => setField(field.id, v)"
          />
        </div>

        <Button type="button" :disabled="!canRun" @click="run">
          <Play class="size-3.5" aria-hidden="true" />
          {{ busy ? "Shifting…" : "Shift timestamps" }}
        </Button>
      </div>

      <p class="text-sm" :class="deltaSeconds === 0 ? 'text-muted-foreground' : 'text-foreground'">
        Total shift:
        <span class="font-mono tabular-nums">{{ shiftPreview }}</span>
        <span v-if="deltaSeconds === 0" class="text-muted-foreground">
          . Negative numbers move the timestamps earlier, positive numbers move them later.
        </span>
      </p>

      <p class="text-xs text-muted-foreground">
        GPS timestamps are not touched: satellite time was right even when the camera clock was
        not. Only DateTime, DateTimeOriginal and DateTimeDigitized change, so every patched file
        keeps its original length and its image data byte for byte. The whole shift runs in this
        browser tab, so your files and inputs never leave your device.
      </p>
    </div>

    <!-- a failure of the run itself, not of one file -->
    <div
      v-if="runError"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="flex items-center gap-2 font-semibold text-destructive">
        <TriangleAlert class="size-3.5" aria-hidden="true" />
        {{ runError.message }}
      </span>
      <span v-if="runError.fix" class="text-muted-foreground">{{ runError.fix }}</span>
    </div>

    <!-- results -->
    <div v-if="results.length > 0" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-muted-foreground" aria-live="polite">
          {{ patchedRows.length }} of {{ results.length }} shifted by
          <span class="font-mono tabular-nums">{{ appliedShift }}</span>
          <template v-if="failedCount > 0">
            , {{ failedCount === 1 ? "1 file left alone" : `${failedCount} files left alone` }}
          </template>
        </p>
        <Button
          v-if="patchedRows.length >= 2"
          type="button"
          variant="outline"
          size="sm"
          @click="saveZip"
        >
          <FileArchive class="size-3.5" aria-hidden="true" />
          Download all as zip
        </Button>
      </div>

      <div class="overflow-x-auto rounded-[10px] border">
        <table class="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr class="border-b text-left text-xs text-muted-foreground">
              <th scope="col" class="px-3 py-2 font-medium">File</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Size</th>
              <th scope="col" class="w-full px-3 py-2 font-medium">Result</th>
              <th scope="col" class="px-3 py-2 font-medium"><span class="sr-only">Save</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in results"
              :key="`${row.name}-${i}`"
              class="border-b last:border-b-0 align-top"
            >
              <td class="max-w-[220px] px-3 py-2">
                <span class="block truncate font-mono text-xs" :title="row.name">
                  {{ row.name }}
                </span>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                {{ formatBytes(row.size) }}
              </td>
              <td class="px-3 py-2">
                <ul v-if="row.ok" class="flex flex-col gap-0.5">
                  <li v-for="tag in row.changed" :key="tag.tag" class="min-w-0">
                    <span class="text-xs text-muted-foreground">{{ tag.tag }}</span>
                    <span class="ml-2 font-mono text-xs tabular-nums">
                      {{ tag.from }} -&gt; {{ tag.to }}
                    </span>
                  </li>
                </ul>
                <div v-else class="flex flex-col gap-0.5">
                  <span class="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
                    {{ row.message }}
                  </span>
                  <span v-if="row.fix" class="text-xs text-muted-foreground">{{ row.fix }}</span>
                </div>
              </td>
              <td class="px-3 py-2 text-right">
                <Button
                  v-if="row.ok"
                  type="button"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Download ${row.name}`"
                  @click="saveOne(row)"
                >
                  <Download class="size-3.5" aria-hidden="true" />
                  Download
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
