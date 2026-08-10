import { ToolError, type ToolLogic } from "../types";
import { MENDING_DURABILITY_PER_XP, XP_SOURCE_BY_ID, type XpSource } from "./data";

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
