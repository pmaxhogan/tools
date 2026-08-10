import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  applyRocketBoost,
  cruisePlan,
  durabilityPlan,
  fireworkSelfDamage,
  lookVector,
  rocketLifetime,
  simulateFlight,
  steadyState,
  travelPlan,
} from "./index";

/**
 * Source-derived golden vectors.
 *
 * Unlike the loot and damage tools, elytra flight cannot be measured on a
 * headless server: gliding is player bound, no command puts an entity into
 * fall-flying with a controlled pitch, and the elytra branch of
 * LivingEntity#travel only runs on the instance that controls the entity.
 * So mc-pipeline/vectors/elytra/source-derived.json is hand derived from the
 * decompiled and unobfuscated trees, and every entry names the class and
 * method it came from plus the versions it holds for.
 *
 * Two kinds of check live here:
 * - steady-glide and steady-cruise vectors carry a closed form solved by
 *   hand from the same equations, so the simulator is measured against
 *   algebra rather than against itself. Those use a 1e-5 relative tolerance
 *   because the closed forms use exact 0.99 and 0.98 while the game widens
 *   float literals to 0.9900000095367432 and 0.9800000190734863.
 * - flight, dive-then-level, travel and durability vectors are per tick runs
 *   of the cited physics, pinned as regressions at 1e-9.
 */

const VECTOR_PATH = fileURLToPath(
  new URL("../../../mc-pipeline/vectors/elytra/source-derived.json", import.meta.url),
);

/**
 * The one thing about elytra flight that WAS measured on a real server, just
 * on a different entity: how a float drag literal behaves. The projectile
 * harness recorded exact per-tick Motion over RCON, and an arrow launched at
 * 3.0 blocks per tick comes back at 2.9700000286102295, which is
 * 3 * Math.fround(0.99), not 3 * 0.99. The elytra multiplies by the same
 * float literals, so this pins the arithmetic layer the vectors above rest
 * on. Skipped rather than failed when the projectile vectors are absent, so
 * this suite never depends on another tool's files existing.
 */
const PROJECTILE_PATH = fileURLToPath(
  new URL("../../../mc-pipeline/vectors/projectile/1.21.11.json", import.meta.url),
);

interface VectorCase {
  type: string;
  label?: string;
  pitchDeg?: number;
  divePitchDeg?: number;
  diveTicks?: number;
  levelPitchDeg?: number;
  flightDuration?: number;
  stopAfterDrop?: number;
  dx?: number;
  dz?: number;
  gravityA?: number;
  gravityB?: number;
  unbreaking?: number;
  currentDamage?: number;
  stars?: number;
  expected?: number;
  expectError?: string;
  expectedHorizontal?: number;
  expectedVertical?: number;
  expectedGlideRatio?: number;
  expectedDistance?: number;
  expectedTicks?: number;
  expectedSpeedAtSwitch?: number;
  expectedPeakSpeed?: number;
  expectedPeakTick?: number;
  expectedMinBoostTicks?: number;
  expectedMeanBoostTicks?: number;
  expectedMaxBoostTicks?: number;
  expectedOverworldRockets?: number;
  expectedNetherRockets?: number;
  expectedOverworldTicks?: number;
  expectedUsableDurability?: number;
  expectedFlightTicks?: number;
  expectedRepairPerMembrane?: number;
  relativeTolerance?: number;
  tolerance?: number;
  provenance: string;
}

interface VectorFile {
  method: string;
  versionsChecked: string[];
  note: string;
  model: { tickOrder: string; assumptions: string[] };
  constants: { name: string; value: number | string; provenance: string; holdsFor: string }[];
  cases: VectorCase[];
}

const vectors = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as VectorFile;

function closeRelative(actual: number, expected: number, rel: number): void {
  const allowed = Math.max(Math.abs(expected) * rel, 1e-12);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(allowed);
}

describe("float drag widening, cross-checked against live server measurements", () => {
  interface ProjectileFile {
    method: string;
    cases: { type: string; series: { tick: number; motion: [number, number, number] }[] }[];
  }

  let measured: ProjectileFile | null = null;
  try {
    measured = JSON.parse(readFileSync(PROJECTILE_PATH, "utf8")) as ProjectileFile;
  } catch {
    measured = null;
  }

  it.skipIf(!measured)("reproduces a measured drag step with float widened constants", () => {
    expect(measured!.method).toBe("rcon-e2e");
    const arrow = measured!.cases.find((c) => c.type === "arrow" && c.series.length > 1);
    expect(arrow).toBeDefined();
    const before = arrow!.series[0]!.motion[0];
    const after = arrow!.series[1]!.motion[0];
    expect(before).not.toBe(0);
    // The real server's answer, to the last bit.
    expect(before * Math.fround(0.99)).toBe(after);
    // and plain double 0.99 does not reproduce it, which is the whole point.
    expect(before * 0.99).not.toBe(after);
  });
});

describe("elytra source-derived vectors", () => {
  it("is a source-derived file covering all six verified versions", () => {
    expect(vectors.method).toBe("source-derived");
    expect(vectors.versionsChecked).toEqual([
      "1.16.5",
      "1.18.2",
      "1.20.6",
      "1.21.1",
      "1.21.11",
      "26.2",
    ]);
    expect(vectors.note).toMatch(/cannot be driven headlessly|player bound/);
    expect(vectors.model.tickOrder).toMatch(/FireworkRocketEntity#tick/);
  });

  it("cites a class and method for every constant and case", () => {
    expect(vectors.constants.length).toBeGreaterThan(15);
    for (const c of vectors.constants) {
      expect(c.provenance.length).toBeGreaterThan(20);
      expect(c.holdsFor.length).toBeGreaterThan(0);
    }
    for (const c of vectors.cases) {
      expect(c.provenance.length).toBeGreaterThan(20);
    }
  });

  it("records the glider component boundary as a bracket, not a guess", () => {
    const boundary = vectors.constants.find((c) => c.name === "gliderComponentBoundary");
    expect(boundary?.value).toBe("between 1.21.1 and 1.21.11");
  });

  for (const c of vectors.cases) {
    const label = c.label ?? JSON.stringify({ ...c, provenance: undefined });

    switch (c.type) {
      case "boost-fixed-point":
        it(`boost fixed point: ${c.expected}`, () => {
          const look = lookVector(0);
          let v = { x: 0, y: 0, z: 0 };
          for (let i = 0; i < 400; i++) v = applyRocketBoost(v, look);
          closeRelative(v.z, c.expected!, 1e-12);
        });
        break;

      case "steady-glide":
        it(`terminal glide at pitch ${c.pitchDeg}`, () => {
          const s = steadyState(c.pitchDeg!);
          closeRelative(s.horizontalSpeed, c.expectedHorizontal!, c.relativeTolerance!);
          closeRelative(s.verticalSpeed, c.expectedVertical!, c.relativeTolerance!);
          if (c.expectedGlideRatio !== undefined) {
            closeRelative(s.glideRatio, c.expectedGlideRatio, c.relativeTolerance!);
          }
        });
        break;

      case "steady-cruise":
        it(`chained rocket cruise at pitch ${c.pitchDeg}`, () => {
          const s = steadyState(c.pitchDeg!, { boosting: true });
          closeRelative(s.horizontalSpeed, c.expectedHorizontal!, c.relativeTolerance!);
          closeRelative(s.verticalSpeed, c.expectedVertical!, c.relativeTolerance!);
        });
        break;

      case "glide-ratio-gravity-independence":
        it("glide ratio does not depend on gravity", () => {
          const a = steadyState(c.pitchDeg!, { gravity: c.gravityA });
          const b = steadyState(c.pitchDeg!, { gravity: c.gravityB });
          closeRelative(b.glideRatio, a.glideRatio, c.relativeTolerance!);
          expect(b.horizontalSpeed).toBeLessThan(a.horizontalSpeed);
        });
        break;

      case "rocket-lifetime":
        it(`rocket lifetime for flight duration ${c.flightDuration}`, () => {
          const life = rocketLifetime(c.flightDuration!);
          expect(life.minBoostTicks).toBe(c.expectedMinBoostTicks);
          expect(life.meanBoostTicks).toBe(c.expectedMeanBoostTicks);
          expect(life.maxBoostTicks).toBe(c.expectedMaxBoostTicks);
        });
        break;

      case "blocks-per-rocket":
        it(`blocks per rocket at flight duration ${c.flightDuration}`, () => {
          const plan = cruisePlan(c.pitchDeg!, c.flightDuration!);
          closeRelative(plan.blocksPerRocket, c.expected!, c.relativeTolerance!);
        });
        break;

      case "flight":
        it(`flight: ${label}`, () => {
          const sim = simulateFlight({
            pitchDeg: c.pitchDeg!,
            stopAfterDrop: c.stopAfterDrop,
            maxTicks: 40000,
          });
          expect(sim.ticks).toBe(c.expectedTicks);
          closeRelative(sim.distance, c.expectedDistance!, c.relativeTolerance!);
        });
        break;

      case "dive-then-level":
        it("dive then level produces a speed spike", () => {
          const sim = simulateFlight({
            pitchDeg: c.levelPitchDeg!,
            pitchSegments: [{ throughTick: c.diveTicks!, pitchDeg: c.divePitchDeg! }],
            maxTicks: 300,
          });
          closeRelative(
            sim.samples[c.diveTicks!]!.horizontalSpeed,
            c.expectedSpeedAtSwitch!,
            c.relativeTolerance!,
          );
          closeRelative(sim.peakHorizontalSpeed, c.expectedPeakSpeed!, c.relativeTolerance!);
          const peak = sim.samples.reduce((a, b) =>
            b.horizontalSpeed > a.horizontalSpeed ? b : a,
          );
          expect(peak.tick).toBe(c.expectedPeakTick);
          // the spike really is above the steady level glide
          expect(sim.peakHorizontalSpeed).toBeGreaterThan(
            steadyState(c.levelPitchDeg!).horizontalSpeed,
          );
        });
        break;

      case "travel":
        it(`trip to ${c.dx}, ${c.dz}`, () => {
          const plan = travelPlan(c.dx!, c.dz!, { flightDuration: c.flightDuration });
          expect(plan.overworld.rockets).toBe(c.expectedOverworldRockets);
          expect(plan.nether.rockets).toBe(c.expectedNetherRockets);
          closeRelative(plan.overworld.ticks, c.expectedOverworldTicks!, c.relativeTolerance!);
        });
        break;

      case "durability":
        it(`durability at Unbreaking ${c.unbreaking}, damage ${c.currentDamage}`, () => {
          if (c.expectError) {
            let thrown: unknown;
            try {
              durabilityPlan({ unbreaking: c.unbreaking, currentDamage: c.currentDamage });
            } catch (e) {
              thrown = e;
            }
            expect(thrown).toBeInstanceOf(ToolError);
            expect((thrown as ToolError).code).toBe(c.expectError);
            return;
          }
          const plan = durabilityPlan({ unbreaking: c.unbreaking, currentDamage: c.currentDamage });
          expect(plan.usableDurability).toBe(c.expectedUsableDurability);
          expect(plan.flightTicks).toBe(c.expectedFlightTicks);
        });
        break;

      case "repair":
        it("phantom membrane repair", () => {
          const plan = durabilityPlan({ currentDamage: c.currentDamage! - 1 });
          expect(plan.repairPerMembrane).toBe(c.expectedRepairPerMembrane);
        });
        break;

      case "self-damage":
        it(`firework self damage with ${c.stars} stars`, () => {
          expect(fireworkSelfDamage(c.stars!).damage).toBe(c.expected);
        });
        break;

      default:
        it(`unhandled vector type ${c.type}`, () => {
          throw new Error(`no assertion wired for vector type "${c.type}"`);
        });
    }
  }
});
