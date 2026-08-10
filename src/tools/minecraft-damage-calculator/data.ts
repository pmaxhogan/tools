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
 */
export interface WeaponPreset {
  id: string;
  label: string;
  damage: number;
  maceOnly?: boolean;
}

export const WEAPON_PRESETS: WeaponPreset[] = [
  { id: "fist", label: "Fist", damage: 1 },
  { id: "wooden-sword", label: "Wooden sword", damage: 4 },
  { id: "golden-sword", label: "Gold sword", damage: 4 },
  { id: "stone-sword", label: "Stone sword", damage: 5 },
  { id: "iron-sword", label: "Iron sword", damage: 6 },
  { id: "mace", label: "Mace (no smash)", damage: 6, maceOnly: true },
  { id: "diamond-sword", label: "Diamond sword", damage: 7 },
  { id: "wooden-axe", label: "Wooden axe", damage: 7 },
  { id: "golden-axe", label: "Gold axe", damage: 7 },
  { id: "netherite-sword", label: "Netherite sword", damage: 8 },
  { id: "stone-axe", label: "Stone axe", damage: 9 },
  { id: "iron-axe", label: "Iron axe", damage: 9 },
  { id: "diamond-axe", label: "Diamond axe", damage: 9 },
  { id: "trident", label: "Trident", damage: 9 },
  { id: "netherite-axe", label: "Netherite axe", damage: 10 },
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
