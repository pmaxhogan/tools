<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowLeftRight, Check, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  PALETTE_KINDS,
  WCAG_LEVELS,
  buildPalette,
  contrastRatio,
  formatHex,
  nearestNamedColor,
  parseColor,
  run,
  srgbToOklch,
  wcagVerdicts,
} from "@/tools/color-picker/index";
import type { ParsedColor, Swatch, Vec3 } from "@/tools/color-picker/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the Color Suite.
 *
 * Three things the generic shell cannot do live here: a native color picker
 * wired two ways to a text field that takes any CSS color, a live contrast
 * preview that renders real text in the pair being checked, and palettes drawn
 * as swatch strips instead of a list of hex strings.
 *
 * Every number and every string on screen comes from the pure layer in
 * `src/tools/color-picker/` (PROJECT.md rule 27). `run` produces the reported
 * rows in all three modes, `parseColor` reads a token, `buildPalette` derives
 * the swatches, and `contrastRatio` plus `wcagVerdicts` decide the pass and
 * fail chips, so a chip can never disagree with the row beneath it. This file
 * owns only the DOM: state, debouncing, the URL fragment, and the clipboard.
 *
 * Nothing here touches the network: your files and inputs never leave your
 * device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

/** Tab values double as the tool's mode values, so the tab, the URL fragment
 * and the meta option vocabulary are all one set. */
const TABS = ["convert", "contrast", "palette"] as const;
type Mode = (typeof TABS)[number];

/** Typing should not re-parse on every keystroke. */
const DEBOUNCE_MS = 200;

const DEFAULT_COLOR = "#663399";
const DEFAULT_FOREGROUND = "#777777";
const DEFAULT_BACKGROUND = "#ffffff";

const mode = ref<Mode>("convert");

/** What the fields hold right now. */
const colorText = ref(DEFAULT_COLOR);
const foregroundText = ref(DEFAULT_FOREGROUND);
const backgroundText = ref(DEFAULT_BACKGROUND);
const paletteKind = ref("all");

/** The debounced mirrors every result is computed from. */
const colorInput = ref(DEFAULT_COLOR);
const foregroundInput = ref(DEFAULT_FOREGROUND);
const backgroundInput = ref(DEFAULT_BACKGROUND);

interface PanelError {
  message: string;
  fix?: string;
}

function toPanelError(err: unknown, fallback: string): PanelError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

function rgbOf(color: ParsedColor): Vec3 {
  return [color.r, color.g, color.b];
}

/** The opaque `#rrggbb` a native color input can hold. */
function opaqueHex(color: ParsedColor): string {
  return formatHex({ ...color, a: 1 });
}

/* ------------------------------------------------------------------ *
 * fragment and debouncing
 * ------------------------------------------------------------------ */

/** Guards the fragment writer: readFragment and writeFragment both touch
 * window, so neither may run while the island is being rendered on the server. */
let ready = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

function syncFragment() {
  if (!ready) return;
  const opts: Record<string, string> = { mode: mode.value, paletteKind: paletteKind.value };
  const fg = foregroundText.value.trim();
  const bg = backgroundText.value.trim();
  if (fg) opts.fg = fg;
  if (bg) opts.bg = bg;
  writeFragment({ input: colorText.value.trim(), opts });
}

function applyInputs() {
  colorInput.value = colorText.value;
  foregroundInput.value = foregroundText.value;
  backgroundInput.value = backgroundText.value;
  syncFragment();
}

function scheduleApply() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyInputs, DEBOUNCE_MS);
}

/** A native color input is already a valid hex and fires continuously while
 * it is dragged, so it skips the debounce and lands straight away. */
function applyNow() {
  clearTimeout(debounceTimer);
  applyInputs();
}

watch([colorText, foregroundText, backgroundText], scheduleApply);
watch([mode, paletteKind], syncFragment);

/* ------------------------------------------------------------------ *
 * picker tab
 * ------------------------------------------------------------------ */

/** The rows of the convert report that state the color in another syntax.
 * Everything else in the report is context, and goes under Details. */
const FORMAT_KEYS = new Set([
  "Hex",
  "RGB",
  "HSL",
  "HWB",
  "OKLCH",
  "OKLab",
  "Lab (D50)",
  "LCH (D50)",
  "Nearest CSS color",
]);

interface ConvertState {
  parsed: ParsedColor | null;
  formats: [string, string][];
  details: [string, string][];
  error: PanelError | null;
}

const convert = computed<ConvertState>(() => {
  const raw = colorInput.value.trim();
  // An empty field is an empty state, not a mistake, so it never gets the
  // error style.
  if (!raw) return { parsed: null, formats: [], details: [], error: null };
  try {
    const parsed = parseColor(raw);
    const report = run(raw, { mode: "convert", paletteKind: paletteKind.value });
    const formats: [string, string][] = [];
    const details: [string, string][] = [];
    for (const [key, value] of Object.entries(report)) {
      (FORMAT_KEYS.has(key) ? formats : details).push([key, value]);
    }
    return { parsed, formats, details, error: null };
  } catch (err) {
    return {
      parsed: null,
      formats: [],
      details: [],
      error: toPanelError(err, "That color could not be read."),
    };
  }
});

/** What the native color input shows. It only accepts opaque `#rrggbb`. */
const pickerHex = computed(() =>
  convert.value.parsed ? opaqueHex(convert.value.parsed) : "#000000",
);

/** The preview fill, alpha included, which is why it sits on a checkerboard. */
const previewCss = computed(() =>
  convert.value.parsed ? formatHex(convert.value.parsed) : "transparent",
);

/** Black or white for the label inside the preview, whichever reads better. */
const previewInk = computed(() => {
  const parsed = convert.value.parsed;
  if (!parsed) return "inherit";
  const rgb = rgbOf(parsed);
  return contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [1, 1, 1]) ? "#000000" : "#ffffff";
});

const previewName = computed(() =>
  convert.value.parsed ? nearestNamedColor(rgbOf(convert.value.parsed)).name : "",
);

const formatsCopyText = computed(() =>
  convert.value.formats.map(([k, v]) => `${k}: ${v}`).join("\n"),
);

function onPickerSwatch(value: string) {
  colorText.value = value;
  applyNow();
}

/* ------------------------------------------------------------------ *
 * contrast tab
 * ------------------------------------------------------------------ */

interface ContrastState {
  foreground: ParsedColor | null;
  background: ParsedColor | null;
  rows: [string, string][];
  ratio: number;
  verdicts: Record<string, boolean>;
  error: PanelError | null;
}

const EMPTY_CONTRAST: ContrastState = {
  foreground: null,
  background: null,
  rows: [],
  ratio: 1,
  verdicts: {},
  error: null,
};

const contrast = computed<ContrastState>(() => {
  const fg = foregroundInput.value.trim();
  const bg = backgroundInput.value.trim();
  if (!fg || !bg) return EMPTY_CONTRAST;
  try {
    // Each field is validated on its own first, so an error names the field it
    // came from. It also guarantees neither value carries a comma or the word
    // "on", which is what makes the combined "fg on bg" form split into
    // exactly the two operands the report expects.
    const foreground = parseColor(fg);
    const background = parseColor(bg);
    const report = run(`${fg} on ${bg}`, { mode: "contrast", paletteKind: paletteKind.value });
    const ratio = contrastRatio(rgbOf(foreground), rgbOf(background));
    return {
      foreground,
      background,
      rows: Object.entries(report),
      ratio,
      verdicts: wcagVerdicts(ratio),
      error: null,
    };
  } catch (err) {
    return {
      ...EMPTY_CONTRAST,
      error: toPanelError(err, "Those colors could not be compared."),
    };
  }
});

const foregroundHex = computed(() =>
  contrast.value.foreground ? opaqueHex(contrast.value.foreground) : "#000000",
);
const backgroundHex = computed(() =>
  contrast.value.background ? opaqueHex(contrast.value.background) : "#ffffff",
);
const previewForeground = computed(() =>
  contrast.value.foreground ? formatHex(contrast.value.foreground) : "inherit",
);
const previewBackground = computed(() =>
  contrast.value.background ? formatHex(contrast.value.background) : "transparent",
);
const ratioText = computed(() => `${contrast.value.ratio.toFixed(2)}:1`);
const contrastCopyText = computed(() =>
  contrast.value.rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
);

function onForegroundSwatch(value: string) {
  foregroundText.value = value;
  applyNow();
}

function onBackgroundSwatch(value: string) {
  backgroundText.value = value;
  applyNow();
}

function swapColors() {
  const fg = foregroundText.value;
  foregroundText.value = backgroundText.value;
  backgroundText.value = fg;
  applyNow();
}

/* ------------------------------------------------------------------ *
 * palettes tab
 * ------------------------------------------------------------------ */

/** Display names for the families `buildPalette` labels its swatches with.
 * Anything not listed falls back to the label the logic layer used. */
const FAMILY_LABELS: Record<string, string> = {
  "Split complement": "Split complementary",
  Tint: "Tints",
  Shade: "Shades",
  Scale: "Numbered scale",
};

interface PaletteSwatch {
  label: string;
  hex: string;
  clipped: boolean;
  /** The CSS custom property name this swatch exports as. Unique, so it also
   * keys the copied marker (two families can share a hex). */
  varName: string;
}

interface PaletteFamily {
  key: string;
  label: string;
  swatches: PaletteSwatch[];
}

/** "Complementary (hue +180)" and "Tint 3" both belong to one family. */
function familyOf(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+\d+$/, "")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function groupSwatches(swatches: Swatch[]): PaletteFamily[] {
  const families: PaletteFamily[] = [];
  const byKey = new Map<string, PaletteFamily>();
  for (const swatch of swatches) {
    const family = familyOf(swatch.label);
    const key = slugify(family) || "palette";
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, label: FAMILY_LABELS[family] ?? family, swatches: [] };
      byKey.set(key, bucket);
      families.push(bucket);
    }
    // "Scale 700" keeps its stop number, "Analogous (hue -30)" gets its
    // position, so every name reads like a design token.
    const trailing = /\s(\d+)$/.exec(swatch.label);
    const suffix = trailing ? trailing[1] : String(bucket.swatches.length + 1);
    bucket.swatches.push({
      label: swatch.label,
      hex: swatch.hex,
      clipped: swatch.clipped,
      varName: `${key}-${suffix}`,
    });
  }
  return families;
}

interface PaletteState {
  baseHex: string;
  families: PaletteFamily[];
  notes: [string, string][];
  error: PanelError | null;
}

const EMPTY_PALETTE: PaletteState = { baseHex: "", families: [], notes: [], error: null };

/** Report rows that are prose about the whole palette rather than a swatch. */
const PALETTE_NOTE_KEYS = ["sRGB gamut", "Method"];

const palette = computed<PaletteState>(() => {
  const raw = colorInput.value.trim();
  if (!raw) return EMPTY_PALETTE;
  try {
    // run() first: it is the one that rejects an unknown palette kind.
    const report = run(raw, { mode: "palette", paletteKind: paletteKind.value });
    const parsed = parseColor(raw);
    const swatches = buildPalette(srgbToOklch(rgbOf(parsed)), paletteKind.value);
    const notes: [string, string][] = [];
    for (const key of PALETTE_NOTE_KEYS) {
      const value = report[key];
      if (value) notes.push([key, value]);
    }
    return {
      baseHex: opaqueHex(parsed),
      families: groupSwatches(swatches),
      notes,
      error: null,
    };
  } catch (err) {
    return { ...EMPTY_PALETTE, error: toPanelError(err, "That palette could not be built.") };
  }
});

const cssVariables = computed(() => {
  const lines: string[] = [];
  if (palette.value.baseHex) lines.push(`--base: ${palette.value.baseHex};`);
  for (const family of palette.value.families) {
    for (const swatch of family.swatches) lines.push(`--${swatch.varName}: ${swatch.hex};`);
  }
  return lines.join("\n");
});

const paletteSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "paletteKind");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "paletteKind",
    label: "Palette to build",
    default: "all",
    options: PALETTE_KINDS.map((k) => ({ value: k, label: k, synonyms: [k] })),
  };
});

/** Which swatch was copied last, so one strip cell can show it. */
const copiedKey = ref<string | null>(null);

async function copySwatch(key: string, hex: string) {
  try {
    await navigator.clipboard.writeText(hex);
  } catch {
    return;
  }
  copiedKey.value = key;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedKey.value = null), 1500);
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  if (state.input) colorText.value = state.input;
  const fromHash = state.opts["mode"];
  if (fromHash && (TABS as readonly string[]).includes(fromHash)) mode.value = fromHash as Mode;
  const fg = state.opts["fg"];
  if (fg) foregroundText.value = fg;
  const bg = state.opts["bg"];
  if (bg) backgroundText.value = bg;
  const kind = state.opts["paletteKind"];
  if (kind && PALETTE_KINDS.includes(kind)) paletteKind.value = kind;
  applyInputs();
  ready = true;
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
  clearTimeout(copyTimer);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="mode" class="w-full">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="convert"> Picker </TabsTrigger>
        <TabsTrigger value="contrast"> Contrast </TabsTrigger>
        <TabsTrigger value="palette"> Palettes </TabsTrigger>
      </TabsList>

      <!-- picker -->
      <TabsContent value="convert" class="flex flex-col gap-4 pt-4">
        <div class="grid gap-4 sm:grid-cols-[minmax(0,15rem)_1fr]">
          <div
            class="relative h-40 w-full overflow-hidden rounded-[14px] border"
            style="
              background-image: repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%);
              background-size: 16px 16px;
            "
          >
            <div class="absolute inset-0" :style="{ backgroundColor: previewCss }" />
            <div
              v-if="convert.parsed"
              class="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 px-3 py-2"
              :style="{ color: previewInk }"
            >
              <span class="font-mono text-sm">{{ previewCss }}</span>
              <span class="truncate text-xs">{{ previewName }}</span>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="cp-color-text" class="text-xs text-muted-foreground">Color</Label>
            <div
              class="flex h-12 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
            >
              <input
                id="cp-color-swatch"
                type="color"
                aria-label="Pick a color"
                class="size-9 shrink-0 cursor-pointer rounded-[8px] border-0 bg-transparent p-0 outline-none"
                :value="pickerHex"
                @input="onPickerSwatch(($event.target as HTMLInputElement).value)"
              />
              <input
                id="cp-color-text"
                v-model="colorText"
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                placeholder="#663399"
                class="min-w-0 flex-1 bg-transparent font-mono text-base outline-none md:text-sm"
                :aria-invalid="convert.error ? 'true' : undefined"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              Drag the swatch or type any CSS color: hex, rgb(), hsl(), hwb(), lab(), lch(),
              oklab(), oklch(), or a color name such as rebeccapurple.
            </p>
          </div>
        </div>

        <div
          v-if="convert.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ convert.error.message }}</span>
          <span v-if="convert.error.fix" class="text-muted-foreground">{{
            convert.error.fix
          }}</span>
        </div>

        <div
          v-if="convert.formats.length > 0"
          class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        >
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Formats
            </span>
            <CopyButton :text="formatsCopyText" label="Copy all" />
          </div>
          <div class="divide-y divide-border/60">
            <div
              v-for="[key, value] in convert.formats"
              :key="key"
              class="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div class="min-w-0">
                <div class="text-xs text-muted-foreground">{{ key }}</div>
                <div class="font-mono text-sm break-words">{{ value }}</div>
              </div>
              <CopyButton :text="value" />
            </div>
          </div>
        </div>

        <div
          v-if="convert.details.length > 0"
          class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        >
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Details
            </span>
          </div>
          <div class="divide-y divide-border/60">
            <div
              v-for="[key, value] in convert.details"
              :key="key"
              class="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div class="min-w-0">
                <div class="text-xs text-muted-foreground">{{ key }}</div>
                <div class="font-mono text-sm break-words">{{ value }}</div>
              </div>
              <CopyButton :text="value" />
            </div>
          </div>
        </div>

        <p v-if="!convert.parsed && !convert.error" class="text-xs text-muted-foreground">
          Pick a color above to see it in every syntax, with its nearest CSS color name and its
          contrast against white and black.
        </p>
      </TabsContent>

      <!-- contrast -->
      <TabsContent value="contrast" class="flex flex-col gap-4 pt-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <Label for="cp-fg-text" class="text-xs text-muted-foreground">Foreground</Label>
            <div
              class="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
            >
              <input
                id="cp-fg-swatch"
                type="color"
                aria-label="Pick a foreground color"
                class="size-7 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
                :value="foregroundHex"
                @input="onForegroundSwatch(($event.target as HTMLInputElement).value)"
              />
              <input
                id="cp-fg-text"
                v-model="foregroundText"
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                placeholder="#777777"
                class="min-w-0 flex-1 bg-transparent font-mono text-base outline-none md:text-sm"
                :aria-invalid="contrast.error ? 'true' : undefined"
              />
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="cp-bg-text" class="text-xs text-muted-foreground">Background</Label>
            <div
              class="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
            >
              <input
                id="cp-bg-swatch"
                type="color"
                aria-label="Pick a background color"
                class="size-7 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
                :value="backgroundHex"
                @input="onBackgroundSwatch(($event.target as HTMLInputElement).value)"
              />
              <input
                id="cp-bg-text"
                v-model="backgroundText"
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                placeholder="#ffffff"
                class="min-w-0 flex-1 bg-transparent font-mono text-base outline-none md:text-sm"
                :aria-invalid="contrast.error ? 'true' : undefined"
              />
            </div>
          </div>
        </div>

        <div>
          <Button type="button" variant="outline" size="sm" @click="swapColors">
            <ArrowLeftRight class="size-3.5" aria-hidden="true" />
            Swap
          </Button>
        </div>

        <div
          v-if="contrast.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ contrast.error.message }}</span>
          <span v-if="contrast.error.fix" class="text-muted-foreground">
            {{ contrast.error.fix }}
          </span>
        </div>

        <template v-if="contrast.rows.length > 0">
          <div
            class="flex flex-col gap-3 rounded-[10px] border p-5"
            :style="{ backgroundColor: previewBackground, color: previewForeground }"
          >
            <p class="text-[15px] leading-[1.6]">
              Normal text at 15px. The quick brown fox jumps over the lazy dog, then reads the small
              print without squinting.
            </p>
            <p class="text-2xl font-semibold">Large text at 24px</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-2xl tabular-nums">{{ ratioText }}</span>
            <span
              v-for="level in WCAG_LEVELS"
              :key="level.label"
              class="inline-flex items-center gap-1 rounded-[8px] border px-2 py-0.5 text-xs"
              :class="
                contrast.verdicts[level.label]
                  ? 'border-[var(--positive)]/40 text-[var(--positive)]'
                  : 'border-destructive/40 text-destructive'
              "
            >
              <Check v-if="contrast.verdicts[level.label]" class="size-3.5" aria-hidden="true" />
              <X v-else class="size-3.5" aria-hidden="true" />
              {{ level.label }}
            </span>
          </div>

          <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
            <div class="flex items-center justify-between px-3 pt-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                WCAG report
              </span>
              <CopyButton :text="contrastCopyText" label="Copy all" />
            </div>
            <div class="divide-y divide-border/60">
              <div
                v-for="[key, value] in contrast.rows"
                :key="key"
                class="flex items-start justify-between gap-3 px-3 py-2"
              >
                <div class="min-w-0">
                  <div class="text-xs text-muted-foreground">{{ key }}</div>
                  <div class="font-mono text-sm break-words">{{ value }}</div>
                </div>
                <CopyButton :text="value" />
              </div>
            </div>
          </div>
        </template>

        <p v-else-if="!contrast.error" class="text-xs text-muted-foreground">
          Give a foreground and a background color to see the ratio and the AA and AAA verdicts for
          normal and large text.
        </p>
      </TabsContent>

      <!-- palettes -->
      <TabsContent value="palette" class="flex flex-col gap-4 pt-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <Label for="cp-base-text" class="text-xs text-muted-foreground">Base color</Label>
            <div
              class="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-transparent px-2 focus-within:ring-3 focus-within:ring-ring/50"
            >
              <input
                id="cp-base-swatch"
                type="color"
                aria-label="Pick a base color"
                class="size-7 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 outline-none"
                :value="pickerHex"
                @input="onPickerSwatch(($event.target as HTMLInputElement).value)"
              />
              <input
                id="cp-base-text"
                v-model="colorText"
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                placeholder="#663399"
                class="min-w-0 flex-1 bg-transparent font-mono text-base outline-none md:text-sm"
                :aria-invalid="palette.error ? 'true' : undefined"
              />
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="cp-palette-kind" class="text-xs text-muted-foreground">
              {{ paletteSpec.label }}
            </Label>
            <SearchableSelect
              id="cp-palette-kind"
              :spec="paletteSpec"
              :model-value="paletteKind"
              class="w-full bg-card"
              @update:model-value="(v: string) => (paletteKind = v)"
            />
          </div>
        </div>

        <div
          v-if="palette.error"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ palette.error.message }}</span>
          <span v-if="palette.error.fix" class="text-muted-foreground">{{
            palette.error.fix
          }}</span>
        </div>

        <template v-if="palette.families.length > 0">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Swatches
            </span>
            <CopyButton :text="cssVariables" label="Copy all as CSS variables" />
          </div>

          <div class="flex flex-col gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="flex flex-col gap-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Base
              </span>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="group flex w-[5.5rem] flex-col gap-1 text-left"
                  :aria-label="`Copy the base color ${palette.baseHex}`"
                  @click="copySwatch('base', palette.baseHex)"
                >
                  <span
                    class="block h-14 w-full rounded-[8px] border transition-transform group-hover:-translate-y-0.5"
                    :style="{ backgroundColor: palette.baseHex }"
                  />
                  <span class="font-mono text-xs">
                    {{ copiedKey === "base" ? "Copied" : palette.baseHex }}
                  </span>
                  <span class="truncate text-[0.65rem] text-muted-foreground">base</span>
                </button>
              </div>
            </div>

            <div v-for="family in palette.families" :key="family.key" class="flex flex-col gap-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                {{ family.label }}
              </span>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="swatch in family.swatches"
                  :key="swatch.varName"
                  type="button"
                  class="group flex w-[5.5rem] flex-col gap-1 text-left"
                  :aria-label="`Copy ${swatch.hex}, ${swatch.label}`"
                  @click="copySwatch(swatch.varName, swatch.hex)"
                >
                  <span
                    class="block h-14 w-full rounded-[8px] border transition-transform group-hover:-translate-y-0.5"
                    :style="{ backgroundColor: swatch.hex }"
                  />
                  <span class="font-mono text-xs">
                    {{ copiedKey === swatch.varName ? "Copied" : swatch.hex }}
                  </span>
                  <span
                    class="truncate text-[0.65rem] text-muted-foreground"
                    :title="
                      swatch.clipped ? `${swatch.label}, chroma reduced to fit sRGB` : swatch.label
                    "
                  >
                    {{ swatch.clipped ? `${swatch.label} *` : swatch.label }}
                  </span>
                </button>
              </div>
            </div>
          </div>

          <p class="text-xs text-muted-foreground">
            Click a swatch to copy its hex. A star marks a swatch whose chroma was reduced to fit
            inside sRGB.
          </p>

          <p v-for="[key, value] in palette.notes" :key="key" class="text-xs text-muted-foreground">
            {{ key }}: {{ value }}
          </p>
        </template>

        <p v-else-if="!palette.error" class="text-xs text-muted-foreground">
          Pick a base color to build hue rotations and lightness ramps in OKLCH, each swatch ready
          to copy as a hex or as a set of CSS variables.
        </p>
      </TabsContent>
    </Tabs>

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
