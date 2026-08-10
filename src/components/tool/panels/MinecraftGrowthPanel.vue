<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import {
  breeding,
  calculate,
  formatTicks,
  inGameDays,
  LAYOUT_PRESETS,
  type BreedingResult,
  type GrowthResult,
} from "@/tools/minecraft-crop-growth-calculator/index";
import {
  ANIMALS,
  CONSTANTS,
  GROWTH_VERSIONS,
  PLANTS,
  VERSION_CHANGELOG,
} from "@/tools/minecraft-crop-growth-calculator/data";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Split-workbench panel for the crop growth and breeding timer.
 *
 * Picker rail on the left (version, then a searchable grouped plant picker,
 * then only the context controls that plant actually has), live results on the
 * right: stat tiles for the headline timings, an SVG chart of the finish-time
 * distribution, the farm layout comparison ranked by yield per hour per block,
 * a random tick speed table, the bone meal card, and the breeding card.
 *
 * All math lives in the logic layer; this file owns DOM, fragment state, and
 * layout only. Controls are gated so no impossible combination is offered:
 * hydration and layout appear only for plants that read the farmland below,
 * the melon and pumpkin fruit-sides control appears only for stems, and a
 * plant that cannot be bone mealed says so instead of showing a control.
 */
defineProps<{ meta: ToolMeta }>();

const LATEST = GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1];

const version = ref(LATEST);
const plant = ref("wheat");
const layout = ref("full");
const randomTickSpeed = ref(CONSTANTS[LATEST].randomTickSpeedDefault);
const fruitSides = ref(4);
const chunkTicking = ref(true);
const animal = ref("cow");
const pairs = ref(1);
const mounted = ref(false);

const DEFAULTS: Record<string, string> = {
  v: LATEST,
  p: "wheat",
  l: "full",
  rts: String(CONSTANTS[LATEST].randomTickSpeedDefault),
  fs: "4",
  ct: "1",
  a: "cow",
  pr: "1",
};

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const VERSION_SYNONYMS: Record<string, string[]> = {
  "1.16.5": ["nether update", "1.16"],
  "1.18.2": ["caves and cliffs", "1.18"],
  "1.20.6": ["trails and tales", "1.20"],
  "1.21.1": ["tricky trials", "1.21"],
  "1.21.11": ["1.21"],
  "26.2": ["latest", "newest", "current"],
};

const CATEGORY_SYNONYMS: Record<string, string[]> = {
  "Farmland crops": ["farm", "hoe", "tilled", "hydration", "water"],
  "Nether plants": ["soul sand", "wart", "cocoa", "jungle"],
  "Stacking plants": ["column", "tall", "height", "sugar cane", "bamboo"],
  "Bushes and trees": ["sapling", "berry", "tree", "forest"],
};

const versionSpec: SelectOptionSpec = {
  kind: "select",
  id: "mcg-version",
  label: "Minecraft version",
  default: LATEST,
  options: GROWTH_VERSIONS.map((v) => ({
    value: v,
    label: v === LATEST ? `${v} (latest)` : v,
    synonyms: VERSION_SYNONYMS[v] ?? [],
  })),
};

const plantSpec = computed<SelectOptionSpec>(() => {
  const cats = [...new Set(PLANTS.map((p) => p.cat))];
  return {
    kind: "select",
    id: "mcg-plant",
    label: "Plant",
    default: "wheat",
    groups: cats
      .map((cat) => ({
        label: cat,
        synonyms: CATEGORY_SYNONYMS[cat] ?? [],
        options: PLANTS.filter((p) => p.cat === cat && p.versions.includes(version.value)).map(
          (p) => ({ value: p.id, label: p.label, synonyms: p.synonyms }),
        ),
      }))
      .filter((g) => g.options.length > 0),
  };
});

const layoutSpec: SelectOptionSpec = {
  kind: "select",
  id: "mcg-layout",
  label: "Farm layout",
  default: "full",
  options: LAYOUT_PRESETS.map((l) => ({
    value: l.id,
    label: l.label,
    synonyms: [l.id.replace(/-/g, " "), "hydration", "water"],
  })),
};

const animalSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcg-animal",
  label: "Animal",
  default: "cow",
  options: ANIMALS.filter((a) => a.versions.includes(version.value)).map((a) => ({
    value: a.id,
    label: a.label,
    synonyms: a.synonyms,
  })),
}));

/* ---------------------------------------------------------------- */
/* results                                                           */
/* ---------------------------------------------------------------- */

interface CalcError {
  message: string;
  fix?: string;
}

function toCalcError(e: unknown): CalcError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

const result = ref<GrowthResult | null>(null);
const breedResult = ref<BreedingResult | null>(null);
const error = ref<CalcError | null>(null);

function recompute() {
  try {
    result.value = calculate({
      version: version.value,
      plant: plant.value,
      layout: layout.value,
      randomTickSpeed: randomTickSpeed.value,
      fruitSides: fruitSides.value,
      chunkTicking: chunkTicking.value,
    });
    breedResult.value = breeding({
      version: version.value,
      animal: animal.value,
      pairs: pairs.value,
    });
    error.value = null;
  } catch (e) {
    result.value = null;
    breedResult.value = null;
    error.value = toCalcError(e);
  }
}

const plantInfo = computed(() => PLANTS.find((p) => p.id === plant.value));
const usesFarmland = computed(() => result.value?.model.farmland ?? false);
const isStem = computed(() => Boolean(result.value?.model.fruitSides));
const changelog = computed(() =>
  VERSION_CHANGELOG.filter(
    (c) => GROWTH_VERSIONS.indexOf(c.version) <= GROWTH_VERSIONS.indexOf(version.value),
  ),
);

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "never";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

interface StatTile {
  label: string;
  value: string;
  sub: string;
  copy: string;
}

const tiles = computed<StatTile[]>(() => {
  const r = result.value;
  if (!r) return [];
  const t = r.timing;
  const chance = t.chancePerRandomTick;
  // Stems get a fifth tile for the fruit rather than folding it into the
  // average: the median and the slowest 5 percent are stem-only, and a true
  // combined median is a compound distribution once a side is blocked, so
  // mixing the two quantities in one row would quietly compare apples to pears.
  const tiles: StatTile[] = [
    {
      label: "Chance per random tick",
      value: chance >= 1 ? "always" : `1 in ${fmt(1 / chance, 2)}`,
      sub: r.speed !== null ? `growth speed ${r.speed}` : "flat roll, no farmland involved",
      copy: chance >= 1 ? "1" : String(chance),
    },
    {
      label: r.fruit ? "Average time to a grown stem" : "Average time",
      value: formatTicks(t.meanTicks, r.version),
      sub: Number.isFinite(t.meanTicks)
        ? `${fmt(t.meanTicks)} ticks, ${fmt(inGameDays(t.meanTicks), 2)} in game days`
        : "never at this setting",
      copy: `${Math.round(t.meanTicks)} ticks`,
    },
    {
      label: "Median time",
      value: formatTicks(t.medianTicks, r.version),
      sub: "half of them are done by here",
      copy: `${t.medianTicks} ticks`,
    },
    {
      label: "Slowest 5 percent",
      value: formatTicks(t.p95Ticks, r.version),
      sub: "one in twenty is still growing at this point",
      copy: `${t.p95Ticks} ticks`,
    },
  ];
  if (r.fruit) {
    tiles.push({
      label: "Then, average per fruit",
      value: formatTicks(r.fruit.meanTicks, r.version),
      sub: `${fmt(r.fruit.expectedRolls, 2)} successful rolls with ${r.fruit.sides} free ${r.fruit.sides === 1 ? "side" : "sides"}`,
      copy: `${Math.round(r.fruit.meanTicks)} ticks`,
    });
  }
  return tiles;
});

/* ---------------------------------------------------------------- */
/* distribution chart                                                */
/* ---------------------------------------------------------------- */

const CHART_H = 210;
const CHART_W = 640;
const PAD = { left: 46, right: 14, top: 12, bottom: 30 };

const chart = computed(() => {
  const r = result.value;
  const points = r?.curve ?? [];
  if (points.length < 2) return null;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const maxTicks = points[points.length - 1].ticks || 1;
  const x = (ticks: number) => PAD.left + (ticks / maxTicks) * innerW;
  const y = (cdf: number) => PAD.top + innerH - cdf * innerH;
  const line = points.map((p) => `${x(p.ticks).toFixed(1)},${y(p.cdf).toFixed(1)}`).join(" ");
  const area = `${PAD.left},${PAD.top + innerH} ${line} ${x(maxTicks).toFixed(1)},${PAD.top + innerH}`;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    x: PAD.left + f * innerW,
    label: formatTicks(Math.round(f * maxTicks), r!.version),
  }));
  const yTicks = [0, 0.5, 1].map((f) => ({
    y: PAD.top + innerH - f * innerH,
    label: `${Math.round(f * 100)}%`,
  }));
  const markers = [
    { label: "median", ticks: r!.timing.medianTicks },
    { label: "slowest 5%", ticks: r!.timing.p95Ticks },
  ]
    .filter((m) => Number.isFinite(m.ticks) && m.ticks <= maxTicks)
    .map((m) => ({ ...m, x: x(m.ticks), top: PAD.top, bottom: PAD.top + innerH }));
  return { line, area, xTicks, yTicks, markers, baseY: PAD.top + innerH };
});

/* ---------------------------------------------------------------- */
/* farm layout diagram                                               */
/* ---------------------------------------------------------------- */

/**
 * A 7x7 top-down slice of the selected layout, drawn from the same preset the
 * math uses so the picture can never disagree with the numbers.
 */
const diagram = computed(() => {
  const preset = LAYOUT_PRESETS.find((l) => l.id === layout.value);
  if (!preset || !usesFarmland.value) return null;
  const size = 7;
  const cells: { x: number; y: number; kind: string }[] = [];
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      let kind = "planted";
      if (preset.id === "rows" || preset.id === "dry-rows") kind = z % 2 === 0 ? "planted" : "bare";
      else if (preset.id === "water-rows") kind = z % 2 === 0 ? "planted" : "water";
      else if (preset.id === "single") kind = x === 3 && z === 3 ? "planted" : "grass";
      if (preset.id === "full" && x === 3 && z === 3) kind = "water";
      cells.push({ x, y: z, kind });
    }
  }
  const dry = preset.id.startsWith("dry");
  return { cells, size, dry, label: preset.label, note: preset.note };
});

const CELL_FILL: Record<string, string> = {
  planted: "var(--primary)",
  bare: "var(--muted)",
  water: "var(--brand-2)",
  grass: "var(--accent)",
};

/* ---------------------------------------------------------------- */
/* fragment state                                                    */
/* ---------------------------------------------------------------- */

watch([version, plant, layout, randomTickSpeed, fruitSides, chunkTicking, animal, pairs], () => {
  recompute();
  if (!mounted.value) return;
  const state: Record<string, string> = {
    v: version.value,
    p: plant.value,
    l: layout.value,
    rts: String(randomTickSpeed.value),
    fs: String(fruitSides.value),
    ct: chunkTicking.value ? "1" : "0",
    a: animal.value,
    pr: String(pairs.value),
  };
  const opts: Record<string, string> = {};
  for (const [k, val] of Object.entries(state)) if (val !== DEFAULTS[k]) opts[k] = val;
  writeFragment({ opts });
});

watch(version, (v) => {
  if (!PLANTS.find((p) => p.id === plant.value)?.versions.includes(v)) plant.value = "wheat";
  if (!ANIMALS.find((a) => a.id === animal.value)?.versions.includes(v)) animal.value = "cow";
});

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

onMounted(() => {
  const frag = readFragment().opts;
  if (frag.v && GROWTH_VERSIONS.includes(frag.v)) version.value = frag.v;
  const wanted = frag.p && PLANTS.find((p) => p.id === frag.p);
  if (wanted && wanted.versions.includes(version.value)) plant.value = wanted.id;
  if (frag.l && LAYOUT_PRESETS.some((l) => l.id === frag.l)) layout.value = frag.l;
  if (frag.rts !== undefined) randomTickSpeed.value = clampInt(frag.rts, 0, 100, 3);
  if (frag.fs !== undefined) fruitSides.value = clampInt(frag.fs, 1, 4, 4);
  if (frag.ct !== undefined) chunkTicking.value = frag.ct !== "0";
  const wantedAnimal = frag.a && ANIMALS.find((a) => a.id === frag.a);
  if (wantedAnimal && wantedAnimal.versions.includes(version.value)) animal.value = wantedAnimal.id;
  if (frag.pr !== undefined) pairs.value = clampInt(frag.pr, 1, 999, 1);
  mounted.value = true;
  recompute();
});

recompute();
</script>

<template>
  <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <!-- Picker rail. -->
      <aside
        aria-label="Plant and farm setup"
        class="flex flex-col gap-4 lg:border-r lg:border-border lg:pr-6"
      >
        <OptionControl
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="version = String($event)"
        />
        <OptionControl
          :spec="plantSpec"
          :model-value="plant"
          @update:model-value="plant = String($event)"
        />

        <div class="h-px bg-border" role="presentation" />

        <OptionControl
          v-if="usesFarmland"
          :spec="layoutSpec"
          :model-value="layout"
          @update:model-value="layout = String($event)"
        />
        <p v-else class="text-xs text-muted-foreground">
          {{ plantInfo?.label }} ignores farmland, so hydration and field layout change nothing
          about how fast it grows.
        </p>

        <OptionControl
          v-if="isStem"
          :spec="{
            kind: 'number',
            id: 'mcg-sides',
            label: 'Free sides for the fruit',
            default: 4,
            min: 1,
            max: 4,
            step: 1,
          }"
          :model-value="fruitSides"
          @update:model-value="fruitSides = clampInt($event, 1, 4, 4)"
        />

        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcg-rts',
            label: 'Random tick speed',
            default: 3,
            min: 0,
            max: 100,
            step: 1,
          }"
          :model-value="randomTickSpeed"
          @update:model-value="randomTickSpeed = clampInt($event, 0, 100, 3)"
        />
        <OptionControl
          :spec="{
            kind: 'boolean',
            id: 'mcg-ticking',
            label: 'Chunk is loaded and ticking',
            default: true,
          }"
          :model-value="chunkTicking"
          @update:model-value="chunkTicking = Boolean($event)"
        />

        <div class="h-px bg-border" role="presentation" />

        <OptionControl
          :spec="animalSpec"
          :model-value="animal"
          @update:model-value="animal = String($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcg-pairs',
            label: 'Breeding pairs',
            default: 1,
            min: 1,
            max: 999,
            step: 1,
          }"
          :model-value="pairs"
          @update:model-value="pairs = clampInt($event, 1, 999, 1)"
        />
      </aside>

      <!-- Results. -->
      <section class="flex min-w-0 flex-col gap-6" aria-live="polite">
        <div
          v-if="error"
          class="rounded-[10px] bg-secondary px-4 py-3 text-sm shadow-[var(--sh-inset)]"
          role="alert"
        >
          <p class="font-medium">{{ error.message }}</p>
          <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
        </div>

        <template v-else-if="result">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="text-sm font-semibold">{{ result.plant.label }}</h2>
            <span class="text-xs text-muted-foreground">
              {{ result.plant.cat }} · Minecraft {{ result.version }} ·
              {{ result.model.stages }} growth
              {{ result.model.stages === 1 ? "step" : "steps" }}
              <template v-if="result.model.perBlock"> per new block</template>
            </span>
          </div>

          <!-- Headline stat tiles. -->
          <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div
              v-for="tile in tiles"
              :key="tile.label"
              class="flex items-start justify-between gap-1 rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
            >
              <div class="min-w-0">
                <div class="truncate text-xs text-muted-foreground" :title="tile.label">
                  {{ tile.label }}
                </div>
                <div class="font-mono text-lg tabular-nums">{{ tile.value }}</div>
                <div class="text-xs text-muted-foreground">{{ tile.sub }}</div>
              </div>
              <CopyButton :text="tile.copy" class="-mr-1.5 shrink-0" />
            </div>
          </div>

          <!-- Finish time distribution. -->
          <div v-if="chart" class="flex flex-col gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Chance it has finished by a given time
            </span>
            <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
              <svg
                :width="640"
                :height="210"
                viewBox="0 0 640 210"
                role="img"
                :aria-label="`Cumulative chance the plant has finished growing over time. Median ${formatTicks(result.timing.medianTicks, result.version)}, slowest five percent past ${formatTicks(result.timing.p95Ticks, result.version)}.`"
                class="text-primary"
              >
                <g class="text-border" stroke="currentColor" stroke-width="1">
                  <line
                    v-for="t in chart.yTicks"
                    :key="`y${t.y}`"
                    x1="46"
                    x2="626"
                    :y1="t.y"
                    :y2="t.y"
                    opacity="0.6"
                  />
                </g>
                <polygon :points="chart.area" fill="currentColor" opacity="0.12" />
                <polyline
                  :points="chart.line"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                />
                <g v-for="m in chart.markers" :key="m.label">
                  <line
                    :x1="m.x"
                    :x2="m.x"
                    :y1="m.top"
                    :y2="m.bottom"
                    stroke="currentColor"
                    stroke-width="1"
                    stroke-dasharray="3 3"
                    opacity="0.7"
                  />
                  <text
                    :x="m.x + 4"
                    :y="m.top + 10"
                    class="text-muted-foreground"
                    fill="currentColor"
                    font-size="10"
                  >
                    {{ m.label }}
                  </text>
                </g>
                <g class="text-muted-foreground" fill="currentColor" font-size="11">
                  <text
                    v-for="t in chart.yTicks"
                    :key="`yl${t.y}`"
                    x="40"
                    :y="t.y + 4"
                    text-anchor="end"
                  >
                    {{ t.label }}
                  </text>
                  <text
                    v-for="t in chart.xTicks"
                    :key="`xl${t.x}`"
                    :x="t.x"
                    y="202"
                    text-anchor="middle"
                  >
                    {{ t.label }}
                  </text>
                </g>
              </svg>
            </div>
            <p class="text-xs text-muted-foreground">
              Growth is a random process, so this is the honest answer: a curve, not one number.
              Each random tick is an independent roll, which makes the finish time a negative
              binomial rather than a countdown.
            </p>
          </div>

          <!-- Farm layout diagram and comparison. -->
          <div v-if="result.layouts.length" class="flex flex-col gap-3">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Farm layouts, ranked by harvests per hour per block
            </span>
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div
                v-if="diagram"
                class="shrink-0 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              >
                <svg
                  width="126"
                  height="126"
                  viewBox="0 0 126 126"
                  role="img"
                  :aria-label="`Top down diagram of the ${diagram.label} layout`"
                >
                  <rect
                    v-for="cell in diagram.cells"
                    :key="`${cell.x}-${cell.y}`"
                    :x="cell.x * 18 + 1"
                    :y="cell.y * 18 + 1"
                    width="16"
                    height="16"
                    rx="3"
                    :fill="CELL_FILL[cell.kind]"
                    :opacity="cell.kind === 'planted' && diagram.dry ? 0.45 : 0.85"
                  />
                </svg>
                <p class="mt-2 max-w-[9rem] text-xs text-muted-foreground">
                  {{ diagram.label }}
                </p>
              </div>
              <div class="min-w-0 flex-1 overflow-x-auto">
                <table class="w-full min-w-[30rem] border-collapse text-sm">
                  <thead>
                    <tr class="border-b text-left text-xs text-muted-foreground">
                      <th class="py-2 pr-3 font-medium">Layout</th>
                      <th class="py-2 pr-3 text-right font-medium">Speed</th>
                      <th class="py-2 pr-3 text-right font-medium">
                        Average {{ isStem ? "to a grown stem" : "per plant" }}
                      </th>
                      <th class="py-2 pr-3 text-right font-medium">Planted</th>
                      <th class="py-2 text-right font-medium">Per hour per block</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in result.layouts"
                      :key="row.id"
                      :class="row.id === result.layoutId ? 'font-semibold text-primary' : ''"
                    >
                      <td class="py-1.5 pr-3">{{ row.label }}</td>
                      <td class="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {{ row.speed }}
                      </td>
                      <td class="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {{ formatTicks(row.meanTicks, result.version) }}
                      </td>
                      <td class="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {{ Math.round(row.density * 100) }}%
                      </td>
                      <td class="py-1.5 text-right font-mono tabular-nums">
                        {{ fmt(row.yieldPerHourPerBlock, 2) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              The last column is what matters for a real farm: harvests per hour for each block of
              footprint, planted share included. Rows run at double the per-plant speed but plant
              half the ground, so they land in the same place as a solid field. Water channels are
              the trap: water is not farmland, so every channel block subtracts from the growth
              speed of the crops beside it.
              <template v-if="isStem">
                For stems the average column is the time to a fully grown stem, while the per hour
                column also carries the fruit placement roll, since that is what a farm actually
                collects.
              </template>
            </p>
          </div>

          <!-- Bone meal and random tick speed. -->
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Bone meal
              </span>
              <template v-if="result.bonemeal.unsupported">
                <p class="text-sm">Bone meal does nothing to {{ result.plant.label }}.</p>
                <p class="text-xs text-muted-foreground">
                  The block does not implement the bone mealable interface at all, so the item is
                  not even consumed.
                </p>
              </template>
              <template v-else>
                <div class="flex items-baseline gap-2">
                  <span class="font-mono text-2xl tabular-nums">
                    {{ fmt(result.bonemeal.expectedUses, 2) }}
                  </span>
                  <span class="text-sm text-muted-foreground">
                    bone meal on average{{
                      result.model.perBlock ? " per new block" : " from planting to harvest"
                    }}
                  </span>
                </div>
                <p class="text-xs text-muted-foreground">{{ result.bonemeal.effect }}</p>
                <p class="text-xs text-muted-foreground">
                  One bone crafts into 3 bone meal, so that is about
                  {{ fmt(result.bonemeal.expectedUses / 3, 2) }} bones. Compare it against the
                  average wait above before deciding it is worth the skeleton farm.
                </p>
              </template>
            </div>

            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Random tick speed
              </span>
              <div class="max-h-56 overflow-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-xs text-muted-foreground">
                      <th class="py-1 pr-3 font-medium">Speed</th>
                      <th class="py-1 pr-3 text-right font-medium">Average time</th>
                      <th class="py-1 text-right font-medium">Relative</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in result.tickSpeeds"
                      :key="row.randomTickSpeed"
                      :class="
                        row.randomTickSpeed === result.randomTickSpeed
                          ? 'font-semibold text-primary'
                          : ''
                      "
                    >
                      <td class="py-1 pr-3 font-mono tabular-nums">{{ row.randomTickSpeed }}</td>
                      <td class="py-1 pr-3 text-right font-mono tabular-nums">
                        {{ formatTicks(row.meanTicks, result.version) }}
                      </td>
                      <td class="py-1 text-right font-mono tabular-nums">
                        {{ fmt(row.relative, 2) }}x
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-muted-foreground">
                A block gets one draw per point of random tick speed per game tick, each hitting one
                of the 4096 blocks in its chunk section. Growth scales linearly with the game rule,
                and stops entirely outside the server's simulation distance, which is what makes an
                AFK spot matter more than the farm design.
              </p>
            </div>
          </div>

          <!-- Breeding. -->
          <div v-if="breedResult" class="flex flex-col gap-3 rounded-[14px] border p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Breeding {{ breedResult.animal.label.toLowerCase() }}
              </span>
              <span class="text-xs text-muted-foreground">
                Food: {{ breedResult.animal.foods.join(", ") }}
              </span>
            </div>
            <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Breeding cooldown</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ formatTicks(breedResult.cooldownTicks, breedResult.version) }}
                </div>
                <div class="text-xs text-muted-foreground">per parent, after each baby</div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Baby to adult</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ formatTicks(breedResult.babyTicks, breedResult.version) }}
                </div>
                <div class="text-xs text-muted-foreground">unfed</div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Feeds to grow it up</div>
                <div class="font-mono text-lg tabular-nums">{{ breedResult.feedsToAdult }}</div>
                <div class="text-xs text-muted-foreground">
                  plus {{ formatTicks(breedResult.ticksAfterFeeding, breedResult.version) }} of
                  waiting
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Babies per hour</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ fmt(breedResult.babiesPerHour, 1) }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ pairs }} {{ pairs === 1 ? "pair" : "pairs" }}, {{ breedResult.foodPerBaby }}
                  food per baby
                </div>
              </div>
            </div>
            <ul class="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              <li v-for="note in breedResult.notes" :key="note">{{ note }}</li>
            </ul>
          </div>

          <!-- Notes and version changelog. -->
          <div v-if="result.notes.length" class="flex flex-col gap-1">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Notes for this plant
            </span>
            <ul class="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              <li v-for="note in result.notes" :key="note">{{ note }}</li>
            </ul>
          </div>

          <div v-if="changelog.length" class="flex flex-col gap-1">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Version boundaries
            </span>
            <ul class="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              <li v-for="entry in changelog" :key="entry.version + entry.text">
                <span class="font-mono">{{ entry.version }}</span>
                {{ entry.text }}
              </li>
            </ul>
          </div>
        </template>

        <p class="text-xs text-muted-foreground">
          Every constant is read out of decompiled game code for 1.16.5, 1.18.2, 1.20.6, 1.21.1,
          1.21.11, and 26.2, and the predicted age distributions are checked against crop grids
          measured on a real dedicated server. Not an official Minecraft product. Not approved by or
          associated with Mojang or Microsoft.
        </p>
      </section>
    </div>
  </div>
</template>
