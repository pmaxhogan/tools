<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import {
  calculate,
  tableHasCropAge,
  type LootCalcResult,
} from "@/tools/minecraft-loot-table-calculator/index";
import {
  LOOT_TABLES,
  LOOT_VERSIONS,
  TABLE_GROUPS,
} from "@/tools/minecraft-loot-table-calculator/tables";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the loot table calculator: version + searchable table
 * picker, context controls that adapt to the table's category, and a results
 * table with exact probabilities, expected counts, and CSS sparklines of the
 * full count distribution. State round-trips through the URL fragment so a
 * configured view is shareable.
 */
defineProps<{ meta: ToolMeta }>();

const version = ref(LOOT_VERSIONS[LOOT_VERSIONS.length - 1]);
const table = ref("blocks/diamond_ore");
const tool = ref("pickaxe");
const fortune = ref(0);
const silkTouch = ref(false);
const looting = ref(0);
const killedByPlayer = ref(true);
const luckOfTheSea = ref(0);
const openWater = ref(true);
const cropMature = ref(true);
const mounted = ref(false);

type SortKey = "name" | "chance" | "expected";
const sortKey = ref<SortKey>("expected");
const sortDesc = ref(true);
const showAllOutcomes = ref(false);

const category = computed(() => LOOT_TABLES.find((t) => t.id === table.value)?.cat ?? "Blocks");
const isBlock = computed(() => category.value === "Blocks");
const isMob = computed(() => category.value === "Mobs");
const isFishing = computed(
  () => category.value === "Fishing and gameplay" && table.value.startsWith("gameplay/fishing"),
);
const showCropToggle = computed(() => isBlock.value && tableHasCropAge(version.value, table.value));

const versionSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-version",
  label: "Minecraft version",
  default: LOOT_VERSIONS[LOOT_VERSIONS.length - 1],
  options: LOOT_VERSIONS.map((v) => ({ value: v, label: v, synonyms: [] })),
}));

/** Table picker limited to tables that exist in the selected version. */
const tableSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-table",
  label: "Loot table",
  default: "blocks/diamond_ore",
  groups: TABLE_GROUPS.map((g) => ({
    ...g,
    options: (g.options ?? []).filter((o) =>
      LOOT_TABLES.some((t) => t.id === o.value && t.versions.includes(version.value)),
    ),
  })).filter((g) => g.options.length),
}));

const toolSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-tool",
  label: "Tool",
  default: "pickaxe",
  options: [
    { value: "pickaxe", label: "Pickaxe", synonyms: [] },
    { value: "shovel", label: "Shovel", synonyms: [] },
    { value: "axe", label: "Axe", synonyms: [] },
    { value: "hoe", label: "Hoe", synonyms: [] },
    { value: "sword", label: "Sword", synonyms: [] },
    { value: "shears", label: "Shears", synonyms: [] },
    { value: "none", label: "Bare hand", synonyms: ["fist", "no tool"] },
  ],
}));

const result = ref<LootCalcResult | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

function recompute() {
  try {
    result.value = calculate({
      version: version.value,
      table: table.value,
      tool: isMob.value ? "none" : tool.value,
      fortune: fortune.value,
      silkTouch: silkTouch.value,
      looting: looting.value,
      killedByPlayer: killedByPlayer.value,
      luckOfTheSea: luckOfTheSea.value,
      openWater: openWater.value,
      cropMature: cropMature.value,
    });
    error.value = null;
  } catch (e) {
    result.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: String((e as Error).message ?? e) };
  }
}

const sortedItems = computed(() => {
  const items = [...(result.value?.items ?? [])];
  const dir = sortDesc.value ? -1 : 1;
  items.sort((a, b) => {
    if (sortKey.value === "name") return dir * a.name.localeCompare(b.name);
    return dir * (a[sortKey.value] - b[sortKey.value]);
  });
  return items;
});

function setSort(key: SortKey) {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value;
  else {
    sortKey.value = key;
    sortDesc.value = key !== "name";
  }
}

const OUTCOME_PREVIEW = 25;
const visibleOutcomes = computed(() => {
  const all = result.value?.outcomes ?? [];
  return showAllOutcomes.value ? all : all.slice(0, OUTCOME_PREVIEW);
});
const maxOutcomeP = computed(() =>
  Math.max(...(result.value?.outcomes ?? []).map((o) => o.p), 1e-9),
);

function pct(p: number): string {
  if (p >= 0.9995) return "100%";
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(2)}%`;
  return `${(p * 100).toPrecision(2)}%`;
}

function avg(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

/** "minecraft:wheat_seeds:3" -> "3 x Wheat Seeds" (readable outcome label). */
function outcomeLabel(items: Record<string, number>): string {
  const parts = Object.entries(items)
    .sort()
    .map(([id, count]) => `${count} x ${displayName(id)}`);
  return parts.length ? parts.join(", ") : "Nothing";
}

function displayName(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Sparkline bars: [count, probability] pairs, capped so rows stay compact. */
const SPARK_CAP = 16;
function sparkBars(dist: Array<[number, number]>): Array<{ count: number; p: number; h: number }> {
  const bars = dist.filter(([, p]) => p > 1e-9);
  if (!bars.length || bars.length > SPARK_CAP) return [];
  const max = Math.max(...bars.map(([, p]) => p));
  return bars.map(([count, p]) => ({ count, p, h: Math.max(8, Math.round((p / max) * 100)) }));
}

// -------------------------------------------------------- fragment state --
const DEFAULTS: Record<string, string> = {
  v: LOOT_VERSIONS[LOOT_VERSIONS.length - 1],
  t: "blocks/diamond_ore",
  tool: "pickaxe",
  f: "0",
  st: "0",
  l: "0",
  kbp: "1",
  lots: "0",
  ow: "1",
  cm: "1",
};

watch(
  [
    version,
    table,
    tool,
    fortune,
    silkTouch,
    looting,
    killedByPlayer,
    luckOfTheSea,
    openWater,
    cropMature,
  ],
  () => {
    recompute();
    if (!mounted.value) return;
    const state: Record<string, string> = {
      v: version.value,
      t: table.value,
      tool: tool.value,
      f: String(fortune.value),
      st: silkTouch.value ? "1" : "0",
      l: String(looting.value),
      kbp: killedByPlayer.value ? "1" : "0",
      lots: String(luckOfTheSea.value),
      ow: openWater.value ? "1" : "0",
      cm: cropMature.value ? "1" : "0",
    };
    const opts: Record<string, string> = {};
    for (const [k, val] of Object.entries(state)) if (val !== DEFAULTS[k]) opts[k] = val;
    writeFragment({ opts });
  },
  { deep: false },
);

onMounted(() => {
  const frag = readFragment().opts;
  if (frag.v && LOOT_VERSIONS.includes(frag.v)) version.value = frag.v;
  if (frag.t && LOOT_TABLES.some((t) => t.id === frag.t)) table.value = frag.t;
  if (frag.tool) tool.value = frag.tool;
  if (frag.f !== undefined) fortune.value = Math.min(3, Math.max(0, Number(frag.f) || 0));
  if (frag.st !== undefined) silkTouch.value = frag.st === "1";
  if (frag.l !== undefined) looting.value = Math.min(3, Math.max(0, Number(frag.l) || 0));
  if (frag.kbp !== undefined) killedByPlayer.value = frag.kbp !== "0";
  if (frag.lots !== undefined)
    luckOfTheSea.value = Math.min(3, Math.max(0, Number(frag.lots) || 0));
  if (frag.ow !== undefined) openWater.value = frag.ow !== "0";
  if (frag.cm !== undefined) cropMature.value = frag.cm !== "0";
  mounted.value = true;
  recompute();
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <OptionControl
        :spec="versionSpec"
        :model-value="version"
        @update:model-value="version = String($event)"
      />
      <OptionControl
        :spec="tableSpec"
        :model-value="table"
        @update:model-value="table = String($event)"
      />
    </div>

    <div class="flex flex-wrap items-end gap-x-5 gap-y-3">
      <template v-if="isBlock">
        <div class="w-36">
          <OptionControl
            :spec="toolSpec"
            :model-value="tool"
            @update:model-value="tool = String($event)"
          />
        </div>
        <div class="w-28">
          <OptionControl
            :spec="{
              kind: 'number',
              id: 'mc-fortune',
              label: 'Fortune',
              default: 0,
              min: 0,
              max: 3,
              step: 1,
            }"
            :model-value="fortune"
            @update:model-value="fortune = Number($event)"
          />
        </div>
        <OptionControl
          :spec="{ kind: 'boolean', id: 'mc-silk', label: 'Silk Touch', default: false }"
          :model-value="silkTouch"
          @update:model-value="silkTouch = Boolean($event)"
        />
        <OptionControl
          v-if="showCropToggle"
          :spec="{ kind: 'boolean', id: 'mc-mature', label: 'Fully grown', default: true }"
          :model-value="cropMature"
          @update:model-value="cropMature = Boolean($event)"
        />
      </template>

      <template v-if="isMob">
        <div class="w-28">
          <OptionControl
            :spec="{
              kind: 'number',
              id: 'mc-looting',
              label: 'Looting',
              default: 0,
              min: 0,
              max: 3,
              step: 1,
            }"
            :model-value="looting"
            @update:model-value="looting = Number($event)"
          />
        </div>
        <OptionControl
          :spec="{ kind: 'boolean', id: 'mc-kbp', label: 'Killed by a player', default: true }"
          :model-value="killedByPlayer"
          @update:model-value="killedByPlayer = Boolean($event)"
        />
      </template>

      <template v-if="isFishing">
        <div class="w-36">
          <OptionControl
            :spec="{
              kind: 'number',
              id: 'mc-lots',
              label: 'Luck of the Sea',
              default: 0,
              min: 0,
              max: 3,
              step: 1,
            }"
            :model-value="luckOfTheSea"
            @update:model-value="luckOfTheSea = Number($event)"
          />
        </div>
        <OptionControl
          :spec="{ kind: 'boolean', id: 'mc-open', label: 'Open water', default: true }"
          :model-value="openWater"
          @update:model-value="openWater = Boolean($event)"
        />
      </template>
    </div>

    <div
      v-if="error"
      class="rounded-[10px] bg-secondary px-4 py-3 text-sm shadow-[var(--sh-inset)]"
    >
      <p class="font-medium">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <template v-else-if="result">
      <div
        v-if="!result.items.length"
        class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      >
        Nothing drops with this context. Try a different tool or enchantment.
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[32rem] border-collapse text-sm">
          <thead>
            <tr class="border-b text-left text-xs text-muted-foreground">
              <th class="py-2 pr-3 font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-foreground"
                  @click="setSort('name')"
                >
                  Item
                  <component
                    :is="sortDesc ? ArrowDown : ArrowUp"
                    v-if="sortKey === 'name'"
                    class="size-3"
                    aria-hidden="true"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 text-right font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-foreground"
                  @click="setSort('chance')"
                >
                  Drop chance
                  <component
                    :is="sortDesc ? ArrowDown : ArrowUp"
                    v-if="sortKey === 'chance'"
                    class="size-3"
                    aria-hidden="true"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 text-right font-medium">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-foreground"
                  @click="setSort('expected')"
                >
                  Avg count
                  <component
                    :is="sortDesc ? ArrowDown : ArrowUp"
                    v-if="sortKey === 'expected'"
                    class="size-3"
                    aria-hidden="true"
                  />
                </button>
              </th>
              <th class="py-2 pr-3 text-right font-medium">Range</th>
              <th class="py-2 font-medium">Distribution</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in sortedItems" :key="item.item" class="border-b border-border/60">
              <td class="py-2 pr-3 font-medium">{{ item.name }}</td>
              <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ pct(item.chance) }}</td>
              <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ avg(item.expected) }}</td>
              <td class="py-2 pr-3 text-right font-mono tabular-nums">
                {{ item.min === item.max ? item.min : `${item.min}-${item.max}` }}
              </td>
              <td class="py-2">
                <div
                  v-if="sparkBars(item.dist).length"
                  class="flex h-6 items-end gap-px"
                  role="img"
                  :aria-label="`Count distribution for ${item.name}`"
                >
                  <div
                    v-for="bar in sparkBars(item.dist)"
                    :key="bar.count"
                    class="w-1.5 rounded-t-[2px] bg-primary/70"
                    :style="{ height: `${bar.h}%` }"
                    :title="`${bar.count}: ${pct(bar.p)}`"
                  />
                </div>
                <span v-else class="text-xs text-muted-foreground">wide</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="result.outcomes && result.items.length" class="flex flex-col gap-2">
        <h3 class="text-sm font-medium">
          Exact outcomes per
          {{ category === "Mobs" ? "kill" : category === "Blocks" ? "block" : "roll" }}
        </h3>
        <ul class="flex flex-col gap-1">
          <li
            v-for="outcome in visibleOutcomes"
            :key="outcome.key"
            class="flex items-center gap-3 text-sm"
          >
            <span class="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
              {{ pct(outcome.p) }}
            </span>
            <div class="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-secondary">
              <div
                class="h-full rounded-full bg-[image:var(--grad-brand)]"
                :style="{ width: `${Math.max(2, (outcome.p / maxOutcomeP) * 100)}%` }"
              />
            </div>
            <span class="min-w-0 truncate text-muted-foreground">
              {{ outcomeLabel(outcome.items) }}
            </span>
          </li>
        </ul>
        <button
          v-if="(result.outcomes.length ?? 0) > OUTCOME_PREVIEW"
          type="button"
          class="w-fit text-xs text-primary hover:underline"
          @click="showAllOutcomes = !showAllOutcomes"
        >
          {{ showAllOutcomes ? "Show fewer" : `Show all ${result.outcomes.length} outcomes` }}
        </button>
      </div>
      <p v-else-if="result.items.length" class="text-xs text-muted-foreground">
        This table has too many possible outcomes to list individually; the per item statistics
        above are still exact.
      </p>

      <ul v-if="result.notes.length" class="flex flex-col gap-1 text-xs text-muted-foreground">
        <li v-for="note in result.notes" :key="note">{{ note }}</li>
      </ul>

      <p class="text-xs text-muted-foreground">
        Computed from the loot table data inside Minecraft {{ result.version }} and validated
        against real server measurements. Not an official Minecraft product. Not approved by or
        associated with Mojang or Microsoft.
      </p>
    </template>
  </div>
</template>
