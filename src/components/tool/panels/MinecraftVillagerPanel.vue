<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { readFragment, writeFragment } from "@/lib/fragment";
import {
  PROFESSION_INFO,
  calculate,
  professionsFor,
  type PricedTrade,
  type VillagerResult,
} from "@/tools/minecraft-villager-trade-calculator/index";
import { VILLAGER_VERSIONS } from "@/tools/minecraft-villager-trade-calculator/data";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Workbench panel for the villager trade and discount calculator. The rail on
 * the left is the villager: version first, because it gates both the trade
 * pool and how far cure discounts stack, then profession, level, and the
 * searchable grouped trade picker. The rail below it is the player's standing
 * with that villager. The right side prices the selection live: stat tiles
 * for the headline numbers, the full level pool priced side by side, the
 * gossip ledger with its decay clock, and the restock and demand model.
 * State round-trips through the URL fragment so a configured answer is
 * shareable.
 */
defineProps<{ meta: ToolMeta }>();

const LATEST = VILLAGER_VERSIONS[VILLAGER_VERSIONS.length - 1];

const version = ref(LATEST);
const profession = ref("librarian");
const level = ref(1);
const tradeIndex = ref(0);
const cures = ref(0);
const heroLevel = ref(0);
const tradesMade = ref(0);
const hurts = ref(0);
const kills = ref(0);
const daysElapsed = ref(0);
const usesPerRestock = ref(0);
const restocks = ref(0);
const rolledPrice = ref(0);
const mounted = ref(false);
/** True once the fragment restore has fully settled, so resets stop firing. */
const ready = ref(false);

const result = ref<VillagerResult | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const versionSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcv-version",
  label: "Minecraft version",
  default: LATEST,
  options: VILLAGER_VERSIONS.map((v) => ({ value: v, label: v, synonyms: [] })),
}));

const professionSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcv-profession",
  label: "Profession",
  default: "librarian",
  options: professionsFor(version.value).map((p) => ({
    value: p,
    label: PROFESSION_INFO[p]?.name ?? p,
    synonyms: [PROFESSION_INFO[p]?.station ?? ""].filter(Boolean),
  })),
}));

const levelSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcv-level",
  label: "Villager level",
  default: "1",
  options: [
    { value: "1", label: "1 Novice", synonyms: ["novice", "first"] },
    { value: "2", label: "2 Apprentice", synonyms: ["apprentice"] },
    { value: "3", label: "3 Journeyman", synonyms: ["journeyman"] },
    { value: "4", label: "4 Expert", synonyms: ["expert"] },
    { value: "5", label: "5 Master", synonyms: ["master", "last"] },
  ],
}));

/**
 * Trade picker grouped by direction, which is the split players think in:
 * trades where you hand over emeralds, and trades where you earn them.
 */
const tradeSpec = computed<SelectOptionSpec>(() => {
  const trades = result.value?.trades ?? [];
  const buy = trades.filter((t) => t.wants === "emerald");
  const sell = trades.filter((t) => t.wants !== "emerald");
  const toOption = (t: PricedTrade) => ({
    value: String(t.index),
    label: t.label,
    synonyms: [
      t.gives,
      t.wants,
      t.givesName,
      t.wantsName,
      ...(t.secondary ? [t.secondary.name] : []),
    ],
  });
  const groups = [];
  if (buy.length) {
    groups.push({
      label: "You pay emeralds",
      synonyms: ["buy", "emerald", "sell to me", "purchase"],
      options: buy.map(toOption),
    });
  }
  if (sell.length) {
    groups.push({
      label: "You earn emeralds",
      synonyms: ["sell", "income", "emerald farm"],
      options: sell.map(toOption),
    });
  }
  return { kind: "select", id: "mcv-trade", label: "Trade", default: "0", groups };
});

/**
 * The rolled price control only makes sense for trades whose cost is rolled
 * when the villager first offers it. Fixed price trades get no control, and
 * the value is reset so a stale fragment can never silently reprice one.
 */
const isRolled = computed(
  () =>
    result.value?.selected?.variable === "book" || result.value?.selected?.variable === "enchanted",
);
const rolledRange = computed(() => {
  const selected = result.value?.selected;
  if (!selected) return { min: 1, max: 64 };
  return { min: selected.baseMin, max: selected.baseMax };
});

function recompute() {
  try {
    result.value = calculate({
      version: version.value,
      profession: profession.value,
      level: level.value,
      tradeIndex: tradeIndex.value,
      heroLevel: heroLevel.value,
      cures: cures.value,
      tradesMade: tradesMade.value,
      hurts: hurts.value,
      kills: kills.value,
      daysElapsed: daysElapsed.value,
      usesPerRestock: usesPerRestock.value,
      restocks: restocks.value,
      rolledPrice: rolledPrice.value > 0 ? rolledPrice.value : undefined,
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

interface StatTile {
  label: string;
  value: string;
  hint?: string;
  copy?: string;
}

const tiles = computed<StatTile[]>(() => {
  const r = result.value;
  const selected = r?.selected;
  if (!r || !selected) return [];
  const price = priceLabel(selected);
  const base =
    selected.baseMin === selected.baseMax
      ? `${selected.baseMin}`
      : `${selected.baseMin} to ${selected.baseMax}`;
  const saved =
    selected.savedMin === selected.savedMax
      ? `${selected.savedMin}`
      : `${selected.savedMin} to ${selected.savedMax}`;
  const out: StatTile[] = [
    { label: `${selected.wantsName} you pay`, value: price, hint: `base ${base}`, copy: price },
    {
      label: "Saved per trade",
      value: saved,
      hint: selected.discountable ? "" : "no discount possible",
    },
    {
      label: "Reputation",
      value: String(r.reputation),
      hint: `x ${selected.priceMultiplier} multiplier`,
    },
    {
      label: "Uses per restock",
      value: String(selected.maxUses),
      hint: `${r.restock.usesPerDay} per day at full restocks`,
    },
  ];
  if (r.mending) {
    out.push({
      label: "Cures for 1 emerald",
      value: r.mending.curesNeeded === null ? "not reachable" : String(r.mending.curesNeeded),
      hint: r.mending.curesNeeded === null ? `floor is ${r.mending.bestCureOnlyPrice}` : "",
    });
  }
  return out;
});

function priceLabel(trade: PricedTrade): string {
  return trade.priceMin === trade.priceMax
    ? `${trade.priceMin}`
    : `${trade.priceMin} to ${trade.priceMax}`;
}

function baseLabel(trade: PricedTrade): string {
  return trade.baseMin === trade.baseMax
    ? `${trade.baseMin}`
    : `${trade.baseMin} to ${trade.baseMax}`;
}

const shareText = computed(() => {
  const r = result.value;
  const s = r?.selected;
  if (!r || !s) return "";
  const lines = [
    `${r.professionName} level ${r.level} (${r.levelName}), Minecraft ${r.version}`,
    `${s.label}`,
    `Price after discounts: ${priceLabel(s)} ${s.wantsName} (base ${baseLabel(s)})`,
    `Reputation ${r.reputation}, Hero of the Village ${r.heroLevel || "none"}, demand ${r.demand}`,
  ];
  if (r.mending) lines.push(r.mending.explanation);
  return lines.join("\n");
});

// -------------------------------------------------------- fragment state --
const DEFAULTS: Record<string, string> = {
  v: LATEST,
  p: "librarian",
  l: "1",
  t: "0",
  hero: "0",
  c: "0",
  tm: "0",
  h: "0",
  k: "0",
  d: "0",
  u: "0",
  r: "0",
  rp: "0",
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

// Version first: switching versions keeps the profession when it still exists
// and always resets the trade selection, because pool indexes are not stable
// across versions. These resets are gated on `ready`, which only flips a tick
// after the fragment restore, so a shared link that sets version, profession,
// level and trade in one pass does not wipe its own trade selection when the
// watcher queue flushes.
watch(version, (v) => {
  if (!professionsFor(v).includes(profession.value)) profession.value = professionsFor(v)[0];
  if (!ready.value) return;
  tradeIndex.value = 0;
  rolledPrice.value = 0;
});
watch([profession, level], () => {
  if (!ready.value) return;
  tradeIndex.value = 0;
  rolledPrice.value = 0;
});
watch(isRolled, (rolled) => {
  if (ready.value && !rolled) rolledPrice.value = 0;
});

watch(
  [
    version,
    profession,
    level,
    tradeIndex,
    cures,
    heroLevel,
    tradesMade,
    hurts,
    kills,
    daysElapsed,
    usesPerRestock,
    restocks,
    rolledPrice,
  ],
  () => {
    recompute();
    if (!mounted.value) return;
    const state: Record<string, string> = {
      v: version.value,
      p: profession.value,
      l: String(level.value),
      t: String(tradeIndex.value),
      hero: String(heroLevel.value),
      c: String(cures.value),
      tm: String(tradesMade.value),
      h: String(hurts.value),
      k: String(kills.value),
      d: String(daysElapsed.value),
      u: String(usesPerRestock.value),
      r: String(restocks.value),
      rp: String(rolledPrice.value),
    };
    const opts: Record<string, string> = {};
    for (const [k, val] of Object.entries(state)) if (val !== DEFAULTS[k]) opts[k] = val;
    writeFragment({ opts });
  },
  { deep: false },
);

onMounted(() => {
  const frag = readFragment().opts;
  if (frag.v && VILLAGER_VERSIONS.includes(frag.v)) version.value = frag.v;
  if (frag.p && professionsFor(version.value).includes(frag.p)) profession.value = frag.p;
  if (frag.l !== undefined) level.value = clamp(Math.round(Number(frag.l) || 1), 1, 5);
  if (frag.t !== undefined) tradeIndex.value = Math.max(0, Math.round(Number(frag.t) || 0));
  if (frag.hero !== undefined) heroLevel.value = clamp(Math.round(Number(frag.hero) || 0), 0, 5);
  if (frag.c !== undefined) cures.value = clamp(Math.round(Number(frag.c) || 0), 0, 20);
  if (frag.tm !== undefined) tradesMade.value = clamp(Math.round(Number(frag.tm) || 0), 0, 64);
  if (frag.h !== undefined) hurts.value = clamp(Math.round(Number(frag.h) || 0), 0, 20);
  if (frag.k !== undefined) kills.value = clamp(Math.round(Number(frag.k) || 0), 0, 20);
  if (frag.d !== undefined) daysElapsed.value = clamp(Math.round(Number(frag.d) || 0), 0, 90);
  if (frag.u !== undefined) usesPerRestock.value = clamp(Math.round(Number(frag.u) || 0), 0, 64);
  if (frag.r !== undefined) restocks.value = clamp(Math.round(Number(frag.r) || 0), 0, 60);
  recompute();
  // A shared link can only carry a rolled price for a trade that rolls one,
  // and only inside that trade's real range.
  if (frag.rp !== undefined && isRolled.value) {
    const raw = Math.round(Number(frag.rp) || 0);
    rolledPrice.value = raw > 0 ? clamp(raw, rolledRange.value.min, rolledRange.value.max) : 0;
  }
  if (tradeIndex.value >= (result.value?.trades.length ?? 0)) tradeIndex.value = 0;
  mounted.value = true;
  recompute();
  void nextTick(() => {
    ready.value = true;
  });
});
</script>

<template>
  <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <!-- The villager, then the player's standing with it. -->
      <aside
        aria-label="Villager and reputation"
        class="flex flex-col gap-4 lg:border-r lg:border-border lg:pr-6"
      >
        <OptionControl
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="version = String($event)"
        />
        <OptionControl
          :spec="professionSpec"
          :model-value="profession"
          @update:model-value="profession = String($event)"
        />
        <OptionControl
          :spec="levelSpec"
          :model-value="String(level)"
          @update:model-value="level = Number($event)"
        />
        <OptionControl
          v-if="result && result.trades.length"
          :spec="tradeSpec"
          :model-value="String(tradeIndex)"
          @update:model-value="tradeIndex = Number($event)"
        />
        <OptionControl
          v-if="isRolled"
          :spec="{
            kind: 'number',
            id: 'mcv-rolled',
            label: `Rolled price (${rolledRange.min} to ${rolledRange.max}, 0 for the whole range)`,
            default: 0,
            min: 0,
            max: rolledRange.max,
            step: 1,
          }"
          :model-value="rolledPrice"
          @update:model-value="rolledPrice = Number($event)"
        />

        <div class="h-px bg-border" role="presentation" />
        <p class="text-xs font-medium text-muted-foreground">Your standing</p>

        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-cures',
            label: 'Zombie cures',
            default: 0,
            min: 0,
            max: 20,
            step: 1,
          }"
          :model-value="cures"
          @update:model-value="cures = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-hero',
            label: 'Hero of the Village level (0 for none)',
            default: 0,
            min: 0,
            max: 5,
            step: 1,
          }"
          :model-value="heroLevel"
          @update:model-value="heroLevel = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-trades',
            label: 'Trades already made',
            default: 0,
            min: 0,
            max: 64,
            step: 1,
          }"
          :model-value="tradesMade"
          @update:model-value="tradesMade = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-hurts',
            label: 'Villagers hurt',
            default: 0,
            min: 0,
            max: 20,
            step: 1,
          }"
          :model-value="hurts"
          @update:model-value="hurts = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-kills',
            label: 'Villagers killed',
            default: 0,
            min: 0,
            max: 20,
            step: 1,
          }"
          :model-value="kills"
          @update:model-value="kills = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-days',
            label: 'Days since you earned it',
            default: 0,
            min: 0,
            max: 90,
            step: 1,
          }"
          :model-value="daysElapsed"
          @update:model-value="daysElapsed = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-uses',
            label: 'Uses between restocks',
            default: 0,
            min: 0,
            max: 64,
            step: 1,
          }"
          :model-value="usesPerRestock"
          @update:model-value="usesPerRestock = Number($event)"
        />
        <OptionControl
          :spec="{
            kind: 'number',
            id: 'mcv-restocks',
            label: 'Restocks so far',
            default: 0,
            min: 0,
            max: 60,
            step: 1,
          }"
          :model-value="restocks"
          @update:model-value="restocks = Number($event)"
        />
      </aside>

      <!-- Live results. -->
      <section class="flex min-w-0 flex-col gap-5" aria-live="polite">
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
            <h2 class="text-sm font-semibold">
              {{ result.professionName }} level {{ result.level }} ({{ result.levelName }})
            </h2>
            <span class="text-xs text-muted-foreground">
              {{ result.station }} · Minecraft {{ result.version }} · rolls {{ result.offered }} of
              these trades
            </span>
          </div>

          <div
            v-if="!result.trades.length"
            class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
          >
            This profession has no trades at this level in Minecraft {{ result.version }}.
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
                  <div v-if="tile.hint" class="truncate text-xs text-muted-foreground">
                    {{ tile.hint }}
                  </div>
                </div>
                <CopyButton v-if="tile.copy" :text="tile.copy" class="-mr-1.5 shrink-0" />
              </div>
            </div>

            <!-- The one emerald book answer. -->
            <div
              v-if="result.mending"
              class="rounded-[10px] border border-[color:var(--brand-hairline)] bg-[image:var(--grad-brand-soft)] px-4 py-3"
            >
              <h3 class="text-sm font-medium">Curing this villager</h3>
              <p class="mt-1 text-sm">{{ result.mending.explanation }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Cures stop helping after {{ result.mending.curesUntilCapped }} in Minecraft
                {{ result.version }}, where the best price curing alone can reach is
                {{ result.mending.bestCureOnlyPrice }}. With Hero of the Village V the floor is
                {{ result.mending.bestPriceWithHero }}.
              </p>
            </div>

            <!-- The whole level pool, priced. -->
            <div class="overflow-x-auto">
              <table class="w-full min-w-[34rem] border-collapse text-sm">
                <caption class="sr-only">
                  Every trade this profession offers at level
                  {{
                    result.level
                  }}
                </caption>
                <thead>
                  <tr class="border-b text-left text-xs text-muted-foreground">
                    <th class="py-2 pr-3 font-medium">Trade</th>
                    <th class="py-2 pr-3 text-right font-medium">Base</th>
                    <th class="py-2 pr-3 text-right font-medium">You pay</th>
                    <th class="py-2 pr-3 text-right font-medium">Uses</th>
                    <th class="py-2 text-right font-medium">XP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="trade in result.trades"
                    :key="trade.index"
                    class="cursor-pointer border-b border-border/60 hover:bg-accent"
                    :class="trade.index === tradeIndex ? 'bg-accent' : undefined"
                    @click="tradeIndex = trade.index"
                  >
                    <td class="py-2 pr-3">
                      <button
                        type="button"
                        class="text-left font-medium hover:text-primary"
                        :aria-pressed="trade.index === tradeIndex"
                        @click.stop="tradeIndex = trade.index"
                      >
                        {{ trade.label }}
                      </button>
                      <span v-if="trade.biomes.length" class="ml-2 text-xs text-muted-foreground">
                        {{ trade.biomes.join(", ") }} only
                      </span>
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {{ baseLabel(trade) }}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ priceLabel(trade) }}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ trade.maxUses }}</td>
                    <td class="py-2 text-right font-mono tabular-nums">{{ trade.xp }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Gossip ledger. -->
            <div class="flex flex-col gap-2">
              <h3 class="text-sm font-medium">Reputation ledger</h3>
              <div class="overflow-x-auto">
                <table class="w-full min-w-[30rem] border-collapse text-sm">
                  <thead>
                    <tr class="border-b text-left text-xs text-muted-foreground">
                      <th class="py-2 pr-3 font-medium">Gossip</th>
                      <th class="py-2 pr-3 text-right font-medium">Stored</th>
                      <th class="py-2 pr-3 text-right font-medium">Weight</th>
                      <th class="py-2 pr-3 text-right font-medium">Points</th>
                      <th class="py-2 text-right font-medium">Lasts</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="line in result.gossip"
                      :key="line.type"
                      class="border-b border-border/60"
                    >
                      <td class="py-2 pr-3">{{ line.label }}</td>
                      <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ line.value }}</td>
                      <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ line.weight }}</td>
                      <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ line.points }}</td>
                      <td class="py-2 text-right font-mono tabular-nums">
                        <template v-if="line.value === 0">-</template>
                        <template v-else-if="line.daysRemaining === null">never decays</template>
                        <template v-else>{{ line.daysRemaining }} days</template>
                      </td>
                    </tr>
                    <tr>
                      <td class="py-2 pr-3 text-sm font-medium">Reputation</td>
                      <td colspan="2"></td>
                      <td class="py-2 pr-3 text-right font-mono tabular-nums font-medium">
                        {{ result.reputation }}
                      </td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Restocking and demand. -->
            <div class="flex flex-col gap-2">
              <h3 class="text-sm font-medium">Restocking and demand</h3>
              <ul class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <li class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  A villager restocks at most {{ result.restock.maxRestocksPerDay }} times a day,
                  and the second restock waits {{ result.restock.cooldownSeconds }} seconds after
                  the first.
                </li>
                <li class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  Demand moves by {{ result.restock.demandPerRestock }} per restock at this usage,
                  and currently sits at {{ result.demand }}.
                </li>
                <li class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  Using fewer than {{ result.restock.breakEvenUses }} of the
                  {{ result.selected?.maxUses ?? 0 }} uses per restock pushes demand back down.
                </li>
                <li class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <template v-if="result.restock.usesBeforePriceRises !== null">
                    The price starts climbing once you use
                    {{ result.restock.usesBeforePriceRises }} of them in a restock cycle.
                  </template>
                  <template v-else>
                    This trade cannot be used enough in one restock cycle to raise its own price.
                  </template>
                </li>
              </ul>
            </div>

            <div v-if="shareText" class="flex items-center gap-2">
              <CopyButton :text="shareText" />
              <span class="text-xs text-muted-foreground">Copy this answer as text</span>
            </div>
          </template>

          <ul v-if="result.notes.length" class="flex flex-col gap-1 text-xs text-muted-foreground">
            <li v-for="note in result.notes" :key="note">{{ note }}</li>
          </ul>

          <p class="text-xs text-muted-foreground">
            Computed from the trade tables and gossip constants inside Minecraft
            {{ result.version }}. Not an official Minecraft product. Not approved by or associated
            with Mojang or Microsoft.
          </p>
        </template>
      </section>
    </div>
  </div>
</template>
