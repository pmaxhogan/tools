<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft damage calculator: the matchup card.
 *
 * Attacker on the left, defender on the right, a swap button between them,
 * one big live readout (final damage, percent reduced, hearts, hits to
 * kill) and a breakdown underneath. Both sides can be a mob (curated,
 * source-derived per-version stats) or a player (custom kit builder with
 * per-piece armor, enchant applicability gating, and realistic status
 * effect sources). Fall damage and mace smashes are secondary modes of the
 * same card. Every number routes through the verified engine in
 * src/tools/minecraft-damage-calculator; the panel only owns DOM, gating,
 * and URL-fragment state. Fragment values are untrusted partial input:
 * everything read from the hash is validated, clamped, and zeroed when the
 * selected version gates it off, so stale share links cannot smuggle in
 * values the engine would reject.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ArrowLeftRight } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  matchup,
  round2,
  type ArmorBuild,
  type MatchupResult,
} from "@/tools/minecraft-damage-calculator/index";
import {
  ABSORPTION_SOURCES,
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  DIFFICULTIES,
  KIT_PRESETS,
  MOBS,
  RESISTANCE_SOURCES,
  VERSIONS,
  VERSION_INFO,
  WEAPON_ENCHANTS,
  WEAPON_PRESETS,
  mobInVersion,
  type ArmorSlot,
  type Difficulty,
  type VersionId,
  type WeaponEnchantId,
} from "@/tools/minecraft-damage-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import OutputView from "../OutputView.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

type Mode = "attack" | "fall" | "mace";
type SideKind = "mob" | "player";

const mode = ref<Mode>("attack");
const version = ref<VersionId>("1.21.11");
const difficulty = ref<Difficulty>("normal");

// attacker
const attackerKind = ref<SideKind>("mob");
const attackerMob = ref("zombie");
const weapon = ref("diamond-sword");
const weaponEnchant = ref<WeaponEnchantId>("none");
const weaponEnchantLevel = ref(0);
const strength = ref(0);
const weakness = ref(0);
const critical = ref(false);

// defender
const defenderKind = ref<SideKind>("player");
const defenderMob = ref("zombie");
const kitPreset = ref("full-diamond");
const pieces = ref<Record<ArmorSlot, { material: string; protection: number }>>({
  helmet: { material: "diamond", protection: 0 },
  chestplate: { material: "diamond", protection: 0 },
  leggings: { material: "diamond", protection: 0 },
  boots: { material: "diamond", protection: 0 },
});
const featherFalling = ref(0);
const resistanceSource = ref("none");
const absorptionSource = ref("none");

// fall mode
const fallHeight = ref(23.5);
const slowFalling = ref(false);

// mace mode
const maceFall = ref(5);
const density = ref(0);
const maceBreach = ref(0);
const maceCritical = ref(false);
const maceEnchant = ref<WeaponEnchantId>("none");
const maceEnchantLevel = ref(0);

const mounted = ref(false);

const versionInfo = computed(() => VERSION_INFO[version.value]);

/* ---------------------------------------------------------------- */
/* gating: zero anything the selected version cannot hold            */
/* ---------------------------------------------------------------- */

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

function enforceVersionGates() {
  const info = VERSION_INFO[version.value];
  if (!info.mace) {
    if (mode.value === "mace") mode.value = "attack";
    maceBreach.value = 0;
    density.value = 0;
    maceEnchant.value = "none";
    maceEnchantLevel.value = 0;
    const preset = WEAPON_PRESETS.find((w) => w.id === weapon.value);
    if (preset?.maceOnly) weapon.value = "diamond-sword";
  }
  if (!info.copper) {
    for (const slot of ARMOR_SLOTS) {
      if (pieces.value[slot].material === "copper") {
        pieces.value[slot].material = "none";
        kitPreset.value = "custom";
      }
    }
  }
  const fallbackMob = (id: string) => {
    const mob = MOBS.find((m) => m.id === id);
    return mob && mobInVersion(mob, version.value) ? id : "zombie";
  };
  attackerMob.value = fallbackMob(attackerMob.value);
  defenderMob.value = fallbackMob(defenderMob.value);
  enforceEnchantGates();
}

/** Zero enchants the current weapon cannot legally hold. */
function enforceEnchantGates() {
  const family = currentWeapon.value.family;
  if (weaponEnchant.value === "none") {
    weaponEnchantLevel.value = 0;
    return;
  }
  const swordOrAxe = family === "sword" || family === "axe";
  const maceSmiteBane =
    family === "mace" && weaponEnchant.value !== "sharpness" && versionInfo.value.mace;
  if (!swordOrAxe && !maceSmiteBane) {
    weaponEnchant.value = "none";
    weaponEnchantLevel.value = 0;
  }
  if (family === "bow") critical.value = false;
}

/* ---------------------------------------------------------------- */
/* select specs                                                      */
/* ---------------------------------------------------------------- */

const versionSpec = computed(
  () => props.meta.options?.find((o) => o.id === "version") as SelectOptionSpec | undefined,
);

const difficultySpec: SelectOptionSpec = {
  kind: "select",
  id: "difficulty",
  label: "Difficulty",
  default: "normal",
  options: [
    { value: "peaceful", label: "Peaceful", synonyms: ["no damage"] },
    { value: "easy", label: "Easy", synonyms: [] },
    { value: "normal", label: "Normal", synonyms: ["default"] },
    { value: "hard", label: "Hard", synonyms: ["1.5x"] },
  ],
};

function mobSpec(id: string): SelectOptionSpec {
  return {
    kind: "select",
    id,
    label: "Mob",
    default: "zombie",
    options: MOBS.filter((m) => mobInVersion(m, version.value)).map((m) => ({
      value: m.id,
      label: m.label,
      synonyms: [m.classification !== "none" ? m.classification : ""].filter(Boolean),
    })),
  };
}

const weaponSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-weapon",
  label: "Weapon",
  default: "diamond-sword",
  options: WEAPON_PRESETS.filter((w) => !w.maceOnly || versionInfo.value.mace).map((w) => ({
    value: w.id,
    label: `${w.label} (${w.damage})`,
    synonyms: [w.family],
  })),
}));

const currentWeapon = computed(
  () => WEAPON_PRESETS.find((w) => w.id === weapon.value) ?? WEAPON_PRESETS[0]!,
);

/** Damage enchants the current weapon can legally hold in this version. */
const allowedEnchants = computed(() => {
  const family = currentWeapon.value.family;
  return WEAPON_ENCHANTS.filter((e) => {
    if (e.id === "none") return true;
    if (family === "sword" || family === "axe") return true;
    if (family === "mace" && e.id !== "sharpness") return versionInfo.value.mace;
    return false;
  });
});

const enchantSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "mc-ench",
  label: "Damage enchant",
  default: "none",
  options: allowedEnchants.value.map((e) => ({
    value: e.id,
    label: e.label,
    synonyms: e.id === "bane" ? ["bane of arthropods"] : [],
  })),
}));

function materialSpec(slot: ArmorSlot): SelectOptionSpec {
  return {
    kind: "select",
    id: `mc-mat-${slot}`,
    label: slot,
    default: "none",
    options: [
      { value: "none", label: "None", synonyms: ["empty", "bare"] },
      ...ARMOR_MATERIALS.filter(
        (m) => m.points[slot] !== null && (m.since !== "copper" || versionInfo.value.copper),
      ).map((m) => ({
        value: m.id,
        label: `${m.label} (+${m.points[slot]})`,
        synonyms: [m.id],
      })),
    ],
  };
}

const kitPresetSpec: SelectOptionSpec = {
  kind: "select",
  id: "mc-kit",
  label: "Kit",
  default: "full-diamond",
  options: [
    { value: "custom", label: "Custom kit", synonyms: ["manual"] },
    ...KIT_PRESETS.map((k) => ({ value: k.id, label: k.label, synonyms: [k.material] })),
  ],
};

const resistanceSpec: SelectOptionSpec = {
  kind: "select",
  id: "mc-res",
  label: "Resistance source",
  default: "none",
  options: RESISTANCE_SOURCES.map((r) => ({
    value: r.id,
    label: r.label,
    synonyms: r.id.startsWith("turtle") ? ["turtle master potion"] : [],
  })),
};

const absorptionSpec: SelectOptionSpec = {
  kind: "select",
  id: "mc-abs",
  label: "Golden apple",
  default: "none",
  options: ABSORPTION_SOURCES.map((a) => ({
    value: a.id,
    label: a.label,
    synonyms: a.id === "egapple" ? ["notch apple", "god apple"] : a.id === "gapple" ? ["gapple"] : [],
  })),
};

const SLOT_LABELS: Record<ArmorSlot, string> = {
  helmet: "Helmet",
  chestplate: "Chestplate",
  leggings: "Leggings",
  boots: "Boots",
};

/* ---------------------------------------------------------------- */
/* kit presets                                                       */
/* ---------------------------------------------------------------- */

function applyKitPreset(id: string) {
  kitPreset.value = id;
  const preset = KIT_PRESETS.find((k) => k.id === id);
  if (!preset) return;
  for (const slot of ARMOR_SLOTS) {
    pieces.value[slot] = { material: preset.material, protection: preset.protection };
  }
}

function onPieceEdit() {
  kitPreset.value = "custom";
}

/* ---------------------------------------------------------------- */
/* swap                                                              */
/* ---------------------------------------------------------------- */

const swapEnabled = computed(() => mode.value === "attack");

/**
 * Swap who is attacking: the sides exchange kinds and mob picks. The
 * weapon loadout stays with the "player as attacker" role and the kit with
 * the "player as defender" role, so a zombie vs kit matchup becomes the
 * kitted player striking the zombie. For mob vs mob the interesting part
 * is what disappears: difficulty scaling only exists for player defenders
 * (Player#hurtServer), and the defender mob's own armor starts to matter
 * (a zombie defends with its 2 armor points).
 */
function swapSides() {
  if (!swapEnabled.value) return;
  const ak = attackerKind.value;
  const am = attackerMob.value;
  attackerKind.value = defenderKind.value;
  attackerMob.value = defenderMob.value;
  defenderKind.value = ak;
  defenderMob.value = am;
}

/* ---------------------------------------------------------------- */
/* result                                                            */
/* ---------------------------------------------------------------- */

const effectiveResistance = computed(() => {
  const source = RESISTANCE_SOURCES.find((r) => r.id === resistanceSource.value);
  const apple = ABSORPTION_SOURCES.find((a) => a.id === absorptionSource.value);
  return Math.max(source?.level ?? 0, apple?.resistanceBonus ?? 0);
});

const absorptionPoints = computed(
  () => ABSORPTION_SOURCES.find((a) => a.id === absorptionSource.value)?.points ?? 0,
);

const kitBuild = computed<ArmorBuild>(() => {
  const build: ArmorBuild = {};
  for (const slot of ARMOR_SLOTS) {
    const p = pieces.value[slot];
    if (p.material !== "none") build[slot] = { material: p.material, protection: p.protection };
  }
  return build;
});

interface CalcError {
  message: string;
  fix?: string;
}

const result = computed<{ r: MatchupResult | null; error: CalcError | null }>(() => {
  try {
    const defender =
      defenderKind.value === "mob"
        ? { kind: "mob" as const, mobId: defenderMob.value }
        : {
            kind: "player" as const,
            kit: {
              build: kitBuild.value,
              featherFalling: mode.value === "fall" ? featherFalling.value : 0,
              resistance: effectiveResistance.value,
              absorption: absorptionPoints.value,
            },
          };
    if (mode.value === "fall") {
      return {
        r: matchup({
          version: version.value,
          mode: "fall",
          fall: { height: fallHeight.value, slowFalling: slowFalling.value },
          defender,
        }),
        error: null,
      };
    }
    if (mode.value === "mace") {
      return {
        r: matchup({
          version: version.value,
          mode: "mace",
          mace: {
            fallDistance: maceFall.value,
            density: density.value,
            breach: maceBreach.value,
            critical: maceCritical.value,
            enchant: maceEnchant.value,
            enchantLevel: maceEnchantLevel.value,
          },
          defender,
        }),
        error: null,
      };
    }
    const attacker =
      attackerKind.value === "mob"
        ? { kind: "mob" as const, mobId: attackerMob.value }
        : {
            kind: "player" as const,
            weaponDamage: currentWeapon.value.damage,
            weaponFamily: currentWeapon.value.family,
            strength: strength.value,
            weakness: weakness.value,
            critical: critical.value,
            enchant: weaponEnchant.value,
            enchantLevel: weaponEnchantLevel.value,
          };
    return {
      r: matchup({
        version: version.value,
        difficulty: difficulty.value,
        mode: "attack",
        attacker,
        defender,
      }),
      error: null,
    };
  } catch (e) {
    const error =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
    return { r: null, error };
  }
});

const breakdownRecord = computed<Record<string, string>>(() => {
  const r = result.value.r;
  if (!r) return {};
  const out: Record<string, string> = {};
  for (const line of r.breakdown) out[line.label] = line.value;
  out["Damage dealt"] =
    r.dealtMin !== r.dealtMax
      ? `${round2(r.dealtMin)} to ${round2(r.dealtMax)} (avg ${round2(r.dealt)})`
      : String(round2(r.dealt));
  out["Damage taken"] =
    r.takenMin !== r.takenMax
      ? `${round2(r.takenMin)} to ${round2(r.takenMax)} (avg ${round2(r.taken)})`
      : String(round2(r.taken));
  if (r.absorbed > 0) out["Soaked by Absorption"] = String(round2(r.absorbed));
  out["Health lost"] = `${round2(r.healthLost)} (${round2(r.healthLost / 2)} hearts)`;
  out["Hits to kill"] =
    r.hits === Infinity
      ? "never"
      : `${r.hits} vs ${r.defenderHp} HP${r.defenderAbsorption > 0 ? ` + ${r.defenderAbsorption} absorption` : ""}`;
  return out;
});

const showDifficulty = computed(() => mode.value === "attack" && attackerKind.value === "mob");

const modes = computed<{ id: Mode; label: string }[]>(() => [
  { id: "attack", label: "Attack" },
  { id: "fall", label: "Fall damage" },
  ...(versionInfo.value.mace ? [{ id: "mace" as Mode, label: "Mace smash" }] : []),
]);

function onVersionChange(v: string) {
  if ((VERSIONS as readonly string[]).includes(v)) version.value = v as VersionId;
  enforceVersionGates();
}

/* ---------------------------------------------------------------- */
/* URL fragment: shareable matchup (rule 6, never localStorage)      */
/* ---------------------------------------------------------------- */

watch(
  [
    mode,
    version,
    difficulty,
    attackerKind,
    attackerMob,
    weapon,
    weaponEnchant,
    weaponEnchantLevel,
    strength,
    weakness,
    critical,
    defenderKind,
    defenderMob,
    kitPreset,
    pieces,
    featherFalling,
    resistanceSource,
    absorptionSource,
    fallHeight,
    slowFalling,
    maceFall,
    density,
    maceBreach,
    maceCritical,
    maceEnchant,
    maceEnchantLevel,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        mode: mode.value,
        v: version.value,
        d: difficulty.value,
        ak: attackerKind.value,
        am: attackerMob.value,
        w: weapon.value,
        we: weaponEnchant.value,
        wel: String(weaponEnchantLevel.value),
        str: String(strength.value),
        weak: String(weakness.value),
        crit: String(critical.value),
        dk: defenderKind.value,
        dm: defenderMob.value,
        kit: kitPreset.value,
        pieces: ARMOR_SLOTS.map(
          (s) => `${pieces.value[s].material}:${pieces.value[s].protection}`,
        ).join(","),
        ff: String(featherFalling.value),
        res: resistanceSource.value,
        abs: absorptionSource.value,
        fh: String(fallHeight.value),
        sf: String(slowFalling.value),
        mf: String(maceFall.value),
        den: String(density.value),
        mb: String(maceBreach.value),
        mc: String(maceCritical.value),
        me: maceEnchant.value,
        mel: String(maceEnchantLevel.value),
      },
    });
  },
  { deep: true },
);

/** Every fragment value is untrusted; validate, clamp, and gate it all. */
onMounted(() => {
  const { opts } = readFragment() as { opts: Partial<Record<string, string>> };
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined =>
    allowed.includes(value as T) ? (value as T) : undefined;

  version.value = pick(opts.v, VERSIONS) ?? "1.21.11";
  mode.value = pick(opts.mode, ["attack", "fall", "mace"] as const) ?? "attack";
  difficulty.value = pick(opts.d, DIFFICULTIES) ?? "normal";
  attackerKind.value = pick(opts.ak, ["mob", "player"] as const) ?? "mob";
  defenderKind.value = pick(opts.dk, ["mob", "player"] as const) ?? "player";
  if (opts.am && MOBS.some((m) => m.id === opts.am)) attackerMob.value = opts.am;
  if (opts.dm && MOBS.some((m) => m.id === opts.dm)) defenderMob.value = opts.dm;
  if (opts.w && WEAPON_PRESETS.some((w) => w.id === opts.w)) weapon.value = opts.w;
  weaponEnchant.value =
    pick(opts.we, ["none", "sharpness", "smite", "bane"] as const) ?? "none";
  weaponEnchantLevel.value = clampInt(opts.wel, 0, 5, 0);
  strength.value = clampInt(opts.str, 0, 2, 0);
  weakness.value = clampInt(opts.weak, 0, 1, 0);
  critical.value = opts.crit === "true";
  kitPreset.value =
    opts.kit === "custom" || KIT_PRESETS.some((k) => k.id === opts.kit)
      ? (opts.kit as string)
      : kitPreset.value;
  if (opts.pieces) {
    const parts = opts.pieces.split(",");
    ARMOR_SLOTS.forEach((slot, i) => {
      const [material, prot] = (parts[i] ?? "").split(":");
      const known = material === "none" || ARMOR_MATERIALS.some((m) => m.id === material);
      if (material && known) {
        pieces.value[slot] = { material, protection: clampInt(prot, 0, 4, 0) };
      }
    });
  }
  featherFalling.value = clampInt(opts.ff, 0, 4, 0);
  resistanceSource.value =
    RESISTANCE_SOURCES.some((r) => r.id === opts.res) ? (opts.res as string) : "none";
  absorptionSource.value =
    ABSORPTION_SOURCES.some((a) => a.id === opts.abs) ? (opts.abs as string) : "none";
  fallHeight.value = Math.min(Math.max(Number(opts.fh) || 23.5, 0), 10000);
  slowFalling.value = opts.sf === "true";
  maceFall.value = Math.min(Math.max(Number(opts.mf) || 5, 0), 10000);
  density.value = clampInt(opts.den, 0, 5, 0);
  maceBreach.value = clampInt(opts.mb, 0, 4, 0);
  maceCritical.value = opts.mc === "true";
  maceEnchant.value = pick(opts.me, ["none", "smite", "bane"] as const) ?? "none";
  maceEnchantLevel.value = clampInt(opts.mel, 0, 5, 0);

  enforceVersionGates();
  mounted.value = true;
});

watch(weapon, enforceEnchantGates);
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- mode / version / difficulty -->
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
              mode === m.id ? 'border-ring bg-accent font-semibold' : 'bg-secondary hover:bg-accent'
            "
            :aria-pressed="mode === m.id"
            @click="mode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div class="flex flex-wrap gap-3">
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="mc-version" class="text-xs text-muted-foreground">Version</Label>
          <SearchableSelect
            v-if="versionSpec"
            id="mc-version"
            :spec="versionSpec"
            :model-value="version"
            @update:model-value="onVersionChange"
          />
        </div>
        <div v-if="showDifficulty" class="flex w-36 flex-col gap-1.5">
          <Label for="mc-difficulty" class="text-xs text-muted-foreground">Difficulty</Label>
          <SearchableSelect
            id="mc-difficulty"
            :spec="difficultySpec"
            :model-value="difficulty"
            @update:model-value="(v: string) => (difficulty = v as Difficulty)"
          />
        </div>
      </div>
    </div>

    <!-- the matchup -->
    <div class="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr]">
      <!-- attacker -->
      <section
        class="flex flex-col gap-3 rounded-[14px] border p-4"
        aria-label="Attacker"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ mode === "fall" ? "The fall" : mode === "mace" ? "Mace smash" : "Attacker" }}
          </span>
          <div v-if="mode === 'attack'" class="flex gap-1.5" role="group" aria-label="Attacker type">
            <button
              v-for="k in ['mob', 'player'] as const"
              :key="k"
              type="button"
              class="rounded-[8px] border px-2.5 py-1 text-xs capitalize transition-colors"
              :class="
                attackerKind === k
                  ? 'border-ring bg-accent font-semibold'
                  : 'bg-secondary hover:bg-accent'
              "
              :aria-pressed="attackerKind === k"
              @click="attackerKind = k"
            >
              {{ k }}
            </button>
          </div>
        </div>

        <!-- fall parameters -->
        <template v-if="mode === 'fall'">
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mc-height" class="text-xs text-muted-foreground"
                >Fall height (blocks)</Label
              >
              <Input
                id="mc-height"
                type="number"
                min="0"
                max="10000"
                step="0.5"
                :model-value="fallHeight"
                @update:model-value="(v) => (fallHeight = Math.max(0, Number(v) || 0))"
              />
            </div>
            <div class="flex items-center gap-2">
              <Switch
                id="mc-slow"
                :model-value="slowFalling"
                @update:model-value="(v) => (slowFalling = Boolean(v))"
              />
              <Label for="mc-slow" class="cursor-pointer text-xs text-muted-foreground"
                >Slow Falling</Label
              >
            </div>
            <p class="text-xs text-muted-foreground">
              Water, slime blocks, and (since 1.19) powder snow cancel the landing; hay bales and
              honey blocks cut it by 80%, beds by 50%. These numbers are a plain solid landing.
            </p>
          </div>
        </template>

        <!-- mace parameters -->
        <template v-else-if="mode === 'mace'">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mc-macefall" class="text-xs text-muted-foreground"
                >Fall distance</Label
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
            <div class="flex flex-col gap-1.5">
              <Label for="mc-density" class="text-xs text-muted-foreground">Density (0-5)</Label>
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
            <div class="flex flex-col gap-1.5">
              <Label for="mc-breach" class="text-xs text-muted-foreground">Breach (0-4)</Label>
              <Input
                id="mc-breach"
                type="number"
                min="0"
                max="4"
                step="1"
                :model-value="maceBreach"
                @update:model-value="(v) => (maceBreach = clampInt(v, 0, 4, 0))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mc-mace-ench" class="text-xs text-muted-foreground"
                >Smite or Bane</Label
              >
              <div class="flex gap-2">
                <SearchableSelect
                  id="mc-mace-ench"
                  :spec="{
                    kind: 'select',
                    id: 'mc-mace-ench',
                    label: 'Mace enchant',
                    default: 'none',
                    options: [
                      { value: 'none', label: 'None', synonyms: [] },
                      { value: 'smite', label: 'Smite', synonyms: ['undead'] },
                      { value: 'bane', label: 'Bane', synonyms: ['arthropods'] },
                    ],
                  }"
                  :model-value="maceEnchant"
                  class="min-w-0 flex-1"
                  @update:model-value="(v: string) => (maceEnchant = v as WeaponEnchantId)"
                />
                <Input
                  aria-label="Mace enchant level"
                  type="number"
                  min="0"
                  max="5"
                  step="1"
                  class="w-16"
                  :disabled="maceEnchant === 'none'"
                  :model-value="maceEnchantLevel"
                  @update:model-value="(v) => (maceEnchantLevel = clampInt(v, 0, 5, 0))"
                />
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Switch
              id="mc-mace-crit"
              :model-value="maceCritical"
              @update:model-value="(v) => (maceCritical = Boolean(v))"
            />
            <Label for="mc-mace-crit" class="cursor-pointer text-xs text-muted-foreground"
              >Critical hit (x1.5; falling smashes usually crit)</Label
            >
          </div>
        </template>

        <!-- mob attacker -->
        <template v-else-if="attackerKind === 'mob'">
          <div class="flex flex-col gap-1.5">
            <Label for="mc-atk-mob" class="text-xs text-muted-foreground">Mob</Label>
            <SearchableSelect
              id="mc-atk-mob"
              :spec="mobSpec('mc-atk-mob')"
              :model-value="attackerMob"
              @update:model-value="(v: string) => (attackerMob = v)"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            Mob stats are read from the decompiled server code for each version. Difficulty scaling
            applies only when the defender is a player.
          </p>
        </template>

        <!-- player attacker -->
        <template v-else>
          <div class="flex flex-col gap-1.5">
            <Label for="mc-weapon" class="text-xs text-muted-foreground">Weapon</Label>
            <SearchableSelect
              id="mc-weapon"
              :spec="weaponSpec"
              :model-value="weapon"
              @update:model-value="(v: string) => (weapon = v)"
            />
          </div>
          <div class="flex gap-2">
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label for="mc-ench" class="text-xs text-muted-foreground">Damage enchant</Label>
              <SearchableSelect
                id="mc-ench"
                :spec="enchantSpec"
                :model-value="weaponEnchant"
                @update:model-value="(v: string) => (weaponEnchant = v as WeaponEnchantId)"
              />
            </div>
            <div class="flex w-16 flex-col gap-1.5">
              <Label for="mc-ench-lvl" class="text-xs text-muted-foreground">Level</Label>
              <Input
                id="mc-ench-lvl"
                type="number"
                min="0"
                max="5"
                step="1"
                :disabled="weaponEnchant === 'none'"
                :model-value="weaponEnchantLevel"
                @update:model-value="(v) => (weaponEnchantLevel = clampInt(v, 0, 5, 0))"
              />
            </div>
          </div>
          <p
            v-if="currentWeapon.family === 'bow'"
            class="text-xs text-muted-foreground"
          >
            Bows cannot hold Sharpness, Smite, or Bane, and arrow crits are random, so the crit
            toggle is off for the bow.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <Label for="mc-str" class="text-xs text-muted-foreground"
                >Strength (potion or beacon, 0-2)</Label
              >
              <Input
                id="mc-str"
                type="number"
                min="0"
                max="2"
                step="1"
                :model-value="strength"
                @update:model-value="(v) => (strength = clampInt(v, 0, 2, 0))"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="mc-weak" class="text-xs text-muted-foreground">Weakness (0-1)</Label>
              <Input
                id="mc-weak"
                type="number"
                min="0"
                max="1"
                step="1"
                :model-value="weakness"
                @update:model-value="(v) => (weakness = clampInt(v, 0, 1, 0))"
              />
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Switch
              id="mc-crit"
              :disabled="currentWeapon.family === 'bow'"
              :model-value="critical"
              @update:model-value="(v) => (critical = Boolean(v))"
            />
            <Label for="mc-crit" class="cursor-pointer text-xs text-muted-foreground"
              >Critical hit (x1.5 on the attribute, enchants excluded)</Label
            >
          </div>
        </template>
      </section>

      <!-- swap -->
      <div class="flex items-center justify-center">
        <Button
          variant="outline"
          size="icon"
          :disabled="!swapEnabled"
          :title="
            swapEnabled
              ? 'Swap attacker and defender'
              : 'Swap applies to attack mode; falls and smashes only go one way'
          "
          aria-label="Swap attacker and defender"
          @click="swapSides"
        >
          <ArrowLeftRight class="size-4" />
        </Button>
      </div>

      <!-- defender -->
      <section class="flex flex-col gap-3 rounded-[14px] border p-4" aria-label="Defender">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Defender</span
          >
          <div class="flex gap-1.5" role="group" aria-label="Defender type">
            <button
              v-for="k in ['mob', 'player'] as const"
              :key="k"
              type="button"
              class="rounded-[8px] border px-2.5 py-1 text-xs capitalize transition-colors"
              :class="
                defenderKind === k
                  ? 'border-ring bg-accent font-semibold'
                  : 'bg-secondary hover:bg-accent'
              "
              :aria-pressed="defenderKind === k"
              @click="defenderKind = k"
            >
              {{ k }}
            </button>
          </div>
        </div>

        <template v-if="defenderKind === 'mob'">
          <div class="flex flex-col gap-1.5">
            <Label for="mc-def-mob" class="text-xs text-muted-foreground">Mob</Label>
            <SearchableSelect
              id="mc-def-mob"
              :spec="mobSpec('mc-def-mob')"
              :model-value="defenderMob"
              @update:model-value="(v: string) => (defenderMob = v)"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            Mob defenders use their real HP and armor attribute (a zombie has 2 armor points) and
            never receive difficulty-scaled damage.
          </p>
        </template>

        <template v-else>
          <div class="flex flex-col gap-1.5">
            <Label for="mc-kit" class="text-xs text-muted-foreground">Kit</Label>
            <SearchableSelect
              id="mc-kit"
              :spec="kitPresetSpec"
              :model-value="kitPreset"
              @update:model-value="applyKitPreset"
            />
          </div>
          <div class="grid grid-cols-1 gap-2">
            <div
              v-for="slot in ARMOR_SLOTS"
              :key="slot"
              class="flex items-end gap-2 rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
            >
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <Label :for="`mc-mat-${slot}`" class="text-xs text-muted-foreground">{{
                  SLOT_LABELS[slot]
                }}</Label>
                <SearchableSelect
                  :id="`mc-mat-${slot}`"
                  :spec="materialSpec(slot)"
                  :model-value="pieces[slot].material"
                  @update:model-value="
                    (v: string) => {
                      pieces[slot].material = v;
                      onPieceEdit();
                    }
                  "
                />
              </div>
              <div class="flex w-16 flex-col gap-1">
                <Label :for="`mc-prot-${slot}`" class="text-xs text-muted-foreground">Prot</Label>
                <Input
                  :id="`mc-prot-${slot}`"
                  type="number"
                  min="0"
                  max="4"
                  step="1"
                  :disabled="pieces[slot].material === 'none'"
                  :model-value="pieces[slot].protection"
                  @update:model-value="
                    (v) => {
                      pieces[slot].protection = clampInt(v, 0, 4, 0);
                      onPieceEdit();
                    }
                  "
                />
              </div>
              <div v-if="slot === 'boots' && mode === 'fall'" class="flex w-16 flex-col gap-1">
                <Label for="mc-ff" class="text-xs text-muted-foreground">FF</Label>
                <Input
                  id="mc-ff"
                  type="number"
                  min="0"
                  max="4"
                  step="1"
                  title="Feather Falling (boots only)"
                  :model-value="featherFalling"
                  @update:model-value="(v) => (featherFalling = clampInt(v, 0, 4, 0))"
                />
              </div>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="mc-res" class="text-xs text-muted-foreground">Resistance source</Label>
              <SearchableSelect
                id="mc-res"
                :spec="resistanceSpec"
                :model-value="resistanceSource"
                @update:model-value="(v: string) => (resistanceSource = v)"
              />
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="mc-abs" class="text-xs text-muted-foreground">Golden apple</Label>
              <SearchableSelect
                id="mc-abs"
                :spec="absorptionSpec"
                :model-value="absorptionSource"
                @update:model-value="(v: string) => (absorptionSource = v)"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Only plain Protection reduces these hits (Feather Falling joins in for falls, on boots
            only). Fire, Blast, and Projectile Protection guard other damage types and are not
            modeled here.
          </p>
        </template>
      </section>
    </div>

    <!-- error -->
    <div
      v-if="result.error"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      role="alert"
    >
      <p class="font-medium text-destructive">{{ result.error.message }}</p>
      <p v-if="result.error.fix" class="text-muted-foreground">{{ result.error.fix }}</p>
    </div>

    <!-- readout -->
    <div v-if="result.r" class="flex flex-col gap-3" aria-live="polite">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-[14px] border bg-card p-3 text-center shadow-[var(--sh-sm)]">
          <p class="text-xs text-muted-foreground">Damage taken</p>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ round2(result.r.taken) }}
          </p>
          <p
            v-if="result.r.takenMin !== result.r.takenMax"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ round2(result.r.takenMin) }} to {{ round2(result.r.takenMax) }}
          </p>
        </div>
        <div class="rounded-[14px] border bg-card p-3 text-center shadow-[var(--sh-sm)]">
          <p class="text-xs text-muted-foreground">Hearts</p>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ round2(result.r.taken / 2) }}
          </p>
        </div>
        <div class="rounded-[14px] border bg-card p-3 text-center shadow-[var(--sh-sm)]">
          <p class="text-xs text-muted-foreground">Reduced by</p>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ round2(result.r.reducedPercent) }}%
          </p>
        </div>
        <div class="rounded-[14px] border bg-card p-3 text-center shadow-[var(--sh-sm)]">
          <p class="text-xs text-muted-foreground">Hits to kill</p>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ result.r.hits === Infinity ? "never" : result.r.hits }}
          </p>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            vs {{ result.r.defenderHp }} HP{{
              result.r.defenderAbsorption > 0 ? ` + ${result.r.defenderAbsorption} abs` : ""
            }}
          </p>
        </div>
      </div>

      <OutputView :output="breakdownRecord" />
    </div>

    <p class="text-xs text-muted-foreground">
      Armor, Protection, and Resistance math is measured against real dedicated servers per
      version; mob stats and effect semantics are derived from decompiled or unobfuscated game
      code.
      <span>Not an official Minecraft product.</span>
      <span>Not approved by or associated with Mojang or Microsoft.</span>
    </p>
  </div>
</template>
