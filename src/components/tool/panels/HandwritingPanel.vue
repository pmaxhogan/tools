<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Download, Eraser, Undo2 } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob, downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import CopyButton from "../CopyButton.vue";
import InkCanvas from "../InkCanvas.vue";

/**
 * Bespoke panel for the Handwriting Pad.
 *
 * The generic ToolShell is a textarea and a text block, which is exactly
 * nothing this tool needs: the input is a pointer and the output is a
 * picture. The drawing surface itself is InkCanvas, shared with the PDF
 * Toolbox's Sign tab, and the ink math lives in the tool's logic layer.
 * This file is the controls, the exports, and the honesty about recognition.
 *
 * Strokes are content, so they live in memory only: never localStorage, never
 * the URL (rule 7, rule 6). The pen settings are preferences, so those do
 * round trip through the fragment and a shared link opens with the same pen.
 */
const props = defineProps<{ meta: ToolMeta }>();

type Guides = "none" | "lines" | "signature";

/* ---------------------------------------------------------------- */
/* options, read from the tool's own metadata                        */
/* ---------------------------------------------------------------- */

function selectSpec(id: string): SelectOptionSpec | null {
  const spec = (props.meta.options ?? []).find((o) => o.id === id);
  return spec && spec.kind === "select" ? spec : null;
}

function segmentsOf(id: string, fallback: SegmentedOption[]): SegmentedOption[] {
  const spec = selectSpec(id);
  const options = spec?.options ?? [];
  return options.length ? options.map((o) => ({ value: o.value, label: o.label })) : fallback;
}

const guideOptions = computed(() =>
  segmentsOf("guides", [
    { value: "none", label: "Blank" },
    { value: "lines", label: "Ruled lines" },
    { value: "signature", label: "Signature line" },
  ]),
);

const shapeOptions = computed(() =>
  segmentsOf("shape", [
    { value: "16 / 9", label: "Wide" },
    { value: "4 / 3", label: "Standard" },
    { value: "3 / 4", label: "Tall" },
  ]),
);

/* ---------------------------------------------------------------- */
/* the pen                                                           */
/* ---------------------------------------------------------------- */

/**
 * Swatches. The five chart tokens are the site's only sanctioned non violet
 * hues, so the palette borrows them rather than inventing colors, plus the
 * ink black and the white every eraser-by-another-name needs on dark paper.
 *
 * The tokens are resolved to hex once, on mount, by asking the browser to
 * paint each one into a single pixel and reading it back. Two reasons: a
 * canvas cannot be handed a `var(...)`, and an exported SVG carrying an
 * `oklch()` stroke would open colorless in older vector editors. A stroke
 * therefore stores the hex it was drawn in and keeps it even if the page
 * theme changes underneath it.
 */
const SWATCH_TOKENS: { token: string; fallback: string; name: string }[] = [
  { token: "--foreground", fallback: "#1b1917", name: "Ink" },
  { token: "--primary", fallback: "#5b4bd6", name: "Violet" },
  { token: "--chart-1", fallback: "#d1743a", name: "Orange" },
  { token: "--chart-2", fallback: "#3f9d9b", name: "Teal" },
  { token: "--chart-3", fallback: "#2f5d80", name: "Blue" },
  { token: "--chart-4", fallback: "#e0a83c", name: "Amber" },
  { token: "--chart-5", fallback: "#e0913c", name: "Gold" },
];

interface Swatch {
  name: string;
  hex: string;
}

const swatches = ref<Swatch[]>([
  ...SWATCH_TOKENS.map((s) => ({ name: s.name, hex: s.fallback })),
  { name: "White", hex: "#ffffff" },
]);

const color = ref("#1b1917");
const baseWidth = ref(3);
const guides = ref<Guides>("lines");
const shape = ref("4 / 3");
const pressure = ref(true);

const pad = ref<InstanceType<typeof InkCanvas>>();
const strokeCount = ref(0);
const busy = ref(false);
const error = ref("");
const mounted = ref(false);

const hasInk = computed(() => strokeCount.value > 0);

/**
 * Paint a CSS color into one pixel and read the pixel back, which turns any
 * color syntax the browser understands into a plain sRGB hex.
 */
function resolveColor(value: string, fallback: string): string {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = "#000000";
  // An unparseable value leaves fillStyle untouched, so the black above is
  // what would come back; compare against a second probe to notice that.
  ctx.fillStyle = value;
  if (ctx.fillStyle === "#000000" && value.trim().toLowerCase() !== "#000000") return fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r ?? 0, g ?? 0, b ?? 0].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function loadSwatches() {
  const style = getComputedStyle(document.documentElement);
  swatches.value = [
    ...SWATCH_TOKENS.map((entry) => ({
      name: entry.name,
      hex: resolveColor(style.getPropertyValue(entry.token).trim(), entry.fallback),
    })),
    { name: "White", hex: "#ffffff" },
  ];
  // The default pen is whatever the ink swatch resolved to.
  if (!touchedColor) color.value = swatches.value[0]?.hex ?? "#1b1917";
}

let touchedColor = false;
let theme: MutationObserver | null = null;

function pickColor(hex: string) {
  touchedColor = true;
  color.value = hex;
}

/* ---------------------------------------------------------------- */
/* actions                                                           */
/* ---------------------------------------------------------------- */

function onChange(strokes: unknown[]) {
  strokeCount.value = strokes.length;
  error.value = "";
}

function undo() {
  pad.value?.undo();
}

function clear() {
  pad.value?.clear();
}

function fail(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
}

async function svgText(): Promise<string> {
  // The paper is a guide, so an exported SVG has no background unless the
  // pad itself is painted a color, which it is not here.
  return (await pad.value?.toSvg({ background: "transparent" })) ?? "";
}

async function downloadSvg() {
  busy.value = true;
  try {
    downloadText(await svgText(), "handwriting.svg", "image/svg+xml");
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

/**
 * CopyButton asks for the SVG at click time. Serializing the pad is the slow
 * part, so the busy flag still wraps it and the button stays disabled.
 */
async function svgForCopy(): Promise<string> {
  busy.value = true;
  try {
    return await svgText();
  } finally {
    busy.value = false;
  }
}

async function downloadPng(scale: number) {
  busy.value = true;
  try {
    const blob = await pad.value?.toPngBlob(scale);
    if (!blob) {
      error.value = "This browser would not encode the drawing as a PNG.";
      return;
    }
    downloadBlob(blob, scale === 1 ? "handwriting.png" : `handwriting@${scale}x.png`);
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* preferences in the fragment, never the drawing                    */
/* ---------------------------------------------------------------- */

function persist() {
  if (!mounted.value) return;
  const opts: Record<string, string> = {
    guides: guides.value,
    shape: shape.value,
    baseWidth: String(baseWidth.value),
    pressure: String(pressure.value),
  };
  // Only a color the user actually picked is worth sharing. Writing the
  // default would pin the pen to whichever theme the link was made in.
  if (touchedColor) opts.color = color.value;
  writeFragment({ opts });
}

onMounted(() => {
  loadSwatches();
  // The swatches are resolved token values, so a theme toggle changes them.
  if (typeof MutationObserver !== "undefined") {
    theme = new MutationObserver(() => loadSwatches());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  const frag = readFragment();
  const raw = frag.opts;
  if (raw.guides === "none" || raw.guides === "lines" || raw.guides === "signature") {
    guides.value = raw.guides;
  }
  if (raw.shape && shapeOptions.value.some((o) => o.value === raw.shape)) shape.value = raw.shape;
  const width = Number(raw.baseWidth);
  if (Number.isFinite(width) && width >= 1 && width <= 14) baseWidth.value = width;
  if (raw.pressure === "true" || raw.pressure === "false") pressure.value = raw.pressure === "true";
  if (raw.color && /^#[0-9a-fA-F]{6}$/.test(raw.color)) {
    touchedColor = true;
    color.value = raw.color.toLowerCase();
  }
  mounted.value = true;
});

onBeforeUnmount(() => {
  theme?.disconnect();
  theme = null;
});

watch([guides, shape, baseWidth, pressure, color], persist);
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <InkCanvas
      ref="pad"
      :color="color"
      :base-width="baseWidth"
      :guides="guides"
      :pressure="pressure"
      :aspect-ratio="shape"
      background="transparent"
      label="Handwriting pad. Draw here with a stylus, a finger, or a mouse."
      @change="onChange"
    />

    <!-- Pen -->
    <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Ink</span>
          <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Pen color">
            <button
              v-for="swatch in swatches"
              :key="swatch.hex + swatch.name"
              type="button"
              class="size-7 rounded-full border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="
                swatch.hex === color
                  ? 'ring-2 ring-ring ring-offset-2 ring-offset-[color:var(--secondary)]'
                  : ''
              "
              :style="{ backgroundColor: swatch.hex }"
              :aria-label="`${swatch.name} ink`"
              :aria-pressed="swatch.hex === color"
              @click="pickColor(swatch.hex)"
            />
          </div>
        </div>

        <div class="flex min-w-44 flex-1 flex-col gap-1.5">
          <span class="text-xs text-muted-foreground tabular-nums">
            Pen width: {{ baseWidth }} px
          </span>
          <Slider
            aria-label="Pen width in pixels"
            :model-value="[baseWidth]"
            :min="1"
            :max="14"
            :step="0.5"
            class="py-2"
            @update:model-value="(v) => (baseWidth = v?.[0] ?? baseWidth)"
          />
        </div>

        <div class="flex items-center gap-2 pb-2">
          <Switch
            id="ink-pressure"
            :model-value="pressure"
            @update:model-value="(v) => (pressure = Boolean(v))"
          />
          <Label for="ink-pressure" class="text-xs text-muted-foreground">
            Vary width with pressure
          </Label>
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Paper</span>
          <Segmented
            :model-value="guides"
            :options="guideOptions"
            label="Paper guides"
            size="sm"
            @update:model-value="(v) => (guides = v as Guides)"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Canvas shape</span>
          <Segmented
            :model-value="shape"
            :options="shapeOptions"
            label="Canvas shape"
            size="sm"
            @update:model-value="(v) => (shape = v)"
          />
        </div>

        <div class="flex items-center gap-2 pb-0.5">
          <Button variant="outline" size="sm" :disabled="!hasInk" @click="undo">
            <Undo2 class="size-4" />
            Undo
          </Button>
          <Button variant="ghost" size="sm" :disabled="!hasInk" @click="clear">
            <Eraser class="size-4" />
            Clear
          </Button>
        </div>
      </div>
    </div>

    <!-- Export -->
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" :disabled="!hasInk || busy" @click="downloadSvg">
        <Download class="size-4" />
        Download SVG
      </Button>
      <CopyButton
        :get-text="svgForCopy"
        :disabled="!hasInk || busy"
        label="Copy as SVG"
        variant="outline"
        size="sm"
        @failed="fail"
      />
      <Button variant="outline" size="sm" :disabled="!hasInk || busy" @click="downloadPng(1)">
        <Download class="size-4" />
        PNG 1x
      </Button>
      <Button variant="outline" size="sm" :disabled="!hasInk || busy" @click="downloadPng(2)">
        <Download class="size-4" />
        PNG 2x
      </Button>
      <span v-if="!hasInk" class="text-xs text-muted-foreground">
        Draw something to turn the exports on.
      </span>
    </div>

    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error }}</p>
    </div>

    <p class="text-xs text-muted-foreground">
      The ruled and signature guides are printed behind the ink by the page, so they never appear in
      an SVG or a PNG you export. Exports have a transparent background, so a light ink will not
      show against a white page. This pad does not read your handwriting: it has no recognition
      model, and it will not guess at your words. Everything is drawn in this tab, so your files and
      inputs never leave your device, and the drawing itself is held in memory only, so reloading
      the page clears it.
    </p>
  </div>
</template>
