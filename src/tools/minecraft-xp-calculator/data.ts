/**
 * XP constants reimplemented from decompiled Minecraft server source.
 *
 * Verified against six decompiled trees under mc-pipeline/work/<id>/src/
 * (1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, 26.2). Every constant in this
 * file is IDENTICAL across all six versions; the citations below name the
 * class the value was read from (1.21.11 paths, older trees match).
 *
 * Mob kill rewards: `this.xpReward` assignments.
 * - net.minecraft.world.entity.monster.Monster (constructor): xpReward = 5.
 *   Inherited by Zombie, Skeleton, Creeper, Spider, Enderman, Witch,
 *   Wither Skeleton, Drowned and every monster with no own assignment.
 * - net.minecraft.world.entity.monster.zombie.Zombie#getBaseExperienceReward
 *   (getExperienceReward(Player) in 1.16.5): if baby,
 *   xpReward = (int)(xpReward * 2.5) = 12.
 * - Blaze, Guardian (inherited by ElderGuardian), illager.Evoker,
 *   breeze.Breeze: xpReward = 10. Endermite, Vex: 3. Ravager,
 *   piglin.PiglinBrute: 20. warden.Warden: 5. Ghast, Shulker, Phantom,
 *   Zoglin, piglin.Piglin, hoglin.Hoglin (adult): 5.
 * - Slime#setSize (MagmaCube shares it; split into cubemob.Slime and
 *   cubemob.MagmaCube in 26.2): xpReward = size, so 1 / 2 / 4.
 * - boss.wither.WitherBoss (constructor): 50.
 * - boss.enderdragon.EnderDragon (death tick): 12000 first kill, 500 after.
 * - Equipment bonus (not modeled in counts, see meta copy):
 *   Mob#getBaseExperienceReward adds 1 + nextInt(3) per equipped item.
 *
 * Animals: net.minecraft.world.entity.animal.Animal#getBaseExperienceReward
 * returns 1 + nextInt(3) = 1 to 3. Animal#spawnChildFromBreeding spawns an
 * ExperienceOrb of nextInt(7) + 1 = 1 to 7. Babies drop nothing
 * (LivingEntity#shouldDropExperience returns !isBaby()).
 *
 * Bottle o' Enchanting: entity.projectile.ThrownExperienceBottle:
 * 3 + nextInt(5) + nextInt(5) = 3 to 11, mean 7.
 *
 * Block XP: net.minecraft.world.level.block.Blocks registrations
 * (DropExperienceBlock with UniformInt in 1.18.2+; OreBlock#xpOnDrop
 * hardcodes the same ranges in 1.16.5). RedStoneOreBlock#spawnAfterBreak:
 * 1 + nextInt(5). SpawnerBlock#spawnAfterBreak: 15 + nextInt(15) +
 * nextInt(15). SculkBlock constructor: ConstantInt.of(1).
 */

export type SourceKind = "mob" | "block" | "other";
export type MobTaxonomy = "undead" | "arthropod";

export interface XpSource {
  /** Stable id used as the select option value. */
  id: string;
  label: string;
  /** Mob kills, mined blocks, or neither (bottles, breeding). */
  kind: SourceKind;
  /** What one "unit" is, e.g. "kill", "bottle", "block mined". */
  unit: string;
  /** Plural of `unit`, e.g. "kills", "blocks mined". */
  unitPlural: string;
  /** Minimum XP dropped by one unit. */
  min: number;
  /** Maximum XP dropped by one unit. */
  max: number;
  /** Expected (mean) XP per unit. */
  mean: number;
  /**
   * Mob max health (Attributes.MAX_HEALTH; default 20.0 from the
   * RangedAttribute in net.minecraft.world.entity.ai.attributes.Attributes
   * when the mob class sets no override). Only present for kind "mob".
   */
  hp?: number;
  /**
   * Smite / Bane of Arthropods sensitivity. Pre-1.21: MobType.UNDEAD /
   * MobType.ARTHROPOD on the entity class. 1.21+: the sensitive_to_smite /
   * sensitive_to_bane_of_arthropods entity type tags. Verified matching.
   */
  taxonomy?: MobTaxonomy;
  /** Class and method the numbers were read from. */
  source: string;
  /** Extra search words for the select. */
  synonyms: string[];
}

const kill = "kill";
const kills = "kills";

export const XP_SOURCES: readonly XpSource[] = [
  // Hostile mobs (Monster base reward and overrides).
  { id: "zombie", kind: "mob", hp: 20, taxonomy: "undead", label: "Zombie", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["zombie", "husk", "zombie villager"] },
  { id: "baby_zombie", kind: "mob", hp: 20, taxonomy: "undead", label: "Baby zombie", unit: kill, unitPlural: kills, min: 12, max: 12, mean: 12, source: "Zombie#getBaseExperienceReward ((int)(5 * 2.5))", synonyms: ["baby", "zombie baby"] },
  { id: "skeleton", kind: "mob", hp: 20, taxonomy: "undead", label: "Skeleton", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["skelly", "stray", "bogged"] },
  { id: "creeper", kind: "mob", hp: 20, label: "Creeper", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["creeper farm"] },
  { id: "spider", kind: "mob", hp: 16, taxonomy: "arthropod", label: "Spider", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["cave spider", "spider farm"] },
  { id: "enderman", kind: "mob", hp: 40, label: "Enderman", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["ender man", "enderman farm", "end farm"] },
  { id: "witch", kind: "mob", hp: 26, label: "Witch", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["witch farm"] },
  { id: "wither_skeleton", kind: "mob", hp: 20, taxonomy: "undead", label: "Wither skeleton", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["wither skelly", "nether fortress"] },
  { id: "ghast", kind: "mob", hp: 10, label: "Ghast", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Ghast constructor (xpReward = 5); MAX_HEALTH 10.0", synonyms: ["ghast tear", "nether flying"] },
  { id: "zombified_piglin", kind: "mob", hp: 20, taxonomy: "undead", label: "Zombified piglin", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor via Zombie (xpReward = 5); MAX_HEALTH default 20.0", synonyms: ["zombie pigman", "pigman", "gold farm"] },
  { id: "piglin", kind: "mob", hp: 16, label: "Piglin", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Piglin constructor (xpReward = 5); MAX_HEALTH 16.0", synonyms: ["bartering", "nether mob"] },
  { id: "blaze", kind: "mob", hp: 20, label: "Blaze", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Blaze constructor (xpReward = 10)", synonyms: ["blaze farm", "blaze rod"] },
  { id: "guardian", kind: "mob", hp: 30, label: "Guardian", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Guardian constructor (xpReward = 10)", synonyms: ["guardian farm", "elder guardian", "ocean monument"] },
  { id: "evoker", kind: "mob", hp: 24, label: "Evoker", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Evoker constructor (xpReward = 10)", synonyms: ["raid", "totem"] },
  { id: "breeze", kind: "mob", hp: 30, label: "Breeze", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Breeze constructor (xpReward = 10)", synonyms: ["trial chamber", "breeze rod"] },
  { id: "warden", kind: "mob", hp: 500, label: "Warden", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Warden constructor (xpReward = 5)", synonyms: ["deep dark", "sculk"] },
  { id: "ravager", kind: "mob", hp: 100, label: "Ravager", unit: kill, unitPlural: kills, min: 20, max: 20, mean: 20, source: "Ravager constructor (xpReward = 20)", synonyms: ["raid", "beast"] },
  { id: "piglin_brute", kind: "mob", hp: 50, label: "Piglin brute", unit: kill, unitPlural: kills, min: 20, max: 20, mean: 20, source: "PiglinBrute constructor (xpReward = 20)", synonyms: ["brute", "bastion"] },
  { id: "vex", kind: "mob", hp: 14, label: "Vex", unit: kill, unitPlural: kills, min: 3, max: 3, mean: 3, source: "Vex constructor (xpReward = 3)", synonyms: ["evoker minion"] },
  { id: "slime_big", kind: "mob", hp: 16, label: "Slime or magma cube, big", unit: kill, unitPlural: kills, min: 4, max: 4, mean: 4, source: "Slime#setSize (xpReward = size, big = 4)", synonyms: ["slime", "magma cube", "large slime"] },
  { id: "slime_small", kind: "mob", hp: 4, label: "Slime or magma cube, small", unit: kill, unitPlural: kills, min: 2, max: 2, mean: 2, source: "Slime#setSize (xpReward = size, small = 2)", synonyms: ["medium slime"] },
  { id: "slime_tiny", kind: "mob", hp: 1, label: "Slime or magma cube, tiny", unit: kill, unitPlural: kills, min: 1, max: 1, mean: 1, source: "Slime#setSize (xpReward = size, tiny = 1)", synonyms: ["tiny slime", "baby slime"] },
  // Bosses.
  { id: "wither", kind: "mob", hp: 300, taxonomy: "undead", label: "Wither", unit: kill, unitPlural: kills, min: 50, max: 50, mean: 50, source: "WitherBoss constructor (xpReward = 50)", synonyms: ["wither boss"] },
  { id: "ender_dragon_first", kind: "mob", hp: 200, label: "Ender dragon, first kill", unit: kill, unitPlural: kills, min: 12000, max: 12000, mean: 12000, source: "EnderDragon death tick (12000 when first kill)", synonyms: ["dragon", "end boss", "first dragon"] },
  { id: "ender_dragon_respawn", kind: "mob", hp: 200, label: "Ender dragon, respawned", unit: kill, unitPlural: kills, min: 500, max: 500, mean: 500, source: "EnderDragon death tick (500 after first kill)", synonyms: ["respawned dragon", "dragon refight"] },
  // Animals.
  { id: "adult_animal", kind: "mob", hp: 10, label: "Adult animal", unit: kill, unitPlural: kills, min: 1, max: 3, mean: 2, source: "Animal#getBaseExperienceReward (1 + nextInt(3))", synonyms: ["cow", "pig", "sheep", "chicken", "animal farm"] },
  { id: "breeding", kind: "other", label: "Breeding two animals", unit: "pair bred", unitPlural: "pairs bred", min: 1, max: 7, mean: 4, source: "Animal#spawnChildFromBreeding (nextInt(7) + 1)", synonyms: ["breed", "breeder", "love mode"] },
  // Bottles and blocks.
  { id: "xp_bottle", kind: "other", label: "Bottle o' Enchanting", unit: "bottle", unitPlural: "bottles", min: 3, max: 11, mean: 7, source: "ThrownExperienceBottle (3 + nextInt(5) + nextInt(5))", synonyms: ["xp bottle", "experience bottle", "bottle of enchanting"] },
  { id: "spawner_block", kind: "block", label: "Breaking a monster spawner", unit: "spawner broken", unitPlural: "spawners broken", min: 15, max: 43, mean: 29, source: "SpawnerBlock#spawnAfterBreak (15 + nextInt(15) + nextInt(15))", synonyms: ["spawner", "mob spawner", "cage"] },
  { id: "sculk", kind: "block", label: "Sculk block", unit: "block mined", unitPlural: "blocks mined", min: 1, max: 1, mean: 1, source: "SculkBlock constructor (ConstantInt.of(1))", synonyms: ["sculk mining", "deep dark"] },
  // Ores (silk touch drops nothing; ranges are per block mined).
  { id: "coal_ore", kind: "block", label: "Coal ore", unit: "block mined", unitPlural: "blocks mined", min: 0, max: 2, mean: 1, source: "Blocks.COAL_ORE (UniformInt.of(0, 2))", synonyms: ["coal", "coal mining"] },
  { id: "nether_gold_ore", kind: "block", label: "Nether gold ore", unit: "block mined", unitPlural: "blocks mined", min: 0, max: 1, mean: 0.5, source: "Blocks.NETHER_GOLD_ORE (UniformInt.of(0, 1))", synonyms: ["gold nugget ore", "nether gold"] },
  { id: "lapis_ore", kind: "block", label: "Lapis lazuli ore", unit: "block mined", unitPlural: "blocks mined", min: 2, max: 5, mean: 3.5, source: "Blocks.LAPIS_ORE (UniformInt.of(2, 5))", synonyms: ["lapis", "lapis mining"] },
  { id: "nether_quartz_ore", kind: "block", label: "Nether quartz ore", unit: "block mined", unitPlural: "blocks mined", min: 2, max: 5, mean: 3.5, source: "Blocks.NETHER_QUARTZ_ORE (UniformInt.of(2, 5))", synonyms: ["quartz", "quartz mining"] },
  { id: "redstone_ore", kind: "block", label: "Redstone ore", unit: "block mined", unitPlural: "blocks mined", min: 1, max: 5, mean: 3, source: "RedStoneOreBlock#spawnAfterBreak (1 + nextInt(5), UniformInt.of(1, 5) in 1.21+)", synonyms: ["redstone", "redstone mining"] },
  { id: "diamond_ore", kind: "block", label: "Diamond ore", unit: "block mined", unitPlural: "blocks mined", min: 3, max: 7, mean: 5, source: "Blocks.DIAMOND_ORE (UniformInt.of(3, 7))", synonyms: ["diamond", "diamond mining"] },
  { id: "emerald_ore", kind: "block", label: "Emerald ore", unit: "block mined", unitPlural: "blocks mined", min: 3, max: 7, mean: 5, source: "Blocks.EMERALD_ORE (UniformInt.of(3, 7))", synonyms: ["emerald", "emerald mining"] },
] as const;

export const XP_SOURCE_BY_ID: ReadonlyMap<string, XpSource> = new Map(
  XP_SOURCES.map((s) => [s.id, s]),
);

/**
 * Mending repair ratio: 2 durability restored per 1 XP point.
 *
 * 1.16.5 through 1.20.6: ExperienceOrb#xpToDurability returns xp * 2 and
 * ExperienceOrb#durabilityToXp returns durability / 2 (repairPlayerItems).
 * 1.21.1+: data-driven, minecraft:repair_with_xp effect with a multiply
 * factor of 2.0 in the mending enchantment definition (verified in
 * mc-pipeline/extracted/<v>/enchantment/mending.json for 1.21.1, 1.21.11,
 * 26.2), applied by EnchantmentHelper#modifyDurabilityToRepairFromXp.
 */
export const MENDING_DURABILITY_PER_XP = 2;

/** The six versions the decompiled trees cover, oldest first. */
export const VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"] as const;
export type VersionId = (typeof VERSIONS)[number];

/**
 * Tool materials. Durability and attack damage bonus from Tiers (1.16.5
 * through 1.21.1) and ToolMaterial (1.21.2+ record constants), verified
 * identical across all six trees for every material that exists in them:
 * WOOD 59/0, STONE 131/1, IRON 250/2, DIAMOND 1561/3, GOLD 32/0,
 * NETHERITE 2031/4. COPPER 190/1 exists only in the 1.21.11 and 26.2
 * trees (added with the copper tools drop, 1.21.9).
 * `axeBase` is the per-material AxeItem attack damage constructor argument
 * from Items.java (verified identical 1.16.5 vs 1.21.11 vs 26.2).
 */
export interface McMaterial {
  id: string;
  label: string;
  durability: number;
  /** Tier attack damage bonus added to every weapon of this material. */
  attackBonus: number;
  /** AxeItem base attack argument for this material. */
  axeBase: number;
  /** Only present when the material does not exist in all six versions. */
  availableIn?: readonly VersionId[];
}

export const MATERIALS: readonly McMaterial[] = [
  { id: "wood", label: "Wood", durability: 59, attackBonus: 0, axeBase: 6 },
  { id: "stone", label: "Stone", durability: 131, attackBonus: 1, axeBase: 7 },
  { id: "copper", label: "Copper", durability: 190, attackBonus: 1, axeBase: 7, availableIn: ["1.21.11", "26.2"] },
  { id: "iron", label: "Iron", durability: 250, attackBonus: 2, axeBase: 6 },
  { id: "gold", label: "Gold", durability: 32, attackBonus: 0, axeBase: 6 },
  { id: "diamond", label: "Diamond", durability: 1561, attackBonus: 3, axeBase: 5 },
  { id: "netherite", label: "Netherite", durability: 2031, attackBonus: 4, axeBase: 5 },
] as const;

export const MATERIAL_BY_ID: ReadonlyMap<string, McMaterial> = new Map(
  MATERIALS.map((m) => [m.id, m]),
);

/**
 * Tool families and durability cost per action.
 * - Sword: 1 durability per hit on a mob. SwordItem#hurtEnemy
 *   hurtAndBreak(1) in 1.16.5 through 1.21.1; DataComponents.WEAPON
 *   new Weapon(1) in ToolMaterial#applySwordProperties for 1.21.2+.
 * - Axe and pickaxe: 2 per hit on a mob, 1 per block mined.
 *   DiggerItem#hurtEnemy hurtAndBreak(2) / #mineBlock hurtAndBreak(1)
 *   in 1.16.5 through 1.21.1; new Weapon(2) plus Tool(..., 1, ...) in
 *   ToolMaterial#applyToolProperties for 1.21.2+.
 * Sword attack damage: 1 (player base, Player#createAttributes
 * ATTACK_DAMAGE 1.0) + 3 (SwordItem / Item.Properties#sword base arg)
 * + material bonus. Axe: 1 + axeBase + material bonus.
 */
export interface McToolFamily {
  id: "sword" | "axe" | "pickaxe";
  label: string;
  /** Which source kind this family acts on. */
  acts: "mob" | "block";
  /** Durability lost per action before Unbreaking (hit for weapons, block for mining). */
  durabilityPerAction: number;
  /** Weapon base attack before material bonus, including the player's 1.0. */
  attackBase?: number;
}

export const TOOL_FAMILIES: readonly McToolFamily[] = [
  { id: "sword", label: "Sword", acts: "mob", durabilityPerAction: 1, attackBase: 4 },
  { id: "axe", label: "Axe", acts: "mob", durabilityPerAction: 2 },
  { id: "pickaxe", label: "Pickaxe", acts: "block", durabilityPerAction: 1 },
] as const;

export const TOOL_FAMILY_BY_ID: ReadonlyMap<string, McToolFamily> = new Map(
  TOOL_FAMILIES.map((f) => [f.id, f]),
);

/** Attack damage of a weapon, including the player's base 1.0. */
export function attackDamage(family: McToolFamily, material: McMaterial): number {
  if (family.id === "axe") return 1 + material.axeBase + material.attackBonus;
  return (family.attackBase ?? 1) + material.attackBonus;
}

/**
 * Enchantment constants, identical across all six versions:
 * - Sharpness: +1.0 + 0.5 per level above the first
 *   (DamageEnchantment#getDamageBonus type 0 in 1.16.5/1.18.2/1.20.6;
 *   sharpness.json minecraft:damage add linear base 1.0
 *   per_level_above_first 0.5 in 1.21.1+). Max level 5.
 * - Smite / Bane of Arthropods: +2.5 per level, only against UNDEAD /
 *   ARTHROPOD mobs (DamageEnchantment types 1 and 2; smite.json and
 *   bane_of_arthropods.json linear base 2.5 per_level 2.5, gated on the
 *   sensitive_to_smite / sensitive_to_bane_of_arthropods tags). Max 5.
 *   The three form a mutually exclusive group
 *   (DamageEnchantment#checkCompatibility; #exclusive_set/damage). Axes
 *   can hold them too (DamageEnchantment#canEnchant accepts AxeItem;
 *   #enchantable/sharp_weapon and /weapon tags include axes in 1.21+).
 * - Unbreaking on tools and weapons (non-armor): the item takes each point
 *   of durability damage with probability 1 / (level + 1)
 *   (DigDurabilityEnchantment#shouldIgnoreDurabilityDrop nextInt(level+1)>0
 *   pre-1.21; unbreaking.json minecraft:item_damage remove_binomial
 *   chance level/(level+1) for non-armor in 1.21.1+). Max level 3.
 *   Armor uses a different curve; no armor is modeled here.
 * - Fire Aspect: sword only (#enchantable/fire_aspect), ignites for
 *   4 seconds per level (fire_aspect.json ignite linear base 4.0). Burn
 *   damage depends on how long the mob lives, so the calculator models it
 *   as a configurable flat HP of free damage per kill. Max level 2.
 */
export function sharpnessBonus(level: number): number {
  return level <= 0 ? 0 : 1 + 0.5 * (level - 1);
}

export function smiteBaneBonus(level: number): number {
  return level <= 0 ? 0 : 2.5 * level;
}

export const MAX_SHARPNESS = 5;
export const MAX_SMITE = 5;
export const MAX_BANE = 5;
export const MAX_UNBREAKING = 3;
export const MAX_FIRE_ASPECT = 2;

/**
 * Mixture presets. Weights are relative and normalized by the logic layer.
 *
 * Mob presets come straight from the game's biome definitions
 * (data/minecraft/worldgen/biome/<biome>.json spawners.monster weights,
 * cached per version under mc-pipeline/extracted/<v>/worldgen/biome/ by
 * mc-pipeline/06-extract-xp-mixtures.mjs).
 *
 * Mining presets are documented approximations derived from the worldgen
 * placed/configured ore features by the same script: relative score =
 * count per chunk x exact height-provider pmf at the target y x vein size,
 * ignoring air-exposure discards and vein intersection. mcmeta exposes no
 * worldgen JSON for 1.16.5, so the mining presets are unavailable there.
 */
export interface MixturePreset {
  id: string;
  label: string;
  /** Which source kind the preset selects. */
  kind: "mob" | "block";
  /** Marks weights that are derived approximations rather than raw game data. */
  approximate?: boolean;
  /** Version id -> weights; "default" is the fallback for unlisted versions. */
  weights: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Versions of the six where the preset has no data. */
  unavailableIn?: readonly VersionId[];
  provenance: string;
}

export const MIXTURE_PRESETS: readonly MixturePreset[] = [
  {
    id: "overworld_mobs",
    label: "Overworld mobs",
    kind: "mob",
    weights: {
      default: { spider: 100, zombie: 95, skeleton: 100, creeper: 100, enderman: 10, witch: 5 },
      "1.21.11": { spider: 100, zombie: 90, skeleton: 100, creeper: 100, enderman: 10, witch: 5 },
      "26.2": { spider: 100, zombie: 90, skeleton: 100, creeper: 100, enderman: 10, witch: 5 },
    },
    provenance:
      "plains.json spawners.monster (06-extract-xp-mixtures.mjs). Excluded: zombie_villager (weight 5), zombie_horse (5, 1.21.11+), and slime (100, spawn attempts are position-gated to slime chunks). 1.21.11+ lowered zombie from 95 to 90.",
  },
  {
    id: "nether_mobs",
    label: "Nether wastes mobs",
    kind: "mob",
    weights: {
      default: {
        zombified_piglin: 100,
        ghast: 50,
        piglin: 15,
        enderman: 1,
        slime_big: 0.667,
        slime_small: 0.667,
        slime_tiny: 0.667,
      },
    },
    provenance:
      "nether_wastes.json spawners.monster, identical in all six versions (06-extract-xp-mixtures.mjs). magma_cube (weight 2) is split equally across the three size entries; sizes spawn randomly.",
  },
  {
    id: "mining_y0",
    label: "Mining at y=0",
    kind: "block",
    approximate: true,
    unavailableIn: ["1.16.5"],
    weights: {
      default: { lapis_ore: 0.6413, redstone_ore: 0.4, diamond_ore: 0.1589, coal_ore: 0.0361 },
    },
    provenance:
      "Relative encounter score at y=0 from overworld ore placed features referenced by plains.json, identical 1.18.2 through 26.2 (06-extract-xp-mixtures.mjs, xp-mixtures.json overworld_y0). Approximate: ignores air exposure discards and vein overlap. Emerald is mountain-biome only and absent. No worldgen JSON exists for 1.16.5.",
  },
  {
    id: "nether_mining",
    label: "Nether wastes mining",
    kind: "block",
    approximate: true,
    unavailableIn: ["1.16.5"],
    weights: {
      default: { nether_quartz_ore: 2.0741, nether_gold_ore: 0.9259 },
    },
    provenance:
      "Relative encounter score at y=14 from nether_wastes.json ore features, identical 1.18.2 through 26.2 (06-extract-xp-mixtures.mjs, xp-mixtures.json nether_y14). Approximate: same caveats as the overworld preset. No worldgen JSON exists for 1.16.5.",
  },
] as const;

export const MIXTURE_PRESET_BY_ID: ReadonlyMap<string, MixturePreset> = new Map(
  MIXTURE_PRESETS.map((p) => [p.id, p]),
);

/** Resolve a preset's weights for a version id (falls back to "default"). */
export function presetWeights(
  preset: MixturePreset,
  version: string,
): Readonly<Record<string, number>> | null {
  if (preset.unavailableIn?.includes(version as VersionId)) return null;
  return preset.weights[version] ?? preset.weights.default ?? null;
}
