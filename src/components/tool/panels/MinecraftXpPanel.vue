<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft XP calculator.
 *
 * Composes the pure logic layer (src/tools/minecraft-xp-calculator): a
 * bidirectional level/XP converter, an every-level SVG curve of total XP
 * across the selected range, a full kill planner table over all XP sources,
 * a weighted multi-source mixture with authoritative presets, and the
 * "source tool has Mending" sustainability sub-card. All math lives in the
 * logic layer; the panel owns only DOM, fragment state, and layout.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  levelFromTotalXp,
  MAX_LEVEL,
  MAX_TOTAL_XP,
  planMixture,
  sustainability,
  totalXpAtLevel,
  xpToNextLevel,
  type MixtureEntry,
  type SustainResult,
} from "@/tools/minecraft-xp-calculator/index";
import {
  MATERIALS,
  MATERIAL_BY_ID,
  MAX_FIRE_ASPECT,
  MAX_UNBREAKING,
  MIXTURE_PRESETS,
  presetWeights,
  TOOL_FAMILIES,
  TOOL_FAMILY_BY_ID,
  VERSIONS,
  XP_SOURCES,
  XP_SOURCE_BY_ID,
  type SourceKind,
  type VersionId,
} from "@/tools/minecraft-xp-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import OutputView from "../OutputView.vue";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

type ConvMode = "levels" | "xp";

const version = ref<VersionId>("1.21.11");
const convMode = ref<ConvMode>("levels");
const fromLevel = ref(0);
const toLevel = ref(30);
const totalXp = ref(1395);

// mixture
const sourceKind = ref<Exclude<SourceKind, "other">>("mob");
const selection = ref<Record<string, number>>({ zombie: 1 });

// mending sustainability sub-card
const mendingOn = ref(false);
const family = ref("sword");
const material = ref("diamond");
const toolDurability = ref(1561);
const durabilityTouched = ref(false);
const unbreaking = ref(0);
const damageEnchant = ref<"none" | "sharpness" | "smite" | "bane">("none");
const damageLevel = ref(5);
const fireAspect = ref(0);
const fireFreeHp = ref(3);

const mounted = ref(false);

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), lo), hi);
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
  id: "version",
  label: "Version",
  default: "1.21.11",
  options: VERSIONS.map((v) => ({
    value: v,
    label: v === "26.2" ? "26.2 (latest)" : v,
    synonyms: [v.replace(/\./g, " ")],
  })),
};

const familySpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "family",
  label: "Tool",
  default: "sword",
  options: TOOL_FAMILIES.map((f) => ({
    value: f.id,
    label: f.label,
    synonyms: [f.acts === "mob" ? "weapon" : "mining tool"],
  })),
}));

const materialSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "material",
  label: "Material",
  default: "diamond",
  options: MATERIALS.filter((m) => !m.availableIn || m.availableIn.includes(version.value)).map(
    (m) => ({
      value: m.id,
      label: `${m.label} (${fmt(m.durability)} durability)`,
      synonyms: [m.id],
    }),
  ),
}));

const damageEnchantSpec: SelectOptionSpec = {
  kind: "select",
  id: "damageEnchant",
  label: "Damage enchantment",
  default: "none",
  options: [
    { value: "none", label: "None", synonyms: ["no enchant"] },
    { value: "sharpness", label: "Sharpness", synonyms: ["sharp"] },
    { value: "smite", label: "Smite", synonyms: ["undead damage"] },
    { value: "bane", label: "Bane of Arthropods", synonyms: ["bane", "arthropod damage"] },
  ],
};

const presetSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "preset",
  label: "Preset",
  default: "",
  options: [
    { value: "", label: "Custom weights", synonyms: ["manual", "none"] },
    ...MIXTURE_PRESETS.filter(
      (p) =>
        p.kind === sourceKind.value && presetWeights(p, version.value) !== null,
    ).map((p) => ({
      value: p.id,
      label: p.approximate ? `${p.label} (approximate)` : p.label,
      synonyms: [p.id.replace(/_/g, " ")],
    })),
  ],
}));

/* ---------------------------------------------------------------- */
/* converter                                                         */
/* ---------------------------------------------------------------- */

function swapModes() {
  if (convMode.value === "levels") {
    totalXp.value = totalXpAtLevel(toLevel.value);
    convMode.value = "xp";
  } else {
    const level = levelFromTotalXp(totalXp.value);
    fromLevel.value = 0;
    toLevel.value = Math.min(level, MAX_LEVEL);
    convMode.value = "levels";
  }
}

const converter = computed<Record<string, string>>(() => {
  if (convMode.value === "levels") {
    const a = fromLevel.value;
    const b = toLevel.value;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const delta = totalXpAtLevel(hi) - totalXpAtLevel(lo);
    return {
      [`Total XP at level ${fmt(lo)}`]: `${fmt(totalXpAtLevel(lo))} points`,
      [`Total XP at level ${fmt(hi)}`]: `${fmt(totalXpAtLevel(hi))} points`,
      [`XP between levels ${fmt(lo)} and ${fmt(hi)}`]: `${fmt(delta)} points`,
      [`Next level up from ${fmt(lo)}`]: `${fmt(xpToNextLevel(lo))} points`,
    };
  }
  const xp = totalXp.value;
  const level = levelFromTotalXp(xp);
  const into = xp - totalXpAtLevel(level);
  const need = xpToNextLevel(level);
  return {
    "Total XP": `${fmt(xp)} points`,
    Level: fmt(level),
    "Progress into level": `${fmt(into)} of ${fmt(need)} points (${Math.floor((into / need) * 100)}%)`,
    [`XP to reach level ${fmt(level + 1)}`]: `${fmt(need - into)} points`,
  };
});

/** XP the planner and sustainability target: the selected level climb. */
const xpNeeded = computed(() => {
  if (convMode.value === "levels") {
    const lo = Math.min(fromLevel.value, toLevel.value);
    const hi = Math.max(fromLevel.value, toLevel.value);
    return totalXpAtLevel(hi) - totalXpAtLevel(lo);
  }
  return totalXp.value;
});

/* ---------------------------------------------------------------- */
/* chart: total XP for EVERY level in the selected range             */
/* ---------------------------------------------------------------- */

const CHART_H = 220;
const PAD = { left: 64, right: 16, top: 14, bottom: 30 };

const chartRange = computed<{ a: number; b: number }>(() => {
  if (convMode.value === "levels") {
    const lo = Math.min(fromLevel.value, toLevel.value);
    const hi = Math.max(fromLevel.value, toLevel.value);
    return hi > lo ? { a: lo, b: hi } : { a: lo, b: lo + 1 };
  }
  const level = levelFromTotalXp(totalXp.value);
  return { a: 0, b: Math.max(1, level) };
});

const chart = computed(() => {
  const { a, b } = chartRange.value;
  const n = b - a + 1;
  const innerW = Math.max(480, Math.min(4000, (n - 1) * 8));
  const width = innerW + PAD.left + PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const yMax = Math.max(1, totalXpAtLevel(b));
  const yMin = totalXpAtLevel(a);
  const span = Math.max(1, yMax - yMin);
  const pts: string[] = [];
  for (let level = a; level <= b; level++) {
    const x = PAD.left + ((level - a) / (n - 1)) * innerW;
    const y = PAD.top + innerH - ((totalXpAtLevel(level) - yMin) / span) * innerH;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const xTicks: { x: number; label: string }[] = [];
  const tickCount = Math.min(6, n);
  for (let i = 0; i < tickCount; i++) {
    const level = Math.round(a + (i / Math.max(1, tickCount - 1)) * (b - a));
    xTicks.push({ x: PAD.left + ((level - a) / (n - 1)) * innerW, label: fmt(level) });
  }
  const yTicks: { y: number; label: string }[] = [0, 0.5, 1].map((f) => ({
    y: PAD.top + innerH - f * innerH,
    label: fmt(Math.round(yMin + f * span)),
  }));
  return { width, points: pts.join(" "), xTicks, yTicks, a, b, yMax, baseY: PAD.top + innerH };
});

/* ---------------------------------------------------------------- */
/* kill planner table: every source                                  */
/* ---------------------------------------------------------------- */

const plannerRows = computed(() =>
  XP_SOURCES.map((s) => {
    const xp = xpNeeded.value;
    const avg = xp <= 0 ? 0 : Math.ceil(xp / s.mean);
    const per = s.min === s.max ? `${fmt(s.mean)}` : `${s.min} to ${s.max} (avg ${fmt(s.mean)})`;
    let guaranteed: string;
    if (s.min === s.max) guaranteed = fmt(avg);
    else if (s.min > 0) guaranteed = fmt(xp <= 0 ? 0 : Math.ceil(xp / s.min));
    else guaranteed = "none (can drop 0)";
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      unit: s.unitPlural,
      per,
      avg: fmt(avg),
      guaranteed,
      selected: selection.value[s.id] !== undefined,
    };
  }),
);

/* ---------------------------------------------------------------- */
/* mixture selection + weights                                       */
/* ---------------------------------------------------------------- */

const selectableSources = computed(() =>
  XP_SOURCES.filter((s) => s.kind === sourceKind.value),
);

const selectedEntries = computed<MixtureEntry[]>(() =>
  Object.entries(selection.value).map(([sourceId, weight]) => ({ sourceId, weight })),
);

const selectedCount = computed(() => selectedEntries.value.length);

function setKind(kind: Exclude<SourceKind, "other">) {
  if (sourceKind.value === kind) return;
  sourceKind.value = kind;
  selection.value = kind === "mob" ? { zombie: 1 } : { diamond_ore: 1 };
  preset.value = "";
}

function toggleSource(id: string) {
  const next = { ...selection.value };
  if (next[id] !== undefined) {
    delete next[id];
  } else {
    // Equal split default: new sources join at weight 1.
    next[id] = 1;
  }
  selection.value = next;
  preset.value = "";
}

function setWeight(id: string, v: unknown) {
  const n = Math.max(0, Number(v) || 0);
  selection.value = { ...selection.value, [id]: n };
  preset.value = "";
}

const preset = ref("");

function applyPreset(id: string) {
  preset.value = id;
  if (!id) return;
  const p = MIXTURE_PRESETS.find((x) => x.id === id);
  if (!p) return;
  const weights = presetWeights(p, version.value);
  if (!weights) return;
  sourceKind.value = p.kind;
  selection.value = { ...weights };
}

const activePreset = computed(() => MIXTURE_PRESETS.find((p) => p.id === preset.value));

const mixturePlan = computed(() => {
  try {
    if (!selectedCount.value) return { plan: null, error: null };
    const plan = planMixture(xpNeeded.value, selectedEntries.value);
    return { plan, error: null };
  } catch (e) {
    return { plan: null, error: toCalcError(e) };
  }
});

const mixtureRows = computed<Record<string, string>>(() => {
  const rows: Record<string, string> = {};
  const m = mixturePlan.value.plan;
  if (!m) return rows;
  const worst = m.worstSource;
  rows["Average XP per action"] =
    `${m.meanXpPerAction.toLocaleString("en-US", { maximumFractionDigits: 2 })} points`;
  rows["Actions needed on average"] = fmt(m.avgActions);
  rows["Guaranteed (worst case)"] =
    m.guaranteedActions === null
      ? `none: ${worst.label} can drop 0 XP`
      : `${fmt(m.guaranteedActions)} (${worst.label} only, minimum rolls)`;
  return rows;
});

/* ---------------------------------------------------------------- */
/* mending sustainability                                            */
/* ---------------------------------------------------------------- */

const familyDef = computed(() => TOOL_FAMILY_BY_ID.get(family.value));
const materialDef = computed(() => MATERIAL_BY_ID.get(material.value));

function onFamilyChange(id: string) {
  family.value = id;
  const def = TOOL_FAMILY_BY_ID.get(id);
  if (!def) return;
  if (def.acts !== sourceKind.value) setKind(def.acts);
  if (def.acts === "block") {
    damageEnchant.value = "none";
    fireAspect.value = 0;
  }
  if (def.id !== "sword") fireAspect.value = 0;
  if (!durabilityTouched.value && materialDef.value) {
    toolDurability.value = materialDef.value.durability;
  }
}

function onMaterialChange(id: string) {
  material.value = id;
  const def = MATERIAL_BY_ID.get(id);
  if (def && !durabilityTouched.value) toolDurability.value = def.durability;
}

function onVersionChange(v: string) {
  version.value = v as VersionId;
  const mat = materialDef.value;
  if (mat?.availableIn && !mat.availableIn.includes(version.value)) {
    onMaterialChange("diamond");
  }
  if (activePreset.value && presetWeights(activePreset.value, version.value) === null) {
    preset.value = "";
  } else if (activePreset.value) {
    applyPreset(preset.value);
  }
}

watch(mendingOn, (on) => {
  if (on && familyDef.value && familyDef.value.acts !== sourceKind.value) {
    setKind(familyDef.value.acts);
  }
});

const sustain = computed<{ result: SustainResult | null; error: CalcError | null }>(() => {
  if (!mendingOn.value || !selectedCount.value) return { result: null, error: null };
  try {
    const result = sustainability({
      family: family.value,
      material: material.value,
      durability: toolDurability.value,
      mending: true,
      unbreaking: unbreaking.value,
      sharpness: damageEnchant.value === "sharpness" ? damageLevel.value : 0,
      smite: damageEnchant.value === "smite" ? damageLevel.value : 0,
      bane: damageEnchant.value === "bane" ? damageLevel.value : 0,
      fireAspect: family.value === "sword" ? fireAspect.value : 0,
      fireAspectFreeHp: fireFreeHp.value,
      mixture: selectedEntries.value,
    });
    return { result, error: null };
  } catch (e) {
    return { result: null, error: toCalcError(e) };
  }
});

const sustainRows = computed<Record<string, string>>(() => {
  const r = sustain.value.result;
  if (!r) return {};
  const noun = r.family.acts === "mob" ? "kills" : "blocks mined";
  const rows: Record<string, string> = {};
  if (r.family.acts === "mob" && r.perSource[0]?.damagePerHit != null) {
    rows["Hits per kill"] = r.perSource
      .map((p) => `${p.source.label}: ${p.hits} (${p.damagePerHit} damage)`)
      .join("; ");
  }
  rows["Average case"] = r.avgSelfSustaining
    ? "self-sustaining: Mending repairs at least as fast as the tool wears"
    : `about ${fmt(r.avgActions ?? 0)} ${noun} before the tool breaks`;
  rows["Worst case"] = r.worstSelfSustaining
    ? `self-sustaining even in the worst case (${r.worstSource.label} only, minimum XP, Unbreaking never procs)`
    : `${fmt(r.worstActions ?? 0)} ${noun} (${r.worstSource.label} only, minimum XP, Unbreaking never procs)`;
  rows["Expected wear per action"] = `${r.avgLossPerAction.toLocaleString("en-US", { maximumFractionDigits: 3 })} durability lost, ${r.avgRepairPerAction.toLocaleString("en-US", { maximumFractionDigits: 2 })} repaired`;
  return rows;
});

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    version,
    convMode,
    fromLevel,
    toLevel,
    totalXp,
    sourceKind,
    selection,
    preset,
    mendingOn,
    family,
    material,
    toolDurability,
    unbreaking,
    damageEnchant,
    damageLevel,
    fireAspect,
    fireFreeHp,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        v: version.value,
        cm: convMode.value,
        from: String(fromLevel.value),
        to: String(toLevel.value),
        xp: String(totalXp.value),
        kind: sourceKind.value,
        sel: selectedEntries.value.map((e) => `${e.sourceId}:${e.weight}`).join(","),
        preset: preset.value,
        mend: String(mendingOn.value),
        fam: family.value,
        mat: material.value,
        dur: String(toolDurability.value),
        unb: String(unbreaking.value),
        de: damageEnchant.value,
        del: String(damageLevel.value),
        fa: String(fireAspect.value),
        fahp: String(fireFreeHp.value),
      },
    });
  },
  { deep: true },
);

onMounted(() => {
  const { opts } = readFragment();
  if (opts.v && (VERSIONS as readonly string[]).includes(opts.v)) {
    version.value = opts.v as VersionId;
  }
  if (opts.cm === "levels" || opts.cm === "xp") convMode.value = opts.cm;
  if (opts.from) fromLevel.value = clampInt(opts.from, 0, MAX_LEVEL, 0);
  if (opts.to) toLevel.value = clampInt(opts.to, 0, MAX_LEVEL, 30);
  if (opts.xp) totalXp.value = clampInt(opts.xp, 0, MAX_TOTAL_XP, 1395);
  if (opts.kind === "mob" || opts.kind === "block") sourceKind.value = opts.kind;
  if (opts.sel) {
    const next: Record<string, number> = {};
    for (const part of opts.sel.split(",")) {
      const [id, w] = part.split(":");
      const src = id ? XP_SOURCE_BY_ID.get(id) : undefined;
      if (src && src.kind === sourceKind.value) {
        next[src.id] = Math.max(0, Number(w) || 1);
      }
    }
    if (Object.keys(next).length) selection.value = next;
  }
  if (opts.mend !== undefined) mendingOn.value = opts.mend === "true";
  if (opts.fam && TOOL_FAMILY_BY_ID.has(opts.fam)) family.value = opts.fam;
  if (opts.mat && MATERIAL_BY_ID.has(opts.mat)) {
    const m = MATERIAL_BY_ID.get(opts.mat);
    if (m && (!m.availableIn || m.availableIn.includes(version.value))) material.value = opts.mat;
  }
  const mat = MATERIAL_BY_ID.get(material.value);
  if (opts.dur) {
    toolDurability.value = clampInt(opts.dur, 1, mat?.durability ?? 2031, mat?.durability ?? 1561);
    durabilityTouched.value = true;
  } else if (mat) {
    toolDurability.value = mat.durability;
  }
  if (opts.unb) unbreaking.value = clampInt(opts.unb, 0, MAX_UNBREAKING, 0);
  if (opts.de === "none" || opts.de === "sharpness" || opts.de === "smite" || opts.de === "bane") {
    damageEnchant.value = opts.de;
  }
  if (opts.del) damageLevel.value = clampInt(opts.del, 1, 5, 5);
  if (opts.fa) fireAspect.value = clampInt(opts.fa, 0, MAX_FIRE_ASPECT, 0);
  if (opts.fahp) fireFreeHp.value = clampInt(opts.fahp, 0, 100, 3);
  if (opts.preset && MIXTURE_PRESETS.some((p) => p.id === opts.preset)) {
    // Selection already restored above; keep the label without reapplying.
    preset.value = opts.preset;
  }
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- header: version -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Level and XP converter
        </span>
        <p class="text-xs text-muted-foreground">
          The XP curve and every reward below are identical in all six verified versions; the
          version picker only gates newer content like copper tools and preset data.
        </p>
      </div>
      <div class="flex w-44 flex-col gap-1.5">
        <Label for="mcxp-version" class="text-xs text-muted-foreground">Version</Label>
        <SearchableSelect
          id="mcxp-version"
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="onVersionChange"
        />
      </div>
    </div>

    <!-- converter card -->
    <div class="flex flex-col gap-3 rounded-[14px] border p-4">
      <div class="flex flex-wrap items-end gap-3">
        <template v-if="convMode === 'levels'">
          <div class="flex w-32 flex-col gap-1.5">
            <Label for="mcxp-from" class="text-xs text-muted-foreground">From level</Label>
            <Input
              id="mcxp-from"
              type="number"
              min="0"
              :max="MAX_LEVEL"
              step="1"
              :model-value="fromLevel"
              @update:model-value="(v) => (fromLevel = clampInt(v, 0, MAX_LEVEL, 0))"
            />
          </div>
          <div class="flex w-32 flex-col gap-1.5">
            <Label for="mcxp-to" class="text-xs text-muted-foreground">To level</Label>
            <Input
              id="mcxp-to"
              type="number"
              min="0"
              :max="MAX_LEVEL"
              step="1"
              :model-value="toLevel"
              @update:model-value="(v) => (toLevel = clampInt(v, 0, MAX_LEVEL, 30))"
            />
          </div>
        </template>
        <div v-else class="flex w-44 flex-col gap-1.5">
          <Label for="mcxp-xp" class="text-xs text-muted-foreground">Total XP points</Label>
          <Input
            id="mcxp-xp"
            type="number"
            min="0"
            :max="MAX_TOTAL_XP"
            step="1"
            :model-value="totalXp"
            @update:model-value="(v) => (totalXp = clampInt(v, 0, MAX_TOTAL_XP, 1395))"
          />
        </div>
        <button
          type="button"
          class="rounded-[10px] border bg-secondary px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          @click="swapModes"
        >
          {{ convMode === "levels" ? "Switch to XP to level" : "Switch to level to XP" }}
        </button>
      </div>
      <div aria-live="polite">
        <OutputView :output="converter" />
      </div>
    </div>

    <!-- chart -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Total XP by level ({{ fmt(chart.a) }} to {{ fmt(chart.b) }})
      </span>
      <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
        <svg
          :width="chart.width"
          :height="220"
          :viewBox="`0 0 ${chart.width} 220`"
          role="img"
          :aria-label="`Line chart of total XP for every level from ${chart.a} to ${chart.b}; total XP at level ${chart.b} is ${fmt(chart.yMax)} points`"
          class="text-primary"
        >
          <g class="text-border" stroke="currentColor" stroke-width="1">
            <line
              v-for="t in chart.yTicks"
              :key="`y${t.y}`"
              x1="64"
              :x2="chart.width - 16"
              :y1="t.y"
              :y2="t.y"
              opacity="0.6"
            />
          </g>
          <g class="text-muted-foreground" fill="currentColor" font-size="11">
            <text
              v-for="t in chart.yTicks"
              :key="`yl${t.y}`"
              :x="58"
              :y="t.y + 4"
              text-anchor="end"
            >
              {{ t.label }}
            </text>
            <text
              v-for="t in chart.xTicks"
              :key="`xl${t.x}`"
              :x="t.x"
              :y="212"
              text-anchor="middle"
            >
              {{ t.label }}
            </text>
          </g>
          <polyline
            :points="chart.points"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p class="text-xs text-muted-foreground">
        Every level in the range is plotted from the exact curve in the game's Player class, no
        sampling. The kinks at levels 16 and 31 are real tier changes.
      </p>
    </div>

    <!-- mixture: sources and weights -->
    <div class="flex flex-col gap-3 rounded-[14px] border p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          XP sources
        </span>
        <div class="flex items-center gap-2">
          <div class="flex gap-2" role="group" aria-label="Source category">
            <button
              v-for="k in ['mob', 'block'] as const"
              :key="k"
              type="button"
              class="rounded-[8px] border px-2.5 py-1 text-xs transition-colors"
              :class="
                sourceKind === k ? 'border-ring bg-accent font-semibold' : 'bg-secondary hover:bg-accent'
              "
              :aria-pressed="sourceKind === k"
              :disabled="mendingOn && familyDef?.acts !== k"
              @click="setKind(k)"
            >
              {{ k === "mob" ? "Mobs" : "Blocks" }}
            </button>
          </div>
          <div class="w-56">
            <SearchableSelect
              id="mcxp-preset"
              :spec="presetSpec"
              :model-value="preset"
              aria-label="Mixture preset"
              @update:model-value="applyPreset"
            />
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Selected XP sources">
        <label
          v-for="s in selectableSources"
          :key="s.id"
          class="flex cursor-pointer items-center gap-1.5 rounded-[8px] border px-2 py-1 text-xs transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"
          :class="
            selection[s.id] !== undefined
              ? 'border-ring bg-accent font-semibold'
              : 'bg-secondary hover:bg-accent'
          "
        >
          <input
            type="checkbox"
            class="sr-only"
            :checked="selection[s.id] !== undefined"
            @change="toggleSource(s.id)"
          />
          {{ s.label }}
        </label>
      </div>

      <!-- distribution card -->
      <div
        v-if="selectedCount > 1"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Distribution (relative weights)
        </span>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="e in selectedEntries"
            :key="e.sourceId"
            class="flex items-center justify-between gap-2"
          >
            <Label :for="`mcxp-w-${e.sourceId}`" class="min-w-0 truncate text-xs">
              {{ XP_SOURCE_BY_ID.get(e.sourceId)?.label ?? e.sourceId }}
            </Label>
            <Input
              :id="`mcxp-w-${e.sourceId}`"
              type="number"
              min="0"
              step="any"
              class="w-24"
              :model-value="e.weight"
              @update:model-value="(v) => setWeight(e.sourceId, v)"
            />
          </div>
        </div>
        <p v-if="activePreset" class="text-xs text-muted-foreground">
          {{ activePreset.provenance }}
        </p>
        <p v-else class="text-xs text-muted-foreground">
          Weights are relative shares of your actions, normalized automatically. New selections
          join at weight 1 (an equal split).
        </p>
      </div>

      <div v-if="mixturePlan.error" class="rounded-[10px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
        <p class="font-medium">{{ mixturePlan.error.message }}</p>
        <p v-if="mixturePlan.error.fix" class="text-muted-foreground">{{ mixturePlan.error.fix }}</p>
      </div>
      <div v-else-if="mixturePlan.plan" aria-live="polite">
        <OutputView :output="mixtureRows" />
        <p class="mt-1.5 text-xs text-muted-foreground">
          The worst case here means the single worst selected source supplying 100 percent of the
          actions, with minimum XP rolls.
        </p>
      </div>
    </div>

    <!-- mending sustainability -->
    <div class="flex flex-col gap-3 rounded-[14px] border p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Label for="mcxp-mend" class="cursor-pointer text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Source tool has Mending
        </Label>
        <Switch
          id="mcxp-mend"
          :model-value="mendingOn"
          @update:model-value="(v) => (mendingOn = Boolean(v))"
        />
      </div>

      <template v-if="mendingOn">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-family" class="text-xs text-muted-foreground">Tool</Label>
            <SearchableSelect
              id="mcxp-family"
              :spec="familySpec"
              :model-value="family"
              @update:model-value="onFamilyChange"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-material" class="text-xs text-muted-foreground">Material</Label>
            <SearchableSelect
              id="mcxp-material"
              :spec="materialSpec"
              :model-value="material"
              @update:model-value="onMaterialChange"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-dur" class="text-xs text-muted-foreground">
              Current durability (max {{ fmt(materialDef?.durability ?? 0) }})
            </Label>
            <Input
              id="mcxp-dur"
              type="number"
              min="1"
              :max="materialDef?.durability ?? 2031"
              step="1"
              :model-value="toolDurability"
              @update:model-value="
                (v) => {
                  toolDurability = clampInt(v, 1, materialDef?.durability ?? 2031, 1);
                  durabilityTouched = true;
                }
              "
            />
          </div>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-unb" class="text-xs text-muted-foreground">Unbreaking (0 to 3)</Label>
            <Input
              id="mcxp-unb"
              type="number"
              min="0"
              :max="MAX_UNBREAKING"
              step="1"
              :model-value="unbreaking"
              @update:model-value="(v) => (unbreaking = clampInt(v, 0, MAX_UNBREAKING, 0))"
            />
          </div>
          <template v-if="familyDef?.acts === 'mob'">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="mcxp-de" class="text-xs text-muted-foreground">Damage enchantment</Label>
              <SearchableSelect
                id="mcxp-de"
                :spec="damageEnchantSpec"
                :model-value="damageEnchant"
                @update:model-value="(v: string) => (damageEnchant = v as 'none' | 'sharpness' | 'smite' | 'bane')"
              />
            </div>
            <div v-if="damageEnchant !== 'none'" class="flex min-w-0 flex-col gap-1.5">
              <Label for="mcxp-del" class="text-xs text-muted-foreground">Level (1 to 5)</Label>
              <Input
                id="mcxp-del"
                type="number"
                min="1"
                max="5"
                step="1"
                :model-value="damageLevel"
                @update:model-value="(v) => (damageLevel = clampInt(v, 1, 5, 5))"
              />
            </div>
          </template>
        </div>

        <div v-if="family === 'sword'" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-fa" class="text-xs text-muted-foreground">Fire Aspect (0 to 2)</Label>
            <Input
              id="mcxp-fa"
              type="number"
              min="0"
              :max="MAX_FIRE_ASPECT"
              step="1"
              :model-value="fireAspect"
              @update:model-value="(v) => (fireAspect = clampInt(v, 0, MAX_FIRE_ASPECT, 0))"
            />
          </div>
          <div v-if="fireAspect > 0" class="flex min-w-0 flex-col gap-1.5">
            <Label for="mcxp-fahp" class="text-xs text-muted-foreground">
              Burn damage per kill (HP)
            </Label>
            <Input
              id="mcxp-fahp"
              type="number"
              min="0"
              max="100"
              step="1"
              :model-value="fireFreeHp"
              @update:model-value="(v) => (fireFreeHp = clampInt(v, 0, 100, 3))"
            />
          </div>
        </div>

        <p v-if="family === 'pickaxe'" class="text-xs text-muted-foreground">
          Fortune is not shown because it never changes ore XP in any verified version: the drop
          paths (OreBlock, DropExperienceBlock, tryDropExperience) only check Silk Touch. Silk
          Touch drops zero XP, so a silk-touched pickaxe cannot sustain itself off ore.
        </p>
        <p v-if="familyDef?.acts === 'mob'" class="text-xs text-muted-foreground">
          Smite only helps against undead mobs and Bane of Arthropods only against arthropods;
          against everything else the bonus is zero. Fire Aspect burn depends on how long the mob
          lives, so it is modeled as a flat amount of free damage per kill that you can adjust.
          Hit counts ignore mob armor and natural regeneration.
        </p>

        <div v-if="sustain.error" class="rounded-[10px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
          <p class="font-medium">{{ sustain.error.message }}</p>
          <p v-if="sustain.error.fix" class="text-muted-foreground">{{ sustain.error.fix }}</p>
        </div>
        <div v-else-if="sustain.result" aria-live="polite">
          <OutputView :output="sustainRows" />
        </div>
      </template>
      <p v-else class="text-xs text-muted-foreground">
        Turn this on to model a Mending tool grinding the selected sources: each action yields XP
        that repairs 2 durability per point while the tool is damaged, and Unbreaking makes each
        point of wear land with probability 1 in (level + 1).
      </p>
    </div>

    <!-- kill planner table -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Full planner: {{ fmt(xpNeeded) }} XP from every source
      </span>
      <div class="max-h-96 overflow-auto rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <table class="w-full min-w-[560px] text-sm">
          <thead>
            <tr class="text-left text-xs font-semibold text-muted-foreground">
              <th scope="col" class="px-3 py-1.5">Source</th>
              <th scope="col" class="px-3 py-1.5">XP per action</th>
              <th scope="col" class="px-3 py-1.5">Average needed</th>
              <th scope="col" class="px-3 py-1.5">Guaranteed</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in plannerRows"
              :key="row.id"
              :class="row.selected ? 'font-semibold text-primary' : ''"
            >
              <td class="px-3 py-1.5">{{ row.label }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.per }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.avg }} {{ row.unit }}</td>
              <td class="px-3 py-1.5 font-mono tabular-nums">{{ row.guaranteed }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted-foreground">
        Averages use each source's expected XP; guaranteed counts assume minimum rolls. Mob
        equipment adds 1 to 3 bonus XP per equipped item and Looting never changes XP, so real
        farm rates only beat these numbers.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">
      Every constant is verified against decompiled game code for 1.16.5, 1.18.2, 1.20.6, 1.21.1,
      1.21.11, and 26.2. Not an official Minecraft product. Not approved by or associated with
      Mojang or Microsoft.
    </p>
  </div>
</template>
