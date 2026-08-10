import { ToolError, type ToolLogic } from "../types";
import {
  attackDamage,
  MATERIAL_BY_ID,
  MAX_BANE,
  MAX_FIRE_ASPECT,
  MAX_SHARPNESS,
  MAX_SMITE,
  MAX_UNBREAKING,
  MENDING_DURABILITY_PER_XP,
  sharpnessBonus,
  smiteBaneBonus,
  TOOL_FAMILY_BY_ID,
  XP_SOURCE_BY_ID,
  type McMaterial,
  type McToolFamily,
  type XpSource,
} from "./data";

/**
 * Minecraft XP economy math, reimplemented from decompiled server source
 * (see ./data.ts for the per-constant citations). The level curve below is
 * Player#getXpNeededForNextLevel, byte-identical across 1.16.5, 1.18.2,
 * 1.20.6, 1.21.1, 1.21.11 and 26.2.
 */

export interface McXpOpts {
  mode: string; // 'levels' | 'xp' | 'mending'
  fromLevel: number;
  toLevel: number;
  totalXp: number;
  durability: number;
  source: string;
  [key: string]: unknown;
}

export type McXpResult = Record<string, string>;

/** Highest level the calculator accepts. Keeps closed forms well inside double precision. */
export const MAX_LEVEL = 100000;
/** Highest raw XP input: the game stores total XP in a Java int. */
export const MAX_TOTAL_XP = 2147483647;
export const MAX_DURABILITY = 1000000;

/**
 * XP points required to go from `level` to `level + 1`.
 * Source: net.minecraft.world.entity.player.Player#getXpNeededForNextLevel.
 */
export function xpToNextLevel(level: number): number {
  if (level >= 30) return 112 + (level - 30) * 9;
  if (level >= 15) return 37 + (level - 15) * 5;
  return 7 + level * 2;
}

/**
 * Total XP points from level 0 to `level`. Closed forms of the summed
 * per-level curve; the test suite proves them equal to direct summation.
 */
export function totalXpAtLevel(level: number): number {
  if (level <= 16) return level * level + 6 * level;
  if (level <= 31) return Math.round(2.5 * level * level - 40.5 * level + 360);
  return Math.round(4.5 * level * level - 162.5 * level + 2220);
}

/** The level a player with `totalXp` points has (the floor level). */
export function levelFromTotalXp(totalXp: number): number {
  let lo = 0;
  let hi = MAX_LEVEL;
  // totalXpAtLevel is strictly increasing; binary-search the floor level.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (totalXpAtLevel(mid) <= totalXp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Orb XP that must be collected to Mending-repair `durability` points.
 * Each XP point restores 2 durability (ExperienceOrb#xpToDurability in
 * 1.16.5-1.20.6; repair_with_xp factor 2.0 in 1.21.1+). Single-orb
 * consumption floors the odd remainder, so ceil is the planning-safe
 * amount of orb XP to collect.
 */
export function mendingXpForDurability(durability: number): number {
  return Math.ceil(durability / MENDING_DURABILITY_PER_XP);
}

function intOpt(opts: McXpOpts, id: string, label: string, min: number, max: number): number {
  const raw = opts[id];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ToolError(
      "not-an-integer",
      `${label} must be a whole number, got "${String(raw)}".`,
      "Enter a plain integer, no decimals or units.",
    );
  }
  if (n < min || n > max) {
    throw new ToolError(
      "out-of-range",
      `${label} must be between ${min} and ${max}, got ${n}.`,
      `Pick a value from ${min} to ${max}.`,
    );
  }
  return n;
}

function getSource(opts: McXpOpts): XpSource {
  const src = XP_SOURCE_BY_ID.get(String(opts.source));
  if (!src) {
    throw new ToolError(
      "unknown-source",
      `Unknown XP source "${String(opts.source)}".`,
      "Pick an XP source from the dropdown, for example Zombie or Bottle o' Enchanting.",
    );
  }
  return src;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function perUnit(src: XpSource): string {
  const range = src.min === src.max ? `${fmt(src.mean)} XP` : `${src.min} to ${src.max} XP, ${fmt(src.mean)} on average`;
  return `${range} per ${src.unit}`;
}

/** Rows planning how many of `src` cover `xp` points. */
function planRows(xp: number, src: XpSource): McXpResult {
  const rows: McXpResult = {};
  rows[`XP per ${src.unit} (${src.label})`] = perUnit(src);
  const avg = xp === 0 ? 0 : Math.ceil(xp / src.mean);
  const avgUnit = avg === 1 ? src.unit : src.unitPlural;
  rows["Needed on average"] = `${fmt(avg)} ${avgUnit}`;
  if (src.min === src.max) {
    rows["Guaranteed"] = `${fmt(avg)} ${avgUnit} (drop amount is fixed)`;
  } else if (src.min > 0) {
    const worst = xp === 0 ? 0 : Math.ceil(xp / src.min);
    rows["Guaranteed (worst case)"] = `${fmt(worst)} ${worst === 1 ? src.unit : src.unitPlural}`;
  } else {
    rows["Guaranteed (worst case)"] = `No guarantee: the minimum drop is 0 XP`;
  }
  return rows;
}

function runLevels(opts: McXpOpts): McXpResult {
  const from = intOpt(opts, "fromLevel", "Current level", 0, MAX_LEVEL);
  const to = intOpt(opts, "toLevel", "Target level", 0, MAX_LEVEL);
  if (from > to) {
    throw new ToolError(
      "levels-reversed",
      `Current level ${from} is above target level ${to}.`,
      "Swap the two levels: the calculator plans an upward climb.",
    );
  }
  const fromXp = totalXpAtLevel(from);
  const toXp = totalXpAtLevel(to);
  const delta = toXp - fromXp;
  const src = getSource(opts);
  return {
    [`Total XP at level ${fmt(from)}`]: `${fmt(fromXp)} points`,
    [`Total XP at level ${fmt(to)}`]: `${fmt(toXp)} points`,
    [`XP needed (${fmt(from)} to ${fmt(to)})`]: `${fmt(delta)} points`,
    [`Next level up from ${fmt(from)}`]: `${fmt(xpToNextLevel(from))} points`,
    ...planRows(delta, src),
  };
}

function runXp(opts: McXpOpts): McXpResult {
  const xp = intOpt(opts, "totalXp", "Total XP", 0, MAX_TOTAL_XP);
  const level = levelFromTotalXp(xp);
  const into = xp - totalXpAtLevel(level);
  const need = xpToNextLevel(level);
  const pct = Math.floor((into / need) * 100);
  return {
    "Total XP": `${fmt(xp)} points`,
    Level: fmt(level),
    "Progress into level": `${fmt(into)} of ${fmt(need)} points (${pct}%)`,
    [`XP to reach level ${fmt(level + 1)}`]: `${fmt(need - into)} points`,
  };
}

function runMending(opts: McXpOpts): McXpResult {
  const durability = intOpt(opts, "durability", "Durability to repair", 0, MAX_DURABILITY);
  const xp = mendingXpForDurability(durability);
  const level = levelFromTotalXp(xp);
  const rem = xp - totalXpAtLevel(level);
  const climb = rem === 0 ? `level 0 to ${fmt(level)}` : `level 0 to ${fmt(level)}, plus ${fmt(rem)} points`;
  const src = getSource(opts);
  return {
    "Durability to repair": fmt(durability),
    "Orb XP needed": `${fmt(xp)} points (each point repairs ${MENDING_DURABILITY_PER_XP} durability)`,
    "Same XP as climbing": climb,
    ...planRows(xp, src),
  };
}

export function run(_input: undefined, opts: McXpOpts): McXpResult {
  switch (opts.mode) {
    case "levels":
      return runLevels(opts);
    case "xp":
      return runXp(opts);
    case "mending":
      return runMending(opts);
    default:
      throw new ToolError(
        "unknown-mode",
        `Unknown mode "${String(opts.mode)}".`,
        "Pick a mode: Levels to XP, XP to level, or Mending repair.",
      );
  }
}

export default { run } satisfies ToolLogic<undefined, McXpResult, McXpOpts>;

// ---------------------------------------------------------------------------
// Weighted source mixtures and the Mending sustainability model. Pure
// functions used by the bespoke panel and the vector test suite; the generic
// run() surface above stays single-source.
// ---------------------------------------------------------------------------

export interface MixtureEntry {
  sourceId: string;
  /** Relative weight; normalized internally. */
  weight: number;
}

export interface MixtureShare {
  source: XpSource;
  /** Normalized share in 0..1. */
  share: number;
}

/**
 * Validate and normalize a weighted mixture. All entries must resolve to
 * known sources of one kind (mob or block are never mixed).
 */
export function normalizeMixture(mixture: readonly MixtureEntry[]): MixtureShare[] {
  if (!mixture.length) {
    throw new ToolError(
      "empty-mixture",
      "No XP sources are selected.",
      "Select at least one XP source, or apply a preset.",
    );
  }
  const shares: { source: XpSource; weight: number }[] = [];
  let total = 0;
  for (const entry of mixture) {
    const source = XP_SOURCE_BY_ID.get(String(entry.sourceId));
    if (!source) {
      throw new ToolError(
        "unknown-source",
        `Unknown XP source "${String(entry.sourceId)}".`,
        "Pick XP sources from the list, for example Zombie or Diamond ore.",
      );
    }
    const w = typeof entry.weight === "number" ? entry.weight : Number(entry.weight);
    if (!Number.isFinite(w) || w < 0) {
      throw new ToolError(
        "bad-weight",
        `Weight for ${source.label} must be a non-negative number, got "${String(entry.weight)}".`,
        "Use plain numbers like 1, 2.5, or 100 for the relative weights.",
      );
    }
    shares.push({ source, weight: w });
    total += w;
  }
  const kinds = new Set(shares.map((s) => s.source.kind));
  if (kinds.size > 1) {
    throw new ToolError(
      "mixed-kinds",
      "A mixture cannot combine mob and block XP sources.",
      "Select only mobs (for weapons) or only mined blocks (for mining tools).",
    );
  }
  if (total <= 0) {
    throw new ToolError(
      "zero-weights",
      "All mixture weights are zero.",
      "Give at least one selected source a weight above zero.",
    );
  }
  return shares.map(({ source, weight }) => ({ source, share: weight / total }));
}

/** Weighted mean XP per action across a normalized mixture. */
export function mixtureMeanXp(shares: readonly MixtureShare[]): number {
  return shares.reduce((acc, s) => acc + s.share * s.source.mean, 0);
}

export interface MixturePlan {
  meanXpPerAction: number;
  /** ceil(xp / weighted mean). */
  avgActions: number;
  /** The single worst selected source (lowest minimum drop) at 100 percent. */
  worstSource: XpSource;
  /** ceil(xp / worst source minimum), or null when that minimum is 0. */
  guaranteedActions: number | null;
}

/**
 * Plan how many actions cover `xpNeeded` for a weighted mixture. The
 * average case uses the weighted mean XP per action; the worst case is
 * the single worst selected source at 100 percent of the actions.
 */
export function planMixture(xpNeeded: number, mixture: readonly MixtureEntry[]): MixturePlan {
  const shares = normalizeMixture(mixture);
  const mean = mixtureMeanXp(shares);
  let worst = shares[0]!.source;
  for (const { source } of shares) if (source.min < worst.min) worst = source;
  return {
    meanXpPerAction: mean,
    avgActions: xpNeeded <= 0 ? 0 : Math.ceil(xpNeeded / mean),
    worstSource: worst,
    guaranteedActions:
      worst.min > 0 ? (xpNeeded <= 0 ? 0 : Math.ceil(xpNeeded / worst.min)) : null,
  };
}

export interface SustainInput {
  family: string; // 'sword' | 'axe' | 'pickaxe'
  material: string;
  /** Current durability of the tool (1..material max). */
  durability: number;
  mending: boolean;
  unbreaking: number;
  sharpness: number;
  smite: number;
  bane: number;
  fireAspect: number;
  /** Free damage per kill attributed to Fire Aspect burn (flat HP model). */
  fireAspectFreeHp: number;
  mixture: readonly MixtureEntry[];
}

export interface SustainPerSource {
  source: XpSource;
  share: number;
  /** Hits to kill (weapons); null for mining. */
  hits: number | null;
  /** Damage per hit against this source (weapons); null for mining. */
  damagePerHit: number | null;
  /** Durability lost per action before Unbreaking. */
  rawLossPerAction: number;
}

export interface SustainResult {
  family: McToolFamily;
  material: McMaterial;
  perSource: SustainPerSource[];
  /** Expected durability lost per action after Unbreaking, weighted. */
  avgLossPerAction: number;
  /** Expected durability restored per action by Mending, weighted. */
  avgRepairPerAction: number;
  avgNetPerAction: number;
  avgSelfSustaining: boolean;
  /** Expected actions until the tool breaks; null when self-sustaining. */
  avgActions: number | null;
  /** The single worst selected source at 100 percent. */
  worstSource: XpSource;
  worstNetPerAction: number;
  worstSelfSustaining: boolean;
  worstActions: number | null;
}

function intLevel(value: number, label: string, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new ToolError(
      "bad-enchant-level",
      `${label} level must be a whole number from 0 to ${max}, got "${String(value)}".`,
      `Use 0 to disable ${label}, or a level from 1 to ${max}.`,
    );
  }
  return n;
}

/** Damage per hit of a weapon against one mob, including damage enchants. */
export function damagePerHit(
  family: McToolFamily,
  material: McMaterial,
  source: XpSource,
  sharpness: number,
  smite: number,
  bane: number,
): number {
  const base = attackDamage(family, material);
  if (sharpness > 0) return base + sharpnessBonus(sharpness);
  if (smite > 0 && source.taxonomy === "undead") return base + smiteBaneBonus(smite);
  if (bane > 0 && source.taxonomy === "arthropod") return base + smiteBaneBonus(bane);
  return base;
}

/** Hits to kill a mob, with Fire Aspect modeled as flat free HP per kill. */
export function hitsToKill(hp: number, damage: number, freeHp: number): number {
  const effective = Math.max(0, hp - Math.max(0, freeHp));
  return Math.max(1, Math.ceil(effective / damage));
}

/**
 * The Mending sustainability model. Per action (one block mined or one mob
 * killed):
 *
 *   raw loss   = durabilityPerAction (x hits per kill for weapons)
 *   avg loss   = raw loss x 1 / (unbreaking + 1)
 *   avg repair = mending ? 2 x mean XP per action : 0
 *   avg net    = weighted avg loss - weighted avg repair
 *
 * If avg net <= 0 the tool is self-sustaining on average. Otherwise the
 * expected actions until it breaks is floor(durability / avg net). The
 * worst case is the single worst selected source at 100 percent, with
 * Unbreaking never proccing and minimum XP rolls:
 *
 *   worst net = max over sources of (raw loss - 2 x min XP)
 */
export function sustainability(input: SustainInput): SustainResult {
  const family = TOOL_FAMILY_BY_ID.get(String(input.family));
  if (!family) {
    throw new ToolError(
      "unknown-family",
      `Unknown tool family "${String(input.family)}".`,
      "Pick sword, axe, or pickaxe.",
    );
  }
  const material = MATERIAL_BY_ID.get(String(input.material));
  if (!material) {
    throw new ToolError(
      "unknown-material",
      `Unknown tool material "${String(input.material)}".`,
      "Pick a material such as iron, diamond, or netherite.",
    );
  }
  const durability =
    typeof input.durability === "number" ? input.durability : Number(input.durability);
  if (!Number.isInteger(durability) || durability < 1 || durability > material.durability) {
    throw new ToolError(
      "bad-durability",
      `Durability must be a whole number from 1 to ${material.durability} for a ${material.label.toLowerCase()} ${family.label.toLowerCase()}, got "${String(input.durability)}".`,
      `Enter the tool's remaining durability, at most ${material.durability}.`,
    );
  }
  const unbreaking = intLevel(input.unbreaking, "Unbreaking", MAX_UNBREAKING);
  const sharpness = intLevel(input.sharpness, "Sharpness", MAX_SHARPNESS);
  const smite = intLevel(input.smite, "Smite", MAX_SMITE);
  const bane = intLevel(input.bane, "Bane of Arthropods", MAX_BANE);
  const fireAspect = intLevel(input.fireAspect, "Fire Aspect", MAX_FIRE_ASPECT);
  if ([sharpness, smite, bane].filter((l) => l > 0).length > 1) {
    throw new ToolError(
      "exclusive-damage-enchants",
      "Sharpness, Smite, and Bane of Arthropods are mutually exclusive.",
      "Keep at most one of the three damage enchantments above level 0.",
    );
  }
  if (family.id === "pickaxe" && (sharpness || smite || bane || fireAspect)) {
    throw new ToolError(
      "enchant-not-applicable",
      "A pickaxe cannot hold damage enchantments or Fire Aspect.",
      "Clear the combat enchantments, or switch to a sword or axe.",
    );
  }
  if (fireAspect > 0 && family.id !== "sword") {
    throw new ToolError(
      "enchant-not-applicable",
      "Fire Aspect only applies to swords.",
      "Set Fire Aspect to 0, or switch the tool family to sword.",
    );
  }
  const freeHp = fireAspect > 0 ? Math.max(0, Number(input.fireAspectFreeHp) || 0) : 0;

  const shares = normalizeMixture(input.mixture);
  if (shares[0]!.source.kind !== family.acts) {
    const want = family.acts === "mob" ? "mobs" : "mined blocks";
    throw new ToolError(
      "kind-mismatch",
      `A ${family.label.toLowerCase()} works on ${want}, not ${shares[0]!.source.kind === "mob" ? "mobs" : "blocks"} like ${shares[0]!.source.label}.`,
      `Select ${want} as the XP sources for this tool family.`,
    );
  }

  const perSource: SustainPerSource[] = shares.map(({ source, share }) => {
    if (family.acts === "mob") {
      const dmg = damagePerHit(family, material, source, sharpness, smite, bane);
      const hits = hitsToKill(source.hp ?? 0, dmg, freeHp);
      return {
        source,
        share,
        hits,
        damagePerHit: dmg,
        rawLossPerAction: hits * family.durabilityPerAction,
      };
    }
    return {
      source,
      share,
      hits: null,
      damagePerHit: null,
      rawLossPerAction: family.durabilityPerAction,
    };
  });

  const unbreakingFactor = 1 / (unbreaking + 1);
  const avgLoss = perSource.reduce((a, p) => a + p.share * p.rawLossPerAction * unbreakingFactor, 0);
  const avgRepair = input.mending
    ? MENDING_DURABILITY_PER_XP * perSource.reduce((a, p) => a + p.share * p.source.mean, 0)
    : 0;
  const avgNet = avgLoss - avgRepair;

  let worst = perSource[0]!;
  let worstNet = -Infinity;
  for (const p of perSource) {
    const net = p.rawLossPerAction - (input.mending ? MENDING_DURABILITY_PER_XP * p.source.min : 0);
    if (net > worstNet) {
      worstNet = net;
      worst = p;
    }
  }

  const EPS = 1e-9;
  return {
    family,
    material,
    perSource,
    avgLossPerAction: avgLoss,
    avgRepairPerAction: avgRepair,
    avgNetPerAction: avgNet,
    avgSelfSustaining: avgNet <= EPS,
    avgActions: avgNet <= EPS ? null : Math.floor(durability / avgNet + EPS),
    worstSource: worst.source,
    worstNetPerAction: worstNet,
    worstSelfSustaining: worstNet <= EPS,
    worstActions: worstNet <= EPS ? null : Math.floor(durability / worstNet + EPS),
  };
}
