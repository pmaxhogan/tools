<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  encode,
  getSheet,
  normaliseType,
  renderBarcodeSvg,
  renderSheetSvg,
  type EncodedBarcode,
  type EncodeOptions,
} from "@/tools/barcode-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the barcode generator, sibling to QrPanel. The generic
 * ToolShell only knows one textarea plus schema-driven options and a text
 * output block; this tool needs the input shape to change with the layout
 * (one value in single mode, one value per line for a sheet), a live SVG
 * preview instead of a dumped string, the per-value warnings that live on the
 * encoded object (check digit computed, letters uppercased, and so on), a
 * used-of-capacity count for label sheets, and a real print path. The
 * encoding tables, geometry and SVG rendering all stay in the pure logic
 * layer: this file only collects input and paints pixels.
 */
const props = defineProps<{ meta: ToolMeta }>();

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);
const inputText = ref("");
const mounted = ref(false);

const type = computed(() => String(opts.value.type ?? "code128"));
const sheetId = computed(() => String(opts.value.sheet ?? "single"));
const isSheet = computed(() => sheetId.value !== "single");
const isCode39 = computed(() => type.value === "code39");

/** Which schema-driven options apply to the current mode. Module width, bar
 * height and quiet zone geometry only matter to a single symbol; a sheet
 * scales bars to fit its own labels and ignores them. */
function showOption(id: string): boolean {
  if (id === "copies") return isSheet.value;
  if (id === "moduleWidth" || id === "height") return !isSheet.value;
  if (id === "code39Check") return isCode39.value;
  return true;
}

function numOpt(id: string, fallback: number): number {
  const n = Number(opts.value[id]);
  return Number.isFinite(n) ? n : fallback;
}

function boolOpt(id: string, fallback: boolean): boolean {
  const v = opts.value[id];
  return typeof v === "boolean" ? v : fallback;
}

const copiesValue = computed(() => Math.max(1, Math.floor(numOpt("copies", 1))));
const valueCount = computed(
  () => inputText.value.split(/\r?\n/).filter((line) => line.trim()).length,
);

const placeholder = computed(() =>
  isSheet.value
    ? "One value per line, one barcode per label, for example:\n012345678905\n012345678912"
    : "Enter the value to encode, for example 012345678905",
);

/* -------------------------------------------------------------------------- */
/* Encode and render                                                         */
/* -------------------------------------------------------------------------- */

interface WarningEntry {
  value: string;
  text: string;
}

interface BarcodeResult {
  svg: string | null;
  warnings: WarningEntry[];
  error: { message: string; fix?: string } | null;
  used: number;
  capacity: number | null;
}

/** Belt and braces, matching the same check the chart tool's panel makes: the
 * markup below is built entirely by this tool's own encoder and SVG renderer
 * (src/tools/barcode-generator), never passed through from the input, and
 * every interpolated value is escaped there. This stops that being an
 * assumption the panel makes silently. */
function assertSafeSvg(svg: string): string {
  if (/<script/i.test(svg)) {
    throw new ToolError(
      "unsafe-output",
      "The barcode could not be shown because the generated image failed its safety check.",
      "Reload the page and try again. If it keeps happening, download the SVG and open it in an editor to inspect it.",
    );
  }
  return svg;
}

const result = computed<BarcodeResult>(() => {
  const raw = inputText.value;
  if (!raw.trim()) return { svg: null, warnings: [], error: null, used: 0, capacity: null };

  try {
    const symbology = normaliseType(type.value);
    const encodeOptions: EncodeOptions = { code39Check: boolOpt("code39Check", false) };
    const showText = boolOpt("showText", true);
    const quietZone = numOpt("quietZone", 10);

    if (!isSheet.value) {
      const trimmed = raw.trim();
      if (/\r?\n/.test(trimmed))
        throw new ToolError(
          "invalid-chars",
          "The input has a line break in it, and a single barcode holds one value.",
          "Pick a layout to print one barcode per line, or enter a single value.",
        );
      const encoded = encode(trimmed, symbology, encodeOptions);
      const svg = assertSafeSvg(
        renderBarcodeSvg(encoded, {
          moduleWidth: numOpt("moduleWidth", 2),
          height: numOpt("height", 80),
          showText,
          quietZone,
        }),
      );
      return {
        svg,
        warnings: encoded.warnings.length
          ? [{ value: encoded.value, text: encoded.warnings.join(" ") }]
          : [],
        error: null,
        used: 1,
        capacity: null,
      };
    }

    const spec = getSheet(sheetId.value);
    if (!spec)
      throw new ToolError(
        "bad-option",
        `Unknown layout "${sheetId.value}".`,
        "Pick a layout from the list.",
      );
    const capacity = spec.rows * spec.cols;
    const values = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (values.length === 0) return { svg: null, warnings: [], error: null, used: 0, capacity };

    const perLine = values.map((value) => ({ value, encoded: encode(value, symbology, encodeOptions) }));
    const printList: EncodedBarcode[] = [];
    for (const { encoded } of perLine) {
      for (let i = 0; i < copiesValue.value; i++) printList.push(encoded);
    }
    const svg = assertSafeSvg(renderSheetSvg(printList, spec, { showText, quietZone }));
    const seen = new Set<string>();
    const warnings = perLine
      .filter(({ encoded }) => encoded.warnings.length > 0)
      .map(({ value, encoded }) => ({ value, text: encoded.warnings.join(" ") }))
      // Repeated lines (the same value entered twice, or the same warning
      // wording on two different values) collapse to one note: the list is a
      // summary of what changed, not a per-label audit trail.
      .filter((w) => {
        const key = `${w.value} ${w.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { svg, warnings, error: null, used: printList.length, capacity };
  } catch (e) {
    return {
      svg: null,
      warnings: [],
      error:
        e instanceof ToolError
          ? { message: e.message, fix: e.fix }
          : { message: e instanceof Error ? e.message : String(e) },
      used: 0,
      capacity: null,
    };
  }
});

// The SVG in the preview is generated entirely by our own encoder and
// renderer above; nothing here calls out to a barcode library.
const previewSrc = computed(() =>
  result.value.svg ? `data:image/svg+xml,${encodeURIComponent(result.value.svg)}` : "",
);

/* -------------------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)                */
/* -------------------------------------------------------------------------- */

function persist() {
  if (!mounted.value) return;
  writeFragment({
    input: inputText.value,
    opts: Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
  });
}

watch(inputText, persist);
watch(opts, persist, { deep: true });

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) inputText.value = frag.input;
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw === undefined) continue;
    if (spec.kind === "number" || spec.kind === "slider") opts.value[spec.id] = Number(raw);
    else if (spec.kind === "boolean") opts.value[spec.id] = raw === "true";
    else opts.value[spec.id] = raw;
  }
  mounted.value = true;
});

/* -------------------------------------------------------------------------- */
/* Downloads and print                                                       */
/* -------------------------------------------------------------------------- */

function downloadSvg() {
  if (!result.value.svg) return;
  const blob = new Blob([result.value.svg], { type: "image/svg+xml" });
  downloadBlob(blob, isSheet.value ? "barcode-sheet.svg" : "barcode.svg");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image could not be decoded."));
    img.src = src;
  });
}

/** Raster export scale: twice the SVG's own pixel size, the same headroom
 * QrPanel gives its PNG export. */
const PNG_SCALE = 2;

const pngError = ref<string | null>(null);

async function downloadPng() {
  if (!result.value.svg) return;
  pngError.value = null;
  try {
    const img = await loadImage(`data:image/svg+xml,${encodeURIComponent(result.value.svg)}`);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * PNG_SCALE));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * PNG_SCALE));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // A barcode reader needs a solid quiet zone; a transparent PNG can fail
    // to scan depending on what it is placed over.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, isSheet.value ? "barcode-sheet.png" : "barcode.png");
    }, "image/png");
  } catch (e) {
    pngError.value = e instanceof Error ? e.message : "The PNG could not be composed.";
  }
}

function printOutput() {
  window.print();
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="no-print grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Input
          </span>

          <div class="flex flex-col gap-1.5">
            <Label for="barcode-input" class="text-xs text-muted-foreground">
              {{ isSheet ? "Values, one per line" : "Value" }}
            </Label>
            <Textarea
              id="barcode-input"
              v-model="inputText"
              :placeholder="placeholder"
              spellcheck="false"
              :class="isSheet ? 'min-h-32' : 'min-h-16'"
              class="resize-y border-0 bg-card font-mono text-sm shadow-none focus-visible:ring-0"
            />
          </div>

          <p v-if="isSheet" class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ valueCount }} value{{ valueCount === 1 ? "" : "s" }}
            <span v-if="valueCount > 0">
              times {{ copiesValue }} = {{ valueCount * copiesValue }} label{{
                valueCount * copiesValue === 1 ? "" : "s"
              }}
              requested</span
            >
          </p>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <template v-for="spec in meta.options" :key="spec.id">
            <OptionControl v-if="showOption(spec.id)" v-model="opts[spec.id]" :spec="spec" />
          </template>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <div
          v-if="result.error"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">
            {{ result.error.message }}
          </p>
          <p v-if="result.error.fix" class="mt-1 text-muted-foreground">
            {{ result.error.fix }}
          </p>
        </div>

        <!-- The well stays white in both themes: a barcode reader needs
             reliable light on dark contrast, which a dark mode surface would
             break. -->
        <div
          v-else
          class="barcode-preview flex min-h-64 items-center justify-center rounded-[10px] bg-white p-4 shadow-[var(--sh-inset)]"
        >
          <img
            v-if="previewSrc"
            :src="previewSrc"
            :alt="isSheet ? 'Barcode sheet preview' : 'Barcode preview'"
            :class="isSheet ? 'max-h-[60vh] w-auto' : ''"
          />
          <p v-else class="text-sm text-muted-foreground">
            Enter a value to generate a barcode. Your files and inputs never leave your device.
          </p>
        </div>

        <p
          v-if="isSheet && result.capacity !== null && !result.error"
          class="text-xs text-muted-foreground tabular-nums"
        >
          Labels: {{ result.used }} of {{ result.capacity }} used
        </p>

        <div v-if="result.warnings.length" class="flex flex-col gap-1">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Notes
          </span>
          <ul class="flex flex-col gap-0.5">
            <li
              v-for="w in result.warnings"
              :key="`${w.value}-${w.text}`"
              class="text-xs text-muted-foreground"
            >
              <span class="font-mono">{{ w.value }}</span
              >: {{ w.text }}
            </li>
          </ul>
        </div>

        <div v-if="result.svg && !result.error" class="flex flex-wrap items-center gap-2">
          <CopyButton :text="result.svg ?? ''" label="Copy SVG" />
          <Button variant="outline" size="sm" @click="downloadSvg"> Download SVG </Button>
          <Button variant="outline" size="sm" @click="downloadPng"> Download PNG </Button>
          <Button variant="outline" size="sm" @click="printOutput"> Print </Button>
        </div>
        <p v-if="pngError" class="text-xs text-destructive">
          {{ pngError }}
        </p>
      </div>
    </div>

    <!-- eslint-disable-next-line vue/no-v-html -- the markup is built by this tool's own logic layer (encode, renderBarcodeSvg, renderSheetSvg), with every interpolated value escaped there, and is checked for a script tag before it reaches this binding -->
    <div class="barcode-print-area" v-html="result.svg ?? ''"></div>
  </div>
</template>

<style scoped>
.barcode-preview img {
  display: block;
  max-width: 100%;
  height: auto;
}
</style>

<style>
/*
 * Print isolation: only the generated barcode or sheet should reach paper, at
 * its own authored size (millimetres for a label sheet, pixels for a single
 * symbol), never scaled to fit the on-screen preview box. Scoped styles
 * cannot reach outside this component (header, sidebar, footer), so this
 * block is intentionally global but only ever loads on the barcode generator
 * page, since panels are lazy-loaded per tool.
 */
.barcode-print-area {
  display: none;
}

@media print {
  /* Anchors the sheet SVG's millimetre coordinates to the physical page
     corner. Without this, the browser's default page margin (commonly
     around 10mm) shifts every label off its die-cut position, which defeats
     the point of a sheet measured in real millimetres. */
  @page {
    margin: 0;
  }
  body * {
    visibility: hidden;
  }
  .barcode-print-area {
    display: block;
    visibility: visible;
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
  }
  .barcode-print-area * {
    visibility: visible;
  }
  .no-print {
    display: none !important;
  }
}
</style>
