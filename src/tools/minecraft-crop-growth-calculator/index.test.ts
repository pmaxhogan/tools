import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  bonemealUses,
  breeding,
  calculate,
  cropGrowthChance,
  finishCurve,
  growthSpeed,
  inGameDays,
  LAYOUT_PRESET_BY_ID,
  run,
  stageChance,
  timing,
  LAYOUT_PRESETS,
  type FarmLayout,
} from "./index";
import { meta } from "./meta";
import { CONSTANTS, GROWTH_VERSIONS, PLANTS, PLANT_BY_ID, plantModel } from "./data";

const LATEST = GROWTH_VERSIONS[GROWTH_VERSIONS.length - 1];

function layout(over: Partial<FarmLayout> = {}): FarmLayout {
  return {
    centerHydrated: true,
    neighbourFarmland: 8,
    neighbourHydrated: true,
    crowding: "grid",
    ...over,
  };
}

describe("growth speed", () => {
  it("matches the hand-computed weights for a fully hydrated crowded field", () => {
    // 1 base + 3 for the moist block below + 8 * 3/4 for the ring = 10,
    // halved by crowding on both axes.
    expect(growthSpeed(layout(), LATEST)).toBe(5);
  });

  it("does not halve a plant with neighbors on one axis only", () => {
    expect(growthSpeed(layout({ crowding: "row" }), LATEST)).toBe(10);
  });

  it("halves for a diagonal-only neighbor, matching the else branch", () => {
    expect(growthSpeed(layout({ crowding: "diagonal" }), LATEST)).toBe(5);
  });

  it("counts dry farmland as 1 rather than 3", () => {
    expect(growthSpeed(layout({ centerHydrated: false, neighbourHydrated: false }), LATEST)).toBe(
      2,
    );
  });

  it("gives water channels no growth credit at all", () => {
    // Rows separated by water: only the two blocks along the row are farmland.
    const speed = growthSpeed(layout({ neighbourFarmland: 2, crowding: "row" }), LATEST);
    expect(speed).toBe(5.5);
  });

  it("clamps a nonsense neighbor count into the real 0 to 8 range", () => {
    expect(growthSpeed(layout({ neighbourFarmland: 40 }), LATEST)).toBe(5);
    expect(growthSpeed(layout({ neighbourFarmland: -3, crowding: "none" }), LATEST)).toBe(4);
  });

  it("is identical in every supported version", () => {
    for (const v of GROWTH_VERSIONS) expect(growthSpeed(layout(), v)).toBe(5);
  });
});

describe("per random tick chance", () => {
  it("is 1 / (floor(25 / speed) + 1)", () => {
    expect(cropGrowthChance(5, LATEST)).toBeCloseTo(1 / 6, 12);
    expect(cropGrowthChance(10, LATEST)).toBeCloseTo(1 / 3, 12);
    expect(cropGrowthChance(5.5, LATEST)).toBeCloseTo(1 / 5, 12);
    expect(cropGrowthChance(2, LATEST)).toBeCloseTo(1 / 13, 12);
    expect(cropGrowthChance(4, LATEST)).toBeCloseTo(1 / 7, 12);
  });

  it("returns 0 for a speed of 0 instead of dividing by zero", () => {
    expect(cropGrowthChance(0, LATEST)).toBe(0);
  });

  it("applies the two-in-three attempt gate that only beetroot and torchflower have", () => {
    const beet = plantModel(PLANT_BY_ID.get("beetroots")!, LATEST);
    const wheat = plantModel(PLANT_BY_ID.get("wheat")!, LATEST);
    expect(stageChance(beet, 4, LATEST)).toBeCloseTo((1 / 7) * (2 / 3), 12);
    expect(stageChance(wheat, 4, LATEST)).toBeCloseTo(1 / 7, 12);
    for (const id of ["carrots", "potatoes", "melon_stem", "pitcher_crop"]) {
      const model = plantModel(PLANT_BY_ID.get(id)!, LATEST);
      expect(stageChance(model, 4, LATEST), id).toBeCloseTo(1 / 7, 12);
    }
  });
});

describe("timing distribution", () => {
  it("has the exact negative binomial mean", () => {
    // 7 stages, 1/6 per random tick, 3 draws per tick out of 4096 blocks.
    const t = timing(7, 1 / 6, 3, LATEST);
    expect(t.meanTicks).toBeCloseTo((7 * 4096 * 6) / 3, 6);
  });

  it("orders the percentiles and puts the mean above the median", () => {
    const t = timing(7, 1 / 6, 3, LATEST);
    expect(t.p5Ticks).toBeLessThan(t.medianTicks);
    expect(t.medianTicks).toBeLessThan(t.p95Ticks);
    // A sum of geometrics is right skewed, so the mean sits above the median.
    expect(t.meanTicks).toBeGreaterThan(t.medianTicks);
  });

  it("agrees with the closed-form geometric median for a single stage", () => {
    const perDraw = 1 / 5 / 4096;
    const expected = Math.ceil(Math.log(0.5) / (3 * Math.log(1 - perDraw)));
    expect(timing(1, 1 / 5, 3, LATEST).medianTicks).toBe(expected);
  });

  it("never finishes when the random tick speed is 0", () => {
    const t = timing(7, 1 / 6, 0, LATEST);
    expect(t.meanTicks).toBe(Infinity);
    expect(t.chancePerGameTick).toBe(0);
  });

  it("scales inversely with the random tick speed", () => {
    const a = timing(7, 1 / 6, 3, LATEST);
    const b = timing(7, 1 / 6, 30, LATEST);
    expect(a.meanTicks / b.meanTicks).toBeCloseTo(10, 6);
  });

  it("produces a monotone finish curve from 0 to near 1", () => {
    const curve = finishCurve(7, 1 / 6, 3, LATEST, 24);
    expect(curve.length).toBe(25);
    expect(curve[0].cdf).toBe(0);
    expect(curve[curve.length - 1].cdf).toBeGreaterThan(0.95);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].cdf).toBeGreaterThanOrEqual(curve[i - 1].cdf);
    }
  });

  it("returns an empty curve when nothing can ever grow", () => {
    expect(finishCurve(7, 1 / 6, 0, LATEST)).toEqual([]);
  });
});

describe("bone meal", () => {
  const model = (id: string) => plantModel(PLANT_BY_ID.get(id)!, LATEST);

  it("costs 2.390625 bone meal for wheat, the exact uniform 2 to 5 expectation", () => {
    expect(bonemealUses(model("wheat")).expectedUses).toBeCloseTo(2.390625, 9);
  });

  it("costs 4 for beetroot, because a quarter of uses advance nothing", () => {
    // The shared 2 to 5 roll is floor-divided by 3, so a roll of 2 gives 0.
    expect(bonemealUses(model("beetroots")).expectedUses).toBeCloseTo(4, 9);
  });

  it("is more expensive per stage for beetroot than for wheat", () => {
    const wheat = bonemealUses(model("wheat")).expectedUses / model("wheat").stages;
    const beet = bonemealUses(model("beetroots")).expectedUses / model("beetroots").stages;
    expect(beet).toBeGreaterThan(wheat);
  });

  it("charges a sapling for failed rolls, since the item is consumed anyway", () => {
    expect(bonemealUses(model("sapling")).expectedUses).toBeCloseTo(2 / 0.45, 9);
  });

  it("reports nether wart, sugar cane, and cactus as impossible to bone meal", () => {
    for (const id of ["nether_wart", "sugar_cane", "cactus"]) {
      const result = bonemealUses(model(id));
      expect(result.unsupported).toBe(true);
      expect(result.expectedUses).toBe(0);
    }
  });

  it("averages bamboo over the 1 to 2 blocks one bone meal adds", () => {
    expect(bonemealUses(model("bamboo")).expectedUses).toBeCloseTo(1 / 1.5, 9);
  });
});

describe("calculate", () => {
  it("gives wheat in a full hydrated field the classic 6 in 25 shape", () => {
    const r = calculate({ version: LATEST, plant: "wheat", layout: "full" });
    expect(r.speed).toBe(5);
    expect(r.timing.chancePerRandomTick).toBeCloseTo(1 / 6, 12);
    expect(r.timing.meanTicks).toBeCloseTo(57344, 6);
    expect(inGameDays(r.timing.meanTicks)).toBeCloseTo(57344 / 24000, 9);
  });

  it("shows rows and a full field reaching the same yield per block", () => {
    const r = calculate({ version: LATEST, plant: "wheat", layout: "rows" });
    const rows = r.layouts.find((l) => l.id === "rows")!;
    const full = r.layouts.find((l) => l.id === "full")!;
    expect(rows.meanTicks * 2).toBeCloseTo(full.meanTicks, 6);
    expect(rows.yieldPerHourPerBlock).toBeCloseTo(full.yieldPerHourPerBlock, 9);
  });

  it("ranks water channels below a plain hydrated field", () => {
    const r = calculate({ version: LATEST, plant: "wheat", layout: "full" });
    const water = r.layouts.find((l) => l.id === "water-rows")!;
    const full = r.layouts.find((l) => l.id === "full")!;
    expect(water.speed).toBe(5.5);
    expect(water.yieldPerHourPerBlock).toBeLessThan(full.yieldPerHourPerBlock);
  });

  it("offers no layout comparison for a plant that ignores farmland", () => {
    const r = calculate({ version: LATEST, plant: "nether_wart" });
    expect(r.speed).toBeNull();
    expect(r.layouts).toEqual([]);
    expect(r.timing.chancePerRandomTick).toBeCloseTo(0.1, 12);
    expect(r.timing.meanTicks).toBeCloseTo((3 * 4096) / 0.1 / 3, 6);
  });

  it("needs 16 random ticks per sugar cane block", () => {
    const r = calculate({ version: LATEST, plant: "sugar_cane" });
    expect(r.model.stages).toBe(16);
    expect(r.timing.chancePerRandomTick).toBe(1);
    expect(r.timing.meanTicks).toBeCloseTo((16 * 4096) / 3, 6);
  });

  it("adds the stem fruit roll and scales it with the usable sides", () => {
    const four = calculate({ version: LATEST, plant: "melon_stem", layout: "rows", fruitSides: 4 });
    const one = calculate({ version: LATEST, plant: "melon_stem", layout: "rows", fruitSides: 1 });
    expect(four.fruit!.expectedRolls).toBeCloseTo(1, 9);
    expect(one.fruit!.expectedRolls).toBeCloseTo(4, 9);
    expect(one.fruit!.meanTicks).toBeCloseTo(four.fruit!.meanTicks * 4, 6);
  });

  it("stops growth completely when the chunk is not ticking", () => {
    const r = calculate({ version: LATEST, plant: "wheat", chunkTicking: false });
    expect(r.timing.meanTicks).toBe(Infinity);
    expect(r.notes.join(" ")).toContain("simulation distance");
  });

  it("reports the random tick speed table relative to the default", () => {
    const r = calculate({ version: LATEST, plant: "wheat", layout: "full" });
    const base = r.tickSpeeds.find(
      (t) => t.randomTickSpeed === CONSTANTS[LATEST].randomTickSpeedDefault,
    )!;
    expect(base.relative).toBeCloseTo(1, 9);
    const fast = r.tickSpeeds.find((t) => t.randomTickSpeed === 100)!;
    expect(fast.relative).toBeCloseTo(100 / 3, 6);
  });

  it("accepts an explicit custom layout over the preset", () => {
    const r = calculate({
      version: LATEST,
      plant: "carrots",
      layout: "full",
      custom: { crowding: "none", neighbourFarmland: 0 },
    });
    expect(r.speed).toBe(4);
  });

  it("throws a typed error for an unknown version", () => {
    expect(() => calculate({ version: "1.7.10", plant: "wheat" })).toThrow(ToolError);
    try {
      calculate({ version: "1.7.10", plant: "wheat" });
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-version");
      expect((e as ToolError).fix).toContain(LATEST);
    }
  });

  it("throws a typed error for an unknown plant", () => {
    try {
      calculate({ version: LATEST, plant: "bananas" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-plant");
    }
  });

  it("throws a typed error for a plant that predates the chosen version", () => {
    try {
      calculate({ version: "1.16.5", plant: "torchflower_crop" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("plant-not-in-version");
    }
  });

  it("computes every plant in every version it ships in", () => {
    for (const plant of PLANTS) {
      for (const version of plant.versions) {
        const r = calculate({ version, plant: plant.id });
        expect(Number.isFinite(r.timing.meanTicks)).toBe(true);
        expect(r.timing.meanTicks).toBeGreaterThan(0);
      }
    }
  });
});

describe("breeding", () => {
  it("uses the real love, cooldown, and baby constants", () => {
    const b = breeding({ version: LATEST, animal: "cow" });
    expect(b.loveTicks).toBe(600);
    expect(b.cooldownTicks).toBe(6000);
    expect(b.babyTicks).toBe(24000);
    expect(b.babiesPerHour).toBeCloseTo(12, 9);
  });

  it("models the truncating 10 percent feed and its stall", () => {
    const b = breeding({ version: LATEST, animal: "cow" });
    expect(b.firstFeedSavesTicks).toBe(2400);
    // The speed up truncates to zero below 200 ticks, so a baby can never be
    // fed all the way to adult.
    expect(b.ticksAfterFeeding).toBeGreaterThan(0);
    expect(b.ticksAfterFeeding).toBeLessThan(200);
    expect(b.feedsToAdult).toBeGreaterThan(30);
    expect(b.foodPerAdult).toBe(2 + b.feedsToAdult);
  });

  it("costs two food items per baby regardless of the animal", () => {
    for (const id of ["cow", "pig", "chicken", "sheep"]) {
      expect(breeding({ version: LATEST, animal: id }).foodPerBaby).toBe(2);
    }
  });

  it("scales the hourly rate with the number of pairs", () => {
    const one = breeding({ version: LATEST, animal: "pig", pairs: 1 });
    const ten = breeding({ version: LATEST, animal: "pig", pairs: 10 });
    expect(ten.babiesPerHour).toBeCloseTo(one.babiesPerHour * 10, 9);
  });

  it("calls out animals that lay eggs instead of spawning a baby", () => {
    const b = breeding({ version: LATEST, animal: "turtle" });
    expect(b.notes.join(" ")).toContain("eggs");
  });

  it("throws a typed error for an unknown animal", () => {
    try {
      breeding({ version: LATEST, animal: "dragon" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-animal");
    }
  });

  it("throws a typed error for an animal that predates the chosen version", () => {
    try {
      breeding({ version: "1.16.5", animal: "camel" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("animal-not-in-version");
    }
  });
});

describe("run", () => {
  it("defaults to wheat and returns labeled rows", () => {
    const out = run("", {});
    expect(out.Plant).toContain("Wheat");
    expect(out["Average time"]).toContain("in game days");
    expect(out["Chance per random tick"]).toBe("1 in 6.00");
  });

  it("reads the plant from the input string", () => {
    expect(run("carrots", {}).Plant).toContain("Carrots");
  });

  it("adds breeding rows when an animal is requested", () => {
    const out = run("wheat", { animal: "cow" });
    expect(out["Breeding cooldown"]).toContain("min");
    expect(out["Food per animal"]).toContain("2 to breed");
  });

  it("says plainly when bone meal does nothing", () => {
    expect(run("cactus", {})["Bone meal"]).toContain("does nothing");
  });

  it("never emits an em dash or en dash in any user-facing string", () => {
    const out = run("wheat", { animal: "cow", layout: "water-rows" });
    for (const [k, v] of Object.entries(out)) {
      expect(k).not.toMatch(/[–—]/);
      expect(v).not.toMatch(/[–—]/);
    }
    for (const preset of LAYOUT_PRESET_BY_ID.values()) {
      expect(`${preset.label} ${preset.note}`).not.toMatch(/[–—]/);
    }
  });
});

describe("meta", () => {
  it("keeps the layout list in meta in step with the logic presets", () => {
    const specs = meta.options?.find((o) => o.id === "layout");
    expect(specs?.kind).toBe("select");
    const ids = (specs as { options: { value: string; label: string }[] }).options;
    expect(ids.map((o) => o.value)).toEqual(LAYOUT_PRESETS.map((l) => l.id));
    expect(ids.map((o) => o.label)).toEqual(LAYOUT_PRESETS.map((l) => l.label));
  });

  it("ends the what copy with the required attribution line", () => {
    expect(
      meta.copy.what.endsWith(
        "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
      ),
    ).toBe(true);
  });

  it("uses no em dashes or en dashes anywhere in the page copy", () => {
    const text = [
      meta.name,
      meta.description,
      meta.copy.what,
      meta.copy.how,
      meta.copy.why,
      ...meta.copy.faq.flatMap((f) => [f.q, f.a]),
      ...(meta.options ?? []).flatMap((o) =>
        o.kind === "select"
          ? [o.label, ...(o.options ?? []).flatMap((x) => [x.label, ...x.synonyms])]
          : [o.label],
      ),
    ].join(" ");
    expect(text).not.toMatch(/[–—]/);
  });
});
