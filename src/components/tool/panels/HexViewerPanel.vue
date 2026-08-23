<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { ChevronLeft, ChevronRight, Download, Play, Search, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  MAX_INPUT_BYTES,
  applyTemplate,
  detectType,
  entropy,
  entropyBlocks,
  extractStrings,
  hexDumpRows,
  parseTemplate,
  run as runHexViewer,
  toBytes,
  type ExtractedString,
  type HexRow,
  type InputEncoding,
  type TemplateField,
} from "@/tools/hex-viewer/index";
import { BUILTIN_TEMPLATES, findTemplate } from "@/tools/hex-viewer/templates";
import { formatByteCount, formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import OutputView from "../OutputView.vue";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the Hex Viewer.
 *
 * The generic ToolShell can only print one block of text, which is the wrong
 * shape for a file you want to move around inside. This panel renders a
 * windowed byte grid, a byte inspector, a struct template editor, and an
 * entropy map, while every byte it decodes still comes from the pure logic
 * layer (PROJECT.md rule 27): toBytes, hexDumpRows, parseTemplate,
 * applyTemplate, detectType, extractStrings, entropy, entropyBlocks and run.
 *
 * Only the rows on screen are built, so the grid stays smooth on a file of
 * many megabytes. The file is read once with arrayBuffer() and held in this
 * tab; nothing is uploaded and nothing is stored.
 *
 * One thing the logic layer does not export is a byte search, so the scan in
 * findMatches below lives here. The needle for a hex query still goes through
 * toBytes, so the parsing rules are not a second copy.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Row height in pixels. The spacer and the scroll math share this number, so
 * a row must never carry a border, a gap, or a taller line box. */
const ROW_HEIGHT = 22;
/** Rows rendered above and below the viewport so a fast flick stays filled. */
const OVERSCAN = 6;
/** Bars in the entropy map. One block of the file per bar. */
const ENTROPY_BARS = 256;
/** Longest selection offered as a hex string, so a copy cannot lock the tab. */
const MAX_COPY_BYTES = 64 * 1024;
/** Search stops here. Past this the answer is a filter, not a list. */
const MAX_MATCHES = 1000;
/** Bytes per row the toolbar offers. */
const ROW_CHOICES: number[] = [8, 16, 32];

/** Numeric types the byte inspector decodes at the selection start. */
const INSPECT_TYPES: string[] = [
  "u8",
  "i8",
  "u16le",
  "u16be",
  "i16le",
  "i16be",
  "u32le",
  "u32be",
  "i32le",
  "i32be",
  "u64le",
  "u64be",
  "i64le",
  "i64be",
  "f32le",
  "f32be",
  "f64le",
  "f64be",
];

/** Text types the inspector decodes across the whole selection. */
const INSPECT_TEXT_TYPES: string[] = ["char", "utf8", "utf16le"];

const STARTER_TEMPLATE = [
  "# One field per line: a type and a name.",
  "char[4] magic",
  "u32le size",
].join("\n");

const TEMPLATE_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "template",
  label: "Template",
  default: "auto",
  options: [
    { value: "auto", label: "Match the magic bytes", synonyms: ["auto", "detect"] },
    { value: "custom", label: "My own template", synonyms: ["custom", "mine"] },
    ...BUILTIN_TEMPLATES.map((t) => ({ value: t.id, label: t.label, synonyms: [t.id] })),
  ],
};

function selectSpec(id: string, fallback: SelectOptionSpec): SelectOptionSpec {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && found.kind === "select" ? found : fallback;
}

const templateSpec = computed(() => selectSpec("template", TEMPLATE_FALLBACK));

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

type TabId = "template" | "strings" | "info";
type SearchMode = "hex" | "text";

interface Problem {
  message: string;
  fix?: string;
}

interface Decoded {
  type: string;
  value: string;
}

const bytes = shallowRef<Uint8Array | null>(null);
const sourceName = ref("");
const encoding = ref<InputEncoding | null>(null);
const pasteText = ref("");
const busy = ref(false);
const error = ref<Problem | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const bytesPerRow = ref(16);
const uppercase = ref(false);

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(460);

const anchor = ref(-1);
const selStart = ref(-1);
const selEnd = ref(-1);
let selecting = false;

const gotoText = ref("");
const gotoError = ref("");

const searchMode = ref<SearchMode>("hex");
const searchQuery = ref("");
const searchError = ref("");
const matches = shallowRef<number[]>([]);
const matchIndex = ref(-1);
const needleLength = ref(0);
const searchTruncated = ref(false);

const tab = ref<TabId>("template");

const templateId = ref("auto");
const templateText = ref(STARTER_TEMPLATE);
const templateStart = ref(0);
const templateFields = shallowRef<TemplateField[]>([]);
const templateWarnings = shallowRef<string[]>([]);
const templateError = ref<Problem | null>(null);
const templateRan = ref(false);

const stringsEncoding = ref<"ascii" | "utf16le">("ascii");
const stringsMin = ref(4);
const stringsResult = shallowRef<ExtractedString[] | null>(null);
const stringsBusy = ref(false);

const summary = shallowRef<string | Record<string, string> | null>(null);
const summaryBusy = ref(false);
const summaryError = ref<Problem | null>(null);

let ready = false;

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */

function toProblem(e: unknown): Problem {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/** The eight digit offset column. hexDumpRows hands back a number, and the
 * dump convention is a padded hex offset that honors the uppercase switch. */
function offsetLabel(offset: number): string {
  const text = offset.toString(16).padStart(8, "0");
  return uppercase.value ? text.toUpperCase() : text;
}

function shortOffset(offset: number): string {
  const text = offset.toString(16);
  return uppercase.value ? `0x${text.toUpperCase()}` : `0x${text}`;
}

/* ------------------------------------------------------------------ *
 * loading bytes
 * ------------------------------------------------------------------ */

function resetView() {
  anchor.value = -1;
  selStart.value = -1;
  selEnd.value = -1;
  scrollTop.value = 0;
  matches.value = [];
  matchIndex.value = -1;
  needleLength.value = 0;
  searchError.value = "";
  searchTruncated.value = false;
  gotoError.value = "";
  templateFields.value = [];
  templateWarnings.value = [];
  templateError.value = null;
  templateRan.value = false;
  templateStart.value = 0;
  stringsResult.value = null;
  summary.value = null;
  summaryError.value = null;
  if (viewport.value) viewport.value.scrollTop = 0;
}

function loadInput(input: Uint8Array | string, name: string) {
  try {
    const result = toBytes(input);
    if (result.bytes.length > MAX_INPUT_BYTES) {
      throw new ToolError(
        "too-large",
        `That input is ${formatBytes(result.bytes.length)}, and this viewer reads up to ${formatBytes(MAX_INPUT_BYTES)}.`,
        "Past that size a browser tab is the wrong tool. Use a viewer that streams from disk.",
      );
    }
    resetView();
    bytes.value = result.bytes;
    encoding.value = result.encoding;
    sourceName.value = name;
    error.value = null;
    // A new file may match a different built in template, but a hand written
    // one is the user's work and survives the swap.
    if (templateId.value === "auto") templateText.value = templateSourceFor("auto");
    runTemplate();
    if (tab.value === "strings") loadStrings(true);
    if (tab.value === "info") loadSummary();
  } catch (e) {
    error.value = toProblem(e);
  }
}

async function readFile(file: File) {
  if (file.size > MAX_INPUT_BYTES) {
    error.value = {
      message: `${file.name} is ${formatBytes(file.size)}, and this viewer reads up to ${formatBytes(MAX_INPUT_BYTES)}.`,
      fix: "Past that size a browser tab is the wrong tool. Use a viewer that streams from disk.",
    };
    return;
  }
  busy.value = true;
  try {
    const buffer = await file.arrayBuffer();
    loadInput(new Uint8Array(buffer), file.name);
  } catch (e) {
    error.value = toProblem(e);
  } finally {
    busy.value = false;
  }
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

function loadPasted() {
  const text = pasteText.value;
  if (text.trim() === "") {
    error.value = {
      message: "There is nothing to read yet.",
      fix: "Paste a hex dump, a base64 string, or any text you want the bytes of.",
    };
    return;
  }
  loadInput(text, "pasted input");
}

function clearInput() {
  bytes.value = null;
  encoding.value = null;
  sourceName.value = "";
  error.value = null;
  resetView();
  if (fileInput.value) fileInput.value.value = "";
}

/* ------------------------------------------------------------------ *
 * facts
 * ------------------------------------------------------------------ */

const byteLength = computed(() => bytes.value?.length ?? 0);

const detected = computed(() => {
  const b = bytes.value;
  return b ? detectType(b) : null;
});

const overallEntropy = computed(() => {
  const b = bytes.value;
  return b ? entropy(b) : 0;
});

const entropyBars = computed<number[]>(() => {
  const b = bytes.value;
  if (!b || b.length === 0) return [];
  return entropyBlocks(b, Math.max(1, Math.ceil(b.length / ENTROPY_BARS)));
});

function barHeight(value: number): number {
  return Math.max(0.5, (value / 8) * 32);
}

/** Click anywhere on the entropy map to move the grid to that part of the file.
 * The go to offset field is the keyboard equivalent. */
function onMapClick(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (box.width <= 0) return;
  const ratio = Math.min(0.9999, Math.max(0, (e.clientX - box.left) / box.width));
  scrollToOffset(Math.floor(ratio * byteLength.value), true);
}

/* ------------------------------------------------------------------ *
 * the windowed grid
 * ------------------------------------------------------------------ */

const totalRows = computed(() => Math.max(1, Math.ceil(byteLength.value / bytesPerRow.value)));

const firstRow = computed(() =>
  Math.max(0, Math.min(Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN, totalRows.value - 1)),
);

const visibleRows = computed(() => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2);

const rows = computed<HexRow[]>(() => {
  const b = bytes.value;
  if (!b) return [];
  return hexDumpRows(b, {
    offset: firstRow.value * bytesPerRow.value,
    length: visibleRows.value * bytesPerRow.value,
    bytesPerRow: bytesPerRow.value,
    uppercase: uppercase.value,
  });
});

/** Rows below the rendered band, held open by the bottom spacer. */
const trailingRows = computed(() =>
  Math.max(0, totalRows.value - firstRow.value - rows.value.length),
);

function measure() {
  const el = viewport.value;
  if (el) viewportHeight.value = el.clientHeight;
}

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

/** Put `offset` on screen. `top` parks it at the first row instead of nudging
 * it into view, which is what a jump from the map or the offset field wants. */
function scrollToOffset(offset: number, top = false) {
  const el = viewport.value;
  if (!el) return;
  const row = Math.floor(Math.max(0, offset) / bytesPerRow.value);
  const wanted = row * ROW_HEIGHT;
  if (top) {
    el.scrollTop = wanted;
  } else if (wanted < el.scrollTop) {
    el.scrollTop = wanted;
  } else if (wanted + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
    el.scrollTop = wanted - el.clientHeight + ROW_HEIGHT;
  }
  scrollTop.value = el.scrollTop;
}

/** Bytes per row changes keep the top byte, not the scroll position, so
 * switching 16 to 32 does not teleport the view. */
function setBytesPerRow(next: number) {
  if (next === bytesPerRow.value) return;
  const top = Math.floor(scrollTop.value / ROW_HEIGHT) * bytesPerRow.value;
  bytesPerRow.value = next;
  nextTick(() => scrollToOffset(top, true));
}

/* ------------------------------------------------------------------ *
 * selection
 * ------------------------------------------------------------------ */

const selLength = computed(() =>
  selStart.value >= 0 && selEnd.value > selStart.value ? selEnd.value - selStart.value : 0,
);

const hasSelection = computed(() => selLength.value > 0);

function setRange(from: number, to: number) {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(byteLength.value, Math.max(from, to) + 1);
  selStart.value = lo;
  selEnd.value = hi;
}

function onCellDown(offset: number, e: PointerEvent) {
  if (e.shiftKey && anchor.value >= 0) {
    setRange(anchor.value, offset);
  } else {
    anchor.value = offset;
    setRange(offset, offset);
  }
  selecting = true;
  viewport.value?.focus();
}

function onCellEnter(offset: number) {
  if (!selecting || anchor.value < 0) return;
  setRange(anchor.value, offset);
}

function endSelecting() {
  selecting = false;
}

function moveCursor(delta: number, extend: boolean) {
  const length = byteLength.value;
  if (length === 0) return;
  const from = anchor.value < 0 ? 0 : anchor.value;
  const next = Math.max(0, Math.min(from + delta, length - 1));
  if (extend) {
    if (anchor.value < 0) anchor.value = next;
    setRange(anchor.value, next);
  } else {
    anchor.value = next;
    setRange(next, next);
  }
  scrollToOffset(next);
}

function onGridKeydown(e: KeyboardEvent) {
  const perRow = bytesPerRow.value;
  const perPage = perRow * Math.max(1, Math.floor(viewportHeight.value / ROW_HEIGHT) - 1);
  let delta: number | null = null;
  if (e.key === "ArrowRight") delta = 1;
  else if (e.key === "ArrowLeft") delta = -1;
  else if (e.key === "ArrowDown") delta = perRow;
  else if (e.key === "ArrowUp") delta = -perRow;
  else if (e.key === "PageDown") delta = perPage;
  else if (e.key === "PageUp") delta = -perPage;
  else if (e.key === "Home") delta = -((anchor.value < 0 ? 0 : anchor.value) % perRow);
  else if (e.key === "End") delta = perRow - 1 - ((anchor.value < 0 ? 0 : anchor.value) % perRow);
  if (delta === null) return;
  e.preventDefault();
  moveCursor(delta, e.shiftKey);
}

const highlighted = computed<Set<number>>(() => {
  const set = new Set<number>();
  const width = needleLength.value;
  if (width <= 0) return set;
  const from = firstRow.value * bytesPerRow.value;
  const to = from + visibleRows.value * bytesPerRow.value;
  for (const at of matches.value) {
    if (at + width <= from || at >= to) continue;
    for (let i = 0; i < width; i++) set.add(at + i);
  }
  return set;
});

function cellClass(offset: number): string {
  const selected = offset >= selStart.value && offset < selEnd.value;
  if (selected) return "bg-primary text-primary-foreground";
  if (highlighted.value.has(offset)) return "bg-[color:var(--accent-soft)] text-foreground";
  return "";
}

/** Hex of the current selection, built from the logic layer's dump rows so the
 * digits and the uppercase rule are never a second implementation. */
const selectionHex = computed(() => {
  const b = bytes.value;
  if (!b || !hasSelection.value || selLength.value > MAX_COPY_BYTES) return "";
  return hexDumpRows(b, {
    offset: selStart.value,
    length: selLength.value,
    bytesPerRow: 256,
    uppercase: uppercase.value,
  })
    .flatMap((row) => row.hex)
    .join(" ");
});

function saveSelection() {
  const b = bytes.value;
  if (!b || !hasSelection.value) return;
  const slice = b.slice(selStart.value, selEnd.value);
  const name = `selection-${selStart.value}-${selEnd.value}.bin`;
  downloadBlob(new Blob([slice.buffer as ArrayBuffer], { type: "application/octet-stream" }), name);
}

/* ------------------------------------------------------------------ *
 * byte inspector
 * ------------------------------------------------------------------ */

/**
 * Decode the bytes at the selection start as every fixed width type, plus the
 * whole selection as text. Each type is its own one line template, so the
 * reading, the endianness and the sizes all stay in the logic layer. A type
 * that runs off the end of the file throws, and is simply left out.
 */
const inspector = computed<Decoded[]>(() => {
  const b = bytes.value;
  const at = selStart.value;
  if (!b || at < 0 || at >= b.length) return [];
  const out: Decoded[] = [];
  for (const type of INSPECT_TYPES) {
    try {
      const result = applyTemplate(b, parseTemplate(`${type} value`), at, {
        uppercase: uppercase.value,
      });
      const field = result.fields[0];
      if (field) out.push({ type, value: String(field.value) });
    } catch {
      // The type does not fit in what is left of the file, so it has no value.
    }
  }
  const width = selLength.value;
  if (width > 0 && width <= MAX_COPY_BYTES) {
    for (const type of INSPECT_TEXT_TYPES) {
      try {
        const result = applyTemplate(b, parseTemplate(`${type}[${width}] value`), at, {
          uppercase: uppercase.value,
        });
        const field = result.fields[0];
        if (field) out.push({ type: `${type}[${width}]`, value: String(field.value) });
      } catch {
        // Same reason: the run does not fit, so there is nothing to show.
      }
    }
  }
  return out;
});

const inspectorText = computed(() =>
  inspector.value.map((row) => `${row.type}: ${row.value}`).join("\n"),
);

/* ------------------------------------------------------------------ *
 * go to offset
 * ------------------------------------------------------------------ */

function goToOffset() {
  const text = gotoText.value.trim();
  if (text === "") return;
  const value = /^0[xX]/.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 0) {
    gotoError.value = "Write a byte offset, either in decimal like 1024 or in hex like 0x400.";
    return;
  }
  if (value >= byteLength.value) {
    gotoError.value = `This file ends at ${shortOffset(Math.max(0, byteLength.value - 1))}.`;
    return;
  }
  gotoError.value = "";
  anchor.value = value;
  setRange(value, value);
  scrollToOffset(value, true);
}

/* ------------------------------------------------------------------ *
 * search
 * ------------------------------------------------------------------ */

/**
 * Logic layer gap: hex-viewer/index.ts exports no byte search, so the scan is
 * here. It is a plain forward scan, stopped at MAX_MATCHES, and it runs on
 * submit rather than on every keystroke because a large file is a real pass.
 */
function findMatches(haystack: Uint8Array, needle: Uint8Array): number[] {
  const found: number[] = [];
  const last = haystack.length - needle.length;
  const head = needle[0];
  for (let i = 0; i <= last; i++) {
    if (haystack[i] !== head) continue;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) {
      found.push(i);
      if (found.length >= MAX_MATCHES) break;
    }
  }
  return found;
}

function buildNeedle(): Uint8Array | null {
  const raw = searchQuery.value;
  if (raw === "") {
    searchError.value = "Type the bytes or the text you are looking for.";
    return null;
  }
  // Text keeps its spaces, since a space is a byte worth finding. Hex does not.
  if (searchMode.value === "text") return new TextEncoder().encode(raw);
  const query = raw.trim();
  if (query === "") {
    searchError.value = "Write pairs of hex digits, like 89 50 4e 47.";
    return null;
  }
  try {
    const result = toBytes(query);
    if (result.encoding !== "hex text") {
      searchError.value =
        "That is not a run of hex bytes. Write pairs of hex digits, like 89 50 4e 47.";
      return null;
    }
    return result.bytes;
  } catch (e) {
    searchError.value = toProblem(e).message;
    return null;
  }
}

function runSearch() {
  const b = bytes.value;
  if (!b) return;
  searchError.value = "";
  const needle = buildNeedle();
  if (!needle || needle.length === 0) {
    matches.value = [];
    matchIndex.value = -1;
    needleLength.value = 0;
    return;
  }
  const found = findMatches(b, needle);
  matches.value = found;
  needleLength.value = needle.length;
  searchTruncated.value = found.length >= MAX_MATCHES;
  if (found.length === 0) {
    matchIndex.value = -1;
    searchError.value = "No match in this file.";
    return;
  }
  matchIndex.value = 0;
  showMatch(0);
}

function showMatch(index: number) {
  const list = matches.value;
  if (list.length === 0) return;
  const wrapped = ((index % list.length) + list.length) % list.length;
  matchIndex.value = wrapped;
  const at = list[wrapped];
  anchor.value = at;
  selStart.value = at;
  selEnd.value = Math.min(byteLength.value, at + needleLength.value);
  scrollToOffset(at, true);
}

function clearSearch() {
  searchQuery.value = "";
  searchError.value = "";
  matches.value = [];
  matchIndex.value = -1;
  needleLength.value = 0;
  searchTruncated.value = false;
}

/* ------------------------------------------------------------------ *
 * struct template
 * ------------------------------------------------------------------ */

function templateSourceFor(id: string): string {
  // "My own template" means edit what is already in the box, so it is kept.
  if (id === "custom") return templateText.value || STARTER_TEMPLATE;
  if (id === "auto") {
    const auto = detected.value?.templateId;
    const found = auto ? findTemplate(auto) : undefined;
    return found ? found.text : STARTER_TEMPLATE;
  }
  return findTemplate(id)?.text ?? STARTER_TEMPLATE;
}

function applyTemplateChoice(id: string) {
  templateId.value = id;
  templateText.value = templateSourceFor(id);
  if (bytes.value) runTemplate();
}

function runTemplate() {
  const b = bytes.value;
  if (!b) return;
  templateRan.value = true;
  try {
    const nodes = parseTemplate(templateText.value);
    const result = applyTemplate(b, nodes, templateStart.value, { uppercase: uppercase.value });
    templateFields.value = result.fields;
    templateWarnings.value = result.warnings;
    templateError.value = null;
  } catch (e) {
    templateFields.value = [];
    templateWarnings.value = [];
    templateError.value = toProblem(e);
  }
}

function selectField(field: TemplateField) {
  if (field.size <= 0) return;
  anchor.value = field.offset;
  setRange(field.offset, field.offset + field.size - 1);
  scrollToOffset(field.offset, true);
}

function useSelectionAsStart() {
  if (selStart.value < 0) return;
  templateStart.value = selStart.value;
  runTemplate();
}

const templateFieldsText = computed(() =>
  templateFields.value
    .map((f) => `${offsetLabel(f.offset)}  ${f.type}  ${f.name} = ${String(f.value)}`)
    .join("\n"),
);

/* ------------------------------------------------------------------ *
 * strings and summary, both computed only when their tab is open
 * ------------------------------------------------------------------ */

async function loadStrings(force = false) {
  const b = bytes.value;
  if (!b) return;
  if (stringsResult.value && !force) return;
  stringsBusy.value = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    stringsResult.value = extractStrings(b, {
      minLength: Math.max(1, Math.floor(stringsMin.value)),
      encoding: stringsEncoding.value,
    });
  } finally {
    stringsBusy.value = false;
  }
}

const stringsText = computed(() =>
  (stringsResult.value ?? []).map((s) => `${offsetLabel(s.offset)}  ${s.text}`).join("\n"),
);

function setStringsEncoding(next: "ascii" | "utf16le") {
  if (next === stringsEncoding.value) return;
  stringsEncoding.value = next;
  loadStrings(true);
}

function setStringsMin(value: string | number) {
  stringsMin.value = Math.max(1, Number(value) || 1);
}

function selectString(found: ExtractedString) {
  const width = found.encoding === "utf16le" ? found.text.length * 2 : found.text.length;
  anchor.value = found.offset;
  setRange(found.offset, found.offset + Math.max(1, width) - 1);
  scrollToOffset(found.offset, true);
}

function setTemplateStart(value: string | number) {
  templateStart.value = Math.max(0, Math.floor(Number(value) || 0));
}

async function loadSummary() {
  const b = bytes.value;
  if (!b || summary.value) return;
  summaryBusy.value = true;
  summaryError.value = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    summary.value = runHexViewer(b, { view: "info" });
  } catch (e) {
    summaryError.value = toProblem(e);
  } finally {
    summaryBusy.value = false;
  }
}

function setTab(next: TabId) {
  tab.value = next;
  if (next === "strings") loadStrings();
  if (next === "info") loadSummary();
}

/* ------------------------------------------------------------------ *
 * shareable state
 * ------------------------------------------------------------------ */

watch([tab, templateId, bytesPerRow, uppercase], () => {
  if (!ready) return;
  writeFragment({
    opts: {
      view: tab.value,
      template: templateId.value,
      bytesPerRow: String(bytesPerRow.value),
      uppercase: String(uppercase.value),
    },
  });
});

// The grid only exists once a file is open, so its height is measured the
// moment the element appears rather than on mount.
watch(viewport, () => {
  measure();
});

onMounted(() => {
  const state = readFragment();
  const perRow = Number(state.opts["bytesPerRow"]);
  if (Number.isFinite(perRow) && ROW_CHOICES.includes(perRow)) bytesPerRow.value = perRow;
  if (state.opts["uppercase"] === "true") uppercase.value = true;
  const wanted = state.opts["template"];
  if (wanted && (wanted === "auto" || wanted === "custom" || findTemplate(wanted))) {
    templateId.value = wanted;
    templateText.value = templateSourceFor(wanted);
  }
  const view = state.opts["view"];
  if (view === "template" || view === "strings" || view === "info") tab.value = view;
  ready = true;
  window.addEventListener("pointerup", endSelecting);
  measure();
});

onUnmounted(() => {
  window.removeEventListener("pointerup", endSelecting);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)] transition-colors"
      :class="dragging ? 'ring-2 ring-ring/60' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Bytes
        </span>
        <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open a file… </Button>
        <input ref="fileInput" type="file" class="hidden" @change="onPickFile" />
      </div>

      <div v-if="bytes" class="px-3 pt-2 pb-3">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ sourceName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(byteLength) }}</span>
          <span v-if="encoding" class="shrink-0 text-muted-foreground">read as {{ encoding }}</span>
          <button
            type="button"
            aria-label="Close this file"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearInput"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <div v-else class="flex flex-col gap-2 px-3 pt-1 pb-3">
        <p class="text-sm text-muted-foreground">
          Drop any file here, or use the button above. Everything is read in this tab: your files
          and inputs never leave your device.
        </p>
        <Label for="hex-paste" class="text-xs text-muted-foreground">
          Or paste a hex dump, a base64 string, or plain text you want the bytes of
        </Label>
        <Textarea
          id="hex-paste"
          v-model="pasteText"
          rows="3"
          class="bg-card font-mono text-xs"
          placeholder="89504e470d0a1a0a"
        />
        <div>
          <Button size="sm" variant="outline" @click="loadPasted">Read these bytes</Button>
        </div>
      </div>
    </div>

    <p v-if="busy" class="text-xs text-muted-foreground" aria-live="polite">Reading the file…</p>

    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <template v-if="bytes">
      <!-- Facts -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Size</div>
          <div class="font-mono text-lg tabular-nums">{{ formatBytes(byteLength) }}</div>
          <div class="text-xs text-muted-foreground tabular-nums">
            {{ formatByteCount(byteLength) }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Detected type</div>
          <div class="font-mono text-lg">{{ detected?.label ?? "unknown" }}</div>
          <div class="text-xs text-muted-foreground">
            {{ detected ? "matched by magic bytes" : "no signature matched" }}
          </div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Entropy</div>
          <div class="font-mono text-lg tabular-nums">{{ overallEntropy.toFixed(2) }}</div>
          <div class="text-xs text-muted-foreground">bits per byte, 8 is the ceiling</div>
        </div>
        <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
          <div class="text-xs text-muted-foreground">Selection</div>
          <div class="font-mono text-lg tabular-nums">
            {{ hasSelection ? formatByteCount(selLength) : "none" }}
          </div>
          <div class="text-xs text-muted-foreground tabular-nums">
            {{ hasSelection ? `from ${shortOffset(selStart)}` : "click a byte in the grid" }}
          </div>
        </div>
      </div>

      <!-- Entropy map -->
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Entropy map
          </span>
          <span class="text-xs text-muted-foreground">Click to jump to that part of the file</span>
        </div>
        <div class="cursor-crosshair rounded-[6px] bg-card p-1" @click="onMapClick">
          <svg
            :viewBox="`0 0 ${Math.max(1, entropyBars.length)} 32`"
            preserveAspectRatio="none"
            class="h-14 w-full fill-primary"
            role="img"
            aria-label="Entropy of the file from start to end, one bar per block"
          >
            <rect
              v-for="(value, i) in entropyBars"
              :key="i"
              :x="i"
              :y="32 - barHeight(value)"
              width="1"
              :height="barHeight(value)"
              :opacity="0.3 + (value / 8) * 0.7"
            />
          </svg>
        </div>
        <p class="text-xs text-muted-foreground">
          Flat low bars are padding or plain text. A run near the top is compressed, encrypted, or
          packed data.
        </p>
      </div>

      <!-- Toolbar -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex flex-col gap-1">
            <Label for="hex-goto" class="text-xs text-muted-foreground">Go to offset</Label>
            <div class="flex items-center gap-2">
              <Input
                id="hex-goto"
                v-model="gotoText"
                class="h-9 w-36 bg-card font-mono text-xs"
                placeholder="0x400 or 1024"
                @keydown.enter="goToOffset"
              />
              <Button size="sm" variant="outline" @click="goToOffset">Go</Button>
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">Search for</span>
            <div class="flex flex-wrap items-center gap-2">
              <div class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]">
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-pressed="searchMode === 'hex'"
                  :class="searchMode === 'hex' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                  @click="searchMode = 'hex'"
                >
                  Hex bytes
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-pressed="searchMode === 'text'"
                  :class="searchMode === 'text' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                  @click="searchMode = 'text'"
                >
                  Text
                </Button>
              </div>
              <Input
                v-model="searchQuery"
                :aria-label="searchMode === 'hex' ? 'Hex bytes to find' : 'Text to find'"
                :placeholder="searchMode === 'hex' ? '89 50 4e 47' : 'IHDR'"
                class="h-9 w-44 bg-card font-mono text-xs"
                @keydown.enter="runSearch"
              />
              <Button size="sm" variant="outline" @click="runSearch">
                <Search class="size-3.5" />
                Find
              </Button>
              <Button
                v-if="matches.length > 0"
                size="sm"
                variant="ghost"
                aria-label="Previous match"
                @click="showMatch(matchIndex - 1)"
              >
                <ChevronLeft class="size-3.5" />
              </Button>
              <span v-if="matches.length > 0" class="font-mono text-xs tabular-nums">
                {{ matchIndex + 1 }} of {{ matches.length }}{{ searchTruncated ? "+" : "" }}
              </span>
              <Button
                v-if="matches.length > 0"
                size="sm"
                variant="ghost"
                aria-label="Next match"
                @click="showMatch(matchIndex + 1)"
              >
                <ChevronRight class="size-3.5" />
              </Button>
              <Button v-if="searchQuery" size="sm" variant="ghost" @click="clearSearch">
                Clear
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">Bytes per row</span>
            <div class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]">
              <Button
                v-for="choice in ROW_CHOICES"
                :key="choice"
                variant="ghost"
                size="sm"
                :aria-pressed="bytesPerRow === choice"
                :class="bytesPerRow === choice ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                @click="setBytesPerRow(choice)"
              >
                {{ choice }}
              </Button>
            </div>
          </div>

          <div class="flex items-center gap-2 pb-1">
            <Switch
              id="hex-uppercase"
              :model-value="uppercase"
              @update:model-value="(v) => (uppercase = Boolean(v))"
            />
            <Label for="hex-uppercase" class="text-xs text-muted-foreground">Uppercase hex</Label>
          </div>
        </div>

        <p v-if="gotoError" role="alert" class="text-xs text-destructive">{{ gotoError }}</p>
        <p v-if="searchError" role="alert" class="text-xs text-destructive">{{ searchError }}</p>
        <p v-else-if="searchTruncated" class="text-xs text-muted-foreground">
          Showing the first {{ MAX_MATCHES }} matches. Narrow the pattern to see the rest.
        </p>
      </div>

      <!-- Grid and inspector -->
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,280px)]">
        <div
          ref="viewport"
          tabindex="0"
          aria-label="Hex dump. Use the arrow keys to move, and hold shift to extend the selection."
          class="h-[440px] overflow-auto rounded-[10px] bg-secondary font-mono text-xs shadow-[var(--sh-inset)] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-[520px]"
          @scroll.passive="onScroll"
          @keydown="onGridKeydown"
        >
          <!-- Spacers stay in flow so the widest row still sets the scroll
               width. An absolutely positioned row band would not. -->
          <div class="w-max min-w-full">
            <div :style="{ height: `${firstRow * ROW_HEIGHT}px` }"></div>
            <div
              v-for="row in rows"
              :key="row.offset"
              class="flex items-center px-3 whitespace-nowrap"
              :style="{ height: `${ROW_HEIGHT}px` }"
            >
              <span class="mr-3 shrink-0 text-muted-foreground tabular-nums">
                {{ offsetLabel(row.offset) }}
              </span>
              <span
                v-for="(cell, i) in row.hex"
                :key="`h${i}`"
                class="inline-block w-[1.7em] shrink-0 rounded-[3px] text-center"
                :class="[cellClass(row.offset + i), (i + 1) % 8 === 0 ? 'mr-2' : '']"
                @pointerdown.prevent="onCellDown(row.offset + i, $event)"
                @pointerenter="onCellEnter(row.offset + i)"
              >
                {{ cell }}
              </span>
              <span class="mx-2 shrink-0 text-muted-foreground">|</span>
              <span
                v-for="(char, i) in row.ascii"
                :key="`a${i}`"
                class="inline-block w-[0.75em] shrink-0 rounded-[3px] text-center"
                :class="cellClass(row.offset + i)"
                @pointerdown.prevent="onCellDown(row.offset + i, $event)"
                @pointerenter="onCellEnter(row.offset + i)"
              >
                {{ char }}
              </span>
            </div>
            <div :style="{ height: `${trailingRows * ROW_HEIGHT}px` }"></div>
          </div>
        </div>

        <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Byte inspector
            </span>
            <CopyButton v-if="inspectorText" :text="inspectorText" label="Copy" />
          </div>

          <p v-if="!hasSelection" class="text-xs text-muted-foreground">
            Click a byte in the grid, or drag across a run, and every reading of it shows up here.
            Shift and click extends the selection, and so do the arrow keys with shift held.
          </p>

          <template v-else>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono tabular-nums">
                {{ shortOffset(selStart) }} to {{ shortOffset(selEnd - 1) }}
              </span>
              <span class="text-muted-foreground tabular-nums">
                {{ formatByteCount(selLength) }}
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <CopyButton v-if="selectionHex" :text="selectionHex" label="Copy hex" />
              <Button size="sm" variant="ghost" @click="saveSelection">
                <Download class="size-3.5" />
                Save bytes
              </Button>
            </div>
            <p v-if="!selectionHex" class="text-xs text-muted-foreground">
              This selection is larger than {{ formatBytes(MAX_COPY_BYTES) }}, so it is offered as a
              file rather than as hex text.
            </p>

            <dl class="divide-y divide-border/60 text-xs">
              <div v-for="row in inspector" :key="row.type" class="flex justify-between gap-3 py-1">
                <dt class="shrink-0 font-mono text-muted-foreground">{{ row.type }}</dt>
                <dd class="min-w-0 font-mono break-all tabular-nums">{{ row.value }}</dd>
              </div>
            </dl>
          </template>
        </div>
      </div>

      <!-- Views -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="tab === 'template'"
            :class="tab === 'template' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setTab('template')"
          >
            Struct template
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="tab === 'strings'"
            :class="tab === 'strings' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setTab('strings')"
          >
            Printable strings
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="tab === 'info'"
            :class="tab === 'info' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setTab('info')"
          >
            File summary
          </Button>
        </div>
      </div>

      <!-- Struct template -->
      <div
        v-if="tab === 'template'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex min-w-[220px] flex-col gap-1">
            <Label for="hex-template" class="text-xs text-muted-foreground">Template</Label>
            <SearchableSelect
              id="hex-template"
              :spec="templateSpec"
              :model-value="templateId"
              @update:model-value="applyTemplateChoice"
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="hex-template-start" class="text-xs text-muted-foreground">
              Start at byte
            </Label>
            <div class="flex items-center gap-2">
              <Input
                id="hex-template-start"
                :model-value="templateStart"
                type="number"
                min="0"
                class="h-9 w-28 bg-card font-mono text-xs"
                @update:model-value="setTemplateStart"
              />
              <Button
                size="sm"
                variant="ghost"
                :disabled="!hasSelection"
                @click="useSelectionAsStart"
              >
                Use selection
              </Button>
            </div>
          </div>
          <Button size="sm" variant="outline" @click="runTemplate">
            <Play class="size-3.5" />
            Run template
          </Button>
        </div>

        <Textarea
          v-model="templateText"
          rows="8"
          aria-label="Struct template source"
          class="bg-card font-mono text-xs"
          spellcheck="false"
        />
        <p class="text-xs text-muted-foreground">
          One statement per line: a field like u32be width or char[4] tag, plus skip, align,
          @offset, repeat and if. Lines starting with # are comments. Edit any built in template and
          run it again.
        </p>

        <div
          v-if="templateError"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">{{ templateError.message }}</p>
          <p v-if="templateError.fix" class="mt-1 text-muted-foreground">{{ templateError.fix }}</p>
        </div>

        <ul
          v-if="templateWarnings.length"
          class="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          <li v-for="(warning, i) in templateWarnings" :key="i">{{ warning }}</li>
        </ul>

        <div v-if="templateFields.length" class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ templateFields.length }} fields. Click a row to select its bytes in the grid.
            </span>
            <CopyButton :text="templateFieldsText" label="Copy fields" />
          </div>
          <div class="max-h-96 overflow-auto rounded-[8px] bg-card">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-left text-xs text-muted-foreground">
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">
                    Offset
                  </th>
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Field</th>
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Type</th>
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Size</th>
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/60">
                <tr
                  v-for="(field, i) in templateFields"
                  :key="`${field.name}-${i}`"
                  class="cursor-pointer align-top hover:bg-secondary"
                  @click="selectField(field)"
                >
                  <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap tabular-nums">
                    {{ offsetLabel(field.offset) }}
                  </td>
                  <td class="px-3 py-1.5 font-mono text-xs break-words">{{ field.name }}</td>
                  <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{{ field.type }}</td>
                  <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap tabular-nums">
                    {{ field.size }}
                  </td>
                  <td class="px-3 py-1.5 font-mono text-xs break-all">{{ String(field.value) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p v-else-if="templateRan && !templateError" class="text-xs text-muted-foreground">
          This template read no fields from the file.
        </p>
      </div>

      <!-- Printable strings -->
      <div
        v-else-if="tab === 'strings'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">Encoding</span>
            <div class="inline-flex gap-1 rounded-[10px] bg-card p-1 shadow-[var(--sh-inset)]">
              <Button
                variant="ghost"
                size="sm"
                :aria-pressed="stringsEncoding === 'ascii'"
                :class="stringsEncoding === 'ascii' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                @click="setStringsEncoding('ascii')"
              >
                ASCII
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :aria-pressed="stringsEncoding === 'utf16le'"
                :class="stringsEncoding === 'utf16le' ? 'bg-secondary shadow-[var(--sh-sm)]' : ''"
                @click="setStringsEncoding('utf16le')"
              >
                UTF-16LE
              </Button>
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <Label for="hex-strings-min" class="text-xs text-muted-foreground">
              Shortest run
            </Label>
            <Input
              id="hex-strings-min"
              :model-value="stringsMin"
              type="number"
              min="1"
              max="64"
              class="h-9 w-24 bg-card font-mono text-xs"
              @update:model-value="setStringsMin"
            />
          </div>
          <Button size="sm" variant="outline" @click="loadStrings(true)">
            <Play class="size-3.5" />
            Find strings
          </Button>
        </div>

        <p v-if="stringsBusy" class="text-xs text-muted-foreground" aria-live="polite">
          Reading the whole file…
        </p>

        <template v-else-if="stringsResult">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground tabular-nums">
              {{ stringsResult.length }} runs. Click one to select its bytes in the grid.
            </span>
            <CopyButton v-if="stringsText" :text="stringsText" label="Copy strings" />
          </div>
          <div v-if="stringsResult.length" class="max-h-96 overflow-auto rounded-[8px] bg-card">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="text-left text-xs text-muted-foreground">
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">
                    Offset
                  </th>
                  <th scope="col" class="sticky top-0 z-10 bg-card px-3 py-2 font-medium">Text</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/60">
                <tr
                  v-for="(found, i) in stringsResult"
                  :key="`${found.offset}-${i}`"
                  class="cursor-pointer align-top hover:bg-secondary"
                  @click="selectString(found)"
                >
                  <td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap tabular-nums">
                    {{ offsetLabel(found.offset) }}
                  </td>
                  <td class="px-3 py-1.5 font-mono text-xs break-all">{{ found.text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-xs text-muted-foreground">
            No printable run of that length in this file.
          </p>
        </template>

        <p v-else class="text-xs text-muted-foreground">
          Select Find strings to scan the whole file for printable runs and list them with their
          offsets.
        </p>
      </div>

      <!-- File summary -->
      <div
        v-else
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <p v-if="summaryBusy" class="text-xs text-muted-foreground" aria-live="polite">
          Hashing and measuring the whole file…
        </p>
        <div
          v-else-if="summaryError"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">{{ summaryError.message }}</p>
          <p v-if="summaryError.fix" class="mt-1 text-muted-foreground">{{ summaryError.fix }}</p>
        </div>
        <OutputView v-else-if="summary" :output="summary" />
      </div>
    </template>
  </div>
</template>
