/**
 * Per-version Minecraft damage data, reimplemented from decompiled or
 * unobfuscated server source and from vanilla data extracted by mc-pipeline.
 *
 * Sources (paths are 1.21.11 Mojang-mapped names; older trees match unless
 * noted; all six trees live under mc-pipeline/work/<id>/src/):
 * - Armor formula: net.minecraft.world.damagesource.CombatRules
 *   #getDamageAfterAbsorb. Identical math in all six versions; 1.20.5+
 *   additionally routes the armor fraction through
 *   EnchantmentHelper#modifyArmorEffectiveness (the Breach hook).
 * - Resistance and enchantment EPF: net.minecraft.world.entity.LivingEntity
 *   #getDamageAfterMagicAbsorb (resistance is (level * 5) / 25 = 20% per
 *   level; EPF sum clamps to 20, each point is 4%).
 * - EPF per enchantment: 1.16.5 / 1.18.2
 *   net.minecraft.world.item.enchantment.ProtectionEnchantment
 *   #getDamageProtection (ALL = level, FIRE / EXPLOSION / PROJECTILE =
 *   2 * level, FALL = 3 * level); 1.20.6+ the same values as
 *   minecraft:damage_protection linear effects in
 *   mc-pipeline/extracted/<v>/enchantment/*.json.
 * - Armor item stats: 1.20.6+ parsed from
 *   mc-pipeline/extracted/<v>/item_components.json
 *   (minecraft:attribute_modifiers); 1.16.5 / 1.18.2 from
 *   net.minecraft.world.item.ArmorMaterials (slotProtections order is
 *   boots, leggings, chestplate, helmet). The numbers are identical in
 *   every version that has the material; netherite toughness is 3 and
 *   knockback resistance 0.1 everywhere.
 * - Mace: net.minecraft.world.item.MaceItem (1.21.1 and 1.21.11 agree):
 *   base attack damage modifier 5, smash bonus 4 * fall for the first 3
 *   blocks, then 2 per block to 8, then 1 per block; Density adds
 *   0.5 * level per fallen block (minecraft:smash_damage_per_fallen_block);
 *   Breach adds -0.15 * level armor effectiveness
 *   (minecraft:armor_effectiveness).
 * - Fall damage: legacy versions (through 1.21.1)
 *   LivingEntity#calculateFallDamage = ceil(fallDistance - 3 - jumpBoost),
 *   where fallDistance accumulates per tick in Entity#checkFallDamage and
 *   the landing tick's movement never accumulates (velocity per tick is
 *   v = (v - 0.08) * 0.98, applied after the move). Modern versions
 *   (1.21.2+) LivingEntity#calculateFallDamage =
 *   floor((fallDistance + 1e-6 - SAFE_FALL_DISTANCE) * FALL_DAMAGE
 *   _MULTIPLIER) with fall distance computed from actual positions, so it
 *   equals the geometric drop height.
 * - Damage type tags: mc-pipeline/extracted/<v>/damage_type_tags/
 *   bypasses_armor.json includes magic, generic, out_of_world and fall in
 *   every version that has the registry (armor never reduces fall damage).
 *
 * Golden vectors measured over RCON against real dedicated servers back all
 * of this: mc-pipeline/vectors/damage/<v>.json and
 * mc-pipeline/vectors/fall/<v>.json.
 */

export const VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"] as const;

export type VersionId = (typeof VERSIONS)[number];

export interface VersionInfo {
  id: VersionId;
  label: string;
  /** Per-tick fall distance ("legacy", through 1.21.1) or position based ("modern", 1.21.2+). */
  fallModel: "legacy" | "modern";
  /** Mace, Density and Breach exist (added in 1.21). */
  mace: boolean;
  /** Copper armor exists (added in the 1.21.9 copper drop). */
  copper: boolean;
}

export const VERSION_INFO: Record<VersionId, VersionInfo> = {
  "1.16.5": { id: "1.16.5", label: "1.16.5", fallModel: "legacy", mace: false, copper: false },
  "1.18.2": { id: "1.18.2", label: "1.18.2", fallModel: "legacy", mace: false, copper: false },
  "1.20.6": { id: "1.20.6", label: "1.20.6", fallModel: "legacy", mace: false, copper: false },
  "1.21.1": { id: "1.21.1", label: "1.21.1", fallModel: "legacy", mace: true, copper: false },
  "1.21.11": { id: "1.21.11", label: "1.21.11", fallModel: "modern", mace: true, copper: true },
  "26.2": { id: "26.2", label: "26.2 (latest)", fallModel: "modern", mace: true, copper: true },
};

export type ArmorSlot = "helmet" | "chestplate" | "leggings" | "boots";

export const ARMOR_SLOTS: ArmorSlot[] = ["helmet", "chestplate", "leggings", "boots"];

export interface ArmorMaterialData {
  id: string;
  label: string;
  /** Armor points per slot; null when the material has no item for the slot. */
  points: Record<ArmorSlot, number | null>;
  /** Armor toughness per piece. */
  toughness: number;
  /** Versions in which the material exists. */
  since: "all" | "copper";
}

/**
 * Armor points per piece. 1.16.5 ArmorMaterials slotProtections arrays and
 * 1.21.11 / 26.2 item_components.json agree exactly for every shared
 * material; copper values come from 1.21.11 item_components.json only.
 */
export const ARMOR_MATERIALS: ArmorMaterialData[] = [
  {
    id: "leather",
    label: "Leather",
    points: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
    toughness: 0,
    since: "all",
  },
  {
    id: "golden",
    label: "Gold",
    points: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
    toughness: 0,
    since: "all",
  },
  {
    id: "chainmail",
    label: "Chainmail",
    points: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
    toughness: 0,
    since: "all",
  },
  {
    id: "copper",
    label: "Copper",
    points: { helmet: 2, chestplate: 4, leggings: 3, boots: 1 },
    toughness: 0,
    since: "copper",
  },
  {
    id: "iron",
    label: "Iron",
    points: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
    toughness: 0,
    since: "all",
  },
  {
    id: "turtle",
    label: "Turtle shell",
    points: { helmet: 2, chestplate: null, leggings: null, boots: null },
    toughness: 0,
    since: "all",
  },
  {
    id: "diamond",
    label: "Diamond",
    points: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
    toughness: 2,
    since: "all",
  },
  {
    id: "netherite",
    label: "Netherite",
    points: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
    toughness: 3,
    since: "all",
  },
];

/**
 * Melee weapon presets: total attack damage including the player's base 1
 * (Player#createAttributes ATTACK_DAMAGE base 1 plus the item's
 * attack_damage modifier). Values identical across all six versions; the
 * mace (total 6) exists from 1.21 on.
 *
 * `family` drives enchant applicability: Sharpness fits swords and axes
 * (1.16.5 DamageEnchantment#canEnchant accepts AxeItem; 1.21.11
 * #minecraft:enchantable/sharp_weapon = melee_weapon + axes), Smite and
 * Bane of Arthropods fit swords, axes, and from 1.21 the mace too
 * (data/minecraft/tags/item/enchantable/weapon.json = sharp_weapon + mace,
 * read from the 1.21.11 server jar). Bows are excluded from all three and
 * from the crit toggle (arrow crits are random, AbstractArrow#setCritArrow).
 * The bow preset is the full-draw arrow: launch speed 3.0 x baseDamage 2.0,
 * ceil'd in AbstractArrow#onHitEntity = 6.
 */
export type WeaponFamily = "sword" | "axe" | "mace" | "bow" | "other";

export interface WeaponPreset {
  id: string;
  label: string;
  damage: number;
  family: WeaponFamily;
  maceOnly?: boolean;
}

export const WEAPON_PRESETS: WeaponPreset[] = [
  { id: "fist", label: "Fist", damage: 1, family: "other" },
  { id: "wooden-sword", label: "Wooden sword", damage: 4, family: "sword" },
  { id: "golden-sword", label: "Gold sword", damage: 4, family: "sword" },
  { id: "stone-sword", label: "Stone sword", damage: 5, family: "sword" },
  { id: "iron-sword", label: "Iron sword", damage: 6, family: "sword" },
  { id: "bow", label: "Bow (full draw arrow)", damage: 6, family: "bow" },
  { id: "mace", label: "Mace (no smash)", damage: 6, family: "mace", maceOnly: true },
  { id: "diamond-sword", label: "Diamond sword", damage: 7, family: "sword" },
  { id: "wooden-axe", label: "Wooden axe", damage: 7, family: "axe" },
  { id: "golden-axe", label: "Gold axe", damage: 7, family: "axe" },
  { id: "netherite-sword", label: "Netherite sword", damage: 8, family: "sword" },
  { id: "stone-axe", label: "Stone axe", damage: 9, family: "axe" },
  { id: "iron-axe", label: "Iron axe", damage: 9, family: "axe" },
  { id: "diamond-axe", label: "Diamond axe", damage: 9, family: "axe" },
  { id: "trident", label: "Trident", damage: 9, family: "other" },
  { id: "netherite-axe", label: "Netherite axe", damage: 10, family: "axe" },
];

/* ------------------------------------------------------------------ */
/* Mobs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Curated mob matchup data, read from the decompiled trees for all six
 * versions (values identical in every tree that has the mob; class paths
 * are 1.21.11 names, older trees differ only in package layout):
 *
 * - Attack damage: the ATTACK_DAMAGE attribute in each mob's
 *   createAttributes (Zombie 3, Blaze 6 melee, EnderMan 7, Ravager 12,
 *   Warden 30, Vindicator 5, PiglinBrute 7, Hoglin 6, WitherSkeleton 4 via
 *   setBaseValue in its constructor). Spider has no own value, so it uses
 *   the Attributes.ATTACK_DAMAGE default base of 2
 *   (Monster#createMonsterAttributes adds the attribute unset).
 * - Held weapons count: Mob#doHurtTarget reads the full ATTACK_DAMAGE
 *   attribute value, which includes the held item's attack_damage
 *   modifier. Wither skeleton carries a stone sword (+4), vindicator an
 *   iron axe (+8), piglin brute a golden axe (+6); those modifiers are the
 *   same item values as the player presets above minus the player's base 1.
 * - Iron golem: IronGolem#doHurtTarget rolls
 *   attack / 2 + nextInt((int)attack) with attack 15, so 7.5 to 21.5
 *   per swing, 14.5 on average.
 * - Skeleton: fires arrows at launch speed 1.6
 *   (AbstractSkeleton#performRangedAttack); arrow damage is
 *   ceil(speed x baseDamage) with baseDamage 2 x power plus a small
 *   difficulty-seeded random (AbstractArrow#setBaseDamageFromMob), which
 *   lands on 4 as the typical point-blank hit.
 * - Creeper: explosionRadius 3 (Creeper#explodeCreeper); explosion damage
 *   is (x * x + x) / 2 * 7 * diameter + 1 at impact fraction x
 *   (ExplosionDamageCalculator#getEntityDamageAmount; the identical
 *   expression is inline in 1.16.5 Explosion#explode), so a point-blank
 *   blast is (1 + 1) / 2 * 7 * 6 + 1 = 43 before difficulty scaling.
 * - HP: MAX_HEALTH attribute; the Attributes.MAX_HEALTH default base is 20
 *   (Zombie, Blaze, Skeleton, WitherSkeleton, Creeper), EnderMan 40,
 *   CaveSpider 12, Spider 16, Vindicator 24, PiglinBrute 50, Hoglin 40,
 *   Ravager 100, IronGolem 100, Warden 500.
 * - Armor: Zombie#createAttributes sets ARMOR 2; every other listed mob
 *   leaves the ARMOR attribute at its default 0.
 * - Classification: 1.16.5 Mob#getMobType overrides (UNDEAD / ARTHROPOD);
 *   1.21.11 entity type tags #minecraft:undead (skeletons + zombies +
 *   wither + phantom) and #minecraft:arthropod (spider, cave_spider,
 *   silverfish, endermite, bee), read from the server jar. Both agree for
 *   every listed mob.
 * - Availability: the Warden class does not exist in the 1.16.5 or 1.18.2
 *   trees (added in 1.19), so it is gated to 1.20.6 and later here.
 */
export type MobClassification = "undead" | "arthropod" | "none";

export type MobAttackKind = "melee" | "arrow" | "explosion";

export interface MobData {
  id: string;
  label: string;
  hp: number;
  armor: number;
  classification: MobClassification;
  attack: {
    kind: MobAttackKind;
    /** Typical damage before difficulty scaling (average for the golem). */
    amount: number;
    min?: number;
    max?: number;
  };
  /** First covered version the mob exists in; omitted = all six. */
  since?: VersionId;
}

export const MOBS: MobData[] = [
  { id: "zombie", label: "Zombie", hp: 20, armor: 2, classification: "undead", attack: { kind: "melee", amount: 3 } },
  { id: "skeleton", label: "Skeleton (arrow)", hp: 20, armor: 0, classification: "undead", attack: { kind: "arrow", amount: 4 } },
  { id: "wither-skeleton", label: "Wither skeleton", hp: 20, armor: 0, classification: "undead", attack: { kind: "melee", amount: 8 } },
  { id: "spider", label: "Spider", hp: 16, armor: 0, classification: "arthropod", attack: { kind: "melee", amount: 2 } },
  { id: "cave-spider", label: "Cave spider", hp: 12, armor: 0, classification: "arthropod", attack: { kind: "melee", amount: 2 } },
  { id: "creeper", label: "Creeper (point blank)", hp: 20, armor: 0, classification: "none", attack: { kind: "explosion", amount: 43 } },
  { id: "blaze", label: "Blaze (melee)", hp: 20, armor: 0, classification: "none", attack: { kind: "melee", amount: 6 } },
  { id: "enderman", label: "Enderman", hp: 40, armor: 0, classification: "none", attack: { kind: "melee", amount: 7 } },
  { id: "vindicator", label: "Vindicator (iron axe)", hp: 24, armor: 0, classification: "none", attack: { kind: "melee", amount: 13 } },
  { id: "piglin-brute", label: "Piglin brute (gold axe)", hp: 50, armor: 0, classification: "none", attack: { kind: "melee", amount: 13 } },
  { id: "hoglin", label: "Hoglin", hp: 40, armor: 0, classification: "none", attack: { kind: "melee", amount: 6 } },
  { id: "ravager", label: "Ravager", hp: 100, armor: 0, classification: "none", attack: { kind: "melee", amount: 12 } },
  { id: "iron-golem", label: "Iron golem", hp: 100, armor: 0, classification: "none", attack: { kind: "melee", amount: 14.5, min: 7.5, max: 21.5 } },
  { id: "warden", label: "Warden", hp: 500, armor: 0, classification: "none", attack: { kind: "melee", amount: 30 }, since: "1.20.6" },
];

/** True when the mob exists in the given version. */
export function mobInVersion(mob: MobData, version: VersionId): boolean {
  if (!mob.since) return true;
  return VERSIONS.indexOf(version) >= VERSIONS.indexOf(mob.since);
}

/* ------------------------------------------------------------------ */
/* Difficulty, effects, enchants                                      */
/* ------------------------------------------------------------------ */

/**
 * Difficulty scaling (Player#hurtServer, identical expression in 1.16.5
 * Player#hurt): applied only when the DEFENDER is a player. Peaceful zeroes
 * the damage, Easy is min(d / 2 + 1, d), Hard is d * 3 / 2.
 *
 * Which damage scales:
 * - Mob melee: every version. Legacy EntityDamageSource
 *   #scalesWithDifficulty returns true when the attacker is a living
 *   non-player; modern damage_type/mob_attack.json says
 *   "when_caused_by_living_non_player".
 * - Explosions: every version. Legacy DamageSource.explosion calls
 *   setScalesWithDifficulty(); modern damage_type/explosion.json says
 *   "always".
 * - Arrows: 1.20.6 and later ONLY. Legacy IndirectEntityDamageSource
 *   passes the arrow entity (not the shooter) to the EntityDamageSource
 *   constructor, and scalesWithDifficulty checks that entity, so skeleton
 *   arrows never scaled before the 1.19.4 damage type rework; modern
 *   damage_type/arrow.json says "when_caused_by_living_non_player" with the
 *   causing entity being the shooter.
 */
export const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * Attacker status effects (MobEffects, identical in all six trees: 1.16.5
 * and 1.18.2 AttackDamageMobEffect multiplies 3.0 / -4.0 by level; 1.20.6+
 * register the same values as ATTACK_DAMAGE attribute modifiers scaled per
 * amplifier): Strength adds 3 attack damage per level, Weakness subtracts
 * 4 per level, and the ATTACK_DAMAGE attribute floors at 0 (RangedAttribute
 * minimum). Survival sources: Strength I / II from potions, Strength I / II
 * from a max beacon; Weakness I from potions or a witch.
 */
export const STRENGTH_PER_LEVEL = 3;
export const WEAKNESS_PER_LEVEL = 4;

/**
 * Defender effect sources, from Foods.java (1.16.5) and the food component
 * in item_components.json (1.20.6+), identical across versions:
 * - Golden apple: Absorption I = 4 absorption points
 *   (AbsorptionMobEffect grants 4 x (amplifier + 1)).
 * - Enchanted golden apple: Absorption IV = 16 points plus Resistance I.
 * - Beacon: Resistance I / II. Turtle Master potions: Resistance III
 *   (regular) or IV (strong).
 * Absorption is consumed before health, after every reduction
 * (LivingEntity#actuallyHurt subtracts it from the post-armor post-effect
 * damage), and does not regenerate.
 */
export const ABSORPTION_SOURCES = [
  { id: "none", label: "None", points: 0, resistanceBonus: 0 },
  { id: "gapple", label: "Golden apple (Absorption I)", points: 4, resistanceBonus: 0 },
  {
    id: "egapple",
    label: "Enchanted golden apple (Absorption IV + Resistance I)",
    points: 16,
    resistanceBonus: 1,
  },
] as const;

export const RESISTANCE_SOURCES = [
  { id: "none", label: "None", level: 0 },
  { id: "beacon-1", label: "Beacon Resistance I", level: 1 },
  { id: "beacon-2", label: "Beacon Resistance II", level: 2 },
  { id: "turtle-3", label: "Turtle Master (Resistance III)", level: 3 },
  { id: "turtle-4", label: "Turtle Master II (Resistance IV)", level: 4 },
] as const;

/**
 * Weapon damage enchantments (identical in every version: 1.16.5
 * DamageEnchantment#getDamageBonus; 1.21.11 enchantment JSON minecraft:damage
 * linear effects): Sharpness adds 1 + 0.5 x (level - 1); Smite and Bane of
 * Arthropods add 2.5 x level, but only against undead / arthropod targets.
 * The three are mutually exclusive (#minecraft:exclusive_set/damage; legacy
 * checkCompatibility). Max level 5. The bonus is added after the crit
 * multiplier (Player#attack keeps the enchant term out of the 1.5x).
 */
export const WEAPON_ENCHANTS = [
  { id: "none", label: "No damage enchant" },
  { id: "sharpness", label: "Sharpness" },
  { id: "smite", label: "Smite" },
  { id: "bane", label: "Bane of Arthropods" },
] as const;

export type WeaponEnchantId = (typeof WEAPON_ENCHANTS)[number]["id"];

/** Named defender kit presets for the panel. */
export interface KitPreset {
  id: string;
  label: string;
  material: string;
  protection: number;
}

export const KIT_PRESETS: KitPreset[] = [
  { id: "full-iron", label: "Full iron", material: "iron", protection: 0 },
  { id: "full-diamond", label: "Full diamond", material: "diamond", protection: 0 },
  { id: "god-netherite", label: "Prot IV netherite", material: "netherite", protection: 4 },
];

/** Common health pools for hits-to-kill math (LivingEntity max health attributes). */
export const HP_POOLS: { label: string; hp: number }[] = [
  { label: "Player, zombie, skeleton (20 HP)", hp: 20 },
  { label: "Creeper (20 HP)", hp: 20 },
  { label: "Enderman (40 HP)", hp: 40 },
  { label: "Iron golem (100 HP)", hp: 100 },
  { label: "Ravager (100 HP)", hp: 100 },
  { label: "Wither (300 HP)", hp: 300 },
  { label: "Warden (500 HP)", hp: 500 },
];

/** Mace constants from MaceItem (1.21+). */
export const MACE = {
  /** Player base 1 + mace attack_damage modifier 5. */
  attackDamage: 6,
  /** Smash needs fallDistance > 1.5 (SMASH_ATTACK_FALL_THRESHOLD). */
  smashThreshold: 1.5,
  /** Density: smash_damage_per_fallen_block 0.5 per level. */
  densityPerLevel: 0.5,
  /** Breach: armor_effectiveness -0.15 per level. */
  breachPerLevel: 0.15,
} as const;

/** Enchantment protection factors (EPF) per level, by damage class. */
export const EPF = {
  protection: 1,
  fireProtection: 2,
  blastProtection: 2,
  projectileProtection: 2,
  featherFalling: 3,
  /** getDamageAfterMagicAbsorb clamps the EPF sum to 20 (80% cap). */
  cap: 20,
} as const;
