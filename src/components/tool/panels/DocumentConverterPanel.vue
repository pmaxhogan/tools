<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { FileText, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { downloadBlob, downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the document converter.
 *
 * The generic ToolShell cannot host this one for three reasons. The tool takes
 * either a file or pasted text, its PDF output is bytes rather than a string,
 * and PDF input is read with pdfjs, which needs a worker and therefore cannot
 * live in the pure logic layer. So this island owns the file reading, the
 * pdfjs text extraction, the previews, and the print handoff, and every
 * transformation of the document itself stays in
 * `src/tools/document-converter/`.
 *
 * The logic module's `run` is deliberately not used. It answers the curl API
 * and the generic shell by encoding a PDF as a base64 data URL row, which
 * would double the memory cost of a document that is already in this tab as
 * bytes. This panel calls the individual conversions instead and renders the
 * PDF through `renderBlocksToPdf`, keeping the real `Uint8Array`.
 *
 * Both heavy dependencies load on the first document rather than on page
 * load: the logic module (mammoth, marked, turndown, pdf-lib) and pdfjs-dist.
 * The pdfjs worker is imported with Vite's ?url suffix so it is emitted as a
 * local asset and served from this origin, never from a CDN.
 *
 * Nothing runs at import time, so the component renders inert on the server.
 */
const props = defineProps<{ meta: ToolMeta }>();

type Logic = typeof import("@/tools/document-converter/index");
type PdfJs = typeof import("pdfjs-dist");

/** What the input is. "pdf" is panel only: the logic layer refuses PDF bytes. */
type SourceKind = "docx" | "markdown" | "html" | "text" | "pdf";
/** What the panel produces. */
type TargetKind = "html" | "markdown" | "text" | "pdf";

interface PanelError {
  message: string;
  fix?: string;
}

interface TextResult {
  kind: "html" | "markdown" | "text";
  text: string;
}

interface PdfResult {
  kind: "pdf";
  blob: Blob;
  url: string;
  pages: number;
}

type Result = TextResult | PdfResult;

const KIND_LABELS: Record<SourceKind, string> = {
  docx: "Word document",
  markdown: "Markdown",
  html: "HTML",
  text: "Plain text",
  pdf: "PDF",
};

const TARGET_EXTENSIONS: Record<TargetKind, string> = {
  html: ".html",
  markdown: ".md",
  text: ".txt",
  pdf: ".pdf",
};

/** File name endings the picker and the sniffer both understand. */
const ACCEPT = ".docx,.md,.markdown,.html,.htm,.txt,.pdf";

const EXTENSION_KINDS: Record<string, SourceKind> = {
  docx: "docx",
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mkd: "markdown",
  html: "html",
  htm: "html",
  xhtml: "html",
  txt: "text",
  text: "text",
  pdf: "pdf",
};

/* ---------------------------------------------------------------- */
/* lazy dependencies                                                 */
/* ---------------------------------------------------------------- */

let logicPromise: Promise<Logic> | null = null;
function loadLogic(): Promise<Logic> {
  logicPromise ??= import("@/tools/document-converter/index");
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
/* option specs, read from the tool's own metadata                   */
/* ---------------------------------------------------------------- */

function metaSelect(id: string): SelectOptionSpec | null {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === id);
  return found && found.kind === "select" ? found : null;
}

function metaNumber(id: string): { label: string; default: number; min?: number; max?: number } {
  const found = props.meta.options?.find((o) => o.kind === "number" && o.id === id);
  if (found && found.kind === "number") {
    return { label: found.label, default: found.default, min: found.min, max: found.max };
  }
  return { label: id, default: 0 };
}

function metaBoolean(id: string): { label: string; default: boolean } {
  const found = props.meta.options?.find((o) => o.kind === "boolean" && o.id === id);
  if (found && found.kind === "boolean") return { label: found.label, default: found.default };
  return { label: id, default: true };
}

const fromSpec = computed<SelectOptionSpec>(
  () =>
    metaSelect("from") ?? {
      kind: "select",
      id: "from",
      label: "Input format",
      default: "auto",
      options: [
        { value: "auto", label: "Detect automatically", synonyms: ["auto", "guess"] },
        { value: "docx", label: "Word document (.docx)", synonyms: ["docx", "word"] },
        { value: "markdown", label: "Markdown", synonyms: ["md", "markdown"] },
        { value: "html", label: "HTML", synonyms: ["html", "web page"] },
        { value: "text", label: "Plain text", synonyms: ["txt", "text"] },
      ],
    },
);

const toSpec = computed<SelectOptionSpec>(
  () =>
    metaSelect("to") ?? {
      kind: "select",
      id: "to",
      label: "Output format",
      default: "html",
      options: [
        { value: "html", label: "HTML", synonyms: ["html", "web page"] },
        { value: "markdown", label: "Markdown", synonyms: ["md", "markdown"] },
        { value: "text", label: "Plain text", synonyms: ["txt", "text"] },
        { value: "pdf", label: "PDF", synonyms: ["pdf", "print"] },
      ],
    },
);

const pageSizeSpec = computed<SelectOptionSpec>(
  () =>
    metaSelect("pageSize") ?? {
      kind: "select",
      id: "pageSize",
      label: "PDF page size",
      default: "a4",
      options: [
        { value: "a4", label: "A4", synonyms: ["a4", "metric"] },
        { value: "letter", label: "US Letter", synonyms: ["letter", "us"] },
      ],
    },
);

const fontSizeMeta = metaNumber("fontSize");
const marginMeta = metaNumber("margin");
const pageNumbersMeta = metaBoolean("pageNumbers");

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const fileBytes = shallowRef<Uint8Array | null>(null);
const fileName = ref("");
const fileSize = ref(0);
/** Bumped on every new file so the DOCX to HTML cache knows it went stale. */
const fileToken = ref(0);

const pasted = ref("");

const from = ref(fromSpec.value.default);
const to = ref(toSpec.value.default);
const pageSize = ref(pageSizeSpec.value.default);
// Held as text so an empty box means "use the tool's default" rather than 0.
const fontSize = ref(String(fontSizeMeta.default));
const margin = ref(String(marginMeta.default));
const pageNumbers = ref(pageNumbersMeta.default);

const dragging = ref(false);
const busy = ref(false);
const busyLabel = ref("");
/** 0 to 100 while a PDF is being read, null the rest of the time. */
const pdfProgress = ref<number | null>(null);
const pdfPageCount = ref(0);

const detected = ref<SourceKind | null>(null);
const error = ref<PanelError | null>(null);
const result = shallowRef<Result | null>(null);
/** The HTML the last successful conversion went through, for the print path. */
const printableHtml = ref<string | null>(null);
const showSource = ref(false);

const fileInput = ref<HTMLInputElement>();

/** Discards the answer of a run that a newer run has already replaced. */
let runToken = 0;
/** DOCX parsing is the one expensive step worth keeping across option changes. */
let docxCacheToken = -1;
let docxCacheHtml = "";
let pasteTimer: ReturnType<typeof setTimeout> | null = null;

/* ---------------------------------------------------------------- */
/* derived                                                           */
/* ---------------------------------------------------------------- */

const hasFile = computed(() => fileBytes.value !== null);
const hasInput = computed(() => hasFile.value || pasted.value.trim() !== "");
const isPdfSource = computed(() => detected.value === "pdf");

const baseName = computed(() => {
  const name = fileName.value;
  if (name === "") return "document";
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return stem === "" ? "document" : stem;
});

const textResult = computed<TextResult | null>(() =>
  result.value && result.value.kind !== "pdf" ? result.value : null,
);
const htmlResult = computed<TextResult | null>(() =>
  result.value && result.value.kind === "html" ? result.value : null,
);
const pdfResult = computed<PdfResult | null>(() =>
  result.value && result.value.kind === "pdf" ? result.value : null,
);

const resultTitle = computed(() => {
  const current = result.value;
  if (!current) return "Result";
  if (current.kind === "html") return "HTML output";
  if (current.kind === "markdown") return "Markdown output";
  if (current.kind === "pdf") return "PDF output";
  return isPdfSource.value ? "Extracted text" : "Plain text output";
});

const downloadLabel = computed(() =>
  result.value ? TARGET_EXTENSIONS[result.value.kind] : ".txt",
);

const previewDoc = computed(() =>
  htmlResult.value ? asDocument(htmlResult.value.text, baseName.value) : "",
);

const canPrint = computed(() => printableHtml.value !== null && !isPdfSource.value);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function toPanelError(e: unknown): PanelError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Paper-like styling for the preview and the print window.
 *
 * Deliberately self contained: no web font, no stylesheet link, nothing that
 * would make the frame reach off this origin. The document is pinned to a
 * light color scheme because it is a page of paper, not a piece of the app.
 */
const DOCUMENT_STYLE = `
:root { color-scheme: light; }
body { margin: 0; padding: 24px; background: #ffffff; color: #17171a;
  font: 15px/1.6 ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
img { max-width: 100%; height: auto; }
a { color: #4a3cc4; }
table { border-collapse: collapse; }
th, td { border: 1px solid #dcd7cf; padding: 6px 10px; text-align: left; }
th { background: #f4f2ee; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #dcd7cf; color: #5a5750; }
pre { background: #f4f2ee; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
hr { border: 0; border-top: 1px solid #dcd7cf; margin: 1.6em 0; }
@media print { body { padding: 0; } }
`;

/** Wrap an HTML fragment in a full document. A real document is left alone. */
function asDocument(html: string, title: string): string {
  if (/<html[\s>]|<!doctype\s+html/i.test(html)) return html;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DOCUMENT_STYLE}</style>`,
    `</head><body>${html}</body></html>`,
  ].join("");
}

/** "%PDF-" anywhere in the first few bytes, where the header is allowed to sit. */
function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8);
  for (let i = 0; i + 5 <= head.length; i += 1) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 &&
      head[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Work out what a dropped file is.
 *
 * Magic bytes win for the two binary formats, because a PDF renamed to .txt is
 * still a PDF. The file extension wins for the three text formats, because
 * nothing in the bytes of a .md file distinguishes it from an .html file that
 * happens to open with a paragraph. Content sniffing is the last resort.
 */
function sniffFile(lib: Logic, bytes: Uint8Array, name: string): SourceKind {
  if (hasPdfMagic(bytes)) return "pdf";
  const ext = extensionOf(name);
  if (ext === "pdf") return "pdf";
  // detectInputKind throws a useful "not a Word document" for other archives.
  if (isZip(bytes)) return lib.detectInputKind(bytes) as SourceKind;
  const byExtension = EXTENSION_KINDS[ext];
  if (byExtension) return byExtension;
  return lib.detectInputKind(bytes) as SourceKind;
}

function releaseResult(): void {
  const current = result.value;
  if (current && current.kind === "pdf") URL.revokeObjectURL(current.url);
}

function setResult(next: Result | null): void {
  releaseResult();
  result.value = next;
}

/* ---------------------------------------------------------------- */
/* loading the input                                                 */
/* ---------------------------------------------------------------- */

async function loadFile(file: File): Promise<void> {
  error.value = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    fileBytes.value = bytes;
    fileName.value = file.name || "document";
    fileSize.value = bytes.byteLength;
    fileToken.value += 1;
    // A new document deserves a fresh look, so any override goes back to auto.
    from.value = "auto";
    void convert();
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  const picked = e.dataTransfer?.files?.[0];
  if (!picked) {
    error.value = {
      message: "Nothing in that drop was a file.",
      fix: "Drop a .docx, .md, .html, .txt or .pdf file, or paste the document into the box instead.",
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
  fileBytes.value = null;
  fileName.value = "";
  fileSize.value = 0;
  fileToken.value += 1;
  detected.value = null;
  error.value = null;
  pdfPageCount.value = 0;
  pdfProgress.value = null;
  printableHtml.value = null;
  setResult(null);
  if (fileInput.value) fileInput.value.value = "";
  if (pasted.value.trim() !== "") void convert();
}

/* ---------------------------------------------------------------- */
/* PDF text extraction                                               */
/* ---------------------------------------------------------------- */

/**
 * Pull the text layer out of a PDF, page by page.
 *
 * Items are joined with a space, except where pdfjs reports a line break, and
 * pages are separated by a blank line. Keeping those line breaks is the point:
 * `cleanExtractedText` rejoins words that the layout hyphenated across a line,
 * which it can only do while the line breaks are still there.
 */
async function extractPdfText(lib: Logic, bytes: Uint8Array, token: number): Promise<void> {
  busyLabel.value = "Reading the PDF";
  pdfProgress.value = 0;
  const pdfjs = await loadPdfjs();
  if (token !== runToken) return;

  // pdfjs hands the buffer to its worker, which detaches it, so it gets a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    if (token !== runToken) return;
    pdfPageCount.value = doc.numPages;

    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (token !== runToken) return;
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let out = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        out += item.str;
        out += item.hasEOL ? "\n" : " ";
      }
      page.cleanup();
      pages.push(out);
      pdfProgress.value = Math.round((n / doc.numPages) * 100);
    }
    if (token !== runToken) return;

    printableHtml.value = null;
    setResult({ kind: "text", text: lib.cleanExtractedText(pages.join("\n\n")) });
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      "pdf-failed",
      `This PDF could not be read: ${detail}`,
      "Password protected PDFs cannot be opened here, and a damaged file has to be repaired first. Try opening it in a PDF viewer and saving a fresh copy.",
    );
  } finally {
    await task.destroy();
  }
}

/* ---------------------------------------------------------------- */
/* conversion                                                        */
/* ---------------------------------------------------------------- */

function pdfOptions(): Record<string, unknown> {
  return {
    pageSize: pageSize.value,
    fontSize: fontSize.value === "" ? undefined : Number(fontSize.value),
    margin: margin.value === "" ? undefined : Number(margin.value),
    pageNumbers: pageNumbers.value,
  };
}

/** DOCX to HTML, kept across option changes so switching output is instant. */
async function docxHtml(lib: Logic, bytes: Uint8Array): Promise<string> {
  if (docxCacheToken === fileToken.value) return docxCacheHtml;
  const html = await lib.docxToHtml(bytes);
  docxCacheToken = fileToken.value;
  docxCacheHtml = html;
  return html;
}

async function convert(): Promise<void> {
  const token = (runToken += 1);
  error.value = null;
  pdfProgress.value = null;

  if (!hasInput.value) {
    detected.value = null;
    printableHtml.value = null;
    pdfPageCount.value = 0;
    setResult(null);
    return;
  }

  busy.value = true;
  busyLabel.value = "Reading the document";
  try {
    const lib = await loadLogic();
    if (token !== runToken) return;

    const bytes = fileBytes.value;
    const text = pasted.value;
    const measured = bytes ? bytes.byteLength : text.length;
    if (measured > lib.MAX_INPUT_BYTES) {
      throw new ToolError(
        "too-large",
        `That document is ${formatBytes(measured)}, past the ${formatBytes(lib.MAX_INPUT_BYTES)} this page converts.`,
        "Split the document, or convert it in a desktop program. The limit exists because the whole conversion runs in this tab's memory.",
      );
    }

    const sniffed = bytes ? sniffFile(lib, bytes, fileName.value) : lib.detectInputKind(text);
    if (token !== runToken) return;
    detected.value = sniffed;

    if (sniffed === "pdf") {
      if (!bytes) {
        throw new ToolError(
          "unknown-format",
          "PDFs are binary, so pasted text cannot be one.",
          "Drop the .pdf file onto the panel to pull its text out.",
        );
      }
      await extractPdfText(lib, bytes, token);
      return;
    }

    pdfPageCount.value = 0;
    const kind: SourceKind = from.value === "auto" ? sniffed : (from.value as SourceKind);
    if (kind === "docx" && !bytes) {
      throw new ToolError(
        "unknown-format",
        "Word documents are binary, so pasted text cannot be one.",
        "Drop the .docx file onto the panel, or set the input format to Markdown, HTML or plain text.",
      );
    }

    busyLabel.value = "Converting";
    let html: string;
    if (kind === "docx") {
      html = await docxHtml(lib, bytes as Uint8Array);
    } else {
      const source = bytes ? new TextDecoder().decode(bytes) : text;
      html =
        kind === "markdown"
          ? lib.markdownToHtml(source)
          : kind === "html"
            ? source
            : lib.textToHtml(source);
    }
    if (token !== runToken) return;
    printableHtml.value = html;

    const target = to.value as TargetKind;
    if (target === "pdf") {
      busyLabel.value = "Laying out the PDF";
      const rendered = await lib.renderBlocksToPdf(lib.htmlToBlocks(html), pdfOptions());
      if (token !== runToken) return;
      // A fresh copy keeps the Blob independent of the array it came from, and
      // gives TypeScript a plain ArrayBuffer rather than an ArrayBufferLike.
      const blob = new Blob([rendered.bytes.slice().buffer as ArrayBuffer], {
        type: "application/pdf",
      });
      setResult({ kind: "pdf", blob, url: URL.createObjectURL(blob), pages: rendered.pageCount });
      return;
    }

    const converted =
      target === "html"
        ? html
        : target === "markdown"
          ? lib.htmlToMarkdown(html)
          : lib.htmlToText(html);
    setResult({ kind: target, text: converted });
  } catch (e) {
    if (token !== runToken) return;
    setResult(null);
    printableHtml.value = null;
    error.value = toPanelError(e);
  } finally {
    if (token === runToken) {
      busy.value = false;
      busyLabel.value = "";
      pdfProgress.value = null;
    }
  }
}

function scheduleConvert(): void {
  if (pasteTimer !== null) clearTimeout(pasteTimer);
  pasteTimer = setTimeout(() => {
    pasteTimer = null;
    void convert();
  }, 250);
}

watch(pasted, () => {
  if (hasFile.value) return;
  scheduleConvert();
});

watch([from, to, pageSize, fontSize, margin, pageNumbers], () => {
  if (!hasInput.value) return;
  void convert();
});

/* ---------------------------------------------------------------- */
/* output actions                                                    */
/* ---------------------------------------------------------------- */

function download(): void {
  const current = result.value;
  if (!current) return;
  const name = `${baseName.value}${TARGET_EXTENSIONS[current.kind]}`;
  if (current.kind === "pdf") {
    downloadBlob(current.blob, name);
    return;
  }
  const type =
    current.kind === "html"
      ? "text/html"
      : current.kind === "markdown"
        ? "text/markdown"
        : "text/plain";
  downloadText(current.text, name, type);
}

/**
 * Hand the rendered document to the browser's own print dialog.
 *
 * This is the pixel exact path: the browser lays the HTML out with its real
 * layout engine and its "Save as PDF" destination writes the page you see.
 * The Download PDF button is the other trade, a text flow renderer that
 * produces cleaner text and real page numbers but no CSS.
 */
function printToPdf(): void {
  const html = printableHtml.value;
  if (html === null) return;
  const win = window.open("", "_blank");
  if (!win) {
    error.value = {
      message: "The browser blocked the print window.",
      fix: "Allow pop-ups for this page, then press Print to PDF again.",
    };
    return;
  }
  win.document.open();
  win.document.write(asDocument(html, baseName.value));
  win.document.close();
  const trigger = () => {
    win.focus();
    win.print();
  };
  // Images arrive as data URLs, so wait for the load rather than printing an
  // empty frame. A document with nothing left to fetch is already complete.
  if (win.document.readyState === "complete") trigger();
  else win.addEventListener("load", trigger, { once: true });
}

onUnmounted(() => {
  runToken += 1;
  if (pasteTimer !== null) clearTimeout(pasteTimer);
  releaseResult();
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
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Document
        </span>
        <div class="flex items-center gap-1">
          <Button v-if="hasFile" variant="ghost" size="sm" @click="clearFile">
            <X class="size-4" />
            Clear file
          </Button>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file </Button>
          <input ref="fileInput" type="file" class="hidden" :accept="ACCEPT" @change="onPickFile" />
        </div>
      </div>

      <div v-if="hasFile" class="flex items-center gap-3 px-3 pt-1 pb-3">
        <div
          class="grid size-10 shrink-0 place-items-center rounded-[8px] bg-background shadow-[var(--sh-inset)]"
        >
          <FileText class="size-5 text-muted-foreground" />
        </div>
        <div class="min-w-0">
          <div class="truncate font-mono text-sm">{{ fileName }}</div>
          <div class="text-xs text-muted-foreground tabular-nums">
            {{ formatBytes(fileSize) }}
            <template v-if="detected"> · read as {{ KIND_LABELS[detected] }}</template>
            <template v-if="isPdfSource && pdfPageCount">
              · {{ pdfPageCount }} {{ pdfPageCount === 1 ? "page" : "pages" }}
            </template>
          </div>
        </div>
      </div>

      <div v-else class="px-3 pt-1 pb-3">
        <Label for="doc-paste" class="sr-only">Markdown, HTML or plain text</Label>
        <Textarea
          id="doc-paste"
          :model-value="pasted"
          rows="6"
          spellcheck="false"
          placeholder="Drop a .docx, .md, .html, .txt or .pdf file here, or paste Markdown, HTML or plain text."
          class="min-h-32 resize-y border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0"
          @update:model-value="(v) => (pasted = String(v))"
        />
      </div>

      <p v-if="hasFile" class="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        Clear the file to convert pasted text instead. Dropping another file replaces this one.
      </p>
    </div>

    <!-- Error -->
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

    <!-- Formats -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Formats
      </span>

      <template v-if="isPdfSource">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="rounded-[8px] bg-card px-2 py-1 font-mono text-xs shadow-[var(--sh-inset)]">
            PDF
          </span>
          <span class="text-muted-foreground">to</span>
          <span class="rounded-[8px] bg-card px-2 py-1 font-mono text-xs shadow-[var(--sh-inset)]">
            Plain text
          </span>
        </div>
        <p class="text-xs text-muted-foreground">
          A PDF only converts one way here: its text layer comes out as plain text. HTML, Markdown
          and a rebuilt PDF are not offered, because recovering the original document structure from
          a finished PDF means guessing, and a guess dressed up as a heading is worse than plain
          text. Convert the source file instead if you still have it.
        </p>
      </template>

      <template v-else>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-52 flex-col gap-1.5">
            <Label for="doc-from" class="text-xs text-muted-foreground">
              {{ fromSpec.label }}
            </Label>
            <SearchableSelect
              id="doc-from"
              :spec="fromSpec"
              :model-value="from"
              class="w-full bg-card"
              @update:model-value="(v) => (from = String(v))"
            />
          </div>

          <div class="flex w-52 flex-col gap-1.5">
            <Label for="doc-to" class="text-xs text-muted-foreground">{{ toSpec.label }}</Label>
            <SearchableSelect
              id="doc-to"
              :spec="toSpec"
              :model-value="to"
              class="w-full bg-card"
              @update:model-value="(v) => (to = String(v))"
            />
          </div>
        </div>

        <p v-if="detected" class="text-xs text-muted-foreground">
          <template v-if="from === 'auto'">
            Detected as {{ KIND_LABELS[detected] }}. Pick an input format above if that guess is
            wrong.
          </template>
          <template v-else>
            Read as {{ KIND_LABELS[from as SourceKind] }} because you chose it. Detection would have
            said {{ KIND_LABELS[detected] }}.
          </template>
        </p>

        <div
          v-if="to === 'pdf'"
          class="flex flex-wrap items-end gap-3 border-t border-border/60 pt-3"
        >
          <div class="flex w-40 flex-col gap-1.5">
            <Label for="doc-page-size" class="text-xs text-muted-foreground">
              {{ pageSizeSpec.label }}
            </Label>
            <SearchableSelect
              id="doc-page-size"
              :spec="pageSizeSpec"
              :model-value="pageSize"
              class="w-full bg-card"
              @update:model-value="(v) => (pageSize = String(v))"
            />
          </div>

          <div class="flex w-40 flex-col gap-1.5">
            <Label for="doc-font-size" class="text-xs text-muted-foreground">
              {{ fontSizeMeta.label }}
            </Label>
            <Input
              id="doc-font-size"
              :model-value="fontSize"
              type="number"
              :min="fontSizeMeta.min"
              :max="fontSizeMeta.max"
              class="h-9 bg-card"
              @update:model-value="(v) => (fontSize = String(v))"
            />
          </div>

          <div class="flex w-40 flex-col gap-1.5">
            <Label for="doc-margin" class="text-xs text-muted-foreground">
              {{ marginMeta.label }}
            </Label>
            <Input
              id="doc-margin"
              :model-value="margin"
              type="number"
              :min="marginMeta.min"
              :max="marginMeta.max"
              class="h-9 bg-card"
              @update:model-value="(v) => (margin = String(v))"
            />
          </div>

          <div class="flex items-center gap-2 pb-2.5">
            <Switch
              id="doc-page-numbers"
              :model-value="pageNumbers"
              @update:model-value="(v) => (pageNumbers = Boolean(v))"
            />
            <Label for="doc-page-numbers" class="text-xs text-muted-foreground">
              {{ pageNumbersMeta.label }}
            </Label>
          </div>
        </div>
      </template>
    </div>

    <!-- Progress -->
    <div v-if="busy" class="flex flex-col gap-2">
      <p class="font-mono text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {{ busyLabel }}<template v-if="pdfProgress !== null"> · {{ pdfProgress }}%</template>
      </p>
      <div
        v-if="pdfProgress !== null"
        class="h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        :aria-valuenow="pdfProgress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="PDF text extraction progress"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          :style="{ width: `${pdfProgress}%` }"
        />
      </div>
    </div>

    <!-- Result -->
    <div v-if="result" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {{ resultTitle }}
        </span>
        <div class="flex items-center gap-1">
          <Button v-if="htmlResult" variant="ghost" size="sm" @click="showSource = !showSource">
            {{ showSource ? "Preview" : "Source" }}
          </Button>
          <CopyButton v-if="textResult" :text="textResult.text" label="Copy" />
          <Button variant="ghost" size="sm" @click="download">
            Download {{ downloadLabel }}
          </Button>
        </div>
      </div>

      <!-- Rendered HTML -->
      <div v-if="htmlResult && htmlResult.text !== '' && !showSource" class="px-3 pt-1 pb-3">
        <iframe
          title="Preview of the converted document"
          sandbox=""
          :srcdoc="previewDoc"
          class="block h-[420px] w-full rounded-[8px] border-0 bg-white shadow-[var(--sh-inset)]"
        ></iframe>
        <p class="pt-2 text-xs text-muted-foreground">
          The preview is a fully sandboxed frame: it runs no script and makes no request.
        </p>
      </div>

      <!-- Text, Markdown, or HTML source -->
      <template v-else-if="textResult">
        <p v-if="textResult.text === ''" class="px-3 pt-1 pb-3 text-sm text-muted-foreground">
          <template v-if="isPdfSource">
            This PDF has no text layer, which means it is a scan or an export of images. The words
            are pixels, not characters, so there is nothing to copy out. Run it through an OCR tool
            to recognize the text first.
          </template>
          <template v-else>
            The conversion produced nothing. That usually means the input was only markup with no
            readable text in it.
          </template>
        </p>
        <pre
          v-else
          class="max-h-[420px] overflow-auto px-3 pt-1 pb-3 font-mono text-sm whitespace-pre-wrap"
          >{{ textResult.text }}</pre>
      </template>

      <!-- PDF -->
      <div v-else-if="pdfResult" class="flex flex-col gap-2 px-3 pt-1 pb-3">
        <p class="text-xs text-muted-foreground tabular-nums">
          {{ pdfResult.pages }} {{ pdfResult.pages === 1 ? "page" : "pages" }} ·
          {{ formatBytes(pdfResult.blob.size) }} · {{ baseName }}.pdf
        </p>
        <iframe
          title="Preview of the generated PDF"
          :src="pdfResult.url"
          class="block h-[520px] w-full rounded-[8px] border-0 bg-white shadow-[var(--sh-inset)]"
        ></iframe>
        <p class="text-xs text-muted-foreground">
          The preview above is your browser's own PDF viewer, reading a copy held in this tab.
        </p>
      </div>
    </div>

    <!-- Print -->
    <div v-if="canPrint" class="flex flex-col gap-2">
      <Button variant="outline" size="sm" class="self-start" @click="printToPdf">
        Print to PDF (exact layout)
      </Button>
      <p class="text-xs text-muted-foreground">
        This opens the converted document in a new window and calls your browser's print dialog, so
        choosing "Save as PDF" there gives you the page exactly as the browser lays it out: real
        CSS, real fonts, images in place. The Download .pdf button above is the other trade. It uses
        the built in text flow renderer, which reads the document structure and lays out headings,
        lists, quotes, code and tables with measured wrapping, page breaks and page numbers, but it
        runs no CSS engine, so styling and images are dropped.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      The Word reader, the Markdown and HTML converters, the PDF writer and the PDF text extractor
      all run inside this page, so your files and inputs never leave your device. The size a
      document can reach is limited by the memory your tab has, not by an upload cap.
    </p>
  </div>
</template>
