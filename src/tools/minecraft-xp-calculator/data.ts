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

export interface XpSource {
  /** Stable id used as the select option value. */
  id: string;
  label: string;
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
  /** Class and method the numbers were read from. */
  source: string;
  /** Extra search words for the select. */
  synonyms: string[];
}

const kill = "kill";
const kills = "kills";

export const XP_SOURCES: readonly XpSource[] = [
  // Hostile mobs (Monster base reward and overrides).
  { id: "zombie", label: "Zombie", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["zombie", "husk", "zombie villager"] },
  { id: "baby_zombie", label: "Baby zombie", unit: kill, unitPlural: kills, min: 12, max: 12, mean: 12, source: "Zombie#getBaseExperienceReward ((int)(5 * 2.5))", synonyms: ["baby", "zombie baby"] },
  { id: "skeleton", label: "Skeleton", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["skelly", "stray", "bogged"] },
  { id: "creeper", label: "Creeper", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["creeper farm"] },
  { id: "spider", label: "Spider", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["cave spider", "spider farm"] },
  { id: "enderman", label: "Enderman", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["ender man", "enderman farm", "end farm"] },
  { id: "witch", label: "Witch", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["witch farm"] },
  { id: "wither_skeleton", label: "Wither skeleton", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Monster constructor (xpReward = 5)", synonyms: ["wither skelly", "nether fortress"] },
  { id: "blaze", label: "Blaze", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Blaze constructor (xpReward = 10)", synonyms: ["blaze farm", "blaze rod"] },
  { id: "guardian", label: "Guardian", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Guardian constructor (xpReward = 10)", synonyms: ["guardian farm", "elder guardian", "ocean monument"] },
  { id: "evoker", label: "Evoker", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Evoker constructor (xpReward = 10)", synonyms: ["raid", "totem"] },
  { id: "breeze", label: "Breeze", unit: kill, unitPlural: kills, min: 10, max: 10, mean: 10, source: "Breeze constructor (xpReward = 10)", synonyms: ["trial chamber", "breeze rod"] },
  { id: "warden", label: "Warden", unit: kill, unitPlural: kills, min: 5, max: 5, mean: 5, source: "Warden constructor (xpReward = 5)", synonyms: ["deep dark", "sculk"] },
  { id: "ravager", label: "Ravager", unit: kill, unitPlural: kills, min: 20, max: 20, mean: 20, source: "Ravager constructor (xpReward = 20)", synonyms: ["raid", "beast"] },
  { id: "piglin_brute", label: "Piglin brute", unit: kill, unitPlural: kills, min: 20, max: 20, mean: 20, source: "PiglinBrute constructor (xpReward = 20)", synonyms: ["brute", "bastion"] },
  { id: "vex", label: "Vex", unit: kill, unitPlural: kills, min: 3, max: 3, mean: 3, source: "Vex constructor (xpReward = 3)", synonyms: ["evoker minion"] },
  { id: "slime_big", label: "Slime or magma cube, big", unit: kill, unitPlural: kills, min: 4, max: 4, mean: 4, source: "Slime#setSize (xpReward = size, big = 4)", synonyms: ["slime", "magma cube", "large slime"] },
  { id: "slime_small", label: "Slime or magma cube, small", unit: kill, unitPlural: kills, min: 2, max: 2, mean: 2, source: "Slime#setSize (xpReward = size, small = 2)", synonyms: ["medium slime"] },
  { id: "slime_tiny", label: "Slime or magma cube, tiny", unit: kill, unitPlural: kills, min: 1, max: 1, mean: 1, source: "Slime#setSize (xpReward = size, tiny = 1)", synonyms: ["tiny slime", "baby slime"] },
  // Bosses.
  { id: "wither", label: "Wither", unit: kill, unitPlural: kills, min: 50, max: 50, mean: 50, source: "WitherBoss constructor (xpReward = 50)", synonyms: ["wither boss"] },
  { id: "ender_dragon_first", label: "Ender dragon, first kill", unit: kill, unitPlural: kills, min: 12000, max: 12000, mean: 12000, source: "EnderDragon death tick (12000 when first kill)", synonyms: ["dragon", "end boss", "first dragon"] },
  { id: "ender_dragon_respawn", label: "Ender dragon, respawned", unit: kill, unitPlural: kills, min: 500, max: 500, mean: 500, source: "EnderDragon death tick (500 after first kill)", synonyms: ["respawned dragon", "dragon refight"] },
  // Animals.
  { id: "adult_animal", label: "Adult animal", unit: kill, unitPlural: kills, min: 1, max: 3, mean: 2, source: "Animal#getBaseExperienceReward (1 + nextInt(3))", synonyms: ["cow", "pig", "sheep", "chicken", "animal farm"] },
  { id: "breeding", label: "Breeding two animals", unit: "pair bred", unitPlural: "pairs bred", min: 1, max: 7, mean: 4, source: "Animal#spawnChildFromBreeding (nextInt(7) + 1)", synonyms: ["breed", "breeder", "love mode"] },
  // Bottles and blocks.
  { id: "xp_bottle", label: "Bottle o' Enchanting", unit: "bottle", unitPlural: "bottles", min: 3, max: 11, mean: 7, source: "ThrownExperienceBottle (3 + nextInt(5) + nextInt(5))", synonyms: ["xp bottle", "experience bottle", "bottle of enchanting"] },
  { id: "spawner_block", label: "Breaking a monster spawner", unit: "spawner broken", unitPlural: "spawners broken", min: 15, max: 43, mean: 29, source: "SpawnerBlock#spawnAfterBreak (15 + nextInt(15) + nextInt(15))", synonyms: ["spawner", "mob spawner", "cage"] },
  { id: "sculk", label: "Sculk block", unit: "block mined", unitPlural: "blocks mined", min: 1, max: 1, mean: 1, source: "SculkBlock constructor (ConstantInt.of(1))", synonyms: ["sculk mining", "deep dark"] },
  // Ores (silk touch drops nothing; ranges are per block mined).
  { id: "coal_ore", label: "Coal ore", unit: "block mined", unitPlural: "blocks mined", min: 0, max: 2, mean: 1, source: "Blocks.COAL_ORE (UniformInt.of(0, 2))", synonyms: ["coal", "coal mining"] },
  { id: "nether_gold_ore", label: "Nether gold ore", unit: "block mined", unitPlural: "blocks mined", min: 0, max: 1, mean: 0.5, source: "Blocks.NETHER_GOLD_ORE (UniformInt.of(0, 1))", synonyms: ["gold nugget ore", "nether gold"] },
  { id: "lapis_ore", label: "Lapis lazuli ore", unit: "block mined", unitPlural: "blocks mined", min: 2, max: 5, mean: 3.5, source: "Blocks.LAPIS_ORE (UniformInt.of(2, 5))", synonyms: ["lapis", "lapis mining"] },
  { id: "nether_quartz_ore", label: "Nether quartz ore", unit: "block mined", unitPlural: "blocks mined", min: 2, max: 5, mean: 3.5, source: "Blocks.NETHER_QUARTZ_ORE (UniformInt.of(2, 5))", synonyms: ["quartz", "quartz mining"] },
  { id: "redstone_ore", label: "Redstone ore", unit: "block mined", unitPlural: "blocks mined", min: 1, max: 5, mean: 3, source: "RedStoneOreBlock#spawnAfterBreak (1 + nextInt(5), UniformInt.of(1, 5) in 1.21+)", synonyms: ["redstone", "redstone mining"] },
  { id: "diamond_ore", label: "Diamond ore", unit: "block mined", unitPlural: "blocks mined", min: 3, max: 7, mean: 5, source: "Blocks.DIAMOND_ORE (UniformInt.of(3, 7))", synonyms: ["diamond", "diamond mining"] },
  { id: "emerald_ore", label: "Emerald ore", unit: "block mined", unitPlural: "blocks mined", min: 3, max: 7, mean: 5, source: "Blocks.EMERALD_ORE (UniformInt.of(3, 7))", synonyms: ["emerald", "emerald mining"] },
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
