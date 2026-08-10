import { ToolError, type ToolLogic } from "../types";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  EPF,
  MACE,
  MOBS,
  STRENGTH_PER_LEVEL,
  VERSIONS,
  VERSION_INFO,
  WEAKNESS_PER_LEVEL,
  mobInVersion,
  type ArmorSlot,
  type Difficulty,
  type MobAttackKind,
  type MobClassification,
  type MobData,
  type VersionId,
  type WeaponEnchantId,
  type WeaponFamily,
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
/* Difficulty scaling                                                 */
/* ------------------------------------------------------------------ */

/**
 * Player#hurtServer difficulty scaling (identical float expression in
 * 1.16.5 Player#hurt): Peaceful zeroes, Easy is min(d / 2 + 1, d), Hard is
 * d * 3 / 2. The game applies this only when the defender is a player.
 */
export function scaleWithDifficulty(amount: number, difficulty: Difficulty): number {
  const a = f32(amount);
  if (difficulty === "peaceful") return 0;
  if (difficulty === "easy") return Math.min(f32(f32(a / 2) + 1), a);
  if (difficulty === "hard") return f32(f32(a * 3) / 2);
  return a;
}

/**
 * Whether a mob's hit difficulty-scales in a version. Mob melee and
 * explosions scale everywhere; arrows only from 1.20.6 on (legacy
 * IndirectEntityDamageSource carries the arrow, not the shooter, so
 * EntityDamageSource#scalesWithDifficulty saw a non-living entity before
 * the 1.19.4 damage type rework). Scaling always requires a player
 * defender, because the whole block lives in Player#hurtServer.
 */
export function attackScalesWithDifficulty(
  version: VersionId,
  kind: MobAttackKind,
  defenderIsPlayer: boolean,
): boolean {
  if (!defenderIsPlayer) return false;
  if (kind === "arrow") {
    return version !== "1.16.5" && version !== "1.18.2";
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Attacker strikes                                                   */
/* ------------------------------------------------------------------ */

/**
 * Weapon damage enchant bonus (DamageEnchantment#getDamageBonus; identical
 * linear values in the modern enchantment JSON): Sharpness 1 + 0.5 per
 * level past the first; Smite / Bane 2.5 x level against the right class.
 */
export function weaponEnchantBonus(
  enchant: WeaponEnchantId,
  level: number,
  defenderClass: MobClassification,
): number {
  const lvl = clamp(Math.floor(level), 0, 5);
  if (lvl <= 0 || enchant === "none") return 0;
  if (enchant === "sharpness") return f32(1 + f32(Math.max(0, lvl - 1) * 0.5));
  if (enchant === "smite") return defenderClass === "undead" ? f32(lvl * 2.5) : 0;
  return defenderClass === "arthropod" ? f32(lvl * 2.5) : 0;
}

/**
 * Whether a weapon family can legally hold a damage enchant in a version.
 * Sharpness: swords and axes (legacy DamageEnchantment#canEnchant accepts
 * AxeItem; modern #minecraft:enchantable/sharp_weapon). Smite / Bane:
 * swords, axes, and from 1.21 the mace as well
 * (tags/item/enchantable/weapon.json includes minecraft:mace).
 */
export function enchantFitsWeapon(
  version: VersionId,
  family: WeaponFamily,
  enchant: WeaponEnchantId,
): boolean {
  if (enchant === "none") return true;
  if (family === "sword" || family === "axe") return true;
  if (family === "mace" && enchant !== "sharpness") return VERSION_INFO[version].mace;
  return false;
}

export interface PlayerStrikeOptions {
  version: VersionId;
  /** Attack damage attribute total: player base 1 plus the weapon modifier. */
  baseAttack: number;
  weaponFamily?: WeaponFamily;
  /** Strength effect level 0..2 (+3 attack per level). */
  strength?: number;
  /** Weakness effect level 0..1 (-4 attack per level). */
  weakness?: number;
  critical?: boolean;
  enchant?: WeaponEnchantId;
  enchantLevel?: number;
  defenderClass?: MobClassification;
}

export interface StrikeResult {
  /** Attack damage attribute after Strength / Weakness, floored at 0. */
  attribute: number;
  enchantBonus: number;
  dealt: number;
}

/**
 * A fully charged player melee strike, composed the way Player#attack does
 * in every covered version: the attribute part (base + Strength - Weakness,
 * floored at 0 by the attribute range) takes the 1.5x crit multiplier; the
 * enchant bonus is added afterwards, outside the crit.
 */
export function playerStrike(opts: PlayerStrikeOptions): StrikeResult {
  const version = requireVersion(opts.version);
  const base = requireNumber(opts.baseAttack, "Attack damage", 0, 10000);
  const strength = requireNumber(opts.strength ?? 0, "Strength", 0, 2);
  const weakness = requireNumber(opts.weakness ?? 0, "Weakness", 0, 1);
  const enchant = opts.enchant ?? "none";
  const level = requireNumber(opts.enchantLevel ?? 0, "Enchant level", 0, 5);
  const family = opts.weaponFamily ?? "other";
  if (enchant !== "none" && level > 0 && !enchantFitsWeapon(version, family, enchant)) {
    throw new ToolError(
      "enchant-weapon-mismatch",
      `${enchant} cannot go on this weapon in ${version}.`,
      "Sharpness fits swords and axes; Smite and Bane fit swords, axes, and the 1.21+ mace.",
    );
  }
  const attribute = Math.max(
    0,
    f32(base + strength * STRENGTH_PER_LEVEL - weakness * WEAKNESS_PER_LEVEL),
  );
  const enchantBonus = weaponEnchantBonus(enchant, level, opts.defenderClass ?? "none");
  const dealt = f32(f32(attribute * (opts.critical ? 1.5 : 1)) + enchantBonus);
  return { attribute, enchantBonus, dealt };
}

export interface MobStrikeResult {
  mob: MobData;
  kind: MobAttackKind;
  scaled: boolean;
  dealt: number;
  dealtMin: number;
  dealtMax: number;
}

/** A mob's hit, difficulty-scaled when the game would scale it. */
export function mobStrike(
  version: VersionId,
  mobId: string,
  difficulty: Difficulty,
  defenderIsPlayer: boolean,
): MobStrikeResult {
  const v = requireVersion(version);
  const mob = MOBS.find((m) => m.id === mobId);
  if (!mob) {
    throw new ToolError(
      "unknown-mob",
      `"${mobId}" is not in the mob list.`,
      `Pick one of: ${MOBS.map((m) => m.id).join(", ")}.`,
    );
  }
  if (!mobInVersion(mob, v)) {
    throw new ToolError(
      "mob-not-in-version",
      `${mob.label} does not exist in ${v}.`,
      `Pick ${mob.since} or later for this mob.`,
    );
  }
  const scaled = attackScalesWithDifficulty(v, mob.attack.kind, defenderIsPlayer);
  const apply = (n: number) => (scaled ? scaleWithDifficulty(n, difficulty) : f32(n));
  return {
    mob,
    kind: mob.attack.kind,
    scaled,
    dealt: apply(mob.attack.amount),
    dealtMin: apply(mob.attack.min ?? mob.attack.amount),
    dealtMax: apply(mob.attack.max ?? mob.attack.amount),
  };
}

/* ------------------------------------------------------------------ */
/* Defenses with Absorption                                           */
/* ------------------------------------------------------------------ */

export interface DefenseOptions {
  armor?: number;
  toughness?: number;
  /** EPF sum already multiplied per enchant type (Protection x1, FF x3). */
  protectionEpf?: number;
  resistance?: number;
  breach?: number;
  /** Absorption points (4 per effect level), consumed before health. */
  absorption?: number;
  /** Skip the armor step (fall damage and other bypasses_armor sources). */
  bypassArmor?: boolean;
}

export interface DefendedHit {
  taken: number;
  absorbed: number;
  healthLost: number;
}

/**
 * The defender's full reduction chain in game order (LivingEntity
 * #actuallyHurt): armor formula (unless bypassed), then Resistance, then
 * the EPF multiplier, then Absorption points soak what is left before
 * health does.
 */
export function applyDefenses(dealt: number, d: DefenseOptions): DefendedHit {
  const amount = requireNumber(dealt, "Damage", 0, 1_000_000);
  const armor = requireNumber(d.armor ?? 0, "Armor", 0, 100);
  const toughness = requireNumber(d.toughness ?? 0, "Toughness", 0, 100);
  const epf = requireNumber(d.protectionEpf ?? 0, "Protection EPF", 0, 100);
  const resistance = requireNumber(d.resistance ?? 0, "Resistance", 0, 5);
  const breach = requireNumber(d.breach ?? 0, "Breach", 0, 4);
  const absorption = requireNumber(d.absorption ?? 0, "Absorption", 0, 1000);
  const afterArmor = d.bypassArmor ? f32(amount) : damageAfterArmor(amount, armor, toughness, breach);
  const taken = damageAfterEffects(afterArmor, resistance, epf);
  const absorbed = Math.min(taken, absorption);
  return { taken, absorbed, healthLost: taken - absorbed };
}

/**
 * Hits to empty a health pool plus an Absorption buffer. Absorption soaks
 * damage point for point until the pool runs out, so the kill threshold is
 * simply hp + absorption.
 */
export function hitsToKillWithAbsorption(taken: number, hp: number, absorption = 0): number {
  if (taken <= 0) return Infinity;
  return Math.ceil((hp + absorption) / taken);
}

/* ------------------------------------------------------------------ */
/* Matchup assembly                                                   */
/* ------------------------------------------------------------------ */

export interface KitOptions {
  build: ArmorBuild;
  /** Feather Falling on the boots, 0..4 (fall mode only). */
  featherFalling?: number;
  /** Effective Resistance level 0..5 from potions, beacons, or apples. */
  resistance?: number;
  /** Absorption points from golden apples. */
  absorption?: number;
}

export interface MatchupAttacker {
  kind: "mob" | "player";
  mobId?: string;
  weaponDamage?: number;
  weaponFamily?: WeaponFamily;
  strength?: number;
  weakness?: number;
  critical?: boolean;
  enchant?: WeaponEnchantId;
  enchantLevel?: number;
}

export interface MatchupDefender {
  kind: "mob" | "player";
  mobId?: string;
  kit?: KitOptions;
}

export interface MatchupOptions {
  version: VersionId;
  difficulty?: Difficulty;
  mode: "attack" | "fall" | "mace";
  attacker?: MatchupAttacker;
  defender: MatchupDefender;
  fall?: { height: number; slowFalling?: boolean };
  mace?: {
    fallDistance: number;
    density?: number;
    breach?: number;
    critical?: boolean;
    enchant?: WeaponEnchantId;
    enchantLevel?: number;
  };
}

export interface MatchupResult {
  dealt: number;
  dealtMin: number;
  dealtMax: number;
  taken: number;
  takenMin: number;
  takenMax: number;
  absorbed: number;
  healthLost: number;
  reducedPercent: number;
  hits: number;
  defenderHp: number;
  defenderAbsorption: number;
  scaled: boolean;
  breakdown: { label: string; value: string }[];
}

interface ResolvedDefender {
  isPlayer: boolean;
  hp: number;
  armor: number;
  toughness: number;
  protectionLevels: number;
  featherFalling: number;
  resistance: number;
  absorption: number;
  classification: MobClassification;
  label: string;
}

function resolveDefender(version: VersionId, defender: MatchupDefender): ResolvedDefender {
  if (defender.kind === "mob") {
    const mob = MOBS.find((m) => m.id === defender.mobId);
    if (!mob) {
      throw new ToolError(
        "unknown-mob",
        `"${defender.mobId}" is not in the mob list.`,
        `Pick one of: ${MOBS.map((m) => m.id).join(", ")}.`,
      );
    }
    if (!mobInVersion(mob, version)) {
      throw new ToolError(
        "mob-not-in-version",
        `${mob.label} does not exist in ${version}.`,
        `Pick ${mob.since} or later for this mob.`,
      );
    }
    return {
      isPlayer: false,
      hp: mob.hp,
      armor: mob.armor,
      toughness: 0,
      protectionLevels: 0,
      featherFalling: 0,
      resistance: 0,
      absorption: 0,
      classification: mob.classification,
      label: mob.label,
    };
  }
  const kit = defender.kit ?? { build: {} };
  const built = buildArmor(version, kit.build);
  return {
    isPlayer: true,
    hp: 20,
    armor: built.armor,
    toughness: built.toughness,
    protectionLevels: built.protectionLevels,
    featherFalling: requireNumber(kit.featherFalling ?? 0, "Feather Falling", 0, 4),
    resistance: requireNumber(kit.resistance ?? 0, "Resistance", 0, 5),
    absorption: requireNumber(kit.absorption ?? 0, "Absorption", 0, 1000),
    classification: "none",
    label: "Player",
  };
}

function pct(dealt: number, taken: number): number {
  return dealt > 0 ? (1 - taken / dealt) * 100 : 0;
}

/**
 * The full matchup: one attacking hit resolved against one defender, per
 * version and difficulty. Every path routes through the golden-vector
 * verified primitives (damageAfterArmor, damageAfterEffects, fallDamage,
 * maceDamage); this function only composes them in game order.
 */
export function matchup(opts: MatchupOptions): MatchupResult {
  const version = requireVersion(opts.version);
  const difficulty: Difficulty = opts.difficulty ?? "normal";
  const defender = resolveDefender(version, opts.defender);
  const breakdown: { label: string; value: string }[] = [];
  const defense: DefenseOptions = {
    armor: defender.armor,
    toughness: defender.toughness,
    protectionEpf: defender.protectionLevels * EPF.protection,
    resistance: defender.resistance,
    absorption: defender.absorption,
  };

  let dealt: number;
  let dealtMin: number;
  let dealtMax: number;
  let scaled = false;

  if (opts.mode === "fall") {
    const fall = opts.fall ?? { height: 10 };
    const base = fallDamage({
      version,
      height: fall.height,
      featherFalling: 0,
      slowFalling: fall.slowFalling,
    });
    dealt = dealtMin = dealtMax = base.baseDamage;
    defense.bypassArmor = true;
    defense.protectionEpf =
      defender.featherFalling * EPF.featherFalling + defender.protectionLevels * EPF.protection;
    breakdown.push({
      label: "Fall distance the game sees",
      value: `${round2(base.fallDistance)} blocks`,
    });
    breakdown.push({ label: "Base fall damage", value: String(base.baseDamage) });
    if (fall.slowFalling) breakdown.push({ label: "Slow Falling", value: "no fall damage" });
  } else if (opts.mode === "mace") {
    const mace = opts.mace ?? { fallDistance: 5 };
    const smash = maceDamage({
      version,
      fallDistance: mace.fallDistance,
      density: mace.density ?? 0,
      armor: 0,
      toughness: 0,
    });
    const enchant = mace.enchant ?? "none";
    const level = mace.enchantLevel ?? 0;
    if (enchant !== "none" && level > 0 && !enchantFitsWeapon(version, "mace", enchant)) {
      throw new ToolError(
        "enchant-weapon-mismatch",
        `${enchant} cannot go on a mace in ${version}.`,
        "Smite and Bane of Arthropods fit the mace from 1.21 on; Sharpness never does.",
      );
    }
    const enchBonus = weaponEnchantBonus(enchant, level, defender.classification);
    const crit = Boolean(mace.critical);
    dealt = dealtMin = dealtMax = f32(f32(smash.dealt * (crit ? 1.5 : 1)) + enchBonus);
    defense.breach = requireNumber(mace.breach ?? 0, "Breach", 0, 4);
    breakdown.push({
      label: "Smash parts",
      value: `${smash.baseDamage} base + ${round2(smash.smashBonus)} smash + ${round2(smash.densityBonus)} Density`,
    });
    if (crit) breakdown.push({ label: "Critical hit", value: "x1.5 before the enchant bonus" });
    if (enchBonus > 0) breakdown.push({ label: "Enchant bonus", value: `+${round2(enchBonus)}` });
    if (!smash.isSmash) {
      breakdown.push({
        label: "Smash attack",
        value: `no (needs a fall over ${MACE.smashThreshold} blocks)`,
      });
    }
  } else if (opts.attacker?.kind === "mob") {
    const strike = mobStrike(version, opts.attacker.mobId ?? "", difficulty, defender.isPlayer);
    scaled = strike.scaled;
    dealt = strike.dealt;
    dealtMin = strike.dealtMin;
    dealtMax = strike.dealtMax;
    // Arrows and explosions are reduced by armor normally; neither is in
    // bypasses_armor, so no defense flags change here.
    breakdown.push({
      label: `${strike.mob.label} hit`,
      value:
        strike.dealtMin !== strike.dealtMax
          ? `${round2(strike.dealtMin)} to ${round2(strike.dealtMax)} (avg ${round2(strike.dealt)})`
          : String(round2(strike.dealt)),
    });
    breakdown.push({
      label: "Difficulty scaling",
      value: scaled
        ? `${difficulty} (${difficulty === "easy" ? "min(d / 2 + 1, d)" : difficulty === "hard" ? "d x 1.5" : difficulty === "peaceful" ? "no damage" : "unchanged"})`
        : defender.isPlayer
          ? version === "1.16.5" || version === "1.18.2"
            ? "arrows never scaled before 1.19.4"
            : "not scaled"
          : "mobs never get scaled damage, only players do",
    });
  } else {
    const attacker = opts.attacker ?? { kind: "player" as const };
    const strike = playerStrike({
      version,
      baseAttack: attacker.weaponDamage ?? 1,
      weaponFamily: attacker.weaponFamily ?? "other",
      strength: attacker.strength,
      weakness: attacker.weakness,
      critical: attacker.critical,
      enchant: attacker.enchant,
      enchantLevel: attacker.enchantLevel,
      defenderClass: defender.classification,
    });
    dealt = dealtMin = dealtMax = strike.dealt;
    breakdown.push({ label: "Attack attribute", value: String(round2(strike.attribute)) });
    if (attacker.critical) breakdown.push({ label: "Critical hit", value: "x1.5 on the attribute" });
    if (strike.enchantBonus > 0) {
      breakdown.push({
        label: "Enchant bonus (after crit)",
        value: `+${round2(strike.enchantBonus)}`,
      });
    } else if (
      (attacker.enchant === "smite" || attacker.enchant === "bane") &&
      (attacker.enchantLevel ?? 0) > 0
    ) {
      breakdown.push({
        label: "Enchant bonus",
        value: `0 (${attacker.enchant === "smite" ? "Smite only hurts undead" : "Bane only hurts arthropods"})`,
      });
    }
  }

  const hit = applyDefenses(dealt, defense);
  const hitMin = dealtMin === dealt ? hit : applyDefenses(dealtMin, defense);
  const hitMax = dealtMax === dealt ? hit : applyDefenses(dealtMax, defense);

  if (!defense.bypassArmor && (defender.armor > 0 || defender.toughness > 0)) {
    breakdown.push({
      label: "Armor step",
      value: `${defender.armor} armor, ${defender.toughness} toughness${(defense.breach ?? 0) > 0 ? `, Breach ${defense.breach}` : ""}`,
    });
  }
  if (defense.bypassArmor) {
    breakdown.push({ label: "Armor step", value: "skipped (fall damage bypasses armor)" });
  }
  if (defender.resistance > 0) {
    breakdown.push({
      label: "Resistance",
      value: `level ${defender.resistance} (-${defender.resistance * 20}%)`,
    });
  }
  if ((defense.protectionEpf ?? 0) > 0) {
    breakdown.push({
      label: "Enchantment protection",
      value: `EPF ${Math.min(defense.protectionEpf ?? 0, EPF.cap)} (-${Math.min(defense.protectionEpf ?? 0, EPF.cap) * 4}%)`,
    });
  }
  if (defender.absorption > 0) {
    breakdown.push({
      label: "Absorption",
      value: `${defender.absorption} points soak ${round2(hit.absorbed)} of this hit`,
    });
  }

  return {
    dealt,
    dealtMin,
    dealtMax,
    taken: hit.taken,
    takenMin: hitMin.taken,
    takenMax: hitMax.taken,
    absorbed: hit.absorbed,
    healthLost: hit.healthLost,
    reducedPercent: pct(dealt, hit.taken),
    hits: hitsToKillWithAbsorption(hit.taken, defender.hp, defender.absorption),
    defenderHp: defender.hp,
    defenderAbsorption: defender.absorption,
    scaled,
    breakdown,
  };
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
