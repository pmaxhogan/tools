import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_SPAWN_CLUSTER_SIZE,
  MIN_SPAWN_DISTANCE,
  MOB_CAP_DIVISOR,
  NO_DESPAWN_DISTANCE,
  PACK_ATTEMPTS_BEFORE_TYPE,
  PACK_SPREAD,
  RANDOM_DESPAWN_DENOMINATOR,
  RANDOM_DESPAWN_IDLE_TICKS,
  ROUNDS_PER_CHUNK_TICK,
  SKY_LIGHT_TEST_RANGE,
  SPAWNING_CHUNK_PLAYER_RADIUS,
  SPAWN_CHUNK_RADIUS,
  SPAWN_VERSIONS,
  afkGeometry,
  categoriesFor,
  darkEnoughChance,
  hasPerPlayerCap,
  lightRuleFor,
  spawnsIn,
} from "./index";
import { BIOMES_BY_ID, type SpawnDimension } from "./biomes";
import { CATEGORY_IDS, MOB_RULES } from "./data";

/**
 * Two suites, because this tool has two kinds of ground truth.
 *
 * 1. Source-derived vectors. Natural spawning cannot be measured on a headless
 *    server: NaturalSpawner only runs for chunks charged by a player, so an
 *    empty server produces nothing no matter how long it ticks. Every constant
 *    was therefore read out of the decompiled server source per version and
 *    written to mc-pipeline/vectors/spawning/source-derived.json with the
 *    class and method it came from. This suite asserts the shipped exports
 *    equal that file, so a hand edit to either one fails loudly.
 *
 * 2. Structural tests parsed straight from the extracted biome JSON under
 *    mc-pipeline/extracted/<version>/. The generated data.ts is asserted to
 *    reproduce the extracted spawner lists, weights, pack sizes, spawn costs
 *    and spawn-rule classifications exactly, so the data layer verifies itself
 *    rather than trusting the emitter.
 */

const VECTORS = fileURLToPath(
  new URL("../../../mc-pipeline/vectors/spawning/source-derived.json", import.meta.url),
);
const EXTRACTED = new URL("../../../mc-pipeline/extracted/", import.meta.url);

interface ConstantVector {
  id: string;
  versions: string[];
  value: number;
  provenance: string;
}
interface CategoryVector {
  id: string;
  versions: string[];
  maxPerChunk: number;
  despawnDistance: number;
  noDespawnDistance: number;
  friendly: boolean;
  persistent: boolean;
}
interface LightRuleVector {
  id: string;
  versions: string[];
  dimensions: SpawnDimension[];
  blockLightLimit: number;
  lightTest: { type: "uniform" | "constant"; min: number; max: number };
  skyLightTest: { type: string; min: number; max: number };
}
interface VectorFile {
  method: string;
  versions: string[];
  constants: ConstantVector[];
  categories: CategoryVector[];
  lightRules: LightRuleVector[];
}

const vec = JSON.parse(readFileSync(VECTORS, "utf8")) as VectorFile;

/** Exported constant per vector id. */
const CONSTANTS: Record<string, number> = {
  "min-spawn-distance": MIN_SPAWN_DISTANCE,
  "world-spawn-exclusion": MIN_SPAWN_DISTANCE,
  "spawn-chunk-radius": SPAWN_CHUNK_RADIUS,
  "mob-cap-divisor": MOB_CAP_DIVISOR,
  "spawning-chunk-player-radius": SPAWNING_CHUNK_PLAYER_RADIUS,
  "rounds-per-chunk-tick": ROUNDS_PER_CHUNK_TICK,
  "pack-attempts-before-type": PACK_ATTEMPTS_BEFORE_TYPE,
  "pack-spread": PACK_SPREAD,
  "max-spawn-cluster-size": MAX_SPAWN_CLUSTER_SIZE,
  "no-despawn-distance": NO_DESPAWN_DISTANCE,
  "random-despawn-idle-ticks": RANDOM_DESPAWN_IDLE_TICKS,
  "random-despawn-chance-denominator": RANDOM_DESPAWN_DENOMINATOR,
};

describe(`source-derived vectors (${vec.method})`, () => {
  it("covers exactly the six shipped versions", () => {
    expect(vec.versions).toEqual(SPAWN_VERSIONS);
    expect(vec.method).toBe("source-derived");
  });

  for (const c of vec.constants) {
    it(`${c.id} = ${c.value}`, () => {
      expect(CONSTANTS[c.id], `no export mapped for vector "${c.id}"`).toBeDefined();
      expect(CONSTANTS[c.id]).toBe(c.value);
      expect(c.provenance.length, `${c.id} must record where it came from`).toBeGreaterThan(20);
      expect(c.versions).toEqual(SPAWN_VERSIONS);
    });
  }

  it("maps every exported constant to a vector entry", () => {
    const ids = new Set(vec.constants.map((c) => c.id));
    for (const id of Object.keys(CONSTANTS)) expect(ids.has(id), `${id} missing`).toBe(true);
  });

  describe("MobCategory", () => {
    for (const version of SPAWN_VERSIONS) {
      it(`${version} category table matches`, () => {
        const expected = vec.categories.filter((c) => c.versions.includes(version));
        const actual = categoriesFor(version);
        expect(actual.map((c) => c.id).sort()).toEqual(expected.map((c) => c.id).sort());
        for (const want of expected) {
          const got = actual.find((c) => c.id === want.id)!;
          expect(got.maxPerChunk, `${version} ${want.id} cap`).toBe(want.maxPerChunk);
          expect(got.despawnDistance, `${version} ${want.id} despawn`).toBe(want.despawnDistance);
          expect(got.noDespawnDistance).toBe(want.noDespawnDistance);
          expect(got.friendly).toBe(want.friendly);
          expect(got.persistent).toBe(want.persistent);
          expect(afkGeometry(version, want.id).instantDespawn).toBe(want.despawnDistance);
        }
      });
    }

    it("the per player cap exists from 1.18.2 on and not in 1.16.5", () => {
      expect(hasPerPlayerCap("1.16.5")).toBe(false);
      for (const v of SPAWN_VERSIONS.filter((x) => x !== "1.16.5")) {
        expect(hasPerPlayerCap(v), v).toBe(true);
      }
    });
  });

  describe("the light rule", () => {
    for (const rule of vec.lightRules) {
      for (const version of rule.versions) {
        for (const dim of rule.dimensions) {
          it(`${version} ${dim}: block light limit ${rule.blockLightLimit}, ${rule.lightTest.type} test`, () => {
            const got = lightRuleFor(version, dim);
            expect(got.blockLightLimit).toBe(rule.blockLightLimit);
            expect(got.test.kind).toBe(rule.lightTest.type);
            expect(got.test.min).toBe(rule.lightTest.min);
            expect(got.test.max).toBe(rule.lightTest.max);
          });
        }
      }
    }

    it("the sky light gate is a nextInt(32) sample in every version", () => {
      expect(SKY_LIGHT_TEST_RANGE).toBe(vec.lightRules[0].skyLightTest.max + 1);
      for (const rule of vec.lightRules) {
        expect(rule.skyLightTest).toEqual({ type: "uniform", min: 0, max: 31 });
      }
      for (const version of SPAWN_VERSIONS) {
        for (let sky = 0; sky <= 15; sky++) {
          const verdict = darkEnoughChance({
            version,
            dimension: "overworld",
            skyLight: sky,
            blockLight: 0,
          });
          expect(verdict.skyChance).toBeCloseTo((32 - sky) / 32, 12);
        }
      }
    });

    it("every version and dimension pair resolves to exactly one vector rule", () => {
      const dims: SpawnDimension[] = ["overworld", "nether", "end"];
      for (const version of SPAWN_VERSIONS) {
        for (const dim of dims) {
          const matches = vec.lightRules.filter(
            (r) => r.versions.includes(version) && r.dimensions.includes(dim),
          );
          expect(matches.length, `${version} ${dim}`).toBe(1);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------

interface ExtractedSpawner {
  type: string;
  weight: number;
  minCount: number;
  maxCount: number;
}
interface ExtractedBiome {
  creatureSpawnProbability: number;
  spawners: Record<string, ExtractedSpawner[]>;
  spawnCosts: Record<string, { charge: number; energyBudget: number }>;
}
interface ExtractedBiomeFile {
  version: string;
  source: string;
  biomes: Record<string, ExtractedBiome>;
}
interface ExtractedPlacement {
  placement: string;
  predicate: string;
  rule: string;
  extraConditions: boolean;
}
interface ExtractedPlacementFile {
  version: string;
  placements: Record<string, ExtractedPlacement>;
}

function readExtracted<T>(version: string, file: string): T {
  return JSON.parse(readFileSync(new URL(`${version}/${file}`, EXTRACTED), "utf8")) as T;
}

describe("data layer matches the extracted game data", () => {
  for (const version of SPAWN_VERSIONS) {
    describe(version, () => {
      const biomeFile = readExtracted<ExtractedBiomeFile>(version, "spawning-biomes.json");
      const placementFile = readExtracted<ExtractedPlacementFile>(version, "spawn-placements.json");
      const biomeIds = Object.keys(biomeFile.biomes);

      it("ships every extracted biome and no invented ones", () => {
        for (const id of biomeIds) {
          expect(BIOMES_BY_ID[id], `${id} missing from biomes.ts`).toBeDefined();
          expect(BIOMES_BY_ID[id].versions).toContain(version);
        }
        for (const info of Object.values(BIOMES_BY_ID)) {
          if (info.versions.includes(version)) {
            expect(biomeFile.biomes[info.id], `${info.id} not in ${version}`).toBeDefined();
          }
        }
      });

      it("reproduces every spawner entry exactly", () => {
        for (const id of biomeIds) {
          const extracted = biomeFile.biomes[id];
          for (const category of CATEGORY_IDS) {
            const want = extracted.spawners[category] ?? [];
            if (!categoriesFor(version).some((c) => c.id === category)) {
              expect(want.length, `${id} ${category} should not exist in ${version}`).toBe(0);
              continue;
            }
            const got = spawnsIn({ version, biome: id, category }).entries;
            expect(got.length, `${version} ${id} ${category} entry count`).toBe(want.length);
            want.forEach((w, i) => {
              expect(got[i].mob, `${id} ${category}[${i}] type`).toBe(w.type);
              expect(got[i].weight, `${id} ${category}[${i}] weight`).toBe(w.weight);
              expect(got[i].minCount, `${id} ${category}[${i}] minCount`).toBe(w.minCount);
              expect(got[i].maxCount, `${id} ${category}[${i}] maxCount`).toBe(w.maxCount);
            });
          }
        }
      });

      it("normalizes weights into shares that sum to one", () => {
        for (const id of biomeIds) {
          for (const category of CATEGORY_IDS) {
            if (!categoriesFor(version).some((c) => c.id === category)) continue;
            const result = spawnsIn({ version, biome: id, category });
            if (!result.entries.length) continue;
            const sum = result.entries.reduce((s, e) => s + e.share, 0);
            expect(sum, `${id} ${category}`).toBeCloseTo(1, 10);
            expect(result.totalWeight).toBe(result.entries.reduce((s, e) => s + e.weight, 0));
          }
        }
      });

      it("carries spawn costs and creature spawn probability through unchanged", () => {
        for (const id of biomeIds) {
          const extracted = biomeFile.biomes[id];
          const anyCategory = CATEGORY_IDS.find(
            (c) =>
              categoriesFor(version).some((x) => x.id === c) &&
              (extracted.spawners[c] ?? []).length > 0,
          );
          if (!anyCategory) continue;
          const result = spawnsIn({ version, biome: id, category: anyCategory });
          expect(result.creatureSpawnProbability).toBe(extracted.creatureSpawnProbability);
          for (const entry of result.entries) {
            const want = extracted.spawnCosts[entry.mob];
            if (want) expect(entry.spawnCost).toEqual(want);
            else expect(entry.spawnCost).toBeNull();
          }
        }
      });

      it("keeps the spawn-rule classification the source parser produced", () => {
        const rules = MOB_RULES[version];
        expect(Object.keys(rules).length).toBeGreaterThan(0);
        for (const [mob, packed] of Object.entries(rules)) {
          const want = placementFile.placements[mob];
          expect(want, `${mob} not in the extracted placements`).toBeDefined();
          expect(packed[0], `${mob} rule`).toBe(want.rule);
          expect(packed[1], `${mob} placement`).toBe(want.placement);
          expect(packed[2], `${mob} predicate`).toBe(want.predicate);
          expect(packed[3] === 1, `${mob} extra conditions`).toBe(want.extraConditions);
        }
      });

      it("classifies every mob that appears in a spawner list", () => {
        const rules = MOB_RULES[version];
        const unclassified: string[] = [];
        for (const id of biomeIds) {
          for (const list of Object.values(biomeFile.biomes[id].spawners)) {
            for (const entry of list) {
              const packed = rules[entry.type];
              if (!packed || packed[0] === "custom") unclassified.push(entry.type);
            }
          }
        }
        expect([...new Set(unclassified)]).toEqual([]);
      });
    });
  }
});
