<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, FileType, X } from "lucide-vue-next";
import { ToolError, type OptionSpec, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import type { FontFormat, FontInfo, PresetName, SubsetResult } from "@/tools/font-subsetter/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Font Subsetter.
 *
 * The generic ToolShell can only describe a subset in text. This tool makes a
 * font file, so the panel owns the file reading, the two temporary FontFace
 * objects behind the before and after preview, the size bar, the glyph table,
 * and the download, while every byte it shows still comes from the pure logic
 * layer (PROJECT.md rule 27): inspectFont, resolveCharacters, subsetFont,
 * toWoff, toWoff2, unicodeRangeCss, fontFaceCss, and subsetFileName.
 *
 * The logic module's `run` is deliberately not used. It answers the generic
 * shell by describing the result in rows of text and by inlining a small
 * subset as a base64 data URL, which would double the memory cost of bytes
 * that are already in this tab. The panel calls the individual functions and
 * keeps the real Uint8Array for the preview and the download.
 *
 * Loading is staged so nothing heavy runs before it is asked for:
 *
 * 1. The logic module (opentype.js, fflate) is imported on the first dropped
 *    font, not on page load, so the panel renders inert on the server and
 *    costs nothing on a visit that only reads the page copy.
 * 2. wawoff2, the wasm WOFF2 codec, is close to a megabyte and is never
 *    imported here at all. `toWoff2` and `fromWoff2` inside the logic layer
 *    pull it in with their own dynamic import on first use, so it loads when
 *    the Create subset button asks for WOFF2 output, or when a WOFF2 file is
 *    dropped and has to be decompressed before it can be read. Both paths
 *    carry a busy label that names what is loading.
 *
 * Nothing touches the DOM at import or setup time: every FontFace lives inside
 * an event handler, and both faces are removed from document.fonts on a new
 * file, on a new subset, and on unmount.
 */
const props = defineProps<{ meta: ToolMeta }>();

type Logic = typeof import("@/tools/font-subsetter/index");

interface PanelError {
  message: string;
  fix?: string;
}

interface SubsetOutput {
  /** The encoded file exactly as it will be downloaded. */
  bytes: Uint8Array;
  format: FontFormat;
  fileName: string;
  glyphCount: number;
  kept: number[];
  missing: number[];
  droppedTables: string[];
  originalSize: number;
  unicodeRange: string;
  css: string;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

const ACCEPT = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";

/**
 * Mirrors PRESET_CHOICES in the logic layer, which is module private. The six
 * values are the ones the tool's own metadata offers, and each one is
 * cumulative: picking Greek keeps basic Latin too.
 */
const PRESET_CHOICES: Record<string, PresetName[]> = {
  "basic-latin": ["basic-latin"],
  "latin-1": ["basic-latin", "latin-1"],
  "latin-ext": ["basic-latin", "latin-1", "latin-ext"],
  greek: ["basic-latin", "greek"],
  cyrillic: ["basic-latin", "cyrillic"],
  none: [],
};

/**
 * Mirrors OUTPUT_FORMATS in the logic layer, also module private. The meta
 * value "ttf" maps to "otf" on purpose: opentype.js 2.x has no glyf writer, so
 * every uncompressed file it produces carries CFF outlines and the OTTO
 * flavor, which makes it an .otf whatever went in.
 */
const OUTPUT_FORMATS: Record<string, FontFormat> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "otf",
  otf: "otf",
};

const FORMAT_LABELS: Record<FontFormat, string> = {
  ttf: "TrueType (.ttf)",
  otf: "OpenType CFF (.otf)",
  woff: "WOFF",
  woff2: "WOFF2",
};

const FORMAT_MIME: Record<FontFormat, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** Both preview lines stay inside printable ASCII so a basic Latin subset covers them. */
const SAMPLE_SENTENCE = "Typography is what language looks like.";
const PANGRAM = "Sphinx of black quartz, judge my vow. 0123456789";

/** Cells drawn before the glyph table asks to be expanded, and after. */
const GLYPH_PREVIEW_LIMIT = 240;
const GLYPH_EXPANDED_LIMIT = 2000;

/** Missing code points named one by one before the count takes over. */
const MISSING_SHOWN = 12;

/* ---------------------------------------------------------------- */
/* option specs, read from the tool's own metadata                   */
/* ---------------------------------------------------------------- */

function metaSelect(id: string): SelectOptionSpec | null {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === id);
  return found && found.kind === "select" ? found : null;
}

interface TextFieldSpec {
  label: string;
  placeholder: string;
}

function metaText(id: string, label: string, placeholder: string): TextFieldSpec {
  const found = props.meta.options?.find((o) => o.kind === "text" && o.id === id);
  if (found && found.kind === "text") {
    return { label: found.label, placeholder: found.placeholder ?? placeholder };
  }
  return { label, placeholder };
}

function metaBoolean(id: string, label: string, fallback: boolean): OptionSpec {
  const found = props.meta.options?.find((o) => o.kind === "boolean" && o.id === id);
  if (found && found.kind === "boolean") return found;
  return { kind: "boolean", id, label, default: fallback };
}

const presetSpec = computed<SelectOptionSpec>(
  () =>
    metaSelect("preset") ?? {
      kind: "select",
      id: "preset",
      label: "Character set",
      default: "basic-latin",
      options: [
        { value: "basic-latin", label: "Basic Latin", synonyms: ["ascii"] },
        { value: "none", label: "None, use only my characters", synonyms: ["custom"] },
      ],
    },
);

const formatSpec = computed<OptionSpec>(
  () =>
    metaSelect("format") ?? {
      kind: "select",
      id: "format",
      label: "Output format",
      default: "woff2",
      options: [
        { value: "woff2", label: "WOFF2", synonyms: ["woff2"] },
        { value: "woff", label: "WOFF", synonyms: ["woff"] },
        { value: "ttf", label: "Uncompressed OpenType (.otf)", synonyms: ["otf"] },
      ],
    },
);

const digitsSpec = computed<OptionSpec>(() =>
  metaBoolean("includeDigitsPunct", "Add digits and punctuation", true),
);

const textSpec = metaText("text", "Characters to keep", "Paste the exact text to render");
const rangesSpec = metaText("ranges", "Extra unicode ranges", "U+2018-201F, U+20AC");

const presetOptions = computed(() => presetSpec.value.options ?? []);

function booleanDefault(spec: OptionSpec): boolean {
  return spec.kind === "boolean" ? spec.default : true;
}

function selectDefault(spec: OptionSpec): string {
  return spec.kind === "select" ? spec.default : "";
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<Logic | null>(null);
const fileBytes = shallowRef<Uint8Array | null>(null);
const fileName = ref("");
const info = shallowRef<FontInfo | null>(null);

const preset = ref(presetSpec.value.default);
const includeDigitsPunct = ref(booleanDefault(digitsSpec.value));
const format = ref(selectDefault(formatSpec.value));
const characters = ref("");
const ranges = ref("");

const dragging = ref(false);
const busy = ref(false);
const busyLabel = ref("");
const error = ref<PanelError | null>(null);
const result = shallowRef<SubsetOutput | null>(null);
/** True once an option changed after the subset on screen was built. */
const stale = ref(false);
const showAllGlyphs = ref(false);
const previewNote = ref("");

const fileInput = ref<HTMLInputElement>();

/** The temporary families the preview renders in. Empty until a face loads. */
const originalFamily = ref("");
const subsetFamily = ref("");

/** Discards the answer of a run that a newer drop or click already replaced. */
let runToken = 0;
/** Makes every FontFace family name unique, so a reload never shadows a face. */
let faceSeq = 0;
let originalFace: FontFace | null = null;
let subsetFace: FontFace | null = null;
let logicPromise: Promise<Logic> | null = null;
/**
 * True once wawoff2 has been pulled in. The logic layer keeps one promise for
 * the whole codec, so a WOFF2 file that was read has already paid for the
 * encoder as well, and the busy label should stop claiming a download that is
 * not going to happen again.
 */
let woff2Loaded = false;

function loadLogic(): Promise<Logic> {
  logicPromise ??= (async () => {
    const logic = await import("@/tools/font-subsetter/index");
    // The bundled wawoff2 package cannot initialize in a browser (its glue
    // only exports under Node), so hand the logic a worker-backed codec from
    // the self-hosted glue under /wawoff2/ before any WOFF2 call happens.
    const { getWoff2Codec } = await import("@/lib/woff2");
    logic.setWoff2Codec(getWoff2Codec());
    return logic;
  })();
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const selectedPresets = computed<PresetName[]>(() => {
  const chosen = [...(PRESET_CHOICES[preset.value] ?? [])];
  if (includeDigitsPunct.value) chosen.push("digits", "punctuation");
  return chosen;
});

/**
 * The live selection. resolveCharacters throws a ToolError on a half-typed
 * range, which is a hint rather than a failure, so it is caught here and shown
 * next to the field instead of replacing the panel with an alert.
 */
const selection = computed<{ codePoints: number[]; problem: PanelError | null }>(() => {
  const lib = logic.value;
  if (!lib) return { codePoints: [], problem: null };
  try {
    return {
      codePoints: lib.resolveCharacters({
        text: characters.value,
        ranges: ranges.value,
        presets: selectedPresets.value,
      }),
      problem: null,
    };
  } catch (e) {
    return { codePoints: [], problem: toPanelError(e) };
  }
});

const selectedRange = computed(() => {
  const lib = logic.value;
  if (!lib || selection.value.codePoints.length === 0) return "";
  return lib.unicodeRangeCss(selection.value.codePoints);
});

const canSubset = computed(
  () => info.value !== null && !busy.value && selection.value.codePoints.length > 0,
);

const outputFormat = computed<FontFormat>(() => OUTPUT_FORMATS[format.value] ?? "woff2");

const comparison = computed(() => {
  const current = result.value;
  if (!current) return null;
  const originalSize = current.originalSize;
  const subsetSize = current.bytes.length;
  const change = originalSize > 0 ? 1 - subsetSize / originalSize : 0;
  const same = Math.abs(change) < 0.0005;
  return {
    originalSize,
    subsetSize,
    same,
    smaller: change > 0,
    /** Clamped so a subset larger than the original still draws a full bar. */
    width: originalSize > 0 ? Math.min(100, (subsetSize / originalSize) * 100) : 100,
    percent: `${(Math.abs(change) * 100).toFixed(1)}%`,
  };
});

const shownGlyphs = computed<number[]>(() => {
  const current = result.value;
  if (!current) return [];
  const limit = showAllGlyphs.value ? GLYPH_EXPANDED_LIMIT : GLYPH_PREVIEW_LIMIT;
  return current.kept.slice(0, limit);
});

const hiddenGlyphCount = computed(() => {
  const current = result.value;
  if (!current) return 0;
  return current.kept.length - shownGlyphs.value.length;
});

const missingShown = computed<number[]>(() => result.value?.missing.slice(0, MISSING_SHOWN) ?? []);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function toPanelError(e: unknown): PanelError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** "U+0041". Borrowed from the logic layer so the panel formats no hex itself. */
function codePointLabel(codePoint: number): string {
  return logic.value?.unicodeRangeCss([codePoint]) ?? "";
}

function charOf(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

/** A quoted family plus a fallback, safe to drop straight into a style binding. */
function familyStack(family: string): string {
  return family === "" ? "inherit" : `"${family}", system-ui, sans-serif`;
}

/**
 * Lets the busy label paint before a synchronous rebuild blocks the thread.
 *
 * The timer is not belt and braces: a background tab stops firing animation
 * frames, so waiting on the frame alone would hold the subset until the tab
 * came back to the front.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

function dropFace(face: FontFace | null): void {
  if (face) document.fonts.delete(face);
}

function clearPreview(): void {
  dropFace(originalFace);
  dropFace(subsetFace);
  originalFace = null;
  subsetFace = null;
  originalFamily.value = "";
  subsetFamily.value = "";
  previewNote.value = "";
}

/**
 * Load `bytes` as a temporary FontFace under a fresh family name.
 *
 * A font the browser refuses is not a panel failure: the subset bytes are
 * still valid and still downloadable, so a rejected load only turns the
 * preview off and leaves a note behind.
 */
async function showFace(
  kind: "original" | "subset",
  bytes: Uint8Array,
  token: number,
): Promise<void> {
  faceSeq += 1;
  const family = `tools-font-${kind}-${faceSeq}`;
  const face = new FontFace(family, bytes.slice().buffer);
  try {
    await face.load();
  } catch {
    if (token !== runToken) return;
    previewNote.value =
      kind === "original"
        ? "This browser could not render the original font, so only the subset is previewed."
        : "This browser could not render the subset, so only the original is previewed. The file still downloads.";
    return;
  }
  if (token !== runToken) {
    return;
  }
  document.fonts.add(face);
  if (kind === "original") {
    dropFace(originalFace);
    originalFace = face;
    originalFamily.value = family;
  } else {
    dropFace(subsetFace);
    subsetFace = face;
    subsetFamily.value = family;
  }
}

/* ---------------------------------------------------------------- */
/* loading a font                                                    */
/* ---------------------------------------------------------------- */

async function loadFile(file: File): Promise<void> {
  const token = ++runToken;
  error.value = null;
  result.value = null;
  stale.value = false;
  showAllGlyphs.value = false;
  clearPreview();
  busy.value = true;
  busyLabel.value = "Reading the font";

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lib = await loadLogic();
    if (token !== runToken) return;
    logic.value = lib;

    // Naming the format first is what lets the busy label be honest about the
    // WOFF2 decoder, which only a WOFF2 input has to wait for.
    const sourceFormat = lib.detectFormat(bytes);
    if (sourceFormat === "woff2" && !woff2Loaded) {
      busyLabel.value = "Loading the WOFF2 decoder, then reading the font";
    }
    await nextFrame();

    const parsed = await lib.inspectFont(bytes);
    if (sourceFormat === "woff2") woff2Loaded = true;
    if (token !== runToken) return;

    fileBytes.value = bytes;
    fileName.value = file.name === "" ? "font" : file.name;
    info.value = parsed;
    await showFace("original", bytes, token);
  } catch (e) {
    if (token !== runToken) return;
    error.value = toPanelError(e);
    fileBytes.value = null;
    fileName.value = "";
    info.value = null;
  } finally {
    if (token === runToken) {
      busy.value = false;
      busyLabel.value = "";
    }
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const picked = e.dataTransfer?.files?.[0];
  if (!picked) {
    error.value = {
      message: "Nothing in that drop was a file.",
      fix: "Drop a .ttf, .otf, .woff, or .woff2 file, or use Open font to pick one.",
    };
    return;
  }
  void loadFile(picked);
}

function onPickFile(e: Event): void {
  const picker = e.target as HTMLInputElement;
  const picked = picker.files?.[0];
  if (!picked) return;
  void loadFile(picked).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function clearFile(): void {
  runToken += 1;
  clearPreview();
  fileBytes.value = null;
  fileName.value = "";
  info.value = null;
  result.value = null;
  stale.value = false;
  showAllGlyphs.value = false;
  error.value = null;
  busy.value = false;
  busyLabel.value = "";
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* building the subset                                               */
/* ---------------------------------------------------------------- */

async function createSubset(): Promise<void> {
  const bytes = fileBytes.value;
  const lib = logic.value;
  if (!bytes || !lib) return;

  const token = ++runToken;
  error.value = null;
  busy.value = true;
  busyLabel.value = "Rebuilding the font from the glyphs you kept";
  await nextFrame();

  try {
    const chosen = outputFormat.value;
    const subset: SubsetResult = await lib.subsetFont(bytes, selection.value.codePoints);
    if (token !== runToken) return;

    let bytesOut: Uint8Array;
    if (chosen === "woff2") {
      busyLabel.value = woff2Loaded
        ? "Compressing the subset to WOFF2"
        : "Loading the WOFF2 encoder, then compressing";
      await nextFrame();
      bytesOut = await lib.toWoff2(subset.ttf);
      woff2Loaded = true;
    } else if (chosen === "woff") {
      busyLabel.value = "Writing the WOFF container";
      await nextFrame();
      bytesOut = lib.toWoff(subset.ttf);
    } else {
      bytesOut = subset.ttf;
    }
    if (token !== runToken) return;

    const unicodeRange = lib.unicodeRangeCss(subset.kept);
    const name = lib.subsetFileName(subset.info.familyName, chosen);

    result.value = {
      bytes: bytesOut,
      format: chosen,
      fileName: name,
      glyphCount: subset.glyphCount,
      kept: subset.kept,
      missing: subset.missing,
      droppedTables: subset.droppedTables,
      originalSize: subset.info.size,
      unicodeRange,
      css: lib.fontFaceCss({
        family: subset.info.familyName,
        format: chosen,
        fileName: name,
        unicodeRange,
      }),
    };
    stale.value = false;
    showAllGlyphs.value = false;
    // Retire the previous face before the new one loads. A face the browser
    // refuses leaves showFace with nothing to install, and a stale family name
    // would draw the last subset's glyphs under this subset's code points.
    dropFace(subsetFace);
    subsetFace = null;
    subsetFamily.value = "";
    await showFace("subset", bytesOut, token);
  } catch (e) {
    if (token !== runToken) return;
    error.value = toPanelError(e);
    result.value = null;
    dropFace(subsetFace);
    subsetFace = null;
    subsetFamily.value = "";
  } finally {
    if (token === runToken) {
      busy.value = false;
      busyLabel.value = "";
    }
  }
}

function download(): void {
  const current = result.value;
  if (!current) return;
  downloadBlob(
    new Blob([current.bytes.slice()], { type: FORMAT_MIME[current.format] }),
    current.fileName,
  );
}

watch([preset, includeDigitsPunct, format, characters, ranges], () => {
  if (result.value) stale.value = true;
});

onUnmounted(() => {
  runToken += 1;
  clearPreview();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Font input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Font
        </span>
        <div class="flex items-center gap-1">
          <Button v-if="info" variant="ghost" size="sm" @click="clearFile">
            <X class="size-4" />
            Clear font
          </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open font </Button>
          <input ref="fileInput" type="file" class="hidden" :accept="ACCEPT" @change="onPickFile" />
        </div>
      </div>

      <div v-if="info" class="flex items-center gap-3 px-3 pt-1 pb-3">
        <div
          class="grid size-10 shrink-0 place-items-center rounded-[8px] bg-background shadow-[var(--sh-inset)]"
        >
          <FileType class="size-5 text-muted-foreground" />
        </div>
        <div class="min-w-0">
          <div class="truncate font-mono text-sm">{{ fileName }}</div>
          <div class="text-xs text-muted-foreground tabular-nums">
            {{ info.formatLabel }} · {{ formatBytes(info.size) }} ·
            {{ count(info.glyphCount) }} glyphs
          </div>
        </div>
      </div>

      <p v-else class="px-3 pt-1 pb-3 text-sm text-muted-foreground">
        Drop a .ttf, .otf, .woff, or .woff2 file here, or use Open font. Nothing runs until a font
        arrives, and the font stays in this tab.
      </p>
    </div>

    <!-- Busy -->
    <p v-if="busy" class="font-mono text-xs text-muted-foreground tabular-nums" aria-live="polite">
      {{ busyLabel }}
    </p>

    <!-- Error -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <template v-if="info">
      <!-- What the font is -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          This font
        </span>

        <div class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">Family</div>
            <div class="truncate font-mono text-sm">{{ info.familyName }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">Style</div>
            <div class="truncate font-mono text-sm">{{ info.styleName }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">Glyphs</div>
            <div class="font-mono text-sm tabular-nums">{{ count(info.glyphCount) }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">Units per em</div>
            <div class="font-mono text-sm tabular-nums">{{ count(info.unitsPerEm) }}</div>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <div class="text-xs text-muted-foreground">
            Coverage: {{ count(info.codePoints.length) }} mapped characters
          </div>
          <div v-if="info.blocks.length" class="flex flex-wrap gap-1.5">
            <span
              v-for="block in info.blocks.slice(0, 8)"
              :key="block.name"
              class="rounded-[8px] bg-card px-2 py-1 text-xs shadow-[var(--sh-inset)]"
            >
              {{ block.name }}
              <span class="text-muted-foreground tabular-nums">{{ count(block.count) }}</span>
            </span>
          </div>
          <p v-else class="text-xs text-muted-foreground">
            This font has no character map, so there is nothing to subset by code point.
          </p>
        </div>

        <p v-if="info.layoutTables.length" class="text-xs text-muted-foreground">
          Carries {{ info.layoutTables.join(", ") }}. A rebuild cannot carry those over, so
          ligatures, kerning, and the other OpenType features in them are dropped from the subset.
        </p>
      </div>

      <!-- Character set -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Characters to keep
        </span>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">{{ presetSpec.label }}</span>
          <div class="inline-flex flex-wrap gap-1 rounded-[10px] bg-background p-1">
            <Button
              v-for="option in presetOptions"
              :key="option.value"
              variant="ghost"
              size="sm"
              :aria-pressed="preset === option.value"
              :class="preset === option.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="preset = option.value"
            >
              {{ option.label }}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="font-subset-text" class="text-xs text-muted-foreground">
            {{ textSpec.label }}
          </Label>
          <Textarea
            id="font-subset-text"
            :model-value="characters"
            rows="3"
            spellcheck="false"
            :placeholder="textSpec.placeholder"
            class="min-h-20 resize-y bg-card font-mono text-sm"
            @update:model-value="(v) => (characters = String(v))"
          />
          <p class="text-xs text-muted-foreground">
            Every character in this box is kept, on top of the set above. Paste the real copy the
            font has to render and the subset covers it exactly.
          </p>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex min-w-52 flex-1 flex-col gap-1.5">
            <Label for="font-subset-ranges" class="text-xs text-muted-foreground">
              {{ rangesSpec.label }}
            </Label>
            <Input
              id="font-subset-ranges"
              :model-value="ranges"
              :placeholder="rangesSpec.placeholder"
              class="h-9 bg-card font-mono"
              @update:model-value="(v) => (ranges = String(v))"
            />
          </div>
          <div class="w-44">
            <OptionControl
              :spec="digitsSpec"
              :model-value="includeDigitsPunct"
              @update:model-value="(v) => (includeDigitsPunct = Boolean(v))"
            />
          </div>
          <div class="w-52">
            <OptionControl
              :spec="formatSpec"
              :model-value="format"
              @update:model-value="(v) => (format = String(v))"
            />
          </div>
        </div>

        <div
          v-if="selection.problem"
          role="status"
          class="rounded-lg bg-card px-3 py-2 text-sm shadow-[var(--sh-inset)]"
        >
          <p class="font-medium text-muted-foreground">{{ selection.problem.message }}</p>
          <p v-if="selection.problem.fix" class="mt-1 text-xs text-muted-foreground">
            {{ selection.problem.fix }}
          </p>
        </div>

        <div v-else-if="selectedRange" class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ count(selection.codePoints.length) }} characters selected
            </span>
            <CopyButton :text="selectedRange" label="Copy unicode-range" />
          </div>
          <div
            class="max-h-20 overflow-y-auto rounded-[8px] bg-card px-2 py-1.5 font-mono text-xs break-words shadow-[var(--sh-inset)]"
          >
            {{ selectedRange }}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Button :disabled="!canSubset" @click="createSubset">
            {{ busy ? "Working…" : "Create subset" }}
          </Button>
          <p v-if="stale" class="text-xs text-muted-foreground">
            The settings changed since the subset below was built.
          </p>
          <p
            v-else-if="!busy && selection.codePoints.length === 0 && !selection.problem"
            class="text-xs text-muted-foreground"
          >
            Nothing is selected yet, so there would be nothing to keep. Pick a character set or type
            the characters you need.
          </p>
        </div>
      </div>
    </template>

    <!-- Result -->
    <template v-if="result && comparison">
      <div
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        :class="stale ? 'opacity-60' : ''"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Subset
          </span>
          <Button variant="ghost" size="sm" @click="download">
            <Download class="size-4" />
            Download {{ result.fileName }}
          </Button>
        </div>

        <p v-if="stale" class="text-xs text-muted-foreground">
          Everything below, the file name and the format included, comes from the settings this
          subset was built with, not the ones selected now. Create the subset again to catch up.
        </p>

        <!-- Size bar -->
        <div class="flex flex-col gap-2">
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-muted-foreground">Original</span>
              <span class="font-mono tabular-nums">{{ formatBytes(comparison.originalSize) }}</span>
            </div>
            <div class="h-2.5 w-full overflow-hidden rounded-full bg-background">
              <div class="h-full w-full rounded-full bg-muted-foreground/50" />
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-muted-foreground"> {{ FORMAT_LABELS[result.format] }} subset </span>
              <span class="font-mono tabular-nums">{{ formatBytes(comparison.subsetSize) }}</span>
            </div>
            <div class="h-2.5 w-full overflow-hidden rounded-full bg-background">
              <div
                class="h-full rounded-full transition-[width] duration-150 ease-out"
                :class="comparison.smaller ? 'bg-positive' : 'bg-primary'"
                :style="{ width: `${comparison.width}%` }"
              />
            </div>
          </div>

          <p class="text-xs text-muted-foreground tabular-nums">
            <template v-if="comparison.same">
              The subset is the same size as the original.
            </template>
            <template v-else-if="comparison.smaller">
              {{ comparison.percent }} smaller than the original.
            </template>
            <template v-else>
              {{ comparison.percent }} larger than the original. That happens when a compressed
              source, usually a WOFF2 file, is written back out uncompressed.
            </template>
            {{ count(result.glyphCount) }} glyphs including .notdef.
          </p>
        </div>

        <!-- Before and after -->
        <div class="flex flex-col gap-2">
          <span class="text-xs text-muted-foreground">Before and after</span>
          <div class="grid gap-2 sm:grid-cols-2">
            <div class="flex flex-col gap-2 rounded-[8px] bg-card p-3 shadow-[var(--sh-inset)]">
              <span class="text-xs text-muted-foreground">Original</span>
              <p
                class="text-xl leading-tight break-words"
                :style="{ fontFamily: familyStack(originalFamily) }"
              >
                {{ SAMPLE_SENTENCE }}
              </p>
              <p
                class="text-sm leading-snug break-words text-muted-foreground"
                :style="{ fontFamily: familyStack(originalFamily) }"
              >
                {{ PANGRAM }}
              </p>
            </div>

            <div class="flex flex-col gap-2 rounded-[8px] bg-card p-3 shadow-[var(--sh-inset)]">
              <span class="text-xs text-muted-foreground">Subset</span>
              <p
                class="text-xl leading-tight break-words"
                :style="{ fontFamily: familyStack(subsetFamily) }"
              >
                {{ SAMPLE_SENTENCE }}
              </p>
              <p
                class="text-sm leading-snug break-words text-muted-foreground"
                :style="{ fontFamily: familyStack(subsetFamily) }"
              >
                {{ PANGRAM }}
              </p>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Both lines are drawn with temporary font faces held in this tab. Any character the
            subset dropped falls back to your system font, which is exactly what a visitor would
            see.
          </p>
          <p v-if="previewNote" class="text-xs text-muted-foreground">{{ previewNote }}</p>
        </div>

        <!-- Glyph table -->
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              Kept {{ count(result.kept.length) }} characters
            </span>
            <Button
              v-if="hiddenGlyphCount > 0 || showAllGlyphs"
              variant="ghost"
              size="sm"
              @click="showAllGlyphs = !showAllGlyphs"
            >
              {{ showAllGlyphs ? "Show fewer" : "Show more" }}
            </Button>
          </div>

          <div
            class="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1 overflow-y-auto rounded-[8px] bg-card p-2 shadow-[var(--sh-inset)]"
          >
            <div
              v-for="cp in shownGlyphs"
              :key="cp"
              class="flex flex-col items-center gap-0.5 rounded-[6px] py-1.5"
              :title="codePointLabel(cp)"
            >
              <span
                class="text-lg leading-none"
                :style="{ fontFamily: familyStack(subsetFamily) }"
                aria-hidden="true"
                >{{ charOf(cp) }}</span
              >
              <span class="font-mono text-[10px] text-muted-foreground tabular-nums">
                {{ codePointLabel(cp) }}
              </span>
            </div>
          </div>

          <p v-if="hiddenGlyphCount > 0" class="text-xs text-muted-foreground tabular-nums">
            {{ count(hiddenGlyphCount) }} more kept characters are not drawn here. All of them are
            in the file.
          </p>

          <p v-if="result.missing.length" class="text-xs text-muted-foreground">
            {{ count(result.missing.length) }} selected characters have no glyph in this font, so
            they were skipped:
            <span class="font-mono">{{ missingShown.map(codePointLabel).join(", ") }}</span>
            <template v-if="result.missing.length > missingShown.length">
              , and {{ count(result.missing.length - missingShown.length) }} more
            </template>
          </p>

          <p v-if="result.droppedTables.length" class="text-xs text-muted-foreground">
            {{ result.droppedTables.join(", ") }} dropped by the rebuild. Ligatures, kerning, and
            the other OpenType features in those tables are not in the subset.
          </p>
        </div>

        <!-- unicode-range and CSS -->
        <div v-if="result.unicodeRange" class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground">unicode-range of the subset</span>
            <CopyButton :text="result.unicodeRange" label="Copy range" />
          </div>
          <div
            class="max-h-20 overflow-y-auto rounded-[8px] bg-card px-2 py-1.5 font-mono text-xs break-words shadow-[var(--sh-inset)]"
          >
            {{ result.unicodeRange }}
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground">@font-face rule</span>
            <CopyButton :text="result.css" label="Copy CSS" />
          </div>
          <pre
            class="max-h-52 overflow-auto rounded-[8px] bg-card px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
            >{{ result.css }}</pre>
        </div>

        <Button class="self-start" @click="download">
          <Download class="size-4" />
          Download {{ result.fileName }} ({{ formatBytes(comparison.subsetSize) }})
        </Button>
      </div>
    </template>

    <p class="text-xs text-muted-foreground">
      The font parser, the subsetter, and the WOFF2 encoder all run inside this page, so your files
      and inputs never leave your device. A licensed font is never handed to a server. The size a
      font can reach is limited by the memory this tab has, not by an upload cap.
    </p>
  </div>
</template>
