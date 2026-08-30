<script setup lang="ts">
/**
 * Bespoke panel for the EXIF Viewer and Stripper.
 *
 * Three things the generic shell cannot do are the reason this file exists: the
 * embedded thumbnail has to be shown as a picture, the cleaned copy has to be
 * downloadable as a file rather than as base64 in a text row, and a strip is
 * almost never a one photo job, so the panel takes a pile of files and can zip
 * the results.
 *
 * Rule 27 holds: nothing here knows what a TIFF directory is. `readMetadata` in
 * `src/tools/exif-viewer-and-stripper/` does the parsing, `stripMetadata` does
 * the rewrite, `commonFields` decides what is worth showing first, `prettyXml`
 * indents the XMP packet, and `cleanFilename` names the output. This file owns
 * only the file reading, the object URLs, and the downloads.
 *
 * The map link is a plain anchor. Nothing on this page fetches a map tile or
 * any other third party resource; the URL is text until you choose to click it.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import {
  Download,
  FileArchive,
  MapPin,
  ScanSearch,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-vue-next";
import { zipSync } from "fflate";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  cleanFilename,
  commonFields,
  prettyXml,
  readMetadata,
  stripMetadata,
} from "@/tools/exif-viewer-and-stripper/index";
import type { ExifReport, MetaField, StripResult } from "@/tools/exif-viewer-and-stripper/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import KeyValueGrid from "../KeyValueGrid.vue";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

interface Row {
  name: string;
  size: number;
  type: string;
  report: ExifReport | null;
  stripped: StripResult | null;
  /** An object URL for the IFD1 preview, released when the row goes. */
  thumbnailUrl: string;
  error: { message: string; fix?: string } | null;
}

const rows = shallowRef<Row[]>([]);
const selected = ref(0);
const showAll = ref(false);
const busy = ref(false);
const runError = ref<{ message: string; fix?: string } | null>(null);

const current = computed<Row | null>(() => rows.value[selected.value] ?? null);

const strippableRows = computed(() => rows.value.filter((r) => r.stripped !== null));

function releaseRows(): void {
  for (const row of rows.value) if (row.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
}

function syncFragment(): void {
  writeFragment({ opts: { showAll: String(showAll.value) } });
}

/* ---------------------------------------------------------------- */
/* reading                                                           */
/* ---------------------------------------------------------------- */

async function readOne(file: File): Promise<Row> {
  const row: Row = {
    name: file.name || "image",
    size: file.size,
    type: file.type || "application/octet-stream",
    report: null,
    stripped: null,
    thumbnailUrl: "",
    error: null,
  };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    row.report = readMetadata(bytes);
    if (row.report.thumbnail) {
      row.thumbnailUrl = URL.createObjectURL(
        new Blob([row.report.thumbnail.slice().buffer as ArrayBuffer], { type: "image/jpeg" }),
      );
    }
    try {
      row.stripped = stripMetadata(bytes);
    } catch {
      // A format that cannot be stripped is still worth reading, so the strip
      // failure only removes the download button for that row.
      row.stripped = null;
    }
  } catch (err) {
    row.error =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That file could not be read." };
  }
  return row;
}

async function addFiles(incoming: File[]): Promise<void> {
  if (incoming.length === 0) return;
  busy.value = true;
  runError.value = null;
  try {
    const next: Row[] = [];
    for (const file of incoming) next.push(await readOne(file));
    releaseRows();
    rows.value = next;
    selected.value = 0;
  } catch (err) {
    runError.value = {
      message: err instanceof Error ? err.message : "Those files could not be read.",
      fix: "Try again with fewer files, or one at a time.",
    };
  } finally {
    busy.value = false;
  }
}

function onFiles(files: File[]): void {
  void addFiles(files);
}

function removeRow(index: number): void {
  const row = rows.value[index];
  if (row?.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
  rows.value = rows.value.filter((_, i) => i !== index);
  if (selected.value >= rows.value.length) selected.value = Math.max(0, rows.value.length - 1);
}

function clearAll(): void {
  releaseRows();
  rows.value = [];
  selected.value = 0;
  runError.value = null;
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch("/samples/sample-photo.jpg");
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await addFiles([new File([blob], "sample-photo.jpg", { type: "image/jpeg" })]);
  } catch {
    runError.value = {
      message: "Could not load the sample photo.",
      fix: "Try again, or drop a photo of your own.",
    };
  }
}

/* ---------------------------------------------------------------- */
/* the report, grouped for reading                                   */
/* ---------------------------------------------------------------- */

const GROUP_TITLES: Record<string, string> = {
  IFD0: "Image and camera",
  Exif: "Capture settings",
  GPS: "Location",
  Interop: "Interoperability",
  IFD1: "Embedded thumbnail",
};

interface FieldGroup {
  title: string;
  record: Record<string, string>;
}

const groups = computed<FieldGroup[]>(() => {
  const report = current.value?.report;
  if (!report) return [];
  const fields: MetaField[] = showAll.value ? report.fields : commonFields(report.fields);
  const order = ["IFD0", "Exif", "GPS", "Interop", "IFD1"];
  const out: FieldGroup[] = [];
  for (const group of order) {
    const inGroup = fields.filter((f) => f.group === group);
    if (inGroup.length === 0) continue;
    const record: Record<string, string> = {};
    for (const field of inGroup) record[field.name] = field.value;
    out.push({ title: GROUP_TITLES[group] ?? group, record });
  }
  return out;
});

const hiddenCount = computed(() => {
  const report = current.value?.report;
  if (!report || showAll.value) return 0;
  return report.fields.length - commonFields(report.fields).length;
});

const textRecord = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const record of current.value?.report?.text ?? []) {
    out[`${record.source} ${record.keyword}`] = record.value;
  }
  return out;
});

const xmpPretty = computed(() => {
  const xmp = current.value?.report?.xmp;
  return xmp ? prettyXml(xmp) : "";
});

/** The whole report as text, for one copy button over everything. */
const reportText = computed(() => {
  const row = current.value;
  if (!row?.report) return "";
  const lines: string[] = [
    `File: ${row.name}`,
    `Format: ${row.report.formatLabel}`,
    `Size: ${formatBytes(row.size)}`,
  ];
  for (const field of row.report.fields) lines.push(`${field.group} ${field.name}: ${field.value}`);
  if (row.report.gps) lines.push(`GPS: ${row.report.gps.decimal}`);
  for (const record of row.report.text)
    lines.push(`${record.source} ${record.keyword}: ${record.value}`);
  if (row.report.xmp) lines.push("", "XMP:", prettyXml(row.report.xmp));
  return lines.join("\n");
});

/* ---------------------------------------------------------------- */
/* saving                                                            */
/* ---------------------------------------------------------------- */

function saveOne(row: Row): void {
  if (!row.stripped) return;
  downloadBlob(
    new Blob([row.stripped.bytes.slice().buffer as ArrayBuffer], { type: row.type }),
    cleanFilename(row.name),
  );
}

/** Two files from two cards can share a name, so the zip disambiguates. */
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
  for (const row of strippableRows.value) {
    if (!row.stripped) continue;
    const name = uniqueName(taken, cleanFilename(row.name));
    taken.add(name);
    entries[name] = row.stripped.bytes;
  }
  if (taken.size === 0) return;
  // Level 0 stores the entries: a JPEG or PNG is already compressed, so
  // deflating it again costs seconds of CPU to save nothing.
  const zipped = zipSync(entries, { level: 0 });
  downloadBlob(
    new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" }),
    "clean-photos.zip",
  );
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

// Read on mount rather than at setup: `client:load` renders this island on the
// server first, where there is no window to read a fragment from.
onMounted(() => {
  if (readFragment().opts["showAll"] === "true") showAll.value = true;
});

onUnmounted(releaseRows);
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <FileDrop
      accept="image/*,.jpg,.jpeg,.png,.webp,.tif,.tiff"
      multiple
      label="Photos"
      hint="Drop one photo or a whole shoot. Everything is read and rewritten in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template #actions>
        <Button variant="ghost" size="sm" :disabled="busy" @click="loadSample">
          <Sparkles class="size-3.5" aria-hidden="true" />
          Load sample
        </Button>
        <Button v-if="rows.length > 0" variant="ghost" size="sm" :disabled="busy" @click="clearAll">
          Clear
        </Button>
      </template>
    </FileDrop>

    <ErrorBanner v-if="runError" :message="runError.message" :hint="runError.fix" />

    <!-- file chips, only worth showing for a batch -->
    <ul v-if="rows.length > 1" class="flex flex-wrap gap-2">
      <li v-for="(row, i) in rows" :key="`${row.name}-${i}`" class="min-w-0">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          :class="i === selected ? 'bg-secondary' : 'bg-card'"
        >
          <button
            type="button"
            class="truncate outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-pressed="i === selected"
            @click="selected = i"
          >
            {{ row.name }}
          </button>
          <TriangleAlert
            v-if="row.error"
            class="size-3 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-label="`Remove ${row.name}`"
            @click="removeRow(i)"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </span>
      </li>
    </ul>

    <!-- toolbar -->
    <div v-if="rows.length > 0" class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <Switch id="exif-show-all" v-model="showAll" @update:model-value="syncFragment" />
        <Label for="exif-show-all" class="text-xs text-muted-foreground">
          Show every tag<span v-if="hiddenCount > 0"> ({{ hiddenCount }} hidden)</span>
        </Label>
      </div>

      <div class="flex flex-wrap items-center gap-1">
        <CopyButton :text="reportText" label="Copy report" />
        <Button
          v-if="current?.stripped"
          type="button"
          variant="outline"
          size="sm"
          @click="saveOne(current)"
        >
          <Download class="size-3.5" aria-hidden="true" />
          Download clean copy
        </Button>
        <Button
          v-if="strippableRows.length >= 2"
          type="button"
          variant="outline"
          size="sm"
          @click="saveZip"
        >
          <FileArchive class="size-3.5" aria-hidden="true" />
          All {{ strippableRows.length }} as zip
        </Button>
      </div>
    </div>

    <ErrorBanner v-if="current?.error" :message="current.error.message" :hint="current.error.fix" />

    <template v-if="current?.report">
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span class="font-mono">{{ current.name }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ current.report.formatLabel }}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">{{ formatBytes(current.size) }}</span>
        <span v-if="current.stripped && current.stripped.bytesSaved > 0" aria-hidden="true">·</span>
        <span v-if="current.stripped && current.stripped.bytesSaved > 0">
          {{ formatBytes(current.stripped.bytesSaved) }} of metadata
        </span>
      </div>

      <EmptyState
        v-if="current.report.empty"
        title="This file carries no metadata"
        hint="There is no Exif, XMP, IPTC, or text block in it, so there is nothing to remove. Exported copies and screenshots are usually already clean."
        icon="FileSearch"
      />

      <!-- GPS -->
      <div
        v-if="current.report.gps"
        class="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      >
        <MapPin class="size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div class="flex min-w-0 flex-col">
          <span class="text-sm">
            This photo records where it was taken:
            <span class="font-mono tabular-nums">{{ current.report.gps.decimal }}</span>
          </span>
          <span
            v-if="current.report.gps.altitude !== undefined"
            class="text-xs text-muted-foreground"
          >
            {{ current.report.gps.altitude.toFixed(1) }} meters above sea level
          </span>
          <a
            :href="current.report.gps.mapUrl"
            target="_blank"
            rel="noreferrer noopener"
            class="mt-1 text-xs break-all text-primary underline underline-offset-2"
          >
            Open in OpenStreetMap in a new tab
          </a>
        </div>
        <div class="ml-auto">
          <CopyButton :text="current.report.gps.decimal" label="Copy coordinates" />
        </div>
      </div>

      <!-- thumbnail -->
      <figure v-if="current.thumbnailUrl" class="flex flex-col gap-1.5">
        <figcaption class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Embedded thumbnail
        </figcaption>
        <img
          :src="current.thumbnailUrl"
          alt="The preview stored inside the photo's metadata"
          class="block h-auto max-w-[16rem] rounded-[10px] shadow-[var(--sh-inset)]"
        />
        <figcaption class="text-xs text-muted-foreground">
          Cameras store this small JPEG in IFD1. After a crop it can still show the original
          framing, which is one reason to strip metadata before sharing.
        </figcaption>
      </figure>

      <!-- field groups -->
      <div v-for="group in groups" :key="group.title" class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {{ group.title }}
        </span>
        <KeyValueGrid :record="group.record" surface="secondary" />
      </div>

      <!-- text records -->
      <div v-if="Object.keys(textRecord).length > 0" class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Text records
        </span>
        <KeyValueGrid :record="textRecord" :columns="2" surface="secondary" />
      </div>

      <!-- XMP -->
      <div v-if="xmpPretty" class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            XMP packet
          </span>
          <CopyButton :text="xmpPretty" label="Copy XMP" />
        </div>
        <pre
          class="max-h-72 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
          >{{ xmpPretty }}</pre>
      </div>

      <!-- segments -->
      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Segments in the file
        </span>
        <div class="overflow-x-auto rounded-[10px] border">
          <table class="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr class="border-b text-left text-xs text-muted-foreground">
                <th scope="col" class="px-3 py-2 font-medium">Segment</th>
                <th scope="col" class="w-full px-3 py-2 font-medium">What it holds</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(segment, i) in current.report.segments"
                :key="`${segment.id}-${i}`"
                class="border-b last:border-b-0"
                :class="segment.metadata ? 'bg-secondary' : ''"
              >
                <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{{ segment.id }}</td>
                <td class="px-3 py-1.5 text-xs">
                  {{ segment.description }}
                  <span v-if="segment.metadata" class="text-muted-foreground">
                    , removed when you strip
                  </span>
                </td>
                <td class="px-3 py-1.5 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {{ formatBytes(segment.size) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="current.stripped" class="text-xs text-muted-foreground">
          <template v-if="current.stripped.removed.length > 0">
            Stripping removes {{ current.stripped.removed.join(", ") }}. No pixel is recompressed,
            so the cleaned copy is identical to look at.
          </template>
          <template v-else> There is nothing to remove: this file is already clean. </template>
          <template v-if="current.stripped.kept.length > 0">
            {{ current.stripped.kept.join(" and ") }} stays, because removing it would shift the
            colors.
          </template>
        </p>
        <p v-else-if="current.report.container === 'tiff'" class="text-xs text-muted-foreground">
          A bare TIFF cannot be stripped in place: the same directories that hold the metadata also
          point at the image data. Convert it to a JPEG or PNG first.
        </p>
      </div>
    </template>

    <EmptyState
      v-else-if="rows.length === 0 && !runError"
      title="No photo loaded yet"
      hint="Drop a JPEG, PNG, WebP, or TIFF to see every field it carries. Drop several to strip a whole shoot at once."
      icon="ScanSearch"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="loadSample">
          <ScanSearch class="size-3.5" aria-hidden="true" />
          Load the sample photo
        </Button>
      </template>
    </EmptyState>
  </div>
</template>
