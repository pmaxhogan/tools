import { describe, expect, it } from "vitest";
import {
  BEACON_TIERS,
  effectDurationSeconds,
  materialCost,
  primaryPowersUpTo,
  run,
  sharedBaseBlocks,
  tierForLayers,
} from "./index";
import { ToolError } from "../types";

describe("BEACON_TIERS", () => {
  it("matches the known block counts per layer", () => {
    expect(BEACON_TIERS.map((t) => t.layerBlocks)).toEqual([9, 34, 83, 164]);
  });

  it("cumulative totals sum the layers so far", () => {
    expect(BEACON_TIERS.map((t) => t.cumulativeBlocks)).toEqual([9, 43, 126, 290]);
  });

  it("ranges grow by 10 blocks per layer", () => {
    expect(BEACON_TIERS.map((t) => t.range)).toEqual([20, 30, 40, 50]);
  });
});

describe("tierForLayers", () => {
  it("returns the matching tier", () => {
    expect(tierForLayers(1).cumulativeBlocks).toBe(9);
    expect(tierForLayers(4).cumulativeBlocks).toBe(290);
  });

  it("rejects layer counts outside 1 to 4", () => {
    expect(() => tierForLayers(0)).toThrow(ToolError);
    expect(() => tierForLayers(5)).toThrow(ToolError);
    expect(() => tierForLayers(2.5)).toThrow(ToolError);
  });
});

describe("primaryPowersUpTo", () => {
  it("accumulates powers across layers in unlock order", () => {
    expect(primaryPowersUpTo(1)).toEqual(["Speed", "Haste"]);
    expect(primaryPowersUpTo(3)).toEqual([
      "Speed",
      "Haste",
      "Resistance",
      "Jump Boost",
      "Strength",
    ]);
  });

  it("adds no new primary power at layer 4 (that layer unlocks the secondary instead)", () => {
    expect(primaryPowersUpTo(4)).toEqual(primaryPowersUpTo(3));
  });
});

describe("materialCost", () => {
  it("scales blocks by 9 ingots each", () => {
    const cost = materialCost(1, "iron");
    expect(cost.blocks).toBe(9);
    expect(cost.ingots).toBe(81);
  });

  it("computes the full pyramid cost", () => {
    const cost = materialCost(4, "diamond");
    expect(cost.blocks).toBe(290);
    expect(cost.ingots).toBe(2610);
  });
});

describe("effectDurationSeconds", () => {
  it("grows by 2 seconds per layer from a 9 second base", () => {
    expect(effectDurationSeconds(1)).toBe(11);
    expect(effectDurationSeconds(4)).toBe(17);
  });
});

describe("sharedBaseBlocks", () => {
  it("a single beacon costs exactly its solo total", () => {
    const result = sharedBaseBlocks(1, 1, 1);
    expect(result.totalBlocks).toBe(9);
    expect(result.soloBlocks).toBe(9);
    expect(result.blocksSaved).toBe(0);
  });

  it("two adjacent layer 1 beacons share exactly one column", () => {
    const result = sharedBaseBlocks(2, 1, 1);
    expect(result.beaconCount).toBe(2);
    expect(result.soloBlocks).toBe(18);
    expect(result.totalBlocks).toBe(15);
    expect(result.blocksSaved).toBe(3);
  });

  it("a 2x3 grid of 6 beacons saves blocks over building them solo", () => {
    const result = sharedBaseBlocks(2, 3, 4);
    expect(result.beaconCount).toBe(6);
    expect(result.soloBlocks).toBe(6 * 290);
    expect(result.totalBlocks).toBeLessThan(result.soloBlocks);
    expect(result.blocksSaved).toBeGreaterThan(0);
  });

  it("rejects non-integer or zero grid dimensions", () => {
    expect(() => sharedBaseBlocks(0, 1, 1)).toThrow(ToolError);
    expect(() => sharedBaseBlocks(1.5, 1, 1)).toThrow(ToolError);
  });
});

describe("run", () => {
  it("reports layer requirements", () => {
    const out = run(undefined, {
      mode: "layers",
      layers: 3,
      material: "iron",
      gridCols: 1,
      gridRows: 1,
    });
    expect(out["Total blocks (all layers)"]).toBe("126");
    expect(out["Effect range"]).toContain("40 blocks");
    expect(out["Primary powers unlocked"]).toContain("Strength");
    expect(out["Secondary power (full pyramid)"]).toBeUndefined();
  });

  it("reports the secondary power only at layer 4", () => {
    const out = run(undefined, {
      mode: "layers",
      layers: 4,
      material: "iron",
      gridCols: 1,
      gridRows: 1,
    });
    expect(out["Secondary power (full pyramid)"]).toBeDefined();
  });

  it("reports material cost", () => {
    const out = run(undefined, {
      mode: "material",
      layers: 1,
      material: "netherite",
      gridCols: 1,
      gridRows: 1,
    });
    expect(out["Blocks needed"]).toBe("9");
    expect(out["Ingots or gems needed"]).toBe("81");
  });

  it("reports a shared base", () => {
    const out = run(undefined, {
      mode: "shared",
      layers: 1,
      material: "iron",
      gridCols: 2,
      gridRows: 1,
    });
    expect(out["Shared base blocks"]).toBe("15");
    expect(out["Blocks saved by sharing"]).toBe("3");
  });

  it("throws for an unknown material", () => {
    expect(() =>
      run(undefined, { mode: "material", layers: 1, material: "wood", gridCols: 1, gridRows: 1 }),
    ).toThrow(ToolError);
  });

  it("throws for an unknown mode", () => {
    expect(() =>
      run(undefined, { mode: "nope", layers: 1, material: "iron", gridCols: 1, gridRows: 1 }),
    ).toThrow(ToolError);
  });
});
