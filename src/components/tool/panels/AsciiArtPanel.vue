<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, FileImage, Sparkles } from "lucide-vue-next";
import { ToolError, type OptionSpec, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { toAscii, toBraille } from "@/tools/image-to-ascii/index";
import type { AsciiCharset, AsciiColorMode, AsciiOptions } from "@/tools/image-to-ascii/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob, downloadText } from "@/lib/download";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for Image to ASCII Art.
 *
 * A picture goes in and text comes out, so the generic shell cannot take the
 * input. Decoding is the only thing that happens here: every character is
 * chosen by the pure layer in `src/tools/image-to-ascii/` (PROJECT.md rule
 * 27), through `toAscii` for the character ramps and `toBraille` for the dot
 * grid. The panel decodes the file onto a canvas, hands the raw RGBA over,
 * and paints what comes back.
 *
 * Three decisions worth writing down:
 *
 * 1. The source is handed over at its own proportions, not pre-scaled to the
 *    output grid. `toAscii` derives its row count from the pixel width and
 *    height it is given (`rows = columns * height * aspect / width`) and then
 *    box-resamples internally, so handing it a canvas already squeezed to
 *    columns by rows would halve the rows a second time and squash the art.
 *    `toBraille` has no aspect knob at all, so proportional input is the only
 *    shape that works for both styles. The working canvas is capped at 1200
 *    pixels on its long edge, which is far more detail than a 200 column grid
 *    can use and keeps a live re-render quick.
 * 2. The row count is bounded as well as the edge. A tall, narrow panorama can
 *    ask for tens of thousands of rows at 200 columns, which is megabytes of
 *    text and a browser-stalling `<pre>`. When that happens the panel lowers
 *    the column count until the grid fits and says so on screen.
 * 3. The preview font size is fitted to the container from a measured
 *    character advance, so a 200 column render shrinks to fit rather than
 *    pushing the page sideways. Ligatures are turned off explicitly: a ramp
 *    like " .:-=+*#%@" is exactly the sort of run a coding font ligates, and
 *    one ligature breaks the whole grid.
 *
 * Nothing here touches the network: the file is read with an object URL and
 * drawn on a local canvas, so your files and inputs never leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Canvas `font` takes a literal stack; a CSS variable there fails to parse. */
const MONO_STACK = '"Geist Mono", ui-monospace, "Cascadia Code", "Source Code Pro", monospace';

/** Longest edge the working canvas keeps. A 200 column grid cannot use more. */
const MAX_EDGE = 1200;
/** Rows past this are unreadable and cost megabytes, so columns give way. */
const MAX_ROWS = 1200;
/** Long enough to swallow a slider drag, short enough to feel live. */
const DEBOUNCE_MS = 150;

/** The range `clampColumns` in the logic layer accepts. */
const MIN_COLUMNS = 20;
const MAX_COLUMNS = 200;

/** `toBraille` fixes its own cell shape, so the panel matches it. */
const BRAILLE_ASPECT = 0.5;
/** U+2800, the braille cell with every dot off. It draws nothing. */
const BRAILLE_BLANK = "\u2800";

const MIN_FONT_PX = 3;
const MAX_FONT_PX = 15;
/** Advance width over font size, replaced by a real measurement on mount. */
const FALLBACK_ADVANCE = 0.6;
/** The `p-3` on the preview, which the observed content box does not remove. */
const PREVIEW_PADDING_PX = 12;

const PNG_FONT_PX = 16;
const PNG_PADDING = 24;
/** Canvases larger than this fail outright in some browsers. */
const MAX_PNG_EDGE = 12000;

interface ArtTheme {
  bg: string;
  fg: string;
}

/** Light text on a warm dark field, and the inverse, matching the site palette. */
const DARK_ART: ArtTheme = { bg: "#141311", fg: "#F6F4F1" };
const LIGHT_ART: ArtTheme = { bg: "#FFFFFF", fg: "#141311" };

const CHARSET_IDS: readonly AsciiCharset[] = ["standard", "blocks", "simple", "custom"];
const COLOR_IDS: readonly AsciiColorMode[] = ["none", "ansi16", "ansi256", "truecolor", "html"];

/** Rendered as a segmented group, so they leave the schema-driven grid. */
const BESPOKE_OPTIONS = new Set(["style", "columns"]);
const ASCII_ONLY = new Set(["charset", "customChars", "color", "aspect"]);
const BRAILLE_ONLY = new Set(["threshold", "brailleDither"]);

const NO_CANVAS = {
  message: "This browser would not give the page a 2D canvas.",
  fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
};

/* ------------------------------------------------------------------ *
 * options, driven by the meta schema
 * ------------------------------------------------------------------ */

function defaultOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of props.meta.options ?? []) out[spec.id] = spec.default;
  return out;
}

const opts = ref<Record<string, unknown>>(defaultOpts());

function setOpt(id: string, value: unknown) {
  opts.value = { ...opts.value, [id]: value };
}

/**
 * Every number the logic layer sees is clamped here first. The schema-driven
 * number inputs carry min and max as attributes only, so an emptied field
 * arrives as 0, and `toAscii` throws on an aspect of 0 rather than drawing.
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

const artStyle = computed<"ascii" | "braille">(() =>
  String(opts.value.style ?? "ascii") === "braille" ? "braille" : "ascii",
);
const isBraille = computed(() => artStyle.value === "braille");

const charsetId = computed<AsciiCharset>(() => {
  const value = String(opts.value.charset ?? "standard");
  return (CHARSET_IDS as readonly string[]).includes(value) ? (value as AsciiCharset) : "standard";
});

const colorMode = computed<AsciiColorMode>(() => {
  const value = String(opts.value.color ?? "none");
  return (COLOR_IDS as readonly string[]).includes(value) ? (value as AsciiColorMode) : "none";
});

const customChars = computed(() => String(opts.value.customChars ?? ""));
const invert = computed(() => opts.value.invert === true);
const brailleDither = computed(() => opts.value.brailleDither === true);
const aspect = computed(() => clampNumber(opts.value.aspect, 0.2, 1, 0.5));
const threshold = computed(() => clampInt(opts.value.threshold, 0, 255, 128));
const columns = computed(() => clampInt(opts.value.columns, MIN_COLUMNS, MAX_COLUMNS, 80));

/** The cell shape the chosen style actually renders with. */
const cellAspect = computed(() => (isBraille.value ? BRAILLE_ASPECT : aspect.value));

const styleSpec = computed<SelectOptionSpec | undefined>(() =>
  (props.meta.options ?? []).find(
    (spec): spec is SelectOptionSpec => spec.kind === "select" && spec.id === "style",
  ),
);

/** Options the other style has no use for are noise, so they are hidden. */
const visibleOptions = computed<OptionSpec[]>(() =>
  (props.meta.options ?? []).filter((spec) => {
    if (BESPOKE_OPTIONS.has(spec.id)) return false;
    if (isBraille.value ? ASCII_ONLY.has(spec.id) : BRAILLE_ONLY.has(spec.id)) return false;
    if (spec.id === "customChars" && charsetId.value !== "custom") return false;
    return true;
  }),
);

/* ------------------------------------------------------------------ *
 * panel state
 * ------------------------------------------------------------------ */

const imageName = ref("");
const imageReady = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);

const sourceWidth = ref(0);
const sourceHeight = ref(0);
/** True when the source was bigger than MAX_EDGE and had to be scaled down. */
const sourceCapped = ref(false);

const outColumns = ref(0);
const outRows = ref(0);
/** True when MAX_ROWS forced a lower column count than the slider asked for. */
const columnsCapped = ref(false);

/** The plain characters: the preview text, the row count, and the PNG grid. */
const previewText = ref("");
/** The selected color mode's output: what copy and download hand over. */
const outputText = ref("");
/** Colored spans for the preview, only when a color mode is selected. */
const previewHtml = ref("");

const containerWidth = ref(0);
const advance = ref(FALLBACK_ADVANCE);

const previewBox = ref<HTMLElement>();

/**
 * The decoded source pixels. Deliberately not reactive: Vue must never proxy a
 * multi megabyte typed array.
 */
let sourceImage: ImageData | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let objectUrl: string | null = null;
let sizeObserver: ResizeObserver | null = null;

/* ------------------------------------------------------------------ *
 * derived text
 * ------------------------------------------------------------------ */

const theme = computed<ArtTheme>(() => (invert.value ? LIGHT_ART : DARK_ART));

/** A whole grid across the container, never smaller than legible dust. */
const fitFontSize = computed(() => {
  const cols = outColumns.value || columns.value;
  const width = containerWidth.value - PREVIEW_PADDING_PX * 2;
  if (cols < 1 || width < 1) return 12;
  const raw = width / (cols * advance.value);
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.floor(raw * 10) / 10));
});

/**
 * One `ch` is the advance of a character, so a line box of `1 / aspect`
 * character widths is exactly the cell the row count was chosen for.
 */
const preStyle = computed(() => ({
  fontFamily: MONO_STACK,
  fontSize: `${fitFontSize.value}px`,
  lineHeight: `${(1 / cellAspect.value).toFixed(4)}ch`,
  color: theme.value.fg,
  backgroundColor: theme.value.bg,
  fontVariantLigatures: "none",
  fontFeatureSettings: '"liga" 0, "calt" 0',
}));

const dimensionNote = computed(() =>
  outColumns.value > 0 ? `${outColumns.value} by ${outRows.value} characters` : "",
);

const outputSize = computed(() =>
  outputText.value ? formatBytes(new TextEncoder().encode(outputText.value).length) : "",
);

const cappedNote = computed(() => {
  const parts: string[] = [];
  if (sourceCapped.value) {
    parts.push(
      `The picture was scaled to ${sourceWidth.value} by ${sourceHeight.value} pixels first, which is more detail than a character grid can use.`,
    );
  }
  if (columnsCapped.value) {
    parts.push(
      `This picture is tall enough that ${columns.value} columns would run past ${MAX_ROWS} rows, so the render dropped to ${outColumns.value} columns.`,
    );
  }
  return parts.join(" ");
});

const baseName = computed(() => imageName.value.replace(/\.[^./\\]+$/, "") || "image");

/** HTML output is only useful as a page, so it keeps its own extension. */
const isHtmlOutput = computed(() => !isBraille.value && colorMode.value === "html");
const textName = computed(() => `${baseName.value}-ascii.${isHtmlOutput.value ? "html" : "txt"}`);
const pngName = computed(() => `${baseName.value}-ascii.png`);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function toPanelError(e: unknown): { message: string; fix?: string } {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : "That image could not be converted." };
}

function releaseObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function workContext(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: true });
}

/** `renderHtml` wraps its body in a `<pre>`; this panel supplies a styled one. */
function stripPre(html: string): string {
  return html.startsWith("<pre>") && html.endsWith("</pre>") ? html.slice(5, -6) : html;
}

/**
 * The column count that keeps the row count under MAX_ROWS, using the same
 * formula the logic layer uses to pick rows.
 */
function fitColumns(width: number, height: number, cell: number, requested: number): number {
  const rows = Math.max(1, Math.round((requested * height * cell) / width));
  if (rows <= MAX_ROWS) return requested;
  const fitted = Math.floor((MAX_ROWS * width) / (height * cell));
  return Math.max(MIN_COLUMNS, Math.min(requested, fitted));
}

/* ------------------------------------------------------------------ *
 * the sample picture
 * ------------------------------------------------------------------ */

/**
 * A procedural sample: a graded sky, a shaded sphere, a hard edged shape, a
 * ridge, and a stepped gray ramp. Smooth grades show what a ramp does with
 * midtones, and the flat shapes and the ramp make clipping obvious. Drawn from
 * arithmetic, so nothing is fetched.
 */
function drawSample(): ImageData | null {
  const width = 640;
  const height = 400;
  const ctx = workContext(width, height);
  if (!ctx) return null;

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#0d0a1c");
  sky.addColorStop(0.42, "#5b4bd6");
  sky.addColorStop(0.72, "#e0679a");
  sky.addColorStop(1, "#ffe9b8");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const ballX = width * 0.3;
  const ballY = height * 0.42;
  const ball = ctx.createRadialGradient(ballX - 30, ballY - 34, 5, ballX, ballY, 96);
  ball.addColorStop(0, "#ffffff");
  ball.addColorStop(0.45, "#5fb3d4");
  ball.addColorStop(1, "#0d1c2e");
  ctx.fillStyle = ball;
  ctx.beginPath();
  ctx.arc(ballX, ballY, 84, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(width * 0.62, height * 0.16, 80, 80);

  ctx.fillStyle = "#231a3c";
  ctx.beginPath();
  ctx.moveTo(0, height * 0.8);
  ctx.lineTo(width * 0.24, height * 0.56);
  ctx.lineTo(width * 0.48, height * 0.81);
  ctx.lineTo(width * 0.72, height * 0.58);
  ctx.lineTo(width, height * 0.82);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  const steps = 16;
  const strip = 36;
  for (let i = 0; i < steps; i += 1) {
    const level = Math.round((i * 255) / (steps - 1));
    ctx.fillStyle = `rgb(${level} ${level} ${level})`;
    ctx.fillRect((i * width) / steps, height - strip, width / steps + 1, strip);
  }

  return ctx.getImageData(0, 0, width, height);
}

/* ------------------------------------------------------------------ *
 * loading a picture
 * ------------------------------------------------------------------ */

function adoptSource(image: ImageData, name: string, capped: boolean) {
  sourceImage = image;
  sourceWidth.value = image.width;
  sourceHeight.value = image.height;
  sourceCapped.value = capped;
  imageName.value = name;
  imageReady.value = true;
  render();
}

function loadSample() {
  error.value = null;
  const image = drawSample();
  if (!image) {
    error.value = NO_CANVAS;
    return;
  }
  adoptSource(image, "sample", false);
}

async function acceptImage(file: File | null | undefined) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    error.value = {
      message: `${file.name || "That file"} is not an image, so there is nothing to convert.`,
      fix: "Drop a PNG, JPEG, WebP, or GIF instead.",
    };
    return;
  }

  error.value = null;
  releaseObjectUrl();
  const url = URL.createObjectURL(file);
  objectUrl = url;

  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

  if (!loaded || !img.naturalWidth || !img.naturalHeight) {
    releaseObjectUrl();
    error.value = {
      message: "That image could not be decoded.",
      fix: "Try a different file, or re-save it as a PNG or JPEG.",
    };
    return;
  }

  const fit = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * fit));
  const height = Math.max(1, Math.round(img.naturalHeight * fit));

  const ctx = workContext(width, height);
  if (!ctx) {
    releaseObjectUrl();
    error.value = NO_CANVAS;
    return;
  }
  ctx.drawImage(img, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  releaseObjectUrl();

  adoptSource(image, file.name || "image", fit < 1);
}

/** Drop, picker, keyboard, clipboard paste, and the carry chip all land here. */
function onFiles(files: File[]) {
  void acceptImage(files[0]);
}

/* ------------------------------------------------------------------ *
 * the render
 * ------------------------------------------------------------------ */

/**
 * One synchronous pass. A half typed custom ramp throws from `resolveCharset`,
 * which is the normal state one keystroke in, so a failure leaves the last
 * good art on screen and only swaps the banner.
 */
function render() {
  const src = sourceImage;
  if (!src) return;

  try {
    const cell = cellAspect.value;
    const cols = fitColumns(src.width, src.height, cell, columns.value);
    columnsCapped.value = cols < columns.value;

    let plain: string;
    let output: string;
    let colored = "";

    if (isBraille.value) {
      plain = toBraille(src.data, src.width, src.height, {
        columns: cols,
        threshold: threshold.value,
        dither: brailleDither.value,
      });
      output = plain;
    } else {
      const base: AsciiOptions = {
        columns: cols,
        charset: charsetId.value,
        customChars: customChars.value,
        invert: invert.value,
        aspect: cell,
      };
      plain = toAscii(src.data, src.width, src.height, { ...base, color: "none" });
      const mode = colorMode.value;
      if (mode === "none") {
        output = plain;
      } else {
        output = toAscii(src.data, src.width, src.height, { ...base, color: mode });
        // ANSI escapes mean nothing to a browser, so the preview always uses
        // the HTML rendering of the same colors.
        colored =
          mode === "html"
            ? output
            : toAscii(src.data, src.width, src.height, {
                ...base,
                color: "html",
              });
      }
    }

    previewText.value = plain;
    previewHtml.value = colored ? stripPre(colored) : "";
    outputText.value = output;
    outColumns.value = cols;
    outRows.value = plain.split("\n").length;
    error.value = null;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

const canExport = computed(() => imageReady.value && outputText.value.length > 0);

function downloadTextFile() {
  if (!canExport.value) return;
  downloadText(outputText.value, textName.value, isHtmlOutput.value ? "text/html" : "text/plain");
}

/**
 * The art as a picture. Characters are drawn one cell at a time rather than a
 * line at a time: it pins every glyph to the grid the row count assumed, which
 * a font with ligatures or a fallback face for braille would otherwise drift
 * off. Spaces are skipped, so the cost tracks the ink, not the grid.
 */
function renderPng() {
  const text = previewText.value;
  if (!canExport.value || !text) return;

  const lines = text.split("\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    error.value = NO_CANVAS;
    return;
  }

  let fontSize = PNG_FONT_PX;
  ctx.font = `${fontSize}px ${MONO_STACK}`;
  let cellW = ctx.measureText("M").width || fontSize * advance.value;
  let cellH = cellW / cellAspect.value;
  let width = Math.ceil(cellW * outColumns.value) + PNG_PADDING * 2;
  let height = Math.ceil(cellH * lines.length) + PNG_PADDING * 2;

  const shrink = Math.min(1, MAX_PNG_EDGE / width, MAX_PNG_EDGE / height);
  if (shrink < 1) {
    fontSize = Math.max(4, fontSize * shrink);
    cellW *= shrink;
    cellH = cellW / cellAspect.value;
    width = Math.ceil(cellW * outColumns.value) + PNG_PADDING * 2;
    height = Math.ceil(cellH * lines.length) + PNG_PADDING * 2;
  }

  // Sizing a canvas resets its context, so the font is set again afterwards.
  canvas.width = width;
  canvas.height = height;
  const paint = theme.value;
  ctx.fillStyle = paint.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${fontSize}px ${MONO_STACK}`;
  ctx.fillStyle = paint.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const y = PNG_PADDING + row * cellH + cellH / 2;
    for (let col = 0; col < line.length; col += 1) {
      const ch = line[col]!;
      // A space and an all-off braille cell (U+2800) both draw nothing.
      if (ch === " " || ch === BRAILLE_BLANK) continue;
      ctx.fillText(ch, PNG_PADDING + col * cellW + cellW / 2, y);
    }
  }

  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, pngName.value);
  }, "image/png");
}

/* ------------------------------------------------------------------ *
 * measurement
 * ------------------------------------------------------------------ */

/**
 * The advance width of one character over the font size. Measured rather than
 * assumed, because the fitted preview size is only correct for the face that
 * actually renders.
 */
function measureAdvance() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.font = `100px ${MONO_STACK}`;
  const width = ctx.measureText("MMMMMMMMMM").width / 10;
  if (width > 0) advance.value = width / 100;
}

/* ------------------------------------------------------------------ *
 * fragment and watchers
 * ------------------------------------------------------------------ */

/** Settings are shareable; the picture is not, so it never reaches the URL. */
function syncFragment() {
  writeFragment({
    opts: {
      style: artStyle.value,
      columns: String(columns.value),
      invert: String(invert.value),
      ...(isBraille.value
        ? { threshold: String(threshold.value), brailleDither: String(brailleDither.value) }
        : {
            charset: charsetId.value,
            color: colorMode.value,
            aspect: String(aspect.value),
            ...(charsetId.value === "custom" && customChars.value
              ? { customChars: customChars.value }
              : {}),
          }),
    },
  });
}

/**
 * A stale or hand edited fragment must never put an unusable value in a
 * control, so every field is validated before it is adopted. Nothing is
 * assigned unless the fragment carried something: replacing `opts` wakes the
 * watcher, and a pristine load would otherwise stamp defaults into the URL
 * before the user has touched a control.
 */
function applyFragment() {
  const state = readFragment();
  const next = { ...opts.value };
  let found = false;

  const styleId = state.opts["style"];
  if (styleId === "ascii" || styleId === "braille") {
    next.style = styleId;
    found = true;
  }

  const cols = Number(state.opts["columns"]);
  if (Number.isInteger(cols) && cols >= MIN_COLUMNS && cols <= MAX_COLUMNS) {
    next.columns = cols;
    found = true;
  }

  const charset = state.opts["charset"];
  if (charset && (CHARSET_IDS as readonly string[]).includes(charset)) {
    next.charset = charset;
    found = true;
  }

  const custom = state.opts["customChars"];
  if (typeof custom === "string" && custom.length > 0 && custom.length <= 200) {
    next.customChars = custom;
    found = true;
  }

  const color = state.opts["color"];
  if (color && (COLOR_IDS as readonly string[]).includes(color)) {
    next.color = color;
    found = true;
  }

  if (state.opts["invert"] !== undefined) {
    next.invert = state.opts["invert"] === "true";
    found = true;
  }

  const ratio = Number(state.opts["aspect"]);
  if (Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 1) {
    next.aspect = ratio;
    found = true;
  }

  const cut = Number(state.opts["threshold"]);
  if (Number.isInteger(cut) && cut >= 0 && cut <= 255) {
    next.threshold = cut;
    found = true;
  }

  if (state.opts["brailleDither"] !== undefined) {
    next.brailleDither = state.opts["brailleDither"] === "true";
    found = true;
  }

  if (found) opts.value = next;
}

watch(
  opts,
  () => {
    syncFragment();
    if (!imageReady.value) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, DEBOUNCE_MS);
  },
  { deep: true },
);

onMounted(() => {
  applyFragment();

  void (async () => {
    try {
      await document.fonts.ready;
    } catch {
      // Without the font loading API the fallback measurement is the best there is.
    }
    measureAdvance();
  })();

  const box = previewBox.value;
  if (box && typeof ResizeObserver !== "undefined") {
    sizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) containerWidth.value = entry.contentRect.width;
    });
    sizeObserver.observe(box);
  }
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  sizeObserver?.disconnect();
  sizeObserver = null;
  releaseObjectUrl();
  sourceImage = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- input -->
    <FileDrop
      accept="image/*"
      label="Drop a picture here or click to choose"
      hint="You can also paste one from the clipboard or load the sample. It is decoded and converted on a canvas in this tab: your files and inputs never leave your device."
      @files="onFiles"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="loadSample">
          <Sparkles class="size-3.5" aria-hidden="true" />
          Load sample
        </Button>
      </template>
    </FileDrop>

    <!-- style and columns -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-6">
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">{{ styleSpec?.label ?? "Style" }}</span>
        <div
          class="inline-flex w-fit gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
          role="group"
          :aria-label="styleSpec?.label ?? 'Style'"
        >
          <Button
            v-for="choice in styleSpec?.options ?? []"
            :key="choice.value"
            type="button"
            variant="ghost"
            size="sm"
            :aria-pressed="artStyle === choice.value"
            :class="artStyle === choice.value ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setOpt('style', choice.value)"
          >
            {{ choice.label }}
          </Button>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label for="ascii-columns" class="text-xs text-muted-foreground">Columns</Label>
        <div class="flex items-center gap-3">
          <Slider
            id="ascii-columns"
            :model-value="[columns]"
            :min="MIN_COLUMNS"
            :max="MAX_COLUMNS"
            :step="1"
            aria-label="Columns"
            class="min-w-0 flex-1"
            @update:model-value="setOpt('columns', $event?.[0] ?? columns)"
          />
          <span
            class="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
          >
            {{ columns }}
          </span>
        </div>
      </div>
    </div>

    <!-- options -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <OptionControl
        v-for="spec in visibleOptions"
        :key="spec.id"
        :spec="spec"
        :model-value="opts[spec.id]"
        @update:model-value="(value: unknown) => setOpt(spec.id, value)"
      />
    </div>

    <!-- output actions -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground"
      >
        <template v-if="imageReady">
          <span class="font-mono">{{ imageName }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ dimensionNote }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ outputSize }}</span>
        </template>
      </div>

      <div v-if="imageReady" class="flex flex-wrap items-center gap-2">
        <CopyButton :text="outputText" label="Copy text" />
        <Button type="button" variant="ghost" size="sm" :disabled="!canExport" @click="renderPng">
          <FileImage class="size-3.5" aria-hidden="true" />
          Render PNG
        </Button>
        <Button type="button" variant="outline" :disabled="!canExport" @click="downloadTextFile">
          <Download class="size-3.5" aria-hidden="true" />
          Download {{ isHtmlOutput ? "HTML" : "text" }}
        </Button>
      </div>
    </div>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- preview -->
    <div v-show="imageReady" class="flex flex-col gap-2">
      <div
        ref="previewBox"
        class="max-w-full overflow-x-auto rounded-[10px] shadow-[var(--sh-inset)]"
        :style="{ backgroundColor: theme.bg }"
      >
        <!-- eslint-disable vue/no-v-html -- built by this tool's own logic layer, which escapes every character it writes and formats every color as a generated hex value -->
        <pre
          v-if="previewHtml"
          class="m-0 w-max min-w-full p-3"
          :style="preStyle"
          v-html="previewHtml"
        />
        <pre v-else class="m-0 w-max min-w-full p-3" :style="preStyle" v-text="previewText" />
        <!-- eslint-enable vue/no-v-html -->
      </div>
      <p v-if="cappedNote" class="text-xs text-muted-foreground">{{ cappedNote }}</p>
    </div>

    <EmptyState
      v-if="!imageReady"
      title="No image loaded yet"
      hint="The preview shrinks the characters to fit the panel, so a wide grid stays on one screen, and the invert option flips the art to suit a light background."
      icon="Image"
    />

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
