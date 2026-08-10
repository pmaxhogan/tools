import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DAY_SECONDS,
  INVENTORY_SLOTS,
  canEat,
  drainPlan,
  duration,
  eatFood,
  effectivePoints,
  exhaustionCovered,
  exhaustionPerSecond,
  freshState,
  healthPerItem,
  rankFoods,
  regenPlan,
  run,
  saturationDrain,
  simulate,
  stepTick,
  sustainPlan,
  type HungerState,
  type McHungerOpts,
  type SimEnv,
} from "./index";
import {
  ACTIVITIES,
  ACTIVITY_BY_ID,
  ACTIVITY_PRESETS,
  HUNGER_VERSIONS,
  MECHANICS,
  PEACEFUL_REGEN,
  activitiesFor,
  foodById,
  foodsFor,
  type VersionId,
} from "./data";
import { meta } from "./meta";
import { flattenSelectOptions } from "../../lib/select-options";

const V: VersionId = "1.21.11";

function opts(over: Partial<McHungerOpts> = {}): McHungerOpts {
  return {
    mode: "drain",
    version: V,
    difficulty: "normal",
    food: "cooked_beef",
    startFood: 20,
    startSaturation: 5,
    startHealth: 10,
    hearts: 1,
    sprintBlocksPerMinute: 300,
    swimBlocksPerMinute: 0,
    jumpsPerMinute: 0,
    blocksMinedPerMinute: 0,
    hitsPerMinute: 0,
    hitsTakenPerMinute: 0,
    ...over,
  };
}

const env: SimEnv = {
  version: V,
  difficulty: "normal",
  naturalRegen: true,
  maxHealth: 20,
  exhaustionPerTick: 0,
};

describe("the data set", () => {
  it("ships a food table for every verified version", () => {
    for (const v of HUNGER_VERSIONS) expect(foodsFor(v).length).toBeGreaterThan(35);
  });

  it("never lists an item that cannot actually be eaten", () => {
    for (const v of HUNGER_VERSIONS) {
      const ids = foodsFor(v).map((f) => f.id);
      for (const bucket of [
        "cod_bucket",
        "salmon_bucket",
        "pufferfish_bucket",
        "tropical_fish_bucket",
      ]) {
        expect(ids, `${v}: ${bucket}`).not.toContain(bucket);
      }
    }
  });

  it("keeps every food's numbers inside the game's own limits", () => {
    for (const v of HUNGER_VERSIONS) {
      for (const f of foodsFor(v)) {
        expect(f.nutrition, f.id).toBeGreaterThanOrEqual(0);
        expect(f.nutrition, f.id).toBeLessThanOrEqual(MECHANICS.maxFood);
        expect(f.saturation, f.id).toBeGreaterThanOrEqual(0);
        expect(f.stack, f.id).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("the metadata", () => {
  it("keeps the matrix slug and the Minecraft category", () => {
    expect(meta.slug).toBe("minecraft-hunger-calculator");
    expect(meta.matrixSlug).toBe("minecraft-hunger");
    expect(meta.category).toBe("Minecraft");
  });

  it("only offers foods that exist in every selectable version", () => {
    const spec = meta.options?.find((o) => o.id === "food");
    expect(spec?.kind).toBe("select");
    const leaves = flattenSelectOptions(spec as never);
    expect(leaves.length).toBeGreaterThan(6);
    for (const leaf of leaves) {
      for (const v of HUNGER_VERSIONS) {
        expect(foodById(v, leaf.value), `${leaf.value} in ${v}`).toBeDefined();
      }
    }
  });

  it("uses no em or en dashes in any user-facing copy", () => {
    const text = JSON.stringify(meta);
    expect(text).not.toMatch(/[–—]/);
  });

  it("ends the what copy with the Mojang disclaimer", () => {
    expect(
      meta.copy.what.endsWith(
        "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
      ),
    ).toBe(true);
  });

  it("states the privacy claim in the exact approved wording", () => {
    expect(meta.copy.why).toContain("your files and inputs never leave your device");
    expect(JSON.stringify(meta)).not.toContain("zero network requests");
  });

  it("gives every select option search synonyms", () => {
    for (const option of meta.options ?? []) {
      if (option.kind !== "select") continue;
      for (const leaf of flattenSelectOptions(option)) {
        expect(Array.isArray(leaf.synonyms), `${option.id}/${leaf.value}`).toBe(true);
      }
    }
  });
});

describe("version-gated activities", () => {
  it("only offers the Lunge enchantment where the enchantment exists", () => {
    const lunge = ACTIVITY_BY_ID.get("ench_lunge");
    expect(lunge, "Lunge applies exhaustion from 1.21.2 on").toBeDefined();
    expect(lunge!.exhaustion).toBe(4);
    for (const v of ["1.16.5", "1.18.2", "1.20.6", "1.21.1"] as const) {
      expect(activitiesFor(v).map((a) => a.id)).not.toContain("ench_lunge");
    }
    for (const v of ["1.21.11", "26.2"] as const) {
      expect(activitiesFor(v).map((a) => a.id)).toContain("ench_lunge");
    }
  });

  it("offers every ungated activity in every version", () => {
    const ungated = ACTIVITIES.filter((a) => !a.availableIn).map((a) => a.id);
    expect(ungated.length).toBeGreaterThanOrEqual(9);
    for (const v of HUNGER_VERSIONS) {
      const ids = activitiesFor(v).map((a) => a.id);
      for (const id of ungated) expect(ids, `${v}: ${id}`).toContain(id);
    }
  });
});

describe("the activity presets", () => {
  it("only reference known activities", () => {
    for (const preset of ACTIVITY_PRESETS) {
      for (const id of Object.keys(preset.rates)) {
        expect(ACTIVITY_BY_ID.has(id), `${preset.id}: ${id}`).toBe(true);
      }
    }
  });

  it("flag every preset that assumes a measured travel speed", () => {
    const sprinting = ACTIVITY_PRESETS.find((p) => p.id === "sprinting")!;
    expect(sprinting.approximate).toBe(true);
    const idle = ACTIVITY_PRESETS.find((p) => p.id === "idle")!;
    expect(idle.approximate).toBe(false);
    expect(exhaustionPerSecond(presetMix(idle.rates))).toBe(0);
  });

  it("produce a usable exhaustion rate for every preset", () => {
    for (const preset of ACTIVITY_PRESETS) {
      expect(exhaustionPerSecond(presetMix(preset.rates))).toBeGreaterThanOrEqual(0);
    }
  });
});

function presetMix(rates: Record<string, number>) {
  return Object.entries(rates).map(([activityId, perMinute]) => ({ activityId, perMinute }));
}

describe("exhaustion arithmetic", () => {
  it("sums an activity mix into exhaustion per second", () => {
    // 600 blocks sprinted per minute is 10 per second at 0.1 each.
    expect(exhaustionPerSecond([{ activityId: "sprint", perMinute: 600 }])).toBeCloseTo(1, 9);
    expect(
      exhaustionPerSecond([
        { activityId: "mine", perMinute: 120 },
        { activityId: "attack", perMinute: 60 },
      ]),
    ).toBeCloseTo((0.005 * 120 + 0.1 * 60) / 60, 9);
  });

  it("treats walking as free", () => {
    expect(exhaustionPerSecond([{ activityId: "walk", perMinute: 100000 }])).toBe(0);
  });

  it("rejects an unknown activity", () => {
    expect(() => exhaustionPerSecond([{ activityId: "flying", perMinute: 1 }])).toThrow(ToolError);
  });

  it("rejects a negative rate", () => {
    expect(() => exhaustionPerSecond([{ activityId: "sprint", perMinute: -1 }])).toThrow(ToolError);
  });
});

describe("drain planning", () => {
  it("returns null timings when nothing costs exhaustion", () => {
    const plan = drainPlan(20, 5, 0);
    expect(plan.secondsToEmpty).toBeNull();
    expect(plan.pointsPerHour).toBe(0);
  });

  it("counts a partial saturation point as a whole burn", () => {
    expect(drainPlan(20, 0.01, 1).secondsToSaturationGone).toBeCloseTo(4, 9);
  });

  it("reports sprint loss at the food level of 6, not at zero", () => {
    const plan = drainPlan(20, 0, 1);
    expect(plan.secondsToSprintLost).toBeCloseTo(56, 9);
    expect(plan.secondsToEmpty).toBeCloseTo(80, 9);
  });

  it("reports no sprint delay when the bar is already at or below 6", () => {
    expect(drainPlan(6, 0, 1).secondsToSprintLost).toBe(0);
    expect(drainPlan(3, 0, 1).secondsToSprintLost).toBe(0);
  });
});

/**
 * The Peaceful saturation refill is the one real version boundary in the
 * whole mechanic: Player#aiStep gained setSaturation(sat + 1.0F) every 20
 * ticks in 1.21, and 1.21.2 moved the block to
 * ServerPlayer#tickRegeneration. Before 1.21 Peaceful refills health and the
 * hunger bar but never saturation, so the hidden pool still burns to zero.
 * These tests exist because a panel once showed "never" on every version.
 */
describe("the Peaceful saturation refill boundary", () => {
  const BEFORE = ["1.16.5", "1.18.2", "1.20.6"] as const;
  const AFTER = ["1.21.1", "1.21.11", "26.2"] as const;

  /** The rate QA reproduced with: the default 337 blocks sprinted per minute. */
  const sprintExh = exhaustionPerSecond([{ activityId: "sprint", perMinute: 337 }]);

  function drain(
    v: VersionId,
    exhPerSecond: number,
    difficulty: "peaceful" | "normal" = "peaceful",
  ) {
    return saturationDrain(
      { food: 20, saturation: 5, exhaustion: 0, health: 10, tickTimer: 0, tickCount: 0 },
      {
        version: v,
        difficulty,
        naturalRegen: true,
        maxHealth: 20,
        exhaustionPerTick: exhPerSecond / 20,
      },
    );
  }

  it("splits the versions exactly where the source does", () => {
    for (const v of BEFORE) expect(PEACEFUL_REGEN[v]!.saturationEvery, v).toBe(0);
    for (const v of AFTER) expect(PEACEFUL_REGEN[v]!.saturationEvery, v).toBe(20);
    // Health and hunger refills are unchanged across the boundary.
    for (const v of HUNGER_VERSIONS) {
      expect(PEACEFUL_REGEN[v]!.healEvery, v).toBe(20);
      expect(PEACEFUL_REGEN[v]!.foodEvery, v).toBe(10);
    }
  });

  it("burns saturation to zero on Peaceful before 1.21", () => {
    for (const v of BEFORE) {
      const d = drain(v, sprintExh);
      expect(d.refilling, v).toBe(false);
      // 5 saturation is 5 burns of 4 exhaustion at 0.1 x 337 / 60 per second.
      expect(d.seconds, v).toBeCloseTo(20 / sprintExh, 6);
      expect(d.seconds, v).toBeCloseTo(35.61, 1);
    }
  });

  it("never empties saturation on Peaceful from 1.21 at an ordinary rate", () => {
    for (const v of AFTER) {
      const d = drain(v, sprintExh);
      expect(d.refilling, v).toBe(true);
      expect(d.seconds, v).toBeNull();
    }
  });

  it("still empties saturation from 1.21 when the burn outruns the refill", () => {
    // The refill is 1 saturation per second, so it takes more than 4
    // exhaustion per second to out-burn it. This proves the answer is
    // simulated rather than a hardcoded "never".
    for (const v of AFTER) {
      const d = drain(v, 12);
      expect(d.refilling, v).toBe(true);
      expect(d.seconds, v).not.toBeNull();
      expect(d.seconds!, v).toBeGreaterThan(0);
    }
  });

  it("does not change any non-Peaceful difficulty on any version", () => {
    for (const v of HUNGER_VERSIONS) {
      const d = drain(v, sprintExh, "normal");
      expect(d.refilling, v).toBe(false);
      expect(d.seconds, v).toBeCloseTo(20 / sprintExh, 6);
    }
  });

  it("reports the boundary through run() drain mode too", () => {
    const at = (v: VersionId) =>
      run(
        undefined,
        opts({
          mode: "drain",
          version: v,
          difficulty: "peaceful",
          startFood: 20,
          startSaturation: 5,
          sprintBlocksPerMinute: 337,
        }),
      )["Saturation gone after"]!;
    for (const v of BEFORE) expect(at(v), v).toBe("35.6 s");
    for (const v of AFTER) expect(at(v), v).toContain("never");
    // The hunger bar itself is pinned by Peaceful on every version.
    for (const v of HUNGER_VERSIONS) {
      const rows = run(
        undefined,
        opts({ mode: "drain", version: v, difficulty: "peaceful", sprintBlocksPerMinute: 337 }),
      );
      expect(rows["Hunger bar empty after"], v).toContain("never");
      expect(rows["Sprinting stops after"], v).toContain("never");
    }
  });

  it("keeps the FAQ copy on the same side of the boundary as the data", () => {
    const faq = meta.copy.faq.map((f) => f.a).join(" ");
    // The copy must name 1.21 as the release that added the refill, and the
    // data must agree. If either moves, this fails.
    expect(faq).toMatch(/1\.21 .*Peaceful a saturation refill/);
    const firstWithRefill = HUNGER_VERSIONS.find((v) => PEACEFUL_REGEN[v]!.saturationEvery > 0);
    expect(firstWithRefill).toBe("1.21.1");
  });
});

describe("eating", () => {
  it("clamps saturation to the food level after the bar fills", () => {
    const after = eatFood(
      { ...freshState(), food: 4, saturation: 0 },
      foodById(V, "golden_carrot")!,
    );
    expect(after.food).toBe(10);
    expect(after.saturation).toBe(10);
  });

  it("never exceeds a full hunger bar", () => {
    const after = eatFood({ ...freshState(), food: 20, saturation: 0 }, foodById(V, "bread")!);
    expect(after.food).toBe(20);
  });

  it("gates ordinary food on a full bar but lets always edible food through", () => {
    const full: HungerState = { ...freshState(), food: 20 };
    expect(canEat(full, foodById(V, "bread")!)).toBe(false);
    expect(canEat(full, foodById(V, "golden_apple")!)).toBe(true);
    expect(canEat({ ...full, food: 19 }, foodById(V, "bread")!)).toBe(true);
  });

  it("follows the honey bottle version boundary", () => {
    const full: HungerState = { ...freshState(), food: 20 };
    expect(canEat(full, foodById("1.21.1", "honey_bottle")!)).toBe(false);
    expect(canEat(full, foodById("1.21.11", "honey_bottle")!)).toBe(true);
  });
});

describe("food value", () => {
  it("puts steak and cooked porkchop at the top per inventory slot", () => {
    const bySlot = rankFoods(V, "slot");
    expect(
      bySlot
        .slice(0, 2)
        .map((r) => r.food.id)
        .sort(),
    ).toEqual(["cooked_beef", "cooked_porkchop"]);
  });

  it("puts the golden carrot at the top on saturation alone", () => {
    expect(rankFoods(V, "saturation")[0]!.food.id).toBe("golden_carrot");
  });

  it("puts rabbit stew first per item and near the bottom per slot", () => {
    const byItem = rankFoods(V, "item");
    expect(byItem[0]!.food.id).toBe("rabbit_stew");
    const bySlot = rankFoods(V, "slot");
    const stewIndex = bySlot.findIndex((r) => r.food.id === "rabbit_stew");
    expect(stewIndex).toBeGreaterThan(bySlot.length / 2);
  });

  it("charges junk food for its own Hunger effect", () => {
    const flesh = foodById(V, "rotten_flesh")!;
    expect(flesh.nutrition + flesh.saturation).toBeCloseTo(4.8, 9);
    expect(effectivePoints(flesh)).toBeCloseTo(4.2, 9);
    expect(exhaustionCovered(flesh)).toBeCloseTo(16.8, 9);
  });

  it("values one point of food at two thirds of a health point", () => {
    const bread = foodById(V, "bread")!;
    expect(healthPerItem(bread)).toBeCloseTo(11 * (4 / 6), 9);
  });

  it("scales per stack and per inventory the same way", () => {
    const row = rankFoods(V, "item").find((r) => r.food.id === "cooked_beef")!;
    expect(row.heartsPerStack).toBeCloseTo(row.heartsPerItem * 64, 9);
    expect(row.heartsPerSlot).toBe(row.heartsPerStack);
    expect(row.heartsPerInventory).toBeCloseTo(row.heartsPerSlot * INVENTORY_SLOTS, 6);
  });

  it("ranks every version without crashing", () => {
    for (const v of HUNGER_VERSIONS) expect(rankFoods(v, "item").length).toBe(foodsFor(v).length);
  });
});

describe("sustain planning", () => {
  it("scales items per hour with the exhaustion rate", () => {
    const steak = foodById(V, "cooked_beef")!;
    const slow = sustainPlan(steak, 0.5);
    const fast = sustainPlan(steak, 1);
    expect(fast.itemsPerHour).toBeCloseTo(slow.itemsPerHour * 2, 9);
    expect(slow.itemsPerHour).toBeCloseTo((0.5 * 3600) / (20.8 * 4), 9);
  });

  it("uses the 20 minute in-game day", () => {
    expect(DAY_SECONDS).toBe(1200);
    const plan = sustainPlan(foodById(V, "bread")!, 1);
    expect(plan.itemsPerDay).toBeCloseTo(plan.itemsPerHour / 3, 9);
  });

  it("refuses a food that costs more than it gives", () => {
    expect(() => sustainPlan(foodById(V, "pufferfish")!, 1)).not.toThrow();
    const worthless = { ...foodById(V, "pufferfish")!, hungerExhaustion: 100 };
    expect(() => sustainPlan(worthless, 1)).toThrow(ToolError);
  });
});

describe("the tick simulation", () => {
  it("never lets exhaustion pass 40", () => {
    let s = freshState();
    for (let i = 0; i < 50; i++) s = stepTick(s, { ...env, exhaustionPerTick: 100 }).state;
    expect(s.exhaustion).toBeLessThanOrEqual(MECHANICS.maxExhaustion);
  });

  it("keeps the hunger bar in range under any load", () => {
    let s = freshState();
    for (let i = 0; i < 5000; i++) s = stepTick(s, { ...env, exhaustionPerTick: 3 }).state;
    expect(s.food).toBeGreaterThanOrEqual(0);
    expect(s.food).toBeLessThanOrEqual(20);
    expect(s.saturation).toBeGreaterThanOrEqual(0);
  });

  it("resets the shared timer when neither regeneration nor starving applies", () => {
    const start: HungerState = { ...freshState(), food: 10, saturation: 0, health: 10 };
    const after = stepTick(start, env);
    expect(after.state.tickTimer).toBe(0);
    expect(after.healed).toBe(0);
    expect(after.starved).toBe(0);
  });

  it("does not regenerate at full health", () => {
    const run = simulate({ ...freshState(), food: 20, saturation: 20 }, env, 400);
    expect(run.healed).toBe(0);
    expect(run.end.health).toBe(20);
  });
});

describe("regeneration planning", () => {
  it("heals one heart in 160 ticks on the normal path", () => {
    const plan = regenPlan({ ...freshState(), food: 19, saturation: 0, health: 10 }, env, 1);
    expect(plan.ticks).toBe(160);
    expect(plan.seconds).toBe(8);
    expect(plan.path).toBe("normal");
    expect(plan.reached).toBe(true);
  });

  it("heals far faster on the saturated path", () => {
    const plan = regenPlan({ ...freshState(), food: 20, saturation: 20, health: 10 }, env, 1);
    expect(plan.ticks).toBe(20);
    expect(plan.path).toBe("saturated");
  });

  it("reports a stall instead of looping when the bar is too low", () => {
    const plan = regenPlan({ ...freshState(), food: 10, saturation: 0, health: 1 }, env, 5);
    expect(plan.reached).toBe(false);
    expect(plan.healed).toBe(0);
    expect(plan.path).toBe("none");
    expect(plan.ticks).toBeLessThan(20);
  });

  it("stops immediately at full health instead of spinning to the tick cap", () => {
    const plan = regenPlan({ ...freshState(), food: 20, saturation: 20, health: 20 }, env, 5);
    expect(plan.reached).toBe(false);
    expect(plan.healed).toBe(0);
    expect(plan.ticks).toBeLessThan(5);
  });

  it("never heals past full health", () => {
    const plan = regenPlan({ ...freshState(), food: 20, saturation: 20, health: 19.5 }, env, 5);
    expect(plan.end.health).toBe(20);
    expect(plan.reached).toBe(false);
  });

  it("reports a stall when natural regeneration is switched off", () => {
    const plan = regenPlan(
      { ...freshState(), food: 20, saturation: 20, health: 1 },
      { ...env, naturalRegen: false },
      1,
    );
    expect(plan.reached).toBe(false);
  });

  it("switches paths when the saturation runs out mid heal", () => {
    const plan = regenPlan({ ...freshState(), food: 20, saturation: 1.5, health: 1 }, env, 3);
    expect(plan.path).toBe("both");
  });
});

describe("run(): drain mode", () => {
  it("reports the drain timings for a sprinting player", () => {
    const out = run(undefined, opts({ sprintBlocksPerMinute: 600 }));
    expect(out["Exhaustion per second"]).toBe("1");
    expect(out["Hunger bar empty after"]).toBe("1 min 40 s");
    expect(out["Points burned per hour"]).toContain("900");
  });

  it("says Peaceful never empties the bar and never costs you sprinting", () => {
    const out = run(undefined, opts({ difficulty: "peaceful" }));
    expect(out["Hunger bar empty after"]).toContain("never");
    expect(out["Sprinting stops after"]).toContain("never");
    expect(out["Starvation floor"]).toContain("Peaceful");
  });

  it("counts swimming and hits taken as well as sprinting", () => {
    const swim = run(undefined, opts({ sprintBlocksPerMinute: 0, swimBlocksPerMinute: 600 }));
    expect(swim["Exhaustion per second"]).toBe("0.1");
    const hurt = run(undefined, opts({ sprintBlocksPerMinute: 0, hitsTakenPerMinute: 60 }));
    expect(hurt["Exhaustion per second"]).toBe("0.1");
  });

  it("names the starvation floor per difficulty", () => {
    expect(run(undefined, opts({ difficulty: "easy" }))["Starvation floor"]).toContain("10 health");
    expect(run(undefined, opts({ difficulty: "normal" }))["Starvation floor"]).toContain(
      "1 health",
    );
    expect(run(undefined, opts({ difficulty: "hard" }))["Starvation floor"]).toContain("kill");
  });
});

describe("run(): sustain, regen, and compare modes", () => {
  it("plans how much food an hour of sprinting costs", () => {
    const out = run(undefined, opts({ mode: "sustain", sprintBlocksPerMinute: 600 }));
    expect(out["Items per hour"]).toBe("43.3");
    expect(out["Restores per item"]).toContain("8 hunger points");
  });

  it("handles a zero exhaustion mix in sustain mode", () => {
    const out = run(undefined, opts({ mode: "sustain", sprintBlocksPerMinute: 0 }));
    expect(out["Items per hour"]).toContain("0");
  });

  it("times a regeneration on the normal path", () => {
    const out = run(
      undefined,
      opts({
        mode: "regen",
        startFood: 19,
        startSaturation: 0,
        startHealth: 10,
        hearts: 1,
        sprintBlocksPerMinute: 0,
      }),
    );
    expect(out["Time taken"]).toBe("8 s");
    expect(out["Regeneration path"]).toContain("80 ticks");
  });

  it("lists the best foods with the classic answers on top", () => {
    const out = run(undefined, opts({ mode: "compare" }));
    expect(out["1. Rabbit Stew"]).toContain("7.33 hearts per item");
    expect(out["Best per inventory slot"]).toMatch(/Steak|Cooked Porkchop/);
    expect(out["Highest saturation"]).toContain("Golden Carrot");
  });
});

describe("run(): errors", () => {
  it("rejects an unknown mode", () => {
    expect(() => run(undefined, opts({ mode: "nope" }))).toThrow(ToolError);
  });

  it("rejects an unknown version", () => {
    expect(() => run(undefined, opts({ mode: "compare", version: "1.7.10" }))).toThrow(ToolError);
  });

  it("rejects an unknown difficulty", () => {
    expect(() => run(undefined, opts({ difficulty: "extreme" }))).toThrow(ToolError);
  });

  it("rejects a food that does not exist in the chosen version", () => {
    expect(() =>
      run(undefined, opts({ mode: "sustain", version: "1.16.5", food: "glow_berries" })),
    ).toThrow(ToolError);
    expect(() => run(undefined, opts({ mode: "sustain", food: "ominous_bottle" }))).toThrow(
      ToolError,
    );
  });

  it("rejects out of range and non numeric inputs", () => {
    expect(() => run(undefined, opts({ startFood: 25 }))).toThrow(ToolError);
    expect(() => run(undefined, opts({ startSaturation: -1 }))).toThrow(ToolError);
    expect(() => run(undefined, opts({ sprintBlocksPerMinute: Number.NaN }))).toThrow(ToolError);
    expect(() => run(undefined, opts({ mode: "regen", hearts: 0 }))).toThrow(ToolError);
  });

  it("carries a code and a fix hint on every thrown error", () => {
    try {
      run(undefined, opts({ mode: "nope" }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("unknown-mode");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });
});

describe("duration formatting", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(duration(12.34)).toBe("12.3 s");
    expect(duration(100)).toBe("1 min 40 s");
    expect(duration(7200)).toBe("2 h 0 min");
    expect(duration(null)).toBe("never at this rate");
  });
});
