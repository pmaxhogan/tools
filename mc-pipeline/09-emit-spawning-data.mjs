// Emit the committed data modules for minecraft-mob-spawning-calculator.
//
// Two inputs, both cached under mc-pipeline/extracted/<version>/ so later runs
// work offline and so the committed cache is the reviewable record:
//
//   1. spawning-biomes.json  - the per-biome spawner lists (mob, weight,
//      minCount, maxCount), spawn costs, and creature spawn probability,
//      trimmed out of the misode/mcmeta <version>-summary biome dump. Only
//      those three fields are kept; the feature and carver lists that make up
//      most of the raw dump are irrelevant here and would bloat the repo.
//   2. spawn-placements.json - the per-mob spawn placement type, heightmap,
//      and spawn-rule predicate NAME, parsed out of the decompiled
//      net/minecraft/world/entity/SpawnPlacements.java under
//      mc-pipeline/work/<version>/src/ when that tree is present. Only the
//      registration table is read (entity id, placement enum, heightmap enum,
//      Class::method reference); no Java is transcribed. Once cached, later
//      runs no longer need work/, which is gitignored.
//
// Output:
//   src/tools/minecraft-mob-spawning-calculator/biomes.ts  (eager, small)
//     the biome registry meta.ts needs: display names, dimension, per-version
//     availability, and the grouped select spec.
//   src/tools/minecraft-mob-spawning-calculator/data.ts    (lazy, larger)
//     interned mob ids, deduplicated spawner entry lists, spawn costs, and
//     the per-version spawn-rule classification.
//
// Idempotent: sorted keys, a stable pool order, and a final pass through the
// repo's prettier, so an unchanged input produces a byte-identical output.
// Node builtins plus prettier, which is already a devDependency.
// Usage: node mc-pipeline/09-emit-spawning-data.mjs [versionId ...]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTRACTED = join(ROOT, "extracted");
const WORK = join(ROOT, "work");
const OUT_DIR = join(ROOT, "..", "src", "tools", "minecraft-mob-spawning-calculator");
const SIZE_LIMIT = 2 * 1024 * 1024;
const RAW = "https://raw.githubusercontent.com/misode/mcmeta";

// Release order matters for the version picker (oldest first).
const KNOWN_VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];

/**
 * Dimension classification. Biome JSON carries no dimension field, so the two
 * non-overworld sets are listed by name. Both sets have been stable across
 * every shipped version (1.16 introduced the four extra nether biomes and the
 * end set has not changed), and the emitter fails loudly on an unknown biome
 * that looks nether or end shaped so a future version cannot silently land in
 * the wrong picker group.
 */
const NETHER_BIOMES = new Set([
  "nether_wastes",
  "crimson_forest",
  "warped_forest",
  "soul_sand_valley",
  "basalt_deltas",
]);
const END_BIOMES = new Set([
  "the_end",
  "end_barrens",
  "end_highlands",
  "end_midlands",
  "small_end_islands",
]);
/** Not reachable in normal play, so never offered as a choice. */
const EXCLUDED_BIOMES = new Set(["the_void"]);

/**
 * The four shared spawn-rule helpers and how each treats light. Anything else
 * registered in SpawnPlacements is a mob's own static method, resolved one
 * level deeper by reading which of these it delegates to (see classifyRule).
 */
const BASE_RULES = {
  "Monster::checkMonsterSpawnRules": "dark",
  "Monster::checkAnyLightMonsterSpawnRules": "any-light",
  "Monster::checkSurfaceMonstersSpawnRules": "surface",
  "Mob::checkMobSpawnRules": "any-light",
};

/** Extra picker search words for biomes people look up by nickname. */
const BIOME_SYNONYMS = {
  mushroom_fields: ["mooshroom", "no monsters", "mushroom island"],
  soul_sand_valley: ["skeleton", "fossil"],
  nether_wastes: ["hell", "zombie pigman", "piglin"],
  warped_forest: ["endermen", "enderman farm"],
  crimson_forest: ["hoglin", "piglin"],
  basalt_deltas: ["magma cube"],
  swamp: ["slime", "witch", "hut"],
  the_end: ["enderman", "end island"],
  end_highlands: ["end city", "enderman"],
  deep_dark: ["warden", "sculk", "ancient city"],
  dripstone_caves: ["cave"],
  lush_caves: ["axolotl", "cave"],
  desert: ["husk"],
  frozen_ocean: ["stray", "polar bear"],
  jungle: ["ocelot", "parrot"],
  ocean: ["squid", "drowned", "guardian"],
  plains: ["grassland", "village"],
  taiga: ["wolf"],
  snowy_slopes: ["goat", "stray"],
  savanna: ["horse"],
  warm_ocean: ["pufferfish", "tropical fish"],
};

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Single-quoted JS string literal (the prettier-stable form for JSON payloads). */
function sq(s) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function titleCase(id) {
  return id
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function dimensionOf(id) {
  if (NETHER_BIOMES.has(id)) return "nether";
  if (END_BIOMES.has(id)) return "end";
  if (/(^|_)nether(_|$)/.test(id) || /(^|_)end(_|$)/.test(id)) {
    throw new Error(
      `biome "${id}" looks like a nether or end biome but is not in the classification lists; ` +
        `update NETHER_BIOMES / END_BIOMES in 09-emit-spawning-data.mjs`,
    );
  }
  return "overworld";
}

// ------------------------------------------------------------ input step 1 --

/** Trim the mcmeta biome summary down to the spawn-relevant fields. */
function trimBiomes(raw) {
  const biomes = {};
  for (const id of Object.keys(raw).sort()) {
    if (EXCLUDED_BIOMES.has(id)) continue;
    const src = raw[id] ?? {};
    const spawners = {};
    for (const cat of Object.keys(src.spawners ?? {}).sort()) {
      // MISC is filtered out of SPAWNING_CATEGORIES in NaturalSpawner, so it
      // can never spawn naturally and is never offered as a choice.
      if (cat === "misc") continue;
      const list = (src.spawners[cat] ?? []).map((s) => ({
        type: s.type,
        weight: s.weight ?? 0,
        minCount: s.minCount ?? s.min_count ?? 1,
        maxCount: s.maxCount ?? s.max_count ?? 1,
      }));
      spawners[cat] = list;
    }
    const costs = {};
    for (const mob of Object.keys(src.spawn_costs ?? {}).sort()) {
      const c = src.spawn_costs[mob] ?? {};
      costs[mob] = {
        charge: c.charge ?? c.spawn_cost_charge ?? 0,
        energyBudget: c.energy_budget ?? c.max_spawn_cost ?? 0,
      };
    }
    biomes[id] = {
      creatureSpawnProbability: src.creature_spawn_probability ?? 0.1,
      spawners,
      spawnCosts: costs,
    };
  }
  return biomes;
}

async function loadBiomes(version) {
  const dir = ensureDir(join(EXTRACTED, version));
  const cache = join(dir, "spawning-biomes.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));

  const url = `${RAW}/${version}-summary/data/worldgen/biome/data.min.json`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const doc = {
    version,
    source: url,
    biomes: trimBiomes(await res.json()),
  };
  writeFileSync(cache, JSON.stringify(doc, null, 2));
  console.log(`[${version}] cached ${Object.keys(doc.biomes).length} biomes`);
  return doc;
}

// ------------------------------------------------------------ input step 2 --

/**
 * Parse the SpawnPlacements registration table out of the decompiled source.
 * Reads only the argument tuples of `register(...)`: entity constant, spawn
 * placement enum, heightmap enum, and the `Class::method` predicate name.
 */
function javaFileIndex(version) {
  const root = join(WORK, version, "src");
  const index = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".java") && !index.has(entry.name)) index.set(entry.name, full);
    }
  };
  walk(root);
  return index;
}

/** Body text of `static boolean <method>(...)` in a class file, brace matched. */
function methodBody(index, cls, method) {
  const file = index.get(`${cls}.java`);
  if (!file) return null;
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(`boolean ${method}(`);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/**
 * Classify one registered predicate into how it treats light. The four shared
 * helpers map directly; a mob's own static method is resolved by reading which
 * helper (or which brightness call) its body uses.
 */
function classifyRule(index, predicate) {
  const base = BASE_RULES[predicate];
  if (base) return { rule: base, extra: false };
  const [cls, method] = predicate.split("::");
  const body = methodBody(index, cls, method);
  if (body === null) return { rule: "custom", extra: true };
  if (/checkSurfaceMonstersSpawnRules/.test(body)) return { rule: "surface", extra: true };
  if (/checkMonsterSpawnRules|isDarkEnoughToSpawn/.test(body)) return { rule: "dark", extra: true };
  if (/getMaxLocalRawBrightness|getBrightness\(/.test(body))
    return { rule: "own-light", extra: true };
  return { rule: "any-light", extra: true };
}

function parsePlacements(version) {
  const file = join(
    WORK,
    version,
    "src",
    "net",
    "minecraft",
    "world",
    "entity",
    "SpawnPlacements.java",
  );
  if (!existsSync(file)) return null;
  const index = javaFileIndex(version);
  const flat = readFileSync(file, "utf8").replace(/\s+/g, " ");
  const re =
    /register\(\s*EntityTypes?\.([A-Z0-9_]+)\s*,\s*(?:SpawnPlacements\.Type\.|SpawnPlacementTypes\.)([A-Z_]+)\s*,\s*Heightmap\.Types\.([A-Z_]+)\s*,\s*([A-Za-z0-9_]+)::([A-Za-z0-9_]+)\s*\)/g;
  const placements = {};
  let m;
  while ((m = re.exec(flat)) !== null) {
    const [, constant, placement, heightmap, cls, method] = m;
    const predicate = `${cls}::${method}`;
    const { rule, extra } = classifyRule(index, predicate);
    placements[`minecraft:${constant.toLowerCase()}`] = {
      placement,
      heightmap,
      predicate,
      rule,
      extraConditions: extra,
    };
  }
  if (!Object.keys(placements).length) {
    throw new Error(`parsed zero placements out of ${file}; the register() shape changed`);
  }
  return placements;
}

function loadPlacements(version) {
  const dir = ensureDir(join(EXTRACTED, version));
  const cache = join(dir, "spawn-placements.json");
  const parsed = parsePlacements(version);
  if (parsed) {
    const doc = {
      version,
      source: "net/minecraft/world/entity/SpawnPlacements.java (decompiled, local only)",
      placements: parsed,
    };
    writeFileSync(cache, JSON.stringify(doc, null, 2));
    return doc;
  }
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  throw new Error(
    `no SpawnPlacements source for ${version} under mc-pipeline/work/ and no cached ` +
      `mc-pipeline/extracted/${version}/spawn-placements.json. Run 02-decompile.mjs first.`,
  );
}

// ----------------------------------------------------------------- emitters --

function tsHeader(script) {
  return (
    `// GENERATED by mc-pipeline/${script}. Do not edit by hand.\n` +
    `// Sources: per-biome spawner lists from the vanilla worldgen biome data\n` +
    `// (mc-pipeline/extracted/<version>/spawning-biomes.json) and the spawn\n` +
    `// placement registration table read out of the decompiled server source\n` +
    `// (mc-pipeline/extracted/<version>/spawn-placements.json).\n`
  );
}

function emitBiomes(versions, byVersion) {
  // biome id -> versions that ship it
  const ids = new Set();
  for (const v of versions) for (const id of Object.keys(byVersion[v].biomes)) ids.add(id);
  const sorted = [...ids].sort();

  const rows = sorted.map((id) => {
    const present = versions
      .map((v, i) => (byVersion[v].biomes[id] ? i : -1))
      .filter((i) => i >= 0);
    const row = [id, titleCase(id), dimensionOf(id), BIOME_SYNONYMS[id] ?? []];
    if (present.length !== versions.length) row.push(present);
    return row;
  });

  const out = `${tsHeader("09-emit-spawning-data.mjs")}import type { SelectGroup } from "../types";

export type SpawnDimension = "overworld" | "nether" | "end";

export interface BiomeInfo {
  /** Biome id without the namespace, e.g. "soul_sand_valley". */
  id: string;
  /** Display name for pickers and results. */
  name: string;
  /** Dimension the biome belongs to. */
  dim: SpawnDimension;
  /** Versions that ship this biome. */
  versions: string[];
  /** Extra search words for the picker. */
  synonyms: string[];
}

/** Version ids with extracted spawner data, oldest first. */
export const SPAWN_VERSIONS: string[] = ${JSON.stringify(versions)};

const DIMS: SpawnDimension[] = ["overworld", "nether", "end"];

type Row = [string, string, string, string[]] | [string, string, string, string[], number[]];

// [id, name, dimension, synonyms, versionIndexes?]; versionIndexes omitted
// when the biome ships in every version. Parsed from a string literal so the
// module stays prettier-stable regardless of row lengths.
const ROWS: Row[] = JSON.parse(
  ${sq(JSON.stringify(rows))},
) as Row[];

export const BIOMES: BiomeInfo[] = ROWS.map((r) => ({
  id: r[0],
  name: r[1],
  dim: r[2] as SpawnDimension,
  versions: (r[4] as number[] | undefined)
    ? (r[4] as number[]).map((i) => SPAWN_VERSIONS[i])
    : SPAWN_VERSIONS,
  synonyms: r[3] as string[],
}));

export const BIOMES_BY_ID: Record<string, BiomeInfo> = Object.fromEntries(
  BIOMES.map((b) => [b.id, b]),
);

const DIM_LABELS: Record<SpawnDimension, { label: string; synonyms: string[] }> = {
  overworld: { label: "Overworld", synonyms: ["surface", "cave", "ocean"] },
  nether: { label: "Nether", synonyms: ["hell", "fortress", "piglin"] },
  end: { label: "The End", synonyms: ["ender", "enderman", "end city"] },
};

/** Grouped select spec for the biome picker, one group per dimension. */
export const BIOME_GROUPS: SelectGroup[] = DIMS.map((dim) => ({
  label: DIM_LABELS[dim].label,
  synonyms: DIM_LABELS[dim].synonyms,
  options: BIOMES.filter((b) => b.dim === dim).map((b) => ({
    value: b.id,
    label: b.name,
    synonyms: b.synonyms,
  })),
})).filter((g) => g.options.length > 0);
`;
  return out;
}

function emitData(versions, byVersion, placements) {
  // Intern mob ids across every version.
  const mobIds = new Set();
  for (const v of versions) {
    for (const b of Object.values(byVersion[v].biomes)) {
      for (const list of Object.values(b.spawners)) for (const e of list) mobIds.add(e.type);
      for (const mob of Object.keys(b.spawnCosts)) mobIds.add(mob);
    }
  }
  const mobs = [...mobIds].sort();
  const mobIndex = new Map(mobs.map((m, i) => [m, i]));

  // Category ids in a stable order, union across versions.
  const catSet = new Set();
  for (const v of versions) {
    for (const b of Object.values(byVersion[v].biomes)) {
      for (const cat of Object.keys(b.spawners)) catSet.add(cat);
    }
  }
  const cats = [...catSet].sort();

  // Deduplicate entry lists: many biomes share the same monster list, and most
  // lists are identical across versions, so one pool keeps the module small.
  const pool = [];
  const poolIndex = new Map();
  function intern(list) {
    const packed = list.map((e) => [mobIndex.get(e.type), e.weight, e.minCount, e.maxCount]);
    const key = JSON.stringify(packed);
    let idx = poolIndex.get(key);
    if (idx === undefined) {
      idx = pool.length;
      pool.push(packed);
      poolIndex.set(key, idx);
    }
    return idx;
  }

  const spawners = {};
  const costs = {};
  const creatureProb = {};
  for (const v of versions) {
    const vs = {};
    const vc = {};
    const vp = {};
    for (const id of Object.keys(byVersion[v].biomes).sort()) {
      const b = byVersion[v].biomes[id];
      const perCat = {};
      for (const cat of cats) {
        const list = b.spawners[cat];
        if (!list || !list.length) continue;
        perCat[cat] = intern(list);
      }
      vs[id] = perCat;
      const costEntries = Object.keys(b.spawnCosts).sort();
      if (costEntries.length) {
        vc[id] = costEntries.map((m) => [
          mobIndex.get(m),
          b.spawnCosts[m].charge,
          b.spawnCosts[m].energyBudget,
        ]);
      }
      vp[id] = b.creatureSpawnProbability;
    }
    spawners[v] = vs;
    costs[v] = vc;
    creatureProb[v] = vp;
  }

  // Spawn-rule classification per version, restricted to mobs that appear in
  // at least one spawner list (the picker never shows the rest).
  const rules = {};
  for (const v of versions) {
    const perVersion = {};
    const table = placements[v].placements;
    for (const mob of mobs) {
      const entry = table[mob];
      if (!entry) continue;
      perVersion[mob] = [
        entry.rule,
        entry.placement,
        entry.predicate,
        entry.extraConditions ? 1 : 0,
      ];
    }
    rules[v] = perVersion;
  }

  const json = (v) => sq(JSON.stringify(v));

  return `${tsHeader("09-emit-spawning-data.mjs")}
/**
 * How the game picks what spawns: a weighted list per biome per mob category.
 * One entry is [mobIndex, weight, minCount, maxCount]; the weight is the
 * relative pick weight inside the category and min/max are the pack size the
 * game rolls once a type has been chosen.
 */
export type PackedEntry = [number, number, number, number];

/**
 * How a mob's spawn rule treats light, classified from the predicate
 * registered in SpawnPlacements. A mob's own static predicate is resolved one
 * level deeper by reading which shared helper its body delegates to:
 *
 * - "dark"       reaches Monster#checkMonsterSpawnRules or #isDarkEnoughToSpawn
 * - "surface"    reaches Monster#checkSurfaceMonstersSpawnRules: dark plus sky
 * - "any-light"  never consults light at all
 * - "own-light"  applies its own brightness test rather than the shared one
 * - "custom"     could not be classified from the source
 */
export type RuleClass = "dark" | "surface" | "any-light" | "own-light" | "custom";

/**
 * [ruleClass, placementType, the predicate the classification came from,
 * 1 when the mob adds conditions beyond the shared helper].
 */
export type PackedRule = [RuleClass, string, string, 0 | 1];

/** Interned mob ids; every packed entry indexes into this list. */
export const MOB_IDS: string[] = JSON.parse(${json(mobs)}) as string[];

/** Mob category ids seen in any shipped version, in stable order. */
export const CATEGORY_IDS: string[] = JSON.parse(${json(cats)}) as string[];

/** Deduplicated weighted entry lists; biome tables index into this pool. */
export const ENTRY_POOL: PackedEntry[][] = JSON.parse(${json(pool)}) as PackedEntry[][];

/** version -> biome id -> category -> ENTRY_POOL index. */
export const SPAWNERS: Record<string, Record<string, Record<string, number>>> = JSON.parse(
  ${json(spawners)},
) as Record<string, Record<string, Record<string, number>>>;

/**
 * version -> biome id -> [mobIndex, charge, energyBudget]. Spawn costs are the
 * density brake used by a handful of biomes (soul sand valley skeletons, the
 * end's endermen): a spawn is refused when the surrounding potential energy
 * would exceed the budget.
 */
export const SPAWN_COSTS: Record<string, Record<string, Array<[number, number, number]>>> =
  JSON.parse(${json(costs)}) as Record<string, Record<string, Array<[number, number, number]>>>;

/** version -> biome id -> creature spawn probability used at chunk generation. */
export const CREATURE_PROBABILITY: Record<string, Record<string, number>> = JSON.parse(
  ${json(creatureProb)},
) as Record<string, Record<string, number>>;

/** version -> mob id -> packed spawn rule classification. */
export const MOB_RULES: Record<string, Record<string, PackedRule>> = JSON.parse(${json(rules)}) as Record<
  string,
  Record<string, PackedRule>
>;
`;
}

// ---------------------------------------------------------------- pipeline --

const only = process.argv.slice(2);
const versions = (only.length ? only : KNOWN_VERSIONS).filter((v) => KNOWN_VERSIONS.includes(v));
if (!versions.length) {
  console.error("no known versions selected");
  process.exit(1);
}

const byVersion = {};
const placements = {};
for (const v of versions) {
  byVersion[v] = await loadBiomes(v);
  placements[v] = loadPlacements(v);
  const biomeCount = Object.keys(byVersion[v].biomes).length;
  const ruleCount = Object.keys(placements[v].placements).length;
  console.log(`[${v}] ${biomeCount} biomes, ${ruleCount} spawn placements`);
}

ensureDir(OUT_DIR);

/**
 * Format with the repo's own prettier so the committed output matches what
 * `npm run lint` and a developer's editor would produce, and so re-running the
 * emitter never churns the diff. Prettier is a devDependency and this script
 * is never part of the Cloudflare build.
 */
const prettier = await import("prettier");
async function format(name, body) {
  const path = join(OUT_DIR, name);
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(body, { ...config, filepath: path });
}

const biomesTs = await format("biomes.ts", emitBiomes(versions, byVersion));
const dataTs = await format("data.ts", emitData(versions, byVersion, placements));
writeFileSync(join(OUT_DIR, "biomes.ts"), biomesTs);
writeFileSync(join(OUT_DIR, "data.ts"), dataTs);

for (const [name, body] of [
  ["biomes.ts", biomesTs],
  ["data.ts", dataTs],
]) {
  const bytes = Buffer.byteLength(body);
  console.log(`${name}: ${(bytes / 1024).toFixed(1)} KiB`);
  if (bytes > SIZE_LIMIT) {
    console.error(`${name} exceeds the ${SIZE_LIMIT} byte service worker precache limit`);
    process.exit(1);
  }
}
console.log("done");
