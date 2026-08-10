/**
 * Minecraft mob spawning simulator: pure logic.
 *
 * Everything here is reimplemented from reading the decompiled server source
 * for the six shipped versions (never transcribed), plus the real per-biome
 * spawner lists extracted into ./data.ts. The classes the constants came from
 * are named in comments and recorded again in
 * mc-pipeline/vectors/spawning/source-derived.json, which the vector suite
 * asserts against these exports.
 *
 * Honesty note that belongs in the code as much as in the page copy: natural
 * spawning cannot be measured on a headless server. The spawn loop only runs
 * for chunks charged by a player, so an empty server ticks all night and
 * produces nothing. None of these numbers were measured in game.
 */
import { ToolError, type ToolLogic } from "../types";
import { BIOMES_BY_ID, SPAWN_VERSIONS, type SpawnDimension } from "./biomes";
import {
  CATEGORY_IDS,
  CREATURE_PROBABILITY,
  ENTRY_POOL,
  MOB_IDS,
  MOB_RULES,
  SPAWNERS,
  SPAWN_COSTS,
  type RuleClass,
} from "./data";

export { SPAWN_VERSIONS, BIOMES, BIOMES_BY_ID, BIOME_GROUPS } from "./biomes";
export type { BiomeInfo, SpawnDimension } from "./biomes";
export type { RuleClass } from "./data";

// ---------------------------------------------------------------- constants --

/**
 * NaturalSpawner#isRightDistanceToPlayerAndSpawnPoint rejects any attempt
 * whose squared distance to the nearest player is 576 or less. Also the
 * exclusion radius around the world spawn point in the same method.
 */
export const MIN_SPAWN_DISTANCE = 24;

/**
 * DistanceManager's naturalSpawnChunkCounter is a
 * FixedPlayerDistanceChunkTracker(8), and ChunkTracker propagates over all
 * eight neighbours, so one player charges a 17 by 17 square of chunks.
 */
export const SPAWN_CHUNK_RADIUS = 8;

/** NaturalSpawner.MAGIC_NUMBER, 17 squared: the mob cap divisor. */
export const MOB_CAP_DIVISOR = 289;

/**
 * ChunkMap#playerIsCloseEnoughForSpawning: a chunk only runs the spawn loop
 * when a player is within 128 blocks of its centre. The comparison is
 * horizontal only, so height above or below the player does not count.
 */
export const SPAWNING_CHUNK_PLAYER_RADIUS = 128;

/** NaturalSpawner#spawnCategoryForPosition runs three pack rounds per tick. */
export const ROUNDS_PER_CHUNK_TICK = 3;

/** Mob#getMaxSpawnClusterSize: one chunk tick stops at four mobs per category. */
export const MAX_SPAWN_CLUSTER_SIZE = 4;

/** MobCategory#getNoDespawnDistance: inside this the idle timer resets. */
export const NO_DESPAWN_DISTANCE = 32;

/** Mob#checkDespawn: random despawn needs this much idle time first. */
export const RANDOM_DESPAWN_IDLE_TICKS = 600;

/** Mob#checkDespawn: `random.nextInt(800) == 0`, evaluated once per tick. */
export const RANDOM_DESPAWN_DENOMINATOR = 800;

/** Server ticks per second. */
export const TICKS_PER_SECOND = 20;

/** The pack walk offset range: `random.nextInt(6) - random.nextInt(6)`. */
export const PACK_SPREAD = 6;

/** `Mth.ceil(random.nextFloat() * 4.0F)` positions tried before a type is picked. */
export const PACK_ATTEMPTS_BEFORE_TYPE = 4;

/**
 * Monster#isDarkEnoughToSpawn compares sky light against `random.nextInt(32)`,
 * so the sky gate passes with probability (32 - skyLight) / 32.
 */
export const SKY_LIGHT_TEST_RANGE = 32;

export interface CategoryInfo {
  id: string;
  name: string;
  /** MobCategory max instances per chunk: the cap numerator. */
  maxPerChunk: number;
  /** MobCategory despawn distance: beyond this a mob is removed instantly. */
  despawnDistance: number;
  noDespawnDistance: number;
  friendly: boolean;
  persistent: boolean;
  /** Versions whose MobCategory enum contains this constant. */
  versions: string[];
}

const ALL_VERSIONS = SPAWN_VERSIONS;
const SINCE_1_18 = SPAWN_VERSIONS.filter((v) => v !== "1.16.5");

/**
 * MobCategory per version. 1.16.5 has six spawning categories; AXOLOTLS and
 * UNDERGROUND_WATER_CREATURE join the enum by 1.18.2. MISC is filtered out of
 * NaturalSpawner.SPAWNING_CATEGORIES and never spawns naturally, so it is not
 * listed here at all.
 */
const CATEGORIES: CategoryInfo[] = [
  {
    id: "monster",
    name: "Monster",
    maxPerChunk: 70,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: false,
    persistent: false,
    versions: ALL_VERSIONS,
  },
  {
    id: "creature",
    name: "Creature",
    maxPerChunk: 10,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: true,
    persistent: true,
    versions: ALL_VERSIONS,
  },
  {
    id: "ambient",
    name: "Ambient",
    maxPerChunk: 15,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: true,
    persistent: false,
    versions: ALL_VERSIONS,
  },
  {
    id: "axolotls",
    name: "Axolotls",
    maxPerChunk: 5,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: true,
    persistent: false,
    versions: SINCE_1_18,
  },
  {
    id: "underground_water_creature",
    name: "Underground water creature",
    maxPerChunk: 5,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: true,
    persistent: false,
    versions: SINCE_1_18,
  },
  {
    id: "water_creature",
    name: "Water creature",
    maxPerChunk: 5,
    despawnDistance: 128,
    noDespawnDistance: 32,
    friendly: true,
    persistent: false,
    versions: ALL_VERSIONS,
  },
  {
    id: "water_ambient",
    name: "Water ambient",
    maxPerChunk: 20,
    despawnDistance: 64,
    noDespawnDistance: 32,
    friendly: true,
    persistent: false,
    versions: ALL_VERSIONS,
  },
];

/** Dimension build height, from the registered DimensionType per version. */
interface DimensionShape {
  minY: number;
  height: number;
}

/**
 * 1.16.5 predates the deepslate world height change: the overworld still runs
 * 0 to 255. From 1.18.2 the registered overworld dimension type is
 * minY -64, height 384. The nether and end are 0 to 255 in every version.
 */
function dimensionShape(version: string, dim: SpawnDimension): DimensionShape {
  if (dim === "overworld") {
    return version === "1.16.5" ? { minY: 0, height: 256 } : { minY: -64, height: 384 };
  }
  return { minY: 0, height: 256 };
}

/** The light test the game samples: an IntProvider in DimensionType.MonsterSettings. */
export interface LightTest {
  kind: "uniform" | "constant";
  min: number;
  max: number;
}

export interface LightRule {
  /**
   * DimensionType#monsterSpawnBlockLightLimit. A block light above this
   * refuses the spawn; a limit of 15 disables the check entirely, which is how
   * 1.16.5 (no check at all) and the modern nether behave.
   */
  blockLightLimit: number;
  /** DimensionType#monsterSpawnLightTest, sampled per attempt. */
  test: LightTest;
  /** Human summary of what the rule means for spawn proofing. */
  summary: string;
}

/**
 * Monster#isDarkEnoughToSpawn per version and dimension.
 *
 * - 1.16.5: no block light gate at all, brightness must be at most a
 *   nextInt(8) sample. Light levels 1 to 7 still spawn, just less often.
 * - 1.18.2: a hard `blockLight > 0` rejection is added, in every dimension.
 * - 1.20.6 onward: the same rule, now read from DimensionType.MonsterSettings,
 *   which lets the nether opt out of the block light gate and fix its sample
 *   at 7. The end's sampled value became a constant 15 by 1.21.11.
 */
export function lightRuleFor(version: string, dim: SpawnDimension): LightRule {
  requireVersion(version);
  if (version === "1.16.5") {
    return {
      blockLightLimit: 15,
      test: { kind: "uniform", min: 0, max: 7 },
      summary: "Any block at light level 8 or above is fully safe; levels 1 to 7 still spawn.",
    };
  }
  if (version === "1.18.2") {
    return {
      blockLightLimit: 0,
      test: { kind: "uniform", min: 0, max: 7 },
      summary: "Any block light above 0 refuses the spawn outright.",
    };
  }
  if (dim === "nether") {
    return {
      blockLightLimit: 15,
      test: { kind: "constant", min: 7, max: 7 },
      summary: "The nether skips the block light gate: brightness 7 or less is what matters.",
    };
  }
  if (dim === "end") {
    const constant = version === "1.21.11" || version === "26.2";
    return {
      blockLightLimit: 0,
      test: constant ? { kind: "constant", min: 15, max: 15 } : { kind: "uniform", min: 0, max: 7 },
      summary: "Any block light above 0 refuses the spawn outright.",
    };
  }
  return {
    blockLightLimit: 0,
    test: { kind: "uniform", min: 0, max: 7 },
    summary: "Any block light above 0 refuses the spawn outright.",
  };
}

/** Whether the version has the per player cap (LocalMobCapCalculator, 1.18+). */
export function hasPerPlayerCap(version: string): boolean {
  requireVersion(version);
  return version !== "1.16.5";
}

// ----------------------------------------------------------------- helpers --

function requireVersion(version: string): void {
  if (!SPAWN_VERSIONS.includes(version)) {
    throw new ToolError(
      "unknown-version",
      `Minecraft ${version} is not one of the versions this tool has data for.`,
      `Pick one of ${SPAWN_VERSIONS.join(", ")}.`,
    );
  }
}

function requireBiome(version: string, biome: string): void {
  const info = BIOMES_BY_ID[biome];
  if (!info) {
    throw new ToolError(
      "unknown-biome",
      `"${biome}" is not a Minecraft biome id.`,
      "Pick a biome from the list, for example plains or soul_sand_valley.",
    );
  }
  if (!info.versions.includes(version)) {
    throw new ToolError(
      "biome-not-in-version",
      `The ${info.name} biome does not exist in Minecraft ${version}.`,
      `Pick a different version or a biome that ships in ${version}.`,
    );
  }
}

function requireCategory(version: string, category: string): CategoryInfo {
  const info = CATEGORIES.find((c) => c.id === category);
  if (!info) {
    throw new ToolError(
      "unknown-category",
      `"${category}" is not a Minecraft mob category.`,
      `Use one of ${CATEGORIES.map((c) => c.id).join(", ")}.`,
    );
  }
  if (!info.versions.includes(version)) {
    throw new ToolError(
      "category-not-in-version",
      `The ${info.id} category does not exist in Minecraft ${version}.`,
      "It was added later; pick a newer version or another category.",
    );
  }
  return info;
}

/** Mob categories that exist in this version, in enum order. */
export function categoriesFor(version: string): CategoryInfo[] {
  requireVersion(version);
  return CATEGORIES.filter((c) => c.versions.includes(version));
}

/** Categories that actually have spawner entries in this biome and version. */
export function categoriesWithSpawns(version: string, biome: string): string[] {
  requireVersion(version);
  requireBiome(version, biome);
  const table = SPAWNERS[version]?.[biome] ?? {};
  return CATEGORY_IDS.filter(
    (c) =>
      table[c] !== undefined && CATEGORIES.some((x) => x.id === c && x.versions.includes(version)),
  );
}

export function mobDisplayName(id: string): string {
  return id
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ----------------------------------------------------------- the light rule --

/** Preset world lighting states; the skyDarken each one produces. */
export type WorldLight = "day" | "night" | "thunder";

/**
 * Level#updateSkyBrightness computes
 * skyDarken = (int)((1 - f * rain * thunder) * 11) with
 * f = 0.5 + 2 * clamp(cos(2 pi * timeOfDay), -0.25, 0.25), so noon gives 0 and
 * midnight gives 11. Monster#isDarkEnoughToSpawn substitutes a fixed 10 while
 * the level is thundering, which is why a thunderstorm darkens the day but is
 * marginally brighter than clear midnight.
 */
export function skyDarkenFor(world: WorldLight): number {
  if (world === "day") return 0;
  if (world === "thunder") return 10;
  return 11;
}

export interface LightVerdict {
  /** Probability that one attempt passes Monster#isDarkEnoughToSpawn. */
  chance: number;
  /** Probability the sky light check passes: P(skyLight <= nextInt(32) - 1). */
  skyChance: number;
  /** False when the block light limit rejects the position outright. */
  blockLightOk: boolean;
  /** Probability the brightness sample passes. */
  brightnessChance: number;
  /** max(blockLight, skyLight - skyDarken), the value the sample is tested against. */
  rawBrightness: number;
  /** The rule that produced this verdict. */
  rule: LightRule;
  /** Plain reason the spawn is blocked, when it is. */
  blockedBy: "sky-light" | "block-light" | "brightness" | null;
}

/**
 * Exact per attempt probability that Monster#isDarkEnoughToSpawn returns true.
 *
 * Three gates, in the order the game evaluates them:
 *  1. `getBrightness(SKY, pos) > random.nextInt(32)` rejects, so the sky light
 *     gate passes with probability (32 - skyLight) / 32.
 *  2. block light above the dimension's limit rejects outright (skipped when
 *     the limit is 15).
 *  3. `max(blockLight, skyLight - skyDarken) <= lightTest.sample(random)`.
 */
export function darkEnoughChance(opts: {
  version: string;
  dimension: SpawnDimension;
  skyLight: number;
  blockLight: number;
  world?: WorldLight;
}): LightVerdict {
  requireVersion(opts.version);
  const rule = lightRuleFor(opts.version, opts.dimension);
  const skyLight = clampLight(opts.skyLight);
  const blockLight = clampLight(opts.blockLight);
  const skyDarken = skyDarkenFor(opts.world ?? "night");

  const skyChance = Math.max(0, (SKY_LIGHT_TEST_RANGE - skyLight) / SKY_LIGHT_TEST_RANGE);
  const blockLightOk = rule.blockLightLimit >= 15 || blockLight <= rule.blockLightLimit;
  const rawBrightness = Math.max(blockLight, skyLight - skyDarken);

  let brightnessChance: number;
  if (rule.test.kind === "constant") {
    brightnessChance = rawBrightness <= rule.test.min ? 1 : 0;
  } else {
    // sample is uniform over [min, max]; pass when rawBrightness <= sample.
    const span = rule.test.max - rule.test.min + 1;
    const passing = rule.test.max - Math.max(rule.test.min, rawBrightness) + 1;
    brightnessChance = Math.max(0, Math.min(span, passing)) / span;
  }

  const chance = blockLightOk ? skyChance * brightnessChance : 0;
  let blockedBy: LightVerdict["blockedBy"] = null;
  if (!blockLightOk) blockedBy = "block-light";
  else if (brightnessChance === 0) blockedBy = "brightness";
  else if (skyChance === 0) blockedBy = "sky-light";

  return { chance, skyChance, blockLightOk, brightnessChance, rawBrightness, rule, blockedBy };
}

function clampLight(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, Math.round(n)));
}

export interface SpawnProofResult {
  /** Block light reaching the target block. */
  blockLight: number;
  /** True when no monster using the light gated rule can ever spawn there. */
  safe: boolean;
  /** Per attempt spawn probability at that block. */
  chance: number;
  /**
   * Largest taxicab distance from the source that is still spawn safe, or -1
   * when the source is too weak to protect any block at all.
   */
  safeRadius: number;
  verdict: LightVerdict;
  notes: string[];
}

/**
 * Spawn proofing: a light source of level L lights a block at taxicab distance
 * d with block light max(0, L - d). Whether that is enough depends entirely on
 * the version, which is the headline change in this tool.
 */
export function spawnProof(opts: {
  version: string;
  dimension: SpawnDimension;
  sourceLight: number;
  distance: number;
  skyLight?: number;
  world?: WorldLight;
}): SpawnProofResult {
  requireVersion(opts.version);
  const source = clampLight(opts.sourceLight);
  const distance = Math.max(0, Math.round(Number.isFinite(opts.distance) ? opts.distance : 0));
  const blockLight = Math.max(0, source - distance);
  const verdict = darkEnoughChance({
    version: opts.version,
    dimension: opts.dimension,
    skyLight: opts.skyLight ?? 0,
    blockLight,
    world: opts.world,
  });

  const rule = verdict.rule;
  // Safe radius: the largest taxicab distance still lit enough to refuse a
  // spawn. Block light falls off one level per block, so a block at distance d
  // holds source - d. With a block light limit the threshold is limit + 1;
  // with the limit disabled it is the brightness sample's ceiling plus one.
  // Minus one means the source is too weak to protect anything at all.
  const needed = rule.blockLightLimit < 15 ? rule.blockLightLimit + 1 : rule.test.max + 1;
  const safeRadius = source >= needed ? source - needed : -1;

  const notes: string[] = [];
  if (safeRadius < 0) {
    notes.push(
      `A light source of level ${source} cannot spawn proof anything in Minecraft ${opts.version}: block light ${needed} or more is needed at the spawn block itself.`,
    );
  } else if (rule.blockLightLimit < 15) {
    notes.push(
      `In Minecraft ${opts.version} a monster needs block light ${rule.blockLightLimit} at the spawn block, so one light source protects every block within ${safeRadius} of it (taxicab distance, not a sphere).`,
    );
  } else {
    notes.push(
      `In Minecraft ${opts.version} the block light gate is off for this dimension, so the block is only safe once its brightness passes ${rule.test.max}; light levels below that reduce the spawn rate instead of stopping it.`,
    );
  }
  if (opts.version === "1.16.5") {
    notes.push(
      "1.16.5 has no block light gate at all, so a block at light 7 still spawns monsters on about one attempt in eight.",
    );
  }

  return {
    blockLight,
    safe: verdict.chance === 0,
    chance: verdict.chance,
    safeRadius,
    verdict,
    notes,
  };
}

// -------------------------------------------------------- what spawns here --

export interface SpawnEntryResult {
  mob: string;
  name: string;
  /** MobSpawnSettings.SpawnerData weight, the relative pick weight. */
  weight: number;
  /** weight divided by the category's total weight in this biome. */
  share: number;
  minCount: number;
  maxCount: number;
  /** minCount + nextInt(1 + maxCount - minCount) averaged. */
  avgPack: number;
  /** How the mob's registered spawn predicate treats light. */
  rule: RuleClass;
  /** The Class::method the classification came from. */
  predicate: string;
  /** True when the mob adds conditions beyond the shared helper. */
  extraConditions: boolean;
  /** Per attempt probability the light rule lets this mob spawn here. */
  lightChance: number;
  /** Spawn cost charge and energy budget, when the biome sets one. */
  spawnCost: { charge: number; energyBudget: number } | null;
  notes: string[];
}

export interface SpawnListResult {
  version: string;
  biome: string;
  biomeName: string;
  dimension: SpawnDimension;
  category: string;
  categoryName: string;
  entries: SpawnEntryResult[];
  totalWeight: number;
  /** Chunk generation probability that a creature pack is placed. */
  creatureSpawnProbability: number;
  lightVerdict: LightVerdict;
  notes: string[];
}

/**
 * Everything the game could pick for one category in one biome, with the real
 * weights, normalized shares and pack sizes straight from the biome data.
 */
export function spawnsIn(opts: {
  version: string;
  biome: string;
  category: string;
  skyLight?: number;
  blockLight?: number;
  world?: WorldLight;
}): SpawnListResult {
  requireVersion(opts.version);
  requireBiome(opts.version, opts.biome);
  const cat = requireCategory(opts.version, opts.category);
  const info = BIOMES_BY_ID[opts.biome];

  const verdict = darkEnoughChance({
    version: opts.version,
    dimension: info.dim,
    skyLight: opts.skyLight ?? 0,
    blockLight: opts.blockLight ?? 0,
    world: opts.world,
  });

  const poolIndex = SPAWNERS[opts.version]?.[opts.biome]?.[opts.category];
  const packed = poolIndex === undefined ? [] : (ENTRY_POOL[poolIndex] ?? []);
  const rules = MOB_RULES[opts.version] ?? {};
  const costs = new Map<number, { charge: number; energyBudget: number }>();
  for (const [mobIdx, charge, budget] of SPAWN_COSTS[opts.version]?.[opts.biome] ?? []) {
    costs.set(mobIdx, { charge, energyBudget: budget });
  }

  const totalWeight = packed.reduce((s, e) => s + e[1], 0);
  const entries: SpawnEntryResult[] = packed.map(([mobIdx, weight, min, max]) => {
    const mob = MOB_IDS[mobIdx];
    const packedRule = rules[mob];
    const rule: RuleClass = packedRule ? packedRule[0] : "custom";
    const predicate = packedRule ? packedRule[2] : "not registered in SpawnPlacements";
    const extraConditions = packedRule ? packedRule[3] === 1 : true;
    const notes: string[] = [];
    let lightChance = 1;
    if (rule === "dark") lightChance = verdict.chance;
    else if (rule === "surface") {
      lightChance = verdict.chance;
      notes.push("Also needs an open view of the sky at the spawn block.");
    } else if (rule === "any-light") {
      notes.push("Never consults light, so a lit block does not stop it.");
    } else if (rule === "own-light") {
      notes.push("Runs its own brightness test rather than the shared light rule.");
    } else {
      notes.push("Its spawn rule could not be classified from the source.");
    }
    if (extraConditions) {
      notes.push(`Adds its own conditions on top (${predicate}), which this tool does not model.`);
    }
    return {
      mob,
      name: mobDisplayName(mob),
      weight,
      share: totalWeight > 0 ? weight / totalWeight : 0,
      minCount: min,
      maxCount: max,
      avgPack: (min + max) / 2,
      rule,
      predicate,
      extraConditions,
      lightChance,
      spawnCost: costs.get(mobIdx) ?? null,
      notes,
    };
  });

  const notes: string[] = [];
  if (!entries.length) {
    notes.push(
      `Minecraft ${opts.version} lists no ${cat.id} spawns for ${info.name}, so nothing in this category ever spawns here naturally.`,
    );
  }
  if (entries.some((e) => e.spawnCost)) {
    notes.push(
      "This biome sets spawn costs, a density brake: a spawn is refused when the potential energy of nearby mobs of the same type would exceed the budget.",
    );
  }
  if (opts.category === "monster" && info.dim === "overworld" && (opts.skyLight ?? 0) > 0) {
    notes.push(
      "Sky light is checked before anything else, so an open sky block spawns monsters less often than a sealed cave even at the same brightness.",
    );
  }

  return {
    version: opts.version,
    biome: opts.biome,
    biomeName: info.name,
    dimension: info.dim,
    category: cat.id,
    categoryName: cat.name,
    entries,
    totalWeight,
    creatureSpawnProbability: CREATURE_PROBABILITY[opts.version]?.[opts.biome] ?? 0,
    lightVerdict: verdict,
    notes,
  };
}

// ------------------------------------------------------------- the mob cap --

export interface MobCapResult {
  category: string;
  categoryName: string;
  /** MobCategory#getMaxInstancesPerChunk. */
  maxPerChunk: number;
  /** Chunks inside the radius 8 counter: 289 per player, minus any overlap. */
  spawnableChunks: number;
  /** maxPerChunk * spawnableChunks / 289, integer divided as the game does. */
  globalCap: number;
  /** LocalMobCapCalculator's per player limit, 1.18 and later. */
  perPlayerCap: number | null;
  /** Chunks that actually run the spawn loop each tick. */
  attemptChunks: number;
  /** Chebyshev radius of the attempting set: min(8, simulation distance). */
  attemptRadius: number;
  /** Live mobs supplied by the caller. */
  currentMobs: number;
  /** globalCap minus currentMobs, floored at zero. */
  headroom: number;
  /** currentMobs / globalCap. */
  fill: number;
  notes: string[];
}

/**
 * Count chunks whose centre is within 128 blocks of a player standing at the
 * centre of their own chunk, limited to a Chebyshev radius. This is exactly
 * ChunkMap#playerIsCloseEnoughForSpawning combined with the spawn candidate
 * set, evaluated for the common case.
 */
export function countAttemptChunks(radius: number): number {
  const r = Math.max(0, Math.min(SPAWN_CHUNK_RADIUS, Math.floor(radius)));
  const limitSq = SPAWNING_CHUNK_PLAYER_RADIUS * SPAWNING_CHUNK_PLAYER_RADIUS;
  let count = 0;
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      const dx = i * 16;
      const dz = j * 16;
      if (dx * dx + dz * dz < limitSq) count++;
    }
  }
  return count;
}

export function mobCap(opts: {
  version: string;
  category: string;
  players?: number;
  /** True when players are far enough apart that their chunk squares do not overlap. */
  playersSeparated?: boolean;
  simulationDistance?: number;
  currentMobs?: number;
}): MobCapResult {
  requireVersion(opts.version);
  const cat = requireCategory(opts.version, opts.category);
  const players = Math.max(1, Math.round(opts.players ?? 1));
  const separated = opts.playersSeparated ?? true;
  const sim = Math.max(2, Math.round(opts.simulationDistance ?? 10));
  const currentMobs = Math.max(0, Math.round(opts.currentMobs ?? 0));

  const chunksPerPlayer = (SPAWN_CHUNK_RADIUS * 2 + 1) ** 2;
  const spawnableChunks = separated ? chunksPerPlayer * players : chunksPerPlayer;
  const globalCap = Math.floor((cat.maxPerChunk * spawnableChunks) / MOB_CAP_DIVISOR);
  const attemptRadius = Math.min(SPAWN_CHUNK_RADIUS, sim);
  const attemptChunks = countAttemptChunks(attemptRadius) * (separated ? players : 1);

  const notes: string[] = [];
  notes.push(
    `The cap counter has a fixed radius of ${SPAWN_CHUNK_RADIUS} chunks, so simulation distance never changes the cap. It only changes how many of those chunks get to try to spawn.`,
  );
  if (sim < SPAWN_CHUNK_RADIUS) {
    notes.push(
      `Simulation distance ${sim} is below ${SPAWN_CHUNK_RADIUS}, so only the inner ${attemptRadius} chunk ring runs the spawn loop while the cap still counts the full ${chunksPerPlayer} chunk square.`,
    );
  }
  if (hasPerPlayerCap(opts.version)) {
    notes.push(
      `Minecraft ${opts.version} also enforces a per player limit of ${cat.maxPerChunk} ${cat.id} mobs near each player (LocalMobCapCalculator), on top of the global cap.`,
    );
  } else {
    notes.push(
      "1.16.5 has no per player cap: one player standing in a mob heavy area can starve everyone else's spawns.",
    );
  }

  return {
    category: cat.id,
    categoryName: cat.name,
    maxPerChunk: cat.maxPerChunk,
    spawnableChunks,
    globalCap,
    perPlayerCap: hasPerPlayerCap(opts.version) ? cat.maxPerChunk : null,
    attemptChunks,
    attemptRadius,
    currentMobs,
    headroom: Math.max(0, globalCap - currentMobs),
    fill: globalCap > 0 ? currentMobs / globalCap : 0,
    notes,
  };
}

// ---------------------------------------------------------- the AFK sphere --

export interface AfkGeometry {
  /** No spawn inside this radius of a player, spherical. */
  minSpawnDistance: number;
  /** Chunks stop attempting beyond this horizontal distance from a player. */
  spawningChunkRadius: number;
  /** Instant despawn beyond this, spherical, per category. */
  instantDespawn: number;
  /** Inside this the idle timer resets, so nothing random despawns. */
  noDespawn: number;
  /** Average seconds a mob survives once eligible for random despawn. */
  randomDespawnMeanSeconds: number;
  notes: string[];
}

export function afkGeometry(version: string, category: string): AfkGeometry {
  requireVersion(version);
  const cat = requireCategory(version, category);
  return {
    minSpawnDistance: MIN_SPAWN_DISTANCE,
    spawningChunkRadius: SPAWNING_CHUNK_PLAYER_RADIUS,
    instantDespawn: cat.despawnDistance,
    noDespawn: NO_DESPAWN_DISTANCE,
    randomDespawnMeanSeconds: RANDOM_DESPAWN_DENOMINATOR / TICKS_PER_SECOND,
    notes: [
      `Spawns land between ${MIN_SPAWN_DISTANCE} blocks (spherical, from NaturalSpawner) and ${SPAWNING_CHUNK_PLAYER_RADIUS} blocks (horizontal, from the chunk gate in ChunkMap).`,
      `Beyond ${cat.despawnDistance} blocks a ${cat.id} is removed the moment it is checked; the world spawn point also blocks spawns within ${MIN_SPAWN_DISTANCE} blocks of it.`,
      `Inside ${NO_DESPAWN_DISTANCE} blocks the idle timer resets every tick, so mobs there never random despawn. Outside it, after ${RANDOM_DESPAWN_IDLE_TICKS} idle ticks each mob has a 1 in ${RANDOM_DESPAWN_DENOMINATOR} chance per tick, about ${RANDOM_DESPAWN_DENOMINATOR / TICKS_PER_SECOND} seconds on average.`,
    ],
  };
}

// -------------------------------------------------------------- farm rates --

export type Bottleneck = "spawn-attempts" | "mob-cap" | "geometry" | "light";

export interface FarmRateResult {
  /** Mobs per hour the geometry alone could produce. */
  spawnLimitedPerHour: number;
  /** Mobs per hour the cap allows given how fast the farm clears them. */
  capLimitedPerHour: number;
  /** The smaller of the two. */
  perHour: number;
  bottleneck: Bottleneck;
  /** The terms, so the page can show the arithmetic rather than a magic number. */
  terms: {
    chunkTicksPerSecond: number;
    columnHeight: number;
    spawnSpacesPerChunk: number;
    hitChance: number;
    mobsPerHit: number;
    lightChance: number;
    dwellSeconds: number;
    headroom: number;
  };
  cap: MobCapResult;
  warnings: string[];
  notes: string[];
}

/**
 * Farm throughput estimate.
 *
 * Reimplemented from NaturalSpawner#spawnCategoryForChunk: once per tick each
 * spawning chunk picks ONE random position, x and z uniform over the chunk and
 * y uniform between the dimension floor and the surface heightmap plus one.
 * All three pack rounds then reuse that y, which is why extra platform layers
 * raise the chance of a hit instead of multiplying hits, and why one chunk tick
 * yields at most Mob#getMaxSpawnClusterSize mobs.
 *
 * This is a model, not a measurement. It ignores the block-by-block validity
 * checks (SpawnPlacements#isSpawnPositionOk, collision, spawn costs) and
 * assumes the platform is wide enough that the pack walk stays on it.
 */
export function farmRate(opts: {
  version: string;
  dimension: SpawnDimension;
  category: string;
  /** Valid spawn positions in the farm, summed over every layer. */
  spawnSpaces: number;
  /** How many chunks the farm spans. */
  farmChunks: number;
  /** Surface heightmap value above the farm: the top of the random y range. */
  surfaceY: number;
  /** Average pack size of the mobs the farm produces. */
  avgPack?: number;
  /** Seconds from spawn to removal inside the farm. */
  dwellSeconds?: number;
  /** Mobs of this category alive outside the farm. */
  otherMobs?: number;
  players?: number;
  playersSeparated?: boolean;
  simulationDistance?: number;
  /** Per attempt light chance from darkEnoughChance; 1 for a fully dark farm. */
  lightChance?: number;
  /** Distance from the AFK spot to the farm's spawning platform. */
  afkDistance?: number;
}): FarmRateResult {
  requireVersion(opts.version);
  const cat = requireCategory(opts.version, opts.category);
  const shape = dimensionShape(opts.version, opts.dimension);

  const farmChunks = Math.max(1, Math.round(opts.farmChunks));
  const spawnSpaces = Math.max(0, Math.round(opts.spawnSpaces));
  const maxY = shape.minY + shape.height - 1;
  const surfaceY = Math.max(shape.minY, Math.min(maxY, Math.round(opts.surfaceY)));
  // Mth.randomBetweenInclusive(random, minY, surface + 1) is inclusive at both
  // ends, so the y range holds surface + 1 - minY + 1 values.
  const columnHeight = surfaceY + 1 - shape.minY + 1;
  const spawnSpacesPerChunk = spawnSpaces / farmChunks;
  const hitChance = Math.min(1, spawnSpacesPerChunk / (256 * columnHeight));
  const avgPack = Math.max(1, opts.avgPack ?? 4);
  const mobsPerHit = Math.min(MAX_SPAWN_CLUSTER_SIZE, avgPack);
  const lightChance = Math.max(0, Math.min(1, opts.lightChance ?? 1));
  const dwellSeconds = Math.max(0.05, opts.dwellSeconds ?? 30);

  const cap = mobCap({
    version: opts.version,
    category: opts.category,
    players: opts.players,
    playersSeparated: opts.playersSeparated,
    simulationDistance: opts.simulationDistance,
    currentMobs: opts.otherMobs,
  });

  const chunkTicksPerSecond = Math.min(farmChunks, cap.attemptChunks) * TICKS_PER_SECOND;
  let spawnLimitedPerHour = chunkTicksPerSecond * hitChance * mobsPerHit * lightChance * 3600;
  const capLimitedPerHour = (cap.headroom / dwellSeconds) * 3600;

  const warnings: string[] = [];
  const afk = opts.afkDistance;
  if (afk !== undefined && Number.isFinite(afk)) {
    if (afk < MIN_SPAWN_DISTANCE) {
      warnings.push(
        `The platform is ${afk} blocks from the AFK spot, inside the ${MIN_SPAWN_DISTANCE} block exclusion sphere. Nothing spawns there at all.`,
      );
      spawnLimitedPerHour = 0;
    } else if (afk > SPAWNING_CHUNK_PLAYER_RADIUS) {
      warnings.push(
        `The platform is ${afk} blocks away, past the ${SPAWNING_CHUNK_PLAYER_RADIUS} block chunk gate. Those chunks never run the spawn loop.`,
      );
      spawnLimitedPerHour = 0;
    } else if (afk > cat.despawnDistance) {
      warnings.push(
        `At ${afk} blocks a ${cat.id} is past its ${cat.despawnDistance} block instant despawn radius, so spawns there are refused by NaturalSpawner#isValidSpawnPostitionForType.`,
      );
      spawnLimitedPerHour = 0;
    } else if (afk < NO_DESPAWN_DISTANCE) {
      warnings.push(
        `The platform is inside the ${NO_DESPAWN_DISTANCE} block no-despawn sphere, so mobs there never random despawn. Good for a collection farm, bad if you rely on despawns to clear the cap.`,
      );
    }
  }
  if (lightChance === 0) {
    warnings.push("The light rule refuses every spawn at this light level, so the rate is zero.");
  }

  const perHour = Math.min(spawnLimitedPerHour, capLimitedPerHour);
  let bottleneck: Bottleneck;
  if (spawnLimitedPerHour === 0 && warnings.length)
    bottleneck = lightChance === 0 ? "light" : "geometry";
  else if (spawnLimitedPerHour <= capLimitedPerHour) bottleneck = "spawn-attempts";
  else bottleneck = "mob-cap";

  const notes: string[] = [
    `Each of the ${Math.min(farmChunks, cap.attemptChunks)} eligible chunks picks one random position per tick, with y uniform over ${columnHeight} values between ${shape.minY} and ${surfaceY + 1}. Lowering what sits above the farm shortens that column and is usually the cheapest rate improvement.`,
    `All ${ROUNDS_PER_CHUNK_TICK} pack rounds share that one y, and a chunk tick stops at ${MAX_SPAWN_CLUSTER_SIZE} mobs, so extra layers raise the chance of a hit rather than multiplying hits.`,
  ];
  if (bottleneck === "mob-cap") {
    notes.push(
      `The cap is binding: ${cap.headroom} of ${cap.globalCap} slots are free and the farm clears a mob every ${dwellSeconds} seconds. Killing faster, or clearing mobs elsewhere in the loaded area, raises the ceiling.`,
    );
  } else if (bottleneck === "spawn-attempts") {
    notes.push(
      "Spawn attempts are binding: more spawnable surface, or a shorter column above the farm, raises the rate. The cap still has room.",
    );
  }

  return {
    spawnLimitedPerHour,
    capLimitedPerHour,
    perHour,
    bottleneck,
    terms: {
      chunkTicksPerSecond,
      columnHeight,
      spawnSpacesPerChunk,
      hitChance,
      mobsPerHit,
      lightChance,
      dwellSeconds,
      headroom: cap.headroom,
    },
    cap,
    warnings,
    notes,
  };
}

// ---------------------------------------------------------- the tool surface --

export interface SpawningRunOpts {
  version?: string;
  biome?: string;
  category?: string;
  skyLight?: number | string;
  blockLight?: number | string;
  world?: WorldLight;
  players?: number | string;
  simulationDistance?: number | string;
}

function num(v: number | string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(p: number): string {
  if (p >= 0.9995) return "100%";
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p > 0) return `${(p * 100).toPrecision(2)}%`;
  return "0%";
}

/**
 * Generic surface: "what can spawn here" plus the cap arithmetic, as labeled
 * rows. The bespoke panel exposes the farm and spawn proofing calculators.
 */
export function run(input: string, opts: SpawningRunOpts): Record<string, string> {
  const version = (opts.version || SPAWN_VERSIONS[SPAWN_VERSIONS.length - 1]).trim();
  requireVersion(version);
  const biome = ((input || "").trim() || opts.biome || "plains").replace(/^minecraft:/, "");
  const category = opts.category || "monster";
  const list = spawnsIn({
    version,
    biome,
    category,
    skyLight: num(opts.skyLight, 0),
    blockLight: num(opts.blockLight, 0),
    world: opts.world ?? "night",
  });
  const cap = mobCap({
    version,
    category,
    players: num(opts.players, 1),
    simulationDistance: num(opts.simulationDistance, 10),
  });

  const out: Record<string, string> = {};
  out["Biome"] = `${list.biomeName} (${list.dimension}), Minecraft ${version}`;
  out["Category"] = `${list.categoryName}, total weight ${list.totalWeight}`;
  if (!list.entries.length) {
    out["Result"] = `Nothing in the ${category} category spawns in ${list.biomeName}.`;
  }
  for (const e of list.entries) {
    const pack = e.minCount === e.maxCount ? `${e.minCount}` : `${e.minCount} to ${e.maxCount}`;
    out[e.name] =
      `weight ${e.weight} (${pct(e.share)} of picks), pack ${pack}, light chance ${pct(e.lightChance)}`;
  }
  out["Mob cap"] =
    `${cap.globalCap} ${category} mobs across ${cap.spawnableChunks} counted chunks` +
    (cap.perPlayerCap === null ? "" : `, plus ${cap.perPlayerCap} per player`);
  out["Spawn ring"] =
    `${MIN_SPAWN_DISTANCE} to ${SPAWNING_CHUNK_PLAYER_RADIUS} blocks; instant despawn past ${afkGeometry(version, category).instantDespawn} blocks`;
  out["Light check"] = `${pct(list.lightVerdict.chance)} of attempts pass at this light level`;
  if (list.notes.length) out["Notes"] = list.notes.join(" ");
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, SpawningRunOpts>;
