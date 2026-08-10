import { ToolError, type ToolLogic } from "../types";
import {
  LOOT_DATA,
  type RawCondition,
  type RawEntry,
  type RawFunction,
  type RawLootTable,
  type RawNumber,
  type RawPool,
} from "./data";
import { LOOT_TABLES, LOOT_VERSIONS } from "./tables";

/**
 * Exact loot probability engine over the real per-version vanilla loot table
 * JSON (see data.ts, generated from mcmeta by mc-pipeline/05-emit-loot-data.mjs).
 *
 * Every distribution is derived analytically, never by simulation:
 * per-entry count distributions come from the shipped number providers and
 * bonus formulas, per-roll outcomes from weighted entry selection, and
 * per-generation results from convolution across independent rolls and pools.
 * Semantics were cross-checked against the decompiled game source under
 * mc-pipeline/work/<version>/src/ (ApplyBonusCount, LootPool, EnchantedCount-
 * IncreaseFunction, BonusLevelTableCondition, LootPoolSingletonContainer):
 *
 * - rolls: NumberProvider.getInt; int uniforms are INCLUSIVE on both ends,
 *   plus floor(bonus_rolls * luck) extra rolls.
 * - entry weight in a pool: max(floor(weight + quality * luck), 0); entries
 *   with weight 0 never enter the candidate list.
 * - alternatives entries short-circuit: children are tried in order and the
 *   first whose conditions pass supplies the drop.
 * - apply_bonus ore_drops: count * m where m = max(nextInt(level+2) - 1, 0)+1,
 *   so P(m=1) = 2/(level+2) and P(m=k) = 1/(level+2) for k = 2..level+1.
 * - apply_bonus uniform_bonus_count adds nextInt(bonusMultiplier*level + 1);
 *   binomial_with_bonus_count adds Binomial(level + extra, probability).
 * - looting_enchant / enchanted_count_increase adds round(level * U) where U
 *   is a CONTINUOUS uniform float from the provider (getFloat), rounded
 *   half-up, optionally clamped by `limit`.
 * - table_bonus passes with chances[min(enchantLevel, len-1)].
 * - survives_explosion and explosion_decay are no-ops without an explosion
 *   radius in the context, which is always the case for the contexts this
 *   tool models (mining, kills, fishing, chests).
 */

// ------------------------------------------------------------- contexts --

export const TOOL_ITEMS: Record<string, string | null> = {
  none: null,
  pickaxe: "minecraft:diamond_pickaxe",
  shovel: "minecraft:diamond_shovel",
  axe: "minecraft:diamond_axe",
  hoe: "minecraft:diamond_hoe",
  sword: "minecraft:diamond_sword",
  shears: "minecraft:shears",
};

/** The one item tag used by shipped match_tool predicates. */
const ITEM_TAGS: Record<string, string[]> = {
  "minecraft:cluster_max_harvestables": [
    "minecraft:wooden_pickaxe",
    "minecraft:stone_pickaxe",
    "minecraft:iron_pickaxe",
    "minecraft:golden_pickaxe",
    "minecraft:diamond_pickaxe",
    "minecraft:netherite_pickaxe",
  ],
};

export interface CalcOptions {
  version: string;
  table: string;
  /** Tool kind key from TOOL_ITEMS. */
  tool?: string;
  fortune?: number;
  silkTouch?: boolean;
  looting?: number;
  killedByPlayer?: boolean;
  onFire?: boolean;
  luckOfTheSea?: number;
  openWater?: boolean;
  /** Crops: evaluate age-based conditions at max age (true) or age 0 (false). */
  cropMature?: boolean;
}

interface Ctx {
  toolItem: string | null;
  fortune: number;
  silkTouch: boolean;
  looting: number;
  killedByPlayer: boolean;
  onFire: boolean;
  openWater: boolean;
  /** Generic luck value; Luck of the Sea level for fishing contexts. */
  luck: number;
  /** Block state assumed for block_state_property checks, e.g. { age: "7" }. */
  blockStates: Record<string, string>;
  notes: Set<string>;
}

// -------------------------------------------------------- distributions --

/** Discrete distribution over integer counts: count -> probability. */
type Dist = Map<number, number>;

const EPS = 1e-12;

function constDist(n: number): Dist {
  return new Map([[n, 1]]);
}

function addTo(d: Dist, k: number, p: number): void {
  if (p <= 0) return;
  d.set(k, (d.get(k) ?? 0) + p);
}

function convolve(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [ka, pa] of a) for (const [kb, pb] of b) addTo(out, ka + kb, pa * pb);
  return prune(out);
}

function mixture(parts: Array<[Dist, number]>): Dist {
  const out: Dist = new Map();
  for (const [d, w] of parts) {
    if (w <= 0) continue;
    for (const [k, p] of d) addTo(out, k, p * w);
  }
  return prune(out);
}

function mapCounts(d: Dist, f: (k: number) => number): Dist {
  const out: Dist = new Map();
  for (const [k, p] of d) addTo(out, f(k), p);
  return out;
}

function prune(d: Dist): Dist {
  for (const [k, p] of d) if (p < EPS) d.delete(k);
  return d;
}

function ev(d: Dist): number {
  let s = 0;
  for (const [k, p] of d) s += k * p;
  return s;
}

function variance(d: Dist): number {
  const m = ev(d);
  let s = 0;
  for (const [k, p] of d) s += (k - m) * (k - m) * p;
  return s;
}

function binomialDist(n: number, p: number): Dist {
  const out: Dist = new Map();
  let coeff = 1;
  for (let k = 0; k <= n; k++) {
    addTo(out, k, coeff * Math.pow(p, k) * Math.pow(1 - p, n - k));
    coeff = (coeff * (n - k)) / (k + 1);
  }
  return out;
}

/** Distribution of Math.round(level * U(min, max)) with U a continuous float. */
function roundedScaledUniform(level: number, min: number, max: number): Dist {
  const lo = level * min;
  const hi = level * max;
  if (hi - lo < 1e-9) return constDist(Math.round(lo));
  const out: Dist = new Map();
  for (let k = Math.ceil(lo - 0.5); k <= Math.floor(hi + 0.5); k++) {
    const a = Math.max(lo, k - 0.5);
    const b = Math.min(hi, k + 0.5);
    if (b > a) addTo(out, k, (b - a) / (hi - lo));
  }
  return out;
}

// ------------------------------------------------------ number providers --

interface NumProvider {
  kind: "const" | "uniform" | "binomial";
  value?: number;
  min?: number;
  max?: number;
  n?: number;
  p?: number;
}

function rawNum(v: RawNumber | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v;
  if (typeof v.value === "number") return v.value;
  throw new ToolError("bad-number", "Nested number providers are not used by vanilla tables.");
}

function parseProvider(raw: RawNumber): NumProvider {
  if (typeof raw === "number") return { kind: "const", value: raw };
  const type = (raw.type ?? "").replace(/^minecraft:/, "");
  if (type === "constant") return { kind: "const", value: rawNum(raw.value, 0) };
  if (type === "binomial") return { kind: "binomial", n: rawNum(raw.n, 0), p: rawNum(raw.p, 0) };
  if (type === "uniform" || (!type && (raw.min !== undefined || raw.max !== undefined))) {
    return { kind: "uniform", min: rawNum(raw.min, 0), max: rawNum(raw.max, 0) };
  }
  throw new ToolError("bad-number", `Unsupported number provider type "${type}".`);
}

/** Integer sampling distribution (NumberProvider.getInt semantics). */
function intDist(raw: RawNumber): Dist {
  const p = parseProvider(raw);
  if (p.kind === "const") return constDist(Math.round(p.value ?? 0));
  if (p.kind === "binomial") return binomialDist(Math.round(p.n ?? 0), p.p ?? 0);
  const min = Math.floor(p.min ?? 0);
  const max = Math.floor(p.max ?? 0);
  if (min >= max) return constDist(min);
  const out: Dist = new Map();
  for (let k = min; k <= max; k++) addTo(out, k, 1 / (max - min + 1));
  return out;
}

// ------------------------------------------------------------ conditions --

function toolEnchantLevel(ctx: Ctx, enchantId: string): number {
  const id = enchantId.replace(/^minecraft:/, "");
  if (ctx.toolItem === null) return 0;
  if (id === "fortune") return ctx.fortune;
  if (id === "silk_touch") return ctx.silkTouch ? 1 : 0;
  if (id === "luck_of_the_sea") return ctx.luck;
  return 0;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Strip "minecraft:" prefixes from object keys (26.2 namespaces predicate keys). */
function stripNs(obj: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k.replace(/^minecraft:/, "")] = v;
    }
  }
  return out;
}

function matchToolItems(ctx: Ctx, spec: unknown): boolean {
  const wanted = Array.isArray(spec) ? (spec as string[]) : [spec as string];
  return wanted.some((w) => {
    if (typeof w !== "string") return false;
    if (w.startsWith("#")) return (ITEM_TAGS[w.slice(1)] ?? []).includes(ctx.toolItem ?? "");
    return ctx.toolItem === w;
  });
}

interface EnchantCheck {
  enchantment?: string;
  enchantments?: string;
  levels?: { min?: number; max?: number };
}

function matchEnchants(ctx: Ctx, list: EnchantCheck[], notes: Set<string>): boolean {
  return list.every((e) => {
    const id = e.enchantments ?? e.enchantment;
    if (typeof id !== "string" || id.startsWith("#")) {
      notes.add(`Enchantment tag predicate ${String(id)} treated as never matching.`);
      return false;
    }
    const level = toolEnchantLevel(ctx, id);
    const min = e.levels?.min ?? 1;
    const max = e.levels?.max;
    return level >= min && (max === undefined || level <= max);
  });
}

/** match_tool across the NBT-era and component-era predicate shapes. */
function evalMatchTool(ctx: Ctx, cond: RawCondition): number {
  if (ctx.toolItem === null) return 0;
  const pred = (cond.predicate ?? {}) as Record<string, unknown>;
  if (pred.item !== undefined && !matchToolItems(ctx, pred.item)) return 0;
  if (pred.items !== undefined && !matchToolItems(ctx, pred.items)) return 0;
  if (pred.tag !== undefined && !matchToolItems(ctx, `#${String(pred.tag)}`)) return 0;
  const enchNbt = pred.enchantments as EnchantCheck[] | undefined;
  if (enchNbt && !matchEnchants(ctx, enchNbt, ctx.notes)) return 0;
  const sub = stripNs(pred.predicates);
  const enchComp = sub.enchantments as EnchantCheck[] | undefined;
  if (enchComp && !matchEnchants(ctx, enchComp, ctx.notes)) return 0;
  return 1;
}

function evalBlockState(ctx: Ctx, cond: RawCondition): number {
  const props = (cond.properties ?? {}) as Record<string, unknown>;
  for (const [key, want] of Object.entries(props)) {
    const have = ctx.blockStates[key];
    if (have === undefined) {
      ctx.notes.add(
        `Block state "${key}" is not part of this tool's context; conditions on it are treated as not matching.`,
      );
      return 0;
    }
    if (typeof want === "object" && want !== null) {
      const range = want as { min?: number | string; max?: number | string };
      const n = Number(have);
      if (range.min !== undefined && n < Number(range.min)) return 0;
      if (range.max !== undefined && n > Number(range.max)) return 0;
    } else if (String(want) !== have) {
      return 0;
    }
  }
  return 1;
}

function evalEntityProperties(ctx: Ctx, cond: RawCondition): number {
  const entity = String(cond.entity ?? "this");
  const pred = stripNs(cond.predicate);
  const keys = Object.keys(pred);
  if (entity === "this" && keys.length === 1 && keys[0] === "flags") {
    const flags = stripNs(pred.flags);
    if (Object.keys(flags).length === 1 && "is_on_fire" in flags) {
      return flags.is_on_fire === ctx.onFire ? 1 : 0;
    }
  }
  if (entity === "this" && keys.length === 1 && keys[0] === "fishing_hook") {
    const hook = stripNs(pred.fishing_hook);
    if ("in_open_water" in hook) return hook.in_open_water === ctx.openWater ? 1 : 0;
  }
  if (entity === "this" && keys.length === 1 && keys[0] === "type_specific") {
    const ts = stripNs(pred.type_specific);
    if (String(ts.type).endsWith("fishing_hook") && "in_open_water" in ts) {
      return ts.in_open_water === ctx.openWater ? 1 : 0;
    }
  }
  ctx.notes.add(
    `An entity_properties condition on "${entity}" (${keys.join(", ")}) is outside this tool's context and treated as never true.`,
  );
  return 0;
}

/**
 * Probability that a condition passes. Random conditions draw independent
 * randomness on every evaluation in game code, so probabilities compose by
 * simple products; deterministic conditions evaluate to exactly 0 or 1.
 */
function evalCondition(ctx: Ctx, cond: RawCondition): number {
  const kind = cond.condition.replace(/^minecraft:/, "");
  switch (kind) {
    case "survives_explosion":
      return 1; // no explosion radius in any modeled context
    case "match_tool":
      return evalMatchTool(ctx, cond);
    case "table_bonus": {
      const chances = cond.chances as number[];
      const level = toolEnchantLevel(ctx, String(cond.enchantment));
      return chances[Math.min(level, chances.length - 1)];
    }
    case "random_chance":
      return rawNum(cond.chance as RawNumber, 0);
    case "random_chance_with_looting":
      return clamp01(
        rawNum(cond.chance as RawNumber, 0) +
          ctx.looting * rawNum(cond.looting_multiplier as RawNumber, 0),
      );
    case "random_chance_with_enchanted_bonus": {
      const unench = rawNum(cond.unenchanted_chance as RawNumber, 0);
      if (ctx.looting <= 0) return clamp01(unench);
      const ench = cond.enchanted_chance as
        number | { type?: string; base?: number; per_level_above_first?: number };
      if (typeof ench === "number") return clamp01(ench);
      return clamp01((ench.base ?? 0) + (ench.per_level_above_first ?? 0) * (ctx.looting - 1));
    }
    case "killed_by_player":
      return ctx.killedByPlayer ? 1 : 0;
    case "block_state_property":
      return evalBlockState(ctx, cond);
    case "entity_properties":
      return evalEntityProperties(ctx, cond);
    case "inverted":
      return 1 - evalCondition(ctx, cond.term as RawCondition);
    case "alternative":
    case "any_of": {
      const terms = (cond.terms ?? []) as RawCondition[];
      let pNone = 1;
      for (const t of terms) pNone *= 1 - evalCondition(ctx, t);
      return 1 - pNone;
    }
    case "all_of": {
      const terms = (cond.terms ?? []) as RawCondition[];
      let p = 1;
      for (const t of terms) p *= evalCondition(ctx, t);
      return p;
    }
    case "damage_source_properties":
      ctx.notes.add(
        "A damage_source_properties condition (specific cause of death) is outside this tool's context and treated as never true.",
      );
      return 0;
    case "location_check":
      ctx.notes.add(
        "A location_check condition (biome or neighboring block) is outside this tool's context and treated as never true.",
      );
      return 0;
    default:
      ctx.notes.add(`Unknown condition "${kind}" treated as never true.`);
      return 0;
  }
}

function conditionsProb(ctx: Ctx, conds: RawCondition[] | undefined): number {
  let p = 1;
  for (const c of conds ?? []) p *= evalCondition(ctx, c);
  return p;
}

// ------------------------------------------------------- count functions --

/** Apply the count-affecting item functions, in order, to a count distribution. */
function applyFunctions(ctx: Ctx, dist: Dist, fns: RawFunction[] | undefined): Dist {
  let d = dist;
  for (const fn of fns ?? []) {
    const q = conditionsProb(ctx, fn.conditions);
    if (q <= 0) continue;
    const applied = applyFunction(ctx, d, fn);
    d =
      q >= 1
        ? applied
        : mixture([
            [applied, q],
            [d, 1 - q],
          ]);
  }
  return d;
}

function applyFunction(ctx: Ctx, d: Dist, fn: RawFunction): Dist {
  const kind = fn.function.replace(/^minecraft:/, "");
  switch (kind) {
    case "set_count": {
      const value = intDist(fn.count as RawNumber);
      if (fn.add === true) return convolve(d, value);
      return value; // replace (also the pre-1.17 behavior, where `add` does not exist)
    }
    case "apply_bonus": {
      const level = toolEnchantLevel(ctx, String(fn.enchantment));
      const formula = String(fn.formula).replace(/^minecraft:/, "");
      const params = (fn.parameters ?? {}) as Record<string, number>;
      if (level <= 0 && formula === "ore_drops") return d;
      if (formula === "ore_drops") {
        // m = max(nextInt(level+2) - 1, 0) + 1: P(1) = 2/(level+2), else 1/(level+2)
        const n = level + 2;
        const mult: Dist = new Map([[1, 2 / n]]);
        for (let m = 2; m <= level + 1; m++) mult.set(m, 1 / n);
        return prune(
          mixture([...mult].map(([m, p]) => [mapCounts(d, (k) => k * m), p] as [Dist, number])),
        );
      }
      if (formula === "uniform_bonus_count") {
        const span = (params.bonusMultiplier ?? 1) * level;
        if (span <= 0) return d;
        const bonus: Dist = new Map();
        for (let k = 0; k <= span; k++) addTo(bonus, k, 1 / (span + 1));
        return convolve(d, bonus);
      }
      if (formula === "binomial_with_bonus_count") {
        const n = level + (params.extra ?? 0);
        if (n <= 0) return d;
        return convolve(d, binomialDist(n, params.probability ?? 0));
      }
      throw new ToolError("bad-formula", `Unknown apply_bonus formula "${formula}".`);
    }
    case "looting_enchant":
    case "enchanted_count_increase": {
      const level = ctx.looting;
      if (level <= 0) return d;
      const prov = parseProvider(fn.count as RawNumber);
      const add =
        prov.kind === "const"
          ? constDist(Math.round(level * (prov.value ?? 0)))
          : roundedScaledUniform(level, prov.min ?? 0, prov.max ?? 0);
      let out = convolve(d, add);
      const limit = fn.limit as number | undefined;
      if (typeof limit === "number") out = mapCounts(out, (k) => Math.min(k, limit));
      return out;
    }
    case "limit_count": {
      const limit = (fn.limit ?? {}) as number | { min?: RawNumber; max?: RawNumber };
      if (typeof limit === "number") return mapCounts(d, (k) => Math.min(k, limit));
      const lo = limit.min === undefined ? undefined : Math.round(rawNum(limit.min, 0));
      const hi = limit.max === undefined ? undefined : Math.round(rawNum(limit.max, 0));
      return mapCounts(d, (k) => {
        let v = k;
        if (lo !== undefined) v = Math.max(v, lo);
        if (hi !== undefined) v = Math.min(v, hi);
        return v;
      });
    }
    default:
      ctx.notes.add(`Function "${kind}" does not affect counts and was ignored.`);
      return d;
  }
}

// ------------------------------------------------- joint outcome algebra --

/** One full-generation outcome: which items with which totals, and how likely. */
interface Outcome {
  items: Record<string, number>;
  p: number;
}

/** Joint distribution over multiset outcomes, keyed by harness signature. */
type Joint = Map<string, Outcome>;

/** Above this many distinct outcomes the joint view degrades to marginals. */
const JOINT_CAP = 4000;

/** Signature identical to the measurement harness: sorted "id:count" CSV, or "nothing". */
export function outcomeKey(items: Record<string, number>): string {
  const parts = Object.entries(items)
    .filter(([, c]) => c > 0)
    .sort()
    .map(([k, c]) => `${k}:${c}`);
  return parts.length ? parts.join(",") : "nothing";
}

function jointOf(items: Record<string, number>, p: number): Joint {
  return new Map([[outcomeKey(items), { items, p }]]);
}

function emptyJoint(): Joint {
  return jointOf({}, 1);
}

function addOutcome(j: Joint, items: Record<string, number>, p: number): void {
  if (p < EPS) return;
  const key = outcomeKey(items);
  const prev = j.get(key);
  if (prev) prev.p += p;
  else j.set(key, { items, p });
}

function convJoint(a: Joint | null, b: Joint | null): Joint | null {
  if (!a || !b) return null;
  const out: Joint = new Map();
  for (const { items: ia, p: pa } of a.values()) {
    for (const { items: ib, p: pb } of b.values()) {
      const merged: Record<string, number> = { ...ia };
      for (const [k, c] of Object.entries(ib)) merged[k] = (merged[k] ?? 0) + c;
      addOutcome(out, merged, pa * pb);
      if (out.size > JOINT_CAP) return null;
    }
  }
  return out;
}

function mixJoint(parts: Array<[Joint | null, number]>): Joint | null {
  const out: Joint = new Map();
  for (const [j, w] of parts) {
    if (w <= 0) continue;
    if (!j) return null;
    for (const { items, p } of j.values()) addOutcome(out, items, p * w);
    if (out.size > JOINT_CAP) return null;
  }
  return out;
}

// -------------------------------------------------------- entry expansion --

/** What one selected candidate produces (single item stack or a nested table). */
interface Singleton {
  weight: number;
  quality: number;
  payload:
    | { kind: "item"; name: string; functions?: RawFunction[] }
    | { kind: "table"; ref: string; functions?: RawFunction[] }
    | { kind: "empty" };
}

/** Mutually exclusive expansion results for one entry container. */
interface ExpandOption {
  p: number;
  sing: Singleton | null;
}

function expandEntry(ctx: Ctx, entry: RawEntry): ExpandOption[] {
  const q = conditionsProb(ctx, entry.conditions);
  const type = entry.type.replace(/^minecraft:/, "");
  let inner: ExpandOption[];
  const weight = entry.weight ?? 1;
  const quality = entry.quality ?? 0;
  switch (type) {
    case "item":
      inner = [
        {
          p: 1,
          sing: {
            weight,
            quality,
            payload: { kind: "item", name: String(entry.name), functions: entry.functions },
          },
        },
      ];
      break;
    case "empty":
      inner = [{ p: 1, sing: { weight, quality, payload: { kind: "empty" } } }];
      break;
    case "loot_table":
      inner = [
        {
          p: 1,
          sing: {
            weight,
            quality,
            payload: { kind: "table", ref: String(entry.ref), functions: entry.functions },
          },
        },
      ];
      break;
    case "alternatives": {
      // Children are tried in order; the first that expands wins.
      inner = [];
      let carry = 1;
      for (const child of entry.children ?? []) {
        const childOptions = expandEntry(ctx, child);
        for (const opt of childOptions) {
          if (opt.sing) inner.push({ p: carry * opt.p, sing: opt.sing });
        }
        const pNone = childOptions.filter((o) => !o.sing).reduce((s, o) => s + o.p, 0);
        carry *= pNone;
        if (carry < EPS) break;
      }
      if (carry >= EPS) inner.push({ p: carry, sing: null });
      break;
    }
    case "tag":
      if (q > 0) {
        ctx.notes.add(
          `A tag entry (${String(entry.name)}) cannot be resolved offline and contributes nothing here.`,
        );
      }
      inner = [{ p: 1, sing: null }];
      break;
    default:
      if (q > 0) ctx.notes.add(`Entry type "${type}" is not supported and contributes nothing.`);
      inner = [{ p: 1, sing: null }];
  }
  if (q >= 1) return inner;
  const out: ExpandOption[] = inner
    .filter((o) => o.sing)
    .map((o) => ({ p: o.p * q, sing: o.sing }));
  const pNone = 1 - out.reduce((s, o) => s + o.p, 0);
  if (pNone > EPS) out.push({ p: pNone, sing: null });
  return out;
}

// ------------------------------------------------------------ the engine --

interface TableResult {
  joint: Joint | null;
  marginals: Map<string, Dist>;
}

const MAX_DEPTH = 8;
const MAX_COMBOS = 4096;

function getTableDoc(version: string, id: string): RawLootTable | undefined {
  const idx = LOOT_DATA.tables[version]?.[id];
  return idx === undefined ? undefined : LOOT_DATA.pool[idx];
}

/** Full-generation distribution of a singleton's payload. */
function singletonResult(ctx: Ctx, version: string, sing: Singleton, depth: number): TableResult {
  const { payload } = sing;
  if (payload.kind === "empty") return { joint: emptyJoint(), marginals: new Map() };
  if (payload.kind === "item") {
    const countDist = applyFunctions(ctx, constDist(1), payload.functions);
    const joint: Joint = new Map();
    const marginal: Dist = new Map();
    for (const [count, p] of countDist) {
      addOutcome(joint, count > 0 ? { [payload.name]: count } : {}, p);
      addTo(marginal, Math.max(count, 0), p);
    }
    return { joint, marginals: new Map([[payload.name, prune(marginal)]]) };
  }
  // Nested loot table reference.
  if (payload.functions?.length) {
    ctx.notes.add(
      "Count functions on a loot_table reference entry are not modeled (none exist in vanilla tables).",
    );
  }
  return computeTable(ctx, version, payload.ref, depth + 1);
}

/** Distribution of a single roll of one pool (weighted selection among candidates). */
function rollResult(ctx: Ctx, version: string, pool: RawPool, depth: number): TableResult {
  const perEntry = (pool.entries ?? []).map((e) => expandEntry(ctx, e));
  // Enumerate combinations across entries that expand probabilistically.
  const probabilistic = perEntry.filter((opts) => opts.length > 1);
  const comboCount = probabilistic.reduce((n, opts) => n * opts.length, 1);
  if (comboCount > MAX_COMBOS) {
    throw new ToolError(
      "too-complex",
      "This table combines too many random conditions to enumerate exactly.",
      "Pick a different table; vanilla tables never hit this bound.",
    );
  }

  const jointParts: Array<[Joint | null, number]> = [];
  const marginalAcc = new Map<string, Array<[Dist, number]>>();
  let pEmptyTotal = 0;

  const combos: Array<{ p: number; picks: Array<Singleton | null> }> = [{ p: 1, picks: [] }];
  for (const opts of perEntry) {
    const next: typeof combos = [];
    for (const combo of combos) {
      if (opts.length === 1) {
        next.push({ p: combo.p, picks: [...combo.picks, opts[0].sing] });
      } else {
        for (const opt of opts) {
          if (combo.p * opt.p < EPS) continue;
          next.push({ p: combo.p * opt.p, picks: [...combo.picks, opt.sing] });
        }
      }
    }
    combos.length = 0;
    combos.push(...next);
  }

  const singletonCache = new Map<Singleton, TableResult>();
  const resolved = (sing: Singleton): TableResult => {
    let r = singletonCache.get(sing);
    if (!r) {
      r = singletonResult(ctx, version, sing, depth);
      singletonCache.set(sing, r);
    }
    return r;
  };

  for (const combo of combos) {
    const candidates = combo.picks.filter((s): s is Singleton => {
      if (!s) return false;
      return Math.max(Math.floor(s.weight + s.quality * ctx.luck), 0) > 0;
    });
    if (!candidates.length) {
      pEmptyTotal += combo.p;
      continue;
    }
    const totalWeight = candidates.reduce(
      (n, s) => n + Math.max(Math.floor(s.weight + s.quality * ctx.luck), 0),
      0,
    );
    for (const cand of candidates) {
      const w = Math.max(Math.floor(cand.weight + cand.quality * ctx.luck), 0);
      const pick = (combo.p * w) / totalWeight;
      const r = resolved(cand);
      jointParts.push([r.joint, pick]);
      for (const [item, dist] of r.marginals) {
        const acc = marginalAcc.get(item) ?? [];
        acc.push([dist, pick]);
        marginalAcc.set(item, acc);
      }
    }
  }

  if (pEmptyTotal > 0) jointParts.push([emptyJoint(), pEmptyTotal]);
  const joint = mixJoint(jointParts);
  // Per-item marginal for one roll: the item's count when its entry is picked,
  // else 0 (some other entry was picked or nothing dropped).
  const marginals = new Map<string, Dist>();
  for (const [item, parts] of marginalAcc) {
    const pCovered = parts.reduce((s, [, w]) => s + w, 0);
    const d = mixture([...parts, [constDist(0), 1 - pCovered]]);
    marginals.set(item, d);
  }
  return { joint, marginals };
}

function poolResult(ctx: Ctx, version: string, pool: RawPool, depth: number): TableResult {
  if (pool.functions?.length) {
    ctx.notes.add("Pool-level count functions are not modeled (none exist in vanilla tables).");
  }
  const pPass = conditionsProb(ctx, pool.conditions);
  if (pPass <= 0) return { joint: emptyJoint(), marginals: new Map() };

  const bonusProv = parseProvider(pool.bonus_rolls ?? 0);
  const bonus =
    bonusProv.kind === "const"
      ? Math.floor((bonusProv.value ?? 0) * ctx.luck)
      : (() => {
          ctx.notes.add("Non-constant bonus_rolls are approximated by their minimum.");
          return Math.floor((bonusProv.min ?? 0) * ctx.luck);
        })();
  const rolls = mapCounts(intDist(pool.rolls), (k) => Math.max(k + bonus, 0));

  const perRoll = rollResult(ctx, version, pool, depth);

  // Convolve across the (iid) rolls, mixing over the roll-count distribution.
  const jointParts: Array<[Joint | null, number]> = [];
  const marginalParts = new Map<string, Array<[Dist, number]>>();
  const maxRolls = Math.max(...[...rolls.keys()]);
  let jointPow: Joint | null = emptyJoint();
  const marginalPow = new Map<string, Dist>();
  for (const item of perRoll.marginals.keys()) marginalPow.set(item, constDist(0));

  for (let r = 0; r <= maxRolls; r++) {
    if (r > 0) {
      jointPow = convJoint(jointPow, perRoll.joint);
      for (const [item, d] of perRoll.marginals) {
        marginalPow.set(item, convolve(marginalPow.get(item) ?? constDist(0), d));
      }
    }
    const pr = rolls.get(r) ?? 0;
    if (pr > 0) {
      jointParts.push([jointPow, pr]);
      for (const [item, d] of marginalPow) {
        const acc = marginalParts.get(item) ?? [];
        acc.push([d, pr]);
        marginalParts.set(item, acc);
      }
    }
  }

  let joint = mixJoint(jointParts);
  const marginals = new Map<string, Dist>();
  for (const [item, parts] of marginalParts) {
    const covered = parts.reduce((s, [, w]) => s + w, 0);
    if (covered < 1 - EPS) parts.push([constDist(0), 1 - covered]);
    marginals.set(item, mixture(parts));
  }

  if (pPass < 1) {
    joint = mixJoint([
      [joint, pPass],
      [emptyJoint(), 1 - pPass],
    ]);
    for (const [item, d] of marginals) {
      marginals.set(
        item,
        mixture([
          [d, pPass],
          [constDist(0), 1 - pPass],
        ]),
      );
    }
  }
  return { joint, marginals };
}

function computeTable(ctx: Ctx, version: string, id: string, depth: number): TableResult {
  if (depth > MAX_DEPTH) {
    throw new ToolError("ref-cycle", `Loot table references nest too deeply at "${id}".`);
  }
  const doc = getTableDoc(version, id);
  if (!doc) {
    throw new ToolError(
      "missing-ref",
      `Referenced loot table "${id}" is not available for ${version}.`,
    );
  }
  if (doc.functions?.length) {
    ctx.notes.add("Table-level count functions are not modeled (none exist in vanilla tables).");
  }
  let joint: Joint | null = emptyJoint();
  const marginals = new Map<string, Dist>();
  for (const pool of doc.pools ?? []) {
    const r = poolResult(ctx, version, pool, depth);
    joint = convJoint(joint, r.joint);
    for (const [item, d] of r.marginals) {
      marginals.set(item, convolve(marginals.get(item) ?? constDist(0), d));
    }
  }
  return { joint, marginals };
}

// ------------------------------------------------------------ public API --

export interface LootItemResult {
  /** Item id, e.g. "minecraft:diamond". */
  item: string;
  /** Human-readable item name. */
  name: string;
  /** Probability of at least one dropping per generation. */
  chance: number;
  /** Expected count per generation. */
  expected: number;
  /** Variance of the count per generation. */
  variance: number;
  /** Smallest and largest possible nonzero drop counts. */
  min: number;
  max: number;
  /** Exact count distribution as [count, probability], ascending, incl 0. */
  dist: Array<[number, number]>;
}

export interface LootOutcomeResult {
  /** Harness-style signature, e.g. "minecraft:diamond:2" or "nothing". */
  key: string;
  items: Record<string, number>;
  p: number;
}

export interface LootCalcResult {
  version: string;
  table: string;
  tableName: string;
  category: string;
  items: LootItemResult[];
  /** Exact full-outcome distribution, or null when beyond the joint cap. */
  outcomes: LootOutcomeResult[] | null;
  notes: string[];
}

/** Whether a table branches on a crop-style "age" block state (drives the UI toggle). */
export function tableHasCropAge(version: string, table: string): boolean {
  const doc = getTableDoc(version, table);
  if (!doc) return false;
  let found = false;
  const scan = (v: unknown): void => {
    if (found) return;
    if (Array.isArray(v)) return v.forEach(scan);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.condition === "minecraft:block_state_property" && o.properties) {
        if ((o.properties as Record<string, unknown>).age !== undefined) found = true;
      }
      Object.values(o).forEach(scan);
    }
  };
  scan(doc);
  return found;
}

export function itemDisplayName(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function checkLevel(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ToolError(
      "bad-level",
      `${label} must be a whole number between 0 and ${max}.`,
      `Set ${label.toLowerCase()} to a value from 0 to ${max}.`,
    );
  }
  return value;
}

/**
 * Derive the block state the context assumes. Only crop-style "age"
 * properties are modeled: fully grown uses the highest age the table
 * references, otherwise age 0. Other properties stay unset (conditions on
 * them fail with a note), matching a freshly placed default-state block.
 */
function deriveBlockStates(doc: RawLootTable, mature: boolean): Record<string, string> {
  if (!mature) return { age: "0" };
  let maxAge = -1;
  const scan = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(scan);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.condition === "minecraft:block_state_property" && o.properties) {
        const age = (o.properties as Record<string, unknown>).age;
        if (age !== undefined) {
          const n = typeof age === "object" ? Number((age as { max?: number }).max) : Number(age);
          if (Number.isFinite(n)) maxAge = Math.max(maxAge, n);
        }
      }
      Object.values(o).forEach(scan);
    }
  };
  scan(doc);
  return { age: String(maxAge >= 0 ? maxAge : 0) };
}

export function calculate(opts: CalcOptions): LootCalcResult {
  const version = opts.version;
  if (!LOOT_VERSIONS.includes(version)) {
    throw new ToolError(
      "unknown-version",
      `Unknown Minecraft version "${version}".`,
      `Pick one of: ${LOOT_VERSIONS.join(", ")}.`,
    );
  }
  const info = LOOT_TABLES.find((t) => t.id === opts.table);
  if (!info) {
    throw new ToolError(
      "unknown-table",
      `Unknown loot table "${opts.table}".`,
      'Use a table id like "blocks/diamond_ore" or pick one from the list.',
    );
  }
  const doc = getTableDoc(version, opts.table);
  if (!doc) {
    throw new ToolError(
      "table-not-in-version",
      `"${info.name}" does not exist in Minecraft ${version}.`,
      `This table is available in: ${info.versions.join(", ")}.`,
    );
  }

  const toolKey = opts.tool ?? "pickaxe";
  if (!(toolKey in TOOL_ITEMS)) {
    throw new ToolError(
      "unknown-tool",
      `Unknown tool "${toolKey}".`,
      `Pick one of: ${Object.keys(TOOL_ITEMS).join(", ")}.`,
    );
  }

  const ctx: Ctx = {
    toolItem: TOOL_ITEMS[toolKey],
    fortune: checkLevel(opts.fortune ?? 0, "Fortune", 3),
    silkTouch: opts.silkTouch ?? false,
    looting: checkLevel(opts.looting ?? 0, "Looting", 3),
    killedByPlayer: opts.killedByPlayer ?? true,
    onFire: opts.onFire ?? false,
    openWater: opts.openWater ?? true,
    luck: checkLevel(opts.luckOfTheSea ?? 0, "Luck of the Sea", 3),
    blockStates: deriveBlockStates(doc, opts.cropMature ?? true),
    notes: new Set(),
  };

  const { joint, marginals } = computeTable(ctx, version, opts.table, 0);

  const items: LootItemResult[] = [...marginals]
    .map(([item, dist]) => {
      const counts = [...dist.keys()].filter((k) => k > 0 && (dist.get(k) ?? 0) > EPS);
      const chance = counts.reduce((s, k) => s + (dist.get(k) ?? 0), 0);
      return {
        item,
        name: itemDisplayName(item),
        chance,
        expected: ev(dist),
        variance: variance(dist),
        min: counts.length ? Math.min(...counts) : 0,
        max: counts.length ? Math.max(...counts) : 0,
        dist: [...dist].sort((a, b) => a[0] - b[0]),
      };
    })
    .filter((r) => r.chance > EPS)
    .sort((a, b) => b.expected - a.expected || a.item.localeCompare(b.item));

  const outcomes = joint
    ? [...joint.values()]
        .map((o) => ({ key: outcomeKey(o.items), items: o.items, p: o.p }))
        .sort((a, b) => b.p - a.p)
    : null;

  return {
    version,
    table: opts.table,
    tableName: info.name,
    category: info.cat,
    items,
    outcomes,
    notes: [...ctx.notes].sort(),
  };
}

// ------------------------------------------------------------- run() API --

export interface LootRunOpts {
  version?: string;
  table?: string;
  tool?: string;
  fortune?: number;
  silkTouch?: boolean;
  looting?: number;
  killedByPlayer?: boolean;
  onFire?: boolean;
  luckOfTheSea?: number;
  openWater?: boolean;
  cropMature?: boolean;
  [key: string]: unknown;
}

function pct(p: number): string {
  if (p >= 0.9995) return "100%";
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(2)}%`;
  return `${(p * 100).toPrecision(2)}%`;
}

export function run(input: string, opts: LootRunOpts): Record<string, string> {
  const table = (input || "").trim() || opts.table || "blocks/diamond_ore";
  const result = calculate({
    version: opts.version ?? LOOT_VERSIONS[LOOT_VERSIONS.length - 1],
    table,
    tool: opts.tool,
    fortune: Number(opts.fortune ?? 0),
    silkTouch: Boolean(opts.silkTouch),
    looting: Number(opts.looting ?? 0),
    killedByPlayer: opts.killedByPlayer === undefined ? true : Boolean(opts.killedByPlayer),
    onFire: Boolean(opts.onFire),
    luckOfTheSea: Number(opts.luckOfTheSea ?? 0),
    openWater: opts.openWater === undefined ? true : Boolean(opts.openWater),
    cropMature: opts.cropMature === undefined ? true : Boolean(opts.cropMature),
  });

  const out: Record<string, string> = {};
  if (!result.items.length) {
    out["Result"] = "Nothing drops with this context.";
  }
  for (const item of result.items) {
    const range = item.min === item.max ? `${item.min}` : `${item.min} to ${item.max}`;
    out[item.name] =
      `${pct(item.chance)} chance, avg ${item.expected.toFixed(3).replace(/\.?0+$/, "")} (drops ${range})`;
  }
  if (result.notes.length) out["Notes"] = result.notes.join(" ");
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, LootRunOpts>;
