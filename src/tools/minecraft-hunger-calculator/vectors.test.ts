import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  drainPlan,
  eatFood,
  effectivePoints,
  healthPerItem,
  simulate,
  stepTick,
  type HungerState,
  type SimEnv,
} from "./index";
import {
  ACTIVITY_BY_ID,
  HUNGER_VERSIONS,
  MECHANICS,
  foodById,
  type DifficultyId,
  type VersionId,
} from "./data";

/**
 * Golden vectors for the hunger mechanic, hand-derived from the decompiled
 * server source. The hunger loop cannot be driven headlessly over RCON (the
 * exhaustion level is not readable from a command and no command adds
 * exhaustion), so every case is worked out by reading FoodData#tick and the
 * causeFoodExhaustion call sites, with the class and method recorded in the
 * vector file next to each value.
 */

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "mc-pipeline",
  "vectors",
  "hunger",
  "source-derived.json",
);

interface BaseCase {
  id: string;
  type: string;
  versions: string[];
  provenance: string;
}

interface StateSpec {
  food: number;
  saturation: number;
  exhaustion?: number;
  health?: number;
}

interface EnvSpec {
  difficulty: DifficultyId;
  naturalRegen: boolean;
  exhaustionPerTick: number;
}

type VectorCase = BaseCase & {
  key?: string;
  activityId?: string;
  foodId?: string;
  present?: boolean;
  start?: StateSpec;
  env?: EnvSpec;
  ticks?: number;
  difficulty?: DifficultyId;
  startHealth?: number;
  food?: number;
  saturation?: number;
  exhaustionPerSecond?: number;
  expect?: unknown;
};

const vectors: { method: string; versionsChecked: string[]; cases: VectorCase[] } = JSON.parse(
  readFileSync(VECTORS_PATH, "utf8"),
);

const EPS = 1e-6;

function state(spec: StateSpec): HungerState {
  return {
    food: spec.food,
    saturation: spec.saturation,
    exhaustion: spec.exhaustion ?? 0,
    health: spec.health ?? 20,
    tickTimer: 0,
    tickCount: 0,
  };
}

function env(version: VersionId, spec: EnvSpec): SimEnv {
  return {
    version,
    difficulty: spec.difficulty,
    naturalRegen: spec.naturalRegen,
    maxHealth: 20,
    exhaustionPerTick: spec.exhaustionPerTick,
  };
}

function runTicks(start: HungerState, e: SimEnv, ticks: number): HungerState {
  let s = start;
  for (let i = 0; i < ticks; i++) s = stepTick(s, e).state;
  return s;
}

describe("source-derived vector file", () => {
  it("declares the source-derived method and the six checked versions", () => {
    expect(vectors.method).toBe("source-derived");
    expect(vectors.versionsChecked).toEqual([...HUNGER_VERSIONS]);
  });

  it("covers a meaningful number of worked cases", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(45);
  });

  it("every case names its versions, its provenance, and a known version id", () => {
    for (const c of vectors.cases) {
      expect(c.versions.length, c.id).toBeGreaterThan(0);
      expect(c.provenance.length, c.id).toBeGreaterThan(20);
      for (const v of c.versions) {
        expect(HUNGER_VERSIONS as readonly string[], `${c.id}: ${v}`).toContain(v);
      }
    }
  });

  it("covers every version at least once", () => {
    const seen = new Set(vectors.cases.flatMap((c) => c.versions));
    for (const v of HUNGER_VERSIONS) expect(seen, v).toContain(v);
  });
});

for (const c of vectors.cases) {
  describe(`${c.type}: ${c.id}`, () => {
    for (const raw of c.versions) {
      const version = raw as VersionId;
      it(`holds in ${version}`, () => {
        switch (c.type) {
          case "constant": {
            const value = (MECHANICS as unknown as Record<string, number>)[c.key!];
            expect(value).toBe(c.expect);
            break;
          }
          case "activity": {
            expect(ACTIVITY_BY_ID.get(c.activityId!)?.exhaustion).toBe(c.expect);
            break;
          }
          case "food": {
            const item = foodById(version, c.foodId!);
            if (c.present === false) {
              expect(item).toBeUndefined();
              break;
            }
            expect(item, `${c.foodId} missing in ${version}`).toBeDefined();
            const want = c.expect as Record<string, number | boolean>;
            for (const [k, v] of Object.entries(want)) {
              expect((item as unknown as Record<string, unknown>)[k], k).toBe(v);
            }
            break;
          }
          case "value": {
            const item = foodById(version, c.foodId!)!;
            const want = c.expect as Record<string, number>;
            expect(effectivePoints(item)).toBeCloseTo(want.netPoints, 6);
            expect(healthPerItem(item) / 2).toBeCloseTo(want.heartsPerItem, 6);
            expect((healthPerItem(item) / 2) * item.stack).toBeCloseTo(want.heartsPerSlot, 5);
            break;
          }
          case "eat": {
            const item = foodById(version, c.foodId!)!;
            const after = eatFood(state(c.start!), item);
            const want = c.expect as { food: number; saturation: number };
            expect(after.food).toBe(want.food);
            expect(after.saturation).toBeCloseTo(want.saturation, 6);
            break;
          }
          case "tick": {
            const after = runTicks(state(c.start!), env(version, c.env!), c.ticks!);
            const want = c.expect as Record<string, number>;
            expect(after.food, "food").toBe(want.food);
            expect(after.saturation, "saturation").toBeCloseTo(want.saturation, 6);
            expect(after.exhaustion, "exhaustion").toBeCloseTo(want.exhaustion, 6);
            expect(after.health, "health").toBeCloseTo(want.health, 6);
            break;
          }
          case "starve": {
            const run = simulate(
              { ...state({ food: 0, saturation: 0 }), health: c.startHealth! },
              env(version, {
                difficulty: c.difficulty!,
                naturalRegen: true,
                exhaustionPerTick: 0,
              }),
              c.ticks!,
            );
            const want = c.expect as { health: number; died: boolean; starvationDamage: number };
            expect(run.end.health, "health").toBeCloseTo(want.health, 6);
            expect(run.died, "died").toBe(want.died);
            expect(run.starvationDamage, "starvationDamage").toBeCloseTo(want.starvationDamage, 6);
            break;
          }
          case "peaceful": {
            const run = simulate(
              state(c.start!),
              env(version, { difficulty: "peaceful", naturalRegen: true, exhaustionPerTick: 0 }),
              c.ticks!,
            );
            const want = c.expect as Record<string, number>;
            expect(run.end.food, "food").toBe(want.food);
            expect(run.end.saturation, "saturation").toBeCloseTo(want.saturation, 6);
            expect(run.end.health, "health").toBeCloseTo(want.health, 6);
            break;
          }
          case "drain": {
            const plan = drainPlan(c.food!, c.saturation!, c.exhaustionPerSecond!);
            const want = c.expect as Record<string, number>;
            expect(plan.secondsToSaturationGone).toBeCloseTo(want.secondsToSaturationGone, 6);
            expect(plan.secondsToSprintLost).toBeCloseTo(want.secondsToSprintLost, 6);
            expect(plan.secondsToEmpty).toBeCloseTo(want.secondsToEmpty, 6);
            break;
          }
          default:
            throw new Error(`unknown vector case type "${c.type}"`);
        }
      });
    }
  });
}

describe("closed forms agree with the tick simulation", () => {
  const base = env("1.21.11", {
    difficulty: "normal",
    naturalRegen: false,
    exhaustionPerTick: 0,
  });

  for (const [food, saturation] of [
    [20, 5],
    [20, 0],
    [18, 12.8],
    [7, 0.5],
    [3, 20],
  ] as const) {
    it(`drainPlan matches simulation from food ${food}, saturation ${saturation}`, () => {
      const perSecond = 1;
      const e = { ...base, exhaustionPerTick: perSecond / 20 };
      const plan = drainPlan(food, saturation, perSecond);
      const run = simulate({ ...state({ food, saturation }), health: 20 }, e, 20 * 4000);
      expect(run.emptyAtTick).not.toBeNull();
      // The simulation reports the tick the bar hit zero; the closed form
      // reports the exact exhaustion crossing, so they agree to within a tick.
      expect(Math.abs(run.emptyAtTick! / 20 - plan.secondsToEmpty!)).toBeLessThan(1 / 20 + EPS);
      if (food > MECHANICS.sprintLevel) {
        expect(Math.abs(run.sprintLostAtTick! / 20 - plan.secondsToSprintLost!)).toBeLessThan(
          1 / 20 + EPS,
        );
      }
    });
  }
});
