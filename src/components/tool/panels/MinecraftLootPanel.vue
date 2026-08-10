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
import CopyButton from "../CopyButton.vue";

/**
 * Split-workbench panel for the loot table calculator: a persistent picker
 * rail on the left (version first, then the searchable grouped table picker,
 * then context controls that adapt to the table's category), live results on
 * the right. Results lead with stat tiles for the headline drop, then the
 * exact per-item table with CSS distribution sparklines and, where
 * tractable, the full per-roll outcome distribution. On narrow screens the
 * rail stacks above the results. State round-trips through the URL fragment
 * so a configured view is shareable.
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

const tableInfo = computed(() => LOOT_TABLES.find((t) => t.id === table.value));
const category = computed(() => tableInfo.value?.cat ?? "Blocks");
const isBlock = computed(() => category.value === "Blocks");
const isMob = computed(() => category.value === "Mobs");
const isFishing = computed(
  () => category.value === "Fishing and gameplay" && table.value.startsWith("gameplay/fishing"),
);
const showCropToggle = computed(
  () => isBlock.value && !!table.value && tableHasCropAge(version.value, table.value),
);

/**
 * Enchantment legality gating: never show an enchantment control the chosen
 * tool item cannot legally hold in vanilla survival. Fortune and Silk Touch
 * are DIGGER-category enchantments in every shipped version: 1.16.5 through
 * 1.20.6 use EnchantmentCategory.DIGGER (instanceof DiggerItem, which
 * includes hoes since 1.16), and 1.21+ use supported_items
 * #minecraft:enchantable/mining_loot = axes + pickaxes + shovels + hoes
 * (verified against mc-pipeline/extracted/<v>/enchantment/*.json and the
 * decompiled tag files). Shears, swords, and the bare hand can never hold
 * them, in any shipped version. Looting is sword-family (WEAPON category,
 * later enchantable/sword and enchantable/melee_weapon); this panel exposes
 * no weapon choice for mobs, so the Looting control is gated on the
 * killed-by-player toggle instead: without a player kill there is no weapon
 * to carry Looting. Hidden controls always contribute level 0 to the engine
 * call, so a stale fragment value can never silently apply.
 */
const MINING_LOOT_TOOLS = new Set(["pickaxe", "shovel", "axe", "hoe"]);
const allowsMiningEnchants = computed(() => isBlock.value && MINING_LOOT_TOOLS.has(tool.value));
const allowsLooting = computed(() => isMob.value && killedByPlayer.value);

const versionSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-version",
  label: "Minecraft version",
  default: LOOT_VERSIONS[LOOT_VERSIONS.length - 1],
  options: LOOT_VERSIONS.map((v) => ({ value: v, label: v, synonyms: [] })),
}));

/** Rail label overrides for the shared grouped spec from tables.ts. */
const GROUP_LABELS: Record<string, { label: string; synonyms: string[] }> = {
  Blocks: { label: "Blocks and ores", synonyms: ["block", "ore", "mining", "crop"] },
  Mobs: { label: "Mobs", synonyms: ["mob", "entity", "kill", "looting"] },
  "Fishing and gameplay": { label: "Fishing", synonyms: ["fishing", "gameplay", "rod"] },
  Chests: { label: "Chests", synonyms: ["chest", "structure", "dungeon", "treasure"] },
};

/**
 * Table picker derived from the chosen version: only tables that exist in
 * that version are offered, grouped by category with searchable synonyms.
 */
const tableSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-table",
  label: "Loot table",
  default: "",
  groups: TABLE_GROUPS.map((g) => ({
    label: GROUP_LABELS[g.label]?.label ?? g.label,
    synonyms: GROUP_LABELS[g.label]?.synonyms ?? g.synonyms,
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
  if (!table.value) {
    result.value = null;
    error.value = null;
    return;
  }
  try {
    result.value = calculate({
      version: version.value,
      table: table.value,
      tool: isMob.value ? "none" : tool.value,
      fortune: allowsMiningEnchants.value ? fortune.value : 0,
      silkTouch: allowsMiningEnchants.value ? silkTouch.value : false,
      looting: allowsLooting.value ? looting.value : 0,
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

/** Headline item for the stat tiles: the highest expected count. */
const topItem = computed(() => {
  const items = result.value?.items ?? [];
  return items.length
    ? items.reduce((best, i) => (i.expected > best.expected ? i : best), items[0])
    : null;
});

const totalExpected = computed(() =>
  (result.value?.items ?? []).reduce((s, i) => s + i.expected, 0),
);

interface StatTile {
  label: string;
  value: string;
  copy?: string;
}

const tiles = computed<StatTile[]>(() => {
  const top = topItem.value;
  const r = result.value;
  if (!top || !r) return [];
  return [
    { label: `${top.name} chance`, value: pct(top.chance), copy: pct(top.chance) },
    { label: `${top.name} avg`, value: avg(top.expected), copy: avg(top.expected) },
    {
      label: `${top.name} range`,
      value: top.min === top.max ? `${top.min}` : `${top.min} to ${top.max}`,
    },
    r.items.length > 1
      ? { label: "Expected items per roll", value: avg(totalExpected.value) }
      : { label: "Possible items", value: String(r.items.length) },
  ];
});

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

// Version-first gating: the table list always derives from the chosen
// version. Switching versions keeps the same table when the new version has
// it; otherwise the selection clears and the results side shows the empty
// state until a table is picked again.
watch(version, (v) => {
  if (table.value && !tableInfo.value?.versions.includes(v)) table.value = "";
});

// When the gate closes (tool switched to one that cannot hold the enchant,
// or killed-by-player turned off), reset the hidden values so the fragment
// and the engine input stay consistent with what is on screen.
watch(allowsMiningEnchants, (allowed) => {
  if (!allowed) {
    fortune.value = 0;
    silkTouch.value = false;
  }
});
watch(allowsLooting, (allowed) => {
  if (!allowed) looting.value = 0;
});

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
    if (!table.value) delete opts.t;
    writeFragment({ opts });
  },
  { deep: false },
);

onMounted(() => {
  const frag = readFragment().opts;
  if (frag.v && LOOT_VERSIONS.includes(frag.v)) version.value = frag.v;
  const fromFrag = frag.t && LOOT_TABLES.find((t) => t.id === frag.t);
  if (fromFrag && fromFrag.versions.includes(version.value)) table.value = fromFrag.id;
  else if (!LOOT_TABLES.find((t) => t.id === table.value)?.versions.includes(version.value)) {
    table.value = "";
  }
  if (frag.tool) tool.value = frag.tool;
  if (frag.f !== undefined) fortune.value = Math.min(3, Math.max(0, Number(frag.f) || 0));
  if (frag.st !== undefined) silkTouch.value = frag.st === "1";
  if (frag.l !== undefined) looting.value = Math.min(3, Math.max(0, Number(frag.l) || 0));
  if (frag.kbp !== undefined) killedByPlayer.value = frag.kbp !== "0";
  if (frag.lots !== undefined)
    luckOfTheSea.value = Math.min(3, Math.max(0, Number(frag.lots) || 0));
  if (frag.ow !== undefined) openWater.value = frag.ow !== "0";
  if (frag.cm !== undefined) cropMature.value = frag.cm !== "0";
  // Clamp restored values against the enchantment gate: a shared URL with
  // fortune on shears (or looting without a player kill) restores clean.
  if (!allowsMiningEnchants.value) {
    fortune.value = 0;
    silkTouch.value = false;
  }
  if (!allowsLooting.value) looting.value = 0;
  mounted.value = true;
  recompute();
});
</script>

<template>
  <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <!-- Picker rail: version first, then the table, then context. -->
      <aside
        aria-label="Loot table and context"
        class="flex flex-col gap-4 lg:border-r lg:border-border lg:pr-6"
      >
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

        <template v-if="table">
          <div class="h-px bg-border" role="presentation" />

          <template v-if="isBlock">
            <OptionControl
              :spec="toolSpec"
              :model-value="tool"
              @update:model-value="tool = String($event)"
            />
            <OptionControl
              v-if="allowsMiningEnchants"
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
            <OptionControl
              v-if="allowsMiningEnchants"
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
            <OptionControl
              :spec="{
                kind: 'boolean',
                id: 'mc-kbp',
                label: 'Killed by a player',
                default: true,
              }"
              :model-value="killedByPlayer"
              @update:model-value="killedByPlayer = Boolean($event)"
            />
            <OptionControl
              v-if="allowsLooting"
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
          </template>

          <template v-if="isFishing">
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
            <OptionControl
              :spec="{ kind: 'boolean', id: 'mc-open', label: 'Open water', default: true }"
              :model-value="openWater"
              @update:model-value="openWater = Boolean($event)"
            />
          </template>
        </template>
      </aside>

      <!-- Live results. -->
      <section class="flex min-w-0 flex-col gap-5" aria-live="polite">
        <div
          v-if="!table"
          class="flex flex-col items-center gap-1 rounded-[10px] bg-secondary px-4 py-10 text-center shadow-[var(--sh-inset)]"
        >
          <p class="text-sm font-medium">Pick a loot table to see its exact odds</p>
          <p class="max-w-md text-xs text-muted-foreground">
            The list shows every block, mob, fishing, and chest table that exists in Minecraft
            {{ version }}. Search by name or by what it drops, like "flint" or "ender pearl".
          </p>
        </div>

        <div
          v-else-if="error"
          class="rounded-[10px] bg-secondary px-4 py-3 text-sm shadow-[var(--sh-inset)]"
          role="alert"
        >
          <p class="font-medium">{{ error.message }}</p>
          <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
        </div>

        <template v-else-if="result">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="text-sm font-semibold">{{ result.tableName }}</h2>
            <span class="text-xs text-muted-foreground">
              {{ result.category }} · Minecraft {{ result.version }}
            </span>
          </div>

          <div
            v-if="!result.items.length"
            class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
          >
            Nothing drops with this context. Try a different tool or enchantment.
          </div>

          <template v-else>
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
                </div>
                <CopyButton v-if="tile.copy" :text="tile.copy" class="-mr-1.5 shrink-0" />
              </div>
            </div>

            <div class="overflow-x-auto">
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
                  <tr
                    v-for="item in sortedItems"
                    :key="item.item"
                    class="border-b border-border/60"
                  >
                    <td class="py-2 pr-3 font-medium">{{ item.name }}</td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ pct(item.chance) }}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ avg(item.expected) }}
                    </td>
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

            <div v-if="result.outcomes" class="flex flex-col gap-2">
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
                v-if="result.outcomes.length > OUTCOME_PREVIEW"
                type="button"
                class="w-fit text-xs text-primary hover:underline"
                @click="showAllOutcomes = !showAllOutcomes"
              >
                {{ showAllOutcomes ? "Show fewer" : `Show all ${result.outcomes.length} outcomes` }}
              </button>
            </div>
            <p v-else class="text-xs text-muted-foreground">
              This table has too many possible outcomes to list individually; the per item
              statistics above are still exact.
            </p>
          </template>

          <ul v-if="result.notes.length" class="flex flex-col gap-1 text-xs text-muted-foreground">
            <li v-for="note in result.notes" :key="note">{{ note }}</li>
          </ul>

          <p class="text-xs text-muted-foreground">
            Computed from the loot table data inside Minecraft {{ result.version }} and validated
            against real server measurements. Not an official Minecraft product. Not approved by or
            associated with Mojang or Microsoft.
          </p>
        </template>
      </section>
    </div>
  </div>
</template>
