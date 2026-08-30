<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, ImageOff, RotateCcw, X } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import type { KeyValueRow } from "@/lib/key-value";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Bespoke panel for the MP3 tag editor. The generic ToolShell renders a
 * Record<string,string> and nothing else, which can show a tag but cannot edit
 * one: this tool needs a form, a picture, and a second file input for the
 * cover art.
 *
 * Every byte level rule lives in the logic layer (rule 27). Parsing, the four
 * text encodings, the unsynchronization scheme, genre resolution and the
 * rebuilt ID3v2.3 tag are all imported from `@/tools/mp3-tag-editor/index`;
 * the panel decides what to ask for and how to draw the answer. The module is
 * imported lazily so the tag reader stays out of every other page's bundle.
 *
 * One shape of the format drives the design: an ID3 tag is a prefix on the
 * file, so editing it never touches the audio. The original bytes are kept in
 * `audio` and copied straight into the saved file, which is why the panel can
 * promise that nothing is re-encoded.
 */
defineProps<{ meta: ToolMeta }>();

type TagLogic = typeof import("@/tools/mp3-tag-editor/index");
type Id3Info = import("@/tools/mp3-tag-editor/index").Id3Info;
type Id3Picture = import("@/tools/mp3-tag-editor/index").Id3Picture;
type EditableTag = import("@/tools/mp3-tag-editor/index").EditableTag;

/** Frames listed before the table starts scrolling on its own. */
const FRAME_ROWS_VISIBLE = 12;
/** Cover art the panel will accept, matching the logic layer's own limit. */
const MAX_COVER_BYTES = 16 * 1024 * 1024;

let logicPromise: Promise<TagLogic> | null = null;
function loadLogic(): Promise<TagLogic> {
  logicPromise ??= import("@/tools/mp3-tag-editor/index");
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<TagLogic | null>(null);
/** What the file said when it was opened. Never edited, so Reset can work. */
const info = shallowRef<Id3Info | null>(null);
/** The audio frames alone, copied verbatim into whatever gets saved. */
const audio = shallowRef<Uint8Array | null>(null);

const fileName = ref("");
const fileSize = ref(0);

/** The form. A plain object because every field is a text input. */
const form = ref<EditableTag>(blankTag());
/** The cover to write: undefined means "unchanged", null means "remove it". */
const coverEdit = shallowRef<Id3Picture | null | undefined>(undefined);
const writeId3v1 = ref(false);

const error = ref<{ message: string; fix?: string } | null>(null);
const busy = ref(false);
const sampleLoading = ref(false);

/** Guards against a slower open landing after a newer one. */
let openSeq = 0;

function blankTag(): EditableTag {
  return {
    title: "",
    artist: "",
    albumArtist: "",
    album: "",
    year: "",
    track: "",
    disc: "",
    genre: "",
    composer: "",
    comment: "",
  };
}

/* ---------------------------------------------------------------- */
/* cover art                                                         */
/* ---------------------------------------------------------------- */

/** The picture that would be written right now, before any save. */
const cover = computed<Id3Picture | null>(() => {
  if (coverEdit.value !== undefined) return coverEdit.value;
  return info.value?.cover ?? null;
});

/**
 * The preview URL, minted from whichever picture is current and released the
 * moment it stops being current. Object URLs are the one browser resource a
 * panel can leak, and a page that swaps covers a few times would hold every
 * image it ever showed.
 */
const coverUrl = ref("");
watch(
  cover,
  (picture) => {
    if (coverUrl.value) URL.revokeObjectURL(coverUrl.value);
    coverUrl.value = picture
      ? URL.createObjectURL(new Blob([picture.bytes.slice()], { type: picture.mime }))
      : "";
  },
  { immediate: true },
);
onUnmounted(() => {
  if (coverUrl.value) URL.revokeObjectURL(coverUrl.value);
});

const coverChanged = computed(() => coverEdit.value !== undefined);

async function onCoverFiles(files: File[]) {
  const file = files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name} is not an image, so it cannot be used as cover art.`,
      fix: "Pick a JPEG, PNG, GIF or WebP file.",
    };
    return;
  }
  if (file.size > MAX_COVER_BYTES) {
    error.value = {
      message: `That image is ${formatBytes(file.size)}, past the ${formatBytes(MAX_COVER_BYTES)} limit for embedded art.`,
      fix: "Shrink the image first. Album art above about 1 MB makes every copy of the file larger for nothing.",
    };
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  coverEdit.value = {
    mime: file.type,
    pictureType: 3,
    typeLabel: "Front cover",
    description: "",
    bytes,
  };
  error.value = null;
}

function removeCover() {
  coverEdit.value = null;
}

function restoreCover() {
  coverEdit.value = undefined;
}

/* ---------------------------------------------------------------- */
/* opening a file                                                    */
/* ---------------------------------------------------------------- */

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function reset() {
  info.value = null;
  audio.value = null;
  form.value = blankTag();
  coverEdit.value = undefined;
  writeId3v1.value = false;
}

async function openBytes(bytes: Uint8Array, name: string, size: number) {
  const seq = ++openSeq;
  busy.value = true;
  error.value = null;

  try {
    const mod = await loadLogic();
    const parsed = mod.parseId3(bytes);
    if (seq !== openSeq) return;

    reset();
    logic.value = mod;
    info.value = parsed;
    audio.value = mod.audioBytesOf(bytes, parsed);
    form.value = { ...parsed.tag };
    writeId3v1.value = Boolean(parsed.v1);
    fileName.value = name;
    fileSize.value = size;
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

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
async function onFiles(files: File[]) {
  const file = files[0];
  if (!file) return;
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.size);
}

/** Loads the bundled sample through the same path as a dropped file. */
async function loadSample() {
  if (sampleLoading.value) return;
  sampleLoading.value = true;
  try {
    const response = await fetch("/samples/sample.mp3");
    if (!response.ok) throw new Error(String(response.status));
    const bytes = new Uint8Array(await response.arrayBuffer());
    await openBytes(bytes, "sample.mp3", bytes.length);
  } catch {
    error.value = {
      message: "Could not load the sample file.",
      fix: "Check your connection and try again, or drop an MP3 of your own.",
    };
  } finally {
    sampleLoading.value = false;
  }
}

function clearFile() {
  openSeq += 1;
  reset();
  fileName.value = "";
  fileSize.value = 0;
  error.value = null;
  busy.value = false;
}

function resetForm() {
  const parsed = info.value;
  if (!parsed) return;
  form.value = { ...parsed.tag };
  coverEdit.value = undefined;
  writeId3v1.value = Boolean(parsed.v1);
}

/* ---------------------------------------------------------------- */
/* the form                                                          */
/* ---------------------------------------------------------------- */

/** Field id, label, and placeholder for every editable row, in tab order. */
const FIELDS: { id: keyof EditableTag; label: string; placeholder: string }[] = [
  { id: "title", label: "Title", placeholder: "Song title" },
  { id: "artist", label: "Artist", placeholder: "Performing artist" },
  { id: "album", label: "Album", placeholder: "Album name" },
  { id: "albumArtist", label: "Album artist", placeholder: "Various Artists" },
  { id: "year", label: "Year", placeholder: "2026" },
  { id: "track", label: "Track", placeholder: "3 or 3/12" },
  { id: "disc", label: "Disc", placeholder: "1 or 1/2" },
  { id: "genre", label: "Genre", placeholder: "Ambient" },
  { id: "composer", label: "Composer", placeholder: "Writing credit" },
  { id: "comment", label: "Comment", placeholder: "Anything you want to remember" },
];

const readOnly = computed(() => info.value?.container === "flac");

const dirty = computed(() => {
  const parsed = info.value;
  if (!parsed) return false;
  if (coverChanged.value) return true;
  if (writeId3v1.value !== Boolean(parsed.v1)) return true;
  return FIELDS.some(({ id }) => form.value[id] !== parsed.tag[id]);
});

/* ---------------------------------------------------------------- */
/* the byte level summary                                            */
/* ---------------------------------------------------------------- */

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const summaryRows = computed<KeyValueRow[]>(() => {
  const parsed = info.value;
  if (!parsed) return [];

  const rows: KeyValueRow[] = [
    { key: "Tag version", value: parsed.version },
    {
      key: "Tag bytes",
      value: parsed.tagSize > 0 ? formatBytes(parsed.tagSize) : "no ID3v2 tag",
    },
    { key: "Audio bytes", value: formatBytes(parsed.audioSize) },
    { key: "Audio starts at", value: `byte ${parsed.audioOffset.toLocaleString()}` },
  ];

  if (parsed.container === "mp3") {
    const flags: string[] = [];
    if (parsed.flags.unsynchronized) flags.push("unsynchronization");
    if (parsed.flags.extendedHeader) flags.push("extended header");
    if (parsed.flags.experimental) flags.push("experimental");
    if (parsed.flags.footer) flags.push("footer");
    rows.push({ key: "Tag flags", value: flags.length > 0 ? flags.join(", ") : "none set" });
    rows.push({
      key: "ID3v1 trailer",
      value: parsed.v1 ? `present, ID3v${parsed.v1.version}` : "none",
    });
  }

  if (parsed.stream) {
    rows.push({ key: "Audio format", value: parsed.stream.codec });
    rows.push({
      key: "Bitrate",
      value: `${parsed.stream.bitrate} kbps${parsed.stream.vbr ? " average, variable" : ""}`,
    });
    rows.push({ key: "Sample rate", value: `${parsed.stream.sampleRate.toLocaleString()} Hz` });
    rows.push({ key: "Channels", value: parsed.stream.channelMode });
    rows.push({ key: "Duration", value: formatDuration(parsed.stream.durationSeconds) });
  }

  return rows;
});

const frames = computed(() => info.value?.frames ?? []);

/** The tag as JSON, for the copy button. Built at click time, not per render. */
function tagAsJson(): string {
  const parsed = info.value;
  const picture = cover.value;
  return JSON.stringify(
    {
      file: fileName.value,
      tagVersion: parsed?.version ?? "none",
      ...form.value,
      cover: picture
        ? { mime: picture.mime, type: picture.typeLabel, bytes: picture.bytes.length }
        : null,
    },
    null,
    2,
  );
}

/* ---------------------------------------------------------------- */
/* saving                                                            */
/* ---------------------------------------------------------------- */

function taggedName(): string {
  const dot = fileName.value.lastIndexOf(".");
  const stem = (dot > 0 ? fileName.value.slice(0, dot) : fileName.value) || "tagged";
  return `${stem}-tagged.mp3`;
}

function save() {
  const mod = logic.value;
  const frames = audio.value;
  if (!mod || !frames || readOnly.value) return;

  try {
    const built = mod.buildId3({ ...form.value }, frames, {
      cover: cover.value,
      writeId3v1: writeId3v1.value,
    });
    // The slice detaches the tag from the source buffer, so the blob does not
    // pin the whole original file in memory for the life of the download.
    downloadBlob(new Blob([built.slice()], { type: "audio/mpeg" }), taggedName());
    error.value = null;
  } catch (e) {
    error.value = toToolError(e);
  }
}

/** Bytes the saved file will occupy, so the button can say so before it runs. */
const savedSize = computed(() => {
  const parsed = info.value;
  const frames = audio.value;
  if (!parsed || !frames) return 0;
  const picture = cover.value;
  const text = FIELDS.reduce((sum, { id }) => sum + form.value[id].length * 2 + 11, 0);
  return frames.length + 10 + 1024 + text + (picture ? picture.bytes.length + 40 : 0);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <FileDrop
      accept=".mp3,.mp2,.flac,audio/mpeg,audio/flac"
      label="Drop an MP3 here or click to choose"
      hint="The tag reader is JavaScript running in this tab: your files and inputs never leave your device. MP3 files are read and written, FLAC files open read only."
      @files="onFiles"
    >
      <template v-if="info" #default>
        <div class="flex justify-center">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <button
              type="button"
              aria-label="Close this file"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>
      </template>

      <template #actions>
        <Button variant="outline" size="sm" :disabled="sampleLoading" @click="loadSample">
          {{ sampleLoading ? "Loading sample…" : "Try a sample" }}
        </Button>
      </template>
    </FileDrop>

    <p v-if="busy" class="text-xs text-muted-foreground">Reading the tag…</p>

    <!-- Errors -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="info">
      <ErrorBanner
        v-if="readOnly"
        variant="info"
        title="FLAC opens read only"
        message="This file's Vorbis comments and picture block are shown below, but saving is MP3 only for now."
        hint="To edit these tags, convert to MP3 first or use a desktop tagger."
      />
      <ErrorBanner
        v-for="warning in info.warnings"
        :key="warning"
        variant="warning"
        title="This tag is not quite to spec"
        :message="warning"
        hint="Everything readable before the problem was kept. Saving writes a clean tag in its place."
      />

      <!-- Cover art and the form -->
      <div class="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div class="flex flex-col gap-2">
          <div
            class="grid size-40 place-items-center overflow-hidden rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          >
            <img
              v-if="coverUrl"
              :src="coverUrl"
              :alt="cover?.description || 'Embedded cover art'"
              class="size-full object-contain"
            />
            <div v-else class="flex flex-col items-center gap-1 px-3 text-center">
              <ImageOff class="size-6 text-muted-foreground" />
              <span class="text-xs text-muted-foreground">No cover art</span>
            </div>
          </div>

          <p v-if="cover" class="text-xs text-muted-foreground tabular-nums">
            {{ cover.mime }}, {{ formatBytes(cover.bytes.length) }}
          </p>

          <FileDrop
            v-if="!readOnly"
            accept="image/*"
            compact
            :paste="false"
            label="Replace cover"
            @files="onCoverFiles"
          />
          <div v-if="!readOnly" class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" :disabled="!cover" @click="removeCover">
              Remove cover
            </Button>
            <Button v-if="coverChanged" variant="ghost" size="sm" @click="restoreCover">
              Undo
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <div v-for="field in FIELDS" :key="field.id" class="flex flex-col gap-1.5">
              <Label :for="`mp3-${field.id}`" class="text-xs text-muted-foreground">
                {{ field.label }}
              </Label>
              <Input
                :id="`mp3-${field.id}`"
                v-model="form[field.id]"
                :placeholder="field.placeholder"
                :disabled="readOnly"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
          </div>

          <div v-if="!readOnly" class="flex items-center gap-2">
            <Checkbox
              id="mp3-write-v1"
              :model-value="writeId3v1"
              @update:model-value="(v) => (writeId3v1 = Boolean(v))"
            />
            <Label for="mp3-write-v1" class="text-xs font-normal">
              Also write a 128 byte ID3v1 trailer for older players
            </Label>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button :disabled="readOnly || !audio" @click="save">
              <Download class="size-3.5" />
              Download tagged MP3
            </Button>
            <Button variant="outline" size="sm" :disabled="!dirty" @click="resetForm">
              <RotateCcw class="size-3.5" />
              Reset
            </Button>
            <CopyButton :get-text="tagAsJson" label="Copy as JSON" variant="outline" />
          </div>

          <p v-if="!readOnly" class="text-xs text-muted-foreground tabular-nums">
            Saving writes a fresh ID3v2.3 tag with 1 KB of padding in front of your original audio
            frames. Nothing is re-encoded, so the sound is bit identical. The saved file will be
            roughly {{ formatBytes(savedSize) }}.
          </p>
        </div>
      </div>

      <!-- Byte level summary -->
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          File layout
        </div>
        <KeyValueGrid :rows="summaryRows" :columns="3" surface="card" :copy="false" dense />
      </div>

      <!-- Frames -->
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Frames in the file
        </div>

        <EmptyState
          v-if="frames.length === 0"
          title="This file carries no tag frames"
          hint="Fill in the fields above and save to give it a full ID3v2.3 tag."
          icon="FileText"
        />
        <div
          v-else
          class="overflow-auto rounded-[8px] bg-card"
          :class="frames.length > FRAME_ROWS_VISIBLE ? 'max-h-80' : ''"
        >
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr class="text-left text-xs text-muted-foreground">
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Id</th>
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Field</th>
                <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Value</th>
                <th
                  scope="col"
                  class="sticky top-0 z-10 bg-card px-3 py-2 text-right font-medium whitespace-nowrap"
                >
                  Bytes
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/60">
              <tr v-for="(frame, i) in frames" :key="`${frame.rawId}-${i}`" class="align-top">
                <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{{ frame.rawId }}</td>
                <td class="px-3 py-1.5 text-xs whitespace-nowrap">{{ frame.label }}</td>
                <td class="max-w-[32rem] px-3 py-1.5 font-mono text-xs break-words">
                  <span v-if="frame.value">{{ frame.value }}</span>
                  <span v-else class="text-muted-foreground italic">
                    {{
                      frame.encrypted ? "encrypted" : frame.compressed ? "compressed" : "no text"
                    }}
                  </span>
                  <span v-if="frame.description" class="text-muted-foreground">
                    ({{ frame.description }})
                  </span>
                </td>
                <td class="px-3 py-1.5 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                  {{ frame.size.toLocaleString() }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
