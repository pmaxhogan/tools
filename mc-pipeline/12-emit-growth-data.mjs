// Emit the committed growth/breeding data module for
// minecraft-crop-growth-calculator.
//
// Two inputs, both already on disk:
//
//   mc-pipeline/work/<version>/src/    decompiled server source (never
//                                      committed, never transcribed). Every
//                                      NUMBER below is read out of it with a
//                                      structural regex, so a value that moves
//                                      between releases shows up as a diff in
//                                      the generated module instead of going
//                                      unnoticed.
//   mc-pipeline/extracted/<version>/registries.json
//                                      the vanilla block and entity registries,
//                                      used to decide which plants and animals
//                                      actually exist in each version.
//
// Output: src/tools/minecraft-crop-growth-calculator/data.ts
//
// Labels, categories, search synonyms, and the per-animal food lists are
// curated here (the source has them as item tags whose contents are not in
// extracted/), but everything that drives a computed number is parsed. Any
// regex that fails to match is a hard error: a silently missing constant would
// produce a confidently wrong calculator.
//
// Idempotent: sorted keys, stable ordering, deterministic output.
// Node builtins only. Usage: node mc-pipeline/12-emit-growth-data.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTRACTED = join(ROOT, "extracted");
const WORK = join(ROOT, "work");
const OUT_DIR = join(ROOT, "..", "src", "tools", "minecraft-crop-growth-calculator");
const SIZE_LIMIT = 2 * 1024 * 1024;

const KNOWN_VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

const versions = KNOWN_VERSIONS.filter((v) => existsSync(join(WORK, v, "src")));
if (!versions.length) {
  console.error("no decompiled source found under mc-pipeline/work/<version>/src");
  process.exit(1);
}

// ------------------------------------------------------------- source io ---

const BLOCK_DIR = "net/minecraft/world/level/block";
const ENTITY_DIR = "net/minecraft/world/entity";

/** Read the first candidate path that exists. Returns null when none do. */
function readAny(version, candidates) {
  for (const rel of candidates) {
    const p = join(WORK, version, "src", rel);
    if (existsSync(p)) return { path: rel, text: readFileSync(p, "utf8") };
  }
  return null;
}

function readBlock(version, names) {
  return readAny(
    version,
    names.map((n) => `${BLOCK_DIR}/${n}.java`),
  );
}

/** Match or die. `what` names the fact so a failure is actionable. */
function must(file, re, what, version) {
  if (!file) throw new Error(`${version}: source file missing for ${what}`);
  const m = file.text.match(re);
  if (!m) throw new Error(`${version}: could not read ${what} from ${file.path} (${re})`);
  return m;
}

/** Whitespace-insensitive source matching: decompiler line breaks move around. */
function flat(text) {
  return text.replace(/\s+/g, " ");
}

// --------------------------------------------------------- per-version ------

const registries = {};
for (const v of versions) {
  const p = join(EXTRACTED, v, "registries.json");
  registries[v] = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function hasBlock(version, id) {
  const reg = registries[version];
  if (!reg) return true; // no registry extracted: fall back to source presence
  const list = reg.block ?? reg["minecraft:block"];
  return Array.isArray(list) ? list.includes(id) : true;
}

function hasEntity(version, id) {
  const reg = registries[version];
  if (!reg) return true;
  const list = reg.entity_type ?? reg["minecraft:entity_type"];
  return Array.isArray(list) ? list.includes(id) : true;
}

/**
 * Everything numeric, parsed per version.
 *
 * Class names and parameter names both move between eras (param0 / $$0 / real
 * names), so every pattern matches on STRUCTURE, never on identifiers.
 */
function readFacts(version) {
  const crop = readBlock(version, ["CropBlock"]);
  const farm = readBlock(version, ["FarmBlock", "FarmlandBlock"]);
  const beet = readBlock(version, ["BeetrootBlock"]);
  const stem = readBlock(version, ["StemBlock"]);
  const wart = readBlock(version, ["NetherWartBlock"]);
  const cocoa = readBlock(version, ["CocoaBlock"]);
  const berry = readBlock(version, ["SweetBerryBushBlock"]);
  const sapling = readBlock(version, ["SaplingBlock"]);
  const bamboo = readBlock(version, ["BambooStalkBlock", "BambooBlock"]);
  const cane = readBlock(version, ["SugarCaneBlock"]);
  const cactus = readBlock(version, ["CactusBlock"]);
  const kelp = readBlock(version, ["KelpBlock"]);
  const caveVines = readBlock(version, ["CaveVinesBlock"]);
  const twisting = readBlock(version, ["TwistingVinesBlock", "TwistingVines"]);
  const weeping = readBlock(version, ["WeepingVinesBlock", "WeepingVines"]);
  const torchflower = readBlock(version, ["TorchflowerCropBlock"]);
  const pitcher = readBlock(version, ["PitcherCropBlock"]);
  const growingHead = readBlock(version, ["GrowingPlantHeadBlock"]);
  const animal = readAny(version, [`${ENTITY_DIR}/animal/Animal.java`]);
  const ageable = readAny(version, [
    `${ENTITY_DIR}/AgeableMob.java`,
    `${ENTITY_DIR}/AgableMob.java`,
  ]);
  const gameRules = readAny(version, [
    "net/minecraft/world/level/gamerules/GameRules.java",
    "net/minecraft/world/level/GameRules.java",
  ]);
  const serverLevel = readAny(version, ["net/minecraft/server/level/ServerLevel.java"]);

  const facts = {};

  // CropBlock.randomTick: nextInt((int)(25.0F / speed) + 1) == 0
  const cropRoll = must(
    crop,
    /nextInt\(\(int\)\(([\d.]+)F \/ [\w$]+\) \+ 1\) == 0/,
    "crop growth roll divisor",
    version,
  );
  facts.growthDivisor = Number(cropRoll[1]);

  // CropBlock.getGrowthSpeed: base 1, farmland 1, moist farmland 3,
  // diagonal/orthogonal neighbours quartered, crowding halves.
  const speedBody = { path: crop.path, text: flat(crop.text) };
  facts.speedBase = Number(
    must(speedBody, /float [\w$]+ = ([\d.]+)F; BlockPos /, "growth speed base", version)[1],
  );
  const weights = must(
    speedBody,
    /\{ [\w$]+ = ([\d.]+)F; if \([^;]*?MOISTURE[^;]*?> 0\) \{ [\w$]+ = ([\d.]+)F;/,
    "farmland growth speed weights",
    version,
  );
  facts.speedFarmland = Number(weights[1]);
  facts.speedMoistFarmland = Number(weights[2]);
  facts.speedNeighbourDivisor = Number(
    must(crop, /[\w$]+ \/= ([\d.]+)F;/, "neighbour speed divisor", version)[1],
  );
  facts.speedCrowdDivisor = Number(
    must(crop, /[\w$]+ \/= ([\d.]+)F;\s*\} else \{/, "crowding speed divisor", version)[1],
  );
  facts.cropLight = Number(
    must(crop, /getRawBrightness\([^)]*\) >= (\d+)\) \{\s*int/, "crop light level", version)[1],
  );
  const maxAgeRe = /getMaxAge\(\) \{\s*return (\d+);/;
  facts.cropMaxAge = Number(must(crop, maxAgeRe, "crop max age", version)[1]);
  const cropBonemeal = must(
    crop,
    /Mth\.nextInt\([^,]+, (\d+), (\d+)\)/,
    "crop bone meal age increase",
    version,
  );
  facts.cropBonemealMin = Number(cropBonemeal[1]);
  facts.cropBonemealMax = Number(cropBonemeal[2]);

  // FarmBlock / FarmlandBlock: hydration range and max moisture.
  facts.maxMoisture = Number(
    must(farm, /setValue\(MOISTURE, (\d+)\), 2\)/, "max moisture", version)[1],
  );
  const hydration = must(
    farm,
    /betweenClosed\([\w$]+\.offset\(-(\d+), 0, -\d+\), [\w$]+\.offset\(\d+, (\d+), \d+\)\)/,
    "farmland hydration range",
    version,
  );
  facts.hydrationRadius = Number(hydration[1]);
  facts.hydrationHeight = Number(hydration[2]);

  // BeetrootBlock divides the shared crop roll, which is why it costs more
  // bone meal than wheat despite having fewer stages.
  facts.beetrootMaxAge = Number(must(beet, maxAgeRe, "beetroot max age", version)[1]);
  // Beetroot skips one growth attempt in three before falling through to the
  // shared CropBlock roll, the same gate torchflower uses.
  facts.beetrootGate = Number(
    must(beet, /nextInt\((\d+)\) != 0/, "beetroot growth gate", version)[1],
  );
  facts.beetrootBonemealDivisor = Number(
    must(beet, /getBonemealAgeIncrease\([^)]*\) \/ (\d+)/, "beetroot bone meal divisor", version)[1],
  );

  // StemBlock: shares the crop roll, then a horizontal direction roll.
  facts.stemMaxAge = Number(must(stem, /< (\d+)\) \{\s*[\w$]+ = [\w$]+\.setValue\(AGE/, "stem max age", version)[1]);
  facts.stemDirections = 4; // Direction.Plane.HORIZONTAL
  if (!/Plane\.HORIZONTAL\.getRandomDirection/.test(stem.text)) {
    throw new Error(`${version}: StemBlock no longer picks a random horizontal direction`);
  }

  facts.netherWartChance = Number(
    must(wart, /nextInt\((\d+)\) == 0/, "nether wart growth roll", version)[1],
  );
  facts.netherWartMaxAge = Number(
    must(wart, /[\w$]+ < (\d+) && [\w$]+\.nextInt\(\d+\) == 0/, "nether wart max age", version)[1],
  );

  facts.cocoaChance = Number(must(cocoa, /nextInt\((\d+)\) == 0/, "cocoa growth roll", version)[1]);
  facts.cocoaMaxAge = Number(must(cocoa, /if \([\w$]+ < (\d+)\)/, "cocoa max age", version)[1]);

  const berryRoll = must(
    berry,
    /[\w$]+ < (\d+) && [\w$]+\.nextInt\((\d+)\) == 0 && [\w$]+\.getRawBrightness\([^;]*?\) >= (\d+)/,
    "sweet berry growth roll",
    version,
  );
  facts.berryMaxAge = Number(berryRoll[1]);
  facts.berryChance = Number(berryRoll[2]);
  facts.berryLight = Number(berryRoll[3]);

  const saplingRoll = must(
    sapling,
    /getMaxLocalRawBrightness\([^;]*?\) >= (\d+) && [\w$]+\.nextInt\((\d+)\) == 0/,
    "sapling growth roll",
    version,
  );
  facts.saplingLight = Number(saplingRoll[1]);
  facts.saplingChance = Number(saplingRoll[2]);
  facts.saplingBonemealSuccess = Number(
    must(sapling, /nextFloat\(\) < ([\d.]+)/, "sapling bone meal success chance", version)[1],
  );

  const bambooRoll = must(
    bamboo,
    /nextInt\((\d+)\) == 0 && [\w$]+\.isEmptyBlock\([^;]*?\) && [\w$]+\.getRawBrightness\([^;]*?\) >= (\d+)/,
    "bamboo growth roll",
    version,
  );
  facts.bambooChance = Number(bambooRoll[1]);
  facts.bambooLight = Number(bambooRoll[2]);
  facts.bambooMaxHeight = Number(
    must(bamboo, /if \([\w$]+ < (\d+)\) \{\s*this\.growBamboo/, "bamboo max height", version)[1],
  );
  const bambooBonemeal = must(
    bamboo,
    /int [\w$]+ = (\d+) \+ [\w$]+\.nextInt\((\d+)\);/,
    "bamboo bone meal blocks",
    version,
  );
  facts.bambooBonemealMin = Number(bambooBonemeal[1]);
  facts.bambooBonemealSpread = Number(bambooBonemeal[2]);

  facts.caneMaxAge = Number(must(cane, /== (\d+)\) \{/, "sugar cane age cap", version)[1]);
  facts.caneMaxHeight = Number(must(cane, /if \([\w$]+ < (\d+)\)/, "sugar cane height cap", version)[1]);
  facts.cactusMaxAge = Number(must(cactus, /== (\d+)\)/, "cactus age cap", version)[1]);
  facts.cactusMaxHeight = Number(
    must(cactus, /(?:if \([\w$]+ < (\d+)\)|\+\+[\w$]+ == (\d+) &&)/, "cactus height cap", version)
      .slice(1)
      .find(Boolean),
  );

  // GrowingPlantHeadBlock family: one block per successful roll until age 25.
  facts.growingHeadMaxAge = Number(
    must(growingHead, /getValue\(AGE\) < (\d+) &&/, "growing plant head age cap", version)[1],
  );
  const headProb = (file, what) =>
    Number(must(file, /super\([^)]*?,\s*([\d.]+)\);/, what, version)[1]);
  facts.kelpChance = headProb(kelp, "kelp growth probability");
  facts.twistingChance = headProb(twisting, "twisting vines growth probability");
  facts.weepingChance = headProb(weeping, "weeping vines growth probability");
  facts.caveVinesChance = caveVines ? headProb(caveVines, "cave vines growth probability") : null;
  facts.caveVinesBerryChance = caveVines
    ? Number(
        must(caveVines, /nextFloat\(\) < ([\d.]+)F/, "cave vines berry chance", version)[1],
      )
    : null;
  facts.growingHeadBonemealBlocks = kelp
    ? Number(
        must(kelp, /getBlocksToGrowWhenBonemealed\([^)]*\) \{\s*return (\d+);/, "kelp bone meal blocks", version)[1],
      )
    : 1;

  if (torchflower) {
    facts.torchflowerGate = Number(
      must(torchflower, /nextInt\((\d+)\) != 0/, "torchflower growth gate", version)[1],
    );
    facts.torchflowerMaxAge = Number(
      must(torchflower, /getMaxAge\(\) \{\s*return (\d+);/, "torchflower max age", version)[1],
    );
    facts.torchflowerBonemeal = Number(
      must(torchflower, /BONEMEAL_INCREASE = (\d+)/, "torchflower bone meal increase", version)[1],
    );
  }
  if (pitcher) {
    facts.pitcherMaxAge = Number(must(pitcher, /MAX_AGE = (\d+)/, "pitcher max age", version)[1]);
    facts.pitcherBonemeal = Number(
      must(pitcher, /BONEMEAL_INCREASE = (\d+)/, "pitcher bone meal increase", version)[1],
    );
  }

  // Random tick machinery. The per-section 16x16x16 selection is what makes
  // the per-block chance randomTickSpeed / 4096.
  const mask = must(
    serverLevel,
    /getBlockRandomPos\([\w$]+, [\w$]+, [\w$]+, (\d+)\)/,
    "random tick position mask",
    version,
  );
  facts.sectionEdge = Number(mask[1]) + 1;
  facts.blocksPerSection = facts.sectionEdge ** 3;

  // WHICH chunks get random ticked at all, from ServerChunkCache.tickChunks.
  // Before 1.21.11 the call to Level.tickChunk is nested inside the natural
  // spawning branch, so a chunk with no player close enough for spawning never
  // random ticks and nothing in it grows. 1.21.11 moved the call to
  // ChunkMap.forEachBlockTickingChunk, decoupling growth from spawning
  // eligibility. This is also why growth can only be MEASURED headlessly on the
  // newer versions: with no player online, the older loop never fires.
  const chunkCache = readAny(version, ["net/minecraft/server/level/ServerChunkCache.java"]);
  if (/forEachBlockTickingChunk\([^;]*?tickChunk\(/.test(flat(chunkCache.text))) {
    facts.randomTickGate = "block-ticking-chunks";
    facts.randomTickGateMethod = "ChunkMap.forEachBlockTickingChunk";
  } else if (/anyPlayerCloseEnoughForSpawning/.test(chunkCache.text)) {
    facts.randomTickGate = "player-near-for-spawning";
    facts.randomTickGateMethod = "ChunkMap.anyPlayerCloseEnoughForSpawning";
  } else if (/noPlayersCloseForSpawning/.test(chunkCache.text)) {
    facts.randomTickGate = "player-near-for-spawning";
    facts.randomTickGateMethod = "ChunkMap.noPlayersCloseForSpawning";
  } else {
    throw new Error(`${version}: could not read the random tick chunk gate from ServerChunkCache`);
  }
  const gameRule = must(
    gameRules,
    /"random_?[tT]ick_?[sS]peed"[^;]*?(?:IntegerValue\.create\((\d+)\)|UPDATES, (\d+),)/,
    "randomTickSpeed default",
    version,
  );
  facts.randomTickSpeedDefault = Number(gameRule.slice(1).find((x) => x !== undefined));
  facts.randomTickGameRule = /world\/level\/gamerules/.test(gameRules.path)
    ? "minecraft:random_tick_speed"
    : "randomTickSpeed";

  // Breeding and baby growth.
  facts.loveTicks = Number(
    must(
      animal,
      /setInLove\([^)]*\) \{\s*this\.inLove = (\d+);/,
      "in love duration",
      version,
    )[1],
  );
  facts.breedCooldownTicks = Number(
    must(animal, /setAge\((\d+)\);/, "post breeding age", version)[1],
  );
  facts.babyGrowTicks = Math.abs(
    Number(
      must(
        ageable,
        /(?:BABY_START_AGE = (-\d+)|setAge\([\w$]+ \? (-\d+) : 0\))/,
        "baby start age",
        version,
      )
        .slice(1)
        .find(Boolean),
    ),
  );
  const feedSource = ageable.text.includes("getSpeedUpSecondsWhenFeeding") ? ageable : animal;
  facts.feedFraction = Number(
    must(feedSource, /\/ (\d+) \* ([\d.]+)F\)/, "baby feeding speed up", version)[2],
  );
  facts.ticksPerSecond = Number(
    must(feedSource, /\/ (\d+) \* [\d.]+F\)/, "ticks per second divisor", version)[1],
  );
  facts.ageUpMultiplier = Number(
    must(ageable, /[\w$]+ \+= [\w$]+ \* (\d+);/, "age up seconds to ticks", version)[1],
  );

  facts.present = {
    torchflower: Boolean(torchflower),
    pitcher: Boolean(pitcher),
    caveVines: Boolean(caveVines),
    cactusFlower: Boolean(readBlock(version, ["CactusFlowerBlock"])),
  };
  facts.farmlandClass = farm.path.split("/").pop().replace(".java", "");
  return facts;
}

const FACTS = {};
for (const v of versions) FACTS[v] = readFacts(v);

// ------------------------------------------------------- plant registry ----

const CATS = {
  farmland: "Farmland crops",
  nether: "Nether plants",
  vertical: "Stacking plants",
  bush: "Bushes and trees",
};

/**
 * One entry per plant the calculator offers. `block` gates availability against
 * the version's block registry; `build` turns the parsed facts into the plant's
 * numeric model, so a constant that changes between versions changes the data.
 */
const PLANTS = [
  {
    id: "wheat",
    label: "Wheat",
    cat: "farmland",
    block: "wheat",
    synonyms: ["seeds", "bread", "hay"],
    unit: "wheat",
    build: (f) => ({
      stages: f.cropMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "uniform", min: f.cropBonemealMin, max: f.cropBonemealMax },
    }),
  },
  {
    id: "carrots",
    label: "Carrots",
    cat: "farmland",
    block: "carrots",
    synonyms: ["carrot", "golden carrot"],
    unit: "carrots",
    build: (f) => ({
      stages: f.cropMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "uniform", min: f.cropBonemealMin, max: f.cropBonemealMax },
    }),
  },
  {
    id: "potatoes",
    label: "Potatoes",
    cat: "farmland",
    block: "potatoes",
    synonyms: ["potato", "poisonous potato", "baked"],
    unit: "potatoes",
    build: (f) => ({
      stages: f.cropMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "uniform", min: f.cropBonemealMin, max: f.cropBonemealMax },
    }),
  },
  {
    id: "beetroots",
    label: "Beetroots",
    cat: "farmland",
    block: "beetroots",
    synonyms: ["beetroot", "beet", "soup"],
    unit: "beetroots",
    build: (f) => ({
      stages: f.beetrootMaxAge,
      model: { kind: "crop", gate: (f.beetrootGate - 1) / f.beetrootGate },
      farmland: true,
      light: f.cropLight,
      bonemeal: {
        kind: "divided",
        min: f.cropBonemealMin,
        max: f.cropBonemealMax,
        divisor: f.beetrootBonemealDivisor,
      },
    }),
  },
  {
    id: "melon_stem",
    label: "Melon stem",
    cat: "farmland",
    block: "melon_stem",
    synonyms: ["melon", "slices", "stem"],
    unit: "melons",
    build: (f) => ({
      stages: f.stemMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "uniform", min: f.cropBonemealMin, max: f.cropBonemealMax },
      fruitSides: f.stemDirections,
    }),
  },
  {
    id: "pumpkin_stem",
    label: "Pumpkin stem",
    cat: "farmland",
    block: "pumpkin_stem",
    synonyms: ["pumpkin", "stem", "carved"],
    unit: "pumpkins",
    build: (f) => ({
      stages: f.stemMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "uniform", min: f.cropBonemealMin, max: f.cropBonemealMax },
      fruitSides: f.stemDirections,
    }),
  },
  {
    id: "torchflower_crop",
    label: "Torchflower",
    cat: "farmland",
    block: "torchflower_crop",
    synonyms: ["sniffer", "seeds", "flower"],
    unit: "torchflowers",
    build: (f) => ({
      stages: f.torchflowerMaxAge,
      model: { kind: "crop", gate: (f.torchflowerGate - 1) / f.torchflowerGate },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "fixed", amount: f.torchflowerBonemeal },
    }),
  },
  {
    id: "pitcher_crop",
    label: "Pitcher plant",
    cat: "farmland",
    block: "pitcher_crop",
    synonyms: ["sniffer", "pitcher pod", "double plant"],
    unit: "pitcher plants",
    build: (f) => ({
      stages: f.pitcherMaxAge,
      model: { kind: "crop" },
      farmland: true,
      light: f.cropLight,
      bonemeal: { kind: "fixed", amount: f.pitcherBonemeal },
    }),
  },
  {
    id: "nether_wart",
    label: "Nether wart",
    cat: "nether",
    block: "nether_wart",
    synonyms: ["wart", "soul sand", "potions", "brewing"],
    unit: "nether wart",
    build: (f) => ({
      stages: f.netherWartMaxAge,
      model: { kind: "fixed", chance: 1 / f.netherWartChance },
      farmland: false,
      light: null,
      bonemeal: null,
    }),
  },
  {
    id: "cocoa",
    label: "Cocoa beans",
    cat: "nether",
    block: "cocoa",
    synonyms: ["cocoa", "jungle log", "cookies"],
    unit: "cocoa beans",
    build: (f) => ({
      stages: f.cocoaMaxAge,
      model: { kind: "fixed", chance: 1 / f.cocoaChance },
      farmland: false,
      light: null,
      bonemeal: { kind: "fixed", amount: 1 },
    }),
  },
  {
    id: "sugar_cane",
    label: "Sugar cane",
    cat: "vertical",
    block: "sugar_cane",
    synonyms: ["reeds", "paper", "sugar"],
    unit: "sugar cane",
    build: (f) => ({
      stages: f.caneMaxAge + 1,
      model: { kind: "always" },
      farmland: false,
      light: null,
      bonemeal: null,
      maxHeight: f.caneMaxHeight,
      perBlock: true,
    }),
  },
  {
    id: "cactus",
    label: "Cactus",
    cat: "vertical",
    block: "cactus",
    synonyms: ["green dye", "sand"],
    unit: "cactus",
    build: (f) => ({
      stages: f.cactusMaxAge + 1,
      model: { kind: "always" },
      farmland: false,
      light: null,
      bonemeal: null,
      maxHeight: f.cactusMaxHeight,
      perBlock: true,
    }),
  },
  {
    id: "bamboo",
    label: "Bamboo",
    cat: "vertical",
    block: "bamboo",
    synonyms: ["scaffolding", "panda", "fuel"],
    unit: "bamboo",
    build: (f) => ({
      stages: 1,
      model: { kind: "fixed", chance: 1 / f.bambooChance },
      farmland: false,
      light: f.bambooLight,
      bonemeal: {
        kind: "blocks",
        min: f.bambooBonemealMin,
        max: f.bambooBonemealMin + f.bambooBonemealSpread - 1,
      },
      maxHeight: f.bambooMaxHeight,
      perBlock: true,
    }),
  },
  {
    id: "kelp",
    label: "Kelp",
    cat: "vertical",
    block: "kelp",
    synonyms: ["dried kelp", "seaweed", "fuel"],
    unit: "kelp",
    build: (f) => ({
      stages: 1,
      model: { kind: "fixed", chance: f.kelpChance },
      farmland: false,
      light: null,
      bonemeal: { kind: "blocks", min: f.growingHeadBonemealBlocks, max: f.growingHeadBonemealBlocks },
      maxHeight: f.growingHeadMaxAge,
      perBlock: true,
    }),
  },
  {
    id: "cave_vines",
    label: "Glow berries (cave vines)",
    cat: "vertical",
    block: "cave_vines",
    synonyms: ["glow berry", "cave vine", "lush caves"],
    unit: "vine blocks",
    build: (f) => ({
      stages: 1,
      model: { kind: "fixed", chance: f.caveVinesChance },
      farmland: false,
      light: null,
      bonemeal: { kind: "blocks", min: f.growingHeadBonemealBlocks, max: f.growingHeadBonemealBlocks },
      maxHeight: f.growingHeadMaxAge,
      perBlock: true,
      berryChance: f.caveVinesBerryChance,
    }),
  },
  {
    id: "twisting_vines",
    label: "Twisting vines",
    cat: "vertical",
    block: "twisting_vines",
    synonyms: ["warped", "nether vine"],
    unit: "vine blocks",
    build: (f) => ({
      stages: 1,
      model: { kind: "fixed", chance: f.twistingChance },
      farmland: false,
      light: null,
      bonemeal: { kind: "blocks", min: f.growingHeadBonemealBlocks, max: f.growingHeadBonemealBlocks },
      maxHeight: f.growingHeadMaxAge,
      perBlock: true,
    }),
  },
  {
    id: "weeping_vines",
    label: "Weeping vines",
    cat: "vertical",
    block: "weeping_vines",
    synonyms: ["crimson", "nether vine"],
    unit: "vine blocks",
    build: (f) => ({
      stages: 1,
      model: { kind: "fixed", chance: f.weepingChance },
      farmland: false,
      light: null,
      bonemeal: { kind: "blocks", min: f.growingHeadBonemealBlocks, max: f.growingHeadBonemealBlocks },
      maxHeight: f.growingHeadMaxAge,
      perBlock: true,
    }),
  },
  {
    id: "sweet_berry_bush",
    label: "Sweet berry bush",
    cat: "bush",
    block: "sweet_berry_bush",
    synonyms: ["berries", "fox", "taiga"],
    unit: "berry harvests",
    build: (f) => ({
      stages: f.berryMaxAge,
      model: { kind: "fixed", chance: 1 / f.berryChance },
      farmland: false,
      light: f.berryLight,
      bonemeal: { kind: "fixed", amount: 1 },
    }),
  },
  {
    id: "sapling",
    label: "Sapling (any tree)",
    cat: "bush",
    block: "oak_sapling",
    synonyms: ["tree", "oak", "spruce", "birch", "grow tree"],
    unit: "trees",
    build: (f) => ({
      stages: 2,
      model: { kind: "fixed", chance: 1 / f.saplingChance },
      farmland: false,
      light: f.saplingLight,
      bonemeal: { kind: "chance", amount: 1, success: f.saplingBonemealSuccess },
    }),
  },
];

// ------------------------------------------------------ animal registry ----

/**
 * Breeding foods. Modern versions read them from item tags (COW_FOOD and
 * friends) whose contents are not part of extracted/, and pre-1.20.5 versions
 * hardcode the same lists as Ingredient constants; both were read out of the
 * decompiled source by hand and are recorded here. Everything numeric about
 * breeding (love duration, cooldown, baby growth, feeding speed up) is parsed.
 */
const ANIMALS = [
  { id: "cow", label: "Cow", entity: "cow", foods: ["Wheat"], synonyms: ["beef", "leather", "milk"] },
  { id: "sheep", label: "Sheep", entity: "sheep", foods: ["Wheat"], synonyms: ["wool", "mutton"] },
  { id: "pig", label: "Pig", entity: "pig", foods: ["Carrot", "Potato", "Beetroot"], synonyms: ["pork", "porkchop"] },
  {
    id: "chicken",
    label: "Chicken",
    entity: "chicken",
    foods: ["Wheat seeds", "Melon seeds", "Pumpkin seeds", "Beetroot seeds"],
    synonyms: ["egg", "feather"],
  },
  {
    id: "rabbit",
    label: "Rabbit",
    entity: "rabbit",
    foods: ["Carrot", "Golden carrot", "Dandelion"],
    synonyms: ["rabbit hide", "rabbit foot"],
  },
  { id: "mooshroom", label: "Mooshroom", entity: "mooshroom", foods: ["Wheat"], synonyms: ["mushroom cow", "stew"] },
  { id: "goat", label: "Goat", entity: "goat", foods: ["Wheat"], synonyms: ["horn", "ram"] },
  { id: "llama", label: "Llama", entity: "llama", foods: ["Hay bale"], synonyms: ["caravan", "trader llama"] },
  {
    id: "horse",
    label: "Horse",
    entity: "horse",
    foods: ["Golden carrot", "Golden apple", "Enchanted golden apple"],
    synonyms: ["donkey", "mule", "saddle"],
  },
  { id: "wolf", label: "Wolf", entity: "wolf", foods: ["Any raw or cooked meat"], synonyms: ["dog", "tame"] },
  { id: "cat", label: "Cat", entity: "cat", foods: ["Raw cod", "Raw salmon"], synonyms: ["ocelot", "kitten"] },
  { id: "panda", label: "Panda", entity: "panda", foods: ["Bamboo"], synonyms: ["bamboo bear"] },
  { id: "fox", label: "Fox", entity: "fox", foods: ["Sweet berries", "Glow berries"], synonyms: ["kit"] },
  { id: "bee", label: "Bee", entity: "bee", foods: ["Any flower"], synonyms: ["honey", "hive"] },
  { id: "turtle", label: "Turtle", entity: "turtle", foods: ["Seagrass"], synonyms: ["scute", "egg"], special: "eggs" },
  { id: "axolotl", label: "Axolotl", entity: "axolotl", foods: ["Bucket of tropical fish"], synonyms: ["bucket", "lush caves"] },
  { id: "camel", label: "Camel", entity: "camel", foods: ["Cactus"], synonyms: ["desert", "mount"] },
  { id: "armadillo", label: "Armadillo", entity: "armadillo", foods: ["Spider eye"], synonyms: ["scute", "wolf armor"] },
  { id: "sniffer", label: "Sniffer", entity: "sniffer", foods: ["Torchflower seeds"], synonyms: ["egg", "archaeology"], special: "eggs" },
  { id: "hoglin", label: "Hoglin", entity: "hoglin", foods: ["Crimson fungus"], synonyms: ["porkchop", "nether"] },
  { id: "strider", label: "Strider", entity: "strider", foods: ["Warped fungus"], synonyms: ["lava", "nether"] },
  { id: "frog", label: "Frog", entity: "frog", foods: ["Slimeball"], synonyms: ["tadpole", "froglight"], special: "tadpole" },
];

// --------------------------------------------------------------- assemble ---

/** Only keep a value when it is not identical across every version. */
function perVersion(pick) {
  const out = {};
  for (const v of versions) out[v] = pick(FACTS[v]);
  const first = JSON.stringify(out[versions[0]]);
  const uniform = versions.every((v) => JSON.stringify(out[v]) === first);
  return { uniform, out };
}

const plantRows = [];
for (const p of PLANTS) {
  const available = versions.filter((v) => {
    if (!hasBlock(v, p.block)) return false;
    try {
      p.build(FACTS[v]);
      return true;
    } catch {
      return false;
    }
  });
  if (!available.length) throw new Error(`plant ${p.id} exists in no version`);
  const models = {};
  for (const v of available) models[v] = p.build(FACTS[v]);
  const first = JSON.stringify(models[available[0]]);
  const uniform = available.every((v) => JSON.stringify(models[v]) === first);
  plantRows.push({
    id: p.id,
    label: p.label,
    cat: CATS[p.cat],
    synonyms: p.synonyms,
    unit: p.unit,
    versions: available,
    model: models[available[0]],
    byVersion: uniform ? null : models,
  });
}

const animalRows = ANIMALS.map((a) => {
  const available = versions.filter((v) => hasEntity(v, a.entity));
  if (!available.length) throw new Error(`animal ${a.id} exists in no version`);
  return {
    id: a.id,
    label: a.label,
    synonyms: a.synonyms,
    foods: a.foods,
    versions: available,
    special: a.special ?? null,
  };
});

const constants = {};
for (const v of versions) {
  const f = FACTS[v];
  constants[v] = {
    randomTickSpeedDefault: f.randomTickSpeedDefault,
    randomTickGameRule: f.randomTickGameRule,
    blocksPerSection: f.blocksPerSection,
    sectionEdge: f.sectionEdge,
    ticksPerSecond: f.ticksPerSecond,
    growthDivisor: f.growthDivisor,
    speedBase: f.speedBase,
    speedFarmland: f.speedFarmland,
    speedMoistFarmland: f.speedMoistFarmland,
    speedNeighbourDivisor: f.speedNeighbourDivisor,
    speedCrowdDivisor: f.speedCrowdDivisor,
    maxMoisture: f.maxMoisture,
    hydrationRadius: f.hydrationRadius,
    hydrationHeight: f.hydrationHeight,
    randomTickGate: f.randomTickGate,
    randomTickGateMethod: f.randomTickGateMethod,
    loveTicks: f.loveTicks,
    breedCooldownTicks: f.breedCooldownTicks,
    babyGrowTicks: f.babyGrowTicks,
    feedFraction: f.feedFraction,
    farmlandClass: f.farmlandClass,
  };
}

// Version boundaries worth telling the reader about, derived by diffing the
// parsed facts rather than asserted from memory.
const changelog = [];
{
  const rule = perVersion((f) => f.randomTickGameRule);
  if (!rule.uniform) {
    const first = versions.find((v) => rule.out[v] !== rule.out[versions[0]]);
    changelog.push({
      version: first,
      text: `The random tick game rule moved from "${rule.out[versions[0]]}" to "${rule.out[first]}" and its class moved to world/level/gamerules/GameRules.java. The default value stayed ${constants[first].randomTickSpeedDefault} and the growth math did not change.`,
    });
  }
  const farmClass = perVersion((f) => f.farmlandClass);
  if (!farmClass.uniform) {
    const first = versions.find((v) => farmClass.out[v] !== farmClass.out[versions[0]]);
    changelog.push({
      version: first,
      text: `${farmClass.out[versions[0]]} was renamed ${farmClass.out[first]} and the "is this farmland" check under a crop became a block tag lookup. Growth speed weights are unchanged, so every number on this page is the same before and after.`,
    });
  }
  const torchflowerFirst = versions.find((v) => FACTS[v].present.torchflower);
  if (torchflowerFirst && torchflowerFirst !== versions[0]) {
    changelog.push({
      version: torchflowerFirst,
      text: "Torchflower and pitcher plant crops arrived with the sniffer. Torchflower is the only crop that skips its growth attempt outright, and both take a flat one stage per bone meal instead of the usual two to five.",
    });
  }
  const caveFirst = versions.find((v) => FACTS[v].present.caveVines);
  if (caveFirst && caveFirst !== versions[0]) {
    changelog.push({
      version: caveFirst,
      text: `Cave vines (glow berries) do not exist in ${versions[0]}. From ${caveFirst} onward they use the same one roll per random tick model as kelp and the nether vines.`,
    });
  }
  const gate = perVersion((f) => f.randomTickGate);
  if (!gate.uniform) {
    const first = versions.find((v) => gate.out[v] !== gate.out[versions[0]]);
    changelog.push({
      version: first,
      text: `Random ticking stopped depending on mob spawning. Before this, ServerChunkCache.tickChunks called Level.tickChunk inside the natural spawning branch, gated on ${[
        ...new Set(
          versions
            .filter((v) => constants[v].randomTickGate === "player-near-for-spawning")
            .map((v) => constants[v].randomTickGateMethod),
        ),
      ].join(" and later ")}, so a chunk with no player close enough for spawning grew nothing at all. From ${first} the call moved to ${constants[first].randomTickGateMethod}, which follows the block ticking chunks instead. It also means live growth can only be measured on a headless server from ${first} onward, because with nobody online the older loop never fires.`,
    });
  }
  const cactusFlowerFirst = versions.find((v) => FACTS[v].present.cactusFlower);
  if (cactusFlowerFirst) {
    changelog.push({
      version: cactusFlowerFirst,
      text: "Cactus gained a flower that can appear on top of a fully grown cactus column. A flower occupies the space a new cactus block would use, so the timings here assume the block above stays clear.",
    });
  }
}

// ------------------------------------------------------------------ emit ----

const HEADER = `// GENERATED by mc-pipeline/12-emit-growth-data.mjs. Do not edit by hand.
// Numbers are parsed out of decompiled server source under
// mc-pipeline/work/<version>/src/ (CropBlock, ${constants[versions[versions.length - 1]].farmlandClass},
// StemBlock, NetherWartBlock, CocoaBlock, SweetBerryBushBlock, SaplingBlock,
// SugarCaneBlock, CactusBlock, the bamboo stalk block, GrowingPlantHeadBlock and
// its subclasses, ServerLevel, GameRules, Animal, AgeableMob). Plant and animal
// availability comes from the per-version block and entity registries in
// mc-pipeline/extracted/. No game code is copied; only values are read.`;

function sq(s) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

const payload = JSON.stringify(
  sortKeys({
    versions,
    constants,
    plants: plantRows,
    animals: animalRows,
    changelog,
  }),
);

const dataTs = `${HEADER}

/** How a plant turns one random tick into one growth step. */
export type GrowthModel =
  /** CropBlock: 1 / (floor(25 / speed) + 1), with an optional attempt gate. */
  | { kind: "crop"; gate?: number }
  /** A flat chance per random tick, independent of farmland. */
  | { kind: "fixed"; chance: number }
  /** Every random tick advances the block (sugar cane, cactus). */
  | { kind: "always" };

/** How one bone meal advances a plant, when bone meal works on it at all. */
export type BonemealModel =
  /** Uniform integer stages in [min, max] (the shared CropBlock rule). */
  | { kind: "uniform"; min: number; max: number }
  /** The uniform roll floor-divided by \`divisor\`, so it can advance nothing. */
  | { kind: "divided"; min: number; max: number; divisor: number }
  /** A flat number of stages. */
  | { kind: "fixed"; amount: number }
  /** A flat number of stages, applied only with probability \`success\`. */
  | { kind: "chance"; amount: number; success: number }
  /** Whole blocks added at once (bamboo, kelp, vines). */
  | { kind: "blocks"; min: number; max: number };

export interface PlantModel {
  /** Successful growth steps from freshly planted to harvestable. */
  stages: number;
  model: GrowthModel;
  /** True when the farmland below drives the speed (hydration and layout). */
  farmland: boolean;
  /** Minimum light level the growth check requires, or null when it has none. */
  light: number | null;
  bonemeal: BonemealModel | null;
  /** Stems: how many horizontal sides the fruit placement roll picks from. */
  fruitSides?: number;
  /** Stacking plants: the height cap on the column. */
  maxHeight?: number;
  /** True when \`stages\` counts one new block rather than a whole harvest. */
  perBlock?: boolean;
  /** Cave vines: chance a newly grown block carries berries. */
  berryChance?: number;
}

export interface PlantInfo {
  id: string;
  label: string;
  cat: string;
  synonyms: string[];
  /** What one harvest yields, for the throughput copy. */
  unit: string;
  /** Versions that ship this plant. */
  versions: string[];
  /** The model for the oldest supported version. */
  model: PlantModel;
  /** Per-version models, only when they are not all identical. */
  byVersion: Record<string, PlantModel> | null;
}

export interface AnimalInfo {
  id: string;
  label: string;
  synonyms: string[];
  /** Breeding foods, one entry per accepted item. */
  foods: string[];
  versions: string[];
  /** Non-standard reproduction: "eggs", "tadpole", or null. */
  special: string | null;
}

export interface GrowthConstants {
  randomTickSpeedDefault: number;
  randomTickGameRule: string;
  /** Blocks in one chunk section, the denominator of the random tick chance. */
  blocksPerSection: number;
  sectionEdge: number;
  ticksPerSecond: number;
  /** The 25 in CropBlock's 1 / (floor(25 / speed) + 1). */
  growthDivisor: number;
  speedBase: number;
  speedFarmland: number;
  speedMoistFarmland: number;
  speedNeighbourDivisor: number;
  speedCrowdDivisor: number;
  maxMoisture: number;
  hydrationRadius: number;
  hydrationHeight: number;
  /** Which chunks get random ticked: see the emitter for the two eras. */
  randomTickGate: string;
  /** The method the gate is spelled with, for citation in the page copy. */
  randomTickGateMethod: string;
  loveTicks: number;
  breedCooldownTicks: number;
  babyGrowTicks: number;
  feedFraction: number;
  farmlandClass: string;
}

interface GrowthData {
  versions: string[];
  constants: Record<string, GrowthConstants>;
  plants: PlantInfo[];
  animals: AnimalInfo[];
  changelog: { version: string; text: string }[];
}

// Parsed from a string literal so the module stays trivial for tsc and eslint.
const DATA: GrowthData = JSON.parse(
  ${sq(payload)},
) as GrowthData;

export const GROWTH_VERSIONS: string[] = DATA.versions;
export const CONSTANTS: Record<string, GrowthConstants> = DATA.constants;
export const PLANTS: PlantInfo[] = DATA.plants;
export const ANIMALS: AnimalInfo[] = DATA.animals;
export const VERSION_CHANGELOG: { version: string; text: string }[] = DATA.changelog;

export const PLANT_BY_ID: Map<string, PlantInfo> = new Map(PLANTS.map((p) => [p.id, p]));
export const ANIMAL_BY_ID: Map<string, AnimalInfo> = new Map(ANIMALS.map((a) => [a.id, a]));

/** The plant's model for one version, falling back to the shared model. */
export function plantModel(plant: PlantInfo, version: string): PlantModel {
  return plant.byVersion?.[version] ?? plant.model;
}
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.ts"), dataTs);

const bytes = Buffer.byteLength(dataTs);
console.log(`versions: ${versions.join(", ")}`);
console.log(`plants: ${plantRows.length} (${plantRows.filter((p) => p.byVersion).length} version dependent)`);
console.log(`animals: ${animalRows.length}`);
console.log(`changelog entries: ${changelog.length}`);
console.log(`data.ts: ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
if (bytes >= SIZE_LIMIT) {
  console.error(`data.ts exceeds the 2 MB precache limit (${bytes} bytes)`);
  process.exit(1);
}
