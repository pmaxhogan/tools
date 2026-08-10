<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft damage calculator.
 *
 * Three modes on one pure logic layer (src/tools/minecraft-damage-calculator):
 * melee vs an armor build, fall damage, and mace smash damage. The panel owns
 * only the DOM: mode tabs, the per-slot armor piece picker, live results, a
 * per-version fall comparison, and URL-fragment state so a build is
 * shareable. All math stays in the logic layer's exported functions.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  buildArmor,
  fallDamage,
  hitsToKill,
  maceDamage,
  meleeDamage,
  round2,
  safeFallHeight,
  type ArmorBuild,
} from "@/tools/minecraft-damage-calculator/index";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  HP_POOLS,
  MACE,
  VERSIONS,
  VERSION_INFO,
  WEAPON_PRESETS,
  type ArmorSlot,
  type VersionId,
} from "@/tools/minecraft-damage-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import OutputView from "../OutputView.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

type Mode = "melee" | "fall" | "mace";

const mode = ref<Mode>("melee");
const version = ref<VersionId>("1.21.11");

// melee
const weapon = ref("diamond-sword");
const amount = ref(7);
const critical = ref(false);

// armor build (shared by melee and mace targets)
const armorMode = ref<"pieces" | "raw">("pieces");
const pieces = ref<Record<ArmorSlot, { material: string; protection: number }>>({
  helmet: { material: "diamond", protection: 0 },
  chestplate: { material: "diamond", protection: 0 },
  leggings: { material: "diamond", protection: 0 },
  boots: { material: "diamond", protection: 0 },
});
const rawArmor = ref(20);
const rawToughness = ref(8);
const rawProtection = ref(0);
const resistance = ref(0);
const breach = ref(0);

// fall
const height = ref(23.5);
const featherFalling = ref(0);
const slowFalling = ref(false);

// mace
const maceFall = ref(5);
const density = ref(0);

const mounted = ref(false);

const versionInfo = computed(() => VERSION_INFO[version.value]);

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const versionSpec = computed(
  () => props.meta.options?.find((o) => o.id === "version") as SelectOptionSpec | undefined,
);

const weaponSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "weapon",
  label: "Weapon",
  default: "diamond-sword",
  options: [
    { value: "custom", label: "Custom damage", synonyms: ["manual", "raw", "amount"] },
    ...WEAPON_PRESETS.filter((w) => !w.maceOnly || versionInfo.value.mace).map((w) => ({
      value: w.id,
      label: `${w.label} (${w.damage})`,
      synonyms: [w.id.replace(/-/g, " ")],
    })),
  ],
}));

function materialSpec(slot: ArmorSlot): SelectOptionSpec {
  return {
    kind: "select",
    id: `material-${slot}`,
    label: slot,
    default: "none",
    options: [
      { value: "none", label: "None", synonyms: ["empty", "bare"] },
      ...ARMOR_MATERIALS.filter(
        (m) =>
          m.points[slot] !== null && (m.since !== "copper" || versionInfo.value.copper),
      ).map((m) => ({
        value: m.id,
        label: `${m.label} (+${m.points[slot]})`,
        synonyms: [m.id],
      })),
    ],
  };
}

const SLOT_LABELS: Record<ArmorSlot, string> = {
  helmet: "Helmet",
  chestplate: "Chestplate",
  leggings: "Leggings",
  boots: "Boots",
};

/* ---------------------------------------------------------------- */
/* derived values                                                    */
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

const armorBuild = computed(() => {
  if (armorMode.value === "raw") {
    return {
      armor: rawArmor.value,
      toughness: rawToughness.value,
      protectionLevels: rawProtection.value,
    };
  }
  const build: ArmorBuild = {};
  for (const slot of ARMOR_SLOTS) {
    const p = pieces.value[slot];
    if (p.material !== "none") build[slot] = { material: p.material, protection: p.protection };
  }
  return buildArmor(version.value, build);
});

const attackDamage = computed(() => {
  if (weapon.value === "custom") return amount.value;
  const preset = WEAPON_PRESETS.find((w) => w.id === weapon.value);
  return preset ? preset.damage : amount.value;
});

const result = computed<{ output: Record<string, string> | null; error: CalcError | null }>(() => {
  try {
    if (mode.value === "melee") {
      const dealt = critical.value ? attackDamage.value * 1.5 : attackDamage.value;
      const build = armorBuild.value;
      const r = meleeDamage({
        version: version.value,
        amount: dealt,
        armor: build.armor,
        toughness: build.toughness,
        protectionLevels: build.protectionLevels,
        resistance: resistance.value,
        breach: versionInfo.value.mace ? breach.value : 0,
      });
      const output: Record<string, string> = {
        "Damage dealt": String(round2(r.dealt)),
        "Target build": `${build.armor} armor, ${build.toughness} toughness, Protection ${build.protectionLevels}`,
        "After armor": String(round2(r.afterArmor)),
        "Damage taken": `${round2(r.taken)} (${round2(r.taken / 2)} hearts)`,
        "Reduced by": `${round2(r.reducedPercent)}%`,
      };
      for (const pool of HP_POOLS) {
        const hits = hitsToKill(r.taken, pool.hp);
        output[`Hits vs ${pool.label}`] = hits === Infinity ? "never" : String(hits);
      }
      return { output, error: null };
    }
    if (mode.value === "fall") {
      const r = fallDamage({
        version: version.value,
        height: height.value,
        featherFalling: featherFalling.value,
        slowFalling: slowFalling.value,
      });
      return {
        output: {
          "Fall distance seen by the game": `${round2(r.fallDistance)} blocks`,
          "Base damage": String(r.baseDamage),
          "Damage taken": `${round2(r.taken)} (${round2(r.taken / 2)} hearts)`,
          "Survivable at full health": r.taken < 20 ? "yes" : "no",
          "Tallest safe drop": `${round2(safeFallHeight(version.value, featherFalling.value))} blocks`,
        },
        error: null,
      };
    }
    const build = armorBuild.value;
    const r = maceDamage({
      version: version.value,
      fallDistance: maceFall.value,
      density: density.value,
      breach: breach.value,
      armor: build.armor,
      toughness: build.toughness,
      protectionLevels: build.protectionLevels,
      resistance: resistance.value,
    });
    const output: Record<string, string> = {
      "Smash attack": r.isSmash ? "yes" : `no (needs a fall over ${MACE.smashThreshold} blocks)`,
      "Damage dealt": `${round2(r.dealt)} = ${r.baseDamage} base + ${round2(r.smashBonus)} smash + ${round2(r.densityBonus)} Density`,
      "Damage taken": `${round2(r.taken)} (${round2(r.taken / 2)} hearts)`,
      "One-shots 20 HP": r.taken >= 20 ? "yes" : "no",
    };
    return { output, error: null };
  } catch (e) {
    return { output: null, error: toCalcError(e) };
  }
});

/** Fall damage across every version for the current height, for the table. */
const fallTable = computed(() => {
  if (mode.value !== "fall") return [];
  return VERSIONS.map((v) => {
    try {
      const r = fallDamage({
        version: v,
        height: height.value,
        featherFalling: featherFalling.value,
        slowFalling: slowFalling.value,
      });
      return { version: VERSION_INFO[v].label, taken: String(round2(r.taken)) };
    } catch {
      return { version: VERSION_INFO[v].label, taken: "?" };
    }
  });
});

const modes = computed<{ id: Mode; label: string }[]>(() => [
  { id: "melee", label: "Melee vs armor" },
  { id: "fall", label: "Fall damage" },
  ...(versionInfo.value.mace ? [{ id: "mace" as Mode, label: "Mace smash" }] : []),
]);

function setMode(m: Mode) {
  mode.value = m;
}

function onVersionChange(v: string) {
  version.value = v as VersionId;
  if (!VERSION_INFO[version.value].mace) {
    if (mode.value === "mace") mode.value = "melee";
    breach.value = 0;
    if (weapon.value === "mace") weapon.value = "custom";
  }
  if (!VERSION_INFO[version.value].copper) {
    for (const slot of ARMOR_SLOTS) {
      if (pieces.value[slot].material === "copper") pieces.value[slot].material = "none";
    }
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    mode,
    version,
    weapon,
    amount,
    critical,
    armorMode,
    pieces,
    rawArmor,
    rawToughness,
    rawProtection,
    resistance,
    breach,
    height,
    featherFalling,
    slowFalling,
    maceFall,
    density,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        mode: mode.value,
        version: version.value,
        weapon: weapon.value,
        amount: String(amount.value),
        crit: String(critical.value),
        armorMode: armorMode.value,
        pieces: ARMOR_SLOTS.map(
          (s) => `${pieces.value[s].material}:${pieces.value[s].protection}`,
        ).join(","),
        armor: String(rawArmor.value),
        toughness: String(rawToughness.value),
        protection: String(rawProtection.value),
        resistance: String(resistance.value),
        breach: String(breach.value),
        height: String(height.value),
        ff: String(featherFalling.value),
        slow: String(slowFalling.value),
        maceFall: String(maceFall.value),
        density: String(density.value),
      },
    });
  },
  { deep: true },
);

onMounted(() => {
  const { opts } = readFragment();
  if (opts.version && (VERSIONS as readonly string[]).includes(opts.version)) {
    version.value = opts.version as VersionId;
  }
  if (opts.mode === "melee" || opts.mode === "fall" || opts.mode === "mace") {
    if (opts.mode !== "mace" || VERSION_INFO[version.value].mace) mode.value = opts.mode;
  }
  if (opts.weapon) weapon.value = opts.weapon;
  if (opts.amount) amount.value = clampInt(opts.amount, 0, 10000, 7);
  if (opts.crit !== undefined) critical.value = opts.crit === "true";
  if (opts.armorMode === "raw" || opts.armorMode === "pieces") armorMode.value = opts.armorMode;
  if (opts.pieces) {
    const parts = opts.pieces.split(",");
    ARMOR_SLOTS.forEach((slot, i) => {
      const [material, prot] = (parts[i] ?? "").split(":");
      if (material) {
        pieces.value[slot] = { material, protection: clampInt(prot, 0, 4, 0) };
      }
    });
  }
  if (opts.armor) rawArmor.value = clampInt(opts.armor, 0, 30, 20);
  if (opts.toughness) rawToughness.value = clampInt(opts.toughness, 0, 20, 8);
  if (opts.protection) rawProtection.value = clampInt(opts.protection, 0, 16, 0);
  if (opts.resistance) resistance.value = clampInt(opts.resistance, 0, 5, 0);
  if (opts.breach) breach.value = clampInt(opts.breach, 0, 4, 0);
  if (opts.height) height.value = Math.max(0, Number(opts.height) || 23.5);
  if (opts.ff) featherFalling.value = clampInt(opts.ff, 0, 4, 0);
  if (opts.slow !== undefined) slowFalling.value = opts.slow === "true";
  if (opts.maceFall) maceFall.value = Math.max(0, Number(opts.maceFall) || 5);
  if (opts.density) density.value = clampInt(opts.density, 0, 5, 0);
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- mode + version -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Mode</span
        >
        <div class="flex flex-wrap gap-2" role="group" aria-label="Calculator mode">
          <button
            v-for="m in modes"
            :key="m.id"
            type="button"
            class="rounded-[10px] border px-3 py-1.5 text-sm transition-colors"
            :class="
              mode === m.id
                ? 'border-ring bg-accent font-semibold'
                : 'bg-secondary hover:bg-accent'
            "
            :aria-pressed="mode === m.id"
            @click="setMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div class="flex w-44 flex-col gap-1.5">
        <Label for="mc-version" class="text-xs text-muted-foreground">Version</Label>
        <SearchableSelect
          v-if="versionSpec"
          id="mc-version"
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="onVersionChange"
        />
      </div>
    </div>

    <!-- melee inputs -->
    <template v-if="mode === 'melee'">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-weapon" class="text-xs text-muted-foreground">Weapon</Label>
          <SearchableSelect
            id="mc-weapon"
            :spec="weaponSpec"
            :model-value="weapon"
            @update:model-value="(v: string) => (weapon = v)"
          />
        </div>
        <div v-if="weapon === 'custom'" class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-amount" class="text-xs text-muted-foreground">Attack damage</Label>
          <Input
            id="mc-amount"
            type="number"
            min="0"
            max="10000"
            step="0.5"
            :model-value="amount"
            @update:model-value="(v) => (amount = Number(v) || 0)"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-crit" class="w-fit cursor-pointer text-xs text-muted-foreground"
            >Critical hit (x1.5)</Label
          >
          <div class="flex h-9 items-center">
            <Switch
              id="mc-crit"
              :model-value="critical"
              @update:model-value="(v) => (critical = Boolean(v))"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- fall inputs -->
    <template v-if="mode === 'fall'">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-height" class="text-xs text-muted-foreground">Fall height (blocks)</Label>
          <Input
            id="mc-height"
            type="number"
            min="0"
            max="10000"
            step="0.5"
            :model-value="height"
            @update:model-value="(v) => (height = Math.max(0, Number(v) || 0))"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-ff" class="text-xs text-muted-foreground">Feather Falling (0 to 4)</Label>
          <Input
            id="mc-ff"
            type="number"
            min="0"
            max="4"
            step="1"
            :model-value="featherFalling"
            @update:model-value="(v) => (featherFalling = clampInt(v, 0, 4, 0))"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-slow" class="w-fit cursor-pointer text-xs text-muted-foreground"
            >Slow Falling</Label
          >
          <div class="flex h-9 items-center">
            <Switch
              id="mc-slow"
              :model-value="slowFalling"
              @update:model-value="(v) => (slowFalling = Boolean(v))"
            />
          </div>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        Landing in water, on hay bales (80% less), honey blocks (80% less), or beds (50% less)
        softens or cancels the landing; slime blocks bounce you for free. These numbers are for a
        plain solid landing.
      </p>
    </template>

    <!-- mace inputs -->
    <template v-if="mode === 'mace'">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-macefall" class="text-xs text-muted-foreground"
            >Fall distance (blocks)</Label
          >
          <Input
            id="mc-macefall"
            type="number"
            min="0"
            max="10000"
            step="0.5"
            :model-value="maceFall"
            @update:model-value="(v) => (maceFall = Math.max(0, Number(v) || 0))"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-density" class="text-xs text-muted-foreground">Density (0 to 5)</Label>
          <Input
            id="mc-density"
            type="number"
            min="0"
            max="5"
            step="1"
            :model-value="density"
            @update:model-value="(v) => (density = clampInt(v, 0, 5, 0))"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="mc-breach-mace" class="text-xs text-muted-foreground">Breach (0 to 4)</Label>
          <Input
            id="mc-breach-mace"
            type="number"
            min="0"
            max="4"
            step="1"
            :model-value="breach"
            @update:model-value="(v) => (breach = clampInt(v, 0, 4, 0))"
          />
        </div>
      </div>
    </template>

    <!-- target armor build (melee + mace) -->
    <template v-if="mode !== 'fall'">
      <div class="flex flex-col gap-3 rounded-[14px] border p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Target armor</span
          >
          <div class="flex gap-2" role="group" aria-label="Armor input mode">
            <button
              type="button"
              class="rounded-[8px] border px-2.5 py-1 text-xs transition-colors"
              :class="
                armorMode === 'pieces'
                  ? 'border-ring bg-accent font-semibold'
                  : 'bg-secondary hover:bg-accent'
              "
              :aria-pressed="armorMode === 'pieces'"
              @click="armorMode = 'pieces'"
            >
              Piece picker
            </button>
            <button
              type="button"
              class="rounded-[8px] border px-2.5 py-1 text-xs transition-colors"
              :class="
                armorMode === 'raw'
                  ? 'border-ring bg-accent font-semibold'
                  : 'bg-secondary hover:bg-accent'
              "
              :aria-pressed="armorMode === 'raw'"
              @click="armorMode = 'raw'"
            >
              Raw values
            </button>
          </div>
        </div>

        <div v-if="armorMode === 'pieces'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div
            v-for="slot in ARMOR_SLOTS"
            :key="slot"
            class="flex items-end gap-2 rounded-[10px] bg-secondary p-2.5 shadow-[var(--sh-inset)]"
          >
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <Label :for="`mc-mat-${slot}`" class="text-xs text-muted-foreground">{{
                SLOT_LABELS[slot]
              }}</Label>
              <SearchableSelect
                :id="`mc-mat-${slot}`"
                :spec="materialSpec(slot)"
                :model-value="pieces[slot].material"
                @update:model-value="(v: string) => (pieces[slot].material = v)"
              />
            </div>
            <div class="flex w-20 flex-col gap-1">
              <Label :for="`mc-prot-${slot}`" class="text-xs text-muted-foreground">Prot</Label>
              <Input
                :id="`mc-prot-${slot}`"
                type="number"
                min="0"
                max="4"
                step="1"
                :disabled="pieces[slot].material === 'none'"
                :model-value="pieces[slot].protection"
                @update:model-value="(v) => (pieces[slot].protection = clampInt(v, 0, 4, 0))"
              />
            </div>
          </div>
        </div>

        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mc-armor" class="text-xs text-muted-foreground">Armor points (0-30)</Label>
            <Input
              id="mc-armor"
              type="number"
              min="0"
              max="30"
              step="1"
              :model-value="rawArmor"
              @update:model-value="(v) => (rawArmor = clampInt(v, 0, 30, 0))"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mc-tough" class="text-xs text-muted-foreground">Toughness (0-20)</Label>
            <Input
              id="mc-tough"
              type="number"
              min="0"
              max="20"
              step="1"
              :model-value="rawToughness"
              @update:model-value="(v) => (rawToughness = clampInt(v, 0, 20, 0))"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mc-protlv" class="text-xs text-muted-foreground"
              >Protection levels (0-16)</Label
            >
            <Input
              id="mc-protlv"
              type="number"
              min="0"
              max="16"
              step="1"
              :model-value="rawProtection"
              @update:model-value="(v) => (rawProtection = clampInt(v, 0, 16, 0))"
            />
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mc-resist" class="text-xs text-muted-foreground"
              >Resistance effect (0-5)</Label
            >
            <Input
              id="mc-resist"
              type="number"
              min="0"
              max="5"
              step="1"
              :model-value="resistance"
              @update:model-value="(v) => (resistance = clampInt(v, 0, 5, 0))"
            />
          </div>
          <div v-if="mode === 'melee' && versionInfo.mace" class="flex min-w-0 flex-col gap-1.5">
            <Label for="mc-breach" class="text-xs text-muted-foreground"
              >Attacker Breach (0-4)</Label
            >
            <Input
              id="mc-breach"
              type="number"
              min="0"
              max="4"
              step="1"
              :model-value="breach"
              @update:model-value="(v) => (breach = clampInt(v, 0, 4, 0))"
            />
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          Only the plain Protection enchantment reduces melee hits (4% per level per piece). Fire,
          Blast and Projectile Protection guard their own damage types and add nothing here.
        </p>
      </div>
    </template>

    <!-- error -->
    <div
      v-if="result.error"
      class="rounded-[10px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
      role="alert"
    >
      <p class="font-medium">{{ result.error.message }}</p>
      <p v-if="result.error.fix" class="text-muted-foreground">{{ result.error.fix }}</p>
    </div>

    <!-- results -->
    <OutputView v-if="result.output" :output="result.output" />

    <!-- fall: per-version comparison -->
    <div v-if="mode === 'fall' && fallTable.length" class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >Damage by version</span
      >
      <div class="overflow-x-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <table class="w-full text-sm">
          <thead>
            <tr>
              <th
                v-for="row in fallTable"
                :key="row.version"
                scope="col"
                class="px-3 py-1.5 text-left text-xs font-semibold text-muted-foreground"
              >
                {{ row.version }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                v-for="row in fallTable"
                :key="row.version"
                class="px-3 py-1.5 font-mono tabular-nums"
                :class="row.version === versionInfo.label ? 'font-semibold text-primary' : ''"
              >
                {{ row.taken }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted-foreground">
        Versions through 1.21.1 accumulate fall distance per tick and miss the landing tick, so
        long falls register short; 1.21.2 and later measure real positions. Both eras were
        verified against live servers.
      </p>
    </div>

    <p v-if="mode === 'mace'" class="text-xs text-muted-foreground">
      Smash bonus: 4 damage per block for the first 3 blocks, 2 per block to 8, then 1 per block,
      on top of the mace's 6 attack damage. Density adds 0.5 damage per level per fallen block;
      Breach removes 15% of the target's armor effectiveness per level.
    </p>

    <p class="text-xs text-muted-foreground">
      Verified against real dedicated servers per version and decompiled game code. Not an
      official Minecraft product. Not approved by or associated with Mojang or Microsoft.
    </p>
  </div>
</template>
