import { describe, expect, it } from "vitest";
import {
  checkPortalLink,
  chebyshevDistance,
  distanceSaved,
  NETHER_SEARCH_RADIUS,
  netherToOverworldRange,
  OVERWORLD_SEARCH_RADIUS,
  overworldToNether,
  run,
  SAFE_SEPARATION,
} from "./index";
import { ToolError } from "../types";

describe("overworldToNether / netherToOverworldRange", () => {
  it("scales down by 8 and floors toward negative infinity", () => {
    expect(overworldToNether(100, 100)).toEqual({ x: 12, z: 12 });
    expect(overworldToNether(-1, -1)).toEqual({ x: -1, z: -1 });
    expect(overworldToNether(-8, -8)).toEqual({ x: -1, z: -1 });
    expect(overworldToNether(-9, 0)).toEqual({ x: -2, z: 0 });
  });

  it("round trips: every overworld point in the range maps back to the same nether coordinate", () => {
    const r = netherToOverworldRange(12, -3);
    expect(r).toEqual({ xMin: 96, xMax: 103, zMin: -24, zMax: -17 });
    for (let x = r.xMin; x <= r.xMax; x++) {
      expect(overworldToNether(x, r.zMin).x).toBe(12);
    }
  });

  it("handles the origin", () => {
    expect(overworldToNether(0, 0)).toEqual({ x: 0, z: 0 });
    expect(netherToOverworldRange(0, 0)).toEqual({ xMin: 0, xMax: 7, zMin: 0, zMax: 7 });
  });
});

describe("checkPortalLink", () => {
  it("flags portals with the same scaled target as linked", () => {
    const result = checkPortalLink({ x: 0, z: 0 }, { x: 5, z: 5 });
    expect(result.scaledDistance).toBe(0);
    expect(result.outcome).toBe("same");
    expect(result.suggestion).toBeDefined();
  });

  it("flags portals right at the search radius boundary as linked", () => {
    // 16 nether blocks apart = 128 overworld blocks, exactly at the boundary.
    const result = checkPortalLink({ x: 0, z: 0 }, { x: 128, z: 0 });
    expect(result.scaledDistance).toBe(NETHER_SEARCH_RADIUS);
    expect(result.outcome).toBe("same");
  });

  it("flags the 16 to 32 range as a risk zone", () => {
    const result = checkPortalLink({ x: 0, z: 0 }, { x: 136, z: 0 });
    expect(result.scaledDistance).toBe(17);
    expect(result.outcome).toBe("risk");
  });

  it("declares portals safely separate past double the search radius", () => {
    const result = checkPortalLink({ x: 0, z: 0 }, { x: 400, z: 0 });
    expect(result.scaledDistance).toBeGreaterThan(NETHER_SEARCH_RADIUS * 2);
    expect(result.outcome).toBe("separate");
    expect(result.suggestion).toBeUndefined();
  });

  it("suggests a placement whose distance from A clears SAFE_SEPARATION", () => {
    const result = checkPortalLink({ x: 0, z: 0 }, { x: 20, z: 0 });
    expect(result.suggestion).toBeDefined();
    const distance = chebyshevDistance(result.scaledA, result.suggestion!);
    expect(distance).toBeGreaterThanOrEqual(SAFE_SEPARATION);
  });
});

describe("distanceSaved", () => {
  it("computes the nether shortcut as 1/8 the overworld distance", () => {
    const d = distanceSaved(0, 0, 800, 0);
    expect(d.overworldDistance).toBe(800);
    expect(d.netherWalkDistance).toBe(100);
    expect(d.blocksSaved).toBe(700);
    expect(d.percentSaved).toBeCloseTo(87.5, 5);
  });

  it("returns zero for identical points", () => {
    const d = distanceSaved(5, 5, 5, 5);
    expect(d.overworldDistance).toBe(0);
    expect(d.blocksSaved).toBe(0);
    expect(d.percentSaved).toBe(0);
  });
});

describe("run", () => {
  it("converts overworld to nether coordinates", () => {
    const out = run(undefined, { mode: "to-nether", x: 100, y: 64, z: -200, x2: 0, z2: 0 });
    expect(out["Nether coordinate"]).toBe("12, 64, -25");
  });

  it("converts nether to an overworld range", () => {
    const out = run(undefined, { mode: "to-overworld", x: 12, y: 64, z: -25, x2: 0, z2: 0 });
    expect(out["Overworld X range"]).toBe("96 to 103");
    expect(out["Overworld Z range"]).toBe("-200 to -193");
  });

  it("reports a link check with a suggestion", () => {
    const out = run(undefined, { mode: "link-check", x: 0, y: 64, z: 0, x2: 5, z2: 5 });
    expect(out.Outcome).toMatch(/same nether portal/i);
    expect(out["Suggested Nether placement for B"]).toBeDefined();
  });

  it("reports distance saved", () => {
    const out = run(undefined, { mode: "distance-saved", x: 0, y: 64, z: 0, x2: 800, z2: 0 });
    expect(out["Blocks saved"]).toBe("700 blocks");
  });

  it("throws for a non-finite coordinate", () => {
    expect(() => run(undefined, { mode: "to-nether", x: NaN, y: 64, z: 0, x2: 0, z2: 0 })).toThrow(
      ToolError,
    );
  });

  it("throws for a coordinate outside the world border", () => {
    expect(() =>
      run(undefined, { mode: "to-nether", x: 40_000_000, y: 64, z: 0, x2: 0, z2: 0 }),
    ).toThrow(ToolError);
  });

  it("throws for an unknown mode", () => {
    expect(() => run(undefined, { mode: "nope", x: 0, y: 0, z: 0, x2: 0, z2: 0 })).toThrow(
      ToolError,
    );
  });

  it("exposes the documented search radius constants", () => {
    expect(OVERWORLD_SEARCH_RADIUS).toBe(128);
    expect(NETHER_SEARCH_RADIUS).toBe(16);
  });
});
