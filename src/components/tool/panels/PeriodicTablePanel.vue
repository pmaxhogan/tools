<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  CATEGORIES,
  PALETTE_IDS,
  TRENDS,
  describeElement,
  elementBySymbol,
  findElement,
  layoutFor,
  paletteColor,
  pubchemUrl,
  trendColor,
  trendRange,
  wikipediaUrl,
  type ElementCell,
  type MarkerCell,
  type PaletteId,
  type TrendId,
  type TrendSpec,
} from "@/tools/periodic-table/index";
import type { Element } from "@/tools/_generated/elements";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText, type KeyValueRow } from "@/lib/key-value";
import KeyValueGrid from "../KeyValueGrid.vue";
import CopyButton from "../CopyButton.vue";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

/**
 * Bespoke panel for the periodic table.
 *
 * The logic layer owns where a cell goes and what color a trend paints; this
 * file owns the grid, the detail card, and URL fragment state (PROJECT.md
 * rule 27).
 *   src/tools/periodic-table/index.ts  layoutFor (layoutStandard, layoutWide),
 *                                      TRENDS, trendColor, trendRange,
 *                                      paletteColor, PALETTE_IDS, CATEGORIES,
 *                                      describeElement, findElement,
 *                                      elementBySymbol, wikipediaUrl,
 *                                      pubchemUrl
 *
 * PLACEMENT IS INLINE STYLE, NOT UTILITY CLASSES
 * ----------------------------------------------
 * Column and row come from the layout at runtime, and Tailwind only emits
 * classes it can see in the source, so `grid-column` and the track template are
 * set as inline styles. That also makes the two layouts one component: the wide
 * table is thirty two columns of the same cell.
 *
 * COLOR
 * -----
 * A trend paints from the chosen palette and an element with no published value
 * stays on the muted surface, which is the honest answer for the synthetic end
 * of period 7. Category coloring uses the map below, which is keyed by the
 * PubChem category names in CATEGORIES. Both paths pick the ink by contrast, so
 * a viridis cell at either end of the ramp still reads at AA.
 *
 * The table scrolls inside its own box. The wide layout is 32 columns and will
 * not fit a phone, and a tool panel must never make the page scroll sideways.
 *
 * Nothing reads the DOM before mount: readFragment runs in onMounted and the
 * fragment writer stays quiet until then, so the server rendered markup is the
 * standard table with carbon selected.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** "none" is the Category coloring, and is the value meta.ts uses for it. */
const TREND_OPTIONS: SegmentedOption[] = [
  { value: "none", label: "Category" },
  ...TRENDS.map((t) => ({ value: t.id, label: t.label })),
];

const LAYOUT_OPTIONS: SegmentedOption[] = [
  { value: "standard", label: "Standard" },
  { value: "wide", label: "Wide" },
];

/**
 * One fill per PubChem category. Every value is light enough that the ink test
 * below picks the dark ink, so the swatches stay legible in both themes. A
 * category the dataset gains later falls through to the muted surface, and
 * CATEGORIES is the list to reconcile against.
 */
const CATEGORY_COLORS: Record<string, string> = {
  Nonmetal: "#a9dfd8",
  "Noble gas": "#c9c2f2",
  "Alkali metal": "#f7c9a9",
  "Alkaline earth metal": "#f4dda6",
  Metalloid: "#c2e3a6",
  Halogen: "#f2c4d8",
  "Post-transition metal": "#b9d3ef",
  "Transition metal": "#dcd5c8",
  Lanthanide: "#e6bfe0",
  Actinide: "#e8b9b0",
};

/**
 * Cell track per layout: the smallest the cell may get before the box starts
 * scrolling, and the largest it grows to on a wide screen. Elastic rather than
 * fixed because the tool page keeps a sidebar and a detail column at xl, and an
 * 18 column table pinned at its maximum would scroll on a 1280px desktop, which
 * reads as broken. Cells stay square through `aspect-square`, so the row height
 * follows whatever width the track resolves to.
 */
const CELL_TRACK: Record<string, { min: string; max: string }> = {
  standard: { min: "30px", max: "44px" },
  wide: { min: "26px", max: "36px" },
};

/** Stops in the legend gradient. Enough that viridis reads as continuous. */
const LEGEND_STOPS = 12;

const DEFAULTS: Record<string, string> = {
  symbol: "C",
  layout: "standard",
  trend: "none",
  palette: "viridis",
};

const LAYOUT_VALUES = ["standard", "wide"];
const TREND_VALUES = TREND_OPTIONS.map((o) => o.value);

/* ------------------------------------------------------------------ *
 * ink
 * ------------------------------------------------------------------ */

/** sRGB relative luminance, the WCAG definition. Input is "#rrggbb". */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

const DARK_INK = "#111111";
const LIGHT_INK = "#ffffff";

/** Whichever ink has the higher contrast ratio against the fill. */
function inkFor(fill: string): string {
  const l = luminance(fill);
  const onDark = (l + 0.05) / (luminance(DARK_INK) + 0.05);
  const onLight = (luminance(LIGHT_INK) + 0.05) / (l + 0.05);
  return onDark >= onLight ? DARK_INK : LIGHT_INK;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const symbol = ref(DEFAULTS.symbol!);
const layoutMode = ref(DEFAULTS.layout!);
const trend = ref(DEFAULTS.trend!);
const palette = ref<PaletteId>("viridis");
const mounted = ref(false);

/* ------------------------------------------------------------------ *
 * layout
 * ------------------------------------------------------------------ */

const layout = computed(() => layoutFor(layoutMode.value));

const elementCells = computed(() =>
  layout.value.cells.filter((c): c is ElementCell => c.kind === "element"),
);

/** Only the standard layout has them; the wide one splices the f block inline. */
const markerCells = computed(() =>
  layout.value.cells.filter((c): c is MarkerCell => c.kind === "marker"),
);

const gridStyle = computed(() => {
  const track = CELL_TRACK[layoutMode.value] ?? CELL_TRACK.standard!;
  return {
    gridTemplateColumns: `repeat(${layout.value.columns}, minmax(${track.min}, ${track.max}))`,
  };
});

/* ------------------------------------------------------------------ *
 * color
 * ------------------------------------------------------------------ */

const activeTrend = computed<TrendSpec | undefined>(() =>
  TRENDS.find((t) => t.id === (trend.value as TrendId)),
);

const range = computed(() => (activeTrend.value ? trendRange(activeTrend.value.id) : undefined));

interface Paint {
  fill: string;
  ink: string;
}

function paintFor(el: Element): Paint | undefined {
  const spec = activeTrend.value;
  if (spec) {
    const paint = trendColor(el, spec.id, palette.value);
    return paint ? { fill: paint.color, ink: inkFor(paint.color) } : undefined;
  }
  const fill = el.groupBlock ? CATEGORY_COLORS[el.groupBlock] : undefined;
  return fill ? { fill, ink: inkFor(fill) } : undefined;
}

function cellStyle(cell: ElementCell): Record<string, string> {
  const style: Record<string, string> = {
    gridColumn: String(cell.x),
    gridRow: String(cell.y),
  };
  const paint = paintFor(cell.element);
  if (paint) {
    style.backgroundColor = paint.fill;
    style.color = paint.ink;
  }
  return style;
}

function cellTitle(el: Element): string {
  const spec = activeTrend.value;
  const parts = [`${el.name}, ${el.atomicNumber}`];
  if (el.groupBlock) parts.push(el.groupBlock);
  if (spec) {
    const value = trendColor(el, spec.id, palette.value)?.value;
    parts.push(
      value === undefined
        ? `${spec.label}: no published value`
        : `${spec.label} ${value} ${spec.unit}`,
    );
  }
  return parts.join(" · ");
}

/** A cell with no paint sits on the muted surface, which reads as "no data". */
function isUnpainted(el: Element): boolean {
  return paintFor(el) === undefined;
}

/* ------------------------------------------------------------------ *
 * the legend
 * ------------------------------------------------------------------ */

const legendGradient = computed(() => {
  const stops: string[] = [];
  for (let i = 0; i < LEGEND_STOPS; i += 1) {
    stops.push(paletteColor(i / (LEGEND_STOPS - 1), palette.value));
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
});

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
}

/**
 * The palette dropdown reuses the spec meta.ts already declares, labels and
 * search synonyms included, so the panel and the generic shell offer the same
 * four ramps under the same names. It only appears while a trend is painting;
 * with Category coloring there is no ramp to choose.
 */
const paletteSpec = computed<SelectOptionSpec | undefined>(() => {
  const spec = props.meta.options?.find((o) => o.id === "palette");
  return spec?.kind === "select" ? spec : undefined;
});

function setPalette(value: string): void {
  if ((PALETTE_IDS as string[]).includes(value)) palette.value = value as PaletteId;
}

/* ------------------------------------------------------------------ *
 * the detail card
 * ------------------------------------------------------------------ */

const selected = computed<Element | undefined>(() => elementBySymbol(symbol.value));

/** Rendered as the links row instead, so they are dropped from the grid. */
const HIDDEN_ROWS = new Set(["Wikipedia", "PubChem"]);

const sheet = computed<Record<string, string>>(() =>
  selected.value ? describeElement(selected.value) : {},
);

const rows = computed<KeyValueRow[]>(() =>
  recordToRows(sheet.value).filter((row) => !HIDDEN_ROWS.has(row.key)),
);

const sheetText = computed(() => rowsToText(recordToRows(sheet.value)));

/** The tile beside the element name wears the same paint as its cell. */
const selectedStyle = computed<Record<string, string>>(() => {
  const el = selected.value;
  const paint = el ? paintFor(el) : undefined;
  if (!paint) return {} as Record<string, string>;
  return { backgroundColor: paint.fill, color: paint.ink };
});

function select(el: Element): void {
  symbol.value = el.symbol;
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

/**
 * One object, one write: writeFragment rebuilds the whole hash from what it is
 * given. The keys are the meta option ids, so a shared link is also an
 * /api/periodic-table query string, and a value equal to the meta default is
 * left out. That keeps the ordinary link down to the element, the layout, and
 * the trend, while a non-default palette still survives being shared.
 */
const fragmentOpts = computed<Record<string, string>>(() => {
  const state: Record<string, string> = {
    symbol: symbol.value,
    layout: layoutMode.value,
    trend: trend.value,
    palette: palette.value,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value !== DEFAULTS[key]) out[key] = value;
  }
  return out;
});

watch(fragmentOpts, (opts) => {
  if (!mounted.value) return;
  writeFragment({ opts });
});

onMounted(() => {
  const fragment = readFragment().opts;
  // findElement takes a symbol, a name, or an atomic number, and the canonical
  // symbol is what gets written back, so a hand typed "#symbol=26" normalizes.
  const el = fragment.symbol ? findElement(fragment.symbol) : undefined;
  if (el) symbol.value = el.symbol;
  if (fragment.layout && LAYOUT_VALUES.includes(fragment.layout))
    layoutMode.value = fragment.layout;
  if (fragment.trend && TREND_VALUES.includes(fragment.trend)) trend.value = fragment.trend;
  if (fragment.palette && (PALETTE_IDS as string[]).includes(fragment.palette))
    palette.value = fragment.palette as PaletteId;
  mounted.value = true;
});
</script>

<template>
  <div class="pt-panel grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
    <!-- ----------------------------------------------------------- table -->
    <section
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Color by</span>
          <Segmented
            :options="TREND_OPTIONS"
            :model-value="trend"
            size="sm"
            label="Color the table by"
            @update:model-value="trend = $event"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Layout</span>
          <Segmented
            :options="LAYOUT_OPTIONS"
            :model-value="layoutMode"
            size="sm"
            label="Table layout"
            @update:model-value="layoutMode = $event"
          />
        </div>
        <div v-if="activeTrend && paletteSpec" class="flex w-40 flex-col gap-1.5">
          <label for="pt-palette" class="text-xs text-muted-foreground">Palette</label>
          <SearchableSelect
            id="pt-palette"
            :spec="paletteSpec"
            :model-value="palette"
            @update:model-value="setPalette"
          />
        </div>
      </div>

      <!-- Wider than the box: it scrolls in here, never on the page. -->
      <div class="-mx-1 overflow-x-auto px-1 pb-1">
        <div class="grid w-full gap-[3px]" :style="gridStyle">
          <button
            v-for="cell in elementCells"
            :key="cell.element.atomicNumber"
            type="button"
            :aria-pressed="cell.element.symbol === symbol"
            :aria-label="`${cell.element.name}, element ${cell.element.atomicNumber}`"
            :title="cellTitle(cell.element)"
            class="relative flex aspect-square flex-col items-center justify-center rounded-[6px] border border-transparent transition-[box-shadow,transform] duration-[120ms] outline-none hover:ring-2 hover:ring-[color:var(--brand-hairline)] focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
            :class="[
              isUnpainted(cell.element) ? 'bg-secondary text-muted-foreground' : '',
              cell.element.symbol === symbol
                ? 'ring-2 ring-primary ring-offset-1 ring-offset-card'
                : '',
            ]"
            :style="cellStyle(cell)"
            @click="select(cell.element)"
          >
            <span class="absolute top-0.5 left-1 text-[9px] leading-none opacity-70 tabular-nums">
              {{ cell.element.atomicNumber }}
            </span>
            <span class="text-[13px] leading-none font-semibold">{{ cell.element.symbol }}</span>
          </button>

          <div
            v-for="marker in markerCells"
            :key="marker.label"
            class="flex aspect-square items-center justify-center rounded-[6px] bg-secondary text-[10px] text-muted-foreground shadow-[var(--sh-inset)]"
            :style="{ gridColumn: String(marker.x), gridRow: String(marker.y) }"
          >
            {{ marker.label }}
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- legend -->
      <div v-if="activeTrend && range" class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-xs font-medium">{{ activeTrend.label }} ({{ activeTrend.unit }})</span>
          <span class="text-xs text-muted-foreground">
            {{ range.count }} of 118 elements have a published value<template
              v-if="activeTrend.scale === 'log'"
            >
              · log scale</template
            >
          </span>
        </div>
        <div class="h-3 rounded-full border" :style="{ backgroundImage: legendGradient }"></div>
        <div class="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
          <span>{{ trimNumber(range.min) }}</span>
          <span>{{ trimNumber(range.max) }}</span>
        </div>
      </div>

      <ul v-else class="flex flex-wrap gap-x-4 gap-y-1.5">
        <li
          v-for="name in CATEGORIES"
          :key="name"
          class="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            class="size-3 rounded-[4px] border"
            :style="{ backgroundColor: CATEGORY_COLORS[name] ?? 'transparent' }"
          ></span>
          {{ name }}
        </li>
      </ul>
    </section>

    <!-- ----------------------------------------------------------- detail -->
    <section
      v-if="selected"
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-start gap-3">
        <span
          class="grid size-14 shrink-0 place-items-center rounded-[10px] border text-xl font-semibold"
          :style="selectedStyle"
          :class="isUnpainted(selected) ? 'bg-secondary text-muted-foreground' : ''"
          aria-hidden="true"
          >{{ selected.symbol }}</span
        >
        <div class="min-w-0 flex-1">
          <h2 class="text-[22px] leading-tight font-semibold tracking-[-0.014em]">
            {{ selected.name }}
          </h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {{ selected.atomicNumber
            }}<template v-if="selected.groupBlock"> · {{ selected.groupBlock }}</template
            ><template v-if="selected.atomicMassText"> · {{ selected.atomicMassText }} u</template>
          </p>
        </div>
        <CopyButton :text="sheetText" aria-label="Copy every field for this element" />
      </div>

      <KeyValueGrid :rows="rows" :columns="1" surface="secondary" dense />

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <a :href="wikipediaUrl(selected)" rel="noopener">Wikipedia</a>
        <a :href="pubchemUrl(selected)" rel="noopener">PubChem</a>
      </div>
    </section>
  </div>
</template>
