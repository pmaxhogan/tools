import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  MOB_CAP_DIVISOR,
  SPAWN_VERSIONS,
  afkGeometry,
  categoriesFor,
  categoriesWithSpawns,
  countAttemptChunks,
  darkEnoughChance,
  farmRate,
  lightRuleFor,
  mobCap,
  mobDisplayName,
  run,
  skyDarkenFor,
  spawnProof,
  spawnsIn,
} from "./index";

const LATEST = SPAWN_VERSIONS[SPAWN_VERSIONS.length - 1];

describe("the light rule", () => {
  it("spawns freely in a sealed dark room in every version", () => {
    for (const v of SPAWN_VERSIONS) {
      const verdict = darkEnoughChance({
        version: v,
        dimension: "overworld",
        skyLight: 0,
        blockLight: 0,
      });
      expect(verdict.chance, `${v} dark room`).toBe(1);
      expect(verdict.blockedBy).toBeNull();
    }
  });

  it("1.16.5 still spawns at light level 7, one attempt in eight", () => {
    const verdict = darkEnoughChance({
      version: "1.16.5",
      dimension: "overworld",
      skyLight: 0,
      blockLight: 7,
    });
    expect(verdict.rawBrightness).toBe(7);
    expect(verdict.chance).toBeCloseTo(1 / 8, 12);
    expect(verdict.blockLightOk).toBe(true);
  });

  it("1.18.2 refuses any block light at all", () => {
    const verdict = darkEnoughChance({
      version: "1.18.2",
      dimension: "overworld",
      skyLight: 0,
      blockLight: 1,
    });
    expect(verdict.chance).toBe(0);
    expect(verdict.blockedBy).toBe("block-light");
  });

  it("the modern nether skips the block light gate and tests brightness against a constant 7", () => {
    const rule = lightRuleFor(LATEST, "nether");
    expect(rule.blockLightLimit).toBe(15);
    expect(rule.test).toEqual({ kind: "constant", min: 7, max: 7 });
    expect(
      darkEnoughChance({ version: LATEST, dimension: "nether", skyLight: 0, blockLight: 7 }).chance,
    ).toBe(1);
    expect(
      darkEnoughChance({ version: LATEST, dimension: "nether", skyLight: 0, blockLight: 8 }).chance,
    ).toBe(0);
  });

  it("an open sky surface block at midnight passes about a quarter of attempts", () => {
    const verdict = darkEnoughChance({
      version: LATEST,
      dimension: "overworld",
      skyLight: 15,
      blockLight: 0,
      world: "night",
    });
    // sky gate (32 - 15) / 32, then raw brightness 15 - 11 = 4 against nextInt(8)
    expect(verdict.skyChance).toBeCloseTo(17 / 32, 12);
    expect(verdict.rawBrightness).toBe(4);
    expect(verdict.brightnessChance).toBeCloseTo(0.5, 12);
    expect(verdict.chance).toBeCloseTo(17 / 64, 12);
  });

  it("daylight leaves an open sky block unspawnable", () => {
    const verdict = darkEnoughChance({
      version: LATEST,
      dimension: "overworld",
      skyLight: 15,
      blockLight: 0,
      world: "day",
    });
    expect(verdict.rawBrightness).toBe(15);
    expect(verdict.chance).toBe(0);
    expect(verdict.blockedBy).toBe("brightness");
  });

  it("the sky darken presets match Level#updateSkyBrightness and the thunder override", () => {
    expect(skyDarkenFor("day")).toBe(0);
    expect(skyDarkenFor("night")).toBe(11);
    expect(skyDarkenFor("thunder")).toBe(10);
  });

  it("the end's sampled light test became a constant by 1.21.11 without changing the outcome", () => {
    expect(lightRuleFor("1.21.1", "end").test).toEqual({ kind: "uniform", min: 0, max: 7 });
    expect(lightRuleFor("1.21.11", "end").test).toEqual({ kind: "constant", min: 15, max: 15 });
    for (const v of ["1.21.1", "1.21.11"]) {
      // The end has no sky light and the block light limit stays 0, so the
      // practical condition is unchanged either way.
      expect(
        darkEnoughChance({ version: v, dimension: "end", skyLight: 0, blockLight: 0 }).chance,
      ).toBe(1);
      expect(
        darkEnoughChance({ version: v, dimension: "end", skyLight: 0, blockLight: 1 }).chance,
      ).toBe(0);
    }
  });

  it("clamps out of range light input to the 0 to 15 the game stores", () => {
    const wild = darkEnoughChance({
      version: LATEST,
      dimension: "overworld",
      skyLight: 99,
      blockLight: -4,
    });
    const clamped = darkEnoughChance({
      version: LATEST,
      dimension: "overworld",
      skyLight: 15,
      blockLight: 0,
    });
    expect(wild).toEqual(clamped);
  });
});

describe("spawn proofing", () => {
  it("a torch protects to distance 13 from 1.18.2 onward", () => {
    const result = spawnProof({
      version: "1.18.2",
      dimension: "overworld",
      sourceLight: 14,
      distance: 13,
    });
    expect(result.blockLight).toBe(1);
    expect(result.safe).toBe(true);
    expect(result.safeRadius).toBe(13);
  });

  it("the same torch only protects to distance 6 in 1.16.5", () => {
    const near = spawnProof({
      version: "1.16.5",
      dimension: "overworld",
      sourceLight: 14,
      distance: 6,
    });
    expect(near.blockLight).toBe(8);
    expect(near.safe).toBe(true);
    expect(near.safeRadius).toBe(6);

    const far = spawnProof({
      version: "1.16.5",
      dimension: "overworld",
      sourceLight: 14,
      distance: 7,
    });
    expect(far.blockLight).toBe(7);
    expect(far.safe).toBe(false);
    expect(far.chance).toBeCloseTo(1 / 8, 12);
  });

  it("a light source cannot spawn proof the modern nether below level 8", () => {
    const weak = spawnProof({
      version: LATEST,
      dimension: "nether",
      sourceLight: 7,
      distance: 0,
    });
    expect(weak.safe).toBe(false);
    expect(weak.safeRadius).toBe(-1);
    expect(weak.notes.join(" ")).toContain("cannot spawn proof anything");

    // Level 15 clears the nether's brightness sample of 7 out to distance 7.
    const strong = spawnProof({
      version: LATEST,
      dimension: "nether",
      sourceLight: 15,
      distance: 7,
    });
    expect(strong.safeRadius).toBe(7);
    expect(strong.blockLight).toBe(8);
    expect(strong.safe).toBe(true);
    expect(
      spawnProof({ version: LATEST, dimension: "nether", sourceLight: 15, distance: 8 }).safe,
    ).toBe(false);
  });

  it("reports minus one rather than zero when nothing at all is protected", () => {
    const dark = spawnProof({
      version: LATEST,
      dimension: "overworld",
      sourceLight: 0,
      distance: 0,
    });
    expect(dark.safeRadius).toBe(-1);
    expect(dark.safe).toBe(false);
  });
});

describe("what can spawn here", () => {
  it("reads the real plains monster list with weights and pack sizes", () => {
    const result = spawnsIn({ version: LATEST, biome: "plains", category: "monster" });
    const spider = result.entries.find((e) => e.mob === "minecraft:spider");
    expect(spider).toBeDefined();
    expect(spider!.weight).toBeGreaterThan(0);
    expect(spider!.minCount).toBe(4);
    expect(spider!.maxCount).toBe(4);
    expect(spider!.avgPack).toBe(4);
    expect(spider!.rule).toBe("dark");
    const total = result.entries.reduce((s, e) => s + e.weight, 0);
    expect(result.totalWeight).toBe(total);
    const shares = result.entries.reduce((s, e) => s + e.share, 0);
    expect(shares).toBeCloseTo(1, 12);
  });

  it("mushroom fields has an empty monster list, which is the answer not a gap", () => {
    const result = spawnsIn({ version: LATEST, biome: "mushroom_fields", category: "monster" });
    expect(result.entries).toEqual([]);
    expect(result.notes.join(" ")).toContain("no monster spawns");
    const creatures = spawnsIn({ version: LATEST, biome: "mushroom_fields", category: "creature" });
    expect(creatures.entries.map((e) => e.mob)).toContain("minecraft:mooshroom");
  });

  it("classifies light-ignoring nether monsters separately from light gated ones", () => {
    const result = spawnsIn({
      version: LATEST,
      biome: "nether_wastes",
      category: "monster",
      blockLight: 15,
    });
    const enderman = result.entries.find((e) => e.mob === "minecraft:enderman");
    expect(enderman?.rule).toBe("dark");
    expect(enderman?.extraConditions).toBe(false);
    expect(enderman?.predicate).toBe("Monster::checkMonsterSpawnRules");
    // Zombified piglins resolve through their own predicate to no light check
    // at all, so a fully lit nether floor still spawns them.
    const zombified = result.entries.find((e) => e.mob === "minecraft:zombified_piglin");
    expect(zombified?.rule).toBe("any-light");
    expect(zombified?.extraConditions).toBe(true);
    expect(zombified?.lightChance).toBe(1);
  });

  it("flags mobs that run their own brightness test", () => {
    const result = spawnsIn({ version: LATEST, biome: "swamp", category: "monster" });
    const slime = result.entries.find((e) => e.mob === "minecraft:slime");
    expect(slime?.rule).toBe("own-light");
    expect(slime?.notes.join(" ")).toContain("own brightness test");
  });

  it("carries the soul sand valley spawn costs through", () => {
    const result = spawnsIn({ version: LATEST, biome: "soul_sand_valley", category: "monster" });
    const skeleton = result.entries.find((e) => e.mob === "minecraft:skeleton");
    expect(skeleton?.spawnCost).toEqual({ charge: 0.7, energyBudget: 0.15 });
    expect(result.notes.join(" ")).toContain("spawn costs");
  });

  it("light gated mobs inherit the per attempt light chance", () => {
    const lit = spawnsIn({
      version: "1.16.5",
      biome: "plains",
      category: "monster",
      blockLight: 7,
    });
    const zombie = lit.entries.find((e) => e.mob === "minecraft:zombie");
    expect(zombie?.lightChance).toBeCloseTo(1 / 8, 12);
  });

  it("lists only categories the biome actually populates", () => {
    const cats = categoriesWithSpawns(LATEST, "the_end");
    expect(cats).toContain("monster");
    expect(cats).not.toContain("creature");
  });
});

describe("the mob cap", () => {
  it("one player charges 289 chunks and allows 70 monsters", () => {
    const cap = mobCap({ version: LATEST, category: "monster" });
    expect(cap.spawnableChunks).toBe(MOB_CAP_DIVISOR);
    expect(cap.globalCap).toBe(70);
    expect(cap.perPlayerCap).toBe(70);
  });

  it("scales with separated players and not with simulation distance", () => {
    const four = mobCap({ version: LATEST, category: "monster", players: 4 });
    expect(four.spawnableChunks).toBe(MOB_CAP_DIVISOR * 4);
    expect(four.globalCap).toBe(280);

    const short = mobCap({ version: LATEST, category: "monster", simulationDistance: 4 });
    const long = mobCap({ version: LATEST, category: "monster", simulationDistance: 32 });
    expect(short.globalCap).toBe(long.globalCap);
    expect(short.attemptChunks).toBeLessThan(long.attemptChunks);
    expect(short.attemptRadius).toBe(4);
    expect(long.attemptRadius).toBe(8);
  });

  it("players standing together share one chunk square", () => {
    const together = mobCap({
      version: LATEST,
      category: "monster",
      players: 4,
      playersSeparated: false,
    });
    expect(together.globalCap).toBe(70);
  });

  it("has no per player cap in 1.16.5", () => {
    expect(mobCap({ version: "1.16.5", category: "monster" }).perPlayerCap).toBeNull();
    expect(mobCap({ version: "1.18.2", category: "monster" }).perPlayerCap).toBe(70);
  });

  it("uses the water ambient cap of 20 and its shorter despawn radius", () => {
    const cap = mobCap({ version: LATEST, category: "water_ambient" });
    expect(cap.globalCap).toBe(20);
    expect(afkGeometry(LATEST, "water_ambient").instantDespawn).toBe(64);
  });

  it("counts only the chunks whose center is inside the 128 block circle", () => {
    expect(countAttemptChunks(8)).toBe(countAttemptChunks(32));
    expect(countAttemptChunks(8)).toBeLessThan(289);
    expect(countAttemptChunks(1)).toBe(9);
    expect(countAttemptChunks(0)).toBe(1);
  });

  it("reports headroom and fill against the supplied live count", () => {
    const cap = mobCap({ version: LATEST, category: "monster", currentMobs: 35 });
    expect(cap.headroom).toBe(35);
    expect(cap.fill).toBeCloseTo(0.5, 12);
  });
});

describe("farm rates", () => {
  const base = {
    version: LATEST,
    dimension: "overworld" as const,
    category: "monster",
    spawnSpaces: 1536,
    farmChunks: 9,
    surfaceY: 100,
    avgPack: 4,
    dwellSeconds: 30,
    afkDistance: 40,
  };

  it("produces a positive rate and names a bottleneck", () => {
    const result = farmRate(base);
    expect(result.perHour).toBeGreaterThan(0);
    expect(result.perHour).toBe(Math.min(result.spawnLimitedPerHour, result.capLimitedPerHour));
    expect(["spawn-attempts", "mob-cap"]).toContain(result.bottleneck);
    expect(result.terms.columnHeight).toBe(100 + 1 + 64 + 1);
  });

  it("a shorter column above the farm raises the rate proportionally", () => {
    const high = farmRate(base);
    const low = farmRate({ ...base, surfaceY: 20 });
    expect(low.spawnLimitedPerHour).toBeGreaterThan(high.spawnLimitedPerHour);
    expect(low.terms.columnHeight).toBeLessThan(high.terms.columnHeight);
  });

  it("zeroes the rate when the platform sits inside the 24 block exclusion sphere", () => {
    const result = farmRate({ ...base, afkDistance: 10 });
    expect(result.perHour).toBe(0);
    expect(result.bottleneck).toBe("geometry");
    expect(result.warnings.join(" ")).toContain("24 block exclusion");
  });

  it("zeroes the rate when the platform is past the 128 block chunk gate", () => {
    const result = farmRate({ ...base, afkDistance: 200 });
    expect(result.perHour).toBe(0);
    expect(result.warnings.join(" ")).toContain("128 block chunk gate");
  });

  it("warns without zeroing when the platform is inside the no-despawn sphere", () => {
    const result = farmRate({ ...base, afkDistance: 26 });
    expect(result.perHour).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("no-despawn");
  });

  it("becomes cap limited when the farm clears mobs slowly", () => {
    const result = farmRate({ ...base, spawnSpaces: 200000, farmChunks: 25, dwellSeconds: 600 });
    expect(result.bottleneck).toBe("mob-cap");
    expect(result.perHour).toBe(result.capLimitedPerHour);
  });

  it("goes to zero when the light rule refuses every attempt", () => {
    const result = farmRate({ ...base, lightChance: 0 });
    expect(result.perHour).toBe(0);
    expect(result.bottleneck).toBe("light");
  });

  it("uses the 1.16.5 world floor of 0 rather than -64", () => {
    const old = farmRate({ ...base, version: "1.16.5" });
    expect(old.terms.columnHeight).toBe(100 + 1 + 0 + 1);
  });
});

describe("errors", () => {
  it("rejects an unknown version", () => {
    expect(() => spawnsIn({ version: "1.7.10", biome: "plains", category: "monster" })).toThrow(
      ToolError,
    );
    try {
      spawnsIn({ version: "1.7.10", biome: "plains", category: "monster" });
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-version");
      expect((e as ToolError).fix).toContain("1.16.5");
    }
  });

  it("rejects an unknown biome", () => {
    try {
      spawnsIn({ version: LATEST, biome: "cheese_caves", category: "monster" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-biome");
    }
  });

  it("rejects a biome that does not exist in the chosen version", () => {
    try {
      spawnsIn({ version: "1.16.5", biome: "deep_dark", category: "monster" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("biome-not-in-version");
      expect((e as ToolError).message).toContain("1.16.5");
    }
  });

  it("rejects an unknown category", () => {
    try {
      spawnsIn({ version: LATEST, biome: "plains", category: "boss" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-category");
    }
  });

  it("rejects a category that did not exist yet", () => {
    try {
      mobCap({ version: "1.16.5", category: "axolotls" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("category-not-in-version");
    }
    expect(categoriesFor("1.16.5").map((c) => c.id)).not.toContain("axolotls");
    expect(categoriesFor(LATEST).map((c) => c.id)).toContain("axolotls");
  });
});

describe("the generic run surface", () => {
  it("defaults to plains monsters on the newest version", () => {
    const out = run("", {});
    expect(out["Biome"]).toContain("Plains");
    expect(out["Mob cap"]).toContain("70");
    expect(out["Spawn ring"]).toContain("24 to 128");
    expect(Object.keys(out)).toContain("Zombie");
  });

  it("accepts a namespaced biome id as input", () => {
    const out = run("minecraft:soul_sand_valley", { version: LATEST });
    expect(out["Biome"]).toContain("Soul Sand Valley");
    expect(out["Biome"]).toContain("nether");
  });

  it("reports an empty category as a result rather than an error", () => {
    const out = run("mushroom_fields", { version: LATEST, category: "monster" });
    expect(out["Result"]).toContain("Nothing");
  });

  it("threads light options through to the light chance row", () => {
    const out = run("plains", { version: LATEST, blockLight: 5 });
    expect(out["Light check"]).toBe("0% of attempts pass at this light level");
  });
});

describe("naming", () => {
  it("titles mob ids without the namespace", () => {
    expect(mobDisplayName("minecraft:zombified_piglin")).toBe("Zombified Piglin");
    expect(mobDisplayName("bat")).toBe("Bat");
  });
});
