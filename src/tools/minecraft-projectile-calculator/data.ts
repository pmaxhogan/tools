/**
 * Static constants for the Minecraft projectile trajectory calculator.
 *
 * Every number here was read out of decompiled or unobfuscated Minecraft
 * server source for the six covered versions (mc-pipeline/work/<version>/src)
 * and reimplemented, never transcribed. The class and method each constant
 * comes from is named in the comment above it so the value can be re-checked.
 *
 * Hand written, not generated: this is roughly forty constants read from
 * source, not extracted game data, so there is no emitter script for it.
 */

export type VersionId = "1.16.5" | "1.18.2" | "1.20.6" | "1.21.1" | "1.21.11" | "26.2";

export const VERSIONS: VersionId[] = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

/**
 * Which Mth.sin/Mth.cos lookup table era a version uses.
 *
 * "float": Mth.sin(float) indexes SIN[(int)(x * 10430.378F) & 65535] and the
 *   table is filled with (float)Math.sin(i * 2 * PI / 65536).
 * "double": Mth.sin(double) indexes SIN[(int)((long)(x * 10430.378350470453)
 *   & 65535L)] and the table is filled with (float)Math.sin(i / 10430.378350470453).
 */
export type TrigEra = "float" | "double";

export interface VersionInfo {
  id: VersionId;
  label: string;
  /**
   * True when the version subtracts a Java float gravity constant from the
   * double motion (AbstractArrow.tick / ThrowableProjectile.tick do
   * `y - 0.05F` and `y - this.getGravity()` with a float return), which
   * widens 0.05F to 0.05000000074505806 and drifts from the double form.
   * False once Entity.applyGravity plus getDefaultGravity() (double) took over.
   */
  floatGravity: boolean;
  /**
   * True once ThrowableProjectile.tick applies gravity and drag BEFORE the
   * move instead of after it (the 1.21.2 movement rewrite). Arrows kept the
   * old move first ordering.
   */
  throwableAcceleratesFirst: boolean;
  /**
   * True once AbstractArrow.tick applies water drag before the move and skips
   * the 0.99 air drag entirely while submerged. Before that, an arrow in water
   * moved first and then took 0.6 in place of 0.99.
   */
  arrowWaterDragBeforeMove: boolean;
  /**
   * True once ThrownEnderpearl.onHit teleports the owner to oldPosition(), the
   * pearl's position at the start of the impact tick, rather than the clipped
   * impact point.
   */
  pearlLandsAtOldPosition: boolean;
  /**
   * True once AbstractHurtingProjectile.tick applies its acceleration and drag
   * before the move instead of after it. Same 1.21.2 boundary as throwables.
   */
  hurtingAcceleratesFirst: boolean;
  /**
   * True once AbstractHurtingProjectile derives its acceleration direction from
   * the current motion (`motion.normalize().scale(accelerationPower)`, 1.21.1
   * onward) rather than from the fixed xPower/yPower/zPower vector stored at
   * launch. Both give the same path while the motion stays collinear, which it
   * always does since these projectiles have no gravity.
   */
  hurtingAccelFromMotion: boolean;
  trigEra: TrigEra;
}

export const VERSION_INFO: Record<VersionId, VersionInfo> = {
  "1.16.5": {
    id: "1.16.5",
    label: "1.16.5",
    floatGravity: true,
    throwableAcceleratesFirst: false,
    arrowWaterDragBeforeMove: false,
    pearlLandsAtOldPosition: false,
    hurtingAcceleratesFirst: false,
    hurtingAccelFromMotion: false,
    trigEra: "float",
  },
  "1.18.2": {
    id: "1.18.2",
    label: "1.18.2",
    floatGravity: true,
    throwableAcceleratesFirst: false,
    arrowWaterDragBeforeMove: false,
    pearlLandsAtOldPosition: false,
    hurtingAcceleratesFirst: false,
    hurtingAccelFromMotion: false,
    trigEra: "float",
  },
  "1.20.6": {
    id: "1.20.6",
    label: "1.20.6",
    floatGravity: false,
    throwableAcceleratesFirst: false,
    arrowWaterDragBeforeMove: false,
    pearlLandsAtOldPosition: false,
    hurtingAcceleratesFirst: false,
    hurtingAccelFromMotion: false,
    trigEra: "float",
  },
  "1.21.1": {
    id: "1.21.1",
    label: "1.21.1",
    floatGravity: false,
    throwableAcceleratesFirst: false,
    arrowWaterDragBeforeMove: false,
    pearlLandsAtOldPosition: false,
    hurtingAcceleratesFirst: false,
    hurtingAccelFromMotion: true,
    trigEra: "float",
  },
  "1.21.11": {
    id: "1.21.11",
    label: "1.21.11",
    floatGravity: false,
    throwableAcceleratesFirst: true,
    arrowWaterDragBeforeMove: true,
    pearlLandsAtOldPosition: true,
    hurtingAcceleratesFirst: true,
    hurtingAccelFromMotion: true,
    trigEra: "double",
  },
  "26.2": {
    id: "26.2",
    label: "26.2 (latest)",
    floatGravity: false,
    throwableAcceleratesFirst: true,
    arrowWaterDragBeforeMove: true,
    pearlLandsAtOldPosition: true,
    hurtingAcceleratesFirst: true,
    hurtingAccelFromMotion: true,
    trigEra: "double",
  },
};

/* ------------------------------------------------------------------ */
/* projectiles                                                         */
/* ------------------------------------------------------------------ */

export type ProjectileId =
  | "arrow"
  | "tipped_arrow"
  | "spectral_arrow"
  | "trident"
  | "snowball"
  | "egg"
  | "ender_pearl"
  | "splash_potion"
  | "lingering_potion"
  | "experience_bottle"
  | "firework_rocket"
  | "firework_rocket_free"
  | "fireball"
  | "small_fireball";

/**
 * "arrow": AbstractArrow.tick, move first then drag then gravity.
 * "throwable": ThrowableProjectile.tick, ordering flips at 1.21.2.
 * "hurting": AbstractHurtingProjectile.tick, no gravity: motion gains a fixed
 *   acceleration along its own direction and is then scaled by 0.95, which
 *   makes a ghast fireball speed up to a terminal 1.9 blocks per tick.
 * "firework": FireworkRocketEntity.tick, no gravity and no drag. A rocket fired
 *   from a crossbow is flagged shot at angle and gets nothing at all, so it is a
 *   straight line; a placed or dispensed one gains 15 percent horizontal speed
 *   and 0.04 upward every tick.
 */
export type ProjectileFamily = "arrow" | "throwable" | "hurting" | "firework";

export type LaunchModeId = "bow" | "crossbow" | "throw" | "hand" | "free";

export interface LaunchMode {
  id: LaunchModeId;
  label: string;
  /** Velocity in blocks per tick at full power (Projectile.shoot scale term). */
  power: number;
  /**
   * Degrees added to the pitch for the y component only, before the direction
   * is normalized (Projectile.shootFromRotation angle argument). Potions and
   * experience bottles pass -20, which lobs them upward.
   */
  pitchOffset: number;
  /** Bow only: power ramps with draw time through BowItem.getPowerForTime. */
  chargeable: boolean;
}

export const LAUNCH_MODES: Record<LaunchModeId, LaunchMode> = {
  // BowItem.releaseUsing: shoot(..., getPowerForTime(t) * 3.0F, 1.0F)
  bow: { id: "bow", label: "Bow", power: 3, pitchOffset: 0, chargeable: true },
  // CrossbowItem.getShootingPower: 3.15F for arrows, 1.6F for firework rockets
  crossbow: { id: "crossbow", label: "Crossbow", power: 3.15, pitchOffset: 0, chargeable: false },
  // TridentItem.releaseUsing: shootFromRotation(..., 0.0F, 2.5F, 1.0F)
  throw: { id: "throw", label: "Thrown by hand", power: 2.5, pitchOffset: 0, chargeable: false },
  // SnowballItem / EggItem / EnderpearlItem: 1.5F. Overridden per projectile below.
  hand: { id: "hand", label: "Thrown by hand", power: 1.5, pitchOffset: 0, chargeable: false },
  // Not player launched: a mob, a dispenser, or a placed rocket. Speed is per projectile.
  free: { id: "free", label: "Launched on its own", power: 0.1, pitchOffset: 0, chargeable: false },
};

export interface ProjectileDef {
  id: ProjectileId;
  label: string;
  family: ProjectileFamily;
  /** Per tick downward acceleration from getDefaultGravity / getGravity. */
  gravity: number;
  /** Per tick multiplier applied to motion in air. */
  airDrag: number;
  /** Per tick multiplier applied to motion in water. */
  waterDrag: number;
  /** Which launchers can fire it, in menu order. */
  launchers: LaunchModeId[];
  /** Per launcher velocity override in blocks per tick. */
  powerByLauncher?: Partial<Record<LaunchModeId, number>>;
  /** Per launcher pitch offset override in degrees. */
  pitchOffsetByLauncher?: Partial<Record<LaunchModeId, number>>;
  /** Per launcher display name override, for launchers that are not a weapon. */
  launcherLabels?: Partial<Record<LaunchModeId, string>>;
  /**
   * "hurting" family only: AbstractHurtingProjectile.accelerationPower, the
   * speed added along the projectile's own direction every tick before drag.
   */
  accelerationPower?: number;
  /**
   * "firework" family only. True for a crossbow rocket, which the game flags
   * shot at angle and therefore never boosts.
   */
  shotAtAngle?: boolean;
  /** Flat impact damage, or "speed" when damage scales with velocity. */
  damage: { kind: "speed"; base: number } | { kind: "flat"; amount: number } | { kind: "none" };
  /** Search aliases for the picker. */
  synonyms: string[];
  /** One line of what makes this projectile behave the way it does. */
  note: string;
}

export const PROJECTILES: ProjectileDef[] = [
  {
    id: "arrow",
    label: "Arrow",
    family: "arrow",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.6,
    launchers: ["bow", "crossbow"],
    damage: { kind: "speed", base: 2 },
    synonyms: ["bow arrow", "normal arrow", "flint arrow"],
    note: "AbstractArrow: 0.05 gravity, 0.99 air drag, 0.6 water drag. Damage is ceil(speed times base damage).",
  },
  {
    id: "tipped_arrow",
    label: "Tipped arrow",
    family: "arrow",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.6,
    launchers: ["bow", "crossbow"],
    damage: { kind: "speed", base: 2 },
    synonyms: ["potion arrow", "poison arrow", "harming arrow"],
    note: "Flies exactly like a plain arrow; only the applied potion effect differs.",
  },
  {
    id: "spectral_arrow",
    label: "Spectral arrow",
    family: "arrow",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.6,
    launchers: ["bow", "crossbow"],
    damage: { kind: "speed", base: 2 },
    synonyms: ["glowing arrow", "glow arrow"],
    note: "Flies exactly like a plain arrow and adds 10 seconds of Glowing on hit.",
  },
  {
    id: "trident",
    label: "Trident",
    family: "arrow",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.99,
    launchers: ["throw"],
    damage: { kind: "flat", amount: 8 },
    synonyms: ["spear", "thrown trident", "loyalty trident"],
    note: "A trident is an arrow internally, but its water drag is 0.99 instead of 0.6, so it barely slows down underwater. Damage is a flat 8, not speed scaled.",
  },
  {
    id: "snowball",
    label: "Snowball",
    family: "throwable",
    gravity: 0.03,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    damage: { kind: "none" },
    synonyms: ["snow ball", "blaze damage"],
    note: "0.03 gravity, thrown at 1.5 blocks per tick. Deals no damage except 3 to a blaze.",
  },
  {
    id: "egg",
    label: "Egg",
    family: "throwable",
    gravity: 0.03,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    damage: { kind: "none" },
    synonyms: ["chicken egg", "egg throw"],
    note: "Identical flight to a snowball. One in eight hatches a chick.",
  },
  {
    id: "ender_pearl",
    label: "Ender pearl",
    family: "throwable",
    gravity: 0.03,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    damage: { kind: "none" },
    synonyms: ["pearl", "teleport", "enderpearl", "pearl clutch"],
    note: "Identical flight to a snowball. Teleports the thrower to the landing spot and deals 5 fall damage.",
  },
  {
    id: "splash_potion",
    label: "Splash potion",
    family: "throwable",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    powerByLauncher: { hand: 0.5 },
    pitchOffsetByLauncher: { hand: -20 },
    damage: { kind: "none" },
    synonyms: ["potion", "splash", "harming potion", "healing potion"],
    note: "Thrown at only 0.5 blocks per tick with a 20 degree upward pitch offset, and falls at 0.05 gravity, so it lobs a short distance.",
  },
  {
    id: "lingering_potion",
    label: "Lingering potion",
    family: "throwable",
    gravity: 0.05,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    powerByLauncher: { hand: 0.5 },
    pitchOffsetByLauncher: { hand: -20 },
    damage: { kind: "none" },
    synonyms: ["lingering", "area effect cloud", "dragon breath potion"],
    note: "Flies exactly like a splash potion and leaves an area effect cloud on impact.",
  },
  {
    id: "experience_bottle",
    label: "Bottle o' Enchanting",
    family: "throwable",
    gravity: 0.07,
    airDrag: 0.99,
    waterDrag: 0.8,
    launchers: ["hand"],
    powerByLauncher: { hand: 0.7 },
    pitchOffsetByLauncher: { hand: -20 },
    damage: { kind: "none" },
    synonyms: ["xp bottle", "experience bottle", "bottle o enchanting", "exp bottle"],
    note: "The heaviest throwable at 0.07 gravity, thrown at 0.7 blocks per tick with the same 20 degree upward offset as a potion.",
  },
  {
    id: "firework_rocket",
    label: "Firework rocket (crossbow)",
    family: "firework",
    gravity: 0,
    airDrag: 1,
    waterDrag: 1,
    launchers: ["crossbow"],
    powerByLauncher: { crossbow: 1.6 },
    shotAtAngle: true,
    damage: { kind: "none" },
    synonyms: ["rocket", "firework", "crossbow firework"],
    note: "A rocket fired from a crossbow is flagged shot at angle, so it takes no gravity, no drag, and no 1.15 boost. It travels in a perfectly straight line until its fuse ends.",
  },
  {
    id: "firework_rocket_free",
    label: "Firework rocket (placed or dispensed)",
    family: "firework",
    gravity: 0,
    airDrag: 1,
    waterDrag: 1,
    launchers: ["free"],
    powerByLauncher: { free: 0.05 },
    launcherLabels: { free: "Placed, dispensed, or used with an elytra" },
    shotAtAngle: false,
    damage: { kind: "none" },
    synonyms: ["elytra boost", "rocket boost", "dispenser firework"],
    note: "A rocket that is not shot at an angle multiplies its horizontal speed by 1.15 and adds 0.04 upward every tick, so it accelerates the whole way instead of slowing down.",
  },
  {
    id: "fireball",
    label: "Ghast fireball",
    family: "hurting",
    gravity: 0,
    airDrag: 0.95,
    waterDrag: 0.8,
    accelerationPower: 0.1,
    launchers: ["free"],
    powerByLauncher: { free: 0.1 },
    launcherLabels: { free: "Spat by a ghast" },
    damage: { kind: "none" },
    synonyms: ["ghast", "large fireball", "deflect"],
    note: "No gravity at all. Each tick it gains 0.1 blocks per tick along its own heading and is then scaled by 0.95, so it speeds up from a crawl to a terminal 1.9 blocks per tick.",
  },
  {
    id: "small_fireball",
    label: "Blaze fireball",
    family: "hurting",
    gravity: 0,
    airDrag: 0.95,
    waterDrag: 0.8,
    accelerationPower: 0.1,
    launchers: ["free"],
    powerByLauncher: { free: 0.1 },
    launcherLabels: { free: "Spat by a blaze" },
    damage: { kind: "flat", amount: 5 },
    synonyms: ["blaze", "small fireball", "fire charge"],
    note: "Flies exactly like a ghast fireball and sets the target alight for 5 seconds instead of exploding.",
  },
];

export const PROJECTILE_BY_ID: Record<ProjectileId, ProjectileDef> = Object.fromEntries(
  PROJECTILES.map((p) => [p.id, p]),
) as Record<ProjectileId, ProjectileDef>;

/* ------------------------------------------------------------------ */
/* enchantments (only real ones per weapon, PROJECT rule: no impossible combos) */
/* ------------------------------------------------------------------ */

export type EnchantId =
  | "power"
  | "punch"
  | "flame"
  | "infinity"
  | "multishot"
  | "piercing"
  | "quick_charge"
  | "loyalty"
  | "riptide"
  | "channeling"
  | "impaling";

export interface EnchantDef {
  id: EnchantId;
  label: string;
  maxLevel: number;
  /** Which launcher the enchantment can appear on. */
  weapon: LaunchModeId;
  /** Other enchantments it can never share an item with. */
  excludes: EnchantId[];
  synonyms: string[];
  effect: string;
}

export const ENCHANTMENTS: EnchantDef[] = [
  {
    id: "power",
    label: "Power",
    maxLevel: 5,
    weapon: "bow",
    excludes: [],
    synonyms: ["arrow damage", "power v"],
    effect: "Adds 1 base damage at level 1 and 0.5 per level after, before the speed multiplier.",
  },
  {
    id: "punch",
    label: "Punch",
    maxLevel: 2,
    weapon: "bow",
    excludes: [],
    synonyms: ["knockback", "arrow knockback"],
    effect: "Adds one knockback unit per level, worth 0.6 blocks per tick of horizontal push.",
  },
  {
    id: "flame",
    label: "Flame",
    maxLevel: 1,
    weapon: "bow",
    excludes: [],
    synonyms: ["fire arrow", "burning arrow"],
    effect: "Sets the target on fire for 5 seconds. No effect on the trajectory.",
  },
  {
    id: "infinity",
    label: "Infinity",
    maxLevel: 1,
    weapon: "bow",
    excludes: [],
    synonyms: ["infinite arrows", "no ammo"],
    effect: "Saves the arrow. No effect on the trajectory or the damage.",
  },
  {
    id: "multishot",
    label: "Multishot",
    maxLevel: 1,
    weapon: "crossbow",
    excludes: ["piercing"],
    synonyms: ["three arrows", "spread"],
    effect: "Fires 3 arrows at 0, -10 and +10 degrees of yaw. Only the middle one follows your crosshair.",
  },
  {
    id: "piercing",
    label: "Piercing",
    maxLevel: 4,
    weapon: "crossbow",
    excludes: ["multishot"],
    synonyms: ["pierce", "through mobs"],
    effect: "Passes through one extra entity per level. No effect on the trajectory.",
  },
  {
    id: "quick_charge",
    label: "Quick Charge",
    maxLevel: 3,
    weapon: "crossbow",
    excludes: [],
    synonyms: ["faster reload", "charge time"],
    effect: "Cuts 0.25 seconds per level off the 1.25 second crossbow charge.",
  },
  {
    id: "loyalty",
    label: "Loyalty",
    maxLevel: 3,
    weapon: "throw",
    excludes: ["riptide"],
    synonyms: ["returns", "comes back"],
    effect: "Returns the trident to you after it lands. No effect on the outbound flight.",
  },
  {
    id: "riptide",
    label: "Riptide",
    maxLevel: 3,
    weapon: "throw",
    excludes: ["loyalty", "channeling"],
    synonyms: ["rocket jump", "launch yourself", "water launch"],
    effect: "Launches you instead of the trident, at 3 times (1 + level) / 4 blocks per tick, and only in water or rain.",
  },
  {
    id: "channeling",
    label: "Channeling",
    maxLevel: 1,
    weapon: "throw",
    excludes: ["riptide"],
    synonyms: ["lightning", "thunder"],
    effect: "Summons lightning on a hit during a thunderstorm. No effect on the flight.",
  },
  {
    id: "impaling",
    label: "Impaling",
    maxLevel: 5,
    weapon: "throw",
    excludes: [],
    synonyms: ["aquatic damage", "water mobs"],
    effect: "Adds 2.5 damage per level against mobs that are sensitive to impaling, which is aquatic mobs only in Java.",
  },
];

export const ENCHANT_BY_ID: Record<EnchantId, EnchantDef> = Object.fromEntries(
  ENCHANTMENTS.map((e) => [e.id, e]),
) as Record<EnchantId, EnchantDef>;

/** Enchantments that can legally sit on the weapon behind this launch mode. */
export function enchantsForLauncher(launcher: LaunchModeId): EnchantDef[] {
  return ENCHANTMENTS.filter((e) => e.weapon === launcher);
}

/* ------------------------------------------------------------------ */
/* misc constants                                                      */
/* ------------------------------------------------------------------ */

/**
 * A projectile spawns at getEyeY() - 0.1 (AbstractArrow and
 * ThrowableItemProjectile constructors). A standing player's eye height is
 * 1.62, so a shot leaves the bow 1.52 blocks above the feet.
 */
export const STANDING_EYE_HEIGHT = 1.62;
export const LAUNCH_HEIGHT_OFFSET = 0.1;
export const DEFAULT_LAUNCH_HEIGHT = STANDING_EYE_HEIGHT - LAUNCH_HEIGHT_OFFSET;

/** Ticks per second. */
export const TPS = 20;

/** Base crossbow charge time in seconds (CrossbowItem.getChargeDuration). */
export const CROSSBOW_BASE_CHARGE_SECONDS = 1.25;

/** Full bow draw in ticks (BowItem.MAX_DRAW_DURATION). */
export const BOW_FULL_DRAW_TICKS = 20;

/** Fall damage an ender pearl deals to the player it teleports. */
export const ENDER_PEARL_DAMAGE = 5;

/** Knockback blocks per tick per Punch level (AbstractArrow.doKnockback). */
export const PUNCH_KNOCKBACK_PER_LEVEL = 0.6;

/** Vertical component of arrow knockback, constant regardless of Punch level. */
export const PUNCH_VERTICAL_PUSH = 0.1;

/** An arrow that never lands despawns after this many ticks (AbstractArrow.tickDespawn). */
export const ARROW_DESPAWN_TICKS = 1200;
