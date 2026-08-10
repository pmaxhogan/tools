import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  bowPowerForTime,
  bowVelocity,
  crossbowChargeTicks,
  dropOverDistance,
  impactDamage,
  launchSpeed,
  maxRange,
  minimumBowDrawTicks,
  motionFromRotation,
  pearlLanding,
  run,
  simulate,
  solveAim,
  validateEnchants,
} from "./index";
import { PROJECTILES, VERSIONS, type VersionId } from "./data";

/* ------------------------------------------------------------------ */
/* the integrator, against measured game positions                     */
/* ------------------------------------------------------------------ */

describe("per tick simulator", () => {
  it("reproduces a measured 1.21.11 arrow tick for tick to full double precision", () => {
    // Arrow summoned at 0.5/110/0.5 with Motion [3.0, 0.0, 0.0] on a real
    // 1.21.11 dedicated server. These are the exact doubles the server read
    // back, not rounded values.
    const r = simulate({
      version: "1.21.11",
      projectile: "arrow",
      origin: { x: 0.5, y: 110, z: 0.5 },
      motion: { x: 3, y: 0, z: 0 },
      maxTicks: 3,
    });
    expect(r.ticks[1].x).toBe(3.5);
    expect(r.ticks[1].y).toBe(110);
    expect(r.ticks[1].z).toBe(0.5);
    expect(r.ticks[2].x).toBe(6.4700000286102295);
    expect(r.ticks[2].y).toBe(109.95);
    expect(r.ticks[2].z).toBe(0.5);
    expect(r.ticks[3].x).toBe(9.410300085258484);
    expect(r.ticks[3].y).toBe(109.85049999952317);
    expect(r.ticks[3].z).toBe(0.5);
  });

  it("uses the same arrow ordering on every covered version in air", () => {
    for (const version of VERSIONS) {
      const r = simulate({
        version,
        projectile: "arrow",
        origin: { x: 0.5, y: 110, z: 0.5 },
        motion: { x: 3, y: 0, z: 0 },
        maxTicks: 2,
      });
      expect(r.ticks[2].x).toBe(6.4700000286102295);
    }
  });

  it("differs between float gravity and double gravity versions", () => {
    // 1.16.5 and 1.18.2 subtract the float literal 0.05F, which widens to
    // 0.05000000074505806; 1.20.6 onward subtract the double 0.05.
    const old = simulate({
      version: "1.16.5",
      projectile: "arrow",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 0 },
      maxTicks: 2,
    });
    const modern = simulate({
      version: "1.20.6",
      projectile: "arrow",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 0 },
      maxTicks: 2,
    });
    expect(old.ticks[2].y).not.toBe(modern.ticks[2].y);
    expect(modern.ticks[2].y).toBe(-0.05);
    expect(old.ticks[2].y).toBe(-0.05000000074505806);
  });

  it("flips the throwable order of operations at 1.21.2", () => {
    // Before the movement rewrite a snowball moved first, so its first tick
    // covers the full launch speed. After it, gravity and drag land first.
    const before = simulate({
      version: "1.21.1",
      projectile: "snowball",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 1.5 },
      maxTicks: 1,
    });
    const after = simulate({
      version: "1.21.11",
      projectile: "snowball",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 1.5 },
      maxTicks: 1,
    });
    expect(before.ticks[1].z).toBe(1.5);
    expect(before.ticks[1].y).toBe(0);
    // 1.5 * 0.99F, where 0.99F widens to 0.99000000953674316.
    expect(after.ticks[1].z).toBe(1.5 * Math.fround(0.99));
    expect(after.ticks[1].y).toBeLessThan(0);
  });

  it("gives an arrow 0.6 water drag and a trident 0.99", () => {
    const arrow = simulate({
      version: "1.21.11",
      projectile: "arrow",
      medium: "water",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 3 },
      maxTicks: 1,
    });
    const trident = simulate({
      version: "1.21.11",
      projectile: "trident",
      medium: "water",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 3 },
      maxTicks: 1,
    });
    // On 1.21.2+ the water drag is applied before the move, so the first tick
    // already shows it.
    expect(arrow.ticks[1].z).toBeCloseTo(1.8, 6);
    expect(trident.ticks[1].z).toBeCloseTo(2.97, 6);
  });

  it("applies arrow water drag after the move before 1.21.2", () => {
    const arrow = simulate({
      version: "1.21.1",
      projectile: "arrow",
      medium: "water",
      origin: { x: 0, y: 0, z: 0 },
      motion: { x: 0, y: 0, z: 3 },
      maxTicks: 2,
    });
    expect(arrow.ticks[1].z).toBe(3);
    expect(arrow.ticks[2].z).toBeCloseTo(4.8, 6);
  });

  it("flies a crossbow firework in a straight line with no gravity", () => {
    const r = simulate({
      version: "1.21.11",
      projectile: "firework_rocket",
      launcher: "crossbow",
      origin: { x: 0, y: 0, z: 0 },
      pitch: 0,
      maxTicks: 10,
    });
    expect(r.ticks[10].y).toBeCloseTo(0, 9);
    expect(r.ticks[10].distance).toBeCloseTo(16, 6);
  });
});

/* ------------------------------------------------------------------ */
/* launch velocity                                                     */
/* ------------------------------------------------------------------ */

describe("launch velocity", () => {
  it("matches the bow draw curve", () => {
    expect(bowPowerForTime(0)).toBe(0);
    expect(bowPowerForTime(20)).toBe(1);
    expect(bowPowerForTime(30)).toBe(1);
    expect(bowVelocity(20)).toBe(3);
    // A 10 tick draw is (0.5^2 + 1) / 3 = 0.41666...
    expect(bowPowerForTime(10)).toBeCloseTo(0.4166667, 6);
    expect(bowVelocity(10)).toBeCloseTo(1.25, 6);
  });

  it("refuses draws under 0.1 power the way the game does", () => {
    const t = minimumBowDrawTicks();
    expect(bowPowerForTime(t)).toBeGreaterThanOrEqual(0.1);
    expect(bowPowerForTime(t - 1)).toBeLessThan(0.1);
  });

  it("uses the fixed crossbow and hand thrown speeds", () => {
    expect(launchSpeed("arrow", "crossbow")).toBe(3.15);
    expect(launchSpeed("firework_rocket", "crossbow")).toBe(1.6);
    expect(launchSpeed("trident", "throw")).toBe(2.5);
    expect(launchSpeed("snowball", "hand")).toBe(1.5);
    expect(launchSpeed("splash_potion", "hand")).toBe(0.5);
    expect(launchSpeed("experience_bottle", "hand")).toBe(0.7);
  });

  it("cuts crossbow charge time by a quarter second per Quick Charge level", () => {
    expect(crossbowChargeTicks(0)).toBe(25);
    expect(crossbowChargeTicks(1)).toBe(20);
    expect(crossbowChargeTicks(2)).toBe(15);
    expect(crossbowChargeTicks(3)).toBe(10);
  });

  it("lobs potions upward through the 20 degree pitch offset", () => {
    const potion = motionFromRotation("1.21.11", 0, 0, -20, 0.5);
    const snowball = motionFromRotation("1.21.11", 0, 0, 0, 1.5);
    expect(potion.y).toBeGreaterThan(0);
    expect(snowball.y).toBeCloseTo(0, 4);
  });

  it("uses the game's sine table, not Math.sin", () => {
    // Mth.sin quantises to 65536 steps, so a 30 degree launch is very close to
    // the ideal half but never exactly it.
    const m = motionFromRotation("1.21.11", -30, 0, 0, 1);
    expect(m.y).toBeCloseTo(0.5, 4);
    expect(m.y).not.toBe(0.5);
    // The table is a step function of the angle: a thousandth of a degree
    // either side of 30 lands on the same entry and gives an identical vector.
    expect(motionFromRotation("1.21.11", -30.0001, 0, 0, 1).y).toBe(m.y);
  });
});

/* ------------------------------------------------------------------ */
/* aiming, range, drop                                                 */
/* ------------------------------------------------------------------ */

describe("aim solver", () => {
  it("finds a flat and a lobbed answer for a reachable target", () => {
    const s = solveAim({
      version: "1.21.11",
      projectile: "arrow",
      launcher: "bow",
      distance: 30,
      deltaY: 0,
    });
    expect(s.low).not.toBeNull();
    expect(s.high).not.toBeNull();
    expect(s.low!.angle).toBeLessThan(s.high!.angle);
    expect(s.low!.flightTicks).toBeLessThan(s.high!.flightTicks);
  });

  it("lands the solved shot on the target it solved for", () => {
    const distance = 45;
    const deltaY = 6;
    const s = solveAim({
      version: "1.21.11",
      projectile: "arrow",
      launcher: "bow",
      distance,
      deltaY,
    });
    const r = simulate({
      version: "1.21.11",
      projectile: "arrow",
      launcher: "bow",
      origin: { x: 0, y: 0, z: 0 },
      pitch: s.low!.pitch,
      maxTicks: 400,
    });
    let hit: number | null = null;
    for (let i = 1; i < r.ticks.length; i++) {
      const a = r.ticks[i - 1];
      const b = r.ticks[i];
      if (a.distance <= distance && b.distance >= distance) {
        const f = (distance - a.distance) / (b.distance - a.distance);
        hit = a.y + (b.y - a.y) * f;
        break;
      }
    }
    expect(hit).not.toBeNull();
    // The sine table quantises the aim, so the best achievable shot lands
    // within a few thousandths of a block rather than exactly on the target,
    // and the solution reports that residual honestly.
    expect(Math.abs(hit! - deltaY)).toBeLessThan(0.01);
    expect(hit! - deltaY).toBeCloseTo(s.low!.missY, 9);
  });

  it("returns no solution for a target beyond the maximum range", () => {
    const s = solveAim({
      version: "1.21.11",
      projectile: "snowball",
      launcher: "hand",
      distance: 400,
      deltaY: 0,
    });
    expect(s.low).toBeNull();
    expect(s.high).toBeNull();
  });

  it("rejects a zero or negative distance", () => {
    expect(() =>
      solveAim({ version: "1.21.11", projectile: "arrow", distance: 0, deltaY: 0 }),
    ).toThrow(ToolError);
  });
});

describe("maximum range", () => {
  it("puts a fully drawn bow shot near the known 120 block ceiling", () => {
    const r = maxRange("1.21.11", "arrow", "bow");
    expect(r.maxRange).toBeGreaterThan(115);
    expect(r.maxRange).toBeLessThan(125);
  });

  it("finds a best angle below 45 degrees because of drag", () => {
    const r = maxRange("1.21.11", "arrow", "bow");
    expect(r.bestAngle).toBeGreaterThan(30);
    expect(r.bestAngle).toBeLessThan(45);
  });

  it("throws a crossbow arrow further than a bow arrow", () => {
    const bow = maxRange("1.21.11", "arrow", "bow");
    const crossbow = maxRange("1.21.11", "arrow", "crossbow");
    expect(crossbow.maxRange).toBeGreaterThan(bow.maxRange);
  });

  it("shortens every projectile's range in water", () => {
    const air = maxRange("1.21.11", "arrow", "bow", 20, "air");
    const water = maxRange("1.21.11", "arrow", "bow", 20, "water");
    expect(water.maxRange).toBeLessThan(air.maxRange / 4);
  });
});

describe("drop over distance", () => {
  it("grows monotonically with distance", () => {
    const rows = dropOverDistance("1.21.11", "arrow", [10, 20, 30, 40, 50], "bow");
    expect(rows).toHaveLength(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].drop).toBeGreaterThan(rows[i - 1].drop);
      expect(rows[i].speed).toBeLessThan(rows[i - 1].speed);
    }
  });

  it("drops a snowball faster than an arrow over the same distance", () => {
    const arrow = dropOverDistance("1.21.11", "arrow", [20], "bow");
    const snowball = dropOverDistance("1.21.11", "snowball", [20], "hand");
    expect(snowball[0].drop).toBeGreaterThan(arrow[0].drop);
  });
});

/* ------------------------------------------------------------------ */
/* ender pearl                                                         */
/* ------------------------------------------------------------------ */

describe("ender pearl", () => {
  it("always costs 5 damage on landing", () => {
    expect(pearlLanding("1.16.5", 0).damage).toBe(5);
    expect(pearlLanding("1.21.11", 0).damage).toBe(5);
  });

  it("teleports to the impact point before 1.21.2 and to the previous tick after", () => {
    const oldVersion = pearlLanding("1.21.1", 0);
    const newVersion = pearlLanding("1.21.11", 0);
    expect(oldVersion.landsAt).toBe("impact point");
    expect(newVersion.landsAt).toBe("position at the start of the impact tick");
    expect(oldVersion.offsetFromImpact).toBe(0);
    expect(newVersion.offsetFromImpact).toBeGreaterThan(0);
    expect(newVersion.distance).toBeLessThan(oldVersion.distance);
  });
});

/* ------------------------------------------------------------------ */
/* damage and enchantment legality                                     */
/* ------------------------------------------------------------------ */

describe("impact damage", () => {
  it("scales arrow damage with speed and ceils it", () => {
    // A fully drawn bow arrow leaves at 3.0 blocks per tick: 3 * 2 = 6.
    expect(impactDamage("arrow", 3).base).toBe(6);
    // A crossbow arrow leaves at 3.15: ceil(6.3) = 7.
    expect(impactDamage("arrow", 3.15).base).toBe(7);
  });

  it("adds Power the way the enchantment data does", () => {
    expect(impactDamage("arrow", 3, { power: 1 }).base).toBe(9);
    expect(impactDamage("arrow", 3, { power: 5 }).base).toBe(Math.ceil(3 * (2 + 3)));
  });

  it("gives a trident a flat 8 plus Impaling instead of speed scaling", () => {
    expect(impactDamage("trident", 2.5).base).toBe(8);
    expect(impactDamage("trident", 0.1).base).toBe(8);
    expect(impactDamage("trident", 2.5, { impaling: 5 }).base).toBe(20.5);
  });

  it("gives snowballs no impact damage", () => {
    expect(impactDamage("snowball", 1.5).base).toBe(0);
  });

  it("gives a blaze fireball a flat 5 and never applies Impaling to it", () => {
    expect(impactDamage("small_fireball", 1).base).toBe(5);
    expect(impactDamage("small_fireball", 1, { impaling: 5 }).base).toBe(5);
  });

  it("adds a critical roll on top for a fully drawn bow", () => {
    const d = impactDamage("arrow", 3, { critical: true });
    expect(d.base).toBe(6);
    expect(d.critMax).toBe(6 + Math.floor(6 / 2) + 1);
  });

  it("turns Punch into 0.6 blocks per tick of knockback per level", () => {
    expect(impactDamage("arrow", 3, { punch: 2 }).knockback).toBeCloseTo(1.2, 10);
    expect(impactDamage("arrow", 3, { punch: 2 }).verticalKnockback).toBe(0.1);
  });
});

describe("enchantment legality", () => {
  it("accepts real bow, crossbow and trident enchantments", () => {
    expect(() => validateEnchants("bow", { power: 5, punch: 2 })).not.toThrow();
    expect(() => validateEnchants("crossbow", { piercing: 4, quick_charge: 3 })).not.toThrow();
    expect(() => validateEnchants("throw", { impaling: 5, loyalty: 3 })).not.toThrow();
  });

  it("rejects an enchantment that cannot go on the weapon", () => {
    expect(() => validateEnchants("crossbow", { power: 5 })).toThrow(ToolError);
    expect(() => validateEnchants("bow", { multishot: 1 })).toThrow(ToolError);
  });

  it("rejects mutually exclusive enchantments", () => {
    expect(() => validateEnchants("crossbow", { multishot: 1, piercing: 1 })).toThrow(ToolError);
    expect(() => validateEnchants("throw", { riptide: 3, loyalty: 3 })).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* run()                                                               */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("solves an aim angle by default", () => {
    const out = run("", { version: "1.21.11", projectile: "arrow", launcher: "bow", distance: 30 });
    expect(out["Aim angle (flat shot)"]).toMatch(/degrees above the horizon/);
    expect(out["Damage on hit"]).toMatch(/hearts/);
  });

  it("reports maximum range", () => {
    const out = run("", { mode: "range", version: "1.21.11", projectile: "arrow" });
    expect(out["Maximum range"]).toMatch(/blocks$/);
    expect(out["Best angle"]).toMatch(/degrees/);
  });

  it("reports drop for a level shot", () => {
    const out = run("", { mode: "drop", version: "1.21.11", projectile: "arrow" });
    expect(out["Drop at 20 blocks"]).toMatch(/blocks after/);
  });

  it("reports the pearl landing and its 5 damage", () => {
    const out = run("", { mode: "pearl", version: "1.21.11" });
    expect(out["You take"]).toBe("5 damage (2.5 hearts)");
  });

  it("throws a helpful error for an unreachable target", () => {
    try {
      run("", { projectile: "splash_potion", launcher: "hand", distance: 200 });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("out-of-range");
      expect((e as ToolError).fix).toMatch(/maximum range/);
    }
  });

  it("throws for an unknown version", () => {
    expect(() => run("", { version: "1.7.10" })).toThrow(ToolError);
  });

  it("throws for an unknown projectile", () => {
    expect(() => run("", { projectile: "wither skull" })).toThrow(ToolError);
  });

  it("throws for an impossible launcher and projectile pair", () => {
    expect(() => run("", { projectile: "snowball", launcher: "bow" })).toThrow(ToolError);
  });

  it("throws when an enchantment cannot be on the chosen weapon", () => {
    expect(() => run("", { projectile: "arrow", launcher: "bow", power: 3 })).not.toThrow();
    expect(() => run("", { projectile: "arrow", launcher: "crossbow", power: 3 })).toThrow(ToolError);
  });

  it("defaults an empty option bag to a fully drawn bow shot", () => {
    const out = run("", {});
    expect(out["Launch speed"]).toBe("3 blocks per tick");
  });
});

/* ------------------------------------------------------------------ */
/* every projectile on every version stays sane                        */
/* ------------------------------------------------------------------ */

describe("coverage", () => {
  it("simulates every projectile on every version without diverging", () => {
    for (const version of VERSIONS as VersionId[]) {
      for (const def of PROJECTILES) {
        const launcher = def.launchers[0];
        const r = simulate({
          version,
          projectile: def.id,
          launcher,
          origin: { x: 0, y: 60, z: 0 },
          groundY: 0,
          pitch: -30,
          maxTicks: 1200,
        });
        expect(Number.isFinite(r.ticks[r.ticks.length - 1].x)).toBe(true);
        // Only the families that take gravity ever come back down.
        if (def.gravity > 0) {
          expect(r.landed).toBe(true);
          expect(r.landing!.distance).toBeGreaterThan(0);
        } else {
          expect(r.landed).toBe(false);
        }
      }
    }
  });
});
