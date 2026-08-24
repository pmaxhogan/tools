import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cropGrowthChance, growthSpeed, stageChance, type FarmLayout } from "./index";
import { CONSTANTS, GROWTH_VERSIONS, PLANT_BY_ID, plantModel } from "./data";

/**
 * Golden-vector suite for crop growth.
 *
 * The pipeline emits one file per version under mc-pipeline/vectors/growth/, in
 * one of two shapes, and both are asserted here.
 *
 * `method: "rcon-e2e"` (`measured: true`) files carry measured `cases`. The
 * harness booted a real dedicated server, built a controlled grid per case,
 * opened an exact tick window at a known random tick speed, then read back the
 * age property of every plant. Two independent things are checked per case:
 *
 * 1. `growthSpeed()` reproduces the growth speed the harness recorded for the
 *    layout it built. No statistics involved: this is the farmland weight sum
 *    and the crowding halving, checked directly.
 * 2. The age histogram matches the engine's prediction. Over `ticksElapsed`
 *    game ticks at random tick speed R, a block receives Binomial(R * ticks,
 *    1/4096) random ticks and each one advances the plant with the engine's per
 *    random tick chance, so the age after the window is exactly
 *    Binomial(R * ticks, chance / 4096) capped at the plant's max age.
 *
 * `method: "source-derived"` (`measured: false`) files carry `sourceConstants`
 * instead, every leaf shaped `{ value, class, note }`. Those versions cannot be
 * measured headlessly at all: before 1.21.11, ServerChunkCache.tickChunks only
 * reaches the random tick loop inside the natural spawning branch, gated on a
 * player being close enough to the chunk for spawning, so with nobody online no
 * block is ever random ticked. 1.21.11 moved the call to
 * ChunkMap.forEachBlockTickingChunk, which is why exactly two versions are
 * measurable. The constants in those files are still worth asserting: they are
 * an INDEPENDENT reading of the same decompiled classes by the pipeline agent,
 * so a mismatch with this tool's generated data means one of the two readings
 * is wrong.
 *
 * The vector files state no tolerance of their own, so the statistical
 * assertions use the same rule as the loot vectors: 4 sigma on the binomial
 * count plus 2, loose enough that a correct engine effectively never fails and
 * tight enough that a wrong growth chance always does.
 *
 * Bamboo is measured as a total block count rather than an age histogram
 * (bamboo has no age counter that survives growth), so it is checked as an
 * expected number of growth events instead, assuming one block per planting at
 * the start of the window, which is what `expectedSamples` records.
 *
 * The loop walks whatever version files exist, so nothing here needs touching
 * when the pipeline regenerates them.
 */

const VECTORS_DIR = fileURLToPath(new URL("../../../mc-pipeline/vectors/growth/", import.meta.url));

/** Every source-derived constant is a leaf of this shape. */
interface Leaf {
  value: number;
  class: string;
  note: string | null;
}

interface VectorCase {
  case: string;
  block: string;
  layout: string;
  caveat: string | null;
  growthSpeed: number | null;
  maxAge: number | null;
  samples: number;
  expectedSamples: number;
  ticksElapsed: number;
  ticksRequested: number;
  randomTickSpeed: number;
  randomTickChancePerBlockPerTick: number;
  ageHistogram: Record<string, number> | null;
  grownAbove?: number;
}

interface SourceConstants {
  cropGrowth?: {
    growthRollDivisor: Leaf;
    growthRollOffset: Leaf;
    minimumLight: Leaf;
    farmlandDryBonus: Leaf;
    farmlandWetBonus: Leaf;
    neighbourDivisor: Leaf;
    crowdingDivisor: Leaf;
  };
  beetroot?: { extraRollDenominator: Leaf; maxAge: Leaf };
  netherWart?: { rollDenominator: Leaf; maxAge: Leaf };
  sugarCane?: { maxAge: Leaf };
  cactus?: { maxAge: Leaf };
  bamboo?: { rollDenominator: Leaf };
}

interface VectorFile {
  version: string;
  generated: string;
  serverJarSha1: string;
  method: "rcon-e2e" | "source-derived";
  measured: boolean;
  note: string;
  randomTickSpeed?: number;
  tickMethod?: string;
  tickWindowPrecision?: string;
  cases?: VectorCase[];
  sourceConstants?: SourceConstants;
}

/** The harness layouts, mirrored as this tool's layout description. */
const CASE_LAYOUTS: Record<string, FarmLayout> = {
  // One crop every 2 blocks, farmland only directly below it.
  "isolated-hydrated": {
    centerHydrated: true,
    neighbourFarmland: 0,
    neighbourHydrated: true,
    crowding: "none",
  },
  "isolated-dry": {
    centerHydrated: false,
    neighbourFarmland: 0,
    neighbourHydrated: false,
    crowding: "none",
  },
  // Continuous rows along x, rows two apart in z: farmland east and west only,
  // and the same crop on one axis only, so the crowding halving never applies.
  "row-hydrated": {
    centerHydrated: true,
    neighbourFarmland: 2,
    neighbourHydrated: true,
    crowding: "row",
  },
  "row-dry": {
    centerHydrated: false,
    neighbourFarmland: 2,
    neighbourHydrated: false,
    crowding: "row",
  },
  // Solid field interior: all nine blocks are farmland and the crop has
  // neighbors on both axes, so the speed is halved.
  "field-hydrated": {
    centerHydrated: true,
    neighbourFarmland: 8,
    neighbourHydrated: true,
    crowding: "grid",
  },
};

/** Sugar cane and cactus reset their age to 0 after growing a block. */
const WRAPPING_AGE = new Set(["sugar_cane", "cactus"]);

function plantIdFor(block: string): string {
  return block.replace(/^minecraft:/, "");
}

function layoutFor(caseName: string): FarmLayout | null {
  for (const [suffix, layout] of Object.entries(CASE_LAYOUTS)) {
    if (caseName.endsWith(suffix)) return layout;
  }
  return null;
}

// --- exact binomial pmf, in logs so the huge trial counts stay stable --------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(x: number): number {
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function binomPmf(n: number, k: number, s: number): number {
  const lchoose = lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
  return Math.exp(lchoose + k * Math.log(s) + (n - k) * Math.log1p(-s));
}

// ---------------------------------------------------------------- suite ----

const files = readdirSync(VECTORS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const loaded = files.map((file) => ({
  file,
  vec: JSON.parse(readFileSync(VECTORS_DIR + file, "utf8")) as VectorFile,
}));

for (const { file, vec } of loaded) {
  const version = vec.version;

  describe(`growth vectors ${version} (${vec.method})`, () => {
    it("is a version this tool ships data for", () => {
      expect(GROWTH_VERSIONS, `${file} names a version the tool does not know`).toContain(version);
      expect(vec.measured).toBe(vec.method === "rcon-e2e");
      expect(
        Boolean(vec.cases?.length) || Boolean(vec.sourceConstants),
        `${file} carries neither cases nor sourceConstants`,
      ).toBe(true);
    });

    // ---------------------------------------------------- measured cases ----
    for (const c of vec.cases ?? []) {
      const plantId = plantIdFor(c.block);
      const plant = PLANT_BY_ID.get(plantId);

      it(`${c.case}: ${plantId} exists in ${version}`, () => {
        expect(plant, `${plantId} is missing from the plant registry`).toBeTruthy();
        expect(plant!.versions).toContain(version);
      });

      if (c.growthSpeed !== null) {
        it(`${c.case}: growth speed ${c.growthSpeed} reproduced from the layout`, () => {
          const layout = layoutFor(c.case);
          expect(layout, `no layout mirror for case ${c.case}`).toBeTruthy();
          expect(growthSpeed(layout!, version)).toBeCloseTo(c.growthSpeed!, 6);
        });
      }

      if (!c.ageHistogram) continue;

      it(`${c.case}: age histogram over ${c.samples} plants matches the prediction`, () => {
        const model = plantModel(plant!, version);
        // stageChance, not cropGrowthChance: beetroot and torchflower skip one
        // growth attempt in three before the shared roll even happens, which is
        // what this case's `caveat` records for beetroot.
        const chance = stageChance(model, c.growthSpeed ?? 0, version);

        // The plant's own stage count must agree with what the server reported.
        if (!WRAPPING_AGE.has(plantId)) {
          expect(model.stages, `${plantId} stage count`).toBe(c.maxAge);
        }

        const maxAge = c.maxAge!;
        const draws = c.ticksElapsed * c.randomTickSpeed;
        const perDraw = chance / CONSTANTS[version].blocksPerSection;
        const n = c.samples;
        const capIsTail = !WRAPPING_AGE.has(plantId);

        let tail = 1;
        for (let age = 0; age <= maxAge; age++) {
          const p = age === maxAge && capIsTail ? Math.max(0, tail) : binomPmf(draws, age, perDraw);
          tail -= p;
          const observed = c.ageHistogram![String(age)] ?? 0;
          const tolerance = 4 * Math.sqrt(n * p * (1 - p)) + 2;
          expect(
            Math.abs(observed - n * p),
            `age ${age}: observed ${observed}, predicted ${(n * p).toFixed(2)} +/- ${tolerance.toFixed(2)}`,
          ).toBeLessThanOrEqual(tolerance);
        }

        // The histogram must account for every plant the harness read back.
        const counted = Object.values(c.ageHistogram!).reduce((a, b) => a + b, 0);
        expect(counted).toBe(n);
      });
    }

    const bamboo = (vec.cases ?? []).find(
      (c) => plantIdFor(c.block) === "bamboo" && !c.ageHistogram,
    );
    if (bamboo) {
      it("bamboo: total block count matches the predicted growth events", () => {
        const model = plantModel(PLANT_BY_ID.get("bamboo")!, version);
        const chance = stageChance(model, 0, version);
        // Only the top block of a column can grow, so a column receives
        // Binomial(ticks * speed, 1/4096) random ticks and each grows a block
        // with `chance`. Starting height is one block per planting.
        const perColumn =
          (bamboo.ticksElapsed * bamboo.randomTickSpeed * chance) /
          CONSTANTS[version].blocksPerSection;
        const columns = bamboo.expectedSamples;
        const predicted = columns * (1 + perColumn);
        const tolerance = 4 * Math.sqrt(columns * perColumn) + 2;
        expect(
          Math.abs(bamboo.samples - predicted),
          `observed ${bamboo.samples} blocks, predicted ${predicted.toFixed(1)} +/- ${tolerance.toFixed(1)}`,
        ).toBeLessThanOrEqual(tolerance);
      });
    }

    // ----------------------------------------- source-derived constants ----
    const sc = vec.sourceConstants;
    if (sc) {
      const c = CONSTANTS[version];
      const model = (id: string) => plantModel(PLANT_BY_ID.get(id)!, version);

      if (sc.cropGrowth) {
        const cg = sc.cropGrowth;
        it(`${cg.growthRollDivisor.class}: growth speed weights agree with the harness`, () => {
          expect(c.growthDivisor).toBe(cg.growthRollDivisor.value);
          expect(c.speedFarmland).toBe(cg.farmlandDryBonus.value);
          expect(c.speedMoistFarmland).toBe(cg.farmlandWetBonus.value);
          expect(c.speedNeighbourDivisor).toBe(cg.neighbourDivisor.value);
          expect(c.speedCrowdDivisor).toBe(cg.crowdingDivisor.value);
          expect(model("wheat").light).toBe(cg.minimumLight.value);
        });

        it(`${cg.growthRollDivisor.class}: the stated roll formula matches at every layout speed`, () => {
          // Spelled exactly as the vector note states it, then checked against
          // the engine at the speeds the named layouts actually produce.
          for (const speed of [2, 2.5, 4, 5, 5.5, 10]) {
            const expected =
              1 / (Math.floor(cg.growthRollDivisor.value / speed) + cg.growthRollOffset.value);
            expect(cropGrowthChance(speed, version), `speed ${speed}`).toBeCloseTo(expected, 12);
          }
          // And the weights compose into those speeds in the first place.
          for (const [name, layout] of Object.entries(CASE_LAYOUTS)) {
            const base =
              1 +
              (layout.centerHydrated ? cg.farmlandWetBonus.value : cg.farmlandDryBonus.value) +
              (layout.neighbourFarmland *
                (layout.neighbourHydrated
                  ? cg.farmlandWetBonus.value
                  : cg.farmlandDryBonus.value)) /
                cg.neighbourDivisor.value;
            const expected =
              layout.crowding === "grid" || layout.crowding === "diagonal"
                ? base / cg.crowdingDivisor.value
                : base;
            expect(growthSpeed(layout, version), name).toBeCloseTo(expected, 6);
          }
        });
      }

      if (sc.beetroot) {
        it(`${sc.beetroot.extraRollDenominator.class}: extra roll and max age agree with the harness`, () => {
          const beet = model("beetroots");
          expect(beet.stages).toBe(sc.beetroot!.maxAge.value);
          const denominator = sc.beetroot!.extraRollDenominator.value;
          expect(stageChance(beet, 4, version)).toBeCloseTo(
            cropGrowthChance(4, version) * ((denominator - 1) / denominator),
            12,
          );
        });
      }

      if (sc.netherWart) {
        it(`${sc.netherWart.rollDenominator.class}: roll and max age agree with the harness`, () => {
          const wart = model("nether_wart");
          expect(wart.stages).toBe(sc.netherWart!.maxAge.value);
          expect(stageChance(wart, 0, version)).toBeCloseTo(
            1 / sc.netherWart!.rollDenominator.value,
            12,
          );
        });
      }

      for (const [id, stated] of [
        ["sugar_cane", sc.sugarCane],
        ["cactus", sc.cactus],
      ] as const) {
        if (!stated) continue;
        it(`${stated.maxAge.class}: one random tick per age step agrees with the harness`, () => {
          const m = model(id);
          expect(stageChance(m, 0, version)).toBe(1);
          // The age property tops out at maxAge, then the next random tick
          // grows a block and resets it, so a new block costs maxAge + 1 ticks.
          expect(m.stages).toBe(stated.maxAge.value + 1);
        });
      }

      if (sc.bamboo) {
        it(`${sc.bamboo.rollDenominator.class}: growth roll agrees with the harness`, () => {
          expect(stageChance(model("bamboo"), 0, version)).toBeCloseTo(
            1 / sc.bamboo!.rollDenominator.value,
            12,
          );
        });
      }
    }
  });
}

describe("vector coverage", () => {
  it("has a file for every version the tool ships", () => {
    const covered = loaded.map((l) => l.vec.version).sort();
    expect(covered).toEqual([...GROWTH_VERSIONS].sort());
  });

  it("measures growth only where a headless server random ticks at all", () => {
    // Not a hardcoded version list: the pipeline detects this with a runtime
    // probe, and the tool's own data records the same boundary from source.
    for (const { vec } of loaded) {
      const gate = CONSTANTS[vec.version].randomTickGate;
      expect(vec.measured, `${vec.version} gate ${gate}`).toBe(gate === "block-ticking-chunks");
    }
    expect(loaded.some((l) => l.vec.measured)).toBe(true);
  });
});
