<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft hunger and saturation calculator.
 *
 * A workbench split: the player's starting state on the left, the activity
 * mix on the right, four stat tiles for the headline numbers, then a food
 * card (what one item does to that state and how many an hour costs), a
 * regeneration card, and the full per-version food ranking table. Every
 * number routes through the verified engine in
 * src/tools/minecraft-hunger-calculator; the panel owns only DOM, gating,
 * and URL-fragment state. Fragment values are untrusted partial input, so
 * everything read from the hash is validated and clamped, and a food that
 * does not exist in the selected version falls back to a food that does.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  DAY_SECONDS,
  INVENTORY_SLOTS,
  canEat,
  drainPlan,
  duration,
  eatFood,
  effectivePoints,
  exhaustionPerSecond,
  healthPerItem,
  rankFoods,
  regenPlan,
  saturationDrain,
  sustainPlan,
  type ActivityRate,
  type HungerState,
  type RankBy,
  type SimEnv,
} from "@/tools/minecraft-hunger-calculator/index";
import {
  ACTIVITY_BY_ID,
  ACTIVITY_PRESETS,
  DIFFICULTIES,
  FOOD_CATEGORIES,
  HUNGER_VERSIONS,
  MECHANICS,
  PEACEFUL_REGEN,
  activitiesFor,
  foodById,
  foodsFor,
  type DifficultyId,
  type FoodItem,
  type VersionId,
} from "@/tools/minecraft-hunger-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import OutputView from "../OutputView.vue";
import ErrorBanner from "../ErrorBanner.vue";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const DEFAULT_VERSION: VersionId = "1.21.11";
const DEFAULT_FOOD = "cooked_beef";

const version = ref<VersionId>(DEFAULT_VERSION);
const difficulty = ref<DifficultyId>("normal");
const naturalRegen = ref(true);

const startFood = ref(20);
const startSaturation = ref(5);
const startHealth = ref(10);
const hearts = ref(5);

const foodId = ref(DEFAULT_FOOD);
const sortBy = ref<RankBy>("item");
const preset = ref("sprinting");
const rates = ref<Record<string, number>>({ sprint: 337 });

const mounted = ref(false);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function dec(n: number, places = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: places });
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number, step = 1): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const snapped = step >= 1 ? Math.round(n) : n;
  return Math.min(Math.max(snapped, lo), hi);
}

interface CalcError {
  message: string;
  fix?: string;
}

function toCalcError(e: unknown): CalcError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const versionSpec: SelectOptionSpec = {
  kind: "select",
  id: "mch-version",
  label: "Version",
  default: DEFAULT_VERSION,
  options: HUNGER_VERSIONS.map((v) => ({
    value: v,
    label: v === "26.2" ? "26.2 (latest)" : v,
    synonyms: [v.replace(/\./g, " ")],
  })),
};

const difficultySpec: SelectOptionSpec = {
  kind: "select",
  id: "mch-difficulty",
  label: "Difficulty",
  default: "normal",
  options: DIFFICULTIES.map((d) => ({
    value: d.id,
    label: d.label,
    synonyms: d.drains ? ["drains hunger"] : ["no hunger drain"],
  })),
};

const presetSpec: SelectOptionSpec = {
  kind: "select",
  id: "mch-preset",
  label: "Activity preset",
  default: "sprinting",
  options: [
    { value: "", label: "Custom rates", synonyms: ["manual", "none"] },
    ...ACTIVITY_PRESETS.map((p) => ({
      value: p.id,
      label: p.approximate ? `${p.label} (approximate)` : p.label,
      synonyms: [p.id.replace(/_/g, " ")],
    })),
  ],
};

/** Only foods that exist in the selected version, grouped by category. */
const foodSpec = computed<SelectOptionSpec>(() => {
  const available = foodsFor(version.value);
  return {
    kind: "select",
    id: "mch-food",
    label: "Food",
    default: DEFAULT_FOOD,
    groups: FOOD_CATEGORIES.filter((cat) => available.some((f) => f.cat === cat)).map((cat) => ({
      label: cat,
      synonyms: [cat.toLowerCase()],
      options: available
        .filter((f) => f.cat === cat)
        .map((f) => ({
          value: f.id,
          label: `${f.name} (${f.nutrition} hunger, ${dec(f.saturation)} saturation)`,
          synonyms: [f.id.replace(/_/g, " "), ...f.synonyms],
        })),
    })),
  };
});

const sortSpec: SelectOptionSpec = {
  kind: "select",
  id: "mch-sort",
  label: "Rank by",
  default: "item",
  options: [
    { value: "item", label: "Hearts per item", synonyms: ["per item", "value"] },
    {
      value: "slot",
      label: "Hearts per inventory slot",
      synonyms: ["per stack", "per slot", "trip"],
    },
    { value: "saturation", label: "Saturation", synonyms: ["saturation", "lasts longest"] },
    { value: "nutrition", label: "Hunger points", synonyms: ["nutrition", "drumsticks", "bar"] },
  ],
};

/* ---------------------------------------------------------------- */
/* activity mix                                                      */
/* ---------------------------------------------------------------- */

/** Only the actions that exist in the selected version (Lunge is 1.21.2+). */
const activities = computed(() => activitiesFor(version.value));

const mix = computed<ActivityRate[]>(() =>
  activities.value.map((a) => ({ activityId: a.id, perMinute: rates.value[a.id] ?? 0 })),
);

const exhPerSecond = computed(() => {
  try {
    return exhaustionPerSecond(mix.value);
  } catch {
    return 0;
  }
});

const activePreset = computed(() => ACTIVITY_PRESETS.find((p) => p.id === preset.value));

function applyPreset(id: string) {
  preset.value = id;
  const found = ACTIVITY_PRESETS.find((p) => p.id === id);
  if (!found) return;
  rates.value = { ...found.rates };
}

function setRate(id: string, value: unknown) {
  rates.value = { ...rates.value, [id]: clampNum(value, 0, 100000, 0) };
  preset.value = "";
}

/** Share of the total exhaustion each activity contributes, for the meter. */
const contributions = computed(() =>
  activities.value
    .map((a) => {
      const perSecond = (a.exhaustion * (rates.value[a.id] ?? 0)) / 60;
      const share = exhPerSecond.value > 0 ? perSecond / exhPerSecond.value : 0;
      return { activity: a, perSecond, share };
    })
    .filter((c) => c.perSecond > 0),
);

/* ---------------------------------------------------------------- */
/* headline numbers                                                  */
/* ---------------------------------------------------------------- */

const peacefulNow = computed(() => difficulty.value === "peaceful");

/** The player's starting state and world, shared by every card below. */
const startState = computed<HungerState>(() => ({
  food: startFood.value,
  saturation: startSaturation.value,
  exhaustion: 0,
  health: startHealth.value,
  tickTimer: 0,
  tickCount: 0,
}));

const env = computed<SimEnv>(() => ({
  version: version.value,
  difficulty: difficulty.value,
  naturalRegen: naturalRegen.value,
  maxHealth: 20,
  exhaustionPerTick: exhPerSecond.value / 20,
}));

const plan = computed(() => drainPlan(startFood.value, startSaturation.value, exhPerSecond.value));

/**
 * Saturation is the one number Peaceful can put back, and only from 1.21
 * (ServerPlayer#tickRegeneration, Player#aiStep before 1.21.2). On 1.16.5,
 * 1.18.2 and 1.20.6 Peaceful refills health and the hunger bar but never
 * saturation, so the pool still burns to zero on a normal Peaceful sprint.
 */
const saturation = computed(() => saturationDrain(startState.value, env.value));

const tiles = computed(() => {
  // The hunger BAR is what Peaceful pins: FoodData#tick guards the food drop
  // with difficulty != PEACEFUL, and the Peaceful branch refills it too.
  const barDrains = !peacefulNow.value;
  const sat = saturation.value;
  return [
    {
      label: "Exhaustion per second",
      value: dec(exhPerSecond.value, 4),
      sub: "4 exhaustion burns 1 point",
    },
    {
      label: "Saturation gone after",
      // A null with no refill means the rate itself is zero, which reads the
      // same way as the other tiles; a null WITH a refill is a real "never".
      value:
        sat.seconds === null ? (sat.refilling ? "never" : duration(null)) : duration(sat.seconds),
      sub: sat.refilling
        ? sat.seconds === null
          ? "Peaceful refills it faster than you burn it"
          : "you outburn the Peaceful refill"
        : barDrains
          ? "then the bar starts moving"
          : "Peaceful adds no saturation before 1.21",
    },
    {
      label: "Sprinting stops after",
      value: barDrains ? duration(plan.value.secondsToSprintLost) : "never",
      sub: barDrains
        ? `sprinting needs hunger above ${MECHANICS.sprintLevel}`
        : "Peaceful never drains the hunger bar",
    },
    {
      label: "Hunger bar empty after",
      value: barDrains ? duration(plan.value.secondsToEmpty) : "never",
      sub: barDrains ? "starvation starts here" : "Peaceful refills the bar instead",
    },
  ];
});

/* ---------------------------------------------------------------- */
/* the selected food                                                 */
/* ---------------------------------------------------------------- */

const selectedFood = computed<FoodItem | undefined>(() => foodById(version.value, foodId.value));

const foodRows = computed<Record<string, string>>(() => {
  const item = selectedFood.value;
  if (!item) return {};
  const rows: Record<string, string> = {};
  rows["Restores"] = `${item.nutrition} hunger points, ${dec(item.saturation)} saturation`;
  if (item.hungerExhaustion > 0) {
    rows["Own Hunger effect costs"] =
      `${dec(item.hungerExhaustion)} exhaustion, so it is really worth ${dec(effectivePoints(item))} points`;
  }
  const after = eatFood(startState.value, item);
  const wastedFood = startState.value.food + item.nutrition - after.food;
  const wastedSat = startState.value.saturation + item.saturation - after.saturation;
  rows["Eating it now leaves you at"] =
    `${after.food} hunger, ${dec(after.saturation)} saturation` +
    (wastedFood > 0 || wastedSat > 0.001
      ? ` (${dec(wastedFood)} hunger and ${dec(wastedSat)} saturation wasted to the clamp)`
      : "");
  if (!canEat(startState.value, item)) {
    rows["Can you eat it right now"] = "no: the bar is full and this food is not always edible";
  } else if (item.alwaysEdible) {
    rows["Can you eat it right now"] = "yes: this food is always edible, even on a full bar";
  }
  rows["Hearts of natural healing"] =
    `${dec(healthPerItem(item) / 2)} per item, ${dec((healthPerItem(item) / 2) * item.stack, 1)} per inventory slot`;
  rows["Eating time"] =
    item.eatTicks === 0
      ? "instant (cake is a block interaction)"
      : `${dec(item.eatTicks / 20, 1)} s`;
  if (item.effects) rows["Side effects"] = item.effects;
  return rows;
});

interface RowsOrError {
  rows: Record<string, string>;
  error: CalcError | null;
}

const sustainRows = computed<RowsOrError>(() => {
  const item = selectedFood.value;
  if (!item) return { rows: {}, error: null };
  if (exhPerSecond.value <= 0 || peacefulNow.value) {
    const rows: Record<string, string> = {
      "Items per hour": peacefulNow.value
        ? "0: Peaceful refills the bar for free"
        : "0: nothing you selected costs exhaustion",
    };
    return { rows, error: null };
  }
  try {
    const s = sustainPlan(item, exhPerSecond.value);
    const rows: Record<string, string> = {
      "Items per hour": dec(s.itemsPerHour, 1),
      "Items per in-game day": `${dec(s.itemsPerDay, 1)} (a day is ${DAY_SECONDS / 60} real minutes)`,
      "Stacks per hour": `${dec(s.stacksPerHour, 2)} (one slot holds ${item.stack})`,
      "Hours a full inventory lasts": dec((INVENTORY_SLOTS * item.stack) / s.itemsPerHour, 1),
      "Time spent eating per hour": duration(s.eatingSecondsPerHour),
    };
    return { rows, error: null };
  } catch (e) {
    return { rows: {}, error: toCalcError(e) };
  }
});

/* ---------------------------------------------------------------- */
/* regeneration                                                      */
/* ---------------------------------------------------------------- */

const regen = computed(() => regenPlan(startState.value, env.value, hearts.value));

const regenRows = computed<Record<string, string>>(() => {
  const r = regen.value;
  const pathLabel: Record<string, string> = {
    saturated: "saturated fast heal, one heal every 10 ticks",
    normal: "normal heal, one heal every 80 ticks",
    both: "started on the fast path, finished on the normal one",
    none: "no healing happened",
  };
  const rows: Record<string, string> = {};
  rows["Time to heal"] = r.reached
    ? duration(r.seconds)
    : `stalls after ${dec(r.healed / 2, 2)} hearts`;
  rows["Path"] = pathLabel[r.path] ?? r.path;
  rows["Costs you"] =
    `${dec(r.foodSpent, 1)} hunger points and ${dec(r.saturationSpent, 2)} saturation, plus ${dec(r.end.exhaustion, 2)} exhaustion still pending`;
  rows["Ends at"] =
    `${dec(r.end.health / 2, 1)} hearts, ${r.end.food} hunger, ${dec(r.end.saturation, 2)} saturation`;
  if (!r.reached) {
    if (startHealth.value >= 20) {
      rows["Why it stalls"] = "you are already at full health, so there is nothing to regenerate";
    } else if (!naturalRegen.value) {
      rows["Why it stalls"] = "the naturalRegeneration game rule is switched off";
    } else {
      rows["Why it stalls"] =
        `natural regeneration needs the hunger bar at ${MECHANICS.healLevel} or more, and yours falls below that first`;
    }
  }
  return rows;
});

/* ---------------------------------------------------------------- */
/* the ranking table                                                 */
/* ---------------------------------------------------------------- */

const ranking = computed(() => rankFoods(version.value, sortBy.value));

/* ---------------------------------------------------------------- */
/* version gating                                                    */
/* ---------------------------------------------------------------- */

function onVersionChange(v: string) {
  version.value = v as VersionId;
  if (!foodById(version.value, foodId.value)) foodId.value = DEFAULT_FOOD;
  // Never carry a rate for an action the selected version does not have.
  const allowed = new Set(activitiesFor(version.value).map((a) => a.id));
  const next: Record<string, number> = {};
  for (const [id, n] of Object.entries(rates.value)) if (allowed.has(id)) next[id] = n;
  rates.value = next;
}

const peacefulNote = computed(() => {
  const regenSpec = PEACEFUL_REGEN[version.value];
  if (!regenSpec) return "";
  return regenSpec.saturationEvery > 0
    ? `On Peaceful this version also refills saturation, one point every ${regenSpec.saturationEvery} ticks, on top of one health point every ${regenSpec.healEvery} ticks and one hunger point every ${regenSpec.foodEvery} ticks. That saturation switches on the fast heal path, so Peaceful heals faster here than it did before 1.21.`
    : `On Peaceful this version refills one health point every ${regenSpec.healEvery} ticks and one hunger point every ${regenSpec.foodEvery} ticks, and never touches saturation. The saturation refill arrived in 1.21.`;
});

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    version,
    difficulty,
    naturalRegen,
    startFood,
    startSaturation,
    startHealth,
    hearts,
    foodId,
    sortBy,
    preset,
    rates,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        v: version.value,
        d: difficulty.value,
        nr: String(naturalRegen.value),
        sf: String(startFood.value),
        ss: String(startSaturation.value),
        sh: String(startHealth.value),
        hr: String(hearts.value),
        f: foodId.value,
        sort: sortBy.value,
        p: preset.value,
        r: Object.entries(rates.value)
          .filter(([, n]) => n > 0)
          .map(([id, n]) => `${id}:${n}`)
          .join(","),
      },
    });
  },
  { deep: true },
);

onMounted(() => {
  const { opts } = readFragment();
  if (opts.v && (HUNGER_VERSIONS as readonly string[]).includes(opts.v)) {
    version.value = opts.v as VersionId;
  }
  if (opts.d && DIFFICULTIES.some((x) => x.id === opts.d))
    difficulty.value = opts.d as DifficultyId;
  if (opts.nr !== undefined) naturalRegen.value = opts.nr !== "false";
  if (opts.sf) startFood.value = clampNum(opts.sf, 0, MECHANICS.maxFood, 20);
  if (opts.ss) startSaturation.value = clampNum(opts.ss, 0, MECHANICS.maxSaturation, 5, 0.1);
  if (opts.sh) startHealth.value = clampNum(opts.sh, 0, 20, 10, 0.5);
  if (opts.hr) hearts.value = clampNum(opts.hr, 0.5, 10, 5, 0.5);
  if (opts.f && foodById(version.value, opts.f)) foodId.value = opts.f;
  if (
    opts.sort === "item" ||
    opts.sort === "slot" ||
    opts.sort === "saturation" ||
    opts.sort === "nutrition"
  ) {
    sortBy.value = opts.sort;
  }
  if (opts.r !== undefined) {
    const allowed = new Set(activitiesFor(version.value).map((a) => a.id));
    const next: Record<string, number> = {};
    for (const part of opts.r.split(",")) {
      const [id, n] = part.split(":");
      if (id && ACTIVITY_BY_ID.has(id) && allowed.has(id)) next[id] = clampNum(n, 0, 100000, 0);
    }
    rates.value = next;
    preset.value = opts.p && ACTIVITY_PRESETS.some((p) => p.id === opts.p) ? opts.p : "";
  } else if (opts.p && ACTIVITY_PRESETS.some((p) => p.id === opts.p)) {
    applyPreset(opts.p);
  }
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- header: version and difficulty -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex min-w-[16rem] flex-1 flex-col gap-1">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Hunger, saturation, and exhaustion
        </span>
        <p class="text-xs text-muted-foreground">
          Every action adds exhaustion. Each 4 exhaustion burns one saturation point, or one hunger
          point once saturation is gone. The tick loop, the constants, and the food table are all
          verified against decompiled game code.
        </p>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="mch-version" class="text-xs text-muted-foreground">Version</Label>
          <SearchableSelect
            id="mch-version"
            :spec="versionSpec"
            :model-value="version"
            @update:model-value="onVersionChange"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mch-difficulty" class="text-xs text-muted-foreground">Difficulty</Label>
          <Segmented
            id="mch-difficulty"
            :options="difficultySpec.options ?? []"
            label="Difficulty"
            :model-value="difficulty"
            @update:model-value="(v: string) => (difficulty = v as DifficultyId)"
          />
        </div>
      </div>
    </div>

    <!-- workbench split: the player, and what the player is doing -->
    <div class="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
      <!-- your player -->
      <div class="flex flex-col gap-3 rounded-[14px] border p-4">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Your player
        </span>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mch-sf" class="text-xs text-muted-foreground">Hunger (0 to 20)</Label>
            <Input
              id="mch-sf"
              type="number"
              min="0"
              :max="MECHANICS.maxFood"
              step="1"
              :model-value="startFood"
              @update:model-value="(v) => (startFood = clampNum(v, 0, MECHANICS.maxFood, 20))"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mch-ss" class="text-xs text-muted-foreground">Saturation (0 to 20)</Label>
            <Input
              id="mch-ss"
              type="number"
              min="0"
              :max="MECHANICS.maxSaturation"
              step="0.1"
              :model-value="startSaturation"
              @update:model-value="
                (v) => (startSaturation = clampNum(v, 0, MECHANICS.maxSaturation, 5, 0.1))
              "
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mch-sh" class="text-xs text-muted-foreground">Health (0 to 20)</Label>
            <Input
              id="mch-sh"
              type="number"
              min="0"
              max="20"
              step="0.5"
              :model-value="startHealth"
              @update:model-value="(v) => (startHealth = clampNum(v, 0, 20, 10, 0.5))"
            />
          </div>
        </div>

        <!-- the bar itself: 10 icons of 2 points each -->
        <div class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>Hunger bar</span>
            <span class="font-mono tabular-nums">{{ startFood }} / 20 points</span>
          </div>
          <div class="flex gap-1" role="img" :aria-label="`Hunger ${startFood} of 20 points`">
            <span
              v-for="i in 10"
              :key="`h${i}`"
              class="h-2.5 flex-1 rounded-[3px]"
              :class="
                startFood >= i * 2
                  ? 'bg-[image:var(--grad-brand)]'
                  : startFood >= i * 2 - 1
                    ? 'bg-[image:var(--grad-brand-soft)]'
                    : 'bg-border'
              "
            />
          </div>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>Saturation (hidden in game, never above the hunger bar)</span>
            <span class="font-mono tabular-nums">{{ dec(startSaturation) }} / 20</span>
          </div>
          <div class="h-2.5 w-full overflow-hidden rounded-[3px] bg-border">
            <div
              class="h-full rounded-[3px] bg-[color:var(--positive)]"
              :style="{ width: `${Math.min(100, (startSaturation / 20) * 100)}%` }"
            />
          </div>
        </div>

        <div class="flex items-center justify-between gap-2">
          <Label for="mch-nr" class="cursor-pointer text-xs text-muted-foreground">
            naturalRegeneration game rule is on
          </Label>
          <Switch
            id="mch-nr"
            :model-value="naturalRegen"
            @update:model-value="(v) => (naturalRegen = Boolean(v))"
          />
        </div>
      </div>

      <!-- what you are doing -->
      <div class="flex flex-col gap-3 rounded-[14px] border p-4">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            What you are doing
          </span>
          <div class="w-56">
            <SearchableSelect
              id="mch-preset"
              :spec="presetSpec"
              :model-value="preset"
              aria-label="Activity preset"
              @update:model-value="applyPreset"
            />
          </div>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div v-for="a in activities" :key="a.id" class="flex items-center justify-between gap-2">
            <Label :for="`mch-r-${a.id}`" class="min-w-0 flex-1 truncate text-xs">
              {{ a.label }}
              <span class="text-muted-foreground">({{ a.unitPlural }} per min)</span>
            </Label>
            <Input
              :id="`mch-r-${a.id}`"
              type="number"
              min="0"
              max="100000"
              step="1"
              class="w-24"
              :model-value="rates[a.id] ?? 0"
              @update:model-value="(v) => setRate(a.id, v)"
            />
          </div>
        </div>
        <p v-if="activePreset" class="text-xs text-muted-foreground">{{ activePreset.note }}</p>
        <p v-else class="text-xs text-muted-foreground">
          Costs per unit come straight from the game code: 0.1 exhaustion per block sprinted, 0.01
          per block swum, 0.05 per jump, 0.2 per sprint jump, 0.005 per block broken, 0.1 per hit
          landed or taken. Walking and crouching are charged 0.0, so they are free at any speed.
        </p>
      </div>
    </div>

    <!-- headline tiles -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
      <div
        v-for="tile in tiles"
        :key="tile.label"
        class="rounded-[14px] border bg-card p-3 text-center shadow-[var(--sh-sm)]"
      >
        <p class="text-xs text-muted-foreground">{{ tile.label }}</p>
        <p class="font-mono text-xl font-semibold tabular-nums">{{ tile.value }}</p>
        <p class="text-xs text-muted-foreground">{{ tile.sub }}</p>
      </div>
    </div>

    <!-- where the exhaustion goes -->
    <div v-if="contributions.length" class="flex flex-col gap-2 rounded-[14px] border p-4">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Where your exhaustion goes
      </span>
      <div v-for="c in contributions" :key="c.activity.id" class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-xs">
          <span>{{ c.activity.label }}</span>
          <span class="font-mono text-muted-foreground tabular-nums">
            {{ dec(c.perSecond, 4) }} per second ({{ dec(c.share * 100, 0) }}%)
          </span>
        </div>
        <div class="h-1.5 w-full overflow-hidden rounded-[3px] bg-secondary">
          <div
            class="h-full rounded-[3px] bg-[image:var(--grad-brand)]"
            :style="{ width: `${c.share * 100}%` }"
          />
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        Natural regeneration is not in this list because it is not something you choose: healing one
        health point adds {{ MECHANICS.exhaustionHeal }} exhaustion on both regeneration paths,
        which is why healing costs 3 hunger or saturation points per heart.
      </p>
    </div>

    <!-- food card -->
    <div class="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
      <div class="flex flex-col gap-3 rounded-[14px] border p-4">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            One food, in detail
          </span>
          <div class="w-64">
            <SearchableSelect
              id="mch-food"
              :spec="foodSpec"
              :model-value="foodId"
              aria-label="Food"
              @update:model-value="(v: string) => (foodId = v)"
            />
          </div>
        </div>
        <div aria-live="polite">
          <OutputView :output="foodRows" />
        </div>
      </div>

      <div class="flex flex-col gap-3 rounded-[14px] border p-4">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          How much of it you need
        </span>
        <ErrorBanner
          v-if="sustainRows.error"
          :message="sustainRows.error.message"
          :hint="sustainRows.error.fix"
        />
        <div v-else aria-live="polite">
          <OutputView :output="sustainRows.rows" />
        </div>
        <p class="text-xs text-muted-foreground">
          These counts assume you eat at a deficit big enough that nothing is thrown away, because
          the game fills the hunger bar first and only then clamps saturation to the new bar level.
          Eating a golden carrot at 18 hunger wastes most of its saturation.
        </p>
      </div>
    </div>

    <!-- regeneration -->
    <div class="flex flex-col gap-3 rounded-[14px] border p-4">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Regenerating hearts
        </span>
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="mch-hearts" class="text-xs text-muted-foreground">Hearts to heal</Label>
          <Input
            id="mch-hearts"
            type="number"
            min="0.5"
            max="10"
            step="0.5"
            :model-value="hearts"
            @update:model-value="(v) => (hearts = clampNum(v, 0.5, 10, 5, 0.5))"
          />
        </div>
      </div>
      <div aria-live="polite">
        <OutputView :output="regenRows" />
      </div>
      <p class="text-xs text-muted-foreground">
        With the bar full and saturation left, the game heals every 10 ticks and spends up to 6
        saturation each time. Otherwise it heals once every 80 ticks while hunger is at
        {{ MECHANICS.healLevel }} or more, and stops entirely below that. Both paths charge
        {{ MECHANICS.exhaustionHeal }} exhaustion per health point.
      </p>
      <p v-if="peacefulNow" class="text-xs text-muted-foreground">{{ peacefulNote }}</p>
    </div>

    <!-- ranking table -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Every food in {{ version }}
        </span>
        <div class="w-56">
          <SearchableSelect
            id="mch-sort"
            :spec="sortSpec"
            :model-value="sortBy"
            aria-label="Rank foods by"
            @update:model-value="(v: string) => (sortBy = v as RankBy)"
          />
        </div>
      </div>
      <div class="max-h-96 overflow-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="text-left text-xs font-semibold text-muted-foreground">
              <th scope="col" class="px-3 py-1.5">Food</th>
              <th scope="col" class="px-3 py-1.5">Hunger</th>
              <th scope="col" class="px-3 py-1.5">Saturation</th>
              <th scope="col" class="px-3 py-1.5">Hearts per item</th>
              <th scope="col" class="px-3 py-1.5">Hearts per slot</th>
              <th scope="col" class="px-3 py-1.5">Stack</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in ranking"
              :key="row.food.id"
              :class="row.food.id === foodId ? 'font-semibold text-primary' : ''"
            >
              <td class="px-3 py-1.5">
                {{ row.food.name }}
                <span v-if="row.food.alwaysEdible" class="text-xs text-muted-foreground">
                  (always edible)
                </span>
              </td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.food.nutrition }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ dec(row.food.saturation) }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ dec(row.heartsPerItem) }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ dec(row.heartsPerSlot, 1) }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.food.stack }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted-foreground">
        Hearts per item is the item's total value divided by 3, because healing costs
        {{ MECHANICS.exhaustionHeal }} exhaustion per health point and
        {{ MECHANICS.exhaustionDrop }} exhaustion is one point. One inventory slot holds one full
        stack, so hearts per slot is the number that matters when you pack for a trip. Junk foods
        are charged for the exhaustion their own Hunger effect costs.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      Verified against decompiled game code for 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, and 26.2.
      Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
    </p>
  </div>
</template>
