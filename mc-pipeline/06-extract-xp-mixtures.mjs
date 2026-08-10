// Extract the data behind the minecraft-xp-calculator mixture presets:
// biome monster spawner weights (plains, nether_wastes) and relative ore
// encounter scores derived from worldgen placed/configured features,
// evaluated at a documented target y level. Raw JSON is cached under
// mc-pipeline/extracted/<version>/worldgen/ and the derived numbers are
// written to mc-pipeline/extracted/<version>/xp-mixtures.json. The committed
// src/tools/minecraft-xp-calculator/data.ts preset tables are hand-copied
// from those outputs (provenance comments cite this script).
//
// Ore model (documented approximation): encounter score for one placed
// feature at height y is
//   countPerChunk * pmf(y) * (1 / rarityChance) * veinSize
// where pmf is the exact discrete distribution of the height provider
// (uniform, or trapezoid = min + U[0..a] + U[0..b] per
// TrapezoidHeight#sample) and veinSize is the configured ore "size". This
// ignores discard_chance_on_air_exposure and vein intersection, so scores
// are relative weights, not absolute ore counts.
// Usage: node mc-pipeline/06-extract-xp-mixtures.mjs [versionId ...]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDir, pinnedVersions } from "./lib/common.mjs";

const OUT = join(ROOT, "extracted");
const RAW = "https://raw.githubusercontent.com/misode/mcmeta";

/** Blocks that drop XP when mined without Silk Touch (see DropExperienceBlock). */
const XP_ORE_BLOCKS = new Set([
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
  "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
  "minecraft:nether_quartz_ore", "minecraft:nether_gold_ore",
]);

/** Map a block id to the tool's XP source id. */
function sourceIdFor(block) {
  const name = block.replace("minecraft:", "").replace("deepslate_", "");
  if (name === "nether_quartz_ore") return "nether_quartz_ore";
  return name;
}

// Generation bounds per dimension era (1.18+ overworld, full-range nether).
const DIMS = {
  overworld: { bottom: -64, top: 319 },
  nether: { bottom: 0, top: 127 },
};

function resolveY(anchor, dim) {
  if (anchor === undefined || anchor === null) return null;
  if (typeof anchor === "number") return anchor;
  if (anchor.absolute !== undefined) return anchor.absolute;
  if (anchor.above_bottom !== undefined) return dim.bottom + anchor.above_bottom;
  if (anchor.below_top !== undefined) return dim.top - anchor.below_top;
  return null;
}

/** Exact pmf(y) of a height provider. Returns 0 when unsupported. */
function pmfAt(provider, y, dim) {
  if (!provider) return 0;
  const type = (provider.type ?? "").replace("minecraft:", "");
  const min = resolveY(provider.min_inclusive, dim);
  const max = resolveY(provider.max_inclusive, dim);
  if (min === null || max === null || max < min) return 0;
  const range = max - min;
  if (y < min || y > max) return 0;
  if (type === "uniform") return 1 / (range + 1);
  if (type === "trapezoid") {
    const plateau = provider.plateau ?? 0;
    if (plateau >= range) return 1 / (range + 1);
    // TrapezoidHeight#sample: min + U[0..b] + U[0..a], a = (range-plateau)/2
    // (integer division), b = range - a. Convolve the two uniforms exactly.
    const a = Math.floor((range - plateau) / 2);
    const b = range - a;
    const target = y - min;
    let ways = 0;
    for (let u = Math.max(0, target - a); u <= Math.min(b, target); u++) ways++;
    return ways / ((a + 1) * (b + 1));
  }
  return 0;
}

async function tryFetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

function countPerChunk(modifiers) {
  let count = 1;
  let rarity = 1;
  for (const m of modifiers) {
    const type = (m.type ?? "").replace("minecraft:", "");
    if (type === "count") {
      const c = m.count;
      if (typeof c === "number") count = c;
      else if (c?.type?.includes("uniform")) count = (c.value.min_inclusive + c.value.max_inclusive) / 2;
      else if (c?.type?.includes("weighted_list")) {
        let total = 0;
        let weight = 0;
        for (const e of c.distribution ?? []) {
          total += (typeof e.data === "number" ? e.data : 0) * e.weight;
          weight += e.weight;
        }
        count = weight > 0 ? total / weight : 1;
      }
    } else if (type === "rarity_filter") rarity = m.chance ?? 1;
  }
  return count / rarity;
}

function heightProviderOf(modifiers) {
  for (const m of modifiers) {
    if ((m.type ?? "").replace("minecraft:", "") === "height_range") return m.height;
  }
  return null;
}

async function extract(id) {
  console.log(`[${id}] xp mixtures...`);
  const out = ensureDir(join(OUT, id));
  const dataBase = `${RAW}/${id}-data/data/minecraft`;
  const result = { version: id, generated: new Date().toISOString(), biomes: {}, mining: {} };

  // 1. Biome spawner weights.
  for (const biome of ["plains", "nether_wastes"]) {
    const json = await tryFetchJson(`${dataBase}/worldgen/biome/${biome}.json`);
    if (json === null) {
      console.log(`  ${biome}: no worldgen data exposed for ${id}`);
      continue;
    }
    ensureDir(join(out, "worldgen", "biome"));
    writeFileSync(join(out, "worldgen", "biome", `${biome}.json`), JSON.stringify(json, null, 2));
    const monsters = (json.spawners?.monster ?? []).map((s) => ({
      type: s.type,
      weight: s.weight,
    }));
    result.biomes[biome] = { monster: monsters };
    console.log(`  ${biome}: ${monsters.length} monster spawner entries`);
  }

  // 2. Ore encounter scores from placed features referenced by each biome.
  const targets = [
    { biome: "plains", key: "overworld_y0", y: 0, dim: DIMS.overworld },
    { biome: "nether_wastes", key: "nether_y14", y: 14, dim: DIMS.nether },
  ];
  for (const t of targets) {
    const biomeJson = result.biomes[t.biome]
      ? JSON.parse(
          (await import("node:fs")).readFileSync(
            join(out, "worldgen", "biome", `${t.biome}.json`),
            "utf8",
          ),
        )
      : null;
    if (!biomeJson) continue;
    const placedIds = [...new Set((biomeJson.features ?? []).flat())].filter(
      (f) => typeof f === "string" && f.includes("ore_"),
    );
    const scores = {};
    const details = [];
    for (const placedId of placedIds) {
      const name = placedId.replace("minecraft:", "");
      const placed = await tryFetchJson(`${dataBase}/worldgen/placed_feature/${name}.json`);
      if (!placed) continue;
      const configuredId = (typeof placed.feature === "string" ? placed.feature : "").replace("minecraft:", "");
      const configured = await tryFetchJson(`${dataBase}/worldgen/configured_feature/${configuredId}.json`);
      if (!configured || (configured.type ?? "").replace("minecraft:", "") !== "ore") continue;
      const blocks = (configured.config?.targets ?? [])
        .map((tg) => tg.state?.Name)
        .filter((b) => XP_ORE_BLOCKS.has(b));
      if (blocks.length === 0) continue;
      ensureDir(join(out, "worldgen", "placed_feature"));
      ensureDir(join(out, "worldgen", "configured_feature"));
      writeFileSync(join(out, "worldgen", "placed_feature", `${name}.json`), JSON.stringify(placed, null, 2));
      writeFileSync(
        join(out, "worldgen", "configured_feature", `${configuredId}.json`),
        JSON.stringify(configured, null, 2),
      );
      const size = configured.config?.size ?? 1;
      const cpc = countPerChunk(placed.placement ?? []);
      const p = pmfAt(heightProviderOf(placed.placement ?? []), t.y, t.dim);
      const score = cpc * p * size;
      const srcId = sourceIdFor(blocks[0]);
      if (score > 0) scores[srcId] = (scores[srcId] ?? 0) + score;
      details.push({ placed: name, size, countPerChunk: cpc, pmfAtY: p, score, source: srcId });
    }
    result.mining[t.key] = { y: t.y, scores, details };
    console.log(`  ${t.key}: ${Object.keys(scores).length} XP ore sources scored`);
  }

  writeFileSync(join(out, "xp-mixtures.json"), JSON.stringify(result, null, 2));
}

const only = process.argv.slice(2);
const { ids } = await pinnedVersions();
for (const id of only.length ? only : ids) await extract(id);
console.log("done");
