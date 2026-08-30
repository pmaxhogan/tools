<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft mob spawning simulator.
 *
 * Workbench split: a picker rail on the left (version first, since it gates
 * the biome list, the categories and the light rule), live answers on the
 * right behind a small tab strip. All arithmetic lives in the pure logic
 * layer; the panel owns only DOM, fragment state and layout.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  MIN_SPAWN_DISTANCE,
  MOB_CAP_DIVISOR,
  NO_DESPAWN_DISTANCE,
  SPAWNING_CHUNK_PLAYER_RADIUS,
  SPAWN_CHUNK_RADIUS,
  SPAWN_VERSIONS,
  afkGeometry,
  categoriesFor,
  categoriesWithSpawns,
  farmRate,
  mobCap,
  spawnProof,
  spawnsIn,
  type FarmRateResult,
  type MobCapResult,
  type SpawnListResult,
  type SpawnProofResult,
  type WorldLight,
} from "@/tools/minecraft-mob-spawning-calculator/index";
import { BIOMES, type SpawnDimension } from "@/tools/minecraft-mob-spawning-calculator/biomes";
import { readFragment, writeFragment } from "@/lib/fragment";
import type { KeyValueRow } from "@/lib/key-value";
import KeyValueGrid from "../KeyValueGrid.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";

defineProps<{ meta: ToolMeta }>();

const LATEST = SPAWN_VERSIONS[SPAWN_VERSIONS.length - 1];
type Tab = "spawns" | "cap" | "farm" | "proof";

const version = ref(LATEST);
const biome = ref("plains");
const category = ref("monster");
const world = ref<WorldLight>("night");
const skyLight = ref(0);
const blockLight = ref(0);
const players = ref(1);
const playersSeparated = ref(true);
const simulationDistance = ref(10);
const currentMobs = ref(0);
const tab = ref<Tab>("spawns");
const mounted = ref(false);

// farm inputs
const spawnSpaces = ref(1536);
const farmChunks = ref(9);
const surfaceY = ref(100);
const dwellSeconds = ref(30);
const afkDistance = ref(40);

// spawn proofing inputs
const sourceLight = ref(14);
const sourceDistance = ref(7);

const DIM_GROUPS: Array<{ id: SpawnDimension; label: string; synonyms: string[] }> = [
  { id: "overworld", label: "Overworld", synonyms: ["surface", "cave", "ocean"] },
  { id: "nether", label: "Nether", synonyms: ["hell", "fortress", "piglin"] },
  { id: "end", label: "The End", synonyms: ["ender", "enderman", "end city"] },
];

const VERSION_SYNONYMS: Record<string, string[]> = {
  "1.16.5": ["nether update"],
  "1.18.2": ["caves and cliffs"],
  "1.20.6": ["trails and tales"],
  "1.21.1": ["tricky trials"],
  "1.21.11": [],
  "26.2": ["latest", "newest"],
};

const versionSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcs-version",
  label: "Minecraft version",
  default: LATEST,
  options: SPAWN_VERSIONS.map((v) => ({
    value: v,
    label: v,
    synonyms: VERSION_SYNONYMS[v] ?? [],
  })),
}));

/** Biomes that exist in the chosen version, whatever the dimension. */
const availableBiomes = computed(() => BIOMES.filter((b) => b.versions.includes(version.value)));

/**
 * The biome picker carries the dimension: grouping by Overworld, Nether and
 * The End means one searchable control instead of two coupled ones, and the
 * dimension can never disagree with the biome.
 */
const biomeSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcs-biome",
  label: "Biome",
  default: "",
  groups: DIM_GROUPS.map((g) => ({
    label: g.label,
    synonyms: g.synonyms,
    options: availableBiomes.value
      .filter((b) => b.dim === g.id)
      .map((b) => ({ value: b.id, label: b.name, synonyms: b.synonyms })),
  })).filter((g) => g.options.length > 0),
}));

const dimension = computed<SpawnDimension>(
  () => availableBiomes.value.find((b) => b.id === biome.value)?.dim ?? "overworld",
);

/**
 * Categories that exist in this version and have at least one spawner entry in
 * this biome, so no combination that cannot happen is selectable. Monster is
 * always kept: "nothing hostile spawns here" is the answer people come for in
 * places like mushroom fields, not a gap in the data.
 */
const availableCategories = computed(() => {
  const inVersion = categoriesFor(version.value);
  let populated: string[] = [];
  try {
    populated = categoriesWithSpawns(version.value, biome.value);
  } catch {
    populated = [];
  }
  return inVersion.filter((c) => c.id === "monster" || populated.includes(c.id));
});

const CATEGORY_SYNONYMS: Record<string, string[]> = {
  monster: ["hostile", "zombie", "skeleton", "creeper"],
  creature: ["passive", "animal", "cow", "sheep"],
  ambient: ["bat"],
  axolotls: ["axolotl"],
  underground_water_creature: ["glow squid"],
  water_creature: ["squid", "dolphin"],
  water_ambient: ["fish", "cod", "salmon"],
};

const categorySpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mcs-category",
  label: "Mob category",
  default: "monster",
  options: availableCategories.value.map((c) => ({
    value: c.id,
    label: c.name,
    synonyms: CATEGORY_SYNONYMS[c.id] ?? [],
  })),
}));

const WORLDS: Array<{ id: WorldLight; label: string }> = [
  { id: "night", label: "Midnight" },
  { id: "day", label: "Noon" },
  { id: "thunder", label: "Storm" },
];

// ------------------------------------------------------------- computation --

const error = ref<{ message: string; fix?: string } | null>(null);
const spawns = ref<SpawnListResult | null>(null);
const cap = ref<MobCapResult | null>(null);
const farm = ref<FarmRateResult | null>(null);
const proof = ref<SpawnProofResult | null>(null);

function recompute() {
  try {
    const list = spawnsIn({
      version: version.value,
      biome: biome.value,
      category: category.value,
      skyLight: skyLight.value,
      blockLight: blockLight.value,
      world: world.value,
    });
    spawns.value = list;
    cap.value = mobCap({
      version: version.value,
      category: category.value,
      players: players.value,
      playersSeparated: playersSeparated.value,
      simulationDistance: simulationDistance.value,
      currentMobs: currentMobs.value,
    });
    const gated = list.entries.filter((e) => e.rule === "dark" || e.rule === "surface");
    const avgPack = list.entries.length
      ? list.entries.reduce((s, e) => s + e.avgPack * e.share, 0)
      : 4;
    farm.value = farmRate({
      version: version.value,
      dimension: dimension.value,
      category: category.value,
      spawnSpaces: spawnSpaces.value,
      farmChunks: farmChunks.value,
      surfaceY: surfaceY.value,
      avgPack,
      dwellSeconds: dwellSeconds.value,
      otherMobs: currentMobs.value,
      players: players.value,
      playersSeparated: playersSeparated.value,
      simulationDistance: simulationDistance.value,
      lightChance: gated.length ? list.lightVerdict.chance : 1,
      afkDistance: afkDistance.value,
    });
    proof.value = spawnProof({
      version: version.value,
      dimension: dimension.value,
      sourceLight: sourceLight.value,
      distance: sourceDistance.value,
      skyLight: skyLight.value,
      world: world.value,
    });
    error.value = null;
  } catch (e) {
    spawns.value = null;
    cap.value = null;
    farm.value = null;
    proof.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: String((e as Error).message ?? e) };
  }
}

const geometry = computed(() => {
  try {
    return afkGeometry(version.value, category.value);
  } catch {
    return null;
  }
});

/** The same light source read against every shipped version, side by side. */
const proofAcrossVersions = computed(() =>
  SPAWN_VERSIONS.map((v) => {
    const r = spawnProof({
      version: v,
      dimension: dimension.value,
      sourceLight: sourceLight.value,
      distance: sourceDistance.value,
      skyLight: skyLight.value,
      world: world.value,
    });
    return { version: v, safeRadius: r.safeRadius, safe: r.safe, chance: r.chance };
  }),
);

interface StatTile {
  label: string;
  value: string;
  hint?: string;
  copy?: string;
}

const tiles = computed<StatTile[]>(() => {
  const c = cap.value;
  const s = spawns.value;
  const f = farm.value;
  if (!c || !s || !f) return [];
  return [
    {
      label: `${s.categoryName} cap`,
      value: String(c.globalCap),
      hint: `${c.maxPerChunk} per ${MOB_CAP_DIVISOR} chunks, ${c.spawnableChunks} counted`,
      copy: String(c.globalCap),
    },
    {
      label: "Chunks trying to spawn",
      value: String(c.attemptChunks),
      hint: `radius ${c.attemptRadius} chunks, inside ${SPAWNING_CHUNK_PLAYER_RADIUS} blocks`,
    },
    {
      label: "Light check passes",
      value: pct(s.lightVerdict.chance),
      hint: `brightness ${s.lightVerdict.rawBrightness} at this spot`,
      copy: pct(s.lightVerdict.chance),
    },
    {
      label: "Estimated mobs per hour",
      value: round(f.perHour),
      hint: `limited by ${bottleneckLabel(f)}`,
      copy: round(f.perHour),
    },
  ];
});

function bottleneckLabel(f: FarmRateResult): string {
  if (f.bottleneck === "spawn-attempts") return "spawn attempts";
  if (f.bottleneck === "mob-cap") return "the mob cap";
  if (f.bottleneck === "light") return "the light rule";
  return "the AFK geometry";
}

const RULE_LABELS: Record<string, string> = {
  dark: "Light gated",
  surface: "Light gated, needs sky",
  "any-light": "Ignores light",
  "own-light": "Own light test",
  custom: "Unclassified",
};

function pct(p: number): string {
  if (p >= 0.9995) return "100%";
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p > 0) return `${(p * 100).toPrecision(2)}%`;
  return "0%";
}

function round(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

/** The six terms the farm rate is built from, spelled out under the estimate. */
const farmTermRows = computed<KeyValueRow[]>(() => {
  const t = farm.value?.terms;
  if (!t) return [];
  return [
    { key: "Chunk ticks per second", value: String(t.chunkTicksPerSecond) },
    { key: "Random y values", value: String(t.columnHeight) },
    { key: "Spaces per chunk", value: round(t.spawnSpacesPerChunk) },
    { key: "Chance of a hit", value: pct(t.hitChance) },
    { key: "Mobs per hit", value: round(t.mobsPerHit) },
    { key: "Light passes", value: pct(t.lightChance) },
  ];
});

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// -------------------------------------------------------------- reactions --

/** Switching version keeps the biome when the new version still ships it. */
function reconcileSelection() {
  if (!availableBiomes.value.some((b) => b.id === biome.value)) {
    biome.value = availableBiomes.value[0]?.id ?? "";
  }
  if (!availableCategories.value.some((c) => c.id === category.value)) {
    category.value = availableCategories.value[0]?.id ?? "monster";
  }
}

watch(version, () => {
  reconcileSelection();
});
watch(biome, () => {
  if (!availableCategories.value.some((c) => c.id === category.value)) {
    category.value = availableCategories.value[0]?.id ?? "monster";
  }
});

const DEFAULTS: Record<string, string> = {
  v: LATEST,
  b: "plains",
  c: "monster",
  w: "night",
  sl: "0",
  bl: "0",
  p: "1",
  sep: "1",
  sim: "10",
  cm: "0",
  ss: "1536",
  fc: "9",
  sy: "100",
  dw: "30",
  afk: "40",
  src: "14",
  sd: "7",
  tab: "spawns",
};

watch(
  [
    version,
    biome,
    category,
    world,
    skyLight,
    blockLight,
    players,
    playersSeparated,
    simulationDistance,
    currentMobs,
    spawnSpaces,
    farmChunks,
    surfaceY,
    dwellSeconds,
    afkDistance,
    sourceLight,
    sourceDistance,
    tab,
  ],
  () => {
    recompute();
    if (!mounted.value) return;
    const state: Record<string, string> = {
      v: version.value,
      b: biome.value,
      c: category.value,
      w: world.value,
      sl: String(skyLight.value),
      bl: String(blockLight.value),
      p: String(players.value),
      sep: playersSeparated.value ? "1" : "0",
      sim: String(simulationDistance.value),
      cm: String(currentMobs.value),
      ss: String(spawnSpaces.value),
      fc: String(farmChunks.value),
      sy: String(surfaceY.value),
      dw: String(dwellSeconds.value),
      afk: String(afkDistance.value),
      src: String(sourceLight.value),
      sd: String(sourceDistance.value),
      tab: tab.value,
    };
    const opts: Record<string, string> = {};
    for (const [k, val] of Object.entries(state)) if (val !== DEFAULTS[k]) opts[k] = val;
    writeFragment({ opts });
  },
);

onMounted(() => {
  const frag = readFragment().opts;
  if (frag.v && SPAWN_VERSIONS.includes(frag.v)) version.value = frag.v;
  if (frag.b && availableBiomes.value.some((b) => b.id === frag.b)) biome.value = frag.b;
  reconcileSelection();
  if (frag.c && availableCategories.value.some((c) => c.id === frag.c)) category.value = frag.c;
  if (frag.w === "day" || frag.w === "night" || frag.w === "thunder") world.value = frag.w;
  if (frag.sl !== undefined) skyLight.value = clampInt(frag.sl, 0, 15, 0);
  if (frag.bl !== undefined) blockLight.value = clampInt(frag.bl, 0, 15, 0);
  if (frag.p !== undefined) players.value = clampInt(frag.p, 1, 20, 1);
  if (frag.sep !== undefined) playersSeparated.value = frag.sep !== "0";
  if (frag.sim !== undefined) simulationDistance.value = clampInt(frag.sim, 2, 32, 10);
  if (frag.cm !== undefined) currentMobs.value = clampInt(frag.cm, 0, 5000, 0);
  if (frag.ss !== undefined) spawnSpaces.value = clampInt(frag.ss, 0, 500000, 1536);
  if (frag.fc !== undefined) farmChunks.value = clampInt(frag.fc, 1, 289, 9);
  if (frag.sy !== undefined) surfaceY.value = clampInt(frag.sy, -64, 320, 100);
  if (frag.dw !== undefined) dwellSeconds.value = clampInt(frag.dw, 1, 3600, 30);
  if (frag.afk !== undefined) afkDistance.value = clampInt(frag.afk, 0, 300, 40);
  if (frag.src !== undefined) sourceLight.value = clampInt(frag.src, 0, 15, 14);
  if (frag.sd !== undefined) sourceDistance.value = clampInt(frag.sd, 0, 20, 7);
  if (frag.tab === "spawns" || frag.tab === "cap" || frag.tab === "farm" || frag.tab === "proof") {
    tab.value = frag.tab;
  }
  mounted.value = true;
  recompute();
});

recompute();

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "spawns", label: "What spawns here" },
  { id: "cap", label: "Mob cap and AFK ring" },
  { id: "farm", label: "Farm rate" },
  { id: "proof", label: "Spawn proofing" },
];
</script>

<template>
  <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <!-- Picker rail: version first, it gates everything below. -->
      <aside
        aria-label="Version, biome and light"
        class="flex flex-col gap-4 lg:border-r lg:border-border lg:pr-6"
      >
        <div class="flex flex-col gap-1.5">
          <Label for="mcs-version" class="text-xs text-muted-foreground">Minecraft version</Label>
          <SearchableSelect
            id="mcs-version"
            :spec="versionSpec"
            :model-value="version"
            @update:model-value="version = $event"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="mcs-biome" class="text-xs text-muted-foreground">Biome</Label>
          <SearchableSelect
            id="mcs-biome"
            :spec="biomeSpec"
            :model-value="biome"
            @update:model-value="biome = $event"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="mcs-category" class="text-xs text-muted-foreground">Mob category</Label>
          <SearchableSelect
            id="mcs-category"
            :spec="categorySpec"
            :model-value="category"
            @update:model-value="category = $event"
          />
        </div>

        <div class="h-px bg-border" role="presentation" />

        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Time of day</span>
          <div class="flex gap-1" role="group" aria-label="Time of day">
            <button
              v-for="w in WORLDS"
              :key="w.id"
              type="button"
              class="flex-1 rounded-[8px] border px-2 py-1.5 text-xs transition-colors"
              :class="
                world === w.id
                  ? 'border-transparent bg-[image:var(--grad-brand)] text-white'
                  : 'hover:bg-accent'
              "
              :aria-pressed="world === w.id"
              @click="world = w.id"
            >
              {{ w.label }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="mcs-sky" class="text-xs text-muted-foreground">Sky light</Label>
            <Input
              id="mcs-sky"
              type="number"
              min="0"
              max="15"
              :model-value="skyLight"
              @update:model-value="skyLight = clampInt($event, 0, 15, 0)"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="mcs-block" class="text-xs text-muted-foreground">Block light</Label>
            <Input
              id="mcs-block"
              type="number"
              min="0"
              max="15"
              :model-value="blockLight"
              @update:model-value="blockLight = clampInt($event, 0, 15, 0)"
            />
          </div>
        </div>

        <div class="h-px bg-border" role="presentation" />

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="mcs-players" class="text-xs text-muted-foreground">Players</Label>
            <Input
              id="mcs-players"
              type="number"
              min="1"
              max="20"
              :model-value="players"
              @update:model-value="players = clampInt($event, 1, 20, 1)"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="mcs-sim" class="text-xs text-muted-foreground">Sim distance</Label>
            <Input
              id="mcs-sim"
              type="number"
              min="2"
              max="32"
              :model-value="simulationDistance"
              @update:model-value="simulationDistance = clampInt($event, 2, 32, 10)"
            />
          </div>
        </div>

        <label
          v-if="players > 1"
          class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
        >
          <input
            v-model="playersSeparated"
            type="checkbox"
            class="size-3.5 accent-[var(--primary)]"
          />
          Players are far enough apart not to share chunks
        </label>

        <div class="flex flex-col gap-1.5">
          <Label for="mcs-live" class="text-xs text-muted-foreground">
            Mobs already loaded elsewhere
          </Label>
          <Input
            id="mcs-live"
            type="number"
            min="0"
            :model-value="currentMobs"
            @update:model-value="currentMobs = clampInt($event, 0, 5000, 0)"
          />
        </div>
      </aside>

      <!-- Live answers. -->
      <section class="flex min-w-0 flex-col gap-5" aria-live="polite">
        <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

        <template v-else-if="spawns && cap && farm && proof">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="text-sm font-semibold">{{ spawns.biomeName }}</h2>
            <span class="text-xs text-muted-foreground">
              {{ spawns.categoryName }} spawns · {{ spawns.dimension }} · Minecraft
              {{ spawns.version }}
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
                <div v-if="tile.hint" class="truncate text-[11px] text-muted-foreground">
                  {{ tile.hint }}
                </div>
              </div>
              <CopyButton v-if="tile.copy" :text="tile.copy" class="-mr-1.5 shrink-0" />
            </div>
          </div>

          <!-- Section tabs. -->
          <div class="flex flex-wrap gap-1" role="group" aria-label="Spawning views">
            <button
              v-for="t in TABS"
              :key="t.id"
              type="button"
              :aria-pressed="tab === t.id"
              class="rounded-[8px] border px-3 py-1.5 text-xs transition-colors"
              :class="
                tab === t.id
                  ? 'border-transparent bg-[image:var(--grad-brand)] text-white'
                  : 'hover:bg-accent'
              "
              @click="tab = t.id"
            >
              {{ t.label }}
            </button>
          </div>

          <!-- What spawns here. -->
          <div v-if="tab === 'spawns'" class="flex flex-col gap-3">
            <EmptyState
              v-if="!spawns.entries.length"
              :title="`Minecraft ${spawns.version} lists no ${spawns.categoryName.toLowerCase()} spawns for ${spawns.biomeName}`"
              hint="Nothing in this category ever appears here naturally."
            />
            <div v-else class="overflow-x-auto">
              <table class="w-full min-w-[34rem] border-collapse text-sm">
                <thead>
                  <tr class="border-b text-left text-xs text-muted-foreground">
                    <th class="py-2 pr-3 font-medium">Mob</th>
                    <th class="py-2 pr-3 text-right font-medium">Weight</th>
                    <th class="py-2 pr-3 text-right font-medium">Share of picks</th>
                    <th class="py-2 pr-3 text-right font-medium">Pack</th>
                    <th class="py-2 pr-3 text-right font-medium">Light passes</th>
                    <th class="py-2 font-medium">Spawn rule</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="e in spawns.entries" :key="e.mob" class="border-b border-border/60">
                    <td class="py-2 pr-3 font-medium">{{ e.name }}</td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ e.weight }}</td>
                    <td class="py-2 pr-3 text-right">
                      <div class="flex items-center justify-end gap-2">
                        <div class="h-2 w-16 overflow-hidden rounded-full bg-secondary">
                          <div
                            class="h-full rounded-full bg-[image:var(--grad-brand)]"
                            :style="{ width: `${Math.max(2, e.share * 100)}%` }"
                          />
                        </div>
                        <span class="font-mono text-xs tabular-nums">{{ pct(e.share) }}</span>
                      </div>
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ e.minCount === e.maxCount ? e.minCount : `${e.minCount}-${e.maxCount}` }}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ pct(e.lightChance) }}
                    </td>
                    <td class="py-2">
                      <span
                        class="rounded-[8px] bg-secondary px-2 py-0.5 text-xs"
                        :title="e.predicate"
                      >
                        {{ RULE_LABELS[e.rule] }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p class="text-xs text-muted-foreground">
              Weights are the real MobSpawnSettings entries from the
              {{ spawns.version }} biome data, so the share column is exactly how often the game
              picks each mob once it has decided to spawn something. Total weight
              {{ spawns.totalWeight }}.
            </p>
            <ul
              v-if="spawns.notes.length"
              class="flex flex-col gap-1 text-xs text-muted-foreground"
            >
              <li v-for="note in spawns.notes" :key="note">{{ note }}</li>
            </ul>
          </div>

          <!-- Mob cap and AFK geometry. -->
          <div v-else-if="tab === 'cap'" class="flex flex-col gap-4">
            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <h3 class="text-sm font-medium">The cap arithmetic</h3>
              <p class="font-mono text-sm tabular-nums">
                {{ cap.maxPerChunk }} x {{ cap.spawnableChunks }} / {{ MOB_CAP_DIVISOR }} =
                {{ cap.globalCap }} {{ cap.categoryName.toLowerCase() }} mobs
              </p>
              <p class="text-xs text-muted-foreground">
                Each player charges a {{ SPAWN_CHUNK_RADIUS * 2 + 1 }} by
                {{ SPAWN_CHUNK_RADIUS * 2 + 1 }} square of chunks, which is where the
                {{ MOB_CAP_DIVISOR }} comes from.
                <template v-if="cap.perPlayerCap !== null">
                  On top of that each player has their own limit of
                  {{ cap.perPlayerCap }} nearby {{ cap.categoryName.toLowerCase() }} mobs.
                </template>
              </p>
              <div class="mt-1 flex items-center gap-3">
                <div class="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    class="h-full rounded-full bg-[image:var(--grad-brand)]"
                    :style="{ width: `${Math.min(100, cap.fill * 100)}%` }"
                  />
                </div>
                <span class="font-mono text-xs tabular-nums">
                  {{ cap.currentMobs }} / {{ cap.globalCap }} used, {{ cap.headroom }} free
                </span>
              </div>
              <ul class="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                <li v-for="note in cap.notes" :key="note">{{ note }}</li>
              </ul>
            </div>

            <div v-if="geometry" class="flex flex-col gap-2 rounded-[14px] border p-4">
              <h3 class="text-sm font-medium">The AFK spot geometry</h3>
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">No spawns inside</div>
                  <div class="font-mono text-lg tabular-nums">{{ MIN_SPAWN_DISTANCE }}</div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">No random despawn inside</div>
                  <div class="font-mono text-lg tabular-nums">{{ NO_DESPAWN_DISTANCE }}</div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Instant despawn past</div>
                  <div class="font-mono text-lg tabular-nums">{{ geometry.instantDespawn }}</div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Chunk gate</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ SPAWNING_CHUNK_PLAYER_RADIUS }}
                  </div>
                </div>
              </div>
              <ul class="flex flex-col gap-1 text-xs text-muted-foreground">
                <li v-for="note in geometry.notes" :key="note">{{ note }}</li>
              </ul>
            </div>
          </div>

          <!-- Farm rate. -->
          <div v-else-if="tab === 'farm'" class="flex flex-col gap-4">
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <div class="flex flex-col gap-1.5">
                <Label for="mcs-spaces" class="text-xs text-muted-foreground">Spawn spaces</Label>
                <Input
                  id="mcs-spaces"
                  type="number"
                  min="0"
                  :model-value="spawnSpaces"
                  @update:model-value="spawnSpaces = clampInt($event, 0, 500000, 1536)"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="mcs-chunks" class="text-xs text-muted-foreground">Chunks spanned</Label>
                <Input
                  id="mcs-chunks"
                  type="number"
                  min="1"
                  max="289"
                  :model-value="farmChunks"
                  @update:model-value="farmChunks = clampInt($event, 1, 289, 9)"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="mcs-surface" class="text-xs text-muted-foreground"
                  >Surface Y above</Label
                >
                <Input
                  id="mcs-surface"
                  type="number"
                  min="-64"
                  max="320"
                  :model-value="surfaceY"
                  @update:model-value="surfaceY = clampInt($event, -64, 320, 100)"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="mcs-dwell" class="text-xs text-muted-foreground">Seconds to kill</Label>
                <Input
                  id="mcs-dwell"
                  type="number"
                  min="1"
                  max="3600"
                  :model-value="dwellSeconds"
                  @update:model-value="dwellSeconds = clampInt($event, 1, 3600, 30)"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="mcs-afk" class="text-xs text-muted-foreground">AFK distance</Label>
                <Input
                  id="mcs-afk"
                  type="number"
                  min="0"
                  max="300"
                  :model-value="afkDistance"
                  @update:model-value="afkDistance = clampInt($event, 0, 300, 40)"
                />
              </div>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Spawn limited</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ round(farm.spawnLimitedPerHour) }}/h
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Cap limited</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ round(farm.capLimitedPerHour) }}/h
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Bottleneck</div>
                <div class="text-lg font-medium">{{ bottleneckLabel(farm) }}</div>
              </div>
            </div>

            <div
              v-if="farm.warnings.length"
              class="rounded-[10px] bg-secondary px-3 py-2 text-xs shadow-[var(--sh-inset)]"
            >
              <p v-for="w in farm.warnings" :key="w" class="text-foreground">{{ w }}</p>
            </div>

            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <h3 class="text-sm font-medium">Where the estimate comes from</h3>
              <KeyValueGrid :rows="farmTermRows" :columns="3" surface="card" :copy="false" dense />
              <ul class="flex flex-col gap-1 text-xs text-muted-foreground">
                <li v-for="note in farm.notes" :key="note">{{ note }}</li>
              </ul>
              <p class="text-xs text-muted-foreground">
                This is a model, not a measurement. It follows the real spawn loop but does not
                check each candidate block for a valid floor, headroom, collision or spawn cost.
              </p>
            </div>
          </div>

          <!-- Spawn proofing. -->
          <div v-else class="flex flex-col gap-4">
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex w-40 flex-col gap-1.5">
                <Label for="mcs-src" class="text-xs text-muted-foreground">
                  Light source level
                </Label>
                <Input
                  id="mcs-src"
                  type="number"
                  min="0"
                  max="15"
                  :model-value="sourceLight"
                  @update:model-value="sourceLight = clampInt($event, 0, 15, 14)"
                />
              </div>
              <div class="flex w-40 flex-col gap-1.5">
                <Label for="mcs-dist" class="text-xs text-muted-foreground">
                  Blocks from the source
                </Label>
                <Input
                  id="mcs-dist"
                  type="number"
                  min="0"
                  max="20"
                  :model-value="sourceDistance"
                  @update:model-value="sourceDistance = clampInt($event, 0, 20, 7)"
                />
              </div>
              <p class="max-w-xs text-xs text-muted-foreground">
                Torch 14, lantern 15, glowstone 15, sea lantern 15, campfire 15, redstone torch 7.
              </p>
            </div>

            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <h3 class="text-sm font-medium">
                {{ proof.safe ? "This block is spawn safe" : "Monsters can still spawn here" }}
              </h3>
              <p class="text-sm">
                Block light reaching it is
                <span class="font-mono tabular-nums">{{ proof.blockLight }}</span
                >, and
                <span class="font-mono tabular-nums">{{ pct(proof.chance) }}</span>
                of spawn attempts would pass the light rule.
              </p>
              <p v-if="proof.safeRadius >= 0" class="text-sm">
                In Minecraft {{ version }} one source of level {{ sourceLight }} protects every
                block within
                <span class="font-mono tabular-nums">{{ proof.safeRadius }}</span>
                blocks of taxicab distance.
              </p>
              <p v-else class="text-sm">
                In Minecraft {{ version }} a source of level {{ sourceLight }} protects nothing at
                all, not even the block it sits on.
              </p>
              <ul class="flex flex-col gap-1 text-xs text-muted-foreground">
                <li v-for="note in proof.notes" :key="note">{{ note }}</li>
              </ul>
            </div>

            <div class="flex flex-col gap-2 rounded-[14px] border p-4">
              <h3 class="text-sm font-medium">The same source in every version</h3>
              <table class="w-full border-collapse text-sm">
                <thead>
                  <tr class="border-b text-left text-xs text-muted-foreground">
                    <th class="py-2 pr-3 font-medium">Version</th>
                    <th class="py-2 pr-3 text-right font-medium">Safe radius</th>
                    <th class="py-2 pr-3 text-right font-medium">
                      Spawn chance at {{ sourceDistance }} blocks
                    </th>
                    <th class="py-2 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in proofAcrossVersions"
                    :key="row.version"
                    class="border-b border-border/60"
                  >
                    <td class="py-2 pr-3 font-mono tabular-nums">{{ row.version }}</td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ row.safeRadius < 0 ? "none" : row.safeRadius }}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono tabular-nums">
                      {{ pct(row.chance) }}
                    </td>
                    <td class="py-2 text-xs">
                      {{ row.safe ? "Spawn safe" : "Still spawns" }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="text-xs text-muted-foreground">
                The jump between 1.16.5 and 1.18.2 is the light rule change: the older rule only
                needed brightness above 7, the newer one needs block light 0, so the same torch
                covers a much wider area.
              </p>
            </div>
          </div>

          <p class="text-xs text-muted-foreground">
            Source derived from the decompiled Minecraft {{ version }} server code, with spawn
            weights and pack sizes read from that version's own biome data. Natural spawning cannot
            be measured on a server with nobody online, so none of these numbers came from an
            in-game measurement. Not an official Minecraft product. Not approved by or associated
            with Mojang or Microsoft.
          </p>
        </template>
      </section>
    </div>
  </div>
</template>
