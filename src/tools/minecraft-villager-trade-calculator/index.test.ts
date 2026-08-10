import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { VILLAGER_DATA, VILLAGER_VERSIONS } from "./data";
import {
  GOSSIP_PER_CURE_MAJOR,
  GOSSIP_PER_CURE_MINOR,
  calculate,
  computeGossip,
  curesForOneEmerald,
  itemName,
  poolFor,
  priceFor,
  professionsFor,
  run,
  stackSizeFor,
} from "./index";

const PRE_NERF = ["1.16.5", "1.18.2"];
const POST_NERF = ["1.20.6", "1.21.1", "1.21.11", "26.2"];

describe("price formula (MerchantOffer.getModifiedCostCount)", () => {
  it("leaves the base price alone with no reputation, hero effect or demand", () => {
    expect(
      priceFor({ base: 20, priceMultiplier: 0.05, reputation: 0, heroLevel: 0, demand: 0 }),
    ).toBe(20);
  });

  it("applies Hero of the Village as a share of the base cost, never less than one", () => {
    // 0.3 + 0.0625 * amplifier, floored, minimum 1.
    expect(
      priceFor({ base: 20, priceMultiplier: 0.05, reputation: 0, heroLevel: 1, demand: 0 }),
    ).toBe(14);
    expect(
      priceFor({ base: 20, priceMultiplier: 0.05, reputation: 0, heroLevel: 5, demand: 0 }),
    ).toBe(9);
    // A one item cost still loses one, which the clamp then puts back at 1.
    expect(
      priceFor({ base: 1, priceMultiplier: 0.05, reputation: 0, heroLevel: 1, demand: 0 }),
    ).toBe(1);
  });

  it("scales the reputation discount by the trade's price multiplier", () => {
    // floor(125 * 0.2) = 25 off a high tier trade, floor(125 * 0.05) = 6 off a low tier one.
    expect(
      priceFor({ base: 40, priceMultiplier: 0.2, reputation: 125, heroLevel: 0, demand: 0 }),
    ).toBe(15);
    expect(
      priceFor({ base: 40, priceMultiplier: 0.05, reputation: 125, heroLevel: 0, demand: 0 }),
    ).toBe(34);
  });

  it("ignores reputation entirely when the price multiplier is zero", () => {
    expect(
      priceFor({ base: 12, priceMultiplier: 0, reputation: 700, heroLevel: 0, demand: 0 }),
    ).toBe(12);
  });

  it("raises the price with demand and never lets it drop below one or above a stack", () => {
    expect(
      priceFor({ base: 20, priceMultiplier: 0.05, reputation: 0, heroLevel: 0, demand: 8 }),
    ).toBe(28);
    // Negative demand is buffered, not a discount.
    expect(
      priceFor({ base: 20, priceMultiplier: 0.05, reputation: 0, heroLevel: 0, demand: -8 }),
    ).toBe(20);
    expect(
      priceFor({ base: 64, priceMultiplier: 0.2, reputation: 0, heroLevel: 0, demand: 40 }),
    ).toBe(64);
    expect(
      priceFor({ base: 5, priceMultiplier: 0.2, reputation: 700, heroLevel: 0, demand: 0 }),
    ).toBe(1);
  });
});

describe("gossip (GossipType caps and decay)", () => {
  it("caps a single cure at the version's major and minor positive limits", () => {
    for (const version of PRE_NERF) {
      const { reputation } = computeGossip(version, { cures: 1 });
      expect(reputation).toBe(5 * GOSSIP_PER_CURE_MAJOR + GOSSIP_PER_CURE_MINOR);
    }
    for (const version of POST_NERF) {
      const { reputation } = computeGossip(version, { cures: 1 });
      expect(reputation).toBe(125);
    }
  });

  it("keeps stacking cures before 1.20.2 and stops dead after it", () => {
    for (const version of PRE_NERF) {
      expect(computeGossip(version, { cures: 2 }).reputation).toBe(250);
      expect(computeGossip(version, { cures: 5 }).reputation).toBe(625);
      // Major positive caps at 100 and minor positive at 200, so 700 is the ceiling.
      expect(computeGossip(version, { cures: 8 }).reputation).toBe(700);
      expect(computeGossip(version, { cures: 50 }).reputation).toBe(700);
    }
    for (const version of POST_NERF) {
      expect(computeGossip(version, { cures: 2 }).reputation).toBe(125);
      expect(computeGossip(version, { cures: 50 }).reputation).toBe(125);
    }
  });

  it("never decays the major positive cure gossip, and decays the rest on schedule", () => {
    const lines = computeGossip("1.21.11", { cures: 1, tradesMade: 20, daysElapsed: 0 }).lines;
    const major = lines.find((l) => l.type === "major_positive")!;
    const minor = lines.find((l) => l.type === "minor_positive")!;
    const trading = lines.find((l) => l.type === "trading")!;
    expect(major.daysRemaining).toBeNull();
    expect(minor.daysRemaining).toBe(24);
    expect(trading.daysRemaining).toBe(12);

    // After enough days only the permanent major positive value survives.
    const later = computeGossip("1.21.11", { cures: 1, tradesMade: 20, daysElapsed: 30 });
    expect(later.reputation).toBe(100);
  });

  it("subtracts weighted negative gossip from reputation", () => {
    expect(computeGossip("1.21.11", { hurts: 1 }).reputation).toBe(-25);
    expect(computeGossip("1.21.11", { kills: 1 }).reputation).toBe(-125);
    expect(computeGossip("1.21.11", { cures: 1, kills: 1 }).reputation).toBe(0);
  });
});

describe("the 1.20.2 cure nerf, priced end to end", () => {
  it("floors any book to one emerald in three cures before 1.20.2", () => {
    for (const version of PRE_NERF) {
      for (const rolled of [5, 19, 38, 64]) {
        const answer = curesForOneEmerald(version, rolled, 0);
        expect(answer.curesNeeded).not.toBeNull();
        expect(answer.curesNeeded!).toBeLessThanOrEqual(3);
      }
      expect(curesForOneEmerald(version, 64, 0).bestCureOnlyPrice).toBe(1);
    }
  });

  it("cannot take a 38 emerald book below 13 by curing alone after 1.20.2", () => {
    for (const version of POST_NERF) {
      const answer = curesForOneEmerald(version, 38, 0);
      expect(answer.curesNeeded).toBeNull();
      expect(answer.bestCureOnlyPrice).toBe(13);
      expect(answer.curesUntilCapped).toBe(1);
      // Hero of the Village V adds floor(0.55 * 38) = 20 more off, which is enough.
      expect(answer.bestPriceWithHero).toBe(1);
      expect(curesForOneEmerald(version, 38, 5).curesNeeded).toBe(1);
    }
  });

  it("still reaches one emerald from a cheap roll with a single cure after 1.20.2", () => {
    for (const version of POST_NERF) {
      expect(curesForOneEmerald(version, 26, 0).curesNeeded).toBe(1);
      expect(curesForOneEmerald(version, 27, 0).curesNeeded).toBeNull();
    }
  });

  it("reports the nerf on the result and flips the note at the boundary", () => {
    expect(
      calculate({ version: "1.18.2", profession: "librarian", level: 1 }).cureNerfApplies,
    ).toBe(false);
    expect(
      calculate({ version: "1.20.6", profession: "librarian", level: 1 }).cureNerfApplies,
    ).toBe(true);
  });
});

describe("trade pools", () => {
  it("prices a real level 1 farmer trade", () => {
    const result = calculate({
      version: "1.21.11",
      profession: "farmer",
      level: 1,
      tradeIndex: 0,
      heroLevel: 1,
    });
    const wheat = result.trades[0];
    expect(wheat.wants).toBe("wheat");
    expect(wheat.baseMin).toBe(20);
    expect(wheat.maxUses).toBe(16);
    expect(wheat.xp).toBe(2);
    expect(wheat.priceMultiplier).toBeCloseTo(0.05, 6);
    expect(wheat.priceMin).toBe(14);
    expect(result.offered).toBe(2);
    expect(result.levelName).toBe("Novice");
  });

  it("keeps randomised trades as a real range", () => {
    const book = calculate({ version: "1.21.11", profession: "librarian", level: 1 }).trades.find(
      (t) => t.variable === "book",
    )!;
    expect(book.baseMin).toBe(5);
    expect(book.baseMax).toBe(64);
    expect(book.secondary?.item).toBe("book");
    expect(book.priceMultiplier).toBeCloseTo(0.2, 6);

    const pickaxe = calculate({
      version: "1.21.11",
      profession: "toolsmith",
      level: 5,
    }).trades.find((t) => t.variable === "enchanted")!;
    // Base 13 emeralds plus the 5 to 19 enchanting levels rolled onto it.
    expect(pickaxe.baseMin).toBe(18);
    expect(pickaxe.baseMax).toBe(32);
  });

  it("clamps a cost to the cost item's stack size, not to 64", () => {
    // The librarian's Expert listing asks for 2 book and quill, an item that
    // stacks to 1. MerchantOffer.getModifiedCostCount clamps the shown cost to
    // the cost item's max stack size, so a player pays one in every version.
    for (const version of VILLAGER_VERSIONS) {
      expect(stackSizeFor(version, "writable_book")).toBe(1);
      const trade = calculate({ version, profession: "librarian", level: 4 }).trades.find(
        (t) => t.wants === "writable_book",
      );
      expect(trade, `${version} librarian 4 has no writable book trade`).toBeDefined();
      expect(trade!.priceMin, `${version} charges the wrong number of books`).toBe(1);
      expect(trade!.priceMax).toBe(1);
    }
    expect(stackSizeFor("1.21.11", "emerald")).toBe(64);
    expect(
      priceFor({ base: 2, priceMultiplier: 0.05, reputation: 0, heroLevel: 0, demand: 0 }),
    ).toBe(2);
    expect(
      priceFor({
        base: 2,
        priceMultiplier: 0.05,
        reputation: 0,
        heroLevel: 0,
        demand: 0,
        maxStack: 1,
      }),
    ).toBe(1);
  });

  it("keeps the stored base cost each version really ships for that trade", () => {
    // 26.x clamps at offer construction in TradeCost.toItemCost, so its data
    // stores 1. Earlier versions store the unclamped 2 and clamp on display.
    for (const version of ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11"]) {
      const trade = calculate({ version, profession: "librarian", level: 4 }).trades.find(
        (t) => t.wants === "writable_book",
      )!;
      expect(trade.baseMin, version).toBe(2);
    }
    const modern = calculate({ version: "26.2", profession: "librarian", level: 4 }).trades.find(
      (t) => t.wants === "writable_book",
    )!;
    expect(modern.baseMin).toBe(1);
  });

  it("explains the stack size clamp in the notes when it bites", () => {
    const result = calculate({ version: "1.21.11", profession: "librarian", level: 4 });
    const index = result.trades.findIndex((t) => t.wants === "writable_book");
    const selected = calculate({
      version: "1.21.11",
      profession: "librarian",
      level: 4,
      tradeIndex: index,
    });
    expect(selected.notes.join(" ")).toContain("stacks to 1");
    // 26.2 already stores the clamped base, so there is nothing to explain.
    const modernIndex = calculate({
      version: "26.2",
      profession: "librarian",
      level: 4,
    }).trades.findIndex((t) => t.wants === "writable_book");
    const modern = calculate({
      version: "26.2",
      profession: "librarian",
      level: 4,
      tradeIndex: modernIndex,
    });
    expect(modern.notes.join(" ")).not.toContain("stacks to 1");
  });

  it("tags trades that only exist on some villager types", () => {
    const boats = calculate({
      version: "1.21.11",
      profession: "fisherman",
      level: 5,
    }).trades.filter((t) => t.biomes.length);
    expect(boats.length).toBeGreaterThan(0);
    expect(boats.every((t) => t.gives === "emerald")).toBe(true);
  });

  it("covers every shipped version with the same thirteen professions and five levels", () => {
    expect(VILLAGER_VERSIONS).toHaveLength(6);
    for (const version of VILLAGER_VERSIONS) {
      const professions = professionsFor(version);
      expect(professions).toHaveLength(13);
      for (const profession of professions) {
        for (let level = 1; level <= 5; level++) {
          const pool = poolFor(version, profession, level);
          expect(pool.length, `${version}/${profession}/${level}`).toBeGreaterThan(0);
          for (const row of pool) {
            expect(row[1], `${version}/${profession}/${level} min cost`).toBeGreaterThan(0);
            expect(row[2]).toBeGreaterThanOrEqual(row[1]);
            expect(row[5], `${version}/${profession}/${level} max uses`).toBeGreaterThan(0);
            expect(row[6]).toBeGreaterThan(0);
            expect(row[7]).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("never emits the wandering trader or the trade rebalance pools", () => {
    for (const version of VILLAGER_VERSIONS) {
      expect(Object.keys(VILLAGER_DATA[version].professions)).not.toContain("wandering_trader");
    }
  });
});

describe("restocking and demand", () => {
  it("derives the demand swing from uses against max uses", () => {
    const result = calculate({
      version: "1.21.11",
      profession: "farmer",
      level: 1,
      tradeIndex: 0,
      usesPerRestock: 16,
      restocks: 3,
    });
    // 16 of 16 uses: demand climbs by maxUses each restock.
    expect(result.restock.demandPerRestock).toBe(16);
    expect(result.demand).toBe(48);
    expect(result.restock.usesPerDay).toBe(48);
    expect(result.restock.breakEvenUses).toBe(8);
    // 20 wheat at 0.05 needs demand 1, so 9 of the 16 uses is enough to move it.
    expect(result.restock.usesBeforePriceRises).toBe(9);
    expect(result.selected!.priceMin).toBeGreaterThan(20);
  });

  it("buffers unused stock as negative demand without ever discounting", () => {
    const result = calculate({
      version: "1.21.11",
      profession: "farmer",
      level: 1,
      tradeIndex: 0,
      usesPerRestock: 0,
      restocks: 4,
    });
    expect(result.demand).toBe(-64);
    expect(result.selected!.priceMin).toBe(20);
  });
});

describe("errors and edges", () => {
  it("rejects an unknown version with a fix hint", () => {
    expect(() => calculate({ version: "1.7.10", profession: "farmer", level: 1 })).toThrow(
      ToolError,
    );
    try {
      calculate({ version: "1.7.10", profession: "farmer", level: 1 });
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-version");
      expect((e as ToolError).fix).toContain("1.21.11");
    }
  });

  it("rejects an unknown profession", () => {
    try {
      calculate({ version: "1.21.11", profession: "nitwit", level: 1 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-profession");
    }
  });

  it("rejects a level outside 1 to 5", () => {
    for (const level of [0, 6, 1.5]) {
      try {
        calculate({ version: "1.21.11", profession: "farmer", level });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-level");
      }
    }
  });

  it("handles a trade index outside the pool by selecting nothing", () => {
    const result = calculate({
      version: "1.21.11",
      profession: "farmer",
      level: 1,
      tradeIndex: 99,
    });
    expect(result.selected).toBeNull();
    expect(result.mending).toBeNull();
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("titles item ids for display", () => {
    expect(itemName("golden_carrot")).toBe("Golden Carrot");
    expect(itemName("emerald")).toBe("Emerald");
  });
});

describe("run()", () => {
  it("falls back to a librarian and returns labelled rows", () => {
    const out = run("", {});
    expect(out["Villager"]).toContain("Librarian");
    expect(Object.keys(out).length).toBeGreaterThan(3);
    expect(out["Reputation"]).toBe("0");
  });

  it("takes the profession from the input and the rest from options", () => {
    const out = run("farmer", { version: "1.16.5", level: 5, cures: 3, heroLevel: 2 });
    expect(out["Villager"]).toContain("Farmer level 5 (Master)");
    expect(out["Reputation"]).toBe("375");
  });
});
