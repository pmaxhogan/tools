// Emit the committed loot data modules for minecraft-loot-table-calculator.
//
// Reads the raw vanilla loot table JSON extracted from mcmeta under
// mc-pipeline/extracted/<version>/loot/{blocks,chests,entities,gameplay}/ and
// writes two generated TypeScript modules:
//
//   src/tools/minecraft-loot-table-calculator/data.ts    (lazy, big)
//     - a deduplicated pool of cleaned loot table JSON documents plus a
//       version -> tableId -> pool-index map. Identical tables shared across
//       versions are stored once, which is what keeps the module far under
//       the 2 MB service worker precache limit.
//   src/tools/minecraft-loot-table-calculator/tables.ts  (eager, small)
//     - the human-readable table registry: display names, category grouping,
//       per-version availability, and the grouped select spec for meta.ts.
//
// Cleaning strips only fields that cannot affect drop probabilities or
// counts: `random_sequence`, the top-level `type`, and cosmetic item
// functions (set_nbt, set_potion, enchant_randomly, furnace_smelt, ...).
// `explosion_decay` is also dropped: without an explosion radius in the loot
// context it is a no-op in game code (ApplyExplosionDecay), and the tool only
// models mining/kill/fishing contexts. Everything the probability engine
// needs (pools, rolls, entries, weights, quality, conditions, count
// functions) is preserved verbatim. `loot_table` references are normalized
// to a `ref` field holding this tool's table id; tables whose references
// cannot be resolved within the extracted set are excluded with a note.
//
// Idempotent: output is deterministic (sorted keys, stable pool order), so
// re-running with unchanged inputs produces byte-identical files.
// Node builtins only. Usage: node mc-pipeline/05-emit-loot-data.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXTRACTED = join(ROOT, "extracted");
const OUT_DIR = join(ROOT, "..", "src", "tools", "minecraft-loot-table-calculator");
const SIZE_LIMIT = 2 * 1024 * 1024;

// Release order matters for the version picker (oldest first).
const KNOWN_VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];
const CATEGORIES = ["blocks", "entities", "gameplay", "chests"];

/** Item functions that can change drop counts or presence. Everything else is cosmetic. */
const COUNT_FUNCTIONS = new Set([
  "minecraft:set_count",
  "minecraft:apply_bonus",
  "minecraft:limit_count",
  "minecraft:looting_enchant",
  "minecraft:enchanted_count_increase",
]);

const versions = KNOWN_VERSIONS.filter((v) => existsSync(join(EXTRACTED, v, "loot")));
if (!versions.length) {
  console.error("no extracted loot data found under mc-pipeline/extracted/");
  process.exit(1);
}

/** "minecraft:gameplay/fishing/junk" -> "gameplay/fishing_junk" (extracted file layout). */
function refToId(ref) {
  const path = ref.replace(/^minecraft:/, "");
  const segs = path.split("/");
  if (segs.length === 1) return segs[0];
  return `${segs[0]}/${segs.slice(1).join("_")}`;
}

/** Deep-clean one loot table document. Returns { table, refs } */
function cleanTable(raw) {
  const refs = [];

  function cleanFunctions(fns) {
    const kept = (fns ?? []).filter((f) => COUNT_FUNCTIONS.has(f.function));
    return kept.length ? kept.map(sortKeys) : undefined;
  }

  function cleanEntry(entry) {
    const e = { ...entry };
    if (e.type === "minecraft:loot_table") {
      const target = e.value ?? e.name;
      e.ref = refToId(target);
      refs.push(e.ref);
      delete e.value;
      delete e.name;
    }
    if (e.children) e.children = e.children.map(cleanEntry);
    const fns = cleanFunctions(e.functions);
    if (fns) e.functions = fns;
    else delete e.functions;
    if (e.conditions) e.conditions = e.conditions.map(sortKeys);
    return sortKeys(e);
  }

  function cleanPool(pool) {
    const p = { ...pool };
    p.entries = (p.entries ?? []).map(cleanEntry);
    if (p.conditions) p.conditions = p.conditions.map(sortKeys);
    const fns = cleanFunctions(p.functions);
    if (fns) p.functions = fns;
    else delete p.functions;
    return sortKeys(p);
  }

  const table = { pools: (raw.pools ?? []).map(cleanPool) };
  const fns = cleanFunctions(raw.functions);
  if (fns) table.functions = fns;
  return { table: sortKeys(table), refs };
}

/** Recursively sort object keys so canonical JSON is stable across runs. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- load ----
/** version -> Map(tableId -> { table, refs }) */
const perVersion = new Map();
for (const v of versions) {
  const map = new Map();
  for (const cat of CATEGORIES) {
    const dir = join(EXTRACTED, v, "loot", cat);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      const id = `${cat}/${file.replace(/\.json$/, "")}`;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      map.set(id, cleanTable(raw));
    }
  }
  perVersion.set(v, map);
}

// ------------------------------------------------- validate references ----
// A table whose loot_table references cannot all be resolved (transitively)
// within the same version's extracted set would silently compute wrong
// numbers, so it is excluded instead.
const excluded = [];
for (const [v, map] of perVersion) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, { refs }] of map) {
      const missing = refs.filter((r) => !map.has(r));
      if (missing.length) {
        excluded.push(`${v}: ${id} (missing ref ${missing.join(", ")})`);
        map.delete(id);
        changed = true;
      }
    }
  }
}

// ------------------------------------------------------------- dedupe ----
const pool = [];
const poolIndex = new Map(); // canonical json -> index
const tables = {}; // version -> tableId -> pool index
for (const v of versions) {
  tables[v] = {};
  for (const [id, { table }] of [...perVersion.get(v)].sort(([a], [b]) => a.localeCompare(b))) {
    const canon = JSON.stringify(table);
    if (!poolIndex.has(canon)) {
      poolIndex.set(canon, pool.length);
      pool.push(table);
    }
    tables[v][id] = poolIndex.get(canon);
  }
}

// ----------------------------------------------------------- registry ----
const SPECIAL_NAMES = {
  "blocks/short_grass": "Short Grass",
  "blocks/grass": "Grass",
  "chests/abandoned_mineshaft": "Abandoned Mineshaft Chest",
  "chests/ancient_city": "Ancient City Chest",
  "chests/bastion_treasure": "Bastion Treasure Chest",
  "chests/buried_treasure": "Buried Treasure Chest",
  "chests/desert_pyramid": "Desert Pyramid Chest",
  "chests/end_city_treasure": "End City Chest",
  "chests/jungle_temple": "Jungle Temple Chest",
  "chests/nether_bridge": "Nether Fortress Chest",
  "chests/shipwreck_treasure": "Shipwreck Treasure Chest",
  "chests/simple_dungeon": "Dungeon Chest",
  "chests/stronghold_library": "Stronghold Library Chest",
  "chests/trial_chambers_reward": "Trial Chambers Reward Vault",
  "gameplay/fishing": "Fishing",
  "gameplay/fishing_fish": "Fishing (fish pool)",
  "gameplay/fishing_junk": "Fishing (junk pool)",
  "gameplay/fishing_treasure": "Fishing (treasure pool)",
  "gameplay/cat_morning_gift": "Cat Morning Gift",
  "gameplay/hero_of_the_village_armorer_gift": "Hero of the Village (Armorer Gift)",
};

const SYNONYMS = {
  "blocks/diamond_ore": ["diamond", "fortune"],
  "blocks/deepslate_diamond_ore": ["diamond", "fortune"],
  "blocks/gravel": ["flint"],
  "blocks/wheat": ["seeds", "crop"],
  "blocks/carrots": ["carrot", "crop"],
  "blocks/potatoes": ["potato", "poisonous", "crop"],
  "blocks/beetroots": ["beetroot", "crop"],
  "blocks/lapis_ore": ["lapis lazuli"],
  "blocks/redstone_ore": ["redstone dust"],
  "blocks/nether_gold_ore": ["gold nugget"],
  "blocks/nether_quartz_ore": ["quartz"],
  "blocks/ancient_debris": ["netherite", "scrap"],
  "blocks/amethyst_cluster": ["shard"],
  "blocks/sweet_berry_bush": ["berries"],
  "blocks/snow": ["snowball", "shovel"],
  "entities/zombie": ["rotten flesh", "iron ingot"],
  "entities/skeleton": ["bone", "arrow"],
  "entities/creeper": ["gunpowder", "music disc"],
  "entities/enderman": ["ender pearl"],
  "entities/blaze": ["blaze rod"],
  "entities/wither_skeleton": ["skull", "coal"],
  "entities/piglin": [],
  "gameplay/fishing": ["rod", "luck of the sea", "fish"],
  "gameplay/fishing_treasure": ["enchanted book", "saddle", "name tag"],
  "gameplay/fishing_junk": ["lily pad", "junk"],
  "gameplay/fishing_fish": ["cod", "salmon", "pufferfish"],
};

const SMALL_WORDS = new Set(["of", "the", "a", "an"]);
function displayName(id) {
  if (SPECIAL_NAMES[id]) return SPECIAL_NAMES[id];
  const base = id.split("/")[1];
  const sheep = base.match(/^sheep_(\w+)$/);
  const words = (sheep ? sheep[1] : base).split("_");
  const cased = words
    .map((w, i) => (SMALL_WORDS.has(w) && i > 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return sheep ? `Sheep (${cased})` : cased;
}

const CAT_LABELS = { blocks: "Blocks", entities: "Mobs", gameplay: "Fishing and gameplay", chests: "Chests" };

const allIds = [...new Set(versions.flatMap((v) => Object.keys(tables[v])))].sort();
const registry = allIds.map((id) => ({
  id,
  name: displayName(id),
  cat: CAT_LABELS[id.split("/")[0]],
  versions: versions.filter((v) => id in tables[v]),
  synonyms: SYNONYMS[id] ?? [],
}));

// --------------------------------------------------------------- emit ----
const HEADER = `// GENERATED by mc-pipeline/05-emit-loot-data.mjs. Do not edit by hand.
// Source: vanilla loot table JSON extracted from mcmeta (Mojang data
// generator output) under mc-pipeline/extracted/<version>/loot/.
// Cosmetic fields are stripped; everything that affects drop chances or
// counts is preserved verbatim. See the emitter for the cleaning rules.`;

/** Single-quoted JS string literal (the prettier-stable form for JSON payloads). */
function sq(s) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const payload = JSON.stringify({ versions, pool, tables });
const dataTs = `${HEADER}

/** Loose JSON shape of one cleaned vanilla loot table. */
export interface RawLootTable {
  pools?: RawPool[];
  functions?: RawFunction[];
}
export interface RawPool {
  rolls: RawNumber;
  bonus_rolls?: RawNumber;
  entries: RawEntry[];
  conditions?: RawCondition[];
  functions?: RawFunction[];
}
export interface RawEntry {
  type: string;
  name?: string;
  ref?: string;
  weight?: number;
  quality?: number;
  expand?: boolean;
  children?: RawEntry[];
  conditions?: RawCondition[];
  functions?: RawFunction[];
}
export type RawNumber =
  | number
  | {
      type?: string;
      min?: RawNumber;
      max?: RawNumber;
      value?: RawNumber;
      n?: RawNumber;
      p?: RawNumber;
    };
export interface RawCondition {
  condition: string;
  [key: string]: unknown;
}
export interface RawFunction {
  function: string;
  conditions?: RawCondition[];
  [key: string]: unknown;
}

interface LootData {
  /** Version ids, oldest first. */
  versions: string[];
  /** Deduplicated table documents (identical tables shared across versions). */
  pool: RawLootTable[];
  /** version -> table id -> index into pool. */
  tables: Record<string, Record<string, number>>;
}

// Parsed from a minified string literal: a multi-hundred-KB object literal
// would make tsc and eslint crawl, a string keeps the AST trivial.
export const LOOT_DATA: LootData = JSON.parse(
  ${sq(payload)},
) as LootData;
`;

// Compact rows: [id, name, catIndex, synonyms, versionIndexes?]. The version
// index list is omitted when the table exists in every version.
const rows = registry.map((r) => {
  const catIdx = Object.values(CAT_LABELS).indexOf(r.cat);
  const vIdx = r.versions.map((v) => versions.indexOf(v));
  const row = [r.id, r.name, catIdx, r.synonyms];
  if (vIdx.length !== versions.length) row.push(vIdx);
  return row;
});

const tablesTs = `${HEADER}
import type { SelectGroup } from "../types";

export type LootCategory = "Blocks" | "Mobs" | "Fishing and gameplay" | "Chests";

export interface LootTableInfo {
  /** Table id, e.g. "blocks/diamond_ore". */
  id: string;
  /** Display name for pickers and results. */
  name: string;
  /** Category grouping label. */
  cat: LootCategory;
  /** Versions that ship this table. */
  versions: string[];
  /** Extra search words for the picker. */
  synonyms: string[];
}

/** Version ids with extracted loot data, oldest first. */
export const LOOT_VERSIONS: string[] = [${versions.map((v) => JSON.stringify(v)).join(", ")}];

const CATS: LootCategory[] = ["Blocks", "Mobs", "Fishing and gameplay", "Chests"];

type Row = [string, string, number, string[]] | [string, string, number, string[], number[]];

// [id, name, catIndex, synonyms, versionIndexes?]; versionIndexes omitted
// when the table ships in every version. Parsed from a string literal so the
// module stays prettier-stable regardless of row lengths.
const ROWS: Row[] = JSON.parse(
  ${sq(JSON.stringify(rows))},
) as Row[];

export const LOOT_TABLES: LootTableInfo[] = ROWS.map((r) => ({
  id: r[0],
  name: r[1],
  cat: CATS[r[2]],
  synonyms: r[3],
  versions: (r[4] ?? LOOT_VERSIONS.map((_, i) => i)).map((i) => LOOT_VERSIONS[i]),
}));

const CAT_SYNONYMS: Record<string, string[]> = {
  Blocks: ["block", "ore", "mining", "crop"],
  Mobs: ["mob", "entity", "kill", "looting"],
  "Fishing and gameplay": ["fishing", "gameplay", "rod"],
  Chests: ["chest", "structure", "dungeon", "treasure"],
};

/** Grouped select spec for the table picker (union across versions). */
export const TABLE_GROUPS: SelectGroup[] = (
  ["Blocks", "Mobs", "Fishing and gameplay", "Chests"] as const
).map((cat) => ({
  label: cat,
  synonyms: CAT_SYNONYMS[cat],
  options: LOOT_TABLES.filter((t) => t.cat === cat).map((t) => ({
    value: t.id,
    label: t.name,
    synonyms: t.synonyms,
  })),
}));
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "data.ts"), dataTs);
writeFileSync(join(OUT_DIR, "tables.ts"), tablesTs);

const dataBytes = Buffer.byteLength(dataTs);
const total = versions.reduce((n, v) => n + Object.keys(tables[v]).length, 0);
console.log(`versions: ${versions.join(", ")}`);
console.log(`tables: ${total} across versions, ${allIds.length} unique ids, ${pool.length} deduped documents`);
if (excluded.length) console.log(`excluded (unresolvable refs):\n  ${excluded.join("\n  ")}`);
console.log(`data.ts: ${dataBytes.toLocaleString()} bytes (${(dataBytes / 1024).toFixed(1)} KiB)`);
console.log(`tables.ts: ${Buffer.byteLength(tablesTs).toLocaleString()} bytes`);
if (dataBytes >= SIZE_LIMIT) {
  console.error(`data.ts exceeds the 2 MB precache limit (${dataBytes} bytes)`);
  process.exit(1);
}
