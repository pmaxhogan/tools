<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft anvil calculator.
 *
 * The pure logic layer (src/tools/minecraft-anvil-calculator/index.ts)
 * reimplements the game's AnvilMenu algorithm per version; everything DOM
 * related lives here: the slot editors, the planner book list, the horizon
 * table, and URL-fragment state so a specific setup is shareable.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ArrowRight, Plus, Sparkles, Trash2 } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  type AnvilItem,
  type CombineOutcome,
  type PlanResult,
  combineItems,
  planCombine,
  renameOnly,
  repairWithMaterials,
  sequentialPlan,
  tooExpensiveHorizon,
} from "@/tools/minecraft-anvil-calculator/index";
import {
  ANVIL_VERSIONS,
  type AnvilEnchant,
  type AnvilVersionData,
} from "@/tools/minecraft-anvil-calculator/data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";

const props = defineProps<{ meta: ToolMeta }>();

const versionSpec = computed(
  () => props.meta.options?.find((o) => o.id === "version") as SelectOptionSpec | undefined,
);

const version = ref((versionSpec.value?.default as string) ?? "1.21.11");
const tab = ref<"combine" | "planner" | "horizon">("combine");
const creative = ref(false);
const mounted = ref(false);

const data = computed<AnvilVersionData>(
  () => ANVIL_VERSIONS[version.value] ?? ANVIL_VERSIONS["1.21.11"]!,
);

/* ---------------------------------------------------------------- */
/* editable item state                                               */
/* ---------------------------------------------------------------- */

interface EditEnchant {
  id: string;
  level: number;
}

interface EditItem {
  kind: string;
  enchants: EditEnchant[];
  priorWork: number;
  damage: number;
}

function freshItem(kind = "sword"): EditItem {
  return { kind, enchants: [], priorWork: 0, damage: 0 };
}

type SacrificeMode = "book" | "item" | "material" | "none";

const target = ref<EditItem>(freshItem());
const sacrifice = ref<EditItem>({ kind: "book", enchants: [], priorWork: 0, damage: 0 });
const sacrificeMode = ref<SacrificeMode>("book");
const materialCount = ref(1);
const renameAction = ref<"keep" | "set" | "clear">("keep");

const plannerItem = ref<EditItem>(freshItem());
const plannerBooks = ref<EditEnchant[][]>([[{ id: "sharpness", level: 5 }]]);
const horizonPriorWork = ref(0);

/* ---------------------------------------------------------------- */
/* select specs built from the version data                          */
/* ---------------------------------------------------------------- */

function familySpec(id: string, label: string, includeBook: boolean): SelectOptionSpec {
  return {
    kind: "select",
    id,
    label,
    default: "sword",
    options: data.value.families
      .filter((f) => includeBook || f.id !== "book")
      .map((f) => ({
        value: f.id,
        label: f.label,
        synonyms: [f.id.replace(/_/g, " ")],
      })),
  };
}

const targetKindSpec = computed(() => familySpec("target-kind", "Target item", true));
const plannerKindSpec = computed(() => familySpec("planner-kind", "Item", false));

const enchantSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "enchant",
  label: "Enchantment",
  default: data.value.enchants[0]?.id ?? "sharpness",
  options: data.value.enchants.map((e) => ({
    value: e.id,
    label: e.name,
    synonyms: [e.id.replace(/_/g, " ")],
  })),
}));

const sacrificeModeSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "sacrifice-mode",
  label: "Second slot",
  default: "book",
  options: [
    { value: "book", label: "Enchanted book", synonyms: ["book"] },
    { value: "item", label: "Same item (combine)", synonyms: ["item", "merge", "sacrifice"] },
    { value: "material", label: "Repair material", synonyms: ["diamond", "unit repair", "ingot"] },
    { value: "none", label: "Nothing (rename only)", synonyms: ["rename", "empty"] },
  ],
}));

const renameSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "rename",
  label: "Name",
  default: "keep",
  options: [
    { value: "keep", label: "Keep name", synonyms: ["no rename"] },
    { value: "set", label: "Set a new name", synonyms: ["rename"] },
    { value: "clear", label: "Remove custom name", synonyms: ["reset name", "clear"] },
  ],
}));

function enchantById(id: string): AnvilEnchant | undefined {
  return data.value.enchants.find((e) => e.id === id);
}

function maxDamageOf(kind: string): number {
  return data.value.families.find((f) => f.id === kind)?.maxDamage ?? 0;
}

function familyLabel(kind: string): string {
  return data.value.families.find((f) => f.id === kind)?.label ?? kind;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

function describe(item: AnvilItem): string {
  const label = familyLabel(item.kind);
  if (item.enchants.length === 0) return label;
  return `${label} (${item.enchants.map((e) => `${enchantById(e.id)?.name ?? e.id} ${roman(e.level)}`).join(", ")})`;
}

/* ---------------------------------------------------------------- */
/* enchant list editing                                              */
/* ---------------------------------------------------------------- */

function addEnchant(list: EditEnchant[]) {
  const used = new Set(list.map((e) => e.id));
  const next = data.value.enchants.find((e) => !used.has(e.id));
  if (next) list.push({ id: next.id, level: next.maxLevel });
}

function clampLevel(e: EditEnchant) {
  const spec = enchantById(e.id);
  const max = spec?.maxLevel ?? 5;
  e.level = Math.min(Math.max(Math.round(e.level) || 1, 1), max);
}

/** Drop state that does not exist in a newly chosen version. */
function sanitizeForVersion() {
  const famIds = new Set(data.value.families.map((f) => f.id));
  const enchIds = new Set(data.value.enchants.map((e) => e.id));
  for (const item of [target.value, sacrifice.value, plannerItem.value]) {
    if (!famIds.has(item.kind)) item.kind = item.kind === "book" ? "book" : "sword";
    item.enchants = item.enchants.filter((e) => enchIds.has(e.id));
    for (const e of item.enchants) clampLevel(e);
  }
  plannerBooks.value = plannerBooks.value
    .map((b) => b.filter((e) => enchIds.has(e.id)))
    .filter((b) => b.length > 0);
  if (plannerBooks.value.length === 0) plannerBooks.value = [[{ id: "unbreaking", level: 3 }]];
}

watch(version, sanitizeForVersion);

/* ---------------------------------------------------------------- */
/* combine result                                                    */
/* ---------------------------------------------------------------- */

interface Failure {
  message: string;
  fix?: string;
}

function toAnvilItem(item: EditItem): AnvilItem {
  const maxDamage = maxDamageOf(item.kind);
  return {
    kind: item.kind,
    enchants: item.enchants.map((e) => ({ ...e })),
    priorWork: Math.max(0, Math.round(item.priorWork) || 0),
    damage: Math.min(Math.max(0, Math.round(item.damage) || 0), maxDamage),
    customName: renameAction.value === "clear" ? true : undefined,
  };
}

const combineResult = computed<{ outcome: CombineOutcome | null; error: Failure | null }>(() => {
  try {
    const opts = {
      version: version.value,
      creative: creative.value,
      rename: renameAction.value,
    };
    const t = toAnvilItem(target.value);
    if (sacrificeMode.value === "material") {
      return {
        outcome: repairWithMaterials(t, Math.max(1, materialCount.value), opts),
        error: null,
      };
    }
    if (sacrificeMode.value === "none") {
      if (renameAction.value === "keep") {
        return { outcome: null, error: null };
      }
      return { outcome: renameOnly(t, opts), error: null };
    }
    const s = toAnvilItem(sacrifice.value);
    if (sacrificeMode.value === "book") s.kind = "book";
    else if (s.kind === "book") s.kind = t.kind;
    return { outcome: combineItems(t, s, opts), error: null };
  } catch (e) {
    const err =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
    return { outcome: null, error: err };
  }
});

const STATUS_TEXT: Record<string, string> = {
  ok: "Combine works",
  "too-expensive": "Too Expensive",
  "no-change": "Nothing changes",
  "no-result": "No result: every sacrifice enchantment is incompatible",
  "invalid-pair": "These two things cannot combine",
};

/* ---------------------------------------------------------------- */
/* planner                                                           */
/* ---------------------------------------------------------------- */

const PRESETS: Record<string, [string, number][]> = {
  sword: [
    ["sharpness", 5],
    ["looting", 3],
    ["unbreaking", 3],
    ["mending", 1],
    ["fire_aspect", 2],
    ["sweeping_edge", 3],
    ["knockback", 2],
  ],
  axe: [
    ["sharpness", 5],
    ["efficiency", 5],
    ["unbreaking", 3],
    ["mending", 1],
    ["silk_touch", 1],
  ],
  pickaxe: [
    ["efficiency", 5],
    ["fortune", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  shovel: [
    ["efficiency", 5],
    ["fortune", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  hoe: [
    ["efficiency", 5],
    ["fortune", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  bow: [
    ["power", 5],
    ["punch", 2],
    ["flame", 1],
    ["infinity", 1],
    ["unbreaking", 3],
  ],
  crossbow: [
    ["quick_charge", 3],
    ["piercing", 4],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  trident: [
    ["impaling", 5],
    ["loyalty", 3],
    ["channeling", 1],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  mace: [
    ["density", 5],
    ["wind_burst", 3],
    ["unbreaking", 3],
    ["mending", 1],
    ["fire_aspect", 2],
  ],
  spear: [
    ["sharpness", 5],
    ["lunge", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  fishing_rod: [
    ["luck_of_the_sea", 3],
    ["lure", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  helmet: [
    ["protection", 4],
    ["respiration", 3],
    ["aqua_affinity", 1],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  chestplate: [
    ["protection", 4],
    ["thorns", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  leggings: [
    ["protection", 4],
    ["swift_sneak", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
  boots: [
    ["protection", 4],
    ["feather_falling", 4],
    ["depth_strider", 3],
    ["soul_speed", 3],
    ["unbreaking", 3],
    ["mending", 1],
  ],
};

const FALLBACK_PRESET: [string, number][] = [
  ["unbreaking", 3],
  ["mending", 1],
];

function loadPreset() {
  const kit = PRESETS[plannerItem.value.kind] ?? FALLBACK_PRESET;
  const enchIds = new Set(data.value.enchants.map((e) => e.id));
  plannerBooks.value = kit
    .filter(([id]) => enchIds.has(id))
    .slice(0, 7)
    .map(([id, level]) => [{ id, level }]);
  plannerItem.value.enchants = [];
}

function addBook() {
  if (plannerBooks.value.length >= 7) return;
  plannerBooks.value.push([{ id: "unbreaking", level: 3 }]);
}

const plannerResult = computed<{
  plan: PlanResult | null;
  naive: PlanResult | null;
  error: Failure | null;
}>(() => {
  try {
    const item = {
      kind: plannerItem.value.kind,
      enchants: plannerItem.value.enchants.map((e) => ({ ...e })),
      priorWork: Math.max(0, Math.round(plannerItem.value.priorWork) || 0),
      damage: 0,
    };
    const books: AnvilItem[] = plannerBooks.value
      .filter((b) => b.length > 0)
      .map((b) => ({
        kind: "book",
        enchants: b.map((e) => ({ ...e })),
        priorWork: 0,
        damage: 0,
      }));
    if (books.length === 0) return { plan: null, naive: null, error: null };
    const opts = { version: version.value };
    return {
      plan: planCombine(item, books, opts),
      naive: sequentialPlan(item, books, opts),
      error: null,
    };
  } catch (e) {
    const err =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
    return { plan: null, naive: null, error: err };
  }
});

/* ---------------------------------------------------------------- */
/* horizon                                                           */
/* ---------------------------------------------------------------- */

const horizonSteps = computed(() => {
  const pw = Math.max(0, Math.round(horizonPriorWork.value) || 0);
  return tooExpensiveHorizon(pw);
});

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch(
  [
    version,
    tab,
    creative,
    target,
    sacrifice,
    sacrificeMode,
    materialCount,
    renameAction,
    plannerItem,
    plannerBooks,
    horizonPriorWork,
  ],
  () => {
    if (!mounted.value) return;
    writeFragment({
      opts: {
        v: version.value,
        tab: tab.value,
        s: JSON.stringify({
          creative: creative.value,
          target: target.value,
          sacrifice: sacrifice.value,
          mode: sacrificeMode.value,
          materials: materialCount.value,
          rename: renameAction.value,
          plannerItem: plannerItem.value,
          books: plannerBooks.value,
          horizon: horizonPriorWork.value,
        }),
      },
    });
  },
  { deep: true },
);

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.v && ANVIL_VERSIONS[frag.opts.v]) version.value = frag.opts.v;
  if (frag.opts.tab === "planner" || frag.opts.tab === "horizon" || frag.opts.tab === "combine") {
    tab.value = frag.opts.tab;
  }
  if (frag.opts.s) {
    try {
      const s = JSON.parse(frag.opts.s);
      if (typeof s.creative === "boolean") creative.value = s.creative;
      if (s.target) target.value = { ...freshItem(), ...s.target };
      if (s.sacrifice) sacrifice.value = { ...freshItem("book"), ...s.sacrifice };
      if (["book", "item", "material", "none"].includes(s.mode)) sacrificeMode.value = s.mode;
      if (typeof s.materials === "number") materialCount.value = s.materials;
      if (["keep", "set", "clear"].includes(s.rename)) renameAction.value = s.rename;
      if (s.plannerItem) plannerItem.value = { ...freshItem(), ...s.plannerItem };
      if (Array.isArray(s.books)) plannerBooks.value = s.books;
      if (typeof s.horizon === "number") horizonPriorWork.value = s.horizon;
      sanitizeForVersion();
    } catch {
      /* a malformed fragment falls back to defaults */
    }
  }
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="anvil-version" class="text-xs text-muted-foreground">Game version</Label>
        <SearchableSelect
          v-if="versionSpec"
          id="anvil-version"
          :spec="versionSpec"
          :model-value="version"
          @update:model-value="(v) => (version = v)"
        />
      </div>
      <div class="flex items-center gap-2 pb-1.5">
        <Switch
          id="anvil-creative"
          :model-value="creative"
          @update:model-value="(v) => (creative = Boolean(v))"
        />
        <Label for="anvil-creative" class="cursor-pointer text-xs text-muted-foreground">
          Creative mode (no 40 level cap, any enchant on any item)
        </Label>
      </div>
    </div>

    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="combine">Combine</TabsTrigger>
        <TabsTrigger value="planner">Optimal planner</TabsTrigger>
        <TabsTrigger value="horizon">Too Expensive horizon</TabsTrigger>
      </TabsList>

      <!-- ============================== combine ============================== -->
      <TabsContent value="combine" class="flex flex-col gap-4 pt-4">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <!-- target slot -->
          <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Target (left slot)
            </p>
            <div class="flex flex-col gap-1.5">
              <Label for="anvil-target-kind" class="text-xs text-muted-foreground">Item</Label>
              <SearchableSelect
                id="anvil-target-kind"
                :spec="targetKindSpec"
                :model-value="target.kind"
                @update:model-value="(v) => (target.kind = v)"
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="flex flex-col gap-1.5">
                <Label for="anvil-target-pw" class="text-xs text-muted-foreground">
                  Prior work penalty
                </Label>
                <Input
                  id="anvil-target-pw"
                  type="number"
                  min="0"
                  max="2000000000"
                  class="h-8"
                  :model-value="target.priorWork"
                  @update:model-value="(v) => (target.priorWork = Number(v) || 0)"
                />
              </div>
              <div v-if="maxDamageOf(target.kind) > 0" class="flex flex-col gap-1.5">
                <Label for="anvil-target-damage" class="text-xs text-muted-foreground">
                  Damage (0 to {{ maxDamageOf(target.kind) }})
                </Label>
                <Input
                  id="anvil-target-damage"
                  type="number"
                  min="0"
                  :max="maxDamageOf(target.kind)"
                  class="h-8"
                  :model-value="target.damage"
                  @update:model-value="(v) => (target.damage = Number(v) || 0)"
                />
              </div>
            </div>
            <!-- target enchants -->
            <div class="flex flex-col gap-2">
              <div v-for="(e, i) in target.enchants" :key="i" class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <SearchableSelect
                    :id="`anvil-target-ench-${i}`"
                    :spec="enchantSpec"
                    :model-value="e.id"
                    @update:model-value="
                      (v) => {
                        e.id = v;
                        clampLevel(e);
                      }
                    "
                  />
                </div>
                <Input
                  type="number"
                  min="1"
                  :max="enchantById(e.id)?.maxLevel ?? 10"
                  class="h-8 w-16"
                  :aria-label="`${enchantById(e.id)?.name ?? e.id} level`"
                  :model-value="e.level"
                  @update:model-value="
                    (v) => {
                      e.level = Number(v) || 1;
                      clampLevel(e);
                    }
                  "
                />
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Remove ${enchantById(e.id)?.name ?? e.id}`"
                  @click="target.enchants.splice(i, 1)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                class="w-fit"
                @click="addEnchant(target.enchants)"
              >
                <Plus class="size-3.5" />
                Add enchantment
              </Button>
            </div>
          </div>

          <!-- sacrifice slot -->
          <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Sacrifice (right slot)
            </p>
            <div class="flex flex-col gap-1.5">
              <Label for="anvil-sac-mode" class="text-xs text-muted-foreground">Second slot</Label>
              <SearchableSelect
                id="anvil-sac-mode"
                :spec="sacrificeModeSpec"
                :model-value="sacrificeMode"
                @update:model-value="(v) => (sacrificeMode = v as SacrificeMode)"
              />
            </div>

            <template v-if="sacrificeMode === 'material'">
              <div class="flex flex-col gap-1.5">
                <Label for="anvil-materials" class="text-xs text-muted-foreground">
                  Material units offered
                </Label>
                <Input
                  id="anvil-materials"
                  type="number"
                  min="1"
                  max="64"
                  class="h-8"
                  :model-value="materialCount"
                  @update:model-value="(v) => (materialCount = Number(v) || 1)"
                />
                <p class="text-xs text-muted-foreground">
                  Each unit repairs a quarter of max durability for 1 level. Only the units needed
                  are consumed.
                </p>
              </div>
            </template>

            <template v-else-if="sacrificeMode === 'book' || sacrificeMode === 'item'">
              <div v-if="sacrificeMode === 'item'" class="grid grid-cols-2 gap-2">
                <div class="flex flex-col gap-1.5">
                  <Label for="anvil-sac-pw" class="text-xs text-muted-foreground">
                    Prior work penalty
                  </Label>
                  <Input
                    id="anvil-sac-pw"
                    type="number"
                    min="0"
                    class="h-8"
                    :model-value="sacrifice.priorWork"
                    @update:model-value="(v) => (sacrifice.priorWork = Number(v) || 0)"
                  />
                </div>
                <div v-if="maxDamageOf(target.kind) > 0" class="flex flex-col gap-1.5">
                  <Label for="anvil-sac-damage" class="text-xs text-muted-foreground">Damage</Label>
                  <Input
                    id="anvil-sac-damage"
                    type="number"
                    min="0"
                    :max="maxDamageOf(target.kind)"
                    class="h-8"
                    :model-value="sacrifice.damage"
                    @update:model-value="(v) => (sacrifice.damage = Number(v) || 0)"
                  />
                </div>
              </div>
              <div v-else class="flex flex-col gap-1.5">
                <Label for="anvil-sac-pw-book" class="text-xs text-muted-foreground">
                  Prior work penalty (book)
                </Label>
                <Input
                  id="anvil-sac-pw-book"
                  type="number"
                  min="0"
                  class="h-8"
                  :model-value="sacrifice.priorWork"
                  @update:model-value="(v) => (sacrifice.priorWork = Number(v) || 0)"
                />
              </div>
              <div class="flex flex-col gap-2">
                <div v-for="(e, i) in sacrifice.enchants" :key="i" class="flex items-center gap-2">
                  <div class="min-w-0 flex-1">
                    <SearchableSelect
                      :id="`anvil-sac-ench-${i}`"
                      :spec="enchantSpec"
                      :model-value="e.id"
                      @update:model-value="
                        (v) => {
                          e.id = v;
                          clampLevel(e);
                        }
                      "
                    />
                  </div>
                  <Input
                    type="number"
                    min="1"
                    :max="enchantById(e.id)?.maxLevel ?? 10"
                    class="h-8 w-16"
                    :aria-label="`${enchantById(e.id)?.name ?? e.id} level`"
                    :model-value="e.level"
                    @update:model-value="
                      (v) => {
                        e.level = Number(v) || 1;
                        clampLevel(e);
                      }
                    "
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    :aria-label="`Remove ${enchantById(e.id)?.name ?? e.id}`"
                    @click="sacrifice.enchants.splice(i, 1)"
                  >
                    <Trash2 class="size-3.5" />
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="w-fit"
                  @click="addEnchant(sacrifice.enchants)"
                >
                  <Plus class="size-3.5" />
                  Add enchantment
                </Button>
              </div>
            </template>

            <p v-else class="text-xs text-muted-foreground">
              Leave the second slot empty and rename below. Rename-only costs clamp at 39 levels and
              never raise the prior work penalty.
            </p>

            <div class="flex flex-col gap-1.5">
              <Label for="anvil-rename" class="text-xs text-muted-foreground">Rename</Label>
              <SearchableSelect
                id="anvil-rename"
                :spec="renameSpec"
                :model-value="renameAction"
                @update:model-value="(v) => (renameAction = v as 'keep' | 'set' | 'clear')"
              />
            </div>
          </div>
        </div>

        <!-- combine result -->
        <div
          v-if="combineResult.error"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">{{ combineResult.error.message }}</p>
          <p v-if="combineResult.error.fix" class="mt-1 text-muted-foreground">
            {{ combineResult.error.fix }}
          </p>
        </div>

        <div
          v-else-if="combineResult.outcome"
          class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]"
          aria-live="polite"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p
              class="text-sm font-semibold"
              :class="
                combineResult.outcome.status === 'ok'
                  ? 'text-[color:var(--positive)]'
                  : combineResult.outcome.status === 'too-expensive'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              "
            >
              {{ STATUS_TEXT[combineResult.outcome.status] }}
            </p>
            <p class="font-mono text-2xl font-semibold tabular-nums">
              {{ combineResult.outcome.displayedCost }}
              <span class="text-sm font-normal text-muted-foreground">levels</span>
            </p>
          </div>

          <table
            v-if="combineResult.outcome.breakdown.length > 0"
            class="w-full border-collapse text-sm"
          >
            <caption class="sr-only">
              Cost breakdown
            </caption>
            <tbody>
              <tr
                v-for="(line, i) in combineResult.outcome.breakdown"
                :key="i"
                class="border-b border-border/60 last:border-0"
              >
                <td class="py-1 pr-2">{{ line.label }}</td>
                <td class="py-1 text-right font-mono tabular-nums">+{{ line.amount }}</td>
              </tr>
            </tbody>
          </table>

          <p
            v-if="combineResult.outcome.droppedEnchants.length > 0"
            class="text-xs text-muted-foreground"
          >
            Dropped (incompatible):
            {{
              combineResult.outcome.droppedEnchants
                .map((id) => enchantById(id)?.name ?? id)
                .join(", ")
            }}
          </p>

          <div v-if="combineResult.outcome.result" class="flex flex-col gap-1 text-sm">
            <p class="font-medium">Result: {{ describe(combineResult.outcome.result) }}</p>
            <p class="text-xs text-muted-foreground">
              Prior work penalty after: {{ combineResult.outcome.result.priorWork }}
              <template v-if="maxDamageOf(combineResult.outcome.result.kind) > 0">
                | Damage: {{ combineResult.outcome.result.damage }} /
                {{ maxDamageOf(combineResult.outcome.result.kind) }}
              </template>
              <template v-if="combineResult.outcome.materialsUsed > 0">
                | Materials consumed: {{ combineResult.outcome.materialsUsed }}
              </template>
            </p>
          </div>
          <p
            v-else-if="combineResult.outcome.status === 'too-expensive'"
            class="text-xs text-muted-foreground"
          >
            Survival anvils refuse any combine of 40 levels or more. Turn on creative mode above to
            see the outcome anyway.
          </p>
        </div>

        <p v-else class="text-sm text-muted-foreground">
          Pick a sacrifice or a rename to see the cost. Your files and inputs never leave your
          device.
        </p>
      </TabsContent>

      <!-- ============================== planner ============================== -->
      <TabsContent value="planner" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-wrap items-end gap-2">
            <div class="flex min-w-40 flex-col gap-1.5">
              <Label for="anvil-plan-kind" class="text-xs text-muted-foreground">Item</Label>
              <SearchableSelect
                id="anvil-plan-kind"
                :spec="plannerKindSpec"
                :model-value="plannerItem.kind"
                @update:model-value="(v) => (plannerItem.kind = v)"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="anvil-plan-pw" class="text-xs text-muted-foreground">
                Prior work penalty
              </Label>
              <Input
                id="anvil-plan-pw"
                type="number"
                min="0"
                class="h-8 w-28"
                :model-value="plannerItem.priorWork"
                @update:model-value="(v) => (plannerItem.priorWork = Number(v) || 0)"
              />
            </div>
            <Button size="sm" variant="outline" @click="loadPreset">
              <Sparkles class="size-3.5" />
              Load god kit
            </Button>
          </div>

          <div class="flex flex-col gap-2">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Books ({{ plannerBooks.length }} of 7)
            </p>
            <div
              v-for="(bk, bi) in plannerBooks"
              :key="bi"
              class="flex flex-col gap-2 rounded-[8px] border border-border bg-card p-2"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted-foreground">Book {{ bi + 1 }}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Remove book ${bi + 1}`"
                  @click="plannerBooks.splice(bi, 1)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
              <div v-for="(e, i) in bk" :key="i" class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <SearchableSelect
                    :id="`anvil-book-${bi}-ench-${i}`"
                    :spec="enchantSpec"
                    :model-value="e.id"
                    @update:model-value="
                      (v) => {
                        e.id = v;
                        clampLevel(e);
                      }
                    "
                  />
                </div>
                <Input
                  type="number"
                  min="1"
                  :max="enchantById(e.id)?.maxLevel ?? 10"
                  class="h-8 w-16"
                  :aria-label="`${enchantById(e.id)?.name ?? e.id} level`"
                  :model-value="e.level"
                  @update:model-value="
                    (v) => {
                      e.level = Number(v) || 1;
                      clampLevel(e);
                    }
                  "
                />
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="`Remove ${enchantById(e.id)?.name ?? e.id} from book ${bi + 1}`"
                  @click="bk.splice(i, 1)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
              <Button variant="ghost" size="sm" class="w-fit" @click="addEnchant(bk)">
                <Plus class="size-3.5" />
                Add enchantment to book
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="w-fit"
              :disabled="plannerBooks.length >= 7"
              @click="addBook"
            >
              <Plus class="size-3.5" />
              Add book
            </Button>
          </div>
        </div>

        <div
          v-if="plannerResult.error"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">{{ plannerResult.error.message }}</p>
          <p v-if="plannerResult.error.fix" class="mt-1 text-muted-foreground">
            {{ plannerResult.error.fix }}
          </p>
        </div>

        <div
          v-else-if="plannerResult.plan"
          class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]"
          aria-live="polite"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="text-sm font-semibold text-[color:var(--positive)]">Cheapest plan found</p>
            <p class="font-mono text-2xl font-semibold tabular-nums">
              {{ plannerResult.plan.totalCost }}
              <span class="text-sm font-normal text-muted-foreground">levels total</span>
            </p>
          </div>
          <ol class="flex flex-col gap-2">
            <li
              v-for="(step, i) in plannerResult.plan.steps"
              :key="i"
              class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            >
              <span
                class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-card font-mono text-xs tabular-nums"
              >
                {{ i + 1 }}
              </span>
              <span class="min-w-0">{{ describe(step.target) }}</span>
              <Plus class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="min-w-0">{{ describe(step.sacrifice) }}</span>
              <ArrowRight class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="font-mono font-medium tabular-nums">
                {{ step.outcome.displayedCost }} levels
              </span>
            </li>
          </ol>
          <p class="text-xs text-muted-foreground">
            Biggest single step: {{ plannerResult.plan.maxStepCost }} levels. Final item:
            {{ describe(plannerResult.plan.finalItem) }} with prior work penalty
            {{ plannerResult.plan.finalItem.priorWork }}.
            <template v-if="plannerResult.naive">
              Applying the books in listed order would cost
              {{ plannerResult.naive.totalCost }} levels; the plan saves
              {{ plannerResult.naive.totalCost - plannerResult.plan.totalCost }}.
            </template>
            <template v-else>
              Applying the books one by one in the listed order hits Too Expensive before finishing.
            </template>
          </p>
        </div>

        <div
          v-else
          class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
        >
          <p class="text-sm text-muted-foreground">
            No survival-legal plan exists for these books on this item. Check that the enchantments
            can go on the item and are not all mutually exclusive.
          </p>
        </div>
      </TabsContent>

      <!-- ============================== horizon ============================== -->
      <TabsContent value="horizon" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="anvil-horizon-pw" class="text-xs text-muted-foreground">
              Current prior work penalty
            </Label>
            <Input
              id="anvil-horizon-pw"
              type="number"
              min="0"
              max="1000"
              class="h-8 w-28"
              :model-value="horizonPriorWork"
              @update:model-value="(v) => (horizonPriorWork = Number(v) || 0)"
            />
          </div>
          <p class="pb-1 text-xs text-muted-foreground">
            The stored penalty is 0, 1, 3, 7, 15, 31, 63... doubling plus one after every combine.
          </p>
        </div>

        <div
          v-if="horizonSteps.length > 0"
          class="overflow-x-auto rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]"
        >
          <table class="w-full min-w-[28rem] border-collapse text-sm">
            <caption class="sr-only">
              Future combines before Too Expensive
            </caption>
            <thead>
              <tr class="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" class="py-1.5 pr-2 font-medium">Combine</th>
                <th scope="col" class="py-1.5 pr-2 font-medium">Penalty paid</th>
                <th scope="col" class="py-1.5 pr-2 font-medium">Max extra work</th>
                <th scope="col" class="py-1.5 font-medium">Penalty after</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in horizonSteps"
                :key="s.combine"
                class="border-b border-border/60 last:border-0"
              >
                <td class="py-1.5 pr-2 font-mono tabular-nums">{{ s.combine }}</td>
                <td class="py-1.5 pr-2 font-mono tabular-nums">{{ s.priorWorkBefore }}</td>
                <td class="py-1.5 pr-2 font-mono tabular-nums">{{ s.maxAffordableWork }}</td>
                <td class="py-1.5 font-mono tabular-nums">{{ s.priorWorkAfter }}</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-3 text-xs text-muted-foreground">
            {{ horizonSteps.length }} combine{{ horizonSteps.length === 1 ? "" : "s" }} left before
            everything except renaming is Too Expensive. A combine needs its penalty plus at least 1
            level of work under 40. Renaming alone clamps to 39 levels and never raises the penalty,
            so it stays possible forever.
          </p>
        </div>

        <div
          v-else
          class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
        >
          <p class="text-sm text-muted-foreground">
            At penalty {{ Math.max(0, Math.round(horizonPriorWork) || 0) }} every combine already
            costs 40 or more: this item is Too Expensive for anything except renaming (39 levels) or
            creative mode.
          </p>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
