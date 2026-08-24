<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import InkCanvas from "../InkCanvas.vue";

/**
 * Bespoke panel for the PDF toolbox.
 *
 * The generic ToolShell can only show the info readout, but this tool needs a
 * file list you can reorder, page thumbnails, and one output file per range,
 * so it gets its own island. The document editing itself stays in the pure
 * logic layer: this component only reads files, calls into it, and offers the
 * results as downloads.
 *
 * Two heavy dependencies are loaded on the first file rather than on page
 * load: pdf-lib through the logic module, and pdfjs-dist for the thumbnails.
 * Both are bundled with the site. The pdfjs worker is imported with Vite's
 * ?url suffix so it is emitted as a local asset and served from this origin,
 * never from a CDN.
 */
defineProps<{ meta: ToolMeta }>();

type PdfLogic = typeof import("@/tools/pdf-toolbox/index");
type PdfJs = typeof import("pdfjs-dist");
// Type only, so the logic module still loads lazily with the first file.
type PageGeometry = import("@/tools/pdf-toolbox/index").PageGeometry;

/** Width of a page thumbnail in CSS pixels, before device pixel ratio. */
const THUMB_WIDTH = 120;
/** Width of the small first page preview beside each file name. */
const FILE_THUMB_WIDTH = 48;
/** Pages rendered into the strip. Past this the preview stops, not the tool. */
const STRIP_LIMIT = 60;

interface LoadedFile {
  id: number;
  name: string;
  size: number;
  bytes: Uint8Array;
  pageCount: number;
  thumbUrl: string | null;
  error: { message: string; fix?: string } | null;
}

interface ResultFile {
  name: string;
  blob: Blob;
  note: string;
}

interface PageThumb {
  page: number;
  url: string;
}

interface FieldInfo {
  name: string;
  type: string;
  value?: string;
  options?: string[];
}

/* ---------------------------------------------------------------- */
/* lazy dependencies                                                 */
/* ---------------------------------------------------------------- */

let logicPromise: Promise<PdfLogic> | null = null;
function loadLogic(): Promise<PdfLogic> {
  logicPromise ??= import("@/tools/pdf-toolbox/index");
  return logicPromise;
}

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    // Self hosted worker: Vite emits this file into the site's own assets.
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return pdfjsPromise;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const files = ref<LoadedFile[]>([]);
const activeId = ref<number | null>(null);
const operation = ref("merge");
const busy = ref(false);
const busyLabel = ref("");
const dragging = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);
const results = ref<ResultFile[]>([]);
const fileInput = ref<HTMLInputElement>();
const logic = shallowRef<PdfLogic | null>(null);

const stripThumbs = ref<PageThumb[]>([]);
const stripTruncated = ref(false);
const stripFailed = ref(false);
/** Bumped on every strip render so a stale run can bail out silently. */
let stripToken = 0;

let nextId = 1;

// Split
const splitSpec = ref("1-3");
// Rotate
const rotateAll = ref(true);
const rotateSpec = ref("1");
const rotateAngle = ref("90");
// Reorder and delete
const order = ref<number[]>([]);
// Watermark
const markText = ref("DRAFT");
const markSize = ref(48);
const markOpacity = ref(20);
const markAngle = ref(45);
const markColor = ref("#ff0000");
const markColorText = ref("#ff0000");
const markPosition = ref("diagonal");

const rotateAngleSpec: SelectOptionSpec = {
  kind: "select",
  id: "pdf-rotate-angle",
  label: "Turn by",
  default: "90",
  options: [
    {
      value: "90",
      label: "90 degrees clockwise",
      synonyms: ["quarter turn", "right", "clockwise", "cw"],
    },
    { value: "180", label: "180 degrees", synonyms: ["half turn", "upside down", "flip"] },
    {
      value: "270",
      label: "270 degrees clockwise",
      synonyms: ["counterclockwise", "left", "ccw", "three quarter turn"],
    },
  ],
};

const markPositionSpec: SelectOptionSpec = {
  kind: "select",
  id: "pdf-mark-position",
  label: "Placement",
  default: "diagonal",
  options: [
    {
      value: "diagonal",
      label: "Diagonal across the page",
      synonyms: ["angled", "corner to corner", "slanted"],
    },
    { value: "center", label: "Centered", synonyms: ["middle", "centre"] },
    { value: "bottom", label: "Along the bottom", synonyms: ["footer", "bottom edge", "below"] },
  ],
};
// Form fill
const formFields = ref<FieldInfo[]>([]);
const formValues = ref<Record<string, string>>({});
const flattenForm = ref(false);
const formLoaded = ref(false);

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const readyFiles = computed(() => files.value.filter((f) => f.error === null));

/**
 * One searchable-select spec per dropdown/radio form field, keyed by field name
 * and rebuilt when the active document's fields change. The choices come from
 * the user's own PDF, so there are no authored synonyms to add.
 */
const formFieldSpecs = computed<Record<string, SelectOptionSpec>>(() => {
  const specs: Record<string, SelectOptionSpec> = {};
  for (const field of formFields.value) {
    if (field.options && field.options.length) {
      specs[field.name] = {
        kind: "select",
        id: `pdf-field-${field.name}`,
        label: field.name,
        default: field.value ?? "",
        options: field.options.map((choice) => ({ value: choice, label: choice, synonyms: [] })),
      };
    }
  }
  return specs;
});

const activeFile = computed(() => files.value.find((f) => f.id === activeId.value) ?? null);

const canMerge = computed(() => readyFiles.value.length >= 2);

const activePageCount = computed(() => activeFile.value?.pageCount ?? 0);

const orderText = computed(() => order.value.join(", "));

const deletedPages = computed(() => {
  const kept = new Set(order.value);
  const out: number[] = [];
  for (let n = 1; n <= activePageCount.value; n += 1) if (!kept.has(n)) out.push(n);
  return out;
});

/** Live check of a range box against the real page count. */
function checkSpec(spec: string): { ok: boolean; note: string } {
  const lib = logic.value;
  const pages = activePageCount.value;
  if (!lib || pages < 1) return { ok: true, note: "" };
  try {
    const groups = lib.parsePageRanges(spec, pages);
    const total = groups.reduce((sum, g) => sum + g.length, 0);
    return {
      ok: true,
      note: `${groups.length} ${groups.length === 1 ? "range" : "ranges"}, ${total} ${total === 1 ? "page" : "pages"} in total.`,
    };
  } catch (e) {
    return { ok: false, note: e instanceof ToolError ? e.message : String(e) };
  }
}

const splitCheck = computed(() => checkSpec(splitSpec.value));
const rotateCheck = computed(() =>
  rotateAll.value ? { ok: true, note: "Every page turns." } : checkSpec(rotateSpec.value),
);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function baseName(name: string): string {
  const dot = name.toLowerCase().lastIndexOf(".pdf");
  return (dot > 0 ? name.slice(0, dot) : name) || "document";
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function toPdfBlob(bytes: Uint8Array): Blob {
  // A fresh copy keeps the Blob independent of the array it came from, and
  // gives TypeScript a plain ArrayBuffer rather than an ArrayBufferLike.
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

function parseHex(raw: string): string | null {
  const body = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(body)) {
    return `#${body
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(body)) return `#${body.toLowerCase()}`;
  return null;
}

function onColorPicker(value: string) {
  markColor.value = value;
  markColorText.value = value;
}

function onColorText(value: string) {
  markColorText.value = value;
  const hex = parseHex(value);
  if (hex) markColor.value = hex;
}

/* ---------------------------------------------------------------- */
/* rendering previews                                                */
/* ---------------------------------------------------------------- */

/**
 * Render one page to a PNG object URL.
 *
 * The bytes are copied before they go to pdfjs because pdfjs hands the buffer
 * to its worker thread, which detaches the original and would leave the file
 * list holding an empty array.
 */
async function renderPage(
  pdf: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>,
  pageNumber: number,
  targetWidth: number,
): Promise<string | null> {
  const page = await pdf.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const scale = targetWidth / unscaled.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // PDF pages assume paper, so an unpainted canvas would show as transparent.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

async function openForPreview(bytes: Uint8Array) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  return { task, pdf: await task.promise };
}

async function renderFileThumb(file: LoadedFile) {
  try {
    const { task, pdf } = await openForPreview(file.bytes);
    try {
      const url = await renderPage(pdf, 1, FILE_THUMB_WIDTH);
      const current = files.value.find((f) => f.id === file.id);
      if (!current || !url) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (current.thumbUrl) URL.revokeObjectURL(current.thumbUrl);
      current.thumbUrl = url;
    } finally {
      await task.destroy();
    }
  } catch {
    // A page that will not render is not a reason to block editing it, and the
    // logic layer has already confirmed the file parses.
  }
}

function clearStrip() {
  for (const thumb of stripThumbs.value) URL.revokeObjectURL(thumb.url);
  stripThumbs.value = [];
  stripTruncated.value = false;
  stripFailed.value = false;
}

async function renderStrip(file: LoadedFile) {
  const token = (stripToken += 1);
  clearStrip();
  try {
    const { task, pdf } = await openForPreview(file.bytes);
    try {
      const max = Math.min(pdf.numPages, STRIP_LIMIT);
      stripTruncated.value = pdf.numPages > max;
      for (let n = 1; n <= max; n += 1) {
        if (token !== stripToken) return;
        const url = await renderPage(pdf, n, THUMB_WIDTH);
        if (token !== stripToken) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) stripThumbs.value = [...stripThumbs.value, { page: n, url }];
      }
    } finally {
      await task.destroy();
    }
  } catch {
    if (token === stripToken) stripFailed.value = true;
  }
}

function thumbFor(page: number): string | null {
  return stripThumbs.value.find((t) => t.page === page)?.url ?? null;
}

/* ---------------------------------------------------------------- */
/* loading files                                                     */
/* ---------------------------------------------------------------- */

async function addFiles(list: File[]) {
  if (list.length === 0) return;
  busy.value = true;
  busyLabel.value = "Reading files";
  error.value = null;
  try {
    const lib = logic.value ?? (await loadLogic());
    logic.value = lib;
    for (const file of list) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry: LoadedFile = {
        id: nextId,
        name: file.name || `document-${nextId}.pdf`,
        size: bytes.length,
        bytes,
        pageCount: 0,
        thumbUrl: null,
        error: null,
      };
      nextId += 1;
      try {
        const info = await lib.getPdfInfo(bytes);
        entry.pageCount = info.pageCount;
      } catch (e) {
        entry.error = toToolError(e);
      }
      files.value = [...files.value, entry];
      if (entry.error === null) {
        if (activeId.value === null) activeId.value = entry.id;
        void renderFileThumb(entry);
      }
    }
  } catch (e) {
    error.value = toToolError(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

function pdfsFrom(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return [...list].filter(
    (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
  );
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const picked = pdfsFrom(e.dataTransfer?.files);
  if (picked.length === 0) {
    error.value = {
      message: "Nothing in that drop was a PDF file.",
      fix: "Drop files whose names end in .pdf. This toolbox only edits PDFs.",
    };
    return;
  }
  void addFiles(picked);
}

function onPickFiles(e: Event) {
  const picker = e.target as HTMLInputElement;
  const picked = pdfsFrom(picker.files);
  void addFiles(picked).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
}

function removeFile(id: number) {
  const entry = files.value.find((f) => f.id === id);
  if (entry?.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
  files.value = files.value.filter((f) => f.id !== id);
  if (activeId.value === id) activeId.value = readyFiles.value[0]?.id ?? null;
}

function moveFile(index: number, delta: number) {
  const next = [...files.value];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  files.value = next;
}

function clearAll() {
  for (const entry of files.value) if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
  files.value = [];
  activeId.value = null;
  clearStrip();
  results.value = [];
  error.value = null;
  formFields.value = [];
  formValues.value = {};
  formLoaded.value = false;
  clearSignPreview();
  setSignature(null, signAspect.value);
  signStrokes.value = 0;
  typedName.value = "";
  signPage.value = 1;
  if (fileInput.value) fileInput.value.value = "";
}

/* ---------------------------------------------------------------- */
/* reacting to the active document                                   */
/* ---------------------------------------------------------------- */

async function loadFormFields() {
  const file = activeFile.value;
  const lib = logic.value;
  formFields.value = [];
  formValues.value = {};
  formLoaded.value = false;
  if (!file || !lib) return;
  try {
    const fields = await lib.listFormFields(file.bytes);
    formFields.value = fields;
    const values: Record<string, string> = {};
    for (const field of fields) values[field.name] = field.value ?? "";
    formValues.value = values;
    formLoaded.value = true;
  } catch (e) {
    error.value = toToolError(e);
  }
}

watch(
  () => activeFile.value?.id ?? null,
  (id) => {
    const file = activeFile.value;
    order.value = file ? Array.from({ length: file.pageCount }, (_, i) => i + 1) : [];
    results.value = [];
    if (!file || id === null) {
      clearStrip();
      formFields.value = [];
      formLoaded.value = false;
      return;
    }
    void renderStrip(file);
    void loadFormFields();
  },
);

/* ---------------------------------------------------------------- */
/* page order editing                                                */
/* ---------------------------------------------------------------- */

function movePage(index: number, delta: number) {
  const next = [...order.value];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  order.value = next;
}

function dropPage(index: number) {
  order.value = order.value.filter((_, i) => i !== index);
}

function restorePage(page: number) {
  order.value = [...order.value, page].sort((a, b) => a - b);
}

function resetOrder() {
  order.value = Array.from({ length: activePageCount.value }, (_, i) => i + 1);
}

/* ---------------------------------------------------------------- */
/* operations                                                        */
/* ---------------------------------------------------------------- */

async function withBusy(label: string, work: (lib: PdfLogic) => Promise<ResultFile[]>) {
  busy.value = true;
  busyLabel.value = label;
  error.value = null;
  try {
    const lib = logic.value ?? (await loadLogic());
    logic.value = lib;
    results.value = await work(lib);
  } catch (e) {
    results.value = [];
    error.value = toToolError(e);
  } finally {
    busy.value = false;
    busyLabel.value = "";
  }
}

function runMerge() {
  void withBusy("Merging", async (lib) => {
    const bytes = await lib.mergePdfs(readyFiles.value.map((f) => f.bytes));
    return [
      {
        name: "merged.pdf",
        blob: toPdfBlob(bytes),
        note: `${readyFiles.value.length} files in the order shown above`,
      },
    ];
  });
}

function runSplit() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Splitting", async (lib) => {
    const parts = await lib.splitPdf(file.bytes, splitSpec.value);
    return parts.map((part) => ({
      name: `${baseName(file.name)}-${part.suffix}.pdf`,
      blob: toPdfBlob(part.bytes),
      note: `${part.pages.length} ${part.pages.length === 1 ? "page" : "pages"}`,
    }));
  });
}

function runExtract() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Extracting", async (lib) => {
    const bytes = await lib.extractPages(file.bytes, splitSpec.value);
    return [
      {
        name: `${baseName(file.name)}-extract.pdf`,
        blob: toPdfBlob(bytes),
        note: "every listed page in one file",
      },
    ];
  });
}

function runRotate() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Rotating", async (lib) => {
    const angle = Number(rotateAngle.value) as 90 | 180 | 270;
    const pages = rotateAll.value
      ? ("all" as const)
      : lib.parsePageRanges(rotateSpec.value, file.pageCount).flat();
    const bytes = await lib.rotatePages(file.bytes, pages, angle);
    return [
      {
        name: `${baseName(file.name)}-rotated.pdf`,
        blob: toPdfBlob(bytes),
        note: `${angle} degrees clockwise`,
      },
    ];
  });
}

function runReorder() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Rebuilding", async (lib) => {
    const bytes = await lib.reorderPages(file.bytes, order.value);
    const removed = deletedPages.value.length;
    return [
      {
        name: `${baseName(file.name)}-pages.pdf`,
        blob: toPdfBlob(bytes),
        note:
          removed > 0
            ? `${order.value.length} pages kept, ${removed} deleted`
            : `${order.value.length} pages, new order`,
      },
    ];
  });
}

function runWatermark() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Stamping", async (lib) => {
    const bytes = await lib.watermarkPdf(file.bytes, {
      text: markText.value,
      opacity: markOpacity.value / 100,
      fontSize: markSize.value,
      angle: markAngle.value,
      color: markColor.value,
      position: markPosition.value as "center" | "diagonal" | "bottom",
    });
    return [
      {
        name: `${baseName(file.name)}-watermarked.pdf`,
        blob: toPdfBlob(bytes),
        note: `"${markText.value}" on all ${file.pageCount} pages`,
      },
    ];
  });
}

function runFill() {
  const file = activeFile.value;
  if (!file) return;
  void withBusy("Filling", async (lib) => {
    const bytes = await lib.fillForm(
      file.bytes,
      { ...formValues.value },
      {
        flatten: flattenForm.value,
      },
    );
    return [
      {
        name: `${baseName(file.name)}-filled.pdf`,
        blob: toPdfBlob(bytes),
        note: flattenForm.value ? "values flattened into the page" : "still fillable",
      },
    ];
  });
}

/* ---------------------------------------------------------------- */
/* sign: a visual signature placed on a page                         */
/* ---------------------------------------------------------------- */

/**
 * The Sign tab is three ways of making the same thing, a transparent PNG of a
 * signature, plus one way of placing it. Draw uses the shared InkCanvas, the
 * same surface the Handwriting Pad is built on. Type renders the name into a
 * canvas in a script face and says out loud that it is typed. Upload takes a
 * PNG or JPEG someone already has.
 *
 * Placement is done on a rendered preview of the real page, so the box the
 * user drags is measured in preview pixels and handed to the logic layer with
 * the scale that maps it back to points. Everything about the Y axis flip and
 * the page rotation lives there, tested, rather than here.
 */
type SignSource = "draw" | "type" | "upload";

/** Widest the page preview gets, in CSS pixels. */
const STAGE_MAX_WIDTH = 620;
/** Width the page preview is rendered at, before the device pixel ratio. */
const STAGE_RENDER_WIDTH = 900;
/** Aspect ratio of the drawing strip, wide like a signature line. */
const SIGN_PAD_ASPECT = "3 / 1";

const SIGN_SOURCES: SegmentedOption[] = [
  { value: "draw", label: "Draw" },
  { value: "type", label: "Type" },
  { value: "upload", label: "Upload image" },
];

const SIGN_INKS: SegmentedOption[] = [
  { value: "#1b1917", label: "Black" },
  { value: "#1c3f94", label: "Blue" },
];

const SIGN_FACES: { value: string; label: string; font: string }[] = [
  {
    value: "script",
    label: "Script",
    font: 'italic 120px "Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", cursive',
  },
  { value: "serif", label: "Serif", font: 'italic 120px Georgia, "Times New Roman", serif' },
  { value: "sans", label: "Sans", font: 'italic 120px "Segoe UI", Helvetica, Arial, sans-serif' },
];
const SIGN_FACE_OPTIONS: SegmentedOption[] = SIGN_FACES.map((f) => ({
  value: f.value,
  label: f.label,
}));

const signSource = ref<SignSource>("draw");
const signInk = ref("#1b1917");
const signFace = ref("script");
const typedName = ref("");
const signPad = ref<InstanceType<typeof InkCanvas>>();
const signStrokes = ref(0);
const signFileInput = ref<HTMLInputElement>();
const signNote = ref("");

/** The signature itself: one PNG or JPEG, whichever way it was made. */
const signBlob = shallowRef<Blob | null>(null);
const signUrl = ref<string | null>(null);
/** Width divided by height of that image, which the placed box preserves. */
const signAspect = ref(3);

/** The page being signed, and its preview. */
const signPage = ref(1);
const signPreview = ref<string | null>(null);
const signGeometry = ref<PageGeometry | null>(null);
const signStage = ref<HTMLDivElement>();
const stageWidth = ref(0);
const stageHeight = ref(0);
let stageObserver: ResizeObserver | null = null;
/** Bumped per preview render so a stale one can bail out silently. */
let signToken = 0;

/**
 * The signature box as fractions of the preview, so resizing the window
 * moves it with the page instead of leaving it behind. Only x, y and width
 * are state: the height follows from the signature's own aspect ratio.
 */
const signBox = ref({ x: 0.08, y: 0.7, w: 0.34 });

const signBoxHeight = computed(() => {
  if (stageWidth.value <= 0 || stageHeight.value <= 0 || signAspect.value <= 0) return 0.1;
  return (signBox.value.w * stageWidth.value) / signAspect.value / stageHeight.value;
});

const canSign = computed(
  () => signBlob.value !== null && signGeometry.value !== null && stageWidth.value > 0,
);

function revokeSignUrl() {
  if (signUrl.value) URL.revokeObjectURL(signUrl.value);
  signUrl.value = null;
}

function clearSignPreview() {
  signToken += 1;
  if (signPreview.value) URL.revokeObjectURL(signPreview.value);
  signPreview.value = null;
  signGeometry.value = null;
}

function setSignature(blob: Blob | null, aspect: number) {
  revokeSignUrl();
  signBlob.value = blob;
  if (!blob) return;
  signAspect.value = aspect > 0 ? aspect : 3;
  signUrl.value = URL.createObjectURL(blob);
}

/**
 * Read the real pixel size of an image blob, which sets the box's shape.
 *
 * Orientation is deliberately ignored. A photo of a signature carries an EXIF
 * orientation tag that browsers honor by default and pdf-lib does not read at
 * all, so measuring the turned picture and embedding the untouched one would
 * land the signature stretched. Measuring what pdf-lib will actually embed
 * keeps the two in step.
 */
async function aspectOf(blob: Blob): Promise<number> {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
    const ratio = bitmap.width / bitmap.height;
    bitmap.close();
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 3;
  } catch {
    return 3;
  }
}

/* -- draw -- */

async function refreshDrawnSignature() {
  const pad = signPad.value;
  if (!pad || signStrokes.value === 0) {
    setSignature(null, signAspect.value);
    return;
  }
  // 2x so the ink stays crisp when the signature is placed larger than the
  // strip it was drawn on.
  const blob = await pad.toPngBlob(2);
  if (!blob) return;
  setSignature(blob, await aspectOf(blob));
}

function onSignStrokes(strokes: unknown[]) {
  signStrokes.value = strokes.length;
  void refreshDrawnSignature();
}

function clearSignPad() {
  signPad.value?.clear();
}

function undoSignPad() {
  signPad.value?.undo();
}

/* -- type -- */

/**
 * Draw the typed name into a canvas and keep the PNG.
 *
 * The face comes from whatever script or italic font the reader's system
 * already has, because loading a handwriting webfont would be a third party
 * request and this page does not make those. It is typed text in a script
 * style, and the note under the field says exactly that.
 */
async function refreshTypedSignature() {
  const text = typedName.value.trim();
  if (text === "") {
    setSignature(null, signAspect.value);
    return;
  }
  const face = SIGN_FACES.find((f) => f.value === signFace.value) ?? SIGN_FACES[0]!;
  const measurer = document.createElement("canvas").getContext("2d");
  if (!measurer) return;
  measurer.font = face.font;
  const metrics = measurer.measureText(text);
  const size = 120;
  const pad = size * 0.22;
  const ascent = metrics.actualBoundingBoxAscent || size * 0.78;
  const descent = metrics.actualBoundingBoxDescent || size * 0.32;
  const width = Math.max(1, Math.ceil(metrics.width + pad * 2));
  const height = Math.max(1, Math.ceil(ascent + descent + pad * 2));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.font = face.font;
  ctx.fillStyle = signInk.value;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, pad, pad + ascent);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  setSignature(blob, width / height);
}

/* -- upload -- */

async function onPickSignature(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  picker.value = "";
  if (!file) return;
  signNote.value = "";
  if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
    signNote.value =
      "A PDF can only carry a PNG or a JPEG. Convert the picture first, and use PNG if you want the paper to show through around the ink.";
    setSignature(null, signAspect.value);
    return;
  }
  setSignature(file, await aspectOf(file));
}

function refreshSignature() {
  signNote.value = "";
  if (signSource.value === "draw") void refreshDrawnSignature();
  else if (signSource.value === "type") void refreshTypedSignature();
}

/* -- the page preview -- */

/**
 * Draw the page being signed, and read its real geometry.
 *
 * The preview picture comes from pdfjs and the placement math from pdf-lib.
 * pdfjs renders the CropBox while pdf-lib measures the MediaBox, so on the
 * rare file where those differ the picture and the coordinates drift apart by
 * the difference; on every ordinary PDF they are the same rectangle.
 */
async function renderSignPage() {
  const file = activeFile.value;
  if (!file || file.error) return;
  const token = (signToken += 1);
  clearSignPreview();
  signToken = token;
  try {
    const lib = logic.value ?? (await loadLogic());
    logic.value = lib;
    const geometry = await lib.getPageGeometry(file.bytes, signPage.value);
    const { task, pdf } = await openForPreview(file.bytes);
    try {
      const url = await renderPage(pdf, signPage.value, STAGE_RENDER_WIDTH);
      if (token !== signToken) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      signGeometry.value = geometry;
      signPreview.value = url;
    } finally {
      await task.destroy();
    }
  } catch (e) {
    if (token === signToken) error.value = toToolError(e);
  }
}

function measureStage() {
  const el = signStage.value;
  if (!el) return;
  stageWidth.value = el.clientWidth;
  stageHeight.value = el.clientHeight;
}

/* -- moving and sizing the box -- */

/**
 * Keep the box on the page.
 *
 * Only the width is state: the height follows from the signature's aspect
 * ratio, so a tall signature runs out of page height long before it runs out
 * of page width. Clamping the height alone would leave the width untouched
 * and the box hanging off the bottom, so the width cap is whatever keeps the
 * derived height inside the page, and the height is recomputed from it.
 */
function clampBox() {
  const box = signBox.value;
  if (stageWidth.value <= 0 || stageHeight.value <= 0 || signAspect.value <= 0) return;
  const maxW = (stageHeight.value * signAspect.value) / stageWidth.value;
  const w = Math.max(0.01, Math.min(1, maxW, Math.max(0.04, box.w)));
  const h = (w * stageWidth.value) / signAspect.value / stageHeight.value;
  signBox.value = {
    w,
    x: Math.min(1 - w, Math.max(0, box.x)),
    y: Math.min(1 - h, Math.max(0, box.y)),
  };
}

let dragMode: "move" | "resize" | null = null;
let dragCorner = { x: 0, y: 0 };
let dragOffset = { x: 0, y: 0 };

function stagePoint(e: PointerEvent): { x: number; y: number } {
  const el = signStage.value;
  if (!el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onBoxDown(e: PointerEvent) {
  if (e.button !== 0 || !signStage.value) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const p = stagePoint(e);
  dragMode = "move";
  dragOffset = {
    x: p.x - signBox.value.x * stageWidth.value,
    y: p.y - signBox.value.y * stageHeight.value,
  };
}

/**
 * Start a corner drag. The corner opposite the handle is pinned, and the box
 * grows or shrinks toward the pointer keeping the signature's aspect ratio,
 * because a stretched signature reads as a fake one.
 */
function onHandleDown(e: PointerEvent, cornerX: 0 | 1, cornerY: 0 | 1) {
  if (e.button !== 0 || !signStage.value) return;
  e.preventDefault();
  e.stopPropagation();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const box = signBox.value;
  dragMode = "resize";
  dragCorner = {
    x: (cornerX === 0 ? box.x + box.w : box.x) * stageWidth.value,
    y: (cornerY === 0 ? box.y + signBoxHeight.value : box.y) * stageHeight.value,
  };
}

function onStageMove(e: PointerEvent) {
  if (!dragMode || stageWidth.value <= 0 || stageHeight.value <= 0) return;
  const p = stagePoint(e);
  if (dragMode === "move") {
    signBox.value = {
      ...signBox.value,
      x: (p.x - dragOffset.x) / stageWidth.value,
      y: (p.y - dragOffset.y) / stageHeight.value,
    };
    clampBox();
    return;
  }
  const widthPx = Math.abs(p.x - dragCorner.x);
  const w = Math.min(1, Math.max(0.04, widthPx / stageWidth.value));
  const heightPx = (w * stageWidth.value) / signAspect.value;
  signBox.value = {
    w,
    x: (p.x < dragCorner.x ? dragCorner.x - widthPx : dragCorner.x) / stageWidth.value,
    y: (p.y < dragCorner.y ? dragCorner.y - heightPx : dragCorner.y) / stageHeight.value,
  };
  clampBox();
}

function onStageUp() {
  dragMode = null;
}

/** Arrow keys nudge, shift plus left or right resizes. */
function onBoxKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 0.05 : 0.01;
  const box = signBox.value;
  if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    signBox.value = { ...box, w: box.w + (e.key === "ArrowRight" ? step : -step) };
    clampBox();
    return;
  }
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = moves[e.key];
  if (!move) return;
  e.preventDefault();
  signBox.value = { ...box, x: box.x + move[0], y: box.y + move[1] };
  clampBox();
}

/* -- applying -- */

function runSign() {
  const file = activeFile.value;
  const geometry = signGeometry.value;
  const blob = signBlob.value;
  if (!file || !geometry || !blob) return;
  const scale = stageWidth.value / geometry.displayWidth;
  const rect = {
    x: signBox.value.x * stageWidth.value,
    y: signBox.value.y * stageHeight.value,
    width: signBox.value.w * stageWidth.value,
    height: signBoxHeight.value * stageHeight.value,
  };
  void withBusy("Signing", async (lib) => {
    const bytes = await lib.signPdf(file.bytes, {
      page: signPage.value,
      image: new Uint8Array(await blob.arrayBuffer()),
      rect,
      viewportScale: scale,
    });
    return [
      {
        name: `${baseName(file.name)}-signed.pdf`,
        blob: toPdfBlob(bytes),
        note: `signature flattened onto page ${signPage.value}`,
      },
    ];
  });
}

/* -- reacting -- */

watch(signStage, (el) => {
  stageObserver?.disconnect();
  stageObserver = null;
  if (!el) return;
  if (typeof ResizeObserver !== "undefined") {
    stageObserver = new ResizeObserver(() => measureStage());
    stageObserver.observe(el);
  }
  measureStage();
});

watch([signInk, signFace, typedName], () => {
  if (signSource.value === "type") void refreshTypedSignature();
});

watch(signSource, () => {
  signNote.value = "";
  // Switching source unmounts the pad, so the ink goes with it and the count
  // has to follow, or a stale one would leave the export button armed.
  signStrokes.value = 0;
  setSignature(null, signAspect.value);
  refreshSignature();
});

// A new signature has a new shape, and a resized stage has new room: either
// can push the box off the page, so re-seat it whenever they change.
watch([signAspect, stageWidth, stageHeight], () => clampBox());

watch([operation, () => activeFile.value?.id ?? null, signPage], () => {
  if (operation.value !== "sign") {
    clearSignPreview();
    return;
  }
  const pages = activePageCount.value;
  if (pages > 0 && signPage.value > pages) {
    signPage.value = pages;
    return;
  }
  if (signPage.value < 1) {
    signPage.value = 1;
    return;
  }
  void renderSignPage();
});

function downloadAll() {
  results.value.forEach((file, i) => {
    setTimeout(() => downloadBlob(file.blob, file.name), i * 250);
  });
}

onUnmounted(() => {
  for (const entry of files.value) if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
  clearStrip();
  clearSignPreview();
  revokeSignUrl();
  stageObserver?.disconnect();
  stageObserver = null;
});
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
          PDF files
        </span>
        <div class="flex items-center gap-1">
          <Button v-if="files.length" variant="ghost" size="sm" @click="clearAll"> Clear </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open files </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept="application/pdf,.pdf"
            multiple
            @change="onPickFiles"
          />
        </div>
      </div>

      <p v-if="!files.length" class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
        Drop one or more PDF files here, or pick them. Merging uses the order of this list, and
        every other operation works on the file you select. Everything runs in this tab: your files
        and inputs never leave your device.
      </p>

      <ul v-else class="divide-y divide-border/60">
        <li v-for="(file, index) in files" :key="file.id" class="flex items-center gap-3 px-3 py-2">
          <div
            class="grid h-14 w-11 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-background shadow-[var(--sh-inset)]"
          >
            <img
              v-if="file.thumbUrl"
              :src="file.thumbUrl"
              :alt="`First page of ${file.name}`"
              class="max-h-full max-w-full object-contain"
            />
            <span v-else class="font-mono text-[10px] text-muted-foreground">PDF</span>
          </div>

          <button
            type="button"
            class="min-w-0 flex-1 rounded-[6px] px-1 py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-pressed="file.id === activeId"
            :disabled="file.error !== null"
            @click="activeId = file.id"
          >
            <span
              class="block truncate text-sm"
              :class="file.id === activeId ? 'font-semibold' : 'font-medium'"
            >
              {{ file.name }}
            </span>
            <span class="block font-mono text-xs text-muted-foreground tabular-nums">
              <template v-if="file.error">Could not be read</template>
              <template v-else>
                {{ file.pageCount }} {{ file.pageCount === 1 ? "page" : "pages" }},
                {{ formatBytes(file.size) }}
                <template v-if="file.id === activeId"> (selected)</template>
              </template>
            </span>
          </button>

          <div class="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move file up"
              :disabled="index === 0"
              @click="moveFile(index, -1)"
            >
              <ArrowUp class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move file down"
              :disabled="index === files.length - 1"
              @click="moveFile(index, 1)"
            >
              <ArrowDown class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove file"
              @click="removeFile(file.id)"
            >
              <X class="size-4" />
            </Button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Per file problems, kept beside the list they belong to -->
    <div
      v-for="file in files.filter((f) => f.error !== null)"
      :key="`err-${file.id}`"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ file.name }}: {{ file.error?.message }}</p>
      <p v-if="file.error?.fix" class="mt-1 text-muted-foreground">
        {{ file.error.fix }}
      </p>
    </div>

    <!-- Operation errors -->
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

    <p v-if="busy" class="text-sm text-muted-foreground" aria-live="polite">{{ busyLabel }}.</p>

    <!-- Operations -->
    <Tabs v-if="readyFiles.length" v-model="operation" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="merge"> Merge </TabsTrigger>
        <TabsTrigger value="split"> Split </TabsTrigger>
        <TabsTrigger value="rotate"> Rotate </TabsTrigger>
        <TabsTrigger value="pages"> Pages </TabsTrigger>
        <TabsTrigger value="watermark"> Watermark </TabsTrigger>
        <TabsTrigger value="form"> Fill form </TabsTrigger>
        <TabsTrigger value="sign"> Sign </TabsTrigger>
      </TabsList>

      <!-- Merge -->
      <TabsContent value="merge" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <p class="text-sm text-muted-foreground">
            Every readable file in the list is joined into one PDF, top to bottom. Use the arrows
            beside each file to set the order first.
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="!canMerge || busy" @click="runMerge">
              Merge {{ readyFiles.length }} files
            </Button>
            <span v-if="!canMerge" class="text-xs text-muted-foreground">
              Add a second PDF to merge.
            </span>
          </div>
        </div>
      </TabsContent>

      <!-- Split -->
      <TabsContent value="split" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-col gap-1.5">
            <Label for="pdf-split-spec" class="text-xs text-muted-foreground">Page ranges</Label>
            <Input
              id="pdf-split-spec"
              v-model="splitSpec"
              spellcheck="false"
              placeholder="1-3,7,9-end"
              class="h-9 bg-card font-mono"
            />
            <p
              class="text-xs"
              :class="splitCheck.ok ? 'text-muted-foreground' : 'text-destructive'"
            >
              {{ splitCheck.note }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="busy || !splitCheck.ok" @click="runSplit">
              Split into separate files
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="busy || !splitCheck.ok"
              @click="runExtract"
            >
              Extract into one file
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Split writes one PDF per comma separated range. Extract puts every listed page into a
            single PDF instead. The word end means the last page.
          </p>
        </div>
      </TabsContent>

      <!-- Rotate -->
      <TabsContent value="rotate" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-36 flex-col gap-1.5">
              <Label for="pdf-rotate-angle" class="text-xs text-muted-foreground">Turn by</Label>
              <SearchableSelect
                id="pdf-rotate-angle"
                :spec="rotateAngleSpec"
                :model-value="rotateAngle"
                class="w-full bg-card"
                @update:model-value="(v) => (rotateAngle = String(v))"
              />
            </div>
            <div class="flex items-center gap-2 pb-2">
              <Switch
                id="pdf-rotate-all"
                :model-value="rotateAll"
                @update:model-value="(v) => (rotateAll = Boolean(v))"
              />
              <Label for="pdf-rotate-all" class="text-xs text-muted-foreground">All pages</Label>
            </div>
            <div v-if="!rotateAll" class="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label for="pdf-rotate-spec" class="text-xs text-muted-foreground"
                >Pages to turn</Label
              >
              <Input
                id="pdf-rotate-spec"
                v-model="rotateSpec"
                spellcheck="false"
                placeholder="1-3,7"
                class="h-9 bg-card font-mono"
              />
            </div>
          </div>
          <p class="text-xs" :class="rotateCheck.ok ? 'text-muted-foreground' : 'text-destructive'">
            {{ rotateCheck.note }}
          </p>
          <div>
            <Button size="sm" :disabled="busy || !rotateCheck.ok" @click="runRotate">
              Rotate
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            The turn is added to the rotation a page already has, which is what a viewer's rotate
            button does. Rotating a page twice by 180 puts it back where it started.
          </p>
        </div>
      </TabsContent>

      <!-- Reorder and delete -->
      <TabsContent value="pages" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <p class="text-sm text-muted-foreground">
            Drag free reordering: move a page with the arrows, or remove it. Pages you remove are
            deleted from the file you download.
          </p>

          <div class="flex flex-wrap gap-3">
            <div
              v-for="(page, index) in order"
              :key="page"
              class="flex w-[120px] flex-col items-center gap-1 rounded-[8px] bg-card p-2 shadow-[var(--sh-sm)]"
            >
              <div
                class="grid h-[110px] w-full place-items-center overflow-hidden rounded-[4px] bg-background shadow-[var(--sh-inset)]"
              >
                <img
                  v-if="thumbFor(page)"
                  :src="thumbFor(page) ?? ''"
                  :alt="`Page ${page}`"
                  class="max-h-full max-w-full object-contain"
                />
                <span v-else class="font-mono text-xs text-muted-foreground">{{ page }}</span>
              </div>
              <span class="font-mono text-[11px] text-muted-foreground tabular-nums">
                page {{ page }}
              </span>
              <div class="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  :aria-label="`Move page ${page} earlier`"
                  :disabled="index === 0"
                  @click="movePage(index, -1)"
                >
                  <ArrowLeft class="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  :aria-label="`Move page ${page} later`"
                  :disabled="index === order.length - 1"
                  @click="movePage(index, 1)"
                >
                  <ArrowRight class="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  :aria-label="`Delete page ${page}`"
                  @click="dropPage(index)"
                >
                  <X class="size-4" />
                </Button>
              </div>
            </div>
          </div>

          <div v-if="deletedPages.length" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">Deleted:</span>
            <Button
              v-for="page in deletedPages"
              :key="`del-${page}`"
              variant="outline"
              size="sm"
              @click="restorePage(page)"
            >
              Put page {{ page }} back
            </Button>
          </div>

          <p class="font-mono text-xs text-muted-foreground">
            New order: {{ orderText || "no pages left" }}
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="busy || order.length === 0" @click="runReorder">
              Apply page changes
            </Button>
            <Button variant="ghost" size="sm" @click="resetOrder"> Reset </Button>
          </div>
        </div>
      </TabsContent>

      <!-- Watermark -->
      <TabsContent value="watermark" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="pdf-mark-text" class="text-xs text-muted-foreground">Text</Label>
              <Input
                id="pdf-mark-text"
                v-model="markText"
                placeholder="DRAFT"
                class="h-9 bg-card"
              />
            </div>

            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="pdf-mark-position" class="text-xs text-muted-foreground">Placement</Label>
              <SearchableSelect
                id="pdf-mark-position"
                :spec="markPositionSpec"
                :model-value="markPosition"
                class="w-full bg-card"
                @update:model-value="(v) => (markPosition = String(v))"
              />
            </div>

            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="pdf-mark-color" class="text-xs text-muted-foreground">Color</Label>
              <div
                class="flex h-9 items-center gap-2 rounded-[10px] border border-input bg-card px-2 focus-within:ring-3 focus-within:ring-ring/50"
              >
                <input
                  id="pdf-mark-color"
                  type="color"
                  aria-label="Watermark color picker"
                  class="size-6 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
                  :value="markColor"
                  @input="onColorPicker(($event.target as HTMLInputElement).value)"
                />
                <input
                  type="text"
                  aria-label="Watermark color hex value"
                  spellcheck="false"
                  placeholder="#ff0000"
                  class="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
                  :value="markColorText"
                  @input="onColorText(($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>

            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="pdf-mark-size" class="text-xs text-muted-foreground"
                >Font size (points)</Label
              >
              <Input
                id="pdf-mark-size"
                type="number"
                min="1"
                max="500"
                :model-value="markSize"
                class="h-9 bg-card"
                @update:model-value="(v) => (markSize = Number(v) || 1)"
              />
            </div>

            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="pdf-mark-angle" class="text-xs text-muted-foreground"
                >Angle (degrees)</Label
              >
              <Input
                id="pdf-mark-angle"
                type="number"
                min="-180"
                max="180"
                :model-value="markAngle"
                class="h-9 bg-card"
                @update:model-value="(v) => (markAngle = Number(v) || 0)"
              />
            </div>

            <div class="flex min-w-0 flex-col gap-1.5">
              <span class="text-xs text-muted-foreground tabular-nums">
                Opacity: {{ markOpacity }}%
              </span>
              <Slider
                aria-label="Watermark opacity"
                :model-value="[markOpacity]"
                :min="1"
                :max="100"
                :step="1"
                class="py-2"
                @update:model-value="(v) => (markOpacity = v?.[0] ?? markOpacity)"
              />
            </div>
          </div>

          <div>
            <Button size="sm" :disabled="busy || markText.trim() === ''" @click="runWatermark">
              Stamp every page
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            The watermark is drawn in Helvetica on top of the existing page content, so the text
            underneath stays selectable. Around 20 percent opacity reads clearly without hiding the
            document.
          </p>
        </div>
      </TabsContent>

      <!-- Fill form -->
      <TabsContent value="form" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <p v-if="formLoaded && formFields.length === 0" class="text-sm text-muted-foreground">
            This PDF has no interactive form fields, so there is nothing to fill in. A scanned form
            is a picture of a form: it has no fields until someone adds them.
          </p>

          <template v-else-if="formFields.length">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div
                v-for="field in formFields"
                :key="field.name"
                class="flex min-w-0 flex-col gap-1.5"
              >
                <Label
                  :for="`pdf-field-${field.name}`"
                  class="truncate text-xs text-muted-foreground"
                >
                  {{ field.name }} ({{ field.type }})
                </Label>

                <div v-if="field.type === 'checkbox'" class="flex h-9 items-center">
                  <Switch
                    :id="`pdf-field-${field.name}`"
                    :model-value="formValues[field.name] === 'true'"
                    @update:model-value="(v) => (formValues[field.name] = v ? 'true' : 'false')"
                  />
                </div>

                <SearchableSelect
                  v-else-if="field.options && field.options.length"
                  :id="`pdf-field-${field.name}`"
                  :spec="formFieldSpecs[field.name]"
                  :model-value="formValues[field.name] ?? ''"
                  class="w-full bg-card"
                  @update:model-value="(v) => (formValues[field.name] = String(v))"
                />

                <Input
                  v-else
                  :id="`pdf-field-${field.name}`"
                  :model-value="formValues[field.name] ?? ''"
                  :disabled="field.type === 'button' || field.type === 'signature'"
                  class="h-9 bg-card"
                  @update:model-value="(v) => (formValues[field.name] = String(v))"
                />
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <Button size="sm" :disabled="busy" @click="runFill"> Fill and download </Button>
              <div class="flex items-center gap-2">
                <Switch
                  id="pdf-flatten"
                  :model-value="flattenForm"
                  @update:model-value="(v) => (flattenForm = Boolean(v))"
                />
                <Label for="pdf-flatten" class="text-xs text-muted-foreground"
                  >Flatten the values in</Label
                >
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              Flattening paints the answers onto the page and removes the fields, so nobody can edit
              them back out. Leave it off if the form still needs to be filled in by someone else.
            </p>
          </template>

          <p v-else class="text-sm text-muted-foreground">Reading the form fields.</p>
        </div>
      </TabsContent>
      <!-- Sign -->
      <TabsContent value="sign" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <Segmented
            :model-value="signSource"
            :options="SIGN_SOURCES"
            label="How to make the signature"
            size="sm"
            @update:model-value="(v) => (signSource = v as 'draw' | 'type' | 'upload')"
          />

          <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
            <!-- Making the signature -->
            <div class="flex min-w-0 flex-1 flex-col gap-3">
              <template v-if="signSource === 'draw'">
                <InkCanvas
                  ref="signPad"
                  :color="signInk"
                  :base-width="3"
                  :aspect-ratio="SIGN_PAD_ASPECT"
                  guides="signature"
                  background="transparent"
                  label="Signature pad. Sign here with a stylus, a finger, or a mouse."
                  note="Sign above the line with a stylus, a finger, a trackpad, or a mouse. Focus the pad and press Ctrl+Z to undo the last stroke."
                  @change="onSignStrokes"
                />
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="signStrokes === 0"
                    @click="undoSignPad"
                  >
                    Undo
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="signStrokes === 0"
                    @click="clearSignPad"
                  >
                    Clear
                  </Button>
                  <Segmented
                    :model-value="signInk"
                    :options="SIGN_INKS"
                    label="Signature ink"
                    size="sm"
                    @update:model-value="(v) => (signInk = v)"
                  />
                </div>
              </template>

              <template v-else-if="signSource === 'type'">
                <div class="flex flex-col gap-1.5">
                  <Label for="pdf-sign-name" class="text-xs text-muted-foreground">
                    Name to render
                  </Label>
                  <Input
                    id="pdf-sign-name"
                    v-model="typedName"
                    placeholder="Ada Lovelace"
                    class="h-9 bg-card"
                  />
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Segmented
                    :model-value="signFace"
                    :options="SIGN_FACE_OPTIONS"
                    label="Lettering"
                    size="sm"
                    @update:model-value="(v) => (signFace = v)"
                  />
                  <Segmented
                    :model-value="signInk"
                    :options="SIGN_INKS"
                    label="Signature ink"
                    size="sm"
                    @update:model-value="(v) => (signInk = v)"
                  />
                </div>
                <p class="text-xs text-muted-foreground">
                  This is typed text in a script face, not your handwriting, and it is drawn with a
                  font your own device already has, so it may look different on someone else's
                  screen. Draw the signature instead if you want it to be yours.
                </p>
              </template>

              <template v-else>
                <div class="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" @click="signFileInput?.click()">
                    Choose a signature image
                  </Button>
                  <input
                    ref="signFileInput"
                    type="file"
                    class="hidden"
                    accept="image/png,image/jpeg"
                    @change="onPickSignature"
                  />
                </div>
                <p class="text-xs text-muted-foreground">
                  A PNG with a transparent background sits on the page cleanly. A JPEG works too,
                  but it carries its own white rectangle with it, which will cover whatever it is
                  placed over.
                </p>
              </template>

              <div
                v-if="signUrl"
                class="flex items-center gap-3 rounded-[8px] bg-card p-2 shadow-[var(--sh-sm)]"
              >
                <img
                  :src="signUrl"
                  alt="The signature that will be placed"
                  class="max-h-14 max-w-40 object-contain"
                />
                <span class="text-xs text-muted-foreground">
                  Drag this onto the page, then pull a corner to size it.
                </span>
              </div>
              <p v-if="signNote" class="text-xs text-destructive">{{ signNote }}</p>
            </div>

            <!-- Placing it -->
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <div class="flex flex-wrap items-end gap-2">
                <div class="flex w-28 flex-col gap-1.5">
                  <Label for="pdf-sign-page" class="text-xs text-muted-foreground">Page</Label>
                  <Input
                    id="pdf-sign-page"
                    type="number"
                    min="1"
                    :max="activePageCount"
                    :model-value="signPage"
                    class="h-9 bg-card"
                    @update:model-value="(v) => (signPage = Math.max(1, Number(v) || 1))"
                  />
                </div>
                <span class="pb-2 font-mono text-xs text-muted-foreground tabular-nums">
                  of {{ activePageCount }}
                </span>
              </div>

              <div v-if="stripThumbs.length > 1" class="flex gap-2 overflow-x-auto pb-1">
                <button
                  v-for="thumb in stripThumbs"
                  :key="`sign-${thumb.page}`"
                  type="button"
                  class="shrink-0 rounded-[4px] p-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  :class="thumb.page === signPage ? 'ring-2 ring-ring' : ''"
                  :aria-label="`Sign page ${thumb.page}`"
                  :aria-pressed="thumb.page === signPage"
                  @click="signPage = thumb.page"
                >
                  <img
                    :src="thumb.url"
                    :alt="`Page ${thumb.page}`"
                    class="w-11 rounded-[3px] bg-background"
                  />
                </button>
              </div>

              <div
                v-if="signPreview && signGeometry"
                ref="signStage"
                class="relative w-full touch-none overflow-hidden rounded-[6px] bg-background shadow-[var(--sh-inset)]"
                :style="{
                  aspectRatio: `${signGeometry.displayWidth} / ${signGeometry.displayHeight}`,
                  maxWidth: `${STAGE_MAX_WIDTH}px`,
                }"
                @pointermove="onStageMove"
                @pointerup="onStageUp"
                @pointercancel="onStageUp"
              >
                <img
                  :src="signPreview"
                  :alt="`Page ${signPage} of ${activeFile?.name ?? 'the document'}`"
                  class="pointer-events-none absolute inset-0 h-full w-full"
                />
                <div
                  v-if="signUrl"
                  tabindex="0"
                  role="group"
                  aria-label="Signature position. Arrow keys move it; hold shift with the left or right arrow to resize it."
                  class="absolute cursor-move rounded-[2px] ring-1 ring-[color:var(--primary)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  :style="{
                    left: `${signBox.x * 100}%`,
                    top: `${signBox.y * 100}%`,
                    width: `${signBox.w * 100}%`,
                    height: `${signBoxHeight * 100}%`,
                  }"
                  @pointerdown="onBoxDown"
                  @keydown="onBoxKey"
                >
                  <img
                    :src="signUrl"
                    alt=""
                    class="pointer-events-none h-full w-full object-fill"
                  />
                  <span
                    class="absolute -top-1.5 -left-1.5 size-3 cursor-nwse-resize rounded-full bg-[color:var(--primary)]"
                    @pointerdown="onHandleDown($event, 0, 0)"
                  />
                  <span
                    class="absolute -top-1.5 -right-1.5 size-3 cursor-nesw-resize rounded-full bg-[color:var(--primary)]"
                    @pointerdown="onHandleDown($event, 1, 0)"
                  />
                  <span
                    class="absolute -bottom-1.5 -left-1.5 size-3 cursor-nesw-resize rounded-full bg-[color:var(--primary)]"
                    @pointerdown="onHandleDown($event, 0, 1)"
                  />
                  <span
                    class="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-full bg-[color:var(--primary)]"
                    @pointerdown="onHandleDown($event, 1, 1)"
                  />
                </div>
              </div>
              <p v-else class="text-sm text-muted-foreground">Drawing the page.</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="!canSign || busy" @click="runSign">
              Apply signature
            </Button>
            <span v-if="!signBlob" class="text-xs text-muted-foreground">
              Draw, type, or upload a signature first.
            </span>
          </div>

          <p class="text-xs text-muted-foreground">
            This is a visual signature: a picture flattened into the page, the same thing as signing
            a printout and scanning it. It is not a cryptographic signature, it carries no
            certificate, and nothing in the file proves who applied it. Once applied it is part of
            the page content, so it cannot be selected or deleted in a viewer.
          </p>
        </div>
      </TabsContent>
    </Tabs>

    <!-- Page strip -->
    <div
      v-if="
        activeFile &&
        operation !== 'merge' &&
        operation !== 'pages' &&
        operation !== 'form' &&
        operation !== 'sign'
      "
      class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{ activeFile.name }}
      </span>
      <p v-if="stripFailed" class="text-xs text-muted-foreground">
        These pages could not be drawn as previews, which happens with unusual fonts or embedded
        color profiles. Every operation above still works on the file.
      </p>
      <div v-else class="flex gap-3 overflow-x-auto pb-1">
        <div
          v-for="thumb in stripThumbs"
          :key="thumb.page"
          class="flex shrink-0 flex-col items-center gap-1"
        >
          <img
            :src="thumb.url"
            :alt="`Page ${thumb.page}`"
            class="rounded-[4px] bg-background shadow-[var(--sh-inset)]"
            :style="{ width: `${THUMB_WIDTH}px` }"
          />
          <span class="font-mono text-[11px] text-muted-foreground tabular-nums">
            {{ thumb.page }}
          </span>
        </div>
      </div>
      <p v-if="stripTruncated" class="text-xs text-muted-foreground">
        Only the first {{ STRIP_LIMIT }} pages are previewed. Operations still cover the whole
        document.
      </p>
    </div>

    <!-- Results -->
    <div v-if="results.length" class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Result
      </span>
      <div class="divide-y divide-border/60 rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div
          v-for="file in results"
          :key="file.name"
          class="flex items-center justify-between gap-3 px-3 py-2"
        >
          <div class="min-w-0">
            <div class="truncate font-mono text-sm">
              {{ file.name }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ file.note }}, {{ formatBytes(file.blob.size) }}
            </div>
          </div>
          <Button variant="outline" size="sm" @click="downloadBlob(file.blob, file.name)">
            Download
          </Button>
        </div>
      </div>
      <div v-if="results.length > 1" class="flex items-center gap-2">
        <Button size="sm" @click="downloadAll"> Download all {{ results.length }} files </Button>
        <span class="text-xs text-muted-foreground">
          Your browser may ask once for permission to save multiple files.
        </span>
      </div>
    </div>

    <p class="text-xs text-muted-foreground">
      Every page here is read, edited, and written by your own browser, so your files and inputs
      never leave your device. Large documents are limited by the memory your tab has, not by an
      upload cap. Password protected PDFs are reported as protected rather than opened: this tool
      cannot remove a password it does not have.
    </p>
  </div>
</template>
