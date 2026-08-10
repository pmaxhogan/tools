import { ToolError, type ToolLogic } from "../types";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  EPF,
  HP_POOLS,
  MACE,
  VERSIONS,
  VERSION_INFO,
  type ArmorSlot,
  type VersionId,
} from "./data";

/**
 * Unified Minecraft damage calculator: melee vs armor, fall damage, and mace
 * smash damage, reimplemented from decompiled server source and verified
 * against golden vectors measured on real dedicated servers per version
 * (mc-pipeline/vectors/damage, mc-pipeline/vectors/fall).
 *
 * All armor and effect math mirrors the game's float32 arithmetic via
 * Math.fround so results match the server bit for bit.
 */

const f32 = Math.fround;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Round to the 0.01 the vectors were captured at; also the display precision. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function requireNumber(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new ToolError(
      "invalid-number",
      `${name} is not a number.`,
      `Enter a number between ${min} and ${max} for ${name.toLowerCase()}.`,
    );
  }
  if (n < min || n > max) {
    throw new ToolError(
      "out-of-range",
      `${name} must be between ${min} and ${max} (got ${n}).`,
      `Use a value between ${min} and ${max}.`,
    );
  }
  return n;
}

export function requireVersion(value: unknown): VersionId {
  const v = String(value ?? "");
  if ((VERSIONS as readonly string[]).includes(v)) return v as VersionId;
  throw new ToolError(
    "unknown-version",
    `"${v}" is not a supported Minecraft version.`,
    `Pick one of: ${VERSIONS.join(", ")}.`,
  );
}

/* ------------------------------------------------------------------ */
/* Armor formula (CombatRules#getDamageAfterAbsorb, float32)          */
/* ------------------------------------------------------------------ */

/**
 * Damage left after the armor attribute reduction, in the game's own float32:
 * reduced = amount * (1 - clamp(armor - amount / (2 + toughness / 4),
 * armor * 0.2, 20) / 25). Breach (1.21+) subtracts 0.15 per level from the
 * armor fraction before it is applied (EnchantmentHelper
 * #modifyArmorEffectiveness), clamped to 0..1.
 */
export function damageAfterArmor(
  amount: number,
  armor: number,
  toughness: number,
  breachLevel = 0,
): number {
  const a = f32(amount);
  const den = f32(2 + f32(toughness / 4));
  const points = f32(clamp(f32(armor - f32(a / den)), f32(armor * 0.2), 20));
  let fraction = f32(points / 25);
  if (breachLevel > 0) {
    fraction = clamp(f32(fraction + f32(-MACE.breachPerLevel * breachLevel)), 0, 1);
  }
  return f32(a * f32(1 - fraction));
}

/**
 * Resistance then enchantment EPF, in order, mirroring LivingEntity
 * #getDamageAfterMagicAbsorb: Resistance removes 20% per level (level 5 is
 * full immunity); the EPF sum clamps to 20 and removes 4% per point.
 */
export function damageAfterEffects(amount: number, resistanceLevel: number, epf: number): number {
  let a = f32(amount);
  if (resistanceLevel > 0) {
    a = Math.max(f32(f32(a * (25 - resistanceLevel * 5)) / 25), 0);
  }
  if (a <= 0) return 0;
  if (epf > 0) {
    const d = clamp(epf, 0, EPF.cap);
    a = f32(a * f32(1 - f32(d / 25)));
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Armor builds from real pieces                                      */
/* ------------------------------------------------------------------ */

export interface PieceChoice {
  /** Material id from ARMOR_MATERIALS, or "none". */
  material: string;
  /** Protection level 0..4 on this piece (Feather Falling in fall mode). */
  protection: number;
}

export type ArmorBuild = Partial<Record<ArmorSlot, PieceChoice>>;

export interface BuiltArmor {
  armor: number;
  toughness: number;
  /** Sum of Protection levels across pieces (EPF x1 vs melee). */
  protectionLevels: number;
}

/** Total armor attribute, toughness and Protection levels for a piece build. */
export function buildArmor(version: VersionId, build: ArmorBuild): BuiltArmor {
  const info = VERSION_INFO[version];
  let armor = 0;
  let toughness = 0;
  let protectionLevels = 0;
  for (const slot of ARMOR_SLOTS) {
    const piece = build[slot];
    if (!piece || piece.material === "none") continue;
    const mat = ARMOR_MATERIALS.find((m) => m.id === piece.material);
    if (!mat) {
      throw new ToolError(
        "unknown-material",
        `"${piece.material}" is not an armor material.`,
        `Use one of: ${ARMOR_MATERIALS.map((m) => m.id).join(", ")}, or "none".`,
      );
    }
    if (mat.since === "copper" && !info.copper) {
      throw new ToolError(
        "material-not-in-version",
        `Copper armor does not exist in ${version}.`,
        "Pick 1.21.11 or later, or choose another material.",
      );
    }
    const points = mat.points[slot];
    if (points === null) {
      throw new ToolError(
        "material-slot-mismatch",
        `${mat.label} has no ${slot} item.`,
        "Turtle shell is a helmet only; pick another material for this slot.",
      );
    }
    armor += points;
    toughness += mat.toughness;
    protectionLevels += clamp(Math.floor(piece.protection || 0), 0, 4);
  }
  return { armor, toughness, protectionLevels };
}

/* ------------------------------------------------------------------ */
/* Melee                                                              */
/* ------------------------------------------------------------------ */

export interface MeleeOptions {
  version: VersionId;
  /** Damage dealt by the attack, before the target's reductions. */
  amount: number;
  /** Target's armor attribute total (0..30). */
  armor: number;
  /** Target's armor toughness total (0..20). */
  toughness: number;
  /** Sum of Protection levels across the target's pieces (EPF x1 each). */
  protectionLevels?: number;
  /** Resistance effect level on the target, 0..5. */
  resistance?: number;
  /** Breach level on the attacker's mace, 0..4 (1.21+). */
  breach?: number;
}

export interface MeleeResult {
  dealt: number;
  afterArmor: number;
  afterEffects: number;
  taken: number;
  reducedPercent: number;
}

export function meleeDamage(opts: MeleeOptions): MeleeResult {
  const version = requireVersion(opts.version);
  const amount = requireNumber(opts.amount, "Attack damage", 0, 10000);
  const armor = requireNumber(opts.armor, "Armor", 0, 100);
  const toughness = requireNumber(opts.toughness, "Toughness", 0, 100);
  const protection = requireNumber(opts.protectionLevels ?? 0, "Protection levels", 0, 16);
  const resistance = requireNumber(opts.resistance ?? 0, "Resistance", 0, 5);
  const breach = requireNumber(opts.breach ?? 0, "Breach", 0, 4);
  if (breach > 0 && !VERSION_INFO[version].mace) {
    throw new ToolError(
      "breach-not-in-version",
      `Breach does not exist in ${version} (the mace and its enchantments arrived in 1.21).`,
      "Pick 1.21.1 or later, or set Breach to 0.",
    );
  }
  const afterArmor = damageAfterArmor(amount, armor, toughness, breach);
  const afterEffects = damageAfterEffects(afterArmor, resistance, protection * EPF.protection);
  return {
    dealt: amount,
    afterArmor,
    afterEffects,
    taken: afterEffects,
    reducedPercent: amount > 0 ? (1 - afterEffects / amount) * 100 : 0,
  };
}

/** Hits to kill a health pool; Infinity when the hit deals 0. */
export function hitsToKill(damagePerHit: number, hp: number): number {
  if (damagePerHit <= 0) return Infinity;
  return Math.ceil(hp / damagePerHit);
}

/* ------------------------------------------------------------------ */
/* Fall damage                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fall distance the game sees for a geometric drop, per era.
 *
 * Legacy (through 1.21.1): fallDistance accumulates the entity's actual
 * per-tick movement while airborne (Entity#checkFallDamage), and the landing
 * tick's movement never accumulates because the on-ground branch runs
 * instead. Velocity integrates as move-then-update: the entity moves by v,
 * then v = (v - 0.08) * 0.98 (LivingEntity#travel). fallDistance is a
 * float32 field.
 *
 * Modern (1.21.2+): fall distance derives from actual position change, so it
 * equals the geometric height.
 *
 * Verified against mc-pipeline/vectors/fall/<v>.json for all six versions
 * (e.g. a 100 block drop reads 97.52 blocks of fall distance on 1.16.5 but
 * a full 100 on 1.21.11).
 */
export function fallDistanceForDrop(version: VersionId, height: number): number {
  if (VERSION_INFO[version].fallModel === "modern") return height;
  let v = 0;
  let fallen = 0;
  let fd = 0;
  for (let tick = 0; tick < 1_000_000; tick++) {
    const d = -v;
    if (fallen + d >= height) return fd;
    fallen += d;
    if (d > 0) fd = f32(fd + d);
    v = (v - 0.08) * 0.98;
  }
  return fd;
}

export interface FallOptions {
  version: VersionId;
  /** Geometric drop height in blocks. */
  height: number;
  /** Feather Falling level on boots, 0..4 (EPF x3 per level). */
  featherFalling?: number;
  /** Slow Falling effect active (no fall damage in every covered version). */
  slowFalling?: boolean;
  /** Jump Boost level, subtracts its amplifier + 1 from the fall distance. */
  jumpBoost?: number;
}

export interface FallResult {
  fallDistance: number;
  baseDamage: number;
  taken: number;
}

export function fallDamage(opts: FallOptions): FallResult {
  const version = requireVersion(opts.version);
  const height = requireNumber(opts.height, "Fall height", 0, 10000);
  const ff = requireNumber(opts.featherFalling ?? 0, "Feather Falling", 0, 4);
  const jump = requireNumber(opts.jumpBoost ?? 0, "Jump Boost", 0, 255);
  if (opts.slowFalling) {
    return { fallDistance: 0, baseDamage: 0, taken: 0 };
  }
  const fd = fallDistanceForDrop(version, height);
  let base: number;
  if (VERSION_INFO[version].fallModel === "modern") {
    // floor((fd + 1e-6 - SAFE_FALL_DISTANCE(3 + jump)) * FALL_DAMAGE_MULTIPLIER(1))
    base = Math.max(0, Math.floor(fd + 1e-6 - (3 + jump)));
  } else {
    // ceil(fd - 3 - jumpBoost)
    base = Math.max(0, Math.ceil(fd - 3 - jump));
  }
  if (base <= 0) return { fallDistance: fd, baseDamage: 0, taken: 0 };
  // Fall damage bypasses armor (damage_type_tags/bypasses_armor.json);
  // Feather Falling EPF applies through getDamageAfterMagicAbsorb.
  const taken = damageAfterEffects(base, 0, ff * EPF.featherFalling);
  return { fallDistance: fd, baseDamage: base, taken };
}

/** Tallest drop that deals no damage (both eras: fall distance up to 3 blocks). */
export function safeFallHeight(version: VersionId, featherFalling = 0): number {
  let lo = 0;
  for (let h = 0; h <= 300; h += 0.5) {
    const r = fallDamage({ version, height: h, featherFalling });
    if (r.taken > 0) return lo;
    lo = h;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* Mace smash                                                         */
/* ------------------------------------------------------------------ */

export interface MaceOptions {
  version: VersionId;
  /** The attacker's fall distance when the hit lands, in blocks. */
  fallDistance: number;
  /** Density level on the mace, 0..5. */
  density?: number;
  /** Breach level on the mace, 0..4. */
  breach?: number;
  /** Target's armor attribute total. */
  armor?: number;
  /** Target's armor toughness total. */
  toughness?: number;
  /** Sum of Protection levels across the target's pieces. */
  protectionLevels?: number;
  /** Resistance effect level on the target, 0..5. */
  resistance?: number;
}

export interface MaceResult {
  isSmash: boolean;
  baseDamage: number;
  smashBonus: number;
  densityBonus: number;
  dealt: number;
  taken: number;
}

/** MaceItem#getAttackDamageBonus smash curve (before Density). */
export function smashBonus(fallDistance: number): number {
  if (fallDistance <= MACE.smashThreshold) return 0;
  if (fallDistance <= 3) return 4 * fallDistance;
  if (fallDistance <= 8) return 12 + 2 * (fallDistance - 3);
  return 22 + fallDistance - 8;
}

export function maceDamage(opts: MaceOptions): MaceResult {
  const version = requireVersion(opts.version);
  if (!VERSION_INFO[version].mace) {
    throw new ToolError(
      "mace-not-in-version",
      `The mace does not exist in ${version}; it arrived in 1.21.`,
      "Pick 1.21.1 or later for mace math.",
    );
  }
  const fd = requireNumber(opts.fallDistance, "Fall distance", 0, 10000);
  const density = requireNumber(opts.density ?? 0, "Density", 0, 5);
  const breach = requireNumber(opts.breach ?? 0, "Breach", 0, 4);
  const armor = requireNumber(opts.armor ?? 0, "Armor", 0, 100);
  const toughness = requireNumber(opts.toughness ?? 0, "Toughness", 0, 100);
  const protection = requireNumber(opts.protectionLevels ?? 0, "Protection levels", 0, 16);
  const resistance = requireNumber(opts.resistance ?? 0, "Resistance", 0, 5);

  const isSmash = fd > MACE.smashThreshold;
  const bonus = smashBonus(fd);
  const densityBonus = isSmash ? MACE.densityPerLevel * density * fd : 0;
  const dealt = MACE.attackDamage + bonus + densityBonus;
  const afterArmor = damageAfterArmor(dealt, armor, toughness, breach);
  const taken = damageAfterEffects(afterArmor, resistance, protection * EPF.protection);
  return { isSmash, baseDamage: MACE.attackDamage, smashBonus: bonus, densityBonus, dealt, taken };
}

/* ------------------------------------------------------------------ */
/* Generic run() surface                                              */
/* ------------------------------------------------------------------ */

export interface DamageCalcOpts {
  mode?: string;
  version?: string;
  amount?: number;
  armor?: number;
  toughness?: number;
  protection?: number;
  resistance?: number;
  breach?: number;
  critical?: boolean;
  height?: number;
  featherFalling?: number;
  slowFalling?: boolean;
  maceFall?: number;
  density?: number;
  [key: string]: unknown;
}

export type DamageCalcResult = Record<string, string>;

function fmt(n: number): string {
  return String(round2(n));
}

function hearts(n: number): string {
  return `${fmt(n / 2)} hearts`;
}

function killsLine(taken: number): string {
  const pools = [20, 40, 100];
  return pools
    .map((hp) => {
      const hits = hitsToKill(taken, hp);
      return `${hits === Infinity ? "never" : hits} vs ${hp} HP`;
    })
    .join(", ");
}

export function run(input: string, opts: DamageCalcOpts): DamageCalcResult {
  const mode = String(opts.mode ?? "melee");
  const version = requireVersion(opts.version ?? "1.21.11");

  if (mode === "melee") {
    const amount = requireNumber(opts.amount ?? 7, "Attack damage", 0, 10000);
    const dealt = opts.critical ? amount * 1.5 : amount;
    const r = meleeDamage({
      version,
      amount: dealt,
      armor: opts.armor ?? 0,
      toughness: opts.toughness ?? 0,
      protectionLevels: opts.protection ?? 0,
      resistance: opts.resistance ?? 0,
      breach: opts.breach ?? 0,
    });
    return {
      "Damage dealt": fmt(r.dealt),
      "After armor": fmt(r.afterArmor),
      "Damage taken": `${fmt(r.taken)} (${hearts(r.taken)})`,
      "Reduced by": `${fmt(r.reducedPercent)}%`,
      "Hits to kill": killsLine(r.taken),
    };
  }

  if (mode === "fall") {
    const r = fallDamage({
      version,
      height: opts.height ?? 10,
      featherFalling: opts.featherFalling ?? 0,
      slowFalling: Boolean(opts.slowFalling),
    });
    return {
      "Fall distance": `${fmt(r.fallDistance)} blocks`,
      "Base damage": fmt(r.baseDamage),
      "Damage taken": `${fmt(r.taken)} (${hearts(r.taken)})`,
      "Safe height": `${fmt(safeFallHeight(version, opts.featherFalling ?? 0))} blocks`,
    };
  }

  if (mode === "mace") {
    const r = maceDamage({
      version,
      fallDistance: opts.maceFall ?? 5,
      density: opts.density ?? 0,
      breach: opts.breach ?? 0,
      armor: opts.armor ?? 0,
      toughness: opts.toughness ?? 0,
      protectionLevels: opts.protection ?? 0,
      resistance: opts.resistance ?? 0,
    });
    return {
      "Smash attack": r.isSmash ? "yes" : "no (needs a fall over 1.5 blocks)",
      "Damage dealt": `${fmt(r.dealt)} (${fmt(r.baseDamage)} base + ${fmt(r.smashBonus)} smash + ${fmt(r.densityBonus)} density)`,
      "Damage taken": `${fmt(r.taken)} (${hearts(r.taken)})`,
      "Hits to kill": killsLine(r.taken),
    };
  }

  throw new ToolError(
    "unknown-mode",
    `"${mode}" is not a mode.`,
    'Use "melee", "fall", or "mace".',
  );
}

export default { run } satisfies ToolLogic<string, DamageCalcResult, DamageCalcOpts>;
