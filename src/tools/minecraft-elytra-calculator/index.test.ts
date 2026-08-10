import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  applyRocketBoost,
  bestGlidePitch,
  cruisePlan,
  durabilityPlan,
  fireworkSelfDamage,
  lookVector,
  mthCos,
  mthSin,
  rocketLifetime,
  run,
  simulateFlight,
  stepGlide,
  steadyState,
  travelPlan,
  type McElytraOpts,
} from "./index";
import {
  DEFAULT_GRAVITY,
  ELYTRA_ENCHANTS,
  ELYTRA_VERSION_DATA,
  SLOW_FALLING_GRAVITY,
} from "./data";

const baseOpts: McElytraOpts = {
  mode: "glide",
  version: "1.21.11",
  pitch: 0,
  height: 100,
  flightDuration: 1,
  targetX: 10000,
  targetZ: 0,
  damage: 0,
  unbreaking: 0,
  stars: 0,
  slowFalling: false,
};

function opts(patch: Partial<McElytraOpts>): McElytraOpts {
  return { ...baseOpts, ...patch };
}

describe("the float sine table", () => {
  it("matches Math.sin closely enough to be the same function", () => {
    for (let deg = -90; deg <= 90; deg += 0.5) {
      const rad = Math.fround(deg * Math.fround(Math.PI / 180));
      expect(mthSin(rad)).toBeCloseTo(Math.sin(rad), 3);
      expect(mthCos(rad)).toBeCloseTo(Math.cos(rad), 3);
    }
  });

  it("quantizes: the table is not just Math.sin", () => {
    // 65536 entries over a full turn, so neighbouring fractional pitches can
    // land on the same entry. If this ever became exact, the reimplementation
    // would have silently stopped modelling Mth#sin.
    const sample = mthSin(0.1234567);
    expect(sample).not.toBe(Math.sin(0.1234567));
  });

  it("agrees with the pre 1.21.11 float index form at every pitch the tool exposes", () => {
    // 1.16.5 through 1.21.1 index with (int)(x * 10430.378F); 1.21.11 and
    // 26.2 use the double form. This proves they pick the same table entry
    // across the whole exposed pitch range, so shipping the modern form
    // covers all six versions.
    const scaleF = Math.fround(10430.378);
    for (let deg = -90; deg <= 90; deg += 0.5) {
      const rad = Math.fround(deg * Math.fround(Math.PI / 180));
      const oldIndex = Math.trunc(Math.fround(rad * scaleF)) & 65535;
      const newIndex = Math.trunc(rad * 10430.378350470453) & 65535;
      expect(oldIndex).toBe(newIndex);
    }
  });
});

describe("lookVector", () => {
  it("points level and forward at pitch 0", () => {
    const look = lookVector(0);
    expect(look.x).toBeCloseTo(0, 6);
    expect(look.y).toBeCloseTo(0, 6);
    expect(look.z).toBeCloseTo(1, 6);
  });

  it("points down at positive pitch, the game's convention", () => {
    expect(lookVector(45).y).toBeLessThan(0);
    expect(lookVector(-45).y).toBeGreaterThan(0);
  });

  it("stays a unit vector", () => {
    for (const pitch of [-90, -30, 0, 17.5, 90]) {
      const l = lookVector(pitch, 137);
      expect(Math.hypot(l.x, l.y, l.z)).toBeCloseTo(1, 3);
    }
  });
});

describe("stepGlide", () => {
  it("sinks from rest at level pitch", () => {
    const v = stepGlide({ x: 0, y: 0, z: 0 }, { pitchDeg: 0 });
    // gravity * (-1 + 0.75) = -0.02, then the dive conversion and the 0.98 drag.
    expect(v.y).toBeLessThan(0);
    expect(v.y).toBeGreaterThan(-0.02);
  });

  it("converts descent into forward speed", () => {
    const start = { x: 0, y: -0.5, z: 0.5 };
    const after = stepGlide(start, { pitchDeg: 0 });
    expect(after.z).toBeGreaterThan(start.z);
  });

  it("trades forward speed for height when pitched up", () => {
    const start = { x: 0, y: 0, z: 2 };
    const after = stepGlide(start, { pitchDeg: -20 });
    expect(after.z).toBeLessThan(start.z);
    expect(after.y).toBeGreaterThan(0);
  });

  it("honours Slow Falling gravity", () => {
    const normal = stepGlide({ x: 0, y: 0, z: 0 }, { pitchDeg: 0, gravity: DEFAULT_GRAVITY });
    const slow = stepGlide({ x: 0, y: 0, z: 0 }, { pitchDeg: 0, gravity: SLOW_FALLING_GRAVITY });
    expect(slow.y).toBeGreaterThan(normal.y);
  });
});

describe("applyRocketBoost", () => {
  it("converges on look times 1.7", () => {
    const look = lookVector(0);
    let v = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) v = applyRocketBoost(v, look);
    expect(v.z).toBeCloseTo(1.7, 9);
  });

  it("halves the gap toward the target every tick", () => {
    const look = { x: 0, y: 0, z: 1 };
    const first = applyRocketBoost({ x: 0, y: 0, z: 0 }, look);
    expect(first.z).toBeCloseTo(0.85, 12);
  });
});

describe("steadyState", () => {
  it("finds the terminal glide at level pitch", () => {
    const s = steadyState(0);
    expect(s.horizontalSpeed).toBeCloseTo(1.51017, 4);
    expect(s.verticalSpeed).toBeCloseTo(-0.14949, 4);
    expect(s.glideRatio).toBeCloseTo(10.102, 2);
  });

  it("cruises faster with rockets than without", () => {
    expect(steadyState(0, { boosting: true }).horizontalSpeed).toBeGreaterThan(
      steadyState(0).horizontalSpeed,
    );
  });

  it("keeps the glide ratio under Slow Falling even though speeds drop", () => {
    const normal = steadyState(0);
    const slow = steadyState(0, { gravity: SLOW_FALLING_GRAVITY });
    expect(slow.horizontalSpeed).toBeLessThan(normal.horizontalSpeed);
    expect(slow.glideRatio).toBeCloseTo(normal.glideRatio, 5);
  });

  it("reports an infinite glide ratio when the flier is climbing", () => {
    expect(steadyState(-5, { boosting: true }).glideRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("bestGlidePitch", () => {
  it("lands on level flight", () => {
    const best = bestGlidePitch(0.5);
    expect(best.pitchDeg).toBeCloseTo(0, 6);
    expect(best.state.glideRatio).toBeGreaterThan(10);
  });
});

describe("simulateFlight", () => {
  it("stops on the requested drop and records a full trace", () => {
    const sim = simulateFlight({ pitchDeg: 0, stopAfterDrop: 100, maxTicks: 40000 });
    expect(sim.stoppedBy).toBe("drop");
    expect(sim.samples).toHaveLength(sim.ticks + 1);
    expect(sim.distance).toBeGreaterThan(800);
    expect(sim.altitudeChange).toBeLessThanOrEqual(-100);
  });

  it("stops on distance when asked", () => {
    const sim = simulateFlight({ pitchDeg: 0, stopAfterDistance: 50, maxTicks: 40000 });
    expect(sim.stoppedBy).toBe("distance");
    expect(sim.distance).toBeGreaterThanOrEqual(50);
  });

  it("falls back to the tick budget", () => {
    const sim = simulateFlight({ pitchDeg: 0, maxTicks: 25 });
    expect(sim.stoppedBy).toBe("ticks");
    expect(sim.ticks).toBe(25);
  });

  it("spikes above the level terminal speed after a dive", () => {
    const level = steadyState(0).horizontalSpeed;
    const sim = simulateFlight({
      pitchDeg: 0,
      pitchSegments: [{ throughTick: 100, pitchDeg: 45 }],
      maxTicks: 300,
    });
    expect(sim.peakHorizontalSpeed).toBeGreaterThan(level * 1.35);
    // and the spike arrives after the flier levels off, not during the dive
    const peak = sim.samples.reduce((a, b) => (b.horizontalSpeed > a.horizontalSpeed ? b : a));
    expect(peak.tick).toBeGreaterThan(100);
  });

  it("chains rockets back to back and covers more ground", () => {
    const plain = simulateFlight({ pitchDeg: 0, maxTicks: 400 });
    const boosted = simulateFlight({
      pitchDeg: 0,
      rocketMode: "chained",
      flightDuration: 1,
      maxTicks: 400,
    });
    expect(boosted.distance).toBeGreaterThan(plain.distance);
    expect(boosted.boostTicks).toBe(400);
    expect(boosted.rocketsUsed).toBeGreaterThan(10);
  });

  it("leaves gaps between rockets in interval mode", () => {
    const sim = simulateFlight({
      pitchDeg: 0,
      rocketMode: "interval",
      flightDuration: 1,
      rocketIntervalTicks: 100,
      maxTicks: 400,
    });
    expect(sim.rocketsUsed).toBe(4);
    expect(sim.boostTicks).toBeLessThan(400);
  });

  it("rejects an impossible pitch", () => {
    expect(() => simulateFlight({ pitchDeg: 120 })).toThrow(ToolError);
    expect(() =>
      simulateFlight({ pitchDeg: 0, pitchSegments: [{ throughTick: 5, pitchDeg: -400 }] }),
    ).toThrow(/between -90 and 90/);
  });

  it("rejects a nonsense tick budget", () => {
    expect(() => simulateFlight({ pitchDeg: 0, maxTicks: 0 })).toThrow(ToolError);
  });

  it("rejects a flight duration that cannot be crafted", () => {
    expect(() => simulateFlight({ pitchDeg: 0, rocketMode: "chained", flightDuration: 4 })).toThrow(
      /1, 2, or 3/,
    );
  });
});

describe("rocketLifetime", () => {
  it("adds ten ticks per gunpowder and one tick before the explosion", () => {
    expect(rocketLifetime(1).meanBoostTicks).toBe(26.5);
    expect(rocketLifetime(2).meanBoostTicks).toBe(36.5);
    expect(rocketLifetime(3).meanBoostTicks).toBe(46.5);
    expect(rocketLifetime(1).minBoostTicks).toBe(21);
    expect(rocketLifetime(1).maxBoostTicks).toBe(32);
  });
});

describe("cruisePlan", () => {
  it("prices a duration 1 rocket at about 44 blocks", () => {
    const plan = cruisePlan(0, 1);
    expect(plan.speedPerSecond).toBeCloseTo(33.45, 1);
    expect(plan.blocksPerRocket).toBeCloseTo(44.33, 1);
    expect(plan.rocketsPerThousandBlocks).toBeCloseTo(22.56, 1);
  });

  it("makes duration 3 cheaper per block in paper but not in gunpowder", () => {
    const one = cruisePlan(0, 1);
    const three = cruisePlan(0, 3);
    expect(three.paperPerThousandBlocks).toBeLessThan(one.paperPerThousandBlocks);
    expect(three.gunpowderPerThousandBlocks).toBeGreaterThan(one.gunpowderPerThousandBlocks);
  });

  it("rejects a flight duration outside 1 to 3", () => {
    expect(() => cruisePlan(0, 0)).toThrow(ToolError);
  });
});

describe("travelPlan", () => {
  it("costs an overworld trip and its Nether alternative", () => {
    const plan = travelPlan(10000, 0);
    expect(plan.overworld.distance).toBe(10000);
    expect(plan.nether.distance).toBe(1250);
    expect(plan.nether.rockets * 8).toBeLessThan(plan.overworld.rockets + 8);
    expect(plan.netherSavingFraction).toBeCloseTo(0.875, 6);
  });

  it("handles the degenerate zero distance trip", () => {
    const plan = travelPlan(0, 0);
    expect(plan.overworld.rockets).toBe(0);
    expect(plan.overworld.seconds).toBe(0);
    expect(plan.netherSavingFraction).toBe(0);
  });

  it("rejects non-finite coordinates", () => {
    expect(() => travelPlan(Number.NaN, 0)).toThrow(ToolError);
  });
});

describe("durabilityPlan", () => {
  it("gives a fresh elytra 431 points and 7 minutes of flight", () => {
    const plan = durabilityPlan({ currentDamage: 0 });
    expect(plan.maxDamage).toBe(432);
    expect(plan.usableDurability).toBe(431);
    expect(plan.flightTicks).toBe(8620);
    expect(plan.flightSeconds).toBe(431);
  });

  it("multiplies flight time by Unbreaking level plus one", () => {
    expect(durabilityPlan({ unbreaking: 3 }).flightTicks).toBe(8620 * 4);
    expect(durabilityPlan({ unbreaking: 3 }).mendingXpPerSecond).toBeCloseTo(0.125, 9);
  });

  it("costs a wrecked elytra four phantom membranes", () => {
    const plan = durabilityPlan({ currentDamage: 431 });
    expect(plan.repairPerMembrane).toBe(108);
    expect(plan.membranesToFull).toBe(4);
    expect(plan.anvilUses).toBe(1);
    expect(plan.usableDurability).toBe(0);
  });

  it("rejects a damage value the game cannot hold", () => {
    expect(() => durabilityPlan({ currentDamage: 432 })).toThrow(/0 to 431/);
    expect(() => durabilityPlan({ currentDamage: -1 })).toThrow(ToolError);
  });

  it("rejects an Unbreaking level above 3", () => {
    expect(() => durabilityPlan({ unbreaking: 4 })).toThrow(ToolError);
  });

  it("rejects an unknown version", () => {
    expect(() => durabilityPlan({ version: "1.7.10" as never })).toThrow(
      /Unknown Minecraft version/,
    );
  });
});

describe("fireworkSelfDamage", () => {
  it("is harmless without stars", () => {
    const d = fireworkSelfDamage(0);
    expect(d.damage).toBe(0);
    expect(d.harmless).toBe(true);
  });

  it("is 5 plus 2 per star", () => {
    expect(fireworkSelfDamage(1).damage).toBe(7);
    expect(fireworkSelfDamage(3).damage).toBe(11);
    expect(fireworkSelfDamage(7).hearts).toBe(9.5);
  });

  it("rejects more stars than a crafting grid holds", () => {
    expect(() => fireworkSelfDamage(8)).toThrow(ToolError);
    expect(() => fireworkSelfDamage(1.5)).toThrow(ToolError);
  });
});

describe("run", () => {
  it("answers the glide question", () => {
    const out = run(undefined, opts({ mode: "glide", height: 100, pitch: 0 }));
    expect(out["Distance covered"]).toMatch(/blocks/);
    expect(out["Glide ratio"]).toMatch(/per block down/);
  });

  it("answers the cruise question", () => {
    const out = run(undefined, opts({ mode: "cruise", flightDuration: 3 }));
    expect(out["Blocks per rocket"]).toMatch(/^7[0-9]/);
  });

  it("answers the trip question with a Nether comparison", () => {
    const out = run(undefined, opts({ mode: "travel", targetX: 10000, targetZ: 0 }));
    expect(out["Nether distance"]).toContain("1,250");
    expect(out["Saved by the Nether"]).toContain("88%");
  });

  it("answers the durability question", () => {
    const out = run(undefined, opts({ mode: "durability", damage: 0, unbreaking: 0 }));
    expect(out["Durability left"]).toContain("431");
    expect(out["Total flight time"]).toContain("min");
  });

  it("answers the firework damage question", () => {
    expect(run(undefined, opts({ mode: "damage", stars: 0 }))["Damage to you"]).toMatch(/None/);
    expect(run(undefined, opts({ mode: "damage", stars: 2 }))["Damage to you"]).toContain(
      "9 damage",
    );
  });

  it("rejects an unknown mode", () => {
    expect(() => run(undefined, opts({ mode: "teleport" }))).toThrow(/Unknown mode/);
  });

  it("rejects a height outside the world", () => {
    expect(() => run(undefined, opts({ mode: "glide", height: 0 }))).toThrow(ToolError);
    expect(() => run(undefined, opts({ mode: "glide", height: 99999 }))).toThrow(ToolError);
  });

  it("rejects a non-numeric field", () => {
    expect(() => run(undefined, opts({ mode: "travel", targetX: "far" as never }))).toThrow(
      /must be a number/,
    );
  });

  it("slows everything down under Slow Falling", () => {
    const normal = run(undefined, opts({ mode: "cruise", slowFalling: false }));
    const slow = run(undefined, opts({ mode: "cruise", slowFalling: true }));
    expect(normal["Cruise speed"]).not.toBe(slow["Cruise speed"]);
  });
});

describe("shipped data", () => {
  it("offers only enchantments that can really go on an elytra", () => {
    expect(ELYTRA_ENCHANTS.map((e) => e.id).sort()).toEqual([
      "binding_curse",
      "mending",
      "unbreaking",
      "vanishing_curse",
    ]);
  });

  it("records the glider component only from 1.21.11 on", () => {
    expect(ELYTRA_VERSION_DATA["1.21.1"].glider).toBe(false);
    expect(ELYTRA_VERSION_DATA["1.21.11"].glider).toBe(true);
    expect(ELYTRA_VERSION_DATA["26.2"].glider).toBe(true);
  });

  it("keeps 432 durability in every verified version", () => {
    for (const v of Object.values(ELYTRA_VERSION_DATA)) expect(v.maxDamage).toBe(432);
  });
});
