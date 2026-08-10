import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { calculate, outcomeKey, run } from "./index";
import { LOOT_TABLES, LOOT_VERSIONS } from "./tables";

/**
 * Structural exactness tests: every expected number below is hand-derived
 * from the shipped loot table JSON plus the decompiled game formulas (see
 * the semantics notes in index.ts). No tolerance fudging beyond float eps.
 */

function distMap(result: ReturnType<typeof calculate>, item: string): Map<number, number> {
  const row = result.items.find((r) => r.item === item);
  expect(row, `expected ${item} in results`).toBeDefined();
  return new Map(row!.dist);
}

describe("diamond ore (1.21.11)", () => {
  it("bare pickaxe drops exactly one diamond", () => {
    const r = calculate({ version: "1.21.11", table: "blocks/diamond_ore", tool: "pickaxe" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].item).toBe("minecraft:diamond");
    expect(r.items[0].expected).toBeCloseTo(1, 12);
    expect(r.items[0].chance).toBeCloseTo(1, 12);
  });

  it("fortune 3 gives the exact ore_drops distribution {1:0.4, 2:0.2, 3:0.2, 4:0.2}", () => {
    // ore_drops: m = max(nextInt(5) - 1, 0) + 1 -> P(1)=2/5, P(2..4)=1/5 each.
    const r = calculate({
      version: "1.21.11",
      table: "blocks/diamond_ore",
      tool: "pickaxe",
      fortune: 3,
    });
    const d = distMap(r, "minecraft:diamond");
    expect(d.get(1)).toBeCloseTo(0.4, 12);
    expect(d.get(2)).toBeCloseTo(0.2, 12);
    expect(d.get(3)).toBeCloseTo(0.2, 12);
    expect(d.get(4)).toBeCloseTo(0.2, 12);
    expect(r.items[0].expected).toBeCloseTo(2.2, 12);
  });

  it("silk touch short-circuits the alternatives to the ore block itself", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/diamond_ore",
      tool: "pickaxe",
      silkTouch: true,
      fortune: 3, // fortune must NOT leak through the silk touch branch
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].item).toBe("minecraft:diamond_ore");
    expect(r.items[0].expected).toBeCloseTo(1, 12);
  });

  it("1.16.5 NBT-era predicates produce the same fortune 3 distribution", () => {
    const r = calculate({
      version: "1.16.5",
      table: "blocks/diamond_ore",
      tool: "pickaxe",
      fortune: 3,
    });
    const d = distMap(r, "minecraft:diamond");
    expect(d.get(1)).toBeCloseTo(0.4, 12);
    expect(d.get(4)).toBeCloseTo(0.2, 12);
    expect(r.items[0].expected).toBeCloseTo(2.2, 12);
  });
});

describe("gravel table_bonus (1.21.11)", () => {
  // chances array in the JSON: [0.1, 0.14285715, 0.25, 1.0], indexed by fortune.
  const cases: Array<[number, number]> = [
    [0, 0.1],
    [1, 0.14285715],
    [2, 0.25],
    [3, 1.0],
  ];
  for (const [fortune, flintChance] of cases) {
    it(`fortune ${fortune} gives flint with p=${flintChance}`, () => {
      const r = calculate({ version: "1.21.11", table: "blocks/gravel", tool: "pickaxe", fortune });
      const flint = r.items.find((i) => i.item === "minecraft:flint");
      expect(flint?.chance ?? 0).toBeCloseTo(flintChance, 6);
      const gravel = r.items.find((i) => i.item === "minecraft:gravel");
      expect(gravel?.chance ?? 0).toBeCloseTo(1 - flintChance, 6);
    });
  }

  it("silk touch always drops the gravel block", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/gravel",
      tool: "pickaxe",
      silkTouch: true,
    });
    expect(r.items.map((i) => i.item)).toEqual(["minecraft:gravel"]);
    expect(r.items[0].chance).toBeCloseTo(1, 12);
  });
});

describe("wheat (1.21.11)", () => {
  const P = 0.5714286;

  it("mature wheat drops 1 wheat plus 1 + Binomial(3, 0.5714286) seeds", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/wheat",
      tool: "none",
      cropMature: true,
    });
    const wheat = distMap(r, "minecraft:wheat");
    expect(wheat.get(1)).toBeCloseTo(1, 12);
    const seeds = distMap(r, "minecraft:wheat_seeds");
    // Pool 1 alternatives fall through to seeds only when NOT mature, so the
    // mature seed count is 1 (base) + binomial bonus from pool 2.
    expect(seeds.get(1)).toBeCloseTo(Math.pow(1 - P, 3), 6);
    expect(seeds.get(2)).toBeCloseTo(3 * P * Math.pow(1 - P, 2), 6);
    expect(seeds.get(3)).toBeCloseTo(3 * P * P * (1 - P), 6);
    expect(seeds.get(4)).toBeCloseTo(P * P * P, 6);
    const evSeeds = r.items.find((i) => i.item === "minecraft:wheat_seeds")!.expected;
    expect(evSeeds).toBeCloseTo(1 + 3 * P, 6);
  });

  it("immature wheat drops exactly one seed and no wheat", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/wheat",
      tool: "none",
      cropMature: false,
    });
    expect(r.items.map((i) => i.item)).toEqual(["minecraft:wheat_seeds"]);
    expect(new Map(r.items[0].dist).get(1)).toBeCloseTo(1, 12);
  });

  it("fortune 3 seeds use binomial n = 3 + 3 = 6 rounds", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/wheat",
      tool: "pickaxe",
      fortune: 3,
      cropMature: true,
    });
    const seeds = distMap(r, "minecraft:wheat_seeds");
    expect(seeds.get(1)).toBeCloseTo(Math.pow(1 - P, 6), 6);
    expect(seeds.get(7)).toBeCloseTo(Math.pow(P, 6), 6);
    const evSeeds = r.items.find((i) => i.item === "minecraft:wheat_seeds")!.expected;
    expect(evSeeds).toBeCloseTo(1 + 6 * P, 6);
  });
});

describe("amethyst cluster tag predicate (1.21.11)", () => {
  it("a pickaxe (cluster_max_harvestables tag) drops 4 shards", () => {
    const r = calculate({ version: "1.21.11", table: "blocks/amethyst_cluster", tool: "pickaxe" });
    expect(new Map(r.items[0].dist).get(4)).toBeCloseTo(1, 12);
  });
  it("a non-pickaxe tool drops 2 shards", () => {
    const r = calculate({ version: "1.21.11", table: "blocks/amethyst_cluster", tool: "shovel" });
    expect(new Map(r.items[0].dist).get(2)).toBeCloseTo(1, 12);
  });
});

describe("mob kills", () => {
  it("zombie rotten flesh is uniform 0..2, EV 1.0 (no looting)", () => {
    const r = calculate({
      version: "1.21.11",
      table: "entities/zombie",
      tool: "none",
      killedByPlayer: false,
    });
    const flesh = distMap(r, "minecraft:rotten_flesh");
    expect(flesh.get(0)).toBeCloseTo(1 / 3, 12);
    expect(flesh.get(1)).toBeCloseTo(1 / 3, 12);
    expect(flesh.get(2)).toBeCloseTo(1 / 3, 12);
  });

  it("looting adds round(level * U(0,1)): EV += level/2, and rare drops scale", () => {
    // enchanted_count_increase with uniform 0..1 float: for level 3 the added
    // count is 0..3 with P(0)=P(3)=1/6 and P(1)=P(2)=1/3.
    const r = calculate({
      version: "1.21.11",
      table: "entities/zombie",
      tool: "none",
      killedByPlayer: true,
      looting: 3,
    });
    const flesh = r.items.find((i) => i.item === "minecraft:rotten_flesh")!;
    expect(flesh.expected).toBeCloseTo(1 + 1.5, 9);
    // Rare pool: killed_by_player AND random_chance_with_enchanted_bonus
    // (base 0.035, +0.01 per level above first -> 0.055 at looting 3),
    // then a 3-way equal-weight pick.
    const iron = r.items.find((i) => i.item === "minecraft:iron_ingot")!;
    expect(iron.chance).toBeCloseTo(0.055 / 3, 9);
  });

  it("the zombie rare pool needs killed_by_player (0.025 unenchanted)", () => {
    const withPlayer = calculate({
      version: "1.21.11",
      table: "entities/zombie",
      tool: "none",
      killedByPlayer: true,
    });
    const iron = withPlayer.items.find((i) => i.item === "minecraft:iron_ingot")!;
    expect(iron.chance).toBeCloseTo(0.025 / 3, 9);
    const without = calculate({
      version: "1.21.11",
      table: "entities/zombie",
      tool: "none",
      killedByPlayer: false,
    });
    expect(without.items.find((i) => i.item === "minecraft:iron_ingot")).toBeUndefined();
  });

  it("1.16.5 random_chance_with_looting: zombie iron ingot at looting 3", () => {
    // 1.16.5 shape: chance 0.025 + looting_multiplier 0.01 per level -> 0.055.
    const r = calculate({
      version: "1.16.5",
      table: "entities/zombie",
      tool: "none",
      killedByPlayer: true,
      looting: 3,
    });
    const iron = r.items.find((i) => i.item === "minecraft:iron_ingot")!;
    expect(iron.chance).toBeCloseTo(0.055 / 3, 9);
  });

  it("1.16.5 looting_enchant on skeleton arrows: EV 1 + level/2", () => {
    const r = calculate({
      version: "1.16.5",
      table: "entities/skeleton",
      tool: "none",
      killedByPlayer: false,
      looting: 2,
    });
    const arrows = r.items.find((i) => i.item === "minecraft:arrow")!;
    expect(arrows.expected).toBeCloseTo(1 + 1, 9);
    // level 2: added count P(0)=1/4, P(1)=1/2, P(2)=1/4 convolved with U{0..2}.
    const d = distMap(r, "minecraft:arrow");
    expect(d.get(4)).toBeCloseTo((1 / 3) * (1 / 4), 9);
  });

  it("sheep tables inline the referenced entities/sheep mutton table (1.16.5)", () => {
    // In 1.16.5 the colored sheep tables hold the wool pool plus a
    // loot_table reference to entities/sheep for the mutton; newer versions
    // split wool and mutton into separately invoked tables instead.
    const r = calculate({
      version: "1.16.5",
      table: "entities/sheep_black",
      tool: "none",
      killedByPlayer: false,
    });
    const wool = r.items.find((i) => i.item === "minecraft:black_wool");
    expect(wool?.chance).toBeCloseTo(1, 12);
    const mutton = r.items.find((i) => i.item === "minecraft:mutton");
    expect(mutton).toBeDefined();
    expect(mutton!.min).toBeGreaterThanOrEqual(1);
  });
});

describe("fishing (1.21.11)", () => {
  it("open water, no luck: saddle chance is 5% treasure branch over 6 equal entries", () => {
    const r = calculate({ version: "1.21.11", table: "gameplay/fishing", luckOfTheSea: 0 });
    const saddle = r.items.find((i) => i.item === "minecraft:saddle")!;
    expect(saddle.chance).toBeCloseTo(0.05 / 6, 9);
  });

  it("luck of the sea 3 shifts weights by quality: treasure 11/97", () => {
    // weights: junk 10 + (-2 * 3) = 4, treasure 5 + (2 * 3) = 11, fish 85 + (-1 * 3) = 82.
    const r = calculate({ version: "1.21.11", table: "gameplay/fishing", luckOfTheSea: 3 });
    const saddle = r.items.find((i) => i.item === "minecraft:saddle")!;
    expect(saddle.chance).toBeCloseTo(11 / 97 / 6, 9);
  });

  it("closed water removes the treasure branch entirely", () => {
    const r = calculate({
      version: "1.21.11",
      table: "gameplay/fishing",
      luckOfTheSea: 0,
      openWater: false,
    });
    expect(r.items.find((i) => i.item === "minecraft:saddle")).toBeUndefined();
    const cod = r.items.find((i) => i.item === "minecraft:cod")!;
    // fish branch 85/95, cod weight 60/100 within the fish table.
    expect(cod.chance).toBeCloseTo((85 / 95) * 0.6, 9);
  });
});

describe("glowstone limit_count (1.16.5)", () => {
  it("fortune 3 dust is uniform 2..4 plus uniform 0..3, clamped to 1..4", () => {
    const r = calculate({
      version: "1.16.5",
      table: "blocks/glowstone",
      tool: "pickaxe",
      fortune: 3,
    });
    const d = distMap(r, "minecraft:glowstone_dust");
    // base U{2..4} + bonus U{0..3}: sums 2..7 then clamped at 4:
    // P(2) = 1/12, P(3) = 2/12, P(4) = 9/12.
    expect(d.get(2)).toBeCloseTo(1 / 12, 9);
    expect(d.get(3)).toBeCloseTo(2 / 12, 9);
    expect(d.get(4)).toBeCloseTo(9 / 12, 9);
    expect(d.get(5) ?? 0).toBe(0);
  });
});

describe("outcome distribution", () => {
  it("matches the harness signature format", () => {
    expect(outcomeKey({ "minecraft:wheat": 1, "minecraft:wheat_seeds": 3 })).toBe(
      "minecraft:wheat:1,minecraft:wheat_seeds:3",
    );
    expect(outcomeKey({})).toBe("nothing");
  });

  it("diamond ore fortune 3 outcomes sum to 1 and match the marginal", () => {
    const r = calculate({
      version: "1.21.11",
      table: "blocks/diamond_ore",
      tool: "pickaxe",
      fortune: 3,
    });
    expect(r.outcomes).not.toBeNull();
    const total = r.outcomes!.reduce((s, o) => s + o.p, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(r.outcomes!.find((o) => o.key === "minecraft:diamond:1")?.p).toBeCloseTo(0.4, 12);
  });

  it("wide chest tables degrade joint outcomes to null but keep marginals", () => {
    const r = calculate({ version: "1.21.11", table: "chests/simple_dungeon", tool: "none" });
    expect(r.outcomes).toBeNull();
    expect(r.items.length).toBeGreaterThan(5);
    for (const item of r.items) {
      expect(item.expected).toBeGreaterThan(0);
    }
  });
});

describe("errors", () => {
  it("rejects an unknown version", () => {
    expect(() => calculate({ version: "1.99", table: "blocks/diamond_ore" })).toThrowError(
      ToolError,
    );
    try {
      calculate({ version: "1.99", table: "blocks/diamond_ore" });
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-version");
      expect((e as ToolError).fix).toContain("1.21.11");
    }
  });

  it("rejects an unknown table with a fix", () => {
    try {
      calculate({ version: "1.21.11", table: "blocks/unobtanium_ore" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-table");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });

  it("rejects a table the selected version does not have, naming versions that do", () => {
    try {
      calculate({ version: "1.16.5", table: "blocks/cherry_leaves" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("table-not-in-version");
      expect((e as ToolError).fix).toContain("1.21");
    }
  });

  it("rejects out-of-range enchantment levels", () => {
    for (const bad of [{ fortune: 7 }, { fortune: -1 }, { fortune: 1.5 }, { looting: 9 }]) {
      expect(() =>
        calculate({ version: "1.21.11", table: "blocks/diamond_ore", tool: "pickaxe", ...bad }),
      ).toThrowError(ToolError);
    }
  });

  it("rejects an unknown tool", () => {
    try {
      calculate({ version: "1.21.11", table: "blocks/diamond_ore", tool: "chainsaw" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-tool");
    }
  });
});

describe("registry and run()", () => {
  it("ships all six versions and a populated registry", () => {
    expect(LOOT_VERSIONS).toEqual(["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"]);
    expect(LOOT_TABLES.length).toBeGreaterThan(100);
    const diamond = LOOT_TABLES.find((t) => t.id === "blocks/diamond_ore")!;
    expect(diamond.name).toBe("Diamond Ore");
    expect(diamond.cat).toBe("Blocks");
    expect(diamond.versions).toContain("1.16.5");
  });

  it("run() renders labeled rows for the generic shell", () => {
    const out = run("", { version: "1.21.11", table: "blocks/diamond_ore", fortune: 3 });
    expect(out["Diamond"]).toContain("100%");
    expect(out["Diamond"]).toContain("avg 2.2");
  });

  it("run() reports empty results honestly", () => {
    // Snow requires a shovel; mining with a pickaxe drops nothing.
    const out = run("", { version: "1.21.11", table: "blocks/snow", tool: "pickaxe" });
    expect(out["Result"]).toContain("Nothing");
  });
});
