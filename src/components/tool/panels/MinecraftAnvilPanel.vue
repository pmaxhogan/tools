<script setup lang="ts">
/**
 * Bespoke panel for the Minecraft anvil calculator: a two-pane workbench.
 *
 * Left pane holds the inventory (version, creative toggle, target item, and
 * the book or sacrifice list with prior-work counts); the right pane holds
 * the results: headline stat tiles, an SVG merge tree of the optimal combine
 * plan, and the numbered step list. The planner is the primary mode; combine
 * and horizon are secondary modes of the same workbench. The pure logic
 * layer (src/tools/minecraft-anvil-calculator/index.ts) does all the math;
 * everything DOM related lives here, and the whole setup round trips
 * through the URL fragment so a specific build is shareable.
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
const tab = ref<"planner" | "combine" | "horizon">("planner");
const creative = ref(false);
const mounted = ref(false);

const data = computed<AnvilVersionData>(
  () => ANVIL_VERSIONS[version.value] ?? ANVIL_VERSIONS["1.21.11"]!,
);

/* ---------------------------------------------------------------- */
/* editable state                                                    */
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

interface EditBook {
  priorWork: number;
  enchants: EditEnchant[];
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
const plannerBooks = ref<EditBook[]>([{ priorWork: 0, enchants: [{ id: "sharpness", level: 5 }] }]);
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
      .map((f) => ({ value: f.id, label: f.label, synonyms: [f.id.replace(/_/g, " ")] })),
  };
}

const targetKindSpec = computed(() => familySpec("target-kind", "Target item", true));
const plannerKindSpec = computed(() => familySpec("planner-kind", "Item", false));

/**
 * Enchantments that can legally land on the given item family in the current
 * version. Creative mode allows anything anywhere (the engine models the
 * bypass), and enchanted books hold anything, so both return the full list.
 */
function applicableEnchants(kind: string): AnvilEnchant[] {
  if (creative.value || kind === "book") return data.value.enchants;
  return data.value.enchants.filter((e) => e.items.includes(kind));
}

function buildEnchantSpec(enchants: AnvilEnchant[]): SelectOptionSpec {
  return {
    kind: "select",
    id: "enchant",
    label: "Enchantment",
    default: enchants[0]?.id ?? "sharpness",
    options: enchants.map((e) => ({
      value: e.id,
      label: e.name,
      synonyms: [e.id.replace(/_/g, " ")],
    })),
  };
}

/** Unfiltered list: book editors only (books can store any enchantment). */
const enchantSpec = computed<SelectOptionSpec>(() => buildEnchantSpec(data.value.enchants));
/** Target item editor: only enchantments that can land on the target. */
const targetEnchantSpec = computed<SelectOptionSpec>(() =>
  buildEnchantSpec(applicableEnchants(target.value.kind)),
);
/** Item-mode sacrifice editor: the sacrifice is the same family as the target. */
const sacrificeItemEnchantSpec = computed<SelectOptionSpec>(() =>
  buildEnchantSpec(applicableEnchants(target.value.kind)),
);
/** Planner item editor: only enchantments that can land on the planner item. */
const plannerItemEnchantSpec = computed<SelectOptionSpec>(() =>
  buildEnchantSpec(applicableEnchants(plannerItem.value.kind)),
);

/**
 * A book enchantment that cannot transfer onto the given target family: the
 * game drops it at the anvil and still charges the incompatibility penalty.
 * Never flags in creative mode or onto a book target.
 */
function willNotTransfer(id: string, targetKind: string): boolean {
  if (creative.value || targetKind === "book") return false;
  return !(enchantById(id)?.items.includes(targetKind) ?? false);
}

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

function enchantText(e: { id: string; level: number }): string {
  return `${enchantById(e.id)?.name ?? e.id} ${roman(e.level)}`;
}

function describe(item: AnvilItem): string {
  const label = familyLabel(item.kind);
  if (item.enchants.length === 0) return label;
  return `${label} (${item.enchants.map(enchantText).join(", ")})`;
}

/* ---------------------------------------------------------------- */
/* enchant list editing                                              */
/* ---------------------------------------------------------------- */

/**
 * Add the next unused enchantment to a list. With a `forKind`, applicable
 * enchantments are preferred; with `strict`, only applicable ones are added
 * (used by item editors, whose pickers are filtered to the same set).
 */
function addEnchant(list: EditEnchant[], forKind?: string, strict = false) {
  const used = new Set(list.map((e) => e.id));
  const preferred = forKind ? applicableEnchants(forKind) : data.value.enchants;
  const pool = strict ? preferred : [...preferred, ...data.value.enchants];
  const next = pool.find((e) => !used.has(e.id));
  if (next) list.push({ id: next.id, level: next.maxLevel });
}

/** Whether addEnchant would still find something to add (drives disabled). */
function canAddEnchant(list: EditEnchant[], forKind?: string, strict = false): boolean {
  const used = new Set(list.map((e) => e.id));
  const pool = strict && forKind ? applicableEnchants(forKind) : data.value.enchants;
  return pool.some((e) => !used.has(e.id));
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
    .map((b) => ({ ...b, enchants: b.enchants.filter((e) => enchIds.has(e.id)) }))
    .filter((b) => b.enchants.length > 0);
  if (plannerBooks.value.length === 0) {
    plannerBooks.value = [{ priorWork: 0, enchants: [{ id: "unbreaking", level: 3 }] }];
  }
}

watch(version, sanitizeForVersion);

/**
 * Fragment restore: drop enchantments a restored ITEM cannot legally carry in
 * survival, rather than render an impossible state. Books are exempt (they
 * store anything), and creative mode is exempt (anything goes there).
 */
function dropInapplicableEnchants() {
  if (creative.value) return;
  const dropFrom = (item: EditItem, kind: string) => {
    if (kind === "book") return;
    item.enchants = item.enchants.filter((e) => enchantById(e.id)?.items.includes(kind) ?? false);
  };
  dropFrom(target.value, target.value.kind);
  if (sacrificeMode.value === "item") dropFrom(sacrifice.value, target.value.kind);
  dropFrom(plannerItem.value, plannerItem.value.kind);
}

// Switching the item family (or flipping the sacrifice to item mode) can
// orphan enchantments the new family cannot carry; drop them in survival so
// the filtered pickers never show an impossible row. Creative keeps them.
watch([() => target.value.kind, () => plannerItem.value.kind, sacrificeMode], () => {
  if (mounted.value) dropInapplicableEnchants();
});

/* ---------------------------------------------------------------- */
/* combine result                                                    */
/* ---------------------------------------------------------------- */

interface Failure {
  message: string;
  fix?: string;
}

function failureOf(e: unknown): Failure {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
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
    const opts = { version: version.value, creative: creative.value, rename: renameAction.value };
    const t = toAnvilItem(target.value);
    if (sacrificeMode.value === "material") {
      return {
        outcome: repairWithMaterials(t, Math.max(1, materialCount.value), opts),
        error: null,
      };
    }
    if (sacrificeMode.value === "none") {
      if (renameAction.value === "keep") return { outcome: null, error: null };
      return { outcome: renameOnly(t, opts), error: null };
    }
    const s = toAnvilItem(sacrifice.value);
    if (sacrificeMode.value === "book") s.kind = "book";
    else if (s.kind === "book") s.kind = t.kind;
    return { outcome: combineItems(t, s, opts), error: null };
  } catch (e) {
    return { outcome: null, error: failureOf(e) };
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
    .map(([id, level]) => ({ priorWork: 0, enchants: [{ id, level }] }));
  plannerItem.value.enchants = [];
}

function addBook() {
  if (plannerBooks.value.length >= 7) return;
  plannerBooks.value.push({ priorWork: 0, enchants: [{ id: "unbreaking", level: 3 }] });
}

interface PlannerComputed {
  plan: PlanResult | null;
  naive: PlanResult | null;
  /** The exact book objects handed to the planner, for tree leaf labels. */
  books: AnvilItem[];
  item: AnvilItem | null;
  /** True when only a creative-mode plan exists (steps at 40+ highlighted). */
  creativeOnly: boolean;
  error: Failure | null;
}

const plannerResult = computed<PlannerComputed>(() => {
  try {
    const item: AnvilItem = {
      kind: plannerItem.value.kind,
      enchants: plannerItem.value.enchants.map((e) => ({ ...e })),
      priorWork: Math.max(0, Math.round(plannerItem.value.priorWork) || 0),
      damage: 0,
    };
    const books: AnvilItem[] = plannerBooks.value
      .filter((b) => b.enchants.length > 0)
      .map((b) => ({
        kind: "book",
        enchants: b.enchants.map((e) => ({ ...e })),
        priorWork: Math.max(0, Math.round(b.priorWork) || 0),
        damage: 0,
      }));
    if (books.length === 0) {
      return { plan: null, naive: null, books, item, creativeOnly: false, error: null };
    }
    const opts = { version: version.value };
    const plan = planCombine(item, books, opts);
    if (plan) {
      return {
        plan,
        naive: sequentialPlan(item, books, opts),
        books,
        item,
        creativeOnly: false,
        error: null,
      };
    }
    // No survival-legal plan: fall back to the cheapest creative plan so the
    // tree can still teach, with Too Expensive steps highlighted.
    const creativePlan = planCombine(item, books, { ...opts, creative: true });
    return { plan: creativePlan, naive: null, books, item, creativeOnly: true, error: null };
  } catch (e) {
    return {
      plan: null,
      naive: null,
      books: [],
      item: null,
      creativeOnly: false,
      error: failureOf(e),
    };
  }
});

const plannerSavings = computed<number | null>(() => {
  const r = plannerResult.value;
  if (!r.plan || r.creativeOnly || !r.naive) return null;
  return r.naive.totalCost - r.plan.totalCost;
});

/* ---------------------------------------------------------------- */
/* merge tree layout (SVG)                                           */
/* ---------------------------------------------------------------- */

const COL_W = 128;
const ROW_H = 92;
const LEAF_W = 116;
const LEAF_H = 60;
const JOIN_W = 74;
const JOIN_H = 26;
const PAD_X = 10;
const PAD_Y = 8;

interface TreeNode {
  key: number;
  kind: "item" | "book" | "join";
  title: string;
  lines: string[];
  cx: number;
  cy: number;
  height: number;
  cost?: number;
  step?: number;
  te?: boolean;
  children: TreeNode[];
}

function shorten(s: string, max = 15): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function leafLines(item: AnvilItem): string[] {
  const lines = item.enchants.map((e) => shorten(enchantText(e)));
  const out = lines.length > 3 ? [...lines.slice(0, 2), `+${lines.length - 2} more`] : lines;
  if (item.priorWork > 0) out.push(`prior work ${item.priorWork}`);
  return out.slice(0, 4);
}

interface MergeTree {
  nodes: TreeNode[];
  edges: { from: TreeNode; to: TreeNode }[];
  width: number;
  height: number;
}

const mergeTree = computed<MergeTree | null>(() => {
  const r = plannerResult.value;
  if (!r.plan || !r.item) return null;
  const bookIndex = new Map<AnvilItem, number>();
  r.books.forEach((b, i) => bookIndex.set(b, i + 1));

  let keySeq = 0;
  const byResult = new Map<AnvilItem, TreeNode>();
  const nodes: TreeNode[] = [];
  const edges: { from: TreeNode; to: TreeNode }[] = [];

  function leafFor(item: AnvilItem): TreeNode {
    const isBook = item.kind === "book";
    const node: TreeNode = {
      key: keySeq++,
      kind: isBook ? "book" : "item",
      title: isBook ? `Book ${bookIndex.get(item) ?? ""}`.trim() : familyLabel(item.kind),
      lines: leafLines(item),
      cx: 0,
      cy: 0,
      height: 0,
      children: [],
    };
    nodes.push(node);
    return node;
  }

  let root: TreeNode | null = null;
  r.plan.steps.forEach((step, i) => {
    const left = byResult.get(step.target) ?? leafFor(step.target);
    const right = byResult.get(step.sacrifice) ?? leafFor(step.sacrifice);
    const join: TreeNode = {
      key: keySeq++,
      kind: "join",
      title: "",
      lines: [],
      cx: 0,
      cy: 0,
      height: Math.max(left.height, right.height) + 1,
      cost: step.outcome.displayedCost,
      step: i + 1,
      te: step.outcome.displayedCost >= 40,
      children: [left, right],
    };
    nodes.push(join);
    edges.push({ from: left, to: join }, { from: right, to: join });
    if (step.outcome.result) byResult.set(step.outcome.result, join);
    root = join;
  });
  if (!root) return null;

  // In-order x assignment: leaves get sequential columns, joins center on
  // their children. Leaves sit on the top row; each join one row per height.
  let leafSlot = 0;
  let maxHeight = 0;
  (function place(node: TreeNode) {
    if (node.children.length === 0) {
      node.cx = PAD_X + LEAF_W / 2 + leafSlot * COL_W;
      leafSlot += 1;
    } else {
      for (const c of node.children) place(c);
      node.cx = (node.children[0]!.cx + node.children[1]!.cx) / 2;
    }
    node.cy = PAD_Y + LEAF_H / 2 + node.height * ROW_H;
    maxHeight = Math.max(maxHeight, node.height);
  })(root);

  return {
    nodes,
    edges,
    width: PAD_X * 2 + (leafSlot - 1) * COL_W + LEAF_W,
    height: PAD_Y * 2 + LEAF_H / 2 + maxHeight * ROW_H + JOIN_H / 2 + 14,
  };
});

function edgePath(e: { from: TreeNode; to: TreeNode }): string {
  const fromBottom = e.from.cy + (e.from.kind === "join" ? JOIN_H / 2 : LEAF_H / 2);
  const toTop = e.to.cy - JOIN_H / 2;
  const midY = (fromBottom + toTop) / 2;
  return `M ${e.from.cx} ${fromBottom} L ${e.from.cx} ${midY} L ${e.to.cx} ${midY} L ${e.to.cx} ${toTop}`;
}

/* ---------------------------------------------------------------- */
/* horizon                                                           */
/* ---------------------------------------------------------------- */

const HORIZON_PRESETS = [0, 1, 3, 7, 15, 31];

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
      if (Array.isArray(s.books)) {
        // Accept both the current {priorWork, enchants} shape and the older
        // plain enchant-array shape from previously shared links.
        // A fragment is untrusted input, so an older or hand-edited link can be
        // missing either field. Partial says so, which makes the defaults real
        // rather than dead code, and a missing enchants array would otherwise
        // reach the template as undefined.
        plannerBooks.value = s.books.map((b: Partial<EditBook> | EditEnchant[]) =>
          Array.isArray(b) ? { priorWork: 0, enchants: b } : { priorWork: 0, enchants: [], ...b },
        );
      }
      if (typeof s.horizon === "number") horizonPriorWork.value = s.horizon;
      sanitizeForVersion();
      dropInapplicableEnchants();
    } catch {
      /* a malformed fragment falls back to defaults */
    }
  }
  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="planner">Optimal planner</TabsTrigger>
        <TabsTrigger value="combine">Combine</TabsTrigger>
        <TabsTrigger value="horizon">Too Expensive horizon</TabsTrigger>
      </TabsList>

      <!-- ========================== planner ========================== -->
      <TabsContent value="planner" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <!-- left pane: inventory -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Inventory
            </p>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex min-w-40 flex-col gap-1.5">
                <Label for="anvil-version-planner" class="text-xs text-muted-foreground">
                  Game version
                </Label>
                <SearchableSelect
                  v-if="versionSpec"
                  id="anvil-version-planner"
                  :spec="versionSpec"
                  :model-value="version"
                  @update:model-value="(v) => (version = v)"
                />
              </div>
              <div class="flex items-center gap-2 pb-1.5">
                <Switch
                  id="anvil-creative-planner"
                  :model-value="creative"
                  @update:model-value="(v) => (creative = Boolean(v))"
                />
                <Label
                  for="anvil-creative-planner"
                  class="cursor-pointer text-xs text-muted-foreground"
                >
                  Creative mode
                </Label>
              </div>
            </div>

            <div class="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-2.5">
              <div class="flex flex-wrap items-end gap-2">
                <div class="flex min-w-36 flex-1 flex-col gap-1.5">
                  <Label for="anvil-plan-kind" class="text-xs text-muted-foreground">Item</Label>
                  <SearchableSelect
                    id="anvil-plan-kind"
                    :spec="plannerKindSpec"
                    :model-value="plannerItem.kind"
                    @update:model-value="(v) => (plannerItem.kind = v)"
                  />
                </div>
                <div class="flex flex-col gap-1.5">
                  <Label for="anvil-plan-pw" class="text-xs text-muted-foreground"
                    >Prior work</Label
                  >
                  <Input
                    id="anvil-plan-pw"
                    type="number"
                    min="0"
                    class="h-8 w-24"
                    :model-value="plannerItem.priorWork"
                    @update:model-value="(v) => (plannerItem.priorWork = Number(v) || 0)"
                  />
                </div>
              </div>
              <div v-for="(e, i) in plannerItem.enchants" :key="i" class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <SearchableSelect
                    :id="`anvil-plan-ench-${i}`"
                    :spec="plannerItemEnchantSpec"
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
                  @click="plannerItem.enchants.splice(i, 1)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="w-fit"
                :disabled="!canAddEnchant(plannerItem.enchants, plannerItem.kind, true)"
                @click="addEnchant(plannerItem.enchants, plannerItem.kind, true)"
              >
                <Plus class="size-3.5" />
                Existing enchantment on the item
              </Button>
            </div>

            <div class="flex items-center justify-between">
              <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Books ({{ plannerBooks.length }} of 7)
              </p>
              <Button size="sm" variant="outline" @click="loadPreset">
                <Sparkles class="size-3.5" />
                Load god kit
              </Button>
            </div>

            <div
              v-for="(bk, bi) in plannerBooks"
              :key="bi"
              class="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-2.5"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">Book {{ bi + 1 }}</span>
                <div class="flex items-center gap-1.5">
                  <Label
                    :for="`anvil-book-${bi}-pw`"
                    class="text-xs whitespace-nowrap text-muted-foreground"
                  >
                    Prior work
                  </Label>
                  <Input
                    :id="`anvil-book-${bi}-pw`"
                    type="number"
                    min="0"
                    class="h-7 w-16"
                    :model-value="bk.priorWork"
                    @update:model-value="(v) => (bk.priorWork = Number(v) || 0)"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    :aria-label="`Remove book ${bi + 1}`"
                    @click="plannerBooks.splice(bi, 1)"
                  >
                    <Trash2 class="size-3.5" />
                  </Button>
                </div>
              </div>
              <div v-for="(e, i) in bk.enchants" :key="i" class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
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
                    @click="bk.enchants.splice(i, 1)"
                  >
                    <Trash2 class="size-3.5" />
                  </Button>
                </div>
                <p v-if="willNotTransfer(e.id, plannerItem.kind)" class="text-xs text-destructive">
                  Will not transfer to {{ familyLabel(plannerItem.kind) }}: the anvil drops it and
                  still charges the clash penalty.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="w-fit"
                :disabled="!canAddEnchant(bk.enchants)"
                @click="addEnchant(bk.enchants, plannerItem.kind)"
              >
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

          <!-- right pane: plan and totals -->
          <div class="flex min-w-0 flex-col gap-3">
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

            <template v-else-if="plannerResult.plan">
              <div
                v-if="plannerResult.creativeOnly"
                class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
              >
                <p class="font-medium text-destructive">No survival plan exists for this build.</p>
                <p class="mt-1 text-muted-foreground">
                  Showing the cheapest creative-only plan. Steps costing 40 or more are highlighted;
                  a survival anvil refuses them.
                </p>
              </div>

              <!-- stat tiles -->
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Total levels</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ plannerResult.plan.totalCost }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Worst single step</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ plannerResult.plan.maxStepCost }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Anvil steps</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ plannerResult.plan.steps.length }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Saved vs listed order</div>
                  <div class="font-mono text-lg tabular-nums">
                    <template v-if="plannerSavings !== null">{{ plannerSavings }}</template>
                    <template v-else-if="plannerResult.creativeOnly">n/a</template>
                    <template v-else>
                      <span
                        class="text-sm"
                        title="Applying the books one by one in the listed order hits Too Expensive"
                      >
                        order fails
                      </span>
                    </template>
                  </div>
                </div>
              </div>

              <!-- merge tree -->
              <div
                v-if="mergeTree"
                class="rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]"
              >
                <p
                  class="mb-1 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                >
                  Merge tree
                </p>
                <div class="overflow-x-auto">
                  <svg
                    :width="mergeTree.width"
                    :height="mergeTree.height"
                    :viewBox="`0 0 ${mergeTree.width} ${mergeTree.height}`"
                    role="img"
                    aria-label="Diagram of the optimal combine order: which book merges into which, with the level cost of each join"
                    class="block text-foreground"
                  >
                    <title>Optimal anvil merge tree</title>
                    <!-- edges -->
                    <path
                      v-for="(e, i) in mergeTree.edges"
                      :key="`e${i}`"
                      :d="edgePath(e)"
                      fill="none"
                      :stroke="e.to.te ? 'var(--destructive)' : 'var(--border)'"
                      stroke-width="1.5"
                    />
                    <!-- nodes -->
                    <g v-for="n in mergeTree.nodes" :key="n.key">
                      <template v-if="n.kind !== 'join'">
                        <rect
                          :x="n.cx - LEAF_W / 2"
                          :y="n.cy - LEAF_H / 2"
                          :width="LEAF_W"
                          :height="LEAF_H"
                          rx="8"
                          fill="var(--card)"
                          :stroke="n.kind === 'item' ? 'var(--primary)' : 'var(--border)'"
                          stroke-width="1"
                        />
                        <text
                          :x="n.cx"
                          :y="n.cy - LEAF_H / 2 + 15"
                          text-anchor="middle"
                          font-size="11"
                          font-weight="600"
                          fill="currentColor"
                        >
                          {{ shorten(n.title, 17) }}
                        </text>
                        <text
                          v-for="(line, li) in n.lines"
                          :key="li"
                          :x="n.cx"
                          :y="n.cy - LEAF_H / 2 + 27 + li * 11"
                          text-anchor="middle"
                          font-size="9"
                          fill="var(--muted-foreground)"
                        >
                          {{ line }}
                        </text>
                      </template>
                      <template v-else>
                        <rect
                          :x="n.cx - JOIN_W / 2"
                          :y="n.cy - JOIN_H / 2"
                          :width="JOIN_W"
                          :height="JOIN_H"
                          rx="13"
                          :fill="n.te ? 'var(--destructive)' : 'var(--primary)'"
                        />
                        <text
                          :x="n.cx"
                          :y="n.cy + 3.5"
                          text-anchor="middle"
                          font-size="10.5"
                          font-weight="600"
                          font-family="var(--font-mono, monospace)"
                          fill="var(--primary-foreground, #fff)"
                        >
                          {{ n.step }}. +{{ n.cost }} lv
                        </text>
                      </template>
                    </g>
                  </svg>
                </div>
                <p class="mt-1 text-xs text-muted-foreground">
                  Read top to bottom: each pill is one anvil use with its level cost. The outlined
                  box is your item.
                </p>
              </div>

              <!-- step list -->
              <div
                class="flex flex-col gap-2 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]"
                aria-live="polite"
              >
                <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Step by step
                </p>
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
                    <span
                      class="font-mono font-medium tabular-nums"
                      :class="step.outcome.displayedCost >= 40 ? 'text-destructive' : ''"
                    >
                      {{ step.outcome.displayedCost }} levels
                    </span>
                  </li>
                </ol>
                <p class="text-xs text-muted-foreground">
                  Final item: {{ describe(plannerResult.plan.finalItem) }} with prior work penalty
                  {{ plannerResult.plan.finalItem.priorWork }}.
                  <template v-if="plannerResult.naive && plannerSavings !== null">
                    Applying the books in listed order would cost
                    {{ plannerResult.naive.totalCost }} levels.
                  </template>
                </p>
              </div>
            </template>

            <div
              v-else
              class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
            >
              <p class="text-sm text-muted-foreground">
                Add books on the left and the cheapest merge order appears here. Your files and
                inputs never leave your device.
              </p>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- ========================== combine ========================== -->
      <TabsContent value="combine" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <!-- left pane: inventory -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Anvil slots
            </p>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex min-w-40 flex-col gap-1.5">
                <Label for="anvil-version-combine" class="text-xs text-muted-foreground">
                  Game version
                </Label>
                <SearchableSelect
                  v-if="versionSpec"
                  id="anvil-version-combine"
                  :spec="versionSpec"
                  :model-value="version"
                  @update:model-value="(v) => (version = v)"
                />
              </div>
              <div class="flex items-center gap-2 pb-1.5">
                <Switch
                  id="anvil-creative-combine"
                  :model-value="creative"
                  @update:model-value="(v) => (creative = Boolean(v))"
                />
                <Label
                  for="anvil-creative-combine"
                  class="cursor-pointer text-xs text-muted-foreground"
                >
                  Creative mode
                </Label>
              </div>
            </div>

            <!-- target -->
            <div class="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-2.5">
              <p class="text-xs font-medium">Target (left slot)</p>
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
                    Prior work
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
              <div v-for="(e, i) in target.enchants" :key="i" class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <SearchableSelect
                    :id="`anvil-target-ench-${i}`"
                    :spec="targetEnchantSpec"
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
                variant="ghost"
                size="sm"
                class="w-fit"
                :disabled="!canAddEnchant(target.enchants, target.kind, true)"
                @click="addEnchant(target.enchants, target.kind, true)"
              >
                <Plus class="size-3.5" />
                Add enchantment
              </Button>
            </div>

            <!-- sacrifice -->
            <div class="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-2.5">
              <p class="text-xs font-medium">Sacrifice (right slot)</p>
              <div class="flex flex-col gap-1.5">
                <Label for="anvil-sac-mode" class="text-xs text-muted-foreground"
                  >Second slot</Label
                >
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
                      Prior work
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
                    <Label for="anvil-sac-damage" class="text-xs text-muted-foreground">
                      Damage
                    </Label>
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
                    Prior work (book)
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
                <div v-for="(e, i) in sacrifice.enchants" :key="i" class="flex flex-col gap-1">
                  <div class="flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <SearchableSelect
                        :id="`anvil-sac-ench-${i}`"
                        :spec="sacrificeMode === 'item' ? sacrificeItemEnchantSpec : enchantSpec"
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
                  <p
                    v-if="sacrificeMode === 'book' && willNotTransfer(e.id, target.kind)"
                    class="text-xs text-destructive"
                  >
                    Will not transfer to {{ familyLabel(target.kind) }}: the anvil drops it and
                    still charges the clash penalty.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="w-fit"
                  :disabled="
                    !canAddEnchant(sacrifice.enchants, target.kind, sacrificeMode === 'item')
                  "
                  @click="addEnchant(sacrifice.enchants, target.kind, sacrificeMode === 'item')"
                >
                  <Plus class="size-3.5" />
                  Add enchantment
                </Button>
              </template>

              <p v-else class="text-xs text-muted-foreground">
                Leave the second slot empty and rename below. Rename-only costs clamp at 39 levels
                and never raise the prior work penalty.
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

          <!-- right pane: result -->
          <div class="flex min-w-0 flex-col gap-3">
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

            <template v-else-if="combineResult.outcome">
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Level cost</div>
                  <div
                    class="font-mono text-lg tabular-nums"
                    :class="
                      combineResult.outcome.status === 'too-expensive' ? 'text-destructive' : ''
                    "
                  >
                    {{ combineResult.outcome.displayedCost }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Work portion</div>
                  <div class="font-mono text-lg tabular-nums">{{ combineResult.outcome.work }}</div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Prior work portion</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ combineResult.outcome.priorWorkCost }}
                  </div>
                </div>
                <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                  <div class="text-xs text-muted-foreground">Penalty after</div>
                  <div class="font-mono text-lg tabular-nums">
                    {{ combineResult.outcome.result ? combineResult.outcome.result.priorWork : 0 }}
                  </div>
                </div>
              </div>

              <div
                class="flex flex-col gap-3 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]"
                aria-live="polite"
              >
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
                  Survival anvils refuse any combine of 40 levels or more. Turn on creative mode to
                  see the outcome anyway.
                </p>
              </div>
            </template>

            <div
              v-else
              class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
            >
              <p class="text-sm text-muted-foreground">
                Pick a sacrifice or a rename on the left to see the cost. Your files and inputs
                never leave your device.
              </p>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- ========================== horizon ========================== -->
      <TabsContent value="horizon" class="pt-4">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <!-- left pane -->
          <div class="flex flex-col gap-3 rounded-[14px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Current penalty
            </p>
            <div class="flex flex-col gap-1.5">
              <Label for="anvil-horizon-pw" class="text-xs text-muted-foreground">
                Prior work penalty
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
            <div class="flex flex-wrap gap-1.5">
              <Button
                v-for="p in HORIZON_PRESETS"
                :key="p"
                variant="outline"
                size="sm"
                class="font-mono tabular-nums"
                :aria-pressed="horizonPriorWork === p"
                @click="horizonPriorWork = p"
              >
                {{ p }}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              The stored penalty is 0, 1, 3, 7, 15, 31, 63... doubling plus one after every combine.
              Pick the value your item shows, or the number of times it has been worked.
            </p>
          </div>

          <!-- right pane -->
          <div class="flex min-w-0 flex-col gap-3">
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Combines left</div>
                <div class="font-mono text-lg tabular-nums">{{ horizonSteps.length }}</div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Max work right now</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ horizonSteps[0]?.maxAffordableWork ?? 0 }}
                </div>
              </div>
              <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
                <div class="text-xs text-muted-foreground">Penalty after next</div>
                <div class="font-mono text-lg tabular-nums">
                  {{ horizonSteps[0]?.priorWorkAfter ?? horizonPriorWork }}
                </div>
              </div>
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
                {{ horizonSteps.length }} combine{{ horizonSteps.length === 1 ? "" : "s" }} left
                before everything except renaming is Too Expensive. A combine needs its penalty plus
                at least 1 level of work under 40. Renaming alone clamps to 39 levels and never
                raises the penalty, so it stays possible forever.
              </p>
            </div>

            <div
              v-else
              class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
            >
              <p class="text-sm text-muted-foreground">
                At penalty {{ Math.max(0, Math.round(horizonPriorWork) || 0) }} every combine
                already costs 40 or more: this item is Too Expensive for anything except renaming
                (39 levels) or creative mode.
              </p>
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>

    <p class="text-xs text-muted-foreground">
      Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
    </p>
  </div>
</template>
